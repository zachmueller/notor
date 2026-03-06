/**
 * Chat panel view — primary UI surface for Notor.
 *
 * Implements the Obsidian ItemView for the chat panel with message
 * display, input area, send/stop buttons, and conversation switching.
 *
 * @see specs/01-mvp/spec.md — FR-4, FR-5
 * @see design/ux.md — chat panel layout, message display
 */

import { ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import type NotorPlugin from "../main";
import type { ConversationMode, Message, LLMProviderType, ModelInfo } from "../types";
import type { ConversationListEntry } from "../chat/history";
import { logger } from "../utils/logger";

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
	private textInputEl!: HTMLTextAreaElement;
	private sendButtonEl!: HTMLButtonElement;
	private stopButtonEl!: HTMLButtonElement;
	private modeToggleEl!: HTMLButtonElement;
	private conversationListEl!: HTMLElement;
	private loadingIndicatorEl!: HTMLElement;
	private tokenFooterEl!: HTMLElement;

	// State
	private isResponding = false;
	private abortController: AbortController | null = null;
	private showConversationList = false;

	// Settings popover state
	private settingsPopoverEl?: HTMLElement;
	private isSettingsOpen = false;

	// Callbacks (set by orchestrator)
	private onSendMessage?: (content: string) => Promise<void>;
	private onStopResponse?: () => void;
	private onNewConversation?: () => void;
	private onSwitchConversation?: (filename: string) => void;
	private onModeToggle?: (mode: ConversationMode) => void;
	private onSettingsOpen?: () => void;
	private onProviderChange?: (providerId: LLMProviderType) => void;
	private onModelChange?: (modelId: string) => void;
	private onRefreshModels?: () => Promise<ModelInfo[]>;
	private getAvailableProviders?: () => { type: LLMProviderType; displayName: string }[];
	private getAvailableModels?: () => ModelInfo[];
	private getCurrentProvider?: () => LLMProviderType;
	private getCurrentModel?: () => string;

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

	setOnSendMessage(callback: (content: string) => Promise<void>): void {
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
		this.textInputEl = inputWrapper.createEl("textarea", {
			cls: "notor-text-input",
			attr: {
				placeholder: "Ask Notor...",
				rows: "1",
			},
		});

		// Auto-resize textarea
		this.textInputEl.addEventListener("input", () => {
			this.textInputEl.style.height = "auto";
			this.textInputEl.style.height = Math.min(this.textInputEl.scrollHeight, 200) + "px";
		});

		// Enter to send, Shift+Enter for newline
		this.textInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.handleSend();
			}
		});

		// Button wrapper
		const buttonWrapper = this.inputAreaEl.createDiv({ cls: "notor-input-buttons" });

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
		this.stopButtonEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>';
		this.stopButtonEl.addEventListener("click", () => this.handleStop());
	}

	// -----------------------------------------------------------------------
	// User interactions
	// -----------------------------------------------------------------------

	private async handleSend(): Promise<void> {
		if (this.isResponding) return;

		const content = this.textInputEl.value.trim();
		if (!content) return;

		this.textInputEl.value = "";
		this.textInputEl.style.height = "auto";

		try {
			await this.onSendMessage?.(content);
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
			this.textInputEl.disabled = true;
			this.loadingIndicatorEl.removeClass("notor-hidden");
		} else {
			this.sendButtonEl.removeClass("notor-hidden");
			this.stopButtonEl.addClass("notor-hidden");
			this.textInputEl.disabled = false;
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

	private scrollToBottom(): void {
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