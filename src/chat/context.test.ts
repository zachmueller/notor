import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { ContextManager } from "./context";
import type { Message } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _nextId = 1;
function makeMessage(overrides: Partial<Message> & { role: Message["role"]; content: Message["content"] }): Message {
	return {
		id: `msg-${_nextId++}`,
		conversation_id: "conv-1",
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

function makeToolCall(id: string, opts?: { hugeParam?: boolean }): Message {
	// estimateMessageTokens adds JSON.stringify(parameters).length / 4 tokens.
	// A ~480k-char param makes a single tool_call ~120k tokens — enough to force
	// truncation to land right after it, leaving its paired result orphaned.
	const parameters = opts?.hugeParam ? { data: "x".repeat(480_000) } : {};
	return makeMessage({
		role: "tool_call",
		content: "",
		tool_call: { id, tool_name: "search", parameters, status: "success" },
	});
}

function makeToolResult(toolCallId: string): Message {
	return makeMessage({
		role: "tool_result",
		content: "",
		tool_result: { tool_name: "search", success: true, result: "ok", tool_call_id: toolCallId },
	});
}

// Unknown model id → getContextWindow falls back to DEFAULT_CONTEXT_WINDOW
// (128_000). With the default 0.9 threshold the budget is 115_200 tokens.
const MODEL = "unknown-model-for-test";

// ---------------------------------------------------------------------------
// assembleContextWindow — tool-pair integrity on truncation
// ---------------------------------------------------------------------------

describe("ContextManager.assembleContextWindow — tool-pair integrity", () => {
	it("drops an orphaned tool_result when its tool_call is truncated (shielded from the leading guard)", () => {
		const cm = new ContextManager();
		// A user message sits between the (truncated) tool_call and its result,
		// so the leading-message guard stops at that user and never reaches the
		// orphaned result — only the new pair-integrity pass can remove it.
		const result = makeToolResult("A");
		const messages: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeToolCall("A", { hugeParam: true }), // truncated by token loop
			makeMessage({ role: "user", content: "shield" }), // survives, shields result
			result, // orphan once A is truncated
			makeMessage({ role: "user", content: "final question" }),
		];

		const out = cm.assembleContextWindow(messages, MODEL);

		expect(out.wasTruncated).toBe(true);
		// The orphaned result must be truncated alongside its missing call.
		expect(result.truncated).toBe(true);
		expect(out.messages).not.toContain(result);
		// No surviving tool_result should reference a truncated/absent call.
		const survivingCallIds = new Set(
			out.messages.filter((m) => m.role === "tool_call").map((m) => m.tool_call?.id ?? m.id)
		);
		for (const m of out.messages) {
			if (m.role === "tool_result") {
				expect(survivingCallIds.has(m.tool_result?.tool_call_id ?? m.id)).toBe(true);
			}
		}
	});

	it("keeps a tool_call/tool_result pair intact when the conversation fits the budget", () => {
		const cm = new ContextManager();
		const call = makeToolCall("B");
		const result = makeToolResult("B");
		const messages: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeMessage({ role: "user", content: "go" }),
			call,
			result,
			makeMessage({ role: "user", content: "thanks" }),
		];

		const out = cm.assembleContextWindow(messages, MODEL);

		expect(out.wasTruncated).toBe(false);
		expect(call.truncated).toBe(false);
		expect(result.truncated).toBe(false);
		expect(out.messages).toContain(call);
		expect(out.messages).toContain(result);
	});
});
