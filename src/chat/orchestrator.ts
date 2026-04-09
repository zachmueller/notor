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
import type { Conversation, ConversationMode, Message, Persona, ToolResult, WorkflowExecution, ExecutionChain } from "../types";
import type { ChatMessage, ToolDefinition, StreamChunk, SendMessageOptions } from "../providers/provider";
import { ProviderError } from "../providers/provider";
import type { ProviderRegistry } from "../providers/index";
import { getModelMetadata } from "../providers/model-metadata";
import { ConversationManager } from "./conversation";
import { ContextManager } from "./context";
import type { SystemPromptBuilder } from "./system-prompt";
import type { ToolDispatcher } from "./dispatcher";
import { partitionToolCalls, executeToolBatches, type ToolCallInfo } from "./tool-orchestration";
import { parseStreamEvents } from "./stream-utils";
import type { HistoryManager } from "./history";
import type { NotorChatView } from "../ui/chat-view";
import type { NotorSettings, ModelPricing } from "../settings";
import type { VaultRuleManager } from "../rules/vault-rules";
import type { PersonaManager } from "../personas/persona-manager";
import { buildAutoContextBlock } from "../context/auto-context";
import { assembleUserMessage, assembleUserContent } from "../context/message-assembler";
import type { Attachment } from "../context/attachment";
import { resolveAttachment, buildAttachmentsBlock } from "../context/attachment";
import { dispatchPreSend, dispatchAfterCompletion } from "../hooks/hook-events";
import type { LifecycleAutomationAccessors, ToolEventAutomationAccessors } from "../hooks/hook-events";
import type { WorkflowHookOverrideManager } from "../hooks/workflow-hook-override";
import { shouldCompact, performCompaction } from "../context/compaction";
import { showCompactingIndicator, showCompactionMarker } from "../ui/compaction-marker";
import { revertWorkflowPersona, switchWorkflowPersona, assembleWorkflowPrompt } from "../workflows/workflow-executor";
import type { Workflow, WorkflowExecutionRequest, WorkflowAssemblyResult, VaultRule } from "../types";
import type { WorkflowConcurrencyManager } from "../workflows/workflow-concurrency";
import type { EffectiveToolConfig, ParsedToolConfig } from "../tool-config/types";
import { mergeToolConfigs } from "../tool-config/merger";
import { ConversationSession } from "./conversation-session";
import type { ApprovalCallback } from "./dispatcher";
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
	 * Workflow hook override manager — tracks per-conversation workflow-scoped
	 * hook overrides (G-003/G-005/G-006/G-007).
	 *
	 * When set, the orchestrator activates overrides before the first LLM API
	 * call in a workflow conversation and deactivates them on all exit paths.
	 */
	private workflowHookOverrideManager?: WorkflowHookOverrideManager;

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

	/**
	 * Contributing `ParsedToolConfig[]` from the current iteration's
	 * `resolveEffectiveConfig()` call. Used by the inspector to show
	 * source provenance for each tool field.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-001, ORCH-004
	 */
	private activeParsedConfigs: ParsedToolConfig[] = [];

	/**
	 * Merged effective tool config for the current iteration. Stored for
	 * inspector access and cleared on `newConversation()`.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-001, ORCH-004
	 */
	private effectiveToolConfig: EffectiveToolConfig | null = null;

	/**
	 * Active conversation sessions keyed by conversation ID.
	 *
	 * Each response loop (foreground or workflow) creates a session that
	 * isolates all per-conversation state. Sessions are removed in the
	 * response loop's finally block.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1d
	 */
	private activeSessions = new Map<string, ConversationSession>();

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
	 * Set the workflow hook override manager reference.
	 *
	 * Called by `main.ts` after the manager is instantiated so the orchestrator
	 * can activate/deactivate scoped hook overrides around workflow execution.
	 *
	 * @see specs/03-workflows-personas/tasks/group-g-tasks.md — G-005, G-006, G-007
	 */
	setWorkflowHookOverrideManager(manager: WorkflowHookOverrideManager): void {
		this.workflowHookOverrideManager = manager;
	}

	/**
	 * Extension automation accessor pair for lifecycle hooks.
	 *
	 * Stored as pre-built accessor objects so the orchestrator can pass them
	 * directly to dispatch functions without knowing about ExtensionManager.
	 *
	 * @see specs/05-user-tools/tasks.md — EXT-017
	 */
	private extensionLifecycleAccessors?: LifecycleAutomationAccessors;
	private extensionToolEventAccessors?: ToolEventAutomationAccessors;

	/**
	 * Set the extension automation accessors for lifecycle and tool event hooks.
	 *
	 * Called by `main.ts` after the ExtensionManager is created so the
	 * orchestrator can forward user automations to all dispatch call sites.
	 *
	 * @see specs/05-user-tools/tasks.md — EXT-017
	 */
	setExtensionAccessors(accessors: {
		lifecycle: LifecycleAutomationAccessors;
		toolEvent: ToolEventAutomationAccessors;
	}): void {
		this.extensionLifecycleAccessors = accessors.lifecycle;
		this.extensionToolEventAccessors = accessors.toolEvent;
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
	// Tool config inspector (ORCH-004)
	// -----------------------------------------------------------------------

	/**
	 * Get the current effective tool config (for the inspector view).
	 *
	 * Returns null when no conversation is active or no tool config has
	 * been resolved yet.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-004
	 */
	getEffectiveToolConfig(): EffectiveToolConfig | null {
		return this.effectiveToolConfig;
	}

	/**
	 * Get the parsed tool configs contributing to the current effective config.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-004
	 */
	getActiveParsedConfigs(): ParsedToolConfig[] {
		return this.activeParsedConfigs;
	}

	// -----------------------------------------------------------------------
	// Session accessors
	// -----------------------------------------------------------------------

	/**
	 * Get the active session for a given conversation ID.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1d
	 */
	getActiveSession(conversationId: string): ConversationSession | undefined {
		return this.activeSessions.get(conversationId);
	}

	/**
	 * Returns the view only if it is currently displaying this session's conversation.
	 *
	 * When the user navigates away from a streaming conversation, this returns
	 * `undefined` so all render calls become no-ops while data writes continue.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1d
	 */
	private getViewForSession(session: ConversationSession): NotorChatView | undefined {
		const displayConvId = this.conversationManager.getActiveConversation()?.id;
		return session.conversationId === displayConvId ? this.view : undefined;
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

		// Tool config state is now per-session (ConversationSession).
		// updateDisplayConfig() will set these fields when the first
		// response loop iteration runs for the new conversation.

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
			currentMode,
			providerConfig?.use_extended_context ? { use_extended_context: true } : undefined
		);

		await this.historyManager.createConversationFile(conversation);

		this.view?.clearMessages();
		this.view?.updateModeDisplay(conversation.mode);

		log.info("New conversation started", { id: conversation.id });
	}

	/**
	 * Fork the current conversation at a specific message.
	 *
	 * Creates a new conversation containing all messages up to (and including)
	 * the fork-point message, persists it, and returns the filename and
	 * conversation object. Does NOT switch to the fork — the caller (main.ts)
	 * handles post-switch wiring.
	 *
	 * Returns `null` (with a Notice) if the fork-point message is not found.
	 */
	async forkConversation(
		forkAtMessageId: string,
	): Promise<{ filename: string; conversation: Conversation } | null> {
		const providerType = this.providerRegistry.getActiveType();
		const providerConfig = this.providerRegistry.getConfig(providerType);
		const modelId = providerConfig?.model_id ?? "";
		const currentMode =
			this.conversationManager.getActiveConversation()?.mode ??
			this.settings.mode;

		const forkData = this.conversationManager.prepareFork(
			forkAtMessageId,
			providerType,
			modelId,
			currentMode,
		);

		if (!forkData) {
			new Notice("Could not fork: message not found in current conversation.");
			return null;
		}

		const filename = await this.historyManager.importConversation(
			forkData.conversation,
			forkData.messages,
		);

		return { filename, conversation: forkData.conversation };
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

		// Unlock input — the session (if any) owns its own AbortController,
		// so navigating away just unlocks the UI without affecting the stream.
		this.view?.setRespondingState(false);

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
	 * Switch to a conversation by its unique ID (H-005).
	 *
	 * Searches the conversation history for an entry matching the given ID,
	 * then delegates to `switchConversation()` with the matching filename.
	 * Used by the workflow activity dropdown to navigate to a specific
	 * workflow's conversation.
	 *
	 * @param conversationId - The conversation ID to find and switch to.
	 * @returns `true` if the conversation was found and loaded, `false` otherwise.
	 *
	 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-005
	 */
	async switchToConversationById(conversationId: string): Promise<boolean> {
		try {
			const entries = await this.historyManager.listConversations();
			const match = entries.find((e) => e.id === conversationId);
			if (!match) {
				log.warn("Conversation not found by ID", { conversationId });
				return false;
			}
			await this.switchConversation(match.filename);
			return true;
		} catch (e) {
			log.error("Failed to switch to conversation by ID", {
				conversationId,
				error: String(e),
			});
			return false;
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
				use_extended_context: providerConfig?.use_extended_context ?? false,
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

		// --- Create isolated ConversationSession for the workflow ---
		const snapshotConv = this.conversationManager.getActiveConversation()!;
		const snapshotMessages = this.conversationManager.getMessages();

		const { ConversationManager: ConvManagerClass } = await import("./conversation");
		const sessionConvManager = new ConvManagerClass(currentMode);

		sessionConvManager.setOnMessageAdded(async (message) => {
			const sessionConv = sessionConvManager.getActiveConversation();
			if (sessionConv) {
				await this.historyManager.appendMessage(sessionConv, message);
			}
		});
		sessionConvManager.setOnConversationChanged(async (sessionConv) => {
			await this.historyManager.updateConversationHeader(sessionConv);
		});

		sessionConvManager.loadConversation(snapshotConv, snapshotMessages);

		const pinnedPersona = this.personaManager?.getActivePersona() ?? null;
		const useExtendedContext = providerConfig?.use_extended_context ?? false;

		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.resolveEffectiveConfig(undefined, assemblyResult, pinnedPersona);

		const approvalCallback: ApprovalCallback = this.dispatcher.getApprovalCallback()
			?? (async () => "approved" as const);

		const session = new ConversationSession({
			conversationId: conversation.id,
			conversationManager: sessionConvManager,
			abortController: new AbortController(),
			title: conversation.title ?? `Workflow: ${workflow.display_name}`,
			pinnedPersona,
			providerType,
			modelId,
			useExtendedContext,
			workflowAssembly: assemblyResult,
			approvalCallback,
			initialConfig,
			initialParsedConfigs,
		});

		this.activeSessions.set(session.conversationId, session);

		// G-006: Activate workflow-scoped hook overrides before the first LLM call
		if (workflow.hooks && this.workflowHookOverrideManager) {
			this.workflowHookOverrideManager.activate(conversation.id, workflow.hooks);
			log.info("Workflow hook overrides activated for manual execution", {
				conversationId: conversation.id,
				events: Object.keys(workflow.hooks),
			});
		}

		// Step 10: Start the response loop
		session.responsePromise = this.responseLoop(currentMode, session);
		try {
			await session.responsePromise;
		} catch (e) {
			session.setStatus("errored");
			this.handleError(e);
		} finally {
			// G-005: Deactivate workflow-scoped hook overrides on all exit paths
			if (this.workflowHookOverrideManager) {
				this.workflowHookOverrideManager.deactivate(conversation.id);
			}
			if (session.status === "running" || session.status === "waiting_approval") {
				session.setStatus("completed");
			}
			this.activeSessions.delete(session.conversationId);
			this.view?.setRespondingState(false);
		}
	}

	// -----------------------------------------------------------------------
	// Background workflow execution (F-021)
	// -----------------------------------------------------------------------

	/**
	 * Execute a workflow in the background (event-triggered).
	 *
	 * Creates a background conversation, sends the assembled prompt, and runs
	 * the LLM response loop independently of the main chat panel. The user's
	 * active conversation is never disturbed.
	 *
	 * Execution sequence:
	 * 1. Create a background conversation (`is_background: true`) with workflow metadata
	 * 2. Update execution record with the new conversation ID
	 * 3. Add the assembled prompt as the first user message (`is_workflow_message: true`)
	 * 4. Run the response loop in the background
	 * 5. Surface a completion/failure Notice
	 * 6. Call `concurrencyManager.onComplete()` in the finally block
	 *
	 * When a tool call requires approval, the execution status is updated to
	 * `"waiting_approval"` via `concurrencyManager.updateStatus()`.
	 *
	 * @param request            - The workflow execution request (workflow + trigger context).
	 * @param execution          - The execution tracking record (from F-020).
	 * @param chain              - Execution chain for loop prevention.
	 * @param concurrencyManager - Manager to call `onComplete()` when done.
	 * @param personaSwitchResult - Result of any persona switch performed before submission.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-021
	 */
	async executeBackgroundWorkflow(
		request: WorkflowExecutionRequest,
		execution: WorkflowExecution,
		chain: ExecutionChain,
		concurrencyManager: WorkflowConcurrencyManager,
		personaSwitchResult: { switched: boolean; previousPersona: string | null }
	): Promise<void> {
		const { workflow, supplementaryText, triggerContext } = request;

		log.info("Starting background workflow execution", {
			executionId: execution.id,
			workflowName: workflow.display_name,
			hookEvent: triggerContext?.event,
		});

		// Step 1: Assemble the workflow prompt (re-assemble here to get the
		// assembled message string; the dispatcher already validated it is non-null)
		let assemblyResult;
		try {
			assemblyResult = await assembleWorkflowPrompt(
				{
					workflow,
					supplementaryText: supplementaryText ?? null,
					triggerContext: triggerContext ?? null,
				},
				this.app.vault,
				this.app.metadataCache
			);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Background workflow prompt assembly failed", {
				executionId: execution.id,
				error: errMsg,
			});
			concurrencyManager.onComplete(execution.id, "errored", errMsg);
			new Notice(`Workflow '${workflow.display_name}' failed: ${errMsg}`);
			// Revert persona if we switched it
			if (personaSwitchResult.switched && this.personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, this.personaManager);
			}
			return;
		}

		if (assemblyResult === null) {
			// Empty guard: Notice already surfaced by assembleWorkflowPrompt
			log.warn("Background workflow assembly returned null", {
				executionId: execution.id,
			});
			concurrencyManager.onComplete(execution.id, "errored", "Workflow has no prompt content");
			if (personaSwitchResult.switched && this.personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, this.personaManager);
			}
			return;
		}

		// Step 2: Create a background conversation (does NOT switch the user's
		// active conversation — we operate on a separate ConversationManager instance
		// scoped to this background execution).
		const providerType = this.providerRegistry.getActiveType();
		const providerConfig = this.providerRegistry.getConfig(providerType);
		const modelId = providerConfig?.model_id ?? "";
		const mode = this.settings.mode;

		// Determine the active persona name after any switch
		const activePersonaName = this.personaManager?.getActivePersona()?.name ?? null;

		// Create a dedicated ConversationManager for this background execution
		// so it runs fully isolated from the main chat panel's state.
		const { ConversationManager } = await import("./conversation");
		const bgConversationManager = new ConversationManager(mode);

		// Wire persistence callbacks (same pattern as the main orchestrator)
		bgConversationManager.setOnMessageAdded(async (message) => {
			const conv = bgConversationManager.getActiveConversation();
			if (conv) {
				await this.historyManager.appendMessage(conv, message);
			}
		});
		bgConversationManager.setOnConversationChanged(async (conv) => {
			await this.historyManager.updateConversationHeader(conv);
		});

		const bgConversation = bgConversationManager.createConversation(
			providerType,
			modelId,
			mode,
			{
				workflow_path: workflow.file_path,
				workflow_name: workflow.display_name,
				persona_name: activePersonaName,
				is_background: true,
				title: `Workflow: ${workflow.display_name}`,
				use_extended_context: providerConfig?.use_extended_context ?? false,
			}
		);

		await this.historyManager.createConversationFile(bgConversation);

		// Step 3: Update execution record with conversation ID
		execution.conversation_id = bgConversation.id;

		// Step 4: Add the assembled message as the first user message
		bgConversationManager.addMessage({
			role: "user",
			content: assemblyResult.assembledMessage,
			is_workflow_message: true,
		});

		log.info("Background workflow conversation created", {
			conversationId: bgConversation.id,
			workflowName: workflow.display_name,
		});

		// G-007: Activate workflow-scoped hook overrides before the first LLM call
		if (workflow.hooks && this.workflowHookOverrideManager) {
			this.workflowHookOverrideManager.activate(bgConversation.id, workflow.hooks);
			log.info("Workflow hook overrides activated for background execution", {
				conversationId: bgConversation.id,
				events: Object.keys(workflow.hooks),
			});
		}

		// Step 5: Run the response loop (no view — background execution)
		// We build a self-contained response loop using the background conversation manager.
		let finalStatus: "completed" | "errored" | "stopped" = "completed";
		let errorMessage: string | undefined;

		try {
			await this._backgroundResponseLoop(
				bgConversationManager,
				assemblyResult,
				mode,
				execution,
				concurrencyManager,
				chain
			);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Background workflow response loop error", {
				executionId: execution.id,
				error: errMsg,
			});
			finalStatus = "errored";
			errorMessage = errMsg;
		} finally {
			// G-005: Deactivate workflow-scoped hook overrides on all exit paths
			// This runs before concurrencyManager.onComplete() so the override is
			// always cleared even if onComplete() throws.
			if (this.workflowHookOverrideManager) {
				this.workflowHookOverrideManager.deactivate(bgConversation.id);
			}

			// Step 6: Mark completion
			concurrencyManager.onComplete(execution.id, finalStatus, errorMessage);

			if (finalStatus === "completed") {
				log.info("Background workflow completed", {
					executionId: execution.id,
					workflowName: workflow.display_name,
				});
				new Notice(`Workflow '${workflow.display_name}' completed.`);
			} else if (finalStatus === "errored") {
				new Notice(`Workflow '${workflow.display_name}' failed: ${errorMessage ?? "Unknown error"}`);
			}

			// Revert persona if we switched it — scoped to this background execution
			if (personaSwitchResult.switched && this.personaManager) {
				try {
					await revertWorkflowPersona(
						personaSwitchResult.previousPersona,
						this.personaManager
					);
				} catch (e) {
					log.error("Failed to revert workflow persona after background execution", {
						error: String(e),
					});
				}
			}
		}
	}

	/**
	 * Background response loop — drives LLM turns for a background workflow
	 * execution without touching the main chat panel UI.
	 *
	 * Mirrors `responseLoop()` but operates on the provided background
	 * `ConversationManager` and never renders to the view.
	 *
	 * @param bgConvManager      - Isolated conversation manager for this execution.
	 * @param workflowAssembly  - Workflow assembly result with tool configs.
	 * @param mode               - Conversation mode (plan/act).
	 * @param execution          - Execution record for status tracking.
	 * @param concurrencyManager - Concurrency manager for status updates.
	 * @param chain              - Execution chain for loop prevention.
	 */
	private async _backgroundResponseLoop(
		bgConvManager: import("./conversation").ConversationManager,
		workflowAssembly: WorkflowAssemblyResult,
		mode: ConversationMode,
		execution: WorkflowExecution,
		concurrencyManager: WorkflowConcurrencyManager,
		_chain: ExecutionChain
	): Promise<void> {
		let continueLoop = true;
		const vaultRootPath = this.getVaultRootPath();

		// Snapshot provider/model/persona for session isolation
		const pinnedPersona = this.personaManager?.getActivePersona() ?? null;
		const providerType = this.providerRegistry.getActiveType();
		const providerConfig = this.providerRegistry.getConfig(providerType);
		const modelId = providerConfig?.model_id ?? "";
		const useExtendedContext = providerConfig?.use_extended_context ?? false;

		// Resolve initial effective config
		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.resolveEffectiveConfig(undefined, workflowAssembly, pinnedPersona);

		// Capture approval callback for session-scoped dispatch
		const approvalCallback = this.dispatcher.getApprovalCallback()
			?? (async () => "approved" as const);

		const bgConv = bgConvManager.getActiveConversation()!;
		const session = new ConversationSession({
			conversationId: bgConv.id,
			conversationManager: bgConvManager,
			abortController: new AbortController(),
			title: bgConv.title ?? `Workflow: ${execution.id}`,
			pinnedPersona,
			providerType,
			modelId,
			useExtendedContext,
			workflowAssembly,
			approvalCallback,
			initialConfig,
			initialParsedConfigs,
		});

		try {
		while (continueLoop) {
			continueLoop = false;

			// 1. Evaluate vault rules + resolve effective tool config
			const matchedRules = this.vaultRuleManager
				? await this.vaultRuleManager.getMatchedRules()
				: undefined;

			const { effective, toolDefinitions, parsedConfigs } =
				await this.resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona);
			session.effectiveConfig = effective;
			session.parsedConfigs = parsedConfigs;

			const { buildAutoContextBlock } = await import("../context/auto-context");
			const autoContext = buildAutoContextBlock(this.app, this.settings);
			const systemPrompt = await this.systemPromptBuilder.assemble(
				mode,
				toolDefinitions,
				undefined, // vaultRuleContent — now handled via cached stripped content
				autoContext ?? undefined,
				session.pinnedPersona
			);

			// 2. Assemble messages
			const allMessages = bgConvManager.getMessages();
			const hasSystemMessage = allMessages.some((m) => m.role === "system");
			if (!hasSystemMessage) {
				allMessages.unshift({
					id: "system",
					conversation_id: bgConvManager.getActiveConversation()!.id,
					role: "system",
					content: systemPrompt,
					timestamp: new Date().toISOString(),
				});
			}

			// 3. Assemble context window
			const { ContextManager } = await import("./context");
			const contextMgr = new ContextManager();
			const contextResult = contextMgr.assembleContextWindow(allMessages, session.modelId, session.useExtendedContext);

			// 4. Convert to ChatMessage format
			const chatMessages = this._bgToChatMessages(
				contextResult.messages,
				systemPrompt
			);

			// 5. Send to LLM
			const abortController = new AbortController();
			const provider = this.providerRegistry.getProvider(session.providerType);
			const stream = provider.sendMessage(chatMessages, toolDefinitions, {
				model: session.modelId,
				abort_signal: abortController.signal,
				use_extended_context: session.useExtendedContext,
			});

			// 6. Process stream (background — no UI rendering)
			let textContent = "";
			let inputTokens = 0;
			let outputTokens = 0;
			let toolCallId = "";
			let toolName = "";
			let parameters: Record<string, unknown> = {};
			let hasToolCall = false;

			for await (const event of parseStreamEvents(stream, abortController.signal)) {
				switch (event.type) {
					case "text_delta":
						textContent = event.text;
						break;
					case "tool_call":
						hasToolCall = true;
						toolCallId = event.id;
						toolName = event.name;
						parameters = event.parameters;
						// Background loop handles one tool call at a time
						break;
					case "message_end":
						inputTokens = event.inputTokens;
						outputTokens = event.outputTokens;
						break;
					case "error":
						throw new Error(event.message);
					case "cancelled":
						// Abort — exit the loop
						break;
				}
				// Background loop breaks after the first tool call
				if (hasToolCall) break;
			}

			if (hasToolCall) {
				// Add tool call message
				const toolCallMessage = bgConvManager.addMessage({
					role: "tool_call",
					content: "",
					tool_call: {
						id: toolCallId,
						tool_name: toolName,
						parameters,
						status: "pending",
					},
				});

				// Update status to waiting_approval if the tool is not auto-approved
				const isAutoApproved = session.effectiveConfig.tools[toolName]?.auto_approve ?? false;

				if (!isAutoApproved) {
					concurrencyManager.updateStatus(execution.id, "waiting_approval");
					log.info("Background workflow waiting for tool approval", {
						executionId: execution.id,
						toolName,
					});
				}

				// Dispatch the tool with session-scoped policy context and approval
				const policyCtx = vaultRootPath
					? session.buildPolicyContext(this.settings, vaultRootPath)
					: undefined;
				const toolResult = await this.dispatcher.dispatch(
					toolName,
					parameters,
					mode,
					toolCallMessage.id,
					undefined, // abortSignal
					undefined, // onProgress
					policyCtx,
					session.approvalCallback,
				);
				toolResult.tool_call_id = toolCallId;

				// Restore running status after approval/execution
				if (!isAutoApproved) {
					concurrencyManager.updateStatus(execution.id, "running");
				}

				// Dispatch hook events if applicable
			// G-004: Pass override manager so workflow-scoped hooks are used when active
			// EXT-017: Pass extension tool event automations
				const bgConvForHooks = bgConvManager.getActiveConversation();
				if (bgConvForHooks && vaultRootPath) {
					const { dispatchOnToolCall, dispatchOnToolResult } =
						await import("../hooks/hook-events");
					dispatchOnToolCall(
						{
							conversationId: bgConvForHooks.id,
							timestamp: new Date().toISOString(),
							toolName,
							toolParams: parameters,
						},
						this.settings,
						vaultRootPath,
						this.workflowHookOverrideManager,
						this.extensionToolEventAccessors,
					);

					const toolResultStr = typeof toolResult.result === "string"
						? toolResult.result
						: JSON.stringify(toolResult.result);
					dispatchOnToolResult(
						{
							conversationId: bgConvForHooks.id,
							timestamp: new Date().toISOString(),
							toolName,
							toolParams: parameters,
							toolResult: toolResultStr,
							toolStatus: toolResult.success ? "success" : "error",
						},
						this.settings,
						vaultRootPath,
						this.workflowHookOverrideManager,
						this.extensionToolEventAccessors,
					);
				}

				// Add tool result message
				bgConvManager.addMessage({
					role: "tool_result",
					content: "",
					tool_result: toolResult,
				});

				// Roll up sub-agent tokens into conversation totals without
				// inflating per-message estimates (which would cause premature
				// compaction/truncation).
				const bgSubAgentTokens = toolResult.sub_agent_metadata?.token_usage;
				if (bgSubAgentTokens) {
					bgConvManager.addTokens(bgSubAgentTokens.input, bgSubAgentTokens.output);
				}

				// Add token tracking message if available
				if (inputTokens || outputTokens) {
					bgConvManager.addMessage({
						role: "assistant",
						content: textContent || "",
						input_tokens: inputTokens,
						output_tokens: outputTokens,
					});
				}

				// Update token footer after background tool result token rollup
				const bgConvForFooter = bgConvManager.getActiveConversation();
				if (bgConvForFooter) {
					this.view?.updateTokenFooter(
						bgConvForFooter.total_input_tokens,
						bgConvForFooter.total_output_tokens,
						bgConvForFooter.estimated_cost
					);
				}

				// Continue the loop
				continueLoop = true;
			} else {
				// Final text response
				bgConvManager.addMessage({
					role: "assistant",
					content: textContent,
					input_tokens: inputTokens,
					output_tokens: outputTokens,
				});
			}
		}
		} finally {
			// No cleanup needed — session is local to this method and not
			// registered in activeSessions (background workflows are tracked
			// by WorkflowConcurrencyManager instead).
		}
	}

	/**
	 * Convert internal messages to ChatMessage format for the background response loop.
	 * Mirrors `toChatMessages()` but without the full class context.
	 */
	private _bgToChatMessages(
		messages: Message[],
		systemPrompt: string
	): import("../providers/provider").ChatMessage[] {
		return this.toChatMessages(messages, systemPrompt);
	}

	/**
	 * Callback that provides tool definitions for the response loop.
	 *
	 * Set by main.ts via `setGetToolDefinitions()` so `executeWorkflow()`
	 * can call `responseLoop()` without direct access to the tool registry.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-015
	 */
	private getToolDefinitionsCallback?: (config?: EffectiveToolConfig) => import("../providers/provider").ToolDefinition[];

	/**
	 * Set the callback that provides tool definitions for the response loop.
	 *
	 * Called by main.ts during view wiring so `executeWorkflow()` can start
	 * the response loop without a direct reference to the tool registry.
	 *
	 * When an `EffectiveToolConfig` is provided, returns filtered tool
	 * definitions (disabled tools excluded). When omitted, returns all tools.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-015
	 * @see specs/04b-tool-toggle/tasks.md — MAIN-001
	 */
	setGetToolDefinitions(callback: (config?: EffectiveToolConfig) => import("../providers/provider").ToolDefinition[]): void {
		this.getToolDefinitionsCallback = callback;
	}

	// -----------------------------------------------------------------------
	// Tool config resolution (Phase 4b)
	// -----------------------------------------------------------------------

	/**
	 * Resolve the effective tool config for the current iteration.
	 *
	 * Pure function — accepts all variable inputs as parameters and returns
	 * a structured result without mutating any orchestrator or dispatcher fields.
	 *
	 * @param matchedRules      - Rules matched by VaultRuleManager for the current context.
	 * @param workflowAssembly  - Active workflow assembly result (null for non-workflow conversations).
	 * @param activePersona     - The persona to use for config resolution (null for no persona).
	 * @returns Structured result with effective config, tool definitions, and parsed configs.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-001
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1b
	 */
	private async resolveEffectiveConfig(
		matchedRules?: VaultRule[],
		workflowAssembly?: WorkflowAssemblyResult | null,
		activePersona?: Persona | null,
	): Promise<{
		effective: EffectiveToolConfig;
		toolDefinitions: ToolDefinition[];
		parsedConfigs: ParsedToolConfig[];
	}> {
		// Phase 1: Extract tool configs from persona and rules
		const { personaToolConfigs, ruleToolConfigs } =
			await this.systemPromptBuilder.extractSourceToolConfigs(matchedRules, activePersona ?? null);

		// Collect workflow tool configs from assembly parameter
		const workflowToolConfigs = workflowAssembly?.toolConfigs ?? [];

		// Collect all parsed configs
		const allConfigs: ParsedToolConfig[] = [
			...ruleToolConfigs,
			...personaToolConfigs,
			...workflowToolConfigs,
		];

		// Build globalAutoApprove and globalEnabled per-iteration from current settings
		const globalAutoApprove: Record<string, boolean> = {
			...this.settings.auto_approve,
		};
		const globalEnabled: Record<string, boolean> = {
			...this.settings.tool_enabled,
		};

		// Expand MCP server-level autoApprove[] into namespaced keys
		if (this.settings.mcp_servers) {
			for (const [serverName, serverConfig] of Object.entries(this.settings.mcp_servers)) {
				if (serverConfig.disabled) continue;
				if (serverConfig.autoApprove) {
					for (const rawToolName of serverConfig.autoApprove) {
						globalAutoApprove[`${serverName}__${rawToolName}`] = true;
					}
				}
			}
		}

		// Get all registered tool names for default fill
		const allToolNames = this.dispatcher.getRegisteredToolNames();

		// Merge all configs
		const effective = mergeToolConfigs(allConfigs, globalAutoApprove, allToolNames, globalEnabled);

		// Compute filtered tool definitions
		const toolDefinitions = this.getToolDefinitionsCallback?.(effective) ?? [];

		log.debug("Effective tool config resolved", {
			totalConfigs: allConfigs.length,
			enabledTools: toolDefinitions.length,
			totalTools: allToolNames.length,
		});

		return { effective, toolDefinitions, parsedConfigs: allConfigs };
	}

	/**
	 * Update the display-facing config fields for the inspector.
	 *
	 * Called when the displayed conversation's config changes (either from
	 * a session's resolveEffectiveConfig result or on conversation switch).
	 */
	private updateDisplayConfig(effective: EffectiveToolConfig, parsedConfigs: ParsedToolConfig[]): void {
		this.activeParsedConfigs = parsedConfigs;
		this.effectiveToolConfig = effective;
		this.dispatcher.setEffectiveToolConfig(effective);
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
	 * Creates an isolated `ConversationSession` that owns all per-conversation
	 * state, then runs the response loop against that session.
	 *
	 * @param content - User message text
	 * @param attachments - Optional file attachments
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1d
	 */
	async handleUserMessage(
		content: string,
		attachments?: Attachment[]
	): Promise<void> {
		// Ensure we have an active conversation
		if (!this.conversationManager.hasActiveConversation()) {
			await this.newConversation();
		}

		const conv = this.conversationManager.getActiveConversation();
		if (!conv) return;

		// Duplicate-send guard: prevent a second session for the same conversation
		if (this.activeSessions.has(conv.id)) {
			new Notice("This conversation is already processing");
			return;
		}

		// Guard: require a model to be selected before doing any work
		if (!this.getActiveModelId()) {
			this.view?.showError(
				"No model selected. Open the model picker and choose a model before sending a message."
			);
			return;
		}

		const mode = this.conversationManager.getMode();

		// Phase 3 (ATT-008): Resolve attachments and build XML/media blocks
		let attachmentsText: string | null = null;
		let attachmentContentBlocks: import("../media/types").ContentBlock[] = [];
		const resolvedAttachments: Attachment[] = [];

		if (attachments && attachments.length > 0) {
			for (const att of attachments) {
				const resolved = await resolveAttachment(this.app, att, {
					maxDimension: this.settings.image_max_dimension,
					compressionQuality: this.settings.image_compression_quality,
				}, this.settings.active_provider);
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

			const built = buildAttachmentsBlock(resolvedAttachments);
			attachmentsText = built.text;
			attachmentContentBlocks = built.contentBlocks;
		}

		// Phase 3 (HOOK-004): Dispatch pre-send hooks and capture stdout
		// G-004: Pass override manager so workflow-scoped hooks are used when active
		// EXT-017: Pass extension lifecycle automations
		let hookInjections: string[] | undefined;
		{
			const vaultRootPath = this.getVaultRootPath();
			if (vaultRootPath) {
				hookInjections = await dispatchPreSend(
					{
						conversationId: conv.id,
						timestamp: new Date().toISOString(),
					},
					this.settings,
					vaultRootPath,
					this.workflowHookOverrideManager,
					this.extensionLifecycleAccessors,
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
		const assembledText = assembleUserMessage({
			attachments: attachmentsText ?? undefined,
			userText: content,
		});
		const assembledContent = assembleUserContent(assembledText, attachmentContentBlocks);

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

		// --- Create isolated ConversationSession ---
		// Snapshot conversation + messages from display manager into an isolated
		// ConversationManager so the response loop never reads shared state.
		const snapshotConv = this.conversationManager.getActiveConversation()!;
		const snapshotMessages = this.conversationManager.getMessages();

		const { ConversationManager: ConvManagerClass } = await import("./conversation");
		const sessionConvManager = new ConvManagerClass(mode);

		// Wire persistence callbacks (same pattern as executeBackgroundWorkflow)
		sessionConvManager.setOnMessageAdded(async (message) => {
			const sessionConv = sessionConvManager.getActiveConversation();
			if (sessionConv) {
				await this.historyManager.appendMessage(sessionConv, message);
			}
		});
		sessionConvManager.setOnConversationChanged(async (sessionConv) => {
			await this.historyManager.updateConversationHeader(sessionConv);
		});

		sessionConvManager.loadConversation(snapshotConv, snapshotMessages);

		// Snapshot persona, provider, model, extended context
		const pinnedPersona = this.personaManager?.getActivePersona() ?? null;
		const providerType = this.providerRegistry.getActiveType();
		const providerConfig = this.providerRegistry.getConfig(providerType);
		const modelId = providerConfig?.model_id ?? "";
		const useExtendedContext = providerConfig?.use_extended_context ?? false;

		// Resolve initial effective config
		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.resolveEffectiveConfig(undefined, null, pinnedPersona);

		// Capture the approval callback from the dispatcher's current global callback.
		// This binds approval prompts to the correct panel's view.
		const approvalCallback: ApprovalCallback = this.dispatcher.getApprovalCallback()
			?? (async () => "approved" as const);

		const session = new ConversationSession({
			conversationId: snapshotConv.id,
			conversationManager: sessionConvManager,
			abortController: new AbortController(),
			title: snapshotConv.title ?? "Untitled",
			pinnedPersona,
			providerType,
			modelId,
			useExtendedContext,
			workflowAssembly: null,
			approvalCallback,
			initialConfig,
			initialParsedConfigs,
		});

		// Register session and start response loop
		this.activeSessions.set(session.conversationId, session);

		session.responsePromise = this.responseLoop(mode, session);
		try {
			await session.responsePromise;
		} catch (e) {
			session.setStatus("errored");
			this.handleError(e);
		} finally {
			if (session.status === "running" || session.status === "waiting_approval") {
				session.setStatus("completed");
			}
			this.activeSessions.delete(session.conversationId);
			this.view?.setRespondingState(false);
		}
	}

	/**
	 * The main response loop — sends messages to the LLM and processes
	 * the response. Loops when tool calls are made.
	 *
	 * Per-iteration: evaluates vault rules, resolves effective tool config
	 * (which extracts tool configs and caches stripped content), then
	 * assembles the system prompt with filtered tool definitions.
	 *
	 * All per-conversation state is read from the session — not from shared
	 * orchestrator fields. The shared `this.conversationManager` is the UI
	 * display manager only; `this.view` calls are guarded by
	 * `getViewForSession()` so render becomes a no-op when the user navigates
	 * away mid-stream.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-002
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1d
	 */
	private async responseLoop(
		mode: ConversationMode,
		session: ConversationSession,
	): Promise<void> {
		let continueLoop = true;
		const vaultRootPath = this.getVaultRootPath();
		const convManager = session.conversationManager;

		try {
			while (continueLoop) {
				continueLoop = false;

				// 0. Phase 3 (COMP-005): Check compaction threshold before each LLM call
				await this.checkAndPerformCompaction(session);

				// 1. Evaluate vault rules (re-evaluated each turn after tool calls)
				const matchedRules = this.vaultRuleManager
					? await this.vaultRuleManager.getMatchedRules()
					: undefined;

				// 1b. Resolve effective tool config (extracts tool configs from
				// persona + rules + workflow, merges, and returns filtered tool definitions)
				const { effective, toolDefinitions, parsedConfigs } = await this.resolveEffectiveConfig(
					matchedRules,
					session.workflowAssembly,
					session.pinnedPersona,
				);
				session.effectiveConfig = effective;
				session.parsedConfigs = parsedConfigs;

				// Update display config only if this session matches the displayed conversation
				if (this.getViewForSession(session)) {
					this.updateDisplayConfig(effective, parsedConfigs);
				}

				// 1c. ACI-001: Build fresh auto-context before each LLM call
				// so open-notes and vault structure reflect the latest state.
				const autoContext = buildAutoContextBlock(this.app, this.settings);
				const systemPrompt = await this.systemPromptBuilder.assemble(
					mode,
					toolDefinitions,
					undefined, // vaultRuleContent — now handled via cached stripped content
					autoContext ?? undefined,
					session.pinnedPersona
				);

				// Emit assembled system prompt as a structured log so E2E tests
				// can verify auto-context is present in the system prompt (ACI-TEST-001).
				log.debug("System prompt assembled", { systemPrompt });

				// 3. Build messages for LLM
				const allMessages = convManager.getMessages();

				// Ensure system message is first
				const hasSystemMessage = allMessages.some((m) => m.role === "system");
				if (!hasSystemMessage) {
					// Add system message (not persisted as a separate message, just in context)
					allMessages.unshift({
						id: "system",
						conversation_id: convManager.getActiveConversation()!.id,
						role: "system",
						content: systemPrompt,
						timestamp: new Date().toISOString(),
					});
				}

				// 4. Assemble context window (truncate if needed)
				const contextResult = this.contextManager.assembleContextWindow(
					allMessages,
					session.modelId,
					session.useExtendedContext,
				);

				if (contextResult.wasTruncated) {
					this.getViewForSession(session)?.showTruncationWarning(contextResult.truncatedCount);
				}

				// 5. Convert to ChatMessage format for provider
				const chatMessages = this.toChatMessages(contextResult.messages, systemPrompt);

				// 6. Send to LLM
				const view = this.getViewForSession(session);
				view?.setRespondingState(true);
				const abortController = session.abortController;

				// Eagerly create the assistant placeholder so the DOM element exists
				// the moment we enter responding state. This ensures the element is
				// present even if the abort fires before any text_delta chunks arrive.
				const eagerContentEl = view?.createAssistantMessagePlaceholder();

				const provider = this.providerRegistry.getProvider(session.providerType);
				const options: SendMessageOptions = {
					model: session.modelId,
					abort_signal: abortController.signal,
					use_extended_context: session.useExtendedContext,
				};

				const stream = provider.sendMessage(chatMessages, toolDefinitions, options);

				// 7. Process stream (pass in the already-created placeholder + session-aware view resolver)
				const result = await this.processStream(
					stream,
					abortController,
					eagerContentEl,
					() => this.getViewForSession(session),
				);

				// 8. Handle result
				if (result.type === "text") {
					// Final text response — loop ends
					const assistantMessage = convManager.addMessage({
						role: "assistant",
						content: result.text,
						input_tokens: result.inputTokens,
						output_tokens: result.outputTokens,
						cost_estimate: this.calculateCost(result.inputTokens, result.outputTokens, session.modelId),
					});

					if (result.contentEl) {
						await this.getViewForSession(session)?.finalizeAssistantMessage(result.contentEl, assistantMessage);
					}

					// Update token footer
					const conv = convManager.getActiveConversation();
					if (conv) {
						this.getViewForSession(session)?.updateTokenFooter(
							conv.total_input_tokens,
							conv.total_output_tokens,
							conv.estimated_cost
						);
					}
				} else if (result.type === "tool_calls") {
					// Tool calls — add all tool_call messages first, dispatch
					// serially, then add all tool_result messages.  Grouped
					// ordering is required by the Anthropic/Bedrock API format
					// (one assistant message with N tool_use blocks followed by
					// one user message with N tool_result blocks).

					// Track tokens from message_end (now correctly captured
					// because processStream consumes the full stream).
					if (result.inputTokens || result.outputTokens) {
						convManager.addMessage({
							role: "assistant",
							content: result.text || "",
							input_tokens: result.inputTokens,
							output_tokens: result.outputTokens,
							cost_estimate: this.calculateCost(result.inputTokens, result.outputTokens, session.modelId),
						});

						// Update token footer after tool-call turn tokens are recorded
						const convAfterToolTokens = convManager.getActiveConversation();
						if (convAfterToolTokens) {
							this.getViewForSession(session)?.updateTokenFooter(
								convAfterToolTokens.total_input_tokens,
								convAfterToolTokens.total_output_tokens,
								convAfterToolTokens.estimated_cost
							);
						}
					}

					// --- Step 1: Add all tool_call messages and render UI ---
					const toolCallEntries: Array<{
						call: ToolCallInfo;
						message: Message;
						el?: HTMLElement;
					}> = [];

					for (const call of result.calls) {
						const toolCallMessage = convManager.addMessage({
							role: "tool_call",
							content: "",
							tool_call: {
								id: call.toolCallId,
								tool_name: call.toolName,
								parameters: call.parameters,
								status: "pending",
							},
						});

						const toolCallEl = this.getViewForSession(session)?.renderToolCall(toolCallMessage);

						// HOOK-005: Fire on_tool_call hooks sequentially
						// G-004: Pass override manager so workflow-scoped hooks are used when active
						// EXT-017: Pass extension tool event automations
						const currentConv = convManager.getActiveConversation();
						if (currentConv && vaultRootPath) {
							const { dispatchOnToolCall } = await import("../hooks/hook-events");
							dispatchOnToolCall(
								{
									conversationId: currentConv.id,
									timestamp: new Date().toISOString(),
									toolName: call.toolName,
									toolParams: call.parameters,
								},
								this.settings,
								vaultRootPath,
								this.workflowHookOverrideManager,
								this.extensionToolEventAccessors,
							);
						}

						toolCallEntries.push({
							call,
							message: toolCallMessage,
							el: toolCallEl,
						});
					}

					// --- Step 2: Dispatch tools via batch orchestration ---
					// Partition into concurrent/serial batches and execute
					// with parallel execution for concurrency-safe (read) tools.
					const messageIdMap = new Map<string, string>();
					for (const entry of toolCallEntries) {
						messageIdMap.set(entry.call.toolCallId, entry.message.id);
					}

					const batches = partitionToolCalls(
						result.calls,
						this.dispatcher,
					);

					// Phase 8.1: Build progress callbacks for tool calls
					// that support onProgress (e.g., use_subagent).
					const onProgressMap = new Map<string, (status: string) => void>();
					for (const entry of toolCallEntries) {
						if (entry.el) {
							const el = entry.el;
							onProgressMap.set(entry.call.toolCallId, (status: string) => {
								this.getViewForSession(session)?.updateToolCallProgress(el, status);
							});
						}
					}

					// Build policy context and pass per-session approval callback
					const policyCtx = vaultRootPath
						? session.buildPolicyContext(this.settings, vaultRootPath)
						: undefined;

					const batchResults = await executeToolBatches(
						batches,
						this.dispatcher,
						mode,
						messageIdMap,
						abortController.signal,
						undefined, // concurrencyCap — use default
						onProgressMap,
						policyCtx,
						session.approvalCallback,
					);

					// Map results back to entries for UI updates
					const toolResults: ToolResult[] = [];
					for (const batchResult of batchResults) {
						const entry = toolCallEntries.find(
							e => e.call.toolCallId === batchResult.call.toolCallId
						);

						// Update tool call status badge in the UI
						if (entry?.el) {
							this.getViewForSession(session)?.updateToolCallStatus(
								entry.el,
								batchResult.result.success ? "success" : "error"
							);
							// Set message ID after dispatch completes so only
							// finished tool calls are forkable (not pending ones)
							entry.el.dataset.messageId = entry.message.id;
							this.getViewForSession(session)?.appendForkButton(entry.el);
						}

						toolResults.push(batchResult.result);
					}

					// --- Step 3: Add all tool_result messages ---
					for (let i = 0; i < toolCallEntries.length; i++) {
						const entry = toolCallEntries[i]!;
						const toolResult = toolResults[i]!;

						// Record note access for vault rule re-evaluation
						const notePath = entry.call.parameters["path"] as string | undefined;
						if (notePath && this.vaultRuleManager) {
							this.vaultRuleManager.recordNoteAccess(notePath);
						}

						const toolResultMessage = convManager.addMessage({
							role: "tool_result",
							content: "",
							tool_result: toolResult,
						});

						// Roll up sub-agent tokens into conversation totals without
						// inflating per-message estimates (which would cause premature
						// compaction/truncation).
						const subAgentTokens = toolResult.sub_agent_metadata?.token_usage;
						if (subAgentTokens) {
							convManager.addTokens(subAgentTokens.input, subAgentTokens.output);
						}

						this.getViewForSession(session)?.renderToolResult(toolResultMessage);

						// HOOK-005: Fire on_tool_result hooks sequentially
						// G-004: Pass override manager so workflow-scoped hooks are used when active
						// EXT-017: Pass extension tool event automations
						const convForToolResult = convManager.getActiveConversation();
						if (convForToolResult && vaultRootPath) {
							const { dispatchOnToolResult } = await import("../hooks/hook-events");
							const toolResultStr = typeof toolResult.result === "string"
								? toolResult.result
								: JSON.stringify(toolResult.result);
							dispatchOnToolResult(
								{
									conversationId: convForToolResult.id,
									timestamp: new Date().toISOString(),
									toolName: entry.call.toolName,
									toolParams: entry.call.parameters,
									toolResult: toolResultStr,
									toolStatus: toolResult.success ? "success" : "error",
								},
								this.settings,
								vaultRootPath,
								this.workflowHookOverrideManager,
								this.extensionToolEventAccessors,
							);
						}

						// Update token footer after sub-agent token rollup
						const convAfterToolResult = convManager.getActiveConversation();
						if (convAfterToolResult) {
							this.getViewForSession(session)?.updateTokenFooter(
								convAfterToolResult.total_input_tokens,
								convAfterToolResult.total_output_tokens,
								convAfterToolResult.estimated_cost
							);
						}
					}

					// If abort was triggered during the tool dispatch loop, break out
					if (abortController.signal.aborted) {
						break;
					}

					// Continue the loop — send tool results back to LLM
					continueLoop = true;
				} else if (result.type === "cancelled") {
					// User cancelled — always render an assistant message so the
					// .notor-message-assistant element exists in the DOM (the E2E
					// test asserts this even when the abort fires before any text
					// chunks have arrived).
					const cancelledContent = result.text
						? result.text + "\n\n*[Response cancelled]*"
						: "*[Response cancelled]*";

					const cancelledMsg = convManager.addMessage({
						role: "assistant",
						content: cancelledContent,
					});

					const cancelView = this.getViewForSession(session);
					if (result.contentEl) {
						// We already have a streaming placeholder — finalize it
						await cancelView?.finalizeAssistantMessage(result.contentEl, cancelledMsg);
					} else {
						// No placeholder yet — create one and finalize immediately
						const el = cancelView?.createAssistantMessagePlaceholder();
						if (el) {
							await cancelView?.finalizeAssistantMessage(el, cancelledMsg);
						}
					}
				} else if (result.type === "error") {
					const errStr = typeof result.error === "string"
						? result.error
						: (result.error as unknown) instanceof Error
							? (result.error as unknown as Error).message
							: JSON.stringify(result.error);
					this.getViewForSession(session)?.showError(errStr);
				}
			}
		} finally {
			// Phase 3 (HOOK-005): Fire after_completion hooks when response loop ends.
			// The finally block ensures hooks fire even when a provider exception
			// escapes the loop. Hooks are fire-and-forget so they never suppress errors.
			const completionConvId = convManager.getActiveConversation()?.id;
			this.dispatchAfterCompletionHooks(completionConvId);
		}
	}

	/**
	 * Dispatch after_completion hooks. Called from responseLoopWithHooks so the
	 * hooks always fire regardless of how the loop terminates.
	 *
	 * G-004: Passes the override manager so workflow-scoped hooks are used
	 * when a workflow-scoped override is active for this conversation.
	 * EXT-017: Passes extension lifecycle automations.
	 */
	private dispatchAfterCompletionHooks(conversationId?: string): void {
		const resolvedId = conversationId ?? this.conversationManager.getActiveConversation()?.id;
		const vaultRootPath = this.getVaultRootPath();
		if (resolvedId && vaultRootPath) {
			dispatchAfterCompletion(
				{
					conversationId: resolvedId,
					timestamp: new Date().toISOString(),
				},
				this.settings,
				vaultRootPath,
				this.workflowHookOverrideManager,
				this.extensionLifecycleAccessors,
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
	private async checkAndPerformCompaction(session?: ConversationSession): Promise<void> {
		const convManager = session?.conversationManager ?? this.conversationManager;
		const conv = convManager.getActiveConversation();
		if (!conv) return;

		const messages = convManager.getMessages();
		const modelId = session?.modelId ?? this.getActiveModelId();

		const useExtendedContext = session?.useExtendedContext ?? this.getActiveUseExtendedContext();
		if (!shouldCompact(messages, this.settings, modelId, useExtendedContext)) {
			return;
		}

		// Separate pending messages (after last assistant turn) from the completed
		// conversation. Only the completed part is sent to performCompaction — this
		// avoids consecutive user messages at the end of the summarization request
		// (the pending question + "Please summarize…" would both be user role).
		// Pending messages are re-appended after compaction so the conversation
		// still ends on a user turn, as required by Bedrock and similar providers.
		const pendingMessages = this.extractPendingMessages(messages);
		const completedMessages = messages.slice(0, messages.length - pendingMessages.length);

		log.info("Compaction message split", {
			totalMessages: messages.length,
			pendingCount: pendingMessages.length,
			completedCount: completedMessages.length,
			firstPendingRole: pendingMessages[0]?.role ?? "none",
			firstCompletedRole: completedMessages[0]?.role ?? "none",
			lastCompletedRole: completedMessages[completedMessages.length - 1]?.role ?? "none",
		});

		// Show compacting indicator in chat UI (session-aware)
		const viewForCompaction = session ? this.getViewForSession(session) : this.view;
		const messagesContainer = viewForCompaction?.getMessagesContainer?.();
		let indicator: HTMLElement | null = null;
		if (messagesContainer) {
			indicator = showCompactingIndicator(messagesContainer);
		}

		log.info("Auto-compaction triggered", {
			conversationId: conv.id,
			messageCount: messages.length,
		});

		try {
			const provider = session
				? this.providerRegistry.getProvider(session.providerType)
				: this.providerRegistry.getActiveProvider();
			const result = await performCompaction(
				completedMessages,
				provider,
				this.settings,
				modelId,
				conv.id,
				"automatic",
				useExtendedContext
			);

			if (result.success && result.newMessages && result.record) {
				// Replace conversation messages with compacted context
				convManager.replaceMessages(result.newMessages);

				// Re-append pending messages so the conversation ends with a user
				// turn. Without this, providers like Bedrock reject the next call
				// because the last message in the compacted context is an assistant
				// acknowledgment ("Understood. I have the context…").
				for (const pending of pendingMessages) {
					convManager.addMessage({
						role: pending.role,
						content: pending.content,
						tool_call: pending.tool_call ?? undefined,
						tool_result: pending.tool_result ?? undefined,
					});
				}

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
		const useExtendedContext = this.getActiveUseExtendedContext();

		// Separate pending messages from the completed conversation (same reason
		// as auto-compaction: avoids consecutive user messages in the summarization
		// request and preserves the pending turn after compaction).
		const pendingMessages = this.extractPendingMessages(messages);
		const completedMessages = messages.slice(0, messages.length - pendingMessages.length);

		// Show compacting indicator
		const messagesContainer = this.view?.getMessagesContainer?.();
		let indicator: HTMLElement | null = null;
		if (messagesContainer) {
			indicator = showCompactingIndicator(messagesContainer);
		}

		try {
			const provider = this.providerRegistry.getActiveProvider();
			const result = await performCompaction(
				completedMessages,
				provider,
				this.settings,
				modelId,
				conv.id,
				"manual",
				useExtendedContext
			);

			if (result.success && result.newMessages && result.record) {
				this.conversationManager.replaceMessages(result.newMessages);

				// Re-append any pending messages so the conversation ends on a user turn.
				for (const pending of pendingMessages) {
					this.conversationManager.addMessage({
						role: pending.role,
						content: pending.content,
						tool_call: pending.tool_call ?? undefined,
						tool_result: pending.tool_result ?? undefined,
					});
				}

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
		eagerContentEl?: HTMLElement,
		viewResolver?: () => NotorChatView | undefined,
	): Promise<StreamResult> {
		let textContent = "";
		let inputTokens = 0;
		let outputTokens = 0;
		// Use the eagerly-created placeholder if provided; first text_delta
		// will use it rather than creating a second element.
		let contentEl: HTMLElement | undefined = eagerContentEl;

		// Resolve view dynamically per-chunk so mid-stream navigation
		// causes rendering to become a no-op while data writes continue.
		const resolveView = viewResolver ?? (() => this.view);

		const accumulatedToolCalls: ToolCallInfo[] = [];

		for await (const event of parseStreamEvents(stream, abortController.signal)) {
			switch (event.type) {
				case "text_delta": {
					// contentEl may already be set from the eager placeholder
					const view = resolveView();
					if (!contentEl) {
						contentEl = view?.createAssistantMessagePlaceholder();
					}
					textContent = event.text;
					if (contentEl) {
						view?.appendStreamChunk(contentEl, event.delta);
					}
					break;
				}

				case "tool_call":
					accumulatedToolCalls.push({
						toolCallId: event.id,
						toolName: event.name,
						parameters: event.parameters,
					});
					break;

				case "message_end":
					inputTokens = event.inputTokens;
					outputTokens = event.outputTokens;
					log.debug("processStream message_end", {
						inputTokens,
						outputTokens,
						toolCallCount: accumulatedToolCalls.length,
					});
					break;

				case "error":
					return {
						type: "error",
						error: event.message,
						text: textContent,
						inputTokens,
						outputTokens,
					};

				case "cancelled":
					return {
						type: "cancelled",
						text: event.text,
						inputTokens,
						outputTokens,
						contentEl,
					};
			}
		}

		// If we accumulated tool calls, return them all
		if (accumulatedToolCalls.length > 0) {
			return {
				type: "tool_calls",
				calls: accumulatedToolCalls,
				text: textContent,
				inputTokens,
				outputTokens,
				contentEl,
			};
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
	/**
	 * Extract messages that follow the last assistant turn.
	 *
	 * These are "pending" messages the LLM hasn't responded to yet (typically
	 * the current user message, or tool_call + tool_result during a tool loop).
	 * They must be re-appended after compaction so the conversation ends on a
	 * user turn, as required by providers like Bedrock that reject assistant
	 * message prefill.
	 */
	private extractPendingMessages(messages: Message[]): Message[] {
		for (let i = messages.length - 1; i >= 0; i--) {
			if (messages[i]?.role === "assistant") {
				return messages.slice(i + 1);
			}
		}
		// No prior assistant response — all messages are pending
		return [...messages];
	}

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

				case "assistant": {
					// Defensive: skip assistant messages with blank content.
					// Providers like Bedrock reject empty text fields. This can
					// happen if a response is cancelled before any text arrives.
					const assistantText = typeof msg.content === "string"
						? msg.content
						: (() => { throw new Error("Expected string content for assistant message"); })();
					if (!assistantText.trim()) {
						log.warn("Skipping assistant message with empty content", { id: msg.id });
						break;
					}
					chatMessages.push({
						role: "assistant",
						content: assistantText,
					});
					break;
				}

				case "tool_call":
					if (msg.tool_call) {
						chatMessages.push({
							role: "tool_call",
							content: "",
							tool_calls: [
								{
									// Use the provider-assigned ID (e.g., Bedrock toolUseId) when
									// available; fall back to the message UUID for other providers.
									id: msg.tool_call.id ?? msg.id,
									tool_name: msg.tool_call.tool_name,
									parameters: msg.tool_call.parameters,
								},
							],
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
							tool_results: [
								{
									// Must match the tool_calls[].id used above for the same call.
									tool_call_id: msg.tool_result.tool_call_id ?? msg.id,
									tool_name: msg.tool_result.tool_name,
									result: resultStr || msg.tool_result.error || "",
									is_error: !msg.tool_result.success,
									...(msg.tool_result.content_blocks?.length ? { content_blocks: msg.tool_result.content_blocks } : {}),
								},
							],
						});
					}
					break;
			}
		}

		// Safety net: ensure every tool_call has a matching tool_result.
		// Providers (Bedrock, Anthropic) reject conversations where a tool_use
		// block is not immediately followed by a tool_result block.
		//
		// With grouped ordering (Phase 2), consecutive tool_calls are followed
		// by consecutive tool_results:
		//   [tool_call_A, tool_call_B, tool_result_A, tool_result_B]
		// We scan each run of tool_calls, collect the subsequent tool_results,
		// and match by tool_call_id.  Unmatched tool_calls get synthetic results.
		const repaired: ChatMessage[] = [];
		let i = 0;
		while (i < chatMessages.length) {
			const msg = chatMessages[i]!;

			// Not a tool_call — pass through
			if (msg.role !== "tool_call" || !msg.tool_calls?.length) {
				repaired.push(msg);
				i++;
				continue;
			}

			// Collect the run of consecutive tool_call messages
			const toolCallRun: ChatMessage[] = [];
			while (i < chatMessages.length && chatMessages[i]!.role === "tool_call" && chatMessages[i]!.tool_calls?.length) {
				toolCallRun.push(chatMessages[i]!);
				i++;
			}

			// Collect the run of consecutive tool_result messages that follow
			const toolResultRun: ChatMessage[] = [];
			while (i < chatMessages.length && chatMessages[i]!.role === "tool_result" && chatMessages[i]!.tool_results?.length) {
				toolResultRun.push(chatMessages[i]!);
				i++;
			}

			// Build a set of tool_call_ids that have matching results
			const matchedIds = new Set(
				toolResultRun.flatMap((r) => r.tool_results!.map((tr) => tr.tool_call_id))
			);

			// Emit all tool_calls
			for (const tc of toolCallRun) {
				repaired.push(tc);
			}

			// Emit all existing tool_results
			for (const tr of toolResultRun) {
				repaired.push(tr);
			}

			// Inject synthetic results for any unmatched tool_calls
			for (const tc of toolCallRun) {
				for (const tcData of tc.tool_calls!) {
					if (!matchedIds.has(tcData.id)) {
						repaired.push({
							role: "tool_result",
							content: "",
							tool_results: [
								{
									tool_call_id: tcData.id,
									tool_name: tcData.tool_name,
									result: "Tool call was cancelled by the user.",
									is_error: true,
								},
							],
						});
						log.warn("Injected synthetic tool_result for orphaned tool_call", {
							toolName: tcData.tool_name,
							toolCallId: tcData.id,
						});
					}
				}
			}
		}

		// Phase 3: Coalesce consecutive tool_call/tool_result messages into
		// single messages with arrays, matching the provider-expected format
		// (one assistant message with N tool_use blocks, one user message with
		// N tool_result blocks).
		const coalesced: ChatMessage[] = [];
		let j = 0;
		while (j < repaired.length) {
			const msg = repaired[j]!;

			if (msg.role === "tool_call" && msg.tool_calls?.length) {
				// Look back: if the preceding coalesced message is an assistant
				// message (pre-tool-call text + token carrier), absorb its content
				// into the coalesced tool_call message.
				let preToolCallText = "";
				const prev = coalesced[coalesced.length - 1];
				if (prev && prev.role === "assistant" && !prev.tool_calls) {
					preToolCallText = typeof prev.content === "string"
						? prev.content
						: (() => { throw new Error("Expected string content for assistant message"); })();
					coalesced.pop(); // absorb into the coalesced message
				}

				// Collect all consecutive tool_call entries
				const allToolCalls: ChatMessage["tool_calls"] = [];
				while (j < repaired.length && repaired[j]!.role === "tool_call" && repaired[j]!.tool_calls?.length) {
					allToolCalls.push(...repaired[j]!.tool_calls!);
					j++;
				}

				coalesced.push({
					role: "tool_call",
					content: preToolCallText,
					tool_calls: allToolCalls,
				});
				continue;
			}

			if (msg.role === "tool_result" && msg.tool_results?.length) {
				// Collect all consecutive tool_result entries
				const allToolResults: ChatMessage["tool_results"] = [];
				while (j < repaired.length && repaired[j]!.role === "tool_result" && repaired[j]!.tool_results?.length) {
					allToolResults.push(...repaired[j]!.tool_results!);
					j++;
				}

				coalesced.push({
					role: "tool_result",
					content: "",
					tool_results: allToolResults,
				});
				continue;
			}

			coalesced.push(msg);
			j++;
		}

		log.info("ChatMessages built for provider", {
			totalCount: coalesced.length,
			firstRole: coalesced[0]?.role ?? "none",
			secondRole: coalesced[1]?.role ?? "none",
			lastRole: coalesced[coalesced.length - 1]?.role ?? "none",
			roles: coalesced.map((m) => m.role),
		});

		return coalesced;
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
				case "MODEL_NOT_FOUND":
					suggestion = " Check that a model is selected in the model picker, or verify the model ID in Settings → Notor.";
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

	private getActiveUseExtendedContext(): boolean {
		const providerType = this.providerRegistry.getActiveType();
		const config = this.providerRegistry.getConfig(providerType);
		return config?.use_extended_context ?? false;
	}

	private calculateCost(inputTokens: number, outputTokens: number, modelId?: string): number | null {
		const resolvedModelId = modelId ?? this.getActiveModelId();

		// Check user-configured pricing first
		const userPricing = this.settings.model_pricing[resolvedModelId] as ModelPricing | undefined;
		if (userPricing) {
			return (
				(inputTokens / 1000) * userPricing.input +
				(outputTokens / 1000) * userPricing.output
			);
		}

		// Fall back to static metadata pricing
		const metadata = getModelMetadata(resolvedModelId);
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
					void this.view?.finalizeAssistantMessage(el, message);
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
	| { type: "tool_calls"; calls: ToolCallInfo[]; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "cancelled"; text: string; inputTokens: number; outputTokens: number; contentEl?: HTMLElement }
	| { type: "error"; error: string; text: string; inputTokens: number; outputTokens: number };
