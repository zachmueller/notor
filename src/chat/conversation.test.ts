import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { ConversationManager } from "./conversation";
import type { Message, ToolResult } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** UUID v4 regex for validation. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createManager(): ConversationManager {
	return new ConversationManager("act");
}

/**
 * Set up a manager with an active conversation and a standard message sequence:
 *   [0] system
 *   [1] user        (input_tokens: 10, cost_estimate: 0.01)
 *   [2] assistant   (output_tokens: 20, cost_estimate: 0.02)
 *   [3] user        (input_tokens: 15, cost_estimate: 0.015)
 *   [4] assistant   (output_tokens: 25, cost_estimate: 0.025)
 */
function setupStandardConversation(mgr: ConversationManager) {
	mgr.createConversation("openai", "gpt-4", "act");

	const sys = mgr.addMessage({ role: "system", content: "You are helpful." });
	const u1 = mgr.addMessage({ role: "user", content: "Hello", input_tokens: 10, cost_estimate: 0.01 });
	const a1 = mgr.addMessage({ role: "assistant", content: "Hi there!", output_tokens: 20, cost_estimate: 0.02 });
	const u2 = mgr.addMessage({ role: "user", content: "Tell me a joke", input_tokens: 15, cost_estimate: 0.015 });
	const a2 = mgr.addMessage({ role: "assistant", content: "Why did the chicken…", output_tokens: 25, cost_estimate: 0.025 });

	return { sys, u1, a1, u2, a2 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationManager.prepareFork()", () => {
	let mgr: ConversationManager;

	beforeEach(() => {
		mgr = createManager();
	});

	// -----------------------------------------------------------------------
	// 6.2 Basic slicing
	// -----------------------------------------------------------------------

	describe("basic slicing", () => {
		it("fork at first message — fork contains exactly 1 message", () => {
			const { sys } = setupStandardConversation(mgr);

			const fork = mgr.prepareFork(sys.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.messages).toHaveLength(1);
			expect(fork!.messages[0]!.content).toBe("You are helpful.");
		});

		it("fork at middle message — fork contains messages 0..N inclusive", () => {
			const { a1 } = setupStandardConversation(mgr);

			const fork = mgr.prepareFork(a1.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.messages).toHaveLength(3); // sys, u1, a1
			expect(fork!.messages[2]!.content).toBe("Hi there!");
		});

		it("fork at last message — fork contains all messages", () => {
			const { a2 } = setupStandardConversation(mgr);

			const fork = mgr.prepareFork(a2.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.messages).toHaveLength(5);
		});
	});

	// -----------------------------------------------------------------------
	// 6.3 ID reassignment
	// -----------------------------------------------------------------------

	describe("ID reassignment", () => {
		it("all message IDs in fork are fresh UUIDs, none match originals", () => {
			const { a2 } = setupStandardConversation(mgr);
			const origIds = mgr.getMessages().map((m) => m.id);

			const fork = mgr.prepareFork(a2.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();

			for (const msg of fork!.messages) {
				expect(msg.id).toMatch(UUID_RE);
				expect(origIds).not.toContain(msg.id);
			}
		});

		it("conversation_id on every message matches the new conversation's ID", () => {
			const { a1 } = setupStandardConversation(mgr);

			const fork = mgr.prepareFork(a1.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();

			for (const msg of fork!.messages) {
				expect(msg.conversation_id).toBe(fork!.conversation.id);
			}
		});

		it("new conversation ID is a fresh UUID, different from parent", () => {
			const { a1 } = setupStandardConversation(mgr);
			const parentId = mgr.getActiveConversation()!.id;

			const fork = mgr.prepareFork(a1.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.conversation.id).toMatch(UUID_RE);
			expect(fork!.conversation.id).not.toBe(parentId);
		});
	});

	// -----------------------------------------------------------------------
	// 6.4 Metadata
	// -----------------------------------------------------------------------

	describe("metadata", () => {
		it("forked_from_conversation_id matches parent conversation ID", () => {
			const { u1 } = setupStandardConversation(mgr);
			const parentId = mgr.getActiveConversation()!.id;

			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork!.conversation.forked_from_conversation_id).toBe(parentId);
		});

		it("forked_from_message_id matches the fork-point message's original ID", () => {
			const { u1 } = setupStandardConversation(mgr);

			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork!.conversation.forked_from_message_id).toBe(u1.id);
		});

		it("created_at is set to 'now' (not copied from parent)", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			// Manually override created_at to a past date so we can verify it's not copied
			const parent = mgr.getActiveConversation()!;
			const pastDate = "2020-01-01T00:00:00.000Z";
			mgr.loadConversation({ ...parent, created_at: pastDate }, []);
			const u1 = mgr.addMessage({ role: "user", content: "Hello" });

			const before = new Date().toISOString();
			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			const after = new Date().toISOString();

			expect(fork!.conversation.created_at).not.toBe(pastDate);
			expect(fork!.conversation.created_at >= before).toBe(true);
			expect(fork!.conversation.created_at <= after).toBe(true);
		});

		it("total_input_tokens / total_output_tokens / estimated_cost are re-summed from sliced messages only", () => {
			const { a1 } = setupStandardConversation(mgr);

			// Fork at a1 → includes sys (no tokens), u1 (input:10, cost:0.01), a1 (output:20, cost:0.02)
			const fork = mgr.prepareFork(a1.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.conversation.total_input_tokens).toBe(10);
			expect(fork!.conversation.total_output_tokens).toBe(20);
			expect(fork!.conversation.estimated_cost).toBeCloseTo(0.03);
		});

		it("uses caller-provided currentProviderId, currentModelId, currentMode (not parent values)", () => {
			const { u1 } = setupStandardConversation(mgr);

			const fork = mgr.prepareFork(u1.id, "anthropic", "claude-3", "plan");
			expect(fork!.conversation.provider_id).toBe("anthropic");
			expect(fork!.conversation.model_id).toBe("claude-3");
			expect(fork!.conversation.mode).toBe("plan");
		});
	});

	// -----------------------------------------------------------------------
	// 6.5 Title
	// -----------------------------------------------------------------------

	describe("title", () => {
		it('title is "Fork of {original title}" when parent has a title', () => {
			mgr.createConversation("openai", "gpt-4", "act");
			// addMessage with role "user" auto-generates title
			const u1 = mgr.addMessage({ role: "user", content: "My cool conversation" });

			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork!.conversation.title).toBe("Fork of My cool conversation");
		});

		it('title falls back to "Fork of {first 8 chars of ID}" when parent has no title', () => {
			mgr.createConversation("openai", "gpt-4", "act");
			// Add a system message (won't auto-generate title) and a hook injection user message
			const sys = mgr.addMessage({ role: "system", content: "System prompt" });
			const parentId = mgr.getActiveConversation()!.id;

			const fork = mgr.prepareFork(sys.id, "openai", "gpt-4", "act");
			expect(fork!.conversation.title).toBe(`Fork of ${parentId.substring(0, 8)}`);
		});

		it('forking a fork strips existing "Fork of " prefix (prevents "Fork of Fork of X")', () => {
			mgr.createConversation("openai", "gpt-4", "act");
			const u1 = mgr.addMessage({ role: "user", content: "Hello" });

			// First fork
			const fork1 = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork1!.conversation.title).toBe("Fork of Hello");

			// Load the fork and fork it again
			mgr.loadConversation(fork1!.conversation, fork1!.messages);
			const fork1MsgId = fork1!.messages[0]!.id;

			const fork2 = mgr.prepareFork(fork1MsgId, "openai", "gpt-4", "act");
			expect(fork2!.conversation.title).toBe("Fork of Hello");
			// NOT "Fork of Fork of Hello"
		});
	});

	// -----------------------------------------------------------------------
	// 6.6 Tool call pairing
	// -----------------------------------------------------------------------

	describe("tool call pairing", () => {
		it("fork at tool_call message auto-includes paired tool_result (next message)", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			mgr.addMessage({ role: "user", content: "Search for X" });
			const tc = mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: {
					id: "call_123",
					tool_name: "search",
					parameters: { q: "X" },
					status: "success",
				},
			});
			mgr.addMessage({
				role: "tool_result",
				content: "Found X",
				tool_result: {
					tool_name: "search",
					success: true,
					result: "Found X",
					tool_call_id: "call_123",
				},
			});
			mgr.addMessage({ role: "assistant", content: "Here are the results." });

			const fork = mgr.prepareFork(tc.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			// user + tool_call + tool_result = 3
			expect(fork!.messages).toHaveLength(3);
			expect(fork!.messages[2]!.role).toBe("tool_result");
		});

		it("fork at tool_result does NOT include next tool_call", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			mgr.addMessage({ role: "user", content: "Search" });
			mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: { id: "call_1", tool_name: "search", parameters: {}, status: "success" },
			});
			const tr = mgr.addMessage({
				role: "tool_result",
				content: "Result 1",
				tool_result: { tool_name: "search", success: true, result: "R1", tool_call_id: "call_1" },
			});
			mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: { id: "call_2", tool_name: "search", parameters: {}, status: "success" },
			});
			mgr.addMessage({
				role: "tool_result",
				content: "Result 2",
				tool_result: { tool_name: "search", success: true, result: "R2", tool_call_id: "call_2" },
			});

			const fork = mgr.prepareFork(tr.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			// user + tool_call + tool_result = 3 (no second tool_call)
			expect(fork!.messages).toHaveLength(3);
			expect(fork!.messages[2]!.role).toBe("tool_result");
		});

		it("fork at tool_call with no paired result — still returns valid data (no auto-extension)", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			mgr.addMessage({ role: "user", content: "Do something" });
			const tc = mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: { id: "call_orphan", tool_name: "run", parameters: {}, status: "pending" },
			});
			// No tool_result follows

			const fork = mgr.prepareFork(tc.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.messages).toHaveLength(2); // user + tool_call
		});

		it("multi-tool sequence — fork mid-sequence includes only messages up to fork point + auto-extension", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			mgr.addMessage({ role: "user", content: "Multi-step" });
			mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: { id: "call_a", tool_name: "step1", parameters: {}, status: "success" },
			});
			mgr.addMessage({
				role: "tool_result",
				content: "Step 1 done",
				tool_result: { tool_name: "step1", success: true, result: "ok", tool_call_id: "call_a" },
			});
			const tc2 = mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: { id: "call_b", tool_name: "step2", parameters: {}, status: "success" },
			});
			mgr.addMessage({
				role: "tool_result",
				content: "Step 2 done",
				tool_result: { tool_name: "step2", success: true, result: "ok", tool_call_id: "call_b" },
			});
			mgr.addMessage({ role: "assistant", content: "All done" });

			// Fork at second tool_call → auto-includes its paired tool_result
			const fork = mgr.prepareFork(tc2.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			// user + tc1 + tr1 + tc2 + tr2 = 5
			expect(fork!.messages).toHaveLength(5);
			expect(fork!.messages[4]!.role).toBe("tool_result");
			expect(fork!.messages[4]!.tool_result!.tool_call_id).toBe("call_b");
		});
	});

	// -----------------------------------------------------------------------
	// 6.7 Preservation
	// -----------------------------------------------------------------------

	describe("preservation", () => {
		it("original message timestamps are preserved (not overwritten)", () => {
			const { sys, u1, a1 } = setupStandardConversation(mgr);

			const fork = mgr.prepareFork(a1.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();

			// Timestamps in fork match originals
			expect(fork!.messages[0]!.timestamp).toBe(sys.timestamp);
			expect(fork!.messages[1]!.timestamp).toBe(u1.timestamp);
			expect(fork!.messages[2]!.timestamp).toBe(a1.timestamp);
		});

		it("provider tool_call.id and tool_result.tool_call_id are preserved (not reassigned)", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			mgr.addMessage({ role: "user", content: "Do something" });
			mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: { id: "call_preserve", tool_name: "search", parameters: {}, status: "success" },
			});
			const tr = mgr.addMessage({
				role: "tool_result",
				content: "Result",
				tool_result: { tool_name: "search", success: true, result: "ok", tool_call_id: "call_preserve" },
			});

			const fork = mgr.prepareFork(tr.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.messages[1]!.tool_call!.id).toBe("call_preserve");
			expect(fork!.messages[2]!.tool_result!.tool_call_id).toBe("call_preserve");
		});

		it("workflow metadata (workflow_path, workflow_name, persona_name) is preserved from parent", () => {
			mgr.createConversation("openai", "gpt-4", "act", {
				workflow_path: "/workflows/test.md",
				workflow_name: "Test Workflow",
				persona_name: "Helper",
			});
			const u1 = mgr.addMessage({ role: "user", content: "Hello" });

			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork!.conversation.workflow_path).toBe("/workflows/test.md");
			expect(fork!.conversation.workflow_name).toBe("Test Workflow");
			expect(fork!.conversation.persona_name).toBe("Helper");
		});

		it("is_background is cleared to false", () => {
			mgr.createConversation("openai", "gpt-4", "act", {
				is_background: true,
			});
			const u1 = mgr.addMessage({ role: "user", content: "Background task" });

			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork!.conversation.is_background).toBe(false);
		});

		it("use_extended_context is preserved when truthy", () => {
			mgr.createConversation("openai", "gpt-4", "act", {
				use_extended_context: true,
			});
			const u1 = mgr.addMessage({ role: "user", content: "Extended" });

			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork!.conversation.use_extended_context).toBe(true);
		});
	});

	// -----------------------------------------------------------------------
	// 6.8 Edge cases
	// -----------------------------------------------------------------------

	describe("edge cases", () => {
		it("returns null for unknown/nonexistent message ID", () => {
			setupStandardConversation(mgr);

			const fork = mgr.prepareFork("nonexistent-id", "openai", "gpt-4", "act");
			expect(fork).toBeNull();
		});

		it("returns null when there is no active conversation", () => {
			const fork = mgr.prepareFork("any-id", "openai", "gpt-4", "act");
			expect(fork).toBeNull();
		});

		it("works with a conversation that has only system + 1 user message", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			mgr.addMessage({ role: "system", content: "System prompt" });
			const u1 = mgr.addMessage({ role: "user", content: "Just one message", input_tokens: 5, cost_estimate: 0.005 });

			const fork = mgr.prepareFork(u1.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.messages).toHaveLength(2);
			expect(fork!.conversation.total_input_tokens).toBe(5);
			expect(fork!.conversation.estimated_cost).toBeCloseTo(0.005);
		});

		it("includes sub-agent token usage from tool_result.sub_agent_metadata in re-summation", () => {
			mgr.createConversation("openai", "gpt-4", "act");
			mgr.addMessage({ role: "user", content: "Use a sub-agent" });
			mgr.addMessage({
				role: "tool_call",
				content: "",
				tool_call: { id: "call_sa", tool_name: "use_subagent", parameters: {}, status: "success" },
			});
			const tr = mgr.addMessage({
				role: "tool_result",
				content: "",
				tool_result: {
					tool_name: "use_subagent",
					success: true,
					result: "Sub-agent found 3 notes.",
					tool_call_id: "call_sa",
					sub_agent_metadata: {
						jsonl_filename: "test.jsonl",
						token_usage: { input: 5000, output: 1200 },
						iteration_count: 3,
						stop_reason: "completed",
						profile_name: "search-vault",
					},
				} as ToolResult,
			});
			// Sub-agent tokens rolled up via addTokens (not on message fields)
			mgr.addTokens(5000, 1200);

			const fork = mgr.prepareFork(tr.id, "openai", "gpt-4", "act");
			expect(fork).not.toBeNull();
			expect(fork!.conversation.total_input_tokens).toBe(5000);
			expect(fork!.conversation.total_output_tokens).toBe(1200);
		});
	});
});

// ---------------------------------------------------------------------------
// addTokens()
// ---------------------------------------------------------------------------

describe("ConversationManager.addTokens()", () => {
	let mgr: ConversationManager;

	beforeEach(() => {
		mgr = createManager();
	});

	it("accumulates tokens into conversation totals", () => {
		mgr.createConversation("openai", "gpt-4", "act");

		mgr.addTokens(500, 200);
		expect(mgr.getActiveConversation()!.total_input_tokens).toBe(500);
		expect(mgr.getActiveConversation()!.total_output_tokens).toBe(200);

		mgr.addTokens(300, 100);
		expect(mgr.getActiveConversation()!.total_input_tokens).toBe(800);
		expect(mgr.getActiveConversation()!.total_output_tokens).toBe(300);
	});

	it("does not affect any message's input_tokens or output_tokens", () => {
		mgr.createConversation("openai", "gpt-4", "act");
		mgr.addMessage({ role: "user", content: "Hello" });

		mgr.addTokens(5000, 1200);

		const messages = mgr.getMessages();
		for (const msg of messages) {
			expect(msg.input_tokens).toBeNull();
			expect(msg.output_tokens).toBeNull();
		}

		// But conversation totals are updated
		expect(mgr.getActiveConversation()!.total_input_tokens).toBe(5000);
		expect(mgr.getActiveConversation()!.total_output_tokens).toBe(1200);
	});

	it("throws when no active conversation", () => {
		expect(() => mgr.addTokens(100, 50)).toThrow("No active conversation");
	});

	it("works alongside addMessage token accumulation", () => {
		mgr.createConversation("openai", "gpt-4", "act");
		mgr.addMessage({ role: "user", content: "Hello", input_tokens: 10 });
		mgr.addTokens(5000, 1200); // sub-agent tokens
		mgr.addMessage({ role: "assistant", content: "Hi", output_tokens: 20 });

		const conv = mgr.getActiveConversation()!;
		expect(conv.total_input_tokens).toBe(5010); // 10 from message + 5000 from addTokens
		expect(conv.total_output_tokens).toBe(1220); // 1200 from addTokens + 20 from message
	});
});
