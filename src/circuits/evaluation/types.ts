/**
 * Circuit evaluation — shared shapes.
 *
 * An evaluation **pass** scores one or more finished sessions of a circuit with
 * the circuit's declared evaluators (`notor-evaluators`). Every evaluator
 * produces one {@link EvaluatorOutcome} per session, appended to that session's
 * `evals.jsonl` (see `eval-log.ts`) and optionally rendered into a report note
 * (see `eval-report.ts`). Nothing here touches the run's own `session-log.jsonl`
 * or budget record.
 */

import type { CircuitOrigin, CircuitSessionMeta, EvalDimension } from "../types";
import type { RunOutcome } from "../run-outcome";

/** What started the pass. */
export type EvalTrigger = "manual" | "auto" | "schedule";

/** The shape an LLM judge submits via `submit_score`, or a code evaluator returns. */
export interface SubmittedScore {
	scores: Record<string, number | boolean>;
	rationale: string;
	overall?: number;
}

/** One edited note's current contents, as shown to an LLM judge. */
export interface EvalNoteContent {
	path: string;
	content: string;
	/** True when `content` was cut to the per-note cap. */
	truncated: boolean;
	/** True when the note changed after the run finished; `null` when the platform cannot stat. */
	mtimeAfterRun: boolean | null;
}

/** The evaluator's view of one finished session ("option a": no step transcripts). */
export interface EvalInput {
	circuit: { name: string; description: string };
	session: { sessionId: string; startedAt: string; origin: CircuitOrigin; sessionDir: string };
	/** The run's objective (`session.json` → `prompt`). */
	objective: string;
	outcome: RunOutcome;
	/** Vault paths of notes the run's steps edited (from persisted tool calls). */
	notesEdited: string[];
	/** Current contents of `notesEdited` (capped); empty when not requested. */
	noteContents: EvalNoteContent[];
	evaluator: { name: string; dimensions: EvalDimension[] };
}

export type EvalFailureReason =
	| "budget"
	| "no_score"
	| "invalid_score"
	| "error"
	| "timeout"
	| "aborted"
	| "unresolved_persona"
	| "unresolved_subagent";

export type EvaluatorOutcome =
	| {
			evaluator: string;
			mode: "conversation" | "code";
			ok: true;
			scores: Record<string, number | boolean>;
			rationale: string;
			overall: number | null;
			costUsd: number;
			modelId: string | null;
	  }
	| {
			evaluator: string;
			mode: "conversation" | "code";
			ok: false;
			reason: EvalFailureReason;
			detail: string;
			costUsd: number;
			modelId: string | null;
	  };

/** One session's slice of a pass. */
export interface EvalSessionResult {
	sessionId: string;
	/** `null` when the session could not be loaded (see `skipped`). */
	meta: CircuitSessionMeta | null;
	outcome: RunOutcome | null;
	outcomes: EvaluatorOutcome[];
	/** Why the session was skipped without running any evaluator (`null` = evaluated). */
	skipped: string | null;
	/** The report note written for this session, when the setting is on. */
	reportPath: string | null;
}

export interface EvalPassResult {
	passId: string;
	circuit: string;
	trigger: EvalTrigger;
	startedAt: string;
	finishedAt: string;
	/** Fingerprint of the evaluator set that ran (names, modes, dimensions, rubric + body text). */
	fingerprint: string;
	/** The pass's USD ceiling (`notor-eval-max-cost-usd`, else the circuit ceiling). */
	maxCostUsd: number;
	sessions: EvalSessionResult[];
	totalCostUsd: number;
}

/** Progress callback payload for the picker's Notice. */
export interface EvalProgress {
	sessionId: string;
	sessionIndex: number;
	sessionCount: number;
	evaluator: string | null;
	evaluatorIndex: number;
	evaluatorCount: number;
	phase: "start" | "scored" | "failed" | "skipped";
}
