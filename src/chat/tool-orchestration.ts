/**
 * Tool orchestration — partitions tool calls into concurrent/serial batches
 * and executes them with appropriate parallelism.
 *
 * Sits between processStream() (which collects all tool calls from one LLM
 * turn) and dispatcher.dispatch() (which executes a single tool).
 *
 * @see specs/ZZ-misc/parallel-tool-execution.md — Phase 4
 */

import type { ToolResult, ConversationMode } from "../types";
import type { ToolDispatcher, ApprovalCallback, InteractionCallback } from "./dispatcher";
import type { ToolPolicyContext } from "./tool-policy";
import type { ToolSessionContext } from "../tools/tool";
import type { RunContext, OrchestrationToolContext } from "../run-loop/types";
import { isMcpTool } from "../mcp/mcp-tool-adapter";
import { logger } from "../utils/logger";

const log = logger("ToolOrchestration");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCallInfo = {
	toolCallId: string;
	toolName: string;
	parameters: Record<string, unknown>;
};

export type Batch = {
	isConcurrencySafe: boolean;
	calls: ToolCallInfo[];
};

export type ToolCallResult = {
	call: ToolCallInfo;
	result: ToolResult;
};

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

/**
 * Partition an ordered list of tool calls into batches of consecutive
 * concurrency-safe or non-concurrent calls.
 *
 * Rules:
 * - Built-in tools with `mode === "read"` are concurrency-safe.
 * - MCP tools are always non-concurrent (they execute arbitrary server-side
 *   code where even "read" operations could have side effects).
 * - Unknown tools (not in registry) are conservatively non-concurrent.
 * - Consecutive concurrency-safe calls are grouped into one batch.
 * - Each non-concurrent call gets its own batch.
 */
export function partitionToolCalls(
	calls: ToolCallInfo[],
	dispatcher: ToolDispatcher,
): Batch[] {
	if (calls.length === 0) return [];

	const batches: Batch[] = [];

	for (const call of calls) {
		const safe = isConcurrencySafe(call.toolName, dispatcher);

		if (safe && batches.length > 0 && batches[batches.length - 1]!.isConcurrencySafe) {
			// Extend the current concurrent batch
			batches[batches.length - 1]!.calls.push(call);
		} else {
			// Start a new batch
			batches.push({ isConcurrencySafe: safe, calls: [call] });
		}
	}

	return batches;
}

/**
 * Determine whether a tool is safe to run concurrently with other
 * concurrency-safe tools.
 */
function isConcurrencySafe(toolName: string, dispatcher: ToolDispatcher): boolean {
	// Unknown tools are conservatively non-concurrent
	if (!dispatcher.hasTool(toolName)) {
		return false;
	}

	// MCP tools are non-concurrent by default, but users can opt in by
	// explicitly classifying a tool as "read" in the server's
	// toolClassifications config. This signals that the user has verified
	// the tool is safe to run concurrently.
	if (isMcpTool(toolName)) {
		return dispatcher.hasExplicitUserReadClassification(toolName);
	}

	// Built-in read tools are safe; write tools are not
	return !dispatcher.isWriteTool(toolName);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Default maximum number of tools executing simultaneously. */
const DEFAULT_CONCURRENCY_CAP = 5;

/**
 * Execute partitioned tool batches, running concurrent batches in parallel
 * (capped) and serial batches one-at-a-time.
 *
 * Returns results in the original call order across all batches.
 */
export async function executeToolBatches(
	batches: Batch[],
	dispatcher: ToolDispatcher,
	mode: ConversationMode,
	messageIdMap: Map<string, string>,
	// abortSignal + concurrencyCap + onProgressMap precede the now-required
	// `policyCtx`, so they are required-but-nullable positional args (TS forbids a
	// required param after an optional one). Callers pass all of them positionally.
	abortSignal: AbortSignal | undefined,
	concurrencyCap: number | undefined,
	onProgressMap: Map<string, (status: string) => void> | undefined,
	policyCtx: ToolPolicyContext,
	approvalCallback?: ApprovalCallback,
	sessionContext?: ToolSessionContext,
	approvalHookDispatcher?: (toolName: string, params: Record<string, unknown>, mode: string) => Promise<"approved" | "rejected" | "pass">,
	interactionCallback?: InteractionCallback,
	runContext?: RunContext,
	orchestrationContext?: OrchestrationToolContext,
): Promise<ToolCallResult[]> {
	const allResults: ToolCallResult[] = [];

	for (const batch of batches) {
		if (abortSignal?.aborted) {
			// Produce synthetic error results for remaining calls in this
			// and all subsequent batches
			for (const call of batch.calls) {
				allResults.push({
					call,
					result: {
						tool_name: call.toolName,
						success: false,
						result: "",
						error: "Tool call was cancelled by the user.",
						tool_call_id: call.toolCallId,
					},
				});
			}
			continue;
		}

		if (batch.isConcurrencySafe && batch.calls.length > 1) {
			// --- Concurrent batch: run in parallel with cap ---
			const results = await runConcurrentBatch(
				batch.calls,
				dispatcher,
				mode,
				messageIdMap,
				abortSignal,
				concurrencyCap ?? DEFAULT_CONCURRENCY_CAP,
				onProgressMap,
				policyCtx,
				approvalCallback,
				sessionContext,
				approvalHookDispatcher,
				interactionCallback,
				runContext,
				orchestrationContext,
			);
			allResults.push(...results);
		} else {
			// --- Serial batch (single call or non-concurrent) ---
			for (const call of batch.calls) {
				if (abortSignal?.aborted) {
					allResults.push({
						call,
						result: {
							tool_name: call.toolName,
							success: false,
							result: "",
							error: "Tool call was cancelled by the user.",
							tool_call_id: call.toolCallId,
						},
					});
					continue;
				}

				const result = await safeDispatch(call, dispatcher, mode, messageIdMap.get(call.toolCallId)!, abortSignal, onProgressMap?.get(call.toolCallId), policyCtx, approvalCallback, sessionContext, approvalHookDispatcher, interactionCallback, runContext, orchestrationContext);
				allResults.push({ call, result });
			}
		}
	}

	return allResults;
}

/**
 * Run a batch of concurrency-safe tool calls in parallel, respecting a
 * concurrency cap via a simple semaphore.
 *
 * Uses Promise.all to preserve submission order in the result array.
 */
async function runConcurrentBatch(
	calls: ToolCallInfo[],
	dispatcher: ToolDispatcher,
	mode: ConversationMode,
	messageIdMap: Map<string, string>,
	// abortSignal + concurrencyCap + onProgressMap precede the now-required
	// `policyCtx` (required-but-nullable — TS forbids a required param after an
	// optional one). The sole caller passes all three positionally.
	abortSignal: AbortSignal | undefined,
	concurrencyCap: number,
	onProgressMap: Map<string, (status: string) => void> | undefined,
	policyCtx: ToolPolicyContext,
	approvalCallback?: ApprovalCallback,
	sessionContext?: ToolSessionContext,
	approvalHookDispatcher?: (toolName: string, params: Record<string, unknown>, mode: string) => Promise<"approved" | "rejected" | "pass">,
	interactionCallback?: InteractionCallback,
	runContext?: RunContext,
	orchestrationContext?: OrchestrationToolContext,
): Promise<ToolCallResult[]> {
	log.info("Running concurrent batch", { count: calls.length, cap: concurrencyCap });

	// Simple semaphore for concurrency cap
	let activeCount = 0;
	const waitQueue: Array<() => void> = [];

	async function acquire(): Promise<void> {
		if (activeCount < concurrencyCap) {
			activeCount++;
			return;
		}
		return new Promise<void>((resolve) => {
			waitQueue.push(() => {
				activeCount++;
				resolve();
			});
		});
	}

	function release(): void {
		activeCount--;
		const next = waitQueue.shift();
		if (next) next();
	}

	const promises = calls.map(async (call): Promise<ToolCallResult> => {
		await acquire();
		try {
			if (abortSignal?.aborted) {
				return {
					call,
					result: {
						tool_name: call.toolName,
						success: false,
						result: "",
						error: "Tool call was cancelled by the user.",
						tool_call_id: call.toolCallId,
					},
				};
			}
			const result = await safeDispatch(call, dispatcher, mode, messageIdMap.get(call.toolCallId)!, abortSignal, onProgressMap?.get(call.toolCallId), policyCtx, approvalCallback, sessionContext, approvalHookDispatcher, interactionCallback, runContext, orchestrationContext);
			return { call, result };
		} finally {
			release();
		}
	});

	return Promise.all(promises);
}

/**
 * Dispatch a single tool call, catching unexpected throws and converting
 * them to error ToolResults so that Promise.all never rejects.
 */
async function safeDispatch(
	call: ToolCallInfo,
	dispatcher: ToolDispatcher,
	mode: ConversationMode,
	messageId: string,
	// abortSignal + onProgress precede the now-required `policyCtx`
	// (required-but-nullable — TS forbids a required param after an optional one).
	abortSignal: AbortSignal | undefined,
	onProgress: ((status: string) => void) | undefined,
	policyCtx: ToolPolicyContext,
	approvalCallback?: ApprovalCallback,
	sessionContext?: ToolSessionContext,
	approvalHookDispatcher?: (toolName: string, params: Record<string, unknown>, mode: string) => Promise<"approved" | "rejected" | "pass">,
	interactionCallback?: InteractionCallback,
	runContext?: RunContext,
	orchestrationContext?: OrchestrationToolContext,
): Promise<ToolResult> {
	try {
		// Conditionally append the cascade seam (runContext / orchestrationContext)
		// ONLY when one is present. The sub-agent / ordinary-chat path passes
		// neither, so `dispatch()` is invoked with EXACTLY the historical 11
		// positional arguments — keeping the RunLoop Regression Gate's
		// `toHaveBeenCalledWith(...)` arity assertions byte-identical (vitest fails
		// on any extra trailing arg, even `undefined`). `policyCtx` (the 7th
		// positional) is WITHIN those 11 args and is now required — every path
		// carries a real ctx; the regression gate asserts the ctx at position 7.
		const result = (runContext !== undefined || orchestrationContext !== undefined)
			? await dispatcher.dispatch(
				call.toolName,
				call.parameters,
				mode,
				messageId,
				abortSignal,
				onProgress,
				policyCtx,
				approvalCallback,
				sessionContext,
				approvalHookDispatcher,
				interactionCallback,
				runContext,
				orchestrationContext,
			)
			: await dispatcher.dispatch(
				call.toolName,
				call.parameters,
				mode,
				messageId,
				abortSignal,
				onProgress,
				policyCtx,
				approvalCallback,
				sessionContext,
				approvalHookDispatcher,
				interactionCallback,
			);
		result.tool_call_id = call.toolCallId;
		return result;
	} catch (e) {
		log.warn("Tool dispatch threw, injecting error tool_result", {
			toolName: call.toolName,
			error: String(e),
		});
		return {
			tool_name: call.toolName,
			success: false,
			result: "",
			error: `Tool call failed: ${e instanceof Error ? e.message : String(e)}`,
			tool_call_id: call.toolCallId,
		};
	}
}
