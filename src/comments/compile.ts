/**
 * Compile accumulated inline comments into one follow-up message.
 *
 * Format (quoted text with inline comments):
 *
 * ```
 * Comments on your previous response:
 *
 * > "selected text"
 * My comment about this
 *
 * > "another passage"
 * Another comment
 * ```
 */

import type { AnchoredComment } from "./types";

/** Default cap on quoted characters per comment before middle-truncation. */
export const MAX_QUOTE_CHARS = 400;

export interface CompileItem {
	comment: AnchoredComment;
	/** True when the anchor no longer resolves (e.g. the message was compacted). */
	orphaned?: boolean;
}

export interface CompileGroup {
	scopeId: string;
	/** Header shown only when comments span more than one scope (e.g. "In message 3"). */
	label?: string;
	items: CompileItem[];
}

export interface CompileOptions {
	/** First line of the batch. Defaults to "Comments on your previous response:". */
	intro?: string;
	maxQuoteChars?: number;
	/** Suffix appended to orphaned quotes. */
	orphanNote?: string;
}

/** Truncate long text in the middle with an ellipsis, keeping both ends. */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.max(2, max - 1);
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}

/** Render one quote as `> "…"` lines, quoting every line of a multi-line selection. */
export function formatQuote(quote: string, maxChars: number, note?: string): string {
	const cleaned = quote
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l, i, arr) => l.length > 0 || (i > 0 && i < arr.length - 1 && arr[i - 1]!.length > 0))
		.join("\n")
		.trim();
	const lines = truncateMiddle(cleaned, maxChars).split("\n");
	const last = lines.length - 1;
	return lines
		.map((line, i) => {
			let out = line;
			if (i === 0) out = `"${out}`;
			if (i === last) out = `${out}"${note ? ` ${note}` : ""}`;
			return `> ${out}`.trimEnd();
		})
		.join("\n");
}

/** Build the batch message. Returns "" when there are no comments. */
export function compileComments(groups: CompileGroup[], opts: CompileOptions = {}): string {
	const nonEmpty = groups.filter((g) => g.items.length > 0);
	if (nonEmpty.length === 0) return "";

	const maxChars = opts.maxQuoteChars ?? MAX_QUOTE_CHARS;
	const orphanNote = opts.orphanNote ?? "(from an earlier message)";
	const showLabels = nonEmpty.length > 1;
	const blocks: string[] = [opts.intro ?? "Comments on your previous response:"];

	for (const group of nonEmpty) {
		if (showLabels && group.label) blocks.push(`**${group.label}:**`);
		for (const { comment, orphaned } of group.items) {
			const quoteSource = comment.quote.trim() ? comment.quote : comment.anchor.exact;
			const quote = formatQuote(quoteSource, maxChars, orphaned ? orphanNote : undefined);
			blocks.push(`${quote}\n${comment.body.trim()}`);
		}
	}

	return blocks.join("\n\n");
}
