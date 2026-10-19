import { describe, it, expect } from "vitest";
import { firstSentences, toSpeakableText, truncateForSpeech } from "./speech-text";

describe("toSpeakableText", () => {
	it("strips headings, emphasis, links, code and list markers", () => {
		const md = [
			"## Summary",
			"",
			"I found **three** notes about _planning_ in [[Projects/Roadmap|the roadmap]] and [[Daily]].",
			"- First item",
			"1. Second `inline` item",
			"See [the docs](https://example.com/docs) or https://example.com.",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n");
		const out = toSpeakableText(md);
		expect(out).not.toMatch(/[#*_`\[\]()]/);
		expect(out).toContain("Summary");
		expect(out).toContain("I found three notes about planning in the roadmap and Daily.");
		expect(out).toContain("First item");
		expect(out).toContain("Second inline item");
		expect(out).toContain("See the docs or a link.");
		expect(out).toContain("code omitted.");
		expect(out).not.toContain("const x");
	});

	it("flattens tables and drops images and html", () => {
		const md = "| Name | Count |\n|------|-------|\n| A | 1 |\n\n![alt](img.png) <br> done";
		const out = toSpeakableText(md);
		expect(out).not.toContain("|");
		expect(out).not.toContain("---");
		expect(out).toContain("Name , Count");
		expect(out).toContain("done");
		expect(out).not.toContain("img.png");
		expect(out).not.toContain("<br>");
	});
});

describe("truncateForSpeech", () => {
	it("returns short text unchanged", () => {
		expect(truncateForSpeech("Hello there.", 100)).toBe("Hello there.");
	});

	it("cuts at a sentence boundary when one is past the halfway mark", () => {
		const text = "First sentence here. Second sentence is longer than the rest. Third one.";
		expect(truncateForSpeech(text, 30)).toBe("First sentence here.");
	});

	it("falls back to a word boundary with an ellipsis", () => {
		expect(truncateForSpeech("one two three four five six", 12)).toBe("one two…");
	});
});

describe("firstSentences", () => {
	it("returns the requested number of sentences", () => {
		expect(firstSentences("A one. B two! C three? D four.", 2)).toBe("A one. B two!");
		expect(firstSentences("No terminator here", 3)).toBe("No terminator here");
	});
});
