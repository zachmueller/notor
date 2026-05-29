import { describe, it, expect } from "vitest";
import { resolveAnthropicThinking } from "./thinking-config";
import { supportsEffortThinking } from "./model-metadata";

describe("resolveAnthropicThinking", () => {
	describe("effort models (Opus 4.8)", () => {
		it("maps named level to adaptive + matching effort (direct id)", () => {
			expect(resolveAnthropicThinking("high", "claude-opus-4-8")).toEqual({
				thinking: { type: "adaptive" },
				effort: "high",
			});
		});

		it("maps named level to adaptive + effort for all regional Bedrock ids", () => {
			const ids = [
				"us.anthropic.claude-opus-4-8",
				"eu.anthropic.claude-opus-4-8",
				"apac.anthropic.claude-opus-4-8",
				"global.anthropic.claude-opus-4-8",
			];
			for (const id of ids) {
				expect(resolveAnthropicThinking("medium", id)).toEqual({
					thinking: { type: "adaptive" },
					effort: "medium",
				});
			}
		});

		it("maps a custom integer budget to adaptive + effort:medium (regression: must NOT be enabled)", () => {
			expect(resolveAnthropicThinking("8000", "global.anthropic.claude-opus-4-8")).toEqual({
				thinking: { type: "adaptive" },
				effort: "medium",
			});
		});

		it("returns undefined for off", () => {
			expect(resolveAnthropicThinking("off", "claude-opus-4-8")).toBeUndefined();
		});
	});

	describe("adaptive-only models (Opus/Sonnet 4.6)", () => {
		it("returns adaptive with no effort field", () => {
			const result = resolveAnthropicThinking("high", "us.anthropic.claude-opus-4-6-v1");
			expect(result).toEqual({ thinking: { type: "adaptive" } });
			expect(result?.effort).toBeUndefined();
		});

		it("returns adaptive (no effort) for Sonnet 4.6", () => {
			const result = resolveAnthropicThinking("medium", "us.anthropic.claude-sonnet-4-6");
			expect(result).toEqual({ thinking: { type: "adaptive" } });
			expect(result?.effort).toBeUndefined();
		});
	});

	describe("enabled models (Opus 4.0, 3.7 Sonnet)", () => {
		it("maps named level to enabled + budget_tokens", () => {
			expect(resolveAnthropicThinking("high", "claude-opus-4-20250514")).toEqual({
				thinking: { type: "enabled", budget_tokens: 16384 },
			});
		});

		it("maps low to budget 1024 for 3.7 Sonnet", () => {
			expect(
				resolveAnthropicThinking("low", "us.anthropic.claude-3-7-sonnet-20250219-v1:0"),
			).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
		});

		it("maps a custom integer to enabled with that budget", () => {
			expect(resolveAnthropicThinking("5000", "claude-opus-4-20250514")).toEqual({
				thinking: { type: "enabled", budget_tokens: 5000 },
			});
		});
	});

	describe("disabled / invalid", () => {
		it("returns undefined for off", () => {
			expect(resolveAnthropicThinking("off", "claude-opus-4-20250514")).toBeUndefined();
		});

		it("returns undefined for null", () => {
			expect(resolveAnthropicThinking(null, "claude-opus-4-20250514")).toBeUndefined();
		});

		it("returns undefined for undefined", () => {
			expect(resolveAnthropicThinking(undefined, "claude-opus-4-20250514")).toBeUndefined();
		});
	});
});

describe("supportsEffortThinking", () => {
	it("is true for Opus 4.8 direct and all regional ids", () => {
		expect(supportsEffortThinking("claude-opus-4-8")).toBe(true);
		expect(supportsEffortThinking("us.anthropic.claude-opus-4-8")).toBe(true);
		expect(supportsEffortThinking("eu.anthropic.claude-opus-4-8")).toBe(true);
		expect(supportsEffortThinking("apac.anthropic.claude-opus-4-8")).toBe(true);
		expect(supportsEffortThinking("global.anthropic.claude-opus-4-8")).toBe(true);
	});

	it("is false for Opus 4.6 and Opus 4.0", () => {
		expect(supportsEffortThinking("us.anthropic.claude-opus-4-6-v1")).toBe(false);
		expect(supportsEffortThinking("claude-opus-4-6")).toBe(false);
		expect(supportsEffortThinking("claude-opus-4-20250514")).toBe(false);
	});
});
