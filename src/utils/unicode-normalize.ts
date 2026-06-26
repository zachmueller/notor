const CHAR_NORMALIZE_MAP: Record<string, string> = {
	'—': '-', // em-dash
	'–': '-', // en-dash
	'−': '-', // minus sign
	'‐': '-', // hyphen
	'‑': '-', // non-breaking hyphen
	'­': '-', // soft hyphen

	'‘': "'", // left single quotation mark
	'’': "'", // right single quotation mark
	'‚': "'", // single low-9 quotation mark
	'‛': "'", // single high-reversed-9 quotation mark
	'′': "'", // prime

	'“': '"', // left double quotation mark
	'”': '"', // right double quotation mark
	'„': '"', // double low-9 quotation mark
	'‟': '"', // double high-reversed-9 quotation mark
	'″': '"', // double prime

	' ': ' ', // non-breaking space
	' ': ' ', // em space
	' ': ' ', // en space
	' ': ' ', // thin space
	' ': ' ', // hair space
	'​': '',  // zero-width space (removed)
	'﻿': '',  // BOM / zero-width no-break space (removed)

	'…': '...', // horizontal ellipsis
};

export interface NormalizeResult {
	normalized: string;
	posMap: number[];
}

export function normalizeForMatch(input: string): NormalizeResult {
	const nfc = input.normalize("NFC");
	const nfcLenMatchesInput = nfc.length === input.length;

	// Build NFC→original position map when NFC changes length (rare: decomposed diacritics)
	let nfcToOrig: number[] | null = null;
	if (!nfcLenMatchesInput) {
		nfcToOrig = buildNfcToOrigMap(input, nfc);
	}

	const posMap: number[] = [];
	let normalized = "";

	for (let i = 0; i < nfc.length; i++) {
		const ch = nfc[i]!;
		const origIdx = nfcLenMatchesInput ? i : nfcToOrig![i]!;
		const mapped = CHAR_NORMALIZE_MAP[ch];

		if (mapped !== undefined) {
			for (let j = 0; j < mapped.length; j++) {
				normalized += mapped[j];
				posMap.push(origIdx);
			}
		} else {
			normalized += ch;
			posMap.push(origIdx);
		}
	}

	return { normalized, posMap };
}

function buildNfcToOrigMap(original: string, nfc: string): number[] {
	// NFC composes combining sequences, so NFC is typically shorter or equal.
	// We align by iterating both strings and matching codepoints.
	// Strategy: iterate original and NFC in tandem using codepoints.
	const origCPs = [...original];
	const nfcCPs = [...nfc];
	const map: number[] = new Array(nfc.length);

	let oi = 0; // codepoint index into origCPs
	let ni = 0; // codepoint index into nfcCPs

	// Track UTF-16 offset for original
	const origUtf16Offsets: number[] = [];
	let offset = 0;
	for (const cp of origCPs) {
		origUtf16Offsets.push(offset);
		offset += cp.length;
	}

	// Track UTF-16 offset for NFC
	const nfcUtf16Offsets: number[] = [];
	offset = 0;
	for (const cp of nfcCPs) {
		nfcUtf16Offsets.push(offset);
		offset += cp.length;
	}

	// Simple heuristic: NFC compositions merge base + combining marks.
	// For each NFC codepoint, we assign it the original position of where
	// its corresponding base character started.
	// Since NFC only composes (never expands for our use case), we advance
	// through original faster than NFC when compositions happen.
	while (ni < nfcCPs.length) {
		const nfcUtf16Pos = nfcUtf16Offsets[ni]!;
		const origUtf16Pos = oi < origUtf16Offsets.length ? origUtf16Offsets[oi]! : origUtf16Offsets[origUtf16Offsets.length - 1]!;

		// Map this NFC UTF-16 range to the current original UTF-16 position
		const nfcCp = nfcCPs[ni]!;
		for (let k = 0; k < nfcCp.length; k++) {
			map[nfcUtf16Pos + k] = origUtf16Pos;
		}

		// Advance: figure out how many original codepoints this NFC codepoint consumed.
		// If the NFC codepoint is a precomposed character and original has base + combiners,
		// skip the combiners in original.
		ni++;
		oi++;

		// Skip combining marks in original that were composed into the NFC codepoint
		while (oi < origCPs.length && isCombiningMark(origCPs[oi]!)) {
			oi++;
		}
	}

	// Fill any remaining map entries (shouldn't happen, but defensive)
	const lastOrig = origUtf16Offsets.length > 0 ? origUtf16Offsets[origUtf16Offsets.length - 1]! : 0;
	for (let i = 0; i < map.length; i++) {
		if (map[i] === undefined) map[i] = lastOrig;
	}

	return map;
}

function isCombiningMark(cp: string): boolean {
	const code = cp.codePointAt(0)!;
	// Unicode combining diacritical marks: U+0300–U+036F (most common block)
	// Extended: U+1AB0–U+1AFF, U+1DC0–U+1DFF, U+20D0–U+20FF, U+FE20–U+FE2F
	return (code >= 0x0300 && code <= 0x036F) ||
		(code >= 0x1AB0 && code <= 0x1AFF) ||
		(code >= 0x1DC0 && code <= 0x1DFF) ||
		(code >= 0x20D0 && code <= 0x20FF) ||
		(code >= 0xFE20 && code <= 0xFE2F);
}

export interface NormalizedMatch {
	index: number;
	length: number;
}

export function normalizedIndexOf(haystack: string, needle: string): NormalizedMatch | null {
	if (needle.length === 0) return { index: 0, length: 0 };

	const h = normalizeForMatch(haystack);
	const n = normalizeForMatch(needle);

	if (n.normalized.length === 0) return { index: 0, length: 0 };

	const matchStart = h.normalized.indexOf(n.normalized);
	if (matchStart === -1) return null;

	const matchEnd = matchStart + n.normalized.length - 1;

	const origStart = h.posMap[matchStart]!;
	const lastMatchedOrigIdx = h.posMap[matchEnd]!;

	// The matched region in the original string extends from origStart to
	// the end of the character at lastMatchedOrigIdx. Since posMap points to
	// the start of the original character, we need +1 to get past it.
	// But if the original char at that position was multi-char mapped (e.g., the
	// NFC char is a surrogate pair), we need the actual char length.
	// For BMP characters (all in our map), +1 is correct.
	const origLength = lastMatchedOrigIdx - origStart + 1;

	return { index: origStart, length: origLength };
}

// ---------------------------------------------------------------------------
// Resilient (tiered) matching
// ---------------------------------------------------------------------------
//
// `resilientIndexOf` layers structural fallbacks on top of the Unicode
// normalization above so find/replace edits survive realistic drift
// (indentation changes, trailing whitespace, single-vs-double spaces) without
// the AI having to reproduce the note byte-for-byte. Tiers are tried in order
// and the FIRST tier that yields any candidate decides the outcome:
//
//   1. Exact (normalized)        — current behaviour, fastest, tightest.
//   2. Line-trimmed              — compare line-by-line ignoring each line's
//                                  leading/trailing whitespace.
//   3. Intra-line whitespace     — additionally collapse runs of spaces/tabs
//      flexible                    within each line (newlines stay significant).
//
// Within whichever tier first produces candidates, more than one distinct
// match is reported as `not_unique` rather than silently editing the first
// occurrence — and we do NOT fall through to a looser tier, because multiple
// matches at a tighter tier is a disambiguation signal, not a reason to loosen.
//
// All returned offsets are in ORIGINAL-haystack coordinates. The line-based
// tiers replace whole matched lines (the span starts at column 0 of the first
// matched line and ends at the last content character of the last matched line,
// excluding its trailing newline) so the caller's `replace` text controls the
// resulting indentation — mirroring Cline's line-trimmed fallback.

export interface ResilientMatch {
	/** Start offset in the ORIGINAL haystack. */
	index: number;
	/** Length of the matched span in the ORIGINAL haystack. */
	length: number;
}

export type ResilientResult =
	| { ok: true; match: ResilientMatch }
	| { ok: false; reason: "not_found" | "not_unique"; count?: number };

/**
 * Map a span expressed in normalized coordinates back to original-haystack
 * coordinates via the position map. `normLastInclusive` is the index of the
 * last included normalized character. Returns null for degenerate spans.
 */
function mapNormSpanToOrig(
	posMap: number[],
	normStart: number,
	normLastInclusive: number,
): ResilientMatch | null {
	if (normStart >= posMap.length) return null;
	if (normLastInclusive < normStart) return null;
	const lastInclusive = Math.min(normLastInclusive, posMap.length - 1);
	const origStart = posMap[normStart]!;
	const lastOrig = posMap[lastInclusive]!;
	return { index: origStart, length: lastOrig - origStart + 1 };
}

/** Collapse a candidate list into a ResilientResult, deduping by span. */
function finalizeCandidates(candidates: ResilientMatch[]): ResilientResult {
	if (candidates.length === 0) return { ok: false, reason: "not_found" };

	const seen = new Set<string>();
	const unique: ResilientMatch[] = [];
	for (const c of candidates) {
		const key = `${c.index}:${c.length}`;
		if (!seen.has(key)) {
			seen.add(key);
			unique.push(c);
		}
	}

	if (unique.length === 1) return { ok: true, match: unique[0]! };
	return { ok: false, reason: "not_unique", count: unique.length };
}

/** Tier 1: every occurrence of the normalized needle in the normalized haystack. */
function exactNormalizedCandidates(h: NormalizeResult, n: NormalizeResult): ResilientMatch[] {
	const candidates: ResilientMatch[] = [];
	const needleLen = n.normalized.length;
	let from = 0;
	for (;;) {
		const idx = h.normalized.indexOf(n.normalized, from);
		if (idx === -1) break;
		const m = mapNormSpanToOrig(h.posMap, idx, idx + needleLen - 1);
		if (m) candidates.push(m);
		from = idx + 1; // advance by one to catch overlapping occurrences
	}
	return candidates;
}

/**
 * Tiers 2 & 3: match line-by-line after applying `lineTransform` to each line
 * (trim for tier 2; collapse-intra-line-whitespace + trim for tier 3). Both
 * tiers share this machinery because both replace whole lines, so the matched
 * span is always line-bounded regardless of the transform.
 */
function lineBasedCandidates(
	h: NormalizeResult,
	n: NormalizeResult,
	lineTransform: (line: string) => string,
): ResilientMatch[] {
	const hLines = h.normalized.split("\n");
	const nLines = n.normalized.split("\n");

	// Drop a single trailing empty needle line — the artifact of a search block
	// that ends with a newline — so it doesn't require a trailing blank line.
	if (nLines.length > 1 && nLines[nLines.length - 1] === "") nLines.pop();

	const hT = hLines.map(lineTransform);
	const nT = nLines.map(lineTransform);

	// Degenerate needle (all blank after transform) can't anchor a match.
	if (nT.length === 0 || nT.every((l) => l === "")) return [];

	// Normalized-space start offset of each haystack line.
	const hLineStart: number[] = new Array(hLines.length);
	let off = 0;
	for (let i = 0; i < hLines.length; i++) {
		hLineStart[i] = off;
		off += hLines[i]!.length + 1; // +1 for the consumed "\n"
	}

	const candidates: ResilientMatch[] = [];
	const maxStart = hLines.length - nT.length;
	for (let i = 0; i <= maxStart; i++) {
		let matched = true;
		for (let j = 0; j < nT.length; j++) {
			if (hT[i + j] !== nT[j]) {
				matched = false;
				break;
			}
		}
		if (!matched) continue;

		const lastLineIdx = i + nT.length - 1;
		const normStart = hLineStart[i]!;
		// End at the last content character of the last matched line (exclude its
		// trailing newline) so `replace` text governs the trailing newline.
		const normLastInclusive = hLineStart[lastLineIdx]! + hLines[lastLineIdx]!.length - 1;
		const m = mapNormSpanToOrig(h.posMap, normStart, normLastInclusive);
		if (m) candidates.push(m);
	}

	return candidates;
}

/**
 * Find `needle` in `haystack` using tiered, drift-tolerant matching with
 * uniqueness enforcement. See the block comment above for tier semantics.
 */
export function resilientIndexOf(haystack: string, needle: string): ResilientResult {
	if (needle.length === 0) return { ok: true, match: { index: 0, length: 0 } };

	const h = normalizeForMatch(haystack);
	const n = normalizeForMatch(needle);

	if (n.normalized.length === 0) return { ok: true, match: { index: 0, length: 0 } };

	// Tier 1: exact (normalized).
	const t1 = finalizeCandidates(exactNormalizedCandidates(h, n));
	if (t1.ok || t1.reason === "not_unique") return t1;

	// Tier 2: line-trimmed.
	const t2 = finalizeCandidates(lineBasedCandidates(h, n, (l) => l.trim()));
	if (t2.ok || t2.reason === "not_unique") return t2;

	// Tier 3: intra-line whitespace-flexible (lines have no "\n", so /\s+/ is
	// safe — it collapses spaces/tabs/CR but never crosses a line boundary).
	const t3 = finalizeCandidates(lineBasedCandidates(h, n, (l) => l.replace(/\s+/g, " ").trim()));
	if (t3.ok || t3.reason === "not_unique") return t3;

	return { ok: false, reason: "not_found" };
}
