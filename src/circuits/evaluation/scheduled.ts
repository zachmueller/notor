/**
 * `notor-eval-schedule` — on each cron tick, evaluate the circuit's finished
 * ROOT sessions that the CURRENT evaluator set (by fingerprint) has not scored
 * yet, newest first, capped per tick so a long backlog never produces one
 * giant pass. A rubric edit changes the fingerprint, so the next tick re-scores
 * every session as a new comparable pass.
 */

import { Notice } from "obsidian";
import { logger } from "../../utils/logger";
import { circuitDataRootOf } from "../data-root";
import type { CircuitHost } from "../host";
import { VaultSessionFs } from "../launch-wiring";
import { makeRecoveryFs } from "../recovery-boot";
import { CircuitSessionManager } from "../session-manager";
import type { Circuit } from "../types";
import { evaluateSessions, loadRubricBodies, type EvaluateSessionsOptions } from "./evaluate-sessions";
import { evaluatorSetFingerprint } from "./evaluator-fingerprint";
import { listEvaluableSessions, type EvaluableSession } from "./session-listing";
import type { EvalPassResult } from "./types";

const log = logger("CircuitEvaluation");

/** Sessions evaluated per scheduled tick, at most. */
export const DEFAULT_SCHEDULED_EVAL_MAX_SESSIONS = 20;

export interface ScheduledEvaluationDeps {
	listCandidates?: (host: CircuitHost, circuit: Circuit) => Promise<EvaluableSession[]>;
	evaluate?: (host: CircuitHost, circuit: Circuit, sessionIds: readonly string[], opts: EvaluateSessionsOptions) => Promise<EvalPassResult>;
	notify?: (message: string) => void;
}

/** Finished root sessions of `circuit` with no completed pass for the current evaluator set, newest first. */
export async function listUnevaluatedSessions(host: CircuitHost, circuit: Circuit): Promise<EvaluableSession[]> {
	const fs = new VaultSessionFs(host.app);
	const sessionManager = new CircuitSessionManager(host.settings.notor_dir, fs, circuitDataRootOf(host));
	const fingerprint = evaluatorSetFingerprint(circuit.evaluators, await loadRubricBodies(fs, circuit.evaluators));
	const sessions = await listEvaluableSessions(makeRecoveryFs(host, sessionManager), circuit.name, fingerprint);
	return sessions.filter((s) => !s.alreadyEvaluated);
}

/** The ids a tick evaluates: the newest `maxSessions` candidates (the list is already newest first). */
export function selectScheduledSessions(candidates: readonly EvaluableSession[], maxSessions = DEFAULT_SCHEDULED_EVAL_MAX_SESSIONS): string[] {
	return candidates.slice(0, Math.max(0, maxSessions)).map((s) => s.sessionId);
}

/**
 * One scheduled tick. Returns the pass, or `null` when there was nothing to do
 * (no evaluators, or every finished session is already scored).
 */
export async function evaluateUnevaluatedSessions(
	host: CircuitHost,
	circuit: Circuit,
	opts: { maxSessions?: number; deps?: ScheduledEvaluationDeps } = {},
): Promise<EvalPassResult | null> {
	if (circuit.evaluators.length === 0) return null;
	const deps = opts.deps ?? {};
	const candidates = await (deps.listCandidates ?? listUnevaluatedSessions)(host, circuit);
	const sessionIds = selectScheduledSessions(candidates, opts.maxSessions);
	if (sessionIds.length === 0) {
		log.debug("Scheduled evaluation: nothing to score", { circuit: circuit.name });
		return null;
	}
	log.info("Scheduled evaluation starting", { circuit: circuit.name, sessions: sessionIds.length, backlog: candidates.length });
	const result = await (deps.evaluate ?? evaluateSessions)(host, circuit, sessionIds, { trigger: "schedule" });

	const evaluated = result.sessions.filter((s) => !s.skipped);
	const scored = evaluated.reduce((n, s) => n + s.outcomes.filter((o) => o.ok).length, 0);
	const failed = evaluated.reduce((n, s) => n + s.outcomes.filter((o) => !o.ok).length, 0);
	const notify = deps.notify ?? ((message: string) => void new Notice(message, 10_000));
	notify(
		`Scheduled evaluation of '${circuit.name}': ${evaluated.length} session${evaluated.length === 1 ? "" : "s"} · ` +
			`${scored} scored, ${failed} failed · $${result.totalCostUsd.toFixed(4)}`,
	);
	return result;
}
