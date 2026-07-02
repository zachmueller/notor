/**
 * TEST-002 (support) — `SessionLog` writer unit tests (FEAT-006).
 *
 * Verifies the append-only contract: one newline-terminated JSON object per
 * append, never truncated/rewritten, serialized (no interleaved partial lines),
 * and the per-entry shape (`type`, `ts`, and `turn` where applicable).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-006 / TEST-002
 */

import { describe, it, expect } from "vitest";
import { SessionLog, type SessionLogWriter } from "./session-log";

/** A fake append-only writer that accumulates the file content. */
class FakeWriter implements SessionLogWriter {
	content = "";
	calls: string[] = [];
	async append(path: string, data: string): Promise<void> {
		this.calls.push(path);
		this.content += data;
	}
}

const fixedNow = () => "2026-06-28T00:00:00.000Z";

describe("SessionLog", () => {
	it("writes exactly one newline-terminated JSON object per append", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("sessions/s1/session-log.jsonl", writer, fixedNow);

		await log.appendSessionStart({
			session_id: "s1",
			flow: "Demo",
			prompt: "do the thing",
			origin: "user",
			parent_session_id: null,
		});

		const lines = writer.content.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(writer.content.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(lines[0]!);
		expect(parsed).toMatchObject({ type: "session.start", session_id: "s1", flow: "Demo", origin: "user" });
		expect(parsed.ts).toBe(fixedNow());
	});

	it("appends — never truncates or rewrites the file", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("sessions/s1/log.jsonl", writer, fixedNow);
		await log.appendTurnStart({ turn: 1, step: "A", trigger_topic: "start", conversation_id: "c1" });
		const afterFirst = writer.content;
		await log.appendTurnComplete({
			turn: 1,
			step: "A",
			emitted_topic: "work",
			conversation_id: "c1",
			cost_usd: 0.01,
			token_usage: { input: 100, output: 50 },
		});
		// The first line is still present verbatim (append-only).
		expect(writer.content.startsWith(afterFirst)).toBe(true);
		const lines = writer.content.split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
	});

	it("records cost_usd + token_usage on turn.complete (Issue-5)", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("l.jsonl", writer, fixedNow);
		await log.appendTurnComplete({
			turn: 2,
			step: "Verify",
			emitted_topic: "tests.passed",
			conversation_id: null,
			cost_usd: 0,
			token_usage: { input: 0, output: 0 },
		});
		const entry = JSON.parse(writer.content.trim());
		expect(entry).toMatchObject({ type: "turn.complete", cost_usd: 0, token_usage: { input: 0, output: 0 } });
	});

	it("records event.emission_overwritten (Issue-13e audit)", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("l.jsonl", writer, fixedNow);
		await log.appendEventEmissionOverwritten({ turn: 1, step: "A", prev_topic: "x", new_topic: "y" });
		const entry = JSON.parse(writer.content.trim());
		expect(entry).toMatchObject({
			type: "event.emission_overwritten",
			prev_topic: "x",
			new_topic: "y",
		});
	});

	it("records child.spawned / child.result (Issue-1 reuse ledger)", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("l.jsonl", writer, fixedNow);
		await log.appendChildSpawned({
			turn: 1,
			step: "Caller",
			flow_name: "ChildFlow",
			ordinal: 0,
			via_tool_call_id: "toolu_1",
			child_session_id: "child-1",
		});
		await log.appendChildResult({
			turn: 1,
			child_session_id: "child-1",
			text: "done",
			stop_reason: "completed",
		});
		const lines = writer.content.split("\n").filter(Boolean).map((l) => JSON.parse(l));
		expect(lines[0]).toMatchObject({ type: "child.spawned", via_tool_call_id: "toolu_1" });
		expect(lines[1]).toMatchObject({ type: "child.result", stop_reason: "completed" });
	});

	it("serializes concurrent appends without interleaving partial lines", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("l.jsonl", writer, fixedNow);
		// Fire several appends without awaiting between them.
		const p1 = log.appendEventEmitted({ turn: 1, topic: "a", payload: "1", source_step: null });
		const p2 = log.appendEventEmitted({ turn: 2, topic: "b", payload: "2", source_step: "A" });
		const p3 = log.appendEventEmitted({ turn: 3, topic: "c", payload: "3", source_step: "B" });
		await Promise.all([p1, p2, p3]);

		const lines = writer.content.split("\n").filter(Boolean);
		expect(lines).toHaveLength(3);
		// Each line is independently valid JSON (no torn lines), in submission order.
		const topics = lines.map((l) => JSON.parse(l).topic);
		expect(topics).toEqual(["a", "b", "c"]);
	});

	it("appendSessionComplete writes a terminal entry", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("l.jsonl", writer, fixedNow);
		await log.appendSessionComplete();
		expect(JSON.parse(writer.content.trim())).toMatchObject({ type: "session.complete" });
	});

	it("appendStepLog writes a step.log entry keyed by turn + step (INT-011)", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("l.jsonl", writer, fixedNow);
		await log.appendStepLog({ turn: 4, step: "Verify", level: "info", message: "chose A", data: { n: 3 } });
		const lines = writer.content.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(writer.content.endsWith("\n")).toBe(true);
		expect(JSON.parse(lines[0]!)).toMatchObject({
			type: "step.log",
			ts: fixedNow(),
			turn: 4,
			step: "Verify",
			level: "info",
			message: "chose A",
			data: { n: 3 },
		});
	});

	it("a failing writer never rejects the append (logging must not crash a run)", async () => {
		const throwing: SessionLogWriter = { append: () => Promise.reject(new Error("disk full")) };
		const log = new SessionLog("l.jsonl", throwing, fixedNow);
		await expect(
			log.appendStepLog({ turn: 1, step: "A", level: "error", message: "x" }),
		).resolves.toBeUndefined();
	});

	it("appendSessionStart stamps schema_version: 1 on the entry", async () => {
		const writer = new FakeWriter();
		const log = new SessionLog("l.jsonl", writer, fixedNow);
		await log.appendSessionStart({
			session_id: "s1",
			flow: "Demo",
			prompt: "go",
			origin: "user",
			parent_session_id: null,
		});
		const entry = JSON.parse(writer.content.trim());
		expect(entry.schema_version).toBe(1);
	});
});
