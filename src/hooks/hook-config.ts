/**
 * Hook configuration model — CRUD operations for lifecycle hooks.
 *
 * Manages ordered lists of hooks per lifecycle event with add, remove,
 * reorder, and toggle operations.
 *
 * @see specs/02-context-intelligence/data-model.md — Hook entity
 * @see specs/02-context-intelligence/tasks.md — HOOK-001
 */

import type { Hook, HookEvent, HookConfig } from "../settings";

// Re-export types for convenience
export type { Hook, HookEvent, HookConfig };

// ---------------------------------------------------------------------------
// UUID generation
// ---------------------------------------------------------------------------

/** Generate a simple UUID v4 for hook identification. */
function generateId(): string {
	return crypto.randomUUID?.() ??
		"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			const v = c === "x" ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
}

// ---------------------------------------------------------------------------
// CRUD helpers
// ---------------------------------------------------------------------------

/**
 * Add a new hook to the configuration for a specific event.
 *
 * @param config - Current hook configuration (mutated in place).
 * @param event - Lifecycle event to attach the hook to.
 * @param command - Shell command to execute.
 * @param label - Optional human-readable label.
 * @returns The newly created hook.
 */
export function addHook(
	config: HookConfig,
	event: HookEvent,
	command: string,
	label = ""
): Hook {
	const hook: Hook = {
		id: generateId(),
		event,
		command,
		label,
		enabled: true,
	};
	config[event].push(hook);
	return hook;
}

/**
 * Remove a hook from the configuration by ID.
 *
 * @param config - Current hook configuration (mutated in place).
 * @param hookId - ID of the hook to remove.
 * @returns True if the hook was found and removed.
 */
export function removeHook(config: HookConfig, hookId: string): boolean {
	for (const event of Object.keys(config) as HookEvent[]) {
		const idx = config[event].findIndex((h) => h.id === hookId);
		if (idx >= 0) {
			config[event].splice(idx, 1);
			return true;
		}
	}
	return false;
}

/**
 * Reorder hooks within a specific event by moving a hook to a new index.
 *
 * @param config - Current hook configuration (mutated in place).
 * @param event - Lifecycle event whose hooks to reorder.
 * @param hookId - ID of the hook to move.
 * @param newIndex - Target index (clamped to valid range).
 * @returns True if the hook was found and moved.
 */
export function reorderHooks(
	config: HookConfig,
	event: HookEvent,
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
 * Toggle a hook's enabled state.
 *
 * @param config - Current hook configuration (mutated in place).
 * @param hookId - ID of the hook to toggle.
 * @returns The new enabled state, or null if hook not found.
 */
export function toggleHook(config: HookConfig, hookId: string): boolean | null {
	for (const event of Object.keys(config) as HookEvent[]) {
		const hook = config[event].find((h) => h.id === hookId);
		if (hook) {
			hook.enabled = !hook.enabled;
			return hook.enabled;
		}
	}
	return null;
}

/**
 * Find a hook by ID across all event types.
 *
 * @param config - Hook configuration to search.
 * @param hookId - ID of the hook to find.
 * @returns The hook if found, or null.
 */
export function findHook(config: HookConfig, hookId: string): Hook | null {
	for (const event of Object.keys(config) as HookEvent[]) {
		const hook = config[event].find((h) => h.id === hookId);
		if (hook) return hook;
	}
	return null;
}

/**
 * Get all enabled hooks for a specific event, in order.
 *
 * @param config - Hook configuration.
 * @param event - Lifecycle event to query.
 * @returns Ordered list of enabled hooks.
 */
export function getEnabledHooks(config: HookConfig, event: HookEvent): Hook[] {
	return config[event].filter((h) => h.enabled);
}