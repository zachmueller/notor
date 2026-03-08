/**
 * Chat orchestrator — wires together the complete send/receive loop.
 *
 * Connects conversation manager, context manager, system prompt builder,
 * provider, and dispatcher into the complete message flow.
 *
 * @see specs/01-mvp/spec.md — FR-4, FR-5, FR-14
 * @see design/architecture.md — message and context management
 */

import { type App, Notice } from "obsidian";
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
import type { PersonaManager } from "../personas/persona-manager";
import { buildAutoContextBlock } from "../context/auto-context";
import { assembleUserMessage } from "../context/message-assembler";
import type { Attachment } from "../context/attachment";
import { resolveAttachment, buildAttachmentsBlock } from "../context/attachment";
import { dispatchPreSend, dispatchAfterCompletion } from "../hooks/hook-events";
import { shouldCompact, performCompaction, estimateConversationTokens } from "../context/compaction";
import type { CompactionRecord } from "../context/compaction";
import { showCompactingIndicator, showCompactionMarker } from "../ui/compaction-marker";
import { revertWorkflowPersona, switchWorkflowPersona, assembleWorkflowPrompt } from "../workflows/workflow-executor";
import type { Workflow } from "../types";
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

	/** Persona manager for active persona state (Phase 4, A-013). */
	private personaManager?: PersonaManager;

	/**
	 * Tracks whether the currently active conversation is a workflow conversation
	 * that performed a persona switch (E-008). When non-null, leaving this
	 * conversation triggers a persona revert via `revertWorkflowPersona()`.
	 *
	 * Stores the persona name that was active *before* the workflow switched it,
	 * or `null` if no persona was active before (i.e., the workflow activated a
	 * persona from global defaults).
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-008
	 */
	private workflowPreviousPersona: string | null | undefined = undefined;

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

		// B-007: Propagate persona auto-approve config so Settings UI
		// changes take effect on the next dispatch without plugin reload.
		this.dispatcher.setPersonaAutoApprove(settings.persona_auto_approve);
	}

	/** Get the conversation manager. */
	getConversationManager(): ConversationManager {
		return this.conversationManager;
	}

	/** Get the context manager. */
	getContextManager(): ContextManager {
		return this.contextManager;
	}

	/**
	 * Set the persona manager reference.
	 *
	 * The orchestrator queries the persona manager for the active persona
	 * before each LLM call and passes it to the system prompt builder.
	 *
	 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-013
	 */
	setPersonaManager(manager: PersonaManager): void {
		this.personaManager = manager;
	}

	/**
	 * Record that the current conversation performed a workflow persona switch.
	 *
	 * Called by the workflow execution path (E-013/E-015) immediately after
	 * `switchWorkflowPersona()` succeeds. The stored `previousPersona` value
	 * is used by `newConversation()` and `switchConversation()` to revert the
	 * persona when the user leaves this conversation (E-008).
	 *
	 * Pass `undefined` to clear the revert state (e.g., when no persona was
	 * switched, or after a revert has been performed).
	 *
	 * @param previousPersona - The persona name that was active before the
	 *   workflow switched it, `null` if no persona was active, or `undefined`
	 *   to clear/disable the revert.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-008
	 */
	setWorkflowPersonaRevert(previousPersona: string | null | undefined): void {
		this.workflowPreviousPersona = previousPersona;
		log.debug("Workflow persona revert state set", { previousPersona });
	}

	// -----------------------------------------------------------------------
	// Conversation lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Start a new conversation.
	 *
	 * If the current conversation was a workflow conversation that performed
	 * a persona switch (E-008), the persona is reverted before creating the
	 * new conversation.
	 */
	async newConversation(): Promise<void> {
		// E-008: Revert workflow persona before leaving this conversation
		await this.maybeRevertWorkflowPersona();

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
	 *
	 * If the current conversation was a workflow conversation that performed
	 * a persona switch (E-008), the persona is reverted before switching.
	 */
	async switchConversation(filename: string): Promise<void> {
		// E-008: Revert workflow persona before leaving this conversation
		await this.maybeRevertWorkflowPersona();

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

	/**
	 * Revert the workflow persona if the current conversation had one active.
	 *
	 * Checks `workflowPreviousPersona` — if set (not `undefined`), calls
	 * `revertWorkflowPersona()` and clears the state. A value of `null` means
	 * "the workflow activated a persona from global defaults; deactivate on
	 * revert". A value of `undefined` means "no workflow persona was switched".
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-008
	 */
	private async maybeRevertWorkflowPersona(): Promise<void> {
		if (this.workflowPreviousPersona === undefined || !this.personaManager) {
			return;
		}

		const previousPersona = this.workflowPreviousPersona;
		// Clear state first so a revert error doesn't leave us in a loop
		this.workflowPreviousPersona = undefined;

		try {
			await revertWorkflowPersona(previousPersona, this.personaManager);
		} catch (e) {
			log.error("Failed to revert workflow persona", { error: String(e) });
		}
	}

	// -----------------------------------------------------------------------
	// Workflow execution (E-013)
	// -----------------------------------------------------------------------

	/**
	 * Execute a workflow: assemble the prompt, switch persona, create a new
	 * conversation, add the assembled message, and start the LLM response loop.
	 *
	 * This is the convergence point for both command-palette and slash-command
	 * workflow triggers. Both paths produce a `Workflow` + optional
	 * supplementary text, which are passed here.
	 *
	 * Execution sequence:
	 * 1. Revert any existing workflow persona (leaving the previous conversation)
	 * 2. Switch to workflow persona if `workflow.persona_name` is set (E-007)
	 * 3. Assemble the workflow prompt via `assembleWorkflowPrompt()` (E-006)
	 * 4. If assembly returns null (empty guard), surface notice and abort
	 * 5. Create a new conversation with workflow metadata
	 * 6. Open the chat panel if not already visible
	 * 7. Store persona revert state (E-008)
	 * 8. Add the assembled message as the first user message (`is_workflow_message: true`)
	 * 9. Dispatch to the LLM via `responseLoop()`
	 *
	 * @param workflow - The discovered workflow to execute.
	 * @param supplementaryText - Optional user text from the slash-command input.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-013
	 */
	async executeWorkflow(workflow: Workflow, supplementaryText = ""): Promise<void> {
		log.info("Executing workflow", {
			display_name: workflow.display_name,
			file_path: workflow.file_path,
			persona_name: workflow.persona_name,
		});

		// Step 2: Switch persona if the workflow specifies one
		let personaSwitchResult: { switched: boolean; previousPersona: string | null } = {
			switched: false,
			previousPersona: null,
		};

		if (workflow.persona_name && this.personaManager) {
			try {
				personaSwitchResult = await switchWorkflowPersona(
					workflow.persona_name,
					this.personaManager
				);
			} catch (e) {
				log.error("Persona switch failed before workflow execution", {
					personaName: workflow.persona_name,
					error: String(e),
				});
				// Non-fatal — continue with current persona
			}
		}

		// Step 3: Assemble the workflow prompt
		let assemblyResult;
		try {
			assemblyResult = await assembleWorkflowPrompt(
				{
					workflow,
					supplementaryText: supplementaryText || null,
					triggerContext: null, // manual execution — no trigger context
				},
				this.app.vault,
				this.app.metadataCache
			);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Workflow prompt assembly failed", { error: errMsg });
			new Notice(`Workflow execution failed: ${errMsg}`);
			// Revert persona if we switched it
			if (personaSwitchResult.switched && this.personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, this.personaManager);
			}
			return;
		}

		// Step 4: Empty guard — assembleWorkflowPrompt returns null and surfaces Notice itself
		if (assemblyResult === null) {
			// Revert persona if we switched it
			if (personaSwitchResult.switched && this.personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, this.personaManager);
			}
			return;
		}

		// Step 5: Create a new conversation with workflow metadata
		// (This also calls maybeRevertWorkflowPersona for the *previous* conversation
		// via the E-008 path — we intentionally skip that here because we already
		// handled persona switching above before creating the new conversation.)
		const providerType = this.providerRegistry.getActiveType();
		const providerConfig = this.providerRegistry.getConfig(providerType);
		const modelId = providerConfig?.model_id ?? "";
		const currentMode = this.conversationManager.hasActiveConversation()
			? this.conversationManager.getMode()
			: this.settings.mode;

		// Determine the active persona name after any switch
		const activePersonaName = this.personaManager?.getActivePersona()?.name ?? null;

		const conversation = this.conversationManager.createConversation(
			providerType,
			modelId,
			currentMode,
			{
				workflow_path: workflow.file_path,
				workflow_name: workflow.display_name,
				persona_name: activePersonaName,
				is_background: false,
				title: `Workflow: ${workflow.display_name}`,
			}
		);

		await this.historyManager.createConversationFile(conversation);

		this.view?.clearMessages();
		this.view?.updateModeDisplay(conversation.mode);

		// Step 7: Store persona revert state for E-008
		if (personaSwitchResult.switched) {
			this.setWorkflowPersonaRevert(personaSwitchResult.previousPersona);
		} else {
			// No switch performed — clear any stale revert state from a previous workflow
			this.workflowPreviousPersona = undefined;
		}

		// Step 8: Add the assembled message as the first user message
		const userMessage = this.conversationManager.addMessage({
			role: "user",
			content: assemblyResult.assembledMessage,
			is_workflow_message: true,
		});

		this.view?.renderUserMessage(userMessage);

		log.info("Workflow conversation created", {
			conversation_id: conversation.id,
			workflow_name: workflow.display_name,
			assembled_length: assemblyResult.assembledMessage.length,
		});

		// Step 9: Start the response loop
		try {
			const toolDefinitions = this.getToolDefinitionsCallback?.() ?? [];
			await this.responseLoop(toolDefinitions, currentMode);
		} catch (e) {
			this.handleError(e);
		} finally {
			this.view?.setRespondingState(false);
		}
	}

	/**
	 * Callback that provides tool definitions for the response loop.
	 *
	 * Set by main.ts via `setGetToolDefinitions()` so `executeWorkflow()`
	 * can call `responseLoop()` without direct access to the tool registry.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-015
	 */
	private getToolDefinitionsCallback?: () => import("../providers/provider").ToolDefinition[];

	/**
	 * Set the callback that provides tool definitions for the response loop.
	 *
	 * Called by main.ts during view wiring so `executeWorkflow()` can start
	 * the response loop without a direct reference to the tool registry.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-015
	 */
	setGetToolDefinitions(callback: () => import("../providers/provider").ToolDefinition[]): void {
		this.getToolDefinitionsCallback = callback;
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
		toolDefinitions: ToolDefinition[],
		attachments?: Attachment[]
	): Promise<void> {
		// Ensure we have an active conversation
		if (!this.conversationManager.hasActiveConversation()) {
			await this.newConversation();
		}

		const mode = this.conversationManager.getMode();

		// Phase 3 (ATT-008): Resolve attachments and build XML block
		let attachmentsBlock: string | null = null;
		const resolvedAttachments: Attachment[] = [];

		if (attachments && attachments.length > 0) {
			for (const att of attachments) {
				const resolved = await resolveAttachment(this.app, att);
				resolvedAttachments.push(resolved);

				// Surface inline warnings for failed resolutions
				if (resolved.status === "error" && resolved.error_message) {
					this.view?.showError(`Attachment warning: ${resolved.error_message}`);
					log.warn("Attachment resolution failed", {
						path: resolved.path,
						error: resolved.error_message,
					});
				}
			}

			attachmentsBlock = buildAttachmentsBlock(resolvedAttachments);
		}

		// Phase 3 (HOOK-004): Dispatch pre-send hooks and capture stdout
		let hookInjections: string[] | undefined;
		const conv = this.conversationManager.getActiveConversation();
		if (conv) {
			const vaultRootPath = this.getVaultRootPath();
			if (vaultRootPath) {
				hookInjections = await dispatchPreSend(
					{
						conversationId: conv.id,
						timestamp: new Date().toISOString(),
					},
					this.settings,
					vaultRootPath
				);
				// Filter empty results
				if (hookInjections && hookInjections.length === 0) {
					hookInjections = undefined;
				}
			}
		}

		// Assemble the user message content: attachments → user text
		// (Auto-context is now injected into the system prompt per ACI-001;
		//  hook output is sent as a separate message per ACI-002.)
		const assembledContent = assembleUserMessage({
			attachments: attachmentsBlock ?? undefined,
			userText: content,
		});

		// Build attachment metadata for JSONL logging (no content, just metadata)
		const attachmentMetadata = resolvedAttachments.length > 0
			? resolvedAttachments.map((a) => ({
				id: a.id,
				type: a.type,
				path: a.path,
				section: a.section,
				display_name: a.display_name,
				content_length: a.content_length,
				status: a.status,
			}))
			: undefined;

		// ACI-002: If hooks produced output, inject it as a separate user
		// message so the LLM still sees it but it renders as a collapsible
		// element in the chat panel instead of inline in the user's bubble.
		if (hookInjections && hookInjections.length > 0) {
			const filtered = hookInjections.filter((s) => s.length > 0);
			if (filtered.length > 0) {
				const hookContent = filtered.join("\n");
				const hookMessage = this.conversationManager.addMessage({
					role: "user",
					content: hookContent,
					is_hook_injection: true,
					hook_injections: hookInjections,
				});
				this.view?.renderHookInjection(hookMessage);
			}
		}

		// Add user message with assembled content (no auto-context, no hooks)
		const userMessage = this.conversationManager.addMessage({
			role: "user",
			content: assembledContent,
			attachments: attachmentMetadata,
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
		const vaultRootPath = this.getVaultRootPath();

		try {
			while (continueLoop) {
				continueLoop = false;

				// 0. Phase 3 (COMP-005): Check compaction threshold before each LLM call
				await this.checkAndPerformCompaction();

				// 1. Evaluate vault rules (re-evaluated each turn after tool calls)
				const vaultRuleContent = this.vaultRuleManager
					? await this.vaultRuleManager.getActiveRuleContent()
					: undefined;

				// 1b. ACI-001: Build fresh auto-context before each LLM call
				// so open-notes and vault structure reflect the latest state.
				const autoContext = buildAutoContextBlock(this.app, this.settings);

				// 2. Assemble system prompt (now includes auto-context and active persona)
				const activePersona = this.personaManager?.getActivePersona() ?? null;
				const systemPrompt = await this.systemPromptBuilder.assemble(
					mode,
					toolDefinitions,
					vaultRuleContent,
					autoContext ?? undefined,
					activePersona
				);

				// Emit assembled system prompt as a structured log so E2E tests
				// can verify auto-context is present in the system prompt (ACI-TEST-001).
				log.debug("System prompt assembled", { systemPrompt });

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

					// Phase 3 (HOOK-005): Fire on_tool_call hooks after approval, before execution
					const currentConv = this.conversationManager.getActiveConversation();
					if (currentConv && vaultRootPath) {
						const { dispatchOnToolCall } = await import("../hooks/hook-events");
						dispatchOnToolCall(
							{
								conversationId: currentConv.id,
								timestamp: new Date().toISOString(),
								toolName: result.toolName,
								toolParams: result.parameters,
							},
							this.settings,
							vaultRootPath
						);
					}

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

					// Phase 3 (HOOK-005): Fire on_tool_result hooks after execution
					const convForToolResult = this.conversationManager.getActiveConversation();
					if (convForToolResult && vaultRootPath) {
						const { dispatchOnToolResult } = await import("../hooks/hook-events");
						const toolResultStr = typeof toolResult.result === "string"
							? toolResult.result
							: JSON.stringify(toolResult.result);
						dispatchOnToolResult(
							{
								conversationId: convForToolResult.id,
								timestamp: new Date().toISOString(),
								toolName: result.toolName,
								toolParams: result.parameters,
								toolResult: toolResultStr,
								toolStatus: toolResult.success ? "success" : "error",
							},
							this.settings,
							vaultRootPath
						);
					}

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
		} finally {
			// Phase 3 (HOOK-005): Fire after_completion hooks when response loop ends.
			// The finally block ensures hooks fire even when a provider exception
			// escapes the loop. Hooks are fire-and-forget so they never suppress errors.
			this.dispatchAfterCompletionHooks();
		}
	}

	/**
	 * Dispatch after_completion hooks. Called from responseLoopWithHooks so the
	 * hooks always fire regardless of how the loop terminates.
	 */
	private dispatchAfterCompletionHooks(): void {
		const convForCompletion = this.conversationManager.getActiveConversation();
		const vaultRootPath = this.getVaultRootPath();
		if (convForCompletion && vaultRootPath) {
			dispatchAfterCompletion(
				{
					conversationId: convForCompletion.id,
					timestamp: new Date().toISOString(),
				},
				this.settings,
				vaultRootPath
			);
		}
	}

	// -----------------------------------------------------------------------
	// Compaction (COMP-005)
	// -----------------------------------------------------------------------

	/**
	 * Check compaction threshold and perform compaction if needed.
	 *
	 * Called before every LLM API call (user messages and tool-result round-trips).
	 * When threshold is crossed, sends conversation to LLM for summarization,
	 * constructs new context window, and logs the compaction record.
	 */
	private async checkAndPerformCompaction(): Promise<void> {
		const conv = this.conversationManager.getActiveConversation();
		if (!conv) return;

		const messages = this.conversationManager.getMessages();
		const modelId = this.getActiveModelId();

		if (!shouldCompact(messages, this.settings, modelId)) {
			return;
		}

		// Show compacting indicator in chat UI
		const messagesContainer = this.view?.getMessagesContainer?.();
		let indicator: HTMLElement | null = null;
		if (messagesContainer) {
			indicator = showCompactingIndicator(messagesContainer);
		}

		log.info("Auto-compaction triggered", {
			conversationId: conv.id,
			messageCount: messages.length,
		});

		try {
			const provider = this.providerRegistry.getActiveProvider();
			const result = await performCompaction(
				messages,
				provider,
				this.settings,
				modelId,
				conv.id,
				"automatic"
			);

			if (result.success && result.newMessages && result.record) {
				// Replace conversation messages with compacted context
				this.conversationManager.replaceMessages(result.newMessages);

				// Log compaction record to JSONL
				await this.historyManager.appendMessage(conv, {
					id: result.record.id,
					conversation_id: conv.id,
					role: "system",
					content: JSON.stringify(result.record),
					timestamp: result.record.timestamp,
				} as Message);

				// Show permanent marker
				if (messagesContainer) {
					showCompactionMarker(
						messagesContainer,
						indicator,
						result.record.timestamp,
						result.record.token_count_at_compaction
					);
				} else {
					indicator?.remove();
				}

				new Notice("Context compacted successfully");
				log.info("Auto-compaction complete", {
					conversationId: conv.id,
					summaryTokens: result.summaryTokens,
				});
			} else {
				// Compaction failed — fall back to existing truncation
				indicator?.remove();
				const errMsg = result.error ?? "Unknown compaction error";
				log.warn("Compaction failed, falling back to truncation", { error: errMsg });
				new Notice(`Context compaction failed: ${errMsg}. Falling back to truncation.`);
			}
		} catch (e) {
			indicator?.remove();
			const errorMsg = e instanceof Error ? e.message : String(e);
			log.error("Compaction error", { error: errorMsg });
			new Notice(`Context compaction error: ${errorMsg}`);
		}
	}

	/**
	 * Manually trigger context compaction.
	 *
	 * Registered as the "Notor: Compact context" command.
	 */
	async manualCompaction(): Promise<void> {
		const conv = this.conversationManager.getActiveConversation();
		if (!conv) {
			new Notice("No active conversation to compact.");
			return;
		}

		const messages = this.conversationManager.getMessages();
		if (messages.length < 2) {
			new Notice("Conversation is too short to compact.");
			return;
		}

		const modelId = this.getActiveModelId();

		// Show compacting indicator
		const messagesContainer = this.view?.getMessagesContainer?.();
		let indicator: HTMLElement | null = null;
		if (messagesContainer) {
			indicator = showCompactingIndicator(messagesContainer);
		}

		try {
			const provider = this.providerRegistry.getActiveProvider();
			const result = await performCompaction(
				messages,
				provider,
				this.settings,
				modelId,
				conv.id,
				"manual"
			);

			if (result.success && result.newMessages && result.record) {
				this.conversationManager.replaceMessages(result.newMessages);

				await this.historyManager.appendMessage(conv, {
					id: result.record.id,
					conversation_id: conv.id,
					role: "system",
					content: JSON.stringify(result.record),
					timestamp: result.record.timestamp,
				} as Message);

				if (messagesContainer) {
					showCompactionMarker(
						messagesContainer,
						indicator,
						result.record.timestamp,
						result.record.token_count_at_compaction
					);
				} else {
					indicator?.remove();
				}

				new Notice("Context compacted successfully");
			} else {
				indicator?.remove();
				new Notice(`Compaction failed: ${result.error ?? "Unknown error"}`);
			}
		} catch (e) {
			indicator?.remove();
			const errorMsg = e instanceof Error ? e.message : String(e);
			new Notice(`Compaction error: ${errorMsg}`);
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

	/** Get the vault root absolute path (Electron-specific). */
	getVaultRootPath(): string | undefined {
		const adapter = this.app.vault.adapter as { basePath?: string };
		return adapter.basePath;
	}

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
