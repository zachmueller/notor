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

import type { ProviderErrorDetails, StreamChunk } from "../providers/provider";
import { logger } from "../utils/logger";

const log = logger("stream-utils");

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export type ParsedStreamEvent =
	| { type: "text_delta"; text: string; delta: string }
	| { type: "thinking_started" }
	| { type: "thinking_delta"; text: string; delta: string }
	// Emitted the moment a tool call opens in the stream — carries the tool
	// name/id but no parameters yet (those arrive on `tool_call`). Lets the UI
	// render an in-progress placeholder card during the parse window.
	| { type: "tool_call_started"; id: string; name: string }
	| { type: "tool_call"; id: string; name: string; parameters: Record<string, unknown> }
	| { type: "message_end"; inputTokens: number; outputTokens: number }
	| { type: "error"; message: string; details?: ProviderErrorDetails }
	| { type: "cancelled"; text: string };

/** Why an in-flight tool call's accumulated JSON could not be finalized. */
export type PartialToolCallReason =
	// `JSON.parse` threw — the accumulated JSON is malformed/incomplete.
	| "parse_failure"
	// The stream ended (message_end) with a max_tokens/length stop reason while
	// a tool call was still open — the output ceiling cut off its JSON.
	| "max_tokens"
	// The stream simply exhausted with a non-empty, never-finalized tool call
	// and no stop reason (e.g. a dropped/aborted upstream connection).
	| "truncated_stream";

/** Options for {@link parseStreamEvents}. */
export interface ParseStreamOpts {
	/**
	 * Preserve the raw accumulated JSON of a tool call that failed to parse or
	 * was cut off mid-stream, so the streamed content is never silently lost.
	 *
	 * Returns the spill file path (embedded in the diagnostic `error` event), or
	 * `undefined` when preservation is unavailable (mobile / spillover disabled)
	 * or the write failed. Must never throw — preservation is best-effort.
	 */
	onPartialToolCall?: (info: {
		toolName: string;
		partialJson: string;
		reason: PartialToolCallReason;
	}) => Promise<string | undefined>;
}

/**
 * Stop/finish reasons that indicate the model hit its output token ceiling.
 * Covers Anthropic/Bedrock ("max_tokens") and OpenAI/local ("length").
 */
function isTruncationStopReason(reason: string | undefined): boolean {
	return reason === "max_tokens" || reason === "length";
}

/** Bounded head/tail preview of (potentially multi-MB) accumulated JSON. */
function previewJson(json: string): { byteLength: number; head: string; tail: string } {
	return {
		byteLength: json.length,
		head: json.slice(0, 200),
		tail: json.length > 200 ? json.slice(-200) : "",
	};
}

/**
 * Tool names whose truncated writes benefit from skeleton-first staging. For
 * these, a recovered `path` lets us steer the agent (and user) toward the
 * skeleton → `replace_in_note` → `update_frontmatter` workaround.
 */
const WRITE_TOOL_NAMES = new Set(["write_note", "write_file"]);

/**
 * Best-effort extraction of the `path` argument from truncated/malformed
 * tool-call JSON. Truncation lands in the trailing `content` string, so the
 * earlier `path` field is almost always intact. Bounded to the first 64 KB
 * (path is near the front) so it stays cheap on multi-MB payloads.
 *
 * Never throws: the regex cannot throw and the `JSON.parse` of the extracted
 * fragment is guarded, so recovery can never break the stream parse. The
 * `[^"\\]|\\.` body only matches a *terminated* quoted value, so a `path` that
 * was itself cut off mid-value correctly yields `undefined`.
 */
function recoverPathFromPartialJson(partialJson: string): string | undefined {
	const head = partialJson.slice(0, 65_536);
	const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head);
	if (!m) return undefined;
	try {
		return JSON.parse(`"${m[1]}"`) as string;
	} catch {
		return undefined;
	}
}

/**
 * Build the user-facing `error` message for a tool call whose JSON could not be
 * finalized. Surfaces the cause, byte count, and (when preserved) the spill path
 * so the user can recover the content via `read_file`. When a target `path` was
 * recovered from the truncated JSON, names it — and for write tools, steers
 * toward the skeleton-first workaround that keeps each write small enough to
 * complete.
 */
function formatTruncationError(
	toolName: string,
	byteLength: number,
	spillPath: string | undefined,
	reason: PartialToolCallReason,
	recoveredPath?: string,
): string {
	const cause =
		reason === "parse_failure"
			? `Failed to parse tool call parameters for ${toolName} — the response appears to have been cut off mid-write`
			: reason === "max_tokens"
				? `The ${toolName} tool call was cut off before completing — the model hit its output token limit`
				: `The ${toolName} tool call was cut off before completing — the response stream ended early`;
	const preserved = spillPath
		? ` Partial content was preserved at: ${spillPath} (open it with read_file).`
		: "";
	let recovered = "";
	if (recoveredPath) {
		recovered = ` Recovered target path: ${recoveredPath}.`;
		if (WRITE_TOOL_NAMES.has(toolName)) {
			recovered +=
				` To finish reliably, write_note a skeleton (headings plus a distinctive` +
				` placeholder marker under each section) to that path, fill each section with` +
				` a follow-up replace_in_note edit, then set frontmatter with update_frontmatter.`;
		}
	}
	return `${cause} (received ${byteLength.toLocaleString()} bytes).${preserved}${recovered}`;
}

// ---------------------------------------------------------------------------
// parseStreamEvents
// ---------------------------------------------------------------------------

/**
 * Async generator that transforms a raw provider stream into parsed events.
 *
 * - `text_delta` events carry both the accumulated text and the new delta.
 * - `tool_call_started` is emitted as soon as a tool call opens (name/id only,
 *   no parameters); `tool_call` follows once the full JSON has been received
 *   and parsed (on `tool_call_end`).
 * - `cancelled` is emitted at most once, when the abort signal fires.
 * - `error` is emitted for provider errors or JSON parse failures.
 *
 * When a tool call's JSON cannot be finalized — it fails to parse, or the
 * stream ends with the call still open (max_tokens truncation / dropped
 * connection) — the accumulated raw JSON is handed to `opts.onPartialToolCall`
 * (if provided) so the streamed content can be preserved instead of silently
 * lost, and a descriptive `error` is emitted (never a `tool_call`, so partial
 * content never re-enters the conversation as a successful write).
 */
export async function* parseStreamEvents(
	stream: AsyncIterable<StreamChunk>,
	abortSignal: AbortSignal,
	opts: ParseStreamOpts = {},
): AsyncIterable<ParsedStreamEvent> {
	let textContent = "";
	let thinkingContent = "";
	// Latch so `thinking_started` is emitted at most once per stream, whether the
	// provider sends an explicit `thinking_start` boundary or only `thinking_delta`
	// chunks (in which case we synthesize the start from the first delta).
	let thinkingStarted = false;

	// Per-tool-call accumulation state
	let currentToolCallId = "";
	let currentToolName = "";
	let toolCallJson = "";
	// True between tool_call_start and its matching tool_call_end. If the stream
	// ends (or hits its token ceiling) while this is set, the call's JSON was
	// truncated — we preserve it rather than letting it silently vanish.
	let toolCallOpen = false;
	// Latest stop/finish reason from the provider (message_end). "max_tokens"/
	// "length" mean the output ceiling was hit.
	let lastStopReason: string | undefined;

	// Best-effort preservation of an unfinalized tool call's raw JSON. Never
	// throws — the spill callback itself is expected to swallow write errors,
	// but guard regardless so preservation can never break the stream parse.
	const preservePartial = async (reason: PartialToolCallReason): Promise<string | undefined> => {
		if (!opts.onPartialToolCall || toolCallJson.length === 0) return undefined;
		try {
			return await opts.onPartialToolCall({
				toolName: currentToolName,
				partialJson: toolCallJson,
				reason,
			});
		} catch (e) {
			log.error("onPartialToolCall threw while preserving tool-call content", {
				toolName: currentToolName,
				error: String(e),
			});
			return undefined;
		}
	};

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

				case "thinking_start":
					if (!thinkingStarted) {
						thinkingStarted = true;
						yield { type: "thinking_started" };
					}
					break;

				case "thinking_delta":
					if (!thinkingStarted) {
						thinkingStarted = true;
						yield { type: "thinking_started" };
					}
					thinkingContent += chunk.text;
					yield { type: "thinking_delta", text: thinkingContent, delta: chunk.text };
					break;

				case "tool_call_start":
					currentToolCallId = chunk.id;
					currentToolName = chunk.tool_name;
					toolCallJson = "";
					toolCallOpen = true;
					yield { type: "tool_call_started", id: chunk.id, name: chunk.tool_name };
					break;

				case "tool_call_delta":
					toolCallJson += chunk.partial_json;
					break;

				case "tool_call_end": {
					let parameters: Record<string, unknown> = {};
					try {
						if (toolCallJson.trim()) {
							parameters = JSON.parse(toolCallJson) as Record<string, unknown>;
						}
					} catch (e) {
						// Truncated/malformed JSON — preserve the raw content before
						// erroring so the streamed write is never silently lost. Logged
						// at `error` level (not `warn`) so it surfaces at the default log
						// level; preview only (head/tail) to avoid flooding the console.
						const spillPath = await preservePartial("parse_failure");
						const recoveredPath = recoverPathFromPartialJson(toolCallJson);
						log.error("Tool-call JSON parse failed — partial content preserved", {
							toolName: currentToolName,
							...previewJson(toolCallJson),
							spillPath,
							recoveredPath,
							error: String(e),
						});
						yield {
							type: "error",
							message: formatTruncationError(
								currentToolName,
								toolCallJson.length,
								spillPath,
								"parse_failure",
								recoveredPath,
							),
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
					toolCallOpen = false;
					break;
				}

				case "message_end":
					lastStopReason = chunk.stop_reason;
					yield {
						type: "message_end",
						inputTokens: chunk.input_tokens,
						outputTokens: chunk.output_tokens,
					};
					break;

				case "error":
					yield { type: "error", message: chunk.error, details: chunk.details };
					return;
			}
		}

		// Stream exhausted with a tool call still open (no tool_call_end). This is
		// the silent-abandon case — e.g. OpenAI/local hitting finish_reason
		// "length", or a dropped connection — where no exception is ever thrown.
		// Preserve the partial JSON and emit a diagnostic rather than letting the
		// call vanish. Gate on !aborted so a user Stop (handled as `cancelled`)
		// never produces a spurious truncation error.
		if (toolCallOpen && toolCallJson.length > 0 && !abortSignal.aborted) {
			const reason: PartialToolCallReason = isTruncationStopReason(lastStopReason)
				? "max_tokens"
				: "truncated_stream";
			const spillPath = await preservePartial(reason);
			const recoveredPath = recoverPathFromPartialJson(toolCallJson);
			log.error("Stream ended with an unfinished tool call — content preserved", {
				toolName: currentToolName,
				...previewJson(toolCallJson),
				stopReason: lastStopReason,
				spillPath,
				recoveredPath,
			});
			yield {
				type: "error",
				message: formatTruncationError(
					currentToolName,
					toolCallJson.length,
					spillPath,
					reason,
					recoveredPath,
				),
			};
		}
	} catch (e) {
		if (abortSignal.aborted) {
			yield { type: "cancelled", text: textContent };
			return;
		}
		throw e;
	}
}
