/**
 * R-4 Research: Slash-command autocomplete in custom ItemView
 *
 * This file is a reference implementation demonstrating how to implement
 * a `/`-triggered workflow autocomplete in Notor's contenteditable chat
 * input using Obsidian's `AbstractInputSuggest<T>`.
 *
 * NOTE: This is a research artifact — not production code. It documents
 * the recommended approach with inline commentary explaining design
 * decisions and tradeoffs discovered during R-4 research.
 *
 * Key findings:
 * - The chat input is already a `<div contenteditable="true">` (changed
 *   from `<textarea>` in Phase 2 to support `AbstractInputSuggest`).
 * - `AbstractInputSuggest<T>` is the correct API for non-editor inline
 *   autocomplete. It's already used for `[[` vault note autocomplete
 *   on the same element (`VaultNoteSuggest` in attachment-picker.ts).
 * - `EditorSuggest<T>` requires a CodeMirror `Editor` instance and
 *   `TFile` context — NOT applicable to contenteditable divs.
 * - Multiple `AbstractInputSuggest` instances can coexist on the same
 *   input element; the `isActive` gating pattern prevents conflicts.
 * - Workflow chips should use the existing `AttachmentChipManager` pattern
 *   (external chip container above the text input), not inline DOM
 *   elements in the contenteditable (which uses plaintext-only mode).
 *
 * @see specs/03-workflows-personas/research.md — R-4
 * @see src/ui/attachment-picker.ts — existing VaultNoteSuggest pattern
 * @see src/ui/chat-view.ts — chat input element and chip container
 */

import {
	AbstractInputSuggest,
	type App,
	prepareFuzzySearch,
} from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Represents a discovered workflow for the autocomplete list. */
interface WorkflowSuggestion {
	/** Vault-relative path under {notor_dir}/workflows/ */
	path: string;
	/** Display name (derived from filename without extension). */
	name: string;
	/** Trigger type from frontmatter (for display context). */
	trigger: string;
	/** Fuzzy match score (null if no query yet). */
	score: number | null;
}

/** Callback when a workflow is selected from the autocomplete. */
type OnWorkflowSelected = (workflow: WorkflowSuggestion) => void;

/** Callback to get the list of discovered workflows. */
type GetWorkflows = () => WorkflowSuggestion[];

// ---------------------------------------------------------------------------
// WorkflowSlashSuggest — `/`-triggered autocomplete
// ---------------------------------------------------------------------------

/**
 * Workflow autocomplete using `AbstractInputSuggest<T>`.
 *
 * Attaches to the same contenteditable `<div>` as the chat input and
 * provides fuzzy matching against discovered workflow names when the
 * user types `/` at the start of the input or after a newline.
 *
 * ## How it coexists with VaultNoteSuggest
 *
 * Both `VaultNoteSuggest` and `WorkflowSlashSuggest` are attached to
 * the same contenteditable div. Obsidian's `AbstractInputSuggest`
 * calls `getSuggestions()` on every input change for all attached
 * instances. The `isActive` flag ensures only one suggest is active
 * at a time:
 *
 * - `VaultNoteSuggest` activates when `[[` is detected
 * - `WorkflowSlashSuggest` activates when `/` is at start or after `\n`
 * - When not active, `getSuggestions()` returns `[]` → popover stays closed
 * - The two triggers (`[[` vs `/`) are mutually exclusive by position
 *
 * ## Trigger detection
 *
 * The `/` trigger is detected in the `input` event handler on the
 * contenteditable div (same place where `[[` detection lives). The
 * handler calls `activate()` when the conditions are met, and the
 * suggest handles deactivation internally when the popover closes.
 *
 * ## Lifecycle
 *
 * Created once during `buildInputArea()` and reused for the lifetime
 * of the chat view. The workflow list is fetched fresh on each activation
 * via the `getWorkflows` callback.
 */
export class WorkflowSlashSuggest extends AbstractInputSuggest<WorkflowSuggestion> {
	private onWorkflowSelected: OnWorkflowSelected;
	private getWorkflows: GetWorkflows;
	private chatInputEl: HTMLDivElement;
	private isActive = false;
	private triggerStartIndex = -1;

	constructor(
		app: App,
		inputEl: HTMLDivElement,
		onWorkflowSelected: OnWorkflowSelected,
		getWorkflows: GetWorkflows
	) {
		super(app, inputEl);
		this.chatInputEl = inputEl;
		this.onWorkflowSelected = onWorkflowSelected;
		this.getWorkflows = getWorkflows;
		this.limit = 20;
	}

	/**
	 * Activate the suggest overlay after `/` is detected at a valid
	 * trigger position.
	 *
	 * @param triggerStartIndex — The character index of the `/` in the
	 *   input text. Used to extract the query (text after `/`).
	 */
	activate(triggerStartIndex: number): void {
		this.isActive = true;
		this.triggerStartIndex = triggerStartIndex;
	}

	/** Deactivate and reset. */
	deactivate(): void {
		this.isActive = false;
		this.triggerStartIndex = -1;
	}

	/**
	 * Called by AbstractInputSuggest on every input change.
	 *
	 * When not active, returns [] immediately (popover stays closed).
	 * When active, extracts the query after `/` and fuzzy-matches
	 * against discovered workflow names.
	 */
	getSuggestions(inputStr: string): WorkflowSuggestion[] {
		if (!this.isActive) {
			return [];
		}

		const query = this.extractQuery(inputStr);
		if (query === null) {
			// `/` no longer present — user deleted it
			this.deactivate();
			return [];
		}

		const workflows = this.getWorkflows();

		if (!query) {
			// No query yet — show all workflows (up to limit)
			return workflows.slice(0, this.limit).map((w) => ({
				...w,
				score: null,
			}));
		}

		// Fuzzy match against workflow names
		const fuzzySearch = prepareFuzzySearch(query);
		const results: WorkflowSuggestion[] = [];

		for (const workflow of workflows) {
			const result = fuzzySearch(workflow.name);
			if (result) {
				results.push({
					...workflow,
					score: result.score,
				});
			}
		}

		// Sort by match score (higher is better)
		results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

		return results.slice(0, this.limit);
	}

	/**
	 * Render a single suggestion item in the dropdown.
	 *
	 * Shows: 📋 icon + workflow name + trigger type badge
	 */
	renderSuggestion(suggestion: WorkflowSuggestion, el: HTMLElement): void {
		const container = el.createDiv({ cls: "notor-workflow-suggest-item" });

		// Workflow icon
		container.createSpan({
			cls: "notor-workflow-suggest-icon",
			text: "📋",
		});

		// Workflow name
		container.createSpan({
			cls: "notor-workflow-suggest-name",
			text: suggestion.name,
		});

		// Trigger type badge (subtle context)
		container.createSpan({
			cls: "notor-workflow-suggest-trigger",
			text: suggestion.trigger,
		});
	}

	/**
	 * Called when the user selects a workflow from the dropdown.
	 *
	 * 1. Cleans up the `/query` text from the input
	 * 2. Calls the onWorkflowSelected callback (which adds a chip)
	 * 3. Deactivates the suggest
	 */
	selectSuggestion(suggestion: WorkflowSuggestion): void {
		// Clean up the `/query` text from the input
		this.cleanupTriggerText();

		// Notify parent to add a workflow chip
		this.onWorkflowSelected(suggestion);

		this.deactivate();
	}

	/**
	 * Extract the query text after `/` from the current input.
	 *
	 * The query is the text between the trigger `/` and the cursor
	 * (end of input). Returns null if `/` is no longer at a valid
	 * trigger position.
	 */
	private extractQuery(inputStr: string): string | null {
		if (this.triggerStartIndex < 0 || this.triggerStartIndex >= inputStr.length) {
			return null;
		}

		// Verify the `/` is still at the expected position
		if (inputStr[this.triggerStartIndex] !== "/") {
			return null;
		}

		// Extract everything after `/`
		const query = inputStr.slice(this.triggerStartIndex + 1);

		// If the query contains a newline, the user moved past the trigger
		if (query.includes("\n")) {
			return null;
		}

		return query;
	}

	/**
	 * Remove the `/query` text from the contenteditable input.
	 *
	 * Preserves any text before the `/` trigger position.
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
// Trigger detection logic — to be added to chat-view.ts input handler
// ---------------------------------------------------------------------------

/**
 * Detect `/` trigger for workflow slash-command autocomplete.
 *
 * Rules for when `/` triggers autocomplete:
 * 1. `/` is the first character in the input (index 0)
 * 2. `/` is preceded by a newline character (`\n`)
 *
 * This prevents false triggers in the middle of words, URLs, file
 * paths, or other contexts where `/` appears naturally.
 *
 * Called from the `input` event handler on the contenteditable div,
 * alongside the existing `detectWikilinkTrigger()` call.
 *
 * @param text — Current text content of the input
 * @param workflowSuggest — The WorkflowSlashSuggest instance
 */
export function detectSlashTrigger(
	text: string,
	workflowSuggest: WorkflowSlashSuggest
): void {
	// Find the last `/` in the text
	const slashIdx = text.lastIndexOf("/");
	if (slashIdx === -1) return;

	// Check if `/` is at a valid trigger position
	const isAtStart = slashIdx === 0;
	const isAfterNewline = slashIdx > 0 && text[slashIdx - 1] === "\n";

	if (isAtStart || isAfterNewline) {
		// Check there's no space in the query (user typing a sentence, not a command)
		// Actually, workflow names can contain spaces, so we allow spaces in the query.
		// Instead, we deactivate if the query contains another `/` (indicates a path).
		const afterSlash = text.slice(slashIdx + 1);
		if (!afterSlash.includes("/")) {
			workflowSuggest.activate(slashIdx);
		}
	}
}

// ---------------------------------------------------------------------------
// Workflow chip management — extends existing AttachmentChipManager pattern
// ---------------------------------------------------------------------------

/**
 * Reference for how workflow chips integrate with the existing chip system.
 *
 * The recommended approach is to add workflow chips to the SAME chip
 * container (`notor-attachment-chips`) used by attachment chips. This
 * provides visual consistency and avoids duplicating the chip container
 * infrastructure.
 *
 * Key differences from attachment chips:
 * - At most ONE workflow chip at a time (vs. multiple attachment chips)
 * - Distinct visual style: `📋` icon, different background color
 * - Selecting a second workflow REPLACES the first (no accumulation)
 * - Chip stores workflow metadata (path, name) for prompt assembly
 */

/** Represents an attached workflow in the chat input. */
interface PendingWorkflow {
	/** Vault-relative path under {notor_dir}/workflows/ */
	path: string;
	/** Display name for the chip label. */
	name: string;
}

/**
 * Manages the workflow chip in the chat input area.
 *
 * Uses the same chip container as AttachmentChipManager but renders
 * with a distinct visual style. Enforces the "at most one workflow"
 * constraint by replacing any existing workflow chip on new selection.
 */
class WorkflowChipManager {
	private containerEl: HTMLElement;
	private onRemove: () => void;
	private chipEl: HTMLElement | null = null;

	constructor(containerEl: HTMLElement, onRemove: () => void) {
		this.containerEl = containerEl;
		this.onRemove = onRemove;
	}

	/**
	 * Set the workflow chip. Replaces any existing workflow chip.
	 */
	setChip(workflow: PendingWorkflow): void {
		// Remove existing workflow chip if any
		this.removeChip();

		this.containerEl.removeClass("notor-hidden");

		const chipEl = this.containerEl.createDiv({
			cls: "notor-attachment-chip notor-workflow-chip",
			attr: { "data-workflow-path": workflow.path },
		});

		// Workflow icon
		chipEl.createSpan({
			cls: "notor-attachment-chip-icon",
			text: "📋",
		});

		// Workflow name
		chipEl.createSpan({
			cls: "notor-attachment-chip-label",
			text: workflow.name,
		});

		// Remove button
		const removeBtn = chipEl.createSpan({
			cls: "notor-attachment-chip-remove",
			attr: { "aria-label": `Remove workflow ${workflow.name}` },
		});
		removeBtn.textContent = "×";
		removeBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			this.removeChip();
			this.onRemove();
		});

		this.chipEl = chipEl;
	}

	/**
	 * Remove the workflow chip.
	 */
	removeChip(): void {
		if (this.chipEl) {
			this.chipEl.remove();
			this.chipEl = null;
		}

		// Hide container if no chips remain (check for attachment chips too)
		if (this.containerEl.childElementCount === 0) {
			this.containerEl.addClass("notor-hidden");
		}
	}

	/**
	 * Clear the workflow chip (called after message is sent).
	 */
	clear(): void {
		this.removeChip();
	}

	/**
	 * Whether a workflow chip is currently displayed.
	 */
	hasChip(): boolean {
		return this.chipEl !== null;
	}
}

// ---------------------------------------------------------------------------
// Integration sketch — how it fits into chat-view.ts
// ---------------------------------------------------------------------------

/**
 * INTEGRATION NOTES (for implementation phase):
 *
 * 1. In `buildInputArea()`, after creating `VaultNoteSuggest`:
 *    ```ts
 *    this.workflowSlashSuggest = new WorkflowSlashSuggest(
 *      this.app,
 *      this.textInputEl,
 *      (workflow) => this.attachWorkflow(workflow),
 *      () => this.getDiscoveredWorkflows()
 *    );
 *
 *    this.workflowChipManager = new WorkflowChipManager(
 *      this.attachmentChipContainerEl,
 *      () => this.removeWorkflow()
 *    );
 *    ```
 *
 * 2. In the `input` event handler, add slash trigger detection:
 *    ```ts
 *    this.textInputEl.addEventListener("input", () => {
 *      // ... existing auto-resize ...
 *      this.detectWikilinkTrigger();   // existing
 *      this.detectSlashTrigger();      // NEW
 *    });
 *    ```
 *
 * 3. New methods on NotorChatView:
 *    ```ts
 *    private detectSlashTrigger(): void {
 *      const text = this.textInputEl.textContent ?? "";
 *      detectSlashTrigger(text, this.workflowSlashSuggest);
 *    }
 *
 *    private attachWorkflow(workflow: WorkflowSuggestion): void {
 *      this.pendingWorkflow = { path: workflow.path, name: workflow.name };
 *      this.workflowChipManager.setChip(this.pendingWorkflow);
 *    }
 *
 *    private removeWorkflow(): void {
 *      this.pendingWorkflow = null;
 *    }
 *    ```
 *
 * 4. In `handleSend()`, include the pending workflow:
 *    ```ts
 *    const workflow = this.pendingWorkflow;
 *    this.pendingWorkflow = null;
 *    this.workflowChipManager.clear();
 *    // ... pass workflow to onSendMessage callback ...
 *    ```
 *
 * 5. Backspace handling — dismiss chip when user backspaces into it:
 *    ```ts
 *    this.textInputEl.addEventListener("keydown", (e) => {
 *      if (e.key === "Backspace" && !this.textInputEl.textContent?.trim()) {
 *        if (this.workflowChipManager.hasChip()) {
 *          this.removeWorkflow();
 *          this.workflowChipManager.clear();
 *        }
 *      }
 *    });
 *    ```
 *
 * 6. CSS for workflow-specific chip styling:
 *    ```css
 *    .notor-workflow-chip {
 *      border-color: var(--color-purple);
 *      background: rgba(var(--color-purple-rgb, 147, 51, 234), 0.08);
 *    }
 *    ```
 */
