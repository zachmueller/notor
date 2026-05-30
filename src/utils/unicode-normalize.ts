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
