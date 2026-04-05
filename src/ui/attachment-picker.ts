/**
 * Attachment picker UI — vault note autocomplete and external file dialog.
 *
 * Implements two attachment mechanisms:
 *   1. Vault note picker with `AbstractInputSuggest<T>` for inline autocomplete
 *      triggered by `[[` in the chat input (per R-1 findings).
 *   2. External file picker using `<input type="file">` with Electron's
 *      `File.path` property (per R-2 findings).
 *
 * @see specs/02-context-intelligence/tasks.md — ATT-005, ATT-006
 * @see specs/02-context-intelligence/research.md — R-1, R-2
 */

import {
	AbstractInputSuggest,
	type App,
	type FuzzyMatch,
	type SearchResult,
	type TFile,
	renderMatches,
	Platform,
	Notice,
	prepareFuzzySearch,
	parseFrontMatterAliases,
	setIcon,
} from "obsidian";
import { ConfirmModal } from "./confirm-modal";
import type { Attachment } from "../context/attachment";
import {
	createVaultNoteAttachment,
	createVaultNoteSectionAttachment,
	createExternalFileAttachment,
	createVaultImageAttachment,
	createExternalBinaryAttachment,
	readExternalFile,
	isDuplicate,
} from "../context/attachment";
import { detectMediaFormat } from "../media/format-detector";
import { processImage } from "../media/image-processor";
import type { ImageMediaType } from "../media/types";
import type { NotorSettings } from "../settings/types";

// ---------------------------------------------------------------------------
// Inline wikilink token insertion
// ---------------------------------------------------------------------------

/**
 * Replace the `[[query` text in a contenteditable input with a styled inline
 * token span. The span has `contenteditable="false"` so the browser treats it
 * as an atomic unit: arrow keys skip over it in one keystroke, and Backspace
 * while it is selected removes the whole token in one keystroke.
 *
 * @param inputEl   - The contenteditable chat input div.
 * @param attachment - The attachment whose display name and id to embed.
 */
export function insertWikilinkToken(
	inputEl: HTMLDivElement,
	attachment: Attachment
): void {
	const fullText = inputEl.textContent ?? "";
	const triggerIdx = fullText.lastIndexOf("[[");
	if (triggerIdx === -1) return;

	// Walk text nodes to find which one contains triggerIdx and at what offset
	// within that node.
	const walker = document.createTreeWalker(inputEl, NodeFilter.SHOW_TEXT);
	let accumulated = 0;
	let targetTextNode: Text | null = null;
	let offsetInNode = 0;

	let node = walker.nextNode() as Text | null;
	while (node) {
		const len = node.length;
		if (accumulated + len > triggerIdx) {
			targetTextNode = node;
			offsetInNode = triggerIdx - accumulated;
			break;
		}
		accumulated += len;
		node = walker.nextNode() as Text | null;
	}

	if (!targetTextNode) return;

	// Split the text node at triggerIdx so splitNode starts with "[[query..."
	const splitNode = targetTextNode.splitText(offsetInNode);

	// Remove splitNode and every DOM node that comes after it (there should be
	// nothing after it since the user is typing at the end, but be safe).
	let sibling: ChildNode | null = splitNode;
	while (sibling) {
		const next: ChildNode | null = sibling.nextSibling;
		sibling.parentNode?.removeChild(sibling);
		sibling = next;
	}

	// Insert the styled token span.
	// Store path/type/section so the MutationObserver can reconstruct the
	// attachment if Undo restores the span after a Backspace deletion.
	const tokenAttr: Record<string, string> = {
		contenteditable: "false",
		"data-attachment-id": attachment.id,
		"data-attachment-path": attachment.path,
		"data-attachment-type": attachment.type,
	};
	if (attachment.section) {
		tokenAttr["data-attachment-section"] = attachment.section;
	}
	const tokenSpan = inputEl.createSpan({
		cls: "notor-wikilink-token",
		attr: tokenAttr,
		text: `[[${attachment.display_name}]]`,
	});

	// A trailing regular-space text node lets the cursor sit after the token.
	const spacer = document.createTextNode(" ");
	inputEl.appendChild(spacer);

	// Move cursor to after the spacer.
	const range = document.createRange();
	range.setStart(spacer, 1);
	range.collapse(true);
	const sel = window.getSelection();
	sel?.removeAllRanges();
	sel?.addRange(range);

	// Silence the unused-variable lint for tokenSpan (it is already appended
	// to the DOM by createSpan above).
	void tokenSpan;
}
import { logger } from "../utils/logger";

const log = logger("AttachmentPicker");

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

/** Called when a new attachment is added via the picker. */
export type OnAttachmentAdded = (attachment: Attachment) => void;

// ---------------------------------------------------------------------------
// ATT-005: Vault note autocomplete suggest
// ---------------------------------------------------------------------------

/** Suggestion item for the vault note picker. */
interface VaultNoteSuggestion {
	/** The TFile for the note. */
	file: TFile;
	/** Display text (filename without extension). */
	display: string;
	/** Fuzzy match result for highlighting. */
	match: FuzzyMatch<TFile> | null;
	/** What the match was against — used to show context in the suggestion row. */
	matchSource: "name" | "path" | "alias";
	/** The alias that matched (only set when matchSource is "alias"). */
	matchedAlias?: string;
}

/** Suggestion item for section header picker. */
interface SectionSuggestion {
	/** The heading text. */
	heading: string;
	/** Heading level (1-6). */
	level: number;
	/** Parent file path. */
	filePath: string;
}

/**
 * Vault note autocomplete using `AbstractInputSuggest<T>`.
 *
 * Attaches to the chat input `contenteditable <div>` and provides
 * fuzzy matching against vault note names. After a note is selected,
 * typing `#` triggers a second pass for section header selection.
 *
 * Triggered by typing `[[` in the chat input via an input event listener.
 */
export class VaultNoteSuggest extends AbstractInputSuggest<VaultNoteSuggestion> {
	private onAttachmentAdded: OnAttachmentAdded;
	private existingAttachments: () => Attachment[];
	private chatInputEl: HTMLDivElement;
	private isActive = false;
	private triggerStartIndex = -1;
	private currentSuggestions: VaultNoteSuggestion[] = [];
	private selectedIndex = -1;

	constructor(
		app: App,
		inputEl: HTMLDivElement,
		onAttachmentAdded: OnAttachmentAdded,
		existingAttachments: () => Attachment[]
	) {
		super(app, inputEl);
		this.chatInputEl = inputEl;
		this.onAttachmentAdded = onAttachmentAdded;
		this.existingAttachments = existingAttachments;
		this.limit = 20;
	}

	/** Activate the suggest overlay after `[[` is detected. */
	activate(triggerStartIndex: number): void {
		this.isActive = true;
		this.triggerStartIndex = triggerStartIndex;
		this.selectedIndex = -1;
		log.debug("VaultNoteSuggest activated", { triggerStartIndex });
	}

	/** Deactivate and reset. */
	deactivate(): void {
		this.isActive = false;
		this.triggerStartIndex = -1;
		this.currentSuggestions = [];
		this.selectedIndex = -1;
		log.debug("VaultNoteSuggest deactivated");
	}

	/** Whether the suggest overlay is currently active. */
	get active(): boolean {
		return this.isActive;
	}

	/**
	 * Move the tracked selection index by `delta` (+1 down, −1 up), wrapping at
	 * the list boundaries. Called by the chat-view keydown handler for ArrowDown/Up
	 * so that Tab-key selection honours the user's navigation.
	 */
	navigateSelection(delta: 1 | -1): void {
		const len = this.currentSuggestions.length;
		if (len === 0) {
			log.debug("VaultNoteSuggest navigateSelection skipped: no suggestions");
			return;
		}
		const prev = this.selectedIndex;
		if (this.selectedIndex === -1) {
			this.selectedIndex = delta === 1 ? 0 : len - 1;
		} else {
			this.selectedIndex = (this.selectedIndex + delta + len) % len;
		}
		log.debug("VaultNoteSuggest navigateSelection", {
			delta,
			prev,
			next: this.selectedIndex,
			listLength: len,
			item: this.currentSuggestions[this.selectedIndex]?.file.path,
		});
	}

	/** Select the currently highlighted suggestion (or the first if none navigated). Used for Tab-key selection. */
	selectFirst(): void {
		const idx = this.selectedIndex >= 0 ? this.selectedIndex : 0;
		const item = this.currentSuggestions[idx];
		log.debug("VaultNoteSuggest selectFirst", {
			selectedIndex: this.selectedIndex,
			resolvedIdx: idx,
			item: item?.file.path ?? null,
			listLength: this.currentSuggestions.length,
		});
		if (item !== undefined) {
			this.selectSuggestion(item);
		}
	}

	getSuggestions(inputStr: string): VaultNoteSuggestion[] {
		if (!this.isActive) {
			return [];
		}

		// Extract the query text after the `[[` trigger
		const query = this.extractQuery(inputStr);
		if (query === null) {
			this.deactivate();
			return [];
		}

		const allFiles = this.app.vault.getFiles();
		const files = allFiles.filter((f) => {
			const ext = "." + f.extension.toLowerCase();
			return ext === ".md" || IMAGE_EXTENSIONS.has(ext);
		});

		if (!query) {
			// No query yet — show all files (up to limit)
			this.currentSuggestions = files.slice(0, this.limit).map((file) => ({
				file,
				display: file.basename,
				match: null,
				matchSource: "name" as const,
			}));
			this.selectedIndex = -1;
			log.debug("VaultNoteSuggest suggestions updated (no query)", { count: this.currentSuggestions.length });
			return this.currentSuggestions;
		}

		// Fuzzy match against filenames, paths, and aliases
		const fuzzySearch = prepareFuzzySearch(query);
		const results: VaultNoteSuggestion[] = [];

		for (const file of files) {
			type Candidate = { score: number; result: SearchResult; source: "name" | "path" | "alias"; alias?: string };
			const candidates: Candidate[] = [];

			const nameResult = fuzzySearch(file.basename);
			if (nameResult) {
				candidates.push({ score: nameResult.score, result: nameResult, source: "name" });
			}

			const pathResult = fuzzySearch(file.path);
			if (pathResult) {
				candidates.push({ score: pathResult.score, result: pathResult, source: "path" });
			}

			const cache = this.app.metadataCache.getFileCache(file);
			const aliases = parseFrontMatterAliases(cache?.frontmatter) ?? [];
			for (const alias of aliases) {
				const aliasResult = fuzzySearch(alias);
				if (aliasResult) {
					candidates.push({ score: aliasResult.score, result: aliasResult, source: "alias", alias });
				}
			}

			candidates.sort((a, b) => b.score - a.score);
			const best = candidates[0];
			if (best) {
				results.push({
					file,
					display: file.basename,
					match: { item: file, match: best.result },
					matchSource: best.source,
					matchedAlias: best.alias,
				});
			}
		}

		// Sort by match score (higher is better)
		results.sort((a, b) => {
			const scoreA = a.match?.match.score ?? 0;
			const scoreB = b.match?.match.score ?? 0;
			return scoreB - scoreA;
		});

		this.currentSuggestions = results.slice(0, this.limit);
		this.selectedIndex = -1;
		log.debug("VaultNoteSuggest suggestions updated (query)", { query, count: this.currentSuggestions.length });
		return this.currentSuggestions;
	}

	renderSuggestion(suggestion: VaultNoteSuggestion, el: HTMLElement): void {
		const container = el.createDiv({ cls: "notor-suggest-item" });

		// Show image icon for image files
		const ext = "." + suggestion.file.extension.toLowerCase();
		if (IMAGE_EXTENSIONS.has(ext)) {
			container.createSpan({ cls: "notor-suggest-icon", text: "\uD83D\uDDBC\uFE0F " });
		}

		if (suggestion.matchSource === "path" && suggestion.match?.match.matches) {
			// Path match: render the full path with highlights
			const pathEl = container.createSpan({ cls: "notor-suggest-name" });
			renderMatches(pathEl, suggestion.file.path, suggestion.match.match.matches);
		} else {
			// Show file path in a subtle way
			const pathParts = suggestion.file.path.split("/");
			if (pathParts.length > 1) {
				const folderPath = pathParts.slice(0, -1).join("/");
				container.createSpan({
					cls: "notor-suggest-path",
					text: folderPath + "/",
				});
			}

			// Filename (with highlights for name matches)
			const nameEl = container.createSpan({ cls: "notor-suggest-name" });
			if (suggestion.matchSource === "name" && suggestion.match?.match.matches) {
				renderMatches(nameEl, suggestion.display, suggestion.match.match.matches);
			} else {
				nameEl.textContent = suggestion.display;
			}

			// Alias match: show the matched alias with highlights
			if (suggestion.matchSource === "alias" && suggestion.matchedAlias && suggestion.match?.match.matches) {
				const aliasEl = container.createSpan({ cls: "notor-suggest-alias" });
				aliasEl.createSpan({ cls: "notor-suggest-alias-label", text: "aka " });
				renderMatches(aliasEl, suggestion.matchedAlias, suggestion.match.match.matches);
			}
		}
	}

	selectSuggestion(suggestion: VaultNoteSuggestion): void {
		const existing = this.existingAttachments();

		// Check for duplicate
		if (isDuplicate(existing, { path: suggestion.file.path })) {
			new Notice("This note is already attached");
			// Leave the typed text intact — just dismiss the popover.
			this.deactivate();
			this.close();
			return;
		}

		// Create the attachment — route image files to image attachment
		const ext = "." + suggestion.file.extension.toLowerCase();
		const attachment = IMAGE_EXTENSIONS.has(ext)
			? createVaultImageAttachment(suggestion.file.path)
			: createVaultNoteAttachment(suggestion.file.path);

		// Insert inline token (replaces `[[query` text with a styled span)
		insertWikilinkToken(this.chatInputEl, attachment);

		// Notify chat-view to track the attachment (no chip needed — token is inline)
		this.onAttachmentAdded(attachment);

		this.deactivate();
		this.close();

		log.debug("Vault note attached", { path: suggestion.file.path });
	}

	/**
	 * Extract the query text after `[[` from the current input.
	 * Returns null if `[[` is no longer present (user deleted it).
	 */
	private extractQuery(inputStr: string): string | null {
		// Find the `[[` marker in the input
		const triggerIdx = inputStr.lastIndexOf("[[");
		if (triggerIdx === -1) {
			return null;
		}

		// Extract everything after `[[`
		return inputStr.slice(triggerIdx + 2);
	}
}

// ---------------------------------------------------------------------------
// Section header suggest (triggered after note selection + `#`)
// ---------------------------------------------------------------------------

/**
 * Section header autocomplete for a specific vault note.
 *
 * Triggered after the user selects a note and types `#` to narrow
 * to a specific section heading.
 */
export class SectionSuggest extends AbstractInputSuggest<SectionSuggestion> {
	private onAttachmentAdded: OnAttachmentAdded;
	private existingAttachments: () => Attachment[];
	private chatInputEl: HTMLDivElement;
	private targetFile: TFile;
	private isActive = false;

	constructor(
		app: App,
		inputEl: HTMLDivElement,
		targetFile: TFile,
		onAttachmentAdded: OnAttachmentAdded,
		existingAttachments: () => Attachment[]
	) {
		super(app, inputEl);
		this.chatInputEl = inputEl;
		this.targetFile = targetFile;
		this.onAttachmentAdded = onAttachmentAdded;
		this.existingAttachments = existingAttachments;
		this.limit = 30;
	}

	activate(): void {
		this.isActive = true;
	}

	deactivate(): void {
		this.isActive = false;
	}

	getSuggestions(inputStr: string): SectionSuggestion[] {
		if (!this.isActive) {
			return [];
		}

		const cache = this.app.metadataCache.getFileCache(this.targetFile);
		const headings = cache?.headings;
		if (!headings || headings.length === 0) {
			return [];
		}

		// Extract query after `#`
		const hashIdx = inputStr.lastIndexOf("#");
		const query = hashIdx !== -1 ? inputStr.slice(hashIdx + 1).trim() : "";

		const suggestions: SectionSuggestion[] = headings.map((h) => ({
			heading: h.heading,
			level: h.level,
			filePath: this.targetFile.path,
		}));

		if (!query) {
			return suggestions;
		}

		// Filter by fuzzy match
		const fuzzySearch = prepareFuzzySearch(query);
		return suggestions.filter((s) => fuzzySearch(s.heading) !== null);
	}

	renderSuggestion(suggestion: SectionSuggestion, el: HTMLElement): void {
		const prefix = "#".repeat(suggestion.level) + " ";
		el.createSpan({
			cls: "notor-suggest-section-level",
			text: prefix,
		});
		el.createSpan({
			cls: "notor-suggest-section-text",
			text: suggestion.heading,
		});
	}

	selectSuggestion(suggestion: SectionSuggestion): void {
		const existing = this.existingAttachments();

		// Check for duplicate
		if (
			isDuplicate(existing, {
				path: suggestion.filePath,
				section: suggestion.heading,
			})
		) {
			new Notice("This section is already attached");
			this.deactivate();
			return;
		}

		const attachment = createVaultNoteSectionAttachment(
			suggestion.filePath,
			suggestion.heading
		);

		// Insert inline token (replaces `[[query` text with a styled span)
		insertWikilinkToken(this.chatInputEl, attachment);

		// Notify chat-view to track the attachment (no chip needed — token is inline)
		this.onAttachmentAdded(attachment);

		this.deactivate();
		log.debug("Section attached", {
			path: suggestion.filePath,
			section: suggestion.heading,
		});
	}
}

// ---------------------------------------------------------------------------
// ATT-006: External file dialog
// ---------------------------------------------------------------------------

/**
 * Get the absolute filesystem path for a File object.
 *
 * Tries `webUtils.getPathForFile()` (Electron 28+, the current recommended API)
 * and falls back to the legacy `File.path` property for older Electron versions.
 */
function getAbsoluteFilePath(file: File): string | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- runtime require needed to access Electron's webUtils which has no static import path in Obsidian's plugin environment
		const { webUtils } = require("electron") as {
			webUtils?: { getPathForFile?: (f: File) => string };
		};
		if (webUtils?.getPathForFile) {
			return webUtils.getPathForFile(file) || undefined;
		}
	} catch {
		// electron not available — shouldn't happen on desktop
	}
	return (file as File & { path?: string }).path || undefined;
}

/**
 * Open the OS-native file dialog for selecting external files.
 *
 * Uses a hidden `<input type="file">` element with programmatic `.click()`
 * per R-2 findings. Reads absolute paths via `webUtils.getPathForFile()` (Electron 28+)
 * with fallback to the legacy `File.path` property.
 *
 * Desktop-only: gated behind `Platform.isDesktopApp`.
 *
 * @param onAttachmentAdded - Callback when a file is successfully attached.
 * @param existingAttachments - Current attachments for duplicate detection.
 * @param thresholdMb - File size threshold for confirmation dialog.
 */
/** Image file extensions for routing detection. */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

/**
 * Read an external binary (image) file, process it, and return base64 + metadata.
 *
 * Returns null if the file exceeds the size limit, cannot be read, or is not
 * a supported image format.
 */
async function readExternalBinaryFile(
	absolutePath: string,
	settings: NotorSettings,
	maxSizeMb = 50,
): Promise<{ base64: string; mediaType: string; width?: number; height?: number } | null> {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const fs = require("fs") as typeof import("fs");

	const stats = fs.statSync(absolutePath);
	if (stats.size > maxSizeMb * 1024 * 1024) {
		return null;
	}

	const buffer = Buffer.from(fs.readFileSync(absolutePath));
	const format = detectMediaFormat(buffer);
	if (!format || format === "pdf" || !["png", "jpeg", "gif", "webp"].includes(format)) {
		return null;
	}

	const mediaType = `image/${format}` as ImageMediaType;
	const block = await processImage(buffer, mediaType, {
		maxDimension: settings.image_max_dimension,
		compressionQuality: settings.image_compression_quality,
	});

	if (block.type !== "image") return null;

	return {
		base64: block.data,
		mediaType: block.media_type,
		width: block.width,
		height: block.height,
	};
}

export function openExternalFileDialog(
	app: App,
	onAttachmentAdded: OnAttachmentAdded,
	existingAttachments: () => Attachment[],
	thresholdMb: number,
	settings?: NotorSettings,
): void {
	if (!Platform.isDesktopApp) {
		new Notice("External file attachment is only available on desktop");
		return;
	}

	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	// Common text + image extensions as a convenience hint (not a security boundary)
	input.accept =
		".md,.txt,.json,.csv,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.sh,.bash,.zsh,.r,.sql,.env,.cfg,.ini,.conf,.log,.diff,.patch,.rst,.tex,.bib,.properties,.gradle,.pom,.sbt,.png,.jpg,.jpeg,.gif,.webp";

	input.addEventListener("change", () => {
		const files = Array.from(input.files ?? []);
		const existing = existingAttachments();

		type PendingFile = { absolutePath: string; name: string; content: string; fileSizeBytes: number };
		const pendingConfirmation: PendingFile[] = [];

		// Collect image files for async processing
		const imageFiles: Array<{ absolutePath: string; name: string }> = [];

		for (const file of files) {
			const absolutePath = getAbsoluteFilePath(file);
			if (!absolutePath) {
				new Notice(`Cannot read file path for: ${file.name}`);
				continue;
			}

			// Check for duplicate
			if (isDuplicate(existing, { path: absolutePath })) {
				new Notice(`Already attached: ${file.name}`);
				continue;
			}

			// Route image files to binary processing path
			const ext = "." + file.name.split(".").pop()?.toLowerCase();
			if (IMAGE_EXTENSIONS.has(ext)) {
				imageFiles.push({ absolutePath, name: file.name });
				continue;
			}

			// Read and validate text file
			const result = readExternalFile(absolutePath, file.name, thresholdMb);

			if (!result.success) {
				new Notice(result.error ?? "Failed to read file");
				continue;
			}

			if (result.needsConfirmation) {
				pendingConfirmation.push({
					absolutePath,
					name: file.name,
					content: result.content!,
					fileSizeBytes: result.fileSizeBytes ?? 0,
				});
				continue;
			}

			const attachment = createExternalFileAttachment(
				absolutePath,
				file.name,
				result.content!
			);
			onAttachmentAdded(attachment);

			log.debug("External file attached", { name: file.name });
		}

		// Process image files asynchronously
		if (imageFiles.length > 0 && settings) {
			void (async () => {
				for (const imgFile of imageFiles) {
					try {
						const result = await readExternalBinaryFile(imgFile.absolutePath, settings);
						if (!result) {
							new Notice(`Failed to process image: ${imgFile.name}`);
							continue;
						}
						const attachment = createExternalBinaryAttachment(
							imgFile.absolutePath,
							imgFile.name,
							result.base64,
							result.mediaType,
							result.width,
							result.height,
						);
						onAttachmentAdded(attachment);
						log.debug("External image attached", { name: imgFile.name });
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`Failed to process image ${imgFile.name}: ${msg}`);
					}
				}
			})();
		}

		// Chain modals for oversized files one at a time.
		// onDismiss (fires on both confirm and cancel) advances to the next file.
		// onConfirm attaches the file before advancing.
		const showNextConfirmation = (index: number): void => {
			const pending = pendingConfirmation[index];
			if (!pending) {
				// All files processed — clean up the input element
				input.remove();
				return;
			}

			const { absolutePath, name, content, fileSizeBytes } = pending;
			const sizeMb = fileSizeBytes / (1024 * 1024);

			new ConfirmModal(
				app,
				"Large file",
				`The file "${name}" is ${sizeMb.toFixed(1)} MB, which exceeds the ${thresholdMb} MB threshold. Attach anyway?`,
				() => {
					const attachment = createExternalFileAttachment(absolutePath, name, content);
					onAttachmentAdded(attachment);
					log.debug("External file attached", { name });
				},
				"Attach anyway",
				false,
				() => showNextConfirmation(index + 1)
			).open();
		};

		if (pendingConfirmation.length > 0) {
			// Chain starts here; input.remove() is deferred to end of chain
			showNextConfirmation(0);
		} else {
			// No oversized files — clean up immediately
			input.remove();
		}
	});

	// Trigger the OS file dialog
	input.click();
}

// ---------------------------------------------------------------------------
// Attachment button + menu
// ---------------------------------------------------------------------------

/**
 * Create the attachment button and menu for the chat input area.
 *
 * The button opens a dropdown menu with:
 * - "Attach vault note" → opens vault file picker
 * - "Attach external file" → opens OS file dialog (desktop only)
 *
 * @param containerEl - Parent element to append the button to.
 * @param app - The Obsidian App instance.
 * @param inputEl - The chat input contenteditable div (for suggest attachment).
 * @param onAttachmentAdded - Callback when an attachment is added.
 * @param existingAttachments - Getter for current attachments.
 * @param thresholdMb - File size threshold for external files.
 * @returns The button element.
 */
export function createAttachmentButton(
	containerEl: HTMLElement,
	app: App,
	inputEl: HTMLDivElement,
	onAttachmentAdded: OnAttachmentAdded,
	existingAttachments: () => Attachment[],
	thresholdMb: number,
	settings?: NotorSettings,
): HTMLButtonElement {
	const btn = containerEl.createEl("button", {
		cls: "notor-attach-btn clickable-icon",
		attr: { "aria-label": "Attach file" },
	});
	setIcon(btn, "paperclip");

	let menuEl: HTMLElement | null = null;

	btn.addEventListener("click", (e) => {
		e.stopPropagation();

		// Toggle menu
		if (menuEl) {
			menuEl.remove();
			menuEl = null;
			return;
		}

		menuEl = containerEl.createDiv({ cls: "notor-attach-menu" });

		// Vault note option
		const vaultOption = menuEl.createDiv({ cls: "notor-attach-menu-item" });
		vaultOption.textContent = "Attach vault note";
		vaultOption.addEventListener("click", () => {
			menuEl?.remove();
			menuEl = null;
			// Focus the input and insert `[[` to trigger the suggest
			inputEl.focus();
			const currentText = inputEl.textContent ?? "";
			inputEl.textContent = currentText + "[[";
			// Move cursor to end
			const range = document.createRange();
			const sel = window.getSelection();
			range.selectNodeContents(inputEl);
			range.collapse(false);
			sel?.removeAllRanges();
			sel?.addRange(range);
			// Trigger input event so the suggest picks it up
			inputEl.dispatchEvent(new Event("input", { bubbles: true }));
		});

		// External file option (desktop only)
		if (Platform.isDesktopApp) {
			const externalOption = menuEl.createDiv({ cls: "notor-attach-menu-item" });
			externalOption.textContent = "Attach external file";
			externalOption.addEventListener("click", () => {
				menuEl?.remove();
				menuEl = null;
				openExternalFileDialog(
					app,
					onAttachmentAdded,
					existingAttachments,
					thresholdMb,
					settings,
				);
			});
		}

		// Close menu on click outside
		const closeHandler = (evt: MouseEvent) => {
			if (menuEl && !menuEl.contains(evt.target as Node) && evt.target !== btn) {
				menuEl.remove();
				menuEl = null;
				document.removeEventListener("click", closeHandler);
			}
		};
		// Defer so the current click doesn't immediately close the menu
		setTimeout(() => document.addEventListener("click", closeHandler), 0);
	});

	return btn;
}