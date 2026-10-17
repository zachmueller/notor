/**
 * Orchestration engine constants (design Phase 1).
 *
 * The finite runaway-ceiling defaults the `FlowDefinitionParser` (FEAT-002)
 * injects when a flow omits them — so every flow is bounded by construction
 * (FR-117 / FR-119a; Issue-8). Values are the authority of
 * specs/ZZ-misc/orchestration/data-model.md and contracts/vault-schema.md.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-002 (finite ceiling defaults)
 */

/** Aggregate LLM-turn ceiling injected when `notor-max-iterations` is omitted (never `Infinity`). */
export const DEFAULT_MAX_ITERATIONS = 100;

/** Wall-clock cap (minutes) injected when `notor-max-runtime-minutes` is omitted. */
export const DEFAULT_MAX_RUNTIME_MINUTES = 60;

/** Aggregate USD cost ceiling injected when `notor-max-cost-usd` is omitted (never `Infinity`). */
export const DEFAULT_MAX_COST_USD = 5.0;

// ---------------------------------------------------------------------------
// Safety-guard thresholds (FEAT-008, FEAT-003)
// ---------------------------------------------------------------------------

/**
 * Stale-loop detection (FEAT-008): the loop is stale when the most recent
 * `STALE_REPEAT_THRESHOLD` events share the same `(topic, source_step)` pair
 * (payload deliberately excluded). Raised 3→4 to offset the looser signature.
 *
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md — Stale-loop detection
 */
export const STALE_REPEAT_THRESHOLD = 4;

/** Rolling-window size the stale detector inspects (holds 5 for context; trigger is 4 consecutive). */
export const STALE_WINDOW_SIZE = 5;

// FEAT-008 thrashing guard removed as dead code — see F1 spec. The former
// THRASHING_ABANDON_THRESHOLD constant was deleted with it.

/**
 * Completion no-progress guard (FEAT-003 / FEAT-010, Issue-9): terminate with
 * `FLOW_ERROR` after this many consecutive blocked `FLOW_COMPLETE` from the same
 * step whose blocking set did NOT shrink.
 *
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md — Completion no-progress guard
 */
export const COMPLETION_NOPROGRESS_THRESHOLD = 3;

/** Number of recent events the step prompt scaffold injects as "EVENT HISTORY". */
export const EVENT_HISTORY_PROMPT_LIMIT = 10;

// ---------------------------------------------------------------------------
// Code-step execution (Phase 3, INT-010)
// ---------------------------------------------------------------------------

/**
 * Default per-step timeout for a `notor-step-mode: code` step (seconds),
 * overridable per step via `notor-step-timeout-seconds`. 300 s (5 min) — not the
 * 60 s an MCP-style convention suggests — because build/test verification is a
 * primary code-step use case and the outer guard must comfortably exceed any
 * inner `utils.executeShellCommand` `timeoutSeconds`.
 *
 * Known limitation (Issue-7): the guard is a `setTimeout`-based race around a
 * `new AsyncFunction` on the main event-loop thread (no Worker/VM isolation in
 * v1), so it only fires at `await` boundaries — an unbounded *synchronous* loop
 * is NOT interruptible.
 *
 * @see specs/ZZ-misc/orchestration/contracts/orchestration-helper.md
 */
export const DEFAULT_CODE_STEP_TIMEOUT_SECONDS = 300;
