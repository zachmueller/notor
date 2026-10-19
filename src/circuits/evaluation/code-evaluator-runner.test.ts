import { describe, it, expect, vi } from "vitest";
import type { ToolDispatcher } from "../../chat/dispatcher";
import type { EvaluatorDefinition } from "../types";
import { CODE_EVALUATOR_ARG_NAMES, runCodeEvaluator, type CodeEvaluatorRuntime } from "./code-evaluator-runner";
import type { EvalInput } from "./types";

function evaluator(body: string, over: Partial<EvaluatorDefinition> = {}): EvaluatorDefinition {
	return {
		name: "Shape",
		description: "",
		mode: "code",
		persona: null,
		subagent: null,
		model: null,
		rubricPath: null,
		dimensions: [
			{ name: "completed", type: "boolean", min: 0, max: 1, description: null },
			{ name: "words", type: "numeric", min: 0, max: 1000, description: null },
		],
		timeoutSeconds: null,
		includeNoteContents: false,
		bodyContent: body,
		notePath: "c/evals/shape.md",
		...over,
	};
}

const input: EvalInput = {
	circuit: { name: "Demo", description: "" },
	session: { sessionId: "s1", startedAt: "t", origin: "user", sessionDir: "notor/circuits/sessions/s1" },
	objective: "obj",
	outcome: { status: "completed", terminalTopic: "FLOW_COMPLETE", text: "one two three", structured: { summary: "s" }, costUsd: 0, tokenUsage: { input: 0, output: 0 }, iterations: 1, source: "run.result" },
	notesEdited: ["out.md"],
	noteContents: [],
	evaluator: { name: "Shape", dimensions: [] },
};

function runtime(over: Partial<CodeEvaluatorRuntime> = {}) {
	const files = new Map<string, string>([["notor/circuits/sessions/s1/scratchpad/draft.md", "draft body"]]);
	const dispatch = vi.fn(async () => ({ tool_name: "read_note", success: true, result: "note body" }));
	const rt: CodeEvaluatorRuntime = {
		app: { marker: "APP" },
		obsidian: {},
		utils: { marker: "UTILS" },
		libs: {},
		dispatcher: { dispatch } as unknown as ToolDispatcher,
		scratchpadFs: {
			read: async (p) => files.get(p) ?? null,
			write: async () => {},
			exists: async (p) => files.has(p),
			list: async () => [...files.keys()],
		},
		policyCtx: { effectiveConfig: { tools: {} }, mode: "plan", vaultRootPath: "/vault" },
		...over,
	};
	return { rt, dispatch, factory: { build: vi.fn(async () => rt) } };
}

function fence(code: string): string {
	return "```ts\n" + code + "\n```";
}

function args(ev: EvaluatorDefinition, rtOver: Partial<CodeEvaluatorRuntime> = {}) {
	const r = runtime(rtOver);
	return {
		run: () =>
			runCodeEvaluator({
				evaluator: ev,
				input,
				sessionDir: "notor/circuits/sessions/s1",
				abortSignal: new AbortController().signal,
				runtimeFactory: r.factory,
				readLog: async () => [{ type: "session.complete", ts: "t" }],
			}),
		...r,
	};
}

describe("runCodeEvaluator", () => {
	it("compiles with the evaluator argument list and returns validated scores", () => {
		expect([...CODE_EVALUATOR_ARG_NAMES]).toEqual(["app", "obsidian", "utils", "libs", "input", "evaluation"]);
	});

	it("passes input + evaluation helper and accepts { scores, rationale, overall }", async () => {
		const ev = evaluator(
			fence(`
				const words = input.outcome.text.split(" ").length;
				return { scores: { completed: input.outcome.status === "completed", words }, rationale: "counted " + evaluation.dimensions.length + " dims", overall: words };
			`),
		);
		const outcome = await args(ev).run();
		expect(outcome).toEqual({
			evaluator: "Shape",
			mode: "code",
			ok: true,
			scores: { completed: true, words: 3 },
			rationale: "counted 2 dims",
			overall: 3,
			costUsd: 0,
			modelId: null,
		});
	});

	it("exposes the session (scratchpad, log) and tool dispatch through the helper", async () => {
		const ev = evaluator(
			fence(`
				const draft = await evaluation.session.scratchpad.read("draft.md");
				const files = await evaluation.session.scratchpad.list();
				const log = await evaluation.session.readLog();
				const note = await evaluation.callTool("read_note", { path: "out.md" });
				return { scores: { completed: draft === "draft body" && files[0] === "draft.md" && log.length === 1 && note === "note body", words: evaluation.session.id === "s1" ? 1 : 0 }, rationale: "r" };
			`),
		);
		const a = args(ev);
		const outcome = await a.run();
		expect(outcome).toMatchObject({ ok: true, scores: { completed: true, words: 1 } });
		expect(a.dispatch).toHaveBeenCalledTimes(1);
		const call = (a.dispatch.mock.calls[0] as unknown[]);
		expect(call[0]).toBe("read_note");
		expect(call[2]).toBe("plan");
		expect(call[6]).toBe(a.rt.policyCtx);
	});

	it("rejects scratchpad path traversal", async () => {
		const ev = evaluator(fence(`await evaluation.session.scratchpad.read("../session.json"); return { scores: {}, rationale: "r" };`));
		expect(await args(ev).run()).toMatchObject({ ok: false, reason: "error", detail: expect.stringMatching(/Invalid scratchpad file name/) });
	});

	it("maps a bad return to invalid_score, a throw to error, a missing fence and a compile error to error", async () => {
		expect(await args(evaluator(fence(`return { scores: { completed: "yes" }, rationale: "r" };`))).run()).toMatchObject({ ok: false, reason: "invalid_score" });
		expect(await args(evaluator(fence(`return 42;`))).run()).toMatchObject({ ok: false, reason: "invalid_score" });
		expect(await args(evaluator(fence(`throw new Error("kaboom");`))).run()).toMatchObject({ ok: false, reason: "error", detail: "kaboom" });
		expect(await args(evaluator("no fence")).run()).toMatchObject({ ok: false, reason: "error", detail: expect.stringMatching(/code fence/) });
		expect(await args(evaluator(fence(`return {`))).run()).toMatchObject({ ok: false, reason: "error", detail: expect.stringMatching(/compile error/) });
	});

	it("times out an await-yielding snippet per notor-eval-timeout-seconds", async () => {
		const ev = evaluator(fence(`await new Promise((r) => setTimeout(r, 200)); return { scores: { completed: true, words: 1 }, rationale: "r" };`), { timeoutSeconds: 0.02 });
		expect(await args(ev).run()).toMatchObject({ ok: false, reason: "timeout" });
	});

	it("returns aborted without running when the signal is already aborted", async () => {
		const r = runtime();
		const controller = new AbortController();
		controller.abort();
		const outcome = await runCodeEvaluator({
			evaluator: evaluator(fence(`return { scores: { completed: true, words: 1 }, rationale: "r" };`)),
			input,
			sessionDir: "d",
			abortSignal: controller.signal,
			runtimeFactory: r.factory,
			readLog: async () => [],
		});
		expect(outcome).toMatchObject({ ok: false, reason: "aborted" });
		expect(r.factory.build).not.toHaveBeenCalled();
	});
});
