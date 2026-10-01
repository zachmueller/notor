import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	forgetModelLimit,
	getApiContextWindow,
	getContextOverride,
	getLearnedContextWindow,
	initModelLimits,
	isBetaRejected,
	listModelLimits,
	onModelLimitsChanged,
	recordApiModelLimits,
	recordBetaRejected,
	recordLearnedContextWindow,
	reportFallbackContextWindow,
	resetModelLimits,
	type ModelLimitsCache,
} from "./model-limits";

function init(opts: { cache?: unknown; overrides?: Record<string, number> } = {}) {
	const persist = vi.fn<(cache: ModelLimitsCache) => void>();
	const onFallback = vi.fn<(id: string) => void>();
	initModelLimits({
		cache: opts.cache,
		getOverrides: () => opts.overrides,
		persist,
		onFallbackContextWindow: onFallback,
	});
	return { persist, onFallback };
}

beforeEach(() => resetModelLimits());

describe("model-limits — persisted cache", () => {
	it("sanitizes a malformed cache, keeping only valid entries", () => {
		init({
			cache: {
				api: { good: { context_window: 1_000_000, updated_at: "t" }, bad: { context_window: "x" }, worse: 7 },
				learned: { m: { context_window: 200_000, source: "estimate" }, tiny: { context_window: 10 } },
				beta_rejected: { r: "2026-01-01", n: 5 },
			},
		});
		expect(getApiContextWindow("good")).toBe(1_000_000);
		expect(getApiContextWindow("bad")).toBeUndefined();
		expect(getLearnedContextWindow("m")).toBe(200_000);
		expect(getLearnedContextWindow("tiny")).toBeUndefined();
		expect(isBetaRejected("r")).toBe(true);
		expect(isBetaRejected("n")).toBe(false);
	});

	it("treats a non-object cache as empty", () => {
		init({ cache: "garbage" });
		expect(listModelLimits()).toEqual({ api: [], learned: [], betaRejected: [] });
	});
});

describe("model-limits — API limits", () => {
	it("persists a batch once, and not at all when nothing changed", () => {
		const { persist } = init();
		recordApiModelLimits([
			{ id: "claude-opus-5-5", max_input_tokens: 1_000_000, max_tokens: 128_000 },
			{ id: "claude-haiku-4-5", max_input_tokens: 200_000 },
			{ id: "no-limit", max_input_tokens: null },
		]);
		expect(persist).toHaveBeenCalledTimes(1);
		expect(getApiContextWindow("claude-opus-5-5")).toBe(1_000_000);
		expect(getApiContextWindow("no-limit")).toBeUndefined();

		recordApiModelLimits([{ id: "claude-opus-5-5", max_input_tokens: 1_000_000, max_tokens: 128_000 }]);
		expect(persist).toHaveBeenCalledTimes(1);

		recordApiModelLimits([{ id: "claude-opus-5-5", max_input_tokens: 900_000, max_tokens: 128_000 }]);
		expect(persist).toHaveBeenCalledTimes(2);
		expect(getApiContextWindow("claude-opus-5-5")).toBe(900_000);
	});
});

describe("model-limits — learned limits", () => {
	it("only ever lowers a learned limit", () => {
		const { persist } = init();
		expect(recordLearnedContextWindow("m", false, 200_000, "error")).toBe(true);
		expect(recordLearnedContextWindow("m", false, 300_000, "error")).toBe(false);
		expect(recordLearnedContextWindow("m", false, 200_000, "error")).toBe(false);
		expect(recordLearnedContextWindow("m", false, 150_000, "estimate")).toBe(true);
		expect(getLearnedContextWindow("m")).toBe(150_000);
		expect(persist).toHaveBeenCalledTimes(2);
	});

	it("tracks the standard and 1M variants separately", () => {
		init();
		recordLearnedContextWindow("m", true, 900_000, "error");
		expect(getLearnedContextWindow("m", true)).toBe(900_000);
		expect(getLearnedContextWindow("m", false)).toBeUndefined();
		expect(listModelLimits().learned[0]).toMatchObject({ key: "m::1m", modelId: "m", extended: true });
	});

	it("ignores values below the minimum", () => {
		init();
		expect(recordLearnedContextWindow("m", false, 100, "error")).toBe(false);
		expect(getLearnedContextWindow("m")).toBeUndefined();
	});
});

describe("model-limits — overrides", () => {
	it("prefers an id::1m override in extended mode and falls back to the bare id", () => {
		init({ overrides: { m: 500_000, "m::1m": 800_000, other: 300_000 } });
		expect(getContextOverride("m", false)).toBe(500_000);
		expect(getContextOverride("m", true)).toBe(800_000);
		expect(getContextOverride("other", true)).toBe(300_000);
		expect(getContextOverride("missing")).toBeUndefined();
	});

	it("ignores invalid override values", () => {
		init({ overrides: { tiny: 50, neg: -1, nan: Number.NaN } });
		expect(getContextOverride("tiny")).toBeUndefined();
		expect(getContextOverride("neg")).toBeUndefined();
		expect(getContextOverride("nan")).toBeUndefined();
	});
});

describe("model-limits — forget, listeners, beta rejection, fallback", () => {
	it("forgets an entry, persists and notifies listeners", () => {
		const { persist } = init();
		const listener = vi.fn();
		onModelLimitsChanged(listener);
		recordLearnedContextWindow("m", false, 200_000, "error");
		recordBetaRejected("b");
		expect(isBetaRejected("b")).toBe(true);
		expect(recordBetaRejected("b")).toBe(false);

		forgetModelLimit("learned", "m");
		forgetModelLimit("beta_rejected", "b");
		forgetModelLimit("learned", "absent");
		expect(getLearnedContextWindow("m")).toBeUndefined();
		expect(isBetaRejected("b")).toBe(false);
		expect(persist).toHaveBeenCalledTimes(4);
		expect(listener).toHaveBeenCalledTimes(4);
	});

	it("reports a fallback once per model id and never for an empty id", () => {
		const { onFallback } = init();
		reportFallbackContextWindow("mystery");
		reportFallbackContextWindow("mystery");
		reportFallbackContextWindow("  ");
		reportFallbackContextWindow("other");
		expect(onFallback.mock.calls).toEqual([["mystery"], ["other"]]);
	});

	it("works in memory without a host", () => {
		recordLearnedContextWindow("m", false, 200_000, "error");
		expect(getLearnedContextWindow("m")).toBe(200_000);
		expect(() => reportFallbackContextWindow("x")).not.toThrow();
	});
});
