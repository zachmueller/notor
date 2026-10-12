import { describe, it, expect, vi } from "vitest";

vi.mock("../providers/model-metadata", () => ({
	getModelExtendedContext: (modelId: string) =>
		modelId === "has-1m" ? { context_window: 1_000_000, beta_flag: "context-1m" } : undefined,
}));

import {
	describeSelection,
	normalizeSelection,
	readSelection,
	selectionsEqual,
	writeSelection,
	type ModelSelection,
	type SelectionRegistry,
} from "./model-selection";
import type { LLMProviderConfig } from "../types";

const configs: Record<string, Partial<LLMProviderConfig>> = {
	"bedrock-work": { id: "bedrock-work", type: "bedrock", display_name: "Bedrock (work)" },
	anthropic: { id: "anthropic", type: "anthropic", display_name: "Anthropic" },
};

const registry: SelectionRegistry = {
	getConfig: (id) => configs[id] as LLMProviderConfig | undefined,
	resolveTypeToId: (type) => Object.values(configs).find((c) => c.type === type)?.id ?? null,
};

const sel = (over: Partial<ModelSelection> = {}): ModelSelection => ({
	providerId: "anthropic",
	modelId: "has-1m",
	useExtendedContext: false,
	thinkingLevel: null,
	presetName: null,
	...over,
});

describe("readSelection / writeSelection", () => {
	it("round-trips the five header fields", () => {
		const conv = { provider_id: "x", model_id: "y" } as Parameters<typeof writeSelection>[0];
		const s = sel({ useExtendedContext: true, thinkingLevel: "high", presetName: "large" });
		writeSelection(conv, s);
		expect(readSelection(conv)).toEqual(s);
	});

	it("defaults missing optional fields", () => {
		expect(readSelection({ provider_id: "p", model_id: "m" })).toEqual({
			providerId: "p", modelId: "m", useExtendedContext: false, thinkingLevel: null, presetName: null,
		});
	});
});

describe("normalizeSelection", () => {
	it("maps a bare provider type to its configured instance id", () => {
		expect(normalizeSelection(sel({ providerId: "bedrock" }), registry).providerId).toBe("bedrock-work");
	});

	it("keeps an instance id and an unknown id as-is", () => {
		expect(normalizeSelection(sel({ providerId: "anthropic" }), registry).providerId).toBe("anthropic");
		expect(normalizeSelection(sel({ providerId: "gone" }), registry).providerId).toBe("gone");
	});

	it("drops the 1M flag for a model without a separate extended variant", () => {
		expect(normalizeSelection(sel({ modelId: "no-1m", useExtendedContext: true }), registry).useExtendedContext).toBe(false);
		expect(normalizeSelection(sel({ modelId: "has-1m", useExtendedContext: true }), registry).useExtendedContext).toBe(true);
	});
});

describe("selectionsEqual", () => {
	it("compares every field, treating undefined thinking/preset as null", () => {
		expect(selectionsEqual(sel(), sel())).toBe(true);
		expect(selectionsEqual(sel(), sel({ thinkingLevel: undefined as unknown as null }))).toBe(true);
		expect(selectionsEqual(sel(), sel({ modelId: "other" }))).toBe(false);
		expect(selectionsEqual(sel(), sel({ presetName: "large" }))).toBe(false);
	});
});

describe("describeSelection", () => {
	it("uses the provider display name and labels Custom when no preset", () => {
		expect(describeSelection(sel(), registry)).toBe("Anthropic · has-1m (Custom)");
	});

	it("includes 1M, thinking and the preset name", () => {
		expect(describeSelection(sel({ useExtendedContext: true, thinkingLevel: "high", presetName: "large" }), registry))
			.toBe("Anthropic · has-1m · 1M · thinking high (large)");
	});
});
