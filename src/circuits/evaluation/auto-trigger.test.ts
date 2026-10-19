import { describe, it, expect, vi } from "vitest";
import { maybeAutoEvaluate, shouldAutoEvaluate } from "./auto-trigger";
import type { CircuitHost } from "../host";
import type { Circuit } from "../types";
import type { EvalPassResult } from "./types";

describe("shouldAutoEvaluate", () => {
	it.each([
		["none", "completed", null, 1, false],
		["complete", "completed", null, 1, true],
		["complete", "error", null, 1, false],
		["complete", "cancelled", null, 1, false],
		["error", "error", null, 1, true],
		["error", "completed", null, 1, false],
		["both", "completed", null, 1, true],
		["both", "error", null, 1, true],
		["both", "cancelled", null, 1, false],
		["both", "completed", "parent-1", 1, false],
		["both", "completed", null, 0, false],
	] as const)("evalAuto=%s status=%s parent=%s evaluators=%d → %s", (evalAuto, status, parent, count, expected) => {
		expect(shouldAutoEvaluate(evalAuto, status, parent, count)).toBe(expected);
	});
});

describe("maybeAutoEvaluate", () => {
	const host = {} as CircuitHost;
	const flow = { name: "Demo", evalAuto: "complete", evaluators: [{ name: "j" }] } as unknown as Circuit;
	const pass = (over: Partial<EvalPassResult["sessions"][number]> = {}): EvalPassResult => ({
		passId: "p",
		circuit: "Demo",
		trigger: "auto",
		startedAt: "t",
		finishedAt: "t",
		fingerprint: "fp",
		maxCostUsd: 1,
		totalCostUsd: 0.2,
		sessions: [{ sessionId: "s1", meta: null, outcome: null, outcomes: [], skipped: null, reportPath: null, ...over }],
	});

	it("evaluates the finished root session with trigger auto", async () => {
		const evaluate = vi.fn(async () => pass());
		await maybeAutoEvaluate(host, flow, "s1", { status: "completed" }, null, { evaluate });
		expect(evaluate).toHaveBeenCalledWith(host, flow, ["s1"], { trigger: "auto" });
	});

	it("does nothing for children, for non-matching statuses, or when evalAuto is none", async () => {
		const evaluate = vi.fn(async () => pass());
		await maybeAutoEvaluate(host, flow, "s1", { status: "completed" }, "parent", { evaluate });
		await maybeAutoEvaluate(host, flow, "s1", { status: "error" }, null, { evaluate });
		await maybeAutoEvaluate(host, { ...flow, evalAuto: "none" } as Circuit, "s1", { status: "completed" }, null, { evaluate });
		expect(evaluate).not.toHaveBeenCalled();
	});

	it("never rejects when the pass throws", async () => {
		const evaluate = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(maybeAutoEvaluate(host, flow, "s1", { status: "completed" }, null, { evaluate })).resolves.toBeUndefined();
	});
});
