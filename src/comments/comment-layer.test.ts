// @vitest-environment jsdom
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { CommentLayer, COMMENT_HIGHLIGHT_CLASS } from "./comment-layer";
import type { AnchoredComment, CommentScope } from "./types";
import { installObsidianDomPolyfill } from "../__mocks__/dom-polyfill";

beforeAll(() => {
	installObsidianDomPolyfill();
	// jsdom does not implement layout APIs used for positioning.
	Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 10, right: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});

function buildRoot(): HTMLElement {
	document.body.innerHTML = "";
	const root = document.createElement("div");
	root.innerHTML = `
		<div class="msg" data-message-id="m1"><div class="content"><details class="think">cat thoughts</details><p>The cat sat on the mat.</p><div class="tok">12 tokens</div></div></div>
		<div class="msg" data-message-id="m2"><div class="content"><p>Second message with a cat.</p></div></div>`;
	document.body.appendChild(root);
	return root;
}

function makeLayer(root: HTMLElement, stored: AnchoredComment[] = []) {
	const saved: AnchoredComment[][] = [];
	const changes: number[] = [];
	const scopeOf = (msg: Element): CommentScope => ({
		scopeId: (msg as HTMLElement).dataset.messageId!,
		el: msg.querySelector<HTMLElement>(".content")!,
	});
	const layer = new CommentLayer({
		root,
		trigger: "contextmenu",
		resolveScope: (node) => {
			const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
			const msg = el?.closest(".msg[data-message-id]");
			return msg ? scopeOf(msg) : null;
		},
		getScopeEl: (id) => root.querySelector<HTMLElement>(`.msg[data-message-id="${id}"] .content`),
		listScopes: () => Array.from(root.querySelectorAll(".msg[data-message-id]")).map(scopeOf),
		skip: (el) => el.matches(".think, .tok"),
		storage: {
			load: () => stored,
			save: (c) => {
				saved.push(c);
			},
		},
		onChange: (c) => changes.push(c.length),
		scopeLabel: (id) => `In message ${id}`,
	});
	return { layer, saved, changes };
}

function selectText(root: HTMLElement, messageId: string, text: string): Range {
	const p = root.querySelector(`.msg[data-message-id="${messageId}"] p`)!.firstChild as Text;
	const idx = p.data.indexOf(text);
	const range = document.createRange();
	range.setStart(p, idx);
	range.setEnd(p, idx + text.length);
	return range;
}

function saveViaPopover(body: string): void {
	const textarea = document.querySelector<HTMLTextAreaElement>(".notor-comment-popover-input")!;
	textarea.value = body;
	textarea.dispatchEvent(new Event("input"));
	document.querySelector<HTMLButtonElement>(".notor-comment-popover-save")!.click();
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("CommentLayer", () => {
	let root: HTMLElement;
	beforeEach(() => {
		root = buildRoot();
	});

	it("opens the popover with a pending highlight and saves a comment", async () => {
		const { layer, saved } = makeLayer(root);
		expect(layer.addFromRange(selectText(root, "m1", "cat sat"))).toBe(true);
		expect(document.querySelector(".notor-comment-popover")).not.toBeNull();
		expect(root.querySelector(".notor-comment-highlight--pending")?.textContent).toBe("cat sat");

		saveViaPopover("Why the cat?");
		await flush();

		expect(document.querySelector(".notor-comment-popover")).toBeNull();
		expect(root.querySelector(".notor-comment-highlight--pending")).toBeNull();
		const marks = root.querySelectorAll(`mark.${COMMENT_HIGHLIGHT_CLASS}`);
		expect(marks).toHaveLength(1);
		expect(marks[0]!.textContent).toBe("cat sat");
		expect(saved.at(-1)).toHaveLength(1);
		expect(saved.at(-1)![0]!.anchor).toMatchObject({ scopeId: "m1", exact: "cat sat", occurrence: 0 });
	});

	it("cancel removes the pending highlight without saving", () => {
		const { layer, saved } = makeLayer(root);
		layer.addFromRange(selectText(root, "m1", "mat"));
		document.querySelector<HTMLButtonElement>(".notor-comment-popover-cancel")!.click();
		expect(root.querySelector("mark")).toBeNull();
		expect(saved).toHaveLength(0);
		expect(root.querySelector(".msg p")!.childNodes).toHaveLength(1);
	});

	it("ignores text in skipped subtrees when anchoring", async () => {
		const { layer, saved } = makeLayer(root);
		layer.addFromRange(selectText(root, "m1", "cat"));
		saveViaPopover("note");
		await flush();
		// "cat thoughts" in the thinking block must not count as occurrence 0.
		expect(saved.at(-1)![0]!.anchor.occurrence).toBe(0);
		expect(saved.at(-1)![0]!.anchor.prefix).toBe("The ");
	});

	it("re-applies stored highlights after a re-render", async () => {
		const { layer, saved } = makeLayer(root);
		layer.addFromRange(selectText(root, "m2", "a cat"));
		saveViaPopover("hmm");
		await flush();
		const stored = saved.at(-1)!;

		// Simulate the host re-rendering everything and a fresh layer loading storage.
		root = buildRoot();
		const second = makeLayer(root, stored);
		await second.layer.reapply();
		const mark = root.querySelector(`mark.${COMMENT_HIGHLIGHT_CLASS}`);
		expect(mark?.textContent).toBe("a cat");
		expect((mark as HTMLElement).dataset.commentId).toBe(stored[0]!.id);
	});

	it("clicking a mark opens the editor; delete removes the comment and its mark", async () => {
		const { layer } = makeLayer(root);
		layer.addFromRange(selectText(root, "m1", "mat"));
		saveViaPopover("first");
		await flush();
		const mark = root.querySelector<HTMLElement>(`mark.${COMMENT_HIGHLIGHT_CLASS}`)!;
		mark.click();
		expect(document.querySelector<HTMLTextAreaElement>(".notor-comment-popover-input")!.value).toBe("first");
		document.querySelector<HTMLButtonElement>(".notor-comment-popover-delete")!.click();
		expect(layer.count).toBe(0);
		expect(root.querySelector("mark")).toBeNull();
	});

	it("compiles grouped comments in document order and flags orphans", async () => {
		const { layer, saved } = makeLayer(root);
		layer.addFromRange(selectText(root, "m2", "Second"), "Second");
		saveViaPopover("on m2");
		await flush();
		layer.addFromRange(selectText(root, "m1", "mat"), "mat");
		saveViaPopover("on m1");
		await flush();
		layer.addFromRange(selectText(root, "m1", "The cat"), "The cat");
		saveViaPopover("earlier in m1");
		await flush();

		const out = layer.compile();
		const m1 = out.indexOf("**In message m1:**");
		const m2 = out.indexOf("**In message m2:**");
		expect(m1).toBeGreaterThan(-1);
		expect(m2).toBeGreaterThan(m1);
		expect(out.indexOf('"The cat"')).toBeLessThan(out.indexOf('"mat"'));

		// Remove message m1 from the DOM: its comments become orphaned.
		root.querySelector('.msg[data-message-id="m1"]')!.remove();
		expect(layer.getOrphanedIds().size).toBe(2);
		expect(layer.compile()).toContain("(from an earlier message)");
		expect(saved.at(-1)).toHaveLength(3);
	});

	it("clear() removes every comment and persists an empty list", async () => {
		const { layer, saved, changes } = makeLayer(root);
		layer.addFromRange(selectText(root, "m1", "mat"));
		saveViaPopover("x");
		await flush();
		await layer.clear();
		expect(layer.count).toBe(0);
		expect(saved.at(-1)).toEqual([]);
		expect(changes.at(-1)).toBe(0);
		expect(root.querySelector("mark")).toBeNull();
	});

	it("reset() drops in-memory state and ignores a stale in-flight load", async () => {
		let resolveLoad!: (c: AnchoredComment[]) => void;
		const pending = new Promise<AnchoredComment[]>((r) => (resolveLoad = r));
		const onChange = vi.fn();
		const layer = new CommentLayer({
			root,
			trigger: "contextmenu",
			resolveScope: () => null,
			getScopeEl: () => null,
			listScopes: () => [],
			storage: { load: () => pending, save: () => {} },
			onChange,
		});
		const loading = layer.load();
		layer.reset();
		resolveLoad([{ id: "x", anchor: { scopeId: "m1", exact: "a", prefix: "", suffix: "", occurrence: 0 }, quote: "a", body: "b", created_at: "" }]);
		await loading;
		expect(layer.count).toBe(0);
	});

	it("rejects ranges outside any scope", () => {
		const { layer } = makeLayer(root);
		const outside = document.createElement("p");
		outside.textContent = "outside";
		document.body.prepend(outside);
		const r = document.createRange();
		r.selectNodeContents(outside);
		expect(layer.addFromRange(r)).toBe(false);
	});
});
