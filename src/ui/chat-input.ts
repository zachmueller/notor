/**
 * Chat input area extracted from chat-view.ts.
 *
 * Manages the text input, resize handle, drag-and-drop, send/stop buttons,
 * mode toggle, attachment chips, and workflow slash-command tokens.
 */

import { Notice, setIcon } from "obsidian";
import type { App, TFile } from "obsidian";
import type { Attachment } from "../context/attachment";
import {
	createVaultNoteAttachment,
	createVaultNoteSectionAttachment,
	createExternalFileAttachment,
	createExternalBinaryAttachment,
	createExternalPdfAttachment,
	readExternalFile,
	isDuplicate,
} from "../context/attachment";
import type { ConversationMode, Workflow } from "../types";
import type { NotorSettings } from "../settings/types";
import {
	VaultNoteSuggest,
	SectionSuggest,
	insertWikilinkToken,
	createAttachmentButton,
	getAbsoluteFilePath,
	readExternalBinaryFile,
	readExternalPdfFile,
	IMAGE_EXTENSIONS,
	PDF_EXTENSIONS,
} from "./attachment-picker";
import { AttachmentChipManager, createAttachmentChipContainer } from "./attachment-chips";
import { WorkflowSlashSuggest, detectSlashTrigger } from "./workflow-suggest";
import { logger } from "../utils/logger";

const log = logger("ChatInput");

export interface ChatInputDeps {
	container: HTMLElement;
	app: App;

	getSettings: () => NotorSettings;
	getIsResponding: () => boolean;
	getPendingAttachments: () => Attachment[];
	setPendingAttachments: (v: Attachment[]) => void;
	getPendingWorkflow: () => Workflow | null;
	setPendingWorkflow: (v: Workflow | null) => void;
	setAutoScroll: (v: boolean) => void;
	getAbortController: () => AbortController | null;
	getMessageListEl: () => HTMLElement;
	getLoadingIndicatorEl: () => HTMLElement;
	getWorkflows: () => Workflow[];
	isActiveLeaf: () => boolean;

	onSendMessage?: (content: string, attachments?: Attachment[]) => Promise<void>;
	onStopResponse?: () => void;
	onSendWorkflow?: (workflow: Workflow, supplementaryText: string) => Promise<void>;
	onModeToggle?: (mode: ConversationMode) => void;
	onForkToNewPanel?: (messageId: string | undefined, initialText?: string) => Promise<void>;
}

export class ChatInput {
	private inputAreaEl!: HTMLElement;
	private inputToolbarEl!: HTMLElement;
	private textInputEl!: HTMLDivElement;
	private sendButtonEl!: HTMLButtonElement;
	private stopButtonEl!: HTMLButtonElement;
	private modeToggleEl!: HTMLButtonElement;
	private attachmentChipContainerEl!: HTMLElement;

	private userDragHeight: number | null = null;
	private resizeHandler?: () => void;
	private tokenObserver?: MutationObserver;
	private attachmentChipManager!: AttachmentChipManager;
	private vaultNoteSuggest?: VaultNoteSuggest;
	private sectionSuggest?: SectionSuggest;
	private workflowSuggest?: WorkflowSlashSuggest;

	constructor(public deps: ChatInputDeps) {}

	build(): void {
		this.inputAreaEl = this.deps.container.createDiv({ cls: "notor-input-area" });

		// Resize handle
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

		// contenteditable div for input
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
			setTimeout(() => this.recalcInputHeight(), 0);
		});
		this.textInputEl.addEventListener("input", () => {
			this.recalcInputHeight();
			this.detectWikilinkTrigger();
			this.detectSlashCommandTrigger();
		});

		// Recalculate max height when the window is resized
		this.resizeHandler = () => this.recalcInputHeight();
		window.addEventListener("resize", this.resizeHandler);

		// Enter to send, Shift+Enter for newline; Tab to select the highlighted
		// workflow or note suggestion.
		//
		// ArrowUp/Down are intentionally NOT handled here: Obsidian's
		// AbstractInputSuggest owns arrow navigation via its own keymap scope and
		// moves the visible highlight itself. Tab delegates selection to that same
		// native highlight through `selectHighlighted()` (which calls Obsidian's
		// own `useSelectedItem`), so it always matches what the user sees — the
		// exact behaviour Enter already has while the popover is open.
		this.textInputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (this.tryHandleBtw()) return;
				void this.handleSend();
			} else if (e.key === "Tab") {
				// stopPropagation guarantees Tab can never fall through to any other
				// handler (e.g. reach an Enter path that would trigger handleSend()).
				if (this.workflowSuggest?.active) {
					e.preventDefault();
					e.stopPropagation();
					this.workflowSuggest.selectHighlighted(e);
				} else if (this.sectionSuggest?.active) {
					e.preventDefault();
					e.stopPropagation();
					this.sectionSuggest.selectHighlighted(e);
				} else if (this.vaultNoteSuggest?.active) {
					e.preventDefault();
					e.stopPropagation();
					this.vaultNoteSuggest.selectHighlighted(e);
				}
			}
		});

		// Force plain-text pastes
		this.textInputEl.addEventListener("paste", (e) => {
			e.preventDefault();
			const text = e.clipboardData?.getData("text/plain") ?? "";
			if (!this.textInputEl.querySelector("[data-workflow-path]")) {
				if (this.tryInsertPastedWorkflowToken(text)) return;
			}
			// Convert any `[[Note]]` / `[[Note#Section]]` wikilinks in the paste
			// into inline attachment tokens (mirrors the live `[[` suggester).
			if (this.tryInsertPastedWikilinkTokens(text)) return;
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
		this.tokenObserver = new MutationObserver((mutations) => {
			for (const mutation of mutations) {
				for (const removed of Array.from(mutation.removedNodes)) {
					for (const el of collectTokenElements(removed)) {
						const id = el.getAttribute("data-attachment-id");
						if (id) {
							this.deps.setPendingAttachments(
								this.deps.getPendingAttachments().filter((a) => a.id !== id)
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
						if (this.deps.getPendingAttachments().some((a) => a.id === id)) continue;
						const attachment =
							type === "vault_note_section" && section
								? createVaultNoteSectionAttachment(path, section)
								: createVaultNoteAttachment(path);
						attachment.id = id;
						this.deps.setPendingAttachments([...this.deps.getPendingAttachments(), attachment]);
					}
					for (const el of collectWorkflowTokenElements(added)) {
						const workflowPath = el.getAttribute("data-workflow-path");
						if (!workflowPath) continue;
						if (this.deps.getPendingWorkflow()?.file_path === workflowPath) continue;
						const workflow = this.deps.getWorkflows().find(
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

		// Initialize vault note suggest
		this.vaultNoteSuggest = new VaultNoteSuggest(
			this.deps.app,
			this.textInputEl,
			(attachment: Attachment) => this.addWikilinkAttachment(attachment),
			() => this.deps.getPendingAttachments()
		);

		// Initialize section-header suggest (opened after a markdown note is
		// picked, so the user may optionally append `#heading`).
		this.sectionSuggest = new SectionSuggest(
			this.deps.app,
			this.textInputEl,
			null,
			(attachment: Attachment) => this.addWikilinkAttachment(attachment),
			() => this.deps.getPendingAttachments()
		);

		// When a markdown note is picked, hand off to the section picker.
		this.vaultNoteSuggest.setOnBeginSectionFlow((file: TFile) => this.beginSectionFlow(file));

		// Initialize workflow slash suggest
		this.workflowSuggest = new WorkflowSlashSuggest(
			this.deps.app,
			this.textInputEl,
			(workflow: Workflow) => this.attachWorkflow(workflow),
			() => this.deps.getWorkflows()
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
		const settings = this.deps.getSettings();
		createAttachmentButton(
			buttonWrapper,
			this.deps.app,
			this.textInputEl,
			(attachment: Attachment) => this.addAttachment(attachment),
			() => this.deps.getPendingAttachments(),
			settings.external_file_size_threshold_mb,
			settings,
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

	destroy(): void {
		this.tokenObserver?.disconnect();
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
		}
	}

	// --- Public API ---

	setRespondingState(responding: boolean): void {
		if (responding) {
			this.sendButtonEl.addClass("notor-hidden");
			this.stopButtonEl.removeClass("notor-hidden");
			this.deps.getLoadingIndicatorEl().removeClass("notor-hidden");
		} else {
			this.sendButtonEl.removeClass("notor-hidden");
			this.stopButtonEl.addClass("notor-hidden");
			this.deps.getLoadingIndicatorEl().addClass("notor-hidden");
			if (this.deps.isActiveLeaf()) {
				this.textInputEl.focus();
			}
		}
	}

	setInputText(text: string): void {
		this.textInputEl.textContent = text;
		this.recalcInputHeight();
	}

	getInputText(): string {
		return this.textInputEl.textContent ?? "";
	}

	triggerSend(): void {
		void this.handleSend();
	}

	updateModeDisplay(mode: ConversationMode): void {
		this.modeToggleEl.textContent = mode === "plan" ? "Plan" : "Act";
		this.modeToggleEl.removeClass("notor-mode-plan", "notor-mode-act");
		this.modeToggleEl.addClass(mode === "plan" ? "notor-mode-plan" : "notor-mode-act");
	}

	focus(): void {
		this.textInputEl.focus();
	}

	getToolbarEl(): HTMLElement {
		return this.inputToolbarEl;
	}

	getInputAreaEl(): HTMLElement {
		return this.inputAreaEl;
	}

	// --- Private: resize ---

	private recalcInputHeight(): void {
		this.textInputEl.setCssProps({ '--notor-input-height': 'auto' });
		const lineHeight = parseFloat(getComputedStyle(this.textInputEl).lineHeight) || 20;
		const padding = 12 + 2;

		const settings = this.deps.getSettings();
		const maxLines = settings.chat_input_max_lines;
		const linesH = (lineHeight * maxLines) + padding;

		if (this.userDragHeight !== null) {
			const newHeight = Math.max(this.userDragHeight, this.textInputEl.scrollHeight);
			this.textInputEl.setCssProps({
				'--notor-input-height': newHeight + 'px',
				'--notor-input-max-height': newHeight + 'px',
			});
			return;
		}

		const pctH = window.innerHeight * (settings.chat_input_max_height_pct / 100);
		const maxH = Math.max(pctH, linesH);
		const newHeight = Math.min(this.textInputEl.scrollHeight, maxH);
		this.textInputEl.setCssProps({
			'--notor-input-height': newHeight + 'px',
			'--notor-input-max-height': maxH + 'px',
		});
	}

	private setupInputResizeHandle(handle: HTMLElement): void {
		handle.addEventListener("pointerdown", (startEvent) => {
			startEvent.preventDefault();
			const startY = startEvent.clientY;
			const startHeight = this.textInputEl.getBoundingClientRect().height;
			const lineHeight = parseFloat(getComputedStyle(this.textInputEl).lineHeight) || 20;
			const padding = 12 + 2;
			const minHeight = (lineHeight * this.deps.getSettings().chat_input_max_lines) + padding;

			const onPointerMove = (moveEvent: PointerEvent) => {
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

	// --- Private: drag and drop ---

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

			const settings = this.deps.getSettings();
			const existing = this.deps.getPendingAttachments();

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

	// --- Private: send/stop/mode handlers ---

	private tryHandleBtw(): boolean {
		const content = this.getInputContentExcludingWorkflowToken();
		const match = content.match(/^\/btw(?:\s+([\s\S]*))?$/i);
		if (!match) return false;

		const initialText = match[1]?.trim() || undefined;
		this.textInputEl.textContent = "";
		void this.deps.onForkToNewPanel?.(undefined, initialText);
		return true;
	}

	private async handleSend(): Promise<void> {
		if (this.deps.getIsResponding()) return;

		this.deps.setAutoScroll(true);

		const pendingWorkflow = this.deps.getPendingWorkflow();
		const content = this.getInputContentExcludingWorkflowToken();

		if (!content && this.deps.getPendingAttachments().length === 0 && !pendingWorkflow) return;

		const attachments = [...this.deps.getPendingAttachments()];
		this.deps.setPendingAttachments([]);
		this.attachmentChipManager.clear();

		this.deps.setPendingWorkflow(null);

		this.textInputEl.textContent = "";
		this.userDragHeight = null;
		this.textInputEl.setCssProps({ '--notor-input-height': 'auto', '--notor-input-max-height': '' });

		try {
			if (pendingWorkflow && this.deps.onSendWorkflow) {
				await this.deps.onSendWorkflow(pendingWorkflow, content);
			} else {
				await this.deps.onSendMessage?.(content, attachments);
			}
		} catch (e) {
			log.error("Send message failed", { error: String(e) });
			new Notice(`Failed to send message: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private handleStop(): void {
		this.deps.getAbortController()?.abort();
		this.deps.onStopResponse?.();
		this.deps.getMessageListEl().querySelectorAll(".notor-approval-prompt").forEach((el) => el.remove());
	}

	private handleModeToggle(): void {
		const currentMode = this.modeToggleEl.textContent?.toLowerCase() as ConversationMode;
		const newMode: ConversationMode = currentMode === "plan" ? "act" : "plan";
		this.updateModeDisplay(newMode);
		this.deps.onModeToggle?.(newMode);
	}

	// --- Private: attachment management ---

	private addWikilinkAttachment(attachment: Attachment): void {
		this.deps.setPendingAttachments([...this.deps.getPendingAttachments(), attachment]);
		log.debug("Wikilink attachment added", {
			id: attachment.id,
			type: attachment.type,
			display: attachment.display_name,
		});
	}

	private addAttachment(attachment: Attachment): void {
		this.deps.setPendingAttachments([...this.deps.getPendingAttachments(), attachment]);
		this.attachmentChipManager.addChip(attachment);
		log.debug("Attachment added", {
			id: attachment.id,
			type: attachment.type,
			display: attachment.display_name,
		});
	}

	private removeAttachment(attachmentId: string): void {
		this.deps.setPendingAttachments(
			this.deps.getPendingAttachments().filter((a) => a.id !== attachmentId)
		);
		this.attachmentChipManager.removeChip(attachmentId);
		log.debug("Attachment removed", { id: attachmentId });
	}

	// --- Private: workflow management ---

	private attachWorkflow(workflow: Workflow): void {
		this.deps.setPendingWorkflow(workflow);
		log.debug("Workflow attached via slash command", {
			display_name: workflow.display_name,
		});
	}

	private removeWorkflow(): void {
		this.deps.setPendingWorkflow(null);
		log.debug("Workflow token removed");
	}

	// --- Private: text/token helpers ---

	private tryInsertPastedWorkflowToken(text: string): boolean {
		const workflows = this.deps.getWorkflows();
		if (workflows.length === 0) return false;

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

		const spacer = document.createTextNode(" ");
		tokenSpan.after(spacer);

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
	 * Scan pasted text for `[[Note]]` / `[[Note#Section]]` wikilinks and splice
	 * each resolvable Markdown note in as an inline attachment token, keeping the
	 * surrounding prose as plain text. Resolution uses Obsidian's own linkpath
	 * resolver so behaviour matches the main editor; unresolvable links and
	 * non-Markdown targets (images/PDFs) are left inert as plain text.
	 *
	 * Returns true if the paste was handled (so the caller skips the plain-text
	 * fallback), false if no wikilink was present.
	 */
	private tryInsertPastedWikilinkTokens(text: string): boolean {
		// Fast bail-out: no wikilink syntax at all.
		if (!text.includes("[[")) return false;

		const pattern = /\[\[([^\]]+)\]\]/g;
		let match: RegExpExecArray | null;
		let lastIndex = 0;
		let insertedAny = false;

		while ((match = pattern.exec(text)) !== null) {
			const inner = match[1] ?? "";
			const hashIdx = inner.indexOf("#");
			const linkpath = (hashIdx === -1 ? inner : inner.slice(0, hashIdx)).trim();
			const section = hashIdx === -1 ? null : inner.slice(hashIdx + 1).trim();

			// Resolve via Obsidian's built-in linkpath resolver (matches main-editor
			// link behaviour). Markdown notes only — leave media/unresolved inert.
			const dest = linkpath
				? this.deps.app.metadataCache.getFirstLinkpathDest(linkpath, "")
				: null;
			if (!dest || dest.extension !== "md") {
				continue;
			}

			const attachment =
				section && section.length > 0
					? createVaultNoteSectionAttachment(dest.path, section)
					: createVaultNoteAttachment(dest.path);

			// Skip notes already attached (e.g. same link pasted twice, or already
			// present from a prior action).
			if (
				isDuplicate(this.deps.getPendingAttachments(), {
					path: attachment.path,
					section: attachment.section,
				})
			) {
				continue;
			}

			// Emit the plain text preceding this match, then the token span.
			const before = text.slice(lastIndex, match.index);
			if (before) this.insertTextAtCursor(before);
			this.insertWikilinkTokenAtCursor(attachment);
			lastIndex = match.index + match[0].length;
			insertedAny = true;
		}

		if (!insertedAny) return false;

		// Emit any trailing text after the final matched link.
		const after = text.slice(lastIndex);
		if (after) this.insertTextAtCursor(after);

		return true;
	}

	/**
	 * Insert a wikilink attachment token at the current caret position, splicing
	 * it into surrounding text (mirrors {@link insertWorkflowTokenAtCursor}).
	 *
	 * Unlike `insertWikilinkToken` in attachment-picker.ts — which finds and
	 * replaces a trailing `[[query` trigger — this inserts at the caret without
	 * disturbing text on either side, which is what mid-paste splicing needs.
	 * The `data-attachment-*` attributes let the MutationObserver auto-register
	 * the pending attachment; we also register it directly so registration does
	 * not depend on observer timing.
	 */
	private insertWikilinkTokenAtCursor(attachment: Attachment): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		range.deleteContents();

		const tokenSpan = document.createElement("span");
		tokenSpan.className = "notor-wikilink-token";
		tokenSpan.contentEditable = "false";
		tokenSpan.setAttribute("data-attachment-id", attachment.id);
		tokenSpan.setAttribute("data-attachment-path", attachment.path);
		tokenSpan.setAttribute("data-attachment-type", attachment.type);
		if (attachment.section) {
			tokenSpan.setAttribute("data-attachment-section", attachment.section);
		}
		tokenSpan.textContent = `[[${attachment.display_name}]]`;
		range.insertNode(tokenSpan);

		const spacer = document.createTextNode(" ");
		tokenSpan.after(spacer);

		const newRange = document.createRange();
		newRange.setStart(spacer, 1);
		newRange.collapse(true);
		sel.removeAllRanges();
		sel.addRange(newRange);

		this.addWikilinkAttachment(attachment);
		log.debug("Wikilink token inserted from paste", {
			path: attachment.path,
			section: attachment.section,
		});
	}

	private insertTextAtCursor(text: string): void {
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) return;

		const range = sel.getRangeAt(0);
		range.deleteContents();

		const node = document.createTextNode(text);
		range.insertNode(node);

		const newRange = document.createRange();
		newRange.setStart(node, node.length);
		newRange.collapse(true);
		sel.removeAllRanges();
		sel.addRange(newRange);
	}

	private getInputContentExcludingWorkflowToken(): string {
		let text = "";
		for (const node of Array.from(this.textInputEl.childNodes)) {
			if (node instanceof HTMLElement && node.hasAttribute("data-workflow-path")) continue;
			text += node.textContent ?? "";
		}
		return text.trim();
	}

	// --- Private: section-header flow ---

	/**
	 * Enter the section-header picker after a markdown note was chosen.
	 *
	 * `VaultNoteSuggest` has already replaced `[[query` with editable
	 * `[[Basename#` text and closed its own popover. We activate the section
	 * suggest for `file` (with a dismiss callback that finalizes the plain
	 * `[[Note]]` attachment if the user backs out), then fire a synthetic `input`
	 * event so Obsidian's `AbstractInputSuggest` opens the section popover — the
	 * same mechanism the "Attach vault note" menu button uses to open the note
	 * picker.
	 */
	private beginSectionFlow(file: TFile): void {
		if (!this.sectionSuggest) return;

		this.sectionSuggest.activate(file, () => this.finalizePlainNote(file));

		// Defer so the current selection/close settles before we reopen.
		setTimeout(() => {
			if (this.sectionSuggest?.active) {
				this.textInputEl.dispatchEvent(new Event("input", { bubbles: true }));
			}
		}, 0);
	}

	/**
	 * Finalize a plain `[[Note]]` attachment when the section picker is dismissed
	 * without choosing a heading. Replaces the leftover `[[Basename#` live text
	 * with the atomic note token.
	 */
	private finalizePlainNote(file: TFile): void {
		// Only finalize if our live `[[…#` text is still present and unfinished
		// (the user may have deleted it, or a token may already exist).
		const text = this.textInputEl.textContent ?? "";
		const triggerIdx = text.lastIndexOf("[[");
		if (triggerIdx === -1 || text.slice(triggerIdx + 2).includes("]]")) return;

		const attachment = createVaultNoteAttachment(file.path);
		insertWikilinkToken(this.textInputEl, attachment);
		this.addWikilinkAttachment(attachment);
		log.debug("Section flow dismissed — finalized plain note", { path: file.path });
	}

	// --- Private: trigger detection ---

	private detectSlashCommandTrigger(): void {
		if (this.vaultNoteSuggest?.["isActive"]) return;
		if (this.sectionSuggest?.active) return;
		if (this.textInputEl.querySelector("[data-workflow-path]")) return;

		const text = this.textInputEl.textContent ?? "";
		const slashIdx = detectSlashTrigger(text);

		if (slashIdx !== null && this.workflowSuggest) {
			this.workflowSuggest.activate(slashIdx);
		}
	}

	private detectWikilinkTrigger(): void {
		// While the section picker is active, the input holds `[[Basename#…` — do
		// NOT re-activate the vault-note suggest over it; the section suggest owns
		// this input event.
		if (this.sectionSuggest?.active) return;

		const text = this.textInputEl.textContent ?? "";
		const triggerIdx = text.lastIndexOf("[[");

		if (triggerIdx !== -1 && this.vaultNoteSuggest) {
			const afterTrigger = text.slice(triggerIdx + 2);
			// A `#` means the note name is complete and we're into section territory;
			// don't re-open the note picker over it.
			if (!afterTrigger.includes("]]") && !afterTrigger.includes("#")) {
				this.vaultNoteSuggest.activate(triggerIdx);
			}
		}
	}
}
