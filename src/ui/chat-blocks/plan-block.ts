/**
 * `plan` chat block — the compact card left in chat history by `submit_plan`:
 * plan title, live review status, and an "Open plan" button that re-opens the
 * plan leaf at any time (including while Notor executes the plan).
 *
 * Registered directly as a TS `ChatBlockDefinition` (not a user-overridable
 * scaffold) because it needs plugin services. `toLLMText` returns null: the
 * plan text already lives in the `submit_plan` call's parameters.
 */

import { setIcon } from "obsidian";
import type { ChatBlockDefinition } from "./registry";
import type { PlanStatus, StoredPlan } from "../../plans/plan-store";
import { PLAN_BLOCK_KIND } from "../../tools/submit-plan";

const STATUS_LABELS: Record<PlanStatus, string> = {
	"pending-review": "Awaiting review",
	"changes-requested": "Changes requested",
	"approved": "Approved",
	"rejected": "Rejected",
};

export interface PlanBlockDeps {
	openPlanView: (conversationId: string) => void;
	loadPlan: (conversationId: string) => Promise<StoredPlan | null>;
}

export function createPlanBlockDefinition(deps: PlanBlockDeps): ChatBlockDefinition {
	return {
		kind: PLAN_BLOCK_KIND,
		displayName: "Plan",
		icon: "clipboard-list",
		excludeFromCompaction: true,
		toLLMText: () => null,
		render: (container, data) => {
			const conversationId = typeof data.conversationId === "string" ? data.conversationId : "";
			const title = typeof data.title === "string" ? data.title : "Plan";
			const snapshot = typeof data.status === "string" ? (data.status as PlanStatus) : undefined;

			const card = container.createDiv({ cls: "notor-plan-block" });
			const icon = card.createSpan({ cls: "notor-plan-block-icon" });
			setIcon(icon, "clipboard-list");
			const text = card.createDiv({ cls: "notor-plan-block-text" });
			text.createDiv({ cls: "notor-plan-block-title", text: title });
			const statusEl = text.createDiv({
				cls: "notor-plan-block-status",
				text: snapshot ? STATUS_LABELS[snapshot] ?? snapshot : "",
			});
			const btn = card.createEl("button", { cls: "notor-plan-block-open", text: "Open plan" });
			btn.disabled = !conversationId;
			btn.addEventListener("click", () => deps.openPlanView(conversationId));

			// The block is a point-in-time snapshot; show the current status when
			// this card still describes the latest revision.
			if (conversationId) {
				void deps.loadPlan(conversationId).then((plan) => {
					if (plan && plan.title === title) statusEl.setText(STATUS_LABELS[plan.status] ?? plan.status);
				});
			}
		},
	};
}
