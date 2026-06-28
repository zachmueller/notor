/**
 * TEST-002 (part 4) + Phase-1 exit gate — `OrchestrationRunner` end-to-end.
 *
 * Drives a hand-authored flow with a FAKE `StepTurnExecutor` (no LLM, no vault):
 *  - single-flow happy path → FLOW_COMPLETE;
 *  - breadth-first FIFO fan-out drain order (Issue-11);
 *  - orphan → fallback → FLOW_ERROR;
 *  - FLOW_CANCELLED terminates with status cancelled;
 *  - required_events blocks a premature completion and re-injects;
 *  - completion no-progress guard terminates after the threshold (Issue-9).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-010 / TEST-002
 */

import { describe, it, expect, vi } from "vitest";
import { COMPLETION_NOPROGRESS_THRESHOLD } from "./constants";
import { OrchestrationRunner } from "./runner";
import type { StepTurnExecutor, StepTurnRequest, StepTurnResult } from "./step-turn-executor";
import type { SessionLog } from "./session-log";
import {
	FLOW_CANCELLED,
	FLOW_COMPLETE,
	type OrchestrationFlow,
	type StepDefinition,
} from "./types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A no-op SessionLog (all appends resolve). */
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
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		...over,
	};
}

/**
 * A fake executor whose emission is decided by `emitFor(step.name, event.topic)`.
 * Records the order steps run in.
 */
function fakeExecutor(
	emitFor: (stepName: string, topic: string) => { topic: string; payload?: string },
	runOrder: string[],
): StepTurnExecutor {
	return {
		execute: vi.fn(async (req: StepTurnRequest): Promise<StepTurnResult> => {
			runOrder.push(req.step.name);
			const e = emitFor(req.step.name, req.event.topic);
			return {
				emission: { topic: e.topic, payload: e.payload ?? "" },
				stopReason: "completed",
				costUsd: 0,
				tokenUsage: { input: 0, output: 0 },
			};
		}),
	} as unknown as StepTurnExecutor;
}

function makeRunner(f: OrchestrationFlow, executor: StepTurnExecutor) {
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
		}),
		makeConversationId: () => `c${convId++}`,
		mode: "act",
		sessionId: "s1",
		abortSignal: new AbortController().signal,
		origin: "user",
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OrchestrationRunner", () => {
	it("runs a single-flow happy path end-to-end → completed", async () => {
		const planner = step("Planner", { triggers: ["start"], publishes: ["work"] });
		const finisher = step("Finisher", { triggers: ["work"], publishes: [FLOW_COMPLETE] });
		const f = flow([planner, finisher]);
		const runOrder: string[] = [];
		const executor = fakeExecutor((name) => {
			if (name === "Planner") return { topic: "work" };
			return { topic: FLOW_COMPLETE };
		}, runOrder);

		const result = await makeRunner(f, executor).start(f, "objective");

		expect(result.status).toBe("completed");
		expect(result.terminal.topic).toBe(FLOW_COMPLETE);
		expect(runOrder).toEqual(["Planner", "Finisher"]);
	});

	it("drains a fan-out breadth-first FIFO (all subscribers, then consequences) — Issue-11", async () => {
		// start --fanout--> [A, B] (declared). A emits a.done → C; B emits b.done → D.
		// Breadth-first: A, B run first (their emissions enqueued), THEN C, D.
		const a = step("A", { triggers: ["fan"], publishes: ["a.done"] });
		const b = step("B", { triggers: ["fan"], publishes: ["b.done"] });
		const c = step("C", { triggers: ["a.done"], publishes: [FLOW_COMPLETE] });
		const d = step("D", { triggers: ["b.done"], publishes: [FLOW_COMPLETE] });
		const seed = step("Seed", { triggers: ["start"], publishes: ["fan"] });
		const f = flow([seed, a, b, c, d], { startingEvent: "start", fanoutTopics: ["fan"] });

		const runOrder: string[] = [];
		const executor = fakeExecutor((name) => {
			switch (name) {
				case "Seed":
					return { topic: "fan" };
				case "A":
					return { topic: "a.done" };
				case "B":
					return { topic: "b.done" };
				case "C":
					return { topic: FLOW_COMPLETE };
				default:
					return { topic: FLOW_COMPLETE };
			}
		}, runOrder);

		const result = await makeRunner(f, executor).start(f, "objective");

		// Seed, then the fan-out set [A, B] (breadth-first), then their
		// consequences C (and the loop terminates at C's FLOW_COMPLETE).
		expect(runOrder.slice(0, 3)).toEqual(["Seed", "A", "B"]);
		// C runs AFTER both A and B (FIFO drain), not interleaved between them.
		expect(runOrder.indexOf("C")).toBeGreaterThan(runOrder.indexOf("B"));
		expect(result.status).toBe("completed");
	});

	it("routes an orphaned topic to the fallback → FLOW_ERROR (status error)", async () => {
		const planner = step("Planner", { triggers: ["start"], publishes: ["nowhere"] });
		const f = flow([planner]);
		const runOrder: string[] = [];
		const executor = fakeExecutor(() => ({ topic: "nowhere" }), runOrder);

		const result = await makeRunner(f, executor).start(f, "objective");

		expect(result.status).toBe("error");
		expect(result.terminal.topic).toBe("FLOW_ERROR");
		expect(result.terminal.payload).toContain("nowhere");
	});

	it("terminates with status cancelled on FLOW_CANCELLED", async () => {
		const planner = step("Planner", { triggers: ["start"], publishes: [FLOW_CANCELLED] });
		const f = flow([planner]);
		const executor = fakeExecutor(() => ({ topic: FLOW_CANCELLED, payload: "nothing to do" }), []);

		const result = await makeRunner(f, executor).start(f, "objective");
		expect(result.status).toBe("cancelled");
		expect(result.terminal.payload).toBe("nothing to do");
	});

	it("blocks a premature completion until a required event is seen, then completes", async () => {
		// Planner emits FLOW_COMPLETE prematurely; required event "review.approved"
		// is unmet → re-injected as flow.requirements_unmet (auto-subscribed back to
		// Planner). On the re-trigger Planner emits review.approved → Reviewer →
		// then FLOW_COMPLETE succeeds.
		const planner = step("Planner", {
			triggers: ["start", "flow.requirements_unmet"],
			publishes: [FLOW_COMPLETE, "review.approved"],
		});
		const reviewer = step("Reviewer", { triggers: ["review.approved"], publishes: [FLOW_COMPLETE] });
		const f = flow([planner, reviewer], { requiredEvents: ["review.approved"] });

		let plannerCalls = 0;
		const runOrder: string[] = [];
		const executor = fakeExecutor((name) => {
			if (name === "Planner") {
				plannerCalls++;
				// First call: premature FLOW_COMPLETE. After re-trigger: emit the required event.
				return plannerCalls === 1 ? { topic: FLOW_COMPLETE } : { topic: "review.approved" };
			}
			return { topic: FLOW_COMPLETE };
		}, runOrder);

		const result = await makeRunner(f, executor).start(f, "objective");
		expect(result.status).toBe("completed");
		expect(runOrder).toContain("Reviewer");
	});

	it("terminates with FLOW_ERROR after the completion no-progress threshold (Issue-9)", async () => {
		// Planner keeps emitting FLOW_COMPLETE but never produces the required event,
		// and is auto-re-triggered with flow.requirements_unmet — a non-shrinking
		// blocking set. The no-progress guard must fire.
		const planner = step("Planner", {
			triggers: ["start", "flow.requirements_unmet"],
			publishes: [FLOW_COMPLETE],
		});
		const f = flow([planner], { requiredEvents: ["never.happens"] });
		const runOrder: string[] = [];
		const executor = fakeExecutor(() => ({ topic: FLOW_COMPLETE }), runOrder);

		const result = await makeRunner(f, executor).start(f, "objective");
		expect(result.status).toBe("error");
		expect(result.terminal.payload).toMatch(/never\.happens|without closing/i);
		// Planner ran the initial turn + up to the threshold re-triggers (bounded).
		expect(runOrder.length).toBeLessThanOrEqual(COMPLETION_NOPROGRESS_THRESHOLD + 2);
	});
});
