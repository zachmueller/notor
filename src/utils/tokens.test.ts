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

	// 13.2 — custom_block token estimation
	it("custom_block with estimated_wire_tokens: 0 returns 0", () => {
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "test", data: { large: "payload" }, estimated_wire_tokens: 0 },
		];
		expect(estimateContentTokens(blocks)).toBe(0);
	});

	it("custom_block with estimated_wire_tokens: 150 returns 150", () => {
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "test", data: {}, estimated_wire_tokens: 150 },
		];
		expect(estimateContentTokens(blocks)).toBe(150);
	});

	it("custom_block without estimated_wire_tokens but with fallback_text estimates from fallback", () => {
		// "hello world" = 11 chars / 4 = ceil(2.75) = 3
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "test", data: {}, fallback_text: "hello world" },
		];
		expect(estimateContentTokens(blocks)).toBe(3);
	});

	it("custom_block without estimated_wire_tokens or fallback_text falls back to JSON.stringify(data)", () => {
		const data = { key: "value" };
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "test", data },
		];
		const expectedTokens = Math.ceil(JSON.stringify(data).length / 4);
		expect(estimateContentTokens(blocks)).toBe(expectedTokens);
	});

	it("custom_block estimated_wire_tokens takes precedence over fallback_text", () => {
		// estimated_wire_tokens: 5 wins over fallback_text which would be 3 tokens
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "test", data: {}, estimated_wire_tokens: 5, fallback_text: "hello world" },
		];
		expect(estimateContentTokens(blocks)).toBe(5);
	});

	it("memory_recalled block with estimated_wire_tokens returns correct value", () => {
		const blocks: ContentBlock[] = [
			{
				type: "custom_block",
				kind: "memory_recalled",
				data: { matches: [{ path: "memory/note.md", title: "Test", reason: "relevant", payload: "Full body text here" }] },
				estimated_wire_tokens: 42,
			},
		];
		expect(estimateContentTokens(blocks)).toBe(42);
	});

	it("memory_recalled block with empty matches and toLLMText returning null yields zero tokens", () => {
		const blocks: ContentBlock[] = [
			{
				type: "custom_block",
				kind: "memory_recalled",
				data: { matches: [] },
				estimated_wire_tokens: 0,
			},
		];
		expect(estimateContentTokens(blocks)).toBe(0);
	});
});
