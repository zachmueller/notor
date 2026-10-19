/**
 * Circuit evaluation — barrel. Lazily imported by the command, the auto-trigger,
 * and the scheduler (like `../launch`), so the evaluation stack stays out of the
 * plugin's startup path.
 */

export { evaluateSessions, loadRubricBodies, newPassId } from "./evaluate-sessions";
export type { EvaluateSessionsDeps, EvaluateSessionsOptions } from "./evaluate-sessions";
export * from "./types";
export { EvalLog, evalLogPath, readEvalLog, summarizeEvalLog } from "./eval-log";
export type { EvalFailedEntry, EvalLogEntry, EvalLogSummary, EvalPassCompleteEntry, EvalPassStartEntry, EvalScoredEntry } from "./eval-log";
export { evaluatorSetFingerprint } from "./evaluator-fingerprint";
export { evalReportPath, overallKey, scoreKey } from "./eval-report";
export { loadFinishedSession } from "./session-loader";
export type { LoadedSession, LoadSessionResult } from "./session-loader";
export { validateScores } from "./score-validation";
export { buildJudgePrompt } from "./judge-prompt";
export { JUDGE_DISABLED_TOOLS, JUDGE_ITERATION_CAP, SUBMIT_SCORE_TOOL, judgeToolConfig, runJudge } from "./judge-runner";
export { CODE_EVALUATOR_ARG_NAMES, makeCodeEvaluatorRuntimeFactory, runCodeEvaluator } from "./code-evaluator-runner";
export type { CodeEvaluationHelper, CodeEvaluatorRuntime, CodeEvaluatorRuntimeFactory } from "./code-evaluator-runner";
export { buildEvalInput, readNoteContents, stepConversationIdsOf } from "./eval-input";
