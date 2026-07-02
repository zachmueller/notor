/**
 * RunLoop — the generalized headless turn-loop engine.
 *
 * Extracted from `SubAgentRunner` (ARCH-002), which already described itself as
 * "a lightweight mini-orchestrator". `RunLoop` runs an isolated LLM conversation
 * loop to a terminal condition and returns a {@link RunResult}. After the
 * extraction BOTH `SubAgentRunner` (a thin adapter) and the orchestration
 * `StepTurnExecutor` / `run_flow` (Phase 1+) consume the same engine.
 *
 * `RunLoop` owns:
 * - the turn loop (stream-parse → `partitionToolCalls` → `executeToolBatches` →
 *   append results → repeat);
 * - the per-run safety caps (iteration / token / context-window proximity);
 * - the cascading **aggregate** budget (cost / iteration ceiling, ARCH-005);
 * - wind-down summarization on any terminal cap;
 * - parent-abort cascading via `runContext.abort`;
 * - invocation of the optional {@link RunLoopHooks}.
 *
 * What it does **NOT** do (these stay out of the engine and, where needed, attach
 * via hooks): persistence (JSONL), compaction / context management, view
 * rendering / persona switching / global state mutation, event routing.
 *
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — authority for behavior
 * @see specs/ZZ-misc/orchestration/data-model.md — authority for shapes
 * @see specs/ZZ-misc/orchestration/tasks/phase-0-runloop.md — ARCH-002
 */

import type { SendMessageOptions, StreamChunk } from "../providers/provider";
import type { ChatMessage } from "../providers/provider";
import { parseStreamEvents } from "../chat/stream-utils";
import {
	partitionToolCalls,
	executeToolBatches,
	type ToolCallInfo,
} from "../chat/tool-orchestration";
import { SUB_AGENT_ITERATION_CAP, SUB_AGENT_TOKEN_LIMIT } from "../sub-agents/constants";
import { getContextWindow } from "../providers/model-metadata";
import { estimateTokenCount, estimateContentTokens } from "../utils/tokens";
import { logger } from "../utils/logger";
import { computeTurnCostUsd, decrementAggregate, hasHeadroom } from "./budget";
import type { RunLoopOptions, RunResult, RunStopReason, TurnOutcome } from "./types";

const log = logger("RunLoop");

/** Terminal caps that trigger a wind-down summarization turn. */
type WindDownReason = "iteration_cap" | "token_limit" | "context_window" | "cost_cap";

/**
 * The generalized headless turn-loop engine. Construct with {@link RunLoopOptions}
 * and call {@link RunLoop.run}.
 */
export class RunLoop {
	private readonly options: RunLoopOptions;
	private readonly iterationCap: number;
	private readonly tokenLimit: number;
	private readonly thinkingLevel: string | null;

	/**
	 * Own abort controller for this run. Linked to `runContext.abort` so a parent
	 * abort cascades into this run (and into children, since each child inherits
	 * a derived signal).
	 */
	private readonly abortController: AbortController;

	/** Listener cleanup for the parent (runContext.abort) link. */
	private readonly unlinkParentAbort: () => void;

	constructor(options: RunLoopOptions) {
		this.options = options;
		this.iterationCap = options.iterationCap ?? SUB_AGENT_ITERATION_CAP;
		this.tokenLimit = options.tokenLimit ?? SUB_AGENT_TOKEN_LIMIT;
		this.thinkingLevel = options.thinkingLevel ?? null;

		// --- Abort propagation: own controller linked to runContext.abort. ---
		this.abortController = new AbortController();

		const parentSignal = options.runContext.abort;
		if (parentSignal.aborted) {
			this.abortController.abort();
		}
		const onParentAbort = () => this.abortController.abort();
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
		this.unlinkParentAbort = () => {
			parentSignal.removeEventListener("abort", onParentAbort);
		};
	}

	/**
	 * Whether this run should thread the cascade seam (`runContext` /
	 * `orchestrationContext`) into `executeToolBatches`.
	 *
	 * Sub-agents seed `maxDepth = 0` and `orchestrationContext: undefined` and
	 * must dispatch tools EXACTLY as `SubAgentRunner` does today (so the
	 * regression gate stays byte-identical: `executeToolBatches` is called with
	 * the historical positional arity, and `dispatch()` receives 11 positional
	 * args). Only a run that can actually spawn children (a flow, `maxDepth > 0`)
	 * or that carries an orchestration session threads the new seam.
	 */
	private get threadsCascadeSeam(): boolean {
		return this.options.runContext.maxDepth > 0
			|| this.options.orchestrationContext !== undefined;
	}

	/**
	 * Run the conversation loop to a terminal condition.
	 *
	 * @param prompt - The task/question for the run to complete.
	 */
	async run(prompt: string): Promise<RunResult> {
		const { systemPrompt, runContext } = this.options;

		const messages: ChatMessage[] = [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: prompt },
		];

		const tokenUsage = { input: 0, output: 0 };
		let iterationCount = 0;
		let lastText = "";
		let streamResult: ConsumedStreamResult | undefined;

		try {
			// Loop while BOTH layers have headroom: the per-run iteration cap AND
			// the shared aggregate budget (iterations + cost). For sub-agents the
			// aggregate cell is both-`Infinity`, so this reduces to today's single
			// `iterationCount < iterationCap` check (decrementing Infinity is a
			// no-op). The aggregate cost ceiling, when finite, yields cost_cap.
			while (true) {
				// Two-layer decision rule (ARCH-005, authority contracts/run-loop.md):
				// proceed iff localIterations < iterationCap AND the shared aggregate
				// cell has both iteration AND cost headroom. Distinguish the terminal
				// reason so cost exhaustion reports cost_cap (the iteration layers map
				// to iteration_cap). For sub-agents the cell is both-Infinity, so this
				// collapses to localIterations < iterationCap — identical to today.
				if (!hasHeadroom(runContext, iterationCount, this.iterationCap)) {
					const reason: WindDownReason = runContext.budget.costRemainingUsd <= 0
						? "cost_cap"
						: "iteration_cap";
					return await this.finishWithWindDown(messages, tokenUsage, iterationCount, reason);
				}

				// Check abort before each LLM call.
				if (this.abortController.signal.aborted) {
					log.info("Run aborted before LLM call", { iteration: iterationCount });
					return {
						text: lastText ? `${lastText}\n\n[Sub-agent cancelled]` : "[Sub-agent cancelled]",
						structured: null,
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "cancelled",
					};
				}

				// Pre-flight token limit check: reserve headroom for wind-down.
				if (this.tokenLimit > 0 && streamResult) {
					const lastInputCost = streamResult.inputTokens;
					const windDownReserve = lastInputCost + 4096;
					if (tokenUsage.input + tokenUsage.output + windDownReserve >= this.tokenLimit) {
						log.warn("Run approaching token limit (pre-flight)", {
							tokenUsage,
							limit: this.tokenLimit,
							windDownReserve,
						});
						return await this.finishWithWindDown(messages, tokenUsage, iterationCount, "token_limit");
					}
				}

				// Context window proximity check.
				if (streamResult) {
					const contextLimit = getContextWindow(this.options.model);
					const lastInputTokens = streamResult.inputTokens;
					const windDownReserve = lastInputTokens + 4096;
					if (contextLimit > 0 && lastInputTokens + windDownReserve >= contextLimit) {
						log.warn("Run approaching context window limit", {
							lastInputTokens,
							contextLimit,
							windDownReserve,
						});
						return await this.finishWithWindDown(messages, tokenUsage, iterationCount, "context_window");
					}
				} else {
					// First iteration: heuristic estimate (50% threshold).
					const contextLimit = getContextWindow(this.options.model);
					const estimatedTokens = this.estimateConversationTokens(messages);
					if (contextLimit > 0 && estimatedTokens >= contextLimit * 0.5) {
						log.warn("Run estimated context exceeds 50% of window (first iteration)", {
							estimatedTokens,
							contextLimit,
						});
						return await this.finishWithWindDown(messages, tokenUsage, iterationCount, "context_window");
					}
				}

				iterationCount++;
				await this.fireHook(() => this.options.hooks?.onTurnStart?.(iterationCount));
				this.reportProgress(`Turn ${iterationCount}/${this.iterationCap}...`);

				// --- Send to LLM ---
				const sendOptions: SendMessageOptions = {
					model: this.options.model,
					abort_signal: this.abortController.signal,
					thinking_level: this.thinkingLevel,
				};

				const stream = this.options.provider.sendMessage(
					messages,
					this.options.toolDefinitions,
					sendOptions,
				);

				// --- Parse stream ---
				streamResult = await this.consumeStream(stream);

				// Accumulate tokens.
				tokenUsage.input += streamResult.inputTokens;
				tokenUsage.output += streamResult.outputTokens;

				// --- Per-turn aggregate budget accounting (ARCH-005) ---
				// Decrement the SHARED cell in place after the turn completes (so
				// parent/siblings/children sharing the cell observe it), and fold the
				// turn into the per-subtree accumulator. For sub-agents the cell is
				// both-Infinity, so this changes nothing observable.
				const turnCostUsd = this.computeTurnCost(streamResult.inputTokens, streamResult.outputTokens);
				decrementAggregate(runContext.budget, turnCostUsd, 1);
				runContext.subtreeConsumed.costUsd += turnCostUsd;
				runContext.subtreeConsumed.iterations += 1;
				if (runContext.depth > runContext.subtreeConsumed.maxDepthReached) {
					runContext.subtreeConsumed.maxDepthReached = runContext.depth;
				}

				// Post-turn token limit check.
				if (this.tokenLimit > 0 && tokenUsage.input + tokenUsage.output >= this.tokenLimit) {
					log.warn("Run reached token limit", { tokenUsage, limit: this.tokenLimit });
					return await this.finishWithWindDown(messages, tokenUsage, iterationCount, "token_limit");
				}

				// --- Handle stream result ---
				if (streamResult.type === "error") {
					log.warn("Run stream error", { error: streamResult.error });
					// The turn's cost was already drawn down from the shared cell above,
					// so fire onTurnComplete too — the cost was real and must reach the
					// per-turn log (else the cell and turn.complete.cost_usd disagree).
					await this.fireHook(() => this.options.hooks?.onTurnComplete?.(iterationCount, this.buildTurnOutcome(streamResult!, turnCostUsd)));
					return {
						text: `[Sub-agent error: ${streamResult.error}]`,
						structured: null,
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "error",
						errorMessage: streamResult.error,
					};
				}

				if (streamResult.type === "cancelled") {
					log.info("Run stream cancelled", { iteration: iterationCount });
					// Same as the error path: the turn's cost is already in the cell, so
					// fire onTurnComplete so the log agrees with the cell.
					await this.fireHook(() => this.options.hooks?.onTurnComplete?.(iterationCount, this.buildTurnOutcome(streamResult!, turnCostUsd)));
					return {
						text: streamResult.text ? `${streamResult.text}\n\n[Sub-agent cancelled]` : "[Sub-agent cancelled]",
						structured: null,
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "cancelled",
					};
				}

				lastText = streamResult.text;

				// --- Text-only response (no tool calls) → completion ---
				if (streamResult.toolCalls.length === 0) {
					if (streamResult.text) {
						messages.push({ role: "assistant", content: streamResult.text });
					}
					log.info("Run completed", {
						iterations: iterationCount,
						textLength: streamResult.text.length,
					});
					await this.fireHook(() => this.options.hooks?.onTurnComplete?.(iterationCount, this.buildTurnOutcome(streamResult!, turnCostUsd)));
					await this.fireHook(() => this.options.hooks?.onPersist?.(messages));
					return {
						text: streamResult.text,
						structured: null,
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "completed",
					};
				}

				// --- Tool calls → dispatch and continue ---
				// Single assistant message with ALL tool calls (Bedrock requires all
				// tool_use blocks in one assistant message, matched by a single user
				// message with all tool_result blocks).
				messages.push({
					role: "tool_call",
					content: streamResult.text || "",
					tool_calls: streamResult.toolCalls.map(call => ({
						id: call.toolCallId,
						tool_name: call.toolName,
						parameters: call.parameters,
					})),
				});

				const batches = partitionToolCalls(streamResult.toolCalls, this.options.dispatcher);

				// messageId map — runs use the tool call ID as message ID.
				const messageIdMap = new Map<string, string>();
				for (const call of streamResult.toolCalls) {
					messageIdMap.set(call.toolCallId, call.toolCallId);
				}

				const batchResults = await this.dispatchBatches(batches, messageIdMap);

				// onTurnComplete fires after the turn's tool batch settles (contract).
				await this.fireHook(() => this.options.hooks?.onTurnComplete?.(iterationCount, this.buildTurnOutcome(streamResult!, turnCostUsd)));

				// Single tool_result message with ALL results (matches the single
				// tool_call message above — required by Bedrock).
				messages.push({
					role: "tool_result",
					content: "",
					tool_results: batchResults.map(({ call, result }) => {
						const resultStr = typeof result.result === "string"
							? result.result
							: JSON.stringify(result.result);
						return {
							tool_call_id: call.toolCallId,
							tool_name: call.toolName,
							result: resultStr || result.error || "",
							is_error: !result.success,
						};
					}),
				});

				await this.fireHook(() => this.options.hooks?.onPersist?.(messages));

				const toolNames = streamResult.toolCalls.map(c => c.toolName).join(", ");
				this.reportProgress(`Executed ${toolNames} (turn ${iterationCount}/${this.iterationCap})`);
			}
		} finally {
			this.unlinkParentAbort();
		}
	}

	// -----------------------------------------------------------------------
	// Tool dispatch — threads the cascade seam only for non-sub-agent runs
	// -----------------------------------------------------------------------

	/**
	 * Dispatch a turn's tool batches. For sub-agent runs (no cascade seam) this
	 * calls `executeToolBatches` with EXACTLY the historical positional arity, so
	 * the regression gate is byte-identical. For flow / orchestration runs it
	 * additionally threads `runContext` + `orchestrationContext` so child-spawning
	 * tools and the orchestration tools can read them.
	 */
	private async dispatchBatches(
		batches: ReturnType<typeof partitionToolCalls>,
		messageIdMap: Map<string, string>,
	) {
		if (!this.threadsCascadeSeam) {
			// Historical sub-agent path — no cascade seam. Threads policyCtx (F2) so
			// the pure policy engine gates sub-agent tool calls; runContext /
			// orchestrationContext stay undefined, so `dispatch()` still receives the
			// historical 11 positional args (the RunLoop Regression Gate arity).
			return executeToolBatches(
				batches,
				this.options.dispatcher,
				this.options.mode,
				messageIdMap,
				this.abortController.signal,
				undefined, // concurrencyCap — use default
				undefined, // onProgressMap
				this.options.policyCtx,
			);
		}
		// Orchestration / flow path: thread the cascade seam. The positional gap
		// up to sessionContext mirrors the orchestrator's call site; runContext +
		// orchestrationContext ride after the existing trailing params.
		return executeToolBatches(
			batches,
			this.options.dispatcher,
			this.options.mode,
			messageIdMap,
			this.abortController.signal,
			undefined, // concurrencyCap — use default
			undefined, // onProgressMap
			this.options.policyCtx,
			undefined, // approvalCallback
			undefined, // sessionContext
			undefined, // approvalHookDispatcher
			undefined, // interactionCallback
			this.options.runContext,
			this.options.orchestrationContext,
		);
	}

	// -----------------------------------------------------------------------
	// Wind-down: graceful summary before stopping
	// -----------------------------------------------------------------------

	/**
	 * Send one final LLM turn asking the model to summarize progress before the
	 * run is terminated by a terminal cap, then persist and return.
	 */
	private async finishWithWindDown(
		messages: ChatMessage[],
		tokenUsage: { input: number; output: number },
		iterationCount: number,
		reason: WindDownReason,
	): Promise<RunResult> {
		const reasonLabels: Record<WindDownReason, string> = {
			iteration_cap: `iteration limit (${iterationCount} turns)`,
			token_limit: `token limit (${(tokenUsage.input + tokenUsage.output).toLocaleString()} tokens)`,
			context_window: "context window proximity (~50%)",
			cost_cap: "aggregate cost limit",
		};
		const reasonLabel = reasonLabels[reason];
		const { runContext } = this.options;

		this.reportProgress("Summarizing progress...");

		messages.push({
			role: "user",
			content: [
				`You are about to be stopped because you have reached the ${reasonLabel}.`,
				"Before stopping, please provide a concise summary of:",
				"1. What was accomplished",
				"2. What remains to be done",
				"3. Key findings or results so far",
				"",
				"Do NOT call any tools. Respond with text only.",
			].join("\n"),
		});

		// Pass toolDefinitions (NOT empty []) because Bedrock requires toolConfig
		// when conversation history contains toolUse/toolResult blocks.
		const sendOptions: SendMessageOptions = {
			model: this.options.model,
			abort_signal: this.abortController.signal,
			thinking_level: this.thinkingLevel,
		};

		try {
			const stream = this.options.provider.sendMessage(
				messages,
				this.options.toolDefinitions,
				sendOptions,
			);
			const streamResult = await this.consumeStream(stream);

			tokenUsage.input += streamResult.inputTokens;
			tokenUsage.output += streamResult.outputTokens;

			// Account for the wind-down turn like any other turn: draw down the SHARED
			// aggregate cell and fire onTurnComplete. Without this, turn.complete's
			// cost_usd under-reports precisely on capped runs (the wind-down call's
			// cost was real but invisible to both the cell and the per-turn log).
			const windDownCostUsd = this.computeTurnCost(streamResult.inputTokens, streamResult.outputTokens);
			decrementAggregate(runContext.budget, windDownCostUsd, 1);
			runContext.subtreeConsumed.costUsd += windDownCostUsd;
			runContext.subtreeConsumed.iterations += 1;
			await this.fireHook(() => this.options.hooks?.onTurnComplete?.(iterationCount, this.buildTurnOutcome(streamResult, windDownCostUsd)));

			const summaryText = streamResult.text || "[No summary generated]";
			const marker = `[Sub-agent stopped: ${reasonLabel}]`;

			await this.fireHook(() => this.options.hooks?.onPersist?.(messages));

			return {
				text: `${marker}\n\n${summaryText}`,
				structured: null,
				messages,
				tokenUsage,
				iterationCount,
				stopReason: reason,
			};
		} catch (err) {
			log.warn("Wind-down summary turn failed", { error: err });
			const marker = `[Sub-agent stopped: ${reasonLabel}]`;
			await this.fireHook(() => this.options.hooks?.onPersist?.(messages));
			return {
				text: marker,
				structured: null,
				messages,
				tokenUsage,
				iterationCount,
				stopReason: reason,
			};
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Compute this turn's cost in USD via `budget.ts` (which wraps the standalone
	 * `calculateCost`). When no `settings` are supplied (e.g. sub-agents) cost is
	 * `0`, so the cost cell is never drawn down and behavior is unchanged.
	 */
	private computeTurnCost(inputTokens: number, outputTokens: number): number {
		const settings = this.options.settings;
		if (!settings) return 0;
		return computeTurnCostUsd(inputTokens, outputTokens, this.options.model, settings);
	}

	/** Build the per-turn summary handed to `onTurnComplete`. */
	private buildTurnOutcome(streamResult: ConsumedStreamResult, costUsd: number): TurnOutcome {
		return {
			text: streamResult.text,
			toolCalls: streamResult.toolCalls.map(c => ({ toolName: c.toolName, toolCallId: c.toolCallId })),
			tokenUsage: { input: streamResult.inputTokens, output: streamResult.outputTokens },
			costUsd,
		};
	}

	/** Fire `onProgress` from both the hooks bag and the top-level callback. */
	private reportProgress(status: string): void {
		this.options.onProgress?.(status);
		this.options.hooks?.onProgress?.(status);
	}

	/**
	 * Invoke a (possibly async) hook, awaiting it at its boundary. A throwing
	 * hook is logged and swallowed — the engine's correctness does not depend on
	 * a consumer's hook succeeding.
	 */
	private async fireHook(fn: () => void | Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (err) {
			log.warn("RunLoop hook threw; continuing", { error: String(err) });
		}
	}

	/**
	 * Heuristic token estimate for the full conversation — used on the first
	 * iteration when no API-reported input token count is available yet.
	 */
	private estimateConversationTokens(messages: ChatMessage[]): number {
		let total = 0;
		for (const msg of messages) {
			total += estimateContentTokens(msg.content);
			if (msg.tool_calls) {
				for (const tc of msg.tool_calls) {
					total += estimateTokenCount(tc.tool_name);
					total += estimateTokenCount(JSON.stringify(tc.parameters));
				}
			}
			if (msg.tool_results) {
				for (const tr of msg.tool_results) {
					total += estimateTokenCount(tr.result);
				}
			}
		}
		return total;
	}

	/**
	 * Consume a provider stream via `parseStreamEvents()`, collecting text and
	 * tool calls without any view rendering.
	 */
	private async consumeStream(
		stream: AsyncIterable<StreamChunk>,
	): Promise<ConsumedStreamResult> {
		let text = "";
		const toolCalls: ToolCallInfo[] = [];
		let inputTokens = 0;
		let outputTokens = 0;

		for await (const event of parseStreamEvents(stream, this.abortController.signal, {
			onPartialToolCall: this.options.dispatcher.makePartialToolCallHandler(),
		})) {
			switch (event.type) {
				case "text_delta":
					text = event.text;
					break;

				// tool_call_started / thinking_* are intentionally ignored: headless
				// runs render no tool-call cards, so the in-progress placeholder
				// event is a no-op here.

				case "tool_call":
					toolCalls.push({
						toolCallId: event.id,
						toolName: event.name,
						parameters: event.parameters,
					});
					break;

				case "message_end":
					inputTokens = event.inputTokens;
					outputTokens = event.outputTokens;
					break;

				case "error":
					return { type: "error", text, toolCalls: [], inputTokens, outputTokens, error: event.message };

				case "cancelled":
					return { type: "cancelled", text: event.text, toolCalls: [], inputTokens, outputTokens };
			}
		}

		return { type: "complete", text, toolCalls, inputTokens, outputTokens };
	}
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ConsumedStreamResult =
	| { type: "complete"; text: string; toolCalls: ToolCallInfo[]; inputTokens: number; outputTokens: number }
	| { type: "error"; text: string; toolCalls: []; inputTokens: number; outputTokens: number; error: string }
	| { type: "cancelled"; text: string; toolCalls: []; inputTokens: number; outputTokens: number };

// Re-export RunStopReason for adapters that map RunResult → narrower result types.
export type { RunStopReason };
