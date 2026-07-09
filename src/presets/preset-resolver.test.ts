import { describe, it, expect } from "vitest";
import { resolveConversationModel } from "./preset-resolver";
import type { ModelPreset } from "../types";

const presets: ModelPreset[] = [
	{ name: "large", provider_id: "bedrock", model_id: "global.anthropic.claude-opus-4-8", use_extended_context: true, thinking_level: "medium" },
	{ name: "small", provider_id: "bedrock", model_id: "global.anthropic.claude-haiku-4-5-20251001-v1:0", use_extended_context: false, thinking_level: null },
];

const allAccessible = () => true;

describe("resolveConversationModel", () => {
	describe("preset source", () => {
		it("resolves a stored preset name to its current definition (incl. thinking level)", () => {
			const res = resolveConversationModel(
				{ preset_name: "large", provider_id: "bedrock", model_id: "stale-model", use_extended_context: false },
				presets,
				"small",
				allAccessible,
			);
			expect(res).toEqual({
				presetName: "large",
				providerId: "bedrock",
				modelId: "global.anthropic.claude-opus-4-8",
				useExtendedContext: true,
				thinkingLevel: "medium",
				source: "preset",
			});
		});
	});

	describe("stored source", () => {
		// Regression: reopening a preset-less conversation must PRESERVE its
		// persisted thinking_level, not zero it (the old branch hardcoded null).
		it("carries the conversation's persisted thinking_level", () => {
			const res = resolveConversationModel(
				{ preset_name: null, provider_id: "bedrock", model_id: "global.anthropic.claude-opus-4-8", use_extended_context: true, thinking_level: "high" },
				presets,
				"small",
				allAccessible,
			);
			expect(res).toMatchObject({
				presetName: null,
				providerId: "bedrock",
				modelId: "global.anthropic.claude-opus-4-8",
				useExtendedContext: true,
				thinkingLevel: "high",
				source: "stored",
			});
		});

		it("defaults thinkingLevel to null when the header has none", () => {
			const res = resolveConversationModel(
				{ preset_name: null, provider_id: "bedrock", model_id: "m", use_extended_context: false },
				presets,
				"small",
				allAccessible,
			);
			expect(res?.thinkingLevel).toBeNull();
			expect(res?.source).toBe("stored");
		});
	});

	describe("default source", () => {
		// Provider no longer accessible → fall back to the default preset.
		it("falls back to the default preset when the stored provider is gone", () => {
			const res = resolveConversationModel(
				{ preset_name: null, provider_id: "removed-provider", model_id: "m", use_extended_context: false, thinking_level: "high" },
				presets,
				"large",
				(pid) => pid === "bedrock",
			);
			expect(res).toMatchObject({
				presetName: "large",
				thinkingLevel: "medium",
				source: "default",
			});
		});
	});
});
