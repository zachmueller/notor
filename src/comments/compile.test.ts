import { describe, it, expect } from "vitest";
import { compileComments, formatQuote, truncateMiddle } from "./compile";
import type { AnchoredComment } from "./types";

function comment(quote: string, body: string, scopeId = "m1"): AnchoredComment {
	return {
		id: Math.random().toString(36),
		anchor: { scopeId, exact: quote.replace(/\s+/g, " "), prefix: "", suffix: "", occurrence: 0 },
		quote,
		body,
		created_at: "2026-10-11T00:00:00.000Z",
	};
}

describe("truncateMiddle", () => {
	it("leaves short text alone and truncates long text in the middle", () => {
		expect(truncateMiddle("short", 10)).toBe("short");
		const out = truncateMiddle("abcdefghijklmnopqrstuvwxyz", 11);
		expect(out).toBe("abcde…vwxyz");
		expect(out.length).toBe(11);
	});
});

describe("formatQuote", () => {
	it("quotes every line of a multi-line selection", () => {
		expect(formatQuote("line one\nline two", 400)).toBe('> "line one\n> line two"');
	});

	it("appends a note after the closing quote", () => {
		expect(formatQuote("gone", 400, "(from an earlier message)")).toBe('> "gone" (from an earlier message)');
	});

	it("drops leading/trailing blank lines and CRLFs", () => {
		expect(formatQuote("\r\nfirst\r\n\r\nsecond\r\n", 400)).toBe('> "first\n>\n> second"');
	});
});

describe("compileComments", () => {
	it("returns an empty string when there are no comments", () => {
		expect(compileComments([])).toBe("");
		expect(compileComments([{ scopeId: "m1", items: [] }])).toBe("");
	});

	it("produces the quoted-text format", () => {
		const out = compileComments([
			{
				scopeId: "m1",
				label: "In message 1",
				items: [{ comment: comment("selected text", "My comment about this") }, { comment: comment("another passage", "Another comment") }],
			},
		]);
		expect(out).toBe(
			'Comments on your previous response:\n\n> "selected text"\nMy comment about this\n\n> "another passage"\nAnother comment',
		);
	});

	it("adds scope labels only when comments span multiple scopes", () => {
		const out = compileComments(
			[
				{ scopeId: "m1", label: "In message 1", items: [{ comment: comment("a", "first") }] },
				{ scopeId: "m2", label: "In message 2", items: [{ comment: comment("b", "second", "m2") }] },
			],
			{ intro: "Comments on your previous responses:" },
		);
		expect(out).toContain("**In message 1:**");
		expect(out).toContain("**In message 2:**");
		expect(out.startsWith("Comments on your previous responses:")).toBe(true);
	});

	it("marks orphaned comments and falls back to the anchor text when no quote is stored", () => {
		const c = comment("", "still relevant");
		c.anchor.exact = "compacted passage";
		const out = compileComments([{ scopeId: "m1", items: [{ comment: c, orphaned: true }] }]);
		expect(out).toContain('> "compacted passage" (from an earlier message)\nstill relevant');
	});
});
