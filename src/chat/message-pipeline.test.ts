import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { toChatMessages, getWireText, setChatBlockRegistry, processStream } from "./message-pipeline";
import type { Message } from "../types";
import type { ContentBlock } from "../media/types";
import type { StreamChunk } from "../providers/provider";

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

function makeExtensionBlock(opts: {
	kind: string;
	data?: Record<string, unknown>;
	fallback_text?: string;
	source_extension?: string;
}): Message {
	const block: ContentBlock = {
		type: "custom_block",
		kind: opts.kind,
		data: opts.data ?? {},
		...(opts.fallback_text != null ? { fallback_text: opts.fallback_text } : {}),
	};
	return makeMessage({
		role: "extension_block",
		content: [block],
		source_extension: opts.source_extension ?? "test-extension",
	});
}

// ---------------------------------------------------------------------------
// getWireText — 13.4
// ---------------------------------------------------------------------------

describe("getWireText", () => {
	beforeEach(() => {
		// Reset registry to undefined between tests
		setChatBlockRegistry({ get: () => undefined });
	});

	it("returns string content as-is", () => {
		expect(getWireText("hello")).toBe("hello");
	});

	it("returns null for empty string", () => {
		expect(getWireText("")).toBeNull();
	});

	it("uses toLLMText when registry has definition", () => {
		const registry = {
			get: (kind: string) =>
				kind === "memory_recalled"
					? { toLLMText: () => "recalled notes content" }
					: undefined,
		};
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "memory_recalled", data: {} },
		];
		expect(getWireText(blocks, registry)).toBe("recalled notes content");
	});

	it("falls back to fallback_text when no registry definition", () => {
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "unknown_kind", data: {}, fallback_text: "fallback content" },
		];
		expect(getWireText(blocks, { get: () => undefined })).toBe("fallback content");
	});

	it("falls back to fallback_text when toLLMText is absent on definition", () => {
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "my_block", data: {}, fallback_text: "fb" },
		];
		const registry = { get: (kind: string) => kind === "my_block" ? {} : undefined };
		expect(getWireText(blocks, registry)).toBe("fb");
	});

	it("returns null when all custom_blocks produce null/empty output", () => {
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "silent_block", data: {} },
		];
		expect(getWireText(blocks, { get: () => undefined })).toBeNull();
	});

	it("returns null when toLLMText returns null and no fallback_text", () => {
		const registry = {
			get: (kind: string) =>
				kind === "invisible" ? { toLLMText: () => null } : undefined,
		};
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "invisible", data: {} },
		];
		expect(getWireText(blocks, registry)).toBeNull();
	});

	it("joins multiple custom_blocks with double newline", () => {
		const registry = {
			get: (kind: string) =>
				kind === "a" ? { toLLMText: () => "text_a" }
				: kind === "b" ? { toLLMText: () => "text_b" }
				: undefined,
		};
		const blocks: ContentBlock[] = [
			{ type: "custom_block", kind: "a", data: {} },
			{ type: "custom_block", kind: "b", data: {} },
		];
		expect(getWireText(blocks, registry)).toBe("text_a\n\ntext_b");
	});

	it("ignores non-custom_block entries", () => {
		const blocks: ContentBlock[] = [
			{ type: "text", text: "user-visible text" },
			{ type: "custom_block", kind: "info", data: {}, fallback_text: "wire text" },
		];
		expect(getWireText(blocks, { get: () => undefined })).toBe("wire text");
	});
});

// ---------------------------------------------------------------------------
// toChatMessages — extension_block handling — 13.4
// ---------------------------------------------------------------------------

describe("toChatMessages — extension_block", () => {
	beforeEach(() => {
		setChatBlockRegistry({ get: () => undefined });
	});

	/** Extract all text from a ChatMessage content (string or ContentBlock[]). */
	function allText(content: unknown): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return (content as Array<{ type: string; text?: string }>)
				.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
				.join("");
		}
		return "";
	}

	it("extension_block with fallback_text emits as user-role with notor-ext tags", () => {
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeExtensionBlock({ kind: "memory", fallback_text: "recalled context", source_extension: "memory-ext" }),
		];
		const result = toChatMessages(msgs, "sys");
		// Without a following user message, the extension_block is not coalesced — it stands alone
		const userMsgs = result.filter((m) => m.role === "user");
		expect(userMsgs).toHaveLength(1);
		const text = allText(userMsgs[0]!.content);
		expect(text).toContain(`<notor-ext source="memory-ext">`);
		expect(text).toContain("recalled context");
		expect(text).toContain("</notor-ext>");
	});

	it("extension_block with toLLMText uses registry output on wire", () => {
		setChatBlockRegistry({
			get: (kind: string) =>
				kind === "search_results"
					? { toLLMText: () => "full search body" }
					: undefined,
		});
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeExtensionBlock({ kind: "search_results", source_extension: "search-ext" }),
		];
		const result = toChatMessages(msgs, "sys");
		const userMsgs = result.filter((m) => m.role === "user");
		expect(userMsgs).toHaveLength(1);
		const text = allText(userMsgs[0]!.content);
		expect(text).toContain("full search body");
	});

	it("extension_block where all blocks produce null → dropped from wire entirely", () => {
		// no fallback_text, no registry → wire text is null → message dropped
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeExtensionBlock({ kind: "decorative_block" }),
			makeMessage({ role: "user", content: "Hello" }),
		];
		const result = toChatMessages(msgs, "sys");
		const hasExtTag = result.some((m) => typeof m.content === "string" && (m.content as string).includes("notor-ext"));
		expect(hasExtTag).toBe(false);
	});

	// -----------------------------------------------------------------------
	// Coalescing — 13.4
	// -----------------------------------------------------------------------

	it("extension_block + user message coalesces into single user message", () => {
		setChatBlockRegistry({ get: () => undefined });
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeExtensionBlock({ kind: "info", fallback_text: "context block" }),
			makeMessage({ role: "user", content: "User question" }),
		];
		const result = toChatMessages(msgs, "sys");
		const userMessages = result.filter((m) => m.role === "user");
		// Both should coalesce: extension_block (user wire) + user message = 1 user message
		expect(userMessages).toHaveLength(1);
		const content = userMessages[0]!.content;
		const isArray = Array.isArray(content);
		expect(isArray).toBe(true);
		if (isArray) {
			const allText = (content as Array<{ type: string; text?: string }>)
				.filter((b) => b.type === "text")
				.map((b) => b.text ?? "")
				.join(" ");
			expect(allText).toContain("User question");
			expect(allText).toContain("context block");
		}
	});

	it("two consecutive extension_blocks coalesce into one user message", () => {
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeExtensionBlock({ kind: "block_a", fallback_text: "block A content" }),
			makeExtensionBlock({ kind: "block_b", fallback_text: "block B content" }),
			makeMessage({ role: "user", content: "My question" }),
		];
		const result = toChatMessages(msgs, "sys");
		const userMessages = result.filter((m) => m.role === "user");
		// All three should coalesce into one user message
		expect(userMessages).toHaveLength(1);
	});

	it("hook injection (user role) + user message also coalesces", () => {
		const hookMsg = makeMessage({
			role: "user",
			content: "Hook injection context",
			is_hook_injection: true,
		});
		const userMsg = makeMessage({ role: "user", content: "Actual question" });
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			hookMsg,
			userMsg,
		];
		const result = toChatMessages(msgs, "sys");
		const userMessages = result.filter((m) => m.role === "user");
		// Both user-role messages coalesce
		expect(userMessages).toHaveLength(1);
	});

	it("user ContentBlock[] + extension_block string normalizes to ContentBlock[]", () => {
		const imgBlock: ContentBlock = { type: "image", media_type: "image/png", data: "base64" };
		const userMsg = makeMessage({ role: "user", content: [imgBlock] });
		const extBlock = makeExtensionBlock({ kind: "info", fallback_text: "some text" });
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			extBlock,
			userMsg,
		];
		const result = toChatMessages(msgs, "sys");
		const userMessages = result.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(1);
		expect(Array.isArray(userMessages[0]!.content)).toBe(true);
	});

	it("notor-ext tags appear in merged user message content", () => {
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeExtensionBlock({ kind: "ctx", fallback_text: "context", source_extension: "my-ext" }),
			makeMessage({ role: "user", content: "follow-up" }),
		];
		const result = toChatMessages(msgs, "sys");
		const userMsg = result.find((m) => m.role === "user");
		expect(userMsg).toBeDefined();
		const content = userMsg!.content;
		if (Array.isArray(content)) {
			const allText = (content as Array<{ type: string; text?: string }>)
				.map((b) => b.text ?? "")
				.join("");
			expect(allText).toContain('<notor-ext source="my-ext">');
		} else {
			expect(content).toContain('<notor-ext source="my-ext">');
		}
	});
});

// ---------------------------------------------------------------------------
// toChatMessages — tool_call / tool_result pairing
//
// Bedrock/Anthropic require every tool_result block to correlate 1:1 to a
// tool_use block in the immediately preceding assistant turn. These cover the
// orphaned-tool_result repair (parallel-batch + standalone) and the existing
// orphaned-tool_call synthetic-result injection (regression lock).
// ---------------------------------------------------------------------------

describe("toChatMessages — tool pairing", () => {
	beforeEach(() => {
		setChatBlockRegistry({ get: () => undefined });
	});

	function makeToolCall(id: string, toolName = "search"): Message {
		return makeMessage({
			role: "tool_call",
			content: "",
			tool_call: { id, tool_name: toolName, parameters: {}, status: "success" },
		});
	}

	function makeToolResult(toolCallId: string, toolName = "search", result = "ok"): Message {
		return makeMessage({
			role: "tool_result",
			content: "",
			tool_result: { tool_name: toolName, success: true, result, tool_call_id: toolCallId },
		});
	}

	/** Assert every tool_result block references a call in the preceding tool_call turn. */
	function assertNoOrphanResults(result: ReturnType<typeof toChatMessages>): void {
		for (let i = 0; i < result.length; i++) {
			const m = result[i]!;
			if (m.role !== "tool_result" || !m.tool_results?.length) continue;
			const prev = result[i - 1];
			const callIds = new Set(
				prev?.role === "tool_call" ? (prev.tool_calls ?? []).map((tc) => tc.id) : []
			);
			for (const tr of m.tool_results) {
				expect(callIds.has(tr.tool_call_id)).toBe(true);
			}
		}
	}

	it("drops an orphaned result block in a parallel batch (calls A,B; results A,B,C)", () => {
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeMessage({ role: "user", content: "go" }),
			makeToolCall("A"),
			makeToolCall("B"),
			makeToolResult("A"),
			makeToolResult("B"),
			makeToolResult("C"), // orphan — no matching call
		];
		const result = toChatMessages(msgs, "sys");
		const trMsg = result.find((m) => m.role === "tool_result");
		expect(trMsg).toBeDefined();
		const ids = (trMsg!.tool_results ?? []).map((tr) => tr.tool_call_id).sort();
		expect(ids).toEqual(["A", "B"]);
		assertNoOrphanResults(result);
	});

	it("drops a standalone tool_result with no preceding tool_call", () => {
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeMessage({ role: "user", content: "hi" }),
			makeToolResult("ghost"), // originating call truncated away
			makeMessage({ role: "assistant", content: "done" }),
		];
		const result = toChatMessages(msgs, "sys");
		expect(result.some((m) => m.role === "tool_result")).toBe(false);
		assertNoOrphanResults(result);
	});

	it("injects a synthetic result for an orphaned tool_call (regression lock)", () => {
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeMessage({ role: "user", content: "go" }),
			makeToolCall("A"),
			// no result for A
			makeMessage({ role: "assistant", content: "next" }),
		];
		const result = toChatMessages(msgs, "sys");
		const trMsg = result.find((m) => m.role === "tool_result");
		expect(trMsg).toBeDefined();
		const synthetic = (trMsg!.tool_results ?? []).find((tr) => tr.tool_call_id === "A");
		expect(synthetic).toBeDefined();
		expect(synthetic!.result).toBe("Tool call was cancelled by the user.");
		expect(synthetic!.is_error).toBe(true);
		assertNoOrphanResults(result);
	});

	it("keeps a well-formed parallel batch intact", () => {
		const msgs: Message[] = [
			makeMessage({ role: "system", content: "sys" }),
			makeMessage({ role: "user", content: "go" }),
			makeToolCall("A"),
			makeToolCall("B"),
			makeToolResult("A"),
			makeToolResult("B"),
		];
		const result = toChatMessages(msgs, "sys");
		const tcMsg = result.find((m) => m.role === "tool_call");
		const trMsg = result.find((m) => m.role === "tool_result");
		expect((tcMsg!.tool_calls ?? []).map((tc) => tc.id).sort()).toEqual(["A", "B"]);
		expect((trMsg!.tool_results ?? []).map((tr) => tr.tool_call_id).sort()).toEqual(["A", "B"]);
		assertNoOrphanResults(result);
	});
});

// ---------------------------------------------------------------------------
// processStream — thinking indicator lifecycle + duration
// ---------------------------------------------------------------------------

type FakeView = {
	createAssistantMessagePlaceholder: ReturnType<typeof vi.fn>;
	startThinkingIndicator: ReturnType<typeof vi.fn>;
	stopThinkingIndicator: ReturnType<typeof vi.fn>;
	cancelThinkingIndicator: ReturnType<typeof vi.fn>;
	appendThinkingChunk: ReturnType<typeof vi.fn>;
	appendStreamChunk: ReturnType<typeof vi.fn>;
	renderStreamingToolCall: ReturnType<typeof vi.fn>;
};

function makeFakeView(): { view: FakeView; contentEl: object } {
	const contentEl = { __sentinel: "contentEl" };
	const view: FakeView = {
		createAssistantMessagePlaceholder: vi.fn(() => contentEl),
		startThinkingIndicator: vi.fn(),
		stopThinkingIndicator: vi.fn(),
		cancelThinkingIndicator: vi.fn(),
		appendThinkingChunk: vi.fn(),
		appendStreamChunk: vi.fn(),
		renderStreamingToolCall: vi.fn(),
	};
	return { view, contentEl };
}

async function* streamOf(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
	for (const chunk of chunks) yield chunk;
}

describe("processStream — thinking indicator", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts and stops the indicator and records a duration for a thinking→text turn", async () => {
		// Date.now() is called once on thinking_started and once inside stopThinking.
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(4_000);
		const { view, contentEl } = makeFakeView();

		const result = await processStream(
			streamOf([
				{ type: "thinking_start" },
				{ type: "text_delta", text: "hello" },
				{ type: "message_end", input_tokens: 5, output_tokens: 7 },
			]),
			new AbortController(),
			contentEl as never,
			() => view as never,
		);

		expect(view.startThinkingIndicator).toHaveBeenCalledTimes(1);
		expect(view.startThinkingIndicator).toHaveBeenCalledWith(contentEl);
		expect(view.stopThinkingIndicator).toHaveBeenCalledTimes(1);
		expect(view.stopThinkingIndicator).toHaveBeenCalledWith(contentEl, 3_000);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.thinkingDurationMs).toBe(3_000);
		}
	});

	it("stops the indicator when the first tool call arrives", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(2_500);
		const { view, contentEl } = makeFakeView();

		const result = await processStream(
			streamOf([
				{ type: "thinking_start" },
				{ type: "tool_call_start", id: "t1", tool_name: "read_note" },
				{ type: "tool_call_end", id: "t1" },
				{ type: "message_end", input_tokens: 1, output_tokens: 1 },
			]),
			new AbortController(),
			contentEl as never,
			() => view as never,
		);

		expect(view.stopThinkingIndicator).toHaveBeenCalledTimes(1);
		// The placeholder card is rendered the moment the call opens (name only).
		expect(view.renderStreamingToolCall).toHaveBeenCalledWith("t1", "read_note");
		expect(result.type).toBe("tool_calls");
		if (result.type === "tool_calls") {
			expect(result.thinkingDurationMs).toBe(1_500);
		}
	});

	it("records a duration for a hidden-thinking-only turn (no text, no tools)", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(10_000).mockReturnValueOnce(12_000);
		const { view, contentEl } = makeFakeView();

		const result = await processStream(
			streamOf([
				{ type: "thinking_start" },
				{ type: "message_end", input_tokens: 3, output_tokens: 0 },
			]),
			new AbortController(),
			contentEl as never,
			() => view as never,
		);

		// stopThinking fires once after the loop ends.
		expect(view.stopThinkingIndicator).toHaveBeenCalledTimes(1);
		expect(view.stopThinkingIndicator).toHaveBeenCalledWith(contentEl, 2_000);
		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.thinking).toBe("");
			expect(result.thinkingDurationMs).toBe(2_000);
		}
	});

	it("stops the indicator and reports a duration when cancelled mid-thinking", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_800);
		const { view, contentEl } = makeFakeView();
		const ac = new AbortController();

		// Abort after thinking_start is consumed but before the next chunk.
		async function* aborting(): AsyncIterable<StreamChunk> {
			yield { type: "thinking_start" };
			ac.abort();
			yield { type: "text_delta", text: "never seen" };
		}

		const result = await processStream(aborting(), ac, contentEl as never, () => view as never);

		expect(view.stopThinkingIndicator).toHaveBeenCalledTimes(1);
		expect(result.type).toBe("cancelled");
		if (result.type === "cancelled") {
			expect(result.thinkingDurationMs).toBe(800);
		}
	});

	it("is a safe no-op when no view is available", async () => {
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(3_000);

		const result = await processStream(
			streamOf([
				{ type: "thinking_start" },
				{ type: "text_delta", text: "hi" },
				{ type: "message_end", input_tokens: 1, output_tokens: 1 },
			]),
			new AbortController(),
			undefined,
			() => undefined,
		);

		expect(result.type).toBe("text");
		if (result.type === "text") {
			expect(result.thinkingDurationMs).toBe(2_000);
		}
	});

	// --- optimistic-start (pre-first-token) behavior -----------------------

	it("optimistically starts the indicator when thinking is enabled, before any event", async () => {
		// Date.now(): optimistic start, then stop on confirmed thinking_start→text.
		vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(8_000);
		const { view, contentEl } = makeFakeView();

		const result = await processStream(
			streamOf([
				{ type: "thinking_start" }, // confirmation (e.g. Bedrock signature delta)
				{ type: "text_delta", text: "answer" },
				{ type: "message_end", input_tokens: 1, output_tokens: 1 },
			]),
			new AbortController(),
			contentEl as never,
			() => view as never,
			true, // thinkingEnabled
		);

		// Started once (optimistically); the later thinking_start must NOT restart it.
		expect(view.startThinkingIndicator).toHaveBeenCalledTimes(1);
		expect(view.stopThinkingIndicator).toHaveBeenCalledTimes(1);
		expect(view.cancelThinkingIndicator).not.toHaveBeenCalled();
		// Duration spans the full optimistic window (request → first token), ~7s.
		expect(view.stopThinkingIndicator).toHaveBeenCalledWith(contentEl, 7_000);
		if (result.type === "text") expect(result.thinkingDurationMs).toBe(7_000);
	});

	it("retracts the optimistic indicator when the model does not actually think", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const { view, contentEl } = makeFakeView();

		const result = await processStream(
			streamOf([
				// No thinking_start — adaptive model chose not to think.
				{ type: "text_delta", text: "quick answer" },
				{ type: "message_end", input_tokens: 1, output_tokens: 1 },
			]),
			new AbortController(),
			contentEl as never,
			() => view as never,
			true, // thinkingEnabled
		);

		expect(view.startThinkingIndicator).toHaveBeenCalledTimes(1); // optimistic
		expect(view.cancelThinkingIndicator).toHaveBeenCalledTimes(1); // retracted
		expect(view.stopThinkingIndicator).not.toHaveBeenCalled();
		expect(result.type).toBe("text");
		if (result.type === "text") {
			// No confirmed thinking → no persisted duration.
			expect(result.thinkingDurationMs).toBe(0);
		}
	});

	it("does not start an indicator when thinking is disabled and none occurs", async () => {
		const { view, contentEl } = makeFakeView();

		await processStream(
			streamOf([
				{ type: "text_delta", text: "hi" },
				{ type: "message_end", input_tokens: 1, output_tokens: 1 },
			]),
			new AbortController(),
			contentEl as never,
			() => view as never,
			false, // thinkingEnabled
		);

		expect(view.startThinkingIndicator).not.toHaveBeenCalled();
		expect(view.cancelThinkingIndicator).not.toHaveBeenCalled();
		expect(view.stopThinkingIndicator).not.toHaveBeenCalled();
	});
});
