/**
 * OpenAI API provider.
 *
 * Implements the LLMProvider interface for direct OpenAI API access.
 * Shares the same wire format as the local provider but with
 * OpenAI-specific endpoint and authentication.
 *
 * Supports custom endpoint URLs for Azure OpenAI or compatible services.
 *
 * @see specs/01-mvp/contracts/llm-provider.md — OpenAI API mapping
 * @see design/research/llm-model-list-apis.md — Section 1
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
import { parseSSEStream } from "./sse";
import { getSecret, SECRET_IDS } from "../utils/secrets";
import { estimateTokenCount } from "../utils/tokens";
import { logger } from "../utils/logger";

const log = logger("OpenAIProvider");

/** Default OpenAI API endpoint. */
const DEFAULT_ENDPOINT = "https://api.openai.com";

/**
 * Known OpenAI chat model prefixes for client-side filtering.
 *
 * The /v1/models endpoint returns 100+ models including embeddings,
 * image, audio, etc. We filter to known chat-capable prefixes.
 */
const CHAT_MODEL_PREFIXES = [
	"gpt-4",
	"gpt-3.5",
	"o1",
	"o3",
	"o4",
	"chatgpt-",
];

/**
 * Convert Notor ChatMessages to OpenAI API message format.
 */
function toOpenAIMessages(
	messages: ChatMessage[]
): Record<string, unknown>[] {
	return messages.map((msg) => {
		if (msg.role === "tool_call" && msg.tool_call) {
			return {
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: msg.tool_call.id,
						type: "function",
						function: {
							name: msg.tool_call.tool_name,
							arguments: JSON.stringify(msg.tool_call.parameters),
						},
					},
				],
			};
		}

		if (msg.role === "tool_result" && msg.tool_result) {
			return {
				role: "tool",
				tool_call_id: msg.tool_result.tool_call_id,
				content: msg.tool_result.result,
			};
		}

		return {
			role: msg.role === "tool_call" || msg.role === "tool_result"
				? "user"
				: msg.role,
			content: msg.content,
		};
	});
}

/**
 * Convert Notor ToolDefinitions to OpenAI function calling format.
 */
function toOpenAITools(
	tools: ToolDefinition[]
): Record<string, unknown>[] | undefined {
	if (tools.length === 0) return undefined;
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.input_schema,
		},
	}));
}

/**
 * Check if a model ID looks like a chat-capable model.
 */
function isChatModel(modelId: string): boolean {
	const lower = modelId.toLowerCase();
	return CHAT_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * OpenAI API provider implementation.
 */
export class OpenAIProvider implements LLMProvider {
	private readonly endpoint: string;
	private readonly app: App;

	constructor(config: LLMProviderConfig, app: App) {
		this.endpoint = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
		this.app = app;
	}

	private getApiKey(): string {
		const key = getSecret(this.app, SECRET_IDS.OPENAI_API_KEY);
		if (!key) {
			throw new ProviderError(
				"OpenAI API key not configured. Add your API key in Settings → Notor.",
				"openai",
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
		const url = `${this.endpoint}/v1/chat/completions`;

		const body: Record<string, unknown> = {
			model: options.model,
			messages: toOpenAIMessages(messages),
			stream: true,
			stream_options: { include_usage: true },
		};

		const openaiTools = toOpenAITools(tools);
		if (openaiTools) {
			body.tools = openaiTools;
		}
		if (options.max_tokens !== undefined) {
			body.max_tokens = options.max_tokens;
		}
		if (options.temperature !== undefined) {
			body.temperature = options.temperature;
		}
		if (options.stop_sequences !== undefined) {
			body.stop = options.stop_sequences;
		}

		let response: Response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${apiKey}`,
				},
				body: JSON.stringify(body),
				signal: options.abort_signal,
			});
		} catch (e: unknown) {
			if (e instanceof DOMException && e.name === "AbortError") {
				return;
			}
			throw new ProviderError(
				`Could not connect to OpenAI API: ${String(e)}`,
				"openai",
				"CONNECTION_FAILED",
				e instanceof Error ? e : undefined
			);
		}

		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error");
			if (response.status === 401) {
				throw new ProviderError(
					"Invalid OpenAI API key. Check your credentials in Settings → Notor.",
					"openai",
					"AUTH_FAILED"
				);
			}
			if (response.status === 429) {
				throw new ProviderError(
					"OpenAI API rate limited. Please wait and try again.",
					"openai",
					"RATE_LIMITED"
				);
			}
			if (response.status === 404) {
				throw new ProviderError(
					`Model not found on OpenAI. Verify the model ID is correct.`,
					"openai",
					"MODEL_NOT_FOUND"
				);
			}
			if (response.status === 400 && errorText.includes("context_length")) {
				throw new ProviderError(
					"Context length exceeded for this model.",
					"openai",
					"CONTEXT_LENGTH_EXCEEDED"
				);
			}
			throw new ProviderError(
				`OpenAI API error (${response.status}): ${errorText}`,
				"openai",
				"PROVIDER_ERROR"
			);
		}

		if (!response.body) {
			throw new ProviderError(
				"No response body from OpenAI API",
				"openai",
				"PROVIDER_ERROR"
			);
		}

		// Track active tool calls for accumulating deltas
		const activeToolCalls = new Map<number, { id: string; name: string; args: string }>();

		for await (const data of parseSSEStream(response.body, options.abort_signal)) {
			try {
				const parsed = JSON.parse(data);

				// Handle usage info (may come in the final chunk)
				if (parsed.usage) {
					yield {
						type: "message_end",
						input_tokens: parsed.usage.prompt_tokens ?? 0,
						output_tokens: parsed.usage.completion_tokens ?? 0,
					};
				}

				const choice = parsed.choices?.[0];
				if (!choice) continue;

				const delta = choice.delta;
				if (!delta) continue;

				// Text content
				if (delta.content) {
					yield { type: "text_delta", text: delta.content };
				}

				// Tool calls
				if (delta.tool_calls) {
					for (const tc of delta.tool_calls) {
						const index = tc.index ?? 0;

						if (tc.id) {
							activeToolCalls.set(index, {
								id: tc.id,
								name: tc.function?.name ?? "",
								args: tc.function?.arguments ?? "",
							});
							if (tc.function?.name) {
								yield {
									type: "tool_call_start",
									id: tc.id,
									tool_name: tc.function.name,
								};
							}
						} else {
							const existing = activeToolCalls.get(index);
							if (existing) {
								if (tc.function?.arguments) {
									existing.args += tc.function.arguments;
									yield {
										type: "tool_call_delta",
										id: existing.id,
										partial_json: tc.function.arguments,
									};
								}
							}
						}
					}
				}

				// Check for finish reason
				if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
					for (const [, tc] of activeToolCalls) {
						yield { type: "tool_call_end", id: tc.id };
					}
					activeToolCalls.clear();
				}
			} catch {
				log.warn("Failed to parse SSE chunk", { data });
			}
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const apiKey = this.getApiKey();
		const url = `${this.endpoint}/v1/models`;

		let response: Response;
		try {
			response = await fetch(url, {
				headers: {
					"Authorization": `Bearer ${apiKey}`,
				},
			});
		} catch (e: unknown) {
			throw new ProviderError(
				`Could not connect to OpenAI API: ${String(e)}`,
				"openai",
				"CONNECTION_FAILED",
				e instanceof Error ? e : undefined
			);
		}

		if (!response.ok) {
			if (response.status === 401) {
				throw new ProviderError(
					"Invalid OpenAI API key. Check your credentials in Settings → Notor.",
					"openai",
					"AUTH_FAILED"
				);
			}
			throw new ProviderError(
				`Failed to list OpenAI models (${response.status})`,
				"openai",
				"PROVIDER_ERROR"
			);
		}

		const json = await response.json();

		// Client-side filtering: exclude embeddings, image, audio models
		const models: ModelInfo[] = (json.data ?? [])
			.filter((m: { id: string }) => isChatModel(m.id))
			.map((m: { id: string; owned_by?: string }) => ({
				id: m.id,
				display_name: m.id,
				context_window: null,
				input_price_per_1k: null,
				output_price_per_1k: null,
				provider: "openai",
			}));

		// Sort alphabetically for consistent display
		models.sort((a, b) => a.id.localeCompare(b.id));

		return models;
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