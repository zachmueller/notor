/**
 * Finished sessions of a circuit, as the evaluation picker and the scheduler
 * see them: terminal status, when they ran, what they cost, and whether the
 * CURRENT evaluator set (by fingerprint) has already scored them.
 */

import { logger } from "../../utils/logger";
import { readRunOutcome } from "../run-outcome";
import { SessionLogReader } from "../session-log-reader";
import type { RecoveryFs } from "../session-recovery";
import type { Circuit, CircuitOrigin, CircuitSessionMeta } from "../types";
import { readEvalLog, summarizeEvalLog } from "./eval-log";

const log = logger("CircuitEvaluation");

/** A {@link RecoveryFs} that can also read `evals.jsonl` (see `makeRecoveryFs`). */
export interface EvalSessionFs extends RecoveryFs {
	readEvals(sessionId: string): Promise<string | null>;
}

export interface EvaluableSession {
	sessionId: string;
	status: "completed" | "cancelled" | "error";
	startedAt: string;
	origin: CircuitOrigin;
	parentSessionId: string | null;
	objective: string;
	/** The run's recorded cost, or `null` when the log is unreadable. */
	costUsd: number | null;
	/** True when a COMPLETED pass with the current evaluator fingerprint exists. */
	alreadyEvaluated: boolean;
	/** `ts` of the last completed pass (any fingerprint), or `null`. */
	lastEvaluatedAt: string | null;
	/** Completed passes so far (any fingerprint). */
	passCount: number;
}

const TERMINAL = new Set(["completed", "cancelled", "error"]);

/**
 * List a circuit's finished sessions, newest first. Children (`parent_session_id`
 * set) are excluded by default: their outcome is folded into the parent's
 * `child.result`, and evaluating them separately double-spends.
 */
export async function listEvaluableSessions(
	fs: EvalSessionFs,
	circuitName: string,
	fingerprint: string,
	opts: { includeChildren?: boolean } = {},
): Promise<EvaluableSession[]> {
	const out: EvaluableSession[] = [];
	for (const sessionId of await fs.listSessions()) {
		let meta: CircuitSessionMeta;
		try {
			const raw = await fs.readMeta(sessionId);
			if (!raw) continue;
			meta = JSON.parse(raw) as CircuitSessionMeta;
		} catch (e) {
			log.debug("Skipping session with unreadable session.json", { sessionId, error: String(e) });
			continue;
		}
		if (meta.flow_name !== circuitName) continue;
		if (!TERMINAL.has(meta.status)) continue;
		if (!opts.includeChildren && meta.parent_session_id) continue;

		let costUsd: number | null = null;
		try {
			const rawLog = await fs.readLog(sessionId);
			if (rawLog) {
				const entries = new SessionLogReader().parse(rawLog).entries;
				costUsd = readRunOutcome(entries, meta)?.costUsd ?? null;
			}
		} catch (e) {
			log.debug("Session log unreadable while listing", { sessionId, error: String(e) });
		}

		const summary = summarizeEvalLog(readEvalLog(await fs.readEvals(sessionId)));
		out.push({
			sessionId,
			status: meta.status as EvaluableSession["status"],
			startedAt: meta.started_at,
			origin: meta.origin,
			parentSessionId: meta.parent_session_id ?? null,
			objective: meta.prompt ?? "",
			costUsd,
			alreadyEvaluated: summary.completedFingerprints.has(fingerprint),
			lastEvaluatedAt: summary.lastCompletedAt,
			passCount: summary.passCount,
		});
	}
	out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
	return out;
}

export interface EvalCeilingEstimate {
	llmJudges: number;
	codeEvaluators: number;
	/** The per-pass USD ceiling (`notor-eval-max-cost-usd`, else the circuit ceiling). */
	maxCostUsdPerPass: number;
	/** Sessions × LLM judges: how many judge turns the pass may start. */
	judgeRuns: number;
}

/** What a pass over `sessionCount` sessions may cost, for the picker footer. */
export function estimateEvalCeiling(circuit: Circuit, sessionCount: number): EvalCeilingEstimate {
	const llmJudges = circuit.evaluators.filter((e) => e.mode === "conversation").length;
	const codeEvaluators = circuit.evaluators.length - llmJudges;
	return {
		llmJudges,
		codeEvaluators,
		maxCostUsdPerPass: circuit.evalMaxCostUsd ?? circuit.maxCostUsd,
		judgeRuns: llmJudges * sessionCount,
	};
}
