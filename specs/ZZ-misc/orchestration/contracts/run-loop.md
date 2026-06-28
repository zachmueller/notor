# Contract: RunLoop Substrate

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-100 group)
**Data Model:** [../data-model.md](../data-model.md) (Run-Loop Substrate Types)
**Tasks:** [../tasks.md](../tasks.md) · [../tasks/phase-0-runloop.md](../tasks/phase-0-runloop.md) (ENV-001/002, ARCH-001…006)
**Sibling contracts:** [edges.md](edges.md) · [tools.md](tools.md) · [orchestration-helper.md](orchestration-helper.md) · [vault-schema.md](vault-schema.md)
**Status:** Draft

---

## Overview

This contract is the **authority** for the run-loop substrate's interface and behavior:

1. the `RunLoop` class surface and its responsibilities;
2. the **two-layer limit decision rule** (per-run cap vs aggregate tree budget);
3. the **depth model** that replaces the binary sub-agent recursion ban;
4. the **`RunLoopHooks`** semantics (the seam orchestration attaches persistence/Notices/nav to);
5. the **shared semaphore** behavior (run-tree concurrency);
6. the **behavior-preservation gate** that proves the extraction is non-breaking.

The substrate is a new module `src/run-loop/` (`types.ts`, `run-loop.ts`, `budget.ts`), extracted from
the existing `SubAgentRunner` (`src/chat/sub-agent-runner.ts`, which already describes itself as "a
lightweight mini-orchestrator"). After extraction, **both** `SubAgentRunner` *and* the orchestration
`StepTurnExecutor` / `run_flow` consume the same engine.

Type **shapes** (`RunContext`, `RunResult`, `RunLoopOptions`, `RunLoopHooks`) are owned by
[../data-model.md](../data-model.md). They are restated here for readability and **must match
data-model.md exactly**; if the two ever diverge, data-model.md wins for shapes and this file wins for
behavior.

---

## What `RunLoop` does *not* do

The engine is deliberately lean. It is **not** `ChatOrchestrator.responseLoop()` and must not absorb
its responsibilities. The following stay out of the engine and (where needed) attach via hooks:

- **Persistence** (JSONL conversation files) — attached by the orchestration consumer via `onPersist`.
- **Compaction / context management** — `ChatOrchestrator`'s concern; never pulled into `RunLoop`.
- **View rendering, persona switching, global state mutation** — caller's concern.
- **Event routing** — the orchestration engine reads the emitted event *after* `run()` returns
  (no mid-turn routing); `RunLoop` neither knows nor cares about topics.

If a prospective consumer needs compaction or view management, it is not a `RunLoop` consumer.

---

## `RunLoop` Class Surface

```typescript
// src/run-loop/run-loop.ts
class RunLoop {
  constructor(options: RunLoopOptions);
  run(prompt: string): Promise<RunResult>;
}
```

`RunLoopOptions` / `RunLoopHooks` (authority: [../data-model.md](../data-model.md); restated):

```typescript
interface RunLoopOptions {
  provider: LLMProvider;
  model: string;
  systemPrompt: string;
  toolDefinitions: ToolDefinition[];
  dispatcher: ToolDispatcher;
  mode: ConversationMode;
  iterationCap?: number;        // per-run cap; default SUB_AGENT_ITERATION_CAP (20)
  tokenLimit?: number;          // per-run; default SUB_AGENT_TOKEN_LIMIT (0 = none)
  thinkingLevel?: ThinkingLevel | null;
  runContext: RunContext;       // depth + SHARED aggregate budget + abort
  orchestrationContext?: OrchestrationToolContext;  // per-step session carriage; undefined for sub-agents
  hooks?: RunLoopHooks;
  onProgress?: (status: string) => void;
}

interface RunLoopHooks {
  onTurnStart?(turn: number): void | Promise<void>;
  onTurnComplete?(turn: number, result: TurnOutcome): void | Promise<void>;
  onPersist?(messages: ChatMessage[]): void | Promise<void>;
  onProgress?(status: string): void;
}
```

`RunResult` (authority: [../data-model.md](../data-model.md); restated):

```typescript
interface RunResult {
  text: string;                       // always present (final / wind-down output)
  structured: unknown | null;         // populated only by a terminal code step (via emit's 3rd arg)
  messages: ChatMessage[];
  tokenUsage: { input: number; output: number };
  iterationCount: number;
  stopReason: "completed" | "iteration_cap" | "token_limit" | "context_window" | "cost_cap" | "depth_cap";
}
```

**`model` is pinned, never global (ARCH-007).** `RunLoopOptions.model` is the model the run executes
on, supplied by the caller. For orchestration step turns it is the pinned `ResolvedProviderConfig.modelId`
resolved by the pure `resolvePersonaProviderConfig(...)` and carried on the step's `ConversationSession`
([../data-model.md](../data-model.md) `ResolvedProviderConfig`) — `RunLoop` never reads the global
`ProviderRegistry` active model, so concurrent runs with different models do not race. For sub-agents it
is the sub-agent profile's model, exactly as today.

**`orchestrationContext` carriage (authority: [../data-model.md](../data-model.md)).** `RunLoop`
threads `orchestrationContext` (when present) into `executeToolBatches` so orchestration tools
(`emit_event`, task tools) can read the active session and write their captured emission into the
context's `pendingEmission` slot — which `StepTurnExecutor` reads back after the turn. It rides the
dispatch seam *beside* `runContext`, assembled at the single `ToolDispatcher.dispatch()` site, and is
**not** merged into `ToolSessionContext` (same different-lifecycle rationale as `runContext`, FR-102).
**Sub-agents pass `orchestrationContext: undefined`** — `SubAgentRunner` already supplies no session
context to `executeToolBatches` today, so this is behavior-preserving by construction.

**`structured` data path.** `RunLoop` does not itself populate `structured`; a terminal code step
does, via `orchestration.emit(topic, payload?, structured?)` → `CodeStepResult.structured`, which the
`OrchestrationRunner`/`StepTurnExecutor` lifts onto the terminal `RunResult.structured`. For
sub-agents and conversation-only runs, `structured` is always `null`.

### Responsibilities

| Responsibility | Behavior | Lifted from |
|---|---|---|
| **Turn loop** | `while (localIterations < iterationCap && budget headroom)`: stream-parse → `partitionToolCalls` → `executeToolBatches` → append results → repeat. Inherits batched/parallel intra-turn dispatch for free. | `sub-agent-runner.ts` `run()` ~151-359 (`executeToolBatches` call ~318) |
| **Per-run caps** | iteration cap (default 20), token limit (default 0 = none), context-window proximity (pre-flight reserve `lastInputTokens + 4096` vs `getContextWindow(model)`). | `sub-agent-runner.ts` ~163-205 |
| **Wind-down** | On any terminal cap (`iteration_cap` / `token_limit` / `context_window` / `cost_cap`), run a final summarization turn and return its text as `RunResult.text`. | `sub-agent-runner.ts` `runWindDown()` ~365-445 |
| **Abort cascade** | Own `AbortController` linked to `runContext.abort`; parent abort cascades to this run (and to children, since each child inherits a derived signal). Checked before each LLM call. | `sub-agent-runner.ts` ~127-142, ~165 |
| **Budget accounting** | Per-turn: decrement the shared `runContext.budget` cell (`iterationsRemaining` / `costRemainingUsd`) in place after each turn completes; add the turn's spend to `runContext.subtreeConsumed`; surface per-turn `cost_usd` / `token_usage` to the consumer (recorded on `turn.complete` for reload reconstruction); check the shared cell **before** the next turn (see decision rule). | new (`budget.ts`, ARCH-005) |
| **Hooks** | Fire optional `onTurnStart` / `onTurnComplete` / `onPersist` / `onProgress` at the loop boundaries. | new (ARCH-001) |
| **Dispatch seam** | Tools dispatched via `executeToolBatches`, which threads `ToolExecuteOptions` (carrying `runContext?`, assembled once in `ToolDispatcher.dispatch()`). | `tool-orchestration.ts` `executeToolBatches` ~114; `dispatcher.ts` ~666 |

`run()` returns when the loop reaches `completed` (no tool calls / explicit completion) or any terminal
cap fires. Tasks: `RunLoop` itself is **ARCH-002**; the budget helpers are **ARCH-005**.

---

## Two-Layer Limit Model

There are **two independent limit layers**. The aggregate budget is layered *on top of* the per-run
cap — it does **not** replace it. Conflating them is the single most common way to break
behavior-preservation during the extraction.

| Layer | Scope | Lives on | Purpose | Status |
|---|---|---|---|---|
| **Per-run cap** (floor) | One runner | `RunLoop.iterationCap` (= `SUB_AGENT_ITERATION_CAP = 20`, from `src/sub-agents/constants.ts`); `tokenLimit` likewise | Stop a *single* loop from spinning; resets fresh for every runner | **Unchanged** by this refactor |
| **Aggregate budget** (ceiling) | The whole call tree | `RunContext.budget` → a **shared `AggregateBudget` cell** (`iterationsRemaining` / `costRemainingUsd`), referenced by every `RunContext` in the tree | Stop a *deep/wide tree* from collectively over-spending even when every node is individually under its per-run cap | **New** (composition needs it) |

> **Unit of `iterationsRemaining`: LLM turns only.** `notor-max-iterations` maps to
> `AggregateBudget.iterationsRemaining` ([../data-model.md](../data-model.md)) and is decremented once
> **per LLM turn**. A **code step is not an LLM turn** (zero tokens, no `RunLoop` run) and decrements
> **neither** `iterationsRemaining` **nor** `costRemainingUsd`. Code steps are bounded instead by
> wall-clock `max_runtime` and the engine's stale-loop detector (orchestration overlay, see
> [event-engine.md](event-engine.md)) — a flow or cycle composed only of code steps is **not** bounded
> by `max_iterations`.

> **The aggregate budget is a SHARED CELL, not a per-child copy** ([../data-model.md](../data-model.md)
> `AggregateBudget`). Every `RunContext` in one call tree references the *same* `AggregateBudget`
> object; a child inherits it **by reference** (`{ ...parent, depth: depth + 1 }` copies the
> reference). Any node's decrement is immediately visible tree-wide — which is the whole point: a
> spread-copied `number` would give each branch a private allowance and silently degrade the
> "tree-wide ceiling" into a per-branch one. This is the load-bearing correction; the rest of this
> section assumes the shared cell.

### Decision rule

A turn proceeds **iff all three conditions hold**:

```
localIterations < iterationCap
  AND RunContext.budget.iterationsRemaining > 0
  AND RunContext.budget.costRemainingUsd    > 0
```

Whichever layer is tighter wins. (Per-run `tokenLimit` and context-window proximity are additional
per-run terminal conditions, evaluated as today; they trigger wind-down, not a budget block.)

### Resolved policies

1. **Independent layers, both must pass.** The aggregate budget is additive on top of the per-run
   cap, never a substitute. A reader seeing `budget.iterationsRemaining` on `RunContext` must not
   assume it supersedes `iterationCap`.
2. **Per-turn decrement of the shared cell, checked before each turn (decrement-after / check-before).**
   As each turn completes, the turn's cost/iteration is subtracted from the **shared** `AggregateBudget`
   cell (mutated in place, so parent/siblings/children all see it), and the next turn is gated on the
   cell before it begins — catching cost drift between turns, not only at spawn boundaries. The gate is
   strict-positive (`costRemainingUsd > 0`), **not** "enough headroom for the next turn" — so a runner
   at any positive remainder admits **one more full turn**. This is a deliberate, inherent soft-ceiling
   property (see policy #3); per-turn cost is computed via `calculateCost` ([Cost](#cost)) and recorded
   on the `turn.complete` log entry for reload reconstruction (policy #5).
3. **Exhaustion blocks new child spawns only; the ceiling is a SOFT ceiling (bounded overshoot).** When
   the shared cell hits zero, no new children launch; **in-flight runs finish their current turn
   gracefully** — no hard-abort, no forced mid-turn wind-down. The cost ceiling is therefore
   overshootable by **up to one full turn's spend per in-flight runner**, from *two independent* causes:
   - **(a) Decrement-after / check-before — applies even serially (concurrency = 1).** Because cost is
     subtracted *after* a turn and the gate is `> 0`, a runner sitting at `$0.01` still runs one more
     whole turn, whose spend is itself unbounded by the budget (it scales with model, output length,
     and intra-turn tool fan-out). No cost **pre-flight reservation** is attempted because per-turn cost
     is not knowable before the turn — so this overshoot is *inherent*, not a defect. (Contrast the
     context-window cap, which **does** pre-flight-reserve `lastInputTokens + 4096` because that is
     known in advance.)
   - **(b) Concurrency check-then-act.** Concurrent in-flight turns check-then-act across `await`
     points, adding one turn's overshoot per concurrent runner; no lock is taken on the cell. **In v1 a
     flow tree runs one LLM turn at a time** (single-threaded routing; `run_flow` is a `write` tool
     serialized within a turn; recursive `run_flow` is a serial awaited chain), so the only
     genuinely-parallel children are **sub-agents** (semaphore cap 3) and those seed a fresh `Infinity`
     cell — they never draw on a flow's cell. Net for a flow tree: effective in-flight concurrency
     against one cell ≈ 1, so the practical worst case is "the cell can go negative by up to one
     max-cost turn." (If concurrent `run_flow` is ever introduced, the bound becomes ≈ that concurrency
     × one turn, and a run-tree semaphore would be wired for `run_flow` then — see the axes table.)

   A blocked spawn returns control to the caller (flow-as-tool / `run_flow`) or terminates the chain
   (chaining); see [tools.md](tools.md).
5. **Budget + safety state are reconstructed on reload, not reset (FR-125).** The `AggregateBudget` cell
   is in-memory; it is **not** persisted as a running total. On recovery it is re-seeded from the flow's
   (defaulted, finite) ceilings and then decremented by **replaying each `turn.complete`'s recorded
   `cost_usd` / `token_usage`** — so a `$5.00` cap resumed mid-run reflects pre-crash spend rather than
   resetting to `$5.00` (which a crash-resume loop could otherwise exceed many times over). The stale
   rolling window and thrashing counters are rehydrated from the replayed event/task history in the same
   pass ([vault-schema.md](vault-schema.md) Parent-rooted recovery, "State rehydration").
4. **Sub-agent equivalence is provable, not coincidental.** Sub-agents pass `maxDepth = 0` and a fresh
   `budget` cell of `{ iterationsRemaining: Infinity, costRemainingUsd: Infinity }`, so the per-run
   `iterationCap` is the *only* effective limit. `budget.iterationsRemaining > 0` and
   `budget.costRemainingUsd > 0` are always true (`Infinity > 0`), and decrementing an `Infinity` cell
   leaves it `Infinity` (nothing observable changes), so the decision rule collapses to
   `localIterations < iterationCap` — byte-identical to today, by construction. The added
   `subtreeConsumed` accumulator is **write-only bookkeeping** for sub-agents (it feeds
   `child_run_metadata` single-run totals and gates nothing), so it likewise changes nothing
   observable. This is why the existing sub-agent suites stay green unmodified (see
   [Behavior-preservation gate](#behavior-preservation-gate)).

`stopReason` on the terminal `RunResult` distinguishes the layers: a per-run cap yields
`iteration_cap` / `token_limit` / `context_window`; the aggregate cost ceiling yields `cost_cap`; a
blocked spawn (depth) yields `depth_cap` on the *child* attempt (surfaced as a tool error, not on the
parent's loop — see depth model).

---

## Depth Model (replaces the binary recursion ban)

Today the sub-agent "no nesting" rule is two small things: `SUBAGENT_EXCLUDED_TOOLS =
new Set(["use_subagent"])` + `filterSubAgentTools` (`src/sub-agents/constants.ts`) and the
`_isSubAgentContext` flag checked in `UseSubagentTool.execute()` (`src/tools/use-subagent.ts` ~201-209).
That binary ban is replaced by a **depth counter on `RunContext`**.

`RunContext` (authority: [../data-model.md](../data-model.md); restated):

```typescript
interface RunContext {
  depth: number;               // current nesting depth (0 = top level)
  maxDepth: number;            // 0 for sub-agents (no nesting); N or Infinity for flows
  budget: AggregateBudget;     // SHARED tree-wide cell { iterationsRemaining, costRemainingUsd } (by reference)
  subtreeConsumed: SubtreeConsumed; // PER-SUBTREE accumulator (NOT shared) — authority for child_run_metadata; see data-model.md
  abort: AbortSignal;          // cascades from parent
}
```

> **`budget` (shared) vs `subtreeConsumed` (per-node) — do not conflate.** The `budget` cell is shared
> by reference tree-wide and is the authority for the **spawn gate** and the **root-header rollup**
> (a single direct read of the root's cell is correct there). `subtreeConsumed` is constructed fresh
> per child, accumulates only that node's own + its settled descendants' spend, and is the authority
> for **`child_run_metadata`'s per-subtree numbers** — precisely because a single read of the *shared*
> cell would absorb concurrent siblings' spend and misattribute it (see [edges.md](edges.md) §5).

### Spawn gate

A child run (a nested `use_subagent`, or a `run_flow` invocation) may be spawned **iff**:

```
RunContext.depth < RunContext.maxDepth
  AND RunContext.budget.iterationsRemaining > 0
  AND RunContext.budget.costRemainingUsd    > 0
```

- A spawned child inherits the parent's `budget` **by reference** (the same shared cell, so the child's
  per-turn decrements draw down the same tree-wide ceiling) and `depth + 1`, with an abort signal
  derived from the parent's.
- **Sub-agents pass `maxDepth = 0`.** The top-level sub-agent runs at `depth = 0`; a nested
  `use_subagent` would require `depth (0) < maxDepth (0)` → **false**, so it is rejected exactly as the
  `_isSubAgentContext` ban does today.
- **Flows pass `maxDepth = N` or `Infinity`** (from `notor-max-depth`), enabling bounded or unlimited
  nesting/chaining.
- A blocked spawn returns a **clear tool error** (`success: false`, not a throw) and the child's
  notional `stopReason` is `depth_cap`. How `use_subagent` and `run_flow` *consume* this gate (where the
  check is performed, the error text, return-vs-terminate semantics for chaining) is the authority of
  **[tools.md](tools.md)**; this file owns only the gate's truth value.

`RunContext` rides the dispatch seam as `runContext?: ToolExecuteOptions` (`src/tools/tool.ts` ~41-63),
assembled once in `ToolDispatcher.dispatch()` (`src/chat/dispatcher.ts` ~666) and threaded through
`executeToolBatches`. It is **deliberately not merged into `ToolSessionContext`** (`src/tools/tool.ts`
~35-39): that interface is a stable per-dispatch read-accessor ("whose session am I in?"), whereas
`RunContext` is mutable, cascading, and tree-scoped ("how deep / how much budget left?"). Different
lifecycles → kept composed, not conflated (FR-102 AC).

Sequencing hazard (tasks.md risk #2): **ARCH-003** (default `runContext`, `maxDepth=0` for sub-agents)
must land **before ARCH-004** removes `_isSubAgentContext`, or nested sub-agents silently become
possible.

---

## Three Concurrency Axes (do not conflate)

The design touches three distinct concurrency layers. They are orthogonal — each has its own owner,
scope, and limit — and `RunLoop` must not fold any one into another.

| Axis | Question it answers | Owner | Limit (today) |
|---|---|---|---|
| **Background triggering** | How many *background flows/workflows* start at once | `WorkflowConcurrencyManager` (`src/workflows/workflow-concurrency.ts`; in-memory, FIFO queue, sleep/wake `reconcileAfterWake`) | bounded pool + FIFO queue |
| **Run-tree expansion** | How deep/wide a single *run tree* spawns children | `RunLoop` shared `Semaphore` (generalized from `src/sub-agents/semaphore.ts`) | sub-agents: `SUB_AGENT_CONCURRENCY_CAP = 3`. **Flows (`run_flow`) in v1: effectively 1 in-flight child turn** — `run_flow` is a `write` tool (serialized within a turn by `executeToolBatches`), the engine routes single-threaded between turns, and recursive `run_flow` is a serial awaited chain. No `run_flow` concurrency semaphore is wired in v1 because there is no `run_flow` parallelism to admit-gate; if concurrent `run_flow` is introduced later, a run-tree-scoped semaphore for it is added then (and the soft-ceiling overshoot bound becomes ≈ that cap × one turn). |
| **Intra-turn tool dispatch** | How many *tool calls within one turn* run in parallel | `executeToolBatches` internal semaphore (`src/chat/tool-orchestration.ts`, pre-existing) | `DEFAULT_CONCURRENCY_CAP = 5` |

- The **intra-turn axis is pre-existing and free**: because `RunLoop` is built on `executeToolBatches`
  (concurrency-safe calls in parallel up to the cap, write/unsafe calls serially, call order
  preserved), every step turn and invoked flow inherits batched/parallel tool dispatch with no extra
  work — matching interactive chat and sub-agents.
- The **cascading-budget model** (`max_depth` / aggregate `max_iterations` / `max_cost_usd`) operates
  only at the **run-tree** layer; it neither sees nor governs intra-turn tool parallelism.
- `WorkflowConcurrencyManager` stays scoped to *background triggering* and is **not** the place for
  child-run concurrency (note: it is in-memory and lost on reload — orchestration crash recovery is a
  separate `session-log.jsonl` concern, [vault-schema.md](vault-schema.md)).

### Shared Semaphore behavior

The counting `Semaphore` is generalized out of `src/sub-agents/` into the run-loop layer (**ARCH-006**)
so orchestration child-run concurrency uses the same primitive without depending on sub-agent code.

```typescript
// generalized into src/run-loop/ (from src/sub-agents/semaphore.ts)
class Semaphore {
  constructor(cap: number);
  acquire(): Promise<void>;   // resolves when a slot is free; queues otherwise
  release(): void;            // frees a slot, waking the next waiter
  get pending(): number;      // count waiting
  get active(): number;       // count holding a slot
}
```

- A run **acquires** before spawning each concurrent child and **releases** when that child run
  settles. The cap bounds how many children run concurrently *within one run tree*.
- Sub-agent concurrency cap stays **3** (`SUB_AGENT_CONCURRENCY_CAP`) — unchanged (FR-106 AC).
- The semaphore is importable by orchestration with **no sub-agent dependencies** (the move is the
  whole point of ARCH-006).
- It is purely an admission gate; it does **not** decrement the aggregate budget — that is the
  two-layer model's job. The two are independent (concurrency = how *wide*; budget = how *much*).

---

## RunLoopHooks Contract

Hooks are how orchestration attaches per-step JSONL persistence, progress Notices, and run-tree
navigation **without** baking them into the engine. The surface is intentionally minimal — resist
pulling `ChatOrchestrator`'s compaction/context management in (tasks.md sequencing-risk: hook-surface
creep).

| Hook | When | Orchestration uses it for | Engine guarantees |
|---|---|---|---|
| `onTurnStart(turn)` | Immediately before each LLM call (after the budget/cap check passes) | Write `turn.start` to `session-log.jsonl` (recovery anchor) | Called once per turn that runs; `turn` is the 1-based local index |
| `onTurnComplete(turn, result: TurnOutcome)` | After a turn's tool batch settles | Write `turn.complete`; synthesize the per-turn progress Notice (FR-140); roll up token usage | Called once per completed turn; not called for a turn skipped by the budget gate |
| `onPersist(messages)` | At persistence points (turn boundary / terminal) | Persist the step conversation as its own JSONL file | Receives the current `ChatMessage[]`; may be async (awaited) |
| `onProgress(status)` | On streaming/status updates | Live status surfacing | Mirrors the existing `SubAgentRunnerOptions.onProgress` callback |

Behavioral rules:

- **All hooks are optional.** Sub-agents pass **no** persistence hooks (only `onProgress`, preserving
  today's `SubAgentRunner` behavior). Orchestration's `StepTurnExecutor` (FEAT-007) supplies the full
  set.
- **Hooks never alter control flow.** They observe; they cannot veto a turn, mutate `RunContext`, or
  change `stopReason`. (The budget/depth gates are the only flow-control authorities.)
- **Hooks may be async and are awaited** at their boundary, so persistence completes before the next
  turn — important for recovery (a `turn.start` written before the LLM call is the dangling-turn anchor
  that FR-125 replays).
- **A throwing hook must not crash the run.** Hook errors are logged and swallowed (the run continues);
  the engine's correctness does not depend on a consumer's hook succeeding.

`TurnOutcome` is the per-turn summary passed to `onTurnComplete` (text delta, tool calls made, token
usage for the turn); its shape is owned by [../data-model.md](../data-model.md) alongside the run-loop
types.

---

## Cost

Per-turn cost is computed via the existing standalone helper:

```typescript
// src/chat/message-pipeline.ts (~643-668) — STANDALONE, no orchestrator state
calculateCost(inputTokens: number, outputTokens: number, modelId: string, settings: NotorSettings): number
```

- `budget.ts` (ARCH-005) imports **only** `calculateCost` + settings — **no orchestrator dependencies**
  (tasks.md sequencing-risk #3: "Cost reachability"). This keeps the run-loop layer free of
  `ChatOrchestrator`.
- After each turn, the turn's cost is subtracted from the shared `RunContext.budget.costRemainingUsd`
  cell **and recorded on the `turn.complete` log entry** (`cost_usd` + `token_usage`); the next turn is
  gated on `budget.costRemainingUsd > 0` (decision rule, policy #2). The strict-positive gate makes the
  ceiling a **soft** one (policy #3): one more full, unbounded-cost turn can run after the remainder
  goes positive-but-tiny, even at concurrency 1 — there is no cost pre-flight reservation because
  per-turn cost is not knowable in advance.
- The recorded per-turn `cost_usd` / `token_usage` are what recovery replays to **rebuild** the
  in-memory cell on reload (policy #5), so the cost ceiling survives a restart.
- For sub-agents, the `budget` cell is `{ …, costRemainingUsd: Infinity }`, so cost never blocks —
  preserving today's behavior.

---

## Behavior-preservation gate

The extraction is gated on **TEST-001** (a release blocker; tasks.md per-phase gate, Phase 0). The
existing sub-agent suites must pass **unmodified** after `SubAgentRunner` is refactored to a thin
adapter over `RunLoop` (`maxDepth = 0`, a fresh `budget` cell of both-`Infinity`, a fresh write-only
`subtreeConsumed`, `orchestrationContext: undefined`, no persistence hooks; mapping `RunResult` →
`SubAgentResult` where `structured` is always null):

- `src/chat/sub-agent-runner.test.ts` — runner loop, caps, wind-down, abort behavior.
- `src/tools/use-subagent.test.ts` — **hard-asserts `iterationCap === 20`**; depth-0 nested rejection.
- `src/sub-agents/constants.test.ts` — `SUB_AGENT_ITERATION_CAP` (20), `SUB_AGENT_TOKEN_LIMIT` (0),
  `SUB_AGENT_CONCURRENCY_CAP` (3), `SUBAGENT_EXCLUDED_TOOLS`.

Per tasks.md (risk #1, highest severity): **do not touch the runner until these pass.** New coverage
(`src/run-loop/run-loop.test.ts` + `src/run-loop/budget.test.ts`) lands alongside, but the existing
green suites are the proof that sub-agent caps, wind-down, and abort are byte-identical to today.
