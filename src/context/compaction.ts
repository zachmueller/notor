/**
 * Auto-compaction — detects when conversation tokens approach the
 * context window limit and summarizes the conversation to reclaim space.
 *
 * COMP-001: Threshold check using token estimation.
 * COMP-002: Summarization request via the active LLM provider.
 * COMP-003: Built-in default compaction prompt and user override.
 *
 * @see specs/02-context-intelligence/data-model.md — CompactionRecord, Token Estimation
 * @see specs/02-context-intelligence/tasks.md — COMP-001, COMP-002, COMP-003
 */

import type { Message } from "../types";
import type { NotorSettings } from "../settings";
import type { LLMProvider, ChatMessage, SendMessageOptions, StreamChunk } from "../providers/provider";
import { estimateTokens } from "../utils/tokens";
import { getContextWindow } from "../providers/model-metadata";
import { logger } from "../utils/logger";

const log = logger("Compaction");

// ---------------------------------------------------------------------------
// COMP-003: Default compaction system prompt
// ---------------------------------------------------------------------------

/**
 * Built-in default compaction system prompt.
 *
 * Instructs the LLM to produce a concise, faithful summary of the
 * conversation that preserves key information needed to continue.
 */
const DEFAULT_COMPACTION_PROMPT = `You are a conversation summarizer. Your task is to produce a concise, faithful summary of the conversation so far.

Requirements:
- Preserve all key facts, decisions, and action items discussed.
- Preserve the names and paths of any files, notes, or resources referenced.
- Preserve any tool calls made and their outcomes (success/failure, key results).
- Preserve the user's goals and current task context.
- Omit pleasantries, repetitive exchanges, and verbose tool output details.
- Write in third person ("The user asked…", "The assistant suggested…").
- Keep the summary under 2000 words.
- Do NOT add any preamble like "Here is a summary" — just output the summary directly.`;

/**
 * Get the compaction system prompt, using the user override if set.
 *
 * @param settings - Plugin settings.
 * @returns The compaction system prompt to use.
 */
export function getCompactionPrompt(settings: NotorSettings): string {
	if (settings.compaction_prompt_override && settings.compaction_prompt_override.trim().length > 0) {
		return settings.compaction_prompt_override.trim();
	}
	return DEFAULT_COMPACTION_PROMPT;
}

// ---------------------------------------------------------------------------
// COMP-001: Threshold check
// ---------------------------------------------------------------------------

/**
 * Estimate cumulative tokens across all messages in a conversation.
 *
 * Counts content of all messages plus serialized tool call/result content.
 *
 * @param messages - All messages in the active context window.
 * @returns Total estimated token count.
 */
export function estimateConversationTokens(messages: Message[]): number {
	let total = 0;
	for (const msg of messages) {
		total += estimateTokens(msg.content);

		// Include tool call parameters in estimation
		if (msg.tool_call) {
			total += estimateTokens(JSON.stringify(msg.tool_call.parameters));
		}

		// Include tool result content in estimation
		if (msg.tool_result) {
			const result = msg.tool_result.result;
			total += estimateTokens(
				typeof result === "string" ? result : JSON.stringify(result)
			);
		}
	}
	return total;
}

/**
 * Check whether the conversation should be compacted.
 *
 * Compares cumulative estimated tokens against `threshold * contextWindow`.
 * For models where the context window is unknown (null), returns false
 * (falls back to existing truncation behavior).
 *
 * @param messages - All messages in the conversation.
 * @param settings - Plugin settings (for threshold).
 * @param modelId - Active model ID (for context window lookup).
 * @returns True if the conversation should be compacted.
 */
export function shouldCompact(
	messages: Message[],
	settings: NotorSettings,
	modelId: string
): boolean {
	const contextWindow = getContextWindowForModel(modelId);
	if (contextWindow === null) {
		return false;
	}

	const totalTokens = estimateConversationTokens(messages);
	const threshold = settings.compaction_threshold * contextWindow;

	const shouldTrigger = totalTokens >= threshold;

	if (shouldTrigger) {
		log.info("Compaction threshold reached", {
			totalTokens,
			threshold,
			contextWindow,
			thresholdFraction: settings.compaction_threshold,
		});
	}

	return shouldTrigger;
}

/**
 * Get the context window for a model, returning null if unknown.
 *
 * Unlike `getContextWindow()` which returns a default, this function
 * returns null for truly unknown models so compaction can fall back
 * to truncation.
 */
function getContextWindowForModel(modelId: string): number | null {
	if (!modelId) return null;
	// getContextWindow returns DEFAULT_CONTEXT_WINDOW (128000) for unknown models.
	// We use it as-is since the default is a reasonable assumption.
	return getContextWindow(modelId);
}

// ---------------------------------------------------------------------------
// COMP-002: Compaction summarization
// ---------------------------------------------------------------------------

/** Record logged in JSONL when compaction occurs. */
export interface CompactionRecord {
	id: string;
	conversation_id: string;
	type: "compaction";
	timestamp: string;
	token_count_at_compaction: number;
	context_window_limit: number;
	threshold: number;
	summary: string;
	summary_tokens: number | null;
	trigger: "automatic" | "manual";
}

/** Result of a compaction attempt. */
export interface CompactionResult {
	/** Whether compaction succeeded. */
	success: boolean;
	/** The summary text (if successful). */
	summary?: string;
	/** Estimated token count of the summary. */
	summaryTokens?: number;
	/** The new messages array to use as the context window. */
	newMessages?: Message[];
	/** The compaction record for JSONL logging. */
	record?: CompactionRecord;
	/** Error message if compaction failed. */
	error?: string;
}

/**
 * Perform compaction by sending the conversation to the LLM for summarization,
 * then constructing the new context window.
 *
 * On success: returns a new message array containing:
 *   1. A synthetic user message: "Summary of prior conversation: {summary}"
 *   2. A synthetic assistant acknowledgment
 *
 * The caller should append the current pending user message after these.
 *
 * On failure: returns an error so the caller can fall back to truncation.
 *
 * @param messages - Current conversation messages (excluding system prompt).
 * @param provider - The active LLM provider for summarization.
 * @param settings - Plugin settings.
 * @param modelId - Active model ID.
 * @param conversationId - Current conversation UUID.
 * @param trigger - Whether this was automatic or manual.
 * @returns Compaction result with new messages or error.
 */
export async function performCompaction(
	messages: Message[],
	provider: LLMProvider,
	settings: NotorSettings,
	modelId: string,
	conversationId: string,
	trigger: "automatic" | "manual"
): Promise<CompactionResult> {
	const compactionPrompt = getCompactionPrompt(settings);
	const contextWindow = getContextWindow(modelId);
	const tokenCount = estimateConversationTokens(messages);

	log.info("Starting compaction", {
		trigger,
		tokenCount,
		contextWindow,
		messageCount: messages.length,
	});

	// Build the summarization request
	const chatMessages: ChatMessage[] = [
		{ role: "system", content: compactionPrompt },
	];

	// Include all conversation messages for summarization
	for (const msg of messages) {
		if (msg.role === "system") continue; // Skip system messages
		if (msg.role === "user" || msg.role === "assistant") {
			chatMessages.push({
				role: msg.role,
				content: msg.content,
			});
		} else if (msg.role === "tool_call" && msg.tool_call) {
			// Represent tool calls as assistant messages for summarization
			chatMessages.push({
				role: "assistant",
				content: `[Tool call: ${msg.tool_call.tool_name}(${JSON.stringify(msg.tool_call.parameters)})]`,
			});
		} else if (msg.role === "tool_result" && msg.tool_result) {
			const resultStr = typeof msg.tool_result.result === "string"
				? msg.tool_result.result
				: JSON.stringify(msg.tool_result.result);
			chatMessages.push({
				role: "user",
				content: `[Tool result: ${msg.tool_result.tool_name} → ${msg.tool_result.success ? "success" : "error"}: ${resultStr.substring(0, 2000)}]`,
			});
		}
	}

	// Add the summarization instruction as the final user message
	chatMessages.push({
		role: "user",
		content: "Please summarize the conversation above.",
	});

	try {
		const options: SendMessageOptions = {
			model: modelId,
		};

		// Stream the summarization response
		const stream = provider.sendMessage(chatMessages, [], options);
		let summaryText = "";
		let inputTokens = 0;
		let outputTokens = 0;

		for await (const chunk of stream as AsyncIterable<StreamChunk>) {
			switch (chunk.type) {
				case "text_delta":
					summaryText += chunk.text;
					break;
				case "message_end":
					inputTokens = chunk.input_tokens;
					outputTokens = chunk.output_tokens;
					break;
				case "error":
					throw new Error(`LLM error during compaction: ${chunk.error}`);
			}
		}

		if (!summaryText.trim()) {
			throw new Error("Compaction produced empty summary");
		}

		const summaryTokens = estimateTokens(summaryText);

		// Construct new context window with synthetic exchange
		const now = new Date().toISOString();
		const newMessages: Message[] = [
			{
				id: generateId(),
				conversation_id: conversationId,
				role: "user",
				content: `Summary of prior conversation:\n\n${summaryText}`,
				timestamp: now,
			},
			{
				id: generateId(),
				conversation_id: conversationId,
				role: "assistant",
				content: "Understood. I have the context from our prior conversation. How can I help you continue?",
				timestamp: now,
			},
		];

		// Build compaction record for JSONL
		const record: CompactionRecord = {
			id: generateId(),
			conversation_id: conversationId,
			type: "compaction",
			timestamp: now,
			token_count_at_compaction: tokenCount,
			context_window_limit: contextWindow,
			threshold: settings.compaction_threshold,
			summary: summaryText,
			summary_tokens: summaryTokens,
			trigger,
		};

		log.info("Compaction successful", {
			trigger,
			originalTokens: tokenCount,
			summaryTokens,
			inputTokensUsed: inputTokens,
			outputTokensUsed: outputTokens,
		});

		return {
			success: true,
			summary: summaryText,
			summaryTokens,
			newMessages,
			record,
		};
	} catch (e) {
		const errorMsg = e instanceof Error ? e.message : String(e);
		log.error("Compaction failed", { error: errorMsg, trigger });

		return {
			success: false,
			error: errorMsg,
		};
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a simple UUID v4. */
function generateId(): string {
	return crypto.randomUUID?.() ??
		"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
			const r = (Math.random() * 16) | 0;
			const v = c === "x" ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
}