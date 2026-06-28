/**
 * Orchestration progress `Notice` synthesis (INT-020 / FR-140 + INT-021 / FR-141).
 *
 * After each **conversation-step** turn completes, `StepTurnExecutor` asks this
 * helper to surface a brief progress `Notice` naming the flow, the step, the
 * iteration, and the topic the turn emitted (the "what's next" line). The markup
 * mirrors `src/tool-config/notices.ts` (`showDraftSavedNotice` ~52-65): a short
 * multi-line message + a numeric timeout, and — on desktop only — a
 * `messageEl.oncontextmenu` right-click handler guarded by `Platform.isDesktop`.
 *
 * The engine never constructs a `Notice`; this helper lives in the orchestration
 * consumer and is invoked purely through the per-step-turn completion path
 * (`src/orchestration/step-turn-executor.ts`), keeping `src/run-loop/`
 * Notice-free (run-loop contract: "Notices stay out of the engine").
 *
 * **Notice-fatigue seam (AC-4).** `showOrchestrationProgressNotice` accepts a
 * `suppress` flag so a long-running loop can withhold the toast without losing
 * progress: a suppressed turn still wrote `turn.complete` and still drove the
 * live run-tree update upstream (those happen *before* this call in the
 * executor) — only the toast is withheld. v1 callers always emit one Notice per
 * turn (the spec ships that behavior unchanged; coalescing/throttling is
 * deferred), but the suppression mechanism exists and is exercised by the unit
 * test, so any future per-flow "quiet" / first-turn-only / windowed policy is
 * just a different computation of this boolean by the caller.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-4-notices.md — INT-020, INT-021
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — RunLoopHooks Contract
 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §1 (header fields), §4 (hidden nav)
 */

import { Notice, Platform } from "obsidian";

/** Auto-dismiss timeout for a progress Notice (ms) — brief, like the other helpers. */
export const PROGRESS_NOTICE_TIMEOUT_MS = 5000;

/** Inputs for the per-turn progress Notice (INT-020 + INT-021). */
export interface OrchestrationProgressNoticeArgs {
	/** `notor-flow-name` of the running flow (conversation-header §1). */
	flowName: string;
	/** `notor-step-name` of the step that produced this turn. */
	stepName: string;
	/**
	 * The flow **hop / step-turn** counter (`session.iteration`, which includes
	 * code steps) — NOT the `notor-max-iterations` LLM-turn unit.
	 */
	iteration: number;
	/**
	 * The topic this turn emitted (or the synthesized `default_publishes` topic
	 * when the step emitted nothing) — the "what's next" line (AC-2).
	 */
	emittedTopic: string;
	/**
	 * The step conversation's id (conversation-header §1). When present on
	 * desktop, the Notice gains a right-click jump to that conversation (INT-021).
	 * Omitted → no jump affordance (e.g. a synthesized turn with no conversation).
	 */
	conversationId?: string;
	/**
	 * Invoked on desktop right-click to open the step conversation (INT-021). The
	 * caller closes this over `switchToConversationById(conversationId)` — no new
	 * navigation primitive is introduced. Omitted → no jump affordance.
	 */
	onJumpToConversation?: () => void;
	/**
	 * Notice-fatigue policy (AC-4): when `true`, no toast is shown. The turn's
	 * `turn.complete` write + run-tree update already happened upstream; only the
	 * toast is withheld. Defaults to `false` (v1 emits one Notice per turn).
	 */
	suppress?: boolean;
	/** Override the auto-dismiss timeout (ms); defaults to {@link PROGRESS_NOTICE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/**
 * Build the progress Notice's message text. Pure (no `Notice` / `Platform`
 * dependency) so the flow + step + iteration + topic contract (AC-1 / AC-2) is
 * directly unit-testable.
 *
 * Format: `[{flowName}] {stepName} · iter {iteration} → {emittedTopic}`, e.g.
 * `[Code Implementation] 📋 Planner · iter 3 → tasks.ready`. On desktop the
 * `(right-click to open step conversation)` hint is appended on its own line,
 * mirroring `showDraftSavedNotice`.
 */
export function buildProgressNoticeMessage(args: {
	flowName: string;
	stepName: string;
	iteration: number;
	emittedTopic: string;
	withJumpHint: boolean;
}): string {
	const head = `[${args.flowName}] ${args.stepName} · iter ${args.iteration} → ${args.emittedTopic}`;
	return args.withJumpHint ? `${head}\n(right-click to open step conversation)` : head;
}

/**
 * Synthesize and show the per-turn progress Notice (INT-020). On desktop, when a
 * `conversationId` + `onJumpToConversation` are supplied, right-clicking the
 * Notice opens that step conversation (INT-021) — the same `messageEl.oncontextmenu`
 * + `Platform.isDesktop` idiom as `showDraftSavedNotice`. Mobile omits the
 * right-click affordance and the hint line. A `suppress: true` call shows nothing
 * (Notice-fatigue seam, AC-4).
 */
export function showOrchestrationProgressNotice(args: OrchestrationProgressNoticeArgs): void {
	// Notice-fatigue seam (AC-4): the toast is the opt-in interrupt; the run-tree
	// (driven by the upstream session-log writes) is the always-on progress surface.
	if (args.suppress) return;

	// Desktop-only jump affordance (INT-021), gated exactly like the other helpers.
	const canJump = Platform.isDesktop && !!args.conversationId && !!args.onJumpToConversation;

	const message = buildProgressNoticeMessage({
		flowName: args.flowName,
		stepName: args.stepName,
		iteration: args.iteration,
		emittedTopic: args.emittedTopic,
		withJumpHint: canJump,
	});

	const notice = new Notice(message, args.timeoutMs ?? PROGRESS_NOTICE_TIMEOUT_MS);

	if (canJump) {
		notice.messageEl.oncontextmenu = () => {
			args.onJumpToConversation!();
		};
	}
}
