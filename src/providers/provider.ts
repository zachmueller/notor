/**
 * LLM Provider interface and supporting types.
 *
 * Defines the provider-agnostic interface that all LLM integrations must
 * implement. This allows the chat system to work identically regardless
 * of which provider is active.
 *
 * All types sourced from specs/01-mvp/contracts/llm-provider.md.
 */

import type { ModelInfo } from "../types";
import type { ContentBlock } from "../media/types";

// ---------------------------------------------------------------------------
// ChatMessage — message format for LLM API calls
// ---------------------------------------------------------------------------

/**
 * Message sent to / received from the LLM.
 *
 * This is the wire format for provider API calls, distinct from the
 * persistence-oriented `Message` type in types.ts.
 */
export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
	content: string | ContentBlock[];
	tool_calls?: Array<{
		id: string;
		tool_name: string;
		parameters: Record<string, unknown>;
	}>;
	tool_results?: Array<{
		tool_call_id: string;
		tool_name: string;
		result: string;
		is_error: boolean;
		content_blocks?: ContentBlock[];
	}>;
}

// ---------------------------------------------------------------------------
// ToolDefinition — tool schema for LLM function calling
// ---------------------------------------------------------------------------

/**
 * Tool definition following OpenAI-style function calling schema.
 * Compatible across providers (with adaptation for Anthropic and Bedrock).
 */
export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: JSONSchema;
	mode?: "read" | "write";
}

/**
 * JSON Schema subset used for tool parameter definitions.
 */
export interface JSONSchema {
	type: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	description?: string;
	items?: JSONSchema;
	enum?: unknown[];
	default?: unknown;
	[key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SendMessageOptions
// ---------------------------------------------------------------------------

/** Options for the sendMessage call. */
export interface SendMessageOptions {
	/** Model ID to use for this request. */
	model: string;
	/** Maximum output tokens. */
	max_tokens?: number;
	/** Sampling temperature. */
	temperature?: number;
	/** Stop sequences. */
	stop_sequences?: string[];
	/** Signal for aborting the request (e.g., user clicks Stop). */
	abort_signal?: AbortSignal;
	/** Whether to use the extended (1M) context window beta (Bedrock only). */
	use_extended_context?: boolean;
	/** Thinking/reasoning level: "off"|"low"|"medium"|"high" or integer string for direct budget_tokens. */
	thinking_level?: string | null;
}

// ---------------------------------------------------------------------------
// StreamChunk — streaming response events
// ---------------------------------------------------------------------------

/** Union type covering all streaming response chunk types. */
export type StreamChunk =
	| { type: "text_delta"; text: string }
	| { type: "thinking_start" }
	| { type: "thinking_delta"; text: string }
	| { type: "tool_call_start"; id: string; tool_name: string }
	| { type: "tool_call_delta"; id: string; partial_json: string }
	| { type: "tool_call_end"; id: string }
	| {
			type: "message_end";
			input_tokens: number;
			output_tokens: number;
			/**
			 * Provider stop/finish reason, normalized to the raw provider string
			 * (e.g. Anthropic "max_tokens"/"end_turn", OpenAI/local "length"/"stop",
			 * Bedrock "max_tokens"/"end_turn"). Optional — providers populate it when
			 * available so the stream parser can detect output-ceiling truncation that
			 * cut off a tool call mid-write.
			 */
			stop_reason?: string;
	  }
	| { type: "error"; error: string; details?: ProviderErrorDetails };

// ---------------------------------------------------------------------------
// ProviderError
// ---------------------------------------------------------------------------

/** Error codes for provider-specific failures. */
export type ProviderErrorCode =
	| "AUTH_FAILED"
	| "CONNECTION_FAILED"
	| "RATE_LIMITED"
	| "MODEL_NOT_FOUND"
	| "INVALID_REQUEST"
	| "CONTEXT_LENGTH_EXCEEDED"
	| "PROVIDER_ERROR"
	| "UNKNOWN";

/**
 * Structured diagnostic detail attached to a provider failure so the raw
 * cause survives into the conversation history (see Message.error). Captures
 * the underlying exception name, the raw provider message, and the keys of
 * any request fields that may have triggered the rejection.
 */
export interface ProviderErrorDetails {
	name?: string;
	rawMessage?: string;
	offendingFields?: string[];
}

/**
 * Structured error class for provider failures.
 *
 * Includes the provider name and a categorized error code so the chat
 * system can react appropriately (e.g., prompt re-auth for AUTH_FAILED,
 * trigger truncation for CONTEXT_LENGTH_EXCEEDED).
 */
export class ProviderError extends Error {
	constructor(
		message: string,
		public readonly provider: string,
		public readonly code: ProviderErrorCode,
		public readonly cause?: Error,
		public readonly details?: ProviderErrorDetails
	) {
		super(message);
		this.name = "ProviderError";
	}
}

// ---------------------------------------------------------------------------
// LLMProvider interface
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic interface that all LLM integrations implement.
 *
 * The chat system interacts exclusively through this interface,
 * allowing transparent switching between providers.
 */
export interface LLMProvider {
	/**
	 * Send a message to the LLM and receive a streaming response.
	 *
	 * @param messages - Ordered array of conversation messages
	 * @param tools - Available tool definitions for the LLM to call
	 * @param options - Provider-specific and general options
	 * @returns Async iterable of response chunks
	 */
	sendMessage(
		messages: ChatMessage[],
		tools: ToolDefinition[],
		options: SendMessageOptions
	): AsyncIterable<StreamChunk>;

	/**
	 * Fetch the list of available models from this provider.
	 *
	 * @returns Array of model info objects, or empty array if unavailable
	 * @throws ProviderError if credentials are invalid or provider is unreachable
	 */
	listModels(): Promise<ModelInfo[]>;

	/**
	 * Estimate the token count for a given text string.
	 * Used for context window tracking and cost estimation.
	 *
	 * @param text - The text to count tokens for
	 * @returns Estimated token count
	 */
	getTokenCount(text: string): number;

	/**
	 * Whether this provider natively supports streaming responses.
	 * If false, the provider implementation must use a buffering adapter
	 * that simulates the streaming interface.
	 */
	supportsStreaming(): boolean;

	/**
	 * Validate that the provider's credentials and configuration are correct.
	 * Used for settings validation and connection testing.
	 *
	 * @returns True if the provider is reachable and credentials are valid
	 * @throws ProviderError with descriptive message on failure
	 */
	validateConnection(): Promise<boolean>;

	/**
	 * Clear cached credentials/clients so the next request creates fresh ones.
	 * Optional — only providers that cache credentials need to implement this.
	 */
	resetCredentials?(): void;
}

// ---------------------------------------------------------------------------
// Buffering adapter for non-streaming providers
// ---------------------------------------------------------------------------

/**
 * Wraps a non-streaming response and yields it as simulated StreamChunk events.
 *
 * Ensures the chat UI always consumes the same `AsyncIterable<StreamChunk>`
 * interface regardless of provider capabilities.
 */
export async function* bufferToStream(
	response: Promise<{
		content: string;
		input_tokens: number;
		output_tokens: number;
	}>
): AsyncIterable<StreamChunk> {
	const result = await response;
	yield { type: "text_delta", text: result.content };
	yield {
		type: "message_end",
		input_tokens: result.input_tokens,
		output_tokens: result.output_tokens,
	};
}