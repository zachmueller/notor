/**
 * F6 §5.4 — `recoverOrchestrations` scan decisions (INT-005 / FR-125).
 *
 * Drives the load-time recovery scan over a `FakeRecoveryFs` + a stubbed host and
 * injected seams (no runner, no DOM), locking the branch logic the review flagged:
 *  - a recoverable root → **offer resume** (with its rebuilt budget + committedKeys);
 *  - a loud recovery error → the session is marked `error` (never silently skipped);
 *  - a still-`active` root whose log looks **live** → **skipped** (no second runner);
 *  - a recoverable root whose flow is no longer discoverable → Notice, no offer.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F6-launch-ts-decomposition.md — §5.4
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { recoverOrchestrations } from "./recovery-boot";
import type { RecoveryFs } from "./session-recovery";
import type { OrchestrationHost } from "./host";
import { FLOW_COMPLETE, type OrchestrationFlow, type OrchestrationSessionMeta } from "./types";

// Capture Notice messages so the error/undiscoverable paths can be asserted.
const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return {
		...actual,
		Notice: class {
			constructor(message: string | DocumentFragment) {
				notices.push(typeof message === "string" ? message : "[fragment]");
			}
			hide(): void {}
		},
	};
});

beforeEach(() => {
	notices.length = 0;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TS = "2026-06-28T00:00:00.000Z";

function flow(over: Partial<OrchestrationFlow> = {}): OrchestrationFlow {
	return {
		name: "F",
		description: "",
		flowDir: "d",
		startingEvent: "start",
		completionEvent: FLOW_COMPLETE,
		maxIterations: 100,
		maxRuntimeMinutes: 60,
		requiredEvents: [],
		fanoutTopics: [],
		steps: [],
		guardrails: [],
		schedule: null,
		invocable: false,
		flowInputs: null,
		flowReturns: null,
		onCompleteFlow: null,
		handoffIsolation: "isolated",
		maxDepth: null,
		maxCostUsd: 5,
		openNotesInEditor: null,
		allowConcurrent: false,
		...over,
	};
}

function meta(over: Partial<OrchestrationSessionMeta> = {}): OrchestrationSessionMeta {
	return {
		session_id: "s",
		flow_name: "F",
		status: "interrupted",
		iteration: 2,
		active_step: "A",
		started_at: TS,
		prompt: "obj",
		parent_session_id: null,
		origin: "user",
		schema_version: 1,
		...over,
	};
}

/** An interrupted-tail log: a dangling turn.start re-emits its trigger on resume. */
function danglingLog(sessionId: string, flowName: string): string {
	return (
		[
			{ type: "session.start", session_id: sessionId, flow: flowName, prompt: "obj", origin: "user", parent_session_id: null, ts: TS },
			{ type: "event.emitted", turn: 1, topic: "start", payload: "obj", source_step: null, ts: TS },
			{ type: "turn.start", turn: 2, step: "A", trigger_topic: "start", conversation_id: "c", ts: TS },
		]
			.map((e) => JSON.stringify(e))
			.join("\n") + "\n"
	);
}

/** A fake recovery fs holding session.json + log per session. */
class FakeRecoveryFs implements RecoveryFs {
	constructor(private readonly sessions: Record<string, { meta?: OrchestrationSessionMeta; log?: string }>) {}
	async listSessions(): Promise<string[]> {
		return Object.keys(this.sessions);
	}
	async readMeta(sessionId: string): Promise<string | null> {
		const m = this.sessions[sessionId]?.meta;
		return m ? JSON.stringify(m) : null;
	}
	async readLog(sessionId: string): Promise<string | null> {
		return this.sessions[sessionId]?.log ?? null;
	}
}

/**
 * A host backed by an in-memory vault adapter, so the one host-touching path in
 * the scan — `sessionManager.updateStatus(...)` marking an error session — can
 * read+write its session.json. Seeds each session's meta at its well-known path.
 */
function fakeHost(sessions: Record<string, { meta?: OrchestrationSessionMeta }>): {
	host: OrchestrationHost;
	files: Map<string, string>;
} {
	const files = new Map<string, string>();
	for (const [id, s] of Object.entries(sessions)) {
		if (s.meta) files.set(`notor/orchestrations/sessions/${id}/session.json`, JSON.stringify(s.meta));
	}
	const adapter = {
		exists: async (p: string) => files.has(p),
		read: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`ENOENT ${p}`);
			return v;
		},
		write: async (p: string, data: string) => {
			files.set(p, data);
		},
		remove: async (p: string) => {
			files.delete(p);
		},
		rename: async (from: string, to: string) => {
			files.set(to, files.get(from) ?? "");
			files.delete(from);
		},
		mkdir: async () => {},
		list: async () => ({ files: [], folders: [] }),
		stat: async () => null,
	};
	const host = {
		app: { vault: { adapter } },
		settings: { notor_dir: "notor" },
	} as unknown as OrchestrationHost;
	return { host, files };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("recoverOrchestrations — scan decisions (F6 §5.4)", () => {
	it("offers resume for a recoverable interrupted root", async () => {
		const sessions = { s1: { meta: meta({ session_id: "s1" }), log: danglingLog("s1", "F") } };
		const { host } = fakeHost(sessions);
		const offerResume = vi.fn();
		await recoverOrchestrations(host, undefined, {
			recoveryFs: new FakeRecoveryFs(sessions),
			resolveFlows: async () => new Map([["F", flow()]]),
			isLive: async () => false,
			offerResume,
		});
		expect(offerResume).toHaveBeenCalledTimes(1);
		const [f, recovered] = offerResume.mock.calls[0]!;
		expect(f.name).toBe("F");
		expect(recovered.sessionId).toBe("s1");
		// The rebuilt runtime state the resume consumes.
		expect(recovered.budget).toBeDefined();
		expect(recovered.committedKeys).toBeInstanceOf(Set);
	});

	it("marks a loud recovery error session `error` and never offers it", async () => {
		// Missing session.json → a scan error, not a recoverable root.
		const sessions = { bad: { log: danglingLog("bad", "F") } };
		const { host, files } = fakeHost({ bad: { meta: meta({ session_id: "bad" }) } });
		const offerResume = vi.fn();
		await recoverOrchestrations(host, undefined, {
			recoveryFs: new FakeRecoveryFs(sessions),
			resolveFlows: async () => new Map([["F", flow()]]),
			isLive: async () => false,
			offerResume,
		});
		expect(offerResume).not.toHaveBeenCalled();
		expect(notices.some((m) => m.includes("recovery error"))).toBe(true);
		// The session.json seeded on the host was flipped to status "error".
		const written = JSON.parse(files.get("notor/orchestrations/sessions/bad/session.json")!) as OrchestrationSessionMeta;
		expect(written.status).toBe("error");
	});

	it("skips a still-active root whose log looks live (no second runner)", async () => {
		const sessions = { live: { meta: meta({ session_id: "live", status: "active" }), log: danglingLog("live", "F") } };
		const { host } = fakeHost(sessions);
		const offerResume = vi.fn();
		await recoverOrchestrations(host, undefined, {
			recoveryFs: new FakeRecoveryFs(sessions),
			resolveFlows: async () => new Map([["F", flow()]]),
			isLive: async () => true, // log mtime is fresh → live
			offerResume,
		});
		expect(offerResume).not.toHaveBeenCalled();
	});

	it("offers resume for a still-active root whose log is NOT live", async () => {
		const sessions = { stale: { meta: meta({ session_id: "stale", status: "active" }), log: danglingLog("stale", "F") } };
		const { host } = fakeHost(sessions);
		const offerResume = vi.fn();
		await recoverOrchestrations(host, undefined, {
			recoveryFs: new FakeRecoveryFs(sessions),
			resolveFlows: async () => new Map([["F", flow()]]),
			isLive: async () => false,
			offerResume,
		});
		expect(offerResume).toHaveBeenCalledTimes(1);
	});

	it("does not offer resume when the recovered flow is no longer discoverable", async () => {
		const sessions = { s1: { meta: meta({ session_id: "s1", flow_name: "Gone" }), log: danglingLog("s1", "Gone") } };
		const { host } = fakeHost(sessions);
		const offerResume = vi.fn();
		await recoverOrchestrations(host, undefined, {
			recoveryFs: new FakeRecoveryFs(sessions),
			resolveFlows: async () => new Map(), // flow not discoverable
			isLive: async () => false,
			offerResume,
		});
		expect(offerResume).not.toHaveBeenCalled();
		expect(notices.some((m) => m.includes("its flow definition is missing"))).toBe(true);
	});
});
