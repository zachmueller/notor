/**
 * Local OpenAI-compatible LLM provider.
 *
 * Connects to locally-hosted LLMs via OpenAI-compatible API (Ollama,
 * LM Studio, etc.). Default endpoint: http://localhost:11434/v1
 *
 * Uses standard fetch API for HTTP requests. SSE stream parsing for
 * streaming responses.
 *
 * @see specs/01-mvp/contracts/llm-provider.md — Local OpenAI-Compatible mapping
 * @see design/research/llm-model-list-apis.md — Section 4
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
import { getSecret } from "../utils/secrets";
import { SECRET_IDS } from "../utils/secrets";
import { estimateTokenCount } from "../utils/tokens";
import { logger } from "../utils/logger";

const log = logger("LocalProvider");

/** Default endpoint for Ollama's OpenAI-compatible API. */
const DEFAULT_ENDPOINT = "http://localhost:11434/v1";

/** Timeout in ms for connection validation requests. */
const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Perform a fetch with an optional timeout (for connection testing).
 * The abort_signal from the caller takes precedence; timeout is additional.
 */
async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number
): Promise<Response> {
	const timeoutController = new AbortController();
	const timer = window.setTimeout(() => timeoutController.abort(), timeoutMs);

	// Combine caller's signal with the timeout signal if both present
	const combinedSignal = init.signal
		? anySignal([init.signal as AbortSignal, timeoutController.signal])
		: timeoutController.signal;

	try {
		return await fetch(url, { ...init, signal: combinedSignal });
	} finally {
		clearTimeout(timer);
	}
}

/** Returns an AbortSignal that aborts when any of the given signals abort. */
function anySignal(signals: AbortSignal[]): AbortSignal {
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort();
			return controller.signal;
		}
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	return controller.signal;
}

/**
 * Convert Notor ChatMessages to OpenAI API message format.
 *
 * Maps tool_call/tool_result roles to the OpenAI function calling format.
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
 * Local OpenAI-compatible provider implementation.
 *
 * Works with any server implementing the OpenAI chat completions API:
 * Ollama, LM Studio, vLLM, LocalAI, etc.
 */
export class LocalProvider implements LLMProvider {
	private readonly endpoint: string;
	private readonly app: App;
	private readonly apiKeyId: string | undefined;

	constructor(config: LLMProviderConfig, app: App) {
		this.endpoint = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
		this.app = app;
		this.apiKeyId = undefined; // Local providers typically don't need auth
	}

	async *sendMessage(
		messages: ChatMessage[],
		tools: ToolDefinition[],
		options: SendMessageOptions
	): AsyncIterable<StreamChunk> {
		const url = `${this.endpoint}/chat/completions`;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		// Optional API key for local servers that require auth
		const apiKey = getSecret(this.app, SECRET_IDS.LOCAL_API_KEY);
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

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
				headers,
				body: JSON.stringify(body),
				signal: options.abort_signal,
			});
		} catch (e: unknown) {
			if (e instanceof DOMException && e.name === "AbortError") {
				return; // User cancellation — terminate cleanly
			}
			const message =
				e instanceof TypeError && String(e).includes("fetch")
					? `Could not connect to local LLM at ${this.endpoint}. Is the server running?`
					: `Connection failed: ${String(e)}`;
			throw new ProviderError(message, "local", "CONNECTION_FAILED", e instanceof Error ? e : undefined);
		}

		if (!response.ok) {
			const errorText = await response.text().catch(() => "Unknown error");
			if (response.status === 401 || response.status === 403) {
				throw new ProviderError(
					`Authentication failed for local LLM at ${this.endpoint}. Check your API key.`,
					"local",
					"AUTH_FAILED"
				);
			}
			if (response.status === 404) {
				throw new ProviderError(
					`Model not found. The model may not be available on your local server.`,
					"local",
					"MODEL_NOT_FOUND"
				);
			}
			if (response.status === 429) {
				throw new ProviderError(
					`Rate limited by local LLM server.`,
					"local",
					"RATE_LIMITED"
				);
			}
			throw new ProviderError(
				`Local LLM error (${response.status}): ${errorText}`,
				"local",
				"PROVIDER_ERROR"
			);
		}

		if (!response.body) {
			throw new ProviderError(
				"No response body from local LLM",
				"local",
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
							// New tool call starting
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
							// Delta for existing tool call
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
					// Emit tool_call_end for any active tool calls
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
		const url = `${this.endpoint}/models`;
		const headers: Record<string, string> = {};

		const apiKey = getSecret(this.app, SECRET_IDS.LOCAL_API_KEY);
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		let response: Response;
		try {
			response = await fetch(url, { headers });
		} catch (e: unknown) {
			throw new ProviderError(
				`Could not connect to local LLM at ${this.endpoint}. Is the server running?`,
				"local",
				"CONNECTION_FAILED",
				e instanceof Error ? e : undefined
			);
		}

		if (!response.ok) {
			throw new ProviderError(
				`Failed to list models from local LLM (${response.status})`,
				"local",
				"PROVIDER_ERROR"
			);
		}

		const json = await response.json();
		const models: ModelInfo[] = (json.data ?? []).map(
			(m: { id: string; owned_by?: string }) => ({
				id: m.id,
				display_name: m.id,
				context_window: null,
				input_price_per_1k: null,
				output_price_per_1k: null,
				provider: "local",
			})
		);

		return models;
	}

	getTokenCount(text: string): number {
		return estimateTokenCount(text);
	}

	supportsStreaming(): boolean {
		return true;
	}

	async validateConnection(): Promise<boolean> {
		// Test connectivity by fetching the models endpoint with a timeout
		const url = `${this.endpoint}/models`;
		const headers: Record<string, string> = {};

		const apiKey = getSecret(this.app, SECRET_IDS.LOCAL_API_KEY);
		if (apiKey) {
			headers["Authorization"] = `Bearer ${apiKey}`;
		}

		let response: Response;
		try {
			response = await fetchWithTimeout(url, { headers }, VALIDATION_TIMEOUT_MS);
		} catch (e: unknown) {
			if (e instanceof DOMException && e.name === "AbortError") {
				throw new ProviderError(
					`Connection to local LLM at ${this.endpoint} timed out after ${VALIDATION_TIMEOUT_MS / 1000}s. Is the server running?`,
					"local",
					"CONNECTION_FAILED"
				);
			}
			throw new ProviderError(
				`Could not connect to local LLM at ${this.endpoint}. Is the server running?`,
				"local",
				"CONNECTION_FAILED",
				e instanceof Error ? e : undefined
			);
		}

		if (!response.ok) {
			throw new ProviderError(
				`Local LLM returned status ${response.status}. Check endpoint and server configuration.`,
				"local",
				"PROVIDER_ERROR"
			);
		}

		return true;
	}
}