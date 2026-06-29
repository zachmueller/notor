/**
 * Minimal type definitions for the OpenAI (and OpenAI-compatible) wire format.
 *
 * These describe ONLY the fields Notor reads from streaming chat-completion
 * chunks and the `/v1/models` listing — not the full API surface. They exist so
 * the provider parse sites can cast `JSON.parse(...)` / `response.json()` once
 * to a known shape instead of operating on `any`. Shared by the OpenAI and
 * local providers, which speak the same wire format.
 */

/** A single tool-call delta inside a streaming choice. */
export interface OpenAIToolCallDelta {
	index?: number;
	id?: string;
	function?: {
		name?: string;
		arguments?: string;
	};
}

/** The incremental `delta` payload of a streaming choice. */
export interface OpenAIStreamDelta {
	content?: string;
	tool_calls?: OpenAIToolCallDelta[];
}

/** One choice within a streaming chat-completion chunk. */
export interface OpenAIStreamChoice {
	finish_reason?: string | null;
	delta?: OpenAIStreamDelta;
}

/** Token-usage block, present on the final chunk for some endpoints. */
export interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
}

/** A single Server-Sent-Events chunk from a streaming chat completion. */
export interface OpenAIStreamChunk {
	choices?: OpenAIStreamChoice[];
	usage?: OpenAIUsage;
}

/** One entry in the `/v1/models` listing response. */
export interface OpenAIModelEntry {
	id: string;
	owned_by?: string;
}

/** The `/v1/models` listing response. */
export interface OpenAIModelsResponse {
	data?: OpenAIModelEntry[];
}
