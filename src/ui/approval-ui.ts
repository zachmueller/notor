/**
 * Approval UI — inline approve/reject prompt for tool calls.
 *
 * Renders approve/reject buttons inside a tool call card when the tool
 * requires manual approval. The send button is disabled while approval
 * is pending. Resolves a promise when the user decides.
 *
 * @see specs/01-mvp/spec.md — FR-15 (auto-approve), FR-16 (tool transparency)
 * @see design/ux.md — auto-approve, inline approval prompt
 */

/**
 * Render an inline approval prompt inside a tool call element.
 *
 * Returns a promise that resolves with "approved" or "rejected" when
 * the user clicks a button. The prompt removes itself from the DOM on decision.
 *
 * @param toolCallEl - The tool call card element to append the prompt into
 * @returns Promise resolving to user's decision
 */
export function renderApprovalPrompt(
	toolCallEl: HTMLElement
): Promise<"approved" | "rejected"> {
	return new Promise((resolve) => {
		const approvalEl = toolCallEl.createDiv({ cls: "notor-approval-prompt" });

		const textEl = approvalEl.createSpan({
			cls: "notor-approval-text",
			text: "Approve this action?",
		});
		// Suppress unused variable warning — textEl is intentionally appended to DOM
		void textEl;

		const btnContainer = approvalEl.createDiv({ cls: "notor-approval-buttons" });

		const approveBtn = btnContainer.createEl("button", {
			cls: "notor-approve-btn",
			text: "Approve",
		});

		const rejectBtn = btnContainer.createEl("button", {
			cls: "notor-reject-btn",
			text: "Reject",
		});

		const cleanup = () => {
			approvalEl.remove();
		};

		approveBtn.addEventListener("click", () => {
			cleanup();
			resolve("approved");
		});

		rejectBtn.addEventListener("click", () => {
			cleanup();
			resolve("rejected");
		});
	});
}