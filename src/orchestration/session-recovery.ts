/**
 * `SessionRecovery` (INT-005 / FR-125) — load-time scan + idempotent replay of
 * `session-log.jsonl` to the last consistent state.
 *
 * Phase-2 scope (the parent-rooted + chaining-root contract, Risk #12):
 *  - **Root-selection scan by `origin`** (always set; loud on absent/unexpected):
 *    `user` / `hook` recover **always** (each is a root with no live launcher to
 *    reconcile it); `chaining` recovers **iff** its `parent_session_id` resolves
 *    to an **already-terminal** predecessor (the chained-successor orphan fix);
 *    `run_flow` (and `chaining` with a non-terminal parent) is **not** scanned —
 *    reconciled by the parent's replay (INT-044, Phase 7). An **absent/unexpected
 *    `origin`** is surfaced as a **loud recovery error**, never silently skipped.
 *  - **Dangling-tail classification** (idempotent): a dangling `turn.start`
 *    (no `event.emitted` after it for that turn) ⇒ re-emit the trigger; a dangling
 *    `event.emitted` (no following `turn.start`) ⇒ re-publish; a dangling
 *    `user.input.required` ⇒ "still paused" (forward-compat with INT-030, not an
 *    interrupted turn); a terminal (`session.complete`/`session.cancelled`) ⇒ no
 *    action.
 *  - **Budget + safety rehydration**: rebuild the `AggregateBudget` cell by
 *    replaying each `turn.complete`'s `cost_usd`/`token_usage` (so a `$5.00` cap
 *    is not reset to `$5.00`); rebuild the stale-window event history + per-task
 *    abandonment counters from the replayed `event.emitted` / task history.
 *  - **`once()` committed-key collection**: gather the `side_effect.committed`
 *    keys so a re-run step's `orchestration.once(key, fn)` (the consumer is
 *    INT-011, Phase 3) skips an already-committed effect.
 *  - **Malformed-line policy**: a truncated **final** line is tolerated (the last
 *    complete entry governs); a malformed **interior** line **fails that
 *    session's recovery loudly** (mark `error`) — enforced by {@link SessionLogReader}.
 *
 * The `run_flow` child-reconciliation half (reuse a terminal child's recorded
 * `child.result`; resume a non-terminal child in place) depends on child sessions
 * existing, which is composition (INT-044, Phase 7) — **out of scope here**. This
 * task defines the root-selection + chaining-root contract so child sessions are
 * inert to the Phase-2 scanner.
 *
 * Every classifier/rehydration method is **pure over the parsed entries**, so
 * replaying the same log twice converges to the same resume action and the same
 * rebuilt state (the idempotency property TEST-005 asserts).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-005 / TEST-005
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Parent-rooted recovery
 */

import type { AggregateBudget } from "../run-loop/types";
import { logger } from "../utils/logger";
import { DEFAULT_MAX_COST_USD, DEFAULT_MAX_ITERATIONS } from "./constants";
import { SessionLogParseError, SessionLogReader } from "./session-log-reader";
import type { SessionLogEntry } from "./session-log";
import type { OrchestrationEvent, OrchestrationSessionMeta } from "./types";

const log = logger("SessionRecovery");

// ---------------------------------------------------------------------------
// Recovery action (the classified dangling tail)
// ---------------------------------------------------------------------------

/**
 * What recovery should do for a session, derived purely from its log tail.
 *
 *  - `re_emit_trigger` — a dangling `turn.start` (the turn was interrupted before
 *    its emission was logged/routed): re-emit the triggering event; the step
 *    retries from fresh context (safe because per-step turns are fresh-context by
 *    design and scratchpad writes are overwrite-only, FR-121).
 *  - `re_publish_event` — a dangling `event.emitted` (logged but not routed):
 *    re-publish it.
 *  - `still_paused` — a dangling `user.input.required` (no following
 *    `user.input.received`): re-surface the prompt (consumed by INT-030); NOT an
 *    interrupted turn. Carries the paused `step` (from the log entry) so the
 *    runner re-triggers exactly that step with the user's answer on resume.
 *  - `none` — the log is terminal (`session.complete`/`session.cancelled`) or
 *    carries nothing replayable.
 */
export type RecoveryAction =
	| { kind: "re_emit_trigger"; topic: string; payload: string; turn: number }
	| { kind: "re_publish_event"; topic: string; payload: string; source_step: string | null; turn: number }
	| { kind: "still_paused"; step: string; prompt: string; turn: number }
	| { kind: "none" };

/** The rehydrated safety-guard state derived from a replayed log. */
export interface RehydratedSafetyState {
	/** Event history (newest last) the stale detector's rolling window reads. */
	history: OrchestrationEvent[];
	/** Per-task abandonment counters the thrashing guard reads. */
	abandonCounts: Map<string, number>;
}

/** A session selected for recovery, with its rebuilt runtime state. */
export interface RecoverableSession {
	sessionId: string;
	meta: OrchestrationSessionMeta;
	action: RecoveryAction;
	/** Rebuilt aggregate budget (pre-crash remaining, not reset to full). */
	budget: AggregateBudget;
	/** Rehydrated stale-window history + abandonment counters. */
	safety: RehydratedSafetyState;
	/** Committed `once()` keys collected during replay (consumer is INT-011). */
	committedKeys: Set<string>;
	/** True when a trailing partial line was tolerated. */
	truncatedFinalLine: boolean;
}

/** A session whose recovery failed loudly (offered as resume-as-root). */
export interface RecoveryError {
	sessionId: string;
	reason: string;
}

/** Result of the load-time scan. */
export interface RecoveryScanResult {
	recoverable: RecoverableSession[];
	errors: RecoveryError[];
}

/** The minimal durable surface the scan reads (vault adapter in production). */
export interface RecoveryFs {
	/** Session ids (directory names under `sessions/`). */
	listSessions(): Promise<string[]>;
	/** Raw `session.json` for a session, or `null` if absent. */
	readMeta(sessionId: string): Promise<string | null>;
	/** Raw `session-log.jsonl` for a session, or `null` if absent. */
	readLog(sessionId: string): Promise<string | null>;
}

/** Flow ceilings used to re-seed the budget (defaulted, finite). */
export interface FlowCeilings {
	maxIterations: number;
	maxCostUsd: number;
}

export interface RecoveryScanOptions {
	/**
	 * Resolve a flow's (defaulted, finite) ceilings by `flow_name` so the budget
	 * is re-seeded from the real ceilings before replaying decrements. Defaults to
	 * the engine defaults (`DEFAULT_MAX_ITERATIONS` / `DEFAULT_MAX_COST_USD`) when
	 * omitted or when a flow can't be resolved.
	 */
	resolveCeilings?: (flowName: string) => FlowCeilings | null;
}

/** Origins the top-level scan recognizes (the discriminator domain). */
const KNOWN_ORIGINS = new Set(["user", "hook", "run_flow", "chaining"]);
/** Statuses the scan considers recoverable. */
const RECOVERABLE_STATUSES = new Set(["active", "interrupted"]);
/** Terminal statuses (a chaining predecessor must be one of these to root its successor). */
const TERMINAL_STATUSES = new Set(["completed", "cancelled", "error"]);

export class SessionRecovery {
	private readonly reader = new SessionLogReader();

	// -- Pure classifiers (the testable core) --------------------------------

	/**
	 * Classify a parsed log's dangling tail into a {@link RecoveryAction}. Pure and
	 * deterministic — running it twice over the same entries yields the same
	 * action (the idempotency property).
	 */
	classifyTail(entries: SessionLogEntry[]): RecoveryAction {
		// Scan from the end for the first entry that determines the resume action.
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i]!;
			switch (e.type) {
				case "session.complete":
				case "session.cancelled":
					return { kind: "none" };
				case "user.input.received":
					// The loop already consumed the input; whatever follows (a turn)
					// governs — keep scanning. (No following turn ⇒ fall through to a
					// later iteration; if it's the tail, nothing replayable remains.)
					return { kind: "none" };
				case "user.input.required":
					return { kind: "still_paused", step: e.step, prompt: e.prompt, turn: e.turn };
				case "event.emitted":
					return {
						kind: "re_publish_event",
						topic: e.topic,
						payload: e.payload,
						source_step: e.source_step,
						turn: e.turn,
					};
				case "turn.start":
				case "turn.complete": {
					// Interrupted turn (or completed-but-not-published): re-emit the
					// trigger. Recover the trigger topic + payload from the turn's
					// turn.start and the event.emitted that drove it.
					const turn = e.turn;
					const triggerTopic = this.findTriggerTopic(entries, turn);
					const payload = this.findTriggerPayload(entries, triggerTopic, i);
					return { kind: "re_emit_trigger", topic: triggerTopic, payload, turn };
				}
				default:
					// side_effect.committed / child.spawned / child.result /
					// event.emission_overwritten / session.start / step.log — skip;
					// keep scanning. (step.log is a pure diagnostic; never replayable.)
					continue;
			}
		}
		return { kind: "none" };
	}

	/**
	 * Rebuild the aggregate budget by replaying decrements. Start from the flow's
	 * (defaulted, finite) ceilings, then subtract each `turn.complete`'s `cost_usd`
	 * and (for LLM turns only — `conversation_id !== null`) one iteration. So a
	 * `$5.00` cap that spent `$4.90` resumes at `$0.10`, not `$5.00`.
	 */
	rebuildBudget(entries: SessionLogEntry[], ceilings: FlowCeilings): AggregateBudget {
		let iterationsRemaining = ceilings.maxIterations;
		let costRemainingUsd = ceilings.maxCostUsd;
		for (const e of entries) {
			if (e.type !== "turn.complete") continue;
			costRemainingUsd -= e.cost_usd ?? 0;
			// Code steps record conversation_id: null and are NOT LLM turns.
			if (e.conversation_id !== null) iterationsRemaining -= 1;
		}
		return { iterationsRemaining, costRemainingUsd };
	}

	/**
	 * Rehydrate the safety-guard state from the replayed log: the event history
	 * (drives the stale-loop rolling window) and per-task abandonment counters
	 * (drive the thrashing guard). Counters count how many times each task key
	 * re-surfaced in a `flow.tasks_remaining` payload — a proxy for re-queue after
	 * a blocked completion. So a near-stale self-loop fires on the **next** repeat
	 * post-reload, not N more.
	 */
	rehydrateSafetyState(entries: SessionLogEntry[]): RehydratedSafetyState {
		const history: OrchestrationEvent[] = [];
		const abandonCounts = new Map<string, number>();
		for (const e of entries) {
			if (e.type !== "event.emitted") continue;
			history.push({
				topic: e.topic,
				payload: e.payload,
				source_step: e.source_step,
				turn: e.turn,
				ts: e.ts,
			});
			if (e.topic === "flow.tasks_remaining") {
				for (const key of extractRemainingTaskKeys(e.payload)) {
					abandonCounts.set(key, (abandonCounts.get(key) ?? 0) + 1);
				}
			}
		}
		return { history, abandonCounts };
	}

	/** Collect the set of `side_effect.committed` keys (FR-125 — `once()` skip set). */
	collectCommittedKeys(entries: SessionLogEntry[]): Set<string> {
		const keys = new Set<string>();
		for (const e of entries) {
			if (e.type === "side_effect.committed") keys.add(e.key);
		}
		return keys;
	}

	// -- Load-time scan ------------------------------------------------------

	/**
	 * Scan all sessions and select the recoverable roots. Reads each
	 * `session.json` to discriminate by `origin`/`status`, then replays each
	 * selected session's log to classify its tail and rebuild its runtime state.
	 * A session whose log has a malformed interior line, or whose `session.json`
	 * is unparseable / carries an absent/unexpected `origin`, is surfaced as a
	 * loud {@link RecoveryError} (offered as resume-as-root), never silently
	 * skipped.
	 */
	async scan(fs: RecoveryFs, options?: RecoveryScanOptions): Promise<RecoveryScanResult> {
		const sessionIds = await fs.listSessions();
		const recoverable: RecoverableSession[] = [];
		const errors: RecoveryError[] = [];

		// Pass 1: read all metas (so chaining can resolve its predecessor's status).
		const metas = new Map<string, OrchestrationSessionMeta>();
		for (const id of sessionIds) {
			const raw = await fs.readMeta(id);
			if (raw === null) {
				errors.push({ sessionId: id, reason: "session.json is missing." });
				continue;
			}
			try {
				metas.set(id, JSON.parse(raw) as OrchestrationSessionMeta);
			} catch (e) {
				errors.push({
					sessionId: id,
					reason: `session.json is unparseable: ${e instanceof Error ? e.message : String(e)}`,
				});
			}
		}

		// Pass 2: select + replay.
		for (const [id, meta] of metas) {
			if (!RECOVERABLE_STATUSES.has(meta.status)) continue; // completed/cancelled/error → ignore

			const origin = (meta as { origin?: unknown }).origin;
			if (typeof origin !== "string" || !KNOWN_ORIGINS.has(origin)) {
				errors.push({
					sessionId: id,
					reason: `Unexpected or absent origin (${JSON.stringify(origin)}); offered as resume-as-root.`,
				});
				continue;
			}

			if (!this.isRecoverableRoot(meta, metas)) continue; // run_flow / live-parent chaining → parent replay

			const logRaw = await fs.readLog(id);
			if (logRaw === null) {
				errors.push({ sessionId: id, reason: "session-log.jsonl is missing." });
				continue;
			}

			try {
				const recovered = this.replay(meta, logRaw, options);
				recoverable.push(recovered);
			} catch (e) {
				if (e instanceof SessionLogParseError) {
					// Interior corruption — fail this session loudly (caller marks `error`).
					errors.push({ sessionId: id, reason: e.message });
				} else {
					errors.push({
						sessionId: id,
						reason: `Recovery replay failed: ${e instanceof Error ? e.message : String(e)}`,
					});
				}
			}
		}

		log.info("Session recovery scan complete", {
			scanned: sessionIds.length,
			recoverable: recoverable.length,
			errors: errors.length,
		});
		return { recoverable, errors };
	}

	/**
	 * Replay one session's log into a {@link RecoverableSession}. Throws
	 * {@link SessionLogParseError} on interior corruption (the caller surfaces it).
	 */
	replay(
		meta: OrchestrationSessionMeta,
		logRaw: string,
		options?: RecoveryScanOptions,
	): RecoverableSession {
		const { entries, truncatedFinalLine } = this.reader.parse(logRaw);
		const ceilings =
			options?.resolveCeilings?.(meta.flow_name) ?? {
				maxIterations: DEFAULT_MAX_ITERATIONS,
				maxCostUsd: DEFAULT_MAX_COST_USD,
			};
		const action = this.classifyTail(entries);

		// Stale-window double-count fix (idempotency AC). For a `re_publish_event`
		// tail the dangling `event.emitted` is re-published on resume — which pushes
		// it into the engine's in-memory history. So it must NOT also be pre-seeded
		// into the rehydrated history, or the stale detector counts the same
		// `(topic, source_step)` twice and a near-stale self-loop fires one repeat
		// early. Exclude the dangling tail event from the rehydrated history; resume
		// re-adds it exactly once. (`re_emit_trigger` re-emits the upstream trigger
		// with `source_step: null`, a distinct signature, so it never double-counts.)
		const historyEntries =
			action.kind === "re_publish_event" ? dropLastEventEmitted(entries) : entries;

		return {
			sessionId: meta.session_id,
			meta,
			action,
			budget: this.rebuildBudget(entries, ceilings),
			safety: this.rehydrateSafetyState(historyEntries),
			committedKeys: this.collectCommittedKeys(entries),
			truncatedFinalLine,
		};
	}

	/**
	 * Whether the top-level scan recovers `meta` as a root:
	 *  - `user` / `hook` → always;
	 *  - `chaining` → iff `parent_session_id` resolves to an already-terminal
	 *    predecessor (the chained-successor is fire-and-forget — its predecessor
	 *    finalized, so there is no live parent to reconcile it);
	 *  - `run_flow` (and `chaining` with a non-terminal/unresolved parent) → no.
	 */
	isRecoverableRoot(
		meta: OrchestrationSessionMeta,
		metas: Map<string, OrchestrationSessionMeta>,
	): boolean {
		switch (meta.origin) {
			case "user":
			case "hook":
				return true;
			case "chaining": {
				const parentId = meta.parent_session_id;
				if (!parentId) return false;
				const parent = metas.get(parentId);
				return parent !== undefined && TERMINAL_STATUSES.has(parent.status);
			}
			case "run_flow":
			default:
				return false;
		}
	}

	// -- Internals -----------------------------------------------------------

	/** The `trigger_topic` of the `turn.start` for `turn` (or `""` if absent). */
	private findTriggerTopic(entries: SessionLogEntry[], turn: number): string {
		for (const e of entries) {
			if (e.type === "turn.start" && e.turn === turn) return e.trigger_topic;
		}
		return "";
	}

	/** The payload of the most recent `event.emitted` for `topic` before index `before`. */
	private findTriggerPayload(
		entries: SessionLogEntry[],
		topic: string,
		before: number,
	): string {
		for (let i = before; i >= 0; i--) {
			const e = entries[i]!;
			if (e.type === "event.emitted" && e.topic === topic) return e.payload;
		}
		return "";
	}
}

/**
 * Return a copy of `entries` with the **last** `event.emitted` removed. Used for
 * the `re_publish_event` recovery tail: that trailing event is re-published on
 * resume (landing it in the engine's history once), so it must not also be
 * pre-seeded into the rehydrated stale-window history.
 */
function dropLastEventEmitted(entries: SessionLogEntry[]): SessionLogEntry[] {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i]!.type === "event.emitted") {
			return [...entries.slice(0, i), ...entries.slice(i + 1)];
		}
	}
	return entries;
}

/** Extract task keys from a `flow.tasks_remaining` payload (`{ remaining_tasks: [{key}] }`). */
function extractRemainingTaskKeys(payload: string): string[] {
	try {
		const parsed = JSON.parse(payload) as {
			remaining_tasks?: Array<{ key?: string }>;
			missing?: string[];
		};
		if (Array.isArray(parsed.remaining_tasks)) {
			return parsed.remaining_tasks.map((t) => t.key).filter((k): k is string => typeof k === "string");
		}
		if (Array.isArray(parsed.missing)) {
			return parsed.missing.filter((k): k is string => typeof k === "string");
		}
	} catch {
		// Non-JSON payload — no task keys.
	}
	return [];
}
