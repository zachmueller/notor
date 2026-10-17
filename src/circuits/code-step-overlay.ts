/**
 * Code-step run-tree overlay (pure helpers) — the read side of the
 * `orchestration.log` feature.
 *
 * A code step (`notor-step-mode: code`) creates **no conversation file**, so it
 * is invisible to the run-tree's conversation-header scan. It does, however,
 * leave a trace in `session-log.jsonl`: a `turn.start` / `turn.complete` pair
 * with `conversation_id: null`, plus any `step.log` entries the step emitted via
 * `orchestration.log`. These helpers turn that trace into:
 *
 *  1. {@link extractCodeStepTurns} — the per-session list of code-step turns
 *     (keyed by the step-turn / hop counter `turn`, the SAME unit as a
 *     conversation header's `orchestration_iteration`), each carrying its logs;
 *  2. {@link spliceCodeSteps} — an overlay that inserts a synthesized code-step
 *     node into an already-built conversation-node tree at the right hop
 *     position, so the run-tree reads conversation-turn → its code-step(s) →
 *     next conversation-turn.
 *
 * Both are **pure** (no Obsidian / view dependency) so they unit-test directly.
 * The view ({@link OrchestrationRunTreeView}) owns reading the log files and
 * constructing real `RunTreeNode`s via the injected factory.
 */

import type { SessionLogEntry } from "./session-log";

/** A single persisted code-step log line (projected from a `step.log` entry). */
export interface CodeStepLog {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	data?: unknown;
	ts: string;
}

/** One code-step turn reconstructed from the session log, with its logs. */
export interface CodeStepTurn {
	/** Step-turn / hop counter (== a conversation header's `orchestration_iteration`). */
	turn: number;
	step: string;
	/** The topic the code step emitted (from its `turn.complete`), when known. */
	emittedTopic?: string;
	/** Logs emitted via `orchestration.log` during the turn (file order, capped). */
	logs: CodeStepLog[];
}

/** Max log rows rendered per code-step turn — guards against a hot loop. */
export const MAX_LOGS_PER_CODE_STEP = 200;

/**
 * Reconstruct the ordered code-step turns of a single session from its parsed
 * `session-log.jsonl` entries. A code-step turn is a `turn.start` with
 * `conversation_id === null` (a conversation step writes a non-null id, so this
 * cleanly discriminates). Logs are matched to their turn by the shared `turn`
 * counter, kept in file order, and clamped to {@link MAX_LOGS_PER_CODE_STEP}
 * (with a synthetic trailing marker noting how many were dropped).
 */
export function extractCodeStepTurns(entries: SessionLogEntry[]): CodeStepTurn[] {
	const byTurn = new Map<number, CodeStepTurn>();
	const dropped = new Map<number, number>();

	for (const e of entries) {
		if (e.type === "turn.start" && e.conversation_id === null) {
			if (!byTurn.has(e.turn)) byTurn.set(e.turn, { turn: e.turn, step: e.step, logs: [] });
		} else if (e.type === "turn.complete" && e.conversation_id === null) {
			const turn = byTurn.get(e.turn);
			if (turn) turn.emittedTopic = e.emitted_topic;
			// Defensive: a turn.complete with no preceding null turn.start still marks
			// a code-step turn (a torn/partial log) — synthesize one so it is visible.
			else byTurn.set(e.turn, { turn: e.turn, step: e.step, emittedTopic: e.emitted_topic, logs: [] });
		} else if (e.type === "step.log") {
			const turn = byTurn.get(e.turn);
			if (!turn) continue; // a log with no matching code-step turn — drop (defensive)
			if (turn.logs.length < MAX_LOGS_PER_CODE_STEP) {
				turn.logs.push({ level: e.level, message: e.message, data: e.data, ts: e.ts });
			} else {
				dropped.set(e.turn, (dropped.get(e.turn) ?? 0) + 1);
			}
		}
	}

	for (const [turn, count] of dropped) {
		const t = byTurn.get(turn);
		if (!t) continue;
		const lastTs = t.logs[t.logs.length - 1]?.ts ?? "";
		t.logs.push({ level: "info", message: `… (${count} more log${count !== 1 ? "s" : ""} truncated)`, ts: lastTs });
	}

	return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
}

/** The minimal node shape {@link spliceCodeSteps} reads from the built tree. */
export interface OverlayNode {
	sessionId?: string;
	iteration?: number;
	kind: string;
	children: OverlayNode[];
}

/**
 * Splice synthesized code-step nodes into an already-built conversation-node
 * tree. For each session, a code-step turn at hop `T` attaches to the
 * conversation node with the greatest `iteration <= T` in the SAME session
 * (inserted before that host's same-session next-step successor, so it reads in
 * hop order). A code step that precedes all of its session's conversation turns
 * is hoisted to a root sibling when it belongs to the root session, else
 * attached to that session's earliest conversation node (best effort — keeps it
 * inside the child subtree).
 *
 * Generic over the node type so it tests with a plain fake and operates on the
 * view's real `RunTreeNode` without importing it. Mutates `roots`/children in
 * place; node creation is delegated to `makeCodeStepNode`.
 */
export function spliceCodeSteps<N extends OverlayNode>(args: {
	roots: N[];
	turnsBySession: Map<string, CodeStepTurn[]>;
	rootSessionId?: string;
	makeCodeStepNode: (turn: CodeStepTurn, sessionId: string) => N;
}): void {
	const { roots, turnsBySession, rootSessionId, makeCodeStepNode } = args;
	if (turnsBySession.size === 0) return;

	// Collect every conversation node (step / child-flow) grouped by session.
	const convBySession = new Map<string, N[]>();
	const visit = (node: N): void => {
		if (isConversationNode(node) && node.sessionId) {
			const list = convBySession.get(node.sessionId) ?? [];
			list.push(node);
			convBySession.set(node.sessionId, list);
		}
		for (const child of node.children) visit(child as N);
	};
	for (const root of roots) visit(root);

	for (const [sessionId, turns] of turnsBySession) {
		const conv = (convBySession.get(sessionId) ?? [])
			.slice()
			.sort((a, b) => (a.iteration ?? 0) - (b.iteration ?? 0));

		for (const turn of turns) {
			const node = makeCodeStepNode(turn, sessionId);
			const host = findHost(conv, turn.turn);
			if (host) {
				insertBeforeSuccessor(host, node, sessionId);
			} else if (sessionId === rootSessionId) {
				roots.push(node); // code step before the root session's first conversation turn
			} else if (conv.length > 0) {
				conv[0]!.children.unshift(node); // child session — keep it inside the subtree
			}
			// else: a session with no conversation node at all — nowhere to anchor; skip.
		}
	}
}

/** A conversation-derived node (has a real conversation), as opposed to a code-step overlay node. */
function isConversationNode(node: OverlayNode): boolean {
	return node.kind === "step" || node.kind === "child-flow" || node.kind === "sub-agent";
}

/** The conversation node with the greatest `iteration <= turn` (the code step's host). */
function findHost<N extends OverlayNode>(convSorted: N[], turn: number): N | undefined {
	let host: N | undefined;
	for (const n of convSorted) {
		if ((n.iteration ?? 0) <= turn) host = n;
		else break;
	}
	return host;
}

/** Insert `node` into `host.children` before the host's same-session next-step successor. */
function insertBeforeSuccessor<N extends OverlayNode>(host: N, node: N, sessionId: string): void {
	const idx = host.children.findIndex(
		(c) => c.sessionId === sessionId && (c.kind === "step" || c.kind === "code-step"),
	);
	if (idx >= 0) host.children.splice(idx, 0, node);
	else host.children.push(node);
}
