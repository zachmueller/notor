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
import type { Message, ToolCall, ToolResult } from "../types";

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
 * Each `ChatMessage` maps to one `Message`. Tool call and tool result
 * entries are extracted from the arrays on the wire format into the
 * single-object fields on the persistence format.
 */
export function chatMessagesToMessages(
	chatMessages: ChatMessage[],
	conversationId: string,
): Message[] {
	const now = new Date().toISOString();

	return chatMessages.map((cm) => {
		const msg: Message = {
			id: crypto.randomUUID(),
			conversation_id: conversationId,
			role: cm.role,
			content: cm.content,
			timestamp: now,
		};

		// Map tool_calls array → single tool_call
		if (cm.tool_calls?.[0]) {
			const tc = cm.tool_calls[0];
			const toolCall: ToolCall = {
				id: tc.id,
				tool_name: tc.tool_name,
				parameters: tc.parameters,
				status: "success",
			};
			msg.tool_call = toolCall;
		}

		// Map tool_results array → single tool_result
		if (cm.tool_results?.[0]) {
			const tr = cm.tool_results[0];
			const toolResult: ToolResult = {
				tool_name: tr.tool_name,
				success: !tr.is_error,
				result: tr.result,
				tool_call_id: tr.tool_call_id,
			};
			msg.tool_result = toolResult;
		}

		return msg;
	});
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
