/**
 * Chat panel view — primary UI surface for Notor.
 *
 * Implements the Obsidian ItemView for the chat panel with message
 * display, input area, send/stop buttons, and conversation switching.
 *
 * @see specs/01-mvp/spec.md — FR-4, FR-5
 * @see design/ux.md — chat panel layout, message display
 */

import { ItemView, MarkdownRenderer, Menu, Modal, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import type NotorPlugin from "../main";
import type { ConversationMode, Message, ModelInfo, ModelPreset, Checkpoint, Persona } from "../types";
import type { Attachment } from "../context/attachment";
import {
	createVaultNoteAttachment,
	createVaultNoteSectionAttachment,
} from "../context/attachment";
import type { ConversationListEntry } from "../chat/history";
import type { PersonaManager } from "../personas/persona-manager";
import { logger } from "../utils/logger";
import { groupModels, formatVariantLabel, buildOptionValue, type ModelGroup } from "../providers/model-grouping";
import {
	renderWriteNoteDiffPreview,
	renderReplaceInNoteDiffPreview,
} from "./diff-view";
import {
	VaultNoteSuggest,
	createAttachmentButton,
	getAbsoluteFilePath,
	readExternalBinaryFile,
	readExternalPdfFile,
	IMAGE_EXTENSIONS,
	PDF_EXTENSIONS,
} from "./attachment-picker";
import {
	createExternalFileAttachment,
	createExternalBinaryAttachment,
	createExternalPdfAttachment,
	readExternalFile,
	isDuplicate,
} from "../context/attachment";
import { AttachmentChipManager, createAttachmentChipContainer } from "./attachment-chips";
import { WorkflowSlashSuggest, detectSlashTrigger } from "./workflow-suggest";
import { resolveNote } from "../utils/resolve-note";
import { findExistingLeaf } from "../tools/note-opener";
import { WorkflowActivityIndicator } from "./workflow-activity-indicator";
import type { WorkflowActivityTracker } from "../workflows/workflow-activity-tracker";
import type { ConversationSession } from "../chat/conversation-session";
import type { Workflow } from "../types";
import { McpStatusIndicator } from "./mcp-status-indicator";
import { getTextContent, type ContentBlock } from "../media/types";
import { renderCollapsibleCard } from "./chat-blocks/collapsible-card";
import { FindInMessages } from "./find-in-messages";
import { marked } from "marked";

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
 * Extract the `<attachments>…</attachments>` XML block from a message string.
 *
 * Returns the raw block and the remaining text (with leading/trailing whitespace
 * stripped). If no block is present, `attachmentsXml` is `null` and `remainder`
 * equals the original content unchanged.
 */
function extractAttachmentsBlock(content: string): { attachmentsXml: string | null; remainder: string } {
	const ATTACHMENTS_RE = /<attachments>([\s\S]*?)<\/attachments>/;
	const match = ATTACHMENTS_RE.exec(content);
	if (!match) return { attachmentsXml: null, remainder: content };
	const attachmentsXml = match[0];
	const remainder = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
	return { attachmentsXml, remainder };
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
	private inputAreaEl!: HTMLElement;
	private inputToolbarEl!: HTMLElement;
	private resizeHandler?: () => void;
	private userDragHeight: number | null = null;
	private textInputEl!: HTMLDivElement;
	private sendButtonEl!: HTMLButtonElement;
	private stopButtonEl!: HTMLButtonElement;
	private modeToggleEl!: HTMLButtonElement;
	private conversationListEl!: HTMLElement;
	private conversationSearchInputEl!: HTMLInputElement;
	private loadingIndicatorEl!: HTMLElement;
	private tokenFooterEl!: HTMLElement;
	private attachmentChipContainerEl!: HTMLElement;

	// State
	private isResponding = false;
	private abortController: AbortController | null = null;
	private showConversationList = false;
	private lastToolCallEl: HTMLElement | null = null;
	private streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingStreamRender: { contentEl: HTMLElement; raw: string } | null = null;
	/** Map of message IDs to their rendered tool call elements, for targeted approval. */
	private toolCallElMap = new Map<string, HTMLElement>();
	private renderedMessages = new Map<string, Message>();
	/** Whether to auto-scroll to the bottom on new content. Set to false when the user scrolls up. */
	private autoScroll = true;

	// Attachment state
	private pendingAttachments: Attachment[] = [];
	private attachmentChipManager!: AttachmentChipManager;
	private vaultNoteSuggest?: VaultNoteSuggest;
	private tokenObserver?: MutationObserver;

	// Workflow slash-command state (E-010, E-012)
	private workflowSuggest?: WorkflowSlashSuggest;
	private pendingWorkflow: Workflow | null = null;
	private getWorkflowsCallback?: () => Workflow[];

	// Workflow send callback (E-012)
	private onSendWorkflow?: (workflow: Workflow, supplementaryText: string) => Promise<void>;

	// Settings popover state
	private settingsPopoverEl?: HTMLElement;
	private isSettingsOpen = false;
	private settingsOutsideClickHandler?: (e: MouseEvent) => void;
	private settingsEscapeHandler?: (e: KeyboardEvent) => void;

	/**
	 * Display-only overrides for provider/model shown in the settings popover.
	 *
	 * Set by `updateProviderDisplay()` / `updateModelDisplay()` when the user
	 * switches to a conversation that was using a different provider/model.
	 * Cleared when the user explicitly changes the picker.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1f
	 */
	private displayedProviderId: string | null = null;
	private displayedModelValue: string | null = null;
	/** Display-only preset name override (set during conversation switch). */
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
	private headerTitleInputEl?: HTMLInputElement;
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
	private favFilterBtnEl?: HTMLElement;

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
	}

	setOnStopResponse(callback: () => void): void {
		this.onStopResponse = callback;
	}

	setOnNewConversation(callback: () => void): void {
		this.onNewConversation = callback;
	}

	setOnSwitchConversation(callback: (filename: string) => void): void {
		this.onSwitchConversation = callback;
	}

	setOnExportConversation(callback: (filename: string) => void): void {
		this.onExportConversation = callback;
	}

	setOnDeleteConversation(callback: (filename: string) => void): void {
		this.onDeleteConversation = callback;
	}

	setOnToggleFavorite(callback: (filename: string) => Promise<void>): void {
		this.onToggleFavorite = callback;
	}

	setOnRenameConversation(callback: (filename: string, currentTitle: string) => void): void {
		this.onRenameConversation = callback;
	}

	setOnDirectRename(callback: (filename: string, newTitle: string) => Promise<void>): void {
		this.onDirectRename = callback;
	}

	setGetActiveConversationMeta(callback: () => ActiveConversationMeta | null): void {
		this.getActiveConversationMeta = callback;
	}

	isFavFilterActive(): boolean {
		return this.favFilterActive;
	}

	setOnImportConversation(callback: (htmlContent: string) => Promise<void>): void {
		this.onImportConversation = callback;
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
	}

	setOnSearchConversations(callback: (query: string) => Promise<ConversationListEntry[]>): void {
		this.onSearchConversations = callback;
	}

	setOnModeToggle(callback: (mode: ConversationMode) => void): void {
		this.onModeToggle = callback;
	}

	setOnSettingsOpen(callback: () => void): void {
		this.onSettingsOpen = callback;
	}

	setOnProviderChange(callback: (providerId: string) => void): void {
		this.onProviderChange = callback;
	}

	setOnModelChange(callback: (modelId: string) => void): void {
		this.onModelChange = callback;
	}

	setOnRefreshModels(callback: () => Promise<ModelInfo[]>): void {
		this.onRefreshModels = callback;
	}

	setGetAvailableProviders(callback: () => { id: string; type: string; displayName: string }[]): void {
		this.getAvailableProviders = callback;
	}

	setGetAvailableModels(callback: () => ModelInfo[]): void {
		this.getAvailableModels = callback;
	}

	setGetCurrentProvider(callback: () => string): void {
		this.getCurrentProvider = callback;
	}

	setGetCurrentModel(callback: () => string): void {
		this.getCurrentModel = callback;
	}

	setOnPresetChange(callback: (presetName: string | null, providerId?: string, modelId?: string, useExtendedContext?: boolean) => void): void {
		this.onPresetChange = callback;
	}

	setGetAvailablePresets(callback: () => ModelPreset[]): void {
		this.getAvailablePresets = callback;
	}

	setGetCurrentPreset(callback: () => string | null): void {
		this.getCurrentPreset = callback;
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
	}

	setOnRestoreCheckpoint(callback: (checkpointId: string) => Promise<boolean>): void {
		this.onRestoreCheckpoint = callback;
	}

	setOnGetCurrentContent(callback: (notePath: string) => Promise<string | null>): void {
		this.onGetCurrentContent = callback;
	}

	setOnForkConversation(callback: (messageId: string) => Promise<void>): void {
		this.onForkConversation = callback;
	}

	setOnForkToNewPanel(callback: (messageId: string | undefined, initialText?: string) => Promise<void>): void {
		this.onForkToNewPanel = callback;
	}

	setOnOpenInNewTab(callback: (filename: string) => void): void {
		this.onOpenInNewTab = callback;
	}

	setOnOpenSettingsGroup(callback: (groupTitle: string, subsection?: string) => void): void {
		this.onOpenSettingsGroup = callback;
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
			this.toggleConversationList();
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
			const toolbar = this.inputToolbarEl ?? this.inputAreaEl;
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
				this.personaLabelEl.style.color = persona.chip_color;
				this.personaLabelEl.style.background = `${persona.chip_color}20`;
				this.personaLabelEl.style.borderColor = `${persona.chip_color}40`;
			} else {
				this.personaLabelEl.style.color = "";
				this.personaLabelEl.style.background = "";
				this.personaLabelEl.style.borderColor = "";
			}
		} else {
			this.personaLabelEl.textContent = "🎭 Default";
			this.personaLabelEl.addClass("notor-persona-label--default");
			this.personaLabelEl.style.color = "";
			this.personaLabelEl.style.background = "";
			this.personaLabelEl.style.borderColor = "";
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
							pm.deactivatePersona();
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
								void pm.activatePersona(p.name).then((ok) => {
									if (ok) {
										this.applyPersonaSwitch(p);
									} else {
										new Notice(`Failed to activate persona '${p.name}'`);
									}
								});
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
		// If the popover is currently open, close and reopen to reflect the change
		if (this.settingsPopoverEl) {
			this.closeSettingsPopover();
			this.openSettingsPopover();
		}
	}

	/**
	 * Update the displayed model in the settings popover without triggering
	 * the global `onModelChange` callback.
	 *
	 * Accepts the composite option value (e.g. `"claude-3-opus::1m"` for
	 * extended context), same format as `getCurrentModel()` returns.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1f
	 */
	updateModelDisplay(modelValue: string): void {
		this.displayedModelValue = modelValue;
		if (this.settingsPopoverEl) {
			this.refreshModelSelect();
		}
	}

	/**
	 * Update the displayed preset in the settings popover without triggering
	 * callbacks. Used during conversation switch to show the correct preset.
	 *
	 * @param presetName - Preset name, or null for "Custom" display
	 * @see specs/ZZ-misc/model-presets-design.md — Section 6.3
	 */
	updatePresetDisplay(presetName: string | null): void {
		this.displayedPresetName = presetName;
		if (this.settingsPopoverEl) {
			this.closeSettingsPopover();
			this.openSettingsPopover();
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
		this.buildConversationList(container);
		this.buildMessageList(container);
		this.buildInputArea(container);

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

		// Disconnect the inline token mutation observer
		this.tokenObserver?.disconnect();
		this.tokenObserver = undefined;

		// Clean up window resize listener
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
			this.resizeHandler = undefined;
		}

		// H-002: Clean up workflow activity indicator DOM and callbacks
		this.workflowActivityIndicator?.destroy();
		this.workflowActivityIndicator = undefined;

		// INT-005: Clean up MCP status indicator
		this.mcpStatusIndicator?.destroy();
		this.mcpStatusIndicator = undefined;

		this.findInMessages?.destroy();
		this.findInMessages = undefined;

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
			this.startHeaderTitleEdit();
		});
		this.headerTitleEl.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.showHeaderTitleContextMenu(e);
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
		listBtn.addEventListener("click", () => this.toggleConversationList());

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
			this.toggleSettingsPopover();
		});

		// New conversation button
		const newBtn = actions.createEl("button", {
			cls: "notor-chat-header-btn clickable-icon",
			attr: { "aria-label": "New conversation" },
		});
		setIcon(newBtn, "message-square-plus");
		newBtn.addEventListener("click", () => {
			if (this.showConversationList) {
				this.toggleConversationList();
			}
			this.onNewConversation?.();
			this.textInputEl.focus();
		});

		// Right-click: show context menu with "current panel" vs "new panel" options
		newBtn.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			this.showNewConversationMenu(e);
		});

		// Middle-click: immediately open a new chat panel
		newBtn.addEventListener("auxclick", (e) => {
			if (e.button !== 1) return;
			e.preventDefault();
			this.plugin.openChatInNewTab(undefined, true);
		});
	}

	private buildConversationList(container: HTMLElement): void {
		// Search input (sibling above the scrollable list, hidden together)
		const searchWrapper = container.createDiv({
			cls: "notor-conversation-search notor-hidden",
		});
		this.conversationSearchInputEl = searchWrapper.createEl("input", {
			type: "text",
			placeholder: "Search conversations…",
			cls: "notor-conversation-search-input",
		});
		this.conversationSearchInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const query = this.conversationSearchInputEl.value.trim();
				const applyFavFilter = (entries: ConversationListEntry[]) =>
					this.favFilterActive ? entries.filter((en) => en.is_favorite) : entries;
				if (!query) {
					// Empty query — reload full list
					this.onOpenConversationList?.().then((entries) => {
						this.renderConversationList(applyFavFilter(entries));
					}).catch((err) => {
						log.error("Failed to load conversation list", { error: String(err) });
					});
				} else {
					this.onSearchConversations?.(query).then((entries) => {
						this.renderConversationList(applyFavFilter(entries));
					}).catch((err) => {
						log.error("Failed to search conversations", { error: String(err) });
					});
				}
			}
		});

		// Import conversation button
		const importBtn = searchWrapper.createDiv({
			cls: "notor-conversation-import-btn",
			attr: { "aria-label": "Import conversation from HTML" },
		});
		setIcon(importBtn, "upload");
		importBtn.addEventListener("click", () => {
			this.openImportFilePicker();
		});

		// Favorites filter toggle
		this.favFilterBtnEl = searchWrapper.createDiv({
			cls: "notor-conversation-fav-filter-btn",
			attr: { "aria-label": "Show favorites only" },
		});
		setIcon(this.favFilterBtnEl, "star");
		this.favFilterBtnEl.addEventListener("click", () => {
			this.favFilterActive = !this.favFilterActive;
			this.favFilterBtnEl?.toggleClass("is-active", this.favFilterActive);
			this.favFilterBtnEl?.setAttribute(
				"aria-label",
				this.favFilterActive ? "Show all conversations" : "Show favorites only"
			);
			// Re-fetch and render with filter
			const query = this.conversationSearchInputEl.value.trim();
			const fetcher = query
				? this.onSearchConversations?.(query)
				: this.onOpenConversationList?.();
			fetcher?.then((entries) => {
				if (this.favFilterActive) {
					entries = entries.filter((e) => e.is_favorite);
				}
				this.renderConversationList(entries);
			});
		});

		this.conversationListEl = container.createDiv({
			cls: "notor-conversation-list notor-hidden",
		});
	}

	/**
	 * Open a file picker for importing a conversation from an exported HTML file.
	 * Reads the selected file via FileReader and passes the content to the
	 * import callback.
	 */
	private openImportFilePicker(): void {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".html";
		input.style.display = "none";
		document.body.appendChild(input);

		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (!file) {
				input.remove();
				return;
			}

			const reader = new FileReader();
			reader.onload = () => {
				const htmlContent = reader.result as string;
				this.onImportConversation?.(htmlContent)?.catch((err) => {
					log.error("Failed to import conversation", { error: String(err) });
				});
				input.remove();
			};
			reader.onerror = () => {
				log.error("Failed to read imported file", { error: String(reader.error) });
				input.remove();
			};
			reader.readAsText(file);
		});

		input.click();
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
			const target = (evt.target as HTMLElement).closest("[data-message-id]") as HTMLElement | null;
			const messageId = target?.dataset.messageId ?? null;
			const selectedText = window.getSelection()?.toString().trim() ?? "";
			const menu = new Menu();
			let hasItems = false;

			if (messageId) {
				const message = this.renderedMessages.get(messageId);
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

	/**
	 * Recalculate the text input height. The input grows to fit its content up
	 * to the greater of 10% of the window height or 3 full lines of text.
	 * When the user has manually dragged the resize handle, their chosen
	 * height is used as the minimum (content can still push beyond it).
	 */
	private recalcInputHeight(): void {
		this.textInputEl.setCssProps({ '--notor-input-height': 'auto' });
		const lineHeight = parseFloat(getComputedStyle(this.textInputEl).lineHeight) || 20;
		const padding = 12 + 2; // 6px top + 6px bottom padding + 2px border

		const maxLines = this.plugin.settings.chat_input_max_lines;
		const linesH = (lineHeight * maxLines) + padding;

		if (this.userDragHeight !== null) {
			// User has manually set the height — use it as minimum, but still
			// allow auto-expand if content exceeds it
			const newHeight = Math.max(this.userDragHeight, this.textInputEl.scrollHeight);
			this.textInputEl.setCssProps({
				'--notor-input-height': newHeight + 'px',
				'--notor-input-max-height': newHeight + 'px',
			});
			return;
		}

		const pctH = window.innerHeight * (this.plugin.settings.chat_input_max_height_pct / 100);
		const maxH = Math.max(pctH, linesH);
		const newHeight = Math.min(this.textInputEl.scrollHeight, maxH);
		this.textInputEl.setCssProps({
			'--notor-input-height': newHeight + 'px',
			'--notor-input-max-height': maxH + 'px',
		});
	}

	/**
	 * Wire up pointer events on the resize handle so the user can
	 * drag-resize the input height vertically. Dragging up increases
	 * height; dragging down decreases it (clamped to a 3-line minimum).
	 */
	private setupInputResizeHandle(handle: HTMLElement): void {
		handle.addEventListener("pointerdown", (startEvent) => {
			startEvent.preventDefault();
			const startY = startEvent.clientY;
			const startHeight = this.textInputEl.getBoundingClientRect().height;
			const lineHeight = parseFloat(getComputedStyle(this.textInputEl).lineHeight) || 20;
			const padding = 12 + 2;
			const minHeight = (lineHeight * this.plugin.settings.chat_input_max_lines) + padding;

			const onPointerMove = (moveEvent: PointerEvent) => {
				// Handle is above the input: dragging up (negative deltaY) increases height
				const deltaY = startY - moveEvent.clientY;
				const newHeight = Math.max(minHeight, startHeight + deltaY);
				this.userDragHeight = newHeight;
				this.textInputEl.setCssProps({
					'--notor-input-height': newHeight + 'px',
					'--notor-input-max-height': newHeight + 'px',
				});
			};

			const onPointerUp = () => {
				document.removeEventListener("pointermove", onPointerMove);
				document.removeEventListener("pointerup", onPointerUp);
			};

			document.addEventListener("pointermove", onPointerMove);
			document.addEventListener("pointerup", onPointerUp);
		});
	}

	private buildInputArea(container: HTMLElement): void {
		this.inputAreaEl = container.createDiv({ cls: "notor-input-area" });

		// Resize handle — allows the user to drag-resize the input height
		const resizeHandle = this.inputAreaEl.createDiv({ cls: "notor-input-resize-handle" });
		this.setupInputResizeHandle(resizeHandle);

		// Text input wrapper (full width, above toolbar)
		const inputWrapper = this.inputAreaEl.createDiv({ cls: "notor-input-wrapper" });

		// Attachment chip container (above the text input)
		this.attachmentChipContainerEl = createAttachmentChipContainer(inputWrapper);
		this.attachmentChipManager = new AttachmentChipManager(
			this.attachmentChipContainerEl,
			(attachmentId: string) => this.removeAttachment(attachmentId)
		);

		// contenteditable div — required for AbstractInputSuggest<T> attachment
		// autocomplete (see R-1 findings). Replaces the former <textarea>.
		this.textInputEl = inputWrapper.createDiv({
			cls: "notor-text-input",
			attr: {
				contenteditable: "true",
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": "Ask Notor...",
				"data-placeholder": "Ask Notor...",
			},
		});

		// Auto-resize contenteditable div
		this.textInputEl.addEventListener("paste", () => {
			// paste fires before clipboard content is committed to the DOM;
			// defer one tick so scrollHeight reflects the pasted content.
			setTimeout(() => this.recalcInputHeight(), 0);
		});
		this.textInputEl.addEventListener("input", () => {
			this.recalcInputHeight();

			// Detect `[[` trigger for vault note autocomplete
			this.detectWikilinkTrigger();

			// Detect `/` trigger for workflow slash-command autocomplete (E-012)
			this.detectSlashCommandTrigger();
		});

		// Recalculate max height when the window is resized
		this.resizeHandler = () => this.recalcInputHeight();
		window.addEventListener("resize", this.resizeHandler);

		// Enter to send, Shift+Enter for newline; Tab to select workflow or note suggestion (E-012)
		this.textInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (this.tryHandleBtw()) return;
				void this.handleSend();
			} else if (e.key === "Tab") {
				if (this.workflowSuggest?.active) {
					e.preventDefault();
					this.workflowSuggest.selectFirst();
				} else if (this.vaultNoteSuggest?.active) {
					e.preventDefault();
					this.vaultNoteSuggest.selectFirst();
				}
			} else if (e.key === "ArrowDown") {
				// Shadow-track arrow navigation so Tab picks the highlighted item.
				// Do NOT preventDefault — Obsidian's scope must also receive it for visual highlight.
				if (this.workflowSuggest?.active) {
					log.debug("ChatView keydown ArrowDown → workflowSuggest.navigateSelection");
					this.workflowSuggest.navigateSelection(1);
				} else if (this.vaultNoteSuggest?.active) {
					log.debug("ChatView keydown ArrowDown → vaultNoteSuggest.navigateSelection");
					this.vaultNoteSuggest.navigateSelection(1);
				}
			} else if (e.key === "ArrowUp") {
				if (this.workflowSuggest?.active) {
					log.debug("ChatView keydown ArrowUp → workflowSuggest.navigateSelection");
					this.workflowSuggest.navigateSelection(-1);
				} else if (this.vaultNoteSuggest?.active) {
					log.debug("ChatView keydown ArrowUp → vaultNoteSuggest.navigateSelection");
					this.vaultNoteSuggest.navigateSelection(-1);
				}
			}
		});

		// Force plain-text pastes so rich-text content cannot pollute the input
		// (required since we removed -webkit-user-modify: read-write-plaintext-only
		// to allow contenteditable="false" spans to behave as atomic units).
		// If the pasted text contains an inline workflow reference (/name or /name.md)
		// that exactly matches a known workflow, convert it to a workflow token.
		this.textInputEl.addEventListener("paste", (e) => {
			e.preventDefault();
			const text = e.clipboardData?.getData("text/plain") ?? "";
			if (!this.textInputEl.querySelector("[data-workflow-path]")) {
				if (this.tryInsertPastedWorkflowToken(text)) return;
			}
			this.insertTextAtCursor(text);
		});

		// Collect all Elements with data-attachment-id at or under a given node.
		const collectTokenElements = (node: Node): Element[] => {
			const results: Element[] = [];
			if (node instanceof Element) {
				if (node.hasAttribute("data-attachment-id")) results.push(node);
				node
					.querySelectorAll("[data-attachment-id]")
					.forEach((el) => results.push(el));
			}
			return results;
		};

		// Collect all Elements with data-workflow-path at or under a given node.
		const collectWorkflowTokenElements = (node: Node): Element[] => {
			const results: Element[] = [];
			if (node instanceof Element) {
				if (node.hasAttribute("data-workflow-path")) results.push(node);
				node
					.querySelectorAll("[data-workflow-path]")
					.forEach((el) => results.push(el));
			}
			return results;
		};

		// Watch for inline wikilink token spans being added or removed.
		//
		// Removal (Backspace / Delete): remove the attachment from pendingAttachments.
		//
		// Addition (Undo after deletion): the browser restores the span to the DOM
		// but pendingAttachments was already cleared — reconstruct the attachment
		// from the metadata attributes stored on the span and re-add it.
		// The dedup check (some(a => a.id === id)) prevents double-adding on the
		// normal insertion path, where addWikilinkAttachment() fires synchronously
		// before this microtask observer callback runs.
		//
		// Workflow tokens (data-workflow-path) are also handled here: removal clears
		// pendingWorkflow; addition (undo) looks up the workflow by path and re-attaches.
		this.tokenObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const removed of Array.from(mutation.removedNodes)) {
					for (const el of collectTokenElements(removed)) {
						const id = el.getAttribute("data-attachment-id");
						if (id) {
							this.pendingAttachments = this.pendingAttachments.filter(
								(a) => a.id !== id
							);
						}
					}
					for (const el of collectWorkflowTokenElements(removed)) {
						if (el.hasAttribute("data-workflow-path")) {
							this.removeWorkflow();
						}
					}
				}
				for (const added of Array.from(mutation.addedNodes)) {
					for (const el of collectTokenElements(added)) {
						const id = el.getAttribute("data-attachment-id");
						const path = el.getAttribute("data-attachment-path");
						const type = el.getAttribute("data-attachment-type");
						const section = el.getAttribute("data-attachment-section");
						if (!id || !path || !type) continue;
						// Already tracked — normal insertion path, skip.
						if (this.pendingAttachments.some((a) => a.id === id)) continue;
						// Undo path: reconstruct and re-add with the original id.
						const attachment =
							type === "vault_note_section" && section
								? createVaultNoteSectionAttachment(path, section)
								: createVaultNoteAttachment(path);
						attachment.id = id;
						this.pendingAttachments.push(attachment);
					}
					for (const el of collectWorkflowTokenElements(added)) {
						const workflowPath = el.getAttribute("data-workflow-path");
						if (!workflowPath) continue;
						// Already tracked — normal insertion path (attachWorkflow fires
						// synchronously before this observer callback), skip.
						if (this.pendingWorkflow?.file_path === workflowPath) continue;
						// Undo path: look up the workflow by path and re-attach.
						const workflow = this.getWorkflowsCallback?.().find(
							(w) => w.file_path === workflowPath
						);
						if (workflow) this.attachWorkflow(workflow);
					}
				}
			}
		});
		this.tokenObserver.observe(this.textInputEl, {
			childList: true,
			subtree: true,
		});

		// Initialize vault note suggest (lazy — created once, reused).
		// Uses addWikilinkAttachment (no chip — token is rendered inline).
		this.vaultNoteSuggest = new VaultNoteSuggest(
			this.app,
			this.textInputEl,
			(attachment: Attachment) => this.addWikilinkAttachment(attachment),
			() => this.pendingAttachments
		);

		// Initialize workflow slash suggest (E-010, E-012)
		this.workflowSuggest = new WorkflowSlashSuggest(
			this.app,
			this.textInputEl,
			(workflow: Workflow) => this.attachWorkflow(workflow),
			() => this.getWorkflowsCallback?.() ?? []
		);

		// Toolbar row below the input (mode toggle left, buttons right)
		this.inputToolbarEl = this.inputAreaEl.createDiv({ cls: "notor-input-toolbar" });

		// Mode toggle (left side of toolbar)
		this.modeToggleEl = this.inputToolbarEl.createEl("button", {
			cls: "notor-mode-toggle notor-mode-plan",
			text: "Plan",
			attr: { "aria-label": "Toggle plan/act mode" },
		});
		this.modeToggleEl.addEventListener("click", () => this.handleModeToggle());

		// Button wrapper (right side of toolbar)
		const buttonWrapper = this.inputToolbarEl.createDiv({ cls: "notor-input-buttons" });

		// Attachment button
		createAttachmentButton(
			buttonWrapper,
			this.app,
			this.textInputEl,
			(attachment: Attachment) => this.addAttachment(attachment),
			() => this.pendingAttachments,
			this.plugin.settings.external_file_size_threshold_mb,
			this.plugin.settings,
		);

		// Send button
		this.sendButtonEl = buttonWrapper.createEl("button", {
			cls: "notor-send-btn",
			attr: { "aria-label": "Send message" },
		});
		setIcon(this.sendButtonEl, "send");
		this.sendButtonEl.addEventListener("click", () => {
			if (this.tryHandleBtw()) return;
			void this.handleSend();
		});

		// Stop button (hidden by default)
		this.stopButtonEl = buttonWrapper.createEl("button", {
			cls: "notor-stop-btn notor-hidden",
			attr: { "aria-label": "Stop response" },
		});
		setIcon(this.stopButtonEl, "octagon-pause");
		this.stopButtonEl.addEventListener("click", () => this.handleStop());

		// Drag-and-drop support for images and PDFs
		this.setupDragAndDrop();
	}

	/**
	 * Set up drag-and-drop handlers on the input area for images, PDFs, and text files.
	 */
	private setupDragAndDrop(): void {
		let dragCounter = 0;

		this.inputAreaEl.addEventListener("dragover", (e) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
		});

		this.inputAreaEl.addEventListener("dragenter", (e) => {
			e.preventDefault();
			dragCounter++;
			if (dragCounter === 1) {
				this.inputAreaEl.addClass("notor-drop-active");
			}
		});

		this.inputAreaEl.addEventListener("dragleave", (e) => {
			e.preventDefault();
			dragCounter--;
			if (dragCounter === 0) {
				this.inputAreaEl.removeClass("notor-drop-active");
			}
		});

		this.inputAreaEl.addEventListener("drop", (e) => {
			e.preventDefault();
			dragCounter = 0;
			this.inputAreaEl.removeClass("notor-drop-active");

			const files = Array.from(e.dataTransfer?.files ?? []);
			if (files.length === 0) return;

			const settings = this.plugin.settings;
			const existing = this.pendingAttachments;

			for (const file of files) {
				const absolutePath = getAbsoluteFilePath(file);
				if (!absolutePath) {
					new Notice(`Cannot read file path for: ${file.name}`);
					continue;
				}

				if (isDuplicate(existing, { path: absolutePath })) {
					new Notice(`Already attached: ${file.name}`);
					continue;
				}

				const ext = "." + (file.name.split(".").pop()?.toLowerCase() ?? "");

				if (IMAGE_EXTENSIONS.has(ext)) {
					void (async () => {
						try {
							const result = await readExternalBinaryFile(absolutePath, settings);
							if (!result) {
								new Notice(`Failed to process image: ${file.name}`);
								return;
							}
							const att = createExternalBinaryAttachment(
								absolutePath,
								file.name,
								result.base64,
								result.mediaType,
								result.width,
								result.height,
							);
							this.addAttachment(att);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Failed to process image ${file.name}: ${msg}`);
						}
					})();
				} else if (PDF_EXTENSIONS.has(ext)) {
					void (async () => {
						try {
							const result = await readExternalPdfFile(absolutePath);
							if (!result) {
								new Notice(`Failed to process PDF: ${file.name}`);
								return;
							}
							const att = createExternalPdfAttachment(
								absolutePath,
								file.name,
								result.base64,
								result.pageCount,
								result.extractedText,
								result.extractedImages,
							);
							this.addAttachment(att);
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`Failed to process PDF ${file.name}: ${msg}`);
						}
					})();
				} else {
					// Text file
					const result = readExternalFile(
						absolutePath,
						file.name,
						settings.external_file_size_threshold_mb,
					);
					if (!result.success) {
						new Notice(result.error ?? `Failed to read file: ${file.name}`);
						continue;
					}
					const att = createExternalFileAttachment(absolutePath, file.name, result.content!);
					this.addAttachment(att);
				}
			}
		});
	}

	// -----------------------------------------------------------------------
	// User interactions
	// -----------------------------------------------------------------------

	/**
	 * Check if the input starts with `/btw` and handle it as a fork-to-new-panel.
	 * Returns true if handled (caller should return early).
	 */
	private tryHandleBtw(): boolean {
		const content = this.getInputContentExcludingWorkflowToken();
		const match = content.match(/^\/btw(?:\s+([\s\S]*))?$/i);
		if (!match) return false;

		const initialText = match[1]?.trim() || undefined;
		this.textInputEl.textContent = "";
		this.onForkToNewPanel?.(undefined, initialText);
		return true;
	}

	private async handleSend(): Promise<void> {
		if (this.isResponding) return;

		// Re-engage auto-scroll for the new exchange so the user sees the response as it streams in.
		this.autoScroll = true;

		// Capture pending workflow before clearing state (E-012)
		const pendingWorkflow = this.pendingWorkflow;

		// Supplementary text is the input content minus the inline workflow token text.
		// (The workflow token span is contenteditable=false so its text is included
		// in textContent — we exclude it so the executor receives only what the user typed.)
		const content = this.getInputContentExcludingWorkflowToken();

		// Guard: no content AND no workflow AND no attachments
		if (!content && this.pendingAttachments.length === 0 && !pendingWorkflow) return;

		// Capture and clear attachments before sending
		const attachments = [...this.pendingAttachments];
		this.pendingAttachments = [];
		this.attachmentChipManager.clear();

		// Clear workflow state (E-012) — token is removed when textContent is cleared below
		this.pendingWorkflow = null;

		this.textInputEl.textContent = "";
		this.userDragHeight = null;
		this.textInputEl.setCssProps({ '--notor-input-height': 'auto', '--notor-input-max-height': '' });

		try {
			if (pendingWorkflow && this.onSendWorkflow) {
				// Route to the workflow execution path (E-012, E-013)
				await this.onSendWorkflow(pendingWorkflow, content);
			} else {
				await this.onSendMessage?.(content, attachments);
			}
		} catch (e) {
			log.error("Send message failed", { error: String(e) });
			new Notice(`Failed to send message: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private handleStop(): void {
		this.abortController?.abort();
		this.onStopResponse?.();
		// Do NOT call setRespondingState(false) here — the finally block in
		// orchestrator.handleUserMessage() already does this after the response
		// loop fully completes (including storing the cancelled assistant message).
		// Calling it here re-enables input before the cancellation is processed,
		// creating a race where the next user message can be inserted before the
		// cancelled assistant message is stored.

		// Clean up any pending approval prompts so the user gets visual feedback
		// that the cancel took effect. The abort signal will resolve the approval
		// Promise via Promise.race in the callback, but the DOM elements linger.
		this.messageListEl.querySelectorAll(".notor-approval-prompt").forEach((el) => el.remove());
	}

	private handleModeToggle(): void {
		const currentMode = this.modeToggleEl.textContent?.toLowerCase() as ConversationMode;
		const newMode: ConversationMode = currentMode === "plan" ? "act" : "plan";
		this.updateModeDisplay(newMode);
		this.onModeToggle?.(newMode);
	}

	private toggleConversationList(): void {
		this.showConversationList = !this.showConversationList;
		const searchWrapper = this.conversationSearchInputEl.parentElement;
		if (this.showConversationList) {
			searchWrapper?.removeClass("notor-hidden");
			this.conversationListEl.removeClass("notor-hidden");
			this.messageListEl.addClass("notor-hidden");
			// Clear search and focus input
			this.conversationSearchInputEl.value = "";
			this.conversationSearchInputEl.focus();
			// Refresh the list from disk every time the panel opens
			if (this.onOpenConversationList) {
				this.onOpenConversationList().then((entries) => {
					this.renderConversationList(entries);
				}).catch((e) => {
					log.error("Failed to load conversation list", { error: String(e) });
				});
			}
		} else {
			searchWrapper?.addClass("notor-hidden");
			this.conversationListEl.addClass("notor-hidden");
			this.messageListEl.removeClass("notor-hidden");
		}
	}

	// -----------------------------------------------------------------------
	// Public UI update methods (called by orchestrator)
	// -----------------------------------------------------------------------

	/**
	 * Set whether the AI is currently responding.
	 * Controls send/stop button visibility and input state.
	 */
	/** Pre-fill the input box with text (used by /btw auto-send and draft restore). */
	setInputText(text: string): void {
		this.textInputEl.textContent = text;
		this.recalcInputHeight();
	}

	/** Return the current raw text content of the input box. */
	getInputText(): string {
		return this.textInputEl.textContent ?? "";
	}

	/** Programmatically trigger a send (used after setInputText for /btw auto-send). */
	triggerSend(): void {
		void this.handleSend();
	}

	setRespondingState(responding: boolean): void {
		this.isResponding = responding;

		if (responding) {
			this.sendButtonEl.addClass("notor-hidden");
			this.stopButtonEl.removeClass("notor-hidden");
			// Input stays editable so the user can type /btw during streaming.
			// The isResponding guard in handleSend() blocks normal sends.
			this.loadingIndicatorEl.removeClass("notor-hidden");
		} else {
			this.sendButtonEl.removeClass("notor-hidden");
			this.stopButtonEl.addClass("notor-hidden");
			this.loadingIndicatorEl.addClass("notor-hidden");
			if (this.app.workspace.activeLeaf === this.leaf) {
				this.textInputEl.focus();
			}
		}
	}

	/**
	 * Update the mode toggle display.
	 */
	updateModeDisplay(mode: ConversationMode): void {
		this.modeToggleEl.textContent = mode === "plan" ? "Plan" : "Act";
		this.modeToggleEl.removeClass("notor-mode-plan", "notor-mode-act");
		this.modeToggleEl.addClass(mode === "plan" ? "notor-mode-plan" : "notor-mode-act");
	}

	appendForkButton(msgEl: HTMLElement, message?: Message): void {
		if (message) {
			this.renderedMessages.set(message.id, message);
		}
		const btn = msgEl.createDiv({ cls: "notor-copy-btn" });
		setIcon(btn, "copy");
		btn.ariaLabel = "Copy message contents";
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const messageId = msgEl.dataset.messageId;
			if (!messageId) return;
			const msg = this.renderedMessages.get(messageId);
			if (!msg) return;
			void navigator.clipboard.writeText(getTextContent(msg.content)).then(() => {
				new Notice("Copied");
			});
		});
	}

	/**
	 * Render a user message in the message list.
	 *
	 * Hook injection messages (identified by `is_hook_injection`) are
	 * rendered via {@link renderHookInjection} instead.
	 *
	 * Workflow messages (identified by `is_workflow_message`) render any
	 * `<workflow_instructions type="…">…</workflow_instructions>` block as a
	 * collapsed `<details>` element (E-014). Text outside the tag — such as
	 * supplementary user text after the closing tag — is rendered normally as
	 * a paragraph below the details element.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-014
	 */
	renderUserMessage(message: Message): void {
		if (message.is_hook_injection) {
			this.renderHookInjection(message);
			return;
		}

		const msgEl = this.messageListEl.createDiv({ cls: "notor-message notor-message-user" });
		msgEl.dataset.messageId = message.id;
		this.appendForkButton(msgEl, message);
		const contentEl = msgEl.createDiv({ cls: "notor-message-content" });

		// Extract <attachments> block (if any) and render as collapsed <details>
		const textContent = getTextContent(message.content);
		const { attachmentsXml, remainder } = extractAttachmentsBlock(textContent);
		if (attachmentsXml !== null) {
			this.renderAttachmentsBlock(contentEl, attachmentsXml);
		}
		const textToRender = attachmentsXml !== null ? remainder : textContent;

		// E-014: Detect <workflow_instructions> block and render as collapsible <details>
		if (message.is_workflow_message) {
			this.renderWorkflowMessage(contentEl, textToRender);
		} else if (textToRender) {
			contentEl.createEl("p", { text: textToRender });
		}

		this.scrollToBottom();
	}

	/**
	 * Render a workflow message with the `<workflow_instructions>` block as a
	 * collapsed `<details>` element and any supplementary text as a paragraph.
	 *
	 * Regex: `/<workflow_instructions\s+type="([^"]*)">([\s\S]*?)<\/workflow_instructions>/`
	 *
	 * - If the regex matches, the matched block is rendered as `<details>`.
	 * - Text before the opening tag (e.g. `<trigger_context>` for event-triggered
	 *   workflows) is rendered as a collapsed-by-default `<details>` element.
	 * - Text after the closing tag (supplementary user text from the slash-command)
	 *   is rendered as a normal paragraph.
	 * - If the regex does not match (plain workflow message), falls back to plain text.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-014
	 */
	private renderWorkflowMessage(container: HTMLElement, content: string): void {
		const WORKFLOW_RE = /<workflow_instructions\s+type="([^"]*)">([\s\S]*?)<\/workflow_instructions>/;
		const match = WORKFLOW_RE.exec(content);

		if (!match) {
			// Fallback: render as plain text if no <workflow_instructions> block found
			container.createEl("p", { text: content });
			return;
		}

		const matchStart = match.index;
		const matchEnd = match.index + match[0].length;
		const workflowType = match[1] ?? "";
		const workflowBody = match[2] ?? "";

		const beforeText = content.slice(0, matchStart).trim();
		const afterText = content.slice(matchEnd).trim();

		// Render text before the block (e.g., <trigger_context> for event-triggered workflows)
		if (beforeText) {
			const triggerDetails = container.createEl("details", { cls: "notor-trigger-context-details" });
			triggerDetails.createEl("summary", { text: "Trigger context" });
			const pre = triggerDetails.createEl("pre");
			pre.createEl("code", { text: beforeText });
		}

		// Render the workflow instructions as a collapsed <details> element
		const details = container.createEl("details", { cls: "notor-workflow-details" });
		details.createEl("summary", { text: `Workflow: ${workflowType}` });
		const bodyEl = details.createDiv({ cls: "notor-workflow-content" });
		bodyEl.textContent = workflowBody;

		// Render supplementary text after the closing tag
		if (afterText) {
			container.createEl("p", { text: afterText });
		}
	}

	/**
	 * Render hook injection output as a collapsible element in the chat
	 * panel (ACI-002).
	 *
	 * The content is sent to the LLM as a separate `user` message, but
	 * displayed to the human as a `<details>` block collapsed by default
	 * so it doesn't clutter the conversation.
	 */
	renderHookInjection(message: Message): void {
		const wrapper = this.messageListEl.createDiv({ cls: "notor-hook-injection" });
		const details = wrapper.createEl("details");
		details.createEl("summary", { text: "Hook output" });
		const pre = details.createEl("pre", { cls: "notor-hook-injection-content" });
		pre.createEl("code", { text: getTextContent(message.content) });
		this.scrollToBottom();
	}

	/**
	 * Render an `<attachments>` XML block as a collapsed `<details>` element.
	 */
	private renderAttachmentsBlock(container: HTMLElement, xml: string): void {
		const details = container.createEl("details", { cls: "notor-attachments-details" });
		details.createEl("summary", { text: "Attachments" });
		const pre = details.createEl("pre", { cls: "notor-attachments-content" });
		pre.createEl("code", { text: xml });
	}

	/**
	 * Create a placeholder for a streaming assistant message.
	 * Returns the content element to append chunks to.
	 */
	createAssistantMessagePlaceholder(): HTMLElement {
		const msgEl = this.messageListEl.createDiv({ cls: "notor-message notor-message-assistant" });
		const contentEl = msgEl.createDiv({ cls: "notor-message-content" });
		this.scrollToBottom();
		return contentEl;
	}

	/**
	 * Append a text chunk to a streaming assistant message.
	 * Renders markdown incrementally via throttled marked.parse().
	 */
	appendStreamChunk(contentEl: HTMLElement, text: string): void {
		const existing = contentEl.getAttribute("data-raw") ?? "";
		const updated = existing + text;
		contentEl.setAttribute("data-raw", updated);

		this.pendingStreamRender = { contentEl, raw: updated };
		if (!this.streamRenderTimer) {
			this.renderStreamMarkdown(contentEl, updated);
			this.streamRenderTimer = setTimeout(() => {
				this.streamRenderTimer = null;
				if (this.pendingStreamRender) {
					this.renderStreamMarkdown(this.pendingStreamRender.contentEl, this.pendingStreamRender.raw);
					this.pendingStreamRender = null;
				}
			}, 100);
		}
	}

	private renderStreamMarkdown(contentEl: HTMLElement, raw: string): void {
		contentEl.innerHTML = marked.parse(raw, { async: false }) as string;
		this.scrollToBottom();
	}

	/**
	 * Finalize a streaming assistant message with full markdown rendering.
	 */
	async finalizeAssistantMessage(contentEl: HTMLElement, message: Message): Promise<void> {
		if (this.streamRenderTimer) {
			clearTimeout(this.streamRenderTimer);
			this.streamRenderTimer = null;
			this.pendingStreamRender = null;
		}
		contentEl.parentElement!.dataset.messageId = message.id;
		this.appendForkButton(contentEl.parentElement!, message);
		contentEl.empty();
		const assistantText = typeof message.content === "string"
			? message.content
			: (() => { throw new Error("Expected string content for assistant message"); })();
		await MarkdownRenderer.render(
			this.app,
			assistantText,
			contentEl,
			"",
			this
		);
		this.activateInternalLinks(contentEl);
		this.activateSettingsLinks(contentEl);
		this.activateConversationLinks(contentEl);

		// Add token annotation if available
		if (message.input_tokens || message.output_tokens) {
			const tokenEl = contentEl.createDiv({ cls: "notor-message-tokens" });
			const parts: string[] = [];
			if (message.input_tokens) parts.push(`↑${message.input_tokens}`);
			if (message.output_tokens) parts.push(`↓${message.output_tokens}`);
			tokenEl.textContent = parts.join(" · ");
		}

		this.scrollToBottom();
	}

	/**
	 * Attach click handlers to internal links within a rendered message element.
	 * Resolves note paths via resolveNote() and opens/focuses the target note.
	 */
	private activateInternalLinks(containerEl: HTMLElement): void {
		const handleLinkClick = (e: MouseEvent) => {
			const link = (e.target as HTMLElement).closest("a.internal-link");
			if (!link) return;
			e.preventDefault();
			const href = link.getAttribute("data-href");
			if (href) this.openInternalLink(href);
		};

		containerEl.addEventListener("click", handleLinkClick);
		containerEl.addEventListener("auxclick", (e) => {
			if (e.button !== 1) return; // middle-click only
			handleLinkClick(e);
		});
	}

	/**
	 * Attach click handlers to settings deep-links (notor-settings:// URLs)
	 * within a rendered message element. Opens Obsidian settings to the target group.
	 *
	 * Must attach directly to the `<a>` elements rather than using event delegation,
	 * because Obsidian's own click handler on rendered external links intercepts
	 * the event and stops propagation before a container-level listener can see it.
	 */
	private activateSettingsLinks(containerEl: HTMLElement): void {
		const prefix = "notor-settings://";
		const allLinks = containerEl.querySelectorAll<HTMLAnchorElement>("a");
		log.debug("activateSettingsLinks: scanning rendered content", {
			totalAnchors: allLinks.length,
			hasCallback: !!this.onOpenSettingsGroup,
		});

		// Log all anchor attributes for diagnostics
		for (const link of allLinks) {
			const href = link.getAttribute("href");
			const dataHref = link.getAttribute("data-href");
			const cls = link.className;
			const text = link.textContent?.substring(0, 60);
			log.debug("activateSettingsLinks: anchor found", { href, dataHref, cls, text });
		}

		let matched = 0;
		for (const link of allLinks) {
			const href = link.getAttribute("href") ?? link.getAttribute("data-href") ?? "";
			if (!href.startsWith(prefix)) continue;
			matched++;

			const raw = href.slice(prefix.length);
			const slashIdx = raw.indexOf("/");
			const groupTitle = decodeURIComponent(slashIdx === -1 ? raw : raw.slice(0, slashIdx));
			const subsection = slashIdx === -1 ? undefined : decodeURIComponent(raw.slice(slashIdx + 1));
			log.debug("activateSettingsLinks: matched settings link", { groupTitle, subsection, href });

			// Attach directly so it fires before Obsidian's external-link handler.
			link.addEventListener("click", (e: MouseEvent) => {
				log.debug("activateSettingsLinks: click fired", { groupTitle, subsection });
				e.preventDefault();
				e.stopPropagation();
				this.onOpenSettingsGroup?.(groupTitle, subsection);
			});

			// Remove href so Obsidian doesn't also try to open it externally.
			link.removeAttribute("href");
			link.dataset.notorSettingsGroup = groupTitle;
			link.classList.add("notor-settings-link");
		}

		log.debug("activateSettingsLinks: scan complete", { matched, total: allLinks.length });
	}

	/**
	 * Attach click handlers to conversation deep-links (notor-conversation:// URLs)
	 * within a rendered message element. Navigates to the referenced conversation.
	 *
	 * Same attachment strategy as activateSettingsLinks — must bind directly to
	 * `<a>` elements before Obsidian's external-link handler intercepts them.
	 */
	private activateConversationLinks(containerEl: HTMLElement): void {
		const prefix = "notor-conversation://";
		const allLinks = containerEl.querySelectorAll<HTMLAnchorElement>("a");

		for (const link of allLinks) {
			const href = link.getAttribute("href") ?? link.getAttribute("data-href") ?? "";
			if (!href.startsWith(prefix)) continue;

			const conversationId = decodeURIComponent(href.slice(prefix.length));

			link.addEventListener("click", (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				this.plugin.openChatInNewTab(undefined, false, undefined, conversationId);
			});

			link.removeAttribute("href");
			link.classList.add("notor-conversation-link");
		}
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

	/**
	 * Get the most recently rendered tool call element.
	 * Used by the approval callback in main.ts to attach the approval prompt.
	 */
	getLastToolCallEl(): HTMLElement | null {
		return this.lastToolCallEl;
	}

	/**
	 * Get the tool call element for a specific message ID.
	 * Used by the approval callback to target the correct element
	 * when multiple tool calls are rendered in one turn.
	 */
	getToolCallEl(messageId: string): HTMLElement | null {
		return this.toolCallElMap.get(messageId) ?? null;
	}

	/**
	 * Get the messages container element for compaction markers.
	 * Phase 3 (COMP-004).
	 */
	getMessagesContainer(): HTMLElement {
		return this.messageListEl;
	}

	/**
	 * Update the status badge on an existing tool call card.
	 *
	 * Called by the orchestrator after tool dispatch completes to
	 * reflect success/error/rejected state in the UI.
	 */
	updateToolCallStatus(toolEl: HTMLElement, status: string): void {
		const statusEl = toolEl.querySelector(".notor-tool-call-status");
		if (!statusEl) return;
		statusEl.className = `notor-tool-call-status notor-tool-status-${status}`;
		statusEl.textContent = status;

		// Remove progress indicator on completion
		const progressEl = toolEl.querySelector(".notor-tool-call-progress");
		if (progressEl) progressEl.remove();
	}

	/**
	 * Update the progress text on an in-flight tool call card.
	 *
	 * Called by the orchestrator via the `onProgressMap` wired through
	 * `executeToolBatches()` → dispatcher → `tool.execute()`.
	 * Used by long-running tools like `use_subagent` (Phase 8.1).
	 */
	updateToolCallProgress(toolEl: HTMLElement, status: string): void {
		let progressEl = toolEl.querySelector(".notor-tool-call-progress") as HTMLElement | null;
		if (!progressEl) {
			progressEl = toolEl.createDiv({ cls: "notor-tool-call-progress" });
		}
		progressEl.textContent = status;
		this.scrollToBottom();
	}

	/**
	 * Render a tool call inline in the message list.
	 */
	renderToolCall(message: Message): HTMLElement {
		const toolCall = message.tool_call;
		if (!toolCall) return this.messageListEl.createDiv();

		const toolEl = this.messageListEl.createDiv({ cls: "notor-tool-call" });

		// Header row: tool name + status
		const headerEl = toolEl.createDiv({ cls: "notor-tool-call-header" });
		const nameEl = headerEl.createSpan({ cls: "notor-tool-call-name" });
		nameEl.textContent = toolCall.tool_name;

		const statusEl = headerEl.createSpan({
			cls: `notor-tool-call-status notor-tool-status-${toolCall.status}`,
		});
		statusEl.textContent = toolCall.status;

		// Collapsible parameters
		const { body: paramsEl } = renderCollapsibleCard(toolEl, { headerText: "parameters" });
		paramsEl.addClass("notor-tool-call-params");
		const pre = paramsEl.createEl("pre");
		pre.createEl("code", { text: JSON.stringify(toolCall.parameters, null, 2) });

		this.lastToolCallEl = toolEl;
		if (message.id) {
			this.toolCallElMap.set(message.id, toolEl);
		}
		this.scrollToBottom();
		return toolEl;
	}

	/**
	 * Render a tool result inline in the message list.
	 */
	renderToolResult(message: Message): void {
		const toolResult = message.tool_result;
		if (!toolResult) return;

		const resultEl = this.messageListEl.createDiv({ cls: "notor-tool-result" });
		resultEl.dataset.messageId = message.id;
		this.appendForkButton(resultEl, message);

		// Summary line
		const summaryEl = resultEl.createDiv({ cls: "notor-tool-result-summary" });
		if (toolResult.success) {
			summaryEl.addClass("notor-tool-result-success");
			const resultStr = typeof toolResult.result === "string"
				? toolResult.result
				: JSON.stringify(toolResult.result);
			summaryEl.textContent = `✓ ${resultStr.substring(0, 100)}${resultStr.length > 100 ? "…" : ""}`;
		} else {
			summaryEl.addClass("notor-tool-result-error");
			summaryEl.textContent = `✗ ${toolResult.error ?? "Unknown error"}`;
		}

		// Collapsible full result
		if (toolResult.success) {
			const resultStr = typeof toolResult.result === "string"
				? toolResult.result
				: JSON.stringify(toolResult.result, null, 2);

			if (resultStr.length > 100) {
				const { body: fullEl } = renderCollapsibleCard(resultEl, { headerText: "full result" });
				fullEl.addClass("notor-tool-result-full");
				const pre = fullEl.createEl("pre");
				pre.createEl("code", { text: resultStr });
			}
		}

		this.scrollToBottom();
	}

	/**
	 * Render an extension_block message as a dedicated row in the message list.
	 */
	renderExtensionBlock(message: Message): void {
		const rowEl = this.messageListEl.createDiv({ cls: "notor-extension-block" });
		rowEl.dataset.messageId = message.id;
		this.populateExtensionBlockEl(rowEl, message);
		this.scrollToBottom();
	}

	hasMessageElement(messageId: string): boolean {
		return !!this.messageListEl.querySelector(`[data-message-id="${messageId}"]`);
	}

	/**
	 * Re-render an extension_block message in place (loading → real).
	 * Finds the existing DOM element by message ID, clears it, and re-renders.
	 */
	reRenderExtensionBlock(message: Message): void {
		const existing = this.messageListEl.querySelector(`[data-message-id="${message.id}"]`) as HTMLElement | null;
		if (!existing || !existing.classList.contains("notor-extension-block")) return;
		existing.empty();
		this.populateExtensionBlockEl(existing, message);
	}

	private populateExtensionBlockEl(el: HTMLElement, message: Message): void {
		const blocks = Array.isArray(message.content) ? message.content : [];

		if (message.source_extension) {
			el.createDiv({ cls: "notor-extension-block-source", text: message.source_extension });
		}

		const registry = this.plugin.getChatBlockRegistry();
		const ctx = {
			message,
			app: this.app,
			openInternalLink: (linkText: string) => this.openInternalLink(linkText),
			collapsibleCard: renderCollapsibleCard,
			pendingMemoryManager: this.plugin.getPendingMemoryManager(),
		};

		for (const block of blocks) {
			const b = block as ContentBlock;
			if (b.type === "text") {
				el.createDiv({ cls: "notor-extension-block-text", text: b.text });
			} else if (b.type === "custom_block") {
				const def = registry.get(b.kind);
				const blockEl = el.createDiv({ cls: "notor-extension-block-content" });

				if (def) {
					if (b.loading && def.renderLoading) {
						try {
							def.renderLoading(blockEl, ctx);
						} catch (e) {
							log.error("renderLoading threw", { kind: b.kind, error: String(e) });
							blockEl.empty();
							this.renderExtensionBlockError(blockEl, b.kind, b.data, e);
						}
					} else if (b.loading) {
						blockEl.createDiv({ cls: "notor-extension-block-loading", text: `Loading ${def.displayName}…` });
					} else {
						try {
							def.render(blockEl, b.data, ctx);
						} catch (e) {
							log.error("Block render error", { kind: b.kind, error: String(e) });
							blockEl.empty();
							this.renderExtensionBlockError(blockEl, b.kind, b.data, e);
						}
					}
				} else {
					// Show "disabled extension" placeholder when the source extension is
					// explicitly disabled in settings; otherwise generic unregistered warning.
					const sourceExt = message.source_extension;
					const isExplicitlyDisabled = sourceExt != null &&
						this.plugin.settings.tool_enabled[sourceExt] === false;
					const headerText = isExplicitlyDisabled
						? `[disabled extension: ${sourceExt}]`
						: `Unregistered block kind: ${b.kind}`;
					const { body } = renderCollapsibleCard(blockEl, { headerText });
					if (b.fallback_text) {
						body.createEl("p", { text: b.fallback_text, cls: "notor-extension-block-fallback" });
					}
				}
			}
		}
	}

	private renderExtensionBlockError(container: HTMLElement, kind: string, data: Record<string, unknown>, _error: unknown): void {
		const errorEl = container.createDiv({ cls: "notor-extension-block-error" });
		errorEl.createDiv({ cls: "notor-extension-block-error-header", text: `Block render error: ${kind}` });
		const pre = errorEl.createEl("pre");
		pre.createEl("code", { text: JSON.stringify(data, null, 2) });
	}

	/**
	 * Render an inline approval prompt for a tool call.
	 * Returns a promise that resolves with the user's decision.
	 */
	renderApprovalPrompt(toolCallEl: HTMLElement, autoApproved = false): Promise<"approved" | "rejected"> {
		if (autoApproved) {
			return Promise.resolve("approved");
		}
		return new Promise((resolve) => {
			const approvalEl = toolCallEl.createDiv({ cls: "notor-approval-prompt" });
			approvalEl.createSpan({ text: "Approve this action?", cls: "notor-approval-text" });

			const btnContainer = approvalEl.createDiv({ cls: "notor-approval-buttons" });
			this.scrollToBottom();

			const approveBtn = btnContainer.createEl("button", {
				cls: "notor-approve-btn",
				text: "Approve",
			});

			const rejectBtn = btnContainer.createEl("button", {
				cls: "notor-reject-btn",
				text: "Reject",
			});

			approveBtn.addEventListener("click", () => {
				approvalEl.remove();
				resolve("approved");
			});

			rejectBtn.addEventListener("click", () => {
				approvalEl.remove();
				resolve("rejected");
			});
		});
	}

	/**
	 * Render a diff-based approval prompt for write tool calls.
	 *
	 * For `write_note` and `replace_in_note`, reads the current file content
	 * and renders a full diff preview with approve/reject controls. For all
	 * other tools falls back to the plain approval prompt.
	 *
	 * @param toolCallEl  - The tool call card element to render into.
	 * @param toolName    - The name of the tool being called.
	 * @param parameters  - The tool parameters (path, content / changes).
	 * @returns Promise resolving to "approved" or "rejected".
	 */
	async renderDiffApprovalPrompt(
		toolCallEl: HTMLElement,
		toolName: string,
		parameters: Record<string, unknown>,
		autoApproved = false
	): Promise<"approved" | "rejected"> {
		const notePath = parameters["path"] as string | undefined;

		if (!notePath) {
			return this.renderApprovalPrompt(toolCallEl, autoApproved);
		}

		if (toolName === "write_note") {
			const afterContent = (parameters["content"] as string | undefined) ?? "";

			// Read current file content (empty string for new files)
			let beforeContent = "";
			try {
				const file = this.app.vault.getFileByPath(notePath);
				if (file) {
					beforeContent = await this.app.vault.read(file);
				}
			} catch {
				// New file — beforeContent stays empty
			}

			// Render the diff. Scroll once to show the action buttons; after that the
			// user is free to scroll up and read the full diff without being fought back.
			const decisionPromise = renderWriteNoteDiffPreview(
				this.messageListEl,
				notePath,
				beforeContent,
				afterContent,
				autoApproved,
				() => this.scrollToBottom()
			);
			this.scrollToBottom();
			const decision = await decisionPromise;
			return decision.accepted ? "approved" : "rejected";
		}

		if (toolName === "replace_in_note") {
			const changeBlocks = (parameters["changes"] as Array<{ search: string; replace: string }> | undefined) ?? [];

			// Read current note content
			let noteContent = "";
			try {
				const file = this.app.vault.getFileByPath(notePath);
				if (file) {
					noteContent = await this.app.vault.read(file);
				}
			} catch {
				// Fall back to plain prompt if file unreadable
				return this.renderApprovalPrompt(toolCallEl, autoApproved);
			}

			if (!noteContent) {
				return this.renderApprovalPrompt(toolCallEl, autoApproved);
			}

			// Render the diff. Scroll once to show the action buttons; after that the
			// user is free to scroll up and read the full diff without being fought back.
			const decisionPromise = renderReplaceInNoteDiffPreview(
				this.messageListEl,
				notePath,
				noteContent,
				changeBlocks,
				autoApproved,
				() => this.scrollToBottom()
			);
			this.scrollToBottom();
			const decision = await decisionPromise;
			if (!decision.accepted) return "rejected";

			// Filter changes to only include user-accepted blocks so the
			// tool executes with the partial selection (parameters is the
			// same object reference the dispatcher passes to tool.execute()).
			if (decision.acceptedBlockIndexes) {
				parameters["changes"] = changeBlocks.filter((_, i) =>
					decision.acceptedBlockIndexes!.has(i)
				);
			}
			return "approved";
		}

		// Other tools: use the plain approval prompt
		return this.renderApprovalPrompt(toolCallEl, autoApproved);
	}

	/**
	 * Update the token/cost footer for the conversation.
	 */
	updateTokenFooter(
		inputTokens: number,
		outputTokens: number,
		estimatedCost: number | null
	): void {
		this.tokenFooterEl.empty();
		this.tokenFooterEl.removeClass("notor-hidden");

		const parts: string[] = [
			`Tokens: ↑${inputTokens.toLocaleString()} ↓${outputTokens.toLocaleString()}`,
		];

		if (estimatedCost != null) {
			parts.push(`Cost: $${estimatedCost.toFixed(4)}`);
		}

		this.tokenFooterEl.textContent = parts.join(" · ");
	}

	/**
	 * Populate the conversation list panel.
	 */
	renderConversationList(entries: ConversationListEntry[]): void {
		this.conversationListEl.empty();

		if (entries.length === 0) {
			this.conversationListEl.createDiv({
				cls: "notor-conversation-list-empty",
				text: "No conversations yet",
			});
			return;
		}

		for (const entry of entries) {
			const isActive = entry.id === this.activeConversationId;
			const item = this.conversationListEl.createDiv({
				cls: `notor-conversation-list-item${isActive ? " is-active" : ""}`,
			});
			item.setAttribute("data-conversation-id", entry.id);

			const contentCol = item.createDiv({ cls: "notor-conversation-list-content" });

			const titleEl = contentCol.createDiv({ cls: "notor-conversation-list-title" });
			titleEl.textContent = entry.title ?? "Untitled";

			// Fork lineage badge — clickable link to parent conversation
			if (entry.forked_from_conversation_id) {
				const parentEntry = entries.find(
					(e) => e.id === entry.forked_from_conversation_id
				);
				if (parentEntry) {
					const badge = titleEl.createSpan({ cls: "notor-fork-badge" });
					setIcon(badge, "git-branch-plus");
					badge.setAttribute("aria-label", "Go to parent conversation");
					badge.addEventListener("click", (e) => {
						e.stopPropagation();
						this.onSwitchConversation?.(parentEntry.filename);
						this.toggleConversationList();
					});
				}
			}

			const metaEl = contentCol.createDiv({ cls: "notor-conversation-list-meta" });
			const date = new Date(entry.updated_at);
			metaEl.textContent = this.formatRelativeTime(date);

			if (entry.preview) {
				const previewEl = contentCol.createDiv({ cls: "notor-conversation-list-preview" });
				previewEl.textContent = entry.preview;
			}

			// Right-side actions column
			const actionsCol = item.createDiv({ cls: "notor-conversation-item-actions" });

			// Three-dots menu button
			const menuBtn = actionsCol.createDiv({ cls: "notor-conversation-menu-btn" });
			setIcon(menuBtn, "more-vertical");
			menuBtn.setAttribute("aria-label", "More options");
			menuBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.showConversationContextMenu(e, entry);
			});

			// Favorite star indicator (always visible when favorited)
			if (entry.is_favorite) {
				const starEl = actionsCol.createDiv({ cls: "notor-conversation-favorite-indicator" });
				setIcon(starEl, "star");
			}

			// Right-click context menu
			item.addEventListener("contextmenu", (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.showConversationContextMenu(e, entry);
			});

			item.addEventListener("click", () => {
				this.onSwitchConversation?.(entry.filename);
				this.toggleConversationList();
			});
		}
	}

	/**
	 * Update the title of a specific conversation in the list DOM without
	 * re-rendering the entire list. No-op if the item isn't rendered.
	 */
	updateConversationTitleInList(conversationId: string, title: string): void {
		const items = this.conversationListEl.querySelectorAll(".notor-conversation-list-item");
		for (const item of items) {
			if (item.getAttribute("data-conversation-id") !== conversationId) continue;
			const titleEl = item.querySelector(".notor-conversation-list-title");
			if (titleEl) {
				titleEl.textContent = title;
			}
			return;
		}
	}

	/**
	 * Update the conversation title displayed in the header bar.
	 * Shows the element when a title is set; hides it for null/empty.
	 * Guards against stale updates by checking conversationId.
	 */
	updateHeaderTitle(conversationId: string, title: string | null): void {
		if (!this.headerTitleEl) return;
		if (conversationId !== this.activeConversationId) return;

		if (title) {
			this.headerTitleEl.textContent = title;
			this.headerTitleEl.removeClass("notor-hidden");
		} else {
			this.headerTitleEl.textContent = "";
			this.headerTitleEl.addClass("notor-hidden");
		}
	}

	updateHeaderFavorite(conversationId: string, isFavorite: boolean): void {
		if (!this.headerFavoriteEl) return;
		if (conversationId !== this.activeConversationId) return;

		if (isFavorite) {
			this.headerFavoriteEl.removeClass("notor-hidden");
		} else {
			this.headerFavoriteEl.addClass("notor-hidden");
		}
	}

	/**
	 * Show context menu for the active conversation title in the header.
	 * Reuses the same menu as the conversation list context menu.
	 */
	private showHeaderTitleContextMenu(evt: MouseEvent): void {
		const meta = this.getActiveConversationMeta?.();
		if (!meta) return;

		const entry: ConversationListEntry = {
			id: meta.id,
			title: meta.title,
			filename: meta.filename,
			is_favorite: meta.is_favorite,
			updated_at: "",
			created_at: "",
			provider_id: "",
			model_id: "",
		};

		this.showConversationContextMenu(evt, entry);
	}

	/**
	 * Start inline editing of the header conversation title.
	 * Replaces the title span with an input field. Enter saves, Esc/blur cancels.
	 */
	private startHeaderTitleEdit(): void {
		const meta = this.getActiveConversationMeta?.();
		if (!meta || !this.headerTitleEl) return;

		// If already editing, no-op
		if (this.headerTitleInputEl) return;

		const currentTitle = meta.title ?? "Untitled";

		// Hide the title span
		this.headerTitleEl.addClass("notor-hidden");

		// Create input element as sibling, inserted after the title span
		const input = document.createElement("input");
		input.type = "text";
		input.value = currentTitle;
		input.className = "notor-header-title-input";
		this.headerTitleEl.parentElement!.insertBefore(input, this.headerTitleEl.nextSibling);
		this.headerTitleInputEl = input;

		input.select();
		input.focus();

		const commit = () => {
			const newTitle = input.value.trim();
			cleanup();
			if (newTitle && newTitle !== currentTitle) {
				void this.onDirectRename?.(meta.filename, newTitle);
			}
		};

		const cancel = () => {
			cleanup();
		};

		const cleanup = () => {
			input.removeEventListener("blur", onBlur);
			input.remove();
			this.headerTitleInputEl = undefined;
			this.headerTitleEl!.removeClass("notor-hidden");
		};

		const onBlur = () => cancel();

		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				commit();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancel();
			}
		});

		input.addEventListener("blur", onBlur);
	}

	/**
	 * Show a context menu for a conversation list item.
	 */
	private showConversationContextMenu(evt: MouseEvent, entry: ConversationListEntry): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle(entry.is_favorite ? "Remove from favorites" : "Add to favorites")
				.setIcon(entry.is_favorite ? "star-off" : "star")
				.onClick(() => {
					this.onToggleFavorite?.(entry.filename);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Rename")
				.setIcon("pencil")
				.onClick(() => {
					this.onRenameConversation?.(entry.filename, entry.title ?? "Untitled");
				});
		});

		menu.addSeparator();

		menu.addItem((item) => {
			item.setTitle("Open in new tab")
				.setIcon("blocks")
				.onClick(() => {
					this.onOpenInNewTab?.(entry.filename);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Export conversation")
				.setIcon("download")
				.onClick(() => {
					this.onExportConversation?.(entry.filename);
				});
		});

		menu.addItem((item) => {
			item.setTitle("Copy conversation link")
				.setIcon("link")
				.onClick(async () => {
					const uri = `obsidian://notor?id=${encodeURIComponent(entry.id)}`;
					await navigator.clipboard.writeText(uri);
					new Notice("Conversation link copied to clipboard");
				});
		});

		menu.addItem((item) => {
			item.setTitle("Copy conversation ID")
				.setIcon("hash")
				.onClick(async () => {
					await navigator.clipboard.writeText(entry.id);
					new Notice("Conversation ID copied");
				});
		});

		menu.addItem((item) => {
			item.setTitle("Delete conversation")
				.setIcon("trash-2")
				.onClick(() => {
					this.onDeleteConversation?.(entry.filename);
				});
		});

		menu.showAtMouseEvent(evt);
	}

	private showNewConversationMenu(evt: MouseEvent): void {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle("New conversation")
				.setIcon("message-square-plus")
				.onClick(() => {
					if (this.showConversationList) {
						this.toggleConversationList();
					}
					this.onNewConversation?.();
					this.textInputEl.focus();
				});
		});

		menu.addItem((item) => {
			item.setTitle("New conversation in new panel")
				.setIcon("layout-dashboard")
				.onClick(() => {
					this.plugin.openChatInNewTab(undefined, true);
				});
		});

		menu.showAtMouseEvent(evt);
	}

	/**
	 * Clear all messages from the display.
	 */
	clearMessages(): void {
		this.findInMessages?.close();
		this.messageListEl.empty();
		this.tokenFooterEl.addClass("notor-hidden");
		this.toolCallElMap.clear();
		this.renderedMessages.clear();
		this.lastToolCallEl = null;
	}

	/**
	 * Display a context window truncation warning.
	 */
	showTruncationWarning(truncatedCount: number): void {
		const warningEl = this.messageListEl.createDiv({ cls: "notor-truncation-warning" });
		warningEl.textContent = `⚠ ${truncatedCount} older message${truncatedCount > 1 ? "s" : ""} trimmed from AI context to fit within the model's context window. Full history is still visible above and saved in the log.`;
		this.scrollToBottom();
	}

	/**
	 * Display an error message in the chat.
	 */
	showError(error: string): void {
		const errorEl = this.messageListEl.createDiv({ cls: "notor-chat-error" });
		errorEl.textContent = `⚠ ${error}`;
		this.scrollToBottom();
	}

	// -----------------------------------------------------------------------
	// Attachment management
	// -----------------------------------------------------------------------

	/**
	 * Add a vault-note attachment that was inserted as an inline wikilink token.
	 * No chip is created — the visual representation is the token span itself.
	 */
	private addWikilinkAttachment(attachment: Attachment): void {
		this.pendingAttachments.push(attachment);
		log.debug("Wikilink attachment added", {
			id: attachment.id,
			type: attachment.type,
			display: attachment.display_name,
		});
	}

	/**
	 * Add an attachment to the pending list and render its chip.
	 */
	private addAttachment(attachment: Attachment): void {
		this.pendingAttachments.push(attachment);
		this.attachmentChipManager.addChip(attachment);
		log.debug("Attachment added", {
			id: attachment.id,
			type: attachment.type,
			display: attachment.display_name,
		});
	}

	/**
	 * Remove an attachment from the pending list and its chip.
	 */
	private removeAttachment(attachmentId: string): void {
		this.pendingAttachments = this.pendingAttachments.filter(
			(a) => a.id !== attachmentId
		);
		this.attachmentChipManager.removeChip(attachmentId);
		log.debug("Attachment removed", { id: attachmentId });
	}

	// -----------------------------------------------------------------------
	// Workflow slash-command management (E-012)
	// -----------------------------------------------------------------------

	/**
	 * Track the selected workflow in state.
	 *
	 * Called after the inline workflow token is inserted into the input.
	 * The token itself is the visual representation; no separate chip is rendered.
	 */
	private attachWorkflow(workflow: Workflow): void {
		this.pendingWorkflow = workflow;
		log.debug("Workflow attached via slash command", {
			display_name: workflow.display_name,
		});
	}

	/**
	 * Clear `pendingWorkflow`.
	 *
	 * Called by the MutationObserver when the inline workflow token is removed
	 * (Backspace) or by handleSend after capturing the workflow for dispatch.
	 */
	private removeWorkflow(): void {
		this.pendingWorkflow = null;
		log.debug("Workflow token removed");
	}

	/**
	 * Parse pasted text for an inline workflow reference (`/name` or `/name.md`)
	 * and, if an exact match is found, insert the workflow token with surrounding text.
	 *
	 * Only the first matching reference is converted. References with no exact
	 * match are left as plain text (caller falls through to insertTextAtCursor).
	 *
	 * @returns true if a workflow token was inserted (caller should skip plain insert).
	 */
	private tryInsertPastedWorkflowToken(text: string): boolean {
		const workflows = this.getWorkflowsCallback?.() ?? [];
		if (workflows.length === 0) return false;

		// Match /word at start of string or after whitespace.
		// Group 1: preceding whitespace char (or "" at start of string).
		// Group 2: the word after /.
		const pattern = /(^|\s)\/(\S+)/g;
		let match: RegExpExecArray | null;
		let foundWorkflow: Workflow | null = null;
		let matchStart = -1;
		let matchEnd = -1;

		while ((match = pattern.exec(text)) !== null) {
			const ref = match[2] ?? "";
			const name = ref.endsWith(".md") ? ref.slice(0, -3) : ref;
			const workflow = workflows.find((w) => w.display_name === name) ?? null;
			if (workflow) {
				foundWorkflow = workflow;
				// Skip the leading whitespace captured in group 1 so matchStart
				// points at the "/" character itself.
				matchStart = match.index + (match[1]?.length ?? 0);
				matchEnd = match.index + match[0].length;
				break;
			}
		}

		if (!foundWorkflow) return false;

		const beforeText = text.slice(0, matchStart);
		const afterText = text.slice(matchEnd);

		if (beforeText) this.insertTextAtCursor(beforeText);
		this.insertWorkflowTokenAtCursor(foundWorkflow);
		if (afterText) this.insertTextAtCursor(afterText);

		return true;
	}

	/**
	 * Insert a workflow token span at the current cursor position.
	 * Called from `tryInsertPastedWorkflowToken` after any preceding text is inserted.
	 */
	private insertWorkflowTokenAtCursor(workflow: Workflow): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		range.deleteContents();

		const tokenSpan = document.createElement("span");
		tokenSpan.className = "notor-workflow-token";
		tokenSpan.contentEditable = "false";
		tokenSpan.setAttribute("data-workflow-path", workflow.file_path);
		tokenSpan.setAttribute("data-workflow-name", workflow.display_name);
		tokenSpan.textContent = `/${workflow.display_name}`;
		range.insertNode(tokenSpan);

		// Trailing space so the cursor can sit after the token.
		const spacer = document.createTextNode(" ");
		tokenSpan.after(spacer);

		// Move cursor to after the spacer.
		const newRange = document.createRange();
		newRange.setStart(spacer, 1);
		newRange.collapse(true);
		sel.removeAllRanges();
		sel.addRange(newRange);

		this.attachWorkflow(workflow);
		log.debug("Workflow token inserted from paste", {
			display_name: workflow.display_name,
		});
	}

	/**
	 * Insert plain text at the current cursor position using the Selection/Range
	 * API.  This replaces the deprecated `document.execCommand("insertText")`
	 * while remaining consistent with `insertWorkflowTokenAtCursor`.
	 */
	private insertTextAtCursor(text: string): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		range.deleteContents();

		const node = document.createTextNode(text);
		range.insertNode(node);

		// Move cursor to the end of the inserted text.
		const newRange = document.createRange();
		newRange.setStart(node, node.length);
		newRange.collapse(true);
		sel.removeAllRanges();
		sel.addRange(newRange);
	}

	/**
	 * Read the chat input text content, skipping the inline workflow token span.
	 *
	 * `textInputEl.textContent` includes the text of `contenteditable="false"`
	 * spans (e.g. `/daily-review`). We exclude the workflow token so the
	 * supplementaryText passed to the executor contains only what the user typed,
	 * not the slash-command trigger text.
	 */
	private getInputContentExcludingWorkflowToken(): string {
		let text = "";
		for (const node of Array.from(this.textInputEl.childNodes)) {
			if (node instanceof HTMLElement && node.hasAttribute("data-workflow-path")) continue;
			text += node.textContent ?? "";
		}
		return text.trim();
	}

	/**
	 * Detect `/` trigger in the chat input and activate `WorkflowSlashSuggest`.
	 *
	 * Only activates when `VaultNoteSuggest` is NOT active (prevents
	 * interference between the two suggests). Called from the `input`
	 * event handler alongside `detectWikilinkTrigger()`.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-012
	 */
	private detectSlashCommandTrigger(): void {
		// Don't activate if the wikilink suggest is active
		if (this.vaultNoteSuggest?.["isActive"]) return;

		// Don't activate if a workflow token is already present — only one workflow
		// can be attached per message.
		if (this.textInputEl.querySelector("[data-workflow-path]")) return;

		const text = this.textInputEl.textContent ?? "";
		const slashIdx = detectSlashTrigger(text);

		if (slashIdx !== null && this.workflowSuggest) {
			this.workflowSuggest.activate(slashIdx);
		}
	}

	/**
	 * Detect `[[` in the chat input and activate the vault note suggest.
	 */
	private detectWikilinkTrigger(): void {
		const text = this.textInputEl.textContent ?? "";
		const triggerIdx = text.lastIndexOf("[[");

		if (triggerIdx !== -1 && this.vaultNoteSuggest) {
			// Check there's no `]]` closing the link after the `[[`
			const afterTrigger = text.slice(triggerIdx + 2);
			if (!afterTrigger.includes("]]")) {
				this.vaultNoteSuggest.activate(triggerIdx);
			}
		}
	}

	// -----------------------------------------------------------------------
	// Settings popover (CHAT-008)
	// -----------------------------------------------------------------------

	private toggleSettingsPopover(): void {
		if (this.isSettingsOpen) {
			this.closeSettingsPopover();
		} else {
			this.openSettingsPopover();
		}
	}

	private openSettingsPopover(): void {
		this.closeSettingsPopover();
		if (this.showConversationList) {
			this.toggleConversationList();
		}
		this.isSettingsOpen = true;

		this.settingsPopoverEl = this.headerEl.createDiv({ cls: "notor-settings-popover" });

		// Close on click outside — deferred to next tick so the opening click
		// doesn't immediately dismiss the popover.
		setTimeout(() => {
			this.settingsOutsideClickHandler = (e: MouseEvent) => {
				const target = e.target as Node | null;
				if (
					this.settingsPopoverEl &&
					target &&
					!this.settingsPopoverEl.contains(target) &&
					!(target as HTMLElement).closest?.("[aria-label='Chat settings']")
				) {
					this.closeSettingsPopover();
				}
			};
			document.addEventListener("mousedown", this.settingsOutsideClickHandler, true);
		}, 0);

		// Close on Escape key
		this.settingsEscapeHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				this.closeSettingsPopover();
				e.preventDefault();
			}
		};
		document.addEventListener("keydown", this.settingsEscapeHandler, true);

		// Model preset selection
		this.buildPresetSelect(this.settingsPopoverEl);


		// Checkpoints section
		this.buildCheckpointsSection(this.settingsPopoverEl);
	}

	/**
	 * Build the preset-based model selector for the settings popover.
	 *
	 * Shows a single dropdown of configured presets + "Custom..." option.
	 * When "Custom" is selected, reveals legacy provider+model dropdowns.
	 *
	 * @see specs/ZZ-misc/model-presets-design.md — Section 6.1
	 */
	private buildPresetSelect(container: HTMLElement): void {
		const presetSection = container.createDiv({ cls: "notor-settings-section notor-preset-section" });
		presetSection.createDiv({ cls: "notor-settings-label", text: "Model Preset" });

		const presets = this.getAvailablePresets?.() ?? [];
		const providerLabels: Record<string, string> = {};
		for (const p of this.plugin.settings.providers) {
			providerLabels[p.id] = p.display_name;
		}

		// Determine current selection
		const currentPreset = this.displayedPresetName !== undefined
			? this.displayedPresetName
			: this.getCurrentPreset?.() ?? null;

		const presetSelect = presetSection.createEl("select", { cls: "notor-settings-select" });

		// Render preset options
		for (const p of presets) {
			const isConfigured = p.provider_id !== null && p.model_id !== null;
			const detail = isConfigured
				? `${providerLabels[p.provider_id!] ?? p.provider_id} \u00B7 ${p.model_id}${p.use_extended_context ? " \u00B7 1M" : ""}`
				: "(not configured)";
			const opt = presetSelect.createEl("option", {
				text: `${p.name}  \u2014  ${detail}`,
				attr: { value: p.name },
			});
			if (!isConfigured) {
				opt.disabled = true;
			}
			if (p.name === currentPreset) {
				opt.selected = true;
			}
		}

		// Separator + Custom option
		const separatorOpt = presetSelect.createEl("option", {
			text: "\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500",
			attr: { value: "__separator" },
		});
		separatorOpt.disabled = true;

		const customOpt = presetSelect.createEl("option", {
			text: "Custom\u2026  \u2014  Select specific provider & model",
			attr: { value: "__custom" },
		});
		if (currentPreset === null) {
			customOpt.selected = true;
		}

		// Custom provider+model section (hidden by default, shown when "Custom" selected)
		const customSection = container.createDiv({ cls: "notor-settings-section notor-custom-model-section" });
		if (currentPreset !== null) {
			customSection.style.display = "none";
		}

		// Build legacy provider+model dropdowns inside customSection
		this.buildCustomModelSection(customSection);

		presetSelect.addEventListener("change", () => {
			const value = presetSelect.value;
			if (value === "__separator") return;

			// Clear display overrides — user is explicitly choosing
			this.displayedPresetName = undefined;
			this.displayedProviderId = null;
			this.displayedModelValue = null;

			if (value === "__custom") {
				customSection.style.display = "";
				this.onPresetChange?.(null);
			} else {
				customSection.style.display = "none";
				this.onPresetChange?.(value);
			}
		});
	}

	/**
	 * Build the legacy provider + model dropdowns for "Custom" mode.
	 * Reuses the same logic as the old provider/model dropdowns.
	 */
	private buildCustomModelSection(container: HTMLElement): void {
		// Provider selection
		const providerLabel = container.createDiv({ cls: "notor-settings-label", text: "Provider" });
		void providerLabel; // Used for DOM layout

		const providerSelect = container.createEl("select", { cls: "notor-settings-select" });
		const providers = this.getAvailableProviders?.() ?? [];
		const currentProvider = this.displayedProviderId ?? this.getCurrentProvider?.() ?? "local";

		for (const p of providers) {
			const opt = providerSelect.createEl("option", {
				text: p.displayName,
				attr: { value: p.id },
			});
			if (p.id === currentProvider) {
				opt.selected = true;
			}
		}

		providerSelect.addEventListener("change", () => {
			this.displayedProviderId = null;
			this.displayedModelValue = null;
			this.onProviderChange?.(providerSelect.value);
			this.refreshModelSelect();
		});

		// Model selection
		const modelWrapper = container.createDiv({ cls: "notor-settings-section" });
		const modelHeader = modelWrapper.createDiv({ cls: "notor-settings-label-row" });
		modelHeader.createDiv({ cls: "notor-settings-label", text: "Model" });

		const refreshBtn = modelHeader.createEl("button", {
			cls: "notor-settings-refresh-btn clickable-icon",
			attr: { "aria-label": "Refresh model list" },
		});
		refreshBtn.textContent = "\u21BB";
		refreshBtn.addEventListener("click", () => {
			void (async () => {
				refreshBtn.disabled = true;
				refreshBtn.textContent = "\u2026";
				try {
					await this.onRefreshModels?.();
					this.refreshModelSelect();
				} catch {
					// Fall through to text input
				} finally {
					refreshBtn.disabled = false;
					refreshBtn.textContent = "\u21BB";
				}
			})();
		});

		this.buildModelSelect(modelWrapper);
	}

	private buildModelSelect(container: HTMLElement): void {
		// Remove existing model select if any
		const existing = container.querySelector(".notor-model-select-wrapper");
		existing?.remove();

		const wrapper = container.createDiv({ cls: "notor-model-select-wrapper" });
		const models = this.getAvailableModels?.() ?? [];
		const currentModel = this.displayedModelValue ?? this.getCurrentModel?.() ?? "";

		if (models.length > 0) {
			const modelSelect = wrapper.createEl("select", { cls: "notor-settings-select" });
			const groups = groupModels(models);

			// Use optgroup for groups with multiple variants; flat options for single-variant groups
			if (groups.some((g) => g.variants.length > 1)) {
				this.renderGroupedModelOptions(modelSelect, groups, currentModel);
			} else {
				// All groups have single variants — render flat (non-Bedrock providers)
				for (const m of models) {
					const opt = modelSelect.createEl("option", {
						text: m.display_name || m.id,
						attr: { value: m.id },
					});
					if (m.id === currentModel) {
						opt.selected = true;
					}
				}
			}

			modelSelect.addEventListener("change", () => {
				this.displayedModelValue = null; // User explicitly changed
				this.onModelChange?.(modelSelect.value);
			});
		} else {
			// Free-text input fallback
			const modelInput = wrapper.createEl("input", {
				cls: "notor-settings-input",
				attr: {
					type: "text",
					placeholder: "Enter model ID...",
					value: currentModel,
				},
			});

			modelInput.addEventListener("change", () => {
				this.displayedModelValue = null; // User explicitly changed
				this.onModelChange?.(modelInput.value);
			});
		}
	}

	/**
	 * Render grouped model options using `<optgroup>` elements.
	 *
	 * Each ModelGroup becomes an `<optgroup>` with its variants as `<option>`s.
	 * The `::1m` suffix is used as an internal encoding for extended context
	 * variants — parsed in the `onModelChange` handler in main.ts.
	 */
	private renderGroupedModelOptions(
		select: HTMLSelectElement,
		groups: ModelGroup[],
		currentModel: string
	): void {
		for (const group of groups) {
			if (group.variants.length === 1) {
				// Single variant — render as a flat option (no optgroup needed)
				const variant = group.variants[0]!;
				const opt = select.createEl("option", {
					text: group.label,
					attr: { value: variant.optionValue },
				});
				if (variant.optionValue === currentModel) {
					opt.selected = true;
				}
			} else {
				// Multiple variants — use optgroup
				const optgroup = select.createEl("optgroup", {
					attr: { label: group.label },
				});
				for (const variant of group.variants) {
					const label = formatVariantLabel(variant);
					const opt = optgroup.createEl("option", {
						text: label,
						attr: { value: variant.optionValue },
					});
					if (variant.optionValue === currentModel) {
						opt.selected = true;
					}
				}
			}
		}
	}

	private buildCheckpointsSection(container: HTMLElement): void {
		const section = container.createDiv({ cls: "notor-settings-section notor-checkpoints-section" });
		const header = section.createDiv({ cls: "notor-settings-label-row" });
		header.createDiv({ cls: "notor-settings-label", text: "Checkpoints" });

		const refreshBtn = header.createEl("button", {
			cls: "notor-settings-refresh-btn clickable-icon",
			attr: { "aria-label": "Refresh checkpoint list" },
		});
		refreshBtn.textContent = "↻";

		const listEl = section.createDiv({ cls: "notor-checkpoint-list" });
		listEl.textContent = "Loading…";

		const loadCheckpoints = async () => {
			listEl.empty();
			listEl.textContent = "Loading…";
			try {
				const checkpoints = (await this.onListCheckpoints?.()) ?? [];
				listEl.empty();
				if (checkpoints.length === 0) {
					listEl.createDiv({
						cls: "notor-checkpoint-empty",
						text: "No checkpoints yet",
					});
					return;
				}
				for (const cp of checkpoints) {
					this.renderCheckpointItem(listEl, cp);
				}
			} catch {
				listEl.empty();
				listEl.createDiv({ cls: "notor-checkpoint-empty", text: "Failed to load checkpoints" });
			}
		};

		refreshBtn.addEventListener("click", () => void loadCheckpoints());

		// Load immediately when the section is created
		void loadCheckpoints();
	}

	private renderCheckpointItem(container: HTMLElement, cp: Checkpoint): void {
		const item = container.createDiv({ cls: "notor-checkpoint-item" });

		const meta = item.createDiv({ cls: "notor-checkpoint-meta" });
		const date = new Date(cp.timestamp);
		meta.createSpan({ cls: "notor-checkpoint-time", text: this.formatRelativeTime(date) });
		meta.createSpan({ cls: "notor-checkpoint-desc", text: cp.description });

		const actions = item.createDiv({ cls: "notor-checkpoint-actions" });

		// Preview button
		const previewBtn = actions.createEl("button", {
			cls: "notor-checkpoint-btn notor-checkpoint-preview-btn",
			text: "Preview",
			attr: { "aria-label": "Preview checkpoint" },
		});
		previewBtn.addEventListener("click", () => {
			this.showCheckpointPreviewModal(cp);
		});

		// Compare button (only if the note currently exists)
		const compareBtn = actions.createEl("button", {
			cls: "notor-checkpoint-btn",
			text: "Compare",
			attr: { "aria-label": "Compare checkpoint with current note" },
		});
		compareBtn.addEventListener("click", () => {
			void (async () => {
				try {
					const current = await this.onGetCurrentContent?.(cp.note_path);
					if (current == null) {
						new Notice(`Note not found: ${cp.note_path}`);
						return;
					}
					this.showCheckpointDiffModal(cp, current);
				} catch (err) {
					log.error("Failed to compare checkpoint", { err });
					new Notice("Failed to compare checkpoint");
				}
			})();
		});

		// Restore button
		const restoreBtn = actions.createEl("button", {
			cls: "notor-checkpoint-btn notor-checkpoint-restore-btn",
			text: "Restore",
			attr: { "aria-label": "Restore note to this checkpoint" },
		});
		restoreBtn.addEventListener("click", () => {
			void (async () => {
				restoreBtn.disabled = true;
				restoreBtn.textContent = "Restoring…";
				try {
					const ok = await this.onRestoreCheckpoint?.(cp.id);
					if (ok) {
						new Notice(`Restored ${cp.note_path} to checkpoint from ${this.formatRelativeTime(new Date(cp.timestamp))}`);
					} else {
						new Notice(`Failed to restore checkpoint`);
					}
				} catch {
					new Notice(`Failed to restore checkpoint`);
				} finally {
					restoreBtn.disabled = false;
					restoreBtn.textContent = "Restore";
				}
			})();
		});
	}

	private showCheckpointPreviewModal(cp: Checkpoint): void {
		const modal = new CheckpointModal(
			this.app,
			`Checkpoint: ${cp.description}`,
			cp.content,
			null
		);
		modal.open();
	}

	private showCheckpointDiffModal(cp: Checkpoint, current: string): void {
		const modal = new CheckpointModal(
			this.app,
			`Compare: ${cp.description}`,
			cp.content,
			current
		);
		modal.open();
	}

	private refreshModelSelect(): void {
		if (!this.settingsPopoverEl) return;
		// Find the model select wrapper inside the custom model section
		const customSection = this.settingsPopoverEl.querySelector(".notor-custom-model-section");
		if (customSection) {
			const modelWrapper = customSection.querySelector(".notor-settings-section");
			if (modelWrapper) {
				this.buildModelSelect(modelWrapper as HTMLElement);
			}
		}
	}

	private closeSettingsPopover(): void {
		if (this.settingsOutsideClickHandler) {
			document.removeEventListener("mousedown", this.settingsOutsideClickHandler, true);
			this.settingsOutsideClickHandler = undefined;
		}
		if (this.settingsEscapeHandler) {
			document.removeEventListener("keydown", this.settingsEscapeHandler, true);
			this.settingsEscapeHandler = undefined;
		}
		this.isSettingsOpen = false;
		this.settingsPopoverEl?.remove();
		this.settingsPopoverEl = undefined;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	scrollToBottom(): void {
		if (!this.autoScroll) return;
		this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
	}

	private formatRelativeTime(date: Date): string {
		const now = Date.now();
		const diff = now - date.getTime();
		const minutes = Math.floor(diff / 60000);
		const hours = Math.floor(diff / 3600000);
		const days = Math.floor(diff / 86400000);

		if (minutes < 1) return "Just now";
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		return date.toLocaleDateString();
	}
}

// ---------------------------------------------------------------------------
// Checkpoint preview / diff modal
// ---------------------------------------------------------------------------

/**
 * Modal for previewing checkpoint content or comparing it against current
 * note content.
 *
 * When `currentContent` is null: shows checkpoint content only (preview).
 * When `currentContent` is provided: shows a side-by-side diff (compare).
 */
class CheckpointModal extends Modal {
	constructor(
		app: import("obsidian").App,
		private readonly title: string,
		private readonly checkpointContent: string,
		private readonly currentContent: string | null
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("notor-checkpoint-modal");

		contentEl.createEl("h2", { text: this.title });

		if (this.currentContent === null) {
			// Preview mode: show checkpoint content
			this.renderContentBlock(contentEl, "Checkpoint content", this.checkpointContent);
		} else {
			// Compare mode: show inline diff
			this.renderDiff(contentEl, this.checkpointContent, this.currentContent);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderContentBlock(container: HTMLElement, label: string, content: string): void {
		container.createEl("p", { cls: "notor-checkpoint-modal-label", text: label });
		const pre = container.createEl("pre", { cls: "notor-checkpoint-modal-content" });
		pre.createEl("code", { text: content });
	}

	/**
	 * Render a simple line-by-line diff between checkpoint and current content.
	 *
	 * Lines only in checkpoint: shown with "-" prefix (deletion, red).
	 * Lines only in current: shown with "+" prefix (addition, green).
	 * Lines in both: shown unchanged.
	 */
	private renderDiff(
		container: HTMLElement,
		checkpointContent: string,
		currentContent: string
	): void {
		container.createEl("p", {
			cls: "notor-checkpoint-modal-label",
			text: "− checkpoint  /  + current",
		});

		const diffEl = container.createEl("pre", { cls: "notor-checkpoint-modal-diff" });

		const checkpointLines = checkpointContent.split("\n");
		const currentLines = currentContent.split("\n");

		// Simple LCS-based diff
		const diff = this.computeDiff(checkpointLines, currentLines);

		for (const entry of diff) {
			const lineEl = diffEl.createEl("div", { cls: `notor-diff-line notor-diff-${entry.type}` });
			const prefix = entry.type === "removed" ? "- " : entry.type === "added" ? "+ " : "  ";
			lineEl.textContent = prefix + entry.text;
		}
	}

	/** Very simple O(n²) diff for modest-length notes. */
	private computeDiff(
		a: string[],
		b: string[]
	): Array<{ type: "unchanged" | "removed" | "added"; text: string }> {
		// Build LCS table
		const m = a.length;
		const n = b.length;
		const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

		for (let i = 1; i <= m; i++) {
			for (let j = 1; j <= n; j++) {
				if (a[i - 1] === b[j - 1]) {
					lcs[i]![j] = lcs[i - 1]![j - 1]! + 1;
				} else {
					lcs[i]![j] = Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
				}
			}
		}

		// Backtrack to produce diff
		let i = m;
		let j = n;
		const entries: Array<{ type: "unchanged" | "removed" | "added"; text: string }> = [];

		while (i > 0 || j > 0) {
			if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
				entries.push({ type: "unchanged", text: a[i - 1]! });
				i--;
				j--;
			} else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
				entries.push({ type: "added", text: b[j - 1]! });
				j--;
			} else {
				entries.push({ type: "removed", text: a[i - 1]! });
				i--;
			}
		}

		entries.reverse();
		return entries;
	}
}
