import { describe, it, expect } from "vitest";
import type { SessionLogEntry } from "../session-log";
import type { Circuit, EvaluatorDefinition } from "../types";
import type { CircuitHost } from "../host";
import { buildEvalInput, readNoteContents, runFinishedAtOf, stepConversationIdsOf, type NoteReader } from "./eval-input";
import type { LoadedSession } from "./session-loader";

const TS = "2026-10-18T10:00:00.000Z";

const entries: SessionLogEntry[] = [
	{ type: "turn.start", turn: 1, step: "A", trigger_topic: "start", conversation_id: "c1", ts: "2026-10-18T09:00:00.000Z" },
	{ type: "turn.complete", turn: 1, step: "A", emitted_topic: "x", conversation_id: "c1", cost_usd: 0.1, token_usage: { input: 1, output: 1 }, ts: "2026-10-18T09:01:00.000Z" },
	{ type: "turn.start", turn: 2, step: "B", trigger_topic: "x", conversation_id: null, ts: "2026-10-18T09:02:00.000Z" },
	{ type: "turn.complete", turn: 2, step: "B", emitted_topic: "y", conversation_id: null, cost_usd: 0, token_usage: { input: 0, output: 0 }, ts: "2026-10-18T09:03:00.000Z" },
	{ type: "turn.start", turn: 3, step: "C", trigger_topic: "y", conversation_id: "c3", ts: "2026-10-18T09:04:00.000Z" },
	{ type: "turn.complete", turn: 3, step: "C", emitted_topic: "FLOW_COMPLETE", conversation_id: "c3", cost_usd: 0.2, token_usage: { input: 1, output: 1 }, ts: "2026-10-18T09:05:00.000Z" },
	{ type: "session.complete", ts: TS },
];

describe("stepConversationIdsOf / runFinishedAtOf", () => {
	it("collects conversation-step ids in order, skipping code steps and duplicates", () => {
		expect(stepConversationIdsOf(entries)).toEqual(["c1", "c3"]);
	});
	it("finds the run's finish timestamp from the last terminal-ish entry", () => {
		expect(runFinishedAtOf(entries)).toBe(TS);
		expect(runFinishedAtOf([])).toBeNull();
	});
});

describe("readNoteContents", () => {
	const reader = (files: Record<string, { body: string; mtime?: number }>): NoteReader => ({
		read: async (p) => {
			const f = files[p];
			if (!f) throw new Error("ENOENT");
			return f.body;
		},
		stat: async (p) => (files[p]?.mtime !== undefined ? { mtime: files[p]!.mtime! } : null),
	});

	it("caps per note and in total, flags truncation, and flags notes changed after the run", async () => {
		const after = Date.parse(TS) + 60_000;
		const before = Date.parse(TS) - 60_000;
		const out = await readNoteContents(
			reader({
				"a.md": { body: "x".repeat(30), mtime: after },
				"b.md": { body: "y".repeat(30), mtime: before },
				"c.md": { body: "z".repeat(30) },
			}),
			["a.md", "b.md", "c.md"],
			TS,
			{ perNote: 20, total: 35 },
		);
		expect(out[0]).toEqual({ path: "a.md", content: "x".repeat(20), truncated: true, mtimeAfterRun: true });
		expect(out[1]).toEqual({ path: "b.md", content: "y".repeat(15), truncated: true, mtimeAfterRun: false });
		// Total cap exhausted: listed, empty, truncated; no stat → null.
		expect(out[2]).toEqual({ path: "c.md", content: "", truncated: true, mtimeAfterRun: null });
	});

	it("treats an unreadable note as empty + truncated rather than failing", async () => {
		const out = await readNoteContents(reader({}), ["gone.md"], TS);
		expect(out).toEqual([{ path: "gone.md", content: "", truncated: true, mtimeAfterRun: null }]);
	});
});

describe("buildEvalInput", () => {
	const circuit = { name: "Demo", description: "A demo" } as Circuit;
	const evaluator = {
		name: "judge",
		dimensions: [{ name: "accuracy", type: "numeric", min: 1, max: 5, description: null }],
	} as EvaluatorDefinition;
	const loaded: LoadedSession = {
		meta: {
			session_id: "s1",
			flow_name: "Demo",
			status: "completed",
			iteration: 3,
			active_step: null,
			started_at: "2026-10-18T08:59:00.000Z",
			prompt: "Research X",
			parent_session_id: null,
			origin: "user",
		},
		entries,
		outcome: {
			status: "completed",
			terminalTopic: "FLOW_COMPLETE",
			text: "done",
			structured: { report: "r" },
			costUsd: 0.3,
			tokenUsage: { input: 2, output: 2 },
			iterations: 3,
			source: "run.result",
		},
		workspace: {
			sessionId: "s1",
			sessionDir: "notor/circuits/sessions/s1",
			scratchpadPath: "notor/circuits/sessions/s1/scratchpad",
			tasksPath: "notor/circuits/sessions/s1/tasks",
			metaPath: "notor/circuits/sessions/s1/session.json",
			logPath: "notor/circuits/sessions/s1/session-log.jsonl",
		},
	};
	const host = {} as CircuitHost;

	it("assembles objective, outcome, edited notes (from the step conversation ids) and contents when asked", async () => {
		const seenIds: string[][] = [];
		const input = await buildEvalInput(host, {
			circuit,
			evaluator,
			loaded,
			includeNoteContents: true,
			deps: {
				notesEdited: async (ids) => {
					seenIds.push(ids);
					return ["out/report.md"];
				},
				reader: { read: async () => "# Report", stat: async () => null },
			},
		});
		expect(seenIds).toEqual([["c1", "c3"]]);
		expect(input).toMatchObject({
			circuit: { name: "Demo", description: "A demo" },
			session: { sessionId: "s1", origin: "user", sessionDir: "notor/circuits/sessions/s1" },
			objective: "Research X",
			outcome: { status: "completed", structured: { report: "r" } },
			notesEdited: ["out/report.md"],
			noteContents: [{ path: "out/report.md", content: "# Report", truncated: false, mtimeAfterRun: null }],
			evaluator: { name: "judge" },
		});
	});

	it("skips note contents when not requested and survives a notes-edited failure", async () => {
		const input = await buildEvalInput(host, {
			circuit,
			evaluator,
			loaded,
			includeNoteContents: false,
			deps: { notesEdited: async () => { throw new Error("no tool registry"); } },
		});
		expect(input.notesEdited).toEqual([]);
		expect(input.noteContents).toEqual([]);
	});
});
