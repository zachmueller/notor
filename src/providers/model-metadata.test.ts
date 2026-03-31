import { describe, it, expect } from "vitest";
import { getContextWindow } from "./model-metadata";

describe("getContextWindow", () => {
	it("returns context window for a known model", () => {
		expect(getContextWindow("us.anthropic.claude-sonnet-4-6")).toBe(200_000);
	});

	it("returns default 128K for an unknown model", () => {
		expect(getContextWindow("unknown-model-id")).toBe(128_000);
	});

	it("returns base context window when useExtendedContext is false", () => {
		expect(getContextWindow("us.anthropic.claude-sonnet-4-6", false)).toBe(200_000);
	});

	it("returns extended context window when useExtendedContext is true and model supports it", () => {
		expect(getContextWindow("us.anthropic.claude-sonnet-4-6", true)).toBe(1_000_000);
	});

	it("returns extended context window when useExtendedContext is true for Opus 4.6", () => {
		expect(getContextWindow("us.anthropic.claude-opus-4-6-v1", true)).toBe(1_000_000);
	});

	it("returns default for unknown model even with useExtendedContext true", () => {
		expect(getContextWindow("unknown-model-id", true)).toBe(128_000);
	});

	it("returns extended context for all regional variants with 1M support", () => {
		const variants = [
			"us.anthropic.claude-sonnet-4-6",
			"eu.anthropic.claude-sonnet-4-6",
			"apac.anthropic.claude-sonnet-4-6",
			"global.anthropic.claude-sonnet-4-6",
			"us.anthropic.claude-opus-4-6-v1",
			"global.anthropic.claude-opus-4-6-v1",
		];
		for (const id of variants) {
			expect(getContextWindow(id, true)).toBe(1_000_000);
		}
	});

	it("returns base context when useExtendedContext is undefined (default)", () => {
		expect(getContextWindow("us.anthropic.claude-sonnet-4-6")).toBe(200_000);
	});
});
