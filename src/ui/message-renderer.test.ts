// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { MessageRenderer, normalizeChangeBlocks, thinkingSummaryText, type MessageRendererDeps } from "./message-renderer";
import type { Message } from "../types";

// ---------------------------------------------------------------------------
// Minimal polyfill for Obsidian's HTMLElement DOM-builder extensions.
// (createDiv / createEl / createSpan / addClass / removeClass / hasClass /
// toggleClass) — enough to exercise the tool-call renderer paths.
// ---------------------------------------------------------------------------
beforeAll(() => {
	type CreateOpts = { cls?: string; text?: string; type?: string };
	function createEl(this: HTMLElement, tag: string, opts?: CreateOpts): HTMLElement {
		const el = document.createElement(tag);
		if (opts?.cls) el.className = opts.cls;
		if (opts?.text) el.textContent = opts.text;
		if (opts?.type) el.setAttribute("type", opts.type);
		this.appendChild(el);
		return el;
	}
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	proto.createEl = createEl;
	proto.createDiv = function (this: HTMLElement, opts?: CreateOpts) {
		return createEl.call(this, "div", opts);
	};
	proto.createSpan = function (this: HTMLElement, opts?: CreateOpts) {
		return createEl.call(this, "span", opts);
	};
	proto.addClass = function (this: HTMLElement, cls: string) {
		this.classList.add(cls);
	};
	proto.removeClass = function (this: HTMLElement, cls: string) {
		this.classList.remove(cls);
	};
	proto.hasClass = function (this: HTMLElement, cls: string) {
		return this.classList.contains(cls);
	};
	proto.toggleClass = function (this: HTMLElement, cls: string, on: boolean) {
		this.classList.toggle(cls, on);
	};
});

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let listEl: HTMLElement;
let renderer: MessageRenderer;

beforeEach(() => {
	document.body.innerHTML = "";
	listEl = document.createElement("div");
	document.body.appendChild(listEl);

	const footerEl = document.createElement("div");

	// Only the subset of deps that the tool-call paths touch is real; the rest
	// are never invoked by these tests.
	const deps = {
		getMessageListEl: () => listEl,
		getTokenFooterEl: () => footerEl,
		scrollToBottom: () => {},
	} as unknown as MessageRendererDeps;

	renderer = new MessageRenderer(deps);
});

function toolCallMessage(id: string, name: string, params: Record<string, unknown>): Message {
	return {
		id,
		role: "tool_call",
		content: "",
		tool_call: { id, tool_name: name, parameters: params, status: "pending" },
	} as unknown as Message;
}

// ---------------------------------------------------------------------------
// normalizeChangeBlocks
// ---------------------------------------------------------------------------

describe("normalizeChangeBlocks", () => {
	it("passes a valid array through (as fresh, detached objects)", () => {
		const input = [{ old_text: "a", new_text: "b" }, { old_text: "c", new_text: "" }];
		const result = normalizeChangeBlocks(input);
		expect(result).toEqual(input);
		// Fresh objects — not the same references as the input.
		expect(result![0]).not.toBe(input[0]);
	});

	it("parses a double-encoded JSON string of an array", () => {
		const result = normalizeChangeBlocks(JSON.stringify([{ old_text: "a", new_text: "b" }]));
		expect(result).toEqual([{ old_text: "a", new_text: "b" }]);
	});

	it("wraps a single {old_text,new_text} object into a one-element array", () => {
		const result = normalizeChangeBlocks({ old_text: "a", new_text: "b" });
		expect(result).toEqual([{ old_text: "a", new_text: "b" }]);
	});

	it("parses then wraps a double-encoded single object", () => {
		const result = normalizeChangeBlocks(JSON.stringify({ old_text: "a", new_text: "b" }));
		expect(result).toEqual([{ old_text: "a", new_text: "b" }]);
	});

	// --- Backward compatibility: legacy {search,replace} aliases canonicalize ---
	it("canonicalizes a legacy {search,replace} array to {old_text,new_text}", () => {
		const result = normalizeChangeBlocks([{ search: "a", replace: "b" }]);
		expect(result).toEqual([{ old_text: "a", new_text: "b" }]);
	});

	it("wraps and canonicalizes a single legacy {search,replace} object", () => {
		const result = normalizeChangeBlocks({ search: "a", replace: "b" });
		expect(result).toEqual([{ old_text: "a", new_text: "b" }]);
	});

	it("preserves a legacy deletion (empty replace) as empty new_text", () => {
		const result = normalizeChangeBlocks([{ search: "a", replace: "" }]);
		expect(result).toEqual([{ old_text: "a", new_text: "" }]);
	});

	it("returns null for a non-JSON string", () => {
		expect(normalizeChangeBlocks("not json")).toBeNull();
	});

	it("returns null for a number", () => {
		expect(normalizeChangeBlocks(42)).toBeNull();
	});

	it("returns null for undefined / null", () => {
		expect(normalizeChangeBlocks(undefined)).toBeNull();
		expect(normalizeChangeBlocks(null)).toBeNull();
	});

	it("returns null for an empty array", () => {
		expect(normalizeChangeBlocks([])).toBeNull();
	});

	it("returns null when any block is malformed", () => {
		expect(normalizeChangeBlocks([{ old_text: 1, new_text: "b" }])).toBeNull();
		expect(normalizeChangeBlocks([{ old_text: "a" }])).toBeNull();
		expect(normalizeChangeBlocks([{ search: 1, replace: "b" }])).toBeNull();
		expect(normalizeChangeBlocks([{ old_text: "a", new_text: "b" }, null])).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// renderDiffApprovalPrompt — malformed `changes` must not throw
// ---------------------------------------------------------------------------

describe("MessageRenderer — renderDiffApprovalPrompt malformed changes", () => {
	for (const [label, changes] of [
		["a number", 42],
		["a non-JSON string", "oops"],
		["missing", undefined],
		["an empty array", []],
		["a malformed block", [{ search: 1 }]],
	] as const) {
		it(`falls back to the generic prompt (no throw) when changes is ${label}`, async () => {
			const toolCallEl = listEl.createDiv();
			// autoApproved: the generic fallback prompt auto-resolves "approved".
			await expect(
				renderer.renderDiffApprovalPrompt(toolCallEl, "replace_in_note", { path: "n.md", changes }, true),
			).resolves.toBe("approved");
		});
	}
});

// ---------------------------------------------------------------------------
// renderStreamingToolCall
// ---------------------------------------------------------------------------

describe("MessageRenderer — streaming tool-call placeholder", () => {
	it("renders a name + streaming badge with no params panel", () => {
		const el = renderer.renderStreamingToolCall("t1", "read_note");

		expect(el).not.toBeNull();
		expect(listEl.querySelectorAll(".notor-tool-call")).toHaveLength(1);
		expect(listEl.querySelector(".notor-tool-call-name")?.textContent).toBe("read_note");

		const badge = listEl.querySelector(".notor-tool-call-status")!;
		expect(badge.classList.contains("notor-tool-status-streaming")).toBe(true);
		expect(badge.textContent).toBe("streaming");

		// No parameters panel until finalize.
		expect(listEl.querySelector(".notor-tool-call-params")).toBeNull();
	});

	it("returns null and renders nothing when the tool-call id is empty", () => {
		const el = renderer.renderStreamingToolCall("", "read_note");
		expect(el).toBeNull();
		expect(listEl.querySelectorAll(".notor-tool-call")).toHaveLength(0);
	});

	it("is idempotent — a duplicate start for the same id reuses the element", () => {
		const first = renderer.renderStreamingToolCall("t1", "read_note");
		const second = renderer.renderStreamingToolCall("t1", "read_note");
		expect(second).toBe(first);
		expect(listEl.querySelectorAll(".notor-tool-call")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// finalizeStreamingToolCall — mutate in place
// ---------------------------------------------------------------------------

describe("MessageRenderer — finalize streaming tool-call", () => {
	it("mutates the SAME element: flips the badge, adds params, no second card", () => {
		const placeholder = renderer.renderStreamingToolCall("t1", "read_note");
		const finalized = renderer.finalizeStreamingToolCall(
			"t1",
			toolCallMessage("m1", "read_note", { path: "a.md" }),
		);

		// Same DOM node — mutated in place.
		expect(finalized).toBe(placeholder);
		expect(listEl.querySelectorAll(".notor-tool-call")).toHaveLength(1);

		const badge = listEl.querySelector(".notor-tool-call-status")!;
		expect(badge.classList.contains("notor-tool-status-streaming")).toBe(false);
		expect(badge.classList.contains("notor-tool-status-pending")).toBe(true);
		expect(badge.textContent).toBe("pending");

		const params = listEl.querySelector(".notor-tool-call-params");
		expect(params).not.toBeNull();
		expect(params?.querySelector("code")?.textContent).toBe(
			JSON.stringify({ path: "a.md" }, null, 2),
		);
	});

	it("produces a card structurally identical to a fresh renderToolCall", () => {
		// Adopted-then-finalized streaming card.
		renderer.renderStreamingToolCall("t1", "read_note");
		const adopted = renderer.finalizeStreamingToolCall(
			"t1",
			toolCallMessage("m1", "read_note", { path: "a.md" }),
		)!;

		// Equivalent card built the post-stream way.
		const fresh = renderer.renderToolCall(toolCallMessage("m2", "read_note", { path: "a.md" }));

		// Strip the message-id data attribute (the only legitimate per-card
		// difference) before comparing structure.
		adopted.removeAttribute("data-message-id");
		fresh.removeAttribute("data-message-id");
		expect(adopted.outerHTML).toBe(fresh.outerHTML);
	});

	it("returns null when no placeholder exists for the id", () => {
		const result = renderer.finalizeStreamingToolCall(
			"unknown",
			toolCallMessage("m1", "read_note", {}),
		);
		expect(result).toBeNull();
	});

	it("migrates the map entry so getToolCallEl(messageId) resolves after finalize", () => {
		const placeholder = renderer.renderStreamingToolCall("t1", "read_note");
		renderer.finalizeStreamingToolCall("t1", toolCallMessage("m1", "read_note", {}));

		// Now reachable by message id...
		expect(renderer.getToolCallEl("m1")).toBe(placeholder);
		// ...and removed from the streaming map (a second finalize finds nothing).
		expect(renderer.finalizeStreamingToolCall("t1", toolCallMessage("m1", "read_note", {}))).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// clearStreamingToolCalls
// ---------------------------------------------------------------------------

describe("MessageRenderer — clearStreamingToolCalls", () => {
	it("removes all dangling placeholders and empties the map", () => {
		renderer.renderStreamingToolCall("t1", "read_note");
		renderer.renderStreamingToolCall("t2", "list_notes");
		expect(listEl.querySelectorAll(".notor-tool-call")).toHaveLength(2);

		renderer.clearStreamingToolCalls();

		expect(listEl.querySelectorAll(".notor-tool-call")).toHaveLength(0);
		// Map is empty — finalize finds nothing to adopt.
		expect(renderer.finalizeStreamingToolCall("t1", toolCallMessage("m1", "read_note", {}))).toBeNull();
	});

	it("leaves finalized (adopted) cards untouched", () => {
		renderer.renderStreamingToolCall("t1", "read_note");
		renderer.finalizeStreamingToolCall("t1", toolCallMessage("m1", "read_note", { path: "a.md" }));
		renderer.renderStreamingToolCall("t2", "list_notes"); // still dangling

		renderer.clearStreamingToolCalls();

		// The adopted card survives; only the dangling placeholder is removed.
		expect(listEl.querySelectorAll(".notor-tool-call")).toHaveLength(1);
		expect(renderer.getToolCallEl("m1")).not.toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Thinking indicator — estimated token count
// ---------------------------------------------------------------------------

describe("thinkingSummaryText", () => {
	it("shows plain 'Thinking' live until reasoning tokens arrive", () => {
		expect(thinkingSummaryText(null, 0, false)).toBe("Thinking");
		expect(thinkingSummaryText(null, 640, false)).toBe("Thinking ~640 tokens");
	});

	it("formats counts compactly (~640, ~1.2k, ~12k)", () => {
		expect(thinkingSummaryText(null, 999, false)).toBe("Thinking ~999 tokens");
		expect(thinkingSummaryText(null, 1_000, false)).toBe("Thinking ~1k tokens");
		expect(thinkingSummaryText(null, 1_234, false)).toBe("Thinking ~1.2k tokens");
		expect(thinkingSummaryText(null, 12_400, false)).toBe("Thinking ~12k tokens");
	});

	it("freezes to duration + tokens, dropping the token part when zero", () => {
		expect(thinkingSummaryText(8_000, 640, true)).toBe("Thought for 8s · ~640 tokens");
		expect(thinkingSummaryText(8_000, 0, true)).toBe("Thought for 8s");
		expect(thinkingSummaryText(65_000, 1_500, true)).toBe("Thought for 1m 5s · ~1.5k tokens");
	});

	it("falls back to 'Thinking' for a finished block with no recorded duration", () => {
		expect(thinkingSummaryText(null, 0, true)).toBe("Thinking");
	});
});

describe("MessageRenderer — thinking indicator", () => {
	function summaryOf(contentEl: HTMLElement): string {
		return contentEl.querySelector(".notor-thinking-block > summary")?.textContent ?? "";
	}

	it("ticks the live summary up with each chunk's running token count", () => {
		const contentEl = renderer.createAssistantMessagePlaceholder();
		renderer.startThinkingIndicator(contentEl);
		expect(summaryOf(contentEl)).toBe("Thinking");
		expect(contentEl.querySelector(".notor-thinking-active")).not.toBeNull();

		renderer.appendThinkingChunk(contentEl, "Let me think", 3);
		expect(summaryOf(contentEl)).toBe("Thinking ~3 tokens");
		renderer.appendThinkingChunk(contentEl, " about this carefully", 9);
		expect(summaryOf(contentEl)).toBe("Thinking ~9 tokens");
	});

	it("freezes to duration + tokens on stop", () => {
		const contentEl = renderer.createAssistantMessagePlaceholder();
		renderer.startThinkingIndicator(contentEl);
		renderer.appendThinkingChunk(contentEl, "reasoning", 3);
		renderer.stopThinkingIndicator(contentEl, 4_000, 3);

		expect(summaryOf(contentEl)).toBe("Thought for 4s · ~3 tokens");
		expect(contentEl.querySelector(".notor-thinking-active")).toBeNull();
		expect(contentEl.querySelector(".notor-thinking-empty")).toBeNull();
	});

	it("freezes hidden thinking to duration only and marks the block empty", () => {
		const contentEl = renderer.createAssistantMessagePlaceholder();
		renderer.startThinkingIndicator(contentEl);
		renderer.stopThinkingIndicator(contentEl, 6_000, 0);

		expect(summaryOf(contentEl)).toBe("Thought for 6s");
		expect(contentEl.querySelector(".notor-thinking-empty")).not.toBeNull();
	});

	it("does not overwrite a frozen summary when a late chunk arrives", () => {
		const contentEl = renderer.createAssistantMessagePlaceholder();
		renderer.startThinkingIndicator(contentEl);
		renderer.appendThinkingChunk(contentEl, "abcd", 1);
		renderer.stopThinkingIndicator(contentEl, 2_000, 1);
		renderer.appendThinkingChunk(contentEl, "efgh", 2);

		expect(summaryOf(contentEl)).toBe("Thought for 2s · ~1 token");
		expect(contentEl.querySelector(".notor-thinking-content")?.textContent).toBe("abcdefgh");
	});
});
