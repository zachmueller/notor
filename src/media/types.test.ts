import { describe, it, expect } from "vitest";
import { getTextContent, type ContentBlock } from "./types";

describe("getTextContent", () => {
	it("returns string input as-is", () => {
		expect(getTextContent("hello world")).toBe("hello world");
	});

	it("returns empty string for empty string input", () => {
		expect(getTextContent("")).toBe("");
	});

	it("returns empty string for empty ContentBlock array", () => {
		expect(getTextContent([])).toBe("");
	});

	it("extracts text from text-only blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "first" },
			{ type: "text", text: "second" },
		];
		expect(getTextContent(blocks)).toBe("first\nsecond");
	});

	it("returns single text block without extra newlines", () => {
		const blocks: ContentBlock[] = [{ type: "text", text: "only one" }];
		expect(getTextContent(blocks)).toBe("only one");
	});

	it("filters out image blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "before" },
			{ type: "image", media_type: "image/png", data: "base64data" },
			{ type: "text", text: "after" },
		];
		expect(getTextContent(blocks)).toBe("before\nafter");
	});

	it("filters out document blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "text" },
			{ type: "document", media_type: "application/pdf", data: "base64data" },
		];
		expect(getTextContent(blocks)).toBe("text");
	});

	it("returns empty string when array contains only non-text blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "image", media_type: "image/jpeg", data: "base64data" },
			{ type: "document", media_type: "application/pdf", data: "base64data" },
		];
		expect(getTextContent(blocks)).toBe("");
	});

	it("handles mixed content blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "hello" },
			{
				type: "image",
				media_type: "image/png",
				data: "base64data",
				width: 100,
				height: 200,
			},
			{ type: "text", text: "world" },
			{
				type: "document",
				media_type: "application/pdf",
				data: "base64data",
				page_count: 5,
			},
		];
		expect(getTextContent(blocks)).toBe("hello\nworld");
	});

	// 13.1 — custom_block filtering
	it("returns empty string for array containing only custom_block entries", () => {
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "memory_recalled", data: { notes: ["a", "b"] } },
			{ type: "custom_block", kind: "other_block", data: {} },
		];
		expect(getTextContent(blocks)).toBe("");
	});

	it("returns only text block content when array contains both custom_block and text blocks", () => {
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "memory_recalled", data: { text: "ignored" } },
			{ type: "text", text: "visible text" },
			{ type: "custom_block", kind: "other", data: {} },
		];
		expect(getTextContent(blocks)).toBe("visible text");
	});
});

describe("custom_block JSON round-trip", () => {
	it("preserves all fields through JSON serialization", () => {
		const block: ContentBlock = {
			type: "custom_block",
			kind: "test_kind",
			data: { key: "value", nested: { n: 42 } },
			fallback_text: "fallback",
			estimated_wire_tokens: 15,
			loading: true,
		};
		const roundTripped = JSON.parse(JSON.stringify(block)) as ContentBlock;
		expect(roundTripped).toEqual(block);
	});

	it("optional fields are absent when not set", () => {
		const block: ContentBlock = {
			type: "custom_block",
			kind: "minimal",
			data: {},
		};
		const roundTripped = JSON.parse(JSON.stringify(block)) as ContentBlock;
		expect(roundTripped.type).toBe("custom_block");
		if (roundTripped.type === "custom_block") {
			expect(roundTripped.fallback_text).toBeUndefined();
			expect(roundTripped.estimated_wire_tokens).toBeUndefined();
			expect(roundTripped.loading).toBeUndefined();
		}
	});
});
