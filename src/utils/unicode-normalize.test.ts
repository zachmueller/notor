import { describe, it, expect } from "vitest";
import { normalizedIndexOf, normalizeForMatch, resilientIndexOf } from "./unicode-normalize";

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

describe("resilientIndexOf", () => {
	/** Helper: assert ok and return the match for chaining. */
	function expectMatch(result: ReturnType<typeof resilientIndexOf>) {
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected ok result");
		return result.match;
	}

	describe("tier 1: exact (normalized)", () => {
		it("finds an exact ASCII match", () => {
			const r = resilientIndexOf("hello world", "world");
			expect(r).toEqual({ ok: true, match: { index: 6, length: 5 } });
		});

		it("still resolves Unicode variants via tier 1 (regression)", () => {
			const r = resilientIndexOf("foo — bar", "foo - bar");
			expect(r).toEqual({ ok: true, match: { index: 0, length: 9 } });
		});

		it("expands ellipsis via tier 1 (regression)", () => {
			const r = resilientIndexOf("wait… more", "wait... more");
			const m = expectMatch(r);
			expect(m.index).toBe(0);
			expect(m.length).toBe(10);
		});

		it("empty needle returns a zero-length match at 0", () => {
			expect(resilientIndexOf("hello", "")).toEqual({ ok: true, match: { index: 0, length: 0 } });
		});

		it("splice round-trips on an exact match", () => {
			const haystack = "before — after";
			const m = expectMatch(resilientIndexOf(haystack, " - "));
			const out = haystack.slice(0, m.index) + " -- " + haystack.slice(m.index + m.length);
			expect(out).toBe("before -- after");
		});
	});

	describe("tier 2: line-trimmed", () => {
		// NOTE: a SINGLE-line trimmed needle is always an exact substring of the
		// haystack, so tier 1 handles it (tight substring replace). Tier 2 only
		// becomes load-bearing for MULTI-line blocks, where newline adjacency
		// breaks the exact substring — that's what these cases exercise.

		it("matches a multi-line block despite interior indentation drift", () => {
			// Note indents the body with 8 spaces; the search block used 4.
			const haystack = "func() {\n        return 1;\n}\n";
			const search = "func() {\n    return 1;\n}";
			const m = expectMatch(resilientIndexOf(haystack, search));
			const out = haystack.slice(0, m.index) + "func() {\n    return 2;\n}" + haystack.slice(m.index + m.length);
			expect(out).toBe("func() {\n    return 2;\n}\n");
		});

		it("matches a multi-line block despite trailing whitespace on interior lines", () => {
			const haystack = "x = [\n  1,  \n  2,\t\n]\n"; // trailing spaces / tab after items
			const search = "x = [\n  1,\n  2,\n]";
			const m = expectMatch(resilientIndexOf(haystack, search));
			const out = haystack.slice(0, m.index) + "x = []" + haystack.slice(m.index + m.length);
			expect(out).toBe("x = []\n");
		});

		it("matches a multi-line block ignoring per-line indentation", () => {
			const haystack = "head\n   one\n      two\nthree\ntail\n";
			const search = "one\ntwo\nthree";
			const m = expectMatch(resilientIndexOf(haystack, search));
			const out = haystack.slice(0, m.index) + "ONE\nTWO\nTHREE" + haystack.slice(m.index + m.length);
			expect(out).toBe("head\nONE\nTWO\nTHREE\ntail\n");
		});

		it("tolerates a trailing newline on the search block", () => {
			// Multi-line so tier 1's substring match doesn't fire first.
			const haystack = "head\n    a\n    b\ntail\n";
			const search = "a\nb\n"; // note the trailing newline
			const m = expectMatch(resilientIndexOf(haystack, search));
			const out = haystack.slice(0, m.index) + "A\nB" + haystack.slice(m.index + m.length);
			expect(out).toBe("head\nA\nB\ntail\n");
		});
	});

	describe("tier 3: intra-line whitespace-flexible", () => {
		it("matches single-vs-multiple spaces inside a line", () => {
			const haystack = "the   quick    brown fox\n";
			const m = expectMatch(resilientIndexOf(haystack, "the quick brown fox"));
			const out = haystack.slice(0, m.index) + "DONE" + haystack.slice(m.index + m.length);
			expect(out).toBe("DONE\n");
		});

		it("matches tabs against spaces inside a line", () => {
			const haystack = "key:\tvalue\n";
			const m = expectMatch(resilientIndexOf(haystack, "key: value"));
			const out = haystack.slice(0, m.index) + "REPLACED" + haystack.slice(m.index + m.length);
			expect(out).toBe("REPLACED\n");
		});

		it("does NOT cross line boundaries (newlines stay significant)", () => {
			// "a b" must not match across the newline between "a" and "b".
			const r = resilientIndexOf("a\nb\n", "a b");
			expect(r).toEqual({ ok: false, reason: "not_found" });
		});
	});

	describe("uniqueness enforcement", () => {
		it("reports not_unique with a count when the needle occurs twice (tier 1)", () => {
			const r = resilientIndexOf("foo bar foo", "foo");
			expect(r).toEqual({ ok: false, reason: "not_unique", count: 2 });
		});

		it("matches uniquely once disambiguating context is added", () => {
			const r = resilientIndexOf("foo bar foo baz", "foo baz");
			expect(r).toEqual({ ok: true, match: { index: 8, length: 7 } });
		});

		it("does not fall through to a looser tier when a tighter tier is ambiguous", () => {
			// Two exact occurrences at tier 1 → not_unique. We report ambiguity at
			// the tighter tier rather than loosening to tier 2/3.
			const r = resilientIndexOf("  item\nitem\n", "item");
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toBe("not_unique");
		});

		it("counts ambiguity at the line-trimmed tier (tier 1 misses)", () => {
			// Multi-line needle: tier 1 can't substring-match across the indented
			// newline, but two blocks match after per-line trimming.
			const haystack = "   a\n   b\nxxx\n   a\n   b\n";
			const r = resilientIndexOf(haystack, "a\nb");
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.reason).toBe("not_unique");
				expect(r.count).toBe(2);
			}
		});
	});

	describe("negative", () => {
		it("returns not_found for genuinely absent text", () => {
			expect(resilientIndexOf("hello world", "goodbye")).toEqual({ ok: false, reason: "not_found" });
		});
	});
});
