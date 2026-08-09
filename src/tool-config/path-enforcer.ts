/**
 * Path constraint enforcement for tool calls.
 *
 * Checks tool call path arguments against the effective `allowed_paths`
 * and `blocked_paths` constraints at dispatch time.
 *
 * @see specs/04b-tool-toggle/spec.md — FR-84
 * @see specs/04b-tool-toggle/research/RT-1-path-argument-inspection.md
 */

import type {
	PathListSet,
	PathNamespace,
	ResolvedToolConfigEntry,
	ToolPathParam,
} from "./types";
import { groupOf } from "./types";
import { intersectPaths, unionPaths } from "./merger";
import { isPathWithin, expandTilde } from "../utils/path-validation";
import { normalize, resolve, isAbsolute } from "path";

// ---------------------------------------------------------------------------
// Tool Path Parameter Descriptor Table
// ---------------------------------------------------------------------------

/**
 * Maps each built-in tool to its path parameter(s) and namespace(s).
 *
 * - Vault-namespace: path is vault-relative; uses string prefix matching.
 * - Filesystem-namespace: path is absolute or resolved from vault root.
 * - Empty array: tool has no path params (exempt from enforcement).
 * - Tools not in this table (e.g., MCP tools): exempt from enforcement.
 */
// Populated dynamically by ExtensionManager.reload() from scaffold/user tool metadata.
export const TOOL_PATH_PARAMS: Record<string, ToolPathParam[]> = {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check whether a tool call's path arguments satisfy the effective
 * `allowed_paths` / `blocked_paths` constraints.
 *
 * @param toolName            - The tool being called.
 * @param parameters          - The tool call parameters (from the LLM).
 * @param entry               - The resolved tool config entry for this tool.
 * @param vaultRootPath       - Absolute path to the vault root directory.
 * @param resolveVaultPath    - Optional resolver for vault note paths. Returns canonical path or null.
 * @param sessionAllowedPaths - Optional per-session prefixes auto-allowed **in
 *   addition to** `entry.allowed_paths` (INT-001 / FR-121). A path under any such
 *   prefix is allowed without mutating the shared/global tool config — the seam
 *   the orchestration engine uses to auto-allow the active session's
 *   `scratchpad/` (and a `shared`-handoff child's parent scratchpad). The active
 *   session sources these from `OrchestrationToolContext` at the single
 *   `ToolDispatcher.dispatch()` assembly site. **Non-orchestration callers pass
 *   `undefined` and behave exactly as today** (byte-identical). `blocked_paths`
 *   still takes precedence — a session-allowed path that also matches a blocked
 *   prefix is blocked.
 * @returns `null` if the call is allowed, or an error message string if blocked.
 */
export function enforcePathConstraints(
	toolName: string,
	parameters: Record<string, unknown>,
	entry: ResolvedToolConfigEntry,
	vaultRootPath: string,
	resolveVaultPath?: (path: string) => string | null,
	sessionAllowedPaths?: string[],
): string | null {
	// Tools not in the descriptor table (e.g., MCP tools) → exempt
	const pathParams = TOOL_PATH_PARAMS[toolName];
	if (pathParams === undefined) return null;

	// Tools with empty path params (e.g., fetch_webpage) → exempt
	if (pathParams.length === 0) return null;

	// No constraints configured anywhere (flat or grouped) → allow
	if (hasNoConstraints(entry)) return null;

	for (const param of pathParams) {
		const rawValue = parameters[param.paramName];
		if (typeof rawValue !== "string") continue;
		const pathValue = rawValue;
		if (pathValue.trim() === "") continue;

		// Resolve note paths to canonical form before constraint check
		const effectivePath = canonicalizePath(pathValue, param, resolveVaultPath);

		const error = checkPath(
			effectivePath,
			param.namespace,
			effectiveLists(entry, param),
			vaultRootPath,
			sessionAllowedPaths,
		);
		if (error) {
			return `Tool "${toolName}" path constraint violation: ${error}`;
		}
	}

	return null;
}

/**
 * Combine a tool's flat (per-context) path lists with the global group scope for
 * one path parameter.
 *
 * The two tiers combine differently, which is what encodes their different
 * framing — and it falls out here mechanically, with no separate merge step:
 *
 * - **Access tier = floor.** A path is blocked if *either* source blocks it, and
 *   allowed only if *both* permit it (intersect allows, union blocks). A persona
 *   can narrow the global baseline but never widen it.
 * - **Approval tier = default.** The group scope is consulted only when the
 *   corresponding flat list is empty, so a persona that sets its own list
 *   replaces the global default outright. Widening is harmless here — the worst
 *   case is a prompt the user opted out of.
 */
export function effectiveLists(
	entry: ResolvedToolConfigEntry,
	param: ToolPathParam,
): PathListSet {
	const group = entry.path_scopes[groupOf(param)];
	if (!group) {
		return {
			allowed_paths: entry.allowed_paths,
			blocked_paths: entry.blocked_paths,
			auto_approve_paths: entry.auto_approve_paths,
			never_auto_approve_paths: entry.never_auto_approve_paths,
		};
	}
	return {
		allowed_paths: intersectPaths(entry.allowed_paths, group.allowed_paths),
		blocked_paths: unionPaths(entry.blocked_paths, group.blocked_paths),
		auto_approve_paths:
			entry.auto_approve_paths.length > 0 ? entry.auto_approve_paths : group.auto_approve_paths,
		never_auto_approve_paths:
			entry.never_auto_approve_paths.length > 0
				? entry.never_auto_approve_paths
				: group.never_auto_approve_paths,
	};
}

/**
 * Build a predicate for filtering vault paths out of a tool's **results**.
 *
 * The hard gate inspects a call's own path arguments, so it cannot stop
 * `search_vault` or `get_backlinks` from reporting paths under a restricted
 * prefix. This gives those tools the same access-tier verdict for an arbitrary
 * vault path, using the `vault-read` group's lists.
 *
 * Returns `undefined` when reads are unrestricted, so the caller can skip
 * filtering entirely — the inert path for the expected majority of users.
 */
export function buildVaultReadFilter(
	entry: ResolvedToolConfigEntry | undefined,
	sessionAllowedPaths?: string[],
): ((vaultPath: string) => boolean) | undefined {
	if (!entry) return undefined;

	// Results are read output, so they answer to `vault-read` regardless of which
	// group the tool's own parameters fall into.
	const lists = effectiveLists(entry, {
		paramName: "",
		namespace: "vault",
		access: "read",
	});
	if (lists.allowed_paths.length === 0 && lists.blocked_paths.length === 0) return undefined;

	// vaultRootPath is unused in the vault namespace, hence "".
	return (vaultPath: string) =>
		checkVaultPath(vaultPath, lists, sessionAllowedPaths) === null;
}

/** True when neither the flat lists nor any group scope constrains anything. */
function hasNoConstraints(entry: ResolvedToolConfigEntry): boolean {
	if (entry.allowed_paths.length > 0 || entry.blocked_paths.length > 0) return false;
	return Object.values(entry.path_scopes).every(
		(g) => g.allowed_paths.length === 0 && g.blocked_paths.length === 0,
	);
}

/** True when no approval-tier list is configured, flat or grouped. */
function hasNoApprovalLists(entry: ResolvedToolConfigEntry): boolean {
	if (entry.auto_approve_paths.length > 0 || entry.never_auto_approve_paths.length > 0) return false;
	return Object.values(entry.path_scopes).every(
		(g) => g.auto_approve_paths.length === 0 && g.never_auto_approve_paths.length === 0,
	);
}

/**
 * The approval tier's verdict for a tool call's path arguments.
 *
 * - `never` — at least one path matched `never_auto_approve_paths`; approval is
 *   forced even when `auto_approve` is true.
 * - `allow` — every path argument matched `auto_approve_paths`; the prompt is
 *   skipped even when `auto_approve` is false.
 * - `none` — no path rule applies; the caller's existing decision stands.
 */
export interface PathApprovalVerdict {
	verdict: "never" | "allow" | "none";
	/** The prefix that produced the verdict, for the approval card's reason label. */
	prefix?: string;
}

/**
 * Decide whether a tool call's path arguments should skip or force the approval
 * prompt. **Soft gate — ergonomics only.** The call runs either way; only the
 * prompt is affected. The hard access gate is {@link enforcePathConstraints}.
 *
 * Quantifiers follow the hard gate's bias toward caution: the restrictive list
 * fires when **any** path argument matches, while the permissive list requires
 * **all** of them to match. So a `move_note` from `ai/x` to `private/y` still
 * prompts.
 *
 * Note-namespace paths are canonicalized via `resolveVaultPath` first — the
 * model often passes bare note names, and without resolution `Foo` would never
 * match the prefix `ai/`. A `null` resolution means the note does not exist yet
 * (the normal create path), so the raw value is checked as the intended
 * destination.
 */
export function evaluatePathApproval(
	toolName: string,
	parameters: Record<string, unknown>,
	entry: ResolvedToolConfigEntry,
	vaultRootPath: string,
	resolveVaultPath?: (path: string) => string | null,
): PathApprovalVerdict {
	const pathParams = TOOL_PATH_PARAMS[toolName];
	if (pathParams === undefined || pathParams.length === 0) return { verdict: "none" };
	if (hasNoApprovalLists(entry)) return { verdict: "none" };

	let sawPathArg = false;
	let allMatchedAllow = true;
	let allowPrefix: string | undefined;

	for (const param of pathParams) {
		const rawValue = parameters[param.paramName];
		if (typeof rawValue !== "string" || rawValue.trim() === "") continue;
		sawPathArg = true;

		const effectivePath = canonicalizePath(rawValue, param, resolveVaultPath);
		const lists = effectiveLists(entry, param);

		// Restrictive list wins outright, on ANY matching argument.
		const never = matchesPathPrefixes(
			effectivePath,
			param.namespace,
			lists.never_auto_approve_paths,
			vaultRootPath,
		);
		if (never !== null) return { verdict: "never", prefix: never };

		const allow = matchesPathPrefixes(
			effectivePath,
			param.namespace,
			lists.auto_approve_paths,
			vaultRootPath,
		);
		if (allow === null) allMatchedAllow = false;
		else allowPrefix ??= allow;
	}

	if (sawPathArg && allMatchedAllow && allowPrefix !== undefined) {
		return { verdict: "allow", prefix: allowPrefix };
	}
	return { verdict: "none" };
}

/**
 * Find the first prefix in `prefixes` that `pathValue` falls under.
 *
 * The single matcher shared by both severity tiers: the hard access gate
 * (`allowed_paths` / `blocked_paths`, below) and the soft approval gate
 * (`auto_approve_paths` / `never_auto_approve_paths`). Returns the winning
 * prefix — not just a boolean — so callers can name it in an error message or
 * an auto-approve reason label.
 *
 * @param namespace - `vault` compares normalized vault-relative prefixes;
 *   `filesystem` expands `~`, resolves relative paths against the vault root,
 *   and compares absolute paths.
 * @returns The matching prefix, or `null` if none match (including when
 *   `prefixes` is empty).
 */
export function matchesPathPrefixes(
	pathValue: string,
	namespace: PathNamespace,
	prefixes: string[],
	vaultRootPath: string,
): string | null {
	if (prefixes.length === 0) return null;

	if (namespace === "vault") {
		const normalized = normalizePath(pathValue);
		for (const prefix of prefixes) {
			if (vaultPathMatchesPrefix(normalized, prefix)) return prefix;
		}
		return null;
	}

	const absolutePath = toAbsolutePath(pathValue, vaultRootPath);
	for (const prefix of prefixes) {
		if (isPathWithin(absolutePath, toAbsolutePath(prefix, vaultRootPath))) return prefix;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonicalize a path argument before matching.
 *
 * For `resolveAs: "note"` vault params, run the Obsidian-style resolver so bare
 * note names become true vault paths. A `null` result means the note does not
 * exist yet — the raw value is then the intended destination and is returned
 * unchanged, which is what keeps new-note creation working under a non-empty
 * `allowed_paths` / `auto_approve_paths`.
 */
function canonicalizePath(
	pathValue: string,
	param: ToolPathParam,
	resolveVaultPath?: (path: string) => string | null,
): string {
	if (param.resolveAs === "note" && param.namespace === "vault" && resolveVaultPath) {
		return resolveVaultPath(pathValue) ?? pathValue;
	}
	return pathValue;
}

/**
 * Check a single path value against allowed/blocked constraints.
 */
function checkPath(
	pathValue: string,
	namespace: PathNamespace,
	lists: PathListSet,
	vaultRootPath: string,
	sessionAllowedPaths?: string[],
): string | null {
	if (namespace === "vault") {
		return checkVaultPath(pathValue, lists, sessionAllowedPaths);
	} else {
		return checkFilesystemPath(pathValue, lists, vaultRootPath, sessionAllowedPaths);
	}
}

/**
 * Vault-namespace: string prefix matching on vault-relative path.
 *
 * `sessionAllowedPaths` (INT-001) are treated as additional allowed prefixes
 * (vault-relative), so the active session's scratchpad passes even when it is
 * outside the tool's configured `allowed_paths`. `blocked_paths` still wins.
 */
function checkVaultPath(
	vaultPath: string,
	lists: PathListSet,
	sessionAllowedPaths?: string[],
): string | null {
	// blocked_paths takes precedence over allowed_paths (and over session-allow)
	const blocked = matchesPathPrefixes(vaultPath, "vault", lists.blocked_paths, "");
	if (blocked !== null) {
		return `Path "${vaultPath}" is blocked by path constraint "${blocked}".`;
	}

	// Per-session auto-allow (FR-121): a path under any session prefix is allowed
	// IN ADDITION to entry.allowed_paths.
	if (matchesPathPrefixes(vaultPath, "vault", sessionAllowedPaths ?? [], "") !== null) {
		return null;
	}

	// allowed_paths: empty means no restriction
	if (
		lists.allowed_paths.length > 0 &&
		matchesPathPrefixes(vaultPath, "vault", lists.allowed_paths, "") === null
	) {
		return `Path "${vaultPath}" is not within any allowed path: [${lists.allowed_paths.join(", ")}].`;
	}

	return null;
}

/**
 * Filesystem-namespace: resolve to absolute path, then compare.
 *
 * `sessionAllowedPaths` (INT-001) are resolved the same way as `allowed_paths`
 * (absolute or vault-root-relative) and treated as additional allowed prefixes.
 * `blocked_paths` still takes precedence.
 */
function checkFilesystemPath(
	rawPath: string,
	lists: PathListSet,
	vaultRootPath: string,
	sessionAllowedPaths?: string[],
): string | null {
	// blocked_paths takes precedence
	const blocked = matchesPathPrefixes(rawPath, "filesystem", lists.blocked_paths, vaultRootPath);
	if (blocked !== null) {
		return `Path "${rawPath}" is blocked by path constraint "${blocked}".`;
	}

	// Per-session auto-allow (FR-121): allowed in addition to entry.allowed_paths.
	if (
		matchesPathPrefixes(rawPath, "filesystem", sessionAllowedPaths ?? [], vaultRootPath) !== null
	) {
		return null;
	}

	// allowed_paths: empty means no restriction
	if (
		lists.allowed_paths.length > 0 &&
		matchesPathPrefixes(rawPath, "filesystem", lists.allowed_paths, vaultRootPath) === null
	) {
		return `Path "${rawPath}" is not within any allowed path: [${lists.allowed_paths.join(", ")}].`;
	}

	return null;
}

/**
 * Resolve a filesystem path to absolute form: expand `~`, then resolve
 * relative paths against the vault root. Collapses `.` / `..` segments.
 */
function toAbsolutePath(rawPath: string, vaultRootPath: string): string {
	const expanded = expandTilde(rawPath);
	return isAbsolute(expanded) ? normalize(expanded) : normalize(resolve(vaultRootPath, expanded));
}

/**
 * Check if a vault-relative path matches a prefix.
 * Uses normalized forward-slash paths with boundary checking.
 */
function vaultPathMatchesPrefix(path: string, prefix: string): boolean {
	const normalizedPrefix = normalizePath(prefix);
	if (path === normalizedPrefix) return true;
	// Ensure prefix boundary at `/`
	const withTrailing = normalizedPrefix.endsWith("/") ? normalizedPrefix : normalizedPrefix + "/";
	return path.startsWith(withTrailing);
}

/**
 * Normalize a vault-relative path: trim, replace backslashes, remove
 * leading/trailing slashes, and collapse `.` / `..` segments.
 *
 * The `..` collapse keeps the vault namespace's notion of path identity aligned
 * with the filesystem namespace, which gets it from `path.normalize()`. A `..`
 * that would escape the vault root is preserved as a literal segment, so such a
 * path matches no prefix and fails closed.
 */
function normalizePath(p: string): string {
	const trimmed = p.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
	if (!trimmed.includes(".")) return trimmed;

	const out: string[] = [];
	for (const segment of trimmed.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			// Only collapse against a real segment; a leading `..` escapes the
			// vault and is kept literal so it matches nothing.
			const last = out[out.length - 1];
			if (last !== undefined && last !== "..") {
				out.pop();
				continue;
			}
		}
		out.push(segment);
	}
	return out.join("/");
}
