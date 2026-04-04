/**
 * SubAgentRunner — a lightweight mini-orchestrator for sub-agent conversations.
 *
 * Runs an isolated LLM conversation loop: send messages → parse stream →
 * dispatch tools → repeat until a text-only response or iteration cap.
 *
 * Unlike the main `ChatOrchestrator`, this class has:
 * - No compaction, context management, or conversation persistence
 * - No view rendering or hooks
 * - No persona switching or workflow assembly
 * - Its own `AbortController` linked to the parent's signal
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.1
 */

import type { LLMProvider, ChatMessage, ToolDefinition, SendMessageOptions } from "../providers/provider";
import type { ConversationMode, ToolResult } from "../types";
import type { ToolDispatcher } from "./dispatcher";
import { parseStreamEvents } from "./stream-utils";
import {
	partitionToolCalls,
	executeToolBatches,
	type ToolCallInfo,
} from "./tool-orchestration";
import { SUB_AGENT_ITERATION_CAP, SUB_AGENT_TOKEN_LIMIT } from "../sub-agents/constants";
import { getContextWindow } from "../providers/model-metadata";
import { estimateTokenCount } from "../utils/tokens";
import { logger } from "../utils/logger";

const log = logger("SubAgentRunner");

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Result returned by a sub-agent execution.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.1
 */
/** Why the sub-agent stopped. */
export type SubAgentStopReason =
	| "completed"
	| "iteration_cap"
	| "token_limit"
	| "context_window";

export interface SubAgentResult {
	/** Final text response from the sub-agent. */
	text: string;
	/** Full conversation messages (for history persistence in Phase 6). */
	messages: ChatMessage[];
	/** Cumulative token usage across all iterations. */
	tokenUsage: { input: number; output: number };
	/** Number of LLM turns executed. */
	iterationCount: number;
	/** Why the sub-agent stopped. */
	stopReason: SubAgentStopReason;
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface SubAgentRunnerOptions {
	/** Resolved LLM provider instance. */
	provider: LLMProvider;
	/** Model ID for this sub-agent. */
	model: string;
	/** Full system prompt (preamble + profile body). */
	systemPrompt: string;
	/** Tool definitions available to this sub-agent (already filtered). */
	toolDefinitions: ToolDefinition[];
	/** Dispatcher with pre-clamped effective config. */
	dispatcher: ToolDispatcher;
	/** Parent's abort signal — triggers cancellation of this sub-agent. */
	parentAbortSignal: AbortSignal;
	/** Maximum LLM turns (default: SUB_AGENT_ITERATION_CAP). */
	iterationCap?: number;
	/** Maximum total tokens (input + output). 0 = no limit. */
	tokenLimit?: number;
	/** Inherited from parent conversation (Section 9.6). */
	mode: ConversationMode;
	/** Optional progress callback (Section 9.5). */
	onProgress?: (status: string) => void;
}

// ---------------------------------------------------------------------------
// SubAgentRunner
// ---------------------------------------------------------------------------

export class SubAgentRunner {
	private readonly provider: LLMProvider;
	private readonly model: string;
	private readonly systemPrompt: string;
	private readonly toolDefinitions: ToolDefinition[];
	private readonly dispatcher: ToolDispatcher;
	private readonly iterationCap: number;
	private readonly tokenLimit: number;
	private readonly mode: ConversationMode;
	private readonly onProgress?: (status: string) => void;

	/**
	 * Own abort controller for this sub-agent. Linked to the parent's signal
	 * so that the parent's Stop button cancels this sub-agent too.
	 */
	private readonly abortController: AbortController;

	/** Listener cleanup for the parent abort signal link. */
	private readonly unlinkParentAbort: () => void;

	constructor(options: SubAgentRunnerOptions) {
		this.provider = options.provider;
		this.model = options.model;
		this.systemPrompt = options.systemPrompt;
		this.toolDefinitions = options.toolDefinitions;
		this.dispatcher = options.dispatcher;
		this.iterationCap = options.iterationCap ?? SUB_AGENT_ITERATION_CAP;
		this.tokenLimit = options.tokenLimit ?? SUB_AGENT_TOKEN_LIMIT;
		this.mode = options.mode;
		this.onProgress = options.onProgress;

		// --- Abort propagation (Section 6.2 / Phase 4.3) ---
		// Each sub-agent gets its own AbortController. If the parent's signal
		// fires, we cascade the abort to this controller.
		this.abortController = new AbortController();

		if (options.parentAbortSignal.aborted) {
			// Parent already aborted before we started
			this.abortController.abort();
		}

		const onParentAbort = () => this.abortController.abort();
		options.parentAbortSignal.addEventListener("abort", onParentAbort, { once: true });

		this.unlinkParentAbort = () => {
			options.parentAbortSignal.removeEventListener("abort", onParentAbort);
		};
	}

	/**
	 * Run the sub-agent conversation loop.
	 *
	 * @param taskPrompt - The task/question for the sub-agent to complete.
	 * @returns Sub-agent result with text, messages, and token usage.
	 */
	async run(taskPrompt: string): Promise<SubAgentResult> {
		const messages: ChatMessage[] = [
			{ role: "system", content: this.systemPrompt },
			{ role: "user", content: taskPrompt },
		];

		const tokenUsage = { input: 0, output: 0 };
		let iterationCount = 0;
		let lastText = "";
		let streamResult: ConsumedStreamResult | undefined;

		try {
			while (iterationCount < this.iterationCap) {
				// Check abort before each LLM call
				if (this.abortController.signal.aborted) {
					log.info("Sub-agent aborted before LLM call", { iteration: iterationCount });
					return {
						text: lastText ? `${lastText}\n\n[Sub-agent cancelled]` : "[Sub-agent cancelled]",
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "completed",
					};
				}

				// Pre-flight token limit check: reserve headroom for wind-down
				if (this.tokenLimit > 0 && streamResult) {
					const lastInputCost = streamResult.inputTokens;
					const windDownReserve = lastInputCost + 4096;
					if (tokenUsage.input + tokenUsage.output + windDownReserve >= this.tokenLimit) {
						log.warn("Sub-agent approaching token limit (pre-flight)", {
							tokenUsage,
							limit: this.tokenLimit,
							windDownReserve,
						});
						return await this.runWindDown(messages, tokenUsage, iterationCount, "token_limit");
					}
				}

				// Context window proximity check (Phase 4B)
				if (streamResult) {
					// Use last turn's actual API-reported input tokens as context size
					const contextLimit = getContextWindow(this.model);
					const lastInputTokens = streamResult.inputTokens;
					const windDownReserve = lastInputTokens + 4096;
					if (contextLimit > 0 && lastInputTokens + windDownReserve >= contextLimit) {
						log.warn("Sub-agent approaching context window limit", {
							lastInputTokens,
							contextLimit,
							windDownReserve,
						});
						return await this.runWindDown(messages, tokenUsage, iterationCount, "context_window");
					}
				} else {
					// First iteration: use heuristic estimate (50% threshold)
					const contextLimit = getContextWindow(this.model);
					const estimatedTokens = this.estimateConversationTokens(messages);
					if (contextLimit > 0 && estimatedTokens >= contextLimit * 0.5) {
						log.warn("Sub-agent estimated context exceeds 50% of window (first iteration)", {
							estimatedTokens,
							contextLimit,
						});
						return await this.runWindDown(messages, tokenUsage, iterationCount, "context_window");
					}
				}

				iterationCount++;
				this.onProgress?.(`Turn ${iterationCount}/${this.iterationCap}...`);

				// --- Send to LLM ---
				const sendOptions: SendMessageOptions = {
					model: this.model,
					abort_signal: this.abortController.signal,
				};

				const stream = this.provider.sendMessage(
					messages,
					this.toolDefinitions,
					sendOptions,
				);

				// --- Parse stream ---
				streamResult = await this.consumeStream(stream);

				// Accumulate tokens
				tokenUsage.input += streamResult.inputTokens;
				tokenUsage.output += streamResult.outputTokens;

				// Post-turn token limit check
				if (this.tokenLimit > 0 && tokenUsage.input + tokenUsage.output >= this.tokenLimit) {
					log.warn("Sub-agent reached token limit", {
						tokenUsage,
						limit: this.tokenLimit,
					});
					return await this.runWindDown(messages, tokenUsage, iterationCount, "token_limit");
				}

				// --- Handle stream result ---
				if (streamResult.type === "error") {
					log.warn("Sub-agent stream error", { error: streamResult.error });
					return {
						text: `[Sub-agent error: ${streamResult.error}]`,
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "completed",
					};
				}

				if (streamResult.type === "cancelled") {
					log.info("Sub-agent stream cancelled", { iteration: iterationCount });
					return {
						text: streamResult.text ? `${streamResult.text}\n\n[Sub-agent cancelled]` : "[Sub-agent cancelled]",
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "completed",
					};
				}

				lastText = streamResult.text;

				// --- Text-only response (no tool calls) → completion ---
				if (streamResult.toolCalls.length === 0) {
					// Add the assistant's final response to messages
					if (streamResult.text) {
						messages.push({ role: "assistant", content: streamResult.text });
					}

					log.info("Sub-agent completed", {
						iterations: iterationCount,
						textLength: streamResult.text.length,
					});

					return {
						text: streamResult.text,
						messages,
						tokenUsage,
						iterationCount,
						stopReason: "completed",
					};
				}

				// --- Tool calls → dispatch and continue ---
				// Add a single assistant message with ALL tool calls (Bedrock requires
				// all tool_use blocks in one assistant message, matched by a single
				// user message with all tool_result blocks).
				messages.push({
					role: "tool_call",
					content: streamResult.text || "",
					tool_calls: streamResult.toolCalls.map(call => ({
						id: call.toolCallId,
						tool_name: call.toolName,
						parameters: call.parameters,
					})),
				});

				// Dispatch tools using the same batch/parallel infrastructure
				const batches = partitionToolCalls(streamResult.toolCalls, this.dispatcher);

				// Build a messageId map — sub-agents use the tool call ID as message ID
				const messageIdMap = new Map<string, string>();
				for (const call of streamResult.toolCalls) {
					messageIdMap.set(call.toolCallId, call.toolCallId);
				}

				const batchResults = await executeToolBatches(
					batches,
					this.dispatcher,
					this.mode,
					messageIdMap,
					this.abortController.signal,
				);

				// Add a single tool_result message with ALL results (matches the
				// single tool_call message above — required by Bedrock).
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

				// Report progress with tool names
				const toolNames = streamResult.toolCalls.map(c => c.toolName).join(", ");
				this.onProgress?.(`Executed ${toolNames} (turn ${iterationCount}/${this.iterationCap})`);
			}

			// --- Iteration cap reached → wind down ---
			log.warn("Sub-agent reached iteration cap", {
				cap: this.iterationCap,
				lastTextLength: lastText.length,
			});
			return await this.runWindDown(messages, tokenUsage, iterationCount, "iteration_cap");
		} finally {
			// Clean up the parent abort listener
			this.unlinkParentAbort();
		}
	}

	// -----------------------------------------------------------------------
	// Wind-down: graceful summary before stopping
	// -----------------------------------------------------------------------

	/**
	 * Send one final LLM turn asking the model to summarize progress before
	 * the sub-agent is terminated.
	 */
	private async runWindDown(
		messages: ChatMessage[],
		tokenUsage: { input: number; output: number },
		iterationCount: number,
		reason: "iteration_cap" | "token_limit" | "context_window",
	): Promise<SubAgentResult> {
		const reasonLabels: Record<typeof reason, string> = {
			iteration_cap: `iteration limit (${iterationCount} turns)`,
			token_limit: `token limit (${(tokenUsage.input + tokenUsage.output).toLocaleString()} tokens)`,
			context_window: "context window proximity (~50%)",
		};
		const reasonLabel = reasonLabels[reason];

		// Report progress
		this.onProgress?.("Summarizing progress...");

		// Append summarization instructions
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

		// Send the summary turn — pass toolDefinitions (NOT empty []) because
		// Bedrock requires toolConfig when conversation history contains
		// toolUse/toolResult blocks.
		const sendOptions: SendMessageOptions = {
			model: this.model,
			abort_signal: this.abortController.signal,
		};

		try {
			const stream = this.provider.sendMessage(
				messages,
				this.toolDefinitions,
				sendOptions,
			);

			const streamResult = await this.consumeStream(stream);

			// Accumulate tokens from the summary turn
			tokenUsage.input += streamResult.inputTokens;
			tokenUsage.output += streamResult.outputTokens;

			// Use whatever text was generated (ignore tool calls if model made them)
			const summaryText = streamResult.text || "[No summary generated]";
			const marker = `[Sub-agent stopped: ${reasonLabel}]`;

			return {
				text: `${marker}\n\n${summaryText}`,
				messages,
				tokenUsage,
				iterationCount,
				stopReason: reason,
			};
		} catch (err) {
			// If the summary turn fails, fall back to a static marker
			log.warn("Wind-down summary turn failed", { error: err });
			const marker = `[Sub-agent stopped: ${reasonLabel}]`;

			return {
				text: marker,
				messages,
				tokenUsage,
				iterationCount,
				stopReason: reason,
			};
		}
	}

	// -----------------------------------------------------------------------
	// Context window estimation
	// -----------------------------------------------------------------------

	/**
	 * Heuristic token estimate for the full conversation — used on the first
	 * iteration when no API-reported input token count is available yet.
	 * Accounts for tool_calls and tool_results arrays, not just msg.content.
	 */
	private estimateConversationTokens(messages: ChatMessage[]): number {
		let total = 0;
		for (const msg of messages) {
			total += estimateTokenCount(msg.content);
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

	// -----------------------------------------------------------------------
	// Stream consumption
	// -----------------------------------------------------------------------

	/**
	 * Consume a provider stream via `parseStreamEvents()`, collecting text
	 * and tool calls without any view rendering.
	 */
	private async consumeStream(
		stream: AsyncIterable<import("../providers/provider").StreamChunk>,
	): Promise<ConsumedStreamResult> {
		let text = "";
		const toolCalls: ToolCallInfo[] = [];
		let inputTokens = 0;
		let outputTokens = 0;

		for await (const event of parseStreamEvents(stream, this.abortController.signal)) {
			switch (event.type) {
				case "text_delta":
					text = event.text;
					break;

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
					return {
						type: "error",
						text,
						toolCalls: [],
						inputTokens,
						outputTokens,
						error: event.message,
					};

				case "cancelled":
					return {
						type: "cancelled",
						text: event.text,
						toolCalls: [],
						inputTokens,
						outputTokens,
					};
			}
		}

		return {
			type: "complete",
			text,
			toolCalls,
			inputTokens,
			outputTokens,
		};
	}
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type ConsumedStreamResult =
	| { type: "complete"; text: string; toolCalls: ToolCallInfo[]; inputTokens: number; outputTokens: number }
	| { type: "error"; text: string; toolCalls: []; inputTokens: number; outputTokens: number; error: string }
	| { type: "cancelled"; text: string; toolCalls: []; inputTokens: number; outputTokens: number };
