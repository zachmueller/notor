/**
 * Anthropic API provider.
 *
 * Implements the LLMProvider interface for direct Anthropic API access.
 * Uses Anthropic's Messages API with SSE streaming and their specific
 * event types (message_start, content_block_delta, message_delta, etc.).
 *
 * @see specs/01-mvp/contracts/llm-provider.md — Anthropic API mapping
 * @see design/research/llm-model-list-apis.md — Section 2
 */

import type { App } from "obsidian";
import type { LLMProviderConfig, ModelInfo } from "../types";
import type {
	ChatMessage,
	LLMProvider,
	SendMessageOptions,
	StreamChunk,
	ToolDefinition,
} from "./provider";
import { ProviderError } from "./provider";
import type { ContentBlock as MediaContentBlock } from "../media/types";
import { getSecret, secretIdForApiKey } from "../utils/secrets";
import { estimateTokenCount } from "../utils/tokens";
import { logger } from "../utils/logger";
import { resolveAnthropicThinking } from "./thinking-config";
import { supportsThinking } from "./model-metadata";

const log = logger("AnthropicProvider");

/** Minimal shape of Anthropic SSE event data payloads (raw JSON, no SDK dependency). */
interface AnthropicEventData {
	content_block?: { type?: string; id?: string; name?: string; thinking?: string };
	delta?: { type?: string; text?: string; partial_json?: string; thinking?: string };
	index?: number;
	usage?: { input_tokens?: number; output_tokens?: number };
	message?: { usage?: { input_tokens?: number } };
	error?: { message?: string };
}

/** Default Anthropic API endpoint. */
const DEFAULT_ENDPOINT = "https://api.anthropic.com";

/** Required Anthropic API version header. */
const ANTHROPIC_VERSION = "2023-06-01";

/** Map a Notor ContentBlock to Anthropic's native content block format. */
function mapToAnthropicBlock(block: MediaContentBlock): Record<string, unknown> {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", source: { type: "base64", media_type: block.media_type, data: block.data } };
		case "document":
			return { type: "document", title: block.name, source: { type: "base64", media_type: "application/pdf", data: block.data } };
		case "custom_block":
			// custom_block is translated to wire text before reaching providers
			return { type: "text", text: block.fallback_text ?? "" };
	}
}

/**
 * Convert Notor ChatMessages to Anthropic Messages API format.
 *
 * Anthropic separates system messages from the messages array.
 * Tool calls and results are represented as content blocks.
 */
function toAnthropicMessages(
	messages: ChatMessage[]
): { system: string | undefined; messages: Record<string, unknown>[] } {
	let system: string | undefined;
	const anthropicMessages: Record<string, unknown>[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			// Anthropic takes system as a separate parameter
			const text = typeof msg.content === "string"
				? msg.content
				: (() => { throw new Error("Expected string content for system message"); })();
			system = system ? `${system}\n\n${text}` : text;
			continue;
		}

		if (msg.role === "tool_call" && msg.tool_calls?.length) {
			// Tool use is part of the assistant's response in Anthropic's format.
			// Pre-tool-call text (if any) is included as a leading text block.
			const content: Record<string, unknown>[] = [];
			if (msg.content) {
				const text = typeof msg.content === "string"
					? msg.content
					: (() => { throw new Error("Expected string content for assistant message"); })();
				content.push({ type: "text", text });
			}
			for (const tc of msg.tool_calls) {
				content.push({
					type: "tool_use",
					id: tc.id,
					name: tc.tool_name,
					input: tc.parameters,
				});
			}
			anthropicMessages.push({ role: "assistant", content });
			continue;
		}

		if (msg.role === "tool_result" && msg.tool_results?.length) {
			anthropicMessages.push({
				role: "user",
				content: msg.tool_results.map((tr) => {
					if (tr.content_blocks?.length) {
						// Multipart tool result: text summary + media blocks
						const parts: Record<string, unknown>[] = [];
						if (tr.result) {
							parts.push({ type: "text", text: tr.result });
						}
						for (const block of tr.content_blocks) {
							parts.push(mapToAnthropicBlock(block));
						}
						return {
							type: "tool_result",
							tool_use_id: tr.tool_call_id,
							content: parts,
							is_error: tr.is_error,
						};
					}
					return {
						type: "tool_result",
						tool_use_id: tr.tool_call_id,
						content: tr.result,
						is_error: tr.is_error,
					};
				}),
			});
			continue;
		}

		if (msg.role === "user") {
			if (Array.isArray(msg.content)) {
				anthropicMessages.push({
					role: "user",
					content: msg.content.map(mapToAnthropicBlock),
				});
			} else if (msg.content === "") {
				// Anthropic rejects empty text content blocks in arrays — pass empty string directly
				anthropicMessages.push({ role: "user", content: msg.content });
			} else {
				anthropicMessages.push({
					role: "user",
					content: [{ type: "text", text: msg.content }],
				});
			}
		} else {
			// Assistant message — always string
			const text = typeof msg.content === "string"
				? msg.content
				: (() => { throw new Error("Expected string content for assistant message"); })();
			anthropicMessages.push({ role: "assistant", content: text });
		}
	}

	return { system, messages: anthropicMessages };
}

/**
 * Convert Notor ToolDefinitions to Anthropic tool format.
 */
function toAnthropicTools(
	tools: ToolDefinition[]
): Record<string, unknown>[] | undefined {
	if (tools.length === 0) return undefined;
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.input_schema,
	}));
}

/**
 * Anthropic API provider implementation.
 */
export class AnthropicProvider implements LLMProvider {
	private readonly endpoint: string;
	private readonly instanceId: string;
	private readonly app: App;

	constructor(config: LLMProviderConfig, app: App) {
		this.endpoint = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
		this.instanceId = config.id;
		this.app = app;
	}

	private getApiKey(): string {
		const key = getSecret(this.app, secretIdForApiKey(this.instanceId));
		if (!key) {
			throw new ProviderError(
				"Anthropic API key not configured. Add your API key in Settings → Notor.",
				"anthropic",
				"AUTH_FAILED"
			);
		}
		return key;
	}

	async *sendMessage(
		messages: ChatMessage[],
		tools: ToolDefinition[],
		options: SendMessageOptions
	): AsyncIterable<StreamChunk> {
		const apiKey = this.getApiKey();
		const url = `${this.endpoint}/v1/messages`;

		const { system, messages: anthropicMessages } =
			toAnthropicMessages(messages);

		// Resolve thinking configuration
		const resolved = supportsThinking(options.model)
			? resolveAnthropicThinking(options.thinking_level, options.model)
			: undefined;
		const thinkingConfig = resolved?.thinking;

		const defaultMaxTokens = thinkingConfig ? 16384 : 4096;

		const body: Record<string, unknown> = {
			model: options.model,
			messages: anthropicMessages,
			max_tokens: Math.max(options.max_tokens ?? defaultMaxTokens, thinkingConfig ? 16384 : 0),
			stream: true,
		};

		if (thinkingConfig) {
			body.thinking = thinkingConfig;
			// Effort models (Opus 4.8+) require output_config.effort alongside
			// thinking.type=adaptive instead of a token budget.
			if (resolved?.effort) {
				body.output_config = { effort: resolved.effort };
			}
			// Temperature is incompatible with thinking
		} else if (options.temperature !== undefined) {
			body.temperature = options.temperature;
		}

		if (system) {
			body.system = system;
		}
		const anthropicTools = toAnthropicTools(tools);
		if (anthropicTools) {
			body.tools = anthropicTools;
			// tool_choice "any" is incompatible with thinking
			if (thinkingConfig && body.tool_choice === "any") {
				body.tool_choice = "auto";
			}
		}
		if (options.stop_sequences !== undefined) {
			body.stop_sequences = options.stop_sequences;
		}

		// Build headers — add beta header when thinking is enabled
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
		};
		if (thinkingConfig) {
			headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: options.abort_signal,
			});
		} catch (e: unknown) {
			if (e instanceof DOMException && e.name === "AbortError") {
				return;
			}
			throw new ProviderError(
				`Could not connect to Anthropic API: ${String(e)}`,
				"anthropic",
				"CONNECTION_FAILED",
				e instanceof Error ? e : undefined
			);
		}

		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error");
			if (response.status === 401) {
				throw new ProviderError(
					"Invalid Anthropic API key. Check your credentials in Settings → Notor.",
					"anthropic",
					"AUTH_FAILED"
				);
			}
			if (response.status === 429) {
				throw new ProviderError(
					"Anthropic API rate limited. Please wait and try again.",
					"anthropic",
					"RATE_LIMITED"
				);
			}
			if (response.status === 400 && errorText.includes("context_length")) {
				throw new ProviderError(
					"Context length exceeded for this model.",
					"anthropic",
					"CONTEXT_LENGTH_EXCEEDED"
				);
			}
			throw new ProviderError(
				`Anthropic API error (${response.status}): ${errorText}`,
				"anthropic",
				"PROVIDER_ERROR"
			);
		}

		if (!response.body) {
			throw new ProviderError(
				"No response body from Anthropic API",
				"anthropic",
				"PROVIDER_ERROR"
			);
		}

		yield* this.parseAnthropicStream(response.body, options.abort_signal);
	}

	/**
	 * Parse Anthropic's SSE stream format.
	 *
	 * Anthropic uses event types: message_start, content_block_start,
	 * content_block_delta, content_block_stop, message_delta, message_stop.
	 */
	private async *parseAnthropicStream(
		stream: ReadableStream<Uint8Array>,
		signal?: AbortSignal
	): AsyncIterable<StreamChunk> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let currentEventType = "";
		const streamState = { pendingInputTokens: 0 };

		try {
			while (true) {
				if (signal?.aborted) return;

				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();

					if (trimmed === "" || trimmed.startsWith(":")) {
						continue;
					}

					// Capture event type
					if (trimmed.startsWith("event: ")) {
						currentEventType = trimmed.slice(7);
						continue;
					}

					if (trimmed.startsWith("data: ")) {
						const data = trimmed.slice(6);
						try {
							const parsed = JSON.parse(data);
							yield* this.handleAnthropicEvent(
								currentEventType,
								parsed,
								streamState
							);
						} catch {
							log.warn("Failed to parse Anthropic SSE data", {
								event: currentEventType,
								data,
							});
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Handle a single Anthropic SSE event.
	 */
	private *handleAnthropicEvent(
		eventType: string,
		data: AnthropicEventData,
		streamState: { pendingInputTokens: number }
	): Iterable<StreamChunk> {
		switch (eventType) {
			case "content_block_start": {
				const block = data.content_block;
				if (block?.type === "tool_use") {
					yield {
						type: "tool_call_start",
						id: block.id ?? "",
						tool_name: block.name ?? "",
					};
				} else if (block?.type === "thinking" || block?.type === "redacted_thinking") {
					// Emit a lifecycle signal on the thinking block boundary even when
					// no thinking text is present (Opus 4.8+ hidden thinking still opens
					// a thinking block on the wire with its text omitted). The optional
					// text delta follows only when the block actually carries content.
					yield { type: "thinking_start" };
					if (block.type === "thinking" && block.thinking) {
						yield { type: "thinking_delta", text: block.thinking };
					}
				}
				break;
			}

			case "content_block_delta": {
				const delta = data.delta;
				if (delta?.type === "text_delta") {
					yield { type: "text_delta", text: delta.text ?? "" };
				} else if (delta?.type === "thinking_delta") {
					yield { type: "thinking_delta", text: delta.thinking ?? "" };
				} else if (delta?.type === "input_json_delta") {
					yield {
						type: "tool_call_delta",
						id: data.index?.toString() ?? "0",
						partial_json: delta.partial_json ?? "",
					};
				}
				break;
			}

			case "content_block_stop": {
				// Anthropic doesn't provide the block ID in content_block_stop,
				// but the index can be used. We emit tool_call_end for all
				// tool use blocks tracked by the caller.
				// For simplicity, emit with index as ID placeholder.
				// The caller tracks mapping from index → actual tool call ID.
				yield {
					type: "tool_call_end",
					id: data.index?.toString() ?? "0",
				};
				break;
			}

			case "message_delta": {
				// Contains stop_reason and usage. output_tokens comes from
				// message_delta; input_tokens was captured from message_start.
				if (data.usage) {
					yield {
						type: "message_end",
						input_tokens: streamState.pendingInputTokens,
						output_tokens: data.usage.output_tokens ?? 0,
					};
				}
				break;
			}

			case "message_start": {
				// Anthropic sends input_tokens in message_start (nested at
				// data.message.usage.input_tokens). message_delta only has
				// output_tokens, so we capture input here for later emission.
				streamState.pendingInputTokens =
					data.message?.usage?.input_tokens ?? 0;
				break;
			}

			case "message_stop":
				// End of message — nothing to emit
				break;

			case "error": {
				yield {
					type: "error",
					error: data.error?.message ?? "Unknown Anthropic error",
				};
				break;
			}

			case "ping":
				// Keep-alive, ignore
				break;

			default:
				log.debug("Unknown Anthropic event type", { eventType });
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const apiKey = this.getApiKey();
		const allModels: ModelInfo[] = [];
		let afterId: string | undefined;
		let hasMore = true;

		while (hasMore) {
			const url = new URL(`${this.endpoint}/v1/models`);
			if (afterId) {
				url.searchParams.set("after_id", afterId);
			}

			let response: Response;
			try {
				response = await fetch(url.toString(), {
					headers: {
						"x-api-key": apiKey,
						"anthropic-version": ANTHROPIC_VERSION,
					},
				});
			} catch (e: unknown) {
				throw new ProviderError(
					`Could not connect to Anthropic API: ${String(e)}`,
					"anthropic",
					"CONNECTION_FAILED",
					e instanceof Error ? e : undefined
				);
			}

			if (!response.ok) {
				if (response.status === 401) {
					throw new ProviderError(
						"Invalid Anthropic API key. Check your credentials in Settings → Notor.",
						"anthropic",
						"AUTH_FAILED"
					);
				}
				throw new ProviderError(
					`Failed to list Anthropic models (${response.status})`,
					"anthropic",
					"PROVIDER_ERROR"
				);
			}

			const json = await response.json();
			const models: ModelInfo[] = (json.data ?? []).map(
				(m: { id: string; display_name?: string }) => ({
					id: m.id,
					display_name: m.display_name || m.id,
					context_window: null,
					input_price_per_1k: null,
					output_price_per_1k: null,
					provider: "anthropic",
				})
			);

			allModels.push(...models);
			hasMore = json.has_more === true;
			afterId = json.last_id;
		}

		return allModels;
	}

	getTokenCount(text: string): number {
		return estimateTokenCount(text);
	}

	supportsStreaming(): boolean {
		return true;
	}

	async validateConnection(): Promise<boolean> {
		await this.listModels();
		return true;
	}
}