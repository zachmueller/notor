import { describe, it, expect, vi } from "vitest";
import type { CircuitHost } from "../host";
import type { Circuit } from "../types";
import { evaluateUnevaluatedSessions, selectScheduledSessions } from "./scheduled";
import type { EvaluableSession } from "./session-listing";
import type { EvalPassResult } from "./types";

function candidate(id: string): EvaluableSession {
	return { sessionId: id, status: "completed", startedAt: "t", origin: "user", parentSessionId: null, objective: "", costUsd: 0, alreadyEvaluated: false, lastEvaluatedAt: null, passCount: 0 };
}

const host = {} as CircuitHost;
const circuit = { name: "Demo", evaluators: [{ name: "j" }] } as unknown as Circuit;

function pass(ids: string[]): EvalPassResult {
	return {
		passId: "p",
		circuit: "Demo",
		trigger: "schedule",
		startedAt: "t",
		finishedAt: "t",
		fingerprint: "fp",
		maxCostUsd: 1,
		totalCostUsd: 0.5,
		sessions: ids.map((sessionId, i) => ({
			sessionId,
			meta: null,
			outcome: null,
			outcomes: [{ evaluator: "j", mode: "conversation" as const, ok: i === 0, scores: {}, rationale: "", overall: null, costUsd: 0, modelId: null, reason: "error" as const, detail: "" }] as EvalPassResult["sessions"][number]["outcomes"],
			skipped: null,
			reportPath: null,
		})),
	};
}

describe("selectScheduledSessions", () => {
	it("takes the newest N (the list is already newest first)", () => {
		const ids = selectScheduledSessions([candidate("a"), candidate("b"), candidate("c")], 2);
		expect(ids).toEqual(["a", "b"]);
		expect(selectScheduledSessions([candidate("a")])).toEqual(["a"]);
		expect(selectScheduledSessions([candidate("a")], 0)).toEqual([]);
	});
});

describe("evaluateUnevaluatedSessions", () => {
	it("evaluates the pending sessions with trigger schedule and notifies", async () => {
		const evaluate = vi.fn(async (_h: CircuitHost, _c: Circuit, ids: readonly string[]) => pass([...ids]));
		const notify = vi.fn();
		const result = await evaluateUnevaluatedSessions(host, circuit, {
			maxSessions: 2,
			deps: { listCandidates: async () => [candidate("a"), candidate("b"), candidate("c")], evaluate, notify },
		});
		expect(evaluate).toHaveBeenCalledWith(host, circuit, ["a", "b"], { trigger: "schedule" });
		expect(result?.sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
		expect(notify).toHaveBeenCalledWith(expect.stringMatching(/Scheduled evaluation of 'Demo': 2 sessions · 1 scored, 1 failed/));
	});

	it("returns null without evaluating when nothing is pending or the circuit has no evaluators", async () => {
		const evaluate = vi.fn(async () => pass([]));
		expect(await evaluateUnevaluatedSessions(host, circuit, { deps: { listCandidates: async () => [], evaluate } })).toBeNull();
		expect(await evaluateUnevaluatedSessions(host, { ...circuit, evaluators: [] } as Circuit, { deps: { listCandidates: async () => [candidate("a")], evaluate } })).toBeNull();
		expect(evaluate).not.toHaveBeenCalled();
	});
});
