/**
 * TEST-005 (support) — `SessionLogReader` malformed-line policy (INT-005).
 *
 * The reader tolerates a truncated/partial FINAL line (the crash signature of an
 * append-only log) but fails loudly on a malformed INTERIOR line — so recovery
 * never silently drops the dangling tail that drives replay.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-005 / TEST-005
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Malformed-line policy
 */

import { describe, it, expect } from "vitest";
import { SessionLogReader, SessionLogParseError } from "./session-log-reader";

const reader = new SessionLogReader();

function line(obj: unknown): string {
	return JSON.stringify(obj);
}

describe("SessionLogReader", () => {
	it("parses a well-formed, newline-terminated log", () => {
		const raw =
			line({ type: "session.start", session_id: "s", flow: "F", prompt: "p", origin: "user", parent_session_id: null, ts: "t" }) + "\n" +
			line({ type: "event.emitted", turn: 1, topic: "start", payload: "p", source_step: null, ts: "t" }) + "\n";
		const { entries, truncatedFinalLine } = reader.parse(raw);
		expect(entries).toHaveLength(2);
		expect(truncatedFinalLine).toBe(false);
		expect(entries[0]!.type).toBe("session.start");
	});

	it("tolerates a truncated FINAL line (crash mid-append) — last complete entry governs", () => {
		const raw =
			line({ type: "turn.start", turn: 1, step: "A", trigger_topic: "start", conversation_id: "c1", ts: "t" }) + "\n" +
			line({ type: "turn.complete", turn: 1, step: "A", emitted_topic: "work", conversation_id: "c1", cost_usd: 0.01, token_usage: { input: 1, output: 1 }, ts: "t" }) + "\n" +
			'{"type":"event.emitted","turn":1,"topic":"wo'; // partial, no trailing newline
		const { entries, truncatedFinalLine } = reader.parse(raw);
		expect(truncatedFinalLine).toBe(true);
		expect(entries).toHaveLength(2);
		expect(entries[entries.length - 1]!.type).toBe("turn.complete");
	});

	it("throws SessionLogParseError on a malformed INTERIOR line", () => {
		const raw =
			line({ type: "turn.start", turn: 1, step: "A", trigger_topic: "start", conversation_id: "c1", ts: "t" }) + "\n" +
			"{ this is not valid json \n" +
			line({ type: "turn.complete", turn: 1, step: "A", emitted_topic: "work", conversation_id: "c1", cost_usd: 0, token_usage: { input: 0, output: 0 }, ts: "t" }) + "\n";
		expect(() => reader.parse(raw)).toThrow(SessionLogParseError);
		try {
			reader.parse(raw);
		} catch (e) {
			expect(e).toBeInstanceOf(SessionLogParseError);
			expect((e as SessionLogParseError).lineIndex).toBe(1);
		}
	});

	it("throws on an interior entry missing a string `type`", () => {
		const raw =
			line({ type: "turn.start", turn: 1, step: "A", trigger_topic: "x", conversation_id: "c", ts: "t" }) + "\n" +
			line({ foo: "bar" }) + "\n" +
			line({ type: "session.complete", ts: "t" }) + "\n";
		expect(() => reader.parse(raw)).toThrow(SessionLogParseError);
	});

	it("treats a complete-but-invalid FINAL line as interior corruption (loud)", () => {
		// A trailing newline means the last real line was a COMPLETE append — so an
		// invalid one is corruption, not truncation.
		const raw =
			line({ type: "turn.start", turn: 1, step: "A", trigger_topic: "x", conversation_id: "c", ts: "t" }) + "\n" +
			"{ broken }\n";
		expect(() => reader.parse(raw)).toThrow(SessionLogParseError);
	});

	it("tolerates interior blank lines", () => {
		const raw =
			line({ type: "turn.start", turn: 1, step: "A", trigger_topic: "x", conversation_id: "c", ts: "t" }) + "\n" +
			"\n" +
			line({ type: "session.complete", ts: "t" }) + "\n";
		const { entries } = reader.parse(raw);
		expect(entries).toHaveLength(2);
	});

	it("returns no entries for an empty log", () => {
		expect(reader.parse("").entries).toHaveLength(0);
		expect(reader.parse("\n").entries).toHaveLength(0);
	});

	it("round-trips a step.log interior line (parser is type-agnostic)", () => {
		const raw =
			line({ type: "turn.start", turn: 2, step: "Verify", trigger_topic: "x", conversation_id: null, ts: "t" }) + "\n" +
			line({ type: "step.log", turn: 2, step: "Verify", level: "info", message: "chose A", data: { n: 3 }, ts: "t" }) + "\n" +
			line({ type: "turn.complete", turn: 2, step: "Verify", emitted_topic: "ok", conversation_id: null, cost_usd: 0, token_usage: { input: 0, output: 0 }, ts: "t" }) + "\n";
		const { entries } = reader.parse(raw);
		expect(entries).toHaveLength(3);
		expect(entries[1]).toMatchObject({ type: "step.log", level: "info", message: "chose A", data: { n: 3 } });
	});
});
