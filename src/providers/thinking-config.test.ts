import { describe, it, expect } from "vitest";
import { resolveAnthropicThinking } from "./thinking-config";
import { getThinkingMode, getThinkingCapability, supportsThinking } from "./model-metadata";

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

	describe("4.6 models (Opus/Sonnet 4.6) — enabled + budget (visible thinking)", () => {
		it("maps high to enabled budget 16384 for Opus 4.6", () => {
			expect(resolveAnthropicThinking("high", "us.anthropic.claude-opus-4-6-v1")).toEqual({
				thinking: { type: "enabled", budget_tokens: 16384 },
			});
		});

		it("maps medium to enabled budget 4096 for Sonnet 4.6", () => {
			expect(resolveAnthropicThinking("medium", "us.anthropic.claude-sonnet-4-6")).toEqual({
				thinking: { type: "enabled", budget_tokens: 4096 },
			});
		});

		// Regression guard: 4.6 must NOT route through adaptive (adaptive returns
		// encrypted reasoning on Bedrock, which renders no visible thinking text).
		it("never returns adaptive for 4.6", () => {
			const result = resolveAnthropicThinking("high", "us.anthropic.claude-sonnet-4-6");
			expect(result?.thinking.type).toBe("enabled");
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

	describe("5-series (Fable 5 / Sonnet 5 / Opus 5) — adaptive + effort", () => {
		// Live Bedrock converse probe (us-west-2, 2026-07): all three 5-series
		// profiles REJECT thinking.type=enabled with "not supported ... Use
		// thinking.type.adaptive and output_config.effort", so they resolve to
		// adaptive + effort exactly like Opus 4.8 — NOT to an undefined/no-op payload.
		it("maps a level to adaptive + effort for Claude Fable 5", () => {
			expect(resolveAnthropicThinking("high", "global.anthropic.claude-fable-5")).toEqual({
				thinking: { type: "adaptive" },
				effort: "high",
			});
			expect(resolveAnthropicThinking("medium", "claude-fable-5")).toEqual({
				thinking: { type: "adaptive" },
				effort: "medium",
			});
		});
	});

	describe("unknown / unsupported models (mode:none)", () => {
		// A model outside THINKING_PATTERNS must emit NO thinking payload, even with
		// a level set — guessing a dialect risks a provider rejection.
		it("returns undefined for a wholly unknown model with a level set", () => {
			expect(resolveAnthropicThinking("high", "some-unknown-model-v9")).toBeUndefined();
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

describe("getThinkingMode", () => {
	// Closed-set boundary: this is the guard for the one-time legacy classification.
	it("is 'effort' for Opus 4.8 direct + all regional ids", () => {
		expect(getThinkingMode("claude-opus-4-8")).toBe("effort");
		expect(getThinkingMode("us.anthropic.claude-opus-4-8")).toBe("effort");
		expect(getThinkingMode("eu.anthropic.claude-opus-4-8")).toBe("effort");
		expect(getThinkingMode("apac.anthropic.claude-opus-4-8")).toBe("effort");
		expect(getThinkingMode("global.anthropic.claude-opus-4-8")).toBe("effort");
	});

	it("is 'enabled' for the entire legacy set (3.5/3.7, 4.0, 4.5, 4.6)", () => {
		const legacy = [
			// 3.5 / 3.7 Sonnet
			"claude-3-5-sonnet-20240620",
			"claude-3-5-sonnet-20241022",
			"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			"claude-3-7-sonnet-20250219",
			"eu.anthropic.claude-3-7-sonnet-20250219-v1:0",
			// 4.0 (dated)
			"claude-sonnet-4-20250514",
			"claude-opus-4-20250514",
			"us.anthropic.claude-sonnet-4-20250514-v1:0",
			"global.anthropic.claude-opus-4-20250514-v1:0",
			// 4.1 (dated) — visible transcript confirmed by live Bedrock probe
			"claude-opus-4-1-20250805",
			"us.anthropic.claude-opus-4-1-20250805-v1:0",
			"global.anthropic.claude-opus-4-1-20250805-v1:0",
			// 4.5 — Sonnet 4.5 and Opus 4.5 (Opus 4.5 visible transcript confirmed
			// by live Bedrock probe: reasoningText.text populated, 332 chars)
			"claude-sonnet-4-5-20250929",
			"apac.anthropic.claude-sonnet-4-5-20250929-v1:0",
			"claude-opus-4-5",
			"us.anthropic.claude-opus-4-5-20251101-v1:0",
			"global.anthropic.claude-opus-4-5-20251101-v1:0",
			// 4.6
			"claude-opus-4-6",
			"claude-sonnet-4-6",
			"us.anthropic.claude-opus-4-6-v1",
			"global.anthropic.claude-opus-4-6-v1",
			"us.anthropic.claude-sonnet-4-6",
			"eu.anthropic.claude-sonnet-4-6",
			"apac.anthropic.claude-sonnet-4-6",
			"global.anthropic.claude-sonnet-4-6",
		];
		for (const id of legacy) {
			expect(getThinkingMode(id)).toBe("enabled");
		}
	});

	// Regression: Opus 4.1 predates the adaptive era and serves a VISIBLE reasoning
	// transcript on Bedrock (live converse probe: accepts thinking.type=enabled,
	// returns reasoningContent text), so it must classify "enabled". Opus 4.7/4.8
	// reject thinking.type=enabled and must stay "effort" — the 4.1 regex must not
	// bleed into them.
	it("is 'enabled' for Opus 4.1 but 'effort' for 4.7/4.8 (closed-set boundary)", () => {
		expect(getThinkingMode("claude-opus-4-1-20250805")).toBe("enabled");
		expect(getThinkingMode("us.anthropic.claude-opus-4-1-20250805-v1:0")).toBe("enabled");
		expect(getThinkingMode("global.anthropic.claude-opus-4-1-20250805-v1:0")).toBe("enabled");
		expect(getThinkingMode("us.anthropic.claude-opus-4-7")).toBe("effort");
		expect(getThinkingMode("global.anthropic.claude-opus-4-7")).toBe("effort");
		expect(getThinkingMode("us.anthropic.claude-opus-4-8")).toBe("effort");
	});

	// Default: any unrecognized / future model id is treated as effort by design,
	// so new adaptive models work without a code change.
	it("defaults to 'effort' for an unknown/future model id", () => {
		expect(getThinkingMode("claude-opus-5-0")).toBe("effort");
		expect(getThinkingMode("global.anthropic.claude-sonnet-5-0")).toBe("effort");
	});

	// The 5-series (Opus 5 / Sonnet 5 / Fable 5) rejects legacy thinking.type=enabled
	// and serves encrypted adaptive reasoning (live converse probe), so it must
	// classify "effort" — NOT the legacy "enabled" protocol.
	it("is 'effort' for the 5-series (Opus 5 / Sonnet 5 / Fable 5)", () => {
		const fiveSeries = [
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
			"us.anthropic.claude-opus-5",
			"global.anthropic.claude-opus-5",
			"us.anthropic.claude-sonnet-5",
			"global.anthropic.claude-sonnet-5",
			"us.anthropic.claude-fable-5",
			"global.anthropic.claude-fable-5",
		];
		for (const id of fiveSeries) {
			expect(getThinkingMode(id)).toBe("effort");
		}
	});
});

describe("supportsThinking", () => {
	// Regression: without the 5-series patterns, supportsThinking returned false
	// for Opus 5 / Sonnet 5 / Fable 5, so thinking was never offered at all.
	it("is true for the 5-series (direct + Bedrock ids)", () => {
		const fiveSeries = [
			"claude-opus-5",
			"claude-sonnet-5",
			"claude-fable-5",
			"us.anthropic.claude-opus-5",
			"global.anthropic.claude-opus-5",
			"us.anthropic.claude-sonnet-5",
			"global.anthropic.claude-sonnet-5",
			"us.anthropic.claude-fable-5",
			"global.anthropic.claude-fable-5",
		];
		for (const id of fiveSeries) {
			expect(supportsThinking(id)).toBe(true);
		}
	});

	// Opus 4.7 (effort) and Opus 4.5 (enabled) both support thinking — they must
	// not be missed just because they were newly added to the metadata table.
	it("is true for Opus 4.7 and Opus 4.5 Bedrock profiles", () => {
		expect(supportsThinking("us.anthropic.claude-opus-4-7")).toBe(true);
		expect(supportsThinking("global.anthropic.claude-opus-4-7")).toBe(true);
		expect(supportsThinking("us.anthropic.claude-opus-4-5-20251101-v1:0")).toBe(true);
		expect(supportsThinking("global.anthropic.claude-opus-4-5-20251101-v1:0")).toBe(true);
	});

	// Claude 3 Haiku / 3 Sonnet have no thinking support — the newly-registered
	// Bedrock profiles must NOT be offered reasoning.
	it("is false for Claude 3 Haiku / 3 Sonnet (no thinking)", () => {
		expect(supportsThinking("us.anthropic.claude-3-haiku-20240307-v1:0")).toBe(false);
		expect(supportsThinking("us.anthropic.claude-3-sonnet-20240229-v1:0")).toBe(false);
	});
});

describe("getThinkingCapability (single source of truth)", () => {
	it("classifies Opus 4.8 as supported effort", () => {
		expect(getThinkingCapability("claude-opus-4-8")).toEqual({ supported: true, mode: "effort" });
		expect(getThinkingCapability("global.anthropic.claude-opus-4-8")).toEqual({
			supported: true,
			mode: "effort",
		});
	});

	it("classifies the legacy set as supported enabled", () => {
		expect(getThinkingCapability("claude-3-7-sonnet-20250219")).toEqual({
			supported: true,
			mode: "enabled",
		});
		expect(getThinkingCapability("us.anthropic.claude-opus-4-6-v1")).toEqual({
			supported: true,
			mode: "enabled",
		});
	});

	// Claude Fable 5: supported adaptive/effort — live Bedrock probe (us-west-2,
	// 2026-07) confirmed it rejects thinking.type=enabled and serves adaptive
	// reasoning, so it classifies effort exactly like the rest of the 5-series.
	it("classifies Claude Fable 5 as supported effort", () => {
		expect(getThinkingCapability("global.anthropic.claude-fable-5")).toEqual({
			supported: true,
			mode: "effort",
		});
		expect(getThinkingCapability("claude-fable-5")).toEqual({ supported: true, mode: "effort" });
	});

	// A wholly unknown model id: NOT supported, mode none — the safe default.
	it("classifies unknown ids as unsupported none", () => {
		expect(getThinkingCapability("totally-unknown-model")).toEqual({
			supported: false,
			mode: "none",
		});
	});

	// Normalization: surrounding whitespace must not flip the classification, so a
	// model is gated identically no matter which code path supplied the id.
	it("normalizes surrounding whitespace before classifying", () => {
		expect(getThinkingCapability("  claude-opus-4-8  ")).toEqual({
			supported: true,
			mode: "effort",
		});
		expect(supportsThinking(" global.anthropic.claude-opus-4-6-v1 ")).toBe(true);
	});

	// supportsThinking (the UI gate) and getThinkingCapability.supported (the wire
	// decision) must always agree — they now share one implementation.
	it("keeps supportsThinking in lockstep with capability.supported", () => {
		for (const id of [
			"claude-opus-4-8",
			"claude-3-7-sonnet-20250219",
			"global.anthropic.claude-fable-5",
			"unknown-x",
		]) {
			expect(supportsThinking(id)).toBe(getThinkingCapability(id).supported);
		}
	});
});
