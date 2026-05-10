import { describe, it, expect } from "vitest";
import { normalizedIndexOf, normalizeForMatch } from "./unicode-normalize";

describe("normalizeForMatch", () => {
	it("leaves plain ASCII unchanged", () => {
		const result = normalizeForMatch("hello world");
		expect(result.normalized).toBe("hello world");
		expect(result.posMap).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("normalizes em-dash to hyphen", () => {
		const result = normalizeForMatch("foo—bar");
		expect(result.normalized).toBe("foo-bar");
	});

	it("normalizes curly quotes to straight quotes", () => {
		const result = normalizeForMatch("“hello”");
		expect(result.normalized).toBe('"hello"');
	});

	it("expands ellipsis to three dots", () => {
		const result = normalizeForMatch("wait…");
		expect(result.normalized).toBe("wait...");
		// The three dots all map back to original index 4 (the ellipsis char)
		expect(result.posMap[4]).toBe(4);
		expect(result.posMap[5]).toBe(4);
		expect(result.posMap[6]).toBe(4);
	});

	it("removes zero-width space", () => {
		const result = normalizeForMatch("foo​bar");
		expect(result.normalized).toBe("foobar");
	});

	it("handles NFC normalization of decomposed characters", () => {
		// e + combining acute = é in NFC
		const decomposed = "café";
		const composed = "café";
		const r1 = normalizeForMatch(decomposed);
		const r2 = normalizeForMatch(composed);
		expect(r1.normalized).toBe(r2.normalized);
	});
});

describe("normalizedIndexOf", () => {
	it("finds exact ASCII match", () => {
		const match = normalizedIndexOf("hello world", "world");
		expect(match).toEqual({ index: 6, length: 5 });
	});

	it("returns null when no match exists", () => {
		const match = normalizedIndexOf("hello world", "xyz");
		expect(match).toBeNull();
	});

	it("matches em-dash in haystack with hyphen in needle", () => {
		const match = normalizedIndexOf("foo — bar", "foo - bar");
		expect(match).toEqual({ index: 0, length: 9 });
	});

	it("matches hyphen in haystack with em-dash in needle", () => {
		const match = normalizedIndexOf("foo - bar", "foo — bar");
		expect(match).toEqual({ index: 0, length: 9 });
	});

	it("matches en-dash in haystack with hyphen in needle", () => {
		const match = normalizedIndexOf("2020–2025", "2020-2025");
		expect(match).toEqual({ index: 0, length: 9 });
	});

	it("matches curly double quotes with straight quotes", () => {
		const match = normalizedIndexOf("he said “hello”", 'he said "hello"');
		expect(match).toEqual({ index: 0, length: 15 });
	});

	it("matches curly single quotes with straight apostrophe", () => {
		const match = normalizedIndexOf("don’t", "don't");
		expect(match).toEqual({ index: 0, length: 5 });
	});

	it("matches non-breaking space with regular space", () => {
		const match = normalizedIndexOf("hello world", "hello world");
		expect(match).toEqual({ index: 0, length: 11 });
	});

	it("matches ellipsis character with three dots (haystack has ellipsis)", () => {
		const match = normalizedIndexOf("wait… more", "wait... more");
		expect(match).not.toBeNull();
		expect(match!.index).toBe(0);
		// Original haystack "wait… more" is 10 chars, the matched region covers all of it
		expect(match!.length).toBe(10);
	});

	it("matches three dots with ellipsis character (haystack has three dots)", () => {
		const match = normalizedIndexOf("wait... more", "wait… more");
		expect(match).not.toBeNull();
		expect(match!.index).toBe(0);
		// Original haystack "wait... more" is 12 chars
		expect(match!.length).toBe(12);
	});

	it("handles zero-width space in haystack transparently", () => {
		const match = normalizedIndexOf("foo​bar", "foobar");
		expect(match).not.toBeNull();
		expect(match!.index).toBe(0);
		expect(match!.length).toBe(7); // includes the zero-width space character
	});

	it("handles NFC equivalence between composed and decomposed", () => {
		const decomposed = "café"; // e + combining acute
		const composed = "café";          // precomposed é
		const match = normalizedIndexOf(decomposed, composed);
		expect(match).not.toBeNull();
	});

	it("handles multiple normalized characters in one match", () => {
		const haystack = "“Hello” — she said…";
		const needle = '"Hello" - she said...';
		const match = normalizedIndexOf(haystack, needle);
		expect(match).not.toBeNull();
		expect(match!.index).toBe(0);
		expect(match!.length).toBe(haystack.length);
	});

	it("finds match at non-zero offset", () => {
		const match = normalizedIndexOf("prefix: foo — bar", "foo - bar");
		expect(match).not.toBeNull();
		expect(match!.index).toBe(8);
		expect(match!.length).toBe(9);
	});

	it("position mapping allows correct splice", () => {
		const haystack = "before — after";
		const needle = " - ";
		const replacement = " -- ";
		const match = normalizedIndexOf(haystack, needle);
		expect(match).not.toBeNull();
		const result = haystack.slice(0, match!.index) + replacement + haystack.slice(match!.index + match!.length);
		expect(result).toBe("before -- after");
	});

	it("position mapping for ellipsis splice", () => {
		const haystack = "wait… done";
		const needle = "...";
		const replacement = "...";
		const match = normalizedIndexOf(haystack, needle);
		expect(match).not.toBeNull();
		const result = haystack.slice(0, match!.index) + replacement + haystack.slice(match!.index + match!.length);
		expect(result).toBe("wait... done");
	});

	it("no false positives for genuinely different text", () => {
		expect(normalizedIndexOf("hello world", "goodbye")).toBeNull();
		expect(normalizedIndexOf("abc", "def")).toBeNull();
	});

	it("handles empty needle", () => {
		const match = normalizedIndexOf("hello", "");
		expect(match).toEqual({ index: 0, length: 0 });
	});

	it("sequential multi-block application works correctly", () => {
		let content = "First — Second — Third";

		// Replace first occurrence
		const match1 = normalizedIndexOf(content, "First - Second");
		expect(match1).not.toBeNull();
		content = content.slice(0, match1!.index) + "First -- Second" + content.slice(match1!.index + match1!.length);

		// Replace in modified content
		const match2 = normalizedIndexOf(content, "Second - Third");
		expect(match2).not.toBeNull();
		content = content.slice(0, match2!.index) + "Second -- Third" + content.slice(match2!.index + match2!.length);

		expect(content).toBe("First -- Second -- Third");
	});
});
