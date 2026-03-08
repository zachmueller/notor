/**
 * Hook event dispatching — triggers hooks at correct lifecycle points.
 *
 * Provides four dispatch functions corresponding to the four hook events:
 * - `dispatchPreSend` — awaits sequentially, returns concatenated stdout
 * - `dispatchOnToolCall` — fire-and-forget sequential
 * - `dispatchOnToolResult` — fire-and-forget sequential
 * - `dispatchAfterCompletion` — fire-and-forget sequential
 *
 * F-022: Each dispatch function now checks `hook.action_type` before executing.
 * Hooks with `action_type: "run_workflow"` are routed to `executeRunWorkflowAction()`
 * via lazy import to avoid circular dependencies. Hooks without `action_type` or
 * with `action_type: "execute_command"` use the existing `executeHook()` path.
 *
 * @see specs/02-context-intelligence/data-model.md — Hook entity
 * @see specs/02-context-intelligence/tasks.md — HOOK-003
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-022
 */

import { Notice } from "obsidian";
import type { NotorSettings } from "../settings";
import type { Hook } from "../settings";
import { getEnabledHooks } from "./hook-config";
import { executeHook, type HookContext } from "./hook-engine";
import { logger } from "../utils/logger";

const log = logger("HookEvents");

// ---------------------------------------------------------------------------
// F-022: run_workflow action dispatcher for Phase 3 lifecycle hooks
// ---------------------------------------------------------------------------

/**
 * Context passed to `executeRunWorkflowAction()` when called from a Phase 3
 * lifecycle hook. Lifecycle hooks have conversationId but no note path.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-022
 */
interface LifecycleHookWorkflowContext {
	conversationId: string;
	hookEvent: string;
	timestamp: string;
}

/**
 * Execute a `run_workflow` action for a Phase 3 LLM lifecycle hook.
 *
 * Builds a minimal `VaultEventHookContext` from the lifecycle hook context,
 * then delegates to `executeRunWorkflowAction()` from the vault event dispatcher.
 *
 * Fire-and-forget: callers do not await this function directly —
 * it is awaited inside sequential loops or wrapped in void().
 *
 * If `workflow_path` is missing or empty, skips with a Notice.
 *
 * @param hook    - The lifecycle hook with `action_type: "run_workflow"`.
 * @param context - Lifecycle hook context (conversation ID, event, timestamp).
 * @param settings - Plugin settings (for vault root path access).
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-022
 */
async function executeLifecycleHookWorkflowAction(
	hook: Hook,
	context: LifecycleHookWorkflowContext,
	settings: NotorSettings
): Promise<void> {
	const workflowPath = hook.workflow_path;
	if (!workflowPath?.trim()) {
		log.warn("run_workflow lifecycle hook has no workflow_path; skipping", {
			hookId: hook.id,
			hookEvent: context.hookEvent,
		});
		new Notice(`Hook '${hook.label || hook.id}' has no workflow path configured; skipping.`);
		return;
	}

	log.info("Routing lifecycle hook to run_workflow action", {
		hookId: hook.id,
		hookEvent: context.hookEvent,
		workflowPath,
	});

	// Lazily import to avoid circular dependency (dispatcher imports orchestrator,
	// orchestrator imports hook-events).
	const { executeRunWorkflowAction } = await import("./vault-event-dispatcher");

	// We need DispatcherDeps — retrieve them from the singleton wired in main.ts.
	// Since lifecycle hooks do not carry dispatcher deps directly, we access the
	// globally-registered deps object (set by main.ts via registerDispatcherDeps).
	const deps = getRegisteredDispatcherDeps();
	if (!deps) {
		log.warn("Dispatcher deps not registered; cannot execute run_workflow lifecycle hook", {
			hookId: hook.id,
		});
		new Notice(`Cannot run workflow '${workflowPath}': plugin not fully initialised.`);
		return;
	}

	// Build a VaultEventHookContext for the lifecycle trigger
	// (lifecycle events have no note path or tag diff)
	const vaultContext: import("./vault-event-hook-engine").VaultEventHookContext = {
		hookEvent: context.hookEvent,
		timestamp: context.timestamp,
		notePath: null,
		tagsAdded: null,
		tagsRemoved: null,
	};

	await executeRunWorkflowAction(workflowPath, vaultContext, null, deps);
}

// ---------------------------------------------------------------------------
// Dispatcher deps registry (for lifecycle hook → run_workflow routing)
// ---------------------------------------------------------------------------

/**
 * Globally registered dispatcher dependencies, set by `main.ts` after the
 * vault event hook system is initialised (F-023).
 *
 * Used exclusively by `executeLifecycleHookWorkflowAction()` to execute
 * `run_workflow` actions from Phase 3 lifecycle hooks.
 */
let _registeredDispatcherDeps: import("./vault-event-dispatcher").DispatcherDeps | null = null;

/**
 * Register the dispatcher dependencies for lifecycle hook → run_workflow routing.
 *
 * Called by `main.ts` after the vault event hook dispatcher is fully wired.
 * Safe to call multiple times (e.g., on settings reload).
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-022
 */
export function registerDispatcherDeps(
	deps: import("./vault-event-dispatcher").DispatcherDeps
): void {
	_registeredDispatcherDeps = deps;
}

/**
 * Retrieve the registered dispatcher deps, or null if not yet set.
 */
function getRegisteredDispatcherDeps(): import("./vault-event-dispatcher").DispatcherDeps | null {
	return _registeredDispatcherDeps;
}

// ---------------------------------------------------------------------------
// Pre-send context (specific to pre_send hooks)
// ---------------------------------------------------------------------------

/** Context for pre-send hook dispatch. */
export interface PreSendContext {
	conversationId: string;
	timestamp: string;
}

/** Context for tool-related hook dispatch. */
export interface ToolHookContext {
	conversationId: string;
	timestamp: string;
	toolName: string;
	toolParams: Record<string, unknown>;
	/** Tool result (only for on_tool_result). */
	toolResult?: string;
	/** Tool status: "success" or "error" (only for on_tool_result). */
	toolStatus?: string;
}

/** Context for after-completion hook dispatch. */
export interface CompletionContext {
	conversationId: string;
	timestamp: string;
}

// ---------------------------------------------------------------------------
// Pre-send dispatch (blocking, stdout captured)
// ---------------------------------------------------------------------------

/**
 * Dispatch all enabled `pre_send` hooks sequentially.
 *
 * Each hook is awaited. Stdout from all hooks is collected and returned
 * as an array of strings (one per hook that produced output).
 *
 * Hook failures do not block subsequent hooks or message dispatch.
 *
 * @param context - Pre-send context metadata.
 * @param settings - Plugin settings.
 * @param vaultRootPath - Vault root path for hook cwd.
 * @returns Array of non-empty stdout strings from hooks.
 */
export async function dispatchPreSend(
	context: PreSendContext,
	settings: NotorSettings,
	vaultRootPath: string
): Promise<string[]> {
	const hooks = getEnabledHooks(settings.hooks, "pre_send");
	if (hooks.length === 0) return [];

	log.info("Dispatching pre_send hooks", { count: hooks.length });

	const stdoutResults: string[] = [];

	const hookContext: HookContext = {
		conversationId: context.conversationId,
		hookEvent: "pre_send",
		timestamp: context.timestamp,
	};

	for (const hook of hooks) {
		// F-022: Route based on action_type
		const actionType = hook.action_type ?? "execute_command";
		if (actionType === "run_workflow") {
			// run_workflow: fire-and-forget (no stdout capture applicable)
			// NOT subject to hook timeout per FR-51
			void executeLifecycleHookWorkflowAction(
				hook,
				{
					conversationId: context.conversationId,
					hookEvent: "pre_send",
					timestamp: context.timestamp,
				},
				settings
			);
			continue;
		}

		// execute_command: existing path (await; captures stdout)
		const result = await executeHook(hook, hookContext, settings, vaultRootPath);
		if (result.stdout && result.stdout.length > 0) {
			stdoutResults.push(result.stdout);
		}
		// Failures are logged and noticed inside executeHook; continue to next
	}

	log.info("Pre-send hooks complete", {
		total: hooks.length,
		withOutput: stdoutResults.length,
	});

	return stdoutResults;
}

// ---------------------------------------------------------------------------
// On-tool-call dispatch (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Dispatch all enabled `on_tool_call` hooks non-blocking.
 *
 * Hooks are executed sequentially but the entire dispatch is
 * fire-and-forget — the caller does not wait for completion.
 *
 * @param context - Tool call context metadata.
 * @param settings - Plugin settings.
 * @param vaultRootPath - Vault root path for hook cwd.
 */
export function dispatchOnToolCall(
	context: ToolHookContext,
	settings: NotorSettings,
	vaultRootPath: string
): void {
	const hooks = getEnabledHooks(settings.hooks, "on_tool_call");
	if (hooks.length === 0) return;

	log.info("Dispatching on_tool_call hooks", { count: hooks.length, tool: context.toolName });

	const hookContext: HookContext = {
		conversationId: context.conversationId,
		hookEvent: "on_tool_call",
		timestamp: context.timestamp,
		toolName: context.toolName,
		toolParams: JSON.stringify(context.toolParams),
	};

	// Fire-and-forget: run sequentially but don't block caller
	void (async () => {
		for (const hook of hooks) {
			// F-022: Route based on action_type
			const actionType = hook.action_type ?? "execute_command";
			if (actionType === "run_workflow") {
				await executeLifecycleHookWorkflowAction(
					hook,
					{
						conversationId: context.conversationId,
						hookEvent: "on_tool_call",
						timestamp: context.timestamp,
					},
					settings
				);
				continue;
			}
			await executeHook(hook, hookContext, settings, vaultRootPath);
		}
		log.info("on_tool_call hooks complete", { count: hooks.length });
	})();
}

// ---------------------------------------------------------------------------
// On-tool-result dispatch (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Dispatch all enabled `on_tool_result` hooks non-blocking.
 *
 * @param context - Tool result context metadata.
 * @param settings - Plugin settings.
 * @param vaultRootPath - Vault root path for hook cwd.
 */
export function dispatchOnToolResult(
	context: ToolHookContext,
	settings: NotorSettings,
	vaultRootPath: string
): void {
	const hooks = getEnabledHooks(settings.hooks, "on_tool_result");
	if (hooks.length === 0) return;

	log.info("Dispatching on_tool_result hooks", { count: hooks.length, tool: context.toolName });

	const hookContext: HookContext = {
		conversationId: context.conversationId,
		hookEvent: "on_tool_result",
		timestamp: context.timestamp,
		toolName: context.toolName,
		toolParams: JSON.stringify(context.toolParams),
		toolResult: context.toolResult,
		toolStatus: context.toolStatus,
	};

	// Fire-and-forget
	void (async () => {
		for (const hook of hooks) {
			// F-022: Route based on action_type
			const actionType = hook.action_type ?? "execute_command";
			if (actionType === "run_workflow") {
				await executeLifecycleHookWorkflowAction(
					hook,
					{
						conversationId: context.conversationId,
						hookEvent: "on_tool_result",
						timestamp: context.timestamp,
					},
					settings
				);
				continue;
			}
			await executeHook(hook, hookContext, settings, vaultRootPath);
		}
		log.info("on_tool_result hooks complete", { count: hooks.length });
	})();
}

// ---------------------------------------------------------------------------
// After-completion dispatch (fire-and-forget)
// ---------------------------------------------------------------------------

/**
 * Dispatch all enabled `after_completion` hooks non-blocking.
 *
 * @param context - Completion context metadata.
 * @param settings - Plugin settings.
 * @param vaultRootPath - Vault root path for hook cwd.
 */
export function dispatchAfterCompletion(
	context: CompletionContext,
	settings: NotorSettings,
	vaultRootPath: string
): void {
	const hooks = getEnabledHooks(settings.hooks, "after_completion");
	if (hooks.length === 0) return;

	log.info("Dispatching after_completion hooks", { count: hooks.length });

	const hookContext: HookContext = {
		conversationId: context.conversationId,
		hookEvent: "after_completion",
		timestamp: context.timestamp,
	};

	// Fire-and-forget
	void (async () => {
		for (const hook of hooks) {
			// F-022: Route based on action_type
			const actionType = hook.action_type ?? "execute_command";
			if (actionType === "run_workflow") {
				await executeLifecycleHookWorkflowAction(
					hook,
					{
						conversationId: context.conversationId,
						hookEvent: "after_completion",
						timestamp: context.timestamp,
					},
					settings
				);
				continue;
			}
			await executeHook(hook, hookContext, settings, vaultRootPath);
		}
		log.info("after_completion hooks complete", { count: hooks.length });
	})();
}
