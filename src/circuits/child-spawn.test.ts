/**
 * F6 §5.1 — `makeChildFlowSpawner` ledger replay (catches F1 Fix 3).
 *
 * Task 03 landed `child-ledger.test.ts` for the pure `matchChildInLedger`; this
 * covers the *spawner* path that consumes it — over a fake ledger fs + a spy
 * launcher (no vault, no runner):
 *  - an empty ledger ⇒ a fresh spawn (the launcher runs, `child.spawned`/`.result`
 *    bracket it);
 *  - a replayed dispatch whose `child.result` is recorded ⇒ **reuse** the recorded
 *    result, **no re-launch** (the parent's replay must not double-execute a child);
 *  - two same-`(step, flow)` dispatches match by **ordinal**, not `via_tool_call_id`.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md — §5.1
 */

import { describe, it, expect, vi } from "vitest";
import { makeChildFlowSpawner, type ChildLedgerFs } from "./child-spawn";
import type { OrchestrationHost } from "./host";
import type { OrchestrationRunResult } from "./runner";
import type { SpawnChildFlowRequest } from "./child-flow";
import { FLOW_COMPLETE, type OrchestrationFlow } from "./types";
import type { AggregateBudget } from "../run-loop/types";
import type { SessionLogEntry } from "./session-log";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TS = "2026-06-28T00:00:00.000Z";

function flow(over: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
	return {
		name: "ChildFlow",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: FLOW_COMPLETE,
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		schedule: null,
		invocable: true,
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

function budget(): AggregateBudget {
	return { iterationsRemaining: 50, costRemainingUsd: 5 };
}

function runResult(over: Partial<OrchestrationRunResult> = {}): OrchestrationRunResult {
	return {
		status: "completed",
		terminal: { topic: FLOW_COMPLETE, payload: "child done", source_step: null, turn: 1, ts: TS },
		iterations: 3,
		structured: { ok: true },
		text: "child done",
		subtreeConsumed: { costUsd: 1.5, iterations: 3, maxDepthReached: 1 },
		tokenUsage: { input: 100, output: 50 },
		budget: budget(),
		depth: 1,
		...over,
	};
}

function req(over: Partial<SpawnChildFlowRequest> = {}): SpawnChildFlowRequest {
	return {
		flowName: "ChildFlow",
		payload: "do the thing",
		parentSessionId: "parent-1",
		parentScratchpadPath: "notor/orchestrations/sessions/parent-1/scratchpad",
		stepName: "Caller",
		turn: 4,
		ordinal: 0,
		viaToolCallId: "call-fresh",
		cascade: { budget: budget(), depth: 0, abort: new AbortController().signal },
		...over,
	};
}

function jsonl(entries: SessionLogEntry[]): string {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function spawnedEntry(over: Partial<Extract<SessionLogEntry, { type: "child.spawned" }>> = {}): SessionLogEntry {
	return {
		type: "child.spawned",
		turn: 4,
		step: "Caller",
		flow_name: "ChildFlow",
		ordinal: 0,
		via_tool_call_id: "call-original",
		child_session_id: "child-recorded",
		ts: TS,
		...over,
	} as SessionLogEntry;
}

function resultEntry(over: Partial<Extract<SessionLogEntry, { type: "child.result" }>> = {}): SessionLogEntry {
	return {
		type: "child.result",
		turn: 4,
		child_session_id: "child-recorded",
		structured: { reused: true },
		text: "recorded child text",
		stop_reason: FLOW_COMPLETE,
		cost_usd: 2,
		iterations: 5,
		ts: TS,
		...over,
	} as SessionLogEntry;
}

/**
 * A host with an in-memory vault adapter — the parent `child.spawned`/`child.result`
 * appends go through `VaultSessionLogWriter` → this adapter. The ledger *reads* are
 * injected via `ChildLedgerFs`, so the two are independent.
 */
function fakeHost(): { host: OrchestrationHost; appended: string[] } {
	const appended: string[] = [];
	const adapter = {
		exists: async () => true,
		read: async () => "",
		write: async () => {},
		append: async (_p: string, data: string) => {
			appended.push(data);
		},
		mkdir: async () => {},
		rename: async () => {},
		list: async () => ({ files: [], folders: [] }),
	};
	const host = {
		app: { vault: { adapter } },
		settings: { notor_dir: "notor", history_path: "notor/chats" },
	} as unknown as OrchestrationHost;
	return { host, appended };
}

/** A fake ledger reader over a single parent-log string. */
function ledger(raw: string | null): ChildLedgerFs {
	return {
		exists: async () => raw !== null,
		read: async () => raw ?? "",
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeChildFlowSpawner — ledger replay (F6 §5.1)", () => {
	it("fresh spawn on an empty ledger — launches the child once", async () => {
		const { host } = fakeHost();
		const launch = vi.fn(async () => runResult());
		const spawn = makeChildFlowSpawner(host, undefined, {
			ledgerFs: ledger(""),
			resolveFlow: async () => flow(),
			launch,
		});

		const out = await spawn(req());

		expect(launch).toHaveBeenCalledTimes(1);
		expect(out.status).toBe("completed");
		expect(out.text).toBe("child done");
		expect(out.rollup.costUsd).toBe(1.5);
	});

	it("reuses a recorded terminal child result WITHOUT re-launching (F1.3 no-double-execute)", async () => {
		const { host } = fakeHost();
		const launch = vi.fn(async () => runResult());
		const parentLog = jsonl([spawnedEntry(), resultEntry()]);
		const spawn = makeChildFlowSpawner(host, undefined, {
			ledgerFs: ledger(parentLog),
			resolveFlow: async () => flow(),
			launch,
		});

		const out = await spawn(req({ viaToolCallId: "call-fresh-replay" }));

		// The child is NOT re-spawned — the recorded result is reused verbatim.
		expect(launch).not.toHaveBeenCalled();
		expect(out.childSessionId).toBe("child-recorded");
		expect(out.text).toBe("recorded child text");
		expect(out.structured).toEqual({ reused: true });
		expect(out.stopReason).toBe(FLOW_COMPLETE);
	});

	it("matches by ordinal, not via_tool_call_id — the 2nd dispatch reuses the 2nd record", async () => {
		const { host } = fakeHost();
		const launch = vi.fn(async () => runResult());
		const parentLog = jsonl([
			spawnedEntry({ ordinal: 0, child_session_id: "child-a", via_tool_call_id: "id-a" }),
			resultEntry({ child_session_id: "child-a", text: "first child" }),
			spawnedEntry({ ordinal: 1, child_session_id: "child-b", via_tool_call_id: "id-b" }),
			resultEntry({ child_session_id: "child-b", text: "second child" }),
		]);
		const spawn = makeChildFlowSpawner(host, undefined, {
			ledgerFs: ledger(parentLog),
			resolveFlow: async () => flow(),
			launch,
		});

		// A replay re-issues run_flow with a FRESH via_tool_call_id; the match is by ordinal.
		const second = await spawn(req({ ordinal: 1, viaToolCallId: "totally-fresh-id" }));

		expect(launch).not.toHaveBeenCalled();
		expect(second.childSessionId).toBe("child-b");
		expect(second.text).toBe("second child");
	});

	it("an old-format child.spawned lacking flow_name/ordinal falls through to a fresh spawn", async () => {
		const { host } = fakeHost();
		const launch = vi.fn(async () => runResult({ text: "freshly spawned" }));
		// Legacy entry: step held a conversation UUID, no flow_name/ordinal.
		const legacy = { type: "child.spawned", turn: 4, step: "conv-uuid", via_tool_call_id: "old", child_session_id: "child-legacy", ts: TS } as unknown as SessionLogEntry;
		const spawn = makeChildFlowSpawner(host, undefined, {
			ledgerFs: ledger(jsonl([legacy])),
			resolveFlow: async () => flow(),
			launch,
		});

		const out = await spawn(req());

		// No wrong reuse — a fresh spawn runs.
		expect(launch).toHaveBeenCalledTimes(1);
		expect(out.text).toBe("freshly spawned");
	});

	it("returns an error result (no launch) when the callee flow is not invocable", async () => {
		const { host } = fakeHost();
		const launch = vi.fn(async () => runResult());
		const spawn = makeChildFlowSpawner(host, undefined, {
			ledgerFs: ledger(""),
			resolveFlow: async () => null,
			launch,
		});

		const out = await spawn(req({ flowName: "Ghost" }));

		expect(launch).not.toHaveBeenCalled();
		expect(out.status).toBe("error");
		expect(out.text).toContain("not invocable");
	});
});
