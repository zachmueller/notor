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
import type { ConversationMode, Message, LLMProviderType, ModelInfo, Checkpoint } from "../types";
import type { Attachment } from "../context/attachment";
import type { ConversationListEntry } from "../chat/history";
import { logger } from "../utils/logger";
import {
	renderWriteNoteDiffPreview,
	renderReplaceInNoteDiffPreview,
} from "./diff-view";
import { VaultNoteSuggest, createAttachmentButton } from "./attachment-picker";
import { AttachmentChipManager, createAttachmentChipContainer } from "./attachment-chips";

const log = logger("ChatView");

/** View type identifier for Obsidian's view registry. */
export const CHAT_VIEW_TYPE = "notor-chat-view";

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
	private textInputEl!: HTMLDivElement;
	private sendButtonEl!: HTMLButtonElement;
	private stopButtonEl!: HTMLButtonElement;
	private modeToggleEl!: HTMLButtonElement;
	private conversationListEl!: HTMLElement;
	private loadingIndicatorEl!: HTMLElement;
	private tokenFooterEl!: HTMLElement;
	private attachmentChipContainerEl!: HTMLElement;

	// State
	private isResponding = false;
	private abortController: AbortController | null = null;
	private showConversationList = false;
	private lastToolCallEl: HTMLElement | null = null;

	// Attachment state
	private pendingAttachments: Attachment[] = [];
	private attachmentChipManager!: AttachmentChipManager;
	private vaultNoteSuggest?: VaultNoteSuggest;

	// Settings popover state
	private settingsPopoverEl?: HTMLElement;
	private isSettingsOpen = false;

	// Callbacks (set by orchestrator)
	private onSendMessage?: (content: string, attachments?: Attachment[]) => Promise<void>;
	private onStopResponse?: () => void;
	private onNewConversation?: () => void;
	private onSwitchConversation?: (filename: string) => void;
	private onOpenConversationList?: () => Promise<ConversationListEntry[]>;
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
		return "Notor Chat";
	}

	getIcon(): string {
		return "message-square";
	}

	// -----------------------------------------------------------------------
	// Callback setters (wired by orchestrator / main.ts)
	// -----------------------------------------------------------------------

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

	setOnOpenConversationList(callback: () => Promise<ConversationListEntry[]>): void {
		this.onOpenConversationList = callback;
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

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("notor-chat-container");

		this.buildHeader(container);
		this.buildConversationList(container);
		this.buildMessageList(container);
		this.buildInputArea(container);

		log.info("Chat view opened");
	}

	async onClose(): Promise<void> {
		this.abortController?.abort();
		log.info("Chat view closed");
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
		listBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>';
		listBtn.addEventListener("click", () => this.toggleConversationList());

		// New conversation button
		const newBtn = actions.createEl("button", {
			cls: "notor-chat-header-btn clickable-icon",
			attr: { "aria-label": "New conversation" },
		});
		newBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
		newBtn.addEventListener("click", () => {
			this.onNewConversation?.();
		});

		// Settings gear
		const settingsBtn = actions.createEl("button", {
			cls: "notor-chat-header-btn clickable-icon",
			attr: { "aria-label": "Chat settings" },
		});
		settingsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
		settingsBtn.addEventListener("click", () => {
			this.toggleSettingsPopover();
		});
	}

	private buildConversationList(container: HTMLElement): void {
		this.conversationListEl = container.createDiv({
			cls: "notor-conversation-list notor-hidden",
		});
	}

	private buildMessageList(container: HTMLElement): void {
		this.messageListEl = container.createDiv({ cls: "notor-message-list" });

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

	private buildInputArea(container: HTMLElement): void {
		this.inputAreaEl = container.createDiv({ cls: "notor-input-area" });

		// Mode toggle
		this.modeToggleEl = this.inputAreaEl.createEl("button", {
			cls: "notor-mode-toggle notor-mode-plan",
			text: "Plan",
			attr: { "aria-label": "Toggle Plan/Act mode" },
		});
		this.modeToggleEl.addEventListener("click", () => this.handleModeToggle());

		// Text input wrapper
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
			this.textInputEl.style.height = "auto";
			this.textInputEl.style.height = Math.min(this.textInputEl.scrollHeight, 200) + "px";

			// Detect `[[` trigger for vault note autocomplete
			this.detectWikilinkTrigger();
		});

		// Enter to send, Shift+Enter for newline
		this.textInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.handleSend();
			}
		});

		// Initialize vault note suggest (lazy — created once, reused)
		this.vaultNoteSuggest = new VaultNoteSuggest(
			this.app,
			this.textInputEl,
			(attachment: Attachment) => this.addAttachment(attachment),
			() => this.pendingAttachments
		);

		// Button wrapper
		const buttonWrapper = this.inputAreaEl.createDiv({ cls: "notor-input-buttons" });

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
		this.sendButtonEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
		this.sendButtonEl.addEventListener("click", () => this.handleSend());

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

		const content = (this.textInputEl.textContent ?? "").trim();
		if (!content && this.pendingAttachments.length === 0) return;

		// Capture and clear attachments before sending
		const attachments = [...this.pendingAttachments];
		this.pendingAttachments = [];
		this.attachmentChipManager.clear();

		this.textInputEl.textContent = "";
		this.textInputEl.style.height = "auto";

		try {
			await this.onSendMessage?.(content, attachments);
		} catch (e) {
			log.error("Send message failed", { error: String(e) });
			new Notice(`Failed to send message: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private handleStop(): void {
		this.abortController?.abort();
		this.onStopResponse?.();
		this.setRespondingState(false);
	}

	private handleModeToggle(): void {
		const currentMode = this.modeToggleEl.textContent?.toLowerCase() as ConversationMode;
		const newMode: ConversationMode = currentMode === "plan" ? "act" : "plan";
		this.updateModeDisplay(newMode);
		this.onModeToggle?.(newMode);
	}

	private toggleConversationList(): void {
		this.showConversationList = !this.showConversationList;
		if (this.showConversationList) {
			this.conversationListEl.removeClass("notor-hidden");
			this.messageListEl.addClass("notor-hidden");
			// Refresh the list from disk every time the panel opens
			if (this.onOpenConversationList) {
				this.onOpenConversationList().then((entries) => {
					this.renderConversationList(entries);
				}).catch((e) => {
					log.error("Failed to load conversation list", { error: String(e) });
				});
			}
		} else {
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
	 */
	renderUserMessage(message: Message): void {
		const msgEl = this.messageListEl.createDiv({ cls: "notor-message notor-message-user" });
		const contentEl = msgEl.createDiv({ cls: "notor-message-content" });
		contentEl.createEl("p", { text: message.content });
		this.scrollToBottom();
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
	 * Get the most recently rendered tool call element.
	 * Used by the approval callback in main.ts to attach the approval prompt.
	 */
	getLastToolCallEl(): HTMLElement | null {
		return this.lastToolCallEl;
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
		paramsToggle.textContent = "▶ Parameters";
		const paramsEl = toolEl.createDiv({ cls: "notor-tool-call-params notor-hidden" });
		const pre = paramsEl.createEl("pre");
		pre.createEl("code", { text: JSON.stringify(toolCall.parameters, null, 2) });

		paramsToggle.addEventListener("click", () => {
			paramsEl.toggleClass("notor-hidden", !paramsEl.hasClass("notor-hidden"));
			paramsToggle.textContent = paramsEl.hasClass("notor-hidden")
				? "▶ Parameters"
				: "▼ Parameters";
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
				toggle.textContent = "▶ Full result";
				const fullEl = resultEl.createDiv({ cls: "notor-tool-result-full notor-hidden" });
				const pre = fullEl.createEl("pre");
				pre.createEl("code", { text: resultStr });

				toggle.addEventListener("click", () => {
					fullEl.toggleClass("notor-hidden", !fullEl.hasClass("notor-hidden"));
					toggle.textContent = fullEl.hasClass("notor-hidden")
						? "▶ Full result"
						: "▼ Full result";
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
					beforeContent = await this.app.vault.read(file as import("obsidian").TFile);
				}
			} catch {
				// New file — beforeContent stays empty
			}

			// Start rendering the diff, then keep scrolling so the action
			// buttons stay visible while the user decides.
			const decisionPromise = renderWriteNoteDiffPreview(
				this.messageListEl,
				notePath,
				beforeContent,
				afterContent,
				/*autoApproved=*/ false
			);
			// Poll-scroll: keep the bottom visible while approval is pending.
			const scrollTimer = window.setInterval(() => this.scrollToBottom(), 100);
			const decision = await decisionPromise;
			window.clearInterval(scrollTimer);
			return decision.accepted ? "approved" : "rejected";
		}

		if (toolName === "replace_in_note") {
			const changeBlocks = (parameters["changes"] as Array<{ search: string; replace: string }> | undefined) ?? [];

			// Read current note content
			let noteContent = "";
			try {
				const file = this.app.vault.getFileByPath(notePath);
				if (file) {
					noteContent = await this.app.vault.read(file as import("obsidian").TFile);
				}
			} catch {
				// Fall back to plain prompt if file unreadable
				return this.renderApprovalPrompt(toolCallEl);
			}

			if (!noteContent) {
				return this.renderApprovalPrompt(toolCallEl);
			}

			// Start rendering the diff, then keep scrolling so the action
			// buttons stay visible while the user decides.
			const decisionPromise = renderReplaceInNoteDiffPreview(
				this.messageListEl,
				notePath,
				noteContent,
				changeBlocks,
				/*autoApproved=*/ false
			);
			// Poll-scroll: keep the bottom visible while approval is pending.
			const scrollTimer = window.setInterval(() => this.scrollToBottom(), 100);
			const decision = await decisionPromise;
			window.clearInterval(scrollTimer);
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
			const item = this.conversationListEl.createDiv({
				cls: "notor-conversation-list-item",
			});

			const titleEl = item.createDiv({ cls: "notor-conversation-list-title" });
			titleEl.textContent = entry.title ?? "Untitled";

			const metaEl = item.createDiv({ cls: "notor-conversation-list-meta" });
			const date = new Date(entry.updated_at);
			metaEl.textContent = this.formatRelativeTime(date);

			if (entry.preview) {
				const previewEl = item.createDiv({ cls: "notor-conversation-list-preview" });
				previewEl.textContent = entry.preview;
			}

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
		this.isSettingsOpen = true;

		this.settingsPopoverEl = this.headerEl.createDiv({ cls: "notor-settings-popover" });

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
		refreshBtn.addEventListener("click", async () => {
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
		});

		this.buildModelSelect(modelSection);

		// Checkpoints section
		this.buildCheckpointsSection(this.settingsPopoverEl);

		// Full settings link
		const fullSettingsLink = this.settingsPopoverEl.createDiv({ cls: "notor-settings-link" });
		fullSettingsLink.createEl("a", { text: "Open full settings", cls: "notor-settings-full-link" });
		fullSettingsLink.addEventListener("click", () => {
			this.closeSettingsPopover();
			this.onSettingsOpen?.();
		});
	}

	private buildModelSelect(container: HTMLElement): void {
		// Remove existing model select if any
		const existing = container.querySelector(".notor-model-select-wrapper");
		existing?.remove();

		const wrapper = container.createDiv({ cls: "notor-model-select-wrapper" });
		const models = this.getAvailableModels?.() ?? [];
		const currentModel = this.getCurrentModel?.() ?? "";

		if (models.length > 0) {
			// Dropdown mode
			const modelSelect = wrapper.createEl("select", { cls: "notor-settings-select" });

			for (const m of models) {
				const opt = modelSelect.createEl("option", {
					text: m.display_name || m.id,
					attr: { value: m.id },
				});
				if (m.id === currentModel) {
					opt.selected = true;
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

		refreshBtn.addEventListener("click", () => loadCheckpoints());

		// Load immediately when the section is created
		loadCheckpoints();
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
		compareBtn.addEventListener("click", async () => {
			const current = await this.onGetCurrentContent?.(cp.note_path);
			if (current == null) {
				new Notice(`Note not found: ${cp.note_path}`);
				return;
			}
			this.showCheckpointDiffModal(cp, current);
		});

		// Restore button
		const restoreBtn = actions.createEl("button", {
			cls: "notor-checkpoint-btn notor-checkpoint-restore-btn",
			text: "Restore",
			attr: { "aria-label": "Restore note to this checkpoint" },
		});
		restoreBtn.addEventListener("click", async () => {
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
		this.isSettingsOpen = false;
		this.settingsPopoverEl?.remove();
		this.settingsPopoverEl = undefined;
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	scrollToBottom(): void {
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
			text: "− Checkpoint  /  + Current",
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
		const result: Array<{ type: "unchanged" | "removed" | "added"; text: string }> = [];

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
