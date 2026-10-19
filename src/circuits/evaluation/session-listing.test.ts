import { describe, it, expect } from "vitest";
import type { Circuit } from "../types";
import { estimateEvalCeiling, listEvaluableSessions, type EvalSessionFs } from "./session-listing";

const TS = (n: number) => `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`;

function meta(id: string, over: Record<string, unknown> = {}) {
	return JSON.stringify({
		session_id: id,
		flow_name: "Demo",
		status: "completed",
		iteration: 1,
		active_step: null,
		started_at: TS(1),
		prompt: `objective ${id}`,
		parent_session_id: null,
		origin: "user",
		...over,
	});
}
function jsonl(entries: unknown[]) {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}
const runResult = (cost: number) =>
	jsonl([
		{ type: "session.complete", ts: TS(1) },
		{ type: "run.result", ts: TS(1), status: "completed", terminal_topic: "FLOW_COMPLETE", text: "", structured: null, cost_usd: cost, token_usage: { input: 0, output: 0 }, iterations: 1 },
	]);
const passLog = (fp: string, completeTs: string) =>
	jsonl([
		{ type: "eval.pass_start", ts: TS(2), pass_id: "p", circuit: "Demo", trigger: "manual", evaluators: [], evaluator_fingerprint: fp, max_cost_usd: 1 },
		{ type: "eval.pass_complete", ts: completeTs, pass_id: "p", cost_usd: 0, scored: 1, failed: 0 },
	]);

function fs(files: Record<string, { meta?: string; log?: string; evals?: string }>): EvalSessionFs {
	return {
		listSessions: async () => Object.keys(files),
		readMeta: async (id) => files[id]?.meta ?? null,
		readLog: async (id) => files[id]?.log ?? null,
		readEvals: async (id) => files[id]?.evals ?? null,
	};
}

describe("listEvaluableSessions", () => {
	it("lists finished root sessions of the circuit newest first, with cost and evaluation state", async () => {
		const sessions = await listEvaluableSessions(
			fs({
				old: { meta: meta("old", { started_at: TS(1) }), log: runResult(0.5), evals: passLog("fp-current", TS(3)) },
				newer: { meta: meta("newer", { started_at: TS(5), status: "error" }), log: runResult(0.25), evals: passLog("fp-stale", TS(6)) },
				active: { meta: meta("active", { started_at: TS(6), status: "active" }) },
				child: { meta: meta("child", { started_at: TS(7), parent_session_id: "newer" }), log: runResult(0.1) },
				other: { meta: meta("other", { flow_name: "Other", started_at: TS(8) }) },
				broken: { meta: "{not json" },
				nolog: { meta: meta("nolog", { started_at: TS(4), status: "cancelled" }) },
			}),
			"Demo",
			"fp-current",
		);
		expect(sessions.map((s) => s.sessionId)).toEqual(["newer", "nolog", "old"]);
		expect(sessions[0]).toMatchObject({ status: "error", costUsd: 0.25, alreadyEvaluated: false, lastEvaluatedAt: TS(6), passCount: 1, objective: "objective newer" });
		expect(sessions[1]).toMatchObject({ status: "cancelled", costUsd: null, alreadyEvaluated: false, passCount: 0 });
		expect(sessions[2]).toMatchObject({ status: "completed", costUsd: 0.5, alreadyEvaluated: true, lastEvaluatedAt: TS(3) });
	});

	it("can include child sessions on request", async () => {
		const sessions = await listEvaluableSessions(
			fs({ child: { meta: meta("child", { parent_session_id: "p" }), log: runResult(0.1) } }),
			"Demo",
			"fp",
			{ includeChildren: true },
		);
		expect(sessions.map((s) => s.sessionId)).toEqual(["child"]);
		expect(sessions[0]!.parentSessionId).toBe("p");
	});
});

describe("estimateEvalCeiling", () => {
	it("counts judge runs per session and reports the pass ceiling", () => {
		const circuit = {
			maxCostUsd: 5,
			evalMaxCostUsd: null,
			evaluators: [{ mode: "conversation" }, { mode: "conversation" }, { mode: "code" }],
		} as unknown as Circuit;
		expect(estimateEvalCeiling(circuit, 3)).toEqual({ llmJudges: 2, codeEvaluators: 1, maxCostUsdPerPass: 5, judgeRuns: 6 });
		expect(estimateEvalCeiling({ ...circuit, evalMaxCostUsd: 0.75 } as Circuit, 0).maxCostUsdPerPass).toBe(0.75);
	});
});
