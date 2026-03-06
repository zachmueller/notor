/**
 * Diff preview UI — renders diff previews for write tool operations.
 *
 * Handles both `write_note` (full-file before/after) and `replace_in_note`
 * (per-block accept/reject + combined view). Integrates with the diff engine
 * to produce structured diff data and render it inline in the chat thread.
 *
 * Behaviour per spec:
 * - Auto-approve ON  → changes applied immediately; collapsed diff shown for
 *   after-the-fact review.
 * - Auto-approve OFF → expanded diff with accept/reject controls shown;
 *   tool execution blocked until user decides.
 * - replace_in_note multi-block → per-change accept/reject + accept all /
 *   reject all bulk controls.
 * - Partial accept → only accepted changes applied; result reflects what was
 *   actually applied.
 *
 * @see specs/01-mvp/spec.md — FR-12
 * @see specs/01-mvp/contracts/tool-schemas.md — diff preview flow
 * @see design/ux.md — diff preview and change approval
 */

import {
	computeWriteNoteDiff,
	computeReplaceInNoteDiff,
	applyBlocks,
	type FileDiff,
	type DiffLine,
	type ChangeBlock,
} from "./diff-engine";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/**
 * Result returned after the user interacts with a diff preview.
 * Tells the caller what content to actually write, or signals rejection.
 */
export interface DiffDecision {
	/** Whether any changes were accepted (false means fully rejected). */
	accepted: boolean;
	/**
	 * The final content to write to the note.
	 * Undefined when accepted is false or no changes remain after partial reject.
	 */
	finalContent?: string;
	/**
	 * For replace_in_note: the subset of accepted block indexes (0-based).
	 * Undefined for write_note decisions.
	 */
	acceptedBlockIndexes?: Set<number>;
}

// ---------------------------------------------------------------------------
// write_note diff preview
// ---------------------------------------------------------------------------

/**
 * Render a diff preview for a `write_note` operation and return a promise
 * that resolves with the user's decision.
 *
 * @param container     - Parent element (chat message list) to render into.
 * @param notePath      - Vault-relative path of the note.
 * @param beforeContent - Current note content; empty string for new files.
 * @param afterContent  - The content the AI wants to write.
 * @param autoApproved  - If true, apply immediately and show collapsed diff.
 * @returns Promise resolving with the user's decision.
 */
export function renderWriteNoteDiffPreview(
	container: HTMLElement,
	notePath: string,
	beforeContent: string,
	afterContent: string,
	autoApproved: boolean
): Promise<DiffDecision> {
	const diffResult = computeWriteNoteDiff(notePath, beforeContent, afterContent);

	return new Promise((resolve) => {
		// notor-diff-view alias allows E2E selectors and approval-UI detection
		// to find the diff container with a stable class name.
		const wrapperEl = container.createDiv({ cls: "notor-diff-preview notor-diff-view" });

		// Header
		const headerEl = wrapperEl.createDiv({ cls: "notor-diff-header" });
		const titleEl = headerEl.createDiv({ cls: "notor-diff-title" });
		titleEl.createSpan({ cls: "notor-diff-icon", text: diffResult.isNewFile ? "✦" : "✎" });
		titleEl.createSpan({
			cls: "notor-diff-path",
			text: notePath,
		});

		const statsEl = headerEl.createDiv({ cls: "notor-diff-stats" });
		if (diffResult.diff.addedCount > 0) {
			statsEl.createSpan({
				cls: "notor-diff-stat-added",
				text: `+${diffResult.diff.addedCount}`,
			});
		}
		if (diffResult.diff.deletedCount > 0) {
			statsEl.createSpan({
				cls: "notor-diff-stat-deleted",
				text: `-${diffResult.diff.deletedCount}`,
			});
		}

		// Collapsible diff body
		const bodyEl = wrapperEl.createDiv({ cls: "notor-diff-body" });

		if (autoApproved) {
			// Collapsed by default for auto-approved
			bodyEl.addClass("notor-hidden");

			const collapseToggle = headerEl.createDiv({ cls: "notor-diff-toggle" });
			collapseToggle.textContent = "▶ Show diff";
			collapseToggle.addEventListener("click", () => {
				const isHidden = bodyEl.hasClass("notor-hidden");
				bodyEl.toggleClass("notor-hidden", !isHidden);
				collapseToggle.textContent = isHidden ? "▼ Hide diff" : "▶ Show diff";
			});

			// Render the diff lines
			renderFileDiffLines(bodyEl, diffResult.diff);

			// Auto-approve: applied immediately, show status
			const statusEl = wrapperEl.createDiv({ cls: "notor-diff-status notor-diff-status-applied" });
			statusEl.textContent = diffResult.isNewFile ? "✓ File created" : "✓ Changes applied";

			resolve({ accepted: true, finalContent: afterContent });
		} else {
			// Expanded for manual approval
			renderFileDiffLines(bodyEl, diffResult.diff);

			// Bulk action buttons
			const actionsEl = wrapperEl.createDiv({ cls: "notor-diff-actions" });

			// Include notor-approve-btn / notor-reject-btn aliases so E2E selectors
			// and the existing approval-UI detection code can find these buttons.
			const acceptBtn = actionsEl.createEl("button", {
				cls: "notor-diff-accept-btn notor-approve-btn",
				text: diffResult.isNewFile ? "Create file" : "Accept all",
			});

			const rejectBtn = actionsEl.createEl("button", {
				cls: "notor-diff-reject-btn notor-reject-btn",
				text: "Reject",
			});

			// Scroll the action buttons into view so Playwright can click them.
			requestAnimationFrame(() => {
				actionsEl.scrollIntoView({ behavior: "instant", block: "nearest" });
			});

			acceptBtn.addEventListener("click", () => {
				actionsEl.remove();
				renderAppliedStatus(wrapperEl, diffResult.isNewFile ? "✓ File created" : "✓ Changes accepted");
				resolve({ accepted: true, finalContent: afterContent });
			});

			rejectBtn.addEventListener("click", () => {
				actionsEl.remove();
				renderAppliedStatus(wrapperEl, "✗ Changes rejected", true);
				resolve({ accepted: false });
			});
		}
	});
}

// ---------------------------------------------------------------------------
// replace_in_note diff preview
// ---------------------------------------------------------------------------

/**
 * Render a diff preview for a `replace_in_note` operation and return a
 * promise that resolves with the user's decision (including which blocks
 * were accepted).
 *
 * @param container    - Parent element (chat message list) to render into.
 * @param notePath     - Vault-relative path of the note.
 * @param noteContent  - Current full note content.
 * @param changeBlocks - The SEARCH/REPLACE blocks to apply.
 * @param autoApproved - If true, apply immediately and show collapsed diff.
 * @returns Promise resolving with the user's decision.
 */
export function renderReplaceInNoteDiffPreview(
	container: HTMLElement,
	notePath: string,
	noteContent: string,
	changeBlocks: ChangeBlock[],
	autoApproved: boolean
): Promise<DiffDecision> {
	const diffResult = computeReplaceInNoteDiff(notePath, noteContent, changeBlocks);

	return new Promise((resolve) => {
		// notor-diff-view alias allows E2E selectors and approval-UI detection
		// to find the diff container with a stable class name.
		const wrapperEl = container.createDiv({ cls: "notor-diff-preview notor-diff-view" });

		// Header
		const headerEl = wrapperEl.createDiv({ cls: "notor-diff-header" });
		const titleEl = headerEl.createDiv({ cls: "notor-diff-title" });
		titleEl.createSpan({ cls: "notor-diff-icon", text: "✎" });
		titleEl.createSpan({ cls: "notor-diff-path", text: notePath });

		const blockCountEl = titleEl.createSpan({ cls: "notor-diff-block-count" });
		blockCountEl.textContent = ` (${changeBlocks.length} change${changeBlocks.length > 1 ? "s" : ""})`;

		const statsEl = headerEl.createDiv({ cls: "notor-diff-stats" });
		if (diffResult.combinedDiff.addedCount > 0) {
			statsEl.createSpan({
				cls: "notor-diff-stat-added",
				text: `+${diffResult.combinedDiff.addedCount}`,
			});
		}
		if (diffResult.combinedDiff.deletedCount > 0) {
			statsEl.createSpan({
				cls: "notor-diff-stat-deleted",
				text: `-${diffResult.combinedDiff.deletedCount}`,
			});
		}

		if (autoApproved) {
			// Auto-approved: collapsed combined diff, no controls
			const collapseToggle = headerEl.createDiv({ cls: "notor-diff-toggle" });
			collapseToggle.textContent = "▶ Show diff";

			const bodyEl = wrapperEl.createDiv({ cls: "notor-diff-body notor-hidden" });
			renderFileDiffLines(bodyEl, diffResult.combinedDiff);

			collapseToggle.addEventListener("click", () => {
				const isHidden = bodyEl.hasClass("notor-hidden");
				bodyEl.toggleClass("notor-hidden", !isHidden);
				collapseToggle.textContent = isHidden ? "▼ Hide diff" : "▶ Show diff";
			});

			const statusEl = wrapperEl.createDiv({ cls: "notor-diff-status notor-diff-status-applied" });
			statusEl.textContent = `✓ ${changeBlocks.length} replacement${changeBlocks.length > 1 ? "s" : ""} applied`;

			const acceptedAll = new Set(changeBlocks.map((_, i) => i));
			const finalContent = applyBlocks(noteContent, changeBlocks);
			resolve({ accepted: true, finalContent, acceptedBlockIndexes: acceptedAll });
			return;
		}

		// Manual approval: per-block controls
		const blocksContainerEl = wrapperEl.createDiv({ cls: "notor-diff-blocks" });

		// Track acceptance state per block (default: all accepted)
		const blockAccepted = new Map<number, boolean>();
		for (let i = 0; i < diffResult.blocks.length; i++) {
			blockAccepted.set(i, true);
		}

		// Render each block with its own accept/reject toggle
		for (const blockDiff of diffResult.blocks) {
			const blockEl = blocksContainerEl.createDiv({ cls: "notor-diff-block" });

			const blockHeaderEl = blockEl.createDiv({ cls: "notor-diff-block-header" });
			const blockLabel = blockHeaderEl.createSpan({ cls: "notor-diff-block-label" });
			blockLabel.textContent = `Change ${blockDiff.blockIndex + 1}`;

			if (blockDiff.isDeletion) {
				blockHeaderEl.createSpan({ cls: "notor-diff-block-badge notor-diff-badge-delete", text: "delete" });
			}

			// Per-block accept/reject toggle button
			const blockToggleBtn = blockHeaderEl.createEl("button", {
				cls: "notor-diff-block-toggle notor-diff-block-accepted",
				text: "✓ Accept",
			});

			// Block diff lines
			const blockBodyEl = blockEl.createDiv({ cls: "notor-diff-block-body" });
			renderFileDiffLines(blockBodyEl, blockDiff.diff);

			// Wire up toggle
			blockToggleBtn.addEventListener("click", () => {
				const currentlyAccepted = blockAccepted.get(blockDiff.blockIndex) ?? true;
				const newState = !currentlyAccepted;
				blockAccepted.set(blockDiff.blockIndex, newState);

				blockToggleBtn.textContent = newState ? "✓ Accept" : "✗ Reject";
				blockToggleBtn.removeClass("notor-diff-block-accepted", "notor-diff-block-rejected");
				blockToggleBtn.addClass(newState ? "notor-diff-block-accepted" : "notor-diff-block-rejected");

				blockEl.toggleClass("notor-diff-block--rejected", !newState);
			});
		}

		// Bulk action buttons
		const actionsEl = wrapperEl.createDiv({ cls: "notor-diff-actions" });

		// Include notor-approve-btn / notor-reject-btn aliases so E2E selectors
		// can detect the approval UI via the stable class names.
		// "Accept all" immediately applies all blocks and resolves (no separate
		// Apply click needed), which also makes E2E automation straightforward.
		const acceptAllBtn = actionsEl.createEl("button", {
			cls: "notor-diff-accept-btn notor-approve-btn",
			text: "Accept all",
		});

		// "Reject all" immediately rejects all blocks and resolves.
		const rejectAllBtn = actionsEl.createEl("button", {
			cls: "notor-diff-reject-btn notor-reject-btn",
			text: "Reject all",
		});

		// "Apply" applies the current per-block state (used after toggling
		// individual blocks); only shown when there are multiple blocks.
		let applyBtn: HTMLButtonElement | null = null;
		if (diffResult.blocks.length > 1) {
			applyBtn = actionsEl.createEl("button", {
				cls: "notor-diff-apply-btn",
				text: "Apply",
			});
		}

		// Scroll the action buttons into view so Playwright can click them.
		requestAnimationFrame(() => {
			actionsEl.scrollIntoView({ behavior: "instant", block: "nearest" });
		});

		/** Resolve with the current blockAccepted state. */
		const resolveWithCurrentState = () => {
			actionsEl.remove();

			const acceptedIndexes = new Set<number>();
			for (const [idx, accepted] of blockAccepted) {
				if (accepted) acceptedIndexes.add(idx);
			}

			if (acceptedIndexes.size === 0) {
				renderAppliedStatus(wrapperEl, "✗ All changes rejected", true);
				resolve({ accepted: false, acceptedBlockIndexes: new Set() });
				return;
			}

			const finalContent = applyBlocks(noteContent, changeBlocks, acceptedIndexes);
			const appliedCount = acceptedIndexes.size;
			const rejectedCount = changeBlocks.length - appliedCount;

			let statusMsg = `✓ ${appliedCount} change${appliedCount > 1 ? "s" : ""} applied`;
			if (rejectedCount > 0) {
				statusMsg += `, ${rejectedCount} rejected`;
			}
			renderAppliedStatus(wrapperEl, statusMsg);
			resolve({ accepted: true, finalContent, acceptedBlockIndexes: acceptedIndexes });
		};

		// Accept all: mark all accepted then apply immediately.
		acceptAllBtn.addEventListener("click", () => {
			for (let i = 0; i < diffResult.blocks.length; i++) {
				blockAccepted.set(i, true);
			}
			updateAllBlockUI(blocksContainerEl, blockAccepted);
			resolveWithCurrentState();
		});

		// Reject all: mark all rejected then apply immediately.
		rejectAllBtn.addEventListener("click", () => {
			for (let i = 0; i < diffResult.blocks.length; i++) {
				blockAccepted.set(i, false);
			}
			updateAllBlockUI(blocksContainerEl, blockAccepted);
			resolveWithCurrentState();
		});

		// Apply: resolve with the current per-block acceptance state.
		applyBtn?.addEventListener("click", resolveWithCurrentState);
	});
}

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render the diff lines (added/deleted/unchanged) into a container element.
 * Only renders a context window of lines around changes for large diffs
 * to keep the UI manageable.
 */
function renderFileDiffLines(container: HTMLElement, diff: FileDiff): void {
	const CONTEXT_LINES = 3;
	const lines = diff.lines;

	if (lines.length === 0) {
		container.createDiv({ cls: "notor-diff-empty", text: "(empty)" });
		return;
	}

	// Determine which lines to show: only changed lines + CONTEXT_LINES around them.
	// For small diffs (≤ 30 lines total), show everything.
	const showAll = lines.length <= 30;
	const visibleSet = new Set<number>();

	if (!showAll) {
		for (let idx = 0; idx < lines.length; idx++) {
			const line = lines[idx];
			if (!line) continue;
			if (line.type !== "unchanged") {
				for (
					let ctx = Math.max(0, idx - CONTEXT_LINES);
					ctx <= Math.min(lines.length - 1, idx + CONTEXT_LINES);
					ctx++
				) {
					visibleSet.add(ctx);
				}
			}
		}
	}

	const tableEl = container.createEl("table", { cls: "notor-diff-table" });
	const tbody = tableEl.createEl("tbody");

	let lastShownIdx = -1;

	for (let idx = 0; idx < lines.length; idx++) {
		const line = lines[idx];
		if (!line) continue;

		if (!showAll && !visibleSet.has(idx)) continue;

		// Insert a "..." separator when lines are skipped
		if (!showAll && lastShownIdx !== -1 && idx > lastShownIdx + 1) {
			const sepRow = tbody.createEl("tr", { cls: "notor-diff-separator-row" });
			sepRow.createEl("td", { cls: "notor-diff-line-num", text: "…" });
			sepRow.createEl("td", { cls: "notor-diff-line-num", text: "…" });
			sepRow.createEl("td", { cls: "notor-diff-line-content", text: "…" });
		}
		lastShownIdx = idx;

		renderDiffLine(tbody, line);
	}
}

/**
 * Render a single diff line as a table row.
 */
function renderDiffLine(tbody: HTMLElement, line: DiffLine): void {
	// Build class list — include both the verbose `notor-diff-line-{type}` names
	// and the short aliases (`notor-diff-add`, `notor-diff-del`) so that E2E
	// selectors and CSS rules can target either form.
	const typeAlias =
		line.type === "added" ? "notor-diff-add" :
		line.type === "deleted" ? "notor-diff-del" : "";
	const rowCls = [
		"notor-diff-line",
		`notor-diff-line-${line.type}`,
		...(typeAlias ? [typeAlias] : []),
	].join(" ");
	const rowEl = tbody.createEl("tr", { cls: rowCls });

	// Before line number
	const beforeNumEl = rowEl.createEl("td", { cls: "notor-diff-line-num notor-diff-line-num-before" });
	beforeNumEl.textContent = line.beforeLineNumber !== null ? String(line.beforeLineNumber) : "";

	// After line number
	const afterNumEl = rowEl.createEl("td", { cls: "notor-diff-line-num notor-diff-line-num-after" });
	afterNumEl.textContent = line.afterLineNumber !== null ? String(line.afterLineNumber) : "";

	// Gutter marker (+/-/ )
	const gutterEl = rowEl.createEl("td", { cls: "notor-diff-line-gutter" });
	gutterEl.textContent = line.type === "added" ? "+" : line.type === "deleted" ? "-" : " ";

	// Content
	const contentEl = rowEl.createEl("td", { cls: "notor-diff-line-content" });
	// Use a <code> element to preserve whitespace
	const codeEl = contentEl.createEl("code");
	codeEl.textContent = line.content;
}

/**
 * Update the per-block accept/reject UI after a bulk accept-all or reject-all.
 */
function updateAllBlockUI(
	blocksContainerEl: HTMLElement,
	blockAccepted: Map<number, boolean>
): void {
	const blockEls = blocksContainerEl.querySelectorAll(".notor-diff-block");
	blockEls.forEach((blockEl, idx) => {
		const accepted = blockAccepted.get(idx) ?? true;
		const toggleBtn = blockEl.querySelector(".notor-diff-block-toggle") as HTMLButtonElement | null;
		if (toggleBtn) {
			toggleBtn.textContent = accepted ? "✓ Accept" : "✗ Reject";
			toggleBtn.removeClass("notor-diff-block-accepted", "notor-diff-block-rejected");
			toggleBtn.addClass(accepted ? "notor-diff-block-accepted" : "notor-diff-block-rejected");
		}
		(blockEl as HTMLElement).toggleClass("notor-diff-block--rejected", !accepted);
	});
}

/**
 * Render a final status line below the diff (applied / rejected).
 */
function renderAppliedStatus(
	wrapperEl: HTMLElement,
	message: string,
	isRejected = false
): void {
	const statusEl = wrapperEl.createDiv({
		cls: `notor-diff-status ${isRejected ? "notor-diff-status-rejected" : "notor-diff-status-applied"}`,
	});
	statusEl.textContent = message;
}