/**
 * `evaluateSessions` — the pass orchestrator, with both runners faked. Asserts
 * the evals.jsonl sequence, the shared pass budget, skipping of unfinished
 * sessions, the report gate, and abort handling.
 */

import { describe, it, expect, vi } from "vitest";
import type { SessionFs } from "../session-manager";
import type { SessionLogWriter } from "../session-log";
import type { CircuitHost } from "../host";
import type { Circuit, EvaluatorDefinition } from "../types";
import type { AggregateBudget } from "../../run-loop/types";
import { evaluateSessions, loadRubricBodies } from "./evaluate-sessions";
import { readEvalLog } from "./eval-log";
import { evaluatorSetFingerprint } from "./evaluator-fingerprint";
import type { EvalInput, EvaluatorOutcome } from "./types";

class MemFs implements SessionFs, SessionLogWriter {
	files = new Map<string, string>();
	async exists(p: string) {
		return this.files.has(p);
	}
	async mkdir() {}
	async write(p: string, data: string) {
		this.files.set(p, data);
	}
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT: ${p}`);
		return v;
	}
	async append(p: string, data: string) {
		this.files.set(p, (this.files.get(p) ?? "") + data);
	}
}

const TS = "2026-10-18T00:00:00.000Z";
const ROOT = "notor/circuits";

function judge(over: Partial<EvaluatorDefinition> = {}): EvaluatorDefinition {
	return {
		name: "Judge",
		description: "",
		mode: "conversation",
		persona: "critic",
		subagent: null,
		model: null,
		rubricPath: `${ROOT}/demo/evals/_rubric.md`,
		dimensions: [{ name: "accuracy", type: "numeric", min: 1, max: 5, description: null }],
		timeoutSeconds: null,
		includeNoteContents: true,
		bodyContent: "Judge <include_note>x</include_note>",
		notePath: `${ROOT}/demo/evals/judge.md`,
		...over,
	};
}
function shape(): EvaluatorDefinition {
	return judge({ name: "Shape", mode: "code", persona: null, rubricPath: null, bodyContent: "```ts\nreturn {}\n```", notePath: `${ROOT}/demo/evals/shape.md`, includeNoteContents: false });
}
function circuit(over: Partial<Circuit> = {}): Circuit {
	return { name: "Demo", description: "", flowDir: `${ROOT}/demo`, maxCostUsd: 5, evalMaxCostUsd: 1.5, evaluators: [judge(), shape()], ...over } as Circuit;
}

function seedSession(fs: MemFs, id: string, status: string, withRunResult: boolean) {
	const dir = `${ROOT}/sessions/${id}`;
	fs.files.set(
		`${dir}/session.json`,
		JSON.stringify({ session_id: id, flow_name: "Demo", status, iteration: 1, active_step: null, started_at: TS, prompt: `obj ${id}`, parent_session_id: null, origin: "user" }),
	);
	const entries: unknown[] = [
		{ type: "turn.start", turn: 1, step: "A", trigger_topic: "start", conversation_id: "c1", ts: TS },
		{ type: "turn.complete", turn: 1, step: "A", emitted_topic: "FLOW_COMPLETE", conversation_id: "c1", cost_usd: 0.3, token_usage: { input: 1, output: 1 }, ts: TS },
		{ type: "event.emitted", turn: 1, topic: "FLOW_COMPLETE", payload: "legacy text", source_step: "A", ts: TS },
	];
	if (status !== "active") entries.push({ type: "session.complete", ts: TS });
	if (withRunResult) {
		entries.push({ type: "run.result", ts: TS, status: "completed", terminal_topic: "FLOW_COMPLETE", text: "done", structured: { ok: true }, cost_usd: 0.3, token_usage: { input: 1, output: 1 }, iterations: 1 });
	}
	fs.files.set(`${dir}/session-log.jsonl`, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function host(fs: MemFs, over: Record<string, unknown> = {}): CircuitHost {
	return {
		app: { vault: { adapter: {} }, metadataCache: {} },
		settings: { notor_dir: "notor", circuits_write_eval_reports: true, ...((over.settings as object) ?? {}) },
		getCircuitDataRootName: () => "circuits",
		...over,
	} as unknown as CircuitHost;
}

function fakeRunners() {
	const judgeCalls: Array<{ budget: AggregateBudget; rubric: string | null; resolvedBody: string; input: EvalInput }> = [];
	const runJudge = vi.fn(async (_host: CircuitHost, a: { evaluator: EvaluatorDefinition; budget: AggregateBudget; rubric: string | null; resolvedBody: string; input: EvalInput }): Promise<EvaluatorOutcome> => {
		judgeCalls.push({ budget: a.budget, rubric: a.rubric, resolvedBody: a.resolvedBody, input: a.input });
		a.budget.costRemainingUsd -= 0.4;
		return { evaluator: a.evaluator.name, mode: "conversation", ok: true, scores: { accuracy: 4 }, rationale: "good", overall: null, costUsd: 0.4, modelId: "m1" };
	});
	const codeCalls: EvalInput[] = [];
	const runCodeEvaluator = vi.fn(async (a: { evaluator: EvaluatorDefinition; input: EvalInput }): Promise<EvaluatorOutcome> => {
		codeCalls.push(a.input);
		return { evaluator: a.evaluator.name, mode: "code", ok: true, scores: { accuracy: 5 }, rationale: "shape", overall: null, costUsd: 0, modelId: null };
	});
	return { runJudge, runCodeEvaluator, judgeCalls, codeCalls };
}

function deps(fs: MemFs, runners: ReturnType<typeof fakeRunners>, over: Record<string, unknown> = {}) {
	let n = 0;
	return {
		fs,
		logWriter: fs,
		runJudge: runners.runJudge,
		runCodeEvaluator: runners.runCodeEvaluator,
		codeRuntimeFactory: { build: async () => { throw new Error("not used"); } },
		resolveBody: async (e: EvaluatorDefinition) => `RESOLVED(${e.name})`,
		now: () => `2026-10-18T00:00:0${(n++) % 10}.000Z`,
		makePassId: () => "pass-test",
		buildInput: async (_h: CircuitHost, a: { evaluator: EvaluatorDefinition; loaded: { meta: { session_id: string; prompt: string }; outcome: unknown }; includeNoteContents: boolean }): Promise<EvalInput> =>
			({
				circuit: { name: "Demo", description: "" },
				session: { sessionId: a.loaded.meta.session_id, startedAt: TS, origin: "user", sessionDir: `${ROOT}/sessions/${a.loaded.meta.session_id}` },
				objective: a.loaded.meta.prompt,
				outcome: a.loaded.outcome,
				notesEdited: [],
				noteContents: [],
				evaluator: { name: a.evaluator.name, dimensions: a.evaluator.dimensions },
				// smuggle the flag out for assertions
				...( { includeNoteContents: a.includeNoteContents } as object),
			}) as EvalInput,
		...over,
	};
}

describe("evaluateSessions", () => {
	it("writes the evals.jsonl sequence per session, shares one pass budget, and writes reports", async () => {
		const fs = new MemFs();
		fs.files.set(`${ROOT}/demo/evals/_rubric.md`, "---\ntitle: r\n---\nBe strict.");
		seedSession(fs, "s1", "completed", true);
		seedSession(fs, "s2", "completed", false);
		const runners = fakeRunners();
		const progress: string[] = [];

		const result = await evaluateSessions(host(fs), circuit(), ["s1", "s2"], {
			trigger: "manual",
			deps: deps(fs, runners),
			onProgress: (p) => progress.push(`${p.sessionId}:${p.evaluator ?? "-"}:${p.phase}`),
		});

		const expectedFp = evaluatorSetFingerprint(circuit().evaluators, { [`${ROOT}/demo/evals/_rubric.md`]: "Be strict." });
		expect(result).toMatchObject({ passId: "pass-test", circuit: "Demo", trigger: "manual", fingerprint: expectedFp, maxCostUsd: 1.5, totalCostUsd: 0.8 });
		expect(result.sessions).toHaveLength(2);
		expect(result.sessions.every((s) => s.skipped === null && s.outcomes.length === 2)).toBe(true);

		const log1 = readEvalLog(fs.files.get(`${ROOT}/sessions/s1/evals.jsonl`));
		expect(log1.map((e) => e.type)).toEqual(["eval.pass_start", "eval.scored", "eval.scored", "eval.pass_complete"]);
		expect(log1[0]).toMatchObject({ pass_id: "pass-test", circuit: "Demo", trigger: "manual", evaluators: ["Judge", "Shape"], evaluator_fingerprint: expectedFp, max_cost_usd: 1.5 });
		expect(log1[1]).toMatchObject({ evaluator: "Judge", mode: "conversation", model_id: "m1", scores: { accuracy: 4 }, cost_usd: 0.4 });
		expect(log1[3]).toMatchObject({ scored: 2, failed: 0, cost_usd: 0.4 });

		// One budget cell for the whole pass, seeded from notor-eval-max-cost-usd.
		expect(runners.judgeCalls).toHaveLength(2);
		expect(runners.judgeCalls[0]!.budget).toBe(runners.judgeCalls[1]!.budget);
		expect(runners.judgeCalls[1]!.budget.costRemainingUsd).toBeCloseTo(1.5 - 0.8, 10);
		expect(runners.judgeCalls[0]!.rubric).toBe("Be strict.");
		expect(runners.judgeCalls[0]!.resolvedBody).toBe("RESOLVED(Judge)");

		// The legacy session (no run.result) still evaluates, from the fallback outcome.
		expect(runners.judgeCalls[1]!.input.outcome).toMatchObject({ source: "fallback", text: "legacy text" });
		// Note contents only for the LLM judge.
		expect((runners.judgeCalls[0]!.input as unknown as { includeNoteContents: boolean }).includeNoteContents).toBe(true);
		expect((runners.codeCalls[0] as unknown as { includeNoteContents: boolean }).includeNoteContents).toBe(false);

		// Reports under the sticky data root.
		expect(result.sessions[0]!.reportPath).toBe(`${ROOT}/evals/demo-s1-pass-test.md`);
		expect(fs.files.get(`${ROOT}/evals/demo-s1-pass-test.md`)).toContain("notor-score-judge-accuracy: 4");
		expect(progress).toEqual([
			"s1:Judge:start", "s1:Judge:scored", "s1:Shape:start", "s1:Shape:scored",
			"s2:Judge:start", "s2:Judge:scored", "s2:Shape:start", "s2:Shape:scored",
		]);
	});

	it("falls back to the circuit ceiling when notor-eval-max-cost-usd is unset", async () => {
		const fs = new MemFs();
		seedSession(fs, "s1", "completed", true);
		const runners = fakeRunners();
		const result = await evaluateSessions(host(fs), circuit({ evalMaxCostUsd: null }), ["s1"], { trigger: "auto", deps: deps(fs, runners) });
		expect(result.maxCostUsd).toBe(5);
		expect(runners.judgeCalls[0]!.budget.costRemainingUsd).toBeCloseTo(5 - 0.4, 10);
	});

	it("skips unfinished or missing sessions without writing evals.jsonl", async () => {
		const fs = new MemFs();
		seedSession(fs, "active", "active", false);
		const runners = fakeRunners();
		const result = await evaluateSessions(host(fs), circuit(), ["active", "ghost"], { trigger: "manual", deps: deps(fs, runners) });
		expect(result.sessions.map((s) => s.skipped)).toEqual(["session is active, not finished", expect.stringMatching(/session.json unreadable/)]);
		expect(fs.files.has(`${ROOT}/sessions/active/evals.jsonl`)).toBe(false);
		expect(runners.runJudge).not.toHaveBeenCalled();
	});

	it("records evaluator failures and thrown runner errors as eval.failed, and honors the report setting", async () => {
		const fs = new MemFs();
		seedSession(fs, "s1", "completed", true);
		const runners = fakeRunners();
		runners.runJudge.mockImplementationOnce(async () => { throw new Error("provider down"); });
		runners.runCodeEvaluator.mockImplementationOnce(async (a) => ({ evaluator: a.evaluator.name, mode: "code", ok: false, reason: "timeout", detail: "slow", costUsd: 0, modelId: null }));
		const result = await evaluateSessions(host(fs, { settings: { notor_dir: "notor", circuits_write_eval_reports: false } }), circuit(), ["s1"], { trigger: "manual", deps: deps(fs, runners) });
		const log = readEvalLog(fs.files.get(`${ROOT}/sessions/s1/evals.jsonl`));
		expect(log.map((e) => e.type)).toEqual(["eval.pass_start", "eval.failed", "eval.failed", "eval.pass_complete"]);
		expect(log[1]).toMatchObject({ evaluator: "Judge", reason: "error", detail: "provider down" });
		expect(log[2]).toMatchObject({ evaluator: "Shape", reason: "timeout" });
		expect(log[3]).toMatchObject({ scored: 0, failed: 2 });
		expect(result.sessions[0]!.reportPath).toBeNull();
		expect([...fs.files.keys()].some((k) => k.includes("/evals/"))).toBe(false);
	});

	it("marks every evaluator aborted once the signal fires, without calling the runners", async () => {
		const fs = new MemFs();
		seedSession(fs, "s1", "completed", true);
		const runners = fakeRunners();
		const controller = new AbortController();
		controller.abort();
		const result = await evaluateSessions(host(fs), circuit(), ["s1"], { trigger: "schedule", abortSignal: controller.signal, deps: deps(fs, runners) });
		expect(result.sessions[0]!.outcomes.map((o) => (o.ok ? "ok" : o.reason))).toEqual(["aborted", "aborted"]);
		expect(runners.runJudge).not.toHaveBeenCalled();
	});
});

describe("loadRubricBodies", () => {
	it("strips frontmatter and omits unreadable rubrics", async () => {
		const fs = new MemFs();
		fs.files.set("r.md", "---\nx: 1\n---\n# Rubric\nBody");
		const bodies = await loadRubricBodies(fs, [judge({ rubricPath: "r.md" }), judge({ name: "J2", rubricPath: "missing.md" }), shape()]);
		expect(bodies).toEqual({ "r.md": "# Rubric\nBody" });
	});
});
