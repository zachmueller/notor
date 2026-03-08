/**
 * CRUD helpers for vault event hook configuration.
 *
 * Mirrors the pattern established in `src/hooks/hook-config.ts` for LLM
 * lifecycle hooks. Supports add, remove, reorder, toggle, and query
 * operations grouped by vault event type.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-002
 */

import type { VaultEventHook, VaultEventHookConfig, VaultEventHookType } from "../types";

// ---------------------------------------------------------------------------
// UUID generation
// ---------------------------------------------------------------------------

/** Generate a simple UUID v4 for hook identification. */
function generateId(): string {
	return (
		crypto.randomUUID?.() ??
		"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			const v = c === "x" ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		})
	);
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Add a new vault event hook to the configuration.
 *
 * @param config - Current vault event hook configuration (mutated in place).
 * @param event - Vault event type to attach the hook to.
 * @param actionType - Whether the hook executes a shell command or runs a workflow.
 * @param commandOrPath - Shell command (for "execute_command") or workflow path (for "run_workflow").
 * @param label - Optional human-readable label.
 * @param schedule - Cron expression (required for "on_schedule" event).
 * @returns The newly created hook.
 * @throws Error if validation fails (e.g., missing command/path, missing schedule for on_schedule).
 */
export function addVaultEventHook(
	config: VaultEventHookConfig,
	event: VaultEventHookType,
	actionType: "execute_command" | "run_workflow",
	commandOrPath: string,
	label = "",
	schedule: string | null = null
): VaultEventHook {
	// Validate action type requirements
	if (actionType === "execute_command" && !commandOrPath.trim()) {
		throw new Error(
			`action_type "execute_command" requires a non-empty shell command.`
		);
	}
	if (actionType === "run_workflow" && !commandOrPath.trim()) {
		throw new Error(
			`action_type "run_workflow" requires a non-empty workflow path.`
		);
	}

	// Validate schedule for on_schedule event
	if (event === "on_schedule" && !schedule?.trim()) {
		throw new Error(
			`Event type "on_schedule" requires a non-empty cron schedule expression.`
		);
	}

	const hook: VaultEventHook = {
		id: generateId(),
		event,
		action_type: actionType,
		command: actionType === "execute_command" ? commandOrPath.trim() : null,
		workflow_path: actionType === "run_workflow" ? commandOrPath.trim() : null,
		label,
		enabled: true,
		schedule: event === "on_schedule" ? (schedule?.trim() ?? null) : null,
	};

	config[event].push(hook);
	return hook;
}

/**
 * Remove a vault event hook from the configuration by ID.
 *
 * Searches across all event types.
 *
 * @param config - Current vault event hook configuration (mutated in place).
 * @param hookId - ID of the hook to remove.
 * @returns True if the hook was found and removed.
 */
export function removeVaultEventHook(
	config: VaultEventHookConfig,
	hookId: string
): boolean {
	for (const event of Object.keys(config) as VaultEventHookType[]) {
		const idx = config[event].findIndex((h) => h.id === hookId);
		if (idx >= 0) {
			config[event].splice(idx, 1);
			return true;
		}
	}
	return false;
}

/**
 * Reorder vault event hooks within a specific event type by moving a
 * hook to a new index.
 *
 * @param config - Current vault event hook configuration (mutated in place).
 * @param event - Vault event type whose hooks to reorder.
 * @param hookId - ID of the hook to move.
 * @param newIndex - Target index (clamped to valid range).
 * @returns True if the hook was found and moved.
 */
export function reorderVaultEventHooks(
	config: VaultEventHookConfig,
	event: VaultEventHookType,
	hookId: string,
	newIndex: number
): boolean {
	const list = config[event];
	const currentIdx = list.findIndex((h) => h.id === hookId);
	if (currentIdx < 0) return false;

	const [hook] = list.splice(currentIdx, 1);
	if (!hook) return false;

	const clampedIndex = Math.max(0, Math.min(newIndex, list.length));
	list.splice(clampedIndex, 0, hook);
	return true;
}

/**
 * Toggle a vault event hook's enabled state.
 *
 * @param config - Current vault event hook configuration (mutated in place).
 * @param hookId - ID of the hook to toggle.
 * @returns The new enabled state, or null if the hook was not found.
 */
export function toggleVaultEventHook(
	config: VaultEventHookConfig,
	hookId: string
): boolean | null {
	for (const event of Object.keys(config) as VaultEventHookType[]) {
		const hook = config[event].find((h) => h.id === hookId);
		if (hook) {
			hook.enabled = !hook.enabled;
			return hook.enabled;
		}
	}
	return null;
}

/**
 * Get all enabled hooks for a specific vault event type, in order.
 *
 * @param config - Vault event hook configuration.
 * @param event - Vault event type to query.
 * @returns Ordered list of enabled hooks for the given event type.
 */
export function getEnabledVaultEventHooks(
	config: VaultEventHookConfig,
	event: VaultEventHookType
): VaultEventHook[] {
	return config[event].filter((h) => h.enabled);
}
