/**
 * Child-flow ledger matching (F1 Fix 3) — pure, Obsidian-free.
 *
 * On a recovery replay a `run_flow` parent re-runs the interrupted step from fresh
 * context; the LLM re-issues the same `run_flow` call but with a brand-new
 * `via_tool_call_id` (and new provider `tool_use` ids). So the durable
 * `child.spawned`/`child.result` ledger CANNOT be matched by id — it is matched by
 * **occurrence order per (step name, callee flowName)**: the Nth dispatch of flow
 * F on step S maps to the Nth `child.spawned` with `(step === S, flow_name === F,
 * ordinal === n)`. v1 runs `run_flow` serially within a step, so the ordinal is a
 * stable cross-replay key.
 *
 * Kept pure (no plugin / no vault) so the reuse-vs-respawn decision is
 * unit-testable over a synthetic parsed log.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F1-orchestration-run-lifecycle.md — Fix 3
 */

import type { ChildResultEntry, ChildSpawnedEntry, SessionLogEntry } from "./session-log";

/** The replay-stable identity of one `run_flow` dispatch. */
export interface ChildDispatchKey {
	/** The dispatching step's name. */
	stepName: string;
	/** The callee flow's `notor-flow-name`. */
	flowName: string;
	/** The 0-based Nth dispatch for this (stepName, flowName) within the step. */
	ordinal: number;
}

/** The outcome of matching a dispatch against a parent's parsed ledger. */
export interface ChildLedgerMatch {
	/** The matched `child.spawned` entry (the recovery anchor). */
	spawned: ChildSpawnedEntry;
	/** The child's terminal `child.result`, if one was recorded (⇒ reuse; else ⇒ resume). */
	result: ChildResultEntry | null;
}

/**
 * Find the `child.spawned` for `key` (and its `child.result`, if any) in a parent
 * session's parsed log entries. Returns `null` when there is no match — a fresh
 * spawn. An old-format entry lacking `flow_name`/`ordinal` never matches (its
 * `flow_name`/`ordinal` are `undefined`, so the strict `===` comparisons fail),
 * which preserves today's behavior: worst case is a fresh spawn, never a wrong reuse.
 */
export function matchChildInLedger(
	entries: SessionLogEntry[],
	key: ChildDispatchKey,
): ChildLedgerMatch | null {
	const spawned = entries.find(
		(e): e is ChildSpawnedEntry =>
			e.type === "child.spawned" &&
			e.step === key.stepName &&
			e.flow_name === key.flowName &&
			e.ordinal === key.ordinal,
	);
	if (!spawned) return null;

	const result =
		entries.find(
			(e): e is ChildResultEntry =>
				e.type === "child.result" && e.child_session_id === spawned.child_session_id,
		) ?? null;

	return { spawned, result };
}

/** Parse a raw `session-log.jsonl` string into entries, tolerating bad lines. */
export function parseLedgerEntries(raw: string): SessionLogEntry[] {
	return raw
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l): SessionLogEntry | null => {
			try {
				return JSON.parse(l) as SessionLogEntry;
			} catch {
				return null;
			}
		})
		.filter((e): e is SessionLogEntry => e !== null);
}
