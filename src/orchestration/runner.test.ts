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
import { SessionRecovery, type RecoverableSession } from "./session-recovery";
import type { SessionLogEntry } from "./session-log";
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
		schedule: null,
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

	// -- INT-030: interactive pause (user.input.required) --------------------

	/** A SessionLog that records every appended entry (for write-order assertions). */
	function recordingLog(events: Array<{ type: string; [k: string]: unknown }>): SessionLog {
		const rec = (type: string) => async (e?: Record<string, unknown>) => {
			events.push({ type, ...(e ?? {}) });
		};
		return {
			appendSessionStart: rec("session.start"),
			appendTurnStart: rec("turn.start"),
			appendTurnComplete: rec("turn.complete"),
			appendEventEmitted: rec("event.emitted"),
			appendEventEmissionOverwritten: rec("event.emission_overwritten"),
			appendChildSpawned: rec("child.spawned"),
			appendChildResult: rec("child.result"),
			appendSessionCancelled: rec("session.cancelled"),
			appendSessionComplete: rec("session.complete"),
			appendUserInputRequired: rec("user.input.required"),
			appendUserInputReceived: rec("user.input.received"),
		} as unknown as SessionLog;
	}

	function makeInteractiveRunner(args: {
		f: OrchestrationFlow;
		executor: StepTurnExecutor;
		log: SessionLog;
		requestUserInput?: (prompt: string) => Promise<string | null>;
		setSessionStatus?: (status: "active" | "interrupted") => Promise<void>;
	}) {
		let convId = 0;
		return new OrchestrationRunner({
			executor: args.executor,
			sessionLog: args.log,
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
			requestUserInput: args.requestUserInput,
			setSessionStatus: args.setSessionStatus,
		});
	}

	it("pauses on user.input.required, then resumes by re-triggering the paused step with the user's answer", async () => {
		// Asker emits user.input.required (its emission); on the resume re-trigger it
		// emits FLOW_COMPLETE. The runner must collect input and feed it back as the
		// resume event's payload to the same step.
		const asker = step("Asker", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([asker]);

		const events: Array<{ type: string; [k: string]: unknown }> = [];
		const log = recordingLog(events);
		const statusLog: string[] = [];
		const seenPayloads: string[] = [];
		let calls = 0;

		const executor = {
			execute: vi.fn(async (req: StepTurnRequest): Promise<StepTurnResult> => {
				calls++;
				seenPayloads.push(req.event.payload);
				// First turn → ask. Resume turn → complete.
				const topic = calls === 1 ? "user.input.required" : FLOW_COMPLETE;
				const payload = calls === 1 ? "Which database?" : "";
				return {
					emission: { topic, payload },
					stopReason: "completed",
					costUsd: 0,
					tokenUsage: { input: 0, output: 0 },
				};
			}),
		} as unknown as StepTurnExecutor;

		const runner = makeInteractiveRunner({
			f,
			executor,
			log,
			requestUserInput: async () => "PostgreSQL",
			setSessionStatus: async (s) => {
				statusLog.push(s);
			},
		});

		const result = await runner.start(f, "objective");

		expect(result.status).toBe("completed");
		// The pausing entry is written BEFORE the resume entry (write order).
		const requiredIdx = events.findIndex((e) => e.type === "user.input.required");
		const receivedIdx = events.findIndex((e) => e.type === "user.input.received");
		expect(requiredIdx).toBeGreaterThanOrEqual(0);
		expect(receivedIdx).toBeGreaterThan(requiredIdx);
		// Status went interrupted (paused) then active (resumed).
		expect(statusLog).toEqual(["interrupted", "active"]);
		// The resume re-triggered Asker with the user's answer as the payload.
		expect(seenPayloads).toContain("PostgreSQL");
		// user.input.received is written BEFORE the resume event.emitted is routed.
		const resumeEventIdx = events.findIndex(
			(e) => e.type === "event.emitted" && e.topic === "user.input.received",
		);
		expect(resumeEventIdx).toBeGreaterThan(receivedIdx);
	});

	it("writes user.input.required BEFORE suspending and sets status interrupted", async () => {
		const asker = step("Asker", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([asker]);
		const events: Array<{ type: string; [k: string]: unknown }> = [];
		const log = recordingLog(events);
		let statusAtPrompt: string | null = null;
		const statusLog: string[] = [];

		let calls = 0;
		const executor = {
			execute: vi.fn(async (): Promise<StepTurnResult> => {
				calls++;
				return {
					emission:
						calls === 1
							? { topic: "user.input.required", payload: "Proceed?" }
							: { topic: FLOW_COMPLETE, payload: "" },
					stopReason: "completed",
					costUsd: 0,
					tokenUsage: { input: 0, output: 0 },
				};
			}),
		} as unknown as StepTurnExecutor;

		const runner = makeInteractiveRunner({
			f,
			executor,
			log,
			requestUserInput: async () => {
				// At the moment we are asked, the pause entry must already be durable
				// and status interrupted.
				statusAtPrompt = statusLog[statusLog.length - 1] ?? null;
				expect(events.some((e) => e.type === "user.input.required")).toBe(true);
				return "yes";
			},
			setSessionStatus: async (s) => {
				statusLog.push(s);
			},
		});

		await runner.start(f, "objective");
		expect(statusAtPrompt).toBe("interrupted");
	});

	it("declining the prompt finalizes via FLOW_CANCELLED (status cancelled), bypassing task enforcement", async () => {
		const asker = step("Asker", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([asker]);
		const events: Array<{ type: string; [k: string]: unknown }> = [];
		const log = recordingLog(events);

		const executor = {
			execute: vi.fn(async (): Promise<StepTurnResult> => ({
				emission: { topic: "user.input.required", payload: "Pick one" },
				stopReason: "completed",
				costUsd: 0,
				tokenUsage: { input: 0, output: 0 },
			})),
		} as unknown as StepTurnExecutor;

		const runner = makeInteractiveRunner({
			f,
			executor,
			log,
			requestUserInput: async () => null, // declined / dismissed
			setSessionStatus: async () => {},
		});

		const result = await runner.start(f, "objective");
		expect(result.status).toBe("cancelled");
		expect(result.terminal.topic).toBe(FLOW_CANCELLED);
		// No resume was written.
		expect(events.some((e) => e.type === "user.input.received")).toBe(false);
	});

	it("cancels the run when no input channel is wired (requestUserInput omitted) — never hangs", async () => {
		const asker = step("Asker", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([asker]);
		const events: Array<{ type: string; [k: string]: unknown }> = [];
		const log = recordingLog(events);
		const executor = {
			execute: vi.fn(async (): Promise<StepTurnResult> => ({
				emission: { topic: "user.input.required", payload: "?" },
				stopReason: "completed",
				costUsd: 0,
				tokenUsage: { input: 0, output: 0 },
			})),
		} as unknown as StepTurnExecutor;

		// No requestUserInput / setSessionStatus injected.
		const result = await makeInteractiveRunner({ f, executor, log }).start(f, "objective");
		expect(result.status).toBe("cancelled");
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

	// -- INT-030: paused-session recovery (resume from a dangling tail) -------

	/** Classify a synthetic paused log into a RecoverableSession via real SessionRecovery. */
	function recoverPausedSession(pausedStep: string, prompt: string): RecoverableSession {
		const TS = "2026-06-29T00:00:00.000Z";
		const log =
			[
				{ type: "session.start", session_id: "s1", flow: "Demo", prompt: "objective", origin: "user", parent_session_id: null, ts: TS },
				{ type: "event.emitted", turn: 1, topic: "start", payload: "objective", source_step: null, ts: TS },
				{ type: "turn.start", turn: 2, step: pausedStep, trigger_topic: "start", conversation_id: "c0", ts: TS },
				{ type: "turn.complete", turn: 2, step: pausedStep, emitted_topic: "user.input.required", conversation_id: "c0", cost_usd: 0.01, token_usage: { input: 10, output: 5 }, ts: TS },
				{ type: "user.input.required", turn: 2, step: pausedStep, prompt, ts: TS },
			]
				.map((e) => JSON.stringify(e as SessionLogEntry))
				.join("\n") + "\n";
		return new SessionRecovery().replay(
			{
				session_id: "s1",
				flow_name: "Demo",
				status: "interrupted",
				iteration: 2,
				active_step: pausedStep,
				started_at: TS,
				prompt: "objective",
				parent_session_id: null,
				origin: "user",
			},
			log,
			{ resolveCeilings: () => ({ maxIterations: 100, maxCostUsd: 5 }) },
		);
	}

	it("recovers a paused session: re-surfaces the prompt and resumes by re-triggering the paused step", async () => {
		const asker = step("Asker", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([asker]);
		const recovered = recoverPausedSession("Asker", "Which option?");
		expect(recovered.action.kind).toBe("still_paused");

		const seenPayloads: string[] = [];
		const executor = {
			execute: vi.fn(async (req: StepTurnRequest): Promise<StepTurnResult> => {
				seenPayloads.push(req.event.payload);
				return {
					emission: { topic: FLOW_COMPLETE, payload: "" },
					stopReason: "completed",
					costUsd: 0,
					tokenUsage: { input: 0, output: 0 },
				};
			}),
		} as unknown as StepTurnExecutor;

		const events: Array<{ type: string; [k: string]: unknown }> = [];
		let prompted = 0;
		const runner = makeInteractiveRunner({
			f,
			executor,
			log: recordingLog(events),
			requestUserInput: async (p) => {
				prompted++;
				expect(p).toBe("Which option?"); // the re-surfaced prompt
				return "Option B";
			},
			setSessionStatus: async () => {},
		});

		const result = await runner.resume(f, recovered);
		expect(result.status).toBe("completed");
		expect(prompted).toBe(1);
		// The recovered paused tail is NOT re-appended; only the resume entry is.
		expect(events.some((e) => e.type === "user.input.required")).toBe(false);
		expect(events.some((e) => e.type === "user.input.received")).toBe(true);
		// The paused step was re-triggered with the user's answer.
		expect(seenPayloads).toContain("Option B");
	});

	it("re-running recovery over the same paused tail re-surfaces the prompt and does not double-resume (idempotent)", async () => {
		const asker = step("Asker", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([asker]);

		const run = async () => {
			const recovered = recoverPausedSession("Asker", "Pick?");
			const events: Array<{ type: string; [k: string]: unknown }> = [];
			let prompted = 0;
			const executor = {
				execute: vi.fn(async (): Promise<StepTurnResult> => ({
					emission: { topic: FLOW_COMPLETE, payload: "" },
					stopReason: "completed",
					costUsd: 0,
					tokenUsage: { input: 0, output: 0 },
				})),
			} as unknown as StepTurnExecutor;
			const runner = makeInteractiveRunner({
				f,
				executor,
				log: recordingLog(events),
				requestUserInput: async () => {
					prompted++;
					return "answer";
				},
				setSessionStatus: async () => {},
			});
			const result = await runner.resume(f, recovered);
			return { result, prompted, receivedCount: events.filter((e) => e.type === "user.input.received").length };
		};

		const a = await run();
		const b = await run();
		// Each independent recovery re-surfaces the prompt exactly once and resumes once.
		expect(a.prompted).toBe(1);
		expect(b.prompted).toBe(1);
		expect(a.receivedCount).toBe(1);
		expect(b.receivedCount).toBe(1);
		expect(a.result.status).toBe("completed");
		expect(b.result.status).toBe("completed");
	});

	it("cancels a recovered paused session when the user declines the re-surfaced prompt", async () => {
		const asker = step("Asker", { triggers: ["start"], publishes: [FLOW_COMPLETE] });
		const f = flow([asker]);
		const recovered = recoverPausedSession("Asker", "Continue?");
		const events: Array<{ type: string; [k: string]: unknown }> = [];
		const executor = {
			execute: vi.fn(async (): Promise<StepTurnResult> => ({
				emission: { topic: FLOW_COMPLETE, payload: "" },
				stopReason: "completed",
				costUsd: 0,
				tokenUsage: { input: 0, output: 0 },
			})),
		} as unknown as StepTurnExecutor;
		const runner = makeInteractiveRunner({
			f,
			executor,
			log: recordingLog(events),
			requestUserInput: async () => null,
			setSessionStatus: async () => {},
		});
		const result = await runner.resume(f, recovered);
		expect(result.status).toBe("cancelled");
		expect(result.terminal.topic).toBe(FLOW_CANCELLED);
		expect(executor.execute).not.toHaveBeenCalled();
	});
});
