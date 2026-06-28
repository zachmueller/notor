# Phase 0 — RunLoop Substrate (Setup + Foundation)

**Created:** 2026-06-27
**Specification:** [spec.md](../spec.md)
**Data Model:** [data-model.md](../data-model.md)
**Master Task Index:** [tasks.md](../tasks.md)
**Contracts:** [contracts/run-loop.md](../contracts/run-loop.md) · [contracts/edges.md](../contracts/edges.md)
**Status:** Complete

This file holds the full task **bodies** for design **Phase 0** — the regression-critical extraction of
the generalized headless turn-loop engine (`RunLoop`) from `SubAgentRunner`. Task IDs and dependency
edges here reproduce [tasks.md](../tasks.md) exactly; that file is authoritative for the edges, this
file is authoritative for the bodies. FR mappings target the **FR-100 group** (FR-100…FR-106) in
[spec.md](../spec.md). The `RunContext` / `RunResult` / `RunLoopOptions` / `RunLoopHooks` **shapes** are
defined in [data-model.md](../data-model.md); the **two-layer limit decision rule** and the **hook
semantics** are the single authority of [contracts/run-loop.md](../contracts/run-loop.md) — this file
references both, it does not redefine them.

Design source: the [Generalized run-loop engine] note. Vault-relative paths from that note are
translated to this repo's real `src/...` layout throughout.

---

## RunLoop Regression Gate

> **ARCH-002 / ARCH-004 / ARCH-005 must keep the existing sub-agent test suites GREEN, unmodified.**
> This is a **release blocker** (tracked as **TEST-001**, below). No orchestration code merges to the
> feature branch until the gate passes.

The three suites that constitute the gate:

| Suite | File | What it pins |
|---|---|---|
| Sub-agent runner | `src/chat/sub-agent-runner.test.ts` | turn loop, iteration/token/context-window caps, wind-down, parent-abort cascade |
| `use_subagent` tool | `src/tools/use-subagent.test.ts` | **hard-asserts `iterationCap === 20`**; nested-`use_subagent` rejection; metadata return shape |
| Sub-agent constants | `src/sub-agents/constants.test.ts` | `SUB_AGENT_ITERATION_CAP = 20`, `SUB_AGENT_TOKEN_LIMIT = 0`, `SUB_AGENT_CONCURRENCY_CAP = 3`, `SUBAGENT_EXCLUDED_TOOLS` |

**Why the gate is provable, not aspirational.** The extraction is behavior-preserving *by
construction* (FR-101, FR-105): when `SubAgentRunner` consumes `RunLoop` it seeds **`maxDepth = 0`** and
both aggregate budgets (`iterationsRemaining`, `costRemainingUsd`) to **`Infinity`**, with **no
persistence hooks**. With the aggregate ceiling at `Infinity`, the per-run `iterationCap` (20) is the
*only* effective limit — the two-layer decision rule (`localIterations < iterationCap AND
iterationsRemaining > 0 AND costRemainingUsd > 0`) reduces to exactly today's single check. Sub-agent
caps, wind-down, and abort cascading are therefore byte-identical to HEAD. See
[contracts/run-loop.md](../contracts/run-loop.md) for the decision rule's authoritative statement.

**Ordering hazards carried from the [tasks.md](../tasks.md) sequencing-risk register:**

- **Risk #1 (highest severity):** the loop lift (ARCH-002) and the depth/budget changes that ride on it
  (ARCH-004, ARCH-005) are gated on the three suites above. Do not touch the runner until they pass.
- **Risk #2 — depth seed before ban removal:** **ARCH-003** must land the default `runContext`
  (sub-agents seeded `maxDepth = 0`) **before ARCH-004** removes the `_isSubAgentContext` /
  `SUBAGENT_EXCLUDED_TOOLS` ban. If ARCH-004 lands first, nested `use_subagent` silently becomes
  possible (no depth seed to fail the `depth < maxDepth` check). ARCH-004 depends on **both** ARCH-002
  and ARCH-003 for exactly this reason.
- **Risk #3 — cost reachability:** **ARCH-005**'s `budget.ts` imports **only** `calculateCost` (from
  `src/chat/message-pipeline.ts`) **and** the settings object. It must not pull in `ChatOrchestrator`
  or any orchestrator-specific state — `calculateCost` is deliberately standalone for this reason.

---

## Phase 0 Task Index (edges reproduced from [tasks.md](../tasks.md))

| ID | One-liner | Depends on |
|---|---|---|
| ENV-001 | Module scaffolds (`src/run-loop/`, `src/orchestration/`) + `orchestration_enabled` setting + default | — |
| ENV-002 | Feature-group registration (`FEATURE_GROUP_TOGGLES`) + `settings/sections/orchestration.ts` | ENV-001 |
| ARCH-001 | `RunContext` / `RunResult` / `RunLoopOptions` / `RunLoopHooks` types | ENV-001 |
| ARCH-002 | Lift loop into `RunLoop`; refactor `SubAgentRunner` to consume it | ARCH-001 |
| ARCH-003 | `runContext?` on `ToolExecuteOptions`; thread through dispatch + `executeToolBatches` | ARCH-001 |
| ARCH-004 | Replace recursion ban with `depth < maxDepth` check in `use-subagent` | ARCH-002, ARCH-003 |
| ARCH-005 | Two-layer budget helpers (`budget.ts`) + per-turn cost wiring via `calculateCost` | ARCH-002, ARCH-004 |
| ARCH-006 | Shared `Semaphore` generalized into the run-loop layer | ARCH-002 |
| ARCH-007 | Pure `resolvePersonaProviderConfig(...)` → session-pinned `ResolvedProviderConfig` (no global registry mutation) | ARCH-001 |
| TEST-001 | RunLoop regression gate + `run-loop.test.ts` + `budget.test.ts` | ARCH-002 / 004 / 005 — **release blocker** |

**Parallelism (from [tasks.md](../tasks.md)):** after ARCH-001 lands the types, **ARCH-003** runs
parallel to **ARCH-002** (different files; both need only the types). ARCH-006 can proceed once ARCH-002
establishes the run-loop layer. TEST-001 can be authored the moment ARCH-002 is in progress (it *is* the
existing suite).

---

## Phase 0: Setup & Environment

### ENV-001: Module scaffolds + `orchestration_enabled` setting + default
**Description:** Create the new module directories with skeleton files so subsequent Phase 0–1 tasks
can work in parallel without file conflicts, and add the `orchestration_enabled` feature-group setting
(additive, mirroring `memory_enabled`) with its default. Skeleton files carry a doc comment only — no
logic. This scaffolds `src/run-loop/` (the substrate) and `src/orchestration/` (Phase 1's home) up
front; only `src/run-loop/` is populated in Phase 0.
**FRs:** FR-100 (module scaffold), FR-119 (setting scaffold — wired in ENV-002)
**Files:**
- `src/run-loop/types.ts` — skeleton (populated by ARCH-001)
- `src/run-loop/run-loop.ts` — skeleton (populated by ARCH-002)
- `src/run-loop/budget.ts` — skeleton (populated by ARCH-005)
- `src/run-loop/semaphore.ts` — skeleton (populated by ARCH-006)
- `src/orchestration/types.ts` — skeleton (populated by FEAT-001 in Phase 1)
- `src/settings/types.ts` — add `orchestration_enabled: boolean` to `NotorSettings` (near `memory_enabled` ~448 / `templates_enabled` ~466)
- `src/settings/defaults.ts` — add `orchestration_enabled: false`
**Dependencies:** None
**Acceptance Criteria:**
- [x] `src/run-loop/` exists with four skeleton files (`types.ts`, `run-loop.ts`, `budget.ts`, `semaphore.ts`)
- [x] `src/orchestration/types.ts` exists as a skeleton
- [x] `NotorSettings` includes `orchestration_enabled: boolean`
- [x] Default settings include `orchestration_enabled: false`
- [x] `npm run build` succeeds with no type errors
- [x] Plugin loads normally; no behavior change with the flag off (no consumer reads it yet)

### ENV-002: Feature-group registration + `settings/sections/orchestration.ts`
**Description:** Register the orchestration feature group so scaffolds can gate on it, and add the
Settings → Notor toggle section. Add `orchestration: "orchestration_enabled"` to `FEATURE_GROUP_TOGGLES`
in `src/extensions/manager.ts` (currently `{ memory: "memory_enabled", templates: "templates_enabled" }`
~235-238), so `isFeatureGroupEnabled()` (~244) resolves it and `reload()` (~264) filters tools tagged
`featureGroup: "orchestration"` (~315). Mirror `src/settings/sections/memory.ts` (~22-73): the toggle
`onChange` sets `settings.orchestration_enabled` then `const manager = ctx.plugin.getExtensionManager();
await manager.reload(false);` (~69). No orchestration scaffolds exist yet — this is the gating
substrate every Phase-1+ scaffold (`emit_event` FEAT-009, task tools INT-002, `run_flow` INT-042)
depends on, per sequencing-risk #6 ("feature-group gating before any scaffold registration").
**FRs:** FR-119 (feature group + toggle)
**Files:**
- `src/extensions/manager.ts` — add `orchestration: "orchestration_enabled"` to `FEATURE_GROUP_TOGGLES`
- `src/settings/sections/orchestration.ts` — new section, mirroring `src/settings/sections/memory.ts`
- `src/settings/settings-tab.ts` — register the orchestration section (wherever memory's section is registered)
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `FEATURE_GROUP_TOGGLES` includes `orchestration: "orchestration_enabled"`
- [x] `isFeatureGroupEnabled("orchestration")` returns the value of `settings.orchestration_enabled`
- [x] An "Orchestration" toggle appears in Settings → Notor, mirroring the Memory toggle
- [x] Toggling it sets `settings.orchestration_enabled` and calls `extensionManager.reload(false)`
- [x] With the flag off, `reload()` filters out any `featureGroup: "orchestration"` tool (none exist yet — verified via a stub tool in TEST scope, then removed)
- [x] `npm run build` succeeds; existing memory/templates gating unaffected

---

## Phase 1 (Foundation): RunLoop Extraction

> All ARCH tasks below are *Foundation* in the repo's six-phase convention but carry the design
> **Phase 0** tag. They form the narrowest waist of the whole feature (ARCH-002).

### ARCH-001: `RunContext` / `RunResult` / `RunLoopOptions` / `RunLoopHooks` types
**Description:** Populate `src/run-loop/types.ts` with the substrate types exactly as defined in
[data-model.md](../data-model.md). These types are imported by every other run-loop module and by
`use-subagent.ts`, so they land first. `RunContext` is the cascading tree-scoped descriptor (depth +
aggregate budget + abort) that will ride `ToolExecuteOptions` in ARCH-003. `RunResult` is the
always-both result (`text` + optional `structured`), of which `SubAgentResult` becomes a strict subset.
`RunLoopOptions` is the engine's input bag; `RunLoopHooks` is the minimal optional lifecycle surface
orchestration attaches persistence/Notices/navigation to in Phase 1 (FEAT-007) — keep it minimal, do
**not** pull in `ChatOrchestrator`'s compaction/context management (hook-creep risk).
**FRs:** FR-100, FR-102, FR-104, FR-105
**Files:**
- `src/run-loop/types.ts` — `RunContext`, `RunResult`, `RunLoopOptions`, `RunLoopHooks`, `TurnOutcome`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `AggregateBudget` is defined as `{ iterationsRemaining: number; costRemainingUsd: number }` and documented as a **shared cell** (referenced by every `RunContext` in a tree, never value-copied per child)
- [x] `RunContext` matches [data-model.md](../data-model.md): `{ depth, maxDepth, budget: AggregateBudget, abort }` — `budget` documented as the **shared aggregate** tree-wide cell (NOT the per-run cap)
- [x] `RunResult` matches [data-model.md](../data-model.md): `{ text, structured: unknown | null, messages, tokenUsage: {input, output}, iterationCount, stopReason }`; `structured` documented as populated only by a terminal code step's `emit(topic, payload?, structured?)` third arg
- [x] `stopReason` union is `"completed" | "iteration_cap" | "token_limit" | "context_window" | "cost_cap" | "depth_cap"`
- [x] `RunLoopOptions` includes `provider, model, systemPrompt, toolDefinitions, dispatcher, mode, iterationCap?, tokenLimit?, thinkingLevel?, runContext, orchestrationContext?, hooks?, onProgress?` (defaults: `iterationCap = SUB_AGENT_ITERATION_CAP` (20), `tokenLimit = SUB_AGENT_TOKEN_LIMIT` (0))
- [x] `OrchestrationToolContext` is defined per [data-model.md](../data-model.md) (`{ sessionId, scratchpadPath, tasksPath, parentScratchpadPath?, pendingEmission }`) and imported by the orchestration tools; `RunLoopOptions.orchestrationContext?` is `undefined` for sub-agents
- [x] `RunLoopHooks` includes only `onTurnStart?`, `onTurnComplete?`, `onPersist?`, `onProgress?` — no compaction/view hooks
- [x] Types compile and are importable from `src/run-loop/types.ts` with no `src/chat/` orchestrator dependency
- [x] `npm run build` succeeds with no type errors

### ARCH-002: Lift the loop into `RunLoop`; refactor `SubAgentRunner` to consume it
**Description:** Extract `SubAgentRunner`'s core turn loop into the generalized headless `RunLoop`
engine, then refactor `SubAgentRunner` into a thin adapter over it (behavior-preserving). The current
`SubAgentRunner.run()` (`src/chat/sub-agent-runner.ts` ~151-359, `while (iterationCount <
this.iterationCap)`), `runWindDown()` (~365-445), the parent-abort cascade (~127-142), and the
`executeToolBatches` call (~318) move into `RunLoop`. `RunLoop` owns: the turn loop (stream-parse →
`partitionToolCalls` → `executeToolBatches` → repeat), the per-run safety caps (iteration / token /
context-window proximity; cost is added in ARCH-005), wind-down summarization on any terminal cap,
parent-abort cascading via `runContext.abort`, and invocation of the optional `RunLoopHooks`. It
dispatches via `src/chat/tool-orchestration.ts` `executeToolBatches` (~114) — **not** the single-call
`dispatcher.dispatch()` loop in `src/chat/workflow-executor.ts` (that is the background-workflow path).
`SubAgentRunner` becomes an adapter: it constructs `RunLoopOptions` seeding **`maxDepth = 0`**, both
aggregate budgets **`Infinity`**, **no persistence hooks**, and maps `RunResult` → `SubAgentResult`
(`structured` dropped/ignored; `stopReason` union widened, `cost_cap`/`depth_cap` unreachable). This is
the **narrowest waist** of the feature and the core of the **RunLoop Regression Gate**.
**FRs:** FR-100, FR-101, FR-104, FR-105
**Files:**
- `src/run-loop/run-loop.ts` — `RunLoop` engine (lifted from `SubAgentRunner`)
- `src/chat/sub-agent-runner.ts` — refactor `SubAgentRunner` into a `RunLoop` adapter; `SubAgentResult` (~48-59) becomes a strict subset of `RunResult`; map result; preserve constructor `SubAgentRunnerOptions` (~115-143) and parent-abort wiring (~127-142)
- `src/run-loop/types.ts` — minor additions if `TurnOutcome` needs fields surfaced to hooks
**Dependencies:** ARCH-001
**Acceptance Criteria:**
- [x] `RunLoop.run()` runs an isolated LLM conversation to a terminal condition and returns a `RunResult`
- [x] `RunLoop` dispatches tools via `executeToolBatches` (inheriting batched/parallel intra-turn dispatch; cap `DEFAULT_CONCURRENCY_CAP = 5`)
- [x] `RunLoop` honors the per-run `iterationCap` and `tokenLimit`, the context-window proximity check, and wind-down summarization on any terminal cap — lifted unchanged from `SubAgentRunner`
- [x] Parent abort cascades into the run via `runContext.abort` exactly as `SubAgentRunner` cascades today
- [x] `SubAgentRunner` constructs `RunLoopOptions` with `maxDepth = 0`, a **fresh** `budget` cell `{ iterationsRemaining: Infinity, costRemainingUsd: Infinity }`, `orchestrationContext: undefined`, and no `onPersist` hook
- [x] `SubAgentResult` is a strict subset of `RunResult` (`structured` always null); the refactor is non-breaking for `use_subagent`
- [x] **GATE:** `src/chat/sub-agent-runner.test.ts` passes unmodified
- [x] **GATE:** `src/tools/use-subagent.test.ts` passes unmodified (incl. `iterationCap === 20` hard-assert)
- [x] **GATE:** `src/sub-agents/constants.test.ts` passes unmodified
- [x] `npm run build` succeeds with no type errors

### ARCH-003: `runContext?` (+ `orchestrationContext?`) on `ToolExecuteOptions`; thread through dispatch + `executeToolBatches`
**Description:** Add the cascade seam so `RunContext` reaches the tools that spawn children, **and** the
per-step `orchestrationContext` seam the orchestration tools (FEAT-009 `emit_event`, INT-002 task tools)
read. Add `runContext?: RunContext` **and** `orchestrationContext?: OrchestrationToolContext` to
`ToolExecuteOptions` (`src/tools/tool.ts` ~41-63 — alongside `onProgress, mode, abortSignal,
sessionContext, silentNoteOpener, interactionCallback`). Assemble both at the **single**
`ToolExecuteOptions` construction site in `ToolDispatcher.dispatch()` (`src/chat/dispatcher.ts` ~666),
sourcing the values threaded from the `RunLoop`/orchestrator through `executeToolBatches`
(`src/chat/tool-orchestration.ts` ~114, which already threads `sessionContext`). **Do not** merge
either into `ToolSessionContext` (`src/tools/tool.ts` ~35-39) — that is a stable per-dispatch
read-accessor ("whose session am I in?"); `RunContext` is mutable/cascading/tree-scoped ("how deep /
how much budget left?") and `OrchestrationToolContext` is the per-step session carriage with a mutable
`pendingEmission` slot. Different lifecycles; keep composed, not conflated (FR-102). Existing tools
ignore the new fields. **Critically (risk #2):** this task seeds the **default** `runContext` —
sub-agents get `maxDepth = 0` and `orchestrationContext: undefined` — and must land **before** ARCH-004
removes the recursion ban, so the depth check has a seed to fail against. ARCH-003 may proceed in
parallel with ARCH-002 (different files; both need only ARCH-001's types). The orchestration consumer
of `orchestrationContext` is Phase 1 (FEAT-009/FEAT-007); this task only establishes the seam.
**FRs:** FR-102, FR-105, FR-116 (the capture seam)
**Files:**
- `src/tools/tool.ts` — add `runContext?: RunContext` and `orchestrationContext?: OrchestrationToolContext` to `ToolExecuteOptions`
- `src/chat/dispatcher.ts` — set both in the single `executeOptions` assembly (~666); accept/thread them on `dispatch()` (~388)
- `src/chat/tool-orchestration.ts` — thread `runContext` + `orchestrationContext` through `executeToolBatches` (~114) → `safeDispatch` (~266) alongside `sessionContext`
- `src/run-loop/run-loop.ts` — pass `runContext` + `orchestrationContext` (from `RunLoopOptions`) into `executeToolBatches` from the loop
**Dependencies:** ARCH-001
**Acceptance Criteria:**
- [x] `ToolExecuteOptions` has optional `runContext?: RunContext` and `orchestrationContext?: OrchestrationToolContext`
- [x] Both are assembled at the single `executeOptions` site in `dispatch()` and threaded through `executeToolBatches`/`safeDispatch`
- [x] Neither is merged into `ToolSessionContext` (verified by inspection; different lifecycle)
- [x] A child run can read `runContext` to inherit the parent's `budget` cell **by reference** and `depth + 1`
- [x] Sub-agent dispatch receives a default `runContext` with `maxDepth = 0` and a fresh both-`Infinity` `budget` cell (the depth seed for ARCH-004), and `orchestrationContext: undefined`
- [x] Existing tools that ignore the new fields behave identically; no regressions in `src/chat/tool-orchestration.test.ts` or dispatcher tests
- [x] `npm run build` succeeds with no type errors

### ARCH-004: Replace the recursion ban with a `depth < maxDepth` check in `use-subagent`
**Description:** Generalize the sub-agent binary no-nesting ban into the depth model on `RunContext`.
Today nesting is blocked by two things: `SUBAGENT_EXCLUDED_TOOLS = new Set(["use_subagent"])` +
`filterSubAgentTools` (`src/sub-agents/constants.ts`) and the `_isSubAgentContext` flag in
`UseSubagentTool` (`src/tools/use-subagent.ts` — declared line 64, checked ~201-209). Replace the
`_isSubAgentContext` check with a `runContext.depth < runContext.maxDepth` gate read from
`ToolExecuteOptions.runContext`. Because ARCH-003 seeds sub-agents at `maxDepth = 0`, a nested
`use_subagent` fails the gate (`0 < 0` is false) — rejected **exactly as today**. The rejection must
return a clear **tool error ToolResult**, not throw. When `RunLoop` spawns the child, it sets the
child's `runContext` to `depth + 1` and inherits the parent's aggregate budget. **Risk #2:** this task
depends on **both** ARCH-002 (the loop must consume `RunLoop`) **and** ARCH-003 (the depth seed must
exist) — never land ARCH-004 before ARCH-003. The `SUBAGENT_EXCLUDED_TOOLS` filter behavior is preserved
in spirit by the depth gate (flows will later pass `maxDepth = N`); keep `constants.test.ts` green.
**FRs:** FR-103, FR-105
**Files:**
- `src/tools/use-subagent.ts` — replace `_isSubAgentContext` check (~201-209) with `runContext.depth < runContext.maxDepth`; on fail, return an error ToolResult; the `_isSubAgentContext` flag (line 64) is removed or retired
- `src/sub-agents/constants.ts` — `SUBAGENT_EXCLUDED_TOOLS` / `filterSubAgentTools` retained for back-compat but the *enforcement* moves to the depth gate (document the shift; keep `SUB_AGENT_ITERATION_CAP`/`SUB_AGENT_TOKEN_LIMIT`/`SUB_AGENT_CONCURRENCY_CAP` unchanged)
- `src/run-loop/run-loop.ts` — when spawning, child `runContext = { ...parent, depth: depth + 1 }` — the `budget` cell is inherited **by reference** (the spread copies the reference, so the child shares the same `AggregateBudget` object)
**Dependencies:** ARCH-002, ARCH-003
**Acceptance Criteria:**
- [x] Nested `use_subagent` is rejected exactly as today (sub-agent depth 0, `0 < 0` false)
- [x] The rejection returns a clear tool **error ToolResult**, not a throw
- [x] A child run launched with `maxDepth ≥ 1` (the flow path) is permitted at `depth < maxDepth`
- [x] Child `runContext` is `depth + 1` and shares the parent's `budget` cell **by reference** (not a copy)
- [x] **GATE:** `src/tools/use-subagent.test.ts` passes (nested-rejection assertion now satisfied via the depth gate; `iterationCap === 20` still holds)
- [x] **GATE:** `src/sub-agents/constants.test.ts` passes unmodified
- [x] `npm run build` succeeds with no type errors

### ARCH-005: Two-layer budget helpers (`budget.ts`) + per-turn cost wiring via `calculateCost`
**Description:** Implement the cascading **aggregate** budget layer in `src/run-loop/budget.ts` and wire
per-turn cost accounting into `RunLoop`. This is the second of the two coexisting limit layers; it does
**not** replace the per-run `iterationCap`. Per the two-layer decision rule (authoritative in
[contracts/run-loop.md](../contracts/run-loop.md)): a turn proceeds iff **both** layers have headroom —
`localIterations < iterationCap AND runContext.budget.iterationsRemaining > 0 AND
runContext.budget.costRemainingUsd > 0`. The **shared** `AggregateBudget` cell is **decremented in
place per-turn** (so the decrement is visible to the parent, siblings, and children that reference the
same cell) and checked **before** the next turn begins; exhaustion **blocks new child spawns only** —
in-flight runs finish their current turn (no hard-abort; **bounded overshoot** under concurrency is
accepted, no lock taken). `budget.ts` provides the decrement/check helpers and computes per-turn cost
via `calculateCost(inputTokens, outputTokens, modelId, settings)` (`src/chat/message-pipeline.ts`
~643-668). **Risk #3 (cost reachability):** `budget.ts` imports **only** `calculateCost` and the
`settings` object — **no** `ChatOrchestrator` or orchestrator state. `calculateCost` is standalone
precisely so the run-loop layer can reach cost without dragging in orchestrator deps. Sub-agents seed a
fresh both-`Infinity` `budget` cell, so the rule reduces to today's per-run check (decrementing
`Infinity` leaves `Infinity`) and the gate stays green by construction (FR-105).
**FRs:** FR-105
**Files:**
- `src/run-loop/budget.ts` — `decrementAggregate(budget, turnCostUsd, turnIterations)` (mutates the shared cell in place), `hasHeadroom(runContext, localIterations, iterationCap)`, `newRootBudget(maxIterations, maxCostUsd)` (constructs a fresh cell; `Infinity` when unset); imports `calculateCost` + `settings` ONLY. **No per-child copy helper** — children share the parent cell by reference (ARCH-004).
- `src/run-loop/run-loop.ts` — call `calculateCost` per turn, decrement the shared `runContext.budget` cell via `budget.ts`, check headroom before each turn, set `stopReason = "cost_cap"` when the aggregate cost ceiling blocks (and `"depth_cap"` is set by the spawn gate from ARCH-004)
- `src/run-loop/types.ts` — no shape change (`budget: AggregateBudget` already on `RunContext` from ARCH-001)
**Dependencies:** ARCH-002, ARCH-004
**Acceptance Criteria:**
- [x] `budget.ts` imports **only** `calculateCost` (from `src/chat/message-pipeline.ts`) and the settings object — verified by inspection (risk #3)
- [x] A turn proceeds iff `localIterations < iterationCap AND budget.iterationsRemaining > 0 AND budget.costRemainingUsd > 0`
- [x] The shared `budget` cell is decremented **in place** per-turn and checked before the next turn begins; a decrement by one node is observed by parent/siblings/children sharing the cell (asserted in `budget.test.ts`)
- [x] Aggregate exhaustion blocks new child spawns only; an in-flight run finishes its current turn (bounded overshoot accepted)
- [x] A run that exhausts the aggregate cost ceiling returns `stopReason = "cost_cap"`; the depth-gate rejection path is `"depth_cap"`
- [x] Sub-agents (fresh both-`Infinity` cell) behave identically to today — per-run cap is the only effective limit; decrementing the `Infinity` cell changes nothing observable
- [x] **GATE:** all three sub-agent suites pass unmodified
- [x] `npm run build` succeeds with no type errors

### ARCH-006: Shared `Semaphore` generalized into the run-loop layer
**Description:** Generalize the counting `Semaphore` (currently `src/sub-agents/semaphore.ts` —
`Semaphore(cap)` with `acquire()` / `release()` / `get pending` / `get active`) into the run-loop layer
(`src/run-loop/semaphore.ts`) so orchestration child-run concurrency uses the same primitive without a
sub-agent dependency. This is the **run-tree-expansion** concurrency axis ("how deep/wide a single run
tree spawns children") — distinct from `WorkflowConcurrencyManager` (background triggering) and from
`executeToolBatches`'s internal cap (intra-turn dispatch, `DEFAULT_CONCURRENCY_CAP = 5`). Do not conflate
the three axes. Move the primitive, re-export from the old path (or update imports) so the sub-agent cap
`SUB_AGENT_CONCURRENCY_CAP = 3` continues to bound concurrent sub-agents unchanged.
**FRs:** FR-106
**Files:**
- `src/run-loop/semaphore.ts` — generalized `Semaphore` (moved/lifted from `src/sub-agents/semaphore.ts`)
- `src/sub-agents/semaphore.ts` — re-export from the run-loop layer, or update sub-agent imports to the new path
- `src/sub-agents/constants.ts` — `SUB_AGENT_CONCURRENCY_CAP = 3` unchanged; sub-agent concurrency now uses the shared `Semaphore`
**Dependencies:** ARCH-002
**Acceptance Criteria:**
- [x] `Semaphore` lives in `src/run-loop/semaphore.ts` with `acquire()` / `release()` / `get pending` / `get active`
- [x] The semaphore is importable by orchestration with **no** sub-agent dependency
- [x] Sub-agent concurrency cap (3) is unchanged — `SUB_AGENT_CONCURRENCY_CAP` still bounds concurrent sub-agents
- [x] The run-tree-expansion axis is documented as distinct from background-triggering and intra-turn dispatch
- [x] **GATE:** `src/sub-agents/constants.test.ts` (and any semaphore test) passes unmodified
- [x] `npm run build` succeeds with no type errors

### ARCH-007: Pure `resolvePersonaProviderConfig(...)` → session-pinned provider/model (no global mutation)
**Description:** Provide the **pure** provider/model resolver that lets each step turn pin its own model
**without** mutating the shared `ProviderRegistry`. This is a foundation-level **correctness**
requirement, not a polish item: the engine relies on concurrency (the shared `Semaphore`, cap 3;
concurrent `run_flow` children; a flow running alongside foreground chat), and the existing
`PersonaManager.applyProviderModelOverrides()` (`src/personas/persona-manager.ts` ~349-453) mutates
**global** state via `providerRegistry.switchProvider(...)` (~357/396) and `updateConfig(...)`
(~363/436) — so two concurrent step turns with different models would clobber each other's selection
(see [research.md](../research.md) Finding 5). Add `resolvePersonaProviderConfig(persona,
stepModelOverride, settings, providerRegistry)` returning a **`ResolvedProviderConfig`** value object
(`{ providerId, modelId, useExtendedContext, thinkingLevel }`, [data-model.md](../data-model.md)) by
**reading** the preset/provider/model tables — **no `switchProvider`/`updateConfig` call**. It mirrors
the existing pure `resolveWorkflowProviderConfig()` (`src/chat/workflow-executor.ts` ~68-96).
`stepModelOverride` (`notor-step-model`) takes precedence over the persona's `preferred_model`.
FEAT-007's `StepTurnExecutor` consumes this (pins the result into each step's `ConversationSession`,
passes `modelId` as `RunLoopOptions.model`); FEAT-007 therefore **depends on ARCH-007**.
**FRs:** FR-115 (concurrency-safe per-step provider/model)
**Files:**
- `src/personas/persona-manager.ts` (or a new `src/personas/provider-config-resolver.ts`) — add the pure `resolvePersonaProviderConfig(...)`; do **not** modify `applyProviderModelOverrides()` (it stays for interactive persona activation, which legitimately mutates global active state)
- `src/run-loop/types.ts` — `ResolvedProviderConfig` (or import from the persona module) if not already present
**Dependencies:** ARCH-001
**Acceptance Criteria:**
- [x] `resolvePersonaProviderConfig(...)` returns a `ResolvedProviderConfig` value object and performs **no** `providerRegistry.switchProvider` / `updateConfig` call (verified by inspection + a test that spies the registry and asserts zero mutating calls)
- [x] `notor-step-model` (the `stepModelOverride` arg) overrides the persona's `preferred_model`
- [x] Preset → provider → model precedence matches `resolveWorkflowProviderConfig()`'s shape; an unavailable provider/model falls back gracefully (value-object fallback, no global write, no blocking)
- [x] Two resolutions for different personas/models produce two independent value objects with no shared mutation and no change to the global active provider/model
- [x] `npm run build` succeeds with no type errors

---

## Quality — RunLoop Regression Gate

### TEST-001: RunLoop regression gate + `run-loop.test.ts` + `budget.test.ts`
**Description:** The release-blocking gate for the entire RunLoop extraction. It has two parts: (1) the
three existing sub-agent suites must pass **unmodified** at every step of ARCH-002 / ARCH-004 / ARCH-005
(behavior-preserving by construction — `maxDepth = 0`, aggregate budgets `Infinity`); and (2) two new
unit suites covering the net-new substrate behavior. `run-loop.test.ts` exercises the lifted engine in
isolation (terminal conditions, hook invocation order, abort cascade). `budget.test.ts` exercises the
two-layer decision rule and the cascade helpers (per-turn decrement, both-layers-must-pass, spawn gating
on exhaustion, sub-agent `Infinity` equivalence). **No orchestration code merges until this gate is
green.**
**FRs:** FR-100, FR-101, FR-104, FR-105, FR-106
**Files:**
- `src/run-loop/run-loop.test.ts` — new unit suite for `RunLoop`
- `src/run-loop/budget.test.ts` — new unit suite for the two-layer limit model
- `src/chat/sub-agent-runner.test.ts` — must pass **unmodified** (gate)
- `src/tools/use-subagent.test.ts` — must pass **unmodified** (gate; `iterationCap === 20` assert)
- `src/sub-agents/constants.test.ts` — must pass **unmodified** (gate)
- `src/personas/provider-config-resolver.test.ts` (or colocated) — new unit suite for ARCH-007 (`resolvePersonaProviderConfig(...)` purity + `notor-step-model` override)
**Dependencies:** ARCH-002, ARCH-004, ARCH-005, ARCH-007 (authorable the moment ARCH-002 is in progress — it *is* the existing suite)
**Acceptance Criteria:**
- [x] **RELEASE BLOCKER:** `src/chat/sub-agent-runner.test.ts`, `src/tools/use-subagent.test.ts`, `src/sub-agents/constants.test.ts` all pass with **zero** modifications
- [x] `run-loop.test.ts` asserts `RunLoop` returns a `RunResult` on each terminal condition (`completed`, `iteration_cap`, `token_limit`, `context_window`, `cost_cap`, `depth_cap`)
- [x] `run-loop.test.ts` asserts hooks fire in order (`onTurnStart` → tool dispatch → `onTurnComplete`; `onPersist` when supplied) and that a missing hook is a no-op
- [x] `run-loop.test.ts` asserts parent abort cascades into the run via `runContext.abort`
- [x] `budget.test.ts` asserts a turn proceeds iff `localIterations < iterationCap AND budget.iterationsRemaining > 0 AND budget.costRemainingUsd > 0`
- [x] `budget.test.ts` asserts the **shared** `budget` cell decrements in place per-turn and that a child sharing the cell by reference sees a parent/sibling decrement (and vice versa) — i.e. the ceiling is tree-wide, not per-branch
- [x] `budget.test.ts` asserts exhaustion blocks **only** new child spawns (in-flight turn completes; bounded overshoot under concurrency)
- [x] `budget.test.ts` asserts sub-agent seeding (`maxDepth = 0`, a fresh both-`Infinity` cell) reduces the rule to today's single per-run cap and that decrementing the `Infinity` cell is a no-op observable-wise
- [x] A `provider-config-resolver` test (ARCH-007) asserts `resolvePersonaProviderConfig(...)` returns a `ResolvedProviderConfig` and makes **zero** `providerRegistry.switchProvider`/`updateConfig` calls (spied), and that `notor-step-model` overrides the persona's preferred model
- [x] `npm test` is green across all files
