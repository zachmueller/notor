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
import { estimateTokenCount, estimateContentTokens, estimateAttachmentSnapshotTokens } from "../utils/tokens";
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
	 * Estimate tokens for a single message using content-based heuristics.
	 *
	 * NOTE: We do NOT use message.input_tokens here — it represents the full
	 * prompt size at that API call (cumulative), not the incremental cost of
	 * this single message. Using it would cause O(n²) inflation when summed.
	 */
	estimateMessageTokens(message: Message): number {
		// For assistant messages, prefer actual output tokens if available
		if (message.role === "assistant" && message.output_tokens) {
			return message.output_tokens;
		}

		let total = estimateContentTokens(message.content);

		// Part 3: attachment content is stored in the per-message snapshot and
		// merged into the wire only at dispatch, so add its cost here (stored
		// `content` is prose-only). Legacy embedded-XML messages count 0 here.
		total += estimateAttachmentSnapshotTokens(message.attachments);

		if (message.tool_call) {
			total += estimateTokenCount(JSON.stringify(message.tool_call.parameters));
		}
		if (message.tool_result) {
			const result = message.tool_result.result;
			total += estimateTokenCount(typeof result === "string" ? result : JSON.stringify(result));
		}

		return total;
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
	 * @param useExtendedContext - Whether to use the extended (1M) context window
	 * @returns Context window assembly result
	 */
	assembleContextWindow(messages: Message[], modelId: string, useExtendedContext?: boolean): ContextWindowResult {
		const contextLimit = getContextWindow(modelId, useExtendedContext);
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

		log.info("Context window assessment", {
			messageCount: messages.length,
			totalTokens,
			tokenBudget,
			contextLimit,
			needsTruncation: totalTokens > tokenBudget,
			firstNonSystemRole: messages.find((m) => m.role !== "system")?.role ?? "none",
		});

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

		// Ensure the first remaining non-system message is "user".
		// The token loop above may have stopped mid-pair (e.g., after removing a
		// user message but before its paired assistant response), leaving an
		// assistant/tool_call/tool_result at the front — which Bedrock rejects
		// ("A conversation must start with a user message").
		// Walk forward past any such orphaned messages.
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (!m || m.truncated || m.role === "system") continue;
			if (m.role === "user" || m.role === "extension_block") break;
			// Leading non-user non-system message: mark truncated
			m.truncated = true;
			tokensToRemove -= (tokenCounts[i] ?? 0); // track for logging
			truncatedCount++;
		}

		// Tool-pair integrity: never keep a tool_result whose originating
		// tool_call was truncated. The token loop above can stop mid-pair (or
		// partway through a parallel tool batch), leaving a surviving result
		// with no matching call. Bedrock/Anthropic reject that with
		// "toolResult blocks exceed toolUse blocks". Drop the orphaned result
		// (the model never saw the call, so the result answers no question).
		// The reverse — a surviving call whose result was truncated — is
		// repaired downstream by the synthetic-result injection in
		// toChatMessages(), so it is intentionally left alone here.
		const survivingCallIds = new Set<string>();
		for (const m of messages) {
			if (!m.truncated && m.role === "tool_call") {
				survivingCallIds.add(m.tool_call?.id ?? m.id);
			}
		}
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (!m || m.truncated || m.role !== "tool_result") continue;
			const refId = m.tool_result?.tool_call_id ?? m.id;
			if (!survivingCallIds.has(refId)) {
				m.truncated = true;
				tokensToRemove -= (tokenCounts[i] ?? 0); // track for logging
				truncatedCount++;
				log.warn("Truncated orphaned tool_result (originating tool_call was truncated)", {
					messageId: m.id,
					toolCallId: refId,
					toolName: m.tool_result?.tool_name,
				});
			}
		}

		log.info("Context window after truncation", {
			truncatedCount,
			remainingCount: messages.filter((m) => !m.truncated).length,
			firstRemainingNonSystemRole: messages.filter((m) => !m.truncated && m.role !== "system")[0]?.role ?? "none",
			roles: messages.filter((m) => !m.truncated && m.role !== "system").map((m) => m.role),
		});

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
	 * @param useExtendedContext - Whether to use the extended (1M) context window
	 * @returns True if total tokens exceed the threshold
	 */
	isApproachingLimit(messages: Message[], modelId: string, useExtendedContext?: boolean): boolean {
		const totalTokens = this.estimateTotalTokens(messages);
		const contextLimit = getContextWindow(modelId, useExtendedContext);
		return totalTokens > contextLimit * this.threshold;
	}

	/**
	 * Get a human-readable context usage summary.
	 */
	getUsageSummary(messages: Message[], modelId: string, useExtendedContext?: boolean): {
		usedTokens: number;
		contextLimit: number;
		percentUsed: number;
	} {
		const usedTokens = this.estimateTotalTokens(messages);
		const contextLimit = getContextWindow(modelId, useExtendedContext);
		const percentUsed = contextLimit > 0 ? Math.round((usedTokens / contextLimit) * 100) : 0;

		return { usedTokens, contextLimit, percentUsed };
	}
}