import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

import { toChatMessages, getWireText, setChatBlockRegistry } from "./message-pipeline";
import type { Message } from "../types";
import type { ContentBlock } from "../media/types";

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
