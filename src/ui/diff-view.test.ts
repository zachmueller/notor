// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { renderWriteNoteDiffPreview, renderReplaceInNoteDiffPreview } from "./diff-view";

// ---------------------------------------------------------------------------
// Minimal polyfill for Obsidian's HTMLElement DOM-builder extensions, matching
// the harness in message-renderer.test.ts.
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

let container: HTMLElement;

beforeEach(() => {
	document.body.innerHTML = "";
	container = document.createElement("div");
	document.body.appendChild(container);
});

const reasonText = () =>
	container.querySelector(".notor-diff-auto-approve-reason")?.textContent ?? null;

// A silent auto-approve gives the user no way to learn why a write skipped
// review, so the collapsed card names the rule that approved it.
describe("diff preview — auto-approve reason label", () => {
	it("renders the reason on an auto-approved write_note card", async () => {
		await renderWriteNoteDiffPreview(
			container,
			"ai/notes.md",
			"",
			"hello",
			true,
			undefined,
			undefined,
			"matched ai/",
		);
		expect(reasonText()).toBe("auto-approved: matched ai/");
	});

	it("renders nothing when an auto-approved card has no reason", async () => {
		await renderWriteNoteDiffPreview(container, "ai/notes.md", "", "hello", true);
		expect(reasonText()).toBeNull();
	});

	it("renders nothing on a card that still awaits approval", () => {
		// Pending cards never resolve until the user clicks, so don't await.
		void renderWriteNoteDiffPreview(
			container,
			"ai/notes.md",
			"",
			"hello",
			false,
			undefined,
			undefined,
			"matched ai/",
		);
		expect(reasonText()).toBeNull();
	});

	it("renders the reason on an auto-approved replace_in_note card", async () => {
		await renderReplaceInNoteDiffPreview(
			container,
			"ai/notes.md",
			"alpha\nbravo\n",
			[{ old_text: "alpha", new_text: "omega" }],
			true,
			undefined,
			undefined,
			"matched ai/",
		);
		expect(reasonText()).toBe("auto-approved: matched ai/");
	});
});
