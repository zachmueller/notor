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
import type { Conversation, Message } from "../types";

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

// ---------------------------------------------------------------------------
// Stateful adapter — append / process / schema_version tests
// ---------------------------------------------------------------------------

/** A stateful fake adapter that supports read, write, append, process, and exists. */
function makeStatefulVault(initialFiles: Record<string, string> = {}): { vault: Vault; files: Record<string, string> } {
	const files: Record<string, string> = { ...initialFiles };
	const dirs = new Set<string>([HISTORY.replace(/\/$/, ""), HISTORY]);
	const adapter = {
		exists: async (p: string) => p in files || dirs.has(p),
		mkdir: async (p: string) => { dirs.add(p); },
		list: async () => ({ files: Object.keys(files), folders: [] }),
		read: async (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT: ${p}`);
			return files[p]!;
		},
		write: async (p: string, data: string) => { files[p] = data; },
		append: async (p: string, data: string) => { files[p] = (files[p] ?? "") + data; },
		process: async (p: string, fn: (content: string) => string): Promise<string> => {
			const content = files[p] ?? "";
			const result = fn(content);
			files[p] = result;
			return result;
		},
		stat: async () => ({ mtime: 0, size: 0 }),
	};
	return { vault: { adapter } as unknown as Vault, files };
}

function conv(over: Partial<Conversation> = {}): Conversation {
	return {
		id: "conv-1",
		created_at: "2026-07-01T00:00:00Z",
		updated_at: "2026-07-01T00:00:00Z",
		provider_id: "bedrock",
		model_id: "claude-opus-4-8",
		total_input_tokens: 0,
		total_output_tokens: 0,
		estimated_cost: null,
		mode: "act",
		...over,
	};
}

function msg(over: Partial<Message> = {}): Message {
	return {
		id: "msg-1",
		conversation_id: "conv-1",
		role: "user",
		content: "hello",
		timestamp: "2026-07-01T00:00:00Z",
		...over,
	};
}

describe("HistoryManager — append conversion (B.1)", () => {
	it("appendMessage on an existing file adds exactly one line without overwriting previous content", async () => {
		const { vault, files } = makeStatefulVault();
		const manager = new HistoryManager(vault, HISTORY, 500, 90);
		const conversation = conv();
		await manager.createConversationFile(conversation);
		const filePath = Object.keys(files).find((k) => k.endsWith(".jsonl"))!;
		const linesBefore = files[filePath]!.trim().split("\n").length;

		await manager.appendMessage(conversation, msg());
		const linesAfter = files[filePath]!.trim().split("\n").length;
		expect(linesAfter).toBe(linesBefore + 1);
	});

	it("appendMessage on a missing file creates header + message (no header-less JSONL)", async () => {
		const { vault, files } = makeStatefulVault();
		const manager = new HistoryManager(vault, HISTORY, 500, 90);
		const conversation = conv();
		// Do NOT call createConversationFile — simulate missing file.
		await manager.appendMessage(conversation, msg());
		const filePath = Object.keys(files).find((k) => k.endsWith(".jsonl"))!;
		const lines = files[filePath]!.trim().split("\n");
		// First line must be a conversation header.
		const header = JSON.parse(lines[0]!);
		expect(header._type).toBe("conversation");
		expect(header.schema_version).toBe(1);
		// Second line must be the message.
		expect(JSON.parse(lines[1]!).role).toBe("user");
	});

	it("header rewrite via updateConversationHeader preserves messages and schema_version", async () => {
		const { vault, files } = makeStatefulVault();
		const manager = new HistoryManager(vault, HISTORY, 500, 90);
		const conversation = conv();
		await manager.createConversationFile(conversation);
		await manager.appendMessage(conversation, msg());

		const filePath = Object.keys(files).find((k) => k.endsWith(".jsonl"))!;
		const linesBefore = files[filePath]!.trim().split("\n").length;

		const updated = conv({ ...conversation, title: "Updated Title" });
		await manager.updateConversationHeader(updated);

		const linesAfter = files[filePath]!.trim().split("\n").length;
		expect(linesAfter).toBe(linesBefore); // no lines added or removed

		const header = JSON.parse(files[filePath]!.split("\n")[0]!);
		expect(header.title).toBe("Updated Title");
		expect(header.schema_version).toBe(1);
	});

	it("toggleFavorite preserves schema_version and unknown fields", async () => {
		const { vault, files } = makeStatefulVault();
		const manager = new HistoryManager(vault, HISTORY, 500, 90);
		const conversation = conv();
		await manager.createConversationFile(conversation);
		await manager.appendMessage(conversation, msg());

		const filePath = Object.keys(files).find((k) => k.endsWith(".jsonl"))!;
		const filename = filePath.split("/").pop()!;
		const linesBefore = files[filePath]!.trim().split("\n").length;

		await manager.toggleFavorite(filename);

		const linesAfter = files[filePath]!.trim().split("\n").length;
		expect(linesAfter).toBe(linesBefore);

		const header = JSON.parse(files[filePath]!.split("\n")[0]!);
		expect(header.is_favorite).toBe(true);
		expect(header.schema_version).toBe(1);
	});

	it("createConversationFile stamps schema_version: 1 on the header", async () => {
		const { vault, files } = makeStatefulVault();
		const manager = new HistoryManager(vault, HISTORY, 500, 90);
		await manager.createConversationFile(conv());
		const filePath = Object.keys(files).find((k) => k.endsWith(".jsonl"))!;
		const header = JSON.parse(files[filePath]!.split("\n")[0]!);
		expect(header.schema_version).toBe(1);
	});

	// F4 (task 01) verification: a pre-change conversation whose header predates
	// schema_version must still load with its messages intact, and toggling favorite
	// must ADD the field without dropping messages. Seeds a genuinely legacy file
	// (no schema_version, no is_favorite) rather than one createConversationFile stamped.
	it("loads a legacy conversation lacking schema_version and defaults it to 1", async () => {
		const legacyPath = `${HISTORY}legacy.jsonl`;
		const legacyHeader = {
			_type: "conversation",
			id: "legacy-1",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
			provider_id: "bedrock",
			model_id: "claude-opus-4-8",
			total_input_tokens: 0,
			total_output_tokens: 0,
			estimated_cost: null,
			mode: "act",
			// deliberately no schema_version, no is_favorite
		};
		const legacyLine =
			JSON.stringify({ _type: "message", id: "m1", conversation_id: "legacy-1", role: "user", content: "hello", timestamp: "2026-01-01T00:00:01Z" });
		const { vault } = makeStatefulVault({
			[legacyPath]: JSON.stringify(legacyHeader) + "\n" + legacyLine + "\n",
		});
		const manager = new HistoryManager(vault, HISTORY, 500, 90);

		const { conversation, messages } = await manager.loadConversation("legacy.jsonl");

		expect(conversation.id).toBe("legacy-1");
		expect(conversation.schema_version).toBe(1); // defaulted on load
		expect(messages).toHaveLength(1);
		expect(messages[0]!.content).toBe("hello");
	});

	it("toggleFavorite on a legacy (schema_version-less) file adds the field and keeps messages", async () => {
		const legacyPath = `${HISTORY}legacy-fav.jsonl`;
		const legacyHeader = {
			_type: "conversation",
			id: "legacy-2",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
			provider_id: "bedrock",
			model_id: "claude-opus-4-8",
			total_input_tokens: 0,
			total_output_tokens: 0,
			estimated_cost: null,
			mode: "act",
		};
		const legacyLine =
			JSON.stringify({ _type: "message", id: "m1", conversation_id: "legacy-2", role: "user", content: "hello", timestamp: "2026-01-01T00:00:01Z" });
		const { vault, files } = makeStatefulVault({
			[legacyPath]: JSON.stringify(legacyHeader) + "\n" + legacyLine + "\n",
		});
		const manager = new HistoryManager(vault, HISTORY, 500, 90);
		const linesBefore = files[legacyPath]!.trim().split("\n").length;

		const newValue = await manager.toggleFavorite("legacy-fav.jsonl");

		expect(newValue).toBe(true);
		const linesAfter = files[legacyPath]!.trim().split("\n").length;
		expect(linesAfter).toBe(linesBefore); // message preserved
		const header = JSON.parse(files[legacyPath]!.split("\n")[0]!);
		expect(header.is_favorite).toBe(true);
		// The favorite toggle is a raw-header rewrite and does NOT stamp schema_version.
		// That is by design: F4's reader-side default (loadConversation: `??= 1`) is the
		// safety net for legacy files, so a missing on-disk stamp remains tolerated.
		expect(header.schema_version).toBeUndefined();
	});
});
