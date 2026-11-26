import { describe, expect, it, vi } from "vitest";
import type { DataAdapter } from "obsidian";
import { capTrees, pruneFinishedCircuitSessions, selectSessionsToPrune, selectTreesToPrune, type SessionInfo } from "./session-retention";
import type { CircuitSessionMeta } from "./types";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-26T00:00:00Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function s(id: string, status: CircuitSessionMeta["status"], daysAgo: number, parent: string | null = null, logDaysAgo: number | null = null): SessionInfo {
	return {
		id,
		meta: { status, started_at: iso(daysAgo), parent_session_id: parent },
		logMtime: logDaysAgo === null ? null : NOW - logDaysAgo * DAY,
	};
}

describe("selectSessionsToPrune", () => {
	it("prunes finished trees older than the window, by newest activity", () => {
		const out = selectSessionsToPrune([
			s("old-done", "completed", 200),
			s("old-cancel", "cancelled", 120),
			s("old-error", "error", 95),
			s("recent", "completed", 10),
			s("old-start-recent-log", "completed", 200, null, 5), // log written 5 days ago
		], 90, NOW);
		expect([...out].sort()).toEqual(["old-cancel", "old-done", "old-error"]);
	});

	it("never prunes active or interrupted sessions, or anything in their tree", () => {
		const out = selectSessionsToPrune([
			s("root-a", "completed", 200),
			s("child-a", "interrupted", 199, "root-a"),
			s("root-b", "active", 300),
			s("child-b", "completed", 300, "root-b"),
		], 90, NOW);
		expect(out.size).toBe(0);
	});

	it("deletes a tree together only when every member qualifies", () => {
		const out = selectSessionsToPrune([
			s("root", "completed", 200),
			s("child", "completed", 199, "root"),
			s("grandchild", "error", 198, "child"),
			s("root2", "completed", 200),
			s("child2", "completed", 30, "root2"), // recent child keeps the whole tree
		], 90, NOW);
		expect([...out].sort()).toEqual(["child", "grandchild", "root"]);
	});

	it("treats a session whose parent no longer exists as its own root", () => {
		const out = selectSessionsToPrune([s("orphan-child", "completed", 200, "deleted-parent")], 90, NOW);
		expect([...out]).toEqual(["orphan-child"]);
	});

	it("keeps sessions with unreadable metadata, and keeps everything when retention is 0", () => {
		const unreadable: SessionInfo = { id: "broken", meta: null, logMtime: NOW - 400 * DAY };
		expect(selectSessionsToPrune([unreadable], 90, NOW).size).toBe(0);
		expect(selectSessionsToPrune([s("old", "completed", 500)], 0, NOW).size).toBe(0);
	});
});

describe("capTrees", () => {
	it("takes whole trees oldest first and never splits a tree", () => {
		const trees = selectTreesToPrune([
			s("a", "completed", 300), s("a1", "completed", 299, "a"), s("a2", "completed", 298, "a"),
			s("b", "completed", 200),
			s("c", "completed", 100),
		], 90, NOW);
		expect(trees.map((t) => t.ids.length)).toEqual([3, 1, 1]);
		expect(capTrees(trees, 4).flatMap((t) => t.ids).sort()).toEqual(["a", "a1", "a2", "b"]);
		expect(capTrees(trees, 2).flatMap((t) => t.ids).sort()).toEqual(["a", "a1", "a2"]); // oversized oldest tree still taken
	});
});

describe("pruneFinishedCircuitSessions", () => {
	const ROOT = "notor/orchestrations";
	const H = ".obsidian/plugins/notor/history";

	function fakeAdapter() {
		const files: Record<string, { content: string; mtime: number }> = {};
		const folders = new Set<string>([`${ROOT}/sessions`, H]);
		const removed: string[] = [];
		const addSession = (id: string, status: string, daysAgo: number) => {
			folders.add(`${ROOT}/sessions/${id}`);
			files[`${ROOT}/sessions/${id}/session.json`] = {
				content: JSON.stringify({ session_id: id, status, started_at: iso(daysAgo), parent_session_id: null }),
				mtime: NOW - daysAgo * DAY,
			};
			files[`${ROOT}/sessions/${id}/session-log.jsonl`] = { content: "{}\n", mtime: NOW - daysAgo * DAY };
		};
		const addStep = (convId: string, sessionId: string) => {
			files[`${H}/orchestration_step_${convId}.jsonl`] = {
				content: JSON.stringify({ _type: "orchestration_step_conversation", id: convId, orchestration_session_id: sessionId }) + "\n{}\n",
				mtime: NOW,
			};
		};
		const adapter = {
			exists: async (p: string) => folders.has(p) || p in files,
			list: async (dir: string) => ({
				files: Object.keys(files).filter((f) => f.slice(0, f.lastIndexOf("/")) === dir),
				folders: [...folders].filter((f) => f.slice(0, f.lastIndexOf("/")) === dir),
			}),
			read: async (p: string) => {
				if (!(p in files)) throw new Error(`ENOENT ${p}`);
				return files[p]!.content;
			},
			stat: async (p: string) => (p in files ? { mtime: files[p]!.mtime } : null),
			remove: async (p: string) => { removed.push(p); },
			rmdir: async (p: string) => { removed.push(`${p}/`); },
		};
		return { adapter: adapter as unknown as DataAdapter, addSession, addStep, files, removed };
	}

	it("removes old finished sessions with their step conversations and sub-agent runs", async () => {
		const fx = fakeAdapter();
		fx.addSession("sess-old", "completed", 200);
		fx.addSession("sess-new", "completed", 5);
		fx.addSession("sess-live", "active", 300);
		fx.addStep("step-old", "sess-old");
		fx.addStep("step-new", "sess-new");
		fx.files[`${H}/20260101_000000_step-old_subagent_x.jsonl`] = { content: "{}\n", mtime: NOW };
		fx.files[`${H}/20260101_000000_step-new_subagent_y.jsonl`] = { content: "{}\n", mtime: NOW };

		const result = await pruneFinishedCircuitSessions({
			adapter: fx.adapter, circuitRootPath: ROOT, historyPath: `${H}/`, retentionDays: 90, now: NOW,
		});

		expect(fx.removed.sort()).toEqual([
			`${H}/20260101_000000_step-old_subagent_x.jsonl`,
			`${H}/orchestration_step_step-old.jsonl`,
			`${ROOT}/sessions/sess-old/`,
		]);
		expect(result).toEqual({ sessions: 1, stepConversations: 1, subAgentConversations: 1, deferred: 0 });
	});

	it("deletes at most maxSessionsPerPass sessions, oldest first, pausing between batches", async () => {
		const fx = fakeAdapter();
		for (let i = 0; i < 7; i++) fx.addSession(`sess-${i}`, "completed", 100 + i * 10); // sess-6 is oldest
		const pause = vi.fn(async () => undefined);
		const result = await pruneFinishedCircuitSessions({
			adapter: fx.adapter, circuitRootPath: ROOT, historyPath: `${H}/`, retentionDays: 90, now: NOW,
			maxSessionsPerPass: 5, batchSize: 2, pause,
		});
		expect(fx.removed).toEqual(["sess-6", "sess-5", "sess-4", "sess-3", "sess-2"].map((id) => `${ROOT}/sessions/${id}/`));
		expect(result.sessions).toBe(5);
		expect(result.deferred).toBe(2);
		expect(pause).toHaveBeenCalledTimes(2); // batches of 2: [6,5] pause [4,3] pause [2]
	});

	it("does nothing when retention is 0", async () => {
		const fx = fakeAdapter();
		fx.addSession("sess-old", "completed", 500);
		await pruneFinishedCircuitSessions({ adapter: fx.adapter, circuitRootPath: ROOT, historyPath: `${H}/`, retentionDays: 0, now: NOW });
		expect(fx.removed).toEqual([]);
	});
});
