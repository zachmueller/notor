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
		// The preset's current definition is only used when the stored provider
		// is gone — never to override what the header recorded.
		it("falls back to the stored preset's current definition when the stored provider is gone", () => {
			const res = resolveConversationModel(
				{ preset_name: "large", provider_id: "removed-provider", model_id: "stale-model", use_extended_context: false },
				presets,
				"small",
				(pid) => pid === "bedrock",
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

		it("falls back to the preset when the header has no model id", () => {
			const res = resolveConversationModel(
				{ preset_name: "small", provider_id: "bedrock", model_id: "" },
				presets,
				"large",
				allAccessible,
			);
			expect(res).toMatchObject({ presetName: "small", source: "preset" });
		});
	});

	describe("stored source", () => {
		// Regression (Quick Settings robustness): the JSONL header is the
		// authority. A preset whose definition drifted after the conversation
		// was saved — or a manual thinking tweak made under a preset — must not
		// change the model on reopen/next turn. The preset name is kept as a label.
		it("prefers the stored values over the preset's current definition and keeps the preset label", () => {
			const res = resolveConversationModel(
				{ preset_name: "large", provider_id: "bedrock", model_id: "stale-model", use_extended_context: false, thinking_level: "low" },
				presets,
				"small",
				allAccessible,
			);
			expect(res).toEqual({
				presetName: "large",
				providerId: "bedrock",
				modelId: "stale-model",
				useExtendedContext: false,
				thinkingLevel: "low",
				source: "stored",
			});
		});

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
