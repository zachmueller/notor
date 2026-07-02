/**
 * F1 Fix 3 — deterministic child-flow ledger matching (the data-integrity core).
 *
 * Recovery replay re-runs a `run_flow` step from fresh context and re-issues the
 * tool with a BRAND-NEW `via_tool_call_id`. The ledger must still match the prior
 * dispatch — by occurrence order per (step, flow, ordinal), NOT by id — so the
 * child is reused/resumed instead of re-spawned (which would double-execute its
 * side effects). These tests drive the pure matcher over a synthetic parent log.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F1-orchestration-run-lifecycle.md — Fix 3
 */

import { describe, it, expect } from "vitest";
import { matchChildInLedger, parseLedgerEntries } from "./child-ledger";
import type { SessionLogEntry } from "./session-log";

const TS = "2026-07-02T00:00:00.000Z";

function spawned(
	over: Partial<Extract<SessionLogEntry, { type: "child.spawned" }>> = {},
): SessionLogEntry {
	return {
		type: "child.spawned",
		ts: TS,
		turn: 1,
		step: "Caller",
		flow_name: "ChildFlow",
		ordinal: 0,
		via_tool_call_id: "runflow-original",
		child_session_id: "child-1",
		...over,
	};
}

function result(
	over: Partial<Extract<SessionLogEntry, { type: "child.result" }>> = {},
): SessionLogEntry {
	return {
		type: "child.result",
		ts: TS,
		turn: 1,
		child_session_id: "child-1",
		text: "child output",
		stop_reason: "FLOW_COMPLETE",
		...over,
	};
}

describe("matchChildInLedger — replay no-respawn", () => {
	it("matches a prior dispatch by (step, flow, ordinal) even with a FRESH via_tool_call_id", () => {
		// The durable log was written with viaToolCallId "runflow-original"; the
		// replay dispatches with a fresh id — the match must still hit.
		const entries = [spawned({ via_tool_call_id: "runflow-original" }), result()];
		const match = matchChildInLedger(entries, {
			stepName: "Caller",
			flowName: "ChildFlow",
			ordinal: 0,
		});
		expect(match).not.toBeNull();
		expect(match!.spawned.child_session_id).toBe("child-1");
		// The recorded result is present → the reuse path (no re-spawn).
		expect(match!.result).not.toBeNull();
		expect(match!.result!.text).toBe("child output");
	});

	it("returns a spawned-without-result match (⇒ resume-in-place, not respawn)", () => {
		const entries = [spawned()]; // spawned but never settled
		const match = matchChildInLedger(entries, {
			stepName: "Caller",
			flowName: "ChildFlow",
			ordinal: 0,
		});
		expect(match).not.toBeNull();
		expect(match!.result).toBeNull();
	});

	it("does NOT match a different step / flow (→ fresh spawn)", () => {
		const entries = [spawned()];
		expect(
			matchChildInLedger(entries, { stepName: "Other", flowName: "ChildFlow", ordinal: 0 }),
		).toBeNull();
		expect(
			matchChildInLedger(entries, { stepName: "Caller", flowName: "OtherFlow", ordinal: 0 }),
		).toBeNull();
	});

	it("does NOT match an old-format entry lacking flow_name/ordinal (→ fresh spawn, no wrong reuse)", () => {
		// A pre-F1 child.spawned: step held a conversation UUID, no flow_name/ordinal.
		const legacy = {
			type: "child.spawned",
			ts: TS,
			turn: 0,
			step: "conv-uuid-abc",
			via_tool_call_id: "runflow-x",
			child_session_id: "child-legacy",
		} as unknown as SessionLogEntry;
		expect(
			matchChildInLedger([legacy], { stepName: "Caller", flowName: "ChildFlow", ordinal: 0 }),
		).toBeNull();
	});
});

describe("matchChildInLedger — ordinal", () => {
	it("matches the 1st and 2nd dispatch of the same flow in one step to the 1st and 2nd entry", () => {
		const entries = [
			spawned({ ordinal: 0, child_session_id: "child-a", via_tool_call_id: "id-a" }),
			result({ child_session_id: "child-a", text: "first" }),
			spawned({ ordinal: 1, child_session_id: "child-b", via_tool_call_id: "id-b" }),
			result({ child_session_id: "child-b", text: "second" }),
		];
		const first = matchChildInLedger(entries, { stepName: "Caller", flowName: "ChildFlow", ordinal: 0 });
		const second = matchChildInLedger(entries, { stepName: "Caller", flowName: "ChildFlow", ordinal: 1 });
		expect(first!.spawned.child_session_id).toBe("child-a");
		expect(first!.result!.text).toBe("first");
		expect(second!.spawned.child_session_id).toBe("child-b");
		expect(second!.result!.text).toBe("second");
		// A third dispatch has no prior entry → fresh spawn.
		expect(
			matchChildInLedger(entries, { stepName: "Caller", flowName: "ChildFlow", ordinal: 2 }),
		).toBeNull();
	});
});

describe("parseLedgerEntries", () => {
	it("parses valid lines and tolerates blank / malformed lines", () => {
		const raw =
			JSON.stringify(spawned()) + "\n" + "{ not json }" + "\n\n" + JSON.stringify(result()) + "\n";
		const entries = parseLedgerEntries(raw);
		expect(entries.map((e) => e.type)).toEqual(["child.spawned", "child.result"]);
	});
});
