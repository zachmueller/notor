/**
 * `notor-eval-auto` — run a circuit's evaluators automatically when one of its
 * ROOT sessions finishes. Fire-and-forget from `finalizeRun`: it never blocks
 * the run, never alters its status, and swallows every error (logged).
 *
 * Children (`parent_session_id` set) are never auto-evaluated: their outcome is
 * folded into the parent's `child.result`, and scoring them separately would
 * double-spend and produce rows that cannot be compared with the parent's.
 */

import { Notice } from "obsidian";
import { logger } from "../../utils/logger";
import type { CircuitHost } from "../host";
import type { CircuitRunResult, CircuitRunStatus } from "../runner";
import type { Circuit, EvalAutoTrigger } from "../types";
import type { EvalPassResult, EvaluateSessionsOptions } from "./index";

const log = logger("CircuitEvaluation");

/** Whether a finished root session should be evaluated automatically. */
export function shouldAutoEvaluate(
	evalAuto: EvalAutoTrigger,
	status: CircuitRunStatus,
	parentSessionId: string | null,
	evaluatorCount: number,
): boolean {
	if (parentSessionId !== null || evaluatorCount === 0) return false;
	switch (evalAuto) {
		case "complete":
			return status === "completed";
		case "error":
			return status === "error";
		case "both":
			return status === "completed" || status === "error";
		default:
			return false;
	}
}

export type EvaluateFn = (
	host: CircuitHost,
	circuit: Circuit,
	sessionIds: readonly string[],
	opts: EvaluateSessionsOptions,
) => Promise<EvalPassResult>;

/**
 * Evaluate the just-finished session if the circuit opted in. Resolves once the
 * pass settles (or is skipped) and never rejects; callers may `void` it.
 */
export async function maybeAutoEvaluate(
	host: CircuitHost,
	flow: Circuit,
	sessionId: string,
	result: Pick<CircuitRunResult, "status">,
	parentSessionId: string | null,
	deps: { evaluate?: EvaluateFn } = {},
): Promise<void> {
	if (!shouldAutoEvaluate(flow.evalAuto, result.status, parentSessionId, flow.evaluators.length)) return;
	try {
		const evaluate = deps.evaluate ?? (await import("./evaluate-sessions")).evaluateSessions;
		const pass = await evaluate(host, flow, [sessionId], { trigger: "auto" });
		const session = pass.sessions[0];
		if (!session || session.skipped) {
			log.warn("Automatic evaluation skipped the session", { flow: flow.name, sessionId, reason: session?.skipped });
			return;
		}
		const scored = session.outcomes.filter((o) => o.ok).length;
		const failed = session.outcomes.length - scored;
		new Notice(
			`Evaluated circuit '${flow.name}': ${scored} scored, ${failed} failed · $${pass.totalCostUsd.toFixed(4)}` +
				(session.reportPath ? ` · ${session.reportPath}` : ""),
		);
	} catch (e) {
		log.warn("Automatic evaluation failed", { flow: flow.name, sessionId, error: String(e) });
	}
}
