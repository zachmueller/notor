/**
 * Message assembler — composes the final user message from multiple
 * content sources in a fixed order.
 *
 * Assembly order:
 *   1. Auto-context block  (`<auto-context>…</auto-context>`)
 *   2. Attachments block   (`<attachments>…</attachments>`)
 *   3. Hook stdout         (newline-joined pre-send hook output)
 *   4. User text           (the user's typed message)
 *
 * Empty sections are omitted — no empty tags or extra whitespace.
 *
 * @see specs/02-context-intelligence/tasks.md — FOUND-004
 * @see specs/02-context-intelligence/plan.md — Context assembly architecture
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parts that make up a user message before assembly. */
export interface MessageParts {
	/** XML-tagged auto-context block (or undefined if disabled/empty). */
	autoContext?: string;
	/** XML-tagged attachments block (or undefined if none). */
	attachments?: string;
	/** Stdout strings captured from pre-send hooks. */
	hookInjections?: string[];
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

	// 1. Auto-context
	if (parts.autoContext) {
		sections.push(parts.autoContext);
	}

	// 2. Attachments
	if (parts.attachments) {
		sections.push(parts.attachments);
	}

	// 3. Hook stdout injections (newline-joined, skip empty strings)
	if (parts.hookInjections && parts.hookInjections.length > 0) {
		const filtered = parts.hookInjections.filter((s) => s.length > 0);
		if (filtered.length > 0) {
			sections.push(filtered.join("\n"));
		}
	}

	// 4. User text (always present)
	sections.push(parts.userText);

	return sections.join("\n\n");
}