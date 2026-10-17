/**
 * Legacy tool-name aliases.
 *
 * Circuit tools were renamed from their orchestration-era names. Only the new
 * names are advertised to the LLM; the legacy names keep resolving silently
 * wherever a tool name acts as a key: dispatch, `<notor_tool_config>` blocks,
 * global per-tool settings (migrated once), and vault override files under
 * `{notor_dir}/tools/`. This lets old step prompts, personas, and settings keep
 * working with no edits.
 *
 * Do NOT confuse the tool name `run_flow` with the persisted session
 * `origin: "run_flow"` discriminator in session.json, which is unchanged.
 */

/** Legacy name → canonical name. */
export const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = Object.freeze({
	run_flow: "run_circuit",
	orchestration_task_ensure: "circuit_task_ensure",
	orchestration_task_start: "circuit_task_start",
	orchestration_task_close: "circuit_task_close",
	orchestration_task_list: "circuit_task_list",
});

/** Resolve a possibly-legacy tool name to its canonical name (identity for every other name). */
export function canonicalToolName(name: string): string {
	return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_NAMES, name) ? LEGACY_TOOL_NAMES[name]! : name;
}

/** Legacy names that resolve to `canonical` (empty for tools that were never renamed). */
export function legacyToolNamesFor(canonical: string): string[] {
	return Object.entries(LEGACY_TOOL_NAMES)
		.filter(([, target]) => target === canonical)
		.map(([legacy]) => legacy);
}
