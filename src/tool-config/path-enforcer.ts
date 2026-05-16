/**
 * Path constraint enforcement for tool calls.
 *
 * Checks tool call path arguments against the effective `allowed_paths`
 * and `blocked_paths` constraints at dispatch time.
 *
 * @see specs/04b-tool-toggle/spec.md — FR-84
 * @see specs/04b-tool-toggle/research/RT-1-path-argument-inspection.md
 */

import type { PathNamespace, ResolvedToolConfigEntry, ToolPathParam } from "./types";
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
 * @param toolName         - The tool being called.
 * @param parameters       - The tool call parameters (from the LLM).
 * @param entry            - The resolved tool config entry for this tool.
 * @param vaultRootPath    - Absolute path to the vault root directory.
 * @param resolveVaultPath - Optional resolver for vault note paths. Returns canonical path or null.
 * @returns `null` if the call is allowed, or an error message string if blocked.
 */
export function enforcePathConstraints(
	toolName: string,
	parameters: Record<string, unknown>,
	entry: ResolvedToolConfigEntry,
	vaultRootPath: string,
	resolveVaultPath?: (path: string) => string | null,
): string | null {
	// Tools not in the descriptor table (e.g., MCP tools) → exempt
	const pathParams = TOOL_PATH_PARAMS[toolName];
	if (pathParams === undefined) return null;

	// Tools with empty path params (e.g., fetch_webpage) → exempt
	if (pathParams.length === 0) return null;

	// No constraints configured → allow
	if (entry.allowed_paths.length === 0 && entry.blocked_paths.length === 0) return null;

	for (const param of pathParams) {
		const rawValue = parameters[param.paramName];
		if (typeof rawValue !== "string") continue;
		const pathValue = rawValue;
		if (pathValue.trim() === "") continue;

		// Resolve note paths to canonical form before constraint check
		let effectivePath = pathValue;
		if (param.resolveAs === "note" && param.namespace === "vault" && resolveVaultPath) {
			const resolved = resolveVaultPath(pathValue);
			if (resolved !== null) {
				effectivePath = resolved;
			}
		}

		const error = checkPath(effectivePath, param.namespace, entry, vaultRootPath);
		if (error) {
			return `Tool "${toolName}" path constraint violation: ${error}`;
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check a single path value against allowed/blocked constraints.
 */
function checkPath(
	pathValue: string,
	namespace: PathNamespace,
	entry: ResolvedToolConfigEntry,
	vaultRootPath: string,
): string | null {
	if (namespace === "vault") {
		return checkVaultPath(pathValue, entry);
	} else {
		return checkFilesystemPath(pathValue, entry, vaultRootPath);
	}
}

/**
 * Vault-namespace: string prefix matching on vault-relative path.
 */
function checkVaultPath(
	vaultPath: string,
	entry: ResolvedToolConfigEntry,
): string | null {
	const normalized = normalizePath(vaultPath);

	// blocked_paths takes precedence over allowed_paths
	if (entry.blocked_paths.length > 0) {
		for (const blocked of entry.blocked_paths) {
			if (vaultPathMatchesPrefix(normalized, blocked)) {
				return `Path "${vaultPath}" is blocked by path constraint "${blocked}".`;
			}
		}
	}

	// allowed_paths: empty means no restriction
	if (entry.allowed_paths.length > 0) {
		const allowed = entry.allowed_paths.some((prefix) =>
			vaultPathMatchesPrefix(normalized, prefix),
		);
		if (!allowed) {
			return `Path "${vaultPath}" is not within any allowed path: [${entry.allowed_paths.join(", ")}].`;
		}
	}

	return null;
}

/**
 * Filesystem-namespace: resolve to absolute path, then compare.
 */
function checkFilesystemPath(
	rawPath: string,
	entry: ResolvedToolConfigEntry,
	vaultRootPath: string,
): string | null {
	const expandedPath = expandTilde(rawPath);
	const absolutePath = isAbsolute(expandedPath)
		? normalize(expandedPath)
		: normalize(resolve(vaultRootPath, expandedPath));

	// blocked_paths takes precedence
	if (entry.blocked_paths.length > 0) {
		for (const blocked of entry.blocked_paths) {
			const expandedBlocked = expandTilde(blocked);
			const absBlocked = isAbsolute(expandedBlocked)
				? normalize(expandedBlocked)
				: normalize(resolve(vaultRootPath, expandedBlocked));
			if (isPathWithin(absolutePath, absBlocked)) {
				return `Path "${rawPath}" is blocked by path constraint "${blocked}".`;
			}
		}
	}

	// allowed_paths: empty means no restriction
	if (entry.allowed_paths.length > 0) {
		const allowed = entry.allowed_paths.some((prefix) => {
			const expandedPrefix = expandTilde(prefix);
			const absAllowed = isAbsolute(expandedPrefix)
				? normalize(expandedPrefix)
				: normalize(resolve(vaultRootPath, expandedPrefix));
			return isPathWithin(absolutePath, absAllowed);
		});
		if (!allowed) {
			return `Path "${rawPath}" is not within any allowed path: [${entry.allowed_paths.join(", ")}].`;
		}
	}

	return null;
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
 * Normalize a vault-relative path: trim, replace backslashes, remove leading/trailing slashes.
 */
function normalizePath(p: string): string {
	return p.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
