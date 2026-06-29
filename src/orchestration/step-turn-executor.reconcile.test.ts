/**
 * INT-031 — step→workflow aggregate-budget reconciliation in `StepTurnExecutor`.
 *
 * Asserts the post-hoc reconciliation contract (FR-151 / Issue-13h): any
 * `invoke_workflow` call during a conversation-step turn pushes the invoked
 * workflow's reported `{ costUsd, iterations }` onto the carriage; after the turn
 * the executor folds those totals into the SHARED `RunContext.budget` cell via
 * `decrementAggregate` (one decrement per invocation) — so the next turn/spawn
 * gate sees the corrected remaining total. The accumulator is drained so a
 * re-read never double-counts.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-5-interactive-workflow.md — INT-031
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// Pin a deterministic provider/model so no global registry is touched.
vi.mock("../personas/provider-config-resolver", () => ({
	resolvePersonaProviderConfig: () => ({
		providerId: "p1",
		modelId: "m1",
		useExtendedContext: false,
		thinkingLevel: null,
	}),
}));
// Fake RunLoop: a single completed turn that emits nothing (the executor will
// synthesize default_publishes). No LLM, no streaming.
vi.mock("../run-loop/run-loop", () => ({
	RunLoop: class {
		async run() {
			return {
				text: "done",
				structured: null,
				messages: [],
				tokenUsage: { input: 0, output: 0 },
				iterationCount: 1,
				stopReason: "completed",
			};
		}
	},
}));

import { StepTurnExecutor } from "./step-turn-executor";
import { newRootBudget } from "../run-loop/budget";
import type { SessionLog } from "./session-log";
import type { OrchestrationToolContext, RunContext } from "../run-loop/types";
import type { OrchestrationFlow, StepDefinition } from "./types";

function noopLog(): SessionLog {
	const noop = () => Promise.resolve();
	return {
		appendTurnStart: noop,
		appendTurnComplete: noop,
		appendEventEmissionOverwritten: noop,
	} as unknown as SessionLog;
}

function step(over: Partial<StepDefinition> = {}): StepDefinition {
	return {
		name: "Worker",
		description: "",
		triggers: ["start"],
		publishes: ["work.done"],
		defaultPublishes: "work.done",
		persona: null,
		model: null,
		mode: "conversation",
		mcpServers: null,
		timeoutSeconds: null,
		bodyContent: "",
		notePath: "steps/worker.md",
		...over,
	};
}

function flow(steps: StepDefinition[]): OrchestrationFlow {
	return {
		name: "Demo",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: "FLOW_COMPLETE",
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
	};
}

function makeExecutor(): StepTurnExecutor {
	return new StepTurnExecutor(
		{
			personaManager: { getPersonaByName: async () => null },
			providerRegistry: { getProvider: () => ({}) } as never,
			settings: {} as never,
			promptBuilder: { build: () => "prompt" } as never,
			runtimeFactory: {
				build: async () => ({
					provider: {} as never,
					dispatcher: {} as never,
					toolDefinitions: [],
					systemPrompt: "sys",
				}),
			},
		},
		noopLog(),
	);
}

function makeRequest(
	ctx: OrchestrationToolContext,
	runContext: RunContext,
): Parameters<StepTurnExecutor["execute"]>[0] {
	const f = flow([step()]);
	return {
		step: f.steps[0]!,
		flow: f,
		event: { topic: "start", payload: "obj", source_step: null, turn: 1, ts: "t" },
		eventHistory: [],
		objective: "obj",
		iteration: 1,
		orchestrationContext: ctx,
		runContext,
		mode: "act",
		conversationId: "c1",
	};
}

function carriage(workflowInvocations: Array<{ costUsd: number; iterations: number }>): OrchestrationToolContext {
	return {
		sessionId: "s1",
		scratchpadPath: "sp",
		tasksPath: "tp",
		pendingEmission: null,
		emissionOverwrites: [],
		workflowInvocations,
	};
}

function runContextWith(budget = newRootBudget(100, 5)): RunContext {
	return {
		depth: 0,
		maxDepth: Infinity,
		budget,
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort: new AbortController().signal,
	};
}

describe("StepTurnExecutor — step→workflow budget reconciliation (INT-031)", () => {
	it("folds a step→workflow invocation's reported cost/iterations into the shared budget after the turn", async () => {
		const ctx = carriage([{ costUsd: 1.25, iterations: 3 }]);
		const rc = runContextWith(newRootBudget(100, 5));

		await makeExecutor().execute(makeRequest(ctx, rc));

		// Aggregate cell decremented by the workflow's reported spend (post-hoc).
		expect(rc.budget.costRemainingUsd).toBeCloseTo(3.75, 5); // 5.00 − 1.25
		expect(rc.budget.iterationsRemaining).toBe(97); // 100 − 3
		// Accumulator drained so a re-read can't double-count.
		expect(ctx.workflowInvocations).toHaveLength(0);
	});

	it("applies one decrement per invocation when a turn invokes multiple workflows", async () => {
		const ctx = carriage([
			{ costUsd: 0.5, iterations: 2 },
			{ costUsd: 0.75, iterations: 1 },
		]);
		const rc = runContextWith(newRootBudget(100, 5));

		await makeExecutor().execute(makeRequest(ctx, rc));

		expect(rc.budget.costRemainingUsd).toBeCloseTo(3.75, 5); // 5 − (0.5 + 0.75)
		expect(rc.budget.iterationsRemaining).toBe(97); // 100 − (2 + 1)
		expect(ctx.workflowInvocations).toHaveLength(0);
	});

	it("leaves the budget untouched for a turn that invoked no workflow", async () => {
		const ctx = carriage([]);
		const rc = runContextWith(newRootBudget(100, 5));

		await makeExecutor().execute(makeRequest(ctx, rc));

		expect(rc.budget.costRemainingUsd).toBe(5);
		expect(rc.budget.iterationsRemaining).toBe(100);
	});
});
