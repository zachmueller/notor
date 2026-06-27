# Contract: Built-in Orchestration Tool Scaffolds

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md)
**Data Model:** [../data-model.md](../data-model.md)
**Tasks:** [../tasks.md](../tasks.md)
**Status:** Draft

**Sibling contracts:**
- [run-loop.md](run-loop.md) — `RunContext` depth/budget gate on child spawn; `RunLoop` hook semantics (single authority).
- [edges.md](edges.md) — `orchestration_edges` + `child_run_metadata` (single authority).
- [vault-schema.md](vault-schema.md) — task-note format, flow `definition.md` + step-note frontmatter.
- [orchestration-helper.md](orchestration-helper.md) — the code-step `orchestration` runtime API that wraps these same tools for code steps.

---

## Overview

This contract defines the **built-in extension tool scaffolds** the orchestration engine adds:
`emit_event`, `run_flow`, and the four task tools (`orchestration_task_ensure` / `_start` / `_close` /
`_list`). These are ordinary built-in tool scaffolds in the existing extension system — discovered,
compiled, and registered by the `ExtensionManager` — distinguished only by their **feature-group
gating** and their orchestration-specific session-context dependencies.

Each tool is described here by: parameters (`input_schema`), `mode` (Plan/Act enforcement), and the
*implementation contract* (what the built-in implementation does, what session-context state it reads
or writes, and when its effect is observed by the engine). These tools never throw to the dispatcher;
failures return a `ToolResult` with `success: false` like every other tool.

---

## Feature-group gating (applies to ALL orchestration tools)

Every orchestration tool scaffold sets `featureGroup: "orchestration"` and is **only registered when
`orchestration_enabled` is true**.

- The scaffold helper `scaffold(name, description, mode, yamlFenceContent, code, featureGroup)`
  (`src/extensions/builtin-tool-scaffolds/_scaffold-helper.ts:9`) takes the `featureGroup` arg and
  stamps `notor-feature-group: orchestration` into the scaffold frontmatter (mirroring
  `capture-memory.ts` / `execute-command.ts`).
- Gating is enforced by `FEATURE_GROUP_TOGGLES` in `src/extensions/manager.ts:235` — add the entry
  `orchestration: "orchestration_enabled"` (see [../data-model.md](../data-model.md) → Settings).
  `isFeatureGroupEnabled()` (`src/extensions/manager.ts:244`) reads it; `reload(isInitialLoad)`
  (`src/extensions/manager.ts:264`) filters disabled-group tools out at registration
  (`src/extensions/manager.ts:315`).
- Toggling `orchestration_enabled` in `src/settings/sections/orchestration.ts` calls
  `getExtensionManager().reload(false)` (mirroring `src/settings/sections/memory.ts:69`), so the four
  task tools, `emit_event`, and `run_flow` appear/disappear from every tool list together.
- **Sequencing:** feature-group registration (`ENV-002`) lands before any scaffold registration. See
  [../tasks.md](../tasks.md) sequencing-risk #6.

> These scaffolds are also visible to a step turn only through its **persona's `<notor_tool_config>`**.
> A step that should not emit events (e.g. a read-only analysis step) can have `emit_event` disabled by
> its persona; the engine then relies on `default_publishes` synthesis (FR-115).

---

## `emit_event`

Publishes an orchestration event to advance the flow. Implements **FR-116**. Task: **FEAT-009**
(depends on `ENV-002`, `FEAT-001`).

### Parameters

```yaml
params:
  topic:
    type: string
    description: "Event topic name (e.g. tasks.ready, review.passed, FLOW_COMPLETE)."
  payload:
    type: string
    description: "Evidence or context handed to the next step."
required: [topic, payload]
```

### Mode

`write` — available only in Act mode (Plan-mode write-block applies, as for any write tool).

### Implementation contract

`emit_event` is a **capture-only** tool. It does **not** route.

1. On `execute`, it reads the active **`orchestrationContext`** off `ToolExecuteOptions`
   (`src/tools/tool.ts`; shape `OrchestrationToolContext` in [../data-model.md](../data-model.md)) —
   the per-step session carriage assembled at the single `ToolDispatcher.dispatch()` site, **distinct
   from `ToolSessionContext`** (it is *not* merged into the chat read-accessor; same different-lifecycle
   rationale as `runContext`, FR-102) — and **writes `{ topic, payload }` to its `pendingEmission`
   slot** as the turn's pending emission (overwriting any prior pending emission within the same turn —
   last call wins). Because each step turn gets its **own** `OrchestrationToolContext` instance,
   concurrent step turns / `run_flow` children never share or race on this slot. If
   `orchestrationContext` is absent (e.g. the tool is somehow reached outside a step turn),
   `emit_event` returns `success: false` rather than mutating anything.
2. It returns a confirmation `ToolResult` (`success: true`) so the LLM sees the emission was recorded;
   the turn then continues or ends normally.
3. **After** the `RunLoop` turn completes, the `StepTurnExecutor` (FR-115) reads
   `orchestrationContext.pendingEmission` and hands it to `OrchestrationEventEngine.publish()`, which
   appends `event.emitted` to `session-log.jsonl` **before** routing (write-before-route, FR-112).

> **Precedent.** This capture-then-read-back across a turn boundary mirrors the existing `update_tasks`
> → `ToolSessionContext.setConversationTasks(...)` → `ChatOrchestrator` pattern
> (`src/tools/update-tasks.ts`), generalized to a per-step orchestration carriage with its own mutable
> `pendingEmission` slot rather than chat's shared session accessor.

**No mid-turn routing.** The next step never begins while the emitting turn is still running — the
engine routes strictly between turns. This keeps the loop single-threaded per session and makes
`session-log.jsonl` replay deterministic for recovery (FR-125).

**Narrative ≠ emission.** Prose in the assistant's text that *names* a topic does not count; only a
real `emit_event` tool call records an emission. If no `emit_event` call is captured, the executor
synthesizes the step's `notor-step-default-publishes` topic (FR-115). The must-publish rule is always
injected into the step scaffold (FR-114) so this fallback is the exception, not the norm.

**Terminal topics.** `FLOW_COMPLETE`, `FLOW_CANCELLED`, and `FLOW_ERROR` are emitted through this same
tool (or synthesized). `FLOW_COMPLETE` is subject to task-completion enforcement (below); `FLOW_CANCELLED`
bypasses it (FR-132). The tool itself is topic-agnostic — terminal handling lives in the engine, not
the scaffold.

---

## `run_flow`

Invokes another flow as a tool and returns its result. Implements **FR-172 / FR-173** (Mechanism A —
flow-as-invocable-tool). Tasks: **INT-042** (the tool; depends on `INT-041`, `ENV-002`) and **INT-043**
(child-`RunLoop` execution + structured-return capture; depends on `INT-042`, `ARCH-002`, `ARCH-005`,
`INT-046`).

### Dynamic description & schema (mirrors `UseSubagentTool`)

`run_flow` is a **single** tool whose `flow` parameter is an `enum` of discovered invocable flow names.
It surfaces flow names and their input contracts **dynamically**, exactly as `UseSubagentTool` surfaces
sub-agent profiles via `get description()` / `get input_schema()`
(`src/tools/use-subagent.ts:113-143`):

- A stateless `FlowCompositionManager` (FR-171, task `INT-041`) discovers invocable flows on demand by
  re-scanning `orchestrations/*/definition.md` for `notor-flow-invocable: true` — mirroring
  `SubAgentManager`'s "no active state, re-scan per request" pattern. The tool caches the visible flow
  list and refreshes it at registration and at the start of each `execute()` (hot-reload), like
  `UseSubagentTool`'s profile cache.
- `get description()` lists each invocable flow with its **`notor-flow-inputs`** (the callee's
  freeform NL input contract; see [vault-schema.md](vault-schema.md)), so the calling LLM knows how to
  shape `payload` — the analogue of `UseSubagentTool` listing `- {name}: {description}`.
- `get input_schema()`:

```yaml
params:
  flow:
    type: string
    enum: [ <discovered notor-flow-invocable flow names> ]   # rebuilt per execute()
    description: "Which flow to invoke. Each flow's notor-flow-inputs is surfaced in the description."
  payload:
    type: string
    description: "Loose, natural-language input conforming to the callee's notor-flow-inputs."
required: [flow, payload]
```

- **Flow names are enum *values*, not tool names.** Because each invocable flow is an enum value of one
  tool (rather than its own dynamically-named tool), naming collisions across flows are **sidestepped
  entirely** — there is no namespace to manage.
- **Single loose `payload`.** One natural-language string matches the loose self-describing contract
  (the design rules out strict per-flow typing). The caller's LLM fills `{flow, payload}` dynamically,
  a `definition.md` can pre-bind them statically, or the two mix.

### Mode

`write` — available only in Act mode.

### Implementation contract

1. **Resolve.** Look up the selected `flow` via `FlowCompositionManager`. An unknown / no-longer-invocable
   flow returns a `ToolResult` `success: false` (not a throw).
2. **Spawn gate.** Before launching, the child spawn is gated on the `RunContext` carried on
   `ToolExecuteOptions` (`runContext?` — assembled once in `ToolDispatcher.dispatch()` at
   `src/chat/dispatcher.ts:666` and threaded through `executeToolBatches`). A spawn proceeds iff
   `depth < maxDepth` **and** the **shared** aggregate-budget cell has headroom
   (`runContext.budget.iterationsRemaining > 0` and `runContext.budget.costRemainingUsd > 0`). The
   child inherits the **same `AggregateBudget` cell by reference** (its turns draw down the same
   tree-wide ceiling) and `depth + 1`. A blocked spawn returns control with a clear tool error. **This
   gate and the shared-cell budget model are the single authority of [run-loop.md](run-loop.md); do
   not restate the decision rule here — reference it.**
3. **Run-to-terminal on a child `RunLoop`.** The selected flow runs **to its terminal event** in a
   **child session** on a **child `RunLoop`** (depth + 1, inheriting the parent's remaining aggregate
   budget). This is the `use_subagent` pattern generalized from a single sub-agent run to a whole flow:
   the child flow's step turns dispatch through `executeToolBatches`, inheriting batched/parallel
   intra-turn tool dispatch for free. Child session linkage (`parent_session_id`, isolation mode) is
   `INT-044`; isolation (`notor-handoff-isolation: isolated | shared`) follows the
   [vault-schema.md](vault-schema.md) `definition.md` contract.
4. **Return.** The tool returns the child's `RunResult` (see [../data-model.md](../data-model.md)):
   **prefer `structured`, fall back to `text`**. The **only** producer of `structured` is a terminal
   **code step** that passes a third arg to `orchestration.emit(topic, payload?, structured?)`
   (authority: [orchestration-helper.md](orchestration-helper.md)); the runner lifts that value onto
   `RunResult.structured` verbatim — no JSON round-trip of `payload`. Absent a terminal code step (or
   when it passes no `structured`), `structured` is `null` and `run_flow` falls back to the closing
   `text` produced by a final conversation step instructed via `notor-flow-returns` (the loose
   fallback).
5. **Edge + rollup.** On return, the calling step's conversation gains a `child` edge to the child
   flow's entry conversation, and the `ToolResult` carries a `child_run_metadata` block with the
   child subtree's aggregate cost / iterations / depth. Both the edge model and the rollup block are
   the **single authority of [edges.md](edges.md)** — this contract neither defines nor redefines
   them.

> `run_flow` differs from sub-agents in one structural way only: a sub-agent runs **one** isolated
> conversation; `run_flow` runs an entire **event-driven flow** (many step turns) to a terminal event.
> Both share the `RunLoop` substrate and the `child_run_metadata` rendering/rollup path.

---

## Task tools

Four built-in tools maintain the runtime task registry under `sessions/{id}/tasks/` (FR-122). The
task-note format (`notor-type: orchestration-task`, `notor-task-status ∈ open | running | closed`,
`notor-task-key`, `notor-task-created` / `_started` / `_completed`) is the **single authority of
[vault-schema.md](vault-schema.md)** — see also [../data-model.md](../data-model.md) → Task note. Task:
**INT-002** (all four scaffolds; depends on `ENV-002`, `INT-001`). All four read the active session's
`tasks/` directory off `ToolSessionContext` and resolve nothing globally.

| Tool | Params | Mode | Effect |
|---|---|---|---|
| `orchestration_task_ensure` | `key: string`, `description: string` | `write` | **Idempotent.** Create `tasks/{key}.md` with `notor-task-status: open` if absent; if present, no-op (no duplicate, status preserved). |
| `orchestration_task_start` | `key: string` | `write` | Set `notor-task-status: running` and stamp `notor-task-started`. Unknown key → `success: false`. |
| `orchestration_task_close` | `key: string` | `write` | Set `notor-task-status: closed` and stamp `notor-task-completed`. Unknown key → `success: false`. |
| `orchestration_task_list` | `filter?: { status?: "open" \| "running" \| "closed" }` | `read` | Return the session's tasks, optionally filtered by status. The only read-mode task tool. |

```yaml
# orchestration_task_ensure
params:
  key:
    type: string
    description: "Unique, stable task key (e.g. step-01-impl). Same key is idempotent."
  description:
    type: string
    description: "Human-readable task description."
required: [key, description]

# orchestration_task_list
params:
  filter:
    type: object
    properties:
      status:
        type: string
        enum: [open, running, closed]
    description: "Optional status filter."
required: []
```

**Idempotency contract (FR-122 AC).** `orchestration_task_ensure` keyed on `key` must never create a
second note for an existing key, and must not reset an already-`running`/`closed` task back to `open`.
This is what makes session-recovery replay safe (FR-125 / `INT-005`): a re-run step re-issuing the same
`ensure` calls converges to the same task set.

> These same four operations are exposed to **code steps** as `orchestration.tasks.{list,ensure,start,close}`
> (see [orchestration-helper.md](orchestration-helper.md)); the code-step helper and these tools share
> one underlying task-registry implementation.

---

## Task completion enforcement (FR-123)

Enforced by the engine at the routing seam, **not** inside any tool. Task: **INT-003** (depends on
`INT-002`, `FEAT-010`).

When `FLOW_COMPLETE` is captured (via `emit_event` or synthesized) the engine inspects the session's
task registry **before** finalizing:

- If **any** task has `notor-task-status` of `open` **or** `running`, the `FLOW_COMPLETE` is
  **rejected** — the flow does not finalize. The engine instead publishes a **`flow.tasks_remaining`**
  event whose payload enumerates the still-open/running task keys, re-triggering the appropriate step
  with remaining-task context so it can finish or close them.
- If **all** tasks are `closed`, `FLOW_COMPLETE` finalizes the flow normally.

**`FLOW_CANCELLED` bypasses this check entirely** (FR-132 / `INT-012`) — open tasks do not block
cancellation. Sequencing: `INT-003` (this enforcement) lands before `INT-012` (`FLOW_CANCELLED` bypass);
see [../tasks.md](../tasks.md) sequencing-risk #8.

---

## `run_flow` vs. step→workflow invocation (disambiguation)

These are two distinct, easily-confused mechanisms. They run on **different loops**:

| | `run_flow` (FR-172/173, this contract) | Step→workflow invocation (FR-151, Phase 5) |
|---|---|---|
| What it invokes | Another **orchestration flow** | A single-turn **workflow** prompt |
| Loop | A **child `RunLoop`** (the `SubAgentRunner`/`executeToolBatches` substrate), run **to a terminal event** (many step turns) | The **background-workflow loop** in `src/chat/workflow-executor.ts` (`while(continueLoop)` ~`:809`; single-call `dispatcher.dispatch()` ~`:951` — one tool at a time), a **single turn** |
| Return | Child `RunResult` (prefer `structured`, fall back to `text`) | The workflow's single-turn result merged into the step's context |
| Child session | New child session (`parent_session_id`, isolation mode) | No child session — the step awaits a workflow result inline |
| Edge/rollup | `child` edge + `child_run_metadata` ([edges.md](edges.md)) | None (no child-flow tree) |
| Aggregate budget | Child turns decrement the **shared** `RunContext.budget` cell live (it runs on a child `RunLoop`) | Runs off-`RunLoop`, so it cannot decrement live; instead **post-hoc reconciliation** (below) |
| Task | `INT-042` / `INT-043` | `INT-031` |

In short: **`run_flow` composes flow→flow** (call/return over the shared run-loop, run-to-terminal);
**step→workflow composes flow→workflow** (a step delegating one bounded task, hooking the existing
background-execution loop). The background-workflow loop is deliberately **not** the seam `run_flow`
uses — it is one-call-at-a-time and entangled with background approval/concurrency/liveness concerns a
child flow turn must not inherit.

> **Aggregate-budget accounting for step→workflow (FR-151 / FR-176).** Because the invoked workflow
> runs on the background-workflow loop — which has **no `RunContext`** — its LLM turns cannot decrement
> the shared aggregate-budget cell live. Without accounting, a step could delegate unbounded spend the
> flow's `notor-max-cost-usd` / `notor-max-iterations` ceilings never see. The resolution is **post-hoc
> reconciliation**: when the invoking step awaits the workflow's result (the `INT-031` await-result
> boundary), it subtracts the workflow's total reported cost/iterations from the **shared**
> `RunContext.budget` cell in one decrement. The ceiling is therefore accurate *after* the invocation
> (the next spawn/turn gate sees the real remaining total); it is not checked *during* the workflow's
> own loop, which is instead bounded by the workflow's per-run cap. This keeps the background loop free
> of `RunContext` plumbing while closing the accounting hole. Authority for the shared cell:
> [run-loop.md](run-loop.md); the reconciliation wiring is `INT-031`.

---

## Cross-references summary

- Spawn gate / two-layer budget / `RunContext` decision rule → [run-loop.md](run-loop.md).
- `orchestration_edges` (`child`/`parent`) + `child_run_metadata` → [edges.md](edges.md).
- Task-note + flow/step frontmatter (`notor-flow-invocable`, `notor-flow-inputs`, `notor-flow-returns`,
  `notor-handoff-isolation`) → [vault-schema.md](vault-schema.md).
- Code-step `orchestration.tasks` / `orchestration.emit` wrappers → [orchestration-helper.md](orchestration-helper.md).
- Type shapes (`RunResult`, settings, `OrchestrationSessionMeta`) → [../data-model.md](../data-model.md).
- FR mapping: FR-116 (`emit_event`), FR-122/123 (tasks + enforcement), FR-132 (`FLOW_CANCELLED`),
  FR-151 (step→workflow), FR-171/172/173 (`run_flow`) → [../spec.md](../spec.md).
- Tasks: FEAT-009, INT-002, INT-003, INT-031, INT-042, INT-043 → [../tasks.md](../tasks.md).
