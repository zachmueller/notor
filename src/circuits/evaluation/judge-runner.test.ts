/**
 * `runJudge` — the LLM judge path, with the run loop faked through the
 * `createRunLoop` seam and the dispatcher assembly mocked at the module edge.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../personas/provider-config-resolver", () => ({
	resolvePersonaProviderConfig: vi.fn(() => ({ providerId: "p1", modelId: "m1", useExtendedContext: false, thinkingLevel: null })),
}));

const assembled = {
	dispatcher: { marker: "dispatcher" },
	effective: {
		tools: {
			read_note: entry(true),
			emit_event: entry(true),
			circuit_task_close: entry(true),
			// The persona disabled submit_score — the judge must still get it.
			submit_score: entry(false),
			write_note: entry(true),
		},
	},
	toolDefinitions: [],
};
vi.mock("../launch-wiring", () => ({
	assembleStepDispatcher: vi.fn(async () => assembled),
	buildToolDefinitions: (tools: Array<{ name: string; mode: string }>, effective: { tools: Record<string, { enabled: boolean }> }) =>
		tools.filter((t) => effective.tools[t.name]?.enabled).map((t) => ({ name: t.name, description: "", input_schema: {}, mode: t.mode })),
}));

import { runJudge, JUDGE_DISABLED_TOOLS, judgeToolConfig } from "./judge-runner";
import { SUB_AGENT_PREAMBLE } from "../../sub-agents/preamble";
import { newRootBudget } from "../../run-loop/budget";
import type { RunLoopOptions, RunResult } from "../../run-loop/types";
import type { CircuitHost } from "../host";
import type { EvaluatorDefinition } from "../types";
import type { EvalInput } from "./types";

function entry(enabled: boolean) {
	return {
		enabled,
		auto_approve: false,
		allowed_paths: [],
		blocked_paths: [],
		allowed_command_patterns: [],
		blocked_command_patterns: [],
		auto_approve_paths: [],
		never_auto_approve_paths: [],
		path_scopes: {},
	};
}

const TOOLS = ["read_note", "emit_event", "circuit_task_close", "submit_score", "write_note"].map((name) => ({
	name,
	mode: name === "write_note" ? "write" : "read",
	description: "",
	input_schema: {},
}));

const persona = { name: "critic", preferred_preset: null, preferred_provider: null, preferred_model: null, prompt_content: "You judge.", prompt_mode: "append" };
const profile = {
	name: "grader",
	system_prompt_path: "notor/sub-agents/grader/system-prompt.md",
	prompt_content: "Grade things.",
	preferred_preset: null,
	preferred_provider: null,
	preferred_model: null,
	thinking_level: "high",
	iteration_cap: 3,
	tool_configs: [],
};

function host(over: Record<string, unknown> = {}): CircuitHost {
	const registry = {
		get: (n: string) => TOOLS.find((t) => t.name === n),
		getAll: () => TOOLS,
		getNames: () => TOOLS.map((t) => t.name),
	};
	return {
		app: { vault: {}, metadataCache: {} },
		settings: { memory_enabled: false, enable_popover_references: false, domain_denylist: [] },
		vaultRootPath: "/vault",
		getToolRegistry: () => registry,
		getPersonaManager: () => ({ getPersonaByName: async (n: string) => (n === "critic" ? persona : null) }),
		getSubAgentManager: () => ({ getProfile: async (n: string) => (n === "grader" ? profile : null) }),
		getProviderRegistry: () => ({ getProvider: () => ({ marker: "provider" }) }),
		getSystemPromptBuilder: () => ({ assemble: async (...a: unknown[]) => `SYSTEM(${(a[4] as { name?: string } | null)?.name ?? "none"})` }),
		...over,
	} as unknown as CircuitHost;
}

function evaluator(over: Partial<EvaluatorDefinition> = {}): EvaluatorDefinition {
	return {
		name: "Report quality",
		description: "",
		mode: "conversation",
		persona: "critic",
		subagent: null,
		model: null,
		rubricPath: null,
		dimensions: [
			{ name: "accuracy", type: "numeric", min: 1, max: 5, description: null },
			{ name: "cited", type: "boolean", min: 0, max: 1, description: null },
		],
		timeoutSeconds: null,
		includeNoteContents: true,
		bodyContent: "Judge it.",
		notePath: "c/evals/judge.md",
		...over,
	};
}

const input: EvalInput = {
	circuit: { name: "Demo", description: "" },
	session: { sessionId: "s1", startedAt: "t", origin: "user", sessionDir: "notor/circuits/sessions/s1" },
	objective: "obj",
	outcome: { status: "completed", terminalTopic: "FLOW_COMPLETE", text: "done", structured: null, costUsd: 0, tokenUsage: { input: 0, output: 0 }, iterations: 1, source: "run.result" },
	notesEdited: [],
	noteContents: [],
	evaluator: { name: "Report quality", dimensions: evaluator().dimensions },
};

/** A scripted run loop: each call pops the next behavior. */
type Behavior = { score?: unknown; stopReason?: string; cost?: number; throws?: string };
function fakeRunLoop(behaviors: Behavior[]) {
	const calls: Array<{ options: RunLoopOptions; prompt: string }> = [];
	const createRunLoop = (options: RunLoopOptions) => ({
		async run(prompt: string): Promise<RunResult> {
			calls.push({ options, prompt });
			const b = behaviors.shift() ?? {};
			if (b.throws) throw new Error(b.throws);
			await options.hooks?.onTurnComplete?.(1, { text: "", toolCalls: [], tokenUsage: { input: 1, output: 1 }, costUsd: b.cost ?? 0.1 });
			if (b.score !== undefined) options.orchestrationContext!.evaluation!.pendingScore = b.score as never;
			return { text: "", structured: null, messages: [], tokenUsage: { input: 1, output: 1 }, iterationCount: 1, stopReason: (b.stopReason ?? "completed") as never };
		},
	});
	return { createRunLoop, calls };
}

function args(over: Record<string, unknown> = {}) {
	return {
		evaluator: evaluator(),
		input,
		resolvedBody: "Judge it.",
		rubric: "Be strict.",
		budget: newRootBudget(Infinity, 1),
		abortSignal: new AbortController().signal,
		sessionDir: "notor/circuits/sessions/s1",
		...over,
	};
}

beforeEach(() => {
	assembled.effective.tools.submit_score = entry(false);
});

describe("judgeToolConfig", () => {
	it("disables every circuit control tool and forces submit_score on + auto-approved without mutating the input", () => {
		const out = judgeToolConfig(assembled.effective);
		for (const name of JUDGE_DISABLED_TOOLS) if (out.tools[name]) expect(out.tools[name]!.enabled).toBe(false);
		expect(out.tools.submit_score).toMatchObject({ enabled: true, auto_approve: true });
		expect(out.tools.read_note!.enabled).toBe(true);
		expect(assembled.effective.tools.submit_score.enabled).toBe(false);
	});
});

describe("runJudge", () => {
	it("scores through submit_score and reports model + accumulated cost", async () => {
		const loop = fakeRunLoop([{ score: { scores: { accuracy: 4, cited: true }, rationale: "good", overall: 4 }, cost: 0.25 }]);
		const outcome = await runJudge(host(), args(), { createRunLoop: loop.createRunLoop });
		expect(outcome).toEqual({
			evaluator: "Report quality",
			mode: "conversation",
			ok: true,
			scores: { accuracy: 4, cited: true },
			rationale: "good",
			overall: 4,
			costUsd: 0.25,
			modelId: "m1",
		});
	});

	it("runs in plan mode with the judge toolset, an evaluation carriage, and auto approval", async () => {
		const loop = fakeRunLoop([{ score: { scores: { accuracy: 4, cited: true }, rationale: "r" } }]);
		await runJudge(host(), args(), { createRunLoop: loop.createRunLoop });
		const { options, prompt } = loop.calls[0]!;
		expect(options.mode).toBe("plan");
		expect(options.model).toBe("m1");
		expect(options.systemPrompt).toBe("SYSTEM(critic)");
		expect(options.toolDefinitions.map((t) => t.name).sort()).toEqual(["read_note", "submit_score", "write_note"]);
		expect(options.policyCtx.mode).toBe("plan");
		expect(options.policyCtx.approvalOverride).toBe("auto");
		expect(options.policyCtx.effectiveConfig.tools.emit_event!.enabled).toBe(false);
		expect(options.policyCtx.sessionAllowedPaths).toEqual(["notor/circuits/sessions/s1/scratchpad"]);
		expect(options.orchestrationContext).toMatchObject({
			sessionId: "s1",
			scratchpadPath: "notor/circuits/sessions/s1/scratchpad",
			evaluation: { evaluatorName: "Report quality" },
		});
		expect(options.runContext.budget).toBe(loop.calls[0]!.options.runContext.budget);
		expect(prompt).toContain("### DIMENSIONS");
		expect(prompt).toContain("Be strict.");
	});

	it("re-runs once with a reminder when no score was submitted, then fails with no_score", async () => {
		const loop = fakeRunLoop([{}, {}]);
		const outcome = await runJudge(host(), args(), { createRunLoop: loop.createRunLoop });
		expect(loop.calls).toHaveLength(2);
		expect(loop.calls[0]!.prompt).not.toContain("### REMINDER");
		expect(loop.calls[1]!.prompt).toContain("### REMINDER");
		expect(outcome).toMatchObject({ ok: false, reason: "no_score", costUsd: 0.2, modelId: "m1" });
	});

	it("succeeds when the reminder run submits the score", async () => {
		const loop = fakeRunLoop([{}, { score: { scores: { accuracy: 2, cited: false }, rationale: "late" } }]);
		const outcome = await runJudge(host(), args(), { createRunLoop: loop.createRunLoop });
		expect(outcome).toMatchObject({ ok: true, scores: { accuracy: 2, cited: false } });
	});

	it("fails with budget before any LLM call when the pass budget is exhausted", async () => {
		const loop = fakeRunLoop([]);
		const outcome = await runJudge(host(), args({ budget: newRootBudget(Infinity, 0) }), { createRunLoop: loop.createRunLoop });
		expect(outcome).toMatchObject({ ok: false, reason: "budget", costUsd: 0 });
		expect(loop.calls).toHaveLength(0);
	});

	it("maps a cost_cap stop to budget, cancelled to aborted, and error to error", async () => {
		expect(await runJudge(host(), args(), { createRunLoop: fakeRunLoop([{ stopReason: "cost_cap" }]).createRunLoop })).toMatchObject({ ok: false, reason: "budget" });
		expect(await runJudge(host(), args(), { createRunLoop: fakeRunLoop([{ stopReason: "cancelled" }]).createRunLoop })).toMatchObject({ ok: false, reason: "aborted" });
		expect(await runJudge(host(), args(), { createRunLoop: fakeRunLoop([{ stopReason: "error" }]).createRunLoop })).toMatchObject({ ok: false, reason: "error" });
		expect(await runJudge(host(), args(), { createRunLoop: fakeRunLoop([{ throws: "network" }]).createRunLoop })).toMatchObject({ ok: false, reason: "error", detail: "network" });
	});

	it("rejects a submitted score that fails validation", async () => {
		const loop = fakeRunLoop([{ score: { scores: { accuracy: 9, cited: true }, rationale: "r" } }]);
		const outcome = await runJudge(host(), args(), { createRunLoop: loop.createRunLoop });
		expect(outcome).toMatchObject({ ok: false, reason: "invalid_score", detail: expect.stringMatching(/within 1\.\.5/) });
	});

	it("fails with unresolved_persona / unresolved_subagent when the judge cannot be found", async () => {
		const loop = fakeRunLoop([]);
		expect(await runJudge(host(), args({ evaluator: evaluator({ persona: "nobody" }) }), { createRunLoop: loop.createRunLoop })).toMatchObject({ ok: false, reason: "unresolved_persona" });
		expect(await runJudge(host(), args({ evaluator: evaluator({ persona: null, subagent: "nobody" }) }), { createRunLoop: loop.createRunLoop })).toMatchObject({ ok: false, reason: "unresolved_subagent" });
		expect(await runJudge(host({ getSubAgentManager: undefined }), args({ evaluator: evaluator({ persona: null, subagent: "grader" }) }), { createRunLoop: loop.createRunLoop })).toMatchObject({
			ok: false,
			reason: "unresolved_subagent",
		});
		expect(loop.calls).toHaveLength(0);
	});

	it("runs a sub-agent judge with the profile's prompt, iteration cap, and thinking level", async () => {
		const loop = fakeRunLoop([{ score: { scores: { accuracy: 3, cited: true }, rationale: "r" } }]);
		const outcome = await runJudge(host(), args({ evaluator: evaluator({ persona: null, subagent: "grader" }) }), { createRunLoop: loop.createRunLoop });
		expect(outcome).toMatchObject({ ok: true });
		const { options } = loop.calls[0]!;
		expect(options.systemPrompt).toBe(`${SUB_AGENT_PREAMBLE}\nGrade things.`);
		expect(options.iterationCap).toBe(3);
		expect(options.thinkingLevel).toBe("high");
		expect(options.toolDefinitions.map((t) => t.name)).toContain("submit_score");
	});

	it("fails when submit_score is not registered", async () => {
		const noSubmit = TOOLS.filter((t) => t.name !== "submit_score");
		const h = host({ getToolRegistry: () => ({ get: (n: string) => noSubmit.find((t) => t.name === n), getAll: () => noSubmit, getNames: () => noSubmit.map((t) => t.name) }) });
		const outcome = await runJudge(h, args(), { createRunLoop: fakeRunLoop([]).createRunLoop });
		expect(outcome).toMatchObject({ ok: false, reason: "error", detail: expect.stringMatching(/submit_score/) });
	});
});
