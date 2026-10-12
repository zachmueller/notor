// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { captureAnchor, normalizeWithMap, resolveAnchor } from "./anchor";
import { buildFlatText, collectTextNodes } from "../ui/highlight-ranges";

function makeScope(html: string): HTMLElement {
	const el = document.createElement("div");
	el.innerHTML = html;
	document.body.appendChild(el);
	return el;
}

function flat(el: HTMLElement, skip?: (e: Element) => boolean): string {
	return buildFlatText(collectTextNodes(el, skip)).text;
}

/** Build a Range covering `[start, end)` of the scope's flattened text. */
function rangeFor(el: HTMLElement, start: number, end: number): Range {
	const { offsets } = buildFlatText(collectTextNodes(el));
	const range = document.createRange();
	const locate = (pos: number) => {
		for (const o of offsets) {
			if (pos <= o.start + o.node.length) return { node: o.node, offset: pos - o.start };
		}
		const last = offsets[offsets.length - 1]!;
		return { node: last.node, offset: last.node.length };
	};
	const s = locate(start);
	const e = locate(end);
	range.setStart(s.node, s.offset);
	range.setEnd(e.node, e.offset);
	return range;
}

describe("normalizeWithMap", () => {
	it("collapses whitespace runs and maps back to raw indices", () => {
		const { norm, map } = normalizeWithMap("a  \n b");
		expect(norm).toBe("a b");
		expect(map).toEqual([0, 1, 5]);
	});
});

describe("captureAnchor", () => {
	it("captures exact text, context and occurrence", () => {
		const el = makeScope("<p>The cat sat. The cat ran.</p>");
		const text = flat(el);
		const second = text.lastIndexOf("cat");
		const anchor = captureAnchor(rangeFor(el, second, second + 3), el, "m1")!;
		expect(anchor.exact).toBe("cat");
		expect(anchor.scopeId).toBe("m1");
		expect(anchor.occurrence).toBe(1);
		expect(anchor.prefix.endsWith("sat. The ")).toBe(true);
		expect(anchor.suffix.startsWith(" ran.")).toBe(true);
	});

	it("handles ranges crossing element boundaries", () => {
		const el = makeScope("<p>Hello <b>bold</b> world</p>");
		const anchor = captureAnchor(rangeFor(el, 3, 12), el, "m1")!;
		expect(anchor.exact).toBe("lo bold w");
	});

	it("trims surrounding whitespace and rejects blank selections", () => {
		const el = makeScope("<p>one   two</p>");
		expect(captureAnchor(rangeFor(el, 3, 6), el, "m1")).toBeNull();
		const anchor = captureAnchor(rangeFor(el, 2, 8), el, "m1")!;
		expect(anchor.exact).toBe("e   tw");
	});

	it("accepts element-container boundaries", () => {
		const el = makeScope("<p>alpha</p><p>beta</p>");
		const range = document.createRange();
		range.setStart(el, 1); // before second <p>
		range.setEnd(el, 2); // after second <p>
		expect(captureAnchor(range, el, "m1")!.exact).toBe("beta");
	});

	it("excludes skipped subtrees from the scope text", () => {
		const el = makeScope('<details class="think">thinking cat</details><p>the cat</p>');
		const skip = (e: Element) => e.matches(".think");
		const range = document.createRange();
		const p = el.querySelector("p")!.firstChild as Text;
		range.setStart(p, 4);
		range.setEnd(p, 7);
		const anchor = captureAnchor(range, el, "m1", skip)!;
		expect(anchor.exact).toBe("cat");
		expect(anchor.occurrence).toBe(0);
		expect(anchor.prefix).toBe("the ");
	});
});

describe("resolveAnchor", () => {
	it("round-trips a captured anchor", () => {
		const el = makeScope("<p>The cat sat. The cat ran.</p>");
		const text = flat(el);
		const second = text.lastIndexOf("cat");
		const anchor = captureAnchor(rangeFor(el, second, second + 3), el, "m1")!;
		expect(resolveAnchor(anchor, text)).toEqual({ start: second, end: second + 3 });
	});

	it("uses context to disambiguate duplicates even when the occurrence index shifted", () => {
		const anchor = { scopeId: "m", exact: "cat", prefix: "The ", suffix: " ran.", occurrence: 1 };
		const text = "A cat. The cat ran. The cat sat.";
		const res = resolveAnchor(anchor, text)!;
		expect(text.slice(res.start, res.end)).toBe("cat");
		expect(res.start).toBe(text.indexOf("cat ran"));
	});

	it("falls back to the occurrence index when context ties", () => {
		const anchor = { scopeId: "m", exact: "x", prefix: "", suffix: "", occurrence: 2 };
		const text = "x x x x";
		expect(resolveAnchor(anchor, text)).toEqual({ start: 4, end: 5 });
	});

	it("tolerates whitespace differences after re-render", () => {
		const anchor = { scopeId: "m", exact: "hello world", prefix: "", suffix: "", occurrence: 0 };
		const text = "say hello\n  world now";
		const res = resolveAnchor(anchor, text)!;
		expect(text.slice(res.start, res.end)).toBe("hello\n  world");
	});

	it("returns null when the passage is gone (orphaned)", () => {
		const anchor = { scopeId: "m", exact: "missing", prefix: "", suffix: "", occurrence: 0 };
		expect(resolveAnchor(anchor, "nothing here")).toBeNull();
	});
});
