/**
 * Auto-approve resolution service.
 *
 * Provides the `resolveAutoApprove()` function that determines the effective
 * auto-approve decision for a built-in tool given global settings.
 *
 * Per-persona auto-approve overrides (Phase 4 `persona_auto_approve`) have
 * been removed in favour of `<notor_tool_config>` (Phase 4b). The storage
 * helpers (`getPersonaOverrides`, `setPersonaToolOverride`,
 * `removePersonaOverrides`, `getStaleToolNames`) are no longer needed.
 *
 * @see specs/04b-tool-toggle/tasks.md — CLEAN-001
 */

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective auto-approve decision for a tool call.
 *
 * Returns the global auto-approve setting for the tool, defaulting to
 * `false` if the tool has no explicit setting.
 *
 * **Important:** This function does NOT consider Plan/Act mode. That check
 * remains in the dispatcher, upstream of auto-approve resolution.
 *
 * @param toolName - Name of the tool being dispatched
 * @param globalAutoApprove - Global per-tool auto-approve settings
 *        (`settings.auto_approve`)
 * @returns `true` if the tool should be auto-approved, `false` if it
 *          requires user approval
 */
export function resolveAutoApprove(
	toolName: string,
	globalAutoApprove: Record<string, boolean>
): boolean {
	return globalAutoApprove[toolName] ?? false;
}
