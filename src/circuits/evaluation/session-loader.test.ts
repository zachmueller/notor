import { describe, it, expect } from "vitest";
import { CircuitSessionManager, type SessionFs } from "../session-manager";
import { loadFinishedSession } from "./session-loader";

class FakeFs implements SessionFs {
	files = new Map<string, string>();
	async exists(p: string) {
		return this.files.has(p);
	}
	async mkdir() {}
	async write(p: string, data: string) {
		this.files.set(p, data);
	}
	async read(p: string) {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT: ${p}`);
		return v;
	}
}

const TS = "2026-10-18T00:00:00.000Z";
function meta(status: string) {
	return JSON.stringify({ session_id: "s1", flow_name: "Demo", status, iteration: 1, active_step: null, started_at: TS, prompt: "obj", parent_session_id: null, origin: "user" });
}
function jsonl(entries: unknown[]) {
	return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("loadFinishedSession", () => {
	const dir = "notor/circuits/sessions/s1";

	it("loads meta, entries, and the run.result outcome of a finished session", async () => {
		const fs = new FakeFs();
		fs.files.set(`${dir}/session.json`, meta("completed"));
		fs.files.set(
			`${dir}/session-log.jsonl`,
			jsonl([
				{ type: "session.complete", ts: TS },
				{ type: "run.result", ts: TS, status: "completed", terminal_topic: "FLOW_COMPLETE", text: "done", structured: { a: 1 }, cost_usd: 0.2, token_usage: { input: 1, output: 1 }, iterations: 2 },
			]),
		);
		const result = await loadFinishedSession(fs, new CircuitSessionManager("notor", fs, "circuits"), "s1");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.session.meta.status).toBe("completed");
			expect(result.session.outcome).toMatchObject({ structured: { a: 1 }, source: "run.result" });
			expect(result.session.workspace.sessionDir).toBe(dir);
			expect(result.session.entries).toHaveLength(2);
		}
	});

	it("refuses an unfinished session and an unreadable session.json", async () => {
		const fs = new FakeFs();
		fs.files.set(`${dir}/session.json`, meta("active"));
		expect(await loadFinishedSession(fs, new CircuitSessionManager("notor", fs, "circuits"), "s1")).toEqual({ ok: false, reason: "session is active, not finished" });
		expect(await loadFinishedSession(fs, new CircuitSessionManager("notor", fs, "circuits"), "missing")).toMatchObject({ ok: false, reason: expect.stringMatching(/session.json unreadable/) });
	});

	it("falls back to session.json when the log is missing or torn", async () => {
		const fs = new FakeFs();
		fs.files.set(`${dir}/session.json`, meta("error"));
		const result = await loadFinishedSession(fs, new CircuitSessionManager("notor", fs, "circuits"), "s1");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.session.outcome).toMatchObject({ status: "error", terminalTopic: "FLOW_ERROR", source: "fallback" });
	});
});
