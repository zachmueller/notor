/**
 * TEST-006 (part 2) — `RunFlowTool` (INT-042 / INT-043).
 *
 * Covers the tool shell over a fake {@link SpawnChildFlow}: the dynamic `flow`
 * enum reflects discovered invocable flows; orchestration-context-only refusal
 * (Issue-4); unknown-flow `success: false`; the spawn gate over the shared budget
 * cell / depth; structured-vs-text return preference; and the `child` edge +
 * `child_run_metadata` it writes.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — TEST-006
 */

import { describe, it, expect, vi } from "vitest";
import { RunFlowTool } from "./run-flow";
import type { SpawnChildFlow, SpawnChildFlowResult } from "../orchestration/child-flow";
import type { FlowCompositionManager } from "../orchestration/flow-composition-manager";
import type { OrchestrationFlow } from "../orchestration/types";
import type { OrchestrationToolContext, RunContext } from "../run-loop/types";
import type { ToolExecuteOptions } from "./tool";

function flow(name: string, over: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
	return {
		name,
		description: "",
		flowDir: `notor/orchestrations/${name}`,
		startingEvent: "start",
		completionEvent: "FLOW_COMPLETE",
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		schedule: null,
		invocable: true,
		flowInputs: "a question",
		flowReturns: "a report",
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		openNotesInEditor: null,
		allowConcurrent: false,
		...over,
	};
}

function fakeComposition(flows: OrchestrationFlow[]): FlowCompositionManager {
	return {
		listInvocableFlows: vi.fn(async () => flows),
		resolveFlow: vi.fn(async (name: string) => flows.find((f) => f.name === name) ?? null),
	} as unknown as FlowCompositionManager;
}

function spawnResult(over: Partial<SpawnChildFlowResult> = {}): SpawnChildFlowResult {
	return {
		status: "completed",
		structured: null,
		text: "child closing text",
		stopReason: "FLOW_COMPLETE",
		childSessionId: "sess-child",
		entryConversationId: "child-entry-conv",
		rollup: { costUsd: 0.5, iterations: 3, maxDepthReached: 1, tokenUsage: { input: 100, output: 50 } },
		...over,
	};
}

function orchestrationContext(over: Partial<OrchestrationToolContext> = {}): OrchestrationToolContext {
	return {
		sessionId: "sess-parent",
		scratchpadPath: "p/scratchpad",
		tasksPath: "p/tasks",
		conversationId: "parent-conv",
		pendingEmission: null,
		childEdges: [],
		childRunResults: [],
		...over,
	};
}

function runContext(over: Partial<RunContext> = {}): RunContext {
	return {
		depth: 0,
		maxDepth: 3,
		budget: { iterationsRemaining: 50, costRemainingUsd: 4 },
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort: new AbortController().signal,
		...over,
	};
}

describe("RunFlowTool", () => {
	it("exposes a dynamic flow enum + per-flow inputs in the description", async () => {
		const tool = new RunFlowTool(fakeComposition([flow("Alpha"), flow("Beta")]), vi.fn());
		await tool.refreshInvocableFlows();

		expect(tool.input_schema.properties?.flow?.enum).toEqual(["Alpha", "Beta"]);
		expect(tool.description).toContain("Alpha: a question");
		expect(tool.description).toContain("Beta: a question");
	});

	it("refuses outside an orchestration context (Issue-4) — no spawn", async () => {
		const spawn = vi.fn();
		const tool = new RunFlowTool(fakeComposition([flow("Alpha")]), spawn as unknown as SpawnChildFlow);
		const result = await tool.execute({ flow: "Alpha", payload: "x" }, {} as ToolExecuteOptions);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/within an orchestration flow/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("returns success:false for an unknown / non-invocable flow (not a throw)", async () => {
		const tool = new RunFlowTool(fakeComposition([flow("Alpha")]), vi.fn());
		const result = await tool.execute(
			{ flow: "Nope", payload: "x" },
			{ orchestrationContext: orchestrationContext(), runContext: runContext() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/not an invocable flow/i);
	});

	it("blocks a too-deep spawn over the shared cell / depth (spawn gate)", async () => {
		const spawn = vi.fn();
		const tool = new RunFlowTool(fakeComposition([flow("Alpha")]), spawn as unknown as SpawnChildFlow);
		const result = await tool.execute(
			{ flow: "Alpha", payload: "x" },
			{ orchestrationContext: orchestrationContext(), runContext: runContext({ depth: 3, maxDepth: 3 }) },
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/depth cap/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("blocks a spawn when the shared budget cell is exhausted", async () => {
		const spawn = vi.fn();
		const tool = new RunFlowTool(fakeComposition([flow("Alpha")]), spawn as unknown as SpawnChildFlow);
		const result = await tool.execute(
			{ flow: "Alpha", payload: "x" },
			{
				orchestrationContext: orchestrationContext(),
				runContext: runContext({ budget: { iterationsRemaining: 0, costRemainingUsd: 4 } }),
			},
		);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/budget exhausted/i);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("prefers structured over text, writes the child edge + child_run_metadata", async () => {
		const spawn = vi.fn(async () =>
			spawnResult({ structured: { report: "done", sources: ["a", "b"] } }),
		);
		const tool = new RunFlowTool(fakeComposition([flow("Alpha")]), spawn);
		const ctx = orchestrationContext();
		const result = await tool.execute(
			{ flow: "Alpha", payload: "research X" },
			{ orchestrationContext: ctx, runContext: runContext() },
		);

		expect(result.success).toBe(true);
		// structured is preferred over text.
		expect(result.result).toBe(JSON.stringify({ report: "done", sources: ["a", "b"] }));
		// child edge written onto the carriage (run-tree descent).
		expect(ctx.childEdges).toEqual([
			{
				kind: "child",
				conversation_id: "child-entry-conv",
				session_id: "sess-child",
				via_tool_call_id: expect.stringMatching(/^runflow-/),
			},
		]);
		// child subtree folded into the calling turn's rollup carriage.
		expect(ctx.childRunResults).toEqual([
			{ costUsd: 0.5, iterations: 3, maxDepthReached: 1, tokenUsage: { input: 100, output: 50 } },
		]);
		// shared child_run_metadata block (aggregate subtree numbers).
		expect(result.child_run_metadata).toMatchObject({
			name: "Alpha",
			session_id: "sess-child",
			entry_conversation_id: "child-entry-conv",
			cost_usd: 0.5,
			iteration_count: 3,
			token_usage: { input: 100, output: 50 },
			stop_reason: "FLOW_COMPLETE",
		});
	});

	it("falls back to text when no structured return was supplied", async () => {
		const spawn = vi.fn(async () => spawnResult({ structured: null, text: "the report text" }));
		const tool = new RunFlowTool(fakeComposition([flow("Alpha")]), spawn);
		const result = await tool.execute(
			{ flow: "Alpha", payload: "x" },
			{ orchestrationContext: orchestrationContext(), runContext: runContext() },
		);
		expect(result.success).toBe(true);
		expect(result.result).toBe("the report text");
	});

	it("threads step identity + a per-step ordinal into the spawn request (F1 Fix 3)", async () => {
		const spawn: SpawnChildFlow = vi.fn(async () => spawnResult());
		const tool = new RunFlowTool(fakeComposition([flow("Alpha"), flow("Beta")]), spawn);
		// One carriage (one step turn) with its ordinal counter.
		const ctx = orchestrationContext({
			stepName: "Caller",
			turn: 7,
			childSpawnOrdinals: new Map<string, number>(),
		});
		const opts = { orchestrationContext: ctx, runContext: runContext() };

		await tool.execute({ flow: "Alpha", payload: "x" }, opts);
		await tool.execute({ flow: "Alpha", payload: "y" }, opts);
		await tool.execute({ flow: "Beta", payload: "z" }, opts);

		// Two Alpha dispatches get ordinals 0, 1; Beta restarts at 0 (per (step, flow)).
		const calls = vi.mocked(spawn).mock.calls;
		expect(calls[0]![0]).toMatchObject({ flowName: "Alpha", stepName: "Caller", turn: 7, ordinal: 0 });
		expect(calls[1]![0]).toMatchObject({ flowName: "Alpha", stepName: "Caller", turn: 7, ordinal: 1 });
		expect(calls[2]![0]).toMatchObject({ flowName: "Beta", stepName: "Caller", turn: 7, ordinal: 0 });
	});

	it("maps a child error status to a failed tool result (not a throw)", async () => {
		const spawn = vi.fn(async () =>
			spawnResult({ status: "error", structured: null, text: "boom", stopReason: "error" }),
		);
		const tool = new RunFlowTool(fakeComposition([flow("Alpha")]), spawn);
		const result = await tool.execute(
			{ flow: "Alpha", payload: "x" },
			{ orchestrationContext: orchestrationContext(), runContext: runContext() },
		);
		expect(result.success).toBe(false);
		expect(result.error).toBe("boom");
	});
});
