/**
 * AWS Bedrock provider.
 *
 * Implements the LLMProvider interface using AWS SDK v3. Uses the
 * Bedrock Converse API for message sending and ListInferenceProfiles
 * for model discovery (system-defined cross-region profiles).
 *
 * Supports two auth methods:
 * - Named profile: fromIni({ profile }) — uses ~/.aws/config + credentials
 * - Direct keys: static credentials from secrets manager
 *
 * This module is lazy-loaded (not imported until Bedrock is selected)
 * to minimize startup bundle impact.
 *
 * Required IAM permissions:
 * - bedrock:InvokeModelWithResponseStream (for sendMessage)
 * - bedrock:ListInferenceProfiles (for listModels — system-defined profiles)
 * - bedrock:ListFoundationModels (optional — adds marketplace models like Qwen, Mistral)
 *
 * @see specs/01-mvp/contracts/llm-provider.md — AWS Bedrock mapping
 * @see design/research/llm-model-list-apis.md — Section 3a (ListInferenceProfiles)
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
import { getSecret, secretIdForAccessKeyId, secretIdForSecretAccessKey } from "../utils/secrets";
import { estimateTokenCount } from "../utils/tokens";
import type { ContentBlock as MediaContentBlock } from "../media/types";
import { getModelExtendedContext, supportsThinking } from "./model-metadata";
import { parseProfileId } from "./model-grouping";
import { resolveAnthropicThinking } from "./thinking-config";
import { logger } from "../utils/logger";
import { sanitizeInputSchemaForBedrock } from "../utils/json-schema-sanitizer";

// AWS SDK imports — these are bundled by esbuild
import {
	BedrockRuntimeClient,
	ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
	ContentBlock,
	ConversationRole,
	ConverseStreamCommandInput,
	ConverseStreamCommandOutput,
	ConverseStreamOutput,
	Message as BedrockMessage,
	SystemContentBlock,
	Tool,
} from "@aws-sdk/client-bedrock-runtime";
import {
	BedrockClient,
	ListFoundationModelsCommand,
	ListInferenceProfilesCommand,
	type ListFoundationModelsResponse,
	type ListInferenceProfilesCommandOutput,
} from "@aws-sdk/client-bedrock";
import { fromIni } from "@aws-sdk/credential-providers";

const log = logger("BedrockProvider");

/** Recursive JSON document type — mirrors @smithy/types DocumentType for AWS SDK compatibility. */
type DocumentType = null | boolean | number | string | DocumentType[] | { [key: string]: DocumentType };

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
/** Map a Notor ContentBlock to Bedrock's native content block format. */
function mapToBedrockBlock(block: MediaContentBlock): ContentBlock {
	switch (block.type) {
		case "text":
			return { text: block.text } as ContentBlock;
		case "image":
			return {
				image: {
					format: block.media_type.split("/")[1] as "png" | "jpeg" | "gif" | "webp",
					source: { bytes: Buffer.from(block.data, "base64") },
				},
			} as ContentBlock;
		case "document":
			return {
				document: {
					format: "pdf" as const,
					name: block.name ?? "document.pdf",
					source: { bytes: Buffer.from(block.data, "base64") },
				},
			} as ContentBlock;
		case "custom_block":
			// custom_block is translated to wire text before reaching providers
			return { text: block.fallback_text ?? "" } as ContentBlock;
	}
}

function toBedrockMessages(
	messages: ChatMessage[]
): { system: SystemContentBlock[]; messages: BedrockMessage[] } {
	const system: SystemContentBlock[] = [];
	const bedrockMessages: BedrockMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			const text = typeof msg.content === "string"
				? msg.content
				: (() => { throw new Error("Expected string content for system message"); })();
			system.push({ text });
			continue;
		}

		if (msg.role === "tool_call" && msg.tool_calls?.length) {
			// Pre-tool-call text (if any) is included as a leading text block.
			const content: ContentBlock[] = [];
			if (msg.content) {
				content.push({ text: msg.content as string });
			}
			for (const tc of msg.tool_calls) {
				content.push({
					toolUse: {
						toolUseId: tc.id,
						name: tc.tool_name,
						input: tc.parameters as unknown as DocumentType,
					},
				});
			}
			bedrockMessages.push({
				role: "assistant" as ConversationRole,
				content,
			});
			continue;
		}

		if (msg.role === "tool_result" && msg.tool_results?.length) {
			bedrockMessages.push({
				role: "user" as ConversationRole,
				content: msg.tool_results.map((tr) => {
					const trContent: ContentBlock[] = [{ text: tr.result } as ContentBlock];
					if (tr.content_blocks?.length) {
						for (const block of tr.content_blocks) {
							trContent.push(mapToBedrockBlock(block));
						}
					}
					return {
						toolResult: {
							toolUseId: tr.tool_call_id,
							content: trContent,
							status: tr.is_error ? ("error" as const) : ("success" as const),
						},
					} as ContentBlock;
				}),
			});
			continue;
		}

		if (msg.role === "user") {
			if (Array.isArray(msg.content)) {
				bedrockMessages.push({
					role: "user" as ConversationRole,
					content: msg.content.map(mapToBedrockBlock),
				});
			} else {
				bedrockMessages.push({
					role: "user" as ConversationRole,
					content: [{ text: msg.content }],
				});
			}
		} else {
			// Assistant message — always string
			const text = typeof msg.content === "string"
				? msg.content
				: (() => { throw new Error("Expected string content for assistant message"); })();
			bedrockMessages.push({
				role: "assistant" as ConversationRole,
				content: [{ text }],
			});
		}
	}

	log.info("Bedrock messages prepared", {
		systemCount: system.length,
		messageCount: bedrockMessages.length,
		firstRole: bedrockMessages[0]?.role ?? "none",
		lastRole: bedrockMessages[bedrockMessages.length - 1]?.role ?? "none",
		roles: bedrockMessages.map((m) => m.role),
	});

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
					// Defensive guard: MCP schemas are already sanitized at
					// discovery, but this catches any schema that reaches Bedrock
					// by another path. Idempotent on already-clean schemas.
					json: sanitizeInputSchemaForBedrock(tool.input_schema)
						.schema as unknown as DocumentType,
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
	private readonly instanceId: string;
	private readonly app: App;
	private runtimeClient: BedrockRuntimeClient | null = null;
	private bedrockClient: BedrockClient | null = null;

	constructor(config: LLMProviderConfig, app: App) {
		this.region = config.region || DEFAULT_REGION;
		this.profile = config.aws_profile || undefined;
		this.authMethod = config.aws_auth_method || "profile";
		this.instanceId = config.id;
		this.app = app;
	}

	/**
	 * Clear cached AWS clients so the next request creates fresh ones
	 * with new credentials from the credential chain.
	 */
	private clearCachedClients(): void {
		this.runtimeClient = null;
		this.bedrockClient = null;
	}

	/** @inheritdoc */
	resetCredentials(): void {
		this.clearCachedClients();
	}

	/**
	 * Whether an SDK error represents expired/invalid security credentials.
	 * Centralizes the check used to trigger a transparent retry and to map the
	 * failure to a clean AUTH_FAILED message.
	 */
	private isExpiredCredentialError(e: unknown): boolean {
		const name =
			e instanceof Error
				? e.name
				: typeof e === "object" && e !== null && "name" in e
					? String((e as { name: unknown }).name)
					: "";
		if (name === "ExpiredTokenException") return true;
		const msg =
			e instanceof Error
				? e.message
				: typeof e === "object" && e !== null && "message" in e
					? String((e as { message: unknown }).message)
					: String(e);
		return msg.includes("security token") && msg.includes("expired");
	}

	/**
	 * Provider-agnostic message for expired/invalid credentials, tailored by the
	 * configured auth method (no references to any external credential tooling).
	 */
	private expiredCredentialMessage(): string {
		return this.authMethod === "keys"
			? "AWS Bedrock credentials have expired or are invalid. Update your access keys in Settings → Notor, then try again."
			: "AWS Bedrock credentials have expired. Refresh your AWS credentials for this profile, then try again.";
	}

	/**
	 * Send a command, transparently retrying once if the failure is an expired
	 * security token. Recreating the client forces the credential chain to
	 * re-resolve — profiles backed by an external credential process or SSO
	 * refresh themselves on a fresh client, so the second attempt succeeds with
	 * no user action. Static keys can't self-refresh, so the retry is skipped
	 * and the original error surfaces for the caller to translate.
	 */
	private async sendWithCredentialRetry<T>(
		getClient: () => { send: (command: unknown) => Promise<unknown> },
		makeCommand: () => unknown
	): Promise<T> {
		try {
			return (await getClient().send(makeCommand())) as T;
		} catch (e) {
			if (this.isExpiredCredentialError(e) && this.authMethod !== "keys") {
				// Drop cached clients so the next getClient() re-resolves creds.
				this.clearCachedClients();
				return (await getClient().send(makeCommand())) as T;
			}
			throw e;
		}
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
				secretIdForAccessKeyId(this.instanceId)
			);
			const secretAccessKey = getSecret(
				this.app,
				secretIdForSecretAccessKey(this.instanceId)
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

	async *sendMessage(
		messages: ChatMessage[],
		tools: ToolDefinition[],
		options: SendMessageOptions
	): AsyncIterable<StreamChunk> {
		/**
		 * Map content block index → provider toolUseId for active tool-use blocks.
		 * Used so that contentBlockStop can emit tool_call_end with the correct
		 * provider-assigned ID (required by Bedrock for toolResult correlation).
		 * Local to each sendMessage() invocation to avoid shared mutable state
		 * when multiple callers (e.g. concurrent sub-agents) use the same provider.
		 */
		const activeToolBlockIndices = new Map<number, string>();
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

		// Inject 1M context beta header when extended context is active
		if (options.use_extended_context) {
			const extCtx = getModelExtendedContext(options.model);
			if (extCtx?.beta_flag) {
				input.additionalModelRequestFields = {
					...input.additionalModelRequestFields as Record<string, DocumentType>,
					anthropic_beta: [extCtx.beta_flag],
				};
			}
		}

		// Inject thinking config for Anthropic-on-Bedrock models
		const isAnthropicModel = options.model.includes("anthropic");
		if (isAnthropicModel && supportsThinking(options.model)) {
			const resolved = resolveAnthropicThinking(options.thinking_level, options.model);
			if (resolved) {
				const thinkingConfig = resolved.thinking;
				input.additionalModelRequestFields = {
					...input.additionalModelRequestFields as Record<string, DocumentType>,
					thinking: thinkingConfig,
					// Effort models (Opus 4.8+) require output_config.effort alongside
					// thinking.type=adaptive instead of a token budget.
					...(resolved.effort && {
						output_config: { effort: resolved.effort },
					}),
				};
				// Temperature is incompatible with thinking
				if (input.inferenceConfig) {
					delete (input.inferenceConfig as Record<string, unknown>).temperature;
				}
				// maxTokens must be set and > budget_tokens for thinking to activate
				const minMaxTokens = thinkingConfig.type === "enabled"
					? Math.max(thinkingConfig.budget_tokens + 4096, 16384)
					: 16384;
				if (!input.inferenceConfig) input.inferenceConfig = {};
				const currentMax = (input.inferenceConfig as Record<string, unknown>).maxTokens as number | undefined;
				if (!currentMax || currentMax < minMaxTokens) {
					(input.inferenceConfig as Record<string, unknown>).maxTokens = minMaxTokens;
				}
			}
		}

		let response;
		try {
			response = await this.sendWithCredentialRetry<ConverseStreamCommandOutput>(
				() => this.getRuntimeClient(),
				() => new ConverseStreamCommand(input)
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
			if (
				errName === "ValidationException" &&
				errMsg.includes("invalid beta flag") &&
				options.use_extended_context
			) {
				throw new ProviderError(
					"The 1M context beta flag was rejected by Bedrock. The beta may have been updated or revoked — check for a plugin update.",
					"bedrock",
					"PROVIDER_ERROR",
					e instanceof Error ? e : undefined
				);
			}
			if (this.isExpiredCredentialError(e)) {
				this.clearCachedClients();
				throw new ProviderError(
					this.expiredCredentialMessage(),
					"bedrock",
					"AUTH_FAILED",
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
				yield* this.handleBedrockEvent(event, activeToolBlockIndices);
			}
		} catch (e: unknown) {
			if (options.abort_signal?.aborted) {
				return;
			}
			log.error("Bedrock stream error (full object for debugging)", e);
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
		event: ConverseStreamOutput,
		activeToolBlockIndices: Map<number, string>
	): Iterable<StreamChunk> {
		if (event.contentBlockStart) {
			const start = event.contentBlockStart.start;
			if (start?.toolUse) {
				const blockIndex = event.contentBlockStart.contentBlockIndex ?? -1;
				const toolUseId = start.toolUse.toolUseId ?? "";
				// Map block index → provider toolUseId so tool_call_end can emit the right ID
				activeToolBlockIndices.set(blockIndex, toolUseId);
				yield {
					type: "tool_call_start",
					id: toolUseId,
					tool_name: start.toolUse.name ?? "",
				};
			}
			// Thinking block start. Emit a lifecycle signal on the boundary even
			// when no plaintext is present (adaptive Opus 4.8 may return a signed
			// reasoning block with its text omitted). Initial content follows only
			// when the block actually carries it.
			const rawStart = start as Record<string, unknown> | undefined;
			if (rawStart?.type === "thinking" || rawStart?.type === "redacted_thinking" || rawStart?.reasoningContent) {
				yield { type: "thinking_start" };
				if (typeof rawStart.thinking === "string" && rawStart.thinking) {
					yield { type: "thinking_delta", text: rawStart.thinking };
				}
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
			// Thinking delta from Anthropic-on-Bedrock
			const rawDelta = delta as Record<string, unknown> | undefined;
			if (rawDelta) {
				// Format 1: delta.type === "thinking_delta" with delta.thinking as string
				if (rawDelta.type === "thinking_delta" && typeof rawDelta.thinking === "string") {
					yield { type: "thinking_delta", text: rawDelta.thinking };
				}
				// Format 2: delta.thinking as a string (direct thinking content)
				else if (typeof rawDelta.thinking === "string" && rawDelta.thinking) {
					yield { type: "thinking_delta", text: rawDelta.thinking };
				}
				// Format 3: delta.thinking as an object with .text
				else if (rawDelta.thinking && typeof (rawDelta.thinking as Record<string, unknown>).text === "string") {
					yield { type: "thinking_delta", text: (rawDelta.thinking as Record<string, unknown>).text as string };
				}
				// Format 4: delta.reasoningContent.text (Bedrock native format)
				else if (rawDelta.reasoningContent && typeof (rawDelta.reasoningContent as Record<string, unknown>).text === "string") {
					yield { type: "thinking_delta", text: (rawDelta.reasoningContent as Record<string, unknown>).text as string };
				}
				// Format 5: delta.reasoningContent with no plaintext (signature/redacted
				// blob from adaptive Opus 4.8). No text to render, but it confirms the
				// model reasoned — emit a boundary signal so the indicator can resolve.
				else if (rawDelta.reasoningContent) {
					yield { type: "thinking_start" };
				}
			}
		}

		if (event.contentBlockStop) {
			const blockIndex = event.contentBlockStop.contentBlockIndex ?? -1;
			// Only emit tool_call_end for blocks that were actually tool-use blocks
			const toolUseId = activeToolBlockIndices.get(blockIndex);
			if (toolUseId !== undefined) {
				activeToolBlockIndices.delete(blockIndex);
				yield {
					type: "tool_call_end",
					id: toolUseId,
				};
			}
		}

		if (event.metadata) {
			const usage = event.metadata.usage;
			log.debug("Bedrock metadata event", {
				hasUsage: !!usage,
				inputTokens: usage?.inputTokens,
				outputTokens: usage?.outputTokens,
				totalTokens: usage?.totalTokens,
			});
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

	/**
	 * Fetch a single page of inference profiles, throwing a normalized
	 * ProviderError on any SDK error.
	 */
	private async fetchInferenceProfilesPage(
		token: string | undefined
	): Promise<ListInferenceProfilesCommandOutput> {
		try {
			// BedrockClient.send() returns ServiceOutputTypes (a broad union type).
			// We cast via unknown to the concrete output type we know this command returns.
			const rawResult = await this.sendWithCredentialRetry<unknown>(
				() => this.getBedrockClient(),
				() =>
					new ListInferenceProfilesCommand({
						typeEquals: "SYSTEM_DEFINED",
						...(token ? { nextToken: token } : {}),
					})
			) as ListInferenceProfilesCommandOutput;
			return rawResult;
		} catch (e: unknown) {
			const errMsg = e instanceof Error ? e.message : String(e);
			const errName =
				e instanceof Error
					? e.name
					: typeof e === "object" && e !== null && "name" in e
						? String((e as { name: unknown }).name)
						: "";

			if (
				errName === "AccessDeniedException" ||
				errMsg.includes("not authorized") ||
				errMsg.includes("Access Denied")
			) {
				throw new ProviderError(
					"AWS Bedrock access denied. The bedrock:ListInferenceProfiles " +
						"IAM permission is required. Check your IAM policy and ensure " +
						"it includes bedrock:ListInferenceProfiles.",
					"bedrock",
					"AUTH_FAILED",
					e instanceof Error ? e : undefined
				);
			}
			if (this.isExpiredCredentialError(e)) {
				this.clearCachedClients();
				throw new ProviderError(
					this.expiredCredentialMessage(),
					"bedrock",
					"AUTH_FAILED",
					e instanceof Error ? e : undefined
				);
			}
			throw new ProviderError(
				`Failed to list Bedrock inference profiles: ${errMsg}`,
				"bedrock",
				"PROVIDER_ERROR",
				e instanceof Error ? e : undefined
			);
		}
	}

	/**
	 * Fetch all foundation models accessible via on-demand TEXT inference.
	 * Used as a supplementary query alongside ListInferenceProfiles to surface
	 * marketplace models (Qwen, Mistral, AI21, etc.) that have no system-defined
	 * inference profile. Failures are swallowed so inference profiles still work
	 * if the IAM role lacks bedrock:ListFoundationModels.
	 */
	private async fetchFoundationModels(): Promise<ListFoundationModelsResponse> {
		const client = this.getBedrockClient();
		try {
			return await client.send(
				new ListFoundationModelsCommand({
					byOutputModality: "TEXT",
					byInferenceType: "ON_DEMAND",
				})
			) as unknown as ListFoundationModelsResponse;
		} catch (e: unknown) {
			log.warn(
				"ListFoundationModels failed (supplementary query, continuing with inference profiles only):",
				e instanceof Error ? e.message : String(e)
			);
			return { modelSummaries: [] };
		}
	}

	async listModels(): Promise<ModelInfo[]> {
		/** Profile ID patterns for known non-chat providers to exclude. */
		const NON_CHAT_ID_PATTERNS = [
			/^[^.]+\.stability\./,    // Stable Diffusion image models
			/^[^.]+\.twelvelabs\./,   // Video/multimodal embedding models
			/^[^.]+\.cohere\.embed/,  // Embedding-only models
			/^amazon\.titan-embed/,   // Amazon Titan embedding models
			/^stability\./,           // Foundation model form of Stability models
			/^twelvelabs\./,          // Foundation model form
			/^cohere\.embed/,         // Foundation model form
		];

		const allProfiles: ModelInfo[] = [];
		let nextToken: string | undefined;

		do {
			const response = await this.fetchInferenceProfilesPage(nextToken);

			for (const profile of response.inferenceProfileSummaries ?? []) {
				const profileId = profile.inferenceProfileId ?? "";
				if (!profileId) continue;
				if (profile.status !== "ACTIVE") continue;
				if (NON_CHAT_ID_PATTERNS.some((p) => p.test(profileId))) continue;

				// Derive the provider display name from the profile ID segment
				// Format: {geo}.{provider}.{model-name}-{version}
				const parts = profileId.split(".");
				const providerRaw = parts.length >= 2 ? parts[1] : undefined;
				const providerSegment = providerRaw
					? providerRaw.charAt(0).toUpperCase() + providerRaw.slice(1)
					: "Bedrock";

				allProfiles.push({
					id: profileId,
					display_name: profileId,
					context_window: null,
					input_price_per_1k: null,
					output_price_per_1k: null,
					provider: providerSegment,
				});
			}

			nextToken = response.nextToken ?? undefined;
		} while (nextToken);

		// Supplement with foundation models that have no system-defined inference
		// profile (e.g. Qwen, Mistral, AI21, Writer, Jamba, Cohere Chat).
		const foundationResponse = await this.fetchFoundationModels();

		// Build a set of bare model IDs already covered by inference profiles
		// so we don't add duplicates (inference profile IDs include a geo prefix).
		const coveredBaseKeys = new Set(
			allProfiles.map((p) => {
				const { baseKey } = parseProfileId(p.id);
				return baseKey;
			})
		);

		for (const model of foundationResponse.modelSummaries ?? []) {
			const modelId = model.modelId ?? "";
			if (!modelId) continue;
			if (model.modelLifecycle?.status === "LEGACY") continue;
			if (NON_CHAT_ID_PATTERNS.some((p) => p.test(modelId))) continue;
			if (coveredBaseKeys.has(modelId)) continue;

			const providerRaw = modelId.split(".")[0];
			const providerSegment = providerRaw
				? providerRaw.charAt(0).toUpperCase() + providerRaw.slice(1)
				: "Bedrock";

			allProfiles.push({
				id: modelId,
				display_name: model.modelName ?? modelId,
				context_window: null,
				input_price_per_1k: null,
				output_price_per_1k: null,
				provider: providerSegment,
			});
		}

		return allProfiles;
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