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
import type { Conversation, ConversationMode, Message, Persona, ToolResult, WorkflowExecution, ExecutionChain, LLMProviderType } from "../types";
import type { ChatMessage, ToolDefinition, StreamChunk, SendMessageOptions } from "../providers/provider";
import { ProviderError } from "../providers/provider";
import type { ProviderRegistry } from "../providers/index";
import { ConversationManager } from "./conversation";
import { ContextManager } from "./context";
import type { SystemPromptBuilder } from "./system-prompt";
import type { ToolDispatcher } from "./dispatcher";
import { partitionToolCalls, executeToolBatches, type ToolCallInfo } from "./tool-orchestration";
import { parseStreamEvents } from "./stream-utils";
import { toChatMessages, processStream, calculateCost, type StreamResult } from "./message-pipeline";
import { ConfigResolver } from "./config-resolver";
import { HookDispatcher } from "./hook-dispatcher";
import { CompactionManager } from "./compaction-manager";
import { ViewRouter } from "./view-router";
import { SessionManager } from "./session-manager";
import { ConversationLifecycleManager } from "./conversation-lifecycle";
import type { HistoryManager } from "./history";
import type { NotorChatView } from "../ui/chat-view";
import type { NotorSettings } from "../settings";
import type { VaultRuleManager } from "../rules/vault-rules";
import type { PersonaManager } from "../personas/persona-manager";
import { buildAutoContextBlock } from "../context/auto-context";
import { assembleUserMessage, assembleUserContent } from "../context/message-assembler";
import type { Attachment } from "../context/attachment";
import { resolveAttachment, buildAttachmentsBlock } from "../context/attachment";
import type { LifecycleAutomationAccessors, ToolEventAutomationAccessors } from "../hooks/hook-events";
import type { WorkflowHookOverrideManager } from "../hooks/workflow-hook-override";
import { revertWorkflowPersona, switchWorkflowPersona, assembleWorkflowPrompt } from "../workflows/workflow-executor";
import type { Workflow, WorkflowExecutionRequest, WorkflowAssemblyResult, VaultRule } from "../types";
import type { WorkflowConcurrencyManager } from "../workflows/workflow-concurrency";
import type { EffectiveToolConfig, ParsedToolConfig } from "../tool-config/types";
import { ConversationSession } from "./conversation-session";
import type { ApprovalCallback } from "./dispatcher";
import type { ToolSessionContext } from "../tools/tool";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { logger } from "../utils/logger";

const log = logger("ChatOrchestrator");

/**
 * Cross-orchestrator session guard — prevents two orchestrators from
 * creating sessions for the same conversation concurrently.
 *
 * Implemented by the plugin class (`main.ts`) and passed to each
 * orchestrator at construction time.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.3
 */
export interface SessionGuard {
	/** Check whether a conversation ID has an active session in any orchestrator. */
	isActive(conversationId: string): boolean;
	/** Register a conversation ID as having an active session. */
	register(conversationId: string): void;
	/** Unregister a conversation ID when its session ends. */
	unregister(conversationId: string): void;
}

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
export class ChatOrchestrator implements ToolSessionContext {
	private conversationManager: ConversationManager;
	private contextManager: ContextManager;
	private readonly configResolver: ConfigResolver;
	private readonly hookDispatcher: HookDispatcher;
	private readonly compactionManager: CompactionManager;
	private readonly viewRouter: ViewRouter;
	private readonly sessionManager: SessionManager;
	private readonly lifecycle: ConversationLifecycleManager;

	/** Proxy getter — delegates to ViewRouter. All `this.view?.` references resolve through here. */
	private get view(): NotorChatView | undefined {
		return this.viewRouter.getView();
	}

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
	 * Per-orchestrator checkpoint manager.
	 *
	 * Each orchestrator (and thus each panel) gets its own CheckpointManager
	 * that tracks the conversation scope internally. Replaces the former
	 * plugin-level singleton.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Amendment A1
	 */
	private checkpointManager?: CheckpointManager;

	/**
	 * Per-orchestrator active provider type.
	 *
	 * Each orchestrator (and thus each panel in multi-panel mode) tracks
	 * its own active provider. Initialized from `ProviderRegistry.getActiveType()`
	 * at construction time. Picker changes update this field, NOT the global
	 * `ProviderRegistry.activeType`.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	private activeProviderType: LLMProviderType;

	/**
	 * Per-orchestrator active model ID.
	 *
	 * Tracks the current model for this panel. Updated when the user changes
	 * the model picker. Used as the default for new conversations and sessions
	 * created from this panel.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	private activeModelId: string;

	/**
	 * Per-orchestrator extended context setting.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	private activeUseExtendedContext: boolean;


	constructor(
		private readonly app: App,
		private readonly providerRegistry: ProviderRegistry,
		private readonly systemPromptBuilder: SystemPromptBuilder,
		private readonly dispatcher: ToolDispatcher,
		private readonly historyManager: HistoryManager,
		private settings: NotorSettings,
		private readonly sessionGuard: SessionGuard,
		view?: NotorChatView,
		private readonly vaultRuleManager?: VaultRuleManager
	) {
		this.conversationManager = new ConversationManager(settings.mode);
		this.contextManager = new ContextManager();
		this.configResolver = new ConfigResolver(settings, systemPromptBuilder, dispatcher);
		this.viewRouter = new ViewRouter(
			() => this.conversationManager.getActiveConversation()?.id,
		);
		if (view) {
			this.viewRouter.setView(view);
		}
		this.hookDispatcher = new HookDispatcher(
			() => this.settings,
			() => this.getVaultRootPath(),
			() => this.workflowHookOverrideManager,
			() => this.extensionLifecycleAccessors,
			() => this.extensionToolEventAccessors,
		);
		this.sessionManager = new SessionManager(
			this.sessionGuard,
			this.historyManager,
			() => this.workflowHookOverrideManager,
		);

		// Initialize per-orchestrator provider/model from current global state
		const initProviderType = this.providerRegistry.getActiveType();
		const initProviderConfig = this.providerRegistry.getConfig(initProviderType);
		this.activeProviderType = initProviderType;
		this.activeModelId = initProviderConfig?.model_id ?? "";
		this.activeUseExtendedContext = initProviderConfig?.use_extended_context ?? false;

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

		this.compactionManager = new CompactionManager(
			() => this.settings,
			this.providerRegistry,
			this.historyManager,
			() => this.conversationManager,
			() => this.view,
			(session) => this.getViewForSession(session),
			() => this.activeModelId,
			() => this.activeUseExtendedContext,
		);
		this.lifecycle = new ConversationLifecycleManager(
			() => this.settings,
			this.historyManager,
			() => this.conversationManager,
			this.viewRouter,
			this.sessionManager,
			this.configResolver,
			() => this.personaManager,
			() => this.checkpointManager,
			() => this.activeProviderType,
			() => this.activeModelId,
			() => this.activeUseExtendedContext,
		);
	}

	// -----------------------------------------------------------------------
	// Configuration
	// -----------------------------------------------------------------------

	/**
	 * Set or update the chat view reference.
	 *
	 * Pass `undefined` to detach the view (e.g. on panel close).
	 * All view interactions throughout the orchestrator use `this.view?.`
	 * optional chaining, so detaching is safe at any point.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 7.2
	 */
	setView(view: NotorChatView | undefined): void {
		this.viewRouter.setView(view);
	}

	/** Get the current view reference (if any). */
	getView(): NotorChatView | undefined {
		return this.viewRouter.getView();
	}

	/**
	 * Per-orchestrator approval callback for tool dispatch.
	 *
	 * Each orchestrator (and thus each panel) gets its own approval callback
	 * bound to the correct panel's view. Replaces the former global
	 * `ToolDispatcher.setApprovalCallback()` — that shared field is not
	 * safe for multi-panel use since each panel needs its own routing.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4e
	 */
	private panelApprovalCallback?: ApprovalCallback;

	/**
	 * Set the approval callback for this orchestrator's panel.
	 *
	 * Called by `wireView()` in main.ts. Sessions snapshot this callback
	 * at creation time.
	 */
	setApprovalCallback(callback: ApprovalCallback): void {
		this.panelApprovalCallback = callback;
	}

	/** Update settings reference. */
	updateSettings(settings: NotorSettings): void {
		this.settings = settings;
		this.dispatcher.setAutoApprove(settings.auto_approve);
		this.configResolver.updateSettings(settings);
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
	 * Set the per-orchestrator checkpoint manager.
	 *
	 * Called by `createOrchestrator()` in main.ts. Each orchestrator manages
	 * its own checkpoint scope internally via conversation lifecycle methods.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Amendment A1
	 */
	setCheckpointManager(manager: CheckpointManager): void {
		this.checkpointManager = manager;
	}

	/**
	 * Get the per-orchestrator checkpoint manager.
	 *
	 * Used by wireView() to bind checkpoint list/restore/getCurrentContent
	 * callbacks to the correct per-orchestrator manager.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Amendment A1
	 */
	getCheckpointManager(): CheckpointManager | undefined {
		return this.checkpointManager;
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
		this.lifecycle.setWorkflowPersonaRevert(previousPersona);
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
		return this.configResolver.getEffectiveToolConfig();
	}

	/**
	 * Get the parsed tool configs contributing to the current effective config.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-004
	 */
	getActiveParsedConfigs(): ParsedToolConfig[] {
		return this.configResolver.getActiveParsedConfigs();
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
		return this.sessionManager.getActiveSession(conversationId);
	}

	getActiveSessions(): ConversationSession[] {
		return this.sessionManager.getActiveSessions();
	}

	hasActiveSession(conversationId: string): boolean {
		return this.sessionManager.hasActiveSession(conversationId);
	}

	onSessionsChanged(callback: () => void): () => void {
		return this.sessionManager.onSessionsChanged(callback);
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
		return this.viewRouter.getViewForSession(session);
	}

	/**
	 * Get the currently displayed conversation (from the UI display manager).
	 *
	 * Used by picker-change callbacks in main.ts to update the conversation
	 * header when the user changes provider/model/persona while viewing a
	 * conversation.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1f-addendum
	 */
	getDisplayedConversation(): Conversation | null {
		return this.conversationManager.getActiveConversation();
	}

	/**
	 * ToolSessionContext implementation — returns the orchestrator's display
	 * ConversationManager's active conversation.
	 *
	 * Note: This reads the orchestrator's **display** ConversationManager, not
	 * the session's isolated one. If the user switches conversations mid-session,
	 * this returns the new displayed conversation. A future refactor could target
	 * `session.conversationManager` instead for true session isolation.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — A4.4b
	 */
	getActiveConversation(): Conversation | null {
		return this.conversationManager.getActiveConversation();
	}

	// -----------------------------------------------------------------------
	// Lifecycle — teardown
	// -----------------------------------------------------------------------

	/**
	 * Abort all active sessions and await their cleanup.
	 *
	 * Called from `main.ts` `onunload()` when the plugin is disabled,
	 * hot-reloaded, or Obsidian closes. Best-effort: awaits response loop
	 * completion up to `timeoutMs` so that JSONL writes can flush, then
	 * clears the session map regardless.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1h
	 */
	async destroy(timeoutMs: number = 2000): Promise<void> {
		return this.sessionManager.destroy(timeoutMs);
	}

	// -----------------------------------------------------------------------
	// Conversation lifecycle (extracted to src/chat/conversation-lifecycle.ts — B3)
	// -----------------------------------------------------------------------

	async newConversation(opts?: { signal?: AbortSignal }): Promise<void> {
		return this.lifecycle.newConversation(opts);
	}

	async forkConversation(forkAtMessageId: string): Promise<{ filename: string; conversation: Conversation } | null> {
		return this.lifecycle.forkConversation(forkAtMessageId);
	}

	async switchConversation(filename: string, opts?: { signal?: AbortSignal }): Promise<void> {
		return this.lifecycle.switchConversation(filename, opts);
	}

	async switchToConversationById(conversationId: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
		return this.lifecycle.switchToConversationById(conversationId, opts);
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
		// Use per-orchestrator provider/model (Phase 4, Step 4b).
		const providerType = this.activeProviderType;
		const providerConfig = this.providerRegistry.getConfig(providerType);
		const modelId = this.activeModelId;
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
			this.setWorkflowPersonaRevert(undefined);
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

		// Session guards: prevent duplicate sessions per-orchestrator and cross-orchestrator
		const guardError = this.sessionManager.checkSessionGuards(conversation.id);
		if (guardError) {
			new Notice(guardError);
			return;
		}

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
			await this.configResolver.resolveEffectiveConfig(undefined, assemblyResult, pinnedPersona);

		const approvalCallback: ApprovalCallback = this.panelApprovalCallback
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

		this.sessionManager.registerSession(session);

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
			if (session.status === "running" || session.status === "waiting_approval") {
				session.setStatus("completed");
			}
			// Drain pending JSONL writes for THIS conversation before removing the session.
			try {
				const conv = session.conversationManager.getActiveConversation();
				if (conv) {
					await this.historyManager.flushConversation(conv);
				}
			} catch {
				// Best-effort — don't block session cleanup on write errors
			}
			// G-005: Deactivate workflow-scoped hook overrides on all exit paths.
			// deactivate() is idempotent — safe if destroy() also calls it.
			if (session.workflowAssembly && this.workflowHookOverrideManager) {
				this.workflowHookOverrideManager.deactivate(session.conversationId);
			}
			this.sessionManager.unregisterSession(session.conversationId);
			this.getViewForSession(session)?.setRespondingState(false);
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
			await this.configResolver.resolveEffectiveConfig(undefined, workflowAssembly, pinnedPersona);

		// Capture approval callback for session-scoped dispatch
		const approvalCallback = this.panelApprovalCallback
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
				await this.configResolver.resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona);
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
			const chatMessages = toChatMessages(
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
					this, // sessionContext (A4.4e)
				);
				toolResult.tool_call_id = toolCallId;

				// Restore running status after approval/execution
				if (!isAutoApproved) {
					concurrencyManager.updateStatus(execution.id, "running");
				}

				// Dispatch hook events if applicable
				const bgConvForHooks = bgConvManager.getActiveConversation();
				if (bgConvForHooks) {
					this.hookDispatcher.dispatchToolCallHook(bgConvForHooks.id, toolName, parameters);
					this.hookDispatcher.dispatchToolResultHook(bgConvForHooks.id, toolName, parameters, toolResult);
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
	 * Set the callback that provides tool definitions for the response loop.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-015
	 * @see specs/04b-tool-toggle/tasks.md — MAIN-001
	 */
	setGetToolDefinitions(callback: (config?: EffectiveToolConfig) => import("../providers/provider").ToolDefinition[]): void {
		this.configResolver.setGetToolDefinitions(callback);
	}

	// -----------------------------------------------------------------------
	// Tool config resolution (extracted to src/chat/config-resolver.ts — B4)
	// -----------------------------------------------------------------------

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

		// Session guards: prevent duplicate sessions per-orchestrator and cross-orchestrator
		const guardError = this.sessionManager.checkSessionGuards(conv.id);
		if (guardError) {
			new Notice(guardError);
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
		let hookInjections: string[] | undefined;
		{
			hookInjections = await this.hookDispatcher.dispatchPreSendHooks(conv.id);
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

		// Snapshot persona, provider, model, extended context.
		//
		// Step 1f: Pin from the conversation header's stored values when available
		// (restored conversation), so continuing an old conversation uses the same
		// provider/model it was using before. Fall back to global state for new
		// conversations or if the stored provider is no longer configured.
		const pinnedPersona = this.personaManager?.getActivePersona() ?? null;

		const headerProviderType = snapshotConv.provider_id as LLMProviderType | undefined;
		const headerProviderConfig = headerProviderType
			? this.providerRegistry.getConfig(headerProviderType)
			: null;
		// Fall back to per-orchestrator provider (not global registry) for new
		// conversations or when the header's provider is no longer configured.
		const providerType = headerProviderConfig
			? headerProviderType!
			: this.activeProviderType;
		const providerConfig = headerProviderConfig ?? this.providerRegistry.getConfig(providerType);

		// Use the header's model_id if the header's provider is still configured,
		// otherwise fall back to per-orchestrator model.
		const modelId = headerProviderConfig
			? (snapshotConv.model_id || (providerConfig?.model_id ?? ""))
			: this.activeModelId;
		const useExtendedContext = headerProviderConfig
			? (snapshotConv.use_extended_context ?? false)
			: this.activeUseExtendedContext;

		// Resolve initial effective config
		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.configResolver.resolveEffectiveConfig(undefined, null, pinnedPersona);

		// Capture the approval callback from this orchestrator's panel.
		// This binds approval prompts to the correct panel's view.
		const approvalCallback: ApprovalCallback = this.panelApprovalCallback
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
		this.sessionManager.registerSession(session);

		// Step 1f-addendum (Trigger 1): Update conversation header if the
		// pinned values differ from what's stored (e.g. user changed provider
		// via picker since the conversation was last used).
		const sessionConv = sessionConvManager.getActiveConversation()!;
		const headerDirty =
			sessionConv.persona_name !== (pinnedPersona?.name ?? null) ||
			sessionConv.provider_id !== providerType ||
			sessionConv.model_id !== modelId;
		if (headerDirty) {
			sessionConv.persona_name = pinnedPersona?.name ?? null;
			sessionConv.provider_id = providerType;
			sessionConv.model_id = modelId;
			await this.historyManager.updateConversationHeader(sessionConv);
		}

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
			// Drain pending JSONL writes for THIS conversation before removing the session.
			// The sync-back path in switchConversation() checks activeSessions to decide
			// whether to use session state or JSONL — if we delete the session before writes
			// flush, sync-back falls through to JSONL which may be incomplete.
			try {
				const conv = session.conversationManager.getActiveConversation();
				if (conv) {
					await this.historyManager.flushConversation(conv);
				}
			} catch {
				// Best-effort — don't block session cleanup on write errors
			}
			// Workflow hook deactivation is intentionally absent here because
			// handleUserMessage() always creates sessions with workflowAssembly: null
			// (verified: orchestrator.ts session creation). No code path through
			// handleUserMessage() sets a non-null workflowAssembly — that field is
			// only populated by executeWorkflow(). See executeWorkflow()'s finally
			// block which handles the workflow case.
			this.sessionManager.unregisterSession(session.conversationId);
			this.getViewForSession(session)?.setRespondingState(false);
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
				await this.compactionManager.checkAndPerformCompaction(session);

				// 1. Evaluate vault rules (re-evaluated each turn after tool calls)
				const matchedRules = this.vaultRuleManager
					? await this.vaultRuleManager.getMatchedRules()
					: undefined;

				// 1b. Resolve effective tool config (extracts tool configs from
				// persona + rules + workflow, merges, and returns filtered tool definitions)
				const { effective, toolDefinitions, parsedConfigs } = await this.configResolver.resolveEffectiveConfig(
					matchedRules,
					session.workflowAssembly,
					session.pinnedPersona,
				);
				session.effectiveConfig = effective;
				session.parsedConfigs = parsedConfigs;

				// Update display config only if this session matches the displayed conversation
				if (this.getViewForSession(session)) {
					this.configResolver.updateDisplayConfig(effective, parsedConfigs);
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
				const chatMessages = toChatMessages(contextResult.messages, systemPrompt);

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
				const result = await processStream(
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
						cost_estimate: calculateCost(result.inputTokens, result.outputTokens, session.modelId, this.settings),
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
							cost_estimate: calculateCost(result.inputTokens, result.outputTokens, session.modelId, this.settings),
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

						// HOOK-005: Fire on_tool_call hooks
						const currentConv = convManager.getActiveConversation();
						if (currentConv) {
							this.hookDispatcher.dispatchToolCallHook(currentConv.id, call.toolName, call.parameters);
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
						this, // sessionContext (A4.4e)
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

						// HOOK-005: Fire on_tool_result hooks
						const convForToolResult = convManager.getActiveConversation();
						if (convForToolResult) {
							this.hookDispatcher.dispatchToolResultHook(
								convForToolResult.id, entry.call.toolName, entry.call.parameters, toolResult,
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
			const completionConvId = convManager.getActiveConversation()?.id
				?? this.conversationManager.getActiveConversation()?.id;
			this.hookDispatcher.dispatchAfterCompletionHooks(completionConvId);
		}
	}


	// -----------------------------------------------------------------------
	// Compaction (extracted to src/chat/compaction-manager.ts — B6)
	// -----------------------------------------------------------------------

	/** Manually trigger context compaction. */
	async manualCompaction(): Promise<void> {
		return this.compactionManager.manualCompaction();
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
		return this.activeModelId;
	}

	private getActiveUseExtendedContext(): boolean {
		return this.activeUseExtendedContext;
	}

	/**
	 * Get the per-orchestrator active provider type.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	getActiveProviderType(): LLMProviderType {
		return this.activeProviderType;
	}

	/**
	 * Update the per-orchestrator provider/model fields.
	 *
	 * Called from `wireView()` picker-change callbacks. Each panel's picker
	 * updates its own orchestrator instead of the global `ProviderRegistry`.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	setActiveProvider(providerType: LLMProviderType): void {
		this.activeProviderType = providerType;
		const config = this.providerRegistry.getConfig(providerType);
		this.activeModelId = config?.model_id ?? "";
		this.activeUseExtendedContext = config?.use_extended_context ?? false;
	}

	/**
	 * Update the per-orchestrator model and extended context fields.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	setActiveModel(modelId: string, useExtendedContext: boolean): void {
		this.activeModelId = modelId;
		this.activeUseExtendedContext = useExtendedContext;
	}


	/** Render a message in the view based on its role. */
	private renderMessage(message: Message): void {
		this.viewRouter.renderMessage(message);
	}
}

