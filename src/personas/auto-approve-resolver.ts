/**
 * Auto-approve resolution service and storage helpers for per-persona
 * per-tool auto-approve overrides.
 *
 * This module is a pure logic layer with no Obsidian API dependencies,
 * making it easy to test in isolation. It provides:
 *
 * 1. **Resolution** — `resolveAutoApprove()` determines the effective
 *    auto-approve decision for a tool given an active persona.
 * 2. **Storage helpers** — CRUD operations on the `persona_auto_approve`
 *    field in `NotorSettings`.
 *
 * @see specs/03-workflows-personas/data-model.md — PersonaAutoApproveConfig
 * @see specs/03-workflows-personas/spec.md — FR-40
 * @see specs/03-workflows-personas/tasks/group-b-tasks.md — B-002, B-006
 */

import type { AutoApproveState } from "../types";
import type { NotorSettings } from "../settings";

// ---------------------------------------------------------------------------
// Resolution (B-002)
// ---------------------------------------------------------------------------

/**
 * Resolve the effective auto-approve decision for a tool call.
 *
 * Resolution logic (from data-model.md):
 * 1. If no persona is active (`personaName` is null) → use global setting.
 * 2. If a persona is active → check `personaOverrides[personaName][toolName]`:
 *    - `"approve"` → return `true`
 *    - `"deny"` → return `false`
 *    - `"global"` or not present → fall back to global setting.
 *
 * **Important:** This function does NOT consider Plan/Act mode. That check
 * remains in the dispatcher, upstream of auto-approve resolution.
 *
 * @param toolName - Name of the tool being dispatched
 * @param personaName - Active persona name, or null if no persona is active
 * @param personaOverrides - Full persona auto-approve config from settings
 *        (`settings.persona_auto_approve`)
 * @param globalAutoApprove - Global per-tool auto-approve settings
 *        (`settings.auto_approve`)
 * @returns `true` if the tool should be auto-approved, `false` if it
 *          requires user approval
 */
export function resolveAutoApprove(
	toolName: string,
	personaName: string | null,
	personaOverrides: Record<string, Record<string, string>>,
	globalAutoApprove: Record<string, boolean>
): boolean {
	// No active persona → global only
	if (personaName === null) {
		return globalAutoApprove[toolName] ?? false;
	}

	// Look up persona overrides
	const overrides = personaOverrides[personaName];
	if (!overrides) {
		// Persona exists but has no overrides configured → fall back to global
		return globalAutoApprove[toolName] ?? false;
	}

	const state = overrides[toolName] as AutoApproveState | undefined;

	switch (state) {
		case "approve":
			return true;
		case "deny":
			return false;
		case "global":
		default:
			// "global", undefined, or any unrecognized value → fall back
			return globalAutoApprove[toolName] ?? false;
	}
}

// ---------------------------------------------------------------------------
// Storage Helpers (B-006)
// ---------------------------------------------------------------------------

/**
 * Get the auto-approve overrides map for a specific persona.
 *
 * Returns an empty record if the persona has no overrides configured.
 *
 * @param settings - Plugin settings object
 * @param personaName - Persona name to look up
 * @returns Map of tool name → AutoApproveState for this persona
 */
export function getPersonaOverrides(
	settings: NotorSettings,
	personaName: string
): Record<string, AutoApproveState> {
	const raw = settings.persona_auto_approve[personaName];
	if (!raw) return {};
	// Cast string values to AutoApproveState (validated at write time)
	return raw as Record<string, AutoApproveState>;
}

/**
 * Set a single tool override for a persona.
 *
 * Creates the persona entry in `persona_auto_approve` if it doesn't exist.
 * If `state` is `"global"`, the entry is removed (since "global" is the
 * default — no need to store it explicitly).
 *
 * The caller is responsible for calling `saveData()` after mutation.
 *
 * @param settings - Plugin settings object (mutated in place)
 * @param personaName - Persona name
 * @param toolName - Tool name
 * @param state - Override state to set
 */
export function setPersonaToolOverride(
	settings: NotorSettings,
	personaName: string,
	toolName: string,
	state: AutoApproveState
): void {
	if (!settings.persona_auto_approve[personaName]) {
		settings.persona_auto_approve[personaName] = {};
	}

	if (state === "global") {
		// Remove the entry — "global" is the default, no need to persist
		delete settings.persona_auto_approve[personaName]![toolName];

		// Clean up empty persona entries
		const remaining = settings.persona_auto_approve[personaName]!;
		if (Object.keys(remaining).length === 0) {
			delete settings.persona_auto_approve[personaName];
		}
	} else {
		settings.persona_auto_approve[personaName]![toolName] = state;
	}
}

/**
 * Remove all auto-approve overrides for a persona.
 *
 * Used for cleanup when a persona is deleted. The caller is responsible
 * for calling `saveData()` after mutation.
 *
 * @param settings - Plugin settings object (mutated in place)
 * @param personaName - Persona name whose overrides should be removed
 */
export function removePersonaOverrides(
	settings: NotorSettings,
	personaName: string
): void {
	delete settings.persona_auto_approve[personaName];
}

/**
 * Identify tool names in a persona's overrides that are no longer
 * registered in the tool registry.
 *
 * Stale entries can occur when an MCP tool is removed or a built-in
 * tool is renamed. The settings UI uses this to display warning
 * indicators on stale entries.
 *
 * @param personaOverrides - Overrides map for a single persona
 *        (e.g., `settings.persona_auto_approve["researcher"]`)
 * @param registeredToolNames - Array of currently registered tool names
 * @returns Array of tool names present in overrides but not in the
 *          registered tool list
 */
export function getStaleToolNames(
	personaOverrides: Record<string, string>,
	registeredToolNames: string[]
): string[] {
	const registeredSet = new Set(registeredToolNames);
	return Object.keys(personaOverrides).filter(
		(toolName) => !registeredSet.has(toolName)
	);
}
