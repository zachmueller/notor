/**
 * Message renderer extracted from chat-view.ts.
 *
 * Handles rendering of user messages, streaming assistant messages,
 * tool calls/results, extension blocks, approval prompts, and token footer.
 */

import { MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { App, Component } from "obsidian";
import type { Message } from "../types";
import type { NotorSettings } from "../settings/types";
import type { ChatBlockRegistry } from "./chat-blocks/registry";
import type { PendingMemoryManager } from "../memory/pending-memory-manager";
import { getTextContent } from "../media/types";
import { renderCollapsibleCard } from "./chat-blocks/collapsible-card";
import { extractPopoverTags, stripPopoverTags, injectPopoverElements } from "./popover-refs";
import {
	renderWriteNoteDiffPreview,
	renderReplaceInNoteDiffPreview,
	type DiffRenderContext,
} from "./diff-view";
import { marked } from "marked";
import { logger } from "../utils/logger";

const log = logger("MessageRenderer");

function extractAttachmentsBlock(content: string): { attachmentsXml: string | null; remainder: string } {
	const ATTACHMENTS_RE = /<attachments>([\s\S]*?)<\/attachments>/;
	const match = ATTACHMENTS_RE.exec(content);
	if (!match) return { attachmentsXml: null, remainder: content };
	const attachmentsXml = match[0];
	const remainder = (content.slice(0, match.index) + content.slice(match.index + match[0].length)).trim();
	return { attachmentsXml, remainder };
}

export interface MessageRendererDeps {
	getMessageListEl: () => HTMLElement;
	getTokenFooterEl: () => HTMLElement;
	app: App;
	component: Component;
	getSettings: () => NotorSettings;
	getChatBlockRegistry: () => ChatBlockRegistry;
	getPendingMemoryManager: () => PendingMemoryManager | null;
	scrollToBottom: () => void;
	openInternalLink: (href: string) => void;
	openChatInNewTab: (conversationFilename?: string, createNew?: boolean, initialText?: string, conversationId?: string) => void;
	onOpenSettingsGroup?: (groupTitle: string, subsection?: string) => void;
}

export class MessageRenderer {
	private lastToolCallEl: HTMLElement | null = null;
	private toolCallElMap = new Map<string, HTMLElement>();
	private renderedMessages = new Map<string, Message>();
	private streamRenderTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingStreamRender: { contentEl: HTMLElement; raw: string } | null = null;

	constructor(public deps: MessageRendererDeps) {}

	// --- Public API ---

	renderUserMessage(message: Message): void {
		if (message.is_hook_injection) {
			this.renderHookInjection(message);
			return;
		}

		const messageListEl = this.deps.getMessageListEl();
		const msgEl = messageListEl.createDiv({ cls: "notor-message notor-message-user" });
		msgEl.dataset.messageId = message.id;
		this.appendForkButton(msgEl, message);
		const contentEl = msgEl.createDiv({ cls: "notor-message-content" });

		const textContent = getTextContent(message.content);
		const { attachmentsXml, remainder } = extractAttachmentsBlock(textContent);
		if (attachmentsXml !== null) {
			this.renderAttachmentsBlock(contentEl, attachmentsXml);
		}
		const textToRender = attachmentsXml !== null ? remainder : textContent;

		if (message.is_workflow_message) {
			this.renderWorkflowMessage(contentEl, textToRender);
		} else if (textToRender) {
			contentEl.createEl("p", { text: textToRender });
		}

		this.deps.scrollToBottom();
	}

	createAssistantMessagePlaceholder(): HTMLElement {
		const messageListEl = this.deps.getMessageListEl();
		const msgEl = messageListEl.createDiv({ cls: "notor-message notor-message-assistant" });
		const contentEl = msgEl.createDiv({ cls: "notor-message-content" });
		this.deps.scrollToBottom();
		return contentEl;
	}

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

	appendThinkingChunk(contentEl: HTMLElement, text: string): void {
		let detailsEl = contentEl.querySelector<HTMLElement>(".notor-thinking-block");
		if (!detailsEl) {
			detailsEl = contentEl.createEl("details", { cls: "notor-thinking-block" });
			detailsEl.createEl("summary", { text: "Thinking" });
			detailsEl.createEl("div", { cls: "notor-thinking-content" });
			if (contentEl.firstChild && contentEl.firstChild !== detailsEl) {
				contentEl.insertBefore(detailsEl, contentEl.firstChild);
			}
		}
		const thinkingContent = detailsEl.querySelector<HTMLElement>(".notor-thinking-content")!;
		const existing = thinkingContent.getAttribute("data-raw") ?? "";
		const updated = existing + text;
		thinkingContent.setAttribute("data-raw", updated);
		thinkingContent.textContent = updated;
		this.deps.scrollToBottom();
	}

	async finalizeAssistantMessage(contentEl: HTMLElement, message: Message): Promise<void> {
		if (this.streamRenderTimer) {
			clearTimeout(this.streamRenderTimer);
			this.streamRenderTimer = null;
			this.pendingStreamRender = null;
		}
		contentEl.parentElement!.dataset.messageId = message.id;
		this.appendForkButton(contentEl.parentElement!, message);
		contentEl.empty();

		if (message.thinking) {
			const detailsEl = contentEl.createEl("details", { cls: "notor-thinking-block" });
			detailsEl.createEl("summary", { text: "Thinking" });
			const thinkingDiv = detailsEl.createEl("div", { cls: "notor-thinking-content" });
			thinkingDiv.textContent = message.thinking;
		}

		const assistantText = typeof message.content === "string"
			? message.content
			: (() => { throw new Error("Expected string content for assistant message"); })();

		let textForRender: string;
		let popoverRefs: { index: number; note?: string; href?: string; title?: string; annotation: string }[] = [];
		if (this.deps.getSettings().enable_popover_references) {
			const extracted = extractPopoverTags(assistantText);
			textForRender = extracted.cleaned;
			popoverRefs = extracted.refs;
		} else {
			textForRender = stripPopoverTags(assistantText);
		}

		await MarkdownRenderer.render(
			this.deps.app,
			textForRender,
			contentEl,
			"",
			this.deps.component
		);

		if (popoverRefs.length > 0) {
			injectPopoverElements(contentEl, popoverRefs, {
				openNote: (path) => this.deps.openInternalLink(path),
				openUrl: (url) => window.open(url, "_blank"),
			});
		}

		this.activateInternalLinks(contentEl);
		this.activateSettingsLinks(contentEl);
		this.activateConversationLinks(contentEl);

		if (message.input_tokens || message.output_tokens) {
			const tokenEl = contentEl.createDiv({ cls: "notor-message-tokens" });
			const parts: string[] = [];
			if (message.input_tokens) parts.push(`↑${message.input_tokens}`);
			if (message.output_tokens) parts.push(`↓${message.output_tokens}`);
			tokenEl.textContent = parts.join(" · ");
		}

		this.deps.scrollToBottom();
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

	renderToolCall(message: Message): HTMLElement {
		const messageListEl = this.deps.getMessageListEl();
		const toolCall = message.tool_call;
		if (!toolCall) return messageListEl.createDiv();

		const toolEl = messageListEl.createDiv({ cls: "notor-tool-call" });

		const headerEl = toolEl.createDiv({ cls: "notor-tool-call-header" });
		const nameEl = headerEl.createSpan({ cls: "notor-tool-call-name" });
		nameEl.textContent = toolCall.tool_name;

		const statusEl = headerEl.createSpan({
			cls: `notor-tool-call-status notor-tool-status-${toolCall.status}`,
		});
		statusEl.textContent = toolCall.status;

		const { body: paramsEl } = renderCollapsibleCard(toolEl, { headerText: "parameters" });
		paramsEl.addClass("notor-tool-call-params");
		const pre = paramsEl.createEl("pre");
		pre.createEl("code", { text: JSON.stringify(toolCall.parameters, null, 2) });

		this.lastToolCallEl = toolEl;
		if (message.id) {
			this.toolCallElMap.set(message.id, toolEl);
		}
		this.deps.scrollToBottom();
		return toolEl;
	}

	renderToolResult(message: Message): void {
		const messageListEl = this.deps.getMessageListEl();
		const toolResult = message.tool_result;
		if (!toolResult) return;

		const resultEl = messageListEl.createDiv({ cls: "notor-tool-result" });
		resultEl.dataset.messageId = message.id;
		this.appendForkButton(resultEl, message);

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

		this.deps.scrollToBottom();
	}

	updateToolCallStatus(toolEl: HTMLElement, status: string): void {
		const statusEl = toolEl.querySelector(".notor-tool-call-status");
		if (!statusEl) return;
		statusEl.className = `notor-tool-call-status notor-tool-status-${status}`;
		statusEl.textContent = status;

		const progressEl = toolEl.querySelector(".notor-tool-call-progress");
		if (progressEl) progressEl.remove();
	}

	updateToolCallProgress(toolEl: HTMLElement, status: string): void {
		let progressEl = toolEl.querySelector(".notor-tool-call-progress");
		if (!progressEl) {
			progressEl = toolEl.createDiv({ cls: "notor-tool-call-progress" });
		}
		progressEl.textContent = status;
		this.deps.scrollToBottom();
	}

	renderExtensionBlock(message: Message): void {
		const messageListEl = this.deps.getMessageListEl();
		const rowEl = messageListEl.createDiv({ cls: "notor-extension-block" });
		rowEl.dataset.messageId = message.id;
		this.populateExtensionBlockEl(rowEl, message);
		this.deps.scrollToBottom();
	}

	reRenderExtensionBlock(message: Message): void {
		const messageListEl = this.deps.getMessageListEl();
		const existing = messageListEl.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
		if (!existing || !existing.classList.contains("notor-extension-block")) return;
		existing.empty();
		this.populateExtensionBlockEl(existing, message);
	}

	renderApprovalPrompt(toolCallEl: HTMLElement, autoApproved = false): Promise<"approved" | "rejected"> {
		if (autoApproved) {
			return Promise.resolve("approved");
		}
		return new Promise((resolve) => {
			const approvalEl = toolCallEl.createDiv({ cls: "notor-approval-prompt" });
			approvalEl.createSpan({ text: "Approve this action?", cls: "notor-approval-text" });

			const btnContainer = approvalEl.createDiv({ cls: "notor-approval-buttons" });
			this.deps.scrollToBottom();

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

	reRenderPendingApprovals(
		pendingApprovals: Map<string, { toolName: string; parameters: Record<string, unknown> }>
	): Map<string, Promise<"approved" | "rejected">> {
		const results = new Map<string, Promise<"approved" | "rejected">>();
		for (const [msgId, { toolName, parameters }] of pendingApprovals) {
			const toolCallEl = this.getToolCallEl(msgId);
			if (toolCallEl) {
				results.set(msgId, this.renderDiffApprovalPrompt(toolCallEl, toolName, parameters, false));
			}
		}
		return results;
	}

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

			let beforeContent = "";
			try {
				const file = this.deps.app.vault.getFileByPath(notePath);
				if (file) {
					beforeContent = await this.deps.app.vault.read(file);
				}
			} catch {
				// New file
			}

			const messageListEl = this.deps.getMessageListEl();
			const renderCtx: DiffRenderContext = { app: this.deps.app, component: this.deps.component, sourcePath: notePath };
			const decisionPromise = renderWriteNoteDiffPreview(
				messageListEl,
				notePath,
				beforeContent,
				afterContent,
				autoApproved,
				renderCtx,
				() => this.deps.scrollToBottom()
			);
			this.deps.scrollToBottom();
			const decision = await decisionPromise;
			return decision.accepted ? "approved" : "rejected";
		}

		if (toolName === "replace_in_note") {
			const changeBlocks = (parameters["changes"] as Array<{ search: string; replace: string }> | undefined) ?? [];

			let noteContent = "";
			try {
				const file = this.deps.app.vault.getFileByPath(notePath);
				if (file) {
					noteContent = await this.deps.app.vault.read(file);
				}
			} catch {
				return this.renderApprovalPrompt(toolCallEl, autoApproved);
			}

			if (!noteContent) {
				return this.renderApprovalPrompt(toolCallEl, autoApproved);
			}

			const messageListEl = this.deps.getMessageListEl();
			const replaceRenderCtx: DiffRenderContext = { app: this.deps.app, component: this.deps.component, sourcePath: notePath };
			const decisionPromise = renderReplaceInNoteDiffPreview(
				messageListEl,
				notePath,
				noteContent,
				changeBlocks,
				autoApproved,
				replaceRenderCtx,
				() => this.deps.scrollToBottom()
			);
			this.deps.scrollToBottom();
			const decision = await decisionPromise;
			if (!decision.accepted) return "rejected";

			if (decision.acceptedBlockIndexes) {
				parameters["changes"] = changeBlocks.filter((_, i) =>
					decision.acceptedBlockIndexes!.has(i)
				);
			}
			return "approved";
		}

		return this.renderApprovalPrompt(toolCallEl, autoApproved);
	}

	updateTokenFooter(
		contextTokens: number,
		outputTokens: number,
		estimatedCost: number | null
	): void {
		const tokenFooterEl = this.deps.getTokenFooterEl();
		tokenFooterEl.empty();
		tokenFooterEl.removeClass("notor-hidden");

		const parts: string[] = [
			`Context: ↑${contextTokens.toLocaleString()} ↓${outputTokens.toLocaleString()}`,
		];

		if (estimatedCost != null) {
			parts.push(`Cost: $${estimatedCost.toFixed(4)}`);
		}

		tokenFooterEl.textContent = parts.join(" · ");
	}

	showTruncationWarning(truncatedCount: number): void {
		const messageListEl = this.deps.getMessageListEl();
		const warningEl = messageListEl.createDiv({ cls: "notor-truncation-warning" });
		warningEl.textContent = `⚠ ${truncatedCount} older message${truncatedCount > 1 ? "s" : ""} trimmed from AI context to fit within the model's context window. Full history is still visible above and saved in the log.`;
		this.deps.scrollToBottom();
	}

	showError(error: string): void {
		const messageListEl = this.deps.getMessageListEl();
		const errorEl = messageListEl.createDiv({ cls: "notor-chat-error" });
		errorEl.textContent = `⚠ ${error}`;
		this.deps.scrollToBottom();
	}

	clearMessages(): void {
		const messageListEl = this.deps.getMessageListEl();
		messageListEl.empty();
		this.deps.getTokenFooterEl().addClass("notor-hidden");
		this.toolCallElMap.clear();
		this.renderedMessages.clear();
		this.lastToolCallEl = null;
	}

	hasMessageElement(messageId: string): boolean {
		return !!this.deps.getMessageListEl().querySelector(`[data-message-id="${messageId}"]`);
	}

	getLastToolCallEl(): HTMLElement | null {
		return this.lastToolCallEl;
	}

	getToolCallEl(messageId: string): HTMLElement | null {
		return this.toolCallElMap.get(messageId) ?? null;
	}

	getMessagesContainer(): HTMLElement {
		return this.deps.getMessageListEl();
	}

	getRenderedMessage(id: string): Message | undefined {
		return this.renderedMessages.get(id);
	}

	// --- Private helpers ---

	private renderStreamMarkdown(contentEl: HTMLElement, raw: string): void {
		const html = marked.parse(raw, { async: false });
		while (contentEl.firstChild) contentEl.firstChild.remove();
		const doc = new DOMParser().parseFromString(html, "text/html");
		while (doc.body.firstChild) {
			contentEl.appendChild(activeDocument.adoptNode(doc.body.firstChild));
		}
		this.deps.scrollToBottom();
	}

	private renderWorkflowMessage(container: HTMLElement, content: string): void {
		const WORKFLOW_RE = /<workflow_instructions\s+type="([^"]*)">([\s\S]*?)<\/workflow_instructions>/;
		const match = WORKFLOW_RE.exec(content);

		if (!match) {
			container.createEl("p", { text: content });
			return;
		}

		const matchStart = match.index;
		const matchEnd = match.index + match[0].length;
		const workflowType = match[1] ?? "";
		const workflowBody = match[2] ?? "";

		const beforeText = content.slice(0, matchStart).trim();
		const afterText = content.slice(matchEnd).trim();

		if (beforeText) {
			const triggerDetails = container.createEl("details", { cls: "notor-trigger-context-details" });
			triggerDetails.createEl("summary", { text: "Trigger context" });
			const pre = triggerDetails.createEl("pre");
			pre.createEl("code", { text: beforeText });
		}

		const details = container.createEl("details", { cls: "notor-workflow-details" });
		details.createEl("summary", { text: `Workflow: ${workflowType}` });
		const bodyEl = details.createDiv({ cls: "notor-workflow-content" });
		bodyEl.textContent = workflowBody;

		if (afterText) {
			container.createEl("p", { text: afterText });
		}
	}

	private renderHookInjection(message: Message): void {
		const messageListEl = this.deps.getMessageListEl();
		const wrapper = messageListEl.createDiv({ cls: "notor-hook-injection" });
		const details = wrapper.createEl("details");
		details.createEl("summary", { text: "Hook output" });
		const pre = details.createEl("pre", { cls: "notor-hook-injection-content" });
		pre.createEl("code", { text: getTextContent(message.content) });
		this.deps.scrollToBottom();
	}

	private renderAttachmentsBlock(container: HTMLElement, xml: string): void {
		const details = container.createEl("details", { cls: "notor-attachments-details" });
		details.createEl("summary", { text: "Attachments" });
		const pre = details.createEl("pre", { cls: "notor-attachments-content" });
		pre.createEl("code", { text: xml });
	}

	private activateInternalLinks(containerEl: HTMLElement): void {
		const handleLinkClick = (e: MouseEvent) => {
			const link = (e.target as HTMLElement).closest("a.internal-link");
			if (!link) return;
			e.preventDefault();
			const href = link.getAttribute("data-href");
			if (href) this.deps.openInternalLink(href);
		};

		containerEl.addEventListener("click", handleLinkClick);
		containerEl.addEventListener("auxclick", (e) => {
			if (e.button !== 1) return;
			handleLinkClick(e);
		});
	}

	private activateSettingsLinks(containerEl: HTMLElement): void {
		const prefix = "notor-settings://";
		const allLinks = containerEl.querySelectorAll<HTMLAnchorElement>("a");
		log.debug("activateSettingsLinks: scanning rendered content", {
			totalAnchors: allLinks.length,
			hasCallback: !!this.deps.onOpenSettingsGroup,
		});

		for (const link of allLinks) {
			const href = link.getAttribute("href") ?? link.getAttribute("data-href") ?? "";
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

			link.addEventListener("click", (e: MouseEvent) => {
				log.debug("activateSettingsLinks: click fired", { groupTitle, subsection });
				e.preventDefault();
				e.stopPropagation();
				this.deps.onOpenSettingsGroup?.(groupTitle, subsection);
			});

			link.removeAttribute("href");
			link.dataset.notorSettingsGroup = groupTitle;
			link.classList.add("notor-settings-link");
		}

		log.debug("activateSettingsLinks: scan complete", { matched, total: allLinks.length });
	}

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
				this.deps.openChatInNewTab(undefined, false, undefined, conversationId);
			});

			link.removeAttribute("href");
			link.classList.add("notor-conversation-link");
		}
	}

	private populateExtensionBlockEl(el: HTMLElement, message: Message): void {
		const blocks = Array.isArray(message.content) ? message.content : [];

		if (message.source_extension) {
			el.createDiv({ cls: "notor-extension-block-source", text: message.source_extension });
		}

		const registry = this.deps.getChatBlockRegistry();
		const ctx = {
			message,
			app: this.deps.app,
			openInternalLink: (linkText: string) => this.deps.openInternalLink(linkText),
			collapsibleCard: renderCollapsibleCard,
			pendingMemoryManager: this.deps.getPendingMemoryManager(),
		};

		for (const block of blocks) {
			const b = block;
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
					const sourceExt = message.source_extension;
					const settings = this.deps.getSettings();
					const isExplicitlyDisabled = sourceExt != null &&
						settings.tool_enabled[sourceExt] === false;
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
}
