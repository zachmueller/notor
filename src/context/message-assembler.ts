/**
 * Message assembler — composes the final user message from multiple
 * content sources in a fixed order.
 *
 * Assembly order (after ACI-001 / ACI-002 cleanup):
 *   1. Attachments block   (`<attachments>…</attachments>`)
 *   2. User text           (the user's typed message)
 *
 * Auto-context is now injected into the system prompt (ACI-001).
 * Hook stdout is now sent as a separate user message (ACI-002).
 *
 * Empty sections are omitted — no empty tags or extra whitespace.
 *
 * @see specs/02-context-intelligence/auto-context-iteration/tasks.md — ACI-006
 * @see specs/02-context-intelligence/plan.md — Context assembly architecture
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parts that make up a user message before assembly. */
export interface MessageParts {
	/** XML-tagged attachments block (or undefined if none). */
	attachments?: string;
	/** The user's typed message text. Always present. */
	userText: string;
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/**
 * Assemble a complete user message from its component parts.
 *
 * Parts are concatenated in fixed order with double-newline separators.
 * Empty/undefined parts are silently omitted.
 *
 * @param parts - The message parts to assemble.
 * @returns The assembled message string ready for dispatch to the LLM.
 */
export function assembleUserMessage(parts: MessageParts): string {
	const sections: string[] = [];

	// 1. Attachments
	if (parts.attachments) {
		sections.push(parts.attachments);
	}

	// 2. User text (always present)
	sections.push(parts.userText);

	return sections.join("\n\n");
}