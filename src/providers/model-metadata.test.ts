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

	it("returns 200K base / 1M extended for the 5-series (Opus 5 / Sonnet 5 / Fable 5)", () => {
		const fiveSeries = [
			"us.anthropic.claude-opus-5",
			"global.anthropic.claude-opus-5",
			"us.anthropic.claude-sonnet-5",
			"global.anthropic.claude-sonnet-5",
			"us.anthropic.claude-fable-5",
			"global.anthropic.claude-fable-5",
		];
		for (const id of fiveSeries) {
			expect(getContextWindow(id)).toBe(200_000);
			expect(getContextWindow(id, true)).toBe(1_000_000);
		}
	});

	it("returns 200K base / 1M extended for Opus 4.7 and Opus 4.5", () => {
		const oneMillion = [
			"us.anthropic.claude-opus-4-7",
			"global.anthropic.claude-opus-4-7",
			"us.anthropic.claude-opus-4-5-20251101-v1:0",
			"global.anthropic.claude-opus-4-5-20251101-v1:0",
		];
		for (const id of oneMillion) {
			expect(getContextWindow(id)).toBe(200_000);
			expect(getContextWindow(id, true)).toBe(1_000_000);
		}
	});

	it("returns 200K for Opus 4.1 / Claude 3 Bedrock profiles (no extended context)", () => {
		const base200k = [
			"us.anthropic.claude-opus-4-1-20250805-v1:0",
			"us.anthropic.claude-3-haiku-20240307-v1:0",
			"us.anthropic.claude-3-sonnet-20240229-v1:0",
		];
		for (const id of base200k) {
			expect(getContextWindow(id)).toBe(200_000);
			// No extended_context — asking for extended returns the base window.
			expect(getContextWindow(id, true)).toBe(200_000);
		}
	});

	it("returns correct windows for newly-registered non-Anthropic Bedrock profiles", () => {
		expect(getContextWindow("us.amazon.nova-2-lite-v1:0")).toBe(300_000);
		expect(getContextWindow("us.meta.llama3-3-70b-instruct-v1:0")).toBe(128_000);
		expect(getContextWindow("us.meta.llama3-1-8b-instruct-v1:0")).toBe(128_000);
		expect(getContextWindow("us.mistral.pixtral-large-2502-v1:0")).toBe(128_000);
		expect(getContextWindow("us.writer.palmyra-x4-v1:0")).toBe(128_000);
		expect(getContextWindow("us.writer.palmyra-x5-v1:0")).toBe(1_000_000);
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
			"us.anthropic.claude-opus-5",
			"global.anthropic.claude-opus-5",
			"us.anthropic.claude-sonnet-5",
			"global.anthropic.claude-sonnet-5",
			"us.anthropic.claude-fable-5",
			"global.anthropic.claude-fable-5",
			"us.anthropic.claude-opus-4-7",
			"global.anthropic.claude-opus-4-7",
			"us.anthropic.claude-opus-4-5-20251101-v1:0",
			"global.anthropic.claude-opus-4-5-20251101-v1:0",
		];
		for (const id of variants) {
			expect(getContextWindow(id, true)).toBe(1_000_000);
		}
	});

	it("returns base context when useExtendedContext is undefined (default)", () => {
		expect(getContextWindow("us.anthropic.claude-sonnet-4-6")).toBe(200_000);
	});
});
