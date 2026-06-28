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

function makeRunner(
	f: OrchestrationFlow,
	executor: StepTurnExecutor,
	listOpenTasks?: () => Promise<Array<{ key: string; description: string }>>,
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
		}),
		makeConversationId: () => `c${convId++}`,
		mode: "act",
		sessionId: "s1",
		abortSignal: new AbortController().signal,
		origin: "user",
		listOpenTasks,
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

	it("FLOW_CANCELLED bypasses open-task enforcement — unlike FLOW_COMPLETE (INT-012 / FR-132)", async () => {
		// A pre-flight Planner cancels while a task is still open. FLOW_COMPLETE
		// would be blocked + re-injected (see the INT-003 test); FLOW_CANCELLED
		// must terminate immediately with status `cancelled`, NOT re-trigger.
		const planner = step("Planner", {
			triggers: ["start", "flow.tasks_remaining"],
			publishes: [FLOW_CANCELLED],
		});
		const f = flow([planner]);
		const runOrder: string[] = [];
		const executor = fakeExecutor(() => ({ topic: FLOW_CANCELLED, payload: "no work to do" }), runOrder);
		// A task is open the whole time — it must NOT block FLOW_CANCELLED.
		const listOpenTasks = async () => [{ key: "step-01", description: "speculative task" }];

		const result = await makeRunner(f, executor, listOpenTasks).start(f, "objective");
		expect(result.status).toBe("cancelled");
		expect(result.terminal.topic).toBe(FLOW_CANCELLED);
		// Planner ran exactly once — no flow.tasks_remaining re-trigger.
		expect(runOrder.filter((n) => n === "Planner").length).toBe(1);
	});

	it("writes session.cancelled with the payload as the reason on FLOW_CANCELLED (INT-012)", async () => {
		const planner = step("Planner", { triggers: ["start"], publishes: [FLOW_CANCELLED] });
		const f = flow([planner]);
		const executor = fakeExecutor(() => ({ topic: FLOW_CANCELLED, payload: "nothing unread" }), []);

		const cancelled: Array<{ reason: string }> = [];
		const log = noopLog();
		(log as unknown as { appendSessionCancelled: (e: { reason: string }) => Promise<void> })
			.appendSessionCancelled = async (e) => {
			cancelled.push(e);
		};

		let convId = 0;
		const runner = new OrchestrationRunner({
			executor,
			sessionLog: log,
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
		const result = await runner.start(f, "objective");
		expect(result.status).toBe("cancelled");
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]!.reason).toBe("nothing unread");
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

	it("blocks FLOW_COMPLETE while a task is open, re-triggers flow.tasks_remaining, then completes (INT-003)", async () => {
		// Planner emits FLOW_COMPLETE while a task is still open → blocked and
		// re-injected as flow.tasks_remaining (auto-subscribed back to Planner).
		// On the re-trigger the task is closed → FLOW_COMPLETE finalizes.
		const planner = step("Planner", {
			triggers: ["start", "flow.tasks_remaining"],
			publishes: [FLOW_COMPLETE],
		});
		const f = flow([planner]);
		const runOrder: string[] = [];

		let open = true;
		const executor = fakeExecutor((name) => {
			if (name === "Planner") {
				// First turn leaves the task open; the re-trigger closes it.
				if (runOrder.filter((n) => n === "Planner").length >= 2) open = false;
				return { topic: FLOW_COMPLETE };
			}
			return { topic: FLOW_COMPLETE };
		}, runOrder);

		const listOpenTasks = async () =>
			open ? [{ key: "step-01", description: "Implement the flag" }] : [];

		const result = await makeRunner(f, executor, listOpenTasks).start(f, "objective");
		expect(result.status).toBe("completed");
		// Planner ran at least twice (blocked once, then completed).
		expect(runOrder.filter((n) => n === "Planner").length).toBeGreaterThanOrEqual(2);
	});

	it("FLOW_COMPLETE finalizes immediately when there are no open tasks (INT-003)", async () => {
		const planner = step("Planner", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([planner]);
		const executor = fakeExecutor(() => ({ topic: FLOW_COMPLETE }), []);
		const result = await makeRunner(f, executor, async () => []).start(f, "objective");
		expect(result.status).toBe("completed");
	});

	it("the flow.tasks_remaining payload enumerates the remaining task keys/descriptions (INT-003)", async () => {
		const planner = step("Planner", {
			triggers: ["start", "flow.tasks_remaining"],
			publishes: [FLOW_COMPLETE],
		});
		const f = flow([planner]);
		const seen: string[] = [];
		let calls = 0;
		const executor = {
			execute: vi.fn(async (req: StepTurnRequest): Promise<StepTurnResult> => {
				calls++;
				// Capture the re-trigger payload the runner injected.
				if (req.event.topic === "flow.tasks_remaining") seen.push(req.event.payload);
				return {
					emission: { topic: FLOW_COMPLETE, payload: "" },
					stopReason: "completed",
					costUsd: 0,
					tokenUsage: { input: 0, output: 0 },
				};
			}),
		} as unknown as StepTurnExecutor;

		let open = true;
		const result = await makeRunner(f, executor, async () => {
			const r = open ? [{ key: "step-01", description: "Implement the flag" }] : [];
			open = false;
			return r;
		}).start(f, "objective");

		expect(result.status).toBe("completed");
		expect(seen.length).toBeGreaterThanOrEqual(1);
		expect(seen[0]).toContain("step-01");
		expect(seen[0]).toContain("Implement the flag");
		expect(calls).toBeGreaterThanOrEqual(2);
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
