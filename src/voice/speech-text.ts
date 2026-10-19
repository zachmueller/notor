/**
 * Turn chat markdown into text that reads well aloud.
 *
 * Used for the no-LLM fallbacks (speaking the last assistant message when the
 * summary pass fails) and for trimming spoken lines to a length budget.
 */

/** Strip markdown, links, code and tables so `say` does not read syntax aloud. */
export function toSpeakableText(markdown: string): string {
	let t = markdown;
	t = t.replace(/```[\s\S]*?```/g, " code omitted. ");
	t = t.replace(/~~~[\s\S]*?~~~/g, " code omitted. ");
	t = t.replace(/<[^>\n]+>/g, " ");
	t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
	t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
	t = t.replace(/\[\[([^\]]+)\]\]/g, "$1");
	t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
	t = t.replace(/https?:\/\/[^\s<>()]+/g, (url) => `a link${/[.,;:!?]+$/.exec(url)?.[0] ?? ""}`);
	t = t.replace(/`([^`]*)`/g, "$1");
	t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
	t = t.replace(/^\s*>\s?/gm, "");
	t = t.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "");
	t = t.replace(/^\s*[-*+]\s+/gm, "");
	t = t.replace(/^\s*\d+[.)]\s+/gm, "");
	t = t.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "");
	t = t.replace(/\|/g, ", ");
	t = t.replace(/(\*\*|__)(.*?)\1/g, "$2");
	t = t.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,;:!?]|$)/g, "$1$2");
	t = t.replace(/^\s*[-*_]{3,}\s*$/gm, "");
	t = t.replace(/[ \t]+/g, " ");
	t = t.replace(/\s*\n\s*\n\s*/g, "\n");
	return t.trim();
}

/** Cut `text` to roughly `maxChars`, preferring a sentence boundary, then a word boundary. */
export function truncateForSpeech(text: string, maxChars: number): string {
	const trimmed = text.trim();
	if (maxChars <= 0 || trimmed.length <= maxChars) return trimmed;
	const cut = trimmed.slice(0, maxChars);
	const sentenceEnd = Math.max(
		cut.lastIndexOf(". "),
		cut.lastIndexOf("! "),
		cut.lastIndexOf("? "),
		cut.lastIndexOf(".\n"),
	);
	if (sentenceEnd >= maxChars * 0.5) return cut.slice(0, sentenceEnd + 1).trim();
	const wordEnd = cut.lastIndexOf(" ");
	return `${(wordEnd > 0 ? cut.slice(0, wordEnd) : cut).trim()}…`;
}

/** First `count` sentences of `text` (whole text when it has fewer). */
export function firstSentences(text: string, count: number): string {
	const parts = text.trim().match(/[^.!?\n]+[.!?]+(\s|$)|[^.!?\n]+$/g);
	if (!parts) return text.trim();
	return parts.slice(0, Math.max(1, count)).join("").trim();
}
