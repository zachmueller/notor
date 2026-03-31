/**
 * HTML importer — extracts embedded JSONL conversation data from an
 * exported Notor HTML file and prepares it for import into the local
 * conversation history.
 *
 * The JSONL block is embedded by `exportToHtml()` inside a
 * `<script type="application/jsonl" id="notor-conversation-data">` tag.
 */

import type { Conversation, Message } from "../types";

/**
 * Regex to locate the embedded JSONL data block in an HTML export.
 *
 * Matches the script tag by its `id` attribute, capturing the inner
 * content (which may span many lines).
 */
const JSONL_BLOCK_RE =
	/<script\s[^>]*id\s*=\s*"notor-conversation-data"[^>]*>([\s\S]*?)<\/script>/;

/**
 * Extract conversation data from an exported Notor HTML file.
 *
 * Returns the parsed conversation header and message array, or `null`
 * if the HTML does not contain an embedded JSONL block or the block
 * is malformed.
 */
export function extractJsonlFromHtml(
	htmlContent: string
): { conversation: Conversation; messages: Message[] } | null {
	const match = JSONL_BLOCK_RE.exec(htmlContent);
	if (!match || !match[1]) return null;

	// Reverse the <\/ escaping applied during export
	const raw = match[1].replace(/<\\\//g, "</");

	const lines = raw.split("\n").filter((l) => l.trim().length > 0);
	if (lines.length === 0) return null;

	// First line must be the conversation header
	let headerObj: Record<string, unknown>;
	try {
		headerObj = JSON.parse(lines[0]!);
	} catch {
		return null;
	}

	if (headerObj._type !== "conversation") return null;

	const { _type: _ht, ...conversationData } = headerObj;
	const conversation = conversationData as unknown as Conversation;

	// Remaining lines are messages
	const messages: Message[] = [];
	for (let i = 1; i < lines.length; i++) {
		try {
			const obj = JSON.parse(lines[i]!);
			const { _type: _mt, ...messageData } = obj;
			messages.push(messageData as Message);
		} catch {
			// Skip malformed lines
		}
	}

	return { conversation, messages };
}

/**
 * Generate fresh IDs for an imported conversation and all its messages
 * to prevent collisions with existing history entries.
 *
 * - The conversation gets a new `id` and its `updated_at` is set to now.
 * - Each message gets a new `id` and its `conversation_id` is updated
 *   to reference the new conversation ID.
 * - Original `created_at` and message timestamps are preserved so the
 *   conversation displays with its original chronology.
 */
export function reassignIds(
	conversation: Conversation,
	messages: Message[]
): { conversation: Conversation; messages: Message[] } {
	const newConversationId = crypto.randomUUID();
	const now = new Date().toISOString();

	const newConversation: Conversation = {
		...conversation,
		id: newConversationId,
		updated_at: now,
	};

	const newMessages: Message[] = messages.map((msg) => ({
		...msg,
		id: crypto.randomUUID(),
		conversation_id: newConversationId,
	}));

	return { conversation: newConversation, messages: newMessages };
}
