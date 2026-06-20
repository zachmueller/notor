import { describe, it, expect } from "vitest";
import { applyBlocks, computeReplaceInNoteDiff, type ChangeBlock } from "./diff-engine";

describe("applyBlocks", () => {
	it("applies a single block", () => {
		const out = applyBlocks("alpha beta gamma", [{ search: "beta", replace: "BETA" }]);
		expect(out).toBe("alpha BETA gamma");
	});

	it("applies multiple blocks in sequence (later blocks see earlier edits)", () => {
		const blocks: ChangeBlock[] = [
			{ search: "one", replace: "two" },
			{ search: "two three", replace: "DONE" },
		];
		expect(applyBlocks("one three", blocks)).toBe("DONE");
	});

	it("respects the acceptedIndexes filter", () => {
		const blocks: ChangeBlock[] = [
			{ search: "a", replace: "X" },
			{ search: "b", replace: "Y" },
		];
		expect(applyBlocks("a b", blocks, new Set([1]))).toBe("a Y");
	});

	it("skips silently when a block does not match (not_found)", () => {
		const blocks: ChangeBlock[] = [
			{ search: "present", replace: "PRESENT" },
			{ search: "absent", replace: "ABSENT" },
		];
		// First applies; second is a no-op rather than throwing.
		expect(applyBlocks("present text", blocks)).toBe("PRESENT text");
	});

	it("skips silently when a block matches ambiguously (not_unique)", () => {
		// "foo" appears twice → resilientIndexOf returns not_unique → skip.
		// The atomic write would reject this; the preview just omits the change.
		expect(applyBlocks("foo bar foo", [{ search: "foo", replace: "X" }])).toBe("foo bar foo");
	});

	it("matches via the line-trimmed tier through resilientIndexOf", () => {
		// Multi-line block with indentation drift — tier 1 can't substring-match,
		// but applyBlocks should still apply via the line-trimmed tier.
		const note = "head\n        a\n        b\ntail\n";
		const out = applyBlocks(note, [{ search: "a\nb", replace: "A\nB" }]);
		expect(out).toBe("head\nA\nB\ntail\n");
	});
});

describe("computeReplaceInNoteDiff", () => {
	it("combined diff reflects only the unambiguous blocks (ambiguous skipped)", () => {
		const note = "foo bar foo\nkeep me";
		const result = computeReplaceInNoteDiff("n.md", note, [
			{ search: "foo", replace: "X" }, // ambiguous → skipped in combined apply
			{ search: "keep me", replace: "kept" }, // unique → applied
		]);
		expect(result.combinedDiff.afterContent).toBe("foo bar foo\nkept");
		// Per-block diffs still describe every requested block.
		expect(result.blocks).toHaveLength(2);
	});
});
