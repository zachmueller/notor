/**
 * `submit_plan` — the model hands a complete plan document to the user for
 * review, Claude Code–style.
 *
 * Flow: store the plan (latest revision only) → open the plan leaf →
 * suspend on a `plan-review` interaction until the user decides:
 *
 * - **approve** → switch the conversation to Act mode; the model executes.
 * - **approve-auto-accept** → same, plus built-in write tools are
 *   auto-approved for the rest of this response loop.
 * - **request-changes** → the compiled inline comments (and/or a typed
 *   reply) come back as the result; the model revises and re-submits.
 * - **reject** → stay in Plan mode.
 *
 * The tool is `read` mode so it works in Plan mode, and is visible in
 * settings (not `internal`) so users can disable it.
 *
 * @see ai/notor/ideas — "Plan document flow with inline commenting and hand-back"
 */

import type { JSONSchema, Tool, ToolExecuteOptions, ToolResult } from "./tool";
import type { PlanStatus, PlanStore } from "../plans/plan-store";
import type { PlanReviewOutcome } from "../plans/plan-review-controller";
import type { NotorSettings } from "../settings/types";

export const SUBMIT_PLAN_TOOL_NAME = "submit_plan";
export const PLAN_BLOCK_KIND = "plan";

export interface SubmitPlanToolDeps {
	planStore: PlanStore;
	/** Open (or focus) the plan leaf for a conversation. */
	openPlanView: (conversationId: string) => void | Promise<void>;
	getSettings: () => Pick<NotorSettings, "auto_skip_user_input_prompts" | "extension_execution_timeout_seconds">;
}

const STATUS_FOR: Record<PlanReviewOutcome["kind"], PlanStatus> = {
	"approve": "approved",
	"approve-auto-accept": "approved",
	"request-changes": "changes-requested",
	"reject": "rejected",
};

export class SubmitPlanTool implements Tool {
	readonly name = SUBMIT_PLAN_TOOL_NAME;
	readonly description =
		"Submit a complete, step-by-step implementation plan to the user for review. " +
		"The plan opens in a dedicated review tab where the user can comment on specific passages, " +
		"request changes, reject it, or approve it (which switches the conversation to Act mode so you can execute it). " +
		"Use this in Plan mode once your read-only research is done and the task needs changes to the vault. " +
		"Put the whole plan in `plan` — do not repeat it in your reply. " +
		"If the user requests changes, revise and call this tool again with the full updated plan.";
	readonly input_schema: JSONSchema = {
		type: "object",
		properties: {
			title: {
				type: "string",
				description: "Short title for the plan (e.g. 'Reorganize project notes').",
			},
			plan: {
				type: "string",
				description: "The complete plan as Markdown: context, numbered steps naming the notes/files to change, and how to verify.",
			},
		},
		required: ["title", "plan"],
	};
	readonly mode = "read" as const;

	constructor(private readonly deps: SubmitPlanToolDeps) {}

	async execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult> {
		const fail = (error: string): ToolResult => ({ tool_name: this.name, success: false, result: "", error });

		const title = typeof params.title === "string" ? params.title.trim() : "";
		const plan = typeof params.plan === "string" ? params.plan.trim() : "";
		if (!title) return fail("title must be a non-empty string");
		if (!plan) return fail("plan must be a non-empty Markdown string");

		const ctx = options?.sessionContext;
		const conversationId = ctx?.getSessionConversationId?.() ?? ctx?.getActiveConversation()?.id ?? null;
		const interact = options?.interactionCallback;
		if (!interact || !conversationId) {
			return fail(
				"submit_plan requires an interactive chat panel; no review channel is available in this context " +
				"(e.g. a background or sub-agent run). Put the plan in your reply instead.",
			);
		}

		await this.deps.planStore.submit(conversationId, title, plan);
		try {
			await this.deps.openPlanView(conversationId);
		} catch {
			// The card's "Open plan" button still works; never fail the call over UI.
		}

		const outcome = await this.awaitReview(conversationId, title, interact, options?.abortSignal);
		if (outcome === "cancelled") return fail("Plan review cancelled.");
		if (outcome === "timed-out") return fail("Plan review timed out without a decision. Ask the user how to proceed.");

		await this.deps.planStore.setStatus(conversationId, STATUS_FOR[outcome.kind]);

		let result: string;
		switch (outcome.kind) {
			case "approve":
				ctx?.setConversationMode?.("act");
				result = "The user approved the plan. The conversation is now in Act mode. Execute the plan now, step by step.";
				break;
			case "approve-auto-accept":
				ctx?.setConversationMode?.("act");
				ctx?.setAutoAcceptWrites?.(true);
				result =
					"The user approved the plan and enabled auto-accept for edits. The conversation is now in Act mode, " +
					"and note/file edits are auto-approved for the rest of this response. Execute the plan now, step by step.";
				break;
			case "request-changes":
				result =
					"The user requested changes to the plan. Revise it to address every point below, " +
					"then call submit_plan again with the complete updated plan.\n\n" +
					(outcome.feedback.trim() || "(No specific feedback was given.)");
				break;
			case "reject":
				result =
					`The user rejected the plan${outcome.reason ? `: ${outcome.reason}` : "."} ` +
					"Do not execute it. Stay in Plan mode and ask the user how they would like to proceed.";
				break;
		}

		return {
			tool_name: this.name,
			success: true,
			result,
			content_blocks: [
				{ type: "custom_block", kind: PLAN_BLOCK_KIND, data: { conversationId, title, status: STATUS_FOR[outcome.kind] } },
			],
		};
	}

	/**
	 * Suspend on the `plan-review` interaction. Honors
	 * `auto_skip_user_input_prompts` (parity with interactive extension tools):
	 * when on, the review times out after `extension_execution_timeout_seconds`.
	 */
	private async awaitReview(
		conversationId: string,
		title: string,
		interact: NonNullable<ToolExecuteOptions["interactionCallback"]>,
		parentSignal?: AbortSignal,
	): Promise<PlanReviewOutcome | "cancelled" | "timed-out"> {
		const child = new AbortController();
		const onParentAbort = () => child.abort();
		if (parentSignal?.aborted) return "cancelled";
		parentSignal?.addEventListener("abort", onParentAbort, { once: true });

		const settings = this.deps.getSettings();
		const timeoutMs = settings.auto_skip_user_input_prompts && settings.extension_execution_timeout_seconds > 0
			? settings.extension_execution_timeout_seconds * 1000
			: 0;
		let timedOut = false;
		const timer = timeoutMs > 0
			? setTimeout(() => {
				timedOut = true;
				child.abort();
			}, timeoutMs)
			: null;

		try {
			const response = await interact(
				{ type: "plan-review", id: `plan-review-${Date.now()}`, conversationId, title },
				child.signal,
			);
			return response.outcome ?? { kind: "request-changes", feedback: "" };
		} catch {
			return timedOut ? "timed-out" : "cancelled";
		} finally {
			if (timer) clearTimeout(timer);
			parentSignal?.removeEventListener("abort", onParentAbort);
		}
	}
}
