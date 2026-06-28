/**
 * Two-layer budget helpers (ARCH-005) — the cascading **aggregate** budget layer.
 *
 * This is the SECOND of two coexisting limit layers. It does **not** replace the
 * per-run `iterationCap` (the floor); it is layered on top of it as the
 * tree-wide ceiling. A turn proceeds iff BOTH layers have headroom (see
 * {@link hasHeadroom}).
 *
 * Risk #3 (cost reachability): this module imports **only** `calculateCost` (from
 * `src/chat/message-pipeline.ts`) and the `NotorSettings` type — NO
 * `ChatOrchestrator` or any orchestrator-specific state. `calculateCost` is
 * deliberately standalone so the run-loop layer can reach cost without dragging
 * in orchestrator deps. There is **no per-child copy helper** — children share
 * the parent {@link AggregateBudget} cell by reference (ARCH-004).
 *
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — Two-Layer Limit Model, Cost
 * @see specs/ZZ-misc/orchestration/tasks/phase-0-runloop.md — ARCH-005
 */

import type { NotorSettings } from "../settings/types";
import { calculateCost } from "../chat/message-pipeline";
import type { AggregateBudget, RunContext } from "./types";

/**
 * Construct a fresh root {@link AggregateBudget} cell. `Infinity` when a ceiling
 * is unset — sub-agents seed a fresh both-`Infinity` cell so the per-run cap is
 * the only effective limit and decrementing the cell is a no-op observable-wise.
 *
 * @param maxIterations - Aggregate LLM-turn ceiling (`Infinity` if unset).
 * @param maxCostUsd - Aggregate USD ceiling (`Infinity` if unset).
 */
export function newRootBudget(
	maxIterations: number = Infinity,
	maxCostUsd: number = Infinity,
): AggregateBudget {
	return {
		iterationsRemaining: maxIterations,
		costRemainingUsd: maxCostUsd,
	};
}

/**
 * Compute a turn's cost in USD via the standalone `calculateCost` helper.
 *
 * `calculateCost` returns `number | null` (null when no pricing is configured
 * for the model). The budget layer treats an unknown cost as `0` — an unpriced
 * model never draws down the cost ceiling (the iteration ceiling still bounds
 * it). This keeps the cost cell strictly monotonic and avoids `NaN` propagation.
 */
export function computeTurnCostUsd(
	inputTokens: number,
	outputTokens: number,
	modelId: string,
	settings: NotorSettings,
): number {
	return calculateCost(inputTokens, outputTokens, modelId, settings) ?? 0;
}

/**
 * Decrement the SHARED {@link AggregateBudget} cell **in place** after a turn
 * completes. Mutating in place is the whole point: the decrement is immediately
 * visible to the parent, siblings, and children that reference the same cell, so
 * the ceiling is genuinely tree-wide.
 *
 * Decrementing an `Infinity` cell leaves it `Infinity` (nothing observable
 * changes) — that is why sub-agents (fresh both-`Infinity` cell) behave
 * identically to today.
 *
 * @param budget - The shared cell (mutated in place).
 * @param turnCostUsd - This turn's cost in USD (from {@link computeTurnCostUsd}).
 * @param turnIterations - LLM turns to subtract (normally 1; a code step is not
 *   an LLM turn and passes 0).
 */
export function decrementAggregate(
	budget: AggregateBudget,
	turnCostUsd: number,
	turnIterations: number = 1,
): void {
	budget.iterationsRemaining -= turnIterations;
	budget.costRemainingUsd -= turnCostUsd;
}

/**
 * The two-layer decision rule: a turn proceeds **iff all three conditions hold**:
 *
 * ```
 * localIterations < iterationCap
 *   AND runContext.budget.iterationsRemaining > 0
 *   AND runContext.budget.costRemainingUsd    > 0
 * ```
 *
 * Whichever layer is tighter wins. The aggregate gate is strict-positive
 * (`> 0`), NOT "enough headroom for the next turn" — so a runner at any positive
 * remainder admits ONE more full turn (the deliberate soft-ceiling property).
 *
 * For sub-agents the cell is both-`Infinity`, so the rule collapses to
 * `localIterations < iterationCap` — byte-identical to today.
 */
export function hasHeadroom(
	runContext: RunContext,
	localIterations: number,
	iterationCap: number,
): boolean {
	return (
		localIterations < iterationCap &&
		runContext.budget.iterationsRemaining > 0 &&
		runContext.budget.costRemainingUsd > 0
	);
}

/**
 * Derive a child {@link RunContext} from a parent's when spawning a nested run.
 *
 * The child inherits the parent's `budget` cell **by reference** (the spread
 * copies the reference, so the child's per-turn decrements draw down the SAME
 * tree-wide ceiling) and `depth + 1`. It constructs a **fresh** `subtreeConsumed`
 * (zeroed) — the subtree accumulator is per-node, not shared. The abort signal
 * cascades from the parent.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — RunContext (child inheritance)
 */
export function deriveChildContext(parent: RunContext): RunContext {
	return {
		...parent,
		depth: parent.depth + 1,
		subtreeConsumed: { costUsd: 0, iterations: 0, maxDepthReached: parent.depth + 1 },
	};
}

/**
 * The spawn gate: a child run (nested `use_subagent` / `run_flow`) may be
 * spawned **iff**:
 *
 * ```
 * runContext.depth < runContext.maxDepth
 *   AND runContext.budget.iterationsRemaining > 0
 *   AND runContext.budget.costRemainingUsd    > 0
 * ```
 *
 * Sub-agents pass `maxDepth = 0`, so the top-level sub-agent (`depth = 0`) fails
 * `0 < 0` for a nested `use_subagent` → rejected exactly as the binary
 * `_isSubAgentContext` ban does today. Flows pass `maxDepth = N` or `Infinity`.
 *
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — Spawn gate
 */
export function canSpawnChild(runContext: RunContext): boolean {
	return (
		runContext.depth < runContext.maxDepth &&
		runContext.budget.iterationsRemaining > 0 &&
		runContext.budget.costRemainingUsd > 0
	);
}
