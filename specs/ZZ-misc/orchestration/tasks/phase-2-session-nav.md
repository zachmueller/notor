# Task Bodies: Phase 2 — Session Workspace + Tasks + Conversation Navigation (Lane A)

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-120 group)
**Data Model:** [../data-model.md](../data-model.md)
**Master Task Index:** [../tasks.md](../tasks.md)
**Contracts:** [../contracts/edges.md](../contracts/edges.md) · [../contracts/vault-schema.md](../contracts/vault-schema.md) · [../contracts/tools.md](../contracts/tools.md) · [../contracts/run-loop.md](../contracts/run-loop.md)
**Status:** Draft

This file holds the full task **bodies** for design Phase 2 (repo phase: Integration, **Lane A**) —
task IDs **INT-001…INT-006** plus the two Lane-A test gates **TEST-005** and **TEST-007**. Task IDs and
their dependency edges are owned by [../tasks.md](../tasks.md); the IDs and edges reproduced here match
it exactly. The covered functional requirements are **FR-120…FR-126** (see [../spec.md](../spec.md)).

Design references: [orchestration.md → Session Workspace] and [orchestration.md → Conversation Model]
(canonical vault design doc). Schema authorities are linked, not redefined: the conversation-edge model
(`orchestration_edges`) and `child_run_metadata` are the single authority of
[../contracts/edges.md](../contracts/edges.md); the persisted vault entities (`session.json`,
`session-log.jsonl` write order, task notes) are the authority of
[../contracts/vault-schema.md](../contracts/vault-schema.md); the task-tool I/O shapes are the authority
of [../contracts/tools.md](../contracts/tools.md).

## Lane scope and sequencing

Lane A opens once the Phase 1 core runner lands (`FEAT-010`) and runs concurrently with Lanes B/C/D.
Within Lane A the internal order is: `INT-001` (session manager) is the root; `INT-002`, `INT-004`,
`INT-005`, `INT-006` depend on it; `INT-003` depends on `INT-002`.

Two sequencing-risk register entries (from [../tasks.md](../tasks.md)) bear directly on this lane:

- **Risk #4 — hide step conversations the moment they are written.** `FEAT-007` (`StepTurnExecutor`)
  begins writing step conversations during Phase 1. `INT-006` (the `_type` marker + hidden-from-list
  filter) must land so step conversations never appear in the flat sidebar, and **`INT-006` must
  precede the run-tree view `POL-003`** (the run-tree is the only surface that renders these hidden
  conversations). `INT-006` therefore depends on `FEAT-007` and is a prerequisite of `POL-003`.
- **Risk #8 — `FLOW_COMPLETE` enforcement before `FLOW_CANCELLED`.** `INT-003` (FR-123) must land
  **before** `INT-012` (Lane B's `FLOW_CANCELLED`, FR-132), because `FLOW_CANCELLED` is defined as the
  terminal event that **bypasses** the completion-task enforcement `INT-003` introduces. Building the
  bypass before the thing it bypasses is undefined. `INT-012` lists `INT-003` as a dependency.

**Per-phase test gate (Phase 2, from [../tasks.md](../tasks.md)):** `TEST-005` (recovery idempotency)
green; a `history` test confirms step conversations are hidden from the flat list. Lane A also feeds the
all-phase e2e gate `TEST-007` (single flow → `FLOW_COMPLETE`, steps hidden).

---

## INT-001: `OrchestrationSessionManager` (session dir + scratchpad + path auto-allow)

**Description:** Implement `OrchestrationSessionManager`, the owner of per-session workspace lifecycle.
On flow start it allocates a session id and creates
`{notor_dir}/orchestrations/sessions/{session-id}/` containing `session.json` (initial status
`active`), an empty `session-log.jsonl` (the writer itself is `FEAT-006`'s `SessionLog`; this task
creates/owns the directory and the session-metadata file), a `scratchpad/` directory (shared,
restriction-free cross-step working space), and a `tasks/` directory (populated by `INT-002`). It
exposes the resolved `scratchpadPath` and `tasksPath` for the prompt scaffold (`FEAT-005`) to inject and
for the engine to thread into step turns.

The defining responsibility beyond directory creation is **path auto-allow**: while a step turn that
belongs to the owning session is executing, the session's `scratchpad/` path must bypass per-step path
constraints so any step can read/write shared state (FR-121). This requires a **signature change** to
the existing path enforcer — `enforcePathConstraints(toolName, parameters, entry, vaultRootPath,
resolveVaultPath?)` at `src/tool-config/path-enforcer.ts:45` (param set `TOOL_PATH_PARAMS` ~28) **has no
per-session seam today** (`entry.allowed_paths` is fixed at dispatch time). INT-001 adds an **optional
`sessionAllowedPaths?: string[]`** parameter (sourced from `OrchestrationToolContext.scratchpadPath` —
and `parentScratchpadPath` for `shared` handoffs — at the single `ToolDispatcher.dispatch()` assembly
site, beside `runContext`/`orchestrationContext`). A path under any `sessionAllowedPaths` prefix is
allowed **in addition to** `entry.allowed_paths`, so the active session's scratchpad is allowed
**without** mutating the shared/global tool config and **without** a global "current session".
Non-orchestration callers pass `undefined` and behave exactly as today. The auto-allow is
**session-scoped**: a step in session A must not gain access to session B's scratchpad. (The Phase 7
`shared` handoff mode reuses this same parameter to auto-allow a *parent* session's scratchpad in a
child — see `INT-044`; this task implements only the owning-session case.)

`session.json` shape and the `session-log.jsonl` entry types / enforced write order are defined by
[../contracts/vault-schema.md](../contracts/vault-schema.md) (`OrchestrationSessionMeta` in
[../data-model.md](../data-model.md)); do not redefine them here. The `parent_session_id` / `origin`
fields exist on `session.json` from the start but are written `null` until Phase 7 composition
(`INT-044`).

**FRs:** FR-120 (session workspace), FR-121 (shared scratchpad + path auto-allow).

**Files:**
- `src/orchestration/session-manager.ts` — new `OrchestrationSessionManager` (create/load session dir,
  `session.json` read/write, expose `scratchpadPath`/`tasksPath`, register the per-session
  scratchpad-allow).
- `src/orchestration/types.ts` — reuse `OrchestrationSessionMeta` (added by `FEAT-001`); no new domain
  types expected here.
- `src/tool-config/path-enforcer.ts` — **add an optional `sessionAllowedPaths?: string[]` parameter** to
  `enforcePathConstraints(...)` (~45); a path under any such prefix is allowed in addition to
  `entry.allowed_paths`. The param defaults to `undefined` (non-orchestration calls unchanged). Sourced
  from `OrchestrationToolContext` at the dispatch assembly site.
- `src/orchestration/runner.ts` — `OrchestrationRunner` (`FEAT-010`) constructs the session via the
  manager at flow start and passes `scratchpadPath`/`tasksPath` into the prompt scaffold + step turns.

**Dependencies:** `FEAT-006` (SessionLog writer / log format), `FEAT-010` (OrchestrationRunner — the
caller that creates a session on start).

**Acceptance Criteria:**
- [ ] On flow start the session directory and its `scratchpad/` and `tasks/` subdirectories are created;
  `session.json` is written with status `active`, the flow name, iteration 0, and the original prompt.
- [ ] The session's `scratchpad/` path is auto-allowed in path enforcement for the owning session's step
  turns: a step can write a file there and a *different* step in the same session can read it back, even
  if neither step's persona `<notor_tool_config>` grants that path.
- [ ] The auto-allow is session-scoped — a step belonging to another session does **not** gain access to
  this session's scratchpad.
- [ ] `enforcePathConstraints` gains an optional `sessionAllowedPaths?` parameter; passing `undefined`
  (every non-orchestration call) yields **byte-identical** behavior to today (asserted by the existing
  path-enforcer tests, unmodified).
- [ ] Per-step path constraints for all non-scratchpad paths are unchanged for orchestration step turns,
  and `enforcePathConstraints` behavior is unchanged for all non-orchestration tool calls.
- [ ] `parent_session_id` and `origin` are present in `session.json` and default to `null`.

---

## INT-002: Four task-tool scaffolds (ensure / start / close / list), gated

**Description:** Add the runtime task registry as four built-in extension tool scaffolds —
`orchestration_task_ensure`, `orchestration_task_start`, `orchestration_task_close`,
`orchestration_task_list` — each `featureGroup: "orchestration"` so they compile/register only when
`orchestration_enabled` is true (gating established by `ENV-002`). Each maintains task notes under the
active session's `sessions/{id}/tasks/{key}.md` with `notor-type: orchestration-task` frontmatter.

Behavior summary (full I/O contract: [../contracts/tools.md](../contracts/tools.md); task-note
frontmatter: [../contracts/vault-schema.md](../contracts/vault-schema.md)):
- `orchestration_task_ensure(key, description)` — **idempotent**: create the task note with status
  `open` if `{key}.md` does not exist; if it already exists, no-op (no duplicate, no status reset).
- `orchestration_task_start(key)` — set `notor-task-status: running` and stamp `notor-task-started`.
- `orchestration_task_close(key)` — set `notor-task-status: closed` and stamp `notor-task-completed`.
- `orchestration_task_list(filter?)` — list the session's tasks, optionally filtered by status.

The tools resolve "the current session" from the session context the engine threads through step turns;
they write under the session `tasks/` directory owned by `INT-001`. They are `mode: write` (like
`emit_event`). Scaffolds follow the existing helper pattern at
`src/extensions/builtin-tool-scaffolds/_scaffold-helper.ts` (`featureGroup?` param ~9), mirroring
existing gated scaffolds such as `src/extensions/builtin-tool-scaffolds/capture-memory.ts`. These four
tools are also the surface the code-step `Orchestration­Helper.tasks` API (`INT-011`, Lane B) dispatches
through.

**FRs:** FR-122 (runtime task registry).

**Files:**
- `src/extensions/builtin-tool-scaffolds/orchestration-task-ensure.ts` — new gated scaffold.
- `src/extensions/builtin-tool-scaffolds/orchestration-task-start.ts` — new gated scaffold.
- `src/extensions/builtin-tool-scaffolds/orchestration-task-close.ts` — new gated scaffold.
- `src/extensions/builtin-tool-scaffolds/orchestration-task-list.ts` — new gated scaffold.
- `src/orchestration/task-registry.ts` — shared task-note read/write/parse helper the four scaffolds
  call (frontmatter via the standard metadata pipeline; writes under `INT-001`'s `tasksPath`).
- `src/extensions/manager.ts` — no change required if `ENV-002` already registered
  `orchestration: "orchestration_enabled"` in `FEATURE_GROUP_TOGGLES` (~235) and the scaffolds are
  picked up by `reload()` (~264) tool filtering (~315); verify the four new scaffolds are excluded when
  the group is off.

**Dependencies:** `ENV-002` (feature-group registration — Risk #6: gating before scaffold
registration), `INT-001` (session `tasks/` directory + current-session resolution).

**Acceptance Criteria:**
- [ ] All four tools appear in the tool registry only when `orchestration_enabled` is true and disappear
  on toggle-off + `manager.reload(false)`.
- [ ] `orchestration_task_ensure` is idempotent: calling it twice with the same `key` yields exactly one
  task note and does not reset an already-`running`/`closed` task.
- [ ] `orchestration_task_start` / `_close` move `notor-task-status` to `running` / `closed` and stamp
  the corresponding timestamp field.
- [ ] `orchestration_task_list` returns the current session's tasks and can filter by status.
- [ ] Task notes are written under the active session's `tasks/` directory with the
  `notor-type: orchestration-task` frontmatter from [../contracts/vault-schema.md](../contracts/vault-schema.md).

---

## INT-003: `FLOW_COMPLETE` task enforcement

**Description:** Gate the terminal `FLOW_COMPLETE` event on the task registry so a flow cannot finalize
with unfinished work. When `FLOW_COMPLETE` is the event about to be routed, the engine queries the
session's tasks (`INT-002`): if any task has status `open` or `running`, the completion is **rejected**
and the engine publishes `flow.tasks_remaining` instead, with a payload listing the still-open task keys
+ descriptions, re-triggering a step with that context. When all tasks are closed, `FLOW_COMPLETE`
finalizes the flow normally.

This enforcement lives at the engine's terminal-event handling in `OrchestrationRunner` (`FEAT-010`) —
the same point that recognizes the configured `notor-completion-event` (default `FLOW_COMPLETE`). The
check runs after the engine has captured the emitted event but as part of routing it, and uses the
write-before-route discipline: the substituted `flow.tasks_remaining` event is the one logged + routed.
`flow.tasks_remaining` is an engine-**synthesized** topic: if no step declares a trigger for it, the
engine **auto-subscribes** it to the step that emitted the blocked `FLOW_COMPLETE` (FEAT-003 / FR-123),
so the re-trigger never dead-ends at the `FallbackCoordinator`. An explicit subscriber wins if present.

**Risk #8:** `INT-003` must land before `INT-012` (`FLOW_CANCELLED`). `FLOW_CANCELLED` (FR-132, Lane B)
is explicitly the terminal event that **bypasses** this enforcement (open tasks are acceptable on
cancel); it is defined as a delta against the enforcement implemented here, so this task is sequenced
first and `INT-012` depends on it.

**FRs:** FR-123 (completion task enforcement).

**Files:**
- `src/orchestration/runner.ts` — `OrchestrationRunner` terminal-event handling: intercept
  `FLOW_COMPLETE`, query open/running tasks, substitute `flow.tasks_remaining` when any remain.
- `src/orchestration/task-registry.ts` — a query helper (`hasOpenTasks()` / `listOpen()`) reused by the
  runner (introduced in `INT-002`).
- `src/orchestration/event-engine.ts` — no schema change; `flow.tasks_remaining` is a **synthesized**
  topic routed via the existing pub/sub — to an explicit subscriber if one declares the trigger, else
  **auto-subscribed** to the step that emitted the blocked `FLOW_COMPLETE` (FEAT-003 / FR-123), so it
  never reaches the `FallbackCoordinator`.

**Dependencies:** `INT-002` (task registry to query), `FEAT-010` (the runner that owns terminal-event
handling).

**Acceptance Criteria:**
- [ ] `FLOW_COMPLETE` emitted while any task is `open` or `running` does **not** finalize the flow;
  `flow.tasks_remaining` is published instead and re-triggers a step.
- [ ] `flow.tasks_remaining` reaches a step even when the author declared no explicit subscriber —
  auto-subscribed to the step that emitted the blocked `FLOW_COMPLETE` (FEAT-003); it does **not**
  dead-end at the `FallbackCoordinator`.
- [ ] The `flow.tasks_remaining` payload enumerates the remaining task keys/descriptions.
- [ ] `FLOW_COMPLETE` with all tasks `closed` (or with no tasks) finalizes the flow.
- [ ] `flow.tasks_remaining` is written to `session-log.jsonl` before it is routed (write-before-route).
- [ ] Enforcement is implemented as a discrete branch so `INT-012`'s `FLOW_CANCELLED` can bypass it
  without duplicating logic.

---

## INT-004: Persistent `memories.md`

**Description:** Add the cross-session persistent memory note at
`{notor_dir}/orchestrations/memories.md` (FR-124). It is a plain, free-form note (Patterns / Decisions /
Fixes / Context sections; not parsed structurally — see [../data-model.md](../data-model.md)). On first
use the note is **seeded** with the section skeleton if it does not yet exist. The step prompt scaffold
(`FEAT-005`'s `StepPromptBuilder`) is extended to (a) tell every step where `memories.md` lives and to
consult it before acting in unfamiliar territory, and (b) instruct steps to append fix-memories when
they get blocked and recover. Steps read/write the note through their normal note tools (its path is the
orchestrations root, not the per-session scratchpad), so no new path auto-allow is required beyond what a
step's persona already grants for the orchestrations directory.

**FRs:** FR-124 (persistent memory).

**Files:**
- `src/orchestration/memories.ts` — new helper to resolve the `memories.md` path and seed the skeleton
  on first use (idempotent: never overwrites an existing note).
- `src/orchestration/step-prompt-builder.ts` — extend `StepPromptBuilder` (`FEAT-005`) to inject the
  `memories.md` path + the consult-and-append instructions into every step turn.
- `src/orchestration/runner.ts` — ensure the memories note is seeded at flow start (or first step turn).

**Dependencies:** `INT-001` (orchestrations root / session lifecycle to hang seeding on), `FEAT-005`
(the prompt scaffold the memory instructions are injected into).

**Acceptance Criteria:**
- [ ] `memories.md` is seeded with the section skeleton on first use and never overwritten thereafter.
- [ ] The path to `memories.md` and the consult-before-acting + append-fix-memories instructions appear
  in every step's assembled system prompt (verifiable via the `step-prompt-builder` unit test).
- [ ] A step can append a memory and a later step (same or different session) reads it back.

---

## INT-005: Session recovery on reload (idempotent replay of `session-log.jsonl`)

**Description:** On plugin load, scan `{notor_dir}/orchestrations/sessions/*/session.json` for
recoverable sessions and replay `session-log.jsonl` to the last consistent state (FR-125). The recovery
rules follow [orchestration.md → Session Recovery]:

- **Parent-rooted scan (no duplicate child runs).** The top-level scan recovers **only root sessions**
  (`origin: "user"`) with status `active`/`interrupted`. A **child session** (`origin ∈ {run_flow,
  chaining}`) is **never** recovered by the top-level scan — its lifecycle is owned by the parent turn
  that spawned it, which is *also* being replayed. When the parent step that invoked `run_flow` is
  replayed (its `turn.start` dangles): if the linked child session already reached a terminal status
  (`completed`/`cancelled`), the parent **reuses the child's recorded result** (read from the child's
  `session.json`/log) rather than re-spawning; if the child is non-terminal, the parent's replay
  **tombstones** the stale child (mark its `session.json` status `error`/abandoned) and **re-spawns** a
  fresh child. This eliminates the race where an independently-recovered child runs *and* the re-run
  parent spawns a duplicate (the bug this rule exists to prevent). Child↔parent linkage is
  `parent_session_id` + the `child`/`parent` edges (INT-006 / INT-044).
- If the last log entry is a `turn.start` with no matching `turn.complete`, the turn was interrupted →
  **re-emit the triggering event** (the step retries from fresh context; per-step turns are
  fresh-context by design, so retry is safe — **provided scratchpad writes are overwrite-only**, FR-121,
  so a re-run reproduces rather than duplicates scratchpad content).
- If the last entry is an `event.emitted` with no following `turn.start`, the event was logged but not
  routed → **re-publish the event**.
- A **truncated/partial final line** (crash mid-write) is treated as absent — the last *complete* entry
  governs recovery (this is the `TEST-005` truncated-log case).
- **Edge backfill tolerance (5b).** A re-run mints **new** conversation ids, so a pre-crash `next`/`prev`
  edge may now point at an abandoned conversation. Recovery **re-backfills** `next`/`prev` against the
  new conversation ids as the resumed steps run; the run-tree (POL-003) **renders only resolvable edges
  and skips dangling ones** (it never assumes an edge target exists). Stale edges are inert, not fatal.
- The user is offered a "Resume orchestration?" prompt summarizing where the run left off.

The defining correctness property is **idempotency of the engine's bookkeeping**: replaying the same
log must converge to the same state and must not double-route an event or double-count a turn. Recovery
is, however, **at-least-once for step execution, not exactly-once**: a re-emitted trigger **re-runs the
step**, which re-runs any external, non-idempotent side effect (e.g. `git push`, a Slack/MCP post, a
deploy) the step performed before crashing. This is inherent — a plugin cannot make arbitrary shell/MCP
effects transactional — so the boundary is named explicitly. Steps guard such effects with
`orchestration.once(key, fn)` (FR-131 / INT-011), which appends a `side_effect.committed` log entry on
success; this recovery classifier consults committed `key`s so a re-run **skips** an already-committed
effect (best-effort — it cannot cover a crash *during* the effect, before the marker is written). The
scan hooks plugin load in `src/main.ts` (alongside existing load-time work; the plugin already does
conversation/session loading, e.g. `loadConversation()` ~1964 and `SessionManager` wiring) and drives
recovery through `OrchestrationRunner` (`FEAT-010`) using the `SessionLog` reader (`FEAT-006`).

**Sequencing note (Risk #9):** A session **paused on user input** (`INT-030`, Lane D) is modeled as a
recoverable log state (`user.input.required` / `user.input.received` entries from
[../contracts/vault-schema.md](../contracts/vault-schema.md)). `INT-005` lands **before** `INT-030` and
must define recovery generically enough that a dangling `user.input.required` (no following
`user.input.received`) recovers as "still paused, re-surface the prompt" rather than re-emitting a
trigger. `INT-030` lists `INT-005` as a dependency.

**Sequencing note (Risk #12 — parent-rooted child reconciliation):** The **root-only scan** and the
overwrite-safety/edge-tolerance rules land in `INT-005` itself (Phase 2). The **child-reconciliation**
half (a replayed `run_flow` reusing a completed child's result, or tombstoning-and-respawning a
non-terminal child) depends on child sessions existing, which is composition (`INT-043`/`INT-044`, Phase
7). `INT-005` therefore **defines the parent-rooted contract** (child sessions are not recovered by the
top-level scan — they carry `origin ∈ {run_flow, chaining}`) so child sessions are inert to the Phase-2
scanner; `INT-044` wires the parent-replay reuse/respawn behavior against it. Until composition lands,
the only recoverable sessions are roots, so the contract is correct and complete for Phase 2.

**FRs:** FR-125 (session recovery on reload).

**Files:**
- `src/orchestration/session-recovery.ts` — new: scan for `active`/`interrupted` sessions, read each
  `session-log.jsonl`, classify the dangling tail, compute the idempotent resume action, and collect
  the set of committed `side_effect.committed` keys so a re-run step's `orchestration.once(key, fn)`
  skips already-committed effects.
- `src/orchestration/session-log.ts` — a reader/parser for `session-log.jsonl` (writer is `FEAT-006`);
  tolerant of a truncated final line.
- `src/orchestration/runner.ts` — a `resume(session)` entry point that re-emits / re-publishes per the
  classified tail without re-running already-completed turns.
- `src/main.ts` — load-time scan that invokes session recovery and surfaces the resume prompt (gated on
  `orchestration_enabled`).

**Dependencies:** `INT-001` (session dir + `session.json` status), `FEAT-006` (the log format / reader),
`FEAT-010` (the runner that re-emits/re-publishes and continues the loop).

**Acceptance Criteria:**
- [ ] On load, **root** sessions (`origin: "user"`) with status `active` or `interrupted` are discovered;
  `completed` / `cancelled` / `error` sessions are ignored, and **child sessions
  (`origin ∈ {run_flow, chaining}`) are NOT recovered by the top-level scan** (they are reconciled by
  the parent replay — INT-044).
- [ ] A dangling `turn.start` (no `turn.complete`) re-emits its trigger; the step retries from fresh
  context.
- [ ] A dangling `event.emitted` (no following `turn.start`) re-publishes the event.
- [ ] A truncated final log line is ignored; the last complete entry governs.
- [ ] Engine-bookkeeping replay is **idempotent**: replaying a recovered log a second time produces no
  additional events or double-counted turns (asserted by `TEST-005`).
- [ ] Recovery is **at-least-once for step execution**: a re-emitted trigger re-runs the step (and may
  repeat an unguarded external side effect — documented boundary, not a defect).
- [ ] A side effect wrapped in `orchestration.once(key, fn)` that already recorded a
  `side_effect.committed` entry is **skipped** on a recovery re-run (best-effort; a crash before the
  marker is written may still re-run it).
- [ ] The recovery classifier leaves room for a dangling `user.input.required` to be treated as "still
  paused" (consumed by `INT-030`), not as an interrupted turn.
- [ ] Recovery re-runs are safe against scratchpad state because writes are overwrite-only (FR-121); a
  pre-crash `next`/`prev` edge pointing at an abandoned conversation is tolerated (re-backfilled against
  new conversation ids; the run-tree skips unresolved edges) — not an error.

---

## INT-006: `orchestration_edges` schema + hidden-from-list filter

**Description:** Two coupled pieces of the conversation model (FR-126):

1. **`orchestration_edges` on the step-conversation JSONL header.** The `StepTurnExecutor` (`FEAT-007`)
   writes orchestration metadata onto each step conversation's header (the `Conversation` type at
   `src/types.ts:24` has **no** orchestration fields today — this is net-new). The typed-edge adjacency
   list `orchestration_edges` (`kind ∈ next / prev / child / parent`, a tree-constrained DAG with no
   cyclic/sibling/return edges) and the additive header fields are the **single authority of
   [../contracts/edges.md](../contracts/edges.md)** — this task references that schema and does **not**
   redefine it. In Phase 2, the executor backfills `next`/`prev` edges to chain a flow's step
   conversations (the `child`/`parent` edges are produced by Phase 7 composition, `INT-043`/`INT-044`,
   and read by the same renderer). Backfill means: when step turn N+1's conversation is created with a
   `prev` edge to turn N, turn N's header is updated with a reciprocal `next` edge.

2. **Hidden-from-list filter.** Step conversations are excluded from the flat conversation sidebar by
   generalizing the existing sub-agent mechanism. Today `isSubAgentFilename(filename)` at
   `src/chat/sub-agent-history.ts:110` (`filename.includes("_subagent_")`) is consulted by
   `HistoryManager.listConversations()` at `src/chat/history.ts:629-630` and `searchConversations()` at
   `src/chat/history.ts:723-724`. Generalize this so a conversation whose header `_type` is
   `orchestration_step_conversation` (the marker from [../contracts/edges.md](../contracts/edges.md)) is
   also filtered out. Prefer a header-`_type` check over a filename convention for the orchestration
   case (the marker is authoritative and survives renames), keeping the existing `isSubAgentFilename`
   path intact for back-compat with already-persisted sub-agent files.

**Risk #4:** hide step conversations the **moment** `FEAT-007` writes them, or the flat sidebar fills
with per-step-turn noise. This task therefore depends on `FEAT-007` and must land in the same lane pass.
**`INT-006` must precede `POL-003`** (the run-tree view): the run-tree is the surface that renders these
now-hidden conversations, reading exactly the `orchestration_edges` this task writes (plus sub-agents'
existing `parent_conversation_id`), so the edge schema must exist first. `INT-047` (generalize
`sub_agent_metadata` → `child_run_metadata`) and `POL-003` both list `INT-006` as a dependency.

**FRs:** FR-126 (conversation edges + hidden-from-list).

**Files:**
- `src/types.ts` — additive orchestration fields on the conversation header (`_type` union gains
  `orchestration_step_conversation`; `orchestration_session_id` / `_flow_name` / `_step_name` /
  `_iteration` / `orchestration_edges`) per [../contracts/edges.md](../contracts/edges.md).
- `src/orchestration/step-turn-executor.ts` — `StepTurnExecutor` (`FEAT-007`) writes the header metadata
  and backfills `next`/`prev` edges between consecutive step-turn conversations.
- `src/chat/sub-agent-history.ts` — generalize the hidden-from-list predicate (keep
  `isSubAgentFilename` ~110; add a header-`_type`-based check for orchestration step conversations, e.g.
  `isHiddenFromConversationList(...)`).
- `src/chat/history.ts` — `listConversations()` (~629-630) and `searchConversations()` (~723-724)
  consult the generalized predicate in addition to `isSubAgentFilename`.

**Dependencies:** `FEAT-007` (the executor that writes step conversations — Risk #4), `INT-001` (session
context that supplies `orchestration_session_id`).

**Acceptance Criteria:**
- [ ] Step conversations are excluded from `listConversations()` and `searchConversations()` (the
  history hidden-from-list unit test, part of the Phase 2 gate).
- [ ] Existing sub-agent conversations remain filtered (`isSubAgentFilename` path unchanged); both kinds
  are hidden via one generalized predicate.
- [ ] Each step conversation header carries the orchestration metadata + an `orchestration_edges` list
  conforming to [../contracts/edges.md](../contracts/edges.md).
- [ ] `next`/`prev` edges are backfilled so a flow's step conversations form a chain; no cyclic edges are
  produced (DAG invariant).
- [ ] No schema for `orchestration_edges` / `child_run_metadata` is defined in this file — it links to
  [../contracts/edges.md](../contracts/edges.md).

---

## TEST-005: Session-recovery idempotency (truncated-log replay)

**Description:** Unit tests for `INT-005`. The **Phase 2 gate** for recovery. Drive
`session-recovery.ts` + the `session-log.jsonl` reader against synthetic logs covering each dangling-tail
class and assert idempotent convergence. This is the regression net guarding FR-125's "replay is
idempotent" AC.

**FRs:** FR-125.

**Files:**
- `src/orchestration/session-recovery.test.ts` — new unit test.
- `src/orchestration/session-log.test.ts` — log reader/parser tests (truncated-line tolerance), if not
  colocated.

**Dependencies:** `INT-005`.

**Acceptance Criteria:**
- [ ] A log ending in a dangling `turn.start` recovers by re-emitting the trigger exactly once.
- [ ] A log ending in a dangling `event.emitted` recovers by re-publishing exactly once.
- [ ] A log with a **truncated final line** recovers from the last complete entry (the truncated line is
  ignored, no parse throw).
- [ ] **Idempotency (engine bookkeeping):** running recovery twice over the same log produces the same
  resume action and no duplicate events or double-counted turns.
- [ ] **`once`-guarded side effect skip:** a log with a `side_effect.committed` entry for `key` causes a
  re-run's `orchestration.once(key, fn)` to skip `fn` (the committed-key set is collected during
  replay); an unguarded effect is documented as re-runnable (at-least-once boundary).
- [ ] A fully-completed log (ends in `session.complete`) yields **no** recovery action.
- [ ] A dangling `user.input.required` (no `user.input.received`) is classified as "still paused", not as
  an interrupted turn (forward-compat with `INT-030`).

---

## TEST-007: e2e — single flow → `FLOW_COMPLETE`, steps hidden from flat list

**Description:** End-to-end test (all-phase gate; **gate for `FEAT-010` + Lane A**). Runs a small
hand-authored flow in a clean test vault to a clean `FLOW_COMPLETE`, exercising the Lane-A surfaces
end-to-end: session workspace creation (`INT-001`), task ensure/close + completion enforcement
(`INT-002`/`INT-003`), and the hidden-from-list filter (`INT-006`). Follows the repo's e2e harness
conventions (see the `write-e2e-test` skill); the chat container requires a clean workspace in
`setupVault` (`writeCleanWorkspace`) or the deferred Notor chat view never mounts.

**FRs:** FR-120, FR-122, FR-123, FR-126 (integration), exercised end-to-end through `FEAT-010`.

**Files:**
- `tests/e2e/orchestration-single-flow.e2e.ts` (or the repo's established e2e path) — new e2e script:
  enable `orchestration_enabled`, write a minimal flow (`definition.md` + two step notes), run it, assert
  terminal state + that step conversations do not appear in the flat conversation list.

**Dependencies:** `FEAT-010` (runner) plus Lane A: `INT-001`, `INT-002`, `INT-003`, `INT-006`.

**Acceptance Criteria:**
- [ ] A minimal hand-authored flow runs end-to-end and terminates on `FLOW_COMPLETE`.
- [ ] A session directory with `session.json` (final status `completed`), a populated
  `session-log.jsonl`, and a `scratchpad/` is created under
  `{notor_dir}/orchestrations/sessions/{id}/`.
- [ ] Tasks ensured during the run are all `closed` at completion (a `FLOW_COMPLETE` attempted with an
  open task is rejected and re-triggers, then completes once closed — exercising `INT-003`).
- [ ] The flow's per-step conversations are **hidden** from the flat conversation sidebar
  (`listConversations()` / the chat history list does not surface them).
- [ ] No regression: a normal (non-orchestration) conversation in the same vault still appears in the
  list.
