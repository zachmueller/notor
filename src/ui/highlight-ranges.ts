/**
 * Highlight ranges — pure DOM helpers for wrapping flat-text ranges in
 * `<mark>` elements across element boundaries, and unwrapping them again.
 *
 * Shared by find-in-messages and the inline comment layer. Both features
 * collect text nodes fresh on every operation (never caching node references
 * across operations) and unwrap only their own marks, so one feature's
 * `splitText` / `normalize()` calls never invalidate the other's state.
 */

/** A text node and its start offset within the flattened text of its root. */
export interface TextNodeOffset {
	node: Text;
	start: number;
}

/** Flattened text of a root plus the per-node offset map. */
export interface FlatText {
	text: string;
	offsets: TextNodeOffset[];
}

/**
 * Collect non-empty text nodes under `root` in document order.
 *
 * @param skip - Optional predicate; text nodes inside an element for which it
 *   returns true (checked on every ancestor up to `root`) are excluded.
 */
export function collectTextNodes(root: Node, skip?: (el: Element) => boolean): Text[] {
	const textNodes: Text[] = [];
	const doc = root.ownerDocument ?? document;
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		if (!node.nodeValue || node.nodeValue.length === 0) continue;
		if (skip && isSkipped(node, root, skip)) continue;
		textNodes.push(node);
	}
	return textNodes;
}

function isSkipped(node: Node, root: Node, skip: (el: Element) => boolean): boolean {
	let current: Node | null = node.parentNode;
	while (current && current !== root) {
		if (current.nodeType === Node.ELEMENT_NODE && skip(current as Element)) return true;
		current = current.parentNode;
	}
	return false;
}

/** Concatenate text nodes into one string and record each node's start offset. */
export function buildFlatText(nodes: Text[]): FlatText {
	let text = "";
	const offsets: TextNodeOffset[] = [];
	for (const tn of nodes) {
		offsets.push({ node: tn, start: text.length });
		text += tn.nodeValue ?? "";
	}
	return { text, offsets };
}

/** Options for {@link wrapRange}. */
export interface WrapOptions {
	className: string;
	/** Extra `data-*` attributes to set on every mark (keys without the `data-` prefix). */
	dataset?: Record<string, string>;
}

/**
 * Wrap the flat-text range `[start, end)` in `<mark>` elements, one per
 * overlapped text node. Splits text nodes in place.
 *
 * When wrapping several ranges against the same `offsets`, process them from
 * last to first so earlier offsets stay valid.
 *
 * @returns The created marks in document order.
 */
export function wrapRange(
	offsets: TextNodeOffset[],
	start: number,
	end: number,
	opts: WrapOptions,
): HTMLElement[] {
	const marks: HTMLElement[] = [];
	if (end <= start) return marks;

	for (let i = offsets.length - 1; i >= 0; i--) {
		const { node, start: nodeStart } = offsets[i]!;
		const nodeEnd = nodeStart + node.length;

		// Skip nodes entirely outside the range
		if (nodeEnd <= start || nodeStart >= end) continue;

		const overlapStart = Math.max(start, nodeStart) - nodeStart;
		const overlapEnd = Math.min(end, nodeEnd) - nodeStart;

		// Split the text node to isolate the matched portion
		let targetNode = node;
		if (overlapEnd < targetNode.length) {
			targetNode.splitText(overlapEnd);
		}
		if (overlapStart > 0) {
			targetNode = targetNode.splitText(overlapStart);
		}

		const doc = targetNode.ownerDocument ?? document;
		const mark = doc.createElement("mark");
		mark.className = opts.className;
		if (opts.dataset) {
			for (const [k, v] of Object.entries(opts.dataset)) mark.dataset[k] = v;
		}
		targetNode.parentNode!.insertBefore(mark, targetNode);
		mark.appendChild(targetNode);
		marks.unshift(mark);
	}

	return marks;
}

/** Unwrap marks (moving their children back in place) and re-merge split text nodes. */
export function unwrapMarks(marks: Iterable<Element>): void {
	const parents = new Set<Node>();
	for (const mark of marks) {
		const parent = mark.parentNode;
		if (!parent) continue;
		while (mark.firstChild) {
			parent.insertBefore(mark.firstChild, mark);
		}
		parent.removeChild(mark);
		parents.add(parent);
	}
	for (const parent of parents) {
		parent.normalize();
	}
}
