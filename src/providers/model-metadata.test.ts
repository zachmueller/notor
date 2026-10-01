import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	describeContextWindow,
	enrichModelInfo,
	getContextWindow,
	getExtendedContextBeta,
	getModelExtendedContext,
	getModelMetadata,
	hasInferredExtendedBeta,
} from "./model-metadata";
import {
	initModelLimits,
	recordApiModelLimits,
	recordBetaRejected,
	recordLearnedContextWindow,
	resetModelLimits,
} from "./model-limits";

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

describe("getContextWindow — inferred Claude models", () => {
	beforeEach(() => resetModelLimits());

	it("assumes 1M for a new Bedrock Sonnet+ model and sends the beta by default", () => {
		for (const id of ["us.anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5-5", "us.anthropic.claude-sonnet-5-5"]) {
			expect(getContextWindow(id)).toBe(1_000_000);
			expect(getContextWindow(id, true)).toBe(1_000_000);
			expect(getExtendedContextBeta(id, false)).toBe("context-1m-2025-08-07");
			expect(hasInferredExtendedBeta(id)).toBe(true);
			// No separate 1M picker variant — the base window is already 1M.
			expect(getModelExtendedContext(id)).toBeUndefined();
		}
	});

	it("assumes 1M for a new direct-API model, with no beta", () => {
		expect(getContextWindow("claude-opus-5-5")).toBe(1_000_000);
		expect(getExtendedContextBeta("claude-opus-5-5", true)).toBeUndefined();
	});

	it("assumes 1M for a new family member with no table sibling (mythos)", () => {
		expect(getContextWindow("us.anthropic.claude-mythos-5-1")).toBe(1_000_000);
	});

	it("inherits the nearest sibling for a new Haiku", () => {
		expect(getContextWindow("us.anthropic.claude-haiku-5")).toBe(200_000);
		expect(getExtendedContextBeta("us.anthropic.claude-haiku-5", false)).toBeUndefined();
	});

	it("inherits base + extended context for an unknown regional variant of a known model", () => {
		const id = "eu.anthropic.claude-opus-5";
		expect(getContextWindow(id)).toBe(200_000);
		expect(getContextWindow(id, true)).toBe(1_000_000);
		expect(getModelExtendedContext(id)).toEqual({ context_window: 1_000_000, beta_flag: "context-1m-2025-08-07" });
		expect(getExtendedContextBeta(id, false)).toBeUndefined();
		expect(getExtendedContextBeta(id, true)).toBe("context-1m-2025-08-07");
	});

	it("falls back to the sibling's base window once the inferred beta is rejected", () => {
		recordBetaRejected("us.anthropic.claude-opus-5-5");
		expect(getContextWindow("us.anthropic.claude-opus-5-5")).toBe(200_000);
		expect(getExtendedContextBeta("us.anthropic.claude-opus-5-5", false)).toBeUndefined();
		expect(hasInferredExtendedBeta("us.anthropic.claude-opus-5-5")).toBe(false);
	});

	it("never infers pricing", () => {
		expect(getModelMetadata("us.anthropic.claude-opus-5-5")).toBeNull();
		const enriched = enrichModelInfo({ id: "us.anthropic.claude-opus-5-5", display_name: "x" });
		expect(enriched.context_window).toBe(1_000_000);
		expect(enriched.input_price_per_1k).toBeUndefined();
	});

	it("reports the inference source", () => {
		expect(describeContextWindow("us.anthropic.claude-opus-5-5")).toMatchObject({
			source: "inferred",
			baseSource: "inferred",
			inferredFrom: "us.anthropic.claude-opus-5",
		});
	});
});

describe("getContextWindow — runtime registry precedence", () => {
	beforeEach(() => resetModelLimits());

	it("prefers the API-reported window over the static table", () => {
		recordApiModelLimits([{ id: "claude-opus-5", max_input_tokens: 1_000_000 }]);
		expect(getContextWindow("claude-opus-5")).toBe(1_000_000);
		expect(describeContextWindow("claude-opus-5").source).toBe("api");
		expect(getModelExtendedContext("claude-opus-5")).toBeUndefined();
	});

	it("clamps to a lower learned limit, per context mode", () => {
		recordLearnedContextWindow("us.anthropic.claude-sonnet-4-6", true, 800_000, "error");
		expect(getContextWindow("us.anthropic.claude-sonnet-4-6", true)).toBe(800_000);
		expect(getContextWindow("us.anthropic.claude-sonnet-4-6", false)).toBe(200_000);
		expect(describeContextWindow("us.anthropic.claude-sonnet-4-6", true).source).toBe("learned");
	});

	it("lets an override win over learned and API limits", () => {
		initModelLimits({ getOverrides: () => ({ "claude-opus-5": 300_000 }), persist: () => {} });
		recordApiModelLimits([{ id: "claude-opus-5", max_input_tokens: 1_000_000 }]);
		recordLearnedContextWindow("claude-opus-5", false, 250_000, "error");
		expect(getContextWindow("claude-opus-5")).toBe(300_000);
		expect(describeContextWindow("claude-opus-5")).toMatchObject({ source: "override", base: 1_000_000, learned: 250_000 });
	});
});

describe("getContextWindow — fallback warning", () => {
	beforeEach(() => resetModelLimits());

	it("warns once for a truly unknown model, never for inferred or empty IDs", () => {
		const onFallback = vi.fn();
		initModelLimits({ getOverrides: () => undefined, persist: () => {}, onFallbackContextWindow: onFallback });
		getContextWindow("some-local-model");
		getContextWindow("some-local-model");
		getContextWindow("us.anthropic.claude-opus-5-5");
		getContextWindow("");
		expect(onFallback.mock.calls).toEqual([["some-local-model"]]);
	});

	it("does not warn when a learned limit replaces the default", () => {
		const onFallback = vi.fn();
		initModelLimits({ getOverrides: () => undefined, persist: () => {}, onFallbackContextWindow: onFallback });
		recordLearnedContextWindow("some-local-model", false, 8_192, "error");
		expect(getContextWindow("some-local-model")).toBe(8_192);
		expect(onFallback).not.toHaveBeenCalled();
	});
});
