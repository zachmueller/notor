/**
 * Text-quote anchoring for the inline comment layer.
 *
 * Capture maps a DOM `Range` onto a scope's flattened text (the same text-node
 * flattening find-in-messages uses). Resolve searches the re-rendered flat
 * text for the passage, tolerating whitespace differences, and disambiguates
 * repeated passages by prefix/suffix overlap and then occurrence index.
 */

import { buildFlatText, collectTextNodes, type TextNodeOffset } from "../ui/highlight-ranges";
import type { CommentAnchor } from "./types";

/** Characters of context captured on each side of the selection. */
export const ANCHOR_CONTEXT_CHARS = 32;

/** Whitespace-collapsed text with a map from normalized index → raw index. */
interface NormalizedText {
	norm: string;
	map: number[];
}

/** Collapse every whitespace run to one space, recording raw positions. */
export function normalizeWithMap(raw: string): NormalizedText {
	let norm = "";
	const map: number[] = [];
	let inSpace = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (/\s/.test(ch)) {
			if (inSpace) continue;
			inSpace = true;
			norm += " ";
			map.push(i);
		} else {
			inSpace = false;
			norm += ch;
			map.push(i);
		}
	}
	return { norm, map };
}

function normalize(raw: string): string {
	return raw.replace(/\s+/g, " ");
}

/**
 * Translate a DOM boundary point into an offset within the flattened text.
 * Boundaries inside skipped subtrees snap to the next included text node.
 */
function flatOffsetOf(container: Node, offset: number, offsets: TextNodeOffset[], total: number): number {
	if (container.nodeType === Node.TEXT_NODE) {
		const entry = offsets.find((o) => o.node === container);
		if (entry) return entry.start + Math.min(offset, entry.node.length);
	}
	const doc = container.ownerDocument ?? document;
	const boundary = doc.createRange();
	boundary.setStart(container, offset);
	boundary.collapse(true);
	// An element-container boundary can never fall inside an included text
	// node, so the offset is the start of the first node at/after the point.
	for (const entry of offsets) {
		if (boundary.comparePoint(entry.node, 0) >= 0) return entry.start;
	}
	return total;
}

/**
 * Compute a text-quote anchor for `range` within `scopeEl`.
 *
 * Leading/trailing whitespace is trimmed from the selection. Returns null when
 * the selection is empty or lies entirely outside the scope's included text.
 *
 * @param skip - Predicate excluding subtrees (thinking blocks, token footers…)
 *   from the scope text; must match what the layer uses when highlighting.
 */
export function captureAnchor(
	range: Range,
	scopeEl: HTMLElement,
	scopeId: string,
	skip?: (el: Element) => boolean,
): CommentAnchor | null {
	const { text, offsets } = buildFlatText(collectTextNodes(scopeEl, skip));
	if (!text) return null;

	let start = flatOffsetOf(range.startContainer, range.startOffset, offsets, text.length);
	let end = flatOffsetOf(range.endContainer, range.endOffset, offsets, text.length);
	if (end < start) [start, end] = [end, start];

	while (start < end && /\s/.test(text[start]!)) start++;
	while (end > start && /\s/.test(text[end - 1]!)) end--;
	if (end <= start) return null;

	const exact = text.slice(start, end);
	const prefix = text.slice(Math.max(0, start - ANCHOR_CONTEXT_CHARS), start);
	const suffix = text.slice(end, end + ANCHOR_CONTEXT_CHARS);

	// Occurrence index among normalized matches that start before `start`.
	const { norm, map } = normalizeWithMap(text);
	const needle = normalize(exact);
	let occurrence = 0;
	let from = 0;
	for (;;) {
		const idx = norm.indexOf(needle, from);
		if (idx === -1 || map[idx]! >= start) break;
		occurrence++;
		from = idx + 1;
	}

	return { scopeId, exact, prefix, suffix, occurrence };
}

function commonSuffixLength(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

function commonPrefixLength(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

/**
 * Locate an anchor in freshly flattened scope text.
 *
 * @returns Raw `[start, end)` offsets into `flatText`, or null when the
 *   passage no longer exists (the comment is then "orphaned").
 */
export function resolveAnchor(anchor: CommentAnchor, flatText: string): { start: number; end: number } | null {
	const needle = normalize(anchor.exact).trim();
	if (!needle) return null;
	const { norm, map } = normalizeWithMap(flatText);

	const candidates: number[] = [];
	let from = 0;
	for (;;) {
		const idx = norm.indexOf(needle, from);
		if (idx === -1) break;
		candidates.push(idx);
		from = idx + 1;
	}
	if (candidates.length === 0) return null;

	let best = candidates[0]!;
	if (candidates.length > 1) {
		const prefix = normalize(anchor.prefix);
		const suffix = normalize(anchor.suffix);
		let bestScore = -1;
		let bestDistance = Infinity;
		candidates.forEach((idx, i) => {
			const before = norm.slice(Math.max(0, idx - prefix.length - 1), idx);
			const after = norm.slice(idx + needle.length, idx + needle.length + suffix.length + 1);
			const score = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
			const distance = Math.abs(i - anchor.occurrence);
			if (score > bestScore || (score === bestScore && distance < bestDistance)) {
				best = idx;
				bestScore = score;
				bestDistance = distance;
			}
		});
	}

	const start = map[best]!;
	const end = map[best + needle.length - 1]! + 1;
	return { start, end };
}
