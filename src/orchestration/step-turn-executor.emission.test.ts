/**
 * FR-117a emission matrix — `StepTurnExecutor.resolveEmission` across every
 * post-turn outcome (F3).
 *
 * This is the load-bearing regression gate for F3: the pre-F3 RunLoop mock always
 * returned `stopReason: "completed"`, which is exactly why a masquerading stream
 * error shipped. Here the RunLoop mock is parametrized (via a mutable module-level
 * result) so we can drive the full matrix a real turn can produce:
 *
 *  - a captured `pendingEmission` always wins (regardless of stop reason);
 *  - `completed` + `default_publishes` → the default topic;
 *  - `completed` + no default → `{step}.no_emit`;
 *  - each cut-off cap → `{step}.capped` carrying `{ stopReason, step }`;
 *  - `error` / `cancelled` → `{step}.stream_error` carrying
 *    `{ step, stopReason, error, stack }` (the raw provider/parser message).
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F3-stream-error-masquerades-as-success.md
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../personas/provider-config-resolver", () => ({
	resolvePersonaProviderConfig: () => ({
		providerId: "p1",
		modelId: "m1",
		useExtendedContext: false,
		thinkingLevel: null,
	}),
}));

// A mutable result the fake RunLoop returns — set per test before execute().
// The default is a clean completed turn (no emission captured).
let nextRunResult: {
	text: string;
	structured: unknown;
	messages: unknown[];
	tokenUsage: { input: number; output: number };
	iterationCount: number;
	stopReason: string;
	errorMessage?: string;
} = {
	text: "done",
	structured: null,
	messages: [],
	tokenUsage: { input: 0, output: 0 },
	iterationCount: 1,
	stopReason: "completed",
};

vi.mock("../run-loop/run-loop", () => ({
	RunLoop: class {
		async run() {
			return nextRunResult;
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
		openNotesInEditor: null,
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

function carriage(over: Partial<OrchestrationToolContext> = {}): OrchestrationToolContext {
	return {
		sessionId: "s1",
		scratchpadPath: "sp",
		tasksPath: "tp",
		pendingEmission: null,
		emissionOverwrites: [],
		workflowInvocations: [],
		...over,
	};
}

function runContext(): RunContext {
	return {
		depth: 0,
		maxDepth: Infinity,
		budget: newRootBudget(100, 5),
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: 0 },
		abort: new AbortController().signal,
	};
}

function makeRequest(
	s: StepDefinition,
	ctx: OrchestrationToolContext,
): Parameters<StepTurnExecutor["execute"]>[0] {
	const f = flow([s]);
	return {
		step: f.steps[0]!,
		flow: f,
		event: { topic: "start", payload: "obj", source_step: null, turn: 1, ts: "t" },
		eventHistory: [],
		objective: "obj",
		iteration: 1,
		orchestrationContext: ctx,
		runContext: runContext(),
		mode: "act",
		conversationId: "c1",
	};
}

/** Set the fake RunLoop's next return. */
function setResult(over: Partial<typeof nextRunResult>): void {
	nextRunResult = {
		text: "done",
		structured: null,
		messages: [],
		tokenUsage: { input: 0, output: 0 },
		iterationCount: 1,
		stopReason: "completed",
		...over,
	};
}

describe("StepTurnExecutor — FR-117a emission matrix (F3)", () => {
	it("a captured pendingEmission always wins — even on a stream error", async () => {
		setResult({ stopReason: "error", errorMessage: "provider down" });
		const ctx = carriage({ pendingEmission: { topic: "explicit.topic", payload: "hand-picked" } });
		const { emission } = await makeExecutor().execute(makeRequest(step(), ctx));
		expect(emission).toEqual({ topic: "explicit.topic", payload: "hand-picked" });
	});

	it("completed + default_publishes → the default topic (empty payload)", async () => {
		setResult({ stopReason: "completed" });
		const { emission } = await makeExecutor().execute(makeRequest(step({ defaultPublishes: "work.done" }), carriage()));
		expect(emission).toEqual({ topic: "work.done", payload: "" });
	});

	it("completed + no default_publishes → {step}.no_emit", async () => {
		setResult({ stopReason: "completed" });
		const { emission } = await makeExecutor().execute(makeRequest(step({ defaultPublishes: null }), carriage()));
		expect(emission.topic).toBe("Worker.no_emit");
		expect(emission.payload).toContain("Worker");
	});

	it.each(["iteration_cap", "token_limit", "context_window", "cost_cap", "depth_cap"])(
		"cut-off cap %s → {step}.capped carrying the stop reason",
		async (stopReason) => {
			setResult({ stopReason });
			const { emission } = await makeExecutor().execute(makeRequest(step(), carriage()));
			expect(emission.topic).toBe("Worker.capped");
			expect(JSON.parse(emission.payload)).toEqual({ stopReason, step: "Worker" });
		},
	);

	it("error → {step}.stream_error carrying the raw error message", async () => {
		setResult({ stopReason: "error", errorMessage: "Bedrock rate limited" });
		const { emission } = await makeExecutor().execute(makeRequest(step(), carriage()));
		expect(emission.topic).toBe("Worker.stream_error");
		expect(JSON.parse(emission.payload)).toEqual({
			step: "Worker",
			stopReason: "error",
			error: "Bedrock rate limited",
			stack: null,
		});
	});

	it("cancelled → {step}.stream_error with a null error (no message on the cancel path)", async () => {
		setResult({ stopReason: "cancelled" });
		const { emission } = await makeExecutor().execute(makeRequest(step(), carriage()));
		expect(emission.topic).toBe("Worker.stream_error");
		expect(JSON.parse(emission.payload)).toEqual({
			step: "Worker",
			stopReason: "cancelled",
			error: null,
			stack: null,
		});
	});
});
