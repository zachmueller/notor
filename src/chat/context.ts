/**
 * Context window management — token tracking and truncation.
 *
 * Monitors cumulative tokens against the active model's context limit.
 * Truncates oldest messages when approaching the limit while preserving
 * the system prompt and recent messages.
 *
 * @see specs/01-mvp/spec.md — FR-4 (context window overflow)
 * @see specs/01-mvp/data-model.md — Message.truncated field
 * @see design/architecture.md — Context window management
 */

import type { Message } from "../types";
import { estimateTokenCount } from "../utils/tokens";
import { getContextWindow } from "../providers/model-metadata";
import { logger } from "../utils/logger";

const log = logger("ContextManager");

/** Default threshold at which truncation begins (% of context window). */
const DEFAULT_TRUNCATION_THRESHOLD = 0.9;

/** Result of context window assembly. */
export interface ContextWindowResult {
	/** Messages to send to the LLM (excludes truncated). */
	messages: Message[];
	/** Total estimated tokens in the context window. */
	totalTokens: number;
	/** Context window limit for the active model. */
	contextLimit: number;
	/** Whether any messages were truncated. */
	wasTruncated: boolean;
	/** Number of messages truncated. */
	truncatedCount: number;
}

/**
 * Manages context window tracking and truncation for conversations.
 */
export class ContextManager {
	/** Truncation threshold as a fraction of context window (0-1). */
	private threshold: number;

	constructor(threshold: number = DEFAULT_TRUNCATION_THRESHOLD) {
		this.threshold = threshold;
	}

	/**
	 * Update the truncation threshold.
	 */
	setThreshold(threshold: number): void {
		this.threshold = Math.max(0.5, Math.min(1.0, threshold));
	}

	/**
	 * Track cumulative token count across all messages.
	 *
	 * @param messages - All messages in the conversation
	 * @returns Total estimated token count
	 */
	estimateTotalTokens(messages: Message[]): number {
		let total = 0;
		for (const msg of messages) {
			if (!msg.truncated) {
				total += this.estimateMessageTokens(msg);
			}
		}
		return total;
	}

	/**
	 * Estimate tokens for a single message.
	 *
	 * Uses actual token counts from LLM responses when available,
	 * falls back to character-based estimation.
	 */
	estimateMessageTokens(message: Message): number {
		// For assistant messages, prefer actual output tokens if available
		if (message.role === "assistant" && message.output_tokens) {
			return message.output_tokens;
		}

		// For messages with known input tokens (from LLM usage data)
		if (message.input_tokens) {
			return message.input_tokens;
		}

		// Fall back to estimation
		let text = message.content;

		// Include tool call/result content in estimation
		if (message.tool_call) {
			text += JSON.stringify(message.tool_call.parameters);
		}
		if (message.tool_result) {
			const result = message.tool_result.result;
			text += typeof result === "string" ? result : JSON.stringify(result);
		}

		return estimateTokenCount(text);
	}

	/**
	 * Assemble the context window for sending to the LLM.
	 *
	 * When the total tokens approach the model's context limit,
	 * marks oldest non-system messages as truncated. System prompts
	 * are never truncated. Recent messages are preserved.
	 *
	 * @param messages - All messages in the conversation (mutated: truncated flag set)
	 * @param modelId - The active model ID for context window lookup
	 * @returns Context window assembly result
	 */
	assembleContextWindow(messages: Message[], modelId: string): ContextWindowResult {
		const contextLimit = getContextWindow(modelId);
		const tokenBudget = Math.floor(contextLimit * this.threshold);

		// Reset all truncation flags
		for (const msg of messages) {
			msg.truncated = false;
		}

		// Calculate total tokens
		let totalTokens = 0;
		const tokenCounts: number[] = [];

		for (const msg of messages) {
			const tokens = this.estimateMessageTokens(msg);
			tokenCounts.push(tokens);
			totalTokens += tokens;
		}

		let truncatedCount = 0;

		// If under budget, no truncation needed
		if (totalTokens <= tokenBudget) {
			return {
				messages: [...messages],
				totalTokens,
				contextLimit,
				wasTruncated: false,
				truncatedCount: 0,
			};
		}

		// Need to truncate — find how many tokens to cut
		let tokensToRemove = totalTokens - tokenBudget;

		log.info("Context window truncation needed", {
			totalTokens,
			tokenBudget,
			contextLimit,
			tokensToRemove,
			messageCount: messages.length,
		});

		// Truncate from oldest non-system messages forward
		// System messages (index 0 typically) are never truncated
		for (let i = 0; i < messages.length && tokensToRemove > 0; i++) {
			const currentMsg = messages[i];
			if (!currentMsg) continue;

			// Never truncate system messages
			if (currentMsg.role === "system") {
				continue;
			}

			// Mark as truncated
			currentMsg.truncated = true;
			tokensToRemove -= (tokenCounts[i] ?? 0);
			truncatedCount++;
		}

		// Recalculate total for non-truncated messages
		let remainingTokens = 0;
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (m && !m.truncated) {
				remainingTokens += (tokenCounts[i] ?? 0);
			}
		}

		const nonTruncated = messages.filter((m) => !m.truncated);

		log.info("Context window truncation complete", {
			truncatedCount,
			remainingMessages: nonTruncated.length,
			remainingTokens,
		});

		return {
			messages: nonTruncated,
			totalTokens: remainingTokens,
			contextLimit,
			wasTruncated: truncatedCount > 0,
			truncatedCount,
		};
	}

	/**
	 * Check if the context window is approaching the limit.
	 *
	 * @returns True if total tokens exceed the threshold
	 */
	isApproachingLimit(messages: Message[], modelId: string): boolean {
		const totalTokens = this.estimateTotalTokens(messages);
		const contextLimit = getContextWindow(modelId);
		return totalTokens > contextLimit * this.threshold;
	}

	/**
	 * Get a human-readable context usage summary.
	 */
	getUsageSummary(messages: Message[], modelId: string): {
		usedTokens: number;
		contextLimit: number;
		percentUsed: number;
	} {
		const usedTokens = this.estimateTotalTokens(messages);
		const contextLimit = getContextWindow(modelId);
		const percentUsed = contextLimit > 0 ? Math.round((usedTokens / contextLimit) * 100) : 0;

		return { usedTokens, contextLimit, percentUsed };
	}
}