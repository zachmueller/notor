/**
 * `evals.jsonl` — the append-only evaluation log beside a session's
 * `session-log.jsonl`.
 *
 * Kept separate so the run's own log stays immutable after `finalizeRun`. Each
 * pass is bracketed by `eval.pass_start` / `eval.pass_complete` and tagged with
 * a `pass_id`, so re-scoring after a rubric edit is a separate, comparable pass.
 * The `evaluator_fingerprint` on `pass_start` identifies the evaluator set that
 * ran; the picker and the scheduler use it to tell "already evaluated with the
 * current evaluators" from "evaluated with an older rubric".
 */

import { logger } from "../../utils/logger";
import type { SessionLogWriter } from "../session-log";
import { parseJsonlEntries } from "../session-log-reader";
import type { EvalFailureReason, EvalTrigger } from "./types";

const log = logger("CircuitEvalLog");

interface BaseEvalEntry {
	type: string;
	ts: string;
	pass_id: string;
}

export interface EvalPassStartEntry extends BaseEvalEntry {
	type: "eval.pass_start";
	circuit: string;
	trigger: EvalTrigger;
	evaluators: string[];
	evaluator_fingerprint: string;
	max_cost_usd: number;
}

export interface EvalScoredEntry extends BaseEvalEntry {
	type: "eval.scored";
	evaluator: string;
	mode: "conversation" | "code";
	model_id: string | null;
	scores: Record<string, number | boolean>;
	rationale: string;
	overall: number | null;
	cost_usd: number;
}

export interface EvalFailedEntry extends BaseEvalEntry {
	type: "eval.failed";
	evaluator: string;
	mode: "conversation" | "code";
	model_id: string | null;
	reason: EvalFailureReason;
	detail: string;
	cost_usd: number;
}

export interface EvalPassCompleteEntry extends BaseEvalEntry {
	type: "eval.pass_complete";
	cost_usd: number;
	scored: number;
	failed: number;
}

export type EvalLogEntry = EvalPassStartEntry | EvalScoredEntry | EvalFailedEntry | EvalPassCompleteEntry;

/** `{sessionDir}/evals.jsonl`. */
export function evalLogPath(sessionDir: string): string {
	return `${sessionDir.replace(/\/+$/, "")}/evals.jsonl`;
}

/** Append-only writer for one session's `evals.jsonl` (same durability model as `SessionLog`). */
export class EvalLog {
	private writeChain: Promise<void> = Promise.resolve();
	private readonly now: () => string;

	constructor(
		private readonly filePath: string,
		private readonly writer: SessionLogWriter,
		now?: () => string,
	) {
		this.now = now ?? (() => new Date().toISOString());
	}

	get path(): string {
		return this.filePath;
	}

	appendPassStart(entry: Omit<EvalPassStartEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "eval.pass_start", ts: this.now(), ...entry });
	}

	appendScored(entry: Omit<EvalScoredEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "eval.scored", ts: this.now(), ...entry });
	}

	appendFailed(entry: Omit<EvalFailedEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "eval.failed", ts: this.now(), ...entry });
	}

	appendPassComplete(entry: Omit<EvalPassCompleteEntry, "type" | "ts">): Promise<void> {
		return this.write({ type: "eval.pass_complete", ts: this.now(), ...entry });
	}

	private write(entry: EvalLogEntry): Promise<void> {
		let line: string;
		try {
			line = JSON.stringify(entry) + "\n";
		} catch (e) {
			log.error("evals.jsonl entry not serializable", { path: this.filePath, type: entry.type, error: String(e) });
			return Promise.resolve();
		}
		const next = this.writeChain.then(async () => {
			try {
				await this.writer.append(this.filePath, line);
			} catch (e) {
				log.error("evals.jsonl append failed", { path: this.filePath, type: entry.type, error: String(e) });
			}
		});
		this.writeChain = next.catch(() => {});
		return next;
	}
}

/**
 * Parse an `evals.jsonl` file. Tolerant: a torn final line is dropped (the
 * shared JSONL policy) and, unlike recovery, an interior bad line only drops
 * that line — an evaluation history must never become unreadable because one
 * append was torn.
 */
export function readEvalLog(raw: string | null | undefined): EvalLogEntry[] {
	if (!raw) return [];
	try {
		return parseJsonlEntries<EvalLogEntry>(raw).entries;
	} catch {
		const entries: EvalLogEntry[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as EvalLogEntry;
				if (parsed && typeof parsed === "object" && typeof parsed.type === "string") entries.push(parsed);
			} catch {
				// skip the torn line
			}
		}
		return entries;
	}
}

export interface EvalLogSummary {
	/** Fingerprints of evaluator sets that have at least one COMPLETED pass. */
	completedFingerprints: Set<string>;
	/** `ts` of the most recent `eval.pass_complete`, or `null`. */
	lastCompletedAt: string | null;
	/** Number of completed passes. */
	passCount: number;
}

/** Roll an `evals.jsonl` up to what the picker / scheduler need. */
export function summarizeEvalLog(entries: readonly EvalLogEntry[]): EvalLogSummary {
	const starts = new Map<string, EvalPassStartEntry>();
	const completedFingerprints = new Set<string>();
	let lastCompletedAt: string | null = null;
	let passCount = 0;
	for (const e of entries) {
		if (e.type === "eval.pass_start") {
			starts.set(e.pass_id, e);
		} else if (e.type === "eval.pass_complete") {
			const start = starts.get(e.pass_id);
			if (start) completedFingerprints.add(start.evaluator_fingerprint);
			passCount += 1;
			if (!lastCompletedAt || e.ts > lastCompletedAt) lastCompletedAt = e.ts;
		}
	}
	return { completedFingerprints, lastCompletedAt, passCount };
}
