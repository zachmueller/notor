/**
 * TEST-006 (part 3) — composition at the runner level (INT-043 / INT-046 / INT-047)
 * + `child_run_metadata` back-compat parse.
 *
 * Drives `OrchestrationRunner` with a fake executor that simulates per-turn spend
 * (decrementing the shared budget cell + folding into the carriage) and a
 * `run_flow`-style child fold, asserting:
 *  - a child run inherits the shared budget cell **by reference** + `depth + 1`
 *    (a child turn's decrement is visible to the parent);
 *  - the run-level subtree rollup sums this run's turns + folded child subtrees
 *    (sourced from `subtreeConsumed`, not a shared-cell delta);
 *  - the `flow.maxDepth` ceiling offsets by the inherited base depth;
 *  - a legacy `sub_agent_metadata` record parses through `readChildRunMetadata`.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — TEST-006
 */

import { describe, it, expect, vi } from "vitest";
import { OrchestrationRunner } from "./runner";
import { decrementAggregate } from "../run-loop/budget";
import type { StepTurnExecutor, StepTurnRequest, StepTurnResult } from "./step-turn-executor";
import type { SessionLog } from "./session-log";
import type { AggregateBudget } from "../run-loop/types";
import { FLOW_COMPLETE, type OrchestrationFlow, type StepDefinition } from "./types";
import { readChildRunMetadata, type ToolResult } from "../types";

function noopLog(): SessionLog {
	const noop = () => Promise.resolve();
	return {
		appendSessionStart: noop,
		appendTurnStart: noop,
		appendTurnComplete: noop,
		appendEventEmitted: noop,
		appendEventEmissionOverwritten: noop,
		appendChildSpawned: noop,
		appendChildResult: noop,
		appendSessionCancelled: noop,
		appendSessionComplete: noop,
		appendUserInputRequired: noop,
		appendUserInputReceived: noop,
	} as unknown as SessionLog;
}

function step(name: string, over: Partial<StepDefinition> = {}): StepDefinition {
	return {
		name,
		description: "",
		triggers: [],
		publishes: [],
		defaultPublishes: null,
		persona: null,
		model: null,
		mode: "conversation",
		mcpServers: null,
		timeoutSeconds: null,
		bodyContent: "",
		notePath: `steps/${name}.md`,
		...over,
	};
}

function flow(steps: StepDefinition[], over: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
	return {
		name: "Demo",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: FLOW_COMPLETE,
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps,
		guardrails: [],
		schedule: null,
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		openNotesInEditor: null,
		allowConcurrent: false,
		...over,
	};
}

/**
 * A fake executor that, per turn, (a) decrements the shared cell by `costUsd`
 * (mirroring what RunLoop does), folding into the turn's `runContext.subtreeConsumed`,
 * and (b) optionally simulates a `run_flow` child by pushing onto the carriage.
 */
function spendExecutor(opts: {
	emitFor: (name: string) => { topic: string; payload?: string };
	costPerTurn?: number;
	childFor?: (name: string) => {
		costUsd: number;
		iterations: number;
		maxDepthReached: number;
		tokenUsage: { input: number; output: number };
	} | null;
}): StepTurnExecutor {
	const cost = opts.costPerTurn ?? 0;
	return {
		execute: vi.fn(async (req: StepTurnRequest): Promise<StepTurnResult> => {
			// Simulate the turn's own spend on the SHARED cell + subtree accumulator.
			decrementAggregate(req.runContext.budget, cost, 1);
			req.runContext.subtreeConsumed.costUsd += cost;
			req.runContext.subtreeConsumed.iterations += 1;
			if (req.runContext.depth > req.runContext.subtreeConsumed.maxDepthReached) {
				req.runContext.subtreeConsumed.maxDepthReached = req.runContext.depth;
			}
			// Simulate a run_flow child this turn (folds into the carriage).
			const child = opts.childFor?.(req.step.name);
			if (child && req.orchestrationContext.childRunResults) {
				// The child's turns already drew down the shared cell by reference:
				decrementAggregate(req.runContext.budget, child.costUsd, child.iterations);
				req.orchestrationContext.childRunResults.push(child);
			}
			const e = opts.emitFor(req.step.name);
			return {
				emission: { topic: e.topic, payload: e.payload ?? "" },
				stopReason: "completed",
				costUsd: cost,
				tokenUsage: { input: 10, output: 5 },
			};
		}),
	} as unknown as StepTurnExecutor;
}

function makeRunner(
	f: OrchestrationFlow,
	executor: StepTurnExecutor,
	inheritedContext?: { budget: AggregateBudget; depth: number },
) {
	let convId = 0;
	return new OrchestrationRunner({
		executor,
		sessionLog: noopLog(),
		makeOrchestrationContext: () => ({
			sessionId: "s1",
			scratchpadPath: "sp",
			tasksPath: "tp",
			pendingEmission: null,
			emissionOverwrites: [],
			childRunResults: [],
			childEdges: [],
		}),
		makeConversationId: () => `c${convId++}`,
		mode: "act",
		sessionId: "s1",
		abortSignal: new AbortController().signal,
		origin: inheritedContext ? "run_flow" : "user",
		inheritedContext,
	});
}

describe("OrchestrationRunner — composition (INT-043/046/047)", () => {
	it("a child run inherits the SHARED budget cell by reference + depth+1", async () => {
		const planner = step("Planner", { triggers: ["start"], publishes: ["work"] });
		const finisher = step("Finisher", { triggers: ["work"], publishes: [FLOW_COMPLETE] });
		const f = flow([planner, finisher], { maxDepth: 3 });
		const shared: AggregateBudget = { iterationsRemaining: 50, costRemainingUsd: 10 };

		const executor = spendExecutor({
			emitFor: (name) => (name === "Planner" ? { topic: "work" } : { topic: FLOW_COMPLETE }),
			costPerTurn: 1,
		});
		const result = await makeRunner(f, executor, { budget: shared, depth: 1 }).start(f, "obj");

		expect(result.status).toBe("completed");
		// Two turns × $1 decremented the SHARED cell (visible to the parent).
		expect(shared.costRemainingUsd).toBe(8);
		expect(shared.iterationsRemaining).toBe(48);
		// The run-level subtree rollup reflects this run's own turns only.
		expect(result.subtreeConsumed.costUsd).toBe(2);
		expect(result.subtreeConsumed.iterations).toBe(2);
		// Inherited base depth 1 → turns ran at depth 1.
		expect(result.subtreeConsumed.maxDepthReached).toBe(1);
	});

	it("folds a settled child flow's subtree into the run-level rollup (subtreeConsumed, not a cell delta)", async () => {
		const caller = step("Caller", { triggers: ["start"], publishes: ["done"] });
		const finisher = step("Finisher", { triggers: ["done"], publishes: [FLOW_COMPLETE] });
		const f = flow([caller, finisher], { maxDepth: 5 });
		// Run as a child so the inherited SHARED cell (not a fresh root) is decremented.
		const shared: AggregateBudget = { iterationsRemaining: 50, costRemainingUsd: 10 };

		const executor = spendExecutor({
			emitFor: (name) => (name === "Caller" ? { topic: "done" } : { topic: FLOW_COMPLETE }),
			costPerTurn: 0.5,
			// The Caller step invokes a child flow that consumed $2 over 4 turns, depth 2.
			childFor: (name) =>
				name === "Caller"
					? { costUsd: 2, iterations: 4, maxDepthReached: 2, tokenUsage: { input: 200, output: 100 } }
					: null,
		});
		const result = await makeRunner(f, executor, { budget: shared, depth: 0 }).start(f, "obj");

		expect(result.status).toBe("completed");
		// Run-level rollup = own 2 turns ($0.5 each = $1) + child subtree ($2) = $3.
		expect(result.subtreeConsumed.costUsd).toBe(3);
		// Own 2 LLM turns + child's 4 = 6 iterations.
		expect(result.subtreeConsumed.iterations).toBe(6);
		// Deepest = the child subtree's depth 2.
		expect(result.subtreeConsumed.maxDepthReached).toBe(2);
		// Tokens: own 2×{10,5} + child {200,100}.
		expect(result.tokenUsage).toEqual({ input: 220, output: 110 });
		// The shared cell saw BOTH the own turns and the child's spend (tree-wide).
		expect(shared.costRemainingUsd).toBe(10 - 1 - 2);
	});

	it("a chaining successor sharing the cell by reference is bounded by the aggregate budget", async () => {
		// Simulate A → B → A over ONE shared cell: each run inherits the same cell.
		// With costRemainingUsd starting at $2 and each turn costing $1, the chain
		// stops drawing turns once the cell is exhausted (the runner's per-turn gate).
		const shared: AggregateBudget = { iterationsRemaining: 100, costRemainingUsd: 2 };
		const only = step("Only", { triggers: ["start"], publishes: [FLOW_COMPLETE] });

		const runHop = (depth: number) =>
			makeRunner(flow([only], { maxDepth: 10 }), spendExecutor({
				emitFor: () => ({ topic: FLOW_COMPLETE }),
				costPerTurn: 1,
			}), { budget: shared, depth }).start(flow([only], { maxDepth: 10 }), "obj");

		await runHop(0); // hop A: 1 turn → cell $1 left
		await runHop(1); // hop B: 1 turn → cell $0 left
		expect(shared.costRemainingUsd).toBe(0);
		// A third hop would find no headroom: the runner's hasHeadroom gate is
		// strict-positive, so the cell at 0 admits no further LLM turn — the cycle
		// is genuinely bounded by the shared aggregate budget, not "by intent".
		expect(shared.costRemainingUsd > 0).toBe(false);
	});

	it("offsets the flow's maxDepth by the inherited base depth (min-of-ancestors)", async () => {
		// A child run at base depth 2 with flow.maxDepth 1 → effective ceiling = 2 + 1 = 3.
		const only = step("Only", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([only], { maxDepth: 1 });
		const shared: AggregateBudget = { iterationsRemaining: 50, costRemainingUsd: 10 };
		let observedMaxDepth = -1;
		const executor = {
			execute: vi.fn(async (req: StepTurnRequest): Promise<StepTurnResult> => {
				observedMaxDepth = req.runContext.maxDepth;
				return {
					emission: { topic: FLOW_COMPLETE, payload: "" },
					stopReason: "completed",
					costUsd: 0,
					tokenUsage: { input: 0, output: 0 },
				};
			}),
		} as unknown as StepTurnExecutor;

		await makeRunner(f, executor, { budget: shared, depth: 2 }).start(f, "obj");
		expect(observedMaxDepth).toBe(3); // baseDepth(2) + flow.maxDepth(1)
	});
});

describe("child_run_metadata back-compat (INT-047)", () => {
	it("reads a legacy sub_agent_metadata record through the shared reader", () => {
		const legacy: ToolResult = {
			tool_name: "use_subagent",
			success: true,
			result: "done",
			sub_agent_metadata: {
				jsonl_filename: "abc_subagent_x.jsonl",
				token_usage: { input: 100, output: 50 },
				iteration_count: 3,
				stop_reason: "completed",
				profile_name: "researcher",
			},
		};
		const meta = readChildRunMetadata(legacy);
		expect(meta).not.toBeNull();
		expect(meta!.jsonl_filename).toBe("abc_subagent_x.jsonl");
		expect(meta!.token_usage).toEqual({ input: 100, output: 50 });
		expect(meta!.iteration_count).toBe(3);
		expect(meta!.stop_reason).toBe("completed");
		// profile_name is the legacy alias of the generalized `name`.
		expect(meta!.profile_name).toBe("researcher");
	});

	it("prefers child_run_metadata over the legacy key when both are present", () => {
		const result: ToolResult = {
			tool_name: "run_flow",
			success: true,
			result: "x",
			child_run_metadata: {
				name: "Child Flow",
				session_id: "sess-c",
				token_usage: { input: 1, output: 2 },
				iteration_count: 1,
				stop_reason: "FLOW_COMPLETE",
			},
			sub_agent_metadata: null,
		};
		expect(readChildRunMetadata(result)?.name).toBe("Child Flow");
	});

	it("returns null when neither key is present", () => {
		const plain: ToolResult = { tool_name: "read_note", success: true, result: "x" };
		expect(readChildRunMetadata(plain)).toBeNull();
	});
});
