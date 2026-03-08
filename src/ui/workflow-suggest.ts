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
}

/**
 * Detect whether `/` at or near the end of `text` is a valid workflow
 * slash-command trigger position.
 *
 * Valid trigger positions:
 * 1. `/` is the first character (`index === 0`).
 * 2. `/` is immediately preceded by a newline (`text[index - 1] === "\n"`).
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
	const isAfterNewline = slashIdx > 0 && text[slashIdx - 1] === "\n";

	if (!isAtStart && !isAfterNewline) return null;

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
	}

	/** Deactivate and reset internal state. */
	deactivate(): void {
		this.isActive = false;
		this.triggerStartIndex = -1;
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
			return workflows.slice(0, this.limit).map((w) => ({
				workflow: w,
				score: null,
			}));
		}

		// Fuzzy match against display_name
		const fuzzySearch = prepareFuzzySearch(query);
		const results: WorkflowSuggestion[] = [];

		for (const workflow of workflows) {
			const result = fuzzySearch(workflow.display_name);
			if (result) {
				results.push({ workflow, score: result.score });
			}
		}

		results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
		return results.slice(0, this.limit);
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
	}

	/**
	 * Handle workflow selection:
	 * 1. Remove the `/query` text from the input.
	 * 2. Call the `onSelect` callback (adds a workflow chip).
	 * 3. Deactivate the suggest.
	 */
	selectSuggestion(suggestion: WorkflowSuggestion): void {
		this.cleanupTriggerText();
		this.onWorkflowSelect(suggestion.workflow);
		this.deactivate();
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
	 * Remove the `/query` prefix from the contenteditable input,
	 * preserving any text before the trigger character.
	 */
	private cleanupTriggerText(): void {
		const el = this.chatInputEl;
		const text = el.textContent ?? "";
		if (this.triggerStartIndex >= 0) {
			el.textContent = text.slice(0, this.triggerStartIndex);
		}
	}
}

// ---------------------------------------------------------------------------
// E-011: WorkflowChipManager — chip rendering
// ---------------------------------------------------------------------------

/**
 * Manages the single workflow chip rendered in the chat input chip container.
 *
 * At most **one** workflow chip is shown at a time. Selecting a new workflow
 * replaces the existing chip. The chip is rendered in the same
 * `notor-attachment-chips` container used by `AttachmentChipManager`.
 *
 * Visual design:
 * - Shares `.notor-attachment-chip` base class for layout consistency.
 * - Adds `.notor-workflow-chip` for the purple-tinted border/background
 *   (defined in `styles.css`).
 * - `📋` icon distinguishes it from note-attachment chips.
 *
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-011
 */
export class WorkflowChipManager {
	private readonly containerEl: HTMLElement;
	private readonly onRemove: () => void;
	private chipEl: HTMLElement | null = null;
	private currentWorkflow: Workflow | null = null;

	/**
	 * @param containerEl — The `notor-attachment-chips` container element.
	 * @param onRemove — Callback fired when the chip × button is clicked.
	 */
	constructor(containerEl: HTMLElement, onRemove: () => void) {
		this.containerEl = containerEl;
		this.onRemove = onRemove;
	}

	/**
	 * Render a workflow chip for `workflow`.
	 *
	 * Any existing workflow chip is replaced. The container is made
	 * visible if it was hidden.
	 */
	setChip(workflow: Workflow): void {
		// Replace any existing workflow chip
		this.removeChip();

		this.currentWorkflow = workflow;
		this.containerEl.removeClass("notor-hidden");

		const chipEl = this.containerEl.createDiv({
			cls: "notor-attachment-chip notor-workflow-chip",
			attr: { "data-workflow-path": workflow.file_path },
		});

		chipEl.createSpan({
			cls: "notor-attachment-chip-icon",
			text: "📋",
		});

		chipEl.createSpan({
			cls: "notor-attachment-chip-label",
			text: workflow.display_name,
		});

		const removeBtn = chipEl.createSpan({
			cls: "notor-attachment-chip-remove",
			attr: { "aria-label": `Remove workflow ${workflow.display_name}` },
		});
		removeBtn.textContent = "×";
		removeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.removeChip();
			this.onRemove();
		});

		this.chipEl = chipEl;

		log.debug("Workflow chip added", { display_name: workflow.display_name });
	}

	/**
	 * Remove the current workflow chip from the DOM and reset internal state.
	 *
	 * Hides the container if no other chips (attachment chips) remain.
	 */
	removeChip(): void {
		if (this.chipEl) {
			this.chipEl.remove();
			this.chipEl = null;
		}
		this.currentWorkflow = null;

		// Hide the container only when entirely empty
		if (this.containerEl.childElementCount === 0) {
			this.containerEl.addClass("notor-hidden");
		}
	}

	/**
	 * Returns the currently attached workflow, or `null` if no chip is shown.
	 */
	getSelectedWorkflow(): Workflow | null {
		return this.currentWorkflow;
	}

	/**
	 * Remove the chip and reset state — called after the message is sent.
	 */
	clear(): void {
		this.removeChip();
	}
}
