/**
 * `LoopSafetyGuards` (FEAT-008) — flow-level loop guards layered on top of the
 * per-run `RunLoop` cap. They terminate a *flow* that is stuck even when each
 * individual turn is within its per-run cap.
 *
 * Implements:
 *  1. **iteration cap** — `flow.maxIterations` counts LLM turns only (the
 *     decrement/enforcement lives in the two-layer budget model; this surfaces
 *     the predicate). Code steps do not advance it (D2/FR-117).
 *  2. **runtime cap** — wall-clock check against `flow.maxRuntimeMinutes`.
 *  3. **stale-loop detection** (self-loops) — the same `(topic, source_step)`
 *     pair (payload deliberately excluded) for `STALE_REPEAT_THRESHOLD` (4)
 *     consecutive events over a rolling window of the last `STALE_WINDOW_SIZE`.
 *
 * FEAT-008 thrashing guard removed as dead code — see F1 spec. Its live half was
 * never built (the runner never supplied a `taskKey`, and `abandonCounts` was only
 * written during resume rehydration, never during a live run). Reviving it is a
 * feature needing real task-registry abandon instrumentation, not a fix.
 *
 * The guards are **pure predicates** over the event history — no I/O, no loop
 * ownership (the runner consults them each turn). The detector predicates take the
 * window as input, so they work identically whether the state was accumulated live
 * or **rehydrated from replay on reload** (Issue-6; replay is INT-005).
 *
 * Boundary ownership: the **completion no-progress guard** (Issue-9) and the
 * **breadth-first FIFO fan-out drain** (Issue-11) are NOT here — they live at the
 * engine/runner completion + routing boundary (FEAT-003 / FEAT-010).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-008
 * @see specs/ZZ-misc/orchestration/contracts/event-engine.md — Loop Safety Guards
 */

import { STALE_REPEAT_THRESHOLD } from "./constants";
import type { OrchestrationEvent, OrchestrationFlow } from "./types";

/** A terminal verdict from a guard (or `null` when no guard fires). */
export interface SafetyGuardResult {
	/** Which guard fired. */
	guard: "iteration_cap" | "runtime_cap" | "stale_loop";
	/** Human-readable reason (carried into the terminal `FLOW_ERROR`). */
	reason: string;
}

/**
 * Stale-loop detection (pure). Returns true iff the most recent
 * `STALE_REPEAT_THRESHOLD` events share the same `(topic, source_step)` pair —
 * payload deliberately excluded (a `default_publishes` payload varies each turn,
 * so a payload-keyed signature missed the common non-converging-LLM loop). Fewer
 * than `STALE_REPEAT_THRESHOLD` events → false.
 */
export function isStale(history: OrchestrationEvent[]): boolean {
	if (history.length < STALE_REPEAT_THRESHOLD) return false;
	const recent = history.slice(-STALE_REPEAT_THRESHOLD);
	const sig = (e: OrchestrationEvent): string => `${e.topic}:${e.source_step}`;
	const first = sig(recent[0]!);
	return recent.every((e) => sig(e) === first);
}

export class LoopSafetyGuards {
	/**
	 * Iteration cap (FR-117). Fires when **LLM turns** reach `flow.maxIterations`
	 * (the aggregate `iterationsRemaining` ceiling). A code step does not advance
	 * `llmTurns`, so a code-step-only flow is bounded by the runtime cap +
	 * stale-loop, not this.
	 */
	checkIteration(llmTurns: number, flow: OrchestrationFlow): boolean {
		return llmTurns >= flow.maxIterations;
	}

	/** Runtime cap (FR-117). Fires when wall-clock since `startedAtMs` exceeds `flow.maxRuntimeMinutes`. */
	checkRuntime(startedAtMs: number, flow: OrchestrationFlow, nowMs: number = Date.now()): boolean {
		const elapsedMinutes = (nowMs - startedAtMs) / 60_000;
		return elapsedMinutes > flow.maxRuntimeMinutes;
	}

	/** Stale-loop detection — delegates to the pure {@link isStale}. */
	isStale(history: OrchestrationEvent[]): boolean {
		return isStale(history);
	}

	// FEAT-008 thrashing guard removed as dead code — see F1 spec.

	/**
	 * The combined per-turn check the runner calls. Returns the first firing
	 * guard's terminal verdict, or `null` when the flow is healthy.
	 */
	evaluate(args: {
		flow: OrchestrationFlow;
		llmTurns: number;
		startedAtMs: number;
		history: OrchestrationEvent[];
		nowMs?: number;
	}): SafetyGuardResult | null {
		const { flow, llmTurns, startedAtMs, history, nowMs } = args;

		if (this.checkIteration(llmTurns, flow)) {
			return {
				guard: "iteration_cap",
				reason: `Flow '${flow.name}' reached its LLM-turn ceiling (${flow.maxIterations}).`,
			};
		}
		if (this.checkRuntime(startedAtMs, flow, nowMs)) {
			return {
				guard: "runtime_cap",
				reason: `Flow '${flow.name}' exceeded its runtime cap (${flow.maxRuntimeMinutes} min).`,
			};
		}
		if (this.isStale(history)) {
			const last = history[history.length - 1]!;
			return {
				guard: "stale_loop",
				reason:
					`Flow '${flow.name}' is stuck in a self-loop: step '${last.source_step}' re-fired ` +
					`'${last.topic}' ${STALE_REPEAT_THRESHOLD} times in a row.`,
			};
		}
		return null;
	}
}
