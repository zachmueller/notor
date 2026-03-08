/**
 * Message assembler — composes the final user message from multiple
 * content sources in a fixed order.
 *
 * Assembly order (Phase 4 — workflow-aware):
 *   1. Trigger context block  (`<trigger_context>…</trigger_context>`)  ← event-triggered only
 *   2. Attachments block      (`<attachments>…</attachments>`)
 *   3. Workflow instructions  (`<workflow_instructions>…</workflow_instructions>`)  ← workflow only
 *   4. User text              (the user's typed message)
 *
 * For non-workflow messages, `triggerContext` and `workflowInstructions`
 * are undefined and the order collapses to the Phase 3 behaviour:
 *   1. Attachments block
 *   2. User text
 *
 * Auto-context is now injected into the system prompt (ACI-001).
 * Hook stdout is now sent as a separate user message (ACI-002).
 *
 * Empty sections are omitted — no empty tags or extra whitespace.
 *
 * @see specs/02-context-intelligence/auto-context-iteration/tasks.md — ACI-006
 * @see specs/02-context-intelligence/plan.md — Context assembly architecture
 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001, E-006
 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Step 6
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
	/**
	 * Pre-formatted `<trigger_context>` XML block for event-triggered
	 * workflow executions. Undefined for manual triggers and non-workflow
	 * messages. Placed before all other sections when present.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
	 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Step 5
	 */
	triggerContext?: string;
	/**
	 * Pre-wrapped `<workflow_instructions type="…">…</workflow_instructions>`
	 * block. Undefined for non-workflow messages. Placed after the attachments
	 * block and before the user's supplementary text.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-001
	 * @see specs/03-workflows-personas/contracts/workflow-assembly.md — Step 4
	 */
	workflowInstructions?: string;
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
 * **Workflow message order (when `workflowInstructions` is present):**
 * 1. `<trigger_context>` block (event-triggered only)
 * 2. `<attachments>` block (if any)
 * 3. `<workflow_instructions>` block
 * 4. User supplementary text (if any)
 *
 * **Non-workflow message order (backward-compatible):**
 * 1. `<attachments>` block (if any)
 * 2. User text
 *
 * @param parts - The message parts to assemble.
 * @returns The assembled message string ready for dispatch to the LLM.
 */
export function assembleUserMessage(parts: MessageParts): string {
	const sections: string[] = [];

	// 1. Trigger context (event-triggered workflows only)
	if (parts.triggerContext) {
		sections.push(parts.triggerContext);
	}

	// 2. Attachments
	if (parts.attachments) {
		sections.push(parts.attachments);
	}

	// 3. Workflow instructions (workflow messages only)
	if (parts.workflowInstructions) {
		sections.push(parts.workflowInstructions);
	}

	// 4. User text (always present; may be empty supplementary text for workflows)
	if (parts.userText) {
		sections.push(parts.userText);
	}

	return sections.join("\n\n");
}
