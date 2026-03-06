/**
 * Diff engine — compute line-by-line diffs between before/after content.
 *
 * Used by the diff preview UI to show proposed changes from write tool
 * operations before they are applied. Supports both `write_note`
 * (full-file replacement) and `replace_in_note` (per-block diffs).
 *
 * @see specs/01-mvp/spec.md — FR-12 (diff preview and change approval)
 * @see specs/01-mvp/contracts/tool-schemas.md — diff preview flow
 * @see design/ux.md — diff preview and change approval
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The type of a single diff line. */
export type DiffLineType = "added" | "deleted" | "unchanged";

/** A single line in a diff. */
export interface DiffLine {
	/** Line type: added, deleted, or unchanged. */
	type: DiffLineType;
	/** The line content (without trailing newline). */
	content: string;
	/**
	 * Line number in the "before" file (1-based).
	 * Null for lines that only exist in the "after" file (added lines).
	 */
	beforeLineNumber: number | null;
	/**
	 * Line number in the "after" file (1-based).
	 * Null for lines that only exist in the "before" file (deleted lines).
	 */
	afterLineNumber: number | null;
}

/** A computed diff between two content strings. */
export interface FileDiff {
	/** The full "before" content. Empty string for new files. */
	beforeContent: string;
	/** The full "after" content. */
	afterContent: string;
	/** Ordered list of diff lines. */
	lines: DiffLine[];
	/** Whether any changes exist between before and after. */
	hasChanges: boolean;
	/** Count of added lines. */
	addedCount: number;
	/** Count of deleted lines. */
	deletedCount: number;
}

/**
 * A diff scoped to a single SEARCH/REPLACE block from `replace_in_note`.
 * Represents the change for one block only.
 */
export interface BlockDiff {
	/** 0-based index of the SEARCH/REPLACE block in the changes array. */
	blockIndex: number;
	/** The search text for this block. */
	searchText: string;
	/** The replacement text for this block. */
	replaceText: string;
	/** The diff between searchText and replaceText. */
	diff: FileDiff;
	/**
	 * Whether this block results in a deletion (empty replace text).
	 * Convenience flag for the UI.
	 */
	isDeletion: boolean;
}

/**
 * All diffs for a `replace_in_note` operation.
 * Contains per-block diffs and the combined full-file diff.
 */
export interface ReplaceNoteDiff {
	/** Path of the note being modified. */
	notePath: string;
	/** Per-block diffs for each SEARCH/REPLACE block. */
	blocks: BlockDiff[];
	/** The complete before/after diff if all blocks are applied. */
	combinedDiff: FileDiff;
}

/**
 * Diff result for a `write_note` operation.
 */
export interface WriteNoteDiff {
	/** Path of the note being written. */
	notePath: string;
	/** True if this is a new file (beforeContent is empty). */
	isNewFile: boolean;
	/** The full file diff. */
	diff: FileDiff;
}

// ---------------------------------------------------------------------------
// Core diff algorithm (Myers / patience-style LCS)
// ---------------------------------------------------------------------------

/**
 * Compute a line-level diff between two strings using the
 * Longest Common Subsequence (LCS) algorithm.
 *
 * This is a standard O(N·M) LCS implementation suitable for
 * typical note sizes. For very large files (10k+ lines) this
 * may be slow, but that is an acceptable tradeoff for the MVP.
 *
 * @param before - The original content (may be empty for new files).
 * @param after  - The proposed new content.
 * @returns A FileDiff describing the changes.
 */
export function computeDiff(before: string, after: string): FileDiff {
	const beforeLines = before === "" ? [] : before.split("\n");
	const afterLines = after === "" ? [] : after.split("\n");

	// Remove trailing empty line caused by trailing newline
	// (split("a\n") yields ["a", ""] — we handle this by treating
	// the content as-is so the diff accurately reflects line count)

	const lcs = computeLCS(beforeLines, afterLines);
	const diffLines = buildDiffLines(beforeLines, afterLines, lcs);

	let addedCount = 0;
	let deletedCount = 0;
	for (const line of diffLines) {
		if (line.type === "added") addedCount++;
		else if (line.type === "deleted") deletedCount++;
	}

	return {
		beforeContent: before,
		afterContent: after,
		lines: diffLines,
		hasChanges: addedCount > 0 || deletedCount > 0,
		addedCount,
		deletedCount,
	};
}

// ---------------------------------------------------------------------------
// Write-note diff
// ---------------------------------------------------------------------------

/**
 * Compute the diff for a `write_note` operation.
 *
 * @param notePath     - Vault-relative path of the note.
 * @param beforeContent - Current note content; pass empty string for new files.
 * @param afterContent  - Proposed new content.
 */
export function computeWriteNoteDiff(
	notePath: string,
	beforeContent: string,
	afterContent: string
): WriteNoteDiff {
	const isNewFile = beforeContent === "";
	const diff = computeDiff(beforeContent, afterContent);

	return {
		notePath,
		isNewFile,
		diff,
	};
}

// ---------------------------------------------------------------------------
// Replace-in-note diff
// ---------------------------------------------------------------------------

/** A single SEARCH/REPLACE block. */
export interface ChangeBlock {
	search: string;
	replace: string;
}

/**
 * Compute per-block diffs and a combined diff for a `replace_in_note`
 * operation.
 *
 * Each block is diffed independently (search vs. replace text) for the
 * per-change accept/reject UI. The combined diff shows the full note
 * before/after applying all blocks.
 *
 * @param notePath      - Vault-relative path of the note.
 * @param noteContent   - Current full note content.
 * @param changeBlocks  - The SEARCH/REPLACE blocks to apply.
 * @returns Per-block diffs and combined diff.
 */
export function computeReplaceInNoteDiff(
	notePath: string,
	noteContent: string,
	changeBlocks: ChangeBlock[]
): ReplaceNoteDiff {
	// Compute per-block diffs
	const blocks: BlockDiff[] = changeBlocks.map((block, index) => {
		const diff = computeDiff(block.search, block.replace);
		return {
			blockIndex: index,
			searchText: block.search,
			replaceText: block.replace,
			diff,
			isDeletion: block.replace === "",
		};
	});

	// Compute combined diff: apply all blocks in sequence to get the
	// full after-content, then diff the full note before/after.
	const afterContent = applyBlocks(noteContent, changeBlocks);
	const combinedDiff = computeDiff(noteContent, afterContent);

	return {
		notePath,
		blocks,
		combinedDiff,
	};
}

/**
 * Apply a subset of SEARCH/REPLACE blocks to note content.
 * Used to compute the after-content for a partial acceptance of changes.
 *
 * @param noteContent    - Original note content.
 * @param changeBlocks   - All blocks in the operation.
 * @param acceptedIndexes - Which block indexes to apply (all if omitted).
 * @returns Note content after applying accepted blocks.
 */
export function applyBlocks(
	noteContent: string,
	changeBlocks: ChangeBlock[],
	acceptedIndexes?: Set<number>
): string {
	let result = noteContent;

	for (let i = 0; i < changeBlocks.length; i++) {
		const block = changeBlocks[i];
		if (!block) continue;

		// Skip blocks not in the accepted set (if a set was provided)
		if (acceptedIndexes !== undefined && !acceptedIndexes.has(i)) {
			continue;
		}

		const idx = result.indexOf(block.search);
		if (idx === -1) {
			// Block no longer matches (can happen when earlier blocks shift text).
			// Skip silently — the caller is responsible for presenting warnings.
			continue;
		}

		result =
			result.slice(0, idx) + block.replace + result.slice(idx + block.search.length);
	}

	return result;
}

// ---------------------------------------------------------------------------
// LCS helpers
// ---------------------------------------------------------------------------

/**
 * Compute the Longest Common Subsequence between two string arrays.
 *
 * Returns an LCS table (2D number array) where `lcs[i][j]` is the length
 * of the LCS of `a[0..i-1]` and `b[0..j-1]`.
 */
function computeLCS(a: string[], b: string[]): number[][] {
	const m = a.length;
	const n = b.length;

	// Initialise a (m+1) × (n+1) table filled with zeros.
	// Using a flat array for performance.
	const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);

	const idx = (i: number, j: number) => i * (n + 1) + j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			if (a[i - 1] === b[j - 1]) {
				dp[idx(i, j)] = (dp[idx(i - 1, j - 1)] ?? 0) + 1;
			} else {
				dp[idx(i, j)] = Math.max(dp[idx(i - 1, j)] ?? 0, dp[idx(i, j - 1)] ?? 0);
			}
		}
	}

	// Convert flat array back to 2D for the backtracking step.
	const table: number[][] = [];
	for (let i = 0; i <= m; i++) {
		table.push(dp.slice(i * (n + 1), (i + 1) * (n + 1)));
	}
	return table;
}

/**
 * Safe accessor for the LCS table that returns 0 for out-of-bounds indices.
 */
function lcsGet(lcs: number[][], i: number, j: number): number {
	return lcs[i]?.[j] ?? 0;
}

/**
 * Backtrack through the LCS table to produce an ordered list of DiffLines.
 */
function buildDiffLines(
	before: string[],
	after: string[],
	lcs: number[][]
): DiffLine[] {
	let i = before.length;
	let j = after.length;
	let beforeLineNum = before.length;
	let afterLineNum = after.length;

	// We backtrack, so collect in reverse and reverse at the end.
	const reversed: DiffLine[] = [];

	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && before[i - 1] === after[j - 1]) {
			// Unchanged line
			reversed.push({
				type: "unchanged",
				content: before[i - 1] ?? "",
				beforeLineNumber: beforeLineNum,
				afterLineNumber: afterLineNum,
			});
			i--;
			j--;
			beforeLineNum--;
			afterLineNum--;
		} else if (j > 0 && (i === 0 || lcsGet(lcs, i, j - 1) >= lcsGet(lcs, i - 1, j))) {
			// Added line (exists in after but not before)
			reversed.push({
				type: "added",
				content: after[j - 1] ?? "",
				beforeLineNumber: null,
				afterLineNumber: afterLineNum,
			});
			j--;
			afterLineNum--;
		} else {
			// Deleted line (exists in before but not after)
			reversed.push({
				type: "deleted",
				content: before[i - 1] ?? "",
				beforeLineNumber: beforeLineNum,
				afterLineNumber: null,
			});
			i--;
			beforeLineNum--;
		}
	}

	reversed.reverse();
	return reversed;
}