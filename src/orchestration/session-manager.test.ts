/**
 * INT-001 — `OrchestrationSessionManager` unit tests.
 *
 * Asserts session-workspace creation (dir + scratchpad/ + tasks/ + session.json
 * with status active / iteration 0 / origin always set), status finalization,
 * and the resolved scratchpad/tasks paths the engine threads into step turns.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-001
 * @see specs/ZZ-misc/orchestration/contracts/vault-schema.md — Directory Structure / session.json
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OrchestrationSessionManager, type SessionFs } from "./session-manager";
import type { OrchestrationSessionMeta } from "./types";

class FakeSessionFs implements SessionFs {
	files = new Map<string, string>();
	dirs = new Set<string>();
	async exists(p: string): Promise<boolean> {
		return this.files.has(p) || this.dirs.has(p);
	}
	async mkdir(p: string): Promise<void> {
		this.dirs.add(p);
	}
	async write(p: string, data: string): Promise<void> {
		this.files.set(p, data);
	}
	async read(p: string): Promise<string> {
		const v = this.files.get(p);
		if (v === undefined) throw new Error(`ENOENT: ${p}`);
		return v;
	}
}

let fs: FakeSessionFs;
let mgr: OrchestrationSessionManager;

beforeEach(() => {
	fs = new FakeSessionFs();
	mgr = new OrchestrationSessionManager("notor", fs);
});

describe("OrchestrationSessionManager", () => {
	it("resolves the well-known workspace paths under orchestrations/sessions", () => {
		const ws = mgr.resolveWorkspace("sess-abc");
		expect(ws.sessionDir).toBe("notor/orchestrations/sessions/sess-abc");
		expect(ws.scratchpadPath).toBe("notor/orchestrations/sessions/sess-abc/scratchpad");
		expect(ws.tasksPath).toBe("notor/orchestrations/sessions/sess-abc/tasks");
		expect(ws.metaPath).toBe("notor/orchestrations/sessions/sess-abc/session.json");
		expect(ws.logPath).toBe("notor/orchestrations/sessions/sess-abc/session-log.jsonl");
	});

	it("creates the session dir + scratchpad/ + tasks/ and writes session.json (status active, iteration 0)", async () => {
		const ws = await mgr.createSession({
			sessionId: "sess-1",
			flowName: "Code Implementation",
			prompt: "implement --verbose",
			origin: "user",
		});
		expect(fs.dirs.has(ws.sessionDir)).toBe(true);
		expect(fs.dirs.has(ws.scratchpadPath)).toBe(true);
		expect(fs.dirs.has(ws.tasksPath)).toBe(true);

		const meta = JSON.parse(fs.files.get(ws.metaPath)!) as OrchestrationSessionMeta;
		expect(meta.status).toBe("active");
		expect(meta.iteration).toBe(0);
		expect(meta.flow_name).toBe("Code Implementation");
		expect(meta.prompt).toBe("implement --verbose");
		expect(meta.active_step).toBeNull();
	});

	it("stamps origin at creation — never null (user / hook are roots with parent null)", async () => {
		const userWs = await mgr.createSession({ sessionId: "u", flowName: "F", prompt: "p", origin: "user" });
		const hookWs = await mgr.createSession({ sessionId: "h", flowName: "F", prompt: "p", origin: "hook" });
		const u = JSON.parse(fs.files.get(userWs.metaPath)!) as OrchestrationSessionMeta;
		const h = JSON.parse(fs.files.get(hookWs.metaPath)!) as OrchestrationSessionMeta;
		expect(u.origin).toBe("user");
		expect(u.parent_session_id).toBeNull();
		expect(h.origin).toBe("hook");
		expect(h.parent_session_id).toBeNull();
	});

	it("records parent_session_id for a composition child origin", async () => {
		const ws = await mgr.createSession({
			sessionId: "child",
			flowName: "F",
			prompt: "p",
			origin: "run_flow",
			parentSessionId: "parent-1",
		});
		const meta = JSON.parse(fs.files.get(ws.metaPath)!) as OrchestrationSessionMeta;
		expect(meta.origin).toBe("run_flow");
		expect(meta.parent_session_id).toBe("parent-1");
	});

	it("updateStatus patches status (and iteration) while preserving every other field", async () => {
		await mgr.createSession({ sessionId: "s", flowName: "F", prompt: "obj", origin: "user" });
		await mgr.updateStatus("s", "completed", { iteration: 7 });
		const meta = await mgr.readMeta("s");
		expect(meta.status).toBe("completed");
		expect(meta.iteration).toBe(7);
		expect(meta.prompt).toBe("obj"); // preserved
		expect(meta.origin).toBe("user"); // preserved
	});
});
