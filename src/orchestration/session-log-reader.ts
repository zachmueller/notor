/**
 * `SessionLogReader` (INT-005) — the replay parser for `session-log.jsonl`.
 *
 * The *writer* is FEAT-006's {@link SessionLog}; this is the read side that
 * recovery (INT-005 / TEST-005) drives. It enforces the **malformed-line policy**
 * (Issue-13d), the load-bearing half of crash safety:
 *
 *  - A **truncated/partial FINAL line** (the expected crash signature of an
 *    append-only log — a crash mid-append) is **tolerated**: the line is dropped
 *    and the last *complete* entry governs.
 *  - A malformed **interior** line (a torn non-atomic flush, an external editor /
 *    sync touching the file) is **NOT** silently skipped or truncated-at: the
 *    reader **throws** {@link SessionLogParseError}. Silently dropping the tail
 *    after an interior bad line would discard exactly the dangling
 *    `turn.start` / `event.emitted` tail that drives replay and would silently
 *    mis-recover the run — so recovery must fail that session loudly (mark it
 *    `error`) instead.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-005 / TEST-005
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Malformed-line policy
 */

import type { SessionLogEntry, SessionStartEntry } from "./session-log";

/** Thrown when an **interior** log line is malformed (recovery must fail loudly). */
export class SessionLogParseError extends Error {
	constructor(
		message: string,
		/** 0-based index of the offending interior line. */
		readonly lineIndex: number,
	) {
		super(message);
		this.name = "SessionLogParseError";
	}
}

/** The parsed log: ordered entries + whether a trailing partial line was dropped. */
export interface ParsedSessionLog {
	entries: SessionLogEntry[];
	/** True when the final line was incomplete (crash-mid-append) and was dropped. */
	truncatedFinalLine: boolean;
	/** Schema version read from the first session.start entry; defaults to 1 for legacy logs. */
	schema_version: number;
}

export class SessionLogReader {
	/**
	 * Parse raw `session-log.jsonl` content into ordered entries.
	 *
	 * Tolerant of a truncated **final** line; throws {@link SessionLogParseError}
	 * on a malformed **interior** line. A line is "interior" iff a later non-empty
	 * line exists after it.
	 */
	parse(raw: string): ParsedSessionLog {
		// Split on newlines WITHOUT dropping empties yet — we need positional info
		// to distinguish the (possibly partial) final line from interior lines.
		const rawLines = raw.split("\n");

		// A trailing newline produces a final empty element; the real "last line"
		// is the last NON-empty element. Track its index in rawLines.
		let lastNonEmpty = -1;
		for (let i = rawLines.length - 1; i >= 0; i--) {
			if (rawLines[i]!.trim() !== "") {
				lastNonEmpty = i;
				break;
			}
		}
		// File terminated with a newline iff there is content and the final raw
		// element is empty — i.e. the last real line was newline-terminated (a
		// complete append) rather than a partial mid-write.
		const finalLineComplete =
			lastNonEmpty >= 0 && lastNonEmpty < rawLines.length - 1;

		const entries: SessionLogEntry[] = [];
		let truncatedFinalLine = false;

		for (let i = 0; i <= lastNonEmpty; i++) {
			const line = rawLines[i]!;
			if (line.trim() === "") continue; // tolerate interior blank lines
			const isFinalRealLine = i === lastNonEmpty;

			try {
				const parsed = JSON.parse(line) as SessionLogEntry;
				if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
					throw new Error("entry missing string `type`");
				}
				entries.push(parsed);
			} catch (e) {
				if (isFinalRealLine && !finalLineComplete) {
					// Truncated final line (crash mid-append) — tolerated.
					truncatedFinalLine = true;
					continue;
				}
				// Interior corruption (or a complete-but-invalid final line) — loud.
				throw new SessionLogParseError(
					`Malformed interior session-log line ${i}: ${e instanceof Error ? e.message : String(e)}`,
					i,
				);
			}
		}

		// Read schema_version off the first entry (must be session.start); default 1 for legacy logs.
		const firstEntry = entries[0];
		const schema_version =
			firstEntry?.type === "session.start"
				? ((firstEntry as SessionStartEntry).schema_version ?? 1)
				: 1;

		return { entries, truncatedFinalLine, schema_version };
	}
}
