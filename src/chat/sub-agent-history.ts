/**
 * Sub-agent conversation history helpers.
 *
 * Converts sub-agent `ChatMessage[]` (provider wire format) to
 * persistence-oriented `Message[]` (JSONL format) and generates
 * the sub-agent JSONL filename.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Section 5.1
 * @see specs/ZZ-misc/sub-agents-implementation-plan.md — Phase 6.1
 */

import type { ChatMessage } from "../providers/provider";
import type { Message } from "../types";

/**
 * Generate a JSONL filename for a sub-agent conversation.
 *
 * Format: `{parent_timestamp}_{parent_id}_subagent_{invocation_id}.jsonl`
 *
 * The parent timestamp uses the same compact format as `HistoryManager.getFilename()`.
 */
export function generateSubAgentFilename(
	parentCreatedAt: string,
	parentId: string,
	invocationId: string,
): string {
	const ts = parentCreatedAt
		.replace(/[-:]/g, "")
		.replace("T", "_")
		.replace(/\.\d+Z$/, "Z")
		.replace("Z", "");
	return `${ts}_${parentId}_subagent_${invocationId}.jsonl`;
}

/**
 * Convert a sub-agent's `ChatMessage[]` array to persistence `Message[]`.
 *
 * A single `ChatMessage` may contain multiple tool calls or results
 * (coalesced for the provider), so we expand them into individual
 * `Message` entries for the persistence format (one tool_call / tool_result
 * per `Message`).
 */
export function chatMessagesToMessages(
	chatMessages: ChatMessage[],
	conversationId: string,
): Message[] {
	const now = new Date().toISOString();
	const result: Message[] = [];

	for (const cm of chatMessages) {
		// Expand coalesced tool_call messages into one Message per tool call
		if (cm.tool_calls && cm.tool_calls.length > 0) {
			for (const tc of cm.tool_calls) {
				result.push({
					id: crypto.randomUUID(),
					conversation_id: conversationId,
					role: cm.role,
					content: cm.content,
					timestamp: now,
					tool_call: {
						id: tc.id,
						tool_name: tc.tool_name,
						parameters: tc.parameters,
						status: "success",
					},
				});
			}
			continue;
		}

		// Expand coalesced tool_result messages into one Message per result
		if (cm.tool_results && cm.tool_results.length > 0) {
			for (const tr of cm.tool_results) {
				result.push({
					id: crypto.randomUUID(),
					conversation_id: conversationId,
					role: cm.role,
					content: cm.content,
					timestamp: now,
					tool_result: {
						tool_name: tr.tool_name,
						success: !tr.is_error,
						result: tr.result,
						tool_call_id: tr.tool_call_id,
					},
				});
			}
			continue;
		}

		// Plain message (system, user, assistant text-only)
		result.push({
			id: crypto.randomUUID(),
			conversation_id: conversationId,
			role: cm.role,
			content: cm.content,
			timestamp: now,
		});
	}

	return result;
}

/**
 * Check whether a JSONL filename follows the sub-agent naming convention.
 *
 * Used by `HistoryManager.listConversations()` and `searchConversations()`
 * to filter out sub-agent files from the main conversation list.
 */
export function isSubAgentFilename(filename: string): boolean {
	return filename.includes("_subagent_");
}
