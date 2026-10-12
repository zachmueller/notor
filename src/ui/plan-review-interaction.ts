/**
 * `plan-review` interaction renderer — the tool-call card shown while a
 * `submit_plan` call waits for the user's decision.
 *
 * The card offers Open plan / Reject / Approve / Approve & auto-accept edits.
 * "Request changes" lives in the plan leaf (where the inline comments are) and
 * in the chat input (typing a reply while a review is pending). All surfaces
 * settle the same review through the {@link PlanReviewController}: the
 * renderer registers its `resolve` with the controller on render and
 * unregisters on cleanup.
 */

import { getPlanReviewController, type PlanReviewOutcome } from "../plans/plan-review-controller";
import type { InteractionRenderer } from "./interaction-ui";

export const planReviewRenderer: InteractionRenderer = {
	render(el, request, resolve) {
		if (request.type !== "plan-review") {
			throw new Error(`planReviewRenderer cannot render request type "${request.type}"`);
		}
		const { id, conversationId, title } = request;
		const controller = getPlanReviewController();

		const settle = (outcome: PlanReviewOutcome) => resolve({ id, values: [], outcome });
		const unregister = controller?.register(conversationId, settle);
		const decide = (outcome: PlanReviewOutcome) => {
			// Route through the controller so other surfaces (plan leaf) see the
			// review as settled; fall back to resolving directly.
			if (!controller?.resolve(conversationId, outcome)) settle(outcome);
		};

		const root = el.createDiv({ cls: "notor-interaction-prompt notor-plan-review-prompt" });
		root.createDiv({ cls: "notor-plan-review-title", text: `Plan ready for review: ${title}` });
		root.createDiv({
			cls: "notor-plan-review-hint",
			text: "Comment on passages in the plan tab and send them back, reply in the chat to request changes, or decide here.",
		});

		const actions = root.createDiv({ cls: "notor-plan-review-actions" });
		const openBtn = actions.createEl("button", { cls: "notor-plan-review-open", text: "Open plan" });
		openBtn.addEventListener("click", () => controller?.openPlan(conversationId));

		actions.createDiv({ cls: "notor-plan-review-spacer" });

		const rejectBtn = actions.createEl("button", { cls: "notor-plan-review-reject", text: "Reject" });
		rejectBtn.addEventListener("click", () => decide({ kind: "reject" }));

		const approveBtn = actions.createEl("button", { cls: "notor-plan-review-approve", text: "Approve" });
		approveBtn.addEventListener("click", () => decide({ kind: "approve" }));

		const autoBtn = actions.createEl("button", {
			cls: "notor-plan-review-approve-auto mod-cta",
			text: "Approve & auto-accept edits",
		});
		autoBtn.addEventListener("click", () => decide({ kind: "approve-auto-accept" }));

		return () => {
			unregister?.();
			root.remove();
		};
	},
};
