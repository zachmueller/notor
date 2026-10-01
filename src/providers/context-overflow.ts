/**
 * Context-overflow error detection and limit learning.
 *
 * Providers word "your prompt exceeds the context window" differently, and
 * several include the real limit in the message. This module recognizes those
 * messages, extracts the limit when present, and records it in the
 * model-limits registry so the next request compacts at the right point.
 *
 * Messages that merely mention tokens but are NOT context overflows — Bedrock
 * throttling ("Too many tokens, please wait"), Anthropic's output cap
 * ("max_tokens: N > M, which is the maximum allowed number of output
 * tokens"), 413 byte-size limits, "invalid beta flag" — must not match.
 */

import { describeContextWindow } from "./model-metadata";
import { recordLearnedContextWindow } from "./model-limits";

export interface ContextOverflowInfo {
	isOverflow: boolean;
	/** The provider-reported context limit, when the message includes one. */
	limit?: number;
}

const OVERFLOW_PATTERNS: RegExp[] = [
	/prompt is too long/i, // Anthropic; Bedrock-wrapped Anthropic
	/input is too long/i, // Bedrock "Input is too long for requested model."
	/exceed context limit/i, // Anthropic "input length and `max_tokens` exceed context limit"
	/context[_ ]length[_ ]exceeded/i, // OpenAI error code
	/maximum context length/i, // OpenAI / vLLM
	/input tokens? exceeds? the (?:configured )?limit/i, // OpenAI configured limit
	/exceeds? the (?:available )?context (?:size|window|length)/i, // llama.cpp
	/exceed_context_size_error/i, // llama.cpp error type
	/context length of only \d/i, // LM Studio
	/greater than the context length/i, // LM Studio
];

/** Limit extractors, tried in order; `group` is the capture holding the limit. */
const LIMIT_PATTERNS: Array<{ re: RegExp; group: number }> = [
	{ re: /([\d,]+)\s*tokens?\s*>\s*([\d,]+)\s*maximum/i, group: 2 }, // "N tokens > M maximum"
	{ re: /exceed context limit:\s*([\d,]+)\s*\+\s*([\d,]+)\s*>\s*([\d,]+)/i, group: 3 }, // "a + b > c"
	{ re: /maximum context length is\s*([\d,]+)/i, group: 1 },
	{ re: /limit of\s*([\d,]+)\s*tokens/i, group: 1 },
	{ re: /context size \(([\d,]+) tokens?\)/i, group: 1 }, // llama.cpp
	{ re: /"n_ctx"\s*:\s*(\d+)/i, group: 1 }, // llama.cpp JSON body
	{ re: /context length of only\s*([\d,]+)/i, group: 1 }, // LM Studio
];

/** Plausible context window range; anything outside is a mis-parse. */
const MIN_PLAUSIBLE_LIMIT = 1_000;
const MAX_PLAUSIBLE_LIMIT = 50_000_000;

/**
 * Classify a provider error message as a context overflow and extract the
 * reported limit, if any.
 */
export function parseContextOverflow(raw: string | null | undefined): ContextOverflowInfo {
	if (!raw) return { isOverflow: false };
	if (!OVERFLOW_PATTERNS.some((re) => re.test(raw))) return { isOverflow: false };

	for (const { re, group } of LIMIT_PATTERNS) {
		const match = re.exec(raw);
		const digits = match?.[group]?.replace(/,/g, "");
		if (!digits) continue;
		const limit = Number(digits);
		if (Number.isFinite(limit) && limit >= MIN_PLAUSIBLE_LIMIT && limit <= MAX_PLAUSIBLE_LIMIT) {
			return { isOverflow: true, limit };
		}
	}
	return { isOverflow: true };
}

/**
 * Classify an error message and, when it reports a limit below the model's
 * current base window, record that limit for the model + context mode.
 *
 * Called by providers at the point they classify an error, so every caller
 * (chat, sub-agents, compaction, workflows) learns from it.
 */
export function noteContextOverflow(
	modelId: string,
	useExtendedContext: boolean | undefined,
	raw: string | null | undefined
): ContextOverflowInfo & { recorded: boolean } {
	const info = parseContextOverflow(raw);
	if (!info.isOverflow || info.limit === undefined || !modelId.trim()) {
		return { ...info, recorded: false };
	}
	// A limit at or above the current window teaches nothing — the window was
	// right and the request was simply too big.
	const { base } = describeContextWindow(modelId, useExtendedContext);
	const recorded = info.limit < base
		? recordLearnedContextWindow(modelId, useExtendedContext, info.limit, "error")
		: false;
	return { ...info, recorded };
}

/** User-facing message for a context-overflow ProviderError. */
export function contextOverflowMessage(limit?: number): string {
	return limit !== undefined
		? `Context length exceeded for this model (limit ${limit.toLocaleString("en-US")} tokens).`
		: "Context length exceeded for this model.";
}
