/**
 * Collect a non-streaming text completion from a provider.
 *
 * Every secondary LLM pass (compaction, extension `llmCall`, voice shaping)
 * needs the same thing: send messages with no tools, drain the stream, keep the
 * text and token counts, and retry transient failures. This helper owns that
 * loop so callers only decide what a terminal stream error means to them.
 */

import type { LLMProvider, ChatMessage, SendMessageOptions, StreamChunk } from "./provider";
import type { NotorSettings } from "../settings";
import { retryPolicyFromSettings, withStreamRetry } from "./stream-retry";
import { retryableCodeOfError, retryableCodeOfFailure } from "./network-errors";

export interface CollectTextResult {
	/** Concatenated text deltas (possibly partial when `failure` is set). */
	text: string;
	inputTokens: number;
	outputTokens: number;
	/** The terminal `error` chunk when the final attempt ended in one. */
	failure?: Extract<StreamChunk, { type: "error" }>;
}

export interface CollectTextOptions {
	/** Identifies the caller in retry logs (e.g. "compaction", "voice:cleanup"). */
	label: string;
	/** Aborts both the in-flight request and any retry wait. */
	signal?: AbortSignal;
}

/**
 * Send `messages` (no tools) and collect the streamed text.
 *
 * Transient failures are retried per the user's network settings. A stream
 * `error` chunk on the final attempt is returned as `failure` together with
 * whatever text arrived, rather than thrown — callers choose whether that is
 * fatal. Thrown provider errors still propagate.
 */
export async function collectText(
	provider: LLMProvider,
	messages: ChatMessage[],
	options: SendMessageOptions,
	settings: NotorSettings,
	opts: CollectTextOptions,
): Promise<CollectTextResult> {
	const signal = options.abort_signal ?? opts.signal;
	return withStreamRetry<CollectTextResult>(
		async () => {
			const stream = provider.sendMessage(messages, [], { ...options, abort_signal: signal });
			const attempt: CollectTextResult = { text: "", inputTokens: 0, outputTokens: 0 };
			for await (const chunk of stream) {
				switch (chunk.type) {
					case "text_delta":
						attempt.text += chunk.text;
						break;
					case "message_end":
						attempt.inputTokens = chunk.input_tokens;
						attempt.outputTokens = chunk.output_tokens;
						break;
					case "error":
						attempt.failure = chunk;
						return attempt;
				}
			}
			return attempt;
		},
		{
			policy: retryPolicyFromSettings(settings),
			signal,
			label: opts.label,
			classify: ({ result, error }) => {
				if (result === undefined) return retryableCodeOfError(error);
				return result.failure ? retryableCodeOfFailure(result.failure) : null;
			},
			onAbort: () => ({ text: "", inputTokens: 0, outputTokens: 0 }),
		},
	);
}
