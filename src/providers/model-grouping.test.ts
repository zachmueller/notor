import { describe, it, expect } from "vitest";
import {
	parseProfileId,
	stripVersionSuffix,
	baseKeyToLabel,
	formatContextLabel,
	groupModels,
	parseOptionValue,
	buildOptionValue,
	formatVariantLabel,
	formatFullVariantLabel,
	EXTENDED_CONTEXT_SUFFIX,
} from "./model-grouping";
import type { ModelInfo } from "../types";

// ---------------------------------------------------------------------------
// parseProfileId
// ---------------------------------------------------------------------------

describe("parseProfileId", () => {
	it("extracts US prefix", () => {
		const result = parseProfileId("us.anthropic.claude-sonnet-4-6");
		expect(result).toEqual({ geo: "US", baseKey: "anthropic.claude-sonnet-4-6" });
	});

	it("extracts EU prefix", () => {
		const result = parseProfileId("eu.anthropic.claude-sonnet-4-6");
		expect(result).toEqual({ geo: "EU", baseKey: "anthropic.claude-sonnet-4-6" });
	});

	it("extracts APAC prefix", () => {
		const result = parseProfileId("apac.anthropic.claude-sonnet-4-6");
		expect(result).toEqual({ geo: "APAC", baseKey: "anthropic.claude-sonnet-4-6" });
	});

	it("extracts Global prefix", () => {
		const result = parseProfileId("global.amazon.nova-pro-v1:0");
		expect(result).toEqual({ geo: "Global", baseKey: "amazon.nova-pro-v1:0" });
	});

	it("returns null geo for non-Bedrock model ID", () => {
		const result = parseProfileId("claude-sonnet-4-6");
		expect(result).toEqual({ geo: null, baseKey: "claude-sonnet-4-6" });
	});

	it("returns null geo for unknown prefix", () => {
		const result = parseProfileId("sa.anthropic.claude-sonnet-4-6");
		expect(result).toEqual({ geo: null, baseKey: "sa.anthropic.claude-sonnet-4-6" });
	});
});

// ---------------------------------------------------------------------------
// stripVersionSuffix
// ---------------------------------------------------------------------------

describe("stripVersionSuffix", () => {
	it("strips -v1:0", () => {
		expect(stripVersionSuffix("amazon.nova-pro-v1:0")).toBe("amazon.nova-pro");
	});

	it("strips -v1", () => {
		expect(stripVersionSuffix("anthropic.claude-opus-4-6-v1")).toBe("anthropic.claude-opus-4-6");
	});

	it("strips -v2:0", () => {
		expect(stripVersionSuffix("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(
			"anthropic.claude-3-5-sonnet-20241022"
		);
	});

	it("does not strip when no version suffix", () => {
		expect(stripVersionSuffix("anthropic.claude-sonnet-4-6")).toBe(
			"anthropic.claude-sonnet-4-6"
		);
	});
});

// ---------------------------------------------------------------------------
// baseKeyToLabel
// ---------------------------------------------------------------------------

describe("baseKeyToLabel", () => {
	it("converts anthropic.claude-sonnet-4-6", () => {
		expect(baseKeyToLabel("anthropic.claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
	});

	it("converts amazon.nova-pro", () => {
		expect(baseKeyToLabel("amazon.nova-pro")).toBe("Nova Pro");
	});

	it("converts anthropic.claude-opus-4-6", () => {
		expect(baseKeyToLabel("anthropic.claude-opus-4-6")).toBe("Claude Opus 4.6");
	});

	it("converts the 5-series (single-digit version)", () => {
		expect(baseKeyToLabel("anthropic.claude-opus-5")).toBe("Claude Opus 5");
		expect(baseKeyToLabel("anthropic.claude-sonnet-5")).toBe("Claude Sonnet 5");
		expect(baseKeyToLabel("anthropic.claude-fable-5")).toBe("Claude Fable 5");
	});

	it("converts anthropic.claude-3-7-sonnet", () => {
		// Strips date suffix, then humanizes
		expect(baseKeyToLabel("anthropic.claude-3-7-sonnet-20250219")).toBe("Claude 3.7 Sonnet");
	});

	it("converts deepseek.r1", () => {
		expect(baseKeyToLabel("deepseek.r1")).toBe("R1");
	});

	it("humanizes newly-registered non-Anthropic base keys", () => {
		// Documents current behavior (the Meta label quirk matches existing Llama 4 entries).
		expect(baseKeyToLabel("meta.llama3-3-70b-instruct")).toBe("Llama3 3 70b Instruct");
		expect(baseKeyToLabel("meta.llama3-1-8b-instruct")).toBe("Llama3 1 8b Instruct");
		expect(baseKeyToLabel("mistral.pixtral-large-2502")).toBe("Pixtral Large 2502");
		expect(baseKeyToLabel("writer.palmyra-x5")).toBe("Palmyra X5");
		expect(baseKeyToLabel("amazon.nova-2-lite")).toBe("Nova 2 Lite");
	});

	it("handles id without provider prefix", () => {
		expect(baseKeyToLabel("claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
	});
});

// ---------------------------------------------------------------------------
// formatContextLabel
// ---------------------------------------------------------------------------

describe("formatContextLabel", () => {
	it("returns null for null", () => {
		expect(formatContextLabel(null)).toBeNull();
	});

	it("returns null for undefined", () => {
		expect(formatContextLabel(undefined)).toBeNull();
	});

	it("returns null for 128K default", () => {
		expect(formatContextLabel(128_000)).toBeNull();
	});

	it("returns '200K' for 200_000", () => {
		expect(formatContextLabel(200_000)).toBe("200K");
	});

	it("returns '1M' for 1_000_000", () => {
		expect(formatContextLabel(1_000_000)).toBe("1M");
	});

	it("returns '300K' for 300_000", () => {
		expect(formatContextLabel(300_000)).toBe("300K");
	});
});

// ---------------------------------------------------------------------------
// parseOptionValue / buildOptionValue
// ---------------------------------------------------------------------------

describe("parseOptionValue", () => {
	it("returns plain model ID for non-extended value", () => {
		const result = parseOptionValue("us.anthropic.claude-sonnet-4-6");
		expect(result).toEqual({ modelId: "us.anthropic.claude-sonnet-4-6", isExtendedContext: false });
	});

	it("strips ::1m suffix and sets isExtendedContext true", () => {
		const result = parseOptionValue("us.anthropic.claude-sonnet-4-6::1m");
		expect(result).toEqual({ modelId: "us.anthropic.claude-sonnet-4-6", isExtendedContext: true });
	});
});

describe("buildOptionValue", () => {
	it("returns plain model ID when not extended", () => {
		expect(buildOptionValue("us.anthropic.claude-sonnet-4-6", false)).toBe(
			"us.anthropic.claude-sonnet-4-6"
		);
	});

	it("appends ::1m when extended", () => {
		expect(buildOptionValue("us.anthropic.claude-sonnet-4-6", true)).toBe(
			"us.anthropic.claude-sonnet-4-6::1m"
		);
	});
});

// ---------------------------------------------------------------------------
// groupModels
// ---------------------------------------------------------------------------

describe("groupModels", () => {
	it("groups Bedrock models by base key", () => {
		const models: ModelInfo[] = [
			{ id: "us.anthropic.claude-sonnet-4-6", display_name: "us.anthropic.claude-sonnet-4-6", context_window: 200_000 },
			{ id: "eu.anthropic.claude-sonnet-4-6", display_name: "eu.anthropic.claude-sonnet-4-6", context_window: 200_000 },
		];

		const groups = groupModels(models);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.key).toBe("anthropic.claude-sonnet-4-6");
		expect(groups[0]!.label).toBe("Claude Sonnet 4.6");
		// 2 base + 2 extended (since these models have extended_context metadata)
		expect(groups[0]!.variants.length).toBe(4);
	});

	it("synthesizes 1M variants for models with extended_context metadata", () => {
		const models: ModelInfo[] = [
			{ id: "us.anthropic.claude-sonnet-4-6", display_name: "us.anthropic.claude-sonnet-4-6", context_window: 200_000 },
		];

		const groups = groupModels(models);
		const variants = groups[0]!.variants;

		// Should have base + extended
		expect(variants).toHaveLength(2);

		const baseVariant = variants.find((v) => !v.isExtendedContext);
		const extVariant = variants.find((v) => v.isExtendedContext);

		expect(baseVariant).toBeDefined();
		expect(baseVariant!.optionValue).toBe("us.anthropic.claude-sonnet-4-6");
		expect(baseVariant!.contextLabel).toBe("200K");

		expect(extVariant).toBeDefined();
		expect(extVariant!.optionValue).toBe("us.anthropic.claude-sonnet-4-6::1m");
		expect(extVariant!.contextLabel).toBe("1M");
		expect(extVariant!.model.context_window).toBe(1_000_000);
	});

	it("synthesizes a 1M variant for Opus 5 (real extended_context metadata)", () => {
		const models: ModelInfo[] = [
			{ id: "us.anthropic.claude-opus-5", display_name: "us.anthropic.claude-opus-5", context_window: 200_000 },
			{ id: "global.anthropic.claude-opus-5", display_name: "global.anthropic.claude-opus-5", context_window: 200_000 },
		];

		const groups = groupModels(models);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.key).toBe("anthropic.claude-opus-5");
		expect(groups[0]!.label).toBe("Claude Opus 5");
		// 2 base + 2 synthesized 1M variants
		expect(groups[0]!.variants.length).toBe(4);

		const ext = groups[0]!.variants.find((v) => v.isExtendedContext && v.region === "US");
		expect(ext).toBeDefined();
		expect(ext!.optionValue).toBe("us.anthropic.claude-opus-5::1m");
		expect(ext!.contextLabel).toBe("1M");
		expect(ext!.model.context_window).toBe(1_000_000);
	});

	it("synthesizes a 1M variant for Opus 4.7 (real extended_context metadata)", () => {
		const models: ModelInfo[] = [
			{ id: "us.anthropic.claude-opus-4-7", display_name: "us.anthropic.claude-opus-4-7", context_window: 200_000 },
			{ id: "global.anthropic.claude-opus-4-7", display_name: "global.anthropic.claude-opus-4-7", context_window: 200_000 },
		];

		const groups = groupModels(models);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.key).toBe("anthropic.claude-opus-4-7");
		expect(groups[0]!.label).toBe("Claude Opus 4.7");
		// 2 base + 2 synthesized 1M variants
		expect(groups[0]!.variants.length).toBe(4);

		const ext = groups[0]!.variants.find((v) => v.isExtendedContext && v.region === "US");
		expect(ext).toBeDefined();
		expect(ext!.optionValue).toBe("us.anthropic.claude-opus-4-7::1m");
		expect(ext!.contextLabel).toBe("1M");
		expect(ext!.model.context_window).toBe(1_000_000);
	});

	it("does not synthesize 1M for models without extended_context", () => {
		const models: ModelInfo[] = [
			{ id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", display_name: "us.anthropic.claude-haiku-4-5-20251001-v1:0", context_window: 200_000 },
		];

		const groups = groupModels(models);
		expect(groups[0]!.variants).toHaveLength(1);
		expect(groups[0]!.variants[0]!.isExtendedContext).toBe(false);
	});

	it("places non-Bedrock models in single-variant groups", () => {
		const models: ModelInfo[] = [
			{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", context_window: 200_000 },
		];

		const groups = groupModels(models);
		expect(groups).toHaveLength(1);
		expect(groups[0]!.variants).toHaveLength(1);
		expect(groups[0]!.variants[0]!.region).toBeNull();
	});

	it("sorts groups alphabetically by label", () => {
		const models: ModelInfo[] = [
			{ id: "us.amazon.nova-pro-v1:0", display_name: "us.amazon.nova-pro-v1:0", context_window: 300_000 },
			{ id: "us.anthropic.claude-sonnet-4-6", display_name: "us.anthropic.claude-sonnet-4-6", context_window: 200_000 },
		];

		const groups = groupModels(models);
		expect(groups[0]!.label).toBe("Claude Sonnet 4.6");
		expect(groups[1]!.label).toBe("Nova Pro");
	});

	it("sorts variants: highest context first, then region alphabetical", () => {
		const models: ModelInfo[] = [
			{ id: "eu.anthropic.claude-sonnet-4-6", display_name: "eu.anthropic.claude-sonnet-4-6", context_window: 200_000 },
			{ id: "us.anthropic.claude-sonnet-4-6", display_name: "us.anthropic.claude-sonnet-4-6", context_window: 200_000 },
		];

		const groups = groupModels(models);
		const variants = groups[0]!.variants;

		// 1M variants first (context descending), then 200K
		expect(variants[0]!.isExtendedContext).toBe(true);
		expect(variants[1]!.isExtendedContext).toBe(true);
		expect(variants[2]!.isExtendedContext).toBe(false);
		expect(variants[3]!.isExtendedContext).toBe(false);

		// Within same context, alphabetical by region
		expect(variants[0]!.region).toBe("EU");
		expect(variants[1]!.region).toBe("US");
		expect(variants[2]!.region).toBe("EU");
		expect(variants[3]!.region).toBe("US");
	});
});

// ---------------------------------------------------------------------------
// formatVariantLabel
// ---------------------------------------------------------------------------

describe("formatVariantLabel", () => {
	it("formats region + context", () => {
		const label = formatVariantLabel({
			model: { id: "test", display_name: "test", context_window: 200_000 },
			region: "US",
			contextLabel: "200K",
			isExtendedContext: false,
			optionValue: "test",
		});
		expect(label).toBe("US — 200K");
	});

	it("formats region + context + beta for extended", () => {
		const label = formatVariantLabel({
			model: { id: "test", display_name: "test", context_window: 1_000_000 },
			region: "US",
			contextLabel: "1M",
			isExtendedContext: true,
			optionValue: "test::1m",
		});
		expect(label).toBe("US — 1M — (beta)");
	});

	it("formats region only when no context label", () => {
		const label = formatVariantLabel({
			model: { id: "test", display_name: "test" },
			region: "US",
			contextLabel: null,
			isExtendedContext: false,
			optionValue: "test",
		});
		expect(label).toBe("US");
	});

	it("falls back to model id when no region or context", () => {
		const label = formatVariantLabel({
			model: { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
			region: null,
			contextLabel: null,
			isExtendedContext: false,
			optionValue: "claude-sonnet-4-6",
		});
		expect(label).toBe("claude-sonnet-4-6");
	});
});

// ---------------------------------------------------------------------------
// formatFullVariantLabel
// ---------------------------------------------------------------------------

describe("formatFullVariantLabel", () => {
	const group = {
		label: "Claude Opus 4.8",
		key: "anthropic.claude-opus-4-8",
		variants: [],
	};

	it("prefixes the model name onto region + context", () => {
		const label = formatFullVariantLabel(group, {
			model: { id: "us.anthropic.claude-opus-4-8", display_name: "test", context_window: 200_000 },
			region: "US",
			contextLabel: "200K",
			isExtendedContext: false,
			optionValue: "us.anthropic.claude-opus-4-8",
		});
		expect(label).toBe("Claude Opus 4.8 · US — 200K");
	});

	it("prefixes the model name onto extended-context variants", () => {
		const label = formatFullVariantLabel(group, {
			model: { id: "us.anthropic.claude-opus-4-8", display_name: "test", context_window: 1_000_000 },
			region: "US",
			contextLabel: "1M",
			isExtendedContext: true,
			optionValue: "us.anthropic.claude-opus-4-8::1m",
		});
		expect(label).toBe("Claude Opus 4.8 · US — 1M — (beta)");
	});

	it("prefixes the model name onto a region-only variant", () => {
		const label = formatFullVariantLabel(group, {
			model: { id: "global.anthropic.claude-opus-4-8", display_name: "test" },
			region: "Global",
			contextLabel: null,
			isExtendedContext: false,
			optionValue: "global.anthropic.claude-opus-4-8",
		});
		expect(label).toBe("Claude Opus 4.8 · Global");
	});

	it("shows just the model name when the variant has no suffix", () => {
		const label = formatFullVariantLabel(group, {
			model: { id: "anthropic.claude-opus-4-8", display_name: "Claude Opus 4.8" },
			region: null,
			contextLabel: null,
			isExtendedContext: false,
			optionValue: "anthropic.claude-opus-4-8",
		});
		expect(label).toBe("Claude Opus 4.8");
	});
});
