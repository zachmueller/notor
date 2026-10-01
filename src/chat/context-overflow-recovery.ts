/**
 * Chat-level handling for context-overflow errors.
 *
 * Providers already record a limit when the error message includes one
 * (see `noteContextOverflow`). This covers the remaining case — messages with
 * no number, such as Bedrock's "Input is too long for requested model." —
 * by learning a conservative limit from Notor's own token estimate, and
 * builds the suggestion shown alongside the error.
 */

import type { Message } from "../types";
import type { NotorSettings } from "../settings";
import { parseContextOverflow } from "../providers/context-overflow";
import { getContextWindow } from "../providers/model-metadata";
import {
	getContextOverride,
	MIN_LEARNED_CONTEXT_WINDOW,
	recordLearnedContextWindow,
} from "../providers/model-limits";
import { estimateConversationTokens, shouldCompact } from "../context/compaction";

/** Fraction of the failed request's estimated size to learn as the new limit. */
const ESTIMATE_SAFETY_FACTOR = 0.9;

export interface ContextOverflowRecovery {
	isOverflow: boolean;
	/** Set when this call recorded a limit from the token estimate. */
	recorded?: { tokens: number; source: "estimate" };
	/** Text appended to the error shown in chat (leading space; empty when not an overflow). */
	suggestion: string;
}

/**
 * Classify a chat error as a context overflow, learn a limit from the
 * estimate when the provider gave none, and build the user-facing suggestion.
 *
 * @param input.messages - The conversation as sent (before the error is persisted).
 */
export function recoverFromContextOverflow(input: {
	rawMessage: string;
	modelId: string;
	useExtendedContext: boolean;
	messages: Message[];
	settings: NotorSettings;
}): ContextOverflowRecovery {
	const { rawMessage, modelId, useExtendedContext, messages, settings } = input;
	const overflow = parseContextOverflow(rawMessage);
	if (!overflow.isOverflow) return { isOverflow: false, suggestion: "" };

	const override = getContextOverride(modelId, useExtendedContext);
	if (override !== undefined) {
		return {
			isOverflow: true,
			suggestion:
				` Your context window override for "${modelId}" (${formatTokens(override)} tokens) is larger than the provider accepts.` +
				" Lower it in Settings → Notor → Reference → Model context limits.",
		};
	}

	let recorded: ContextOverflowRecovery["recorded"];
	// A numeric limit was already recorded by the provider — don't double-record.
	if (overflow.limit === undefined) {
		const window = getContextWindow(modelId, useExtendedContext);
		const estimate = estimateConversationTokens(messages);
		const learned = Math.floor(estimate * ESTIMATE_SAFETY_FACTOR);
		if (
			estimate < window &&
			learned >= MIN_LEARNED_CONTEXT_WINDOW &&
			recordLearnedContextWindow(modelId, useExtendedContext, learned, "estimate")
		) {
			recorded = { tokens: learned, source: "estimate" };
		}
	}

	// A numeric limit already appears in the error text itself.
	const limitNote = recorded
		? ` Notor will now treat this model's limit as about ${formatTokens(recorded.tokens)} tokens.`
		: "";
	const action = shouldCompact(messages, settings, modelId, useExtendedContext)
		? " Your next message will compact the conversation automatically."
		: " Run Notor: Compact context, or start a new conversation.";

	return { isOverflow: true, recorded, suggestion: limitNote + action };
}

function formatTokens(tokens: number): string {
	return tokens.toLocaleString("en-US");
}
