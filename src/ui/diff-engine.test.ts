import { describe, it, expect } from "vitest";
import { applyBlocks, computeReplaceInNoteDiff, type ChangeBlock } from "./diff-engine";

describe("applyBlocks", () => {
	it("applies a single edit", () => {
		const out = applyBlocks("alpha beta gamma", [{ old_text: "beta", new_text: "BETA" }]);
		expect(out).toBe("alpha BETA gamma");
	});

	it("applies multiple edits in sequence (later edits see earlier ones)", () => {
		const blocks: ChangeBlock[] = [
			{ old_text: "one", new_text: "two" },
			{ old_text: "two three", new_text: "DONE" },
		];
		expect(applyBlocks("one three", blocks)).toBe("DONE");
	});

	it("respects the acceptedIndexes filter", () => {
		const blocks: ChangeBlock[] = [
			{ old_text: "a", new_text: "X" },
			{ old_text: "b", new_text: "Y" },
		];
		expect(applyBlocks("a b", blocks, new Set([1]))).toBe("a Y");
	});

	it("skips silently when an edit does not match (not_found)", () => {
		const blocks: ChangeBlock[] = [
			{ old_text: "present", new_text: "PRESENT" },
			{ old_text: "absent", new_text: "ABSENT" },
		];
		// First applies; second is a no-op rather than throwing.
		expect(applyBlocks("present text", blocks)).toBe("PRESENT text");
	});

	it("skips silently when an edit matches ambiguously (not_unique)", () => {
		// "foo" appears twice → resilientIndexOf returns not_unique → skip.
		// The atomic write would reject this; the preview just omits the change.
		expect(applyBlocks("foo bar foo", [{ old_text: "foo", new_text: "X" }])).toBe("foo bar foo");
	});

	it("matches via the line-trimmed tier through resilientIndexOf", () => {
		// Multi-line edit with indentation drift — tier 1 can't substring-match,
		// but applyBlocks should still apply via the line-trimmed tier.
		const note = "head\n        a\n        b\ntail\n";
		const out = applyBlocks(note, [{ old_text: "a\nb", new_text: "A\nB" }]);
		expect(out).toBe("head\nA\nB\ntail\n");
	});
});

describe("computeReplaceInNoteDiff", () => {
	it("combined diff reflects only the unambiguous edits (ambiguous skipped)", () => {
		const note = "foo bar foo\nkeep me";
		const result = computeReplaceInNoteDiff("n.md", note, [
			{ old_text: "foo", new_text: "X" }, // ambiguous → skipped in combined apply
			{ old_text: "keep me", new_text: "kept" }, // unique → applied
		]);
		expect(result.combinedDiff.afterContent).toBe("foo bar foo\nkept");
		// Per-block diffs still describe every requested edit.
		expect(result.blocks).toHaveLength(2);
	});
});
