/**
 * Hook dispatcher — consolidates lifecycle and tool-event hook dispatch.
 *
 * Extracted from `ChatOrchestrator` (Phase B8). Wraps the imported
 * `dispatchPreSend`, `dispatchOnToolCall`, `dispatchOnToolResult`, and
 * `dispatchAfterCompletion` functions with bundled common parameters
 * (settings, vaultRootPath, overrideManager, extensionAccessors).
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B8
 */

import type { ToolResult } from "../types";
import type { NotorSettings } from "../settings";
import type { WorkflowHookOverrideManager } from "../hooks/workflow-hook-override";
import {
	dispatchPreSend,
	dispatchOnToolCall,
	dispatchOnToolResult,
	dispatchAfterCompletion,
	dispatchOnApprovalRequired,
	type LifecycleAutomationAccessors,
	type ToolEventAutomationAccessors,
} from "../hooks/hook-events";
import { logger } from "../utils/logger";

const log = logger("HookDispatcher");

export class HookDispatcher {
	constructor(
		private readonly getSettings: () => NotorSettings,
		private readonly getVaultRootPath: () => string | undefined,
		private readonly getWorkflowHookOverrideManager: () => WorkflowHookOverrideManager | undefined,
		private readonly getExtensionLifecycleAccessors: () => LifecycleAutomationAccessors | undefined,
		private readonly getExtensionToolEventAccessors: () => ToolEventAutomationAccessors | undefined,
	) {}

	/**
	 * Dispatch pre-send hooks (blocking, stdout captured).
	 *
	 * @returns Captured hook stdout lines, or undefined if no vault root.
	 * @see HOOK-004, G-004, EXT-017
	 */
	async dispatchPreSendHooks(conversationId: string): Promise<string[] | undefined> {
		const vaultRootPath = this.getVaultRootPath();
		if (!vaultRootPath) return undefined;

		const result = await dispatchPreSend(
			{
				conversationId,
				timestamp: new Date().toISOString(),
			},
			this.getSettings(),
			vaultRootPath,
			this.getWorkflowHookOverrideManager(),
			this.getExtensionLifecycleAccessors(),
		);

		// Filter empty results
		return result.length > 0 ? result : undefined;
	}

	/**
	 * Fire on_tool_call hooks (fire-and-forget).
	 *
	 * @see HOOK-005, G-004, EXT-017
	 */
	dispatchToolCallHook(
		conversationId: string,
		toolName: string,
		toolParams: Record<string, unknown>,
	): void {
		const vaultRootPath = this.getVaultRootPath();
		if (!vaultRootPath) return;

		dispatchOnToolCall(
			{
				conversationId,
				timestamp: new Date().toISOString(),
				toolName,
				toolParams,
			},
			this.getSettings(),
			vaultRootPath,
			this.getWorkflowHookOverrideManager(),
			this.getExtensionToolEventAccessors(),
		);
	}

	/**
	 * Fire on_tool_result hooks (fire-and-forget).
	 *
	 * @see HOOK-005, G-004, EXT-017
	 */
	dispatchToolResultHook(
		conversationId: string,
		toolName: string,
		toolParams: Record<string, unknown>,
		toolResult: ToolResult,
	): void {
		const vaultRootPath = this.getVaultRootPath();
		if (!vaultRootPath) return;

		const toolResultStr = typeof toolResult.result === "string"
			? toolResult.result
			: JSON.stringify(toolResult.result);

		dispatchOnToolResult(
			{
				conversationId,
				timestamp: new Date().toISOString(),
				toolName,
				toolParams,
				toolResult: toolResultStr,
				toolStatus: toolResult.success ? "success" : "error",
			},
			this.getSettings(),
			vaultRootPath,
			this.getWorkflowHookOverrideManager(),
			this.getExtensionToolEventAccessors(),
		);
	}

	/**
	 * Fire after_completion hooks (fire-and-forget).
	 *
	 * @param conversationId - If not provided, falls back to undefined (caller should resolve).
	 * @see HOOK-005, G-004, EXT-017
	 */
	dispatchAfterCompletionHooks(conversationId?: string): void {
		const vaultRootPath = this.getVaultRootPath();
		if (!conversationId || !vaultRootPath) return;

		dispatchAfterCompletion(
			{
				conversationId,
				timestamp: new Date().toISOString(),
			},
			this.getSettings(),
			vaultRootPath,
			this.getWorkflowHookOverrideManager(),
			this.getExtensionLifecycleAccessors(),
		);
	}

	/**
	 * Dispatch on_approval_required hooks (blocking, sequential, short-circuit).
	 *
	 * Returns "approved", "rejected", or "pass". Hooks are evaluated in order;
	 * the first non-"pass" result wins.
	 */
	async dispatchApprovalRequiredHook(
		conversationId: string,
		toolName: string,
		toolParams: Record<string, unknown>,
		mode: string,
	): Promise<"approved" | "rejected" | "pass"> {
		const vaultRootPath = this.getVaultRootPath();
		if (!vaultRootPath) return "pass";

		return dispatchOnApprovalRequired(
			{
				conversationId,
				timestamp: new Date().toISOString(),
				toolName,
				toolParams,
				mode,
			},
			this.getSettings(),
			vaultRootPath,
			this.getExtensionToolEventAccessors(),
		);
	}
}
