/**
 * Child-flow spawn contract (INT-043/044) — the seam between the `run_flow` tool
 * (`src/tools/run-flow.ts`) and the launch wiring (`src/orchestration/launch.ts`).
 *
 * `run_flow` is a hand-written `Tool` (it needs the dynamic `flow` enum, mirroring
 * `UseSubagentTool`) and must not import the plugin/launch stack directly. It is
 * handed a {@link SpawnChildFlow} callback at construction; `launch.ts` provides
 * the real implementation ({@link launchChildFlow}) that creates a child session,
 * runs a child `OrchestrationRunner` with the inherited shared budget cell +
 * `depth + 1`, and brackets the run with the parent's `child.spawned` / `child.result`
 * ledger entries (FR-125 recovery anchors).
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — INT-043 / INT-044
 * @see specs/ZZ-misc/orchestration/contracts/tools.md — run_flow
 */

import type { AggregateBudget } from "../run-loop/types";

/** The cascade context a `run_flow` spawn inherits from the calling step's turn. */
export interface ChildSpawnContext {
	/** The SHARED tree-wide budget cell (inherited by reference — the child draws it down). */
	budget: AggregateBudget;
	/** The calling turn's depth (the child runs at `depth + 1`). */
	depth: number;
	/** Cascading abort signal from the parent run. */
	abort: AbortSignal;
}

/** A request to spawn a child flow as a tool. */
export interface SpawnChildFlowRequest {
	/** The resolved invocable flow's `notor-flow-name`. */
	flowName: string;
	/** The loose, natural-language payload conforming to the callee's `notor-flow-inputs`. */
	payload: string;
	/** The parent (caller) session id — recorded as the child's `parent_session_id`. */
	parentSessionId: string;
	/** The parent's scratchpad path — auto-allowed for a `shared`-handoff child (FR-174). */
	parentScratchpadPath: string;
	/** The calling step's conversation id (the `child` edge's source / the child's `parent` back-link target). */
	parentConversationId?: string;
	/** Synthetic correlation id for the parent's `child.spawned`/`child.result` ledger (recovery anchor). */
	viaToolCallId: string;
	/** Inherited cascade context (shared budget cell + depth + abort). */
	cascade: ChildSpawnContext;
}

/** What a child-flow spawn returns to the calling `run_flow` tool. */
export interface SpawnChildFlowResult {
	/** Terminal status of the child run. */
	status: "completed" | "cancelled" | "error";
	/** The child's `RunResult.structured` (a terminal code step's typed return), or `null`. */
	structured: unknown | null;
	/** The child's closing text (the loose fallback when `structured` is null). */
	text: string;
	/** The child run's stop reason / terminal topic. */
	stopReason: string;
	/** The child session id. */
	childSessionId: string;
	/** The child flow's entry conversation id (the `child` edge target), if any was created. */
	entryConversationId: string | null;
	/** Aggregate-subtree rollup of the child run (per-subtree `subtreeConsumed`, NOT a shared-cell delta). */
	rollup: {
		costUsd: number;
		iterations: number;
		maxDepthReached: number;
		tokenUsage: { input: number; output: number };
	};
}

/**
 * Spawn a child flow to its terminal event and return its result. Provided by
 * `launch.ts`; injected into `RunFlowTool`. Throws only on an unexpected internal
 * failure — a flow that errors returns `status: "error"` (the tool maps it to a
 * `ToolResult`, never a throw).
 */
export type SpawnChildFlow = (req: SpawnChildFlowRequest) => Promise<SpawnChildFlowResult>;
