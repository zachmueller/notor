/**
 * Shared stream event parser for LLM response streams.
 *
 * Transforms raw `AsyncIterable<StreamChunk>` from providers into
 * higher-level, fully-parsed events. Both `ChatOrchestrator.processStream()`
 * and `SubAgentRunner` consume this same generator, keeping parsing logic
 * in one place and letting each caller handle rendering/progress independently.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 9.1
 */

import type { StreamChunk } from "../providers/provider";
import { logger } from "../utils/logger";

const log = logger("stream-utils");

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type ParsedStreamEvent =
	| { type: "text_delta"; text: string; delta: string }
	| { type: "thinking_delta"; text: string; delta: string }
	| { type: "tool_call"; id: string; name: string; parameters: Record<string, unknown> }
	| { type: "message_end"; inputTokens: number; outputTokens: number }
	| { type: "error"; message: string }
	| { type: "cancelled"; text: string };

// ---------------------------------------------------------------------------
// parseStreamEvents
// ---------------------------------------------------------------------------

/**
 * Async generator that transforms a raw provider stream into parsed events.
 *
 * - `text_delta` events carry both the accumulated text and the new delta.
 * - `tool_call` events are emitted only once the full JSON has been received
 *   and parsed (on `tool_call_end`).
 * - `cancelled` is emitted at most once, when the abort signal fires.
 * - `error` is emitted for provider errors or JSON parse failures.
 */
export async function* parseStreamEvents(
	stream: AsyncIterable<StreamChunk>,
	abortSignal: AbortSignal,
): AsyncIterable<ParsedStreamEvent> {
	let textContent = "";
	let thinkingContent = "";

	// Per-tool-call accumulation state
	let currentToolCallId = "";
	let currentToolName = "";
	let toolCallJson = "";

	try {
		for await (const chunk of stream) {
			if (abortSignal.aborted) {
				yield { type: "cancelled", text: textContent };
				return;
			}

			switch (chunk.type) {
				case "text_delta":
					textContent += chunk.text;
					yield { type: "text_delta", text: textContent, delta: chunk.text };
					break;

				case "thinking_delta":
					thinkingContent += chunk.text;
					yield { type: "thinking_delta", text: thinkingContent, delta: chunk.text };
					break;

				case "tool_call_start":
					currentToolCallId = chunk.id;
					currentToolName = chunk.tool_name;
					toolCallJson = "";
					break;

				case "tool_call_delta":
					toolCallJson += chunk.partial_json;
					break;

				case "tool_call_end": {
					let parameters: Record<string, unknown> = {};
					try {
						if (toolCallJson.trim()) {
							parameters = JSON.parse(toolCallJson);
						}
					} catch (e) {
						log.warn("Failed to parse tool call JSON", {
							toolName: currentToolName,
							json: toolCallJson,
							error: String(e),
						});
						yield {
							type: "error",
							message: `Failed to parse tool call parameters for ${currentToolName}`,
						};
						return;
					}

					yield {
						type: "tool_call",
						id: currentToolCallId,
						name: currentToolName,
						parameters,
					};

					// Reset per-call state for the next tool call in the stream
					currentToolCallId = "";
					currentToolName = "";
					toolCallJson = "";
					break;
				}

				case "message_end":
					yield {
						type: "message_end",
						inputTokens: chunk.input_tokens,
						outputTokens: chunk.output_tokens,
					};
					break;

				case "error":
					yield { type: "error", message: chunk.error };
					return;
			}
		}
	} catch (e) {
		if (abortSignal.aborted) {
			yield { type: "cancelled", text: textContent };
			return;
		}
		throw e;
	}
}
