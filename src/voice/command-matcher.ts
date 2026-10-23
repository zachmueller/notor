/**
 * Wake-word residue stripping.
 *
 * Capture starts at the keyword spotter's hit, but whisper often still hears
 * (part of) the wake word at the start of the utterance — "Hey Notor,",
 * "Hey Nota", "no tor", or just "tor". Matching is case-insensitive, ignores
 * punctuation, and is fuzzy on the wake word's last word. The text after the
 * wake word keeps its original casing and punctuation, because free-text
 * answers need them.
 */

/** Lowercase, strip punctuation, collapse whitespace. */
export function normalizeSpoken(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Levenshtein distance (small strings only). */
function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
		}
		prev = row;
	}
	return prev[b.length]!;
}

/** One edit is allowed on longer words only, so real words ("note", "not") are not mistaken for it. */
function closeTo(heard: string, target: string): boolean {
	return target.length >= 5 ? editDistance(heard, target) <= 1 : heard === target;
}

/**
 * Remove a leading wake word (or what whisper made of it) from `transcript`.
 * `wakeWord` may list alternative spellings ("Hey Nota"); any of them match.
 * Returns the transcript unchanged when it does not start with the wake word.
 */
export function stripWakeWord(transcript: string, wakeWord: string | readonly string[]): string {
	const spellings = (typeof wakeWord === "string" ? [wakeWord] : wakeWord)
		.map((spelling) => normalizeSpoken(spelling).split(" ").filter(Boolean))
		.filter((words) => words.length > 0);
	if (spellings.length === 0) return transcript.trim();
	const lastWords = [...new Set(spellings.map((words) => words[words.length - 1]!))];
	const maxLead = Math.max(...spellings.map((words) => words.length));
	const isLast = (word: string) => lastWords.some((last) => closeTo(word, last));

	const tokens = [...transcript.matchAll(/[\p{L}\p{N}]+/gu)].map((m) => ({
		word: m[0].toLowerCase(),
		end: m.index + m[0].length,
	}));

	// The wake word's last word may be preceded by at most the remaining wake
	// words (garbled or not); whisper sometimes splits it in two ("no tor").
	let end = -1;
	for (let k = 0; k < Math.min(tokens.length, maxLead); k++) {
		const token = tokens[k]!;
		const next = tokens[k + 1];
		if (isLast(token.word)) {
			end = token.end;
			break;
		}
		if (next && isLast(token.word + next.word)) {
			end = next.end;
			break;
		}
	}
	// Capture can begin inside the wake word, leaving only its tail ("tor").
	const first = tokens[0];
	const isTail = (word: string) => word.length >= 3 && lastWords.some((last) => word.length < last.length && last.endsWith(word));
	if (end < 0 && first && isTail(first.word)) {
		end = first.end;
	}
	if (end < 0) return transcript.trim();

	// Drop separators left over from the wake word ("Hey Notor, approve").
	return transcript.slice(end).replace(/^[\s\p{P}]+/u, "").trim();
}
