/**
 * Hook event dispatching — triggers hooks at correct lifecycle points.
 *
 * Provides four dispatch functions corresponding to the four hook events:
 * - `dispatchPreSend` — awaits sequentially, returns concatenated stdout
 * - `dispatchOnToolCall` — fire-and-forget sequential
 * - `dispatchOnToolResult` — fire-and-forget sequential
 * - `dispatchAfterCompletion` — fire-and-forget sequential
 *
 * @see specs/02-context-intelligence/data-model.md — Hook entity
 * @see specs/02-context-intelligence/tasks.md — HOOK-003
 */

import type { NotorSettings } from "../settings";
import { getEnabledHooks } from "./hook-config";
import { executeHook, type HookContext } from "./hook-engine";
import { logger } from "../utils/logger";

const log = logger("HookEvents");

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
			await executeHook(hook, hookContext, settings, vaultRootPath);
		}
		log.info("after_completion hooks complete", { count: hooks.length });
	})();
}