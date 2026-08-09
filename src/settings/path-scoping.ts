/**
 * Global path-scoping settings: definitions and the settings→config bridge.
 *
 * Two severity tiers over one matcher, scoped by `namespace × access` group:
 *
 * - **Access tier** (`allowed_paths` / `blocked_paths`) — a hard gate. The global
 *   value is a **floor**: per-context `<notor_tool_config>` can only narrow it
 *   (allow lists intersect, block lists union), so a persona can never widen
 *   what the user globally forbade.
 * - **Approval tier** (`auto_approve_paths` / `never_auto_approve_paths`) — a soft
 *   gate that only decides whether a human sees the approval prompt. The global
 *   value is a **default**: a per-context list replaces it outright, since the
 *   worst case is a prompt the user opted out of.
 *
 * Values live in `settings.user_shared_settings` (the cross-tool surface that
 * also holds `read_file_allowed_paths`), keyed `path_scope_<group>_<list>`.
 * Enforcement reads those keys directly, so it never depends on the schema
 * below being registered with the extension manager.
 *
 * Distinct from the pre-existing filesystem *expansion* settings
 * (`read_file_allowed_paths`, `execute_command_allowed_paths`), which **add**
 * directories outside the vault. These lists **restrict**.
 */

import type { SettingsFieldSchema } from "../extensions/types";
import type { PathGroup, PathListSet } from "../tool-config/types";

/** The four path lists each group carries, in display order. */
export const PATH_SCOPE_LISTS = [
	"allowed_paths",
	"blocked_paths",
	"auto_approve_paths",
	"never_auto_approve_paths",
] as const;

export type PathScopeList = (typeof PATH_SCOPE_LISTS)[number];

/** Which tier a list belongs to — drives the Access/Approval grouping in Settings. */
export const PATH_SCOPE_TIER: Record<PathScopeList, "access" | "approval"> = {
	allowed_paths: "access",
	blocked_paths: "access",
	auto_approve_paths: "approval",
	never_auto_approve_paths: "approval",
};

/** Display metadata for the four groups, in Settings display order. */
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

/** Per-list label and help text, shared across all four groups. */
const LIST_META: Record<PathScopeList, { name: string; description: string }> = {
	allowed_paths: {
		name: "Allowed paths",
		description:
			"Restrict this group to these path prefixes. Empty means no restriction. Out-of-bounds calls are blocked and the AI is told why. A persona or workflow can narrow this further but never widen it.",
	},
	blocked_paths: {
		name: "Blocked paths",
		description:
			"Never allow this group to touch these path prefixes. Takes precedence over Allowed paths. No persona or workflow can override it.",
	},
	auto_approve_paths: {
		name: "Auto-approve paths",
		description:
			"Skip the approval prompt for calls under these prefixes. Calls elsewhere still run — they just wait for your approval. This is convenience, not a security boundary; use Blocked paths to actually forbid access. A persona that sets its own list replaces this default.",
	},
	never_auto_approve_paths: {
		name: "Never auto-approve paths",
		description:
			"Always ask for approval under these prefixes, even for tools you have set to auto-approve.",
	},
};

/** The settings key for one group/list pair, e.g. `path_scope_vault_write_allowed_paths`. */
export function pathScopeKey(group: PathGroup, list: PathScopeList): string {
	return `path_scope_${group.replace("-", "_")}_${list}`;
}

/**
 * The sixteen `string[]` field schemas (4 groups × 4 lists).
 *
 * Rendered by the hand-rolled Path scoping section, which groups them by tier.
 * Deliberately NOT part of `BUILTIN_SHARED_SETTINGS_SCHEMA`: that constant is a
 * fallback a user-authored `notor/settings.md` replaces wholesale, and these
 * fields must not disappear when someone customizes that file.
 */
export const PATH_SCOPING_SETTINGS_SCHEMA: readonly SettingsFieldSchema[] = PATH_GROUPS.flatMap(
	({ group, name }) =>
		PATH_SCOPE_LISTS.map((list) => ({
			key: pathScopeKey(group, list),
			name: `${name}: ${LIST_META[list].name}`,
			type: "string[]" as const,
			description: LIST_META[list].description,
			default: [] as string[],
		})),
);

/** Field schema for one group/list pair, for the grouped Settings renderer. */
export function pathScopeField(group: PathGroup, list: PathScopeList): SettingsFieldSchema {
	return {
		key: pathScopeKey(group, list),
		name: LIST_META[list].name,
		type: "string[]",
		description: LIST_META[list].description,
		default: [],
	};
}

/**
 * Read the global group scopes out of persisted shared settings.
 *
 * A group is included only when at least one of its lists is non-empty, so the
 * common unrestricted case yields `{}` and every downstream group lookup is a
 * cheap miss.
 */
export function buildGlobalPathScopes(
	userSharedSettings: Record<string, string | number | boolean | string[]> | undefined,
): Partial<Record<PathGroup, PathListSet>> {
	if (!userSharedSettings) return {};

	const scopes: Partial<Record<PathGroup, PathListSet>> = {};
	for (const { group } of PATH_GROUPS) {
		const lists = {} as PathListSet;
		let hasAny = false;
		for (const list of PATH_SCOPE_LISTS) {
			const value = userSharedSettings[pathScopeKey(group, list)];
			const paths = Array.isArray(value) ? value.filter((p) => typeof p === "string" && p.trim() !== "") : [];
			lists[list] = paths;
			if (paths.length > 0) hasAny = true;
		}
		if (hasAny) scopes[group] = lists;
	}
	return scopes;
}
