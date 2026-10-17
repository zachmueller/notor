/**
 * Unit tests for the code-step run-tree overlay (pure helpers).
 *
 * Covers:
 *  - `extractCodeStepTurns` — reconstructs code-step turns (null-conversation
 *    turn.start/complete) from a session log, attaches step.log entries by turn,
 *    orders by hop, and caps log volume;
 *  - `spliceCodeSteps` — inserts a code-step node at its hop position (largest
 *    conversation iteration <= turn), within the right session, hoisting a
 *    pre-first-conversation code step to a root sibling.
 */

import { describe, it, expect } from "vitest";
import {
	extractCodeStepTurns,
	spliceCodeSteps,
	MAX_LOGS_PER_CODE_STEP,
	type CodeStepTurn,
	type OverlayNode,
} from "./code-step-overlay";
import type { SessionLogEntry } from "./session-log";

function turnStart(turn: number, step: string, conversationId: string | null): SessionLogEntry {
	return { type: "turn.start", ts: "T", turn, step, trigger_topic: "t", conversation_id: conversationId };
}
function turnComplete(turn: number, step: string, topic: string, conversationId: string | null): SessionLogEntry {
	return {
		type: "turn.complete",
		ts: "T",
		turn,
		step,
		emitted_topic: topic,
		conversation_id: conversationId,
		cost_usd: 0,
		token_usage: { input: 0, output: 0 },
	};
}
function stepLog(turn: number, step: string, level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): SessionLogEntry {
	return { type: "step.log", ts: "T", turn, step, level, message, ...(data !== undefined ? { data } : {}) };
}

describe("extractCodeStepTurns", () => {
	it("reconstructs code-step turns with their topic + logs, ordered by hop", () => {
		const entries: SessionLogEntry[] = [
			turnStart(1, "Setup", "conv-1"), // conversation step — ignored
			turnComplete(1, "Setup", "ready", "conv-1"),
			turnStart(2, "Verify", null), // code step
			stepLog(2, "Verify", "info", "running tests"),
			stepLog(2, "Verify", "info", "tests passed", { count: 12 }),
			turnComplete(2, "Verify", "tests.passed", null),
		];
		const turns = extractCodeStepTurns(entries);
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({ turn: 2, step: "Verify", emittedTopic: "tests.passed" });
		expect(turns[0]!.logs).toEqual([
			{ level: "info", message: "running tests", data: undefined, ts: "T" },
			{ level: "info", message: "tests passed", data: { count: 12 }, ts: "T" },
		]);
	});

	it("ignores conversation steps (non-null conversation_id)", () => {
		const entries: SessionLogEntry[] = [
			turnStart(1, "Chat", "conv-1"),
			turnComplete(1, "Chat", "done", "conv-1"),
		];
		expect(extractCodeStepTurns(entries)).toEqual([]);
	});

	it("orders multiple code-step turns by hop counter ascending", () => {
		const entries: SessionLogEntry[] = [
			turnStart(5, "Late", null),
			turnComplete(5, "Late", "e5", null),
			turnStart(3, "Early", null),
			turnComplete(3, "Early", "e3", null),
		];
		expect(extractCodeStepTurns(entries).map((t) => t.turn)).toEqual([3, 5]);
	});

	it("caps logs per turn with a truncation marker", () => {
		const entries: SessionLogEntry[] = [turnStart(1, "Loop", null)];
		const total = MAX_LOGS_PER_CODE_STEP + 25;
		for (let i = 0; i < total; i++) entries.push(stepLog(1, "Loop", "debug", `log ${i}`));
		entries.push(turnComplete(1, "Loop", "done", null));

		const turns = extractCodeStepTurns(entries);
		expect(turns[0]!.logs).toHaveLength(MAX_LOGS_PER_CODE_STEP + 1); // cap + marker
		expect(turns[0]!.logs.at(-1)!.message).toMatch(/25 more logs truncated/);
	});

	it("drops a step.log with no matching code-step turn (defensive)", () => {
		const entries: SessionLogEntry[] = [stepLog(9, "Ghost", "warn", "orphan")];
		expect(extractCodeStepTurns(entries)).toEqual([]);
	});
});

// A minimal mutable node for splice tests.
interface FakeNode extends OverlayNode {
	id: string;
	children: FakeNode[];
}
function conv(id: string, sessionId: string, iteration: number, kind = "step"): FakeNode {
	return { id, sessionId, iteration, kind, children: [] };
}
function makeNode(turn: CodeStepTurn, sessionId: string): FakeNode {
	return { id: `code-step:${sessionId}:${turn.turn}`, sessionId, iteration: turn.turn, kind: "code-step", children: [] };
}
function csTurn(turn: number, step = "Code"): CodeStepTurn {
	return { turn, step, logs: [] };
}

describe("spliceCodeSteps", () => {
	it("attaches a code step to the conversation node with the greatest iteration <= turn", () => {
		const a = conv("a", "s1", 1);
		const b = conv("b", "s1", 3);
		a.children.push(b); // a → b chain
		const roots: FakeNode[] = [a];

		spliceCodeSteps<FakeNode>({
			roots,
			turnsBySession: new Map([["s1", [csTurn(2)]]]), // hop 2 → between a(1) and b(3)
			rootSessionId: "s1",
			makeCodeStepNode: makeNode,
		});

		// The code step hosts under `a` (iteration 1 <= 2 < 3), before the next step `b`.
		expect(a.children.map((c) => c.id)).toEqual(["code-step:s1:2", "b"]);
	});

	it("hoists a code step preceding all conversation turns to a root sibling (root session)", () => {
		const a = conv("a", "s1", 5);
		const roots: FakeNode[] = [a];
		spliceCodeSteps<FakeNode>({
			roots,
			turnsBySession: new Map([["s1", [csTurn(1)]]]), // hop 1 < 5 → no host
			rootSessionId: "s1",
			makeCodeStepNode: makeNode,
		});
		expect(roots.map((r) => r.id)).toEqual(["a", "code-step:s1:1"]);
	});

	it("places child-session code steps inside the child subtree, keyed by session", () => {
		const parent = conv("p", "s-parent", 1);
		const child = conv("c", "s-child", 1, "child-flow");
		parent.children.push(child);
		const roots: FakeNode[] = [parent];

		spliceCodeSteps<FakeNode>({
			roots,
			turnsBySession: new Map([["s-child", [csTurn(2)]]]),
			rootSessionId: "s-parent",
			makeCodeStepNode: makeNode,
		});

		// The s-child code step hosts under the child node (its session), not the parent.
		expect(child.children.map((n) => n.id)).toEqual(["code-step:s-child:2"]);
		expect(parent.children.map((n) => n.id)).toEqual(["c"]);
	});

	it("is a no-op when there are no code-step turns", () => {
		const a = conv("a", "s1", 1);
		const roots: FakeNode[] = [a];
		spliceCodeSteps<FakeNode>({ roots, turnsBySession: new Map(), makeCodeStepNode: makeNode });
		expect(roots).toEqual([a]);
		expect(a.children).toEqual([]);
	});
});
