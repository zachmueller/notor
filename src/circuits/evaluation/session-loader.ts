/**
 * Load a FINISHED session from disk for evaluation: `session.json`, the parsed
 * `session-log.jsonl`, and its terminal outcome (`run.result`, or the legacy
 * fallback). Evaluation never reads the in-memory `CircuitRunResult`, so it
 * works the same for a run that finished seconds ago, days ago, or in a batch.
 */

import { logger } from "../../utils/logger";
import { readRunOutcome, type RunOutcome } from "../run-outcome";
import type { SessionLogEntry } from "../session-log";
import { SessionLogReader } from "../session-log-reader";
import type { CircuitSessionManager, SessionFs, SessionWorkspace } from "../session-manager";
import type { CircuitSessionMeta } from "../types";

const log = logger("CircuitEvaluation");

export interface LoadedSession {
	meta: CircuitSessionMeta;
	entries: SessionLogEntry[];
	outcome: RunOutcome;
	workspace: SessionWorkspace;
}

export type LoadSessionResult = { ok: true; session: LoadedSession } | { ok: false; reason: string };

const TERMINAL = new Set(["completed", "cancelled", "error"]);

export async function loadFinishedSession(
	fs: SessionFs,
	sessionManager: CircuitSessionManager,
	sessionId: string,
): Promise<LoadSessionResult> {
	const workspace = sessionManager.resolveWorkspace(sessionId);

	let meta: CircuitSessionMeta;
	try {
		meta = await sessionManager.readMeta(sessionId);
	} catch (e) {
		return { ok: false, reason: `session.json unreadable: ${e instanceof Error ? e.message : String(e)}` };
	}
	if (!TERMINAL.has(meta.status)) {
		return { ok: false, reason: `session is ${meta.status}, not finished` };
	}

	let entries: SessionLogEntry[] = [];
	try {
		const raw = await fs.read(workspace.logPath);
		entries = new SessionLogReader().parse(raw).entries;
	} catch (e) {
		// A torn log still leaves the terminal status in session.json; evaluate
		// with the degraded fallback rather than refusing.
		log.warn("session-log.jsonl unreadable; evaluating from session.json only", {
			sessionId,
			error: String(e),
		});
	}

	const outcome = readRunOutcome(entries, meta);
	if (!outcome) {
		return { ok: false, reason: "no terminal outcome recorded" };
	}
	return { ok: true, session: { meta, entries, outcome, workspace } };
}
