/**
 * Chat panel view — primary UI surface for Notor.
 *
 * Implements the Obsidian ItemView for the chat panel with message
 * display, input area, send/stop buttons, and conversation switching.
 *
 * @see specs/01-mvp/spec.md — FR-4, FR-5
 * @see design/ux.md — chat panel layout, message display
 */

import { ItemView, Menu, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type NotorPlugin from "../main";
import type { ConversationMode, Message, ModelInfo, ModelPreset, Checkpoint, Persona, TaskItem } from "../types";
import type { Attachment } from "../context/attachment";
import type { ConversationListEntry } from "../chat/history";
import type { PersonaManager } from "../personas/persona-manager";
import { logger } from "../utils/logger";
import { SettingsPopover } from "./settings-popover";
import { ConversationList } from "./conversation-list";
import { ChatInput } from "./chat-input";
import { MessageRenderer } from "./message-renderer";
import { resolveNote } from "../utils/resolve-note";
import { findExistingLeaf } from "../tools/note-opener";
import { WorkflowActivityIndicator } from "./workflow-activity-indicator";
import type { WorkflowActivityTracker } from "../workflows/workflow-activity-tracker";
import type { ConversationSession } from "../chat/conversation-session";
import type { Workflow } from "../types";
import { McpStatusIndicator } from "./mcp-status-indicator";
import { getTextContent } from "../media/types";
import { FindInMessages } from "./find-in-messages";

const log = logger("ChatView");

/** View type identifier for Obsidian's view registry. */
export const CHAT_VIEW_TYPE = "notor-chat-view";

/** Metadata about the active conversation, used by the header title context menu and inline edit. */
export interface ActiveConversationMeta {
	id: string;
	title: string;
	filename: string;
	is_favorite: boolean;
}


/**
 * Chat panel ItemView for Notor.
 *
 * Layout:
 * - Header: title, settings gear, new conversation button
 * - Message list: scrollable container for conversation messages
 * - Input area: text input, send/stop button, mode toggle
 */
export class NotorChatView extends ItemView {
	private plugin: NotorPlugin;

	// DOM elements
	private headerEl!: HTMLElement;
	private messageListEl!: HTMLElement;
	private conversationList?: ConversationList;
	private taskPanelEl!: HTMLElement;
	private taskPanelCollapsed = false;
	private loadingIndicatorEl!: HTMLElement;
	private tokenFooterEl!: HTMLElement;

	// Extracted modules
	private chatInput!: ChatInput;
	private messageRenderer!: MessageRenderer;

	// State
	private isResponding = false;
	private abortController: AbortController | null = null;
	private showConversationList = false;
	private autoScroll = true;

	// Attachment state (parent-owned, accessed by ChatInput via deps)
	private pendingAttachments: Attachment[] = [];

	// Workflow state (parent-owned, accessed by ChatInput via deps)
	private pendingWorkflow: Workflow | null = null;
	private getWorkflowsCallback?: () => Workflow[];

	// Workflow send callback (E-012)
	private onSendWorkflow?: (workflow: Workflow, supplementaryText: string) => Promise<void>;

	// Settings popover (CHAT-008)
	private settingsPopover?: SettingsPopover;
	private isSettingsOpen = false;
	private displayedProviderId: string | null = null;
	private displayedModelValue: string | null = null;
	private displayedPresetName: string | null | undefined = undefined;

	// Persona state (A-009, A-010)
	private personaManager?: PersonaManager;
	private personaLabelEl?: HTMLElement;
	private onPersonaChange?: (persona: Persona | null) => void;

	// Workflow activity indicator state (H-002, H-003)
	private workflowActivityTracker?: WorkflowActivityTracker;
	private workflowActivityIndicator?: WorkflowActivityIndicator;
	/** Accessor for active foreground conversation sessions (Phase 3). */
	private getActiveSessions?: () => ConversationSession[];
	/** Accessor returning the conversation ID currently displayed in THIS panel. */
	private getCurrentConversationId?: () => string | null;

	// MCP status indicator (INT-005)
	private mcpStatusIndicator?: McpStatusIndicator;

	// Find-in-messages search bar
	private findInMessages?: FindInMessages;

	// Active conversation tracking
	private activeConversationId: string | null = null;

	// Header conversation title (displayed between "Notor" and action icons)
	private headerTitleEl?: HTMLSpanElement;
	private headerFavoriteEl?: HTMLSpanElement;

	/**
	 * Whether a conversation has been loaded into this view.
	 *
	 * Set to `true` by both `setState()` and the `setTimeout(0)` fallback
	 * in the registerView factory. Prevents duplicate loads when both fire.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.4
	 */
	isConversationLoaded = false;

	/**
	 * AbortController for the in-flight `loadConversation()` call.
	 *
	 * When a new load is triggered (e.g. setState overriding a fallback),
	 * the previous controller is aborted to cancel its async chain.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Amendment R2
	 */
	_loadConversationAbort?: AbortController;

	/**
	 * Timeout ID for the `setTimeout(0)` fallback conversation load.
	 *
	 * Stored so it can be cleared on view close to prevent loading into
	 * a destroyed view.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Amendment R2-2
	 */
	_loadFallbackTimeout?: ReturnType<typeof setTimeout>;

	/**
	 * Unregister function for the orchestrator session-change listener.
	 *
	 * Stored so previous listeners can be cleaned up before re-registering
	 * (prevents listener accumulation across wireView calls).
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Phase A3.5
	 */
	_unregisterSessionsChanged?: () => void;

	/**
	 * Removes this panel's `updateActivityIndicator` callback from the global
	 * set in `main.ts`. Called on close and on re-wire to prevent accumulation.
	 */
	_removeActivityCallback?: () => void;

	/**
	 * Unregister function for the PersonaManager persona-changed listener.
	 * Ensures file-watcher-triggered refreshes update this panel's persona chip.
	 */
	_unregisterPersonaChanged?: () => void;

	/**
	 * Async cleanup callback invoked on panel close.
	 *
	 * Set by `wireView()` in `main.ts`. Aborts in-flight loads, detaches the
	 * view from the orchestrator, removes from registry, and awaits
	 * `orchestrator.destroy()` for JSONL flush + session guard cleanup.
	 *
	 * Must be async: Obsidian awaits `ItemView.onClose(): Promise<void>`,
	 * so the flush completes before the panel tears down.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 7.2
	 */
	onCloseCleanup?: () => Promise<void>;

	// Callbacks (set by orchestrator)
	private onSendMessage?: (content: string, attachments?: Attachment[]) => Promise<void>;
	private onStopResponse?: () => void;
	private onNewConversation?: () => void;
	private onSwitchConversation?: (filename: string) => void;
	private onExportConversation?: (filename: string) => void;
	private onDeleteConversation?: (filename: string) => void;
	private onImportConversation?: (htmlContent: string) => Promise<void>;
	private onSwitchToConversationById?: (conversationId: string) => Promise<boolean>;
	private onOpenConversationList?: () => Promise<ConversationListEntry[]>;
	private onSearchConversations?: (query: string) => Promise<ConversationListEntry[]>;
	private onModeToggle?: (mode: ConversationMode) => void;
	private onSettingsOpen?: () => void;
	private onProviderChange?: (providerId: string) => void;
	private onModelChange?: (modelId: string) => void;
	private onRefreshModels?: () => Promise<ModelInfo[]>;
	private getAvailableProviders?: () => { id: string; type: string; displayName: string }[];
	private getAvailableModels?: () => ModelInfo[];
	private getCurrentProvider?: () => string;
	private getCurrentModel?: () => string;
	private onPresetChange?: (presetName: string | null, providerId?: string, modelId?: string, useExtendedContext?: boolean) => void;
	private getAvailablePresets?: () => ModelPreset[];
	private getCurrentPreset?: () => string | null;
	private getActiveModelId?: () => string;
	private getActiveThinkingLevel?: () => string | null;
	private onThinkingLevelChange?: (level: string | null) => void;

	// Fork callbacks
	private onForkConversation?: (messageId: string) => Promise<void>;
	private onForkToNewPanel?: (messageId: string | undefined, initialText?: string) => Promise<void>;

	// Favorite callback
	private onToggleFavorite?: (filename: string) => Promise<void>;

	// Rename callback
	private onRenameConversation?: (filename: string, currentTitle: string) => void;

	// Direct rename callback (bypasses RenameModal for inline header edit)
	private onDirectRename?: (filename: string, newTitle: string) => Promise<void>;

	// Active conversation metadata (for header context menu and inline edit)
	private getActiveConversationMeta?: () => ActiveConversationMeta | null;

	// Favorites filter state
	private favFilterActive = false;

	// Open conversation in new tab callback
	private onOpenInNewTab?: (filename: string) => void;

	// Settings deep-link callback
	private onOpenSettingsGroup?: (groupTitle: string, subsection?: string) => void;

	// Checkpoint callbacks
	private onListCheckpoints?: () => Promise<Checkpoint[]>;
	private onRestoreCheckpoint?: (checkpointId: string) => Promise<boolean>;
	private onGetCurrentContent?: (notePath: string) => Promise<string | null>;

	constructor(leaf: WorkspaceLeaf, plugin: NotorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Notor chat";
	}

	getIcon(): string {
		return "message-square";
	}

	// -----------------------------------------------------------------------
	// Callback setters (wired by orchestrator / main.ts)
	// -----------------------------------------------------------------------

	setActiveConversationId(id: string | null): void {
		this.activeConversationId = id;
	}

	getActiveConversationId(): string | null {
		return this.activeConversationId;
	}

	setOnSendMessage(callback: (content: string, attachments?: Attachment[]) => Promise<void>): void {
		this.onSendMessage = callback;
		if (this.chatInput) this.chatInput.deps.onSendMessage = callback;
	}

	setOnStopResponse(callback: () => void): void {
		this.onStopResponse = callback;
		if (this.chatInput) this.chatInput.deps.onStopResponse = callback;
	}

	setOnNewConversation(callback: () => void): void {
		this.onNewConversation = callback;
		if (this.conversationList) this.conversationList.deps.onNewConversation = callback;
	}

	setOnSwitchConversation(callback: (filename: string) => void): void {
		this.onSwitchConversation = callback;
		if (this.conversationList) this.conversationList.deps.onSwitchConversation = callback;
	}

	setOnExportConversation(callback: (filename: string) => void): void {
		this.onExportConversation = callback;
		if (this.conversationList) this.conversationList.deps.onExportConversation = callback;
	}

	setOnDeleteConversation(callback: (filename: string) => void): void {
		this.onDeleteConversation = callback;
		if (this.conversationList) this.conversationList.deps.onDeleteConversation = callback;
	}

	setOnToggleFavorite(callback: (filename: string) => Promise<void>): void {
		this.onToggleFavorite = callback;
		if (this.conversationList) this.conversationList.deps.onToggleFavorite = callback;
	}

	setOnRenameConversation(callback: (filename: string, currentTitle: string) => void): void {
		this.onRenameConversation = callback;
		if (this.conversationList) this.conversationList.deps.onRenameConversation = callback;
	}

	setOnDirectRename(callback: (filename: string, newTitle: string) => Promise<void>): void {
		this.onDirectRename = callback;
		if (this.conversationList) this.conversationList.deps.onDirectRename = callback;
	}

	setGetActiveConversationMeta(callback: () => ActiveConversationMeta | null): void {
		this.getActiveConversationMeta = callback;
		if (this.conversationList) this.conversationList.deps.getActiveConversationMeta = callback;
	}

	isFavFilterActive(): boolean {
		return this.conversationList?.isFavFilterActive() ?? this.favFilterActive;
	}

	setOnImportConversation(callback: (htmlContent: string) => Promise<void>): void {
		this.onImportConversation = callback;
		if (this.conversationList) this.conversationList.deps.onImportConversation = callback;
	}

	/**
	 * Set the callback for switching to a conversation by ID (H-005).
	 *
	 * This is used by the workflow activity dropdown to navigate to a
	 * specific workflow's conversation. The callback searches conversation
	 * history for the matching ID and loads it.
	 *
	 * @param callback - Async function that finds and switches to the
	 *                   conversation with the given ID. Returns true if
	 *                   the conversation was found and loaded, false otherwise.
	 *
	 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-005
	 */
	setOnSwitchToConversationById(callback: (conversationId: string) => Promise<boolean>): void {
		this.onSwitchToConversationById = callback;
	}

	setOnOpenConversationList(callback: () => Promise<ConversationListEntry[]>): void {
		this.onOpenConversationList = callback;
		if (this.conversationList) this.conversationList.deps.onOpenConversationList = callback;
	}

	setOnSearchConversations(callback: (query: string) => Promise<ConversationListEntry[]>): void {
		this.onSearchConversations = callback;
		if (this.conversationList) this.conversationList.deps.onSearchConversations = callback;
	}

	setOnModeToggle(callback: (mode: ConversationMode) => void): void {
		this.onModeToggle = callback;
		if (this.chatInput) this.chatInput.deps.onModeToggle = callback;
	}

	setOnSettingsOpen(callback: () => void): void {
		this.onSettingsOpen = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onSettingsOpen = callback;
	}

	setOnProviderChange(callback: (providerId: string) => void): void {
		this.onProviderChange = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onProviderChange = callback;
	}

	setOnModelChange(callback: (modelId: string) => void): void {
		this.onModelChange = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onModelChange = callback;
	}

	setOnRefreshModels(callback: () => Promise<ModelInfo[]>): void {
		this.onRefreshModels = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onRefreshModels = callback;
	}

	setGetAvailableProviders(callback: () => { id: string; type: string; displayName: string }[]): void {
		this.getAvailableProviders = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getAvailableProviders = callback;
	}

	setGetAvailableModels(callback: () => ModelInfo[]): void {
		this.getAvailableModels = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getAvailableModels = callback;
	}

	setGetCurrentProvider(callback: () => string): void {
		this.getCurrentProvider = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getCurrentProvider = callback;
	}

	setGetCurrentModel(callback: () => string): void {
		this.getCurrentModel = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getCurrentModel = callback;
	}

	setOnPresetChange(callback: (presetName: string | null, providerId?: string, modelId?: string, useExtendedContext?: boolean) => void): void {
		this.onPresetChange = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onPresetChange = callback;
	}

	setGetAvailablePresets(callback: () => ModelPreset[]): void {
		this.getAvailablePresets = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getAvailablePresets = callback;
	}

	setGetCurrentPreset(callback: () => string | null): void {
		this.getCurrentPreset = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getCurrentPreset = callback;
	}

	setGetActiveModelId(callback: () => string): void {
		this.getActiveModelId = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getActiveModelId = callback;
	}

	setGetActiveThinkingLevel(callback: () => string | null): void {
		this.getActiveThinkingLevel = callback;
		if (this.settingsPopover) this.settingsPopover.deps.getActiveThinkingLevel = callback;
	}

	setOnThinkingLevelChange(callback: (level: string | null) => void): void {
		this.onThinkingLevelChange = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onThinkingLevelChange = callback;
	}

	setOnPersonaChange(callback: (persona: Persona | null) => void): void {
		this.onPersonaChange = callback;
	}


	/**
	 * Apply a persona switch to this specific panel: update the chip label
	 * and fire the per-panel callback (which propagates to the orchestrator,
	 * JSONL header, and ToolDispatcher).
	 *
	 * Used by the chip context menu, settings popover picker, and the
	 * command-palette "Switch persona" command.
	 */
	applyPersonaSwitch(persona: Persona | null): void {
		this.updatePersonaLabel(persona);
		this.onPersonaChange?.(persona);
	}

	openFindBar(): void {
		this.findInMessages?.open();
	}

	setOnListCheckpoints(callback: () => Promise<Checkpoint[]>): void {
		this.onListCheckpoints = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onListCheckpoints = callback;
	}

	setOnRestoreCheckpoint(callback: (checkpointId: string) => Promise<boolean>): void {
		this.onRestoreCheckpoint = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onRestoreCheckpoint = callback;
	}

	setOnGetCurrentContent(callback: (notePath: string) => Promise<string | null>): void {
		this.onGetCurrentContent = callback;
		if (this.settingsPopover) this.settingsPopover.deps.onGetCurrentContent = callback;
	}

	setOnForkConversation(callback: (messageId: string) => Promise<void>): void {
		this.onForkConversation = callback;
	}

	setOnForkToNewPanel(callback: (messageId: string | undefined, initialText?: string) => Promise<void>): void {
		this.onForkToNewPanel = callback;
		if (this.chatInput) this.chatInput.deps.onForkToNewPanel = callback;
	}

	setOnOpenInNewTab(callback: (filename: string) => void): void {
		this.onOpenInNewTab = callback;
		if (this.conversationList) this.conversationList.deps.onOpenInNewTab = callback;
	}

	setOnOpenSettingsGroup(callback: (groupTitle: string, subsection?: string) => void): void {
		this.onOpenSettingsGroup = callback;
		if (this.messageRenderer) this.messageRenderer.deps.onOpenSettingsGroup = callback;
	}

	setOnCloseCleanup(callback: () => Promise<void>): void {
		this.onCloseCleanup = callback;
	}

	// -----------------------------------------------------------------------
	// Workflow slash-command setters (E-012)
	// -----------------------------------------------------------------------

	/**
	 * Provide the workflow discovery callback to the slash-command suggest.
	 *
	 * Called by the orchestrator once workflow discovery is available.
	 * If the suggest is already built (view already open), the callback
	 * is applied immediately; otherwise it is stored and applied in
	 * `buildInputArea()`.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-012
	 */
	setGetWorkflows(callback: () => Workflow[]): void {
		this.getWorkflowsCallback = callback;
		// If the suggest already exists (view reopened), update its source.
		// WorkflowSlashSuggest reads the callback on every getSuggestions()
		// invocation, so no further action is needed beyond storing it.
	}

	/**
	 * Set the callback invoked when the user sends a message with an
	 * attached workflow chip.
	 *
	 * When set, `handleSend()` routes workflow-attached messages here
	 * instead of the normal `onSendMessage` path. The orchestrator
	 * wires this to `ChatOrchestrator.executeWorkflow()`.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-012, E-013
	 */
	setOnSendWorkflow(callback: (workflow: Workflow, supplementaryText: string) => Promise<void>): void {
		this.onSendWorkflow = callback;
		if (this.chatInput) this.chatInput.deps.onSendWorkflow = callback;
	}

	// -----------------------------------------------------------------------
	// Workflow activity indicator (H-002, H-003)
	// -----------------------------------------------------------------------

	/**
	 * Set the workflow activity tracker for the activity indicator.
	 *
	 * Called by `main.ts` `wireView()` after the tracker is initialized.
	 * If the header is already built (view already open), the indicator
	 * is rendered immediately. Otherwise it renders on the next `onOpen()`.
	 *
	 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-002
	 */
	setWorkflowActivityTracker(tracker: WorkflowActivityTracker): void {
		this.workflowActivityTracker = tracker;

		// If the header is already built, render the indicator immediately
		if (this.headerEl) {
			this.initActivityIndicator();
		}
	}

	/**
	 * Set the accessor for active foreground conversation sessions (Phase 3).
	 *
	 * Used by the activity indicator to include detached foreground
	 * conversations in the badge count and dropdown entries.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 3, Step 3c
	 */
	setGetActiveSessions(getter: () => ConversationSession[]): void {
		this.getActiveSessions = getter;

		// Re-initialize indicator if it's already rendered, to pass the getter
		if (this.headerEl && this.workflowActivityTracker) {
			this.initActivityIndicator();
		}
	}

	/**
	 * Set the accessor for the conversation ID currently displayed in THIS panel.
	 *
	 * Passed to the activity indicator and forwarded to the dropdown so the
	 * entry matching this panel's open conversation is subtly highlighted.
	 */
	setGetCurrentConversationId(getter: () => string | null): void {
		this.getCurrentConversationId = getter;

		if (this.headerEl && this.workflowActivityTracker) {
			this.initActivityIndicator();
		}
	}

	/**
	 * Trigger an update of the activity indicator (badge + animation).
	 *
	 * Called when the orchestrator's session set changes so the indicator
	 * reactively reflects the current count.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 3, Step 3c
	 */
	updateActivityIndicator(): void {
		this.workflowActivityIndicator?.update();
	}

	/**
	 * Initialize the workflow activity indicator in the chat panel header.
	 *
	 * Called from `onOpen()` (if tracker is already set) or from
	 * `setWorkflowActivityTracker()` (if header is already built).
	 */
	private initActivityIndicator(): void {
		// Destroy any existing indicator to avoid duplicates
		this.workflowActivityIndicator?.destroy();
		this.workflowActivityIndicator = undefined;

		if (!this.workflowActivityTracker || !this.headerEl) return;

		this.workflowActivityIndicator = new WorkflowActivityIndicator(
			this.headerEl,
			this.workflowActivityTracker,
			this.getActiveSessions,
			this.getCurrentConversationId,
		);

		// Wire the conversation navigation callback (H-005)
		this.workflowActivityIndicator.setOnNavigateToConversation(
			(conversationId: string) => {
				void this.switchToConversation(conversationId);
			}
		);

		this.workflowActivityIndicator.render();
	}

	/**
	 * Switch to a specific conversation by ID (H-005).
	 *
	 * Called when the user clicks a workflow entry in the activity dropdown.
	 * Delegates to the `onSwitchToConversationById` callback wired by
	 * the orchestrator/main.ts. If the conversation is not found, a
	 * non-blocking notice is surfaced.
	 *
	 * For workflows with status `"waiting_approval"`, this navigates to the
	 * conversation where the pending tool call approval prompt is visible,
	 * allowing the user to unblock the paused background workflow.
	 *
	 * Reveals and focuses the chat panel if it is not currently visible.
	 *
	 * @param conversationId - The conversation ID to navigate to.
	 *
	 * @see specs/03-workflows-personas/tasks/group-h-tasks.md — H-005
	 */
	async switchToConversation(conversationId: string): Promise<void> {
		// Ensure the chat panel is visible
		void this.app.workspace.revealLeaf(this.leaf);

		// Close conversation list if it was open
		if (this.showConversationList) {
			this.conversationList?.toggle();
		}

		if (!this.onSwitchToConversationById) {
			log.warn("switchToConversation called but no callback is set", { conversationId });
			return;
		}

		try {
			const found = await this.onSwitchToConversationById(conversationId);
			if (!found) {
				const { Notice } = await import("obsidian");
				new Notice("Conversation not found");
				log.warn("Conversation not found for navigation", { conversationId });
			}
		} catch (e) {
			log.error("Failed to switch to conversation", {
				conversationId,
				error: String(e),
			});
			const { Notice } = await import("obsidian");
			new Notice(`Failed to load conversation: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	// -----------------------------------------------------------------------
	// Persona integration (A-009, A-010)
	// -----------------------------------------------------------------------

	/**
	 * Set the persona manager for the picker and label.
	 *
	 * The manager's onPersonaChanged callback is wired to update the
	 * persona label whenever the active persona changes (from picker,
	 * programmatic switch, or workflow revert).
	 */
	setPersonaManager(manager: PersonaManager): void {
		this.personaManager = manager;
	}

	/**
	 * Update the active persona label near the chat input area.
	 *
	 * Shows "🎭 {name}" when a persona is active, hidden when none.
	 * Called on persona switch (picker, programmatic, or workflow revert).
	 *
	 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-010
	 */
	updatePersonaLabel(persona: Persona | null): void {
		if (!this.personaLabelEl) {
			// Create the label element if it doesn't exist yet.
			// Inserted into the toolbar row, after the mode toggle.
			const toolbar = this.chatInput?.getToolbarEl() ?? this.chatInput?.getInputAreaEl();
			if (toolbar) {
				this.personaLabelEl = toolbar.createDiv({
					cls: "notor-persona-label",
				});
				// Place after the mode toggle (second child of toolbar)
				const modeToggle = toolbar.querySelector(".notor-mode-toggle");
				if (modeToggle?.nextSibling) {
					toolbar.insertBefore(this.personaLabelEl, modeToggle.nextSibling);
				}
				// Click to open persona context menu
				this.personaLabelEl.addEventListener("click", (evt) => {
					if (!this.personaManager) return;
					this.showPersonaContextMenu(evt);
				});
			} else {
				return;
			}
		}

		if (persona) {
			const emoji = persona.chip_emoji ?? "🎭";
			this.personaLabelEl.textContent = `${emoji} ${persona.name}`;
			this.personaLabelEl.removeClass("notor-hidden");
			this.personaLabelEl.removeClass("notor-persona-label--default");

			// Apply custom chip colour or reset to CSS defaults
			if (persona.chip_color) {
				this.personaLabelEl.addClass("notor-persona-label--custom");
				this.personaLabelEl.setCssProps({
					"--persona-chip-color": persona.chip_color,
					"--persona-chip-bg": `${persona.chip_color}20`,
					"--persona-chip-border": `${persona.chip_color}40`,
				});
			} else {
				this.personaLabelEl.removeClass("notor-persona-label--custom");
				this.personaLabelEl.setCssProps({
					"--persona-chip-color": "",
					"--persona-chip-bg": "",
					"--persona-chip-border": "",
				});
			}
		} else {
			this.personaLabelEl.textContent = "🎭 Default";
			this.personaLabelEl.addClass("notor-persona-label--default");
			this.personaLabelEl.removeClass("notor-persona-label--custom");
			this.personaLabelEl.setCssProps({
				"--persona-chip-color": "",
				"--persona-chip-bg": "",
				"--persona-chip-border": "",
			});
		}
	}

	/**
	 * Show an Obsidian context menu for switching the active persona.
	 *
	 * Discovers available personas, builds a menu with "None (deactivate)"
	 * at the top followed by alphabetically sorted personas, and applies
	 * the selection to this specific panel via {@link applyPersonaSwitch}.
	 */
	private showPersonaContextMenu(evt: MouseEvent): void {
		if (!this.personaManager) return;
		const pm = this.personaManager;

		pm.getDiscoveredPersonas()
			.then((personas) => {
				const menu = new Menu();

				// "None (deactivate)" at the top
				menu.addItem((item) => {
					item.setTitle("None (deactivate)")
						.setIcon("x-circle")
						.onClick(() => {
							this.applyPersonaSwitch(null);
						});
				});

				// Alphabetically sorted personas
				const sorted = [...personas].sort((a, b) => a.name.localeCompare(b.name));
				for (const p of sorted) {
					menu.addItem((item) => {
						const label = p.chip_emoji ? `${p.chip_emoji} ${p.name}` : p.name;
						item.setTitle(label)
							.setIcon("user")
							.onClick(() => {
								this.applyPersonaSwitch(p);
							});
					});
				}

				menu.showAtMouseEvent(evt);
			})
			.catch((e) => {
				log.error("Failed to discover personas for context menu", { error: String(e) });
				new Notice("Failed to load personas");
			});
	}

	/**
	 * Update the displayed provider in the settings popover without triggering
	 * the global `onProviderChange` callback.
	 *
	 * Called by the orchestrator when switching to a conversation that used a
	 * different provider. The override is cleared when the user explicitly
	 * changes the provider via the picker.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1f
	 */
	updateProviderDisplay(providerId: string): void {
		this.displayedProviderId = providerId;
		if (this.settingsPopover?.isOpen()) {
			this.settingsPopover.close();
			this.settingsPopover.open();
		}
	}

	updateModelDisplay(modelValue: string): void {
		this.displayedModelValue = modelValue;
		if (this.settingsPopover?.isOpen()) {
			this.settingsPopover.refreshModelSelect();
		}
	}

	updatePresetDisplay(presetName: string | null): void {
		this.displayedPresetName = presetName;
		if (this.settingsPopover?.isOpen()) {
			this.settingsPopover.close();
			this.settingsPopover.open();
		}
	}

	/**
	 * Clear display-only provider/model overrides.
	 *
	 * Called when the user explicitly changes the provider/model via the
	 * picker (the override should no longer apply), or when creating a new
	 * conversation (which snapshots from global state).
	 */
	clearDisplayOverrides(): void {
		this.displayedProviderId = null;
		this.displayedModelValue = null;
		this.displayedPresetName = undefined;
	}

	/**
	 * Get the current AbortController for cancelling LLM requests.
	 */
	getAbortController(): AbortController | null {
		return this.abortController;
	}

	/**
	 * Create a new AbortController for a new request.
	 */
	createAbortController(): AbortController {
		this.abortController = new AbortController();
		return this.abortController;
	}

	// -----------------------------------------------------------------------
	// Lifecycle
	// -----------------------------------------------------------------------

	onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("notor-chat-container");

		this.buildHeader(container);
		this.initSettingsPopover();
		this.initConversationList(container);
		this.buildTaskPanel(container);
		this.buildMessageList(container);

		// Initialize MessageRenderer
		this.messageRenderer = new MessageRenderer({
			getMessageListEl: () => this.messageListEl,
			getTokenFooterEl: () => this.tokenFooterEl,
			app: this.app,
			component: this,
			getSettings: () => this.plugin.settings,
			getChatBlockRegistry: () => this.plugin.getChatBlockRegistry(),
			getPendingMemoryManager: () => this.plugin.getPendingMemoryManager(),
			scrollToBottom: () => this.scrollToBottom(),
			openInternalLink: (href) => this.openInternalLink(href),
			openChatInNewTab: (filename, createNew, initialText, conversationId) => this.plugin.openChatInNewTab(filename, createNew, initialText, conversationId),
			onOpenSettingsGroup: this.onOpenSettingsGroup,
		});

		// Initialize ChatInput
		this.chatInput = new ChatInput({
			container,
			app: this.app,
			getSettings: () => this.plugin.settings,
			getIsResponding: () => this.isResponding,
			getPendingAttachments: () => this.pendingAttachments,
			setPendingAttachments: (v) => { this.pendingAttachments = v; },
			getPendingWorkflow: () => this.pendingWorkflow,
			setPendingWorkflow: (v) => { this.pendingWorkflow = v; },
			setAutoScroll: (v) => { this.autoScroll = v; },
			getAbortController: () => this.abortController,
			getMessageListEl: () => this.messageListEl,
			getLoadingIndicatorEl: () => this.loadingIndicatorEl,
			getWorkflows: () => this.getWorkflowsCallback?.() ?? [],
			// eslint-disable-next-line @typescript-eslint/no-deprecated -- no non-deprecated API for active-leaf identity check
			isActiveLeaf: () => this.app.workspace.activeLeaf === this.leaf,
			onSendMessage: this.onSendMessage,
			onStopResponse: this.onStopResponse,
			onSendWorkflow: this.onSendWorkflow,
			onModeToggle: this.onModeToggle,
			onForkToNewPanel: this.onForkToNewPanel,
		});
		this.chatInput.build();

		this.findInMessages = new FindInMessages(container, this.messageListEl, {
			onClose: () => {},
			setAutoScroll: (v: boolean) => { this.autoScroll = v; },
		});
		container.addEventListener("keydown", (e) => {
			if ((e.metaKey || e.ctrlKey) && e.key === "f") {
				e.preventDefault();
				e.stopPropagation();
				this.findInMessages?.open();
			}
		}, true);

		// H-002: Render workflow activity indicator in header (if tracker is already wired)
		this.initActivityIndicator();

		log.info("Chat view opened");
		return Promise.resolve();
	}

	async onClose(): Promise<void> {
		// A7.4: Await orchestrator cleanup first — aborts in-flight loads,
		// detaches view, flushes JSONL writes, unregisters session guards.
		// Must complete before DOM teardown (Obsidian awaits onClose).
		// @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 7.2
		await this.onCloseCleanup?.();

		this.abortController?.abort();

		// Clean up ChatInput (observer + resize listener)
		this.chatInput?.destroy();

		// H-002: Clean up workflow activity indicator DOM and callbacks
		this.workflowActivityIndicator?.destroy();
		this.workflowActivityIndicator = undefined;

		// INT-005: Clean up MCP status indicator
		this.mcpStatusIndicator?.destroy();
		this.mcpStatusIndicator = undefined;

		this.findInMessages?.destroy();
		this.findInMessages = undefined;

		this.settingsPopover?.destroy();
		this.settingsPopover = undefined;

		this.conversationList?.destroy();
		this.conversationList = undefined;

		// A3.8: Release all callback references to prevent GC leaks.
		// Called AFTER onCloseCleanup (Amendment R2-8 ordering) so the
		// cleanup callback can still use view callbacks if needed.
		this.clearCallbacks();

		log.info("Chat view closed");
	}

	/**
	 * Null all callback properties to release GC references.
	 *
	 * Called from `onClose()` after orchestrator cleanup. Covers all
	 * 24 `setOn*` + 8 `setGet*` callback slots.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Amendment A6
	 */
	clearCallbacks(): void {
		// setOn* callbacks (24)
		this.onSendMessage = undefined;
		this.onStopResponse = undefined;
		this.onNewConversation = undefined;
		this.onSwitchConversation = undefined;
		this.onExportConversation = undefined;
		this.onDeleteConversation = undefined;
		this.onToggleFavorite = undefined;
		this.onImportConversation = undefined;
		this.onSwitchToConversationById = undefined;
		this.onOpenConversationList = undefined;
		this.onSearchConversations = undefined;
		this.onModeToggle = undefined;
		this.onSettingsOpen = undefined;
		this.onProviderChange = undefined;
		this.onModelChange = undefined;
		this.onRefreshModels = undefined;
		this.onListCheckpoints = undefined;
		this.onRestoreCheckpoint = undefined;
		this.onGetCurrentContent = undefined;
		this.onForkConversation = undefined;
		this.onForkToNewPanel = undefined;
		this.onOpenInNewTab = undefined;
		this.onOpenSettingsGroup = undefined;
		this.onSendWorkflow = undefined;
		this.onPersonaChange = undefined;
		this.onDirectRename = undefined;

		// setGet* callbacks (9)
		this.getAvailableProviders = undefined;
		this.getAvailableModels = undefined;
		this.getCurrentProvider = undefined;
		this.getCurrentModel = undefined;
		this.getWorkflowsCallback = undefined;
		this.getActiveSessions = undefined;
		this.getCurrentConversationId = undefined;
		this.getActiveConversationMeta = undefined;

		// Close cleanup callback (A7.2)
		this.onCloseCleanup = undefined;
	}

	// -----------------------------------------------------------------------
	// State persistence (Phase 4 — workspace restore for secondary panels)
	// -----------------------------------------------------------------------

	/**
	 * Save view state for Obsidian workspace restore.
	 *
	 * Stores the active conversation ID so that closing and reopening
	 * Obsidian restores the panel to the correct conversation.
	 */
	getState(): Record<string, unknown> {
		return {
			conversationId: this.activeConversationId,
		};
	}

	/**
	 * Restore view state from a previous session (Obsidian workspace restore).
	 *
	 * Called by Obsidian after the registerView factory returns. No longer
	 * detects secondary panels or re-wires orchestrators — the factory
	 * creates a fresh orchestrator for every panel. setState only loads
	 * the correct conversation via `loadConversation()`.
	 *
	 * Amendment A5 + R2: If the setTimeout fallback already loaded
	 * (isConversationLoaded === true), but we have a saved conversation to
	 * restore, override it. loadConversation() uses an AbortController to
	 * cancel any in-flight fallback load, preventing races.
	 *
	 * @see specs/ZZ-misc/multi-conversation-robustness-redesign.md — Section 4.4
	 */
	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const s = state as Record<string, unknown> | null;
		const savedConversationId = (s?.conversationId ?? s?.conversationFilename) as string | undefined;

		// Load the saved conversation. The orchestrator was already correctly
		// bound in the registerView factory — no re-wiring needed.
		if (!this.isConversationLoaded || savedConversationId) {
			this.isConversationLoaded = true;
			const orchestrator = this.plugin.getOrchestratorForView(this);
			if (orchestrator) {
				this.plugin.loadConversation(this, orchestrator, s);
			} else {
				log.warn("setState: no orchestrator found for view — setTimeout fallback will retry");
			}
		}
	}

	// -----------------------------------------------------------------------
	// UI Construction
	// -----------------------------------------------------------------------

	private initSettingsPopover(): void {
		this.settingsPopover = new SettingsPopover({
			headerEl: this.headerEl,
			app: this.app,
			providers: this.plugin.settings.providers,
			getIsSettingsOpen: () => this.isSettingsOpen,
			setIsSettingsOpen: (v) => { this.isSettingsOpen = v; },
			getShowConversationList: () => this.showConversationList,
			getDisplayedPresetName: () => this.displayedPresetName,
			setDisplayedPresetName: (v) => { this.displayedPresetName = v; },
			getDisplayedProviderId: () => this.displayedProviderId,
			setDisplayedProviderId: (v) => { this.displayedProviderId = v; },
			getDisplayedModelValue: () => this.displayedModelValue,
			setDisplayedModelValue: (v) => { this.displayedModelValue = v; },
			onSettingsOpen: this.onSettingsOpen,
			onPresetChange: this.onPresetChange,
			onProviderChange: this.onProviderChange,
			onModelChange: this.onModelChange,
			onRefreshModels: this.onRefreshModels,
			onThinkingLevelChange: this.onThinkingLevelChange,
			onListCheckpoints: this.onListCheckpoints,
			onRestoreCheckpoint: this.onRestoreCheckpoint,
			onGetCurrentContent: this.onGetCurrentContent,
			getAvailablePresets: this.getAvailablePresets,
			getCurrentPreset: this.getCurrentPreset,
			getAvailableProviders: this.getAvailableProviders,
			getAvailableModels: this.getAvailableModels,
			getCurrentProvider: this.getCurrentProvider,
			getCurrentModel: this.getCurrentModel,
			getActiveModelId: this.getActiveModelId,
			getActiveThinkingLevel: this.getActiveThinkingLevel,
			toggleConversationList: () => this.conversationList?.toggle(),
		});
	}

	private initConversationList(container: HTMLElement): void {
		const self = this;
		this.conversationList = new ConversationList(container, {
			get messageListEl() { return self.messageListEl; },
			headerTitleEl: this.headerTitleEl,
			headerFavoriteEl: this.headerFavoriteEl,
			getActiveConversationId: () => this.activeConversationId,
			getShowConversationList: () => this.showConversationList,
			setShowConversationList: (v) => { this.showConversationList = v; },
			onOpenConversationList: this.onOpenConversationList,
			onSearchConversations: this.onSearchConversations,
			onSwitchConversation: this.onSwitchConversation,
			onToggleFavorite: this.onToggleFavorite,
			onRenameConversation: this.onRenameConversation,
			onExportConversation: this.onExportConversation,
			onDeleteConversation: this.onDeleteConversation,
			onImportConversation: this.onImportConversation,
			onNewConversation: this.onNewConversation,
			onOpenInNewTab: this.onOpenInNewTab,
			onDirectRename: this.onDirectRename,
			getActiveConversationMeta: this.getActiveConversationMeta,
			openChatInNewTab: (_conv, newPanel) => this.plugin.openChatInNewTab(undefined, newPanel),
			focusInput: () => this.chatInput?.focus(),
		});
		this.conversationList.build();
	}

	private buildHeader(container: HTMLElement): void {
		this.headerEl = container.createDiv({ cls: "notor-chat-header" });

		const titleArea = this.headerEl.createDiv({ cls: "notor-chat-header-title" });
		titleArea.createSpan({ text: "Notor", cls: "notor-chat-title" });

		// Active conversation title (between "Notor" and action icons)
		this.headerTitleEl = titleArea.createSpan({
			cls: "notor-header-conversation-title notor-hidden",
		});
		this.headerTitleEl.addEventListener("dblclick", (e) => {
			e.preventDefault();
			this.conversationList?.startHeaderTitleEdit();
		});
		this.headerTitleEl.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.conversationList?.showHeaderTitleContextMenu(e);
		});

		this.headerFavoriteEl = titleArea.createSpan({
			cls: "notor-header-favorite-icon notor-hidden",
			attr: { "aria-label": "Favorite" },
		});
		setIcon(this.headerFavoriteEl, "star");
		this.headerFavoriteEl.addEventListener("click", (e) => {
			e.stopPropagation();
			const meta = this.getActiveConversationMeta?.();
			if (meta) this.onToggleFavorite?.(meta.filename);
		});

		const actions = this.headerEl.createDiv({ cls: "notor-chat-header-actions" });

		// Conversation list toggle
		const listBtn = actions.createEl("button", {
			cls: "notor-chat-header-btn clickable-icon",
			attr: { "aria-label": "Conversation history" },
		});
		setIcon(listBtn, "list");
		listBtn.addEventListener("click", () => this.conversationList?.toggle());

		// Workflow activity indicator is inserted after this button (see workflow-activity-indicator.ts)

		// INT-005: MCP status indicator — rendered into the actions bar.
		// Only visible when ≥1 MCP server is configured.
		this.mcpStatusIndicator = new McpStatusIndicator(actions, this.plugin);
		this.mcpStatusIndicator.render();

		// Settings gear
		const settingsBtn = actions.createEl("button", {
			cls: "notor-chat-header-btn clickable-icon",
			attr: { "aria-label": "Chat settings" },
		});
		setIcon(settingsBtn, "settings");
		settingsBtn.addEventListener("click", () => {
			this.settingsPopover?.toggle();
		});

		// New conversation button
		const newBtn = actions.createEl("button", {
			cls: "notor-chat-header-btn clickable-icon",
			attr: { "aria-label": "New conversation" },
		});
		setIcon(newBtn, "message-square-plus");
		newBtn.addEventListener("click", () => {
			if (this.showConversationList) {
				this.conversationList?.toggle();
			}
			this.onNewConversation?.();
			this.chatInput?.focus();
		});

		// Right-click: show context menu with "current panel" vs "new panel" options
		newBtn.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.conversationList?.showNewConversationMenu(e);
		});

		// Middle-click: immediately open a new chat panel
		newBtn.addEventListener("auxclick", (e) => {
			if (e.button !== 1) return;
			e.preventDefault();
			this.plugin.openChatInNewTab(undefined, true);
		});
	}


	private buildTaskPanel(container: HTMLElement): void {
		this.taskPanelEl = container.createDiv({ cls: "notor-task-panel notor-hidden" });
	}

	renderTaskPanel(tasks?: TaskItem[] | null): void {
		if (!tasks || tasks.length === 0) {
			this.taskPanelEl?.addClass("notor-hidden");
			return;
		}

		this.taskPanelEl?.removeClass("notor-hidden");
		this.taskPanelEl?.empty();

		const completed = tasks.filter((t) => t.status === "completed").length;

		const header = this.taskPanelEl.createDiv({ cls: "notor-task-panel-header" });
		const chevron = header.createSpan({ text: "▶", cls: "notor-task-panel-chevron" });
		if (!this.taskPanelCollapsed) chevron.addClass("notor-task-panel-chevron-open");
		header.createSpan({ text: `Tasks (${completed}/${tasks.length} done)`, cls: "notor-task-panel-title" });

		const body = this.taskPanelEl.createDiv({ cls: "notor-task-panel-body" });
		if (this.taskPanelCollapsed) body.addClass("notor-hidden");
		for (const task of tasks) {
			const taskEl = body.createDiv({ cls: "notor-task-item" });
			const icon = task.status === "completed" ? "☑"
				: task.status === "in_progress" ? "⏳"
				: "☐";
			const cls = task.status === "completed" ? "notor-task-completed"
				: task.status === "in_progress" ? "notor-task-in-progress"
				: "";
			if (cls) taskEl.addClass(cls);
			taskEl.createSpan({ text: `${icon} ${task.content}` });
		}

		header.addEventListener("click", () => {
			this.taskPanelCollapsed = !this.taskPanelCollapsed;
			body.toggleClass("notor-hidden", this.taskPanelCollapsed);
			chevron.toggleClass("notor-task-panel-chevron-open", !this.taskPanelCollapsed);
		});
	}

	private buildMessageList(container: HTMLElement): void {
		this.messageListEl = container.createDiv({ cls: "notor-message-list" });

		// Re-enable auto-scroll when the user scrolls back to the bottom; disable it when they scroll up.
		this.messageListEl.addEventListener("scroll", () => {
			const el = this.messageListEl;
			const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
			this.autoScroll = distanceFromBottom <= 50;
		});

		// Context menu for messages and panel background
		this.messageListEl.addEventListener("contextmenu", (evt: MouseEvent) => {
			const target = (evt.target as HTMLElement).closest<HTMLElement>("[data-message-id]");
			const messageId = target?.dataset.messageId ?? null;
			const selectedText = window.getSelection()?.toString().trim() ?? "";
			const menu = new Menu();
			let hasItems = false;

			if (messageId) {
				const message = this.messageRenderer.getRenderedMessage(messageId);
				if (message) {
					menu.addItem((item) => {
						item.setTitle("Copy message contents")
							.setIcon("clipboard-copy")
							.onClick(() => {
								void navigator.clipboard.writeText(getTextContent(message.content)).then(() => {
									new Notice("Copied");
								});
							});
					});
					hasItems = true;
				}
			}

			if (selectedText) {
				menu.addItem((item) => {
					item.setTitle("Copy selected text")
						.setIcon("text-cursor")
						.onClick(() => {
							void navigator.clipboard.writeText(selectedText).then(() => {
								new Notice("Copied");
							});
						});
				});
				hasItems = true;
			}

			if (messageId) {
				menu.addSeparator();
				menu.addItem((item) => {
					item.setTitle("Fork here")
						.setIcon("git-branch-plus")
						.onClick(() => {
							this.onForkConversation?.(messageId);
						});
				});
				menu.addItem((item) => {
					item.setTitle("/btw")
						.setIcon("message-square-plus")
						.onClick(() => {
							this.onForkToNewPanel?.(messageId);
						});
				});
				hasItems = true;
			}

			if (this.activeConversationId) {
				menu.addSeparator();
				menu.addItem((item) => {
					item.setTitle("Copy conversation ID")
						.setIcon("hash")
						.onClick(() => {
							void navigator.clipboard.writeText(this.activeConversationId!).then(() => {
								new Notice("Conversation ID copied");
							});
						});
				});
				hasItems = true;
			}

			if (hasItems) {
				menu.showAtMouseEvent(evt);
				evt.preventDefault();
			}
		});

		// Loading indicator
		this.loadingIndicatorEl = container.createDiv({
			cls: "notor-loading-indicator notor-hidden",
		});
		this.loadingIndicatorEl.createSpan({ text: "Thinking", cls: "notor-loading-text" });
		const dots = this.loadingIndicatorEl.createSpan({ cls: "notor-loading-dots" });
		dots.createSpan({ text: "." });
		dots.createSpan({ text: "." });
		dots.createSpan({ text: "." });

		// Token/cost footer
		this.tokenFooterEl = container.createDiv({
			cls: "notor-token-footer notor-hidden",
		});
	}




	// -----------------------------------------------------------------------
	// Public UI update methods — delegated to ChatInput / MessageRenderer
	// -----------------------------------------------------------------------

	setInputText(text: string): void {
		this.chatInput.setInputText(text);
	}

	getInputText(): string {
		return this.chatInput.getInputText();
	}

	triggerSend(): void {
		this.chatInput.triggerSend();
	}

	setRespondingState(responding: boolean): void {
		this.isResponding = responding;
		this.chatInput.setRespondingState(responding);
	}

	updateModeDisplay(mode: ConversationMode): void {
		this.chatInput.updateModeDisplay(mode);
	}

	appendForkButton(msgEl: HTMLElement, message?: Message): void {
		this.messageRenderer.appendForkButton(msgEl, message);
	}

	renderUserMessage(message: Message): void {
		this.messageRenderer.renderUserMessage(message);
	}

	renderHookInjection(message: Message): void {
		this.messageRenderer.renderUserMessage(message);
	}

	createAssistantMessagePlaceholder(): HTMLElement {
		return this.messageRenderer.createAssistantMessagePlaceholder();
	}

	appendStreamChunk(contentEl: HTMLElement, text: string): void {
		this.messageRenderer.appendStreamChunk(contentEl, text);
	}

	appendThinkingChunk(contentEl: HTMLElement, text: string): void {
		this.messageRenderer.appendThinkingChunk(contentEl, text);
	}

	async finalizeAssistantMessage(contentEl: HTMLElement, message: Message): Promise<void> {
		return this.messageRenderer.finalizeAssistantMessage(contentEl, message);
	}

	renderToolCall(message: Message): HTMLElement {
		return this.messageRenderer.renderToolCall(message);
	}

	renderToolResult(message: Message): void {
		this.messageRenderer.renderToolResult(message);
	}

	updateToolCallStatus(toolEl: HTMLElement, status: string): void {
		this.messageRenderer.updateToolCallStatus(toolEl, status);
	}

	updateToolCallProgress(toolEl: HTMLElement, status: string): void {
		this.messageRenderer.updateToolCallProgress(toolEl, status);
	}

	renderExtensionBlock(message: Message): void {
		this.messageRenderer.renderExtensionBlock(message);
	}

	reRenderExtensionBlock(message: Message): void {
		this.messageRenderer.reRenderExtensionBlock(message);
	}

	hasMessageElement(messageId: string): boolean {
		return this.messageRenderer.hasMessageElement(messageId);
	}

	renderApprovalPrompt(toolCallEl: HTMLElement, autoApproved = false): Promise<"approved" | "rejected"> {
		return this.messageRenderer.renderApprovalPrompt(toolCallEl, autoApproved);
	}

	reRenderPendingApprovals(
		pendingApprovals: Map<string, { toolName: string; parameters: Record<string, unknown> }>
	): Map<string, Promise<"approved" | "rejected">> {
		return this.messageRenderer.reRenderPendingApprovals(pendingApprovals);
	}

	async renderDiffApprovalPrompt(
		toolCallEl: HTMLElement,
		toolName: string,
		parameters: Record<string, unknown>,
		autoApproved = false
	): Promise<"approved" | "rejected"> {
		return this.messageRenderer.renderDiffApprovalPrompt(toolCallEl, toolName, parameters, autoApproved);
	}

	getLastToolCallEl(): HTMLElement | null {
		return this.messageRenderer.getLastToolCallEl();
	}

	getToolCallEl(messageId: string): HTMLElement | null {
		return this.messageRenderer.getToolCallEl(messageId);
	}

	getMessagesContainer(): HTMLElement {
		return this.messageRenderer.getMessagesContainer();
	}

	updateTokenFooter(
		contextTokens: number,
		outputTokens: number,
		estimatedCost: number | null
	): void {
		this.messageRenderer.updateTokenFooter(contextTokens, outputTokens, estimatedCost);
	}

	showTruncationWarning(truncatedCount: number): void {
		this.messageRenderer.showTruncationWarning(truncatedCount);
	}

	showError(error: string): void {
		this.messageRenderer.showError(error);
	}

	private openInternalLink(href: string): void {
		const file = resolveNote(href, this.app.vault, this.app.metadataCache);
		if (!file) {
			new Notice(`Note not found: ${href}`);
			return;
		}
		const existingLeaf = findExistingLeaf(this.app, file);
		if (existingLeaf) {
			this.app.workspace.setActiveLeaf(existingLeaf, { focus: true });
		} else {
			void this.app.workspace.openLinkText(href, "", true);
		}
	}

	// -----------------------------------------------------------------------
	// Conversation list delegation
	// -----------------------------------------------------------------------

	renderConversationList(entries: ConversationListEntry[]): void {
		this.conversationList?.render(entries);
	}

	updateConversationTitleInList(conversationId: string, title: string): void {
		this.conversationList?.updateTitleInList(conversationId, title);
	}

	updateHeaderTitle(conversationId: string, title: string | null): void {
		this.conversationList?.updateHeaderTitle(conversationId, title);
	}

	updateHeaderFavorite(conversationId: string, isFavorite: boolean): void {
		this.conversationList?.updateHeaderFavorite(conversationId, isFavorite);
	}

	clearMessages(): void {
		this.findInMessages?.close();
		this.messageRenderer.clearMessages();
		this.taskPanelEl?.addClass("notor-hidden");
		this.taskPanelEl?.empty();
		this.taskPanelCollapsed = false;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	scrollToBottom(): void {
		if (!this.autoScroll) return;
		this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
	}

}
