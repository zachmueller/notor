/**
 * `readRunOutcome` — the finished-session outcome reader behind evaluation.
 * Prefers the `run.result` entry; reconstructs older logs from the terminal
 * `event.emitted` + summed turn costs; returns null for unfinished sessions.
 */

import { describe, it, expect } from "vitest";
import { readRunOutcome } from "./run-outcome";
import type { SessionLogEntry } from "./session-log";

const TS = "2026-06-28T00:00:00.000Z";

function turnComplete(turn: number, cost: number, conv: string | null = "c"): SessionLogEntry {
	return {
		type: "turn.complete",
		turn,
		step: "S",
		emitted_topic: "x",
		conversation_id: conv,
		cost_usd: cost,
		token_usage: { input: 100, output: 50 },
		ts: TS,
	};
}

function emitted(turn: number, topic: string, payload: string): SessionLogEntry {
	return { type: "event.emitted", turn, topic, payload, source_step: "S", ts: TS };
}

describe("readRunOutcome", () => {
	it("prefers the run.result entry when present", () => {
		const entries: SessionLogEntry[] = [
			turnComplete(1, 0.5),
			emitted(1, "FLOW_COMPLETE", "payload text"),
			{ type: "session.complete", ts: TS },
			{
				type: "run.result",
				status: "completed",
				terminal_topic: "CIRCUIT_COMPLETE",
				text: "closing text",
				structured: { report: "r" },
				cost_usd: 0.75,
				token_usage: { input: 10, output: 5 },
				iterations: 3,
				ts: TS,
			},
		];
		expect(readRunOutcome(entries)).toEqual({
			status: "completed",
			terminalTopic: "FLOW_COMPLETE",
			text: "closing text",
			structured: { report: "r" },
			costUsd: 0.75,
			tokenUsage: { input: 10, output: 5 },
			iterations: 3,
			source: "run.result",
		});
	});

	it("falls back to the terminal event.emitted + summed costs for legacy logs", () => {
		const entries: SessionLogEntry[] = [
			turnComplete(1, 0.1),
			turnComplete(2, 0.2, null),
			{ type: "child.result", turn: 2, child_session_id: "k", text: "t", stop_reason: "completed", cost_usd: 0.05, ts: TS },
			emitted(2, "CIRCUIT_COMPLETE", "legacy closing payload"),
			{ type: "session.complete", ts: TS },
		];
		const outcome = readRunOutcome(entries);
		expect(outcome).toMatchObject({
			status: "completed",
			terminalTopic: "FLOW_COMPLETE",
			text: "legacy closing payload",
			structured: null,
			iterations: 2,
			tokenUsage: { input: 200, output: 100 },
			source: "fallback",
		});
		expect(outcome!.costUsd).toBeCloseTo(0.35, 10);
	});

	it("maps FLOW_ERROR / FLOW_CANCELLED terminals to their statuses in the fallback", () => {
		expect(readRunOutcome([emitted(1, "FLOW_ERROR", "bad")])).toMatchObject({ status: "error", text: "bad" });
		expect(readRunOutcome([emitted(1, "FLOW_CANCELLED", "")])).toMatchObject({ status: "cancelled" });
	});

	it("uses a terminal meta.status (and the cancellation reason) when no terminal event was logged", () => {
		const entries: SessionLogEntry[] = [turnComplete(1, 0.1), { type: "session.cancelled", reason: "user stop", ts: TS }];
		expect(readRunOutcome(entries, { status: "cancelled" })).toMatchObject({
			status: "cancelled",
			terminalTopic: "FLOW_CANCELLED",
			text: "user stop",
			source: "fallback",
		});
	});

	it("returns null for a session with no terminal signal", () => {
		expect(readRunOutcome([turnComplete(1, 0.1)])).toBeNull();
		expect(readRunOutcome([turnComplete(1, 0.1)], { status: "active" })).toBeNull();
		expect(readRunOutcome([], { status: "interrupted" })).toBeNull();
	});
});
