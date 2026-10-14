/**
 * PlanView — dedicated leaf for reviewing a conversation's plan document.
 *
 * Renders the latest plan submitted via `submit_plan`, hosts the inline
 * comment layer with a selection trigger (a floating "Comment" button shows
 * as soon as text is selected), lists pending comments, and offers the review
 * actions while a review is pending. Once decided, the leaf stays readable
 * (status badge only) so the plan can be re-read while Notor executes it.
 *
 * State: `{ conversationId }`, so the leaf survives workspace restore.
 *
 * @see ai/notor/ideas — "Plan document flow with inline commenting and hand-back"
 */

import { ItemView, MarkdownRenderer, setIcon } from "obsidian";
import type { ViewStateResult, WorkspaceLeaf } from "obsidian";
import type NotorPlugin from "../main";
import { CommentLayer } from "../comments/comment-layer";
import type { AnchoredComment } from "../comments/types";
import type { PlanStatus, StoredPlan } from "../plans/plan-store";
import type { PlanReviewOutcome } from "../plans/plan-review-controller";
import { logger } from "../utils/logger";

const log = logger("PlanView");

export const PLAN_VIEW_TYPE = "notor-plan-view";
const PLAN_SCOPE_ID = "plan";

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
	"pending-review": "Awaiting review",
	"changes-requested": "Changes requested",
	"approved": "Approved",
	"rejected": "Rejected",
};

export class PlanView extends ItemView {
	private conversationId?: string;
	private plan: StoredPlan | null = null;
	private renderedMarkdown: string | null = null;
	private layer?: CommentLayer;
	private readonly unsubscribers: Array<() => void> = [];

	private titleEl?: HTMLElement;
	private statusEl?: HTMLElement;
	private bodyEl?: HTMLElement;
	private commentsEl?: HTMLElement;
	private footerEl?: HTMLElement;
	private noteEl?: HTMLTextAreaElement;
	private sendBtn?: HTMLButtonElement;
	private decisionBtns: HTMLButtonElement[] = [];

	constructor(leaf: WorkspaceLeaf, private readonly plugin: NotorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PLAN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.plan?.title ? `Plan: ${this.plan.title}` : "Plan";
	}

	getIcon(): string {
		return "clipboard-list";
	}

	getConversationId(): string | undefined {
		return this.conversationId;
	}

	/** The plan leaf's comment layer (exposed for E2E tests). */
	getCommentLayer(): CommentLayer | undefined {
		return this.layer;
	}

	getState(): Record<string, unknown> {
		return { conversationId: this.conversationId };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		const s = (state ?? {}) as Record<string, unknown>;
		const next = typeof s.conversationId === "string" ? s.conversationId : this.conversationId;
		if (next !== this.conversationId) {
			this.conversationId = next;
			this.renderedMarkdown = null;
			this.layer?.reset();
		}
		await this.refresh();
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("notor-plan-container");

		const header = container.createDiv({ cls: "notor-plan-header" });
		this.titleEl = header.createDiv({ cls: "notor-plan-title" });
		this.statusEl = header.createSpan({ cls: "notor-plan-status" });
		const chatBtn = header.createEl("button", { cls: "notor-plan-open-chat clickable-icon", attr: { "aria-label": "Open conversation" } });
		setIcon(chatBtn, "message-square");
		chatBtn.addEventListener("click", () => void this.openConversation());

		this.bodyEl = container.createDiv({ cls: "notor-plan-body markdown-rendered" });

		this.commentsEl = container.createDiv({ cls: "notor-plan-comments notor-hidden" });
		this.footerEl = container.createDiv({ cls: "notor-plan-footer" });
		this.buildFooter(this.footerEl);

		const bodyEl = this.bodyEl;
		this.layer = new CommentLayer({
			root: bodyEl,
			trigger: "selection",
			resolveScope: (node) => (bodyEl.contains(node) ? { scopeId: PLAN_SCOPE_ID, el: bodyEl } : null),
			getScopeEl: (id) => (id === PLAN_SCOPE_ID ? bodyEl : null),
			listScopes: () => [{ scopeId: PLAN_SCOPE_ID, el: bodyEl }],
			skip: (el) => el.matches(".copy-code-button"),
			storage: {
				load: async () => {
					if (!this.conversationId) return [];
					return (await this.plugin.getPlanStore().load(this.conversationId))?.comments ?? [];
				},
				save: (comments) => {
					if (this.conversationId) void this.plugin.getPlanStore().updateComments(this.conversationId, comments);
				},
			},
			onChange: (comments) => this.renderComments(comments),
			compileIntro: () => "Comments on the plan:",
			orphanNote: "(passage no longer in the plan)",
			app: this.app,
		});

		this.unsubscribers.push(
			this.plugin.getPlanStore().onChange((id) => {
				if (id === this.conversationId) void this.refresh();
			}),
			this.plugin.getPlanReviewController().onChange((id) => {
				if (id === this.conversationId) this.updateFooter();
			}),
		);

		await this.refresh();
	}

	async onClose(): Promise<void> {
		for (const off of this.unsubscribers.splice(0)) off();
		this.layer?.destroy();
		this.layer = undefined;
	}

	// -- Rendering ----------------------------------------------------------------

	private async refresh(): Promise<void> {
		if (!this.bodyEl) return; // not opened yet; onOpen will refresh
		const convId = this.conversationId;
		this.plan = convId ? await this.plugin.getPlanStore().load(convId) : null;
		if (convId !== this.conversationId) return; // switched while loading

		this.titleEl?.setText(this.plan?.title ?? "No plan");
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();

		if (!this.plan) {
			this.renderedMarkdown = null;
			this.bodyEl.empty();
			this.bodyEl.createDiv({
				cls: "notor-plan-empty",
				text: "No plan has been submitted for this conversation yet.",
			});
			this.statusEl?.addClass("notor-hidden");
			this.layer?.reset();
			this.updateFooter();
			return;
		}

		this.statusEl?.removeClass("notor-hidden");
		this.statusEl?.setText(PLAN_STATUS_LABELS[this.plan.status]);
		this.statusEl?.setAttribute("data-status", this.plan.status);

		if (this.plan.markdown !== this.renderedMarkdown) {
			this.renderedMarkdown = this.plan.markdown;
			this.bodyEl.empty();
			try {
				await MarkdownRenderer.render(this.app, this.plan.markdown, this.bodyEl, "", this);
			} catch (e) {
				log.warn("Plan markdown render failed", { error: String(e) });
				this.bodyEl.setText(this.plan.markdown);
			}
			// New revision (or first render): reload comments from the store.
			this.layer?.reset();
			await this.layer?.reapply();
		}
		this.updateFooter();
	}

	private renderComments(comments: AnchoredComment[]): void {
		const el = this.commentsEl;
		if (!el) return;
		el.empty();
		el.toggleClass("notor-hidden", comments.length === 0);
		if (comments.length > 0) {
			el.createDiv({ cls: "notor-plan-comments-header", text: comments.length === 1 ? "1 comment" : `${comments.length} comments` });
			const orphaned = this.layer?.getOrphanedIds() ?? new Set<string>();
			for (const c of comments) {
				const item = el.createDiv({ cls: "notor-plan-comment" });
				if (orphaned.has(c.id)) item.addClass("is-orphaned");
				const quote = c.quote.replace(/\s+/g, " ").trim();
				item.createDiv({ cls: "notor-plan-comment-quote", text: quote.length > 120 ? `${quote.slice(0, 117)}…` : quote });
				item.createDiv({ cls: "notor-plan-comment-body", text: c.body });
				const actions = item.createDiv({ cls: "notor-plan-comment-actions" });
				const edit = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Edit comment" } });
				setIcon(edit, "pencil");
				edit.addEventListener("click", (e) => {
					e.stopPropagation();
					this.layer?.openEditor(c.id);
				});
				const del = actions.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Delete comment" } });
				setIcon(del, "trash-2");
				del.addEventListener("click", (e) => {
					e.stopPropagation();
					this.layer?.remove(c.id);
				});
				item.addEventListener("click", () => this.layer?.scrollTo(c.id));
			}
		}
		this.updateFooter();
	}

	private buildFooter(footer: HTMLElement): void {
		this.noteEl = footer.createEl("textarea", { cls: "notor-plan-note" });
		this.noteEl.placeholder = "Overall feedback (optional)";
		this.noteEl.rows = 2;
		this.noteEl.addEventListener("input", () => this.updateFooter());

		const row = footer.createDiv({ cls: "notor-plan-actions" });
		this.sendBtn = row.createEl("button", { cls: "notor-plan-send mod-cta", text: "Send comments" });
		this.sendBtn.addEventListener("click", () => void this.sendFeedback());
		row.createDiv({ cls: "notor-plan-actions-spacer" });

		const reject = row.createEl("button", { cls: "notor-plan-reject", text: "Reject" });
		reject.addEventListener("click", () => this.decide({ kind: "reject" }));
		const approve = row.createEl("button", { cls: "notor-plan-approve", text: "Approve" });
		approve.addEventListener("click", () => this.decide({ kind: "approve" }));
		const auto = row.createEl("button", { cls: "notor-plan-approve-auto", text: "Approve & auto-accept edits" });
		auto.addEventListener("click", () => this.decide({ kind: "approve-auto-accept" }));
		this.decisionBtns = [reject, approve, auto];
	}

	private isPending(): boolean {
		return !!this.conversationId && this.plugin.getPlanReviewController().hasPending(this.conversationId);
	}

	private updateFooter(): void {
		if (!this.footerEl || !this.sendBtn) return;
		const pending = this.isPending() && !!this.plan;
		this.footerEl.toggleClass("is-pending", pending);
		const count = this.layer?.count ?? 0;
		const hasNote = (this.noteEl?.value.trim().length ?? 0) > 0;
		this.sendBtn.setText(count > 0 ? `Send comments (${count})` : "Send feedback");
		this.sendBtn.disabled = !pending || (count === 0 && !hasNote);
		for (const b of this.decisionBtns) b.disabled = !pending;
		if (this.noteEl) this.noteEl.disabled = !pending;
	}

	private decide(outcome: PlanReviewOutcome): void {
		if (!this.conversationId) return;
		this.plugin.getPlanReviewController().resolve(this.conversationId, outcome);
	}

	private async sendFeedback(): Promise<void> {
		if (!this.conversationId || !this.layer) return;
		const parts = [this.layer.compile(), this.noteEl?.value.trim() ?? ""].filter((p) => p.length > 0);
		if (parts.length === 0) return;
		const resolved = this.plugin.getPlanReviewController().resolve(this.conversationId, {
			kind: "request-changes",
			feedback: parts.join("\n\n"),
		});
		if (!resolved) return;
		await this.layer.clear();
		if (this.noteEl) this.noteEl.value = "";
		this.updateFooter();
	}

	private async openConversation(): Promise<void> {
		if (!this.conversationId) return;
		await this.plugin.openChatPanel();
		await this.plugin.getActiveOrchestrator()?.switchToConversationById(this.conversationId);
	}
}
