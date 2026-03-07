/**
 * Chat orchestrator — wires together the complete send/receive loop.
 *
 * Connects conversation manager, context manager, system prompt builder,
 * provider, and dispatcher into the complete message flow.
 *
 * @see specs/01-mvp/spec.md — FR-4, FR-5, FR-14
 * @see design/architecture.md — message and context management
 */

import type { App } from "obsidian";
import type { ConversationMode, Message } from "../types";
import type { ChatMessage, ToolDefinition, StreamChunk, SendMessageOptions } from "../providers/provider";
import { ProviderError } from "../providers/provider";
import type { ProviderRegistry } from "../providers/index";
import { getModelMetadata } from "../providers/model-metadata";
import { ConversationManager } from "./conversation";
import { ContextManager } from "./context";
import type { SystemPromptBuilder } from "./system-prompt";
import type { ToolDispatcher } from "./dispatcher";
import type { HistoryManager } from "./history";
import type { NotorChatView } from "../ui/chat-view";
import type { NotorSettings, ModelPricing } from "../settings";
import type { VaultRuleManager } from "../rules/vault-rules";
import { buildAutoContextBlock } from "../context/auto-context";
import { assembleUserMessage } from "../context/message-assembler";
import { logger } from "../utils/logger";

const log = logger("ChatOrchestrator");

/**
 * Orchestrates the complete chat send/receive loop.
 *
 * On user message:
 * 1. Assemble system prompt
 * 2. Append user message
 * 3. Build context window
 * 4. Send to active provider
 * 5. Stream response chunks to UI
 * 6. Parse tool calls from stream
 * 7. Route through dispatcher
 * 8. Send tool result back to LLM
 * 9. Loop until final text response
 */
export class ChatOrchestrator {
	private conversationManager: ConversationManager;
	private contextManager: ContextManager;

	constructor(
		private readonly app: App,
		private readonly providerRegistry: ProviderRegistry,
		private readonly systemPromptBuilder: SystemPromptBuilder,
		private readonly dispatcher: ToolDispatcher,
		private readonly historyManager: HistoryManager,
		private settings: NotorSettings,
		private view?: NotorChatView,
		private readonly vaultRuleManager?: VaultRuleManager
	) {
		this.conversationManager = new ConversationManager(settings.mode);
		this.contextManager = new ContextManager();

		// Wire conversation manager to history persistence
		this.conversationManager.setOnMessageAdded(async (message: Message) => {
			const conv = this.conversationManager.getActiveConversation();
			if (conv) {
				await this.historyManager.appendMessage(conv, message);
			}
		});

		this.conversationManager.setOnConversationChanged(async (conv) => {
			await this.historyManager.updateConversationHeader(conv);
		});
	}

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/** Set or update the chat view reference. */
	setView(view: NotorChatView): void {
		this.view = view;
	}

	/** Update settings reference. */
	updateSettings(settings: NotorSettings): void {
		this.settings = settings;
		this.dispatcher.setAutoApprove(settings.auto_approve);
	}

	/** Get the conversation manager. */
	getConversationManager(): ConversationManager {
		return this.conversationManager;
	}

	/** Get the context manager. */
	getContextManager(): ContextManager {
		return this.contextManager;
	}

	// -----------------------------------------------------------------------
	// Conversation lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Start a new conversation.
	 */
	async newConversation(): Promise<void> {
		const providerType = this.providerRegistry.getActiveType();
		const providerConfig = this.providerRegistry.getConfig(providerType);
		const modelId = providerConfig?.model_id ?? "";

		// Preserve the current in-session mode when creating a new conversation
		// so that toggling Plan/Act and then starting a new conversation keeps
		// the user's chosen mode. Only fall back to the saved setting when no
		// conversation has been started yet (initial load).
		const currentMode = this.conversationManager.hasActiveConversation()
			? this.conversationManager.getMode()
			: this.settings.mode;

		const conversation = this.conversationManager.createConversation(
			providerType,
			modelId,
			currentMode
		);

		await this.historyManager.createConversationFile(conversation);

		this.view?.clearMessages();
		this.view?.updateModeDisplay(conversation.mode);

		log.info("New conversation started", { id: conversation.id });
	}

	/**
	 * Switch to an existing conversation.
	 */
	async switchConversation(filename: string): Promise<void> {
		try {
			const { conversation, messages } = await this.historyManager.loadConversation(filename);
			this.conversationManager.loadConversation(conversation, messages);

			// Re-render all messages in the view
			this.view?.clearMessages();
			for (const msg of messages) {
				this.renderMessage(msg);
			}

			this.view?.updateModeDisplay(conversation.mode);

			// Update token footer
			this.view?.updateTokenFooter(
				conversation.total_input_tokens,
				conversation.total_output_tokens,
				conversation.estimated_cost
			);

			log.info("Switched to conversation", { id: conversation.id });
		} catch (e) {
			log.error("Failed to switch conversation", { filename, error: String(e) });
			this.view?.showError(`Failed to load conversation: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Send/receive loop
	// -----------------------------------------------------------------------

	/** Get the vault rule manager. */
	getVaultRuleManager(): VaultRuleManager | undefined {
		return this.vaultRuleManager;
	}

	/**
	 * Handle a user message — the main entry point for the send/receive loop.
	 *
	 * @param content - User message text
	 * @param toolDefinitions - Available tool definitions
	 */
	async handleUserMessage(
		content: string,
		toolDefinitions: ToolDefinition[]
	): Promise<void> {
		// Ensure we have an active conversation
		if (!this.conversationManager.hasActiveConversation()) {
			await this.newConversation();
		}

		const mode = this.conversationManager.getMode();

		// Phase 3 (CTX-006): Build auto-context block from enabled sources
		const autoContext = buildAutoContextBlock(this.app, this.settings);

		// Assemble the full message content: auto-context → user text
		// (attachments and hook injections will be added in later phases)
		const assembledContent = assembleUserMessage({
			autoContext: autoContext ?? undefined,
			userText: content,
		});

		// Add user message with assembled content
		const userMessage = this.conversationManager.addMessage({
			role: "user",
			content: assembledContent,
			auto_context: autoContext,
		});

		this.view?.renderUserMessage(userMessage);

		// Start the response loop (vault rules evaluated dynamically inside)
		try {
			await this.responseLoop(toolDefinitions, mode);
		} catch (e) {
			this.handleError(e);
		} finally {
			this.view?.setRespondingState(false);
		}
	}

	/**
	 * The main response loop — sends messages to the LLM and processes
	 * the response. Loops when tool calls are made.
	 *
	 * Vault rules are re-evaluated before each LLM turn so that rules
	 * triggered by notes accessed in earlier tool calls take effect
	 * on the next message sent to the LLM.
	 */
	private async responseLoop(
		toolDefinitions: ToolDefinition[],
		mode: ConversationMode
	): Promise<void> {
		let continueLoop = true;

		while (continueLoop) {
			continueLoop = false;

			// 1. Evaluate vault rules (re-evaluated each turn after tool calls)
			const vaultRuleContent = this.vaultRuleManager
				? await this.vaultRuleManager.getActiveRuleContent()
				: undefined;

			// 2. Assemble system prompt
			const systemPrompt = await this.systemPromptBuilder.assemble(
				mode,
				toolDefinitions,
				vaultRuleContent
			);

			// 3. Build messages for LLM
			const allMessages = this.conversationManager.getMessages();

			// Ensure system message is first
			const hasSystemMessage = allMessages.some((m) => m.role === "system");
			if (!hasSystemMessage) {
				// Add system message (not persisted as a separate message, just in context)
				allMessages.unshift({
					id: "system",
					conversation_id: this.conversationManager.getActiveConversation()!.id,
					role: "system",
					content: systemPrompt,
					timestamp: new Date().toISOString(),
				});
			}

			// 4. Assemble context window (truncate if needed)
			const contextResult = this.contextManager.assembleContextWindow(
				allMessages,
				this.getActiveModelId()
			);

			if (contextResult.wasTruncated) {
				this.view?.showTruncationWarning(contextResult.truncatedCount);
			}

			// 5. Convert to ChatMessage format for provider
			const chatMessages = this.toChatMessages(contextResult.messages, systemPrompt);

			// 6. Send to LLM
			this.view?.setRespondingState(true);
			const abortController = this.view?.createAbortController() ?? new AbortController();

			// Eagerly create the assistant placeholder so the DOM element exists
			// the moment we enter responding state. This ensures the element is
			// present even if the abort fires before any text_delta chunks arrive.
			const eagerContentEl = this.view?.createAssistantMessagePlaceholder();

			const provider = this.providerRegistry.getActiveProvider();
			const options: SendMessageOptions = {
				model: this.getActiveModelId(),
				abort_signal: abortController.signal,
			};

			const stream = provider.sendMessage(chatMessages, toolDefinitions, options);

			// 7. Process stream (pass in the already-created placeholder)
			const result = await this.processStream(stream, abortController, eagerContentEl);

			// 8. Handle result
			if (result.type === "text") {
				// Final text response — loop ends
				const assistantMessage = this.conversationManager.addMessage({
					role: "assistant",
					content: result.text,
					input_tokens: result.inputTokens,
					output_tokens: result.outputTokens,
					cost_estimate: this.calculateCost(result.inputTokens, result.outputTokens),
				});

				if (result.contentEl) {
					await this.view?.finalizeAssistantMessage(result.contentEl, assistantMessage);
				}

				// Update token footer
				const conv = this.conversationManager.getActiveConversation();
				if (conv) {
					this.view?.updateTokenFooter(
						conv.total_input_tokens,
						conv.total_output_tokens,
						conv.estimated_cost
					);
				}
			} else if (result.type === "tool_call") {
				// Tool call — dispatch and loop
				const toolCallMessage = this.conversationManager.addMessage({
					role: "tool_call",
					content: "",
					tool_call: {
						id: result.toolCallId,
						tool_name: result.toolName,
						parameters: result.parameters,
						status: "pending",
					},
				});

				const toolCallEl = this.view?.renderToolCall(toolCallMessage);

				// Dispatch through the tool dispatcher
				const toolResult = await this.dispatcher.dispatch(
					result.toolName,
					result.parameters,
					mode,
					toolCallMessage.id
				);

				// Propagate the provider tool call ID so the result can be correlated
				toolResult.tool_call_id = result.toolCallId;

				// Record note access for vault rule re-evaluation
				const notePath = result.parameters["path"] as string | undefined;
				if (notePath && this.vaultRuleManager) {
					this.vaultRuleManager.recordNoteAccess(notePath);
				}

				// Add tool result message
				const toolResultMessage = this.conversationManager.addMessage({
					role: "tool_result",
					content: "",
					tool_result: toolResult,
				});

				this.view?.renderToolResult(toolResultMessage);

				// Track tokens from message_end if available
				if (result.inputTokens || result.outputTokens) {
					this.conversationManager.addMessage({
						role: "assistant",
						content: result.text || "",
						input_tokens: result.inputTokens,
						output_tokens: result.outputTokens,
						cost_estimate: this.calculateCost(result.inputTokens, result.outputTokens),
					});
				}

				// Continue the loop — send tool result back to LLM
				continueLoop = true;
			} else if (result.type === "cancelled") {
				// User cancelled — always render an assistant message so the
				// .notor-message-assistant element exists in the DOM (the E2E
				// test asserts this even when the abort fires before any text
				// chunks have arrived).
				const cancelledContent = result.text
					? result.text + "\n\n*[Response cancelled]*"
					: "*[Response cancelled]*";

				const cancelledMsg = this.conversationManager.addMessage({
					role: "assistant",
					content: cancelledContent,
				});

				if (result.contentEl) {
					// We already have a streaming placeholder — finalize it
					await this.view?.finalizeAssistantMessage(result.contentEl, cancelledMsg);
				} else {
					// No placeholder yet — create one and finalize immediately
					const el = this.view?.createAssistantMessagePlaceholder();
					if (el) {
						await this.view?.finalizeAssistantMessage(el, cancelledMsg);
					}
				}
			} else if (result.type === "error") {
				const errStr = typeof result.error === "string"
					? result.error
					: (result.error as unknown) instanceof Error
						? (result.error as unknown as Error).message
						: JSON.stringify(result.error);
				this.view?.showError(errStr);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Stream processing
	// -----------------------------------------------------------------------

	/** Result type for stream processing. */
	private async processStream(
		stream: AsyncIterable<StreamChunk>,
		abortController: AbortController,
		eagerContentEl?: HTMLElement
	): Promise<StreamResult> {
		let textContent = "";
		let inputTokens = 0;
		let outputTokens = 0;
		// Use the eagerly-created placeholder if provided; first text_delta
		// will use it rather than creating a second element.
		let contentEl: HTMLElement | undefined = eagerContentEl;

		// Tool call accumulation
		let currentToolCallId = "";
		let currentToolName = "";
		let toolCallJson = "";
		let hasToolCall = false;

		try {
			for await (const chunk of stream) {
				if (abortController.signal.aborted) {
					return {
						type: "cancelled",
						text: textContent,
						inputTokens,
						outputTokens,
						contentEl,
					};
				}

				switch (chunk.type) {
					case "text_delta":
						// contentEl may already be set from the eager placeholder
						if (!contentEl) {
							contentEl = this.view?.createAssistantMessagePlaceholder();
						}
						textContent += chunk.text;
						if (contentEl) {
							this.view?.appendStreamChunk(contentEl, chunk.text);
						}
						break;

					case "tool_call_start":
						hasToolCall = true;
						currentToolCallId = chunk.id;
						currentToolName = chunk.tool_name;
						toolCallJson = "";
						// Hide loading indicator during tool call parsing
						break;

					case "tool_call_delta":
						toolCallJson += chunk.partial_json;
						break;

					case "tool_call_end":
						// Tool call complete — return for dispatch
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
							return {
								type: "error",
								error: `Failed to parse tool call parameters for ${currentToolName}`,
								text: textContent,
								inputTokens,
								outputTokens,
							};
						}

						// Continue reading to get message_end tokens
						// But return tool call for dispatch
						return {
							type: "tool_call",
							toolCallId: currentToolCallId,
							toolName: currentToolName,
							parameters,
							text: textContent,
							inputTokens,
							outputTokens,
							contentEl,
						};

					case "message_end":
						inputTokens = chunk.input_tokens;
						outputTokens = chunk.output_tokens;
						break;

					case "error":
						return {
							type: "error",
							error: chunk.error,
							text: textContent,
							inputTokens,
							outputTokens,
						};
				}
			}
		} catch (e) {
			if (abortController.signal.aborted) {
				return {
					type: "cancelled",
					text: textContent,
					inputTokens,
					outputTokens,
					contentEl,
				};
			}
			throw e;
		}

		return {
			type: "text",
			text: textContent,
			inputTokens,
			outputTokens,
			contentEl,
		};
	}

	// -----------------------------------------------------------------------
	// Message conversion
	// -----------------------------------------------------------------------

	/**
	 * Convert internal Message objects to ChatMessage format for the provider.
	 */
	private toChatMessages(messages: Message[], systemPrompt: string): ChatMessage[] {
		const chatMessages: ChatMessage[] = [];

		for (const msg of messages) {
			switch (msg.role) {
				case "system":
					chatMessages.push({
						role: "system",
						content: systemPrompt,
					});
					break;

				case "user":
					chatMessages.push({
						role: "user",
						content: msg.content,
					});
					break;

				case "assistant":
					chatMessages.push({
						role: "assistant",
						content: msg.content,
					});
					break;

				case "tool_call":
					if (msg.tool_call) {
						chatMessages.push({
							role: "tool_call",
							content: "",
							tool_call: {
								// Use the provider-assigned ID (e.g., Bedrock toolUseId) when
								// available; fall back to the message UUID for other providers.
								id: msg.tool_call.id ?? msg.id,
								tool_name: msg.tool_call.tool_name,
								parameters: msg.tool_call.parameters,
							},
						});
					}
					break;

				case "tool_result":
					if (msg.tool_result) {
						const resultStr = typeof msg.tool_result.result === "string"
							? msg.tool_result.result
							: JSON.stringify(msg.tool_result.result);

						chatMessages.push({
							role: "tool_result",
							content: "",
							tool_result: {
								// Must match the tool_call.id used above for the same call.
								tool_call_id: msg.tool_result.tool_call_id ?? msg.id,
								tool_name: msg.tool_result.tool_name,
								result: resultStr,
								is_error: !msg.tool_result.success,
							},
						});
					}
					break;
			}
		}

		return chatMessages;
	}

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	private handleError(e: unknown): void {
		if (e instanceof ProviderError) {
			let suggestion = "";
			switch (e.code) {
				case "AUTH_FAILED":
					suggestion = " Check your API key or credentials in Settings → Notor.";
					break;
				case "CONNECTION_FAILED":
					suggestion = " Check that your provider is running and accessible.";
					break;
				case "RATE_LIMITED":
					suggestion = " Wait a moment and try again.";
					break;
				case "CONTEXT_LENGTH_EXCEEDED":
					suggestion = " Try starting a new conversation or reducing message length.";
					break;
				default:
					suggestion = "";
			}

			this.view?.showError(`${e.message}${suggestion}`);
			log.error("Provider error", {
				provider: e.provider,
				code: e.code,
				message: e.message,
			});
		} else {
			const message = e instanceof Error ? e.message : String(e);
			this.view?.showError(`An error occurred: ${message}`);
			log.error("Unexpected error in chat loop", { error: message });
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private getActiveModelId(): string {
		const providerType = this.providerRegistry.getActiveType();
		const config = this.providerRegistry.getConfig(providerType);
		return config?.model_id ?? "";
	}

	private calculateCost(inputTokens: number, outputTokens: number): number | null {
		const modelId = this.getActiveModelId();

		// Check user-configured pricing first
		const userPricing = this.settings.model_pricing[modelId] as ModelPricing | undefined;
		if (userPricing) {
			return (
				(inputTokens / 1000) * userPricing.input +
				(outputTokens / 1000) * userPricing.output
			);
		}

		// Fall back to static metadata pricing
		const metadata = getModelMetadata(modelId);
		if (metadata?.input_price_per_1k != null && metadata?.output_price_per_1k != null) {
			return (
				(inputTokens / 1000) * metadata.input_price_per_1k +
				(outputTokens / 1000) * metadata.output_price_per_1k
			);
		}

		return null;
	}

	/**
	 * Render a message in the view based on its role.
	 */
	private renderMessage(message: Message): void {
		switch (message.role) {
			case "user":
				this.view?.renderUserMessage(message);
				break;
			case "assistant": {
				const el = this.view?.createAssistantMessagePlaceholder();
				if (el) {
					this.view?.finalizeAssistantMessage(el, message);
				}
				break;
			}
			case "tool_call":
				this.view?.renderToolCall(message);
				break;
			case "tool_result":
				this.view?.renderToolResult(message);
				break;
			// system messages are not rendered
		}
	}
}

/** Internal result type for stream processing. */
type StreamResult =
	| { type: "text"; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "tool_call"; toolCallId: string; toolName: string; parameters: Record<string, unknown>; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "cancelled"; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "error"; error: string; text: string; inputTokens: number; outputTokens: number };
