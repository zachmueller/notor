/**
 * TEST-005 — Session-recovery idempotency (the Phase-2 recovery gate, INT-005).
 *
 * Drives `SessionRecovery` + the `session-log.jsonl` reader against synthetic
 * logs covering each dangling-tail class and asserts idempotent convergence,
 * budget reconstruction, safety-state rehydration, the chaining-root rule, the
 * malformed-line policy, and `once()` committed-key collection.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-005 / TEST-005
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Parent-rooted recovery
 */

import { describe, it, expect } from "vitest";
import { SessionRecovery, type RecoveryFs } from "./session-recovery";
import { DEFAULT_MAX_COST_USD, DEFAULT_MAX_ITERATIONS } from "./constants";
import type { SessionLogEntry } from "./session-log";
import type { OrchestrationSessionMeta } from "./types";

const recovery = new SessionRecovery();

// ---------------------------------------------------------------------------
// Log builders
// ---------------------------------------------------------------------------

function jsonl(entries: SessionLogEntry[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const TS = "2026-06-28T00:00:00.000Z";

function sessionStart(origin: OrchestrationSessionMeta["origin"], parent: string | null = null): SessionLogEntry {
	return { type: "session.start", session_id: "s", flow: "F", prompt: "obj", origin, parent_session_id: parent, ts: TS };
}
function eventEmitted(turn: number, topic: string, payload = "p", source: string | null = null): SessionLogEntry {
	return { type: "event.emitted", turn, topic, payload, source_step: source, ts: TS };
}
function turnStart(turn: number, step: string, trigger: string, conv: string | null = "c"): SessionLogEntry {
	return { type: "turn.start", turn, step, trigger_topic: trigger, conversation_id: conv, ts: TS };
}
function turnComplete(turn: number, step: string, topic: string, costUsd: number, conv: string | null = "c"): SessionLogEntry {
	return {
		type: "turn.complete",
		turn,
		step,
		emitted_topic: topic,
		conversation_id: conv,
		cost_usd: costUsd,
		token_usage: { input: 100, output: 50 },
		ts: TS,
	};
}
function stepLog(turn: number, step: string, message: string): SessionLogEntry {
	return { type: "step.log", turn, step, level: "info", message, ts: TS };
}

function meta(over: Partial<OrchestrationSessionMeta> = {}): OrchestrationSessionMeta {
	return {
		session_id: "s",
		flow_name: "F",
		status: "interrupted",
		iteration: 2,
		active_step: "A",
		started_at: TS,
		prompt: "obj",
		parent_session_id: null,
		origin: "user",
		...over,
	};
}

const CEIL = { maxIterations: DEFAULT_MAX_ITERATIONS, maxCostUsd: DEFAULT_MAX_COST_USD };

// ---------------------------------------------------------------------------
// Tail classification
// ---------------------------------------------------------------------------

describe("SessionRecovery — tail classification", () => {
	it("a dangling turn.start (no turn.complete) re-emits its trigger", () => {
		const entries = [
			sessionStart("user"),
			eventEmitted(1, "build.start", "the objective"),
			turnStart(2, "Planner", "build.start"),
		];
		const action = recovery.classifyTail(entries);
		expect(action).toEqual({ kind: "re_emit_trigger", topic: "build.start", payload: "the objective", turn: 2 });
	});

	it("a dangling event.emitted (no following turn.start) re-publishes the event", () => {
		const entries = [
			sessionStart("user"),
			eventEmitted(1, "build.start", "obj"),
			turnStart(2, "Planner", "build.start"),
			turnComplete(2, "Planner", "tasks.ready", 0.01),
			eventEmitted(2, "tasks.ready", "{\"task\":\"t1\"}", "Planner"),
		];
		const action = recovery.classifyTail(entries);
		expect(action).toEqual({
			kind: "re_publish_event",
			topic: "tasks.ready",
			payload: "{\"task\":\"t1\"}",
			source_step: "Planner",
			turn: 2,
		});
	});

	it("a fully-completed log (ends in session.complete) yields no action", () => {
		const entries = [
			sessionStart("user"),
			eventEmitted(1, "build.start"),
			turnComplete(2, "Planner", "FLOW_COMPLETE", 0.02),
			{ type: "session.complete", ts: TS } as SessionLogEntry,
		];
		expect(recovery.classifyTail(entries)).toEqual({ kind: "none" });
	});

	it("a dangling user.input.required is classified as still paused (not an interrupted turn)", () => {
		const entries = [
			sessionStart("user"),
			eventEmitted(1, "build.start"),
			turnComplete(2, "Asker", "needs.input", 0.01),
			{ type: "user.input.required", turn: 2, step: "Asker", prompt: "Which option?", ts: TS } as SessionLogEntry,
		];
		expect(recovery.classifyTail(entries)).toEqual({ kind: "still_paused", step: "Asker", prompt: "Which option?", turn: 2 });
	});

	it("idempotency: classifying twice yields the identical action", () => {
		const entries = [sessionStart("user"), eventEmitted(1, "build.start"), turnStart(2, "Planner", "build.start")];
		expect(recovery.classifyTail(entries)).toEqual(recovery.classifyTail(entries));
	});

	it("a step.log tail is a no-op (a diagnostic entry is never replayable)", () => {
		const entries = [
			sessionStart("user"),
			eventEmitted(1, "build.start"),
			turnComplete(2, "Verify", "FLOW_COMPLETE", 0, null),
			{ type: "session.complete", ts: TS } as SessionLogEntry,
			stepLog(2, "Verify", "trailing diagnostic"),
		];
		expect(recovery.classifyTail(entries)).toEqual({ kind: "none" });
	});

	it("a step.log before a dangling turn.start is skipped — the turn governs", () => {
		const entries = [
			sessionStart("user"),
			eventEmitted(1, "build.start", "the objective"),
			stepLog(2, "Planner", "about to plan"),
			turnStart(2, "Planner", "build.start"),
		];
		expect(recovery.classifyTail(entries)).toEqual({
			kind: "re_emit_trigger",
			topic: "build.start",
			payload: "the objective",
			turn: 2,
		});
	});
});

// ---------------------------------------------------------------------------
// Budget reconstruction
// ---------------------------------------------------------------------------

describe("SessionRecovery — budget reconstruction", () => {
	it("replays turn.complete cost to the pre-crash remaining (not reset to full)", () => {
		const entries = [
			sessionStart("user"),
			turnComplete(1, "A", "x", 2.5),
			turnComplete(2, "B", "y", 2.4),
		];
		const budget = recovery.rebuildBudget(entries, { maxIterations: 100, maxCostUsd: 5.0 });
		expect(budget.costRemainingUsd).toBeCloseTo(0.1, 5); // 5.00 − 4.90
		expect(budget.iterationsRemaining).toBe(98); // two LLM turns
	});

	it("code-step turn.complete (conversation_id null) does NOT decrement iterations", () => {
		const entries = [
			sessionStart("user"),
			turnComplete(1, "A", "x", 0.01, "conv"), // LLM turn
			turnComplete(2, "Verify", "y", 0, null), // code step
		];
		const budget = recovery.rebuildBudget(entries, { maxIterations: 100, maxCostUsd: 5.0 });
		expect(budget.iterationsRemaining).toBe(99); // only the LLM turn counts
	});
});

// ---------------------------------------------------------------------------
// Safety-state rehydration
// ---------------------------------------------------------------------------

describe("SessionRecovery — safety-state rehydration", () => {
	it("rebuilds the event history (newest last) for the stale-window detector", () => {
		const entries = [
			sessionStart("user"),
			eventEmitted(1, "a", "p", null),
			eventEmitted(2, "b", "p", "A"),
			eventEmitted(3, "b", "p", "A"),
		];
		const { history } = recovery.rehydrateSafetyState(entries);
		expect(history.map((e) => e.topic)).toEqual(["a", "b", "b"]);
		expect(history[history.length - 1]).toMatchObject({ topic: "b", source_step: "A", turn: 3 });
	});

	it("excludes the re_publish_event dangling tail from rehydrated history (no double-count)", () => {
		// A near-stale self-loop: 3 consecutive (loop, Stepper) emissions, the last
		// of which is the dangling tail (logged but not routed → re_publish_event).
		// resume() re-publishes that tail, so the rehydrated history must NOT also
		// contain it, or the stale window would count it twice and fire one early.
		const log = jsonl([
			sessionStart("user"),
			eventEmitted(1, "loop", "p", "Stepper"),
			eventEmitted(2, "loop", "p", "Stepper"),
			eventEmitted(3, "loop", "p", "Stepper"), // dangling tail (no following turn.start)
		]);
		const recovered = recovery.replay(meta({ origin: "user", status: "interrupted" }), log, undefined);
		expect(recovered.action.kind).toBe("re_publish_event");
		// The rehydrated history holds only the FIRST TWO loop events; resume's
		// re-publish supplies the third — so the window reflects exactly 3, not 4.
		const loopCount = recovered.safety.history.filter((e) => e.topic === "loop").length;
		expect(loopCount).toBe(2);
	});

	it("keeps the full history for a re_emit_trigger tail (no exclusion — distinct signature)", () => {
		const log = jsonl([
			sessionStart("user"),
			eventEmitted(1, "loop", "p", "Stepper"),
			turnStart(2, "Stepper", "loop"), // dangling turn.start → re_emit_trigger
		]);
		const recovered = recovery.replay(meta({ origin: "user", status: "interrupted" }), log, undefined);
		expect(recovered.action.kind).toBe("re_emit_trigger");
		// The event.emitted that drove the interrupted turn stays in the window.
		expect(recovered.safety.history.filter((e) => e.topic === "loop").length).toBe(1);
	});

	it("rebuilds per-task abandonment counters from flow.tasks_remaining payloads", () => {
		const remaining = (keys: string[]) =>
			eventEmitted(0, "flow.tasks_remaining", JSON.stringify({ remaining_tasks: keys.map((k) => ({ key: k })) }), "Planner");
		const entries = [
			sessionStart("user"),
			remaining(["t1", "t2"]),
			remaining(["t1"]),
			remaining(["t1"]),
		];
		const { abandonCounts } = recovery.rehydrateSafetyState(entries);
		expect(abandonCounts.get("t1")).toBe(3);
		expect(abandonCounts.get("t2")).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// once() committed-key collection
// ---------------------------------------------------------------------------

describe("SessionRecovery — committed-key collection", () => {
	it("collects side_effect.committed keys so a re-run skips them", () => {
		const entries = [
			sessionStart("user"),
			{ type: "side_effect.committed", turn: 2, step: "Deploy", key: "git-push", ts: TS } as SessionLogEntry,
			turnComplete(2, "Deploy", "deployed", 0.01),
			{ type: "side_effect.committed", turn: 3, step: "Notify", key: "slack-post", ts: TS } as SessionLogEntry,
		];
		const keys = recovery.collectCommittedKeys(entries);
		expect(keys.has("git-push")).toBe(true);
		expect(keys.has("slack-post")).toBe(true);
		expect(keys.size).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Root selection (origin discriminator + chaining-root rule)
// ---------------------------------------------------------------------------

describe("SessionRecovery — root selection", () => {
	const metas = new Map<string, OrchestrationSessionMeta>();

	it("recovers user and hook origins always", () => {
		expect(recovery.isRecoverableRoot(meta({ origin: "user" }), metas)).toBe(true);
		expect(recovery.isRecoverableRoot(meta({ origin: "hook" }), metas)).toBe(true);
	});

	it("does NOT recover a run_flow child by the top-level scan", () => {
		expect(recovery.isRecoverableRoot(meta({ origin: "run_flow", parent_session_id: "parent" }), metas)).toBe(false);
	});

	it("recovers a chaining successor IFF its predecessor is terminal", () => {
		const map = new Map<string, OrchestrationSessionMeta>();
		map.set("pred-done", meta({ session_id: "pred-done", status: "completed" }));
		map.set("pred-live", meta({ session_id: "pred-live", status: "active" }));

		const chainedTerminalParent = meta({ session_id: "succ", origin: "chaining", parent_session_id: "pred-done" });
		const chainedLiveParent = meta({ session_id: "succ2", origin: "chaining", parent_session_id: "pred-live" });
		expect(recovery.isRecoverableRoot(chainedTerminalParent, map)).toBe(true);
		expect(recovery.isRecoverableRoot(chainedLiveParent, map)).toBe(false);
	});

	it("does NOT recover a chaining successor with a missing/null parent", () => {
		expect(recovery.isRecoverableRoot(meta({ origin: "chaining", parent_session_id: null }), metas)).toBe(false);
		expect(recovery.isRecoverableRoot(meta({ origin: "chaining", parent_session_id: "ghost" }), metas)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Full scan over a fake RecoveryFs
// ---------------------------------------------------------------------------

/** A fake recovery FS holding session.json + log per session. */
class FakeRecoveryFs implements RecoveryFs {
	constructor(
		private readonly sessions: Record<string, { meta?: OrchestrationSessionMeta; log?: string }>,
	) {}
	async listSessions(): Promise<string[]> {
		return Object.keys(this.sessions);
	}
	async readMeta(id: string): Promise<string | null> {
		const s = this.sessions[id];
		return s?.meta ? JSON.stringify(s.meta) : null;
	}
	async readLog(id: string): Promise<string | null> {
		const s = this.sessions[id];
		return s?.log ?? null;
	}
}

describe("SessionRecovery — scan", () => {
	it("selects recoverable roots and classifies each, ignoring terminal sessions", async () => {
		const fs = new FakeRecoveryFs({
			"sess-user": {
				meta: meta({ session_id: "sess-user", origin: "user", status: "interrupted" }),
				log: jsonl([sessionStart("user"), eventEmitted(1, "build.start", "obj"), turnStart(2, "Planner", "build.start")]),
			},
			"sess-done": {
				meta: meta({ session_id: "sess-done", origin: "user", status: "completed" }),
				log: jsonl([sessionStart("user"), { type: "session.complete", ts: TS } as SessionLogEntry]),
			},
			"sess-child": {
				meta: meta({ session_id: "sess-child", origin: "run_flow", status: "interrupted", parent_session_id: "sess-user" }),
				log: jsonl([sessionStart("run_flow", "sess-user")]),
			},
		});
		const { recoverable, errors } = await recovery.scan(fs);
		expect(errors).toHaveLength(0);
		expect(recoverable.map((r) => r.sessionId)).toEqual(["sess-user"]);
		expect(recoverable[0]!.action.kind).toBe("re_emit_trigger");
	});

	it("surfaces an absent/unexpected origin as a LOUD recovery error (not silent skip)", async () => {
		const fs = new FakeRecoveryFs({
			"sess-bad": {
				meta: { ...meta({ session_id: "sess-bad" }), origin: "weird" as unknown as "user" },
				log: jsonl([sessionStart("user")]),
			},
		});
		const { recoverable, errors } = await recovery.scan(fs);
		expect(recoverable).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.sessionId).toBe("sess-bad");
		expect(errors[0]!.reason).toMatch(/origin/i);
	});

	it("fails a session loudly when its log has a malformed INTERIOR line", async () => {
		const goodHead = JSON.stringify(turnStart(1, "A", "start"));
		const goodTail = JSON.stringify(turnComplete(1, "A", "x", 0.01));
		const log = `${goodHead}\n{ broken interior }\n${goodTail}\n`;
		const fs = new FakeRecoveryFs({
			"sess-corrupt": { meta: meta({ session_id: "sess-corrupt", origin: "user", status: "interrupted" }), log },
		});
		const { recoverable, errors } = await recovery.scan(fs);
		expect(recoverable).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]!.reason).toMatch(/malformed interior/i);
	});

	it("recovers a chaining-root (terminal predecessor) but not a live-parent chaining child", async () => {
		const fs = new FakeRecoveryFs({
			"pred": {
				meta: meta({ session_id: "pred", origin: "user", status: "completed" }),
				log: jsonl([sessionStart("user"), { type: "session.complete", ts: TS } as SessionLogEntry]),
			},
			"succ": {
				meta: meta({ session_id: "succ", origin: "chaining", status: "interrupted", parent_session_id: "pred" }),
				log: jsonl([sessionStart("chaining", "pred"), eventEmitted(1, "start", "obj"), turnStart(2, "S", "start")]),
			},
			"succ-live": {
				meta: meta({ session_id: "succ-live", origin: "chaining", status: "interrupted", parent_session_id: "live-pred" }),
				log: jsonl([sessionStart("chaining", "live-pred")]),
			},
			"live-pred": {
				meta: meta({ session_id: "live-pred", origin: "user", status: "active" }),
				log: jsonl([sessionStart("user"), turnStart(1, "X", "start")]),
			},
		});
		const { recoverable } = await recovery.scan(fs);
		const ids = recoverable.map((r) => r.sessionId).sort();
		// `succ` (terminal predecessor) + `live-pred` (a user root) recover;
		// `succ-live` (non-terminal parent) is reconciled by the parent, not scanned.
		expect(ids).toContain("succ");
		expect(ids).toContain("live-pred");
		expect(ids).not.toContain("succ-live");
	});

	it("idempotency: scanning twice yields the same resume actions", async () => {
		const fs = new FakeRecoveryFs({
			"sess-user": {
				meta: meta({ session_id: "sess-user", origin: "user", status: "interrupted" }),
				log: jsonl([sessionStart("user"), eventEmitted(1, "build.start", "obj"), turnStart(2, "Planner", "build.start")]),
			},
		});
		const a = await recovery.scan(fs);
		const b = await recovery.scan(fs);
		expect(a.recoverable[0]!.action).toEqual(b.recoverable[0]!.action);
		expect(a.recoverable[0]!.budget).toEqual(b.recoverable[0]!.budget);
	});

	it("rebuilds budget from the flow's resolved ceilings during a scan", async () => {
		const fs = new FakeRecoveryFs({
			"sess": {
				meta: meta({ session_id: "sess", origin: "user", status: "interrupted", flow_name: "Costly" }),
				log: jsonl([sessionStart("user"), turnComplete(1, "A", "x", 4.9), turnStart(2, "B", "x")]),
			},
		});
		const { recoverable } = await recovery.scan(fs, {
			resolveCeilings: (name) => (name === "Costly" ? { maxIterations: 100, maxCostUsd: 5.0 } : null),
		});
		expect(recoverable[0]!.budget.costRemainingUsd).toBeCloseTo(0.1, 5);
	});

	it("tolerates a truncated final line during a scan (no throw, last entry governs)", async () => {
		const log =
			JSON.stringify(turnComplete(1, "A", "x", 0.01)) + "\n" +
			'{"type":"event.emitted","turn":1,"top'; // partial
		const fs = new FakeRecoveryFs({
			"sess": { meta: meta({ session_id: "sess", origin: "user", status: "interrupted" }), log },
		});
		const { recoverable, errors } = await recovery.scan(fs);
		expect(errors).toHaveLength(0);
		expect(recoverable).toHaveLength(1);
		expect(recoverable[0]!.truncatedFinalLine).toBe(true);
	});
});

void CEIL;
