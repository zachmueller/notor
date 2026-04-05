import { describe, it, expect } from "vitest";
import { estimateContentTokens } from "./tokens";
import type { ContentBlock } from "../media/types";

describe("estimateContentTokens", () => {
	it("delegates to estimateTokenCount for string input", () => {
		// "hello world" = 11 chars / 4 = 2.75 → ceil → 3
		expect(estimateContentTokens("hello world")).toBe(3);
	});

	it("returns 0 for empty string", () => {
		expect(estimateContentTokens("")).toBe(0);
	});

	it("returns 0 for empty ContentBlock array", () => {
		expect(estimateContentTokens([])).toBe(0);
	});

	it("estimates text-only blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "hello world" }, // 11 / 4 = 3
			{ type: "text", text: "test" }, // 4 / 4 = 1
		];
		expect(estimateContentTokens(blocks)).toBe(4);
	});

	it("estimates image with dimensions", () => {
		const blocks: ContentBlock[] = [
			{ type: "image", media_type: "image/png", data: "", width: 1500, height: 750 },
		];
		// (1500 * 750) / 750 = 1500
		expect(estimateContentTokens(blocks)).toBe(1500);
	});

	it("estimates image without dimensions as flat 2000", () => {
		const blocks: ContentBlock[] = [
			{ type: "image", media_type: "image/jpeg", data: "" },
		];
		expect(estimateContentTokens(blocks)).toBe(2000);
	});

	it("estimates document with page count", () => {
		const blocks: ContentBlock[] = [
			{ type: "document", media_type: "application/pdf", data: "", page_count: 5 },
		];
		// 5 * 2000 = 10000
		expect(estimateContentTokens(blocks)).toBe(10000);
	});

	it("estimates document without page count as flat 2000", () => {
		const blocks: ContentBlock[] = [
			{ type: "document", media_type: "application/pdf", data: "" },
		];
		expect(estimateContentTokens(blocks)).toBe(2000);
	});

	it("sums mixed content blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "hello world" }, // 3
			{ type: "image", media_type: "image/png", data: "", width: 750, height: 750 }, // 750
			{ type: "document", media_type: "application/pdf", data: "", page_count: 2 }, // 4000
		];
		expect(estimateContentTokens(blocks)).toBe(3 + 750 + 4000);
	});
});
