/**
 * `evaluateSessions` — one evaluation **pass** over N finished sessions of a
 * circuit. The single entry point every trigger (manual command, `notor-eval-auto`,
 * `notor-eval-schedule`) calls.
 *
 * Per pass: one fresh `AggregateBudget` (`notor-eval-max-cost-usd`, else the
 * circuit ceiling), one evaluator-set fingerprint, one `pass_id`. Per session:
 * load from disk → `eval.pass_start` → run each evaluator sequentially,
 * appending `eval.scored` / `eval.failed` → `eval.pass_complete` → optionally a
 * report note. A session that is not finished (or cannot be read) is skipped
 * with a reason and no log write. Per-evaluator failures never throw; only a
 * circuit-level I/O failure does.
 */

import { getFrontMatterInfo } from "obsidian";
import { resolveIncludeNotes } from "../../include-note/resolver";
import { newRootBudget } from "../../run-loop/budget";
import { logger } from "../../utils/logger";
import { circuitDataRootOf } from "../data-root";
import type { CircuitHost } from "../host";
import { VaultSessionFs, VaultSessionLogWriter } from "../launch-wiring";
import type { SessionLogWriter } from "../session-log";
import { CircuitSessionManager, type SessionFs } from "../session-manager";
import type { Circuit, EvaluatorDefinition } from "../types";
import { makeCodeEvaluatorRuntimeFactory, runCodeEvaluator, type CodeEvaluatorRuntimeFactory } from "./code-evaluator-runner";
import { buildEvalInput } from "./eval-input";
import { EvalLog, evalLogPath } from "./eval-log";
import { writeEvalReport } from "./eval-report";
import { evaluatorSetFingerprint } from "./evaluator-fingerprint";
import { runJudge } from "./judge-runner";
import { loadFinishedSession } from "./session-loader";
import type { EvalPassResult, EvalProgress, EvalSessionResult, EvalTrigger, EvaluatorOutcome } from "./types";

const log = logger("CircuitEvaluation");

export interface EvaluateSessionsDeps {
	fs: SessionFs;
	logWriter: SessionLogWriter;
	runJudge: typeof runJudge;
	runCodeEvaluator: typeof runCodeEvaluator;
	codeRuntimeFactory: CodeEvaluatorRuntimeFactory;
	buildInput: typeof buildEvalInput;
	/** Resolve an evaluator body's `<include_note>` tags. */
	resolveBody: (evaluator: EvaluatorDefinition) => Promise<string>;
	now: () => string;
	makePassId: () => string;
}

export interface EvaluateSessionsOptions {
	trigger: EvalTrigger;
	abortSignal?: AbortSignal;
	onProgress?: (progress: EvalProgress) => void;
	/** Test seams; every member defaults to the real implementation. */
	deps?: Partial<EvaluateSessionsDeps>;
}

export function newPassId(): string {
	return `pass-${crypto.randomUUID().slice(0, 12)}`;
}

/** Read each rubric note's body (frontmatter stripped), keyed by path. Unreadable rubrics are omitted. */
export async function loadRubricBodies(
	fs: SessionFs,
	evaluators: readonly EvaluatorDefinition[],
): Promise<Record<string, string>> {
	const bodies: Record<string, string> = {};
	for (const e of evaluators) {
		if (!e.rubricPath || bodies[e.rubricPath] !== undefined) continue;
		try {
			const raw = await fs.read(e.rubricPath);
			bodies[e.rubricPath] = raw.slice(getFrontMatterInfo(raw).contentStart);
		} catch (err) {
			log.warn("Rubric note unreadable; the judge runs without it", { path: e.rubricPath, error: String(err) });
		}
	}
	return bodies;
}

/** Fill in the real implementation for every dep a caller did not inject (lazily, so tests never build the real runtime). */
function resolveDeps(host: CircuitHost, over: Partial<EvaluateSessionsDeps> = {}): EvaluateSessionsDeps {
	return {
		fs: over.fs ?? new VaultSessionFs(host.app),
		logWriter: over.logWriter ?? new VaultSessionLogWriter(host.app),
		runJudge: over.runJudge ?? runJudge,
		runCodeEvaluator: over.runCodeEvaluator ?? runCodeEvaluator,
		codeRuntimeFactory: over.codeRuntimeFactory ?? makeCodeEvaluatorRuntimeFactory(host),
		buildInput: over.buildInput ?? buildEvalInput,
		resolveBody:
			over.resolveBody ??
			(async (evaluator) => {
				try {
					const resolved = await resolveIncludeNotes(
						evaluator.bodyContent,
						host.app.vault,
						host.app.metadataCache,
						evaluator.notePath,
						"workflow",
					);
					return resolved.inlineContent;
				} catch (e) {
					log.warn("Could not resolve <include_note> tags in evaluator body", { evaluator: evaluator.name, error: String(e) });
					return evaluator.bodyContent;
				}
			}),
		now: over.now ?? (() => new Date().toISOString()),
		makePassId: over.makePassId ?? newPassId,
	};
}

export async function evaluateSessions(
	host: CircuitHost,
	circuit: Circuit,
	sessionIds: readonly string[],
	opts: EvaluateSessionsOptions,
): Promise<EvalPassResult> {
	const deps = resolveDeps(host, opts.deps);
	const abortSignal = opts.abortSignal ?? new AbortController().signal;
	const rootName = circuitDataRootOf(host);
	const notorDir = host.settings.notor_dir;
	const sessionManager = new CircuitSessionManager(notorDir, deps.fs, rootName);

	const evaluators = circuit.evaluators;
	const rubricBodies = await loadRubricBodies(deps.fs, evaluators);
	const fingerprint = evaluatorSetFingerprint(evaluators, rubricBodies);
	const maxCostUsd = circuit.evalMaxCostUsd ?? circuit.maxCostUsd;
	const budget = newRootBudget(Infinity, maxCostUsd);
	const passId = deps.makePassId();
	const startedAt = deps.now();
	const resolvedBodies = new Map<string, string>();
	const bodyOf = async (e: EvaluatorDefinition): Promise<string> => {
		let body = resolvedBodies.get(e.name);
		if (body === undefined) {
			body = await deps.resolveBody(e);
			resolvedBodies.set(e.name, body);
		}
		return body;
	};

	log.info("Evaluation pass starting", {
		circuit: circuit.name,
		passId,
		trigger: opts.trigger,
		sessions: sessionIds.length,
		evaluators: evaluators.map((e) => e.name),
		maxCostUsd,
	});

	const sessions: EvalSessionResult[] = [];
	let totalCostUsd = 0;
	for (const [sessionIndex, sessionId] of sessionIds.entries()) {
		const progress = (phase: EvalProgress["phase"], evaluator: string | null, evaluatorIndex: number): void =>
			opts.onProgress?.({
				sessionId,
				sessionIndex,
				sessionCount: sessionIds.length,
				evaluator,
				evaluatorIndex,
				evaluatorCount: evaluators.length,
				phase,
			});

		const loaded = await loadFinishedSession(deps.fs, sessionManager, sessionId);
		if (!loaded.ok) {
			log.warn("Skipping session", { sessionId, reason: loaded.reason });
			sessions.push({ sessionId, meta: null, outcome: null, outcomes: [], skipped: loaded.reason, reportPath: null });
			progress("skipped", null, 0);
			continue;
		}
		const { session } = loaded;
		const evalLog = new EvalLog(evalLogPath(session.workspace.sessionDir), deps.logWriter, deps.now);
		await evalLog.appendPassStart({
			pass_id: passId,
			circuit: circuit.name,
			trigger: opts.trigger,
			evaluators: evaluators.map((e) => e.name),
			evaluator_fingerprint: fingerprint,
			max_cost_usd: maxCostUsd,
		});

		const outcomes: EvaluatorOutcome[] = [];
		for (const [evaluatorIndex, evaluator] of evaluators.entries()) {
			progress("start", evaluator.name, evaluatorIndex);
			let outcome: EvaluatorOutcome;
			try {
				if (abortSignal.aborted) {
					outcome = {
						evaluator: evaluator.name,
						mode: evaluator.mode,
						ok: false,
						reason: "aborted",
						detail: "evaluation cancelled",
						costUsd: 0,
						modelId: null,
					};
				} else {
					const input = await deps.buildInput(host, {
						circuit,
						evaluator,
						loaded: session,
						includeNoteContents: evaluator.mode === "conversation" && evaluator.includeNoteContents,
					});
					outcome =
						evaluator.mode === "code"
							? await deps.runCodeEvaluator({
									evaluator,
									input,
									sessionDir: session.workspace.sessionDir,
									abortSignal,
									runtimeFactory: deps.codeRuntimeFactory,
									readLog: async () => session.entries,
								})
							: await deps.runJudge(host, {
									evaluator,
									input,
									resolvedBody: await bodyOf(evaluator),
									rubric: evaluator.rubricPath ? (rubricBodies[evaluator.rubricPath] ?? null) : null,
									budget,
									abortSignal,
									sessionDir: session.workspace.sessionDir,
								});
				}
			} catch (e) {
				outcome = {
					evaluator: evaluator.name,
					mode: evaluator.mode,
					ok: false,
					reason: "error",
					detail: e instanceof Error ? e.message : String(e),
					costUsd: 0,
					modelId: null,
				};
			}
			outcomes.push(outcome);
			totalCostUsd += outcome.costUsd;
			if (outcome.ok) {
				await evalLog.appendScored({
					pass_id: passId,
					evaluator: outcome.evaluator,
					mode: outcome.mode,
					model_id: outcome.modelId,
					scores: outcome.scores,
					rationale: outcome.rationale,
					overall: outcome.overall,
					cost_usd: outcome.costUsd,
				});
				progress("scored", evaluator.name, evaluatorIndex);
			} else {
				await evalLog.appendFailed({
					pass_id: passId,
					evaluator: outcome.evaluator,
					mode: outcome.mode,
					model_id: outcome.modelId,
					reason: outcome.reason,
					detail: outcome.detail,
					cost_usd: outcome.costUsd,
				});
				progress("failed", evaluator.name, evaluatorIndex);
			}
		}

		await evalLog.appendPassComplete({
			pass_id: passId,
			cost_usd: outcomes.reduce((sum, o) => sum + o.costUsd, 0),
			scored: outcomes.filter((o) => o.ok).length,
			failed: outcomes.filter((o) => !o.ok).length,
		});

		const sessionResult: EvalSessionResult = {
			sessionId,
			meta: session.meta,
			outcome: session.outcome,
			outcomes,
			skipped: null,
			reportPath: null,
		};
		if (host.settings.circuits_write_eval_reports) {
			try {
				sessionResult.reportPath = await writeEvalReport({
					notorDir,
					fs: deps.fs,
					rootName,
					pass: { passId, circuit: circuit.name, trigger: opts.trigger, fingerprint, finishedAt: deps.now() },
					session: sessionResult,
				});
			} catch (e) {
				log.warn("Failed to write evaluation report", { sessionId, error: String(e) });
			}
		}
		sessions.push(sessionResult);
	}

	const result: EvalPassResult = {
		passId,
		circuit: circuit.name,
		trigger: opts.trigger,
		startedAt,
		finishedAt: deps.now(),
		fingerprint,
		maxCostUsd,
		sessions,
		totalCostUsd,
	};
	log.info("Evaluation pass finished", {
		circuit: circuit.name,
		passId,
		evaluated: sessions.filter((s) => !s.skipped).length,
		skipped: sessions.filter((s) => s.skipped).length,
		totalCostUsd,
	});
	return result;
}
