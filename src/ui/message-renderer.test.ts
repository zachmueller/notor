// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { MessageRenderer, type MessageRendererDeps } from "./message-renderer";
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
