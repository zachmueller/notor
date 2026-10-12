/**
 * PlanReviewController — routes the user's decision on a pending plan back to
 * the suspended `submit_plan` tool call.
 *
 * A pending review can be settled from several surfaces: the tool-call card's
 * buttons, the plan leaf's footer, or a message typed into the chat input.
 * Each surface calls {@link PlanReviewController.resolve} with the
 * conversation id; the `plan-review` interaction renderer registered the
 * `settle` function that resolves the tool's interaction promise.
 *
 * Lifetime rules (a re-rendered prompt after a view switch must not leave a
 * stale "pending" entry behind):
 * - `register` returns an identity-guarded unregister — it only removes its
 *   own entry, never a later re-registration.
 * - `resolve` removes the entry after settling it.
 * - `clear` is called when the owning session ends (Stop, completion, error).
 */

import { logger } from "../utils/logger";

const log = logger("PlanReviewController");

export type PlanReviewOutcome =
	| { kind: "approve" }
	| { kind: "approve-auto-accept" }
	| { kind: "request-changes"; feedback: string }
	| { kind: "reject"; reason?: string };

interface PendingReview {
	settle: (outcome: PlanReviewOutcome) => void;
}

export class PlanReviewController {
	private readonly pending = new Map<string, PendingReview>();
	private readonly listeners = new Set<(conversationId: string) => void>();

	/**
	 * Register the settle function for a conversation's pending review.
	 * Replaces any previous registration for the same conversation.
	 *
	 * @returns An unregister function that only removes this registration.
	 */
	register(conversationId: string, settle: (outcome: PlanReviewOutcome) => void): () => void {
		const entry: PendingReview = { settle };
		this.pending.set(conversationId, entry);
		this.emit(conversationId);
		return () => {
			if (this.pending.get(conversationId) === entry) {
				this.pending.delete(conversationId);
				this.emit(conversationId);
			}
		};
	}

	/** Settle a pending review. Returns false when nothing was pending. */
	resolve(conversationId: string, outcome: PlanReviewOutcome): boolean {
		const entry = this.pending.get(conversationId);
		if (!entry) return false;
		this.pending.delete(conversationId);
		try {
			entry.settle(outcome);
		} catch (e) {
			log.error("Plan review settle failed", { conversationId, error: String(e) });
		}
		this.emit(conversationId);
		return true;
	}

	/** Drop a pending review without settling it (the owning session ended). */
	clear(conversationId: string): void {
		if (this.pending.delete(conversationId)) this.emit(conversationId);
	}

	hasPending(conversationId: string): boolean {
		return this.pending.has(conversationId);
	}

	/** Subscribe to pending-state changes. Returns an unsubscribe fn. */
	onChange(cb: (conversationId: string) => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	private emit(conversationId: string): void {
		for (const cb of this.listeners) {
			try {
				cb(conversationId);
			} catch (e) {
				log.error("PlanReviewController listener failed", { error: String(e) });
			}
		}
	}
}

let instance: PlanReviewController | null = null;

/**
 * Install the plugin-wide controller. Module-level so UI code without plugin
 * access (the interaction renderer registry) can reach it — same pattern as
 * `setChatBlockRegistry`.
 */
export function setPlanReviewController(controller: PlanReviewController | null): void {
	instance = controller;
}

export function getPlanReviewController(): PlanReviewController | null {
	return instance;
}
