/**
 * Chat panel view — primary UI surface for Notor.
 *
 * Implements the Obsidian ItemView for the chat panel with message
 * display, input area, send/stop buttons, and conversation switching.
 *
 * @see specs/01-mvp/spec.md — FR-4, FR-5
 * @see design/ux.md — chat panel layout, message display
 */

import { ItemView, MarkdownRenderer, Modal, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type NotorPlugin from "../main";
import type { ConversationMode, Message, LLMProviderType, ModelInfo, Checkpoint, Persona } from "../types";
import type { Attachment } from "../context/attachment";
import {
	createVaultNoteAttachment,
	createVaultNoteSectionAttachment,
} from "../context/attachment";
import type { ConversationListEntry } from "../chat/history";
import type { PersonaManager } from "../personas/persona-manager";
import { buildPersonaPicker } from "./persona-picker";
import { logger } from "../utils/logger";
import { groupModels, formatVariantLabel, buildOptionValue, type ModelGroup } from "../providers/model-grouping";
import {
	renderWriteNoteDiffPreview,
	renderReplaceInNoteDiffPreview,
} from "./diff-view";
import { VaultNoteSuggest, createAttachmentButton } from "./attachment-picker";
import { AttachmentChipManager, createAttachmentChipContainer } from "./attachment-chips";
import { WorkflowSlashSuggest, detectSlashTrigger } from "./workflow-suggest";
import { resolveNote } from "../utils/resolve-note";
import { findExistingLeaf } from "../tools/note-opener";
import { WorkflowActivityIndicator } from "./workflow-activity-indicator";
import type { WorkflowActivityTracker } from "../workflows/workflow-activity-tracker";
import type { Workflow } from "../types";
import { McpStatusIndicator } from "./mcp-status-indicator";

const log = logger("ChatView");

/** View type identifier for Obsidian's view registry. */
export const CHAT_VIEW_TYPE = "notor-chat-view";

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

	// Persona state (A-009, A-010)
	private personaManager?: PersonaManager;
	private personaLabelEl?: HTMLElement;

	// Workflow activity indicator state (H-002, H-003)
	private workflowActivityTracker?: WorkflowActivityTracker;
	private workflowActivityIndicator?: WorkflowActivityIndicator;

	// MCP status indicator (INT-005)
	private mcpStatusIndicator?: McpStatusIndicator;

	// Active conversation tracking
	private activeConversationId: string | null = null;

	// Callbacks (set by orchestrator)
	private onSendMessage?: (content: string, attachments?: Attachment[]) => Promise<void>;
	private onStopResponse?: () => void;
	private onNewConversation?: () => void;
	private onSwitchConversation?: (filename: string) => void;
	private onExportConversation?: (filename: string) => void;
	private onImportConversation?: (htmlContent: string) => Promise<void>;
	private onSwitchToConversationById?: (conversationId: string) => Promise<boolean>;
	private onOpenConversationList?: () => Promise<ConversationListEntry[]>;
	private onSearchConversations?: (query: string) => Promise<ConversationListEntry[]>;
	private onModeToggle?: (mode: ConversationMode) => void;
	private onSettingsOpen?: () => void;
	private onProviderChange?: (providerId: LLMProviderType) => void;
	private onModelChange?: (modelId: string) => void;
	private onRefreshModels?: () => Promise<ModelInfo[]>;
	private getAvailableProviders?: () => { type: LLMProviderType; displayName: string }[];
	private getAvailableModels?: () => ModelInfo[];
	private getCurrentProvider?: () => LLMProviderType;
	private getCurrentModel?: () => string;

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

	setOnProviderChange(callback: (providerId: LLMProviderType) => void): void {
		this.onProviderChange = callback;
	}

	setOnModelChange(callback: (modelId: string) => void): void {
		this.onModelChange = callback;
	}

	setOnRefreshModels(callback: () => Promise<ModelInfo[]>): void {
		this.onRefreshModels = callback;
	}

	setGetAvailableProviders(callback: () => { type: LLMProviderType; displayName: string }[]): void {
		this.getAvailableProviders = callback;
	}

	setGetAvailableModels(callback: () => ModelInfo[]): void {
		this.getAvailableModels = callback;
	}

	setGetCurrentProvider(callback: () => LLMProviderType): void {
		this.getCurrentProvider = callback;
	}

	setGetCurrentModel(callback: () => string): void {
		this.getCurrentModel = callback;
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
			this.workflowActivityTracker
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

		// Listen for persona changes to update the label
		manager.setOnPersonaChanged((persona) => {
			this.updatePersonaLabel(persona);
		});

		// Initialize label with current state
		this.updatePersonaLabel(manager.getActivePersona());
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
					cls: "notor-persona-label notor-hidden",
				});
				// Place after the mode toggle (second child of toolbar)
				const modeToggle = toolbar.querySelector(".notor-mode-toggle");
				if (modeToggle?.nextSibling) {
					toolbar.insertBefore(this.personaLabelEl, modeToggle.nextSibling);
				}
			} else {
				return;
			}
		}

		if (persona) {
			this.personaLabelEl.textContent = `🎭 ${persona.name}`;
			this.personaLabelEl.removeClass("notor-hidden");
		} else {
			this.personaLabelEl.textContent = "";
			this.personaLabelEl.addClass("notor-hidden");
		}
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

		// H-002: Render workflow activity indicator in header (if tracker is already wired)
		this.initActivityIndicator();

		log.info("Chat view opened");
		return Promise.resolve();
	}

	onClose(): Promise<void> {
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

		log.info("Chat view closed");
		return Promise.resolve();
	}

	// -----------------------------------------------------------------------
	// UI Construction
	// -----------------------------------------------------------------------

	private buildHeader(container: HTMLElement): void {
		this.headerEl = container.createDiv({ cls: "notor-chat-header" });

		const titleArea = this.headerEl.createDiv({ cls: "notor-chat-header-title" });
		titleArea.createSpan({ text: "Notor", cls: "notor-chat-title" });

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
				if (!query) {
					// Empty query — reload full list
					this.onOpenConversationList?.().then((entries) => {
						this.renderConversationList(entries);
					}).catch((err) => {
						log.error("Failed to load conversation list", { error: String(err) });
					});
				} else {
					this.onSearchConversations?.(query).then((entries) => {
						this.renderConversationList(entries);
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
	 */
	private recalcInputHeight(): void {
		this.textInputEl.setCssProps({ '--notor-input-height': 'auto' });
		const lineHeight = parseFloat(getComputedStyle(this.textInputEl).lineHeight) || 20;
		const padding = 12 + 2; // 6px top + 6px bottom padding + 2px border
		const threeLines = (lineHeight * 3) + padding;
		const tenPercent = window.innerHeight * 0.1;
		const maxH = Math.max(tenPercent, threeLines);
		const newHeight = Math.min(this.textInputEl.scrollHeight, maxH);
		this.textInputEl.setCssProps({
			'--notor-input-height': newHeight + 'px',
			'--notor-input-max-height': maxH + 'px',
		});
	}

	private buildInputArea(container: HTMLElement): void {
		this.inputAreaEl = container.createDiv({ cls: "notor-input-area" });

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
			this.plugin.settings.external_file_size_threshold_mb
		);

		// Send button
		this.sendButtonEl = buttonWrapper.createEl("button", {
			cls: "notor-send-btn",
			attr: { "aria-label": "Send message" },
		});
		setIcon(this.sendButtonEl, "send");
		this.sendButtonEl.addEventListener("click", () => void this.handleSend());

		// Stop button (hidden by default)
		this.stopButtonEl = buttonWrapper.createEl("button", {
			cls: "notor-stop-btn notor-hidden",
			attr: { "aria-label": "Stop response" },
		});
		setIcon(this.stopButtonEl, "octagon-pause");
		this.stopButtonEl.addEventListener("click", () => this.handleStop());
	}

	// -----------------------------------------------------------------------
	// User interactions
	// -----------------------------------------------------------------------

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
	setRespondingState(responding: boolean): void {
		this.isResponding = responding;

		if (responding) {
			this.sendButtonEl.addClass("notor-hidden");
			this.stopButtonEl.removeClass("notor-hidden");
			this.textInputEl.setAttribute("contenteditable", "false");
			this.textInputEl.addClass("notor-text-input--disabled");
			this.loadingIndicatorEl.removeClass("notor-hidden");
		} else {
			this.sendButtonEl.removeClass("notor-hidden");
			this.stopButtonEl.addClass("notor-hidden");
			this.textInputEl.setAttribute("contenteditable", "true");
			this.textInputEl.removeClass("notor-text-input--disabled");
			this.loadingIndicatorEl.addClass("notor-hidden");
			this.textInputEl.focus();
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
		const contentEl = msgEl.createDiv({ cls: "notor-message-content" });

		// Extract <attachments> block (if any) and render as collapsed <details>
		const { attachmentsXml, remainder } = extractAttachmentsBlock(message.content);
		if (attachmentsXml !== null) {
			this.renderAttachmentsBlock(contentEl, attachmentsXml);
		}
		const textToRender = attachmentsXml !== null ? remainder : message.content;

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
		pre.createEl("code", { text: message.content });
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
	 */
	appendStreamChunk(contentEl: HTMLElement, text: string): void {
		// For streaming, we accumulate text and re-render markdown periodically
		const existing = contentEl.getAttribute("data-raw") ?? "";
		const updated = existing + text;
		contentEl.setAttribute("data-raw", updated);

		// Simple streaming: render as text, final render as markdown
		contentEl.textContent = updated;
		this.scrollToBottom();
	}

	/**
	 * Finalize a streaming assistant message with full markdown rendering.
	 */
	async finalizeAssistantMessage(contentEl: HTMLElement, message: Message): Promise<void> {
		contentEl.empty();
		await MarkdownRenderer.render(
			this.app,
			message.content,
			contentEl,
			"",
			this
		);
		this.activateInternalLinks(contentEl);

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
		const paramsToggle = toolEl.createDiv({ cls: "notor-tool-call-toggle" });
		paramsToggle.textContent = "▶ parameters";
		const paramsEl = toolEl.createDiv({ cls: "notor-tool-call-params notor-hidden" });
		const pre = paramsEl.createEl("pre");
		pre.createEl("code", { text: JSON.stringify(toolCall.parameters, null, 2) });

		paramsToggle.addEventListener("click", () => {
			paramsEl.toggleClass("notor-hidden", !paramsEl.hasClass("notor-hidden"));
			paramsToggle.textContent = paramsEl.hasClass("notor-hidden")
				? "▶ parameters"
				: "▼ parameters";
		});

		this.lastToolCallEl = toolEl;
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
				const toggle = resultEl.createDiv({ cls: "notor-tool-call-toggle" });
				toggle.textContent = "▶ full result";
				const fullEl = resultEl.createDiv({ cls: "notor-tool-result-full notor-hidden" });
				const pre = fullEl.createEl("pre");
				pre.createEl("code", { text: resultStr });

				toggle.addEventListener("click", () => {
					fullEl.toggleClass("notor-hidden", !fullEl.hasClass("notor-hidden"));
					toggle.textContent = fullEl.hasClass("notor-hidden")
						? "▶ full result"
						: "▼ full result";
				});
			}
		}

		this.scrollToBottom();
	}

	/**
	 * Render an inline approval prompt for a tool call.
	 * Returns a promise that resolves with the user's decision.
	 */
	renderApprovalPrompt(toolCallEl: HTMLElement): Promise<"approved" | "rejected"> {
		return new Promise((resolve) => {
			const approvalEl = toolCallEl.createDiv({ cls: "notor-approval-prompt" });
			approvalEl.createSpan({ text: "Approve this action?", cls: "notor-approval-text" });

			const btnContainer = approvalEl.createDiv({ cls: "notor-approval-buttons" });

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
		parameters: Record<string, unknown>
	): Promise<"approved" | "rejected"> {
		const notePath = parameters["path"] as string | undefined;

		if (!notePath) {
			return this.renderApprovalPrompt(toolCallEl);
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
				/*autoApproved=*/ false
			);
			this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
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
				return this.renderApprovalPrompt(toolCallEl);
			}

			if (!noteContent) {
				return this.renderApprovalPrompt(toolCallEl);
			}

			// Render the diff. Scroll once to show the action buttons; after that the
			// user is free to scroll up and read the full diff without being fought back.
			const decisionPromise = renderReplaceInNoteDiffPreview(
				this.messageListEl,
				notePath,
				noteContent,
				changeBlocks,
				/*autoApproved=*/ false
			);
			this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
			const decision = await decisionPromise;
			return decision.accepted ? "approved" : "rejected";
		}

		// Other tools: use the plain approval prompt
		return this.renderApprovalPrompt(toolCallEl);
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

			const contentCol = item.createDiv({ cls: "notor-conversation-list-content" });

			const titleEl = contentCol.createDiv({ cls: "notor-conversation-list-title" });
			titleEl.textContent = entry.title ?? "Untitled";

			const metaEl = contentCol.createDiv({ cls: "notor-conversation-list-meta" });
			const date = new Date(entry.updated_at);
			metaEl.textContent = this.formatRelativeTime(date);

			if (entry.preview) {
				const previewEl = contentCol.createDiv({ cls: "notor-conversation-list-preview" });
				previewEl.textContent = entry.preview;
			}

			// Export button
			const exportBtn = item.createDiv({ cls: "notor-conversation-export-btn" });
			setIcon(exportBtn, "download");
			exportBtn.setAttribute("aria-label", "Export conversation");
			exportBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.onExportConversation?.(entry.filename);
			});

			item.addEventListener("click", () => {
				this.onSwitchConversation?.(entry.filename);
				this.toggleConversationList();
			});
		}
	}

	/**
	 * Clear all messages from the display.
	 */
	clearMessages(): void {
		this.messageListEl.empty();
		this.tokenFooterEl.addClass("notor-hidden");
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

		// Provider selection
		const providerSection = this.settingsPopoverEl.createDiv({ cls: "notor-settings-section" });
		providerSection.createDiv({ cls: "notor-settings-label", text: "Provider" });

		const providerSelect = providerSection.createEl("select", { cls: "notor-settings-select" });
		const providers = this.getAvailableProviders?.() ?? [];
		const currentProvider = this.getCurrentProvider?.() ?? "local";

		for (const p of providers) {
			const opt = providerSelect.createEl("option", {
				text: p.displayName,
				attr: { value: p.type },
			});
			if (p.type === currentProvider) {
				opt.selected = true;
			}
		}

		providerSelect.addEventListener("change", () => {
			this.onProviderChange?.(providerSelect.value as LLMProviderType);
			// Refresh model list when provider changes
			this.refreshModelSelect();
		});

		// Model selection
		const modelSection = this.settingsPopoverEl.createDiv({ cls: "notor-settings-section" });
		const modelHeader = modelSection.createDiv({ cls: "notor-settings-label-row" });
		modelHeader.createDiv({ cls: "notor-settings-label", text: "Model" });

		const refreshBtn = modelHeader.createEl("button", {
			cls: "notor-settings-refresh-btn clickable-icon",
			attr: { "aria-label": "Refresh model list" },
		});
		refreshBtn.textContent = "↻";
		refreshBtn.addEventListener("click", () => {
			void (async () => {
				refreshBtn.disabled = true;
				refreshBtn.textContent = "…";
				try {
					await this.onRefreshModels?.();
					this.refreshModelSelect();
				} catch {
					// Fall through to text input
				} finally {
					refreshBtn.disabled = false;
					refreshBtn.textContent = "↻";
				}
			})();
		});

		this.buildModelSelect(modelSection);

		// Persona picker (A-009) — triggers rescan on each popover open
		if (this.personaManager) {
			buildPersonaPicker(this.settingsPopoverEl, this.personaManager);
		}

		// Checkpoints section
		this.buildCheckpointsSection(this.settingsPopoverEl);
	}

	private buildModelSelect(container: HTMLElement): void {
		// Remove existing model select if any
		const existing = container.querySelector(".notor-model-select-wrapper");
		existing?.remove();

		const wrapper = container.createDiv({ cls: "notor-model-select-wrapper" });
		const models = this.getAvailableModels?.() ?? [];
		const currentModel = this.getCurrentModel?.() ?? "";

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
		const modelSection = this.settingsPopoverEl.querySelectorAll(".notor-settings-section")[1];
		if (modelSection) {
			this.buildModelSelect(modelSection as HTMLElement);
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
