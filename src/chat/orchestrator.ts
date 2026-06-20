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
import type { Conversation, ConversationMode, Message, Persona, TaskItem, ToolResult, WorkflowExecution, WorkflowAssemblyResult, ExecutionChain } from "../types";
import type { SendMessageOptions } from "../providers/provider";
import { ProviderError } from "../providers/provider";
import type { ProviderRegistry } from "../providers/index";
import { ConversationManager } from "./conversation";
import { ContextManager } from "./context";
import type { SystemPromptBuilder } from "./system-prompt";
import type { ToolDispatcher } from "./dispatcher";
import { partitionToolCalls, executeToolBatches, type ToolCallInfo } from "./tool-orchestration";
import { toChatMessages, processStream, calculateCost } from "./message-pipeline";
import { supportsThinking } from "../providers/model-metadata";
import { ConfigResolver } from "./config-resolver";
import { HookDispatcher } from "./hook-dispatcher";
import { CompactionManager } from "./compaction-manager";
import { ViewRouter } from "./view-router";
import { SessionManager } from "./session-manager";
import { ConversationLifecycleManager } from "./conversation-lifecycle";
import { WorkflowExecutor } from "./workflow-executor";
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
import { dispatchOnConversationStart } from "../hooks/hook-events";
import type { WorkflowHookOverrideManager } from "../hooks/workflow-hook-override";
import type { Workflow, WorkflowExecutionRequest } from "../types";
import type { WorkflowConcurrencyManager } from "../workflows/workflow-concurrency";
import type { EffectiveToolConfig, ParsedToolConfig } from "../tool-config/types";
import { ConversationSession } from "./conversation-session";
import type { ApprovalCallback, InteractionCallback } from "./dispatcher";
import type { ToolSessionContext } from "../tools/tool";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import type { StaleContentTracker } from "./stale-tracker";
import { logger } from "../utils/logger";
import { resolveNote } from "../utils/resolve-note";
import { estimateTokenCount } from "../utils/tokens";
import type { ChatBlockRegistry } from "../ui/chat-blocks/registry";
import type { TemplateVariableRegistry } from "../template-vars";

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
	private readonly workflowExecutor: WorkflowExecutor;

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
	private sharedCheckpointManagerGetter?: () => CheckpointManager | undefined;
	private staleTrackerGetter?: () => StaleContentTracker;

	/** Chat block registry — injected from main.ts for Phase 10 tool content_block bridging. */
	private chatBlockRegistry?: ChatBlockRegistry;

	/**
	 * Per-orchestrator active provider instance ID.
	 *
	 * Each orchestrator (and thus each panel in multi-panel mode) tracks
	 * its own active provider. Initialized from `ProviderRegistry.getActiveId()`
	 * at construction time. Picker changes update this field, NOT the global
	 * registry active ID.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	private activeProviderId: string;

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

	/** Per-orchestrator thinking/reasoning level (null = off). */
	private activeThinkingLevel: string | null = null;

	/** Per-orchestrator active persona (null = no persona). */
	private activePersona: Persona | null = null;

	/**
	 * Per-orchestrator active preset name.
	 *
	 * Tracks the currently selected preset for this panel, or null if
	 * "Custom" mode is active. Used for conversation header pinning and
	 * display-restore on conversation switch.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 6
	 */
	private activePresetName: string | null = null;


	constructor(
		private readonly app: App,
		private readonly providerRegistry: ProviderRegistry,
		private readonly systemPromptBuilder: SystemPromptBuilder,
		private readonly dispatcher: ToolDispatcher,
		private readonly historyManager: HistoryManager,
		private settings: NotorSettings,
		private readonly sessionGuard: SessionGuard,
		view?: NotorChatView,
		private readonly vaultRuleManager?: VaultRuleManager,
		private readonly templateRegistry?: TemplateVariableRegistry,
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
		const initProviderId = this.providerRegistry.getActiveId();
		const initProviderConfig = this.providerRegistry.getConfig(initProviderId);
		this.activeProviderId = initProviderId;
		this.activeModelId = initProviderConfig?.model_id ?? "";
		this.activeUseExtendedContext = initProviderConfig?.use_extended_context ?? false;

		// Initialize thinking level from default preset
		const defaultPreset = this.settings.model_presets?.find(
			(p) => p.name === this.settings.default_preset,
		);
		if (defaultPreset?.thinking_level) {
			this.activeThinkingLevel = defaultPreset.thinking_level;
		}

		// Wire conversation manager to history persistence + live render for direct emits
		this.conversationManager.setOnMessageAdded(async (message: Message) => {
			// Render before async disk I/O so extension blocks appear in DOM order,
			// before the LLM response, rather than after the JSONL write resolves.
			// Guard against double-render for transient blocks already shown by emitLoadingBlock.
			if (message.role === "extension_block" && !this.view?.hasMessageElement(message.id)) {
				this.viewRouter.renderMessage(message);
			}
			const conv = this.conversationManager.getActiveConversation();
			if (conv) {
				await this.historyManager.appendMessage(conv, message);
			}
		});

		this.conversationManager.setOnMessageUpdated((message) => {
			if (message.role === "extension_block") {
				this.view?.reRenderExtensionBlock(message);
			}
		});

		this.conversationManager.setOnConversationChanged(async (conv) => {
			await this.historyManager.updateConversationHeader(conv);
		});

		this.conversationManager.setOnTitleChanged((conversationId, title) => {
			this.view?.updateConversationTitleInList(conversationId, title);
			this.view?.updateHeaderTitle(conversationId, title);
			// Propagate title to active session so its header writes don't clobber
			// the new title. The session has a snapshot taken before the automation
			// completed, so without this its onConversationChanged writes would
			// overwrite the title set by the automation.
			const session = this.sessionManager.getActiveSession(conversationId);
			if (session) {
				const sessionConv = session.conversationManager.getActiveConversation();
				if (sessionConv && sessionConv.title !== title) {
					session.conversationManager.setTitle(title);
				}
			}
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
			() => this.activeProviderId,
			() => this.activeModelId,
			() => this.activeUseExtendedContext,
			(id) => { this.activeProviderId = id; },
			(modelId) => { this.activeModelId = modelId; },
			(useExtended) => { this.activeUseExtendedContext = useExtended; },
			(level) => { this.activeThinkingLevel = level; },
			() => this.activePresetName,
			(name) => { this.activePresetName = name; },
			(providerId) => !!this.providerRegistry.getConfig(providerId) || !!this.providerRegistry.resolveTypeToId(providerId),
			() => this.activePersona,
			(persona) => { this.activePersona = persona; },
			() => this.sharedCheckpointManagerGetter?.(),
			(filename) => this.switchConversation(filename),
			() => this.staleTrackerGetter?.(),
		);
		this.workflowExecutor = new WorkflowExecutor({
			app: this.app,
			providerRegistry: this.providerRegistry,
			systemPromptBuilder: this.systemPromptBuilder,
			dispatcher: this.dispatcher,
			historyManager: this.historyManager,
			sessionManager: this.sessionManager,
			configResolver: this.configResolver,
			hookDispatcher: this.hookDispatcher,
			viewRouter: this.viewRouter,
			getSettings: () => this.settings,
			getPersonaManager: () => this.personaManager,
			getWorkflowHookOverrideManager: () => this.workflowHookOverrideManager,
			getVaultRuleManager: () => this.vaultRuleManager,
			getPanelApprovalCallback: () => this.panelApprovalCallback,
			getPanelInteractionCallback: () => this.panelInteractionCallback,
			getConversationManager: () => this.conversationManager,
			getActiveProviderId: () => this.activeProviderId,
			getActiveModelId: () => this.activeModelId,
			getActiveUseExtendedContext: () => this.activeUseExtendedContext,
			getActivePersona: () => this.activePersona,
			setActivePersona: (persona) => { this.activePersona = persona; },
			getVaultRootPath: () => this.getVaultRootPath(),
			getTemplateRegistry: () => this.templateRegistry,
			getSessionContext: () => this,
			runResponseLoop: (mode, session) => this.responseLoop(mode, session),
			setWorkflowPersonaRevert: (prev) => this.setWorkflowPersonaRevert(prev),
			handleError: (e) => this.handleError(e),
		});
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

	/**
	 * Per-orchestrator interaction callback for tool dispatch (e.g. follow-up
	 * questions). Bound to this panel's view, mirroring `panelApprovalCallback`.
	 * Sessions snapshot it at creation time.
	 */
	private panelInteractionCallback?: InteractionCallback;

	/** Set the interaction callback for this orchestrator's panel. */
	setInteractionCallback(callback: InteractionCallback): void {
		this.panelInteractionCallback = callback;
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
		// Initialize per-panel persona from global default
		this.activePersona = manager.getActivePersona();
	}

	getActivePersona(): Persona | null {
		return this.activePersona;
	}

	setActivePersona(persona: Persona | null): void {
		this.activePersona = persona;
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

	setSharedCheckpointManager(getter: () => CheckpointManager | undefined): void {
		this.sharedCheckpointManagerGetter = getter;
	}

	setStaleTracker(getter: () => StaleContentTracker): void {
		this.staleTrackerGetter = getter;
	}

	/** Inject the ChatBlockRegistry for Phase 10 tool content_block → extension_block bridging. */
	setChatBlockRegistry(registry: ChatBlockRegistry): void {
		this.chatBlockRegistry = registry;
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

	setConversationTasks(tasks: TaskItem[] | null): void {
		this.conversationManager.setTasks(tasks);
		this.view?.renderTaskPanel(tasks);
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
	// Workflow execution — delegated to WorkflowExecutor (Phase B5)
	// -----------------------------------------------------------------------

	/** @see WorkflowExecutor.executeWorkflow */
	async executeWorkflow(workflow: Workflow, supplementaryText = ""): Promise<void> {
		return this.workflowExecutor.executeWorkflow(workflow, supplementaryText);
	}

	/** @see WorkflowExecutor.executeBackgroundWorkflow */
	async executeBackgroundWorkflow(
		request: WorkflowExecutionRequest,
		execution: WorkflowExecution,
		chain: ExecutionChain,
		concurrencyManager: WorkflowConcurrencyManager,
		personaSwitchResult: { switched: boolean; previousPersona: string | null }
	): Promise<void> {
		return this.workflowExecutor.executeBackgroundWorkflow(
			request, execution, chain, concurrencyManager, personaSwitchResult
		);
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
				}, this.providerRegistry.getActiveType());
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

		// Record vault attachment paths for rule trigger evaluation
		if (this.vaultRuleManager && resolvedAttachments.length > 0) {
			for (const att of resolvedAttachments) {
				if (att.status === "resolved" && (
					att.type === "vault_note" ||
					att.type === "vault_note_section" ||
					att.type === "vault_image" ||
					att.type === "vault_pdf"
				)) {
					this.vaultRuleManager.recordNoteAccess(att.path);
				}
			}
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

		// Fire on_conversation_start trigger for the first user message.
		// Blocking automations are awaited here so their emitted blocks land in the
		// session snapshot below. Non-blocking automations remain fire-and-forget.
		// Detect "first": only non-hook user messages exist, and this is the first one.
		{
			const allMessages = this.conversationManager.getMessages();
			const userMessages = allMessages.filter(
				(m) => m.role === "user" && !m.is_hook_injection
			);
			log.debug("on_conversation_start check", {
				totalMessages: allMessages.length,
				userMessages: userMessages.length,
				hasAccessors: !!this.extensionLifecycleAccessors,
			});
			if (userMessages.length === 1) {
				// Show the responding state immediately so the user sees feedback while
				// blocking automations (e.g. memory-search) run before the LLM call.
				this.view?.setRespondingState(true);
				await dispatchOnConversationStart(
					{
						conversationId: conv.id,
						firstMessage: content,
						timestamp: new Date().toISOString(),
					},
					this.extensionLifecycleAccessors,
					{
						emitLoadingBlock: (kind) => {
							const msg = this.conversationManager.addMessage({
								role: "extension_block",
								content: [{ type: "custom_block", kind, data: {}, loading: true }],
								source_extension: null,
								exclude_from_compaction: true,
								transient: true,
							});
							// Render the loading placeholder immediately into the chat thread.
							this.viewRouter.renderMessage(msg);
							return msg;
						},
						resolveLoadingBlock: (messageId) => {
							// The loading block will be replaced via chatBlocks.emit() in the
							// automation code (Task 8.5). This callback is a no-op signal that
							// the automation completed normally (not timed out).
							log.debug("on_conversation_start blocking automation resolved", { messageId });
						},
					},
				);
			}
		}

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
		const pinnedPersona = this.activePersona;

		const headerProviderId = snapshotConv.provider_id as string | undefined;
		let headerProviderConfig = headerProviderId
			? this.providerRegistry.getConfig(headerProviderId)
			: null;
		// Backward compat: if the header stores a bare type, resolve to first instance
		if (!headerProviderConfig && headerProviderId) {
			const resolvedId = this.providerRegistry.resolveTypeToId(headerProviderId);
			if (resolvedId) headerProviderConfig = this.providerRegistry.getConfig(resolvedId);
		}
		// Fall back to per-orchestrator provider for new conversations or
		// when the header's provider is no longer configured.
		const providerId = headerProviderConfig
			? headerProviderConfig.id
			: this.activeProviderId;
		const providerConfig = headerProviderConfig ?? this.providerRegistry.getConfig(providerId);

		// Use the header's model_id if the header's provider is still configured,
		// otherwise fall back to per-orchestrator model.
		const modelId = headerProviderConfig
			? (snapshotConv.model_id || (providerConfig?.model_id ?? ""))
			: this.activeModelId;
		const useExtendedContext = headerProviderConfig
			? (snapshotConv.use_extended_context ?? false)
			: this.activeUseExtendedContext;

		// Re-hydrate workflow tool configs for follow-up turns. The transient
		// WorkflowAssemblyResult only lives for the first execution session
		// (created by executeWorkflow); follow-up messages flow through here, so
		// without this the workflow's <notor_tool_config> overrides would decay
		// to [] after turn one. We persist toolConfigs on the conversation header
		// and rebuild a minimal assembly from them (only toolConfigs is read by
		// resolveEffectiveConfig). Skipped when the user has deactivated the
		// workflow via the chip (workflow_deactivated === true).
		const workflowAssembly: WorkflowAssemblyResult | null =
			(snapshotConv.workflow_tool_configs && snapshotConv.workflow_tool_configs.length > 0
				&& snapshotConv.workflow_deactivated !== true)
				? {
					assembledMessage: "",
					workflowName: snapshotConv.workflow_name ?? "",
					attachments: [],
					toolConfigs: snapshotConv.workflow_tool_configs,
				}
				: null;

		// Resolve initial effective config
		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.configResolver.resolveEffectiveConfig(undefined, workflowAssembly, pinnedPersona);

		// Capture the approval callback from this orchestrator's panel.
		// This binds approval prompts to the correct panel's view.
		const approvalCallback: ApprovalCallback = this.panelApprovalCallback
			?? (async () => "approved" as const);

		// Capture the interaction callback (follow-up questions) from this panel.
		const interactionCallback = this.panelInteractionCallback;

		const session = new ConversationSession({
			conversationId: snapshotConv.id,
			conversationManager: sessionConvManager,
			abortController: new AbortController(),
			title: snapshotConv.title ?? "Untitled",
			pinnedPersona,
			providerId,
			modelId,
			useExtendedContext,
			thinkingLevel: this.activeThinkingLevel,
			workflowAssembly,
			approvalCallback,
			interactionCallback,
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
			sessionConv.provider_id !== providerId ||
			sessionConv.model_id !== modelId;
		if (headerDirty) {
			sessionConv.persona_name = pinnedPersona?.name ?? null;
			sessionConv.provider_id = providerId;
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
			// Sync session state back to display manager so getMessages() reflects
			// the full conversation (assistant + tool messages added during the
			// response loop). Only sync if the display manager is still showing
			// the same conversation — if the user switched away, don't clobber.
			const displayConv = this.conversationManager.getActiveConversation();
			if (displayConv && displayConv.id === session.conversationId) {
				const finalConv = session.conversationManager.getActiveConversation();
				const finalMessages = session.conversationManager.getMessages();
				if (finalConv && finalMessages.length > 0) {
					this.conversationManager.loadConversation(finalConv, finalMessages, { silent: true });
				}
			}
			// Workflow hook deactivation is intentionally absent here because
			// handleUserMessage() never *activates* hook overrides — only
			// executeWorkflow() does (see its finally block). The session's
			// workflowAssembly may now be non-null (re-hydrated from the
			// conversation header to keep tool configs alive across turns), but
			// that re-hydrated assembly only carries toolConfigs for config
			// resolution; it is never tied to an active hook override here, so
			// there is nothing to deactivate.
			session.rejectAllPendingApprovals();
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
				// so open-files and vault structure reflect the latest state.
				const autoContext = buildAutoContextBlock(this.app, this.settings);
				const currentConv = convManager.getActiveConversation();
				const systemPrompt = await this.systemPromptBuilder.assemble(
					mode,
					toolDefinitions,
					undefined, // vaultRuleContent — now handled via cached stripped content
					autoContext ?? undefined,
					session.pinnedPersona,
					this.settings.memory_enabled,
					currentConv?.tasks,
					this.settings.enable_popover_references,
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

				const provider = this.providerRegistry.getProvider(session.providerId);
				const options: SendMessageOptions = {
					model: session.modelId,
					abort_signal: abortController.signal,
					use_extended_context: session.useExtendedContext,
					thinking_level: session.thinkingLevel,
				};

				const stream = provider.sendMessage(chatMessages, toolDefinitions, options);

				// Thinking is requested for this turn when the model supports it and a
				// level is set. Used to optimistically show the thinking indicator
				// during the pre-first-token window — on Bedrock, adaptive Opus 4.8
				// reasons server-side before any byte streams, so a purely
				// signal-driven indicator would never appear in time.
				const thinkingEnabled =
					!!session.thinkingLevel &&
					session.thinkingLevel !== "off" &&
					supportsThinking(session.modelId);

				// 7. Process stream (pass in the already-created placeholder + session-aware view resolver)
				const result = await processStream(
					stream,
					abortController,
					eagerContentEl,
					() => this.getViewForSession(session),
					thinkingEnabled,
				);

				// 8. Handle result
				if (result.type === "text") {
					// Final text response — loop ends
					const assistantMessage = convManager.addMessage({
						role: "assistant",
						content: result.text,
						thinking: result.thinking || null,
						thinking_duration_ms: result.thinkingDurationMs || null,
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
							convManager.getCurrentContextUsage().contextTokens,
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
						const toolTurnMsg = convManager.addMessage({
							role: "assistant",
							content: result.text || "",
							thinking: result.thinking || null,
							thinking_duration_ms: result.thinkingDurationMs || null,
							input_tokens: result.inputTokens,
							output_tokens: result.outputTokens,
							cost_estimate: calculateCost(result.inputTokens, result.outputTokens, session.modelId, this.settings),
						});

						// Finalize the streaming placeholder so thinking block persists
						if (result.contentEl) {
							await this.getViewForSession(session)?.finalizeAssistantMessage(result.contentEl, toolTurnMsg);
						}

						// Update token footer after tool-call turn tokens are recorded
						const convAfterToolTokens = convManager.getActiveConversation();
						if (convAfterToolTokens) {
							this.getViewForSession(session)?.updateTokenFooter(
								convManager.getCurrentContextUsage().contextTokens,
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

						// Adopt the mid-stream streaming placeholder when one exists
						// (mutate it in place — no second card), otherwise build a
						// fresh card. The fallback covers no-placeholder cases: empty
						// provider id, a non-streaming provider, or the view being
						// absent when streaming started.
						const view = this.getViewForSession(session);
						const toolCallEl =
							view?.finalizeStreamingToolCall(call.toolCallId, toolCallMessage)
							?? view?.renderToolCall(toolCallMessage);

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

					// Sweep any streaming placeholders that never matched a finalized
					// call (defensive — e.g. a start with no usable end that somehow
					// still returned tool_calls). Adopted placeholders were already
					// migrated out of the streaming map above.
					this.getViewForSession(session)?.clearStreamingToolCalls();

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
						? session.buildPolicyContext(this.settings, vaultRootPath, (path: string) => {
							const file = resolveNote(path, this.app.vault, this.app.metadataCache);
							return file?.path ?? null;
						})
						: undefined;

					const approvalHookFn = currentConv
						? async (tn: string, params: Record<string, unknown>, m: string) =>
							this.hookDispatcher.dispatchApprovalRequiredHook(currentConv.id, tn, params, m)
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
						approvalHookFn,
						session.interactionCallback,
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
							this.getViewForSession(session)?.appendForkButton(entry.el, entry.message);
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
								convManager.getCurrentContextUsage().contextTokens,
								convAfterToolResult.total_output_tokens,
								convAfterToolResult.estimated_cost
							);
						}
					}

					// --- Phase 10: emit extension_block for tool content_blocks ---
					// Collect custom_blocks from all tool results in this batch,
					// then emit a single extension_block message after the entire
					// tool_result group (preserving tool_call/tool_result coalescing).
					const customBlocksForBatch: Array<{
						block: import("../media/types").ContentBlock & { type: "custom_block" };
						toolName: string;
					}> = [];
					for (const toolResult of toolResults) {
						if (toolResult.content_blocks?.length) {
							for (const block of toolResult.content_blocks) {
								if (block.type === "custom_block") {
									// Validate JSON-serializability
									try {
										const serialized = JSON.stringify(block.data);
										if (serialized.length > 102400) {
											log.error(
												`Phase 10: custom_block data exceeds 100KB size limit — skipping`,
												{ kind: block.kind, tool: toolResult.tool_name, size: serialized.length },
											);
											continue;
										}
									} catch {
										log.error(
											`Phase 10: custom_block data is not JSON-serializable — skipping`,
											{ kind: block.kind, tool: toolResult.tool_name },
										);
										continue;
									}

									const registry = this.chatBlockRegistry;
									const def = registry?.get(block.kind);
									if (!def) {
										log.warn(
											`Phase 10: block kind '${block.kind}' is not registered — will render with fallback`,
											{ tool: toolResult.tool_name },
										);
									}

									// Compute estimated_wire_tokens if not already set
									let blockWithTokens = block;
									if (block.estimated_wire_tokens === undefined) {
										let estimated_wire_tokens: number;
										if (def?.toLLMText) {
											const wireText = def.toLLMText(block.data);
											estimated_wire_tokens = wireText != null ? estimateTokenCount(wireText) : 0;
										} else if (block.fallback_text != null) {
											estimated_wire_tokens = estimateTokenCount(block.fallback_text);
										} else {
											estimated_wire_tokens = 0;
										}
										blockWithTokens = { ...block, estimated_wire_tokens };
									}

									customBlocksForBatch.push({ block: blockWithTokens, toolName: toolResult.tool_name });
								}
							}
						}
					}

					if (customBlocksForBatch.length > 0) {
						// Group by source tool name for attribution
						const blocksByTool = new Map<string, typeof customBlocksForBatch>();
						for (const entry of customBlocksForBatch) {
							const existing = blocksByTool.get(entry.toolName) ?? [];
							existing.push(entry);
							blocksByTool.set(entry.toolName, existing);
						}

						for (const [toolName, entries] of blocksByTool) {
							convManager.addMessage({
								role: "extension_block",
								content: entries.map((e) => e.block),
								source_extension: toolName,
								exclude_from_compaction: false,
							});
						}
					}

					// If abort was triggered during the tool dispatch loop, break out
					if (abortController.signal.aborted) {
						break;
					}

					// Continue the loop — send tool results back to LLM
					continueLoop = true;
				} else if (result.type === "cancelled") {
					// Tear down any in-progress streaming tool-call placeholders —
					// they live outside the normal message lifecycle and are never
					// adopted when the turn is cancelled mid-stream.
					this.getViewForSession(session)?.clearStreamingToolCalls();

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
						thinking: result.thinking || null,
						thinking_duration_ms: result.thinkingDurationMs || null,
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
					// Tear down any streaming placeholder — covers JSON-parse
					// failures too (parseStreamEvents emits `error` after the
					// tool_call_started, so the placeholder is never adopted).
					this.getViewForSession(session)?.clearStreamingToolCalls();

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
					// Auto-clear cached credentials for Bedrock so the next
					// attempt picks up refreshed tokens without restarting.
					if (e.provider === "bedrock") {
						// Safety net: drop cached clients for every bedrock
						// instance so the next attempt re-resolves credentials.
						// Must reset by type — the registry is keyed by instance
						// ID, so the bare "bedrock" type is not a valid key. The
						// provider message is already self-contained, so no
						// suggestion is appended here.
						this.providerRegistry.resetCredentialsForType("bedrock");
					} else {
						suggestion = " Check your API key or credentials in Settings → Notor.";
					}
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

	/**
	 * Get the per-orchestrator active model ID.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	getActiveModelId(): string {
		return this.activeModelId;
	}

	/**
	 * Get the per-orchestrator extended context setting.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	getActiveUseExtendedContext(): boolean {
		return this.activeUseExtendedContext;
	}

	getActiveThinkingLevel(): string | null {
		return this.activeThinkingLevel;
	}

	setActiveThinkingLevel(level: string | null): void {
		this.activeThinkingLevel = level;
	}

	/**
	 * Get the per-orchestrator active provider instance ID.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	getActiveProviderId(): string {
		return this.activeProviderId;
	}

	/**
	 * Update the per-orchestrator provider/model fields.
	 *
	 * Called from `wireView()` picker-change callbacks. Each panel's picker
	 * updates its own orchestrator instead of the global `ProviderRegistry`.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	setActiveProvider(providerId: string): void {
		this.activeProviderId = providerId;
		const config = this.providerRegistry.getConfig(providerId);
		this.activeModelId = config?.model_id ?? "";
		this.activeUseExtendedContext = config?.use_extended_context ?? false;
	}

	/**
	 * Update the per-orchestrator model and extended context fields.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4b
	 */
	setActiveModel(modelId: string, useExtendedContext: boolean, thinkingLevel?: string | null): void {
		this.activeModelId = modelId;
		this.activeUseExtendedContext = useExtendedContext;
		if (thinkingLevel !== undefined) {
			this.activeThinkingLevel = thinkingLevel;
		}
	}

	/** Get the per-orchestrator active preset name (null = Custom mode). */
	getActivePresetName(): string | null {
		return this.activePresetName;
	}

	/** Set the per-orchestrator active preset name (null = Custom mode). */
	setActivePresetName(presetName: string | null): void {
		this.activePresetName = presetName;
	}


	/** Render a message in the view based on its role. */
	private renderMessage(message: Message): void {
		this.viewRouter.renderMessage(message);
	}
}

