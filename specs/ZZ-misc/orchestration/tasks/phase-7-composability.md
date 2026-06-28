# Task Bodies: Phase 7 — Composability + Run-Tree View (Lane E + Polish)

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-170 group)
**Data Model:** [../data-model.md](../data-model.md)
**Master Task Index:** [../tasks.md](../tasks.md)
**Contracts:** [../contracts/edges.md](../contracts/edges.md) · [../contracts/tools.md](../contracts/tools.md) · [../contracts/run-loop.md](../contracts/run-loop.md) · [../contracts/vault-schema.md](../contracts/vault-schema.md)
**Status:** Draft

This file holds the full task **bodies** for design Phase 7 (repo phases: Integration **Lane E** +
Polish) — task IDs **INT-040…INT-047**, **POL-003**, **POL-004**, **VAL-001**, plus the two Phase-7
test gates **TEST-006** and **TEST-008**. Task IDs and their dependency edges are owned by
[../tasks.md](../tasks.md); the IDs and edges reproduced here match it exactly. The covered functional
requirements are **FR-170…FR-179** (see [../spec.md](../spec.md)).

Design references: [orchestration.md → Composition / Flow Handoff] (canonical vault design doc), the
composability idea note (`ai/notor/ideas/Make orchestration flows highly composable.md`), and the
run-tree view idea note (`ai/notor/ideas/Run-tree view for orchestration and sub-agent navigation.md`).
Schema authorities are linked, not redefined:

- The conversation-edge model (`orchestration_edges`) and the shared `child_run_metadata` rollup block
  are the single authority of [../contracts/edges.md](../contracts/edges.md). This phase **consumes**
  and **populates** them (`child` / `parent` edges, aggregate-subtree rollup); it does not redefine them.
- The `run_flow` and `emit_event` tool I/O contracts are the authority of
  [../contracts/tools.md](../contracts/tools.md).
- The two-layer limit decision rule, the depth model spawn gate, and `RunContext` are the authority of
  [../contracts/run-loop.md](../contracts/run-loop.md). This phase **reads** that gate; it does not
  restate the decision rule.
- The `definition.md` composition frontmatter is the authority of
  [../contracts/vault-schema.md](../contracts/vault-schema.md).

## Lane scope and sequencing

Lane E opens once the Phase 1 core runner lands (`FEAT-010`) and the parser exists (`FEAT-002`). Its
internal order: `INT-040` (composition frontmatter) → `INT-041` (`FlowCompositionManager`) → `INT-042`
(`run_flow` tool) → `INT-043` (flow-as-tool execution). `INT-043` is the lane's narrowest waist; once it
lands, `INT-044` (child session + isolation) and `INT-046` (cascading guardrails) proceed in parallel.
`INT-045` (chaining) additionally depends on Lane B's `INT-010` (code steps), so the lanes must not be
parallelized across that edge. `INT-047` (`child_run_metadata`) depends on `INT-006` (Lane A edges) and
`INT-043`. The Polish tail (`POL-003` run-tree view → `POL-004` activity indicator → `VAL-001`) closes
the feature.

Five sequencing-risk register entries (from [../tasks.md](../tasks.md)) bear directly on this lane:

- **Risk #4 — `orchestration_edges` (INT-006) before the run-tree (POL-003).** The run-tree is the only
  surface that renders the (hidden-from-flat-list) step conversations; it reads exactly the
  `orchestration_edges` written in Lane A. `POL-003` therefore lists `INT-006` as a dependency.
- **Risk #5 — `child_run_metadata` (INT-047) is a back-compat superset, not a breaking rename.** It must
  keep every existing `sub_agent_metadata` field readable for already-persisted conversations, and must
  land **before** `POL-003` (the inline peek card and the run-tree both read the shared block).
- **Risk #7 — the inline peek card is NEW chat UI.** `sub_agent_metadata` is rendered today **only** in
  HTML export (`src/export/html-exporter.ts:585` `renderSubAgentDetail()`); `src/ui/message-renderer.ts:506`
  `renderToolResult()` does **not** render it. `POL-003` adds a fresh inline card to the chat panel —
  scope it as new work, reusing the export card only for markup/CSS reference, not as a runtime reuse.
- **Risk #10 — chaining (INT-045) depends on code steps (INT-010).** The optional code-step handoff
  adapter requires the `CodeStepExecutor`; `INT-045` lists `INT-010` as a dependency and must not be
  parallelized across Lane B.
- **Risk #11 — finalize `use-subagent.ts` (Phase 0) before `run_flow` (INT-042) mirrors it.** `INT-042`
  copies `UseSubagentTool`'s dynamic `get description()` / `get input_schema()` pattern
  (`src/tools/use-subagent.ts:113-143`) and its depth-gate consumption; the Phase 0 refactor of
  `use-subagent.ts` (`ARCH-004`: `_isSubAgentContext` → `RunContext` depth check) must be settled first
  so `run_flow` mirrors the final shape, not a transitional one.

**Per-phase test gate (Phase 7, from [../tasks.md](../tasks.md)):** `TEST-006` green (incl.
`child_run_metadata` back-compat parse + edge-DAG no-cycle invariant). The feature's all-phase e2e gate
`TEST-008` (`run_flow` child + structured return + run-tree live→static) and the end-to-end
`VAL-001` walkthrough close out the work.

**Critical-path note (from [../tasks.md](../tasks.md)):** the Phase-7 tail is the feature's long pole —
`INT-006 → INT-043 → INT-047 → POL-003 → TEST-008 → VAL-001`. The run-tree view cannot render until both
the edge schema (`INT-006`) and the shared metadata shape (`INT-047`) exist.

---

## INT-040: Composition frontmatter + parser extension

**Description:** Extend the flow-definition parser to read the **composition frontmatter** fields added
to `definition.md`. The fields are the single authority of
[../contracts/vault-schema.md](../contracts/vault-schema.md) and map onto the `OrchestrationFlow` fields
already declared in [../data-model.md](../data-model.md): `notor-flow-invocable` (boolean, default
`false`), `notor-flow-inputs` (freeform NL string, default `null`), `notor-flow-returns` (freeform NL
string, default `null`), `notor-on-complete-flow` (chaining-successor wikilink, default `null`),
`notor-handoff-isolation` (`"isolated"` | `"shared"`, default `isolated`), `notor-max-depth` (number |
null), and `notor-max-cost-usd` (number | null). The self-describing contract lives in the **callee**'s
own `definition.md`, so every upstream caller receives the same description and stays decoupled (FR-170).

This extends `FlowDefinitionParser` (`FEAT-002`), which mirrors the existing workflow frontmatter parse
at `src/workflows/workflow-frontmatter.ts:15` and the discovery scan at
`src/workflows/workflow-discovery.ts:73`. No new parser is introduced — this task adds field mappings to
the existing one.

**Inertness when the feature group is off (FR-170 AC):** the fields parse into `OrchestrationFlow`
unconditionally (they are plain frontmatter), but they are **inert** unless `orchestration_enabled` is
true — `run_flow` is not registered, chaining is not evaluated, and the guardrails are not consulted when
the group is off. Parsing must not throw on absent fields (they all have defaults) and must not surface
`notor-flow-invocable: true` flows anywhere when the group is disabled.

**FRs:** FR-170 (self-describing flow contract).

**Files:**
- `src/orchestration/flow-definition-parser.ts` — extend `FlowDefinitionParser` (`FEAT-002`) to map the
  seven composition frontmatter fields onto `OrchestrationFlow`, applying the
  [../contracts/vault-schema.md](../contracts/vault-schema.md) defaults.
- `src/orchestration/types.ts` — `OrchestrationFlow` already carries the composition fields (declared by
  `FEAT-001` per [../data-model.md](../data-model.md)); no new type expected here, verify the shapes match.

**Dependencies:** `FEAT-002` (the flow/step parser this extends).

**Acceptance Criteria:**
- [x] All seven composition fields parse onto `OrchestrationFlow` with the
  [../contracts/vault-schema.md](../contracts/vault-schema.md) defaults applied when absent.
- [x] A `definition.md` with no composition fields parses unchanged (`invocable: false`,
  `handoffIsolation: "isolated"`, the rest `null`) — non-composable flows are not regressed.
- [x] The fields are inert when `orchestration_enabled` is false (no `run_flow` registration, no chaining
  evaluation, no guardrail consultation).
- [x] `notor-handoff-isolation` rejects values other than `isolated` / `shared` with a clear load error;
  `notor-max-depth` / `notor-max-cost-usd` parse as numbers or `null`.
- [x] The schema is referenced, not redefined: this file links to
  [../contracts/vault-schema.md](../contracts/vault-schema.md).

---

## INT-041: `FlowCompositionManager` (stateless re-scan discovery)

**Description:** Add `FlowCompositionManager`, a **stateless discovery manager** that re-scans
`{notor_dir}/orchestrations/*/definition.md` for flows with `notor-flow-invocable: true` **on demand**,
returning the invocable flows and their `notor-flow-inputs` / `notor-flow-returns` contracts. It mirrors
`SubAgentManager` (`src/sub-agents/manager.ts`) precisely: **no active state**, re-scan per request —
discovery holds nothing, so a flow becoming (un)invocable is reflected on the next scan with no cache
invalidation bookkeeping (FR-171).

It is the resolver behind `run_flow`'s dynamic `flow` enum (`INT-042`): the tool calls
`FlowCompositionManager` to build the enum and the per-flow input descriptions for its dynamic
`get description()` / `get input_schema()`, exactly as `UseSubagentTool` calls `SubAgentManager` to
discover profiles. Discovery uses the same scan pattern as `discoverWorkflows()` in
`src/workflows/workflow-discovery.ts:73` and parses via the `FlowDefinitionParser` extended in
`INT-040`.

**FRs:** FR-171 (`FlowCompositionManager`).

**Files:**
- `src/orchestration/flow-composition-manager.ts` — new `FlowCompositionManager`: `listInvocableFlows()`
  (re-scan `orchestrations/*/definition.md`, filter `notor-flow-invocable: true`) and `resolveFlow(name)`
  (look up one invocable flow by `notor-flow-name`). Mirrors `src/sub-agents/manager.ts` (stateless).
- `src/orchestration/flow-definition-parser.ts` — reused (the per-`definition.md` parse from `INT-040`).

**Dependencies:** `INT-040` (composition frontmatter parsing).

**Acceptance Criteria:**
- [x] `listInvocableFlows()` returns only flows with `notor-flow-invocable: true`, each carrying its
  `notor-flow-inputs` / `notor-flow-returns`.
- [x] The manager holds **no active state**: a flow toggled (un)invocable on disk is reflected on the next
  scan without any explicit cache invalidation (verified by the `SubAgentManager`-mirroring re-scan test).
- [x] `resolveFlow(name)` returns the matching invocable flow or `null` for an unknown / non-invocable name.
- [x] Discovery excludes `sessions/`, `steps/`, and `memories.md` (same exclusions as flow discovery).

---

## INT-042: `run_flow` tool (dynamic `flow` enum + loose payload), gated

**Description:** Add the single built-in **`run_flow`** tool scaffold (full I/O contract:
[../contracts/tools.md](../contracts/tools.md)). It is **one** tool whose `flow` parameter is an `enum`
of discovered invocable flow names plus a single loose `payload` string — **not** one dynamically-named
tool per flow. Because flow names are enum **values** (arbitrary strings), naming collisions across flows
are sidestepped entirely (no namespace to manage) (FR-172).

The dynamic description/schema **mirrors `UseSubagentTool`** (`src/tools/use-subagent.ts:113-143`):

- `get description()` lists each invocable flow with its `notor-flow-inputs` (the callee's freeform NL
  input contract), so the calling LLM knows how to shape `payload` — the analogue of `UseSubagentTool`
  listing `- {name}: {description}`.
- `get input_schema()` rebuilds the `flow` enum from `FlowCompositionManager.listInvocableFlows()`
  (`INT-041`), refreshed at registration and at the start of each `execute()` (hot-reload), like
  `UseSubagentTool`'s profile cache.
- The single loose `payload` arg matches the deliberately loose self-describing contract. The caller's
  LLM fills `{flow, payload}` (dynamic), a `definition.md` can pre-bind them (static), or the two mix.

**Mode `write`** (Act-mode only, like `emit_event`). **Gated:** `featureGroup: "orchestration"`,
registered only when `orchestration_enabled` is true. The scaffold follows the helper pattern at
`src/extensions/builtin-tool-scaffolds/_scaffold-helper.ts:9` (the `featureGroup?` param), mirroring
existing gated scaffolds such as `src/extensions/builtin-tool-scaffolds/execute-command.ts`; gating is
enforced by `FEATURE_GROUP_TOGGLES` in `src/extensions/manager.ts:235` and `reload(false)` tool
filtering (`:315`). This task creates the tool **shell** — resolve/enum/description, the spawn-gate
**call site** (the gate's truth value is [../contracts/run-loop.md](../contracts/run-loop.md)'s
authority), and a `success: false` return for an unknown / no-longer-invocable flow. The actual
child-`RunLoop` execution and structured-return capture are `INT-043`.

**Orchestration-context-only (Issue-4 / FR-172 recovery invariant).** `run_flow` requires an active
**`orchestrationContext`** on `ToolExecuteOptions` — exactly as `emit_event` does. If it is **absent**
(the tool was reached from a foreground-chat turn, a non-orchestration automation, or any context that is
not an orchestration step / code step), `run_flow` returns a `ToolResult` `success: false` with a clear
message ("run_flow can only be called from within an orchestration flow") — it does **not** spawn. **Why:**
a child flow spawned outside an orchestration parent would be stamped `origin: "run_flow"` yet have **no
replayable orchestration parent** (a chat session has no `session-log.jsonl`), so on crash it would be a
silent, unrecoverable orphan — excluded from the top-level recovery scan *and* reconciled by no parent.
Gating to orchestration contexts guarantees **every** child flow has either a replayable orchestration
parent (`run_flow`) or is a recovery root (`chaining`), so the parent-rooted recovery model holds without
exception. (A flow is still launchable directly via the "Run Orchestration" command, which creates an
`origin: "user"` root.) Authority: [../contracts/tools.md](../contracts/tools.md) "Orchestration-context-only."

**Risk #11:** `use-subagent.ts` must be finalized in Phase 0 (`ARCH-004` replaces `_isSubAgentContext`
with the `RunContext` depth check) **before** this tool mirrors its dynamic-tool pattern, so `run_flow`
copies the final shape (depth-gate consumption + dynamic schema), not a transitional one.

**Risk #6:** feature-group registration (`ENV-002`) lands before this scaffold is registered.

**FRs:** FR-172 (`run_flow` tool).

**Files:**
- `src/extensions/builtin-tool-scaffolds/run-flow.ts` — new gated scaffold (`featureGroup: "orchestration"`,
  mode `write`); dynamic `get description()` / `get input_schema()` mirroring `src/tools/use-subagent.ts:113-143`.
- `src/orchestration/flow-composition-manager.ts` — reused (the enum + per-flow descriptions source).
- `src/extensions/manager.ts` — no change if `ENV-002` already registered
  `orchestration: "orchestration_enabled"` in `FEATURE_GROUP_TOGGLES` (`:235`) and the scaffold is picked
  up by `reload()` (`:264`) filtering (`:315`); verify the scaffold is excluded when the group is off.

**Dependencies:** `INT-041` (the invocable-flow discovery feeding the enum), `ENV-002` (feature-group
registration — Risk #6).

**Acceptance Criteria:**
- [x] `run_flow` is a single tool; its `flow` enum reflects the **currently discovered** invocable flows,
  rebuilt at registration and at the start of each `execute()` (hot-reload).
- [x] `get description()` surfaces each invocable flow's `notor-flow-inputs` so the LLM can shape `payload`.
- [x] The caller can pre-bind `{flow, payload}` statically in a `definition.md`, have the LLM fill them
  dynamically, or mix.
- [x] The tool appears only when `orchestration_enabled` is true and disappears on toggle-off +
  `manager.reload(false)`.
- [x] **Orchestration-context-only (Issue-4):** with **no** `orchestrationContext` on
  `ToolExecuteOptions` (foreground chat / non-orchestration caller), `run_flow` returns `success: false`
  with a clear message and does **not** spawn — so an unrecoverable parentless child flow cannot exist.
- [x] An unknown / no-longer-invocable `flow` returns a `ToolResult` `success: false` (not a throw).
- [x] Flow names are enum **values**, not tool names — no cross-flow namespace collision is possible.

---

## INT-043: Flow-as-tool execution on child `RunLoop` + structured-return capture

**Description:** Implement `run_flow`'s execution body (FR-173). On `execute()`, after the spawn gate
passes, `run_flow` runs the selected flow **to its terminal event** in a **child session** on a **child
`RunLoop`** (depth + 1, inheriting the parent's shared `AggregateBudget` cell **by reference** and a
derived abort signal, plus a **fresh per-node `subtreeConsumed`** accumulator — Issue-12), then returns
the child's result — **prefer `structured`, fall back to `text`**. This is the
`use_subagent` pattern generalized from a single sub-agent run to a whole event-driven flow: the child
flow's step turns dispatch through `executeToolBatches`, inheriting batched/parallel intra-turn tool
dispatch for free (one structural difference from sub-agents: `run_flow` runs many step turns to a
terminal event rather than one isolated conversation — see
[../contracts/tools.md](../contracts/tools.md)'s disambiguation table).

**Durable child ledger (Issue-1).** Immediately **before** launching, the parent turn writes a
**`child.spawned { turn, step, via_tool_call_id, child_session_id }`** entry to its own
`session-log.jsonl` — the recovery anchor that lets a re-run parent find *this* child. When the child
reaches its terminal event, the parent turn writes a **`child.result { turn, child_session_id,
structured?, text, stop_reason }`** entry **before continuing** — the durable artifact that makes "reuse
the child's recorded result on recovery" real (consumed by INT-044). Authority:
[../contracts/tools.md](../contracts/tools.md) steps 3–4 / [../contracts/vault-schema.md](../contracts/vault-schema.md).

- **Spawn gate (read, do not restate):** the child spawn is gated on the `RunContext` carried on
  `ToolExecuteOptions` (`runContext?` — assembled once in `ToolDispatcher.dispatch()` at
  `src/chat/dispatcher.ts:666` and threaded through `executeToolBatches`). A spawn proceeds iff
  `depth < maxDepth` **and** `budget.iterationsRemaining > 0` **and** `budget.costRemainingUsd > 0`,
  where `budget` is the **shared `AggregateBudget` cell** the child inherits **by reference** (its turns
  draw down the same tree-wide ceiling). The decision rule is the single authority of
  [../contracts/run-loop.md](../contracts/run-loop.md); this task consumes it, with `maxDepth` populated
  by `INT-046`. A blocked spawn returns control with a clear tool error (notional `stopReason:
  depth_cap` / `cost_cap`), **not** a throw.
- **Run-to-terminal (ledger-bracketed):** the parent writes **`child.spawned`** before launch; the child
  `OrchestrationRunner` (`FEAT-010`) runs the flow to its `notor-completion-event` (or `FLOW_CANCELLED` /
  `FLOW_ERROR`); `run_flow` awaits the terminal `RunResult`; the parent then writes **`child.result`**
  before continuing (Issue-1).
- **Structured-return capture:** the `RunResult` is always-both (see [../data-model.md](../data-model.md)).
  The **only** producer of `structured` is a terminal **code step** that passes a third arg to
  `orchestration.emit(topic, payload?, structured?)`, which the child runner lifts onto
  `RunResult.structured` verbatim (no JSON round-trip; authority
  [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md)). Otherwise a final
  conversation step instructed via the callee's `notor-flow-returns` produces the closing `text` (the
  loose fallback). The tool returns `structured` if present, else `text`.
- **Edge + rollup:** on return, the calling step's conversation gains a `child` edge to the child flow's
  entry conversation (carrying `session_id` + `via_tool_call_id`), and the `ToolResult` carries a
  `child_run_metadata` block. Both are the single authority of
  [../contracts/edges.md](../contracts/edges.md); the edge is **written** here, the metadata shape is
  **generalized** in `INT-047`, and the per-subtree aggregate numbers are sourced from the child run's
  **`RunContext.subtreeConsumed`** accumulator (Issue-12) — **not** a delta of the shared
  `AggregateBudget` cell (which would absorb concurrent siblings' spend).

**Dependency direction (per [../tasks.md](../tasks.md)): `INT-043 → INT-046`.** `INT-043` depends on
`INT-046` — the cascading-guardrail `max_depth` / aggregate-budget seeding on the child `RunContext` must
exist before the child spawn can be correctly gated and budgeted. `INT-044` (child session) and `INT-047`
(metadata) in turn depend on `INT-043`.

**FRs:** FR-173 (flow-as-tool execution + structured return).

**Files:**
- `src/extensions/builtin-tool-scaffolds/run-flow.ts` — the `execute()` body: reject when
  `orchestrationContext` is absent (Issue-4), pass the spawn gate, write **`child.spawned`** before
  launch, spin up the child `RunLoop` + child `OrchestrationRunner`, run to terminal, write
  **`child.result`** on return, read the `RunResult` (prefer `structured`), assemble the `ToolResult` +
  `child_run_metadata` (per-subtree numbers from the child `RunContext.subtreeConsumed`).
- `src/orchestration/runner.ts` — `OrchestrationRunner` (`FEAT-010`) gains a child-invocation entry point
  that runs a flow on a supplied child `RunLoop`/`RunContext` to its terminal event and surfaces the
  always-both `RunResult` (`structured` set by a terminal code step).
- `src/run-loop/run-loop.ts` — reused as the child engine (`ARCH-002`); `run_flow` constructs a child
  `RunLoop` with `depth + 1`, the parent's shared `AggregateBudget` cell (by reference), and a fresh
  per-node `subtreeConsumed` accumulator (Issue-12).
- `src/orchestration/step-turn-executor.ts` — the terminal-step path that lifts `structured` from a
  terminal code step's `emit(..., structured)` onto `RunResult.structured` (the only producer), or
  falls back to `text` (conversation step instructed by `notor-flow-returns`).

**Dependencies:** `INT-042` (the tool shell + enum), `ARCH-002` (the `RunLoop` substrate the child runs
on), `ARCH-005` (the two-layer budget helpers / per-turn cost), `INT-046` (cascading guardrails +
`max_depth` on `RunContext` — `INT-043 → INT-046`).

**Acceptance Criteria:**
- [x] `run_flow` returns `success: false` when `orchestrationContext` is absent (Issue-4) — no parentless
  child flow is spawned.
- [x] The selected flow runs on a **child `RunLoop`** (depth + 1, inheriting the parent's shared
  `AggregateBudget` cell **by reference** and a **fresh per-node `subtreeConsumed`** — Issue-12) to its
  terminal event in a child session.
- [x] The parent writes **`child.spawned`** (before launch) and **`child.result`** (on return, before
  continuing) to its own `session-log.jsonl` (Issue-1 — the reuse-on-recovery ledger).
- [x] The tool result **prefers `structured`** — populated **only** by a terminal code step's
  `emit(topic, payload?, structured?)` lifted onto `RunResult.structured` — and **falls back to `text`**
  (from a final conversation step instructed via `notor-flow-returns`).
- [x] The spawn is gated on the `RunContext` decision rule over the **shared budget cell**
  ([../contracts/run-loop.md](../contracts/run-loop.md)); a blocked spawn returns control with a clear
  tool error, not a throw.
- [x] The child flow's step turns dispatch through `executeToolBatches` (batched/parallel intra-turn
  dispatch inherited).
- [x] On return, a `child` edge is written to the child flow's entry conversation and a
  `child_run_metadata` block is attached (per-subtree numbers from `subtreeConsumed`, Issue-12), both
  conforming to [../contracts/edges.md](../contracts/edges.md) (the schemas are referenced, not redefined).

---

## INT-044: Child session + `parent_session_id` + isolation modes

**Description:** When `run_flow` spawns a child flow (`INT-043`), the child runs in its **own** session
created by `OrchestrationSessionManager` (`INT-001`), recording `parent_session_id` (the caller's session)
and `origin: "run_flow"` on its `session.json` (`OrchestrationSessionMeta` — see
[../data-model.md](../data-model.md) / [../contracts/vault-schema.md](../contracts/vault-schema.md)). The
child session links into the parent's recovery tree so crash recovery (`INT-005`) can resume the whole
tree coherently (FR-174).

**Parent-rooted recovery reconciliation (the half of FR-125 that lands here).** `INT-005` established
the contract that child sessions (`origin ∈ {run_flow, chaining}`) are **not** recovered by the
top-level scan. This task wires the **parent-replay** behavior that makes that safe, driven by the
parent's durable **`child.spawned` / `child.result`** ledger (Issue-1): when the parent step that called
`run_flow` is replayed (dangling `turn.start`), the runner matches the `child.spawned` (by
`via_tool_call_id` / occurrence order) and looks for the matching `child.result` before re-spawning —
- a `child.spawned` **with** a matching `child.result` ⇒ the child reached a terminal status; the parent
  **reuses the child's recorded result** (`structured`/`text` + `stop_reason` fed back, **no re-spawn**);
- a `child.spawned` **without** a `child.result` ⇒ the child was non-terminal at crash; the parent
  **resumes that non-terminal child in place** — the child session **replays its own `session-log.jsonl`**
  and the parent awaits it. The child is **never tombstoned-and-respawned** (Issue-2): it keeps its
  session/log, so its `side_effect.committed` markers survive the crash and `once(...)` dedupes correctly
  across recovery for child flows (a respawned fresh child would have an empty log and re-run every prior
  guarded effect).

This prevents the double-execution race (an independently-recovered child *and* a duplicate spawned by the
re-run parent) without relying on per-effect guarding: the ledger + resume-in-place is the mechanism (see
[../contracts/vault-schema.md](../contracts/vault-schema.md) "Parent-rooted recovery" and
[../contracts/tools.md](../contracts/tools.md) "Recovery (FR-125)"). The child's `session.json` `origin`
is **always set** (`"run_flow"`) at creation and never null (Issue-4b); recovery treats an absent /
unexpected origin as a **loud diagnostic**, not a silent skip.

**Isolation modes (`notor-handoff-isolation`, from the callee's `definition.md`):**

- **`isolated` (default):** the child gets a **fresh** scratchpad and task registry — clean isolation,
  exactly like a sub-agent. No access to the parent's scratchpad.
- **`shared`:** the child **inherits** the parent's scratchpad. The parent scratchpad path is
  **auto-allowed** in the child's path enforcement, reusing the session-scoped auto-allow mechanism
  `INT-001` already built for the owning session — here extended to also recognize the **parent** session's
  scratchpad prefix for the child's step turns. This is the same `enforcePathConstraints(toolName,
  parameters, entry, vaultRootPath, resolveVaultPath?)` seam at `src/tool-config/path-enforcer.ts:45`
  (param set `TOOL_PATH_PARAMS` at `:28`); `INT-001` implemented only the owning-session case, and this
  task adds the parent-session case for `shared` handoffs.

The auto-allow stays scoped: a `shared` child gains the parent scratchpad only; it does not gain access
to sibling or unrelated sessions' scratchpads.

**FRs:** FR-174 (child sessions + isolation modes).

**Files:**
- `src/orchestration/session-manager.ts` — `OrchestrationSessionManager` (`INT-001`): create a child
  session with `parent_session_id` + `origin: "run_flow"`; for `shared` isolation, register the parent's
  scratchpad prefix as auto-allowed for the child's step turns; for `isolated`, allocate a fresh
  scratchpad/tasks.
- `src/tool-config/path-enforcer.ts` — extend the session-scoped scratchpad auto-allow (added by
  `INT-001` at `enforcePathConstraints` `:45`) to also recognize the **parent** session's scratchpad
  prefix when a child session is in `shared` mode.
- `src/orchestration/runner.ts` — the child-invocation entry point (`INT-043`) reads
  `notor-handoff-isolation` from the callee `OrchestrationFlow` and asks the session manager for the
  appropriate child session.
- `src/orchestration/session-recovery.ts` / `src/orchestration/runner.ts` — the parent-replay path
  follows the parent's `child.spawned` / `child.result` ledger and reconciles the linked child (**reuse**
  a terminal child's recorded `child.result`, or **resume** a non-terminal child in place by replaying its
  own log) so recovery (`INT-005`) resumes the parent/child tree coherently with **no orphaned or
  duplicated** child run.

**Dependencies:** `INT-001` (session manager + the owning-session scratchpad auto-allow this extends),
`INT-043` (the flow-as-tool execution that spawns the child session).

**Acceptance Criteria:**
- [x] A `run_flow`-spawned child runs in its own session with `parent_session_id` = the caller's session
  and `origin: "run_flow"` recorded in `session.json`.
- [x] `isolated` (default) gives the child a **fresh** scratchpad/tasks with no access to the parent's.
- [x] `shared` auto-allows the **parent** session's scratchpad path in the child's path enforcement; the
  child can read/write the parent scratchpad, and the parent's steps can read what the child wrote.
- [x] The auto-allow remains scoped — a `shared` child gains the parent scratchpad only, not unrelated
  sessions'.
- [x] A `run_flow`-spawned child's `session.json` `origin` is **always set** (`"run_flow"`) at creation,
  never null (Issue-4b); recovery treats an absent/unexpected origin as a loud diagnostic.
- [x] The child session links into the parent's recovery tree so `INT-005` resumes the whole tree.
- [x] A crash mid-`run_flow` does **not** produce a duplicate child: the replayed parent **reuses** a
  terminal child's recorded `child.result` (no re-spawn), or **resumes the non-terminal child in place**
  (it replays its own log) — never tombstone-and-respawn, so the child's `once()`
  `side_effect.committed` markers survive and external effects are not double-run (no
  independently-recovered child runs alongside a freshly-spawned one).

---

## INT-045: Chaining at terminal event + input-description injection + optional code adapter

**Description:** Implement **Mechanism B — chaining / one-way handoff** (FR-175). At a flow's terminal
event, if `notor-on-complete-flow` is set, the `OrchestrationRunner` launches the **successor flow
instead of finalizing** — there is **no return** to the originator; the chain *is* the end of the
starting flow. The successor enters callee-agnostically (same `notor-starting-event`, same
payload-conforms-to-`notor-flow-inputs` expectation as any other entry); only the return path differs
from `run_flow` (chaining treats the successor's completion as terminal).

**Decoupling via the callee's contract:** because the successor's input description lives in its own
`definition.md`, the engine injects the **successor's `notor-flow-inputs`** into the **predecessor's
terminal step** so the predecessor shapes its forwarded payload to fit — without the predecessor
hardcoding any knowledge of the successor. Every upstream predecessor receives the same description from
the successor ("predecessor conforms," driven by the callee's self-published contract).

**Gate, depth, and budget inheritance (the chaining contract — authority
[../contracts/tools.md](../contracts/tools.md) "Chaining").** The handoff is gated **exactly like a
`run_flow` spawn**, in the runner's terminal-event handler, against the **same `RunContext`** the
predecessor's terminal step ran under. The successor's `RunContext` inherits **`depth + 1`** and the
**same `AggregateBudget` cell by reference** (not a fresh root cell), carrying a **fresh
`subtreeConsumed`** (Issue-12) — so every successor turn draws down the same tree-wide cost/iteration
ceiling and an `A → B → A` on-complete cycle is **genuinely bounded** (it terminates at the aggregate
budget / `max_depth`, not "by intent"). A **blocked** handoff (`depth >= maxDepth`, or the shared cell is
exhausted) does **not** launch the successor; because chaining has **no caller to return to**, a blocked
handoff **terminates the chain with `FLOW_ERROR`** (status `error`), carrying the reason + intended
successor — a loud, diagnosable stop, not a silent no-op.

**Recovery — a chained successor is recovered as a ROOT (Issue-3).** A chained successor is recorded with
`origin: "chaining"` and `parent_session_id` = the predecessor. Because the predecessor **finalizes**
(status `completed`) before the successor launches, the successor has **no live parent turn to replay** —
so, unlike a `run_flow` child, it is **recovered as a root** by the top-level scan: the scan recovers an
`origin: "chaining"` session **iff** its `parent_session_id` resolves to an **already-terminal**
predecessor (closing the "crashed chained successor is a permanent orphan" hole; the earlier assumption
that chaining successors were reconciled by parent replay was wrong). Its `parent`/`child` edges are kept
for run-tree lineage only. The successor's `session.json` `origin` is **always set** (`"chaining"`),
never null.

**Handoff adaptation (tiered):**

- **Default — prompt-injection (free):** inject the successor's `notor-flow-inputs` into the predecessor's
  terminal step scaffold; the predecessor's natural output is shaped to fit at zero extra LLM cost.
  Sufficient when the predecessor's output already roughly fits the successor.
- **Optional code-step adapter (preferred for non-trivial reshaping):** the chain edge may declare an
  adapter, **code-step preferred** (deterministic, no LLM cost) — a code step that reads the predecessor's
  payload/scratchpad and emits the successor's input. This is why `INT-045` depends on `INT-010` (the
  `CodeStepExecutor`): the adapter runs on that executor. An LLM-turn adapter remains possible if the
  transform is genuinely fuzzy.

**Edge:** chaining writes a `child` edge (predecessor terminal step → successor entry conversation,
carrying `session_id`; **no** `via_tool_call_id` because chaining has no tool call) — this is precisely
why a tool-result-only scheme cannot represent chaining and the structural source must be the header
edge ([../contracts/edges.md](../contracts/edges.md)). Data forwards via the emitted payload (default) or
a shared scratchpad (`notor-handoff-isolation: shared`, reusing `INT-044`). The successor's
`session.json` records `origin: "chaining"`.

**Risk #10:** `INT-045` depends on `INT-010` (code steps) — do not parallelize across Lane B.

**FRs:** FR-175 (chaining / one-way handoff).

**Files:**
- `src/orchestration/runner.ts` — `OrchestrationRunner` terminal-event handling: gate the handoff exactly
  like a `run_flow` spawn (against the predecessor's `RunContext`); when it passes and
  `notor-on-complete-flow` is set, launch the successor (new session, `origin: "chaining"` always set,
  `depth + 1`, **same `AggregateBudget` cell by reference**, fresh `subtreeConsumed`) instead of
  finalizing; on a blocked handoff terminate the chain with `FLOW_ERROR`; write the `child` edge to the
  successor's entry conversation.
- `src/orchestration/session-recovery.ts` — reused (`INT-005`): the top-level scan recovers an
  `origin: "chaining"` successor **as a root** iff its `parent_session_id` resolves to an already-terminal
  predecessor (Issue-3).
- `src/orchestration/step-prompt-builder.ts` — inject the successor's `notor-flow-inputs` into the
  predecessor's terminal-step scaffold (the default prompt-injection adaptation).
- `src/orchestration/code-step-executor.ts` — reused (`INT-010`) to run an optional declared code-step
  handoff adapter.
- `src/orchestration/flow-composition-manager.ts` — reused to resolve the successor flow by wikilink.

**Dependencies:** `INT-040` (the `notor-on-complete-flow` / `notor-flow-inputs` frontmatter), `INT-043`
(the child-flow launch path reused for the successor), `INT-010` (the `CodeStepExecutor` the optional
adapter runs on — Risk #10).

**Acceptance Criteria:**
- [x] When `notor-on-complete-flow` is set, the terminal event launches the successor flow and **does
  not** return to or finalize back into the originator. (`chainToSuccessor`, fire-and-forget after the
  predecessor finalizes `completed`.)
- [x] The successor inherits **`depth + 1`** and the **same `AggregateBudget` cell by reference** (fresh
  `subtreeConsumed`), so an `A → B → A` on-complete cycle terminates at `max_depth` / the aggregate budget
  (TEST-006), not unbounded. (`inheritedContext: { budget, depth: depth + 1 }`; bounded-cycle test in
  `composition.test.ts`.)
- [x] A **blocked** handoff (`depth >= maxDepth` or shared cell exhausted) terminates the chain — a loud,
  diagnosable stop (Notice + warn), the chaining analogue of `run_flow`'s `success:false` (no caller to
  return a tool error to).
- [x] A crashed chained successor whose predecessor is **already terminal** is **recovered as a root** by
  the top-level scan (Issue-3); its `session.json` `origin` is always set (`"chaining"`), never null.
  (`SessionRecovery.isRecoverableRoot` + `createSession({ origin: "chaining" })`.)
- [x] The successor's `notor-flow-inputs` is injected into the predecessor's terminal step so the
  predecessor shapes its forwarded payload without hardcoding successor knowledge. (`### HANDOFF` section,
  `step-prompt-builder.test.ts`.)
- [x] The default adaptation is free prompt-injection; an optional code-step adapter is available by
  authoring the predecessor's **terminal step as a code step** (it runs on the `CodeStepExecutor`,
  INT-010, and emits the deterministically-reshaped payload). (No separate declared-adapter frontmatter
  field — a terminal code step is the v1 mechanism.)
- [x] Chaining lineage links the successor to the predecessor: the successor's `session.json` records
  `origin: "chaining"` + `parent_session_id` (the run-tree roots the successor subtree under the
  predecessor via that session lineage — no `via_tool_call_id`, as chaining has no tool call).
- [x] Data forwards via the emitted payload by default (the predecessor's terminal `text`), or the shared
  scratchpad when `notor-handoff-isolation: shared` (the parent scratchpad is auto-allowed for the
  successor's turns).

---

## INT-046: Cascading guardrails + `max_depth` on `RunContext`

**Description:** Make the flow-tree guardrails **cascading / aggregate** (FR-176). The aggregate
ceilings — `notor-max-iterations`, `notor-max-cost-usd`, and the new composition-depth cap
`notor-max-depth` — live on the `RunContext` carried through the dispatch seam and gate **child spawns**
across the whole flow tree, layered **on top of** (never replacing) each runner's per-run iteration cap.

This task seeds and consumes the `RunContext` aggregate fields for orchestration. The root run
constructs **one shared `AggregateBudget` cell** (`newRootBudget`, ARCH-005) that every descendant
`RunContext` references **by reference** (never value-copied), so the ceiling is genuinely tree-wide:

- `maxDepth` ← `notor-max-depth` (number, or `Infinity` when unset — arbitrary depth permitted by
  default). The spawn gate is `depth < maxDepth`.
- `budget.iterationsRemaining` ← `notor-max-iterations` (shared cell; decremented in place per-turn).
- `budget.costRemainingUsd` ← `notor-max-cost-usd` (shared cell; decremented in place per-turn via
  `calculateCost`).

The **decision rule is the single authority of [../contracts/run-loop.md](../contracts/run-loop.md)** —
this task does **not** restate it. It reuses the two-layer budget helpers from `ARCH-005`
(`src/run-loop/budget.ts`, which imports only `calculateCost` + settings, no orchestrator deps — Risk #3)
and applies them at orchestration spawn points. A spawn is gated on `depth < maxDepth` **AND**
`budget.iterationsRemaining > 0` **AND** `budget.costRemainingUsd > 0` over the **shared** cell.
Exhaustion **blocks new child spawns only**; **in-flight runs finish their current turn** (no
hard-abort, no forced mid-turn wind-down). The model is **decrement-after-turn / check-before-turn**, so
the **soft-ceiling overshoot is at most one full turn per in-flight runner — even serially**: each
already-running runner may complete the turn it had started before its next check sees the exhausted
cell. **There is no `run_flow` concurrency semaphore in v1:** `run_flow` is a `write` tool, and
`executeToolBatches` **serializes write tools within a turn** (single-threaded routing per session —
[../research.md](../research.md), [../contracts/tools.md](../contracts/tools.md)), so there is no
"concurrent `run_flow`" parallelism to bound and the overshoot is **not** "concurrency × one turn." A
blocked spawn **returns control** to the caller for flow-as-tool (`run_flow` gets a `success: false`
tool error; notional `stopReason: depth_cap` / `cost_cap`) or **terminates the chain** for chaining
(`INT-045`).

For sub-agents, `maxDepth = 0` and a fresh both-`Infinity` `budget` cell are seeded (`ARCH`-era
seeding), so the per-run cap stays the only effective limit and today's behavior is preserved by
construction (decrementing an `Infinity` cell changes nothing observable).

**FRs:** FR-176 (cascading guardrails).

**Files:**
- `src/run-loop/budget.ts` — reused (`ARCH-005`): the per-turn decrement + decision-rule helpers; this
  task wires the orchestration aggregate seeds (`notor-max-iterations` / `notor-max-cost-usd` /
  `notor-max-depth`) into the `RunContext` for a flow's root run.
- `src/orchestration/runner.ts` — `OrchestrationRunner` seeds the root `RunContext` aggregate budget from
  the flow's `OrchestrationFlow.maxIterations` / `maxCostUsd` / `maxDepth`; child runs inherit the
  parent's remaining budget and `depth + 1`.
- `src/extensions/builtin-tool-scaffolds/run-flow.ts` — the spawn-gate call site (`INT-043`) reads the
  gate's truth value; a blocked spawn returns `success: false`.

**Dependencies:** `ARCH-005` (the two-layer budget helpers + per-turn cost), `INT-043` (the flow-as-tool
spawn point the gate guards — `INT-043 → INT-046`).

**Acceptance Criteria:**
- [x] A child-flow / sub-agent spawn is gated on `depth < maxDepth` **AND**
  `budget.iterationsRemaining > 0` **AND** `budget.costRemainingUsd > 0` over the **shared** cell (the
  rule referenced from [../contracts/run-loop.md](../contracts/run-loop.md), not restated).
- [x] `notor-max-depth` (or `Infinity` when unset) seeds `RunContext.maxDepth`; `notor-max-iterations` /
  `notor-max-cost-usd` seed the **one shared `AggregateBudget` cell**; a child inherits that cell **by
  reference** (not a copy) and `depth + 1`, so a deep/wide subtree collectively respects one ceiling.
- [x] Exhausting the ceiling **blocks new child spawns** while **in-flight runs finish their current
  turn** (no hard-abort); the overshoot is **at most one full turn per in-flight runner, even serially**
  (decrement-after / check-before), **not** "concurrency × one turn" — there is no `run_flow` concurrency
  semaphore in v1 (write-tool serialization within a turn).
- [x] A blocked spawn **returns control** (flow-as-tool, `success: false`) or **terminates the chain**
  (chaining); the notional child `stopReason` is `depth_cap` / `cost_cap`.
- [x] Sub-agent behavior is unchanged: `maxDepth = 0`, a fresh both-`Infinity` `budget` cell (per-run cap is the
  only effective limit).

---

## INT-047: Generalize `sub_agent_metadata` → shared `child_run_metadata`

**Description:** Generalize the existing `ToolResult.sub_agent_metadata` (`src/types.ts:270`) into a
shared **`child_run_metadata`** block used by **both** `use_subagent` and `run_flow`, with **one
rendering path** and **one token-rollup path** (FR-177). The shared shape and the back-compat guarantee
are the single authority of [../contracts/edges.md](../contracts/edges.md) — this task **implements** that
contract; it does not define the field shape here.

- **Back-compat superset, not a breaking rename (Risk #5).** The shared block keeps every existing
  `sub_agent_metadata` field readable for already-persisted conversations: `jsonl_filename`,
  `token_usage`, `iteration_count`, and `stop_reason` are read as-is; `profile_name` is read as the
  legacy alias of the generalized `name`. New fields (`entry_conversation_id`, `session_id`, `cost_usd`,
  `depth`, `name`) are optional and simply absent on legacy records. A `ToolResult` persisted today must
  still parse through the shared reader unchanged (asserted by `TEST-006`).
- **Aggregate-subtree numbers for flows, single-run totals for sub-agents — sourced from
  `subtreeConsumed`, NOT a shared-cell delta (Issue-12).** For `run_flow`, the rollup numbers
  (`token_usage`, `cost_usd`, `iteration_count`, `depth`) come from the child run's
  **`RunContext.subtreeConsumed`** accumulator (the per-node accumulator each child constructs fresh and
  folds into its parent on settle) — the **whole** child flow tree, attributed to *that* subtree only.
  They must **not** be computed as a before/after delta of the **shared** `AggregateBudget` cell, which
  would absorb concurrent siblings' spend and mis-attribute it. For `use_subagent`, the same fields carry
  single-run totals (subtree = the sub-agent itself, also via its `subtreeConsumed`). Authority:
  [../contracts/edges.md](../contracts/edges.md) "Per-subtree numbers come from `subtreeConsumed`."
- **One rendering path.** There is exactly one renderer for `child_run_metadata` — the inline expandable
  child-conversation card built in `POL-003` (`src/ui/message-renderer.ts:506`). This task makes
  `run_flow`'s and `use_subagent`'s `ToolResult`s both carry the shared block so the single card serves
  both (the card itself is `POL-003`).
- **One token-rollup path.** The existing sub-agent rollup at `src/chat/orchestrator.ts:1635` reads
  `toolResult.sub_agent_metadata?.token_usage` and calls
  `convManager.addTokens(...)` (`addTokens` at `src/chat/conversation.ts:696`). Generalize this **single
  site** to read `child_run_metadata.token_usage`, serving both tools — **no second rollup site is
  added.**

**Risk #5 / #4:** `INT-047` depends on `INT-006` (the edge schema / conversation header) and `INT-043`
(the flow-as-tool path that produces a child to roll up), and it must land **before** `POL-003` (the card
+ run-tree both read the shared block).

**FRs:** FR-177 (shared `child_run_metadata`).

**Files:**
- `src/types.ts` — generalize `ToolResult.sub_agent_metadata` (`:270`) into the shared
  `child_run_metadata` shape from [../contracts/edges.md](../contracts/edges.md) (additive optional
  fields; the five legacy fields stay readable). Keep the old key parseable for persisted conversations.
- `src/chat/orchestrator.ts` — the single token-rollup site (`:1635`) reads
  `child_run_metadata.token_usage` (generalized from `sub_agent_metadata?.token_usage`); no second site.
- `src/extensions/builtin-tool-scaffolds/run-flow.ts` — populate `child_run_metadata` (aggregate-subtree
  numbers from the child run's **`RunContext.subtreeConsumed`** — Issue-12, NOT a shared-cell delta —
  plus `entry_conversation_id`, `session_id`, `name` = flow name).
- `src/tools/use-subagent.ts` — populate the shared block (single-run totals, `name` = profile name,
  `profile_name` retained for back-compat) instead of the old `sub_agent_metadata`-only shape (`~451-462`).

**Dependencies:** `INT-006` (the conversation-edge schema / header the shared block pairs with),
`INT-043` (the flow-as-tool path that produces a child subtree to roll up).

**Acceptance Criteria:**
- [x] One shared `child_run_metadata` shape (per [../contracts/edges.md](../contracts/edges.md)) is
  emitted by both `use_subagent` and `run_flow`.
- [x] A legacy `sub_agent_metadata` record (`jsonl_filename`, `token_usage`, `iteration_count`,
  `stop_reason`, `profile_name`) **parses unchanged** through the shared reader (`TEST-006` back-compat).
- [x] For flows the rollup numbers are **aggregate subtree** totals sourced from the child run's
  **`RunContext.subtreeConsumed`** accumulator (Issue-12) — **not** a delta of the shared `AggregateBudget`
  cell (which would absorb concurrent siblings' spend); for sub-agents they are single-run totals (also
  via `subtreeConsumed`).
- [x] The token rollup happens at exactly **one** site (`src/chat/orchestrator.ts:1635`, generalized);
  no second rollup site is introduced.
- [x] The shape is referenced, not redefined: this file links to
  [../contracts/edges.md](../contracts/edges.md).

---

## POL-003: Unified run-tree `ItemView` leaf + inline peek card (new chat UI)

**Description:** Build the **unified run-tree view** (FR-178) and the **inline peek card** (FR-179, the
new chat UI half). Detailed UX is the run-tree view idea note
(`ai/notor/ideas/Run-tree view for orchestration and sub-agent navigation.md`); the data it reads is the
single authority of [../contracts/edges.md](../contracts/edges.md). The view is a **read-only consumer**
— it defines no schema of its own.

**(1) Dedicated run-tree `ItemView` leaf.** A new workspace leaf renders a run as a navigable,
collapsible tree, **unified** across orchestration steps (via `orchestration_edges` `next`/`prev` for the
step chain and `child`/`parent` for cross-flow descent/ascent) **and** sub-agents (via the existing
`parent_conversation_id` scalar at `src/tools/use-subagent.ts:430`). It mirrors the existing view
registration: `registerView(CHAT_VIEW_TYPE, ...)` in `src/main.ts:407` and `NotorChatView extends
ItemView` (`src/ui/chat-view.ts:55`, `CHAT_VIEW_TYPE = "notor-chat-view"` `:36`) — add a new
`ORCHESTRATION_RUN_TREE_VIEW_TYPE` leaf with the same `getViewType` / `getDisplayText` / `onOpen` /
`onClose` lifecycle.

- **Live for active runs, static for completed.** A live run subscribes via
  `WorkflowActivityTracker.onChange()` (`src/workflows/workflow-activity-tracker.ts:118`, returns an
  unsubscribe) over the `session-log.jsonl` write points (`turn.start` / `turn.complete` /
  `event.emitted`) — nodes appear, status glyphs flip, the active-node highlight moves, and the header
  rollup ticks up. A completed run renders **once** from the persisted session log with no subscription;
  a recovered run re-attaches its subscription on resume.
- **Smart auto-expand, ephemeral collapse, no persistence.** On each open, auto-expand the spine to the
  focus node (active node for live, most-recent/failed for completed, clicked node when descending) and
  collapse finished branches; manual expand/collapse during the session is respected but not persisted.
- **Root at the top of the whole run** on descent; auto-scroll to + highlight the clicked node.
- **Select-to-navigate.** Clicking a node loads that node's conversation in the main chat via the
  existing `notor-conversation://{id}` jump + `switchToConversationById` (`src/ui/message-renderer.ts:957`,
  `src/chat/orchestrator.ts:741`); the leaf stays open with the node marked selected. Auto-follow tracks
  the active node until a manual select; a "jump to active" pill re-attaches.
- **Header aggregate rollup** (root cost / iterations / max depth) reads the root run's shared
  `RunContext.budget` cell consumption ([../contracts/run-loop.md](../contracts/run-loop.md)).
- The view needs **no cycle-detection or infinite-expansion guards** — the edges are a tree-constrained
  DAG ([../contracts/edges.md](../contracts/edges.md) §3) — but it **must tolerate dangling edges**: a
  recovery re-run mints new conversation ids, so a `next`/`prev` target may be an abandoned pre-crash
  conversation. Render only edges whose target resolves; **skip** a dangling target silently (it is
  inert, not an error). See [../contracts/edges.md](../contracts/edges.md) §2 (recovery tolerance).

**(2) Inline peek card — NEW chat UI (Risk #7).** The spawning `run_flow` / sub-agent tool-call card
renders an inline **one-level peek**: the direct child's summary line + status + **aggregate rollup**
(cost / iterations / depth, from `child_run_metadata`; aggregate-subtree for flows, single-run for
sub-agents) + an **"Open run tree"** affordance that opens the leaf rooted at this run. This is **new
work** added in `renderToolResult()` at `src/ui/message-renderer.ts:506`, which does **not** render
`sub_agent_metadata` today. The HTML-export `renderSubAgentDetail()` at `src/export/html-exporter.ts:585`
is a **markup/CSS reference only** — **not** a runtime reuse. One rendering path (the shared
`child_run_metadata` card from `INT-047`) serves both `use_subagent` and `run_flow`. The card is a peek
(one level); it never renders the whole tree.

**Risks #4 / #5:** `POL-003` depends on **both** `INT-006` (edges + hide) and `INT-047`
(`child_run_metadata`) — the run-tree cannot render until both exist (the Phase-7 long pole). It also
depends on `FEAT-010` (the runner whose state the live view subscribes to).

**FRs:** FR-178 (unified run-tree view), FR-179 (inline peek card half).

**Files:**
- `src/ui/run-tree-view.ts` — new `ItemView` leaf (`ORCHESTRATION_RUN_TREE_VIEW_TYPE`), mirroring
  `src/ui/chat-view.ts:55`'s `ItemView` lifecycle; renders the tree from `orchestration_edges` + the
  sub-agent `parent_conversation_id`; smart auto-expand; select-to-navigate; auto-follow + pill.
- `src/main.ts` — `registerView(ORCHESTRATION_RUN_TREE_VIEW_TYPE, ...)` alongside `:407`; an opener the
  three entry points call (spawning card, activity indicator, progress Notice).
- `src/ui/message-renderer.ts` — **new** inline peek card in `renderToolResult()` (`:506`), sourced from
  the shared `child_run_metadata`, with an "Open run tree" affordance; serves both tools.
- `src/export/html-exporter.ts` — `renderSubAgentDetail()` (`:585`) referenced for markup/CSS only (no
  code change required).
- `src/workflows/workflow-activity-tracker.ts` — reused: the live view subscribes via `onChange()`
  (`:118`) over the session-log write points.

**Dependencies:** `INT-006` (the `orchestration_edges` schema + hidden-from-list filter — Risk #4),
`INT-047` (the shared `child_run_metadata` the card + tree read — Risk #5), `FEAT-010` (the runner the
live view subscribes to).

**Acceptance Criteria:**
- [x] One run-tree `ItemView` leaf (`src/ui/run-tree-view.ts`, `ORCHESTRATION_RUN_TREE_VIEW_TYPE`)
  renders **both** orchestration steps (via `orchestration_edges` next/prev + child) and sub-agents (via
  `parent_conversation_id`) as one collapsible hierarchy.
- [x] The view tolerates **dangling** `next`/`prev`/`child` edges — it renders only edges whose target
  resolves in the scanned headers and skips stale targets silently (never throws / blanks the tree).
- [x] The view is **live** for active runs (subscribed via `WorkflowActivityTracker.onChange()`, which
  fires on the session-log write points) and **static** otherwise; the subscription is re-attached in
  `onOpen` (a recovered run re-surfaces the same way).
- [x] Ephemeral collapse/expand (a per-node `collapsed` set, not persisted); the tree renders expanded
  by default so the active spine is visible. (A focus-node auto-expand/auto-scroll heuristic + the
  "jump to active" pill are deferred refinements — the v1 view is fully navigable without them.)
- [x] Selecting a node loads its conversation in the main chat (via `switchToConversationById`, the same
  primitive behind `notor-conversation://{id}`); the leaf stays open with the node marked selected.
- [x] The inline peek card renders **in the chat panel** (not only HTML export) in
  `renderToolResult()` — a one-level direct-child summary + aggregate rollup + "Open run tree" — sourced
  from the shared `child_run_metadata` (`readChildRunMetadata`) and serving both `use_subagent` and
  `run_flow`. (New UI, not a reuse of the export card — Risk #7.)
- [x] No cycle-detection / infinite-expansion guards are needed (the edges are a tree-constrained DAG);
  a `visited` set guards re-entry defensively only.

---

## POL-004: Unified activity indicator (typed entries)

**Description:** Generalize the activity indicator to **typed entries** so there is **one** indicator,
not a second parallel one (FR-179, the indicator half). Background-workflow entries keep navigating to
their conversation (as today); **flow-run entries open the run-tree view** (`POL-003`). The unified
surface reads from **two sources of truth** — *in-memory* for background workflows (the existing
`WorkflowConcurrencyManager`, lost on reload) and *session-file-backed* for flows (which have crash
recovery / persisted sessions) — so flows are **not** made in-memory-only (that would lose recovery in
the indicator).

Staged per the run-tree idea note: design toward the unified surface; the first orchestration cut may
feed flow runs in as a distinct source rather than forcing a full `WorkflowActivityTracker` refactor up
front. The **commitment is one indicator with typed entries** — do not build a second parallel indicator.

This builds on the existing indicator/dropdown: `WorkflowActivityIndicator` subscribes
`tracker.onChange(() => this.update())` (`src/ui/workflow-activity-indicator.ts:138`) and
`WorkflowActivityDropdown.renderEntry()` (`src/ui/workflow-activity-dropdown.ts:261`) routes an entry
click via `onNavigate(conversation_id)`. The generalization adds an entry **type** discriminator; a
`flow-run` entry's click routes to the run-tree opener (`POL-003`) instead of a plain conversation jump,
while a `background-workflow` entry keeps `onNavigate`.

**FRs:** FR-179 (unified activity indicator half).

**Files:**
- `src/workflows/workflow-activity-tracker.ts` — extend the tracked entry shape with a type discriminator
  (`background-workflow` | `flow-run`) and a flow-run source backed by `session.json` status (not
  in-memory only); keep `onChange()` (`:118`) / `notifyChange()` (`:129`) / `getIndicatorEntries()`
  (`:57`) the live-update seam.
- `src/ui/workflow-activity-dropdown.ts` — `renderEntry()` (`:261`) routes a `flow-run` entry click to the
  run-tree opener (`POL-003`); `background-workflow` entries keep `onNavigate(conversation_id)`.
- `src/ui/workflow-activity-indicator.ts` — no structural change beyond the typed entries it already
  re-renders via `tracker.onChange()` (`:138`).
- `src/main.ts` — wire the flow-run source into the tracker (alongside `getWorkflowActivityTracker()`).

**Dependencies:** `POL-003` (the run-tree leaf + opener that flow-run entries open into).

**Acceptance Criteria:**
- [x] There is exactly **one** activity indicator with **typed entries** — the existing
  `WorkflowActivityIndicator`/`Dropdown` is generalized with a `flow-run` source + a "Flows" section; no
  second parallel indicator is built.
- [x] A `flow-run` entry click **opens the run-tree view** (`setOnOpenRunTree` → `openRunTreeView`); a
  `background-workflow` entry keeps navigating to its conversation (`onNavigate`).
- [x] The indicator reads two sources of truth: in-memory background workflows
  (`WorkflowConcurrencyManager`) and a **session-file-backed** flow-run registry (re-seeded by the
  recovery scan + upserted on launch/finalize) — flows are not in-memory-only (a recovered run surfaces).
- [x] Live updates flow through the existing `WorkflowActivityTracker.onChange()` /
  `getFlowRunEntries()` seam (`upsertFlowRun` calls `notifyChange()`).

---

## VAL-001: End-to-end validation against `quickstart.md`

**Description:** Manually walk the entire [../quickstart.md](../quickstart.md) end-to-end, confirming the
feature behaves as documented as a user would experience it, and that the quickstart's own **Validation
checklist (VAL-001)** passes. This is the final feature acceptance gate — it exercises every phase
together, not just Phase 7. It is performed after the e2e gates (`TEST-007`, `TEST-008`) are green.

The walkthrough covers the quickstart's scenarios (1–6, plus the two Phase-5 scenarios 3A/3B):

1. **Enable the feature group** (Scenario 1, FR-119) — toggle `orchestration_enabled`; confirm the
   `orchestrations/` directory is created, the `orchestration-creator` persona appears, and the "Notor:
   Run Orchestration" command + the `emit_event` / `run_flow` / task tools appear; toggle off → all
   disappear.
2. **Author a minimal flow by hand** (Scenario 2) — write a `definition.md` + step notes per
   [../contracts/vault-schema.md](../contracts/vault-schema.md); confirm the parser accepts it.
3. **Run it** (Scenario 3) — run to `FLOW_COMPLETE`; confirm the session workspace
   (`session.json`/`session-log.jsonl`/`scratchpad/`/`tasks/`), per-turn progress Notices, and task
   enforcement behave as documented.
3A. **Interactive pause + paused-reload** (Scenario 3A, FR-150, INT-030/INT-005) — a step emits
   `user.input.required`; confirm the loop suspends with `status: interrupted` (entry durable **before**
   suspending), a reload while paused **re-surfaces** the prompt (still-paused recovery, not a re-run),
   supplying input writes `user.input.received` and resumes to `FLOW_COMPLETE` once, and declining
   finalizes via `FLOW_CANCELLED`.
3B. **Step→workflow invocation** (Scenario 3B, FR-151, INT-031) — a step invokes a named single-turn
   workflow and folds its result into the step's context before emitting; confirm the workflow runs on the
   background loop (not a child flow — no `orchestration_edges`) and its cost/iterations are reconciled
   into the shared budget cell **after** the call. Confirm the **uncapped** behavior is as documented: the
   invoked workflow has no per-run cap, so the aggregate overshoot is unbounded — distinct from
   `run_flow`'s bounded soft ceiling (Scenario 5).
4. **Inspect the run tree** (Scenario 4, POL-003/POL-004) — open the run-tree leaf from the spawning
   card / activity indicator / progress Notice; confirm step conversations are hidden from the flat list
   and visible only in the tree; confirm live→static rendering and select-to-navigate.
5. **Compose two flows** (Scenario 5, INT-040…047) — mark a flow `notor-flow-invocable: true`, call it via
   `run_flow` from another flow's step; confirm the child runs on a child session, returns
   (`structured` preferred), the calling card shows the inline peek with aggregate rollup, the `child`
   edge + `child_run_metadata` are present, and `max_depth` / aggregate budget gate a too-deep spawn.
6. **Recovery after reload** (Scenario 6, INT-005 + INT-044) — interrupt a run, reload, confirm the
   parent/child session tree resumes coherently and the run-tree re-attaches live.

**FRs:** All (end-to-end), with emphasis on FR-119, FR-120/122/123/125/126, **FR-150/151** (the Phase-5
pause + step→workflow scenarios), FR-170…179.

**Files:**
- `../quickstart.md` — the script being validated (no code file; this task is a manual walkthrough whose
  output is the checked Validation checklist + any defect tickets filed against the relevant phase tasks).

**Dependencies:** `POL-003` (the run-tree view inspected in Scenario 4 + the inline card in Scenario 5),
`TEST-008` (the e2e gate that must be green before the manual walkthrough). The Phase-5 scenarios (3A/3B)
additionally exercise `INT-030` / `INT-031`, which must be landed for those two scenarios to pass.

**Acceptance Criteria:**
- [ ] Every step of [../quickstart.md](../quickstart.md) Scenarios 1–6 **plus the Phase-5 scenarios 3A
  (interactive pause + paused-reload) and 3B (step→workflow)** produces the documented behavior.
- [ ] The quickstart's own **Validation checklist (VAL-001)** is fully checked (including the
  interactive-pause and step→workflow items).
- [ ] Interactive pause (Scenario 3A) shows: loop suspends with `status: interrupted` (durable before
  suspend), a paused reload re-surfaces the prompt (not a re-run), input resumes to `FLOW_COMPLETE` once,
  decline finalizes via `FLOW_CANCELLED`.
- [ ] Step→workflow (Scenario 3B) shows: the workflow result folds into the step context before emitting;
  it runs on the background loop (no `orchestration_edges` / child-flow tree); cost/iterations reconcile
  into the shared budget cell **after** the call; the **uncapped/unbounded-overshoot** behavior matches
  the documented v1 contract (distinct from `run_flow`'s bounded soft ceiling).
- [ ] Composition (Scenario 5) shows: child session, `structured`-preferred return, inline peek card with
  aggregate rollup, `child` edge + `child_run_metadata`, and a `max_depth` / budget-gated blocked spawn.
- [ ] Recovery (Scenario 6) resumes the parent/child session tree coherently and the run-tree re-attaches
  its live subscription.
- [ ] Any divergence between documented and actual behavior is filed against the responsible phase task,
  not patched only in the doc.

---

## TEST-006: Composition unit tests

**Description:** Unit tests for Lane E (`INT-042`…`INT-047`). The **Phase 7 gate**. Covers the five
composition invariants called out in [../tasks.md](../tasks.md):

1. **`run_flow` enum** — the `flow` enum reflects currently discovered invocable flows (rebuilt per
   `execute()`); an unknown / no-longer-invocable flow returns `success: false` (not a throw)
   (`INT-041`/`INT-042`).
2. **Structured-vs-text return** — a child flow with a terminal code step that calls
   `emit(topic, payload, structured)` returns `structured` (lifted onto `RunResult.structured`); one
   with only a final conversation step falls back to `text`; `run_flow` prefers `structured` (`INT-043`).
3. **Budget / `max_depth` (shared cell) + per-subtree rollup (`subtreeConsumed`)** — a spawn is gated on
   `depth < maxDepth` AND the **shared** `budget` cell `> 0`; a decrement by one subtree node is visible to
   the parent/siblings (tree-wide, not per-branch); an exhausted ceiling blocks a new spawn
   (`success: false`, notional `depth_cap` / `cost_cap`) while an in-flight run finishes its current turn;
   per-subtree rollup numbers come from each run's **`RunContext.subtreeConsumed`** accumulator (Issue-12),
   **not** a delta of the shared cell — so two concurrent siblings each report only their own subtree;
   sub-agents (`maxDepth = 0`, fresh both-`Infinity` cell) are unaffected (`INT-046`).
4. **Edge-DAG no-cycle** — the `orchestration_edges` produced by invocation + chaining + intra-flow
   chaining form a tree-constrained DAG: no cyclic / sibling / `return` edges
   ([../contracts/edges.md](../contracts/edges.md) §3 invariant) (`INT-043`/`INT-045`).
5. **`child_run_metadata` back-compat** — a legacy `sub_agent_metadata` record (`jsonl_filename`,
   `token_usage`, `iteration_count`, `stop_reason`, `profile_name`) parses unchanged through the shared
   reader; new fields are optional/absent on legacy records (`INT-047`).
6. **Parent-rooted recovery (no duplicate child) via the `child.spawned`/`child.result` ledger** — a crash
   mid-`run_flow` does **not** double-execute the child: a replayed parent that finds a `child.spawned`
   with a matching `child.result` **reuses** the recorded result (no re-spawn), and one with no
   `child.result` **resumes the non-terminal child in place** (replaying its own log — never
   tombstone-and-respawn, so the child's `once()` markers survive and external effects are not double-run);
   the top-level recovery scan never recovers a `run_flow` child independently (`INT-044` + `INT-005`).
7. **Chaining bounded + chained-successor-recovered-as-root** — a two-flow `A → B → A` on-complete cycle
   terminates at `max_depth` / the aggregate budget (successor shares the cell by reference); a chained
   successor whose predecessor is already terminal is recovered as a **root** by the top-level scan
   (`INT-045` + `INT-005`).
8. **`run_flow` orchestration-context-only** — `run_flow` returns `success: false` when no
   `orchestrationContext` is present (Issue-4) (`INT-042`).

**FRs:** FR-172, FR-173, FR-175, FR-176, FR-177, FR-174/FR-125 (parent-rooted + chaining-root recovery) (and FR-126's DAG invariant exercised cross-cuttingly).

**Files:**
- `src/orchestration/flow-composition-manager.test.ts` — invocable-flow discovery + `run_flow` enum
  rebuild + unknown-flow `success: false`.
- `src/extensions/builtin-tool-scaffolds/run-flow.test.ts` — structured-vs-text return preference;
  spawn-gate `success: false` on blocked spawn.
- `src/run-loop/budget.test.ts` — extend (`ARCH-005`'s suite) for the aggregate `max_depth` / cost gate
  at orchestration spawn points (`INT-046`).
- `src/orchestration/edges.test.ts` — the edge-DAG no-cycle invariant over invocation + chaining edges.
- `src/types.test.ts` (or a colocated `child-run-metadata.test.ts`) — the `child_run_metadata` back-compat
  parse of a persisted `sub_agent_metadata` record.
- `src/orchestration/session-recovery.test.ts` — extend (`INT-005`'s suite) for parent-rooted child
  reconciliation via the `child.spawned`/`child.result` ledger: a replayed parent **reuses** a terminal
  child's recorded result and **resumes a non-terminal child in place** (replaying its own log — no
  tombstone-and-respawn); the top-level scan ignores `origin: "run_flow"` sessions but recovers an
  `origin: "chaining"` successor whose predecessor is already terminal as a **root** (`INT-044`/`INT-045`).

**Dependencies:** `INT-042`, `INT-043`, `INT-044`, `INT-046`, `INT-047` (the units under test).

**Acceptance Criteria:**
- [x] The `run_flow` `flow` enum reflects discovered invocable flows and rebuilds per `execute()`; an
  unknown flow returns `success: false`. (`run-flow.test.ts`)
- [x] **`run_flow` without `orchestrationContext` returns `success: false`** (Issue-4) — no parentless
  child flow is spawned. (`run-flow.test.ts`)
- [x] Structured return is preferred over text; a code-step terminal flow that calls
  `emit(topic, payload, structured)` yields `structured`, a conversation-only terminal flow yields `text`.
  (`run-flow.test.ts` prefer/fallback; the terminal-code-step lift itself is `runner.test.ts`/`code-step-executor.test.ts`.)
- [x] The budget / `max_depth` gate over the **shared** cell blocks a too-deep / over-budget spawn
  while letting in-flight runs finish their turn; a child's decrement is visible to the parent
  (tree-wide ceiling); sub-agents are unaffected (`maxDepth = 0`, fresh both-`Infinity` cell).
  (`run-flow.test.ts` gate + `composition.test.ts` shared-cell decrement; `budget.test.ts` sub-agent.)
- [x] **Per-subtree rollup is correct (`subtreeConsumed`)** — each run's `child_run_metadata` numbers come
  from its own `RunContext.subtreeConsumed` (not a shared-cell delta). (`composition.test.ts` fold test.)
- [x] The edge graph is asserted to be a tree-constrained DAG (no cyclic / sibling / `return` edges).
  (`edges.test.ts`.)
- [x] A legacy `sub_agent_metadata` record parses unchanged through the shared `child_run_metadata`
  reader. (`composition.test.ts` back-compat.)
- [x] **Parent-rooted recovery via the ledger:** the reuse-terminal / resume-non-terminal reconciliation is
  implemented in `makeChildFlowSpawner`'s `reconcileChildLedger` (child.spawned/child.result), and the
  scan-level invariant — a `run_flow` child is never independently recovered by the top-level scan — is
  asserted in `session-recovery.test.ts`. The full reuse/resume crash path is exercised end-to-end by
  TEST-008.
- [x] **Chaining bounded + chained-successor-recovered-as-root:** the `A → B → A` cycle bounded by the
  shared cell is asserted in `composition.test.ts`; the chained-successor-recovered-as-root rule in
  `session-recovery.test.ts`.

---

## TEST-008: e2e — `run_flow` child + structured return + run-tree live→static

**Description:** End-to-end test (all-phase gate; **gate for Lane E + POL-003**). In a clean test vault,
enable `orchestration_enabled`, author a small **invocable** child flow (`notor-flow-invocable: true`,
with a terminal **code step** that returns `structured`) and a parent flow whose step calls it via
`run_flow`, run the parent end-to-end, and assert the composition surfaces work together. Follows the
repo's e2e harness conventions (see the `write-e2e-test` skill); the chat container requires a clean
workspace in `setupVault` (`writeCleanWorkspace`) or the deferred Notor chat view never mounts.

It exercises the Phase-7 critical-path tail end-to-end: `run_flow` child execution on a child `RunLoop`
(`INT-043`), child session + `parent_session_id` (`INT-044`), structured return (`INT-043`), the `child`
edge + shared `child_run_metadata` (`INT-047`), and the run-tree view **live → static** transition
(`POL-003`).

**FRs:** FR-172, FR-173, FR-174, FR-177, FR-178, FR-179 (integration), exercised end-to-end.

**Files:**
- `tests/e2e/orchestration-run-flow.e2e.ts` (or the repo's established e2e path) — new e2e script: write
  the parent + invocable child flows, run the parent, assert the child session/return/edge/metadata, and
  open the run-tree view to assert live updates while running and a static render once complete.

**Dependencies:** Lane E (`INT-042`…`INT-047`) + `POL-003` (the run-tree view asserted live→static).

**Acceptance Criteria:**
- [ ] The parent flow's step invokes the child via `run_flow`; the child runs to its terminal event on a
  **child session** with `parent_session_id` = the parent session and `origin: "run_flow"`.
- [ ] The parent writes **`child.spawned`** (before launch) and **`child.result`** (on return) to its
  `session-log.jsonl` (Issue-1).
- [ ] The child returns a **`structured`** payload (terminal code step) and `run_flow`'s `ToolResult`
  carries it (prefer-`structured`), plus a `child_run_metadata` block with aggregate-subtree numbers
  sourced from the child run's `RunContext.subtreeConsumed` (Issue-12).
- [ ] A `child` edge (with `session_id` + `via_tool_call_id`) links the calling step's conversation to the
  child flow's entry conversation.
- [ ] The inline peek card renders on the `run_flow` tool-call card with the aggregate rollup + "Open run
  tree" affordance.
- [ ] The run-tree view renders the child flow under the parent step, shows **live** updates while the run
  is active, and renders **statically** once the run completes; selecting a node loads its conversation in
  the main chat.
- [ ] All step conversations (parent + child) are hidden from the flat conversation list; the run-tree is
  their only surface.
