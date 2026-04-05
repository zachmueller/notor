/**
 * Token estimation utility for context window tracking and cost calculation.
 *
 * Uses a lightweight character-based estimation suitable for bundling —
 * no external API calls or large dependencies required.
 *
 * The heuristic targets ~10% accuracy relative to actual tokenizer output
 * (GPT/Claude tokenizers average ~4 characters per token for English text,
 * with variation for code, punctuation, and non-Latin scripts).
 */

/**
 * Average characters per token.
 *
 * Empirically, GPT and Claude tokenizers produce roughly 1 token per
 * 4 characters of English prose. Code and structured text tend toward
 * ~3.5 chars/token; non-Latin scripts can be higher.
 *
 * 4.0 is a conservative middle ground that slightly overestimates token
 * count, which is safer for context window tracking (better to truncate
 * a little early than to exceed the limit).
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate the token count for a given text.
 *
 * This is a fast, client-side-only approximation suitable for:
 * - Context window tracking (when to warn/truncate)
 * - Cost estimation display
 *
 * It is NOT suitable for exact billing calculations — providers report
 * actual token counts in their responses, which should be preferred
 * when available.
 *
 * @param text - The text to estimate tokens for.
 * @returns Estimated token count (always >= 0).
 */
export function estimateTokenCount(text: string): number {
	if (!text) {
		return 0;
	}
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Media-aware token estimation
// ---------------------------------------------------------------------------

import type { ContentBlock } from "../media/types";

function estimateImageTokens(width?: number, height?: number): number {
	if (width != null && height != null) {
		return Math.ceil((width * height) / 750);
	}
	return 2000;
}

function estimateDocumentTokens(pageCount?: number): number {
	if (pageCount != null) {
		return pageCount * 2000;
	}
	return 2000;
}

/**
 * Estimate tokens for content that may be a string or ContentBlock[].
 *
 * For strings, delegates to estimateTokenCount().
 * For ContentBlock[], sums per-block estimates using type-specific heuristics.
 */
export function estimateContentTokens(content: string | ContentBlock[]): number {
	if (typeof content === "string") {
		return estimateTokenCount(content);
	}
	let total = 0;
	for (const block of content) {
		switch (block.type) {
			case "text":
				total += estimateTokenCount(block.text);
				break;
			case "image":
				total += estimateImageTokens(block.width, block.height);
				break;
			case "document":
				total += estimateDocumentTokens(block.page_count);
				break;
		}
	}
	return total;
}

/**
 * Alias for {@link estimateTokenCount} matching the Phase 3 task spec name.
 *
 * Used by auto-compaction and context assembly modules.
 *
 * @param text - The text to estimate tokens for (handles empty/null/undefined).
 * @returns Estimated token count (always >= 0).
 */
export const estimateTokens = estimateTokenCount;
