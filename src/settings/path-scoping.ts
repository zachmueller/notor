/**
 * Global path-scoping settings: the rule model and the settings→config bridge.
 *
 * Users author one **rule per path prefix**, choosing independently what the AI
 * may do when reading and when writing that path. Each rule is projected into
 * the four per-group path lists the enforcer consumes, so the two severity tiers
 * behind those lists still apply:
 *
 * - **Access tier** (`allowed_paths` / `blocked_paths`, from the `allow`,
 *   `allow_auto`, and `blocked` states) — a hard gate. The global value is a
 *   **floor**: per-context `<notor_tool_config>` can only narrow it (allow lists
 *   intersect, block lists union), so a persona can never widen what the user
 *   globally forbade.
 * - **Approval tier** (`auto_approve_paths` / `never_auto_approve_paths`, from
 *   the `auto_approve`, `allow_auto`, and `always_ask` states) — a soft gate
 *   that only decides whether a human sees the approval prompt. The global value
 *   is a **default**: a per-context list replaces it outright, since the worst
 *   case is a prompt the user opted out of.
 *
 * Rules live in `settings.path_scope_rules`. Enforcement never sees them — it
 * only sees the projected `PathListSet` per `namespace × access` group.
 *
 * Distinct from the pre-existing filesystem *expansion* settings
 * (`read_file_allowed_paths`, `execute_command_allowed_paths`), which **add**
 * directories outside the vault. These rules **restrict**.
 */

import type { PathGroup, PathListSet } from "../tool-config/types";

/** The four path lists each group carries, in display order. */
export const PATH_SCOPE_LISTS = [
	"allowed_paths",
	"blocked_paths",
	"auto_approve_paths",
	"never_auto_approve_paths",
] as const;

export type PathScopeList = (typeof PATH_SCOPE_LISTS)[number];

/** What a rule permits for one access direction (read or write) of one path. */
export type PathRuleState =
	| "default"
	| "auto_approve"
	| "always_ask"
	| "allow"
	| "allow_auto"
	| "blocked";

/**
 * One user-authored path rule: a prefix plus independent read and write states.
 *
 * The prefix is stored as typed (whitespace-trimmed only). Both matchers compare
 * on segment boundaries, so `ai` and `ai/` behave identically and normalizing
 * would only surprise someone reading their own `data.json`.
 */
export interface PathScopeRule {
	path: string;
	read: PathRuleState;
	write: PathRuleState;
}

/** Dropdown vocabulary, in display order. */
export const PATH_RULE_STATES: ReadonlyArray<{
	state: PathRuleState;
	label: string;
	description: string;
}> = [
	{
		state: "default",
		label: "Default",
		description: "No rule. Calls are allowed and prompt for approval as usual.",
	},
	{
		state: "auto_approve",
		label: "Auto-approve",
		description: "Skip the approval prompt here. Convenience, not a boundary.",
	},
	{
		state: "always_ask",
		label: "Always ask",
		description: "Always prompt here, even for tools set to auto-approve.",
	},
	{
		state: "allow",
		label: "Allow only",
		description:
			"Restrict this direction to the paths marked Allow only. Everything else is blocked.",
	},
	{
		state: "allow_auto",
		label: "Allow + auto-approve",
		description: "Allow only, and skip the approval prompt here.",
	},
	{
		state: "blocked",
		label: "Blocked",
		description: "Never allow this direction here. No persona can override it.",
	},
];

/** Which lists each state contributes to. `default` contributes nothing. */
const STATE_TO_LISTS: Record<Exclude<PathRuleState, "default">, ReadonlyArray<PathScopeList>> = {
	auto_approve: ["auto_approve_paths"],
	always_ask: ["never_auto_approve_paths"],
	allow: ["allowed_paths"],
	allow_auto: ["allowed_paths", "auto_approve_paths"],
	blocked: ["blocked_paths"],
};

/** Display metadata for the four groups: what each one governs. */
export const PATH_GROUPS: ReadonlyArray<{
	group: PathGroup;
	name: string;
	description: string;
}> = [
	{
		group: "vault-read",
		name: "Vault — read",
		description:
			"Note paths the AI reads from: read_note, search_vault, get_backlinks, and the note inputs of the DOCX tools.",
	},
	{
		group: "vault-write",
		name: "Vault — write",
		description:
			"Note paths the AI creates, edits, moves, or deletes: write_note, replace_in_note, move_note, delete_note, apply_template.",
	},
	{
		group: "filesystem-read",
		name: "Filesystem — read",
		description:
			"Files outside the vault the AI reads: read_file, read_docx, import_docx, and DOCX templates.",
	},
	{
		group: "filesystem-write",
		name: "Filesystem — write",
		description:
			"Files outside the vault the AI writes: write_file, replace_in_file, DOCX output, and the execute_command working directory.",
	},
];

/** Short labels for the restrict-mode hint, e.g. "Vault reads restricted to: …". */
export const PATH_GROUP_PHRASES: Record<PathGroup, string> = {
	"vault-read": "Vault reads",
	"vault-write": "Vault writes",
	"filesystem-read": "Filesystem reads",
	"filesystem-write": "Filesystem writes",
};

/** A drive-qualified Windows path (`C:\x`, `c:/x`). The separator is required. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/**
 * Which namespaces a rule's path governs, inferred from its shape.
 *
 * A `~`-prefixed, root-relative, or drive-qualified path can only ever name a
 * file outside the vault, so it governs the filesystem groups alone. Anything
 * else is relative, and relative prefixes reach **both** namespaces: the vault
 * matcher takes them as vault-relative note paths, and the filesystem matcher
 * resolves them against the vault root, so a rule on `private/` also governs
 * `read_file private/notes.md`. Covering both is the fail-closed reading.
 *
 * Detection is deliberately string-shaped rather than `path.isAbsolute`, which
 * returns false for `C:\x` off Windows and would make `data.json` unportable.
 */
export function detectRuleNamespace(path: string): "filesystem" | "both" {
	const trimmed = path.trim();
	if (trimmed.startsWith("~")) return "filesystem";
	if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return "filesystem";
	if (WINDOWS_DRIVE.test(trimmed)) return "filesystem";
	return "both";
}

/** Empty lists for one group. */
function emptyLists(): PathListSet {
	return {
		allowed_paths: [],
		blocked_paths: [],
		auto_approve_paths: [],
		never_auto_approve_paths: [],
	};
}

/**
 * Project the user's rules into the per-group path lists the enforcer consumes.
 *
 * A group is included only when at least one of its lists is non-empty, so the
 * common unrestricted case yields `{}` and every downstream group lookup is a
 * cheap miss.
 *
 * Tolerant of hand-edited `data.json`: a blank path is skipped, and an
 * unrecognized state is treated as `default`. Neither can grant access, since
 * granting requires landing in `allowed_paths` or `auto_approve_paths`.
 */
export function buildGlobalPathScopes(
	rules: readonly PathScopeRule[] | undefined,
): Partial<Record<PathGroup, PathListSet>> {
	if (!rules || rules.length === 0) return {};

	const scopes: Partial<Record<PathGroup, PathListSet>> = {};

	for (const rule of rules) {
		if (typeof rule?.path !== "string") continue;
		const path = rule.path.trim();
		if (path === "") continue;

		const namespaces: ReadonlyArray<"vault" | "filesystem"> =
			detectRuleNamespace(path) === "filesystem" ? ["filesystem"] : ["vault", "filesystem"];

		for (const access of ["read", "write"] as const) {
			const state = rule[access];
			if (state === "default" || !state) continue;
			const lists = STATE_TO_LISTS[state];
			if (!lists) continue;

			for (const namespace of namespaces) {
				const group = `${namespace}-${access}` as PathGroup;
				const target = (scopes[group] ??= emptyLists());
				for (const list of lists) {
					target[list].push(path);
				}
			}
		}
	}

	return scopes;
}

/**
 * The allow-listed paths per group, for the Settings hint that warns when a
 * direction has been narrowed to a fixed set of paths.
 */
export function restrictSummary(
	rules: readonly PathScopeRule[],
): Partial<Record<PathGroup, string[]>> {
	const scopes = buildGlobalPathScopes(rules);
	const summary: Partial<Record<PathGroup, string[]>> = {};
	for (const { group } of PATH_GROUPS) {
		const allowed = scopes[group]?.allowed_paths;
		if (allowed && allowed.length > 0) summary[group] = allowed;
	}
	return summary;
}
