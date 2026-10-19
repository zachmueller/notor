import { describe, it, expect } from "vitest";
import type { SessionLogWriter } from "../session-log";
import { EvalLog, evalLogPath, readEvalLog, summarizeEvalLog, type EvalLogEntry } from "./eval-log";

class FakeWriter implements SessionLogWriter {
	content = "";
	paths: string[] = [];
	async append(path: string, data: string): Promise<void> {
		this.paths.push(path);
		this.content += data;
	}
}

const fixedNow = () => "2026-10-18T00:00:00.000Z";

describe("EvalLog", () => {
	it("appends one newline-terminated JSON object per entry at {sessionDir}/evals.jsonl", async () => {
		const writer = new FakeWriter();
		const log = new EvalLog(evalLogPath("notor/circuits/sessions/s1/"), writer, fixedNow);
		await log.appendPassStart({
			pass_id: "pass-1",
			circuit: "Demo",
			trigger: "manual",
			evaluators: ["judge"],
			evaluator_fingerprint: "abc",
			max_cost_usd: 1,
		});
		await log.appendScored({
			pass_id: "pass-1",
			evaluator: "judge",
			mode: "conversation",
			model_id: "m1",
			scores: { accuracy: 4 },
			rationale: "ok",
			overall: null,
			cost_usd: 0.1,
		});
		await log.appendFailed({
			pass_id: "pass-1",
			evaluator: "shape",
			mode: "code",
			model_id: null,
			reason: "error",
			detail: "boom",
			cost_usd: 0,
		});
		await log.appendPassComplete({ pass_id: "pass-1", cost_usd: 0.1, scored: 1, failed: 1 });

		expect(writer.paths.every((p) => p === "notor/circuits/sessions/s1/evals.jsonl")).toBe(true);
		const entries = readEvalLog(writer.content);
		expect(entries.map((e) => e.type)).toEqual(["eval.pass_start", "eval.scored", "eval.failed", "eval.pass_complete"]);
		expect(entries[0]).toMatchObject({ ts: fixedNow(), evaluator_fingerprint: "abc" });
		expect(writer.content.endsWith("\n")).toBe(true);
	});

	it("never rejects on a failing writer", async () => {
		const log = new EvalLog("x.jsonl", { append: async () => { throw new Error("disk"); } }, fixedNow);
		await expect(log.appendPassComplete({ pass_id: "p", cost_usd: 0, scored: 0, failed: 0 })).resolves.toBeUndefined();
	});
});

describe("readEvalLog", () => {
	it("returns [] for empty input and tolerates torn lines anywhere", () => {
		expect(readEvalLog(null)).toEqual([]);
		expect(readEvalLog("")).toEqual([]);
		const raw = '{"type":"eval.pass_start","pass_id":"p","ts":"t"}\nnot json\n{"type":"eval.pass_complete","pass_id":"p","ts":"t"}\n{"type":"eval.sc';
		expect(readEvalLog(raw).map((e) => e.type)).toEqual(["eval.pass_start", "eval.pass_complete"]);
	});
});

describe("summarizeEvalLog", () => {
	const start = (pass_id: string, fp: string): EvalLogEntry => ({
		type: "eval.pass_start",
		ts: "t1",
		pass_id,
		circuit: "Demo",
		trigger: "manual",
		evaluators: [],
		evaluator_fingerprint: fp,
		max_cost_usd: 1,
	});
	const complete = (pass_id: string, ts: string): EvalLogEntry => ({ type: "eval.pass_complete", ts, pass_id, cost_usd: 0, scored: 0, failed: 0 });

	it("only counts fingerprints whose pass completed, and tracks the latest completion", () => {
		const summary = summarizeEvalLog([start("a", "fp-old"), complete("a", "2026-01-01T00:00:00Z"), start("b", "fp-new"), start("c", "fp-mid"), complete("c", "2026-02-01T00:00:00Z")]);
		expect([...summary.completedFingerprints].sort()).toEqual(["fp-mid", "fp-old"]);
		expect(summary.lastCompletedAt).toBe("2026-02-01T00:00:00Z");
		expect(summary.passCount).toBe(2);
	});

	it("is empty for no entries", () => {
		expect(summarizeEvalLog([])).toEqual({ completedFingerprints: new Set(), lastCompletedAt: null, passCount: 0 });
	});
});
