/**
 * Run-loop substrate types (design Phase 0).
 *
 * These are the shapes the generalized headless turn-loop engine (`RunLoop`)
 * is built on. They are imported by `run-loop.ts`, `budget.ts`, `semaphore.ts`
 * and by `use-subagent.ts` (the cascade seam). The module is deliberately free
 * of any `src/chat/` orchestrator dependency — `RunLoop` is NOT
 * `ChatOrchestrator.responseLoop()` and must not absorb compaction / context
 * management / view rendering.
 *
 * Shape authority: specs/ZZ-misc/orchestration/data-model.md (Run-Loop Substrate
 * Types). Behavior authority: specs/ZZ-misc/orchestration/contracts/run-loop.md.
 * If the two ever diverge, data-model.md wins for shapes and run-loop.md wins for
 * behavior.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-0-runloop.md — ARCH-001
 */

import type { LLMProvider, ChatMessage, ToolDefinition } from "../providers/provider";
import type { ConversationMode } from "../types";
import type { ToolDispatcher } from "../chat/dispatcher";
import type { NotorSettings } from "../settings/types";

// ---------------------------------------------------------------------------
// Aggregate budget — the SHARED tree-wide cell
// ---------------------------------------------------------------------------

/**
 * The aggregate budget is a **single mutable object shared by reference across
 * the whole run tree** — NOT a value copied into each child. Every
 * {@link RunContext} in one call tree points at the *same* `AggregateBudget`
 * instance, so any node's decrement is immediately visible to the parent,
 * siblings, and children. That sharing is what makes the ceiling genuinely
 * *tree-wide*: a spread-copied `number` would give each branch its own private
 * allowance (a per-branch budget), defeating the purpose.
 *
 * Sub-agents seed a fresh both-`Infinity` cell, so the per-run cap is the only
 * effective limit and decrementing the cell changes nothing observable.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — AggregateBudget
 */
export interface AggregateBudget {
	/**
	 * AGGREGATE tree-wide ceiling, counts LLM TURNS ONLY (`Infinity` for
	 * sub-agents). This is NOT the per-run cap. Code steps (zero tokens, not an
	 * LLM turn) do NOT decrement this.
	 */
	iterationsRemaining: number;
	/**
	 * AGGREGATE tree-wide cost ceiling in USD (`Infinity` for sub-agents). Code
	 * steps do NOT decrement this.
	 */
	costRemainingUsd: number;
}

/**
 * Per-subtree consumed accounting — the authority for `child_run_metadata`'s
 * aggregate numbers (design Phase 7). Distinct from the shared {@link AggregateBudget}
 * cell: each child run constructs its OWN `SubtreeConsumed` and folds a settled
 * child's totals into its parent's on return, so a node reports only the spend
 * of ITS OWN subtree, never absorbing concurrent siblings' spend.
 *
 * In Phase 0 this is **write-only bookkeeping** — `RunLoop` accumulates into it
 * per turn but it gates nothing, so sub-agent behavior is unchanged.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — SubtreeConsumed
 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §5
 */
export interface SubtreeConsumed {
	/** This node's own turns + settled descendants' subtree cost (USD). */
	costUsd: number;
	/** LLM turns: this node + settled descendants. */
	iterations: number;
	/** Deepest depth reached at or below this node. */
	maxDepthReached: number;
}

// ---------------------------------------------------------------------------
// RunContext — the cascading tree-scoped descriptor
// ---------------------------------------------------------------------------

/**
 * Carried as an optional field `runContext?` on `ToolExecuteOptions`
 * (`src/tools/tool.ts`), assembled once in `ToolDispatcher.dispatch()`. Mutable,
 * cascading, tree-scoped — deliberately NOT merged into `ToolSessionContext`
 * (a stable per-dispatch read-accessor). Different lifecycles → kept composed,
 * not conflated (FR-102).
 *
 * A child run inherits the parent's `budget` **by reference**
 * (`{ ...parent, depth: depth + 1 }` copies the reference, so the cell is
 * shared) and `depth + 1`, but constructs a **fresh** `subtreeConsumed`
 * (zeroed) — the subtree accumulator is *not* shared.
 *
 * Sub-agents seed `maxDepth = 0` and a fresh both-`Infinity` `budget` → today's
 * behavior, by construction.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — RunContext
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — Depth Model
 */
export interface RunContext {
	/** Current nesting depth (0 = top level). */
	depth: number;
	/** 0 for sub-agents (no nesting); N or Infinity for flows. */
	maxDepth: number;
	/** SHARED tree-wide aggregate cell (by reference, never value-copied per child). */
	budget: AggregateBudget;
	/** PER-SUBTREE accumulator (NOT shared); authority for `child_run_metadata`. */
	subtreeConsumed: SubtreeConsumed;
	/** Cascades from the parent — a parent abort cascades into this run. */
	abort: AbortSignal;
}

// ---------------------------------------------------------------------------
// OrchestrationToolContext — per-step session carriage
// ---------------------------------------------------------------------------

/**
 * Per-step orchestration session carriage. Carried as an optional field
 * `orchestrationContext?` on `ToolExecuteOptions`, **distinct** from both
 * {@link RunContext} and `ToolSessionContext` — assembled once at the single
 * `ToolDispatcher.dispatch()` assembly site, exactly like `runContext`.
 *
 * It delivers per-step orchestration session identity *into* a tool's
 * `execute()` and carries the captured emission *back out* (the mutable
 * `pendingEmission` slot) for the executor to read after the turn. Each step
 * turn gets its own instance, so concurrent step turns / `run_flow` children
 * never share or race on it.
 *
 * **Sub-agents pass `orchestrationContext: undefined`** — preserving today's
 * behavior, where `SubAgentRunner` supplies no session context to
 * `executeToolBatches`. The consumer of `pendingEmission` (`emit_event`,
 * `StepTurnExecutor`) arrives in Phase 1; Phase 0 only establishes the seam.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — OrchestrationToolContext
 */
export interface OrchestrationToolContext {
	/** Owning orchestration session. */
	sessionId: string;
	/** `sessions/{id}/scratchpad/` — auto-allowed in path enforcement (INT-001). */
	scratchpadPath: string;
	/** `sessions/{id}/tasks/`. */
	tasksPath: string;
	/** Present for `shared`-handoff children (auto-allowed too; FR-174). */
	parentScratchpadPath?: string;
	/**
	 * The calling step's conversation id for this turn (INT-043). `run_flow` reads
	 * it to write the `child` edge (calling step → child flow's entry conversation)
	 * and to pass the reciprocal `parent` back-link into the child session.
	 * `undefined` for code-step turns (a code step has no conversation) and for any
	 * non-orchestration carriage.
	 */
	conversationId?: string;
	/**
	 * Child-flow edges this turn produced (INT-043 / FR-178). `run_flow` appends a
	 * `{ kind: "child", conversation_id, session_id, via_tool_call_id }` edge here;
	 * `StepTurnExecutor` merges them into the persisted step conversation's
	 * `orchestration_edges` header so the run-tree can descend into the child flow.
	 * Optional — `undefined` for sub-agents and any non-orchestration carriage.
	 */
	childEdges?: import("../types").OrchestrationEdge[];
	/**
	 * Mutable capture slot — `emit_event` writes here during `execute()`; the
	 * executor reads it post-turn (last-write-wins within a turn).
	 */
	pendingEmission: { topic: string; payload: string; structured?: unknown } | null;
	/**
	 * Audit back-channel for the within-turn overwrite policy (Issue-13e,
	 * FEAT-009 → FEAT-006). `emit_event` pushes `{ prev_topic, new_topic }` here
	 * when it overwrites a pending non-terminal emission (last-write-wins) or
	 * rejects an attempt to overwrite a latched terminal; `StepTurnExecutor`
	 * flushes these to `session-log.jsonl` as `event.emission_overwritten`
	 * entries after the turn. Optional — `undefined` for sub-agents and any
	 * non-orchestration carriage; the scaffold no-ops the audit when it is absent.
	 */
	emissionOverwrites?: Array<{ prev_topic: string; new_topic: string }>;
	/**
	 * Step→workflow spend accumulator (INT-031 / FR-151). The `invoke_workflow`
	 * tool pushes each invoked workflow's reported `{ costUsd, iterations }` here
	 * during a step turn; `StepTurnExecutor` drains it **after** the turn and folds
	 * the totals into the shared `RunContext.budget` cell in one `decrementAggregate`
	 * (post-hoc reconciliation — the background-workflow loop has no `RunContext`,
	 * so it cannot decrement live). Optional — `undefined` for sub-agents and any
	 * non-orchestration carriage; the tool no-ops the accounting when it is absent.
	 *
	 * @see specs/ZZ-misc/orchestration/contracts/tools.md — run_flow vs step→workflow
	 */
	workflowInvocations?: Array<{ costUsd: number; iterations: number }>;
	/**
	 * Child-flow subtree rollup accumulator (INT-043/047 / FR-177). The `run_flow`
	 * tool pushes each settled child flow's per-subtree totals here during a step
	 * turn; `OrchestrationRunner` drains it **after** the turn and folds them into
	 * the run-level `subtreeConsumed` + token totals so the parent's
	 * `child_run_metadata` (and the root run-tree header rollup) reflects the
	 * **whole** descendant subtree — not just its own turns. This is *attribution
	 * only*: the child's turns already decremented the **shared** `AggregateBudget`
	 * cell by reference (tree-wide ceiling), so the fold must NOT re-decrement the
	 * budget. Optional — `undefined` for sub-agents and any non-orchestration
	 * carriage; the tool no-ops the rollup when it is absent.
	 *
	 * @see specs/ZZ-misc/orchestration/contracts/edges.md — §5 (subtreeConsumed fold)
	 */
	childRunResults?: Array<{
		costUsd: number;
		iterations: number;
		maxDepthReached: number;
		tokenUsage: { input: number; output: number };
	}>;
}

// ---------------------------------------------------------------------------
// ResolvedProviderConfig — pinned per step turn (ARCH-007)
// ---------------------------------------------------------------------------

/**
 * The provider/model a step turn runs on, resolved by a **pure** function
 * (`resolvePersonaProviderConfig`, ARCH-007) and **pinned** into the step's
 * session — NEVER applied to the global `ProviderRegistry`. This is the
 * concurrency-correctness foundation: two concurrent step turns each carry their
 * own pinned model, and no step turn mutates shared provider/model state.
 *
 * Mirrors the existing workflow precedent `resolveWorkflowProviderConfig()`
 * (`src/chat/workflow-executor.ts`).
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — ResolvedProviderConfig
 */
export interface ResolvedProviderConfig {
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
}

// ---------------------------------------------------------------------------
// RunResult — always-both result
// ---------------------------------------------------------------------------

/** Why a run stopped. The aggregate cost ceiling yields `cost_cap`; a blocked spawn yields `depth_cap`. */
export type RunStopReason =
	| "completed"
	| "iteration_cap"
	| "token_limit"
	| "context_window"
	| "cost_cap"
	| "depth_cap";

/**
 * The result of a `RunLoop.run()`. `structured` is populated only by a terminal
 * code step that passes a third argument to
 * `orchestration.emit(topic, payload?, structured?)` (Phase 3); a conversation
 * step leaves it `null`. `SubAgentResult` (`src/chat/sub-agent-runner.ts`) is a
 * strict subset of this — `structured` always null.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — RunResult (always-both)
 */
export interface RunResult {
	/** Always present (final / wind-down output). */
	text: string;
	/** Populated only by a terminal code step's `emit(...)` third arg; otherwise `null`. */
	structured: unknown;
	/** Full conversation messages. */
	messages: ChatMessage[];
	/** Cumulative token usage across all turns. */
	tokenUsage: { input: number; output: number };
	/** Number of LLM turns executed. */
	iterationCount: number;
	/** Why the run stopped. */
	stopReason: RunStopReason;
}

// ---------------------------------------------------------------------------
// TurnOutcome — per-turn summary passed to onTurnComplete
// ---------------------------------------------------------------------------

/**
 * Per-turn summary handed to {@link RunLoopHooks.onTurnComplete}. Carries enough
 * for orchestration to write the `turn.complete` log entry, synthesize the
 * per-turn progress Notice, and roll up token usage. The engine's correctness
 * does NOT depend on a hook consuming this.
 *
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — RunLoopHooks Contract
 */
export interface TurnOutcome {
	/** Assistant text produced this turn. */
	text: string;
	/** Tool calls the model made this turn (names + ids). */
	toolCalls: { toolName: string; toolCallId: string }[];
	/** Token usage for this turn alone. */
	tokenUsage: { input: number; output: number };
	/** Cost for this turn alone in USD (computed via `calculateCost`; `0` when pricing is unknown). */
	costUsd: number;
}

// ---------------------------------------------------------------------------
// RunLoopHooks — the optional lifecycle seam
// ---------------------------------------------------------------------------

/**
 * The minimal optional lifecycle surface orchestration attaches persistence,
 * progress Notices, and run-tree navigation to in Phase 1 (FEAT-007) — WITHOUT
 * baking them into the engine. Keep this surface minimal: do NOT pull in
 * `ChatOrchestrator`'s compaction / context management (hook-creep risk).
 *
 * All hooks are optional and observe only — they cannot veto a turn, mutate
 * `RunContext`, or change `stopReason`. Hooks may be async and are awaited at
 * their boundary. A throwing hook is logged and swallowed; the run continues.
 *
 * @see specs/ZZ-misc/orchestration/contracts/run-loop.md — RunLoopHooks Contract
 */
export interface RunLoopHooks {
	/** Immediately before each LLM call (after the budget/cap check passes). `turn` is 1-based. */
	onTurnStart?(turn: number): void | Promise<void>;
	/** After a turn's tool batch settles. Not called for a turn skipped by the budget gate. */
	onTurnComplete?(turn: number, result: TurnOutcome): void | Promise<void>;
	/** At persistence points (turn boundary / terminal). Orchestration persists the step conversation. */
	onPersist?(messages: ChatMessage[]): void | Promise<void>;
	/** On streaming/status updates. Mirrors the existing `SubAgentRunnerOptions.onProgress`. */
	onProgress?(status: string): void;
}

// ---------------------------------------------------------------------------
// RunLoopOptions — the engine's input bag
// ---------------------------------------------------------------------------

/**
 * Constructor input for {@link RunLoop}. `iterationCap` defaults to
 * `SUB_AGENT_ITERATION_CAP` (20) and `tokenLimit` to `SUB_AGENT_TOKEN_LIMIT`
 * (0 = none) when unset.
 *
 * `model` is the model the run executes on, supplied by the caller — never the
 * global `ProviderRegistry` active model (ARCH-007). For orchestration step
 * turns it is the pinned `ResolvedProviderConfig.modelId`; for sub-agents it is
 * the sub-agent profile's model.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — RunLoopOptions / RunLoopHooks
 */
export interface RunLoopOptions {
	/** Resolved LLM provider instance. */
	provider: LLMProvider;
	/** Model ID for this run (caller-supplied; pinned, never read from the global registry). */
	model: string;
	/** Full system prompt (preamble + body). */
	systemPrompt: string;
	/** Tool definitions available to this run (already filtered). */
	toolDefinitions: ToolDefinition[];
	/** Dispatcher with pre-clamped effective config. */
	dispatcher: ToolDispatcher;
	/** Conversation mode (Plan / Act). */
	mode: ConversationMode;
	/** Per-run cap; default `SUB_AGENT_ITERATION_CAP` (20). */
	iterationCap?: number;
	/** Per-run total-token limit; default `SUB_AGENT_TOKEN_LIMIT` (0 = none). */
	tokenLimit?: number;
	/** Inherited thinking level (null = off). Repo convention is `string | null`. */
	thinkingLevel?: string | null;
	/**
	 * Settings used to price per-turn cost via `calculateCost` (ARCH-005). When
	 * omitted, per-turn cost is treated as `0` (the iteration ceiling still
	 * bounds the run) — sub-agents pass `undefined` here, so the cost cell is
	 * never drawn down and behavior is unchanged.
	 */
	settings?: NotorSettings;
	/** Depth + SHARED aggregate budget + abort. */
	runContext: RunContext;
	/** Per-step session carriage; `undefined` for sub-agents. */
	orchestrationContext?: OrchestrationToolContext;
	/** Optional lifecycle hooks (persistence / Notices / nav). */
	hooks?: RunLoopHooks;
	/** Optional progress callback (status string). */
	onProgress?: (status: string) => void;
}
