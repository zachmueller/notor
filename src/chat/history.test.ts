/**
 * INT-006 (Phase-2 gate) — `HistoryManager` hidden-from-flat-list behavior.
 *
 * The Phase-2 gate AC ("a `history` test confirms step conversations are hidden
 * from the flat list") exercised at the **history-list surface**:
 * `listConversations()` and `searchConversations()` exclude orchestration step
 * conversations (header `_type: "orchestration_step_conversation"`) AND sub-agent
 * conversations, while ordinary conversations still appear.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-2-session-nav.md — INT-006 / Phase-2 gate
 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §4 Hidden-From-Flat-List Rule
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { Vault } from "obsidian";
import { HistoryManager } from "./history";

const HISTORY = ".obsidian/plugins/notor/history/";

/** A fake Vault whose adapter serves a fixed set of JSONL history files. */
function makeVault(files: Record<string, string>): Vault {
	const paths = Object.keys(files);
	const adapter = {
		exists: async (p: string) => p === HISTORY.replace(/\/$/, "") || p === HISTORY || p in files,
		mkdir: async () => undefined,
		list: async () => ({ files: paths, folders: [] }),
		read: async (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p]!;
		},
		write: async () => undefined,
		stat: async () => ({ mtime: 0, size: 0 }),
	};
	return { adapter } as unknown as Vault;
}

/** Build a one-line-header + one-user-message JSONL file. */
function convFile(header: Record<string, unknown>, userText = "hello"): string {
	const h = JSON.stringify(header);
	const msg = JSON.stringify({ _type: "message", role: "user", content: userText, timestamp: "t" });
	return `${h}\n${msg}\n`;
}

const NORMAL = convFile({
	_type: "conversation",
	id: "normal-1",
	created_at: "2026-06-28T00:00:00Z",
	updated_at: "2026-06-28T00:01:00Z",
	provider_id: "bedrock",
	model_id: "m",
	title: "A normal chat",
}, "find me please");

const STEP = convFile({
	_type: "orchestration_step_conversation",
	id: "step-1",
	created_at: "2026-06-28T00:00:00Z",
	updated_at: "2026-06-28T00:02:00Z",
	provider_id: "bedrock",
	model_id: "m",
	title: "[Single Flow E2E] Planner — iteration 1",
	orchestration_session_id: "sess-A",
	orchestration_edges: [],
}, "find me please");

const SUBAGENT = convFile({
	_type: "sub_agent_conversation",
	id: "sub-1",
	created_at: "2026-06-28T00:00:00Z",
	updated_at: "2026-06-28T00:03:00Z",
	provider_id: "bedrock",
	model_id: "m",
	title: "sub-agent run",
}, "find me please");

let hm: HistoryManager;

beforeEach(() => {
	const vault = makeVault({
		[`${HISTORY}2026_conversation_normal.jsonl`]: NORMAL,
		[`${HISTORY}orchestration_step_step-1.jsonl`]: STEP,
		[`${HISTORY}2026_subagent_sub-1.jsonl`]: SUBAGENT,
	});
	hm = new HistoryManager(vault, HISTORY, 500, 90);
});

describe("HistoryManager.listConversations — hidden-from-flat-list (INT-006)", () => {
	it("excludes orchestration step conversations and sub-agent conversations", async () => {
		const entries = await hm.listConversations();
		const ids = entries.map((e) => e.id);
		expect(ids).toContain("normal-1");
		expect(ids).not.toContain("step-1"); // orchestration step conversation hidden
		expect(ids).not.toContain("sub-1"); // sub-agent conversation hidden
	});

	it("still returns the ordinary conversation (no regression)", async () => {
		const entries = await hm.listConversations();
		expect(entries).toHaveLength(1);
		expect(entries[0]!.title).toBe("A normal chat");
	});
});

describe("HistoryManager.searchConversations — hidden-from-flat-list (INT-006)", () => {
	it("excludes step + sub-agent conversations even when their content matches the query", async () => {
		// All three files contain "find me please"; only the normal one may surface.
		const results = await hm.searchConversations("find me please");
		const ids = results.map((e) => e.id);
		expect(ids).toEqual(["normal-1"]);
	});

	it("empty query delegates to listConversations (also filtered)", async () => {
		const results = await hm.searchConversations("   ");
		expect(results.map((e) => e.id)).toEqual(["normal-1"]);
	});
});
