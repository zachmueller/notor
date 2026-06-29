/**
 * `failure-report` (Part B) — composing the opt-in failed-run debug note.
 *
 * Asserts the writer composes from data already captured (session.json meta +
 * the run result + session-log.jsonl) and writes to the discoverable
 * `orchestrations/failures/{slug}-{id}.md` path with the dedicated frontmatter
 * discriminator, the failure reason, the failing-step stack, and the timeline.
 */

import { describe, it, expect } from "vitest";
import {
	writeFailureReport,
	failureReportPath,
	slugifyFlowName,
	shouldWriteFailureReport,
} from "./failure-report";
import type { SessionFs } from "./session-manager";
import type { OrchestrationRunResult } from "./runner";
import type { OrchestrationSessionMeta, OrchestrationEvent } from "./types";

/** Minimal in-memory SessionFs (only write is exercised by the writer). */
class FakeFs implements SessionFs {
	files = new Map<string, string>();
	async exists(p: string): Promise<boolean> {
		return this.files.has(p);
	}
	async mkdir(): Promise<void> {}
	async write(p: string, data: string): Promise<void> {
		this.files.set(p, data);
	}
	async read(p: string): Promise<string> {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT: ${p}`);
		return v;
	}
}

function meta(over: Partial<OrchestrationSessionMeta> = {}): OrchestrationSessionMeta {
	return {
		session_id: "sess-abc123",
		flow_name: "Notor Usage Miner",
		status: "error",
		iteration: 7,
		active_step: "Rollup Build",
		started_at: "2026-06-29T03:00:00Z",
		prompt: "Mine my last 90 days of Notor usage.",
		parent_session_id: null,
		origin: "user",
		...over,
	};
}

function terminal(topic: string, payload: string): OrchestrationEvent {
	return { topic, payload, source_step: "Rollup Build", turn: 7, ts: "2026-06-29T03:17:43Z" };
}

function result(over: Partial<OrchestrationRunResult> = {}): OrchestrationRunResult {
	// The writer reads only status / terminal / iterations; the rest is filler to
	// satisfy the type without dragging in budget/subtree shapes.
	return {
		status: "error",
		terminal: terminal("FLOW_ERROR", "Step failure channel 'rollup-build.code_error' had no handler."),
		iterations: 7,
		structured: null,
		text: "",
		subtreeConsumed: {} as OrchestrationRunResult["subtreeConsumed"],
		tokenUsage: { input: 0, output: 0 },
		budget: {} as OrchestrationRunResult["budget"],
		depth: 0,
		...over,
	};
}

const SESSION_DIR = "notor/orchestrations/sessions/sess-abc123";

/** A small valid session-log.jsonl with two turns and a code_error event. */
const SAMPLE_LOG = [
	{ type: "session.start", ts: "t0", session_id: "sess-abc123", flow: "Notor Usage Miner", prompt: "p", origin: "user", parent_session_id: null },
	{ type: "turn.complete", ts: "t1", turn: 1, step: "Enumerate", emitted_topic: "chunk.build", conversation_id: null, cost_usd: 0, token_usage: { input: 0, output: 0 } },
	{ type: "turn.complete", ts: "t2", turn: 2, step: "Summarize", emitted_topic: "chunk.summarized", conversation_id: "c2", cost_usd: 0.0123, token_usage: { input: 100, output: 50 } },
	{ type: "event.emitted", ts: "t3", turn: 7, topic: "rollup-build.code_error", payload: JSON.stringify({ step: "Rollup Build", error: "Cannot read properties of undefined (reading 'manifest')", stack: "TypeError: ...\n  at eval (rollup-build:3:21)" }), source_step: "Rollup Build" },
	{ type: "event.emitted", ts: "t4", turn: 7, topic: "FLOW_ERROR", payload: "Step failure channel 'rollup-build.code_error' had no handler.", source_step: "Rollup Build" },
]
	.map((e) => JSON.stringify(e))
	.join("\n") + "\n";

describe("failureReportPath / slugifyFlowName", () => {
	it("slugifies a flow display name", () => {
		expect(slugifyFlowName("Notor Usage Miner")).toBe("notor-usage-miner");
		expect(slugifyFlowName("  Code/Assist!! ")).toBe("code-assist");
		expect(slugifyFlowName("???")).toBe("flow");
	});

	it("builds the failures/ path under the notor dir", () => {
		expect(failureReportPath("notor", "Notor Usage Miner", "sess-abc123")).toBe(
			"notor/orchestrations/failures/notor-usage-miner-sess-abc123.md",
		);
		// Trailing slash on notor dir is normalized.
		expect(failureReportPath("vault/notor/", "Review", "s1")).toBe(
			"vault/notor/orchestrations/failures/review-s1.md",
		);
	});
});

describe("shouldWriteFailureReport (the toggle gate)", () => {
	it("writes only when the setting is on AND the run errored", () => {
		expect(shouldWriteFailureReport("error", true)).toBe(true);
	});
	it("never writes when the setting is off — even on error", () => {
		expect(shouldWriteFailureReport("error", false)).toBe(false);
	});
	it("never writes for a non-error terminal status — even with the setting on", () => {
		expect(shouldWriteFailureReport("completed", true)).toBe(false);
		expect(shouldWriteFailureReport("cancelled", true)).toBe(false);
	});
});

describe("writeFailureReport", () => {
	it("writes a report with the dedicated discriminator, reason, stack, and timeline", async () => {
		const fs = new FakeFs();
		const path = await writeFailureReport({
			notorDir: "notor",
			fs,
			meta: meta(),
			result: result(),
			logJsonl: SAMPLE_LOG,
			sessionDir: SESSION_DIR,
		});

		expect(path).toBe("notor/orchestrations/failures/notor-usage-miner-sess-abc123.md");
		const out = fs.files.get(path)!;
		expect(out).toBeTruthy();

		// Frontmatter — NOT a flow/step discriminator (so discovery ignores it).
		expect(out).toContain("notor-type: orchestration-failure-report");
		expect(out).not.toMatch(/notor-type: orchestration-(flow|step)\b/);
		expect(out).toContain('notor-session-id: "sess-abc123"');

		// Objective + failure reason.
		expect(out).toContain("Mine my last 90 days of Notor usage.");
		expect(out).toContain("had no handler");

		// Failing step + stack (parsed from the {step}.code_error payload).
		expect(out).toContain("Rollup Build");
		expect(out).toContain("TypeError:");
		expect(out).toContain("reading 'manifest'");

		// Timeline table includes prior turns and their cost.
		expect(out).toContain("| Turn | Step | Emitted | Cost (USD) |");
		expect(out).toContain("Summarize");
		expect(out).toContain("0.0123");

		// Raw-data pointers to the session files.
		expect(out).toContain(`${SESSION_DIR}/session.json`);
		expect(out).toContain(`${SESSION_DIR}/session-log.jsonl`);
	});

	it("tolerates a missing/unreadable log (no timeline, no throw)", async () => {
		const fs = new FakeFs();
		const path = await writeFailureReport({
			notorDir: "notor",
			fs,
			meta: meta(),
			result: result(),
			logJsonl: null,
			sessionDir: SESSION_DIR,
		});
		const out = fs.files.get(path)!;
		expect(out).toContain("notor-type: orchestration-failure-report");
		// Still records the terminal reason even with no log.
		expect(out).toContain("had no handler");
		expect(out).toMatch(/no turns recorded/i);
	});

	it("tolerates a torn/malformed log without throwing", async () => {
		const fs = new FakeFs();
		const torn = SAMPLE_LOG + "{ this is not valid json";
		const path = await writeFailureReport({
			notorDir: "notor",
			fs,
			meta: meta(),
			result: result(),
			logJsonl: torn,
			sessionDir: SESSION_DIR,
		});
		// A trailing partial line is tolerated by the reader → timeline still built.
		const out = fs.files.get(path)!;
		expect(out).toContain("Summarize");
	});
});
