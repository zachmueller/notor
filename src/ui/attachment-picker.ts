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
	type TFile,
	Platform,
	Notice,
	prepareFuzzySearch,
} from "obsidian";
import type { Attachment } from "../context/attachment";
import {
	createVaultNoteAttachment,
	createVaultNoteSectionAttachment,
	createExternalFileAttachment,
	readExternalFile,
	isDuplicate,
} from "../context/attachment";
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
	}

	/** Deactivate and reset. */
	deactivate(): void {
		this.isActive = false;
		this.triggerStartIndex = -1;
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

		const files = this.app.vault.getMarkdownFiles();

		if (!query) {
			// No query yet — show all files (up to limit)
			return files.slice(0, this.limit).map((file) => ({
				file,
				display: file.basename,
				match: null,
			}));
		}

		// Fuzzy match against filenames
		const fuzzySearch = prepareFuzzySearch(query);
		const results: VaultNoteSuggestion[] = [];

		for (const file of files) {
			const result = fuzzySearch(file.basename);
			if (result) {
				results.push({
					file,
					display: file.basename,
					match: { item: file, match: result },
				});
			}
		}

		// Sort by match score (higher is better)
		results.sort((a, b) => {
			const scoreA = a.match?.match.score ?? 0;
			const scoreB = b.match?.match.score ?? 0;
			return scoreB - scoreA;
		});

		return results.slice(0, this.limit);
	}

	renderSuggestion(suggestion: VaultNoteSuggestion, el: HTMLElement): void {
		const container = el.createDiv({ cls: "notor-suggest-item" });

		// Show file path in a subtle way
		const pathParts = suggestion.file.path.split("/");
		if (pathParts.length > 1) {
			const folderPath = pathParts.slice(0, -1).join("/");
			container.createSpan({
				cls: "notor-suggest-path",
				text: folderPath + "/",
			});
		}

		// Filename with match highlighting
		const nameEl = container.createSpan({ cls: "notor-suggest-name" });
		if (suggestion.match?.match.matches) {
			// Render with fuzzy match highlights
			const text = suggestion.display;
			const matches = suggestion.match.match.matches;
			let lastIndex = 0;

			for (const [start, end] of matches) {
				if (start > lastIndex) {
					nameEl.appendText(text.slice(lastIndex, start));
				}
				nameEl.createSpan({
					cls: "notor-suggest-highlight",
					text: text.slice(start, end),
				});
				lastIndex = end;
			}

			if (lastIndex < text.length) {
				nameEl.appendText(text.slice(lastIndex));
			}
		} else {
			nameEl.textContent = suggestion.display;
		}
	}

	selectSuggestion(suggestion: VaultNoteSuggestion): void {
		const existing = this.existingAttachments();

		// Check for duplicate
		if (isDuplicate(existing, { path: suggestion.file.path })) {
			new Notice("This note is already attached");
			this.cleanupTriggerText();
			this.deactivate();
			return;
		}

		// Create the attachment
		const attachment = createVaultNoteAttachment(suggestion.file.path);
		this.onAttachmentAdded(attachment);

		// Clean up the `[[query` text from the input
		this.cleanupTriggerText();
		this.deactivate();

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

	/** Remove the `[[query` text from the contenteditable input. */
	private cleanupTriggerText(): void {
		const el = this.chatInputEl;
		const text = el.textContent ?? "";
		const triggerIdx = text.lastIndexOf("[[");
		if (triggerIdx !== -1) {
			el.textContent = text.slice(0, triggerIdx);
		}
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
		this.onAttachmentAdded(attachment);

		// Clean up input text
		const el = this.chatInputEl;
		const text = el.textContent ?? "";
		const triggerIdx = text.lastIndexOf("[[");
		if (triggerIdx !== -1) {
			el.textContent = text.slice(0, triggerIdx);
		}

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
 * Open the OS-native file dialog for selecting external files.
 *
 * Uses a hidden `<input type="file">` element with programmatic `.click()`
 * per R-2 findings. Reads absolute paths from Electron's `File.path` property.
 *
 * Desktop-only: gated behind `Platform.isDesktopApp`.
 *
 * @param onAttachmentAdded - Callback when a file is successfully attached.
 * @param existingAttachments - Current attachments for duplicate detection.
 * @param thresholdMb - File size threshold for confirmation dialog.
 */
export function openExternalFileDialog(
	onAttachmentAdded: OnAttachmentAdded,
	existingAttachments: () => Attachment[],
	thresholdMb: number
): void {
	if (!Platform.isDesktopApp) {
		new Notice("External file attachment is only available on desktop");
		return;
	}

	const input = document.createElement("input");
	input.type = "file";
	input.multiple = true;
	// Common text-like extensions as a convenience hint (not a security boundary)
	input.accept =
		".md,.txt,.json,.csv,.yaml,.yml,.toml,.xml,.html,.css,.js,.ts,.py,.sh,.bash,.zsh,.r,.sql,.env,.cfg,.ini,.conf,.log,.diff,.patch,.rst,.tex,.bib,.properties,.gradle,.pom,.sbt";

	input.addEventListener("change", () => {
		const files = Array.from(input.files ?? []);
		const existing = existingAttachments();

		for (const file of files) {
			// Electron-specific `File.path` for absolute path access
			const absolutePath = (file as File & { path?: string }).path;
			if (!absolutePath) {
				new Notice(`Cannot read file path for: ${file.name}`);
				continue;
			}

			// Check for duplicate
			if (isDuplicate(existing, { path: absolutePath })) {
				new Notice(`Already attached: ${file.name}`);
				continue;
			}

			// Read and validate the file
			const result = readExternalFile(absolutePath, file.name, thresholdMb);

			if (!result.success) {
				new Notice(result.error ?? "Failed to read file");
				continue;
			}

			if (result.needsConfirmation) {
				// Show confirmation dialog for large files
				const sizeMb = (result.fileSizeBytes ?? 0) / (1024 * 1024);
				const proceed = confirm(
					`The file "${file.name}" is ${sizeMb.toFixed(1)} MB, ` +
						`which exceeds the ${thresholdMb} MB threshold.\n\n` +
						`Attach anyway?`
				);
				if (!proceed) {
					continue;
				}
			}

			// Create the attachment
			const attachment = createExternalFileAttachment(
				absolutePath,
				file.name,
				result.content!
			);
			onAttachmentAdded(attachment);

			log.debug("External file attached", { name: file.name });
		}

		// Clean up the input element
		input.remove();
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
	thresholdMb: number
): HTMLButtonElement {
	const btn = containerEl.createEl("button", {
		cls: "notor-attach-btn clickable-icon",
		attr: { "aria-label": "Attach file" },
	});
	btn.innerHTML =
		'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>';

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
					onAttachmentAdded,
					existingAttachments,
					thresholdMb
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