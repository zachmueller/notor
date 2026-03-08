/**
 * Workflow hook override manager — tracks per-conversation workflow-scoped
 * hook overrides and resolves the effective hooks for each lifecycle event.
 *
 * When a workflow with `notor-hooks` frontmatter begins execution, its
 * scoped hooks are activated for that conversation. When the workflow
 * ends (success, failure, or user stop), the override is removed and
 * global hooks resume.
 *
 * Override semantics (per FR-52):
 * - Workflow-scoped hooks **replace** global hooks for overridden events.
 * - Global hooks for events NOT overridden by the workflow still apply.
 * - Only one workflow's hooks can be active per conversation at a time
 *   (last-write wins if `activate()` is called while one is already active).
 *
 * The manager is a singleton-like service instantiated once in `main.ts`
 * and shared across the orchestrator and hook dispatch functions.
 * State is in-memory only — it is lost on plugin reload (acceptable;
 * workflow execution state is also in-memory).
 *
 * Task covered:
 * - G-003: WorkflowHookOverrideManager
 *
 * @see specs/03-workflows-personas/data-model.md — WorkflowScopedHook, WorkflowHookConfig
 * @see specs/03-workflows-personas/spec.md — FR-52
 */

import type { Hook } from "../settings";
import type {
	LLMHookEvent,
	WorkflowHookConfig,
	WorkflowScopedHook,
} from "../types";
import { logger } from "../utils/logger";

const log = logger("WorkflowHookOverride");

// ---------------------------------------------------------------------------
// WorkflowHookOverrideManager
// ---------------------------------------------------------------------------

/**
 * Manages per-conversation workflow-scoped hook overrides.
 *
 * Instantiate once in `main.ts` and pass the reference to the orchestrator
 * and hook dispatch functions.
 */
export class WorkflowHookOverrideManager {
	/**
	 * Active overrides keyed by conversation ID.
	 * A missing entry means no override is active — global hooks apply.
	 */
	private readonly _overrides = new Map<string, WorkflowHookConfig>();

	// -------------------------------------------------------------------------
	// Activation / deactivation
	// -------------------------------------------------------------------------

	/**
	 * Activate workflow-scoped hook overrides for the given conversation.
	 *
	 * If an override is already active for this conversation it is replaced
	 * (last-write wins). This is safe because only one workflow can be
	 * executing in a given conversation at a time.
	 *
	 * @param conversationId - The conversation to scope these overrides to.
	 * @param workflowHooks  - The `WorkflowHookConfig` from the workflow's frontmatter.
	 */
	activate(conversationId: string, workflowHooks: WorkflowHookConfig): void {
		const hadPrevious = this._overrides.has(conversationId);
		this._overrides.set(conversationId, workflowHooks);

		log.info("Workflow hook overrides activated", {
			conversationId,
			replaced: hadPrevious,
			events: Object.keys(workflowHooks),
		});
	}

	/**
	 * Remove any workflow hook override for the given conversation, restoring
	 * global hook behaviour.
	 *
	 * Safe to call when no override is active (no-op in that case).
	 *
	 * @param conversationId - The conversation whose override should be cleared.
	 */
	deactivate(conversationId: string): void {
		const hadOverride = this._overrides.has(conversationId);
		this._overrides.delete(conversationId);

		if (hadOverride) {
			log.info("Workflow hook overrides deactivated", { conversationId });
		}
	}

	// -------------------------------------------------------------------------
	// Query
	// -------------------------------------------------------------------------

	/**
	 * Returns whether a workflow hook override is currently active for the
	 * given conversation.
	 *
	 * @param conversationId - The conversation to check.
	 */
	isOverrideActive(conversationId: string): boolean {
		return this._overrides.has(conversationId);
	}

	/**
	 * Returns the active `WorkflowHookConfig` for the given conversation,
	 * or `null` if no override is active.
	 *
	 * @param conversationId - The conversation to query.
	 */
	getActiveOverride(conversationId: string): WorkflowHookConfig | null {
		return this._overrides.get(conversationId) ?? null;
	}

	/**
	 * Resolve the effective hooks to execute for a given lifecycle event in
	 * the specified conversation.
	 *
	 * Resolution logic:
	 * - If an active workflow override exists for `conversationId` **and**
	 *   that override includes the requested `event` → return the
	 *   `WorkflowScopedHook[]` for that event (replaces global hooks).
	 * - Otherwise → return the supplied `globalHooks` unchanged.
	 *
	 * The return type is a discriminated union: callers can distinguish
	 * the two cases by checking whether the first element (if any) has an
	 * `action_type` property (workflow-scoped) vs. an `event` + `command`
	 * shape compatible with the settings `Hook` interface (global).
	 *
	 * @param conversationId - The conversation for which to resolve hooks.
	 * @param event          - The lifecycle event being dispatched.
	 * @param globalHooks    - The enabled global `Hook[]` for this event
	 *                         (from `getEnabledHooks(settings.hooks, event)`).
	 * @returns Either the workflow-scoped hooks or the global hooks.
	 */
	getEffectiveHooks(
		conversationId: string,
		event: LLMHookEvent,
		globalHooks: Hook[]
	): WorkflowScopedHook[] | Hook[] {
		const override = this._overrides.get(conversationId);

		if (override) {
			const scopedHooks = override[event];
			if (scopedHooks !== undefined && scopedHooks.length > 0) {
				log.debug("Using workflow-scoped hooks for event", {
					conversationId,
					event,
					count: scopedHooks.length,
				});
				return scopedHooks;
			}

			// Override is active but does not cover this event → use global hooks
			log.debug(
				"Workflow override active but does not cover event; using global hooks",
				{ conversationId, event }
			);
		}

		return globalHooks;
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	/**
	 * Clear all active override state.
	 *
	 * Called during `onunload()` to prevent any dangling state if the plugin
	 * is disabled and re-enabled without a full page reload.
	 */
	destroy(): void {
		const count = this._overrides.size;
		this._overrides.clear();
		if (count > 0) {
			log.info("WorkflowHookOverrideManager destroyed; cleared overrides", {
				count,
			});
		}
	}
}
