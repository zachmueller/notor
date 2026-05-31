/**
 * Message pipeline — pure transformations for the chat orchestrator.
 *
 * Extracted from `ChatOrchestrator` (Phase B7). These are stateless functions
 * with no orchestrator field access:
 * - `toChatMessages` — converts internal Message[] to provider ChatMessage[]
 * - `processStream` — transforms provider stream into a typed StreamResult
 * - `extractPendingMessages` — splits messages at the last assistant turn
 * - `calculateCost` — computes cost from token counts and pricing metadata
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B7
 */

import type { Message } from "../types";
import { assertUnreachable } from "../utils/assert-unreachable";
import type { ChatMessage, StreamChunk } from "../providers/provider";
import type { ContentBlock } from "../media/types";
import { getModelMetadata } from "../providers/model-metadata";
import { parseStreamEvents } from "./stream-utils";
import type { ToolCallInfo } from "./tool-orchestration";
import type { NotorChatView } from "../ui/chat-view";
import type { NotorSettings, ModelPricing } from "../settings";
import { logger } from "../utils/logger";

const log = logger("MessagePipeline");

// ---------------------------------------------------------------------------
// ChatBlockRegistry stub — wired at plugin init via setChatBlockRegistry()
// ---------------------------------------------------------------------------

interface ChatBlockRegistryLike {
	get(kind: string): { toLLMText?: (data: Record<string, unknown>) => string | null } | undefined;
}

let moduleRegistry: ChatBlockRegistryLike | undefined;

/** Called once at plugin init to wire in the real ChatBlockRegistry. */
export function setChatBlockRegistry(registry: ChatBlockRegistryLike): void {
	moduleRegistry = registry;
}

/**
 * Resolve custom_block entries to wire text.
 *
 * Calls toLLMText from the registry when available; falls back to
 * fallback_text. Returns null when all blocks produce empty output
 * (message should be dropped from wire entirely).
 */
export function getWireText(
	content: string | ContentBlock[],
	registry?: ChatBlockRegistryLike,
): string | null {
	if (typeof content === "string") {
		return content || null;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (block.type !== "custom_block") {
			continue;
		}
		const def = registry?.get(block.kind);
		let text: string | null = null;
		if (def?.toLLMText) {
			text = def.toLLMText(block.data);
		} else {
			text = block.fallback_text ?? null;
		}
		if (text != null && text !== "") {
			parts.push(text);
		}
	}
	return parts.length > 0 ? parts.join("\n\n") : null;
}

/** Result type for stream processing. */
export type StreamResult =
	| { type: "text"; text: string; thinking: string; thinkingDurationMs: number; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "tool_calls"; calls: ToolCallInfo[]; text: string; thinking: string; thinkingDurationMs: number; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "cancelled"; text: string; thinking: string; thinkingDurationMs: number; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "error"; error: string; text: string; inputTokens: number; outputTokens: number };

/**
 * Process a provider stream into a typed result.
 *
 * The `viewResolver` callback resolves the view dynamically per-chunk so
 * mid-stream navigation causes rendering to become a no-op while data
 * writes continue.
 */
export async function processStream(
	stream: AsyncIterable<StreamChunk>,
	abortController: AbortController,
	eagerContentEl?: HTMLElement,
	viewResolver?: () => NotorChatView | undefined,
): Promise<StreamResult> {
	let textContent = "";
	let thinkingContent = "";
	let inputTokens = 0;
	let outputTokens = 0;
	// Use the eagerly-created placeholder if provided; first text_delta
	// will use it rather than creating a second element.
	let contentEl: HTMLElement | undefined = eagerContentEl;

	const resolveView = viewResolver ?? (() => undefined);

	// Thinking timer state. The pipeline owns the authoritative elapsed time
	// (Date.now() deltas survive mid-stream view navigation); the renderer's
	// interval is purely cosmetic.
	let thinkingStartTime: number | null = null;
	let thinkingDurationMs = 0;
	let thinkingStopped = false;
	const stopThinking = () => {
		if (thinkingStartTime !== null && !thinkingStopped) {
			thinkingDurationMs = Date.now() - thinkingStartTime;
			thinkingStopped = true;
			if (contentEl) resolveView()?.stopThinkingIndicator(contentEl, thinkingDurationMs);
		}
	};

	const accumulatedToolCalls: ToolCallInfo[] = [];

	for await (const event of parseStreamEvents(stream, abortController.signal)) {
		switch (event.type) {
			case "thinking_started": {
				thinkingStartTime = Date.now();
				const view = resolveView();
				if (!contentEl) {
					contentEl = view?.createAssistantMessagePlaceholder();
				}
				if (contentEl) {
					view?.startThinkingIndicator(contentEl);
				}
				break;
			}

			case "thinking_delta": {
				thinkingContent += event.delta;
				const view = resolveView();
				if (!contentEl) {
					contentEl = view?.createAssistantMessagePlaceholder();
				}
				if (contentEl) {
					view?.appendThinkingChunk(contentEl, event.delta);
				}
				break;
			}

			case "text_delta": {
				// First visible text ends the thinking phase.
				stopThinking();
				// contentEl may already be set from the eager placeholder
				const view = resolveView();
				if (!contentEl) {
					contentEl = view?.createAssistantMessagePlaceholder();
				}
				textContent = event.text;
				if (contentEl) {
					view?.appendStreamChunk(contentEl, event.delta);
				}
				break;
			}

			case "tool_call":
				// First tool call ends the thinking phase.
				stopThinking();
				accumulatedToolCalls.push({
					toolCallId: event.id,
					toolName: event.name,
					parameters: event.parameters,
				});
				break;

			case "message_end":
				inputTokens = event.inputTokens;
				outputTokens = event.outputTokens;
				log.debug("processStream message_end", {
					inputTokens,
					outputTokens,
					toolCallCount: accumulatedToolCalls.length,
				});
				break;

			case "error":
				stopThinking();
				return {
					type: "error",
					error: event.message,
					text: textContent,
					inputTokens,
					outputTokens,
				};

			case "cancelled":
				stopThinking();
				return {
					type: "cancelled",
					text: event.text,
					thinking: thinkingContent,
					thinkingDurationMs,
					inputTokens,
					outputTokens,
					contentEl,
				};
		}
	}

	// Stream ended normally. Stop any still-running thinking timer (covers
	// hidden-thinking-only turns that emit no text and no tool calls).
	stopThinking();

	// If we accumulated tool calls, return them all
	if (accumulatedToolCalls.length > 0) {
		return {
			type: "tool_calls",
			calls: accumulatedToolCalls,
			text: textContent,
			thinking: thinkingContent,
			thinkingDurationMs,
			inputTokens,
			outputTokens,
			contentEl,
		};
	}

	return {
		type: "text",
		text: textContent,
		thinking: thinkingContent,
		thinkingDurationMs,
		inputTokens,
		outputTokens,
		contentEl,
	};
}

/**
 * Convert internal Message objects to ChatMessage format for the provider.
 *
 * Handles role mapping, tool call coalescing, synthetic result injection
 * for orphaned tool_calls, and pre-tool-call text absorption.
 */
export function toChatMessages(messages: Message[], systemPrompt: string): ChatMessage[] {
	const chatMessages: ChatMessage[] = [];

	for (const msg of messages) {
		switch (msg.role) {
			case "system":
				chatMessages.push({
					role: "system",
					content: systemPrompt,
				});
				break;

			case "user":
				chatMessages.push({
					role: "user",
					content: msg.content,
				});
				break;

			case "assistant": {
				// Defensive: skip assistant messages with blank content.
				// Providers like Bedrock reject empty text fields. This can
				// happen if a response is cancelled before any text arrives.
				const assistantText = typeof msg.content === "string"
					? msg.content
					: (() => { throw new Error("Expected string content for assistant message"); })();
				if (!assistantText.trim()) {
					log.warn("Skipping assistant message with empty content", { id: msg.id });
					break;
				}
				chatMessages.push({
					role: "assistant",
					content: assistantText,
				});
				break;
			}

			case "tool_call":
				if (msg.tool_call) {
					chatMessages.push({
						role: "tool_call",
						content: "",
						tool_calls: [
							{
								// Use the provider-assigned ID (e.g., Bedrock toolUseId) when
								// available; fall back to the message UUID for other providers.
								id: msg.tool_call.id ?? msg.id,
								tool_name: msg.tool_call.tool_name,
								parameters: msg.tool_call.parameters,
							},
						],
					});
				}
				break;

			case "tool_result":
				if (msg.tool_result) {
					const resultStr = typeof msg.tool_result.result === "string"
						? msg.tool_result.result
						: JSON.stringify(msg.tool_result.result);

					chatMessages.push({
						role: "tool_result",
						content: "",
						tool_results: [
							{
								// Must match the tool_calls[].id used above for the same call.
								tool_call_id: msg.tool_result.tool_call_id ?? msg.id,
								tool_name: msg.tool_result.tool_name,
								result: resultStr || msg.tool_result.error || "",
								is_error: !msg.tool_result.success,
								...(msg.tool_result.content_blocks?.length ? { content_blocks: msg.tool_result.content_blocks } : {}),
							},
						],
					});
				}
				break;

			case "extension_block": {
				const wireText = getWireText(msg.content, moduleRegistry);
				if (wireText != null) {
					const source = msg.source_extension ?? "";
					const tagged = source
						? `<notor-ext source="${source}">${wireText}</notor-ext>`
						: `<notor-ext>${wireText}</notor-ext>`;
					chatMessages.push({ role: "user", content: tagged });
				}
				// null → drop entirely (zero wire tokens)
				break;
			}

			default:
				assertUnreachable(msg.role);
		}
	}

	// Safety net: ensure every tool_call has a matching tool_result.
	// Providers (Bedrock, Anthropic) reject conversations where a tool_use
	// block is not immediately followed by a tool_result block.
	//
	// With grouped ordering (Phase 2), consecutive tool_calls are followed
	// by consecutive tool_results:
	//   [tool_call_A, tool_call_B, tool_result_A, tool_result_B]
	// We scan each run of tool_calls, collect the subsequent tool_results,
	// and match by tool_call_id.  Unmatched tool_calls get synthetic results.
	const repaired: ChatMessage[] = [];
	let i = 0;
	while (i < chatMessages.length) {
		const msg = chatMessages[i]!;

		// Not a tool_call — pass through
		if (msg.role !== "tool_call" || !msg.tool_calls?.length) {
			repaired.push(msg);
			i++;
			continue;
		}

		// Collect the run of consecutive tool_call messages
		const toolCallRun: ChatMessage[] = [];
		while (i < chatMessages.length && chatMessages[i]!.role === "tool_call" && chatMessages[i]!.tool_calls?.length) {
			toolCallRun.push(chatMessages[i]!);
			i++;
		}

		// Collect the run of consecutive tool_result messages that follow
		const toolResultRun: ChatMessage[] = [];
		while (i < chatMessages.length && chatMessages[i]!.role === "tool_result" && chatMessages[i]!.tool_results?.length) {
			toolResultRun.push(chatMessages[i]!);
			i++;
		}

		// Build a set of tool_call_ids that have matching results
		const matchedIds = new Set(
			toolResultRun.flatMap((r) => r.tool_results!.map((tr) => tr.tool_call_id))
		);

		// Emit all tool_calls
		for (const tc of toolCallRun) {
			repaired.push(tc);
		}

		// Emit all existing tool_results
		for (const tr of toolResultRun) {
			repaired.push(tr);
		}

		// Inject synthetic results for any unmatched tool_calls
		for (const tc of toolCallRun) {
			for (const tcData of tc.tool_calls!) {
				if (!matchedIds.has(tcData.id)) {
					repaired.push({
						role: "tool_result",
						content: "",
						tool_results: [
							{
								tool_call_id: tcData.id,
								tool_name: tcData.tool_name,
								result: "Tool call was cancelled by the user.",
								is_error: true,
							},
						],
					});
					log.warn("Injected synthetic tool_result for orphaned tool_call", {
						toolName: tcData.tool_name,
						toolCallId: tcData.id,
					});
				}
			}
		}
	}

	// Phase 3: Coalesce consecutive tool_call/tool_result messages into
	// single messages with arrays, matching the provider-expected format
	// (one assistant message with N tool_use blocks, one user message with
	// N tool_result blocks).
	const coalesced: ChatMessage[] = [];
	let j = 0;
	while (j < repaired.length) {
		const msg = repaired[j]!;

		if (msg.role === "tool_call" && msg.tool_calls?.length) {
			// Look back: if the preceding coalesced message is an assistant
			// message (pre-tool-call text + token carrier), absorb its content
			// into the coalesced tool_call message.
			let preToolCallText = "";
			const prev = coalesced[coalesced.length - 1];
			if (prev && prev.role === "assistant" && !prev.tool_calls) {
				preToolCallText = typeof prev.content === "string"
					? prev.content
					: (() => { throw new Error("Expected string content for assistant message"); })();
				coalesced.pop(); // absorb into the coalesced message
			}

			// Collect all consecutive tool_call entries
			const allToolCalls: ChatMessage["tool_calls"] = [];
			while (j < repaired.length && repaired[j]!.role === "tool_call" && repaired[j]!.tool_calls?.length) {
				allToolCalls.push(...repaired[j]!.tool_calls!);
				j++;
			}

			coalesced.push({
				role: "tool_call",
				content: preToolCallText,
				tool_calls: allToolCalls,
			});
			continue;
		}

		if (msg.role === "tool_result" && msg.tool_results?.length) {
			// Collect all consecutive tool_result entries
			const allToolResults: ChatMessage["tool_results"] = [];
			while (j < repaired.length && repaired[j]!.role === "tool_result" && repaired[j]!.tool_results?.length) {
				allToolResults.push(...repaired[j]!.tool_results!);
				j++;
			}

			coalesced.push({
				role: "tool_result",
				content: "",
				tool_results: allToolResults,
			});
			continue;
		}

		coalesced.push(msg);
		j++;
	}

	// Phase 4: Consecutive same-role coalescing pass.
	// Merges adjacent messages with the same role (no tool_calls/tool_results).
	// Addresses extension_block adjacency AND the pre-existing hook-injection
	// alternation bug (Bedrock's strict alternation requirement).
	const final: ChatMessage[] = [];
	for (const msg of coalesced) {
		const prev = final[final.length - 1];
		if (
			prev &&
			prev.role === msg.role &&
			!prev.tool_calls &&
			!prev.tool_results &&
			!msg.tool_calls &&
			!msg.tool_results
		) {
			// Normalize both sides to ContentBlock[] and concatenate
			const aContent = typeof prev.content === "string"
				? [{ type: "text" as const, text: prev.content }]
				: prev.content;
			const bContent = typeof msg.content === "string"
				? [{ type: "text" as const, text: msg.content }]
				: msg.content;
			prev.content = [...aContent, ...bContent];
		} else {
			final.push({ ...msg });
		}
	}

	log.info("ChatMessages built for provider", {
		totalCount: final.length,
		firstRole: final[0]?.role ?? "none",
		secondRole: final[1]?.role ?? "none",
		lastRole: final[final.length - 1]?.role ?? "none",
		roles: final.map((m) => m.role),
	});

	return final;
}

/**
 * Extract messages that follow the last assistant turn.
 *
 * These are "pending" messages the LLM hasn't responded to yet (typically
 * the current user message, or tool_call + tool_result during a tool loop).
 * They must be re-appended after compaction so the conversation ends on a
 * user turn, as required by providers like Bedrock that reject assistant
 * message prefill.
 */
export function extractPendingMessages(messages: Message[]): Message[] {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") {
			return messages.slice(i + 1);
		}
	}
	// No prior assistant response — all messages are pending
	return [...messages];
}

/**
 * Calculate cost from token counts using user-configured pricing or
 * static model metadata.
 */
export function calculateCost(
	inputTokens: number,
	outputTokens: number,
	modelId: string,
	settings: NotorSettings,
): number | null {
	// Check user-configured pricing first
	const userPricing = settings.model_pricing[modelId] as ModelPricing | undefined;
	if (userPricing) {
		return (
			(inputTokens / 1000) * userPricing.input +
			(outputTokens / 1000) * userPricing.output
		);
	}

	// Fall back to static metadata pricing
	const metadata = getModelMetadata(modelId);
	if (metadata?.input_price_per_1k != null && metadata?.output_price_per_1k != null) {
		return (
			(inputTokens / 1000) * metadata.input_price_per_1k +
			(outputTokens / 1000) * metadata.output_price_per_1k
		);
	}

	return null;
}
