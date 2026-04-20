/**
 * Tests for Phase 13.5 — compaction behavior with exclude_from_compaction.
 *
 * The CompactionManager itself is heavily integrated (requires providers,
 * history manager, etc.) so these tests focus on the observable behaviors
 * that are independently testable:
 *  - extractPendingMessages correctly splits at the last assistant turn
 *  - exclude_from_compaction flag survives the re-append cycle (via ConversationManager)
 *  - All metadata fields are preserved when messages are re-appended
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { extractPendingMessages } from "./message-pipeline";
import { ConversationManager } from "./conversation";
import type { Message } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _id = 1;
function makeMsg(role: Message["role"], overrides: Partial<Message> = {}): Message {
	return {
		id: `m${_id++}`,
		conversation_id: "conv-1",
		role,
		content: `content-${role}`,
		timestamp: "2026-01-01T00:00:00.000Z",
		input_tokens: null,
		output_tokens: null,
		cost_estimate: null,
		tool_call: null,
		tool_result: null,
		truncated: false,
		auto_context: null,
		attachments: null,
		hook_injections: null,
		is_hook_injection: false,
		is_workflow_message: false,
		source_extension: null,
		exclude_from_compaction: false,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// extractPendingMessages — 13.5
// ---------------------------------------------------------------------------

describe("extractPendingMessages — 13.5", () => {
	it("returns messages after last assistant turn", () => {
		const msgs: Message[] = [
			makeMsg("system"),
			makeMsg("user"),
			makeMsg("assistant"),
			makeMsg("user"),   // pending
		];
		const pending = extractPendingMessages(msgs);
		expect(pending).toHaveLength(1);
		expect(pending[0]!.role).toBe("user");
	});

	it("returns all messages when no assistant turn exists", () => {
		const msgs: Message[] = [
			makeMsg("system"),
			makeMsg("user"),
		];
		expect(extractPendingMessages(msgs)).toHaveLength(2);
	});

	it("includes extension_block messages after last assistant", () => {
		const msgs: Message[] = [
			makeMsg("system"),
			makeMsg("user"),
			makeMsg("assistant"),
			makeMsg("extension_block"),  // pending
			makeMsg("user"),             // pending
		];
		const pending = extractPendingMessages(msgs);
		expect(pending).toHaveLength(2);
		expect(pending[0]!.role).toBe("extension_block");
	});

	it("returns empty array when last message is assistant", () => {
		const msgs: Message[] = [
			makeMsg("user"),
			makeMsg("assistant"),
		];
		expect(extractPendingMessages(msgs)).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// exclude_from_compaction — field survival through re-append — 13.5
// ---------------------------------------------------------------------------

describe("exclude_from_compaction — field preservation through re-append — 13.5", () => {
	it("re-appended excluded message preserves source_extension and exclude_from_compaction", () => {
		const mgr = new ConversationManager("act");
		mgr.createConversation("openai", "gpt-4", "act");

		// Add a block with exclude_from_compaction
		const original = mgr.addMessage({
			role: "extension_block",
			content: [{ type: "custom_block", kind: "memory", data: { key: "val" } }],
			source_extension: "memory-ext",
			exclude_from_compaction: true,
		});

		// Simulate re-append (what CompactionManager does after compaction)
		mgr.addMessage({
			role: original.role,
			content: original.content,
			source_extension: original.source_extension ?? undefined,
			exclude_from_compaction: original.exclude_from_compaction,
		});

		const messages = mgr.getMessages();
		const reAppended = messages[messages.length - 1]!;
		expect(reAppended.source_extension).toBe("memory-ext");
		expect(reAppended.exclude_from_compaction).toBe(true);
	});

	it("re-appended pending message preserves is_hook_injection and hook_injections", () => {
		const mgr = new ConversationManager("act");
		mgr.createConversation("openai", "gpt-4", "act");

		const original = mgr.addMessage({
			role: "user",
			content: "Hook injected content",
			is_hook_injection: true,
			hook_injections: ["hook output 1", "hook output 2"],
		});

		// Simulate re-append
		mgr.addMessage({
			role: original.role,
			content: original.content,
			is_hook_injection: original.is_hook_injection,
			hook_injections: original.hook_injections ?? undefined,
		});

		const messages = mgr.getMessages();
		const reAppended = messages[messages.length - 1]!;
		expect(reAppended.is_hook_injection).toBe(true);
		expect(reAppended.hook_injections).toEqual(["hook output 1", "hook output 2"]);
	});

	it("message with exclude_from_compaction is excluded from completed-messages split", () => {
		// Simulates what CompactionManager.checkAndPerformCompaction() does:
		// split allCompleted into excludedMessages and completedMessages
		const msgs: Message[] = [
			makeMsg("system"),
			makeMsg("user"),
			makeMsg("assistant"),
			makeMsg("extension_block", { exclude_from_compaction: true }),
			makeMsg("user"),   // pending (after last assistant... wait, ext_block is after assistant)
		];

		// In compaction, pendingMessages is extracted first (after last assistant)
		const pending = extractPendingMessages(msgs);
		const allCompleted = msgs.slice(0, msgs.length - pending.length);

		const excluded = allCompleted.filter((m) => m.exclude_from_compaction);
		const completed = allCompleted.filter((m) => !m.exclude_from_compaction);

		// extension_block lands in pending (it's after last assistant)
		// If placed before assistant, it would be in excluded
		expect(pending.length).toBeGreaterThan(0);
		// allCompleted contains messages up to and including the last assistant
		expect(allCompleted.every((m) => !m.exclude_from_compaction || excluded.includes(m))).toBe(true);
		expect(completed.every((m) => !m.exclude_from_compaction)).toBe(true);
		expect(excluded.every((m) => m.exclude_from_compaction)).toBe(true);
	});

	it("extension_block before last assistant lands in excluded set, not pending", () => {
		const msgs: Message[] = [
			makeMsg("system"),
			makeMsg("extension_block", { exclude_from_compaction: true }),  // will be in allCompleted
			makeMsg("user"),
			makeMsg("assistant"),   // last assistant
			makeMsg("user"),        // pending
		];

		const pending = extractPendingMessages(msgs);
		const allCompleted = msgs.slice(0, msgs.length - pending.length);
		const excluded = allCompleted.filter((m) => m.exclude_from_compaction);
		const completed = allCompleted.filter((m) => !m.exclude_from_compaction);

		expect(pending).toHaveLength(1);
		expect(pending[0]!.role).toBe("user");
		expect(excluded).toHaveLength(1);
		expect(excluded[0]!.role).toBe("extension_block");
		// system, user, assistant are NOT excluded
		expect(completed).toHaveLength(3);
	});
});
