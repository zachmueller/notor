/**
 * `SessionLog` — the append-only `session-log.jsonl` writer (FEAT-006).
 *
 * The crash-recovery source of truth. Exposes one append method per entry type
 * and enforces the **write order** documented in
 * specs/ZZ-misc/orchestration/contracts/vault-schema.md: for each turn,
 * `turn.start` is written **before** the LLM call / code execution begins,
 * `turn.complete` after the emit is captured, and `event.emitted`
 * **before** the event is routed (write-before-route).
 *
 * Writes are append-only and durable — the writer never rewrites or truncates
 * the file. Concurrent appends from one runner are serialized through an
 * internal promise chain so no two appends interleave a partial line.
 *
 * This is the **writer surface only** — the session *directory* lifecycle
 * (`session.json`, `scratchpad/`, `tasks/`) is Phase 2 (INT-001); recovery
 * replay is INT-005. FEAT-006 only guarantees the log is written in the
 * recoverable order.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-006
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Enforced write order
 */

import { logger } from "../utils/logger";

const log = logger("SessionLog");

// ---------------------------------------------------------------------------
// Entry shapes (authority: data-model.md / vault-schema.md)
// ---------------------------------------------------------------------------

interface BaseEntry {
	type: string;
	ts: string;
}

export interface SessionStartEntry extends BaseEntry {
	type: "session.start";
	session_id: string;
	flow: string;
	prompt: string;
	origin: "user" | "hook" | "run_flow" | "chaining";
	parent_session_id: string | null;
}

export interface TurnStartEntry extends BaseEntry {
	type: "turn.start";
	turn: number;
	step: string;
	trigger_topic: string;
	/** `null` for a code step (no conversation). */
	conversation_id: string | null;
}

export interface TurnCompleteEntry extends BaseEntry {
	type: "turn.complete";
	turn: number;
	step: string;
	emitted_topic: string;
	conversation_id: string | null;
	/** Per-turn cost (Issue-5). A code step records `0`. */
	cost_usd: number;
	/** Per-turn token usage (Issue-5). A code step records zeros. */
	token_usage: { input: number; output: number };
}

export interface EventEmittedEntry extends BaseEntry {
	type: "event.emitted";
	turn: number;
	topic: string;
	payload: string;
	source_step: string | null;
}

export interface EventEmissionOverwrittenEntry extends BaseEntry {
	type: "event.emission_overwritten";
	turn: number;
	step: string;
	prev_topic: string;
	new_topic: string;
}

export interface ChildSpawnedEntry extends BaseEntry {
	type: "child.spawned";
	turn: number;
	step: string;
	via_tool_call_id: string;
	child_session_id: string;
}

export interface ChildResultEntry extends BaseEntry {
	type: "child.result";
	turn: number;
	child_session_id: string;
	structured?: unknown;
	text: string;
	stop_reason: string;
}

export interface SessionCancelledEntry extends BaseEntry {
	type: "session.cancelled";
	reason: string;
}

export interface SessionCompleteEntry extends BaseEntry {
	type: "session.complete";
}

export interface UserInputRequiredEntry extends BaseEntry {
	type: "user.input.required";
	turn: number;
	step: string;
	prompt: string;
}

export interface UserInputReceivedEntry extends BaseEntry {
	type: "user.input.received";
	turn: number;
	payload: string;
}

/** The full session-log entry union. */
export type SessionLogEntry =
	| SessionStartEntry
	| TurnStartEntry
	| TurnCompleteEntry
	| EventEmittedEntry
	| EventEmissionOverwrittenEntry
	| ChildSpawnedEntry
	| ChildResultEntry
	| SessionCancelledEntry
	| SessionCompleteEntry
	| UserInputRequiredEntry
	| UserInputReceivedEntry;

// ---------------------------------------------------------------------------
// Writer abstraction (decouples from Obsidian's Vault for tests)
// ---------------------------------------------------------------------------

/**
 * The minimal durable-append surface `SessionLog` needs. In production this is
 * backed by `vault.adapter.append(path, data)` (true append-only). Tests inject
 * a fake to assert the write-before-route ordering.
 */
export interface SessionLogWriter {
	/** Append `data` to the file at `path`, creating it if absent. Never truncates. */
	append(path: string, data: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// SessionLog
// ---------------------------------------------------------------------------

export class SessionLog {
	private readonly writer: SessionLogWriter;
	private readonly filePath: string;
	/** Serializes appends so two writes never interleave a partial line. */
	private writeChain: Promise<void> = Promise.resolve();
	/** Injectable clock (defaults to wall clock) — tests pass a deterministic stamp. */
	private readonly now: () => string;

	constructor(filePath: string, writer: SessionLogWriter, now?: () => string) {
		this.filePath = filePath;
		this.writer = writer;
		this.now = now ?? (() => new Date().toISOString());
	}

	/** The session-log file path this writer appends to. */
	get path(): string {
		return this.filePath;
	}

	// -- Append helpers ------------------------------------------------------

	appendSessionStart(entry: Omit<SessionStartEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "session.start", ts: this.now(), ...entry });
	}

	appendTurnStart(entry: Omit<TurnStartEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "turn.start", ts: this.now(), ...entry });
	}

	appendTurnComplete(entry: Omit<TurnCompleteEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "turn.complete", ts: this.now(), ...entry });
	}

	/**
	 * Write-before-route hook (FR-112): the event engine (FEAT-003) calls this
	 * **before** delivering the event to any subscriber.
	 */
	appendEventEmitted(entry: Omit<EventEmittedEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "event.emitted", ts: this.now(), ...entry });
	}

	appendEventEmissionOverwritten(
		entry: Omit<EventEmissionOverwrittenEntry, "type" | "ts">,
	): Promise<void> {
		return this.write({ type: "event.emission_overwritten", ts: this.now(), ...entry });
	}

	appendChildSpawned(entry: Omit<ChildSpawnedEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "child.spawned", ts: this.now(), ...entry });
	}

	appendChildResult(entry: Omit<ChildResultEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "child.result", ts: this.now(), ...entry });
	}

	appendSessionCancelled(entry: Omit<SessionCancelledEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "session.cancelled", ts: this.now(), ...entry });
	}

	appendSessionComplete(): Promise<void> {
		return this.write({ type: "session.complete", ts: this.now() });
	}

	// -- Forward-declared (Phase 5 INT-030 fills behavior) -------------------

	appendUserInputRequired(entry: Omit<UserInputRequiredEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "user.input.required", ts: this.now(), ...entry });
	}

	appendUserInputReceived(entry: Omit<UserInputReceivedEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "user.input.received", ts: this.now(), ...entry });
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * Serialize the append onto the write chain. Each append writes exactly one
	 * newline-terminated JSON object; a failed write is logged (never thrown) so
	 * one bad append cannot poison the chain or crash the run.
	 */
	private write(entry: SessionLogEntry): Promise<void> {
		const line = JSON.stringify(entry) + "\n";
		const next = this.writeChain.then(async () => {
			try {
				await this.writer.append(this.filePath, line);
			} catch (e) {
				log.error("session-log append failed", {
					path: this.filePath,
					type: entry.type,
					error: String(e),
				});
			}
		});
		// Keep the chain alive even if a prior write rejected (it shouldn't —
		// errors are swallowed above — but be defensive).
		this.writeChain = next.catch(() => {});
		return next;
	}
}
