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

function estimateImageTokens(width?: number, height?: number, provider?: string): number {
	if (width != null && height != null) {
		if (provider === "openai") {
			// OpenAI GPT-4 Vision tile-based formula (high detail mode)
			return 170 * Math.ceil(width / 512) * Math.ceil(height / 512) + 85;
		}
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
 *
 * @param provider - Optional provider type for provider-specific token formulas (e.g., "openai" uses tile-based image estimation).
 */
export function estimateContentTokens(content: string | ContentBlock[], provider?: string): number {
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
				total += estimateImageTokens(block.width, block.height, provider);
				break;
			case "document":
				total += estimateDocumentTokens(block.page_count);
				break;
			case "custom_block":
				if (block.estimated_wire_tokens != null) {
					total += block.estimated_wire_tokens;
				} else if (block.fallback_text != null) {
					total += estimateTokenCount(block.fallback_text);
				} else {
					total += estimateTokenCount(JSON.stringify(block.data));
				}
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

import type { PersistedAttachmentMeta } from "../types";

/**
 * Estimate the wire tokens contributed by a message's attachment snapshots.
 *
 * Part 3 stores attachment content in the per-message `attachments` snapshot
 * instead of in the message `content` string, and rebuilds the `<attachments>`
 * block only at dispatch. Token estimation over the (now prose-only) stored
 * `content` would therefore under-count and let truncation/compaction over-fill
 * the real context window. This helper re-adds the attachment cost from the
 * snapshot so estimates stay aligned with what is actually sent.
 *
 * Only new-format (snapshot-bearing) entries are counted; legacy entries whose
 * content is still embedded in `content` return 0 here to avoid double-counting.
 *
 * @param provider - Optional provider type for provider-specific image formulas.
 */
export function estimateAttachmentSnapshotTokens(
	attachments: PersistedAttachmentMeta[] | null | undefined,
	provider?: string,
): number {
	if (!attachments || attachments.length === 0) return 0;
	let total = 0;
	for (const att of attachments) {
		const isSnapshot = att.content != null || att.content_hash != null || att.binary_content != null;
		if (!isSnapshot) continue;
		if (att.content != null) {
			// Text notes/sections/PDF-text: content plus a small XML-wrapper overhead.
			total += estimateTokenCount(att.content) + 8;
		}
		if (att.type === "vault_image" || att.type === "external_image") {
			total += estimateImageTokens(att.width ?? undefined, att.height ?? undefined, provider);
		} else if (att.type === "vault_pdf" || att.type === "external_pdf") {
			// content_length carries the page count for native document blocks.
			if (att.binary_content != null || att.content_hash != null) {
				total += estimateDocumentTokens(att.content_length ?? undefined);
			}
		}
	}
	return total;
}
