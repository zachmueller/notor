// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { buildFlatText, collectTextNodes, unwrapMarks, wrapRange } from "./highlight-ranges";

function makeRoot(html: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = html;
	document.body.appendChild(root);
	return root;
}

describe("highlight-ranges", () => {
	it("collects text nodes in document order and builds a flat string", () => {
		const root = makeRoot("<p>Hello <b>bold</b> world</p><p>Second</p>");
		const { text, offsets } = buildFlatText(collectTextNodes(root));
		expect(text).toBe("Hello bold worldSecond");
		expect(offsets.map((o) => o.start)).toEqual([0, 6, 10, 16]);
	});

	it("skips text inside elements matched by the skip predicate", () => {
		const root = makeRoot('<details class="think">hidden</details><p>shown</p><div class="tok">12 tokens</div>');
		const nodes = collectTextNodes(root, (el) => el.matches(".think, .tok"));
		expect(buildFlatText(nodes).text).toBe("shown");
	});

	it("wraps a range that crosses element boundaries", () => {
		const root = makeRoot("<p>Hello <b>bold</b> world</p>");
		const { offsets } = buildFlatText(collectTextNodes(root));
		const marks = wrapRange(offsets, 3, 12, { className: "hl", dataset: { commentId: "c1" } });
		expect(marks).toHaveLength(3);
		expect(marks.map((m) => m.textContent).join("")).toBe("lo bold w");
		expect(marks.every((m) => m.dataset.commentId === "c1")).toBe(true);
		expect(root.textContent).toBe("Hello bold world");
	});

	it("round-trips: unwrap restores the original DOM and merges text nodes", () => {
		const html = "<p>Hello <b>bold</b> world</p>";
		const root = makeRoot(html);
		const { offsets } = buildFlatText(collectTextNodes(root));
		const marks = wrapRange(offsets, 2, 13, { className: "hl" });
		unwrapMarks(marks);
		expect(root.innerHTML).toBe(html);
		expect(collectTextNodes(root)).toHaveLength(3);
	});

	it("handles multiple ranges when processed last-to-first", () => {
		const root = makeRoot("<p>aa bb aa bb</p>");
		const { offsets } = buildFlatText(collectTextNodes(root));
		const second = wrapRange(offsets, 6, 8, { className: "hl" });
		const first = wrapRange(offsets, 0, 2, { className: "hl" });
		expect(first[0]!.textContent).toBe("aa");
		expect(second[0]!.textContent).toBe("aa");
		expect(root.querySelectorAll("mark.hl")).toHaveLength(2);
	});

	it("returns no marks for an empty range", () => {
		const root = makeRoot("<p>text</p>");
		const { offsets } = buildFlatText(collectTextNodes(root));
		expect(wrapRange(offsets, 2, 2, { className: "hl" })).toEqual([]);
	});
});
