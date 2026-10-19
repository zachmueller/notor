/**
 * `readRunOutcome` — recover a finished session's terminal outcome from its
 * parsed `session-log.jsonl`.
 *
 * Prefers the `run.result` entry `finalizeRun` appends. Sessions recorded before
 * that entry existed are reconstructed from what the log does carry: the last
 * terminal `event.emitted` (status + closing text), the summed per-turn and
 * child costs, and `structured: null` (never persisted for a root run). The
 * `source` field tells callers which path produced the outcome so a report can
 * flag degraded inputs.
 */

import type { SessionLogEntry } from "./session-log";
import type { CircuitSessionMeta } from "./types";
import { FLOW_CANCELLED, FLOW_COMPLETE, FLOW_ERROR, canonicalTopic, isTerminalTopic } from "./types";

export type RunOutcomeStatus = "completed" | "cancelled" | "error";

export interface RunOutcome {
	status: RunOutcomeStatus;
	terminalTopic: string;
	text: string;
	structured: unknown;
	costUsd: number;
	tokenUsage: { input: number; output: number };
	iterations: number;
	/** `run.result` when the entry was present; `fallback` when reconstructed from older logs. */
	source: "run.result" | "fallback";
}

function statusForTopic(topic: string): RunOutcomeStatus {
	const t = canonicalTopic(topic);
	if (t === FLOW_COMPLETE) return "completed";
	if (t === FLOW_CANCELLED) return "cancelled";
	return "error";
}

function topicForStatus(status: RunOutcomeStatus): string {
	if (status === "completed") return FLOW_COMPLETE;
	if (status === "cancelled") return FLOW_CANCELLED;
	return FLOW_ERROR;
}

/**
 * Read the terminal outcome of a session from its log entries.
 *
 * Returns `null` when the session has no terminal signal (still active or
 * interrupted): no `run.result`, no terminal `event.emitted`, and no terminal
 * `meta.status`.
 */
export function readRunOutcome(
	entries: SessionLogEntry[],
	meta?: Pick<CircuitSessionMeta, "status"> | null,
): RunOutcome | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i]!;
		if (e.type === "run.result") {
			return {
				status: e.status,
				terminalTopic: canonicalTopic(e.terminal_topic),
				text: e.text ?? "",
				structured: e.structured ?? null,
				costUsd: e.cost_usd ?? 0,
				tokenUsage: { input: e.token_usage?.input ?? 0, output: e.token_usage?.output ?? 0 },
				iterations: e.iterations ?? 0,
				source: "run.result",
			};
		}
	}

	// Fallback for logs written before run.result existed.
	let costUsd = 0;
	let input = 0;
	let output = 0;
	let iterations = 0;
	let terminal: { topic: string; payload: string } | null = null;
	let cancelledReason: string | null = null;
	for (const e of entries) {
		if (e.type === "turn.complete") {
			costUsd += e.cost_usd ?? 0;
			input += e.token_usage?.input ?? 0;
			output += e.token_usage?.output ?? 0;
			iterations += 1;
		} else if (e.type === "child.result") {
			costUsd += e.cost_usd ?? 0;
		} else if (e.type === "event.emitted" && isTerminalTopic(e.topic)) {
			terminal = { topic: canonicalTopic(e.topic), payload: e.payload };
		} else if (e.type === "session.cancelled") {
			cancelledReason = e.reason;
		}
	}

	let status: RunOutcomeStatus;
	let terminalTopic: string;
	let text: string;
	if (terminal) {
		status = statusForTopic(terminal.topic);
		terminalTopic = terminal.topic;
		text = terminal.payload;
	} else if (meta && (meta.status === "completed" || meta.status === "cancelled" || meta.status === "error")) {
		status = meta.status;
		terminalTopic = topicForStatus(status);
		text = cancelledReason ?? "";
	} else {
		return null;
	}

	return {
		status,
		terminalTopic,
		text,
		structured: null,
		costUsd,
		tokenUsage: { input, output },
		iterations,
		source: "fallback",
	};
}
