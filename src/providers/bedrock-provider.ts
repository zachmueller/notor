/**
 * AWS Bedrock provider.
 *
 * Implements the LLMProvider interface using AWS SDK v3. Uses the
 * Bedrock Converse API for message sending and ListFoundationModels
 * for model discovery.
 *
 * Supports two auth methods:
 * - Named profile: fromIni({ profile }) — uses ~/.aws/config + credentials
 * - Direct keys: static credentials from secrets manager
 *
 * This module is lazy-loaded (not imported until Bedrock is selected)
 * to minimize startup bundle impact.
 *
 * @see specs/01-mvp/contracts/llm-provider.md — AWS Bedrock mapping
 * @see design/research/llm-model-list-apis.md — Section 3
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
import { getSecret, SECRET_IDS } from "../utils/secrets";
import { estimateTokenCount } from "../utils/tokens";
import { logger } from "../utils/logger";

// AWS SDK imports — these are bundled by esbuild
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
	ConversationRole,
	ConverseStreamCommandInput,
	ConverseStreamOutput,
	Message as BedrockMessage,
	SystemContentBlock,
	Tool,
} from "@aws-sdk/client-bedrock-runtime";
import {
	BedrockClient,
	ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { fromIni } from "@aws-sdk/credential-providers";

const log = logger("BedrockProvider");

/** Default AWS region. */
const DEFAULT_REGION = "us-east-1";

/**
 * Convert Notor ChatMessages to Bedrock Converse API format.
 *
 * Bedrock Converse API has a different message structure:
 * - System messages are a separate parameter
 * - Messages alternate between user and assistant roles
 * - Tool use/results are content blocks within messages
 */
function toBedrockMessages(
	messages: ChatMessage[]
): { system: SystemContentBlock[]; messages: BedrockMessage[] } {
	const system: SystemContentBlock[] = [];
	const bedrockMessages: BedrockMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			system.push({ text: msg.content });
			continue;
		}

		if (msg.role === "tool_call" && msg.tool_call) {
			bedrockMessages.push({
				role: "assistant" as ConversationRole,
				content: [
					{
						toolUse: {
							toolUseId: msg.tool_call.id,
							name: msg.tool_call.tool_name,
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							input: msg.tool_call.parameters as any,
						},
					},
				],
			});
			continue;
		}

		if (msg.role === "tool_result" && msg.tool_result) {
			bedrockMessages.push({
				role: "user" as ConversationRole,
				content: [
					{
						toolResult: {
							toolUseId: msg.tool_result.tool_call_id,
							content: [{ text: msg.tool_result.result }],
							status: msg.tool_result.is_error ? "error" : "success",
						},
					},
				],
			});
			continue;
		}

		const role: ConversationRole =
			msg.role === "user" ? "user" : "assistant";

		bedrockMessages.push({
			role,
			content: [{ text: msg.content }],
		});
	}

	return { system, messages: bedrockMessages };
}

/**
 * Convert Notor ToolDefinitions to Bedrock tool config format.
 */
function toBedrockToolConfig(
	tools: ToolDefinition[]
): { tools: Tool[] } | undefined {
	if (tools.length === 0) return undefined;
	return {
		tools: tools.map((tool) => ({
			toolSpec: {
				name: tool.name,
				description: tool.description,
				inputSchema: {
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					json: tool.input_schema as any,
				},
			},
		})),
	};
}

/**
 * AWS Bedrock provider implementation.
 */
export class BedrockProvider implements LLMProvider {
	private readonly region: string;
	private readonly profile: string | undefined;
	private readonly authMethod: "profile" | "keys";
	private readonly app: App;
	private runtimeClient: BedrockRuntimeClient | null = null;
	private bedrockClient: BedrockClient | null = null;

	constructor(config: LLMProviderConfig, app: App) {
		this.region = config.region || DEFAULT_REGION;
		this.profile = config.aws_profile || undefined;
		this.authMethod = config.aws_auth_method || "profile";
		this.app = app;
	}

	/**
	 * Create AWS credentials based on auth method.
	 */
	private getCredentials():
		| ReturnType<typeof fromIni>
		| { accessKeyId: string; secretAccessKey: string } {
		if (this.authMethod === "keys") {
			const accessKeyId = getSecret(
				this.app,
				SECRET_IDS.BEDROCK_ACCESS_KEY_ID
			);
			const secretAccessKey = getSecret(
				this.app,
				SECRET_IDS.BEDROCK_SECRET_ACCESS_KEY
			);
			if (!accessKeyId || !secretAccessKey) {
				throw new ProviderError(
					"AWS credentials not configured. Add your access keys in Settings → Notor.",
					"bedrock",
					"AUTH_FAILED"
				);
			}
			return { accessKeyId, secretAccessKey };
		}

		// Profile-based auth
		return fromIni({ profile: this.profile || "default" });
	}

	/**
	 * Get or create the Bedrock Runtime client (for inference).
	 */
	private getRuntimeClient(): BedrockRuntimeClient {
		if (!this.runtimeClient) {
			this.runtimeClient = new BedrockRuntimeClient({
				region: this.region,
				credentials: this.getCredentials(),
			});
		}
		return this.runtimeClient;
	}

	/**
	 * Get or create the Bedrock client (for model listing).
	 */
	private getBedrockClient(): BedrockClient {
		if (!this.bedrockClient) {
			this.bedrockClient = new BedrockClient({
				region: this.region,
				credentials: this.getCredentials(),
			});
		}
		return this.bedrockClient;
	}

	/**
	 * Track which content block indices contain tool use blocks so that
	 * contentBlockStop events are only emitted as tool_call_end for tool blocks.
	 */
	private activeToolBlockIndices = new Set<number>();

	async *sendMessage(
		messages: ChatMessage[],
		tools: ToolDefinition[],
		options: SendMessageOptions
	): AsyncIterable<StreamChunk> {
		// Clear tool block index tracker for each new request
		this.activeToolBlockIndices.clear();
		const client = this.getRuntimeClient();
		const { system, messages: bedrockMessages } =
			toBedrockMessages(messages);

		const input: ConverseStreamCommandInput = {
			modelId: options.model,
			system: system.length > 0 ? system : undefined,
			messages: bedrockMessages,
			inferenceConfig: {
				...(options.max_tokens !== undefined && {
					maxTokens: options.max_tokens,
				}),
				...(options.temperature !== undefined && {
					temperature: options.temperature,
				}),
				...(options.stop_sequences !== undefined && {
					stopSequences: options.stop_sequences,
				}),
			},
		};

		const toolConfig = toBedrockToolConfig(tools);
		if (toolConfig) {
			input.toolConfig = toolConfig;
		}

		let response;
		try {
			response = await client.send(
				new ConverseStreamCommand(input)
			);
		} catch (e: unknown) {
			if (options.abort_signal?.aborted) {
				return;
			}
			// AWS SDK exceptions may have a non-string message property; safely coerce.
			const errMsg = e instanceof Error
				? (typeof e.message === "string" ? e.message : JSON.stringify(e.message))
				: (typeof e === "object" && e !== null && "message" in e)
					? String((e as { message: unknown }).message)
					: String(e);
			const errName = e instanceof Error ? e.name : (typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "");

			if (
				errName === "AccessDeniedException" ||
				errMsg.includes("not authorized") ||
				errMsg.includes("Access Denied")
			) {
				throw new ProviderError(
					"AWS Bedrock access denied. Check your IAM permissions and model access.",
					"bedrock",
					"AUTH_FAILED",
					e instanceof Error ? e : undefined
				);
			}
			if (
				errName === "ThrottlingException" ||
				errMsg.includes("rate exceeded")
			) {
				throw new ProviderError(
					"AWS Bedrock rate limited. Please wait and try again.",
					"bedrock",
					"RATE_LIMITED",
					e instanceof Error ? e : undefined
				);
			}
			if (
				errName === "ModelNotReadyException" ||
				errMsg.includes("model") && errMsg.includes("not found")
			) {
				throw new ProviderError(
					"Model not available on AWS Bedrock. Check that the model is enabled in your region.",
					"bedrock",
					"MODEL_NOT_FOUND",
					e instanceof Error ? e : undefined
				);
			}
			if (errMsg.includes("ECONNREFUSED") || errMsg.includes("network")) {
				throw new ProviderError(
					`Could not connect to AWS Bedrock in region ${this.region}: ${errMsg}`,
					"bedrock",
					"CONNECTION_FAILED",
					e instanceof Error ? e : undefined
				);
			}
			throw new ProviderError(
				`AWS Bedrock error: ${errMsg}`,
				"bedrock",
				"PROVIDER_ERROR",
				e instanceof Error ? e : undefined
			);
		}

		if (!response.stream) {
			throw new ProviderError(
				"No response stream from AWS Bedrock",
				"bedrock",
				"PROVIDER_ERROR"
			);
		}

		try {
			for await (const event of response.stream) {
				if (options.abort_signal?.aborted) {
					return;
				}
				yield* this.handleBedrockEvent(event);
			}
		} catch (e: unknown) {
			if (options.abort_signal?.aborted) {
				return;
			}
			yield {
				type: "error",
				error: e instanceof Error ? e.message : String(e),
			};
		}
	}

	/**
	 * Handle a single Bedrock Converse stream event.
	 */
	private *handleBedrockEvent(
		event: ConverseStreamOutput
	): Iterable<StreamChunk> {
		if (event.contentBlockStart) {
			const start = event.contentBlockStart.start;
			if (start?.toolUse) {
				const blockIndex = event.contentBlockStart.contentBlockIndex ?? -1;
				// Track this block as a tool-use block
				this.activeToolBlockIndices.add(blockIndex);
				yield {
					type: "tool_call_start",
					id: start.toolUse.toolUseId ?? "",
					tool_name: start.toolUse.name ?? "",
				};
			}
		}

		if (event.contentBlockDelta) {
			const delta = event.contentBlockDelta.delta;
			if (delta?.text) {
				yield { type: "text_delta", text: delta.text };
			}
			if (delta?.toolUse) {
				yield {
					type: "tool_call_delta",
					id: event.contentBlockDelta.contentBlockIndex?.toString() ?? "0",
					partial_json: delta.toolUse.input ?? "",
				};
			}
		}

		if (event.contentBlockStop) {
			const blockIndex = event.contentBlockStop.contentBlockIndex ?? -1;
			// Only emit tool_call_end for blocks that were actually tool-use blocks
			if (this.activeToolBlockIndices.has(blockIndex)) {
				this.activeToolBlockIndices.delete(blockIndex);
				yield {
					type: "tool_call_end",
					id: blockIndex.toString(),
				};
			}
		}

		if (event.metadata) {
			const usage = event.metadata.usage;
			if (usage) {
				yield {
					type: "message_end",
					input_tokens: usage.inputTokens ?? 0,
					output_tokens: usage.outputTokens ?? 0,
				};
			}
		}

		if (event.internalServerException) {
			yield {
				type: "error",
				error:
					event.internalServerException.message ??
					"Internal server error",
			};
		}

		if (event.modelStreamErrorException) {
			yield {
				type: "error",
				error:
					event.modelStreamErrorException.message ??
					"Model stream error",
			};
		}

		if (event.throttlingException) {
			yield {
				type: "error",
				error:
					event.throttlingException.message ??
					"Bedrock rate limited",
			};
		}

		if (event.validationException) {
			yield {
				type: "error",
				error:
					event.validationException.message ?? "Validation error",
			};
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		const client = this.getBedrockClient();

		let response;
		try {
			response = await client.send(
				new ListFoundationModelsCommand({
					byOutputModality: "TEXT",
					byInferenceType: "ON_DEMAND",
				})
			);
		} catch (e: unknown) {
			const errMsg = e instanceof Error ? e.message : String(e);
			const errName = e instanceof Error ? e.name : "";

			if (
				errName === "AccessDeniedException" ||
				errMsg.includes("not authorized")
			) {
				throw new ProviderError(
					"AWS Bedrock access denied. Check your IAM permissions (bedrock:ListFoundationModels).",
					"bedrock",
					"AUTH_FAILED",
					e instanceof Error ? e : undefined
				);
			}
			throw new ProviderError(
				`Failed to list Bedrock models: ${errMsg}`,
				"bedrock",
				"PROVIDER_ERROR",
				e instanceof Error ? e : undefined
			);
		}

		const models: ModelInfo[] = (response.modelSummaries ?? [])
			.filter((m) => m.modelLifecycle?.status === "ACTIVE")
			.map((m) => ({
				id: m.modelId ?? "",
				display_name: m.modelName ?? m.modelId ?? "",
				context_window: null,
				input_price_per_1k: null,
				output_price_per_1k: null,
				provider: m.providerName ?? "bedrock",
			}))
			.filter((m) => m.id !== "");

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