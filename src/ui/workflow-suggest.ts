/**
 * Workflow slash-command autocomplete and chip management for the chat input.
 *
 * Provides two closely related components:
 *
 *   - `WorkflowSlashSuggest` — `AbstractInputSuggest<T>` subclass that
 *     activates when `/` is typed at the start of the input (or after
 *     a newline) and fuzzy-matches discovered workflow names.
 *
 *   - `WorkflowChipManager` — renders a workflow chip (pill) in the
 *     existing `notor-attachment-chips` container. Enforces "at most
 *     one workflow per message".
 *
 *   - `detectSlashTrigger` — utility function that determines whether
 *     the `/` character at a given position is a valid workflow trigger.
 *
 * Design decisions:
 * - Both components share the existing chip container
 *   (`notor-attachment-chips`) with attachment chips. No new DOM container
 *   is created — chips coexist in the same flex row.
 * - `isActive` gating prevents `WorkflowSlashSuggest` and
 *   `VaultNoteSuggest` from being active simultaneously (R-4 finding).
 * - The `getWorkflows` callback is called on every `getSuggestions()`
 *   invocation so the list reflects any discovery rescans.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-010, E-011
 * @see specs/03-workflows-personas/research/research-r4-slash-command-test.ts
 * @see src/ui/attachment-picker.ts — VaultNoteSuggest (same pattern)
 */

import {
	AbstractInputSuggest,
	type App,
	prepareFuzzySearch,
} from "obsidian";
import type { Workflow } from "../types";
import { logger } from "../utils/logger";

const log = logger("WorkflowSuggest");

// ---------------------------------------------------------------------------
// E-010: WorkflowSlashSuggest — autocomplete class
// ---------------------------------------------------------------------------

/**
 * A single entry in the workflow suggest dropdown.
 *
 * Wraps the full `Workflow` object alongside the raw fuzzy match score
 * so that `getSuggestions()` can sort by relevance.
 */
export interface WorkflowSuggestion {
	/** The discovered workflow. */
	workflow: Workflow;
	/** Fuzzy match score (null when no query text has been typed yet). */
	score: number | null;
	/** When the best match came from an alias rather than display_name, the matched alias. */
	matchedAlias?: string;
}

/**
 * Detect whether `/` at or near the end of `text` is a valid workflow
 * slash-command trigger position.
 *
 * Valid trigger positions:
 * 1. `/` is the first character (`index === 0`).
 * 2. `/` is immediately preceded by any whitespace character (space, tab, newline).
 *
 * False-positive prevention:
 * - A `/` in the middle of a word, URL, or file path is NOT a trigger.
 * - If the text after `/` contains another `/`, it is likely a path —
 *   returns `null` to prevent accidental activation.
 *
 * @param text — The full current text content of the chat input.
 * @returns The index of the trigger `/`, or `null` if no valid trigger.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-010
 */
export function detectSlashTrigger(text: string): number | null {
	const slashIdx = text.lastIndexOf("/");
	if (slashIdx === -1) return null;

	const isAtStart = slashIdx === 0;
	const isAfterWhitespace = slashIdx > 0 && /\s/.test(text[slashIdx - 1] ?? "");

	if (!isAtStart && !isAfterWhitespace) return null;

	// Guard: if the text after `/` contains another `/`, it looks like a
	// file path — don't trigger.
	const afterSlash = text.slice(slashIdx + 1);
	if (afterSlash.includes("/")) return null;

	return slashIdx;
}

/**
 * Workflow autocomplete using `AbstractInputSuggest<WorkflowSuggestion>`.
 *
 * Attaches to the chat input `<div contenteditable>` and provides
 * fuzzy matching against discovered workflow names when triggered.
 *
 * ## Activation lifecycle
 *
 * 1. The `input` event handler in `chat-view.ts` calls
 *    `detectSlashTrigger()` on every keystroke.
 * 2. When a valid trigger is found, the handler calls `activate(index)`.
 * 3. `AbstractInputSuggest` calls `getSuggestions()` — the implementation
 *    returns matching `WorkflowSuggestion[]` while `isActive` is true.
 * 4. When the user selects a suggestion, `selectSuggestion()` is called,
 *    which cleans up the input and fires the `onSelect` callback.
 * 5. Deactivation occurs automatically when the popover closes (via
 *    Escape, click outside, or `deactivate()`).
 *
 * ## Coexistence with VaultNoteSuggest
 *
 * Both suggests live on the same contenteditable element.
 * `AbstractInputSuggest` calls `getSuggestions()` on all attached
 * instances for every input event. When `isActive` is false, this
 * implementation returns `[]` immediately, keeping the popover closed.
 * The `VaultNoteSuggest` has its own `isActive` flag; callers must
 * check it before activating `WorkflowSlashSuggest`.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-010
 */
export class WorkflowSlashSuggest extends AbstractInputSuggest<WorkflowSuggestion> {
	private readonly chatInputEl: HTMLDivElement;
	private readonly onWorkflowSelect: (workflow: Workflow) => void;
	private readonly getWorkflows: () => Workflow[];
	private isActive = false;
	private triggerStartIndex = -1;
	private currentSuggestions: WorkflowSuggestion[] = [];

	constructor(
		app: App,
		inputEl: HTMLDivElement,
		onSelect: (workflow: Workflow) => void,
		getWorkflows: () => Workflow[]
	) {
		super(app, inputEl);
		this.chatInputEl = inputEl;
		this.onWorkflowSelect = onSelect;
		this.getWorkflows = getWorkflows;
		this.limit = 20;
	}

	/**
	 * Activate the suggest overlay after `/` is detected at a valid
	 * trigger position.
	 *
	 * @param triggerStartIndex — Index of the `/` character in the input
	 *   text. Used to extract the query (everything after `/`).
	 */
	activate(triggerStartIndex: number): void {
		this.isActive = true;
		this.triggerStartIndex = triggerStartIndex;
		log.debug("WorkflowSlashSuggest activated", { triggerStartIndex });
	}

	/** Deactivate and reset internal state. */
	deactivate(): void {
		this.isActive = false;
		this.triggerStartIndex = -1;
		this.currentSuggestions = [];
		log.debug("WorkflowSlashSuggest deactivated");
	}

	/** Whether the suggest overlay is currently active. */
	get active(): boolean {
		return this.isActive;
	}

	/**
	 * Select whatever the popover currently highlights — mirrors what pressing
	 * Enter does. Used for Tab-key selection.
	 *
	 * Obsidian's `AbstractInputSuggest` owns the real, visible highlight (moved by
	 * its own `scope` on ArrowUp/Down); there is no typed API to read it, so we
	 * drive Obsidian's internal controller directly (Mechanism C), falling back to
	 * reading the `.is-selected` DOM row (B), then the first item, so Tab is never
	 * worse than before. See ideas/Tab completion in suggester….md.
	 */
	selectHighlighted(evt?: KeyboardEvent): void {
		if (this.currentSuggestions.length === 0) return;

		// Mechanism C: the exact call Obsidian's own Enter handler makes. It routes
		// back through this class's selectSuggestion(value, evt) with the real
		// highlighted value, reusing the insert/deactivate/close logic below.
		const controller = this.suggestions;
		if (controller && typeof controller.useSelectedItem === "function") {
			controller.useSelectedItem(evt ?? {});
			return;
		}

		// Mechanism B: map the highlighted DOM row into our current list order.
		const domIdx = this.highlightedDomIndex();
		if (domIdx >= 0 && domIdx < this.currentSuggestions.length) {
			this.selectSuggestion(this.currentSuggestions[domIdx]!);
			return;
		}

		// Fallback: first item (never worse than the previous Tab behaviour).
		this.selectSuggestion(this.currentSuggestions[0]!);
	}

	/** Index of the `.is-selected` row within the popover we own, or -1. */
	private highlightedDomIndex(): number {
		for (const c of Array.from(activeDocument.querySelectorAll(".suggestion-container"))) {
			const items = Array.from(c.querySelectorAll(".suggestion-item"));
			if (items.length !== this.currentSuggestions.length) continue; // not our popover
			const idx = items.findIndex((el) => el.classList.contains("is-selected"));
			if (idx >= 0) return idx;
		}
		return -1;
	}

	/**
	 * Called by `AbstractInputSuggest` on every input change.
	 *
	 * Returns `[]` immediately when not active (keeps popover closed).
	 * When active, extracts the query after `/` and fuzzy-matches it
	 * against discovered workflow `display_name` values.
	 */
	getSuggestions(inputStr: string): WorkflowSuggestion[] {
		if (!this.isActive) return [];

		const query = this.extractQuery(inputStr);
		if (query === null) {
			// The `/` trigger character was deleted — deactivate.
			this.deactivate();
			return [];
		}

		const workflows = this.getWorkflows();

		if (!query) {
			// No query text yet — list all workflows up to the limit.
			this.currentSuggestions = workflows.slice(0, this.limit).map((w) => ({
				workflow: w,
				score: null,
			}));
			log.debug("WorkflowSlashSuggest suggestions updated (no query)", { count: this.currentSuggestions.length });
			return this.currentSuggestions;
		}

		// Fuzzy match against display_name and aliases, taking the best score
		const fuzzySearch = prepareFuzzySearch(query);
		const results: WorkflowSuggestion[] = [];

		for (const workflow of workflows) {
			let bestScore: number | null = null;
			let matchedAlias: string | undefined;

			const nameResult = fuzzySearch(workflow.display_name);
			if (nameResult) {
				bestScore = nameResult.score;
			}

			for (const alias of workflow.aliases) {
				const aliasResult = fuzzySearch(alias);
				if (aliasResult && (bestScore === null || aliasResult.score > bestScore)) {
					bestScore = aliasResult.score;
					matchedAlias = alias;
				}
			}

			if (bestScore !== null) {
				results.push({ workflow, score: bestScore, matchedAlias });
			}
		}

		results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
		this.currentSuggestions = results.slice(0, this.limit);
		log.debug("WorkflowSlashSuggest suggestions updated (query)", { query, count: this.currentSuggestions.length });
		return this.currentSuggestions;
	}

	/**
	 * Render a single suggestion row in the dropdown.
	 *
	 * Format: 📋 {display_name}
	 */
	renderSuggestion(suggestion: WorkflowSuggestion, el: HTMLElement): void {
		const container = el.createDiv({ cls: "notor-workflow-suggest-item" });

		container.createSpan({
			cls: "notor-workflow-suggest-icon",
			text: "📋",
		});

		container.createSpan({
			cls: "notor-workflow-suggest-name",
			text: suggestion.workflow.display_name,
		});

		if (suggestion.matchedAlias) {
			container.createSpan({
				cls: "notor-workflow-suggest-alias",
				text: `(${suggestion.matchedAlias})`,
			});
		}
	}

	/**
	 * Handle workflow selection:
	 * 1. Replace the `/query` text with an inline workflow token.
	 * 2. Call the `onSelect` callback (tracks the workflow in state).
	 * 3. Deactivate the suggest.
	 */
	selectSuggestion(suggestion: WorkflowSuggestion, _evt?: MouseEvent | KeyboardEvent): void {
		this.insertToken(suggestion.workflow);
		this.deactivate();
		this.onWorkflowSelect(suggestion.workflow);
		this.close();
		log.debug("Workflow selected from slash suggest", {
			display_name: suggestion.workflow.display_name,
		});
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	/**
	 * Extract the query text after the `/` trigger character.
	 *
	 * Returns `null` if the `/` is no longer at the expected position
	 * (user deleted it or changed context).
	 */
	private extractQuery(inputStr: string): string | null {
		if (this.triggerStartIndex < 0 || this.triggerStartIndex >= inputStr.length) {
			return null;
		}
		if (inputStr[this.triggerStartIndex] !== "/") {
			return null;
		}

		const query = inputStr.slice(this.triggerStartIndex + 1);

		// If the query wraps onto a new line, the user has moved past
		// the trigger context — deactivate.
		if (query.includes("\n")) return null;

		return query;
	}

	/**
	 * Replace the `/query` text in the contenteditable input with a styled
	 * inline workflow token span. The span has `contenteditable="false"` so
	 * the browser treats it as atomic: Backspace removes the whole token in
	 * one keystroke.
	 *
	 * Data attributes stored on the span allow the MutationObserver in
	 * chat-view.ts to reconstruct the workflow state if Undo restores the
	 * token after a Backspace deletion.
	 */
	private insertToken(workflow: Workflow): void {
		const el = this.chatInputEl;
		const triggerIdx = this.triggerStartIndex;
		if (triggerIdx < 0) return;

		// Walk text nodes to find which one contains triggerIdx and the offset
		// within that node (same algorithm as insertWikilinkToken).
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
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

		// Split at triggerIdx so splitNode starts with "/query..."
		const splitNode = targetTextNode.splitText(offsetInNode);

		// Remove splitNode and all following siblings (the "/query" text).
		let sibling: ChildNode | null = splitNode;
		while (sibling) {
			const next: ChildNode | null = sibling.nextSibling;
			sibling.parentNode?.removeChild(sibling);
			sibling = next;
		}

		// Insert the styled token span with data attributes for undo reconstruction.
		const tokenSpan = el.createSpan({
			cls: "notor-workflow-token",
			attr: {
				contenteditable: "false",
				"data-workflow-path": workflow.file_path,
				"data-workflow-name": workflow.display_name,
			},
			text: `/${workflow.display_name}`,
		});

		// Trailing space lets the cursor sit after the token.
		const spacer = document.createTextNode(" ");
		el.appendChild(spacer);

		// Move cursor to after the spacer.
		const range = document.createRange();
		range.setStart(spacer, 1);
		range.collapse(true);
		const sel = window.getSelection();
		sel?.removeAllRanges();
		sel?.addRange(range);

		// Silence the unused-variable lint (span is already in the DOM via createSpan).
		void tokenSpan;
	}
}

