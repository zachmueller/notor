# Orchestration Engine — Multi-Step Flow Specification

**Created:** 2026-06-27
**Status:** Draft
**Branch:** feature/orchestration
**Supersedes:** [specs/05-ralph/spec.md](../../05-ralph/spec.md) (the "hats" precursor — terminology and architecture revised)
**Source design notes (Obsidian vault):**
- `ai/notor/ideas/Multi-hat orchestration loop engine.md`
- `ai/notor/ideas/Generalized run-loop engine for sub-agents and orchestration.md`
- `ai/notor/ideas/Run-tree view for orchestration and sub-agent navigation.md`
- `ai/notor/ideas/Make orchestration flows highly composable.md`

**Related spec docs:** [plan.md](plan.md) · [research.md](research.md) · [data-model.md](data-model.md) · [quickstart.md](quickstart.md) · [tasks.md](tasks.md) · [contracts/](contracts/)

---

## Overview

Notor currently executes **single-turn workflows**: one prompt → one assistant response (with tool
use across multiple LLM turns within that one session). Complex tasks — implementing a feature
end-to-end, synthesizing research across many sources, running an adversarial review — need
multi-step coordination a single session cannot reliably provide.

This feature adds a native, in-process **orchestration engine**: an event-driven loop where
specialized LLM roles (**steps**) take turns processing work, passing named **events** to one another
until a terminal condition is reached. Each step gets its own conversation (a separate JSONL file),
its own **persona** (system prompt, tool access, model), and its own instructions. Steps communicate
by publishing events; the engine routes each event to the next step by trigger subscription.

The engine is built on a generalized headless turn-loop substrate (`RunLoop`) extracted from the
existing `SubAgentRunner`, so sub-agents and orchestration step turns share one execution engine.
Flows are **composable** (a flow can be invoked as a tool by another flow, or chain into a successor
on completion) and **observable** (a unified run-tree view renders the whole run as a navigable
hierarchy). Orchestration state — flows, steps, sessions, tasks, memories — all lives in the vault,
consistent with Notor's vault-native approach.

**What it is not:** a workflow. Workflows are single-turn prompt templates launched via the workflow
system. Orchestrations are multi-step event loops with state, coordination, and programmatic control
steps, launched separately (though individual steps may invoke workflows).

### Scope

This specification covers the **entire feature as one cohesive implementation** (design Phases 0–7).
No phase is required to be independently shippable; the feature ships together. The phase structure
exists to order the work and isolate the regression-critical foundation (the `RunLoop` extraction),
not to define separate releases.

The whole subsystem is gated behind a feature group (`orchestration_enabled`), defaulting to **off**,
mirroring the memory subsystem.

---

## User Stories

- As a developer, I want to run a multi-step implementation loop (plan → build → verify → review →
  finalize) so complex features are implemented autonomously without me manually chaining prompts.
- As a researcher, I want a multi-phase research flow (explore → synthesize → verify → summarize) so
  large research tasks complete with consistent rigor at each phase.
- As an author, I want to define reusable flows, steps, and personas as vault notes so teammates can
  invoke the same orchestrations without understanding the underlying prompt engineering.
- As a user, I want each step's turn visible as its own conversation so I can follow progress and
  diagnose where a run went wrong.
- As a user, I want per-step tool access governed by the step's persona so a planner can't write code
  and a builder can only write where I allow.
- As a user, I want deterministic, zero-LLM **code steps** for verification, data-fetching, routing,
  and notifications so the flow's plumbing is reliable and free.
- As a user, I want orchestration sessions to survive a plugin restart so a long run isn't lost.
- As a user, I want the run to terminate automatically if it gets stuck (stale loop, thrashing,
  iteration/runtime/cost cap) so a confused model doesn't burn unlimited tokens.
- As a user, I want a progress Notice after each turn that I can right-click to jump into that step's
  conversation so I can intervene when something looks amiss.
- As a user, I want to pause a run for input when a step needs my judgment, then resume.
- As an author, I want flows to compose — call one flow as a tool from another and get a result back,
  or chain one flow into a successor on completion — so I can build large automations from small,
  well-tested flow building blocks.
- As a user, I want a unified run-tree view that shows the whole run (orchestration steps *and*
  sub-agents) as a navigable, collapsible tree, live while running and static when done.
- As a user, I want a built-in `orchestration-creator` persona that guides me through authoring a new
  flow interactively.

---

## Functional Requirements

Requirements are grouped by the eight work areas (design Phases 0–7). Each FR group maps to tasks in
[tasks.md](tasks.md) and a checkbox in [checklists/requirements.md](checklists/requirements.md).

### FR-100 group — Generalized RunLoop substrate (design Phase 0)

**FR-100: Headless `RunLoop` engine.** A new `src/run-loop/` module provides a generalized headless
turn-loop engine (`RunLoop`) extracted from `SubAgentRunner`'s loop. It owns the turn loop
(stream-parse → tool dispatch → repeat), per-run safety caps (iteration / token / context-window
proximity / cost), wind-down summarization on any terminal cap, parent abort cascading, and a set of
optional lifecycle hooks (`onTurnStart`/`onTurnComplete`/`onPersist`/`onProgress`).

- AC: `RunLoop` runs an isolated LLM conversation to a terminal condition and returns a `RunResult`.
- AC: it dispatches tools via `executeToolBatches` (inheriting batched/parallel intra-turn dispatch).

**FR-101: `SubAgentRunner` consumes `RunLoop` (behavior-preserving).** `SubAgentRunner` is refactored
into a thin adapter over `RunLoop` (seeding `maxDepth = 0`, aggregate budget `Infinity`, no
persistence hooks), mapping `RunResult` → `SubAgentResult`.

- AC: `sub-agent-runner.test.ts`, `use-subagent.test.ts`, `constants.test.ts` pass with no behavioral
  change (the **RunLoop regression gate**).
- AC: sub-agent caps, wind-down, and abort behavior are byte-identical to today.

**FR-102: `RunContext` rides the dispatch seam.** `RunContext = { depth, maxDepth,
iterationsRemaining, costRemainingUsd, abort }` is added as an optional `runContext?` field on
`ToolExecuteOptions`, assembled once in `ToolDispatcher.dispatch()` and threaded through
`executeToolBatches`. Existing tools ignore it; `use_subagent` (and later `run_flow`) read it.

- AC: a child run inherits the parent's remaining budget and `depth + 1`.
- AC: `RunContext` is **not** merged into `ToolSessionContext` (different lifecycle).

**FR-103: Depth model replaces the binary recursion ban.** The sub-agent no-nesting ban
(`SUBAGENT_EXCLUDED_TOOLS` + `_isSubAgentContext`) is replaced by a `depth < maxDepth` check on
`RunContext`. Sub-agents pass `maxDepth = 0` (nested `use_subagent` still rejected); flows pass
`maxDepth = N` or unlimited.

- AC: nested `use_subagent` is rejected exactly as today (depth 0).
- AC: the rejection path returns a clear tool error, not a throw.

**FR-104: Always-both `RunResult`.** `RunResult` always carries `text` plus an optional `structured`
payload slot (populated only by a terminal code step). `SubAgentResult` is a strict subset
(`structured` always null).

- AC: `stopReason ∈ {completed, iteration_cap, token_limit, context_window, cost_cap, depth_cap}`.
- AC: the refactor of `SubAgentResult` is non-breaking.

**FR-105: Two-layer limit model.** A per-run iteration cap (unchanged, 20) and a new **aggregate
tree-wide budget** (`iterationsRemaining` / `costRemainingUsd` on `RunContext`) coexist. A turn
proceeds iff **both** layers have headroom. Aggregate counters decrement per-turn; exhaustion blocks
new child spawns only (in-flight runs finish their current turn).

- AC: a turn proceeds iff `localIterations < iterationCap AND iterationsRemaining > 0 AND
  costRemainingUsd > 0`.
- AC: sub-agents seed the aggregate to `Infinity`, so the per-run cap is the only effective limit.

**FR-106: Shared concurrency semaphore.** The counting `Semaphore` (currently `src/sub-agents/`) is
generalized into the run-loop layer so orchestration child-run concurrency uses the same primitive.

- AC: sub-agent concurrency cap (3) is unchanged.
- AC: the semaphore is importable by orchestration without sub-agent dependencies.

### FR-110 group — Core engine + flow schema (design Phase 1)

**FR-110: Flow definition as a vault note.** A flow is a directory
`{notor_dir}/orchestrations/{flow-name}/` with a `definition.md` (topology, loop config, guardrails)
and a `steps/` subdirectory of step notes. `definition.md` frontmatter uses the `notor-type:
orchestration-flow` discriminator. Full schema in [data-model.md](data-model.md) and
[contracts/vault-schema.md](contracts/vault-schema.md).

- AC: flows are discovered from `{notor_dir}/orchestrations/`.
- AC: the note body of `definition.md` is documentation only — never injected into any prompt.

**FR-111: Step note as a vault note.** Each step is a note under `{flow-dir}/steps/` with
`notor-type: orchestration-step` frontmatter (triggers, publishes, default-publishes, persona, model,
mode, mcp-servers) and a Markdown body of instructions.

- AC: each trigger topic maps to at most one step per flow; ambiguous routing is rejected at load
  with a clear error.
- AC: step bodies may use `<include_note>` tags.

**FR-112: Event engine (pub/sub + wildcard).** `OrchestrationEventEngine` provides `subscribe`,
`publish` (write-before-route), `getSubscribers`, `getEventHistory`. Multiple steps triggering on one
topic execute in `notor-steps` order.

- AC: `publish` appends the event to `session-log.jsonl` before routing.
- AC: a topic with no subscriber routes to the `FallbackCoordinator`.

**FR-113: FallbackCoordinator.** A mandatory `*` subscriber that receives any orphaned event, attempts
to steer back to a known topic, and terminates with `FLOW_ERROR` if unrecoverable.

- AC: it is always registered and cannot be overridden.
- AC: an orphaned event never silently stalls the loop.

**FR-114: Step prompt scaffold.** `StepPromptBuilder` wraps a step's raw instructions in a structural
scaffold (orientation → execute → verify → report → guardrails) and **always** injects the
must-publish rule, the objective, the incoming event, the recent event history, and the scratchpad
path. Persona content integrates via the existing `SystemPromptBuilder` append/replace mechanism.

- AC: the must-publish rule is present even when the step has custom instructions.
- AC: flow guardrails from `definition.md` are injected into every step turn.

**FR-115: Step turn execution.** `StepTurnExecutor` runs a conversation step on the shared `RunLoop`
(not `ChatOrchestrator.responseLoop()`): it creates a `ConversationSession`, resolves the step's
persona via `PersonaManager.getPersonaByName()` without mutating global state, runs the turn, and
captures the emitted event (or synthesizes `default_publishes` if none).

- AC: a step turn runs on `RunLoop`.
- AC: a no-emit turn synthesizes the step's `default_publishes` topic.

**FR-116: `emit_event` tool.** A built-in tool scaffold (feature-group-gated, mode `write`) that
captures `{topic, payload}` onto the session context; the engine reads and routes it **after** the
turn completes (no mid-turn routing).

- AC: it appears only when `orchestration_enabled` is true.
- AC: narrative text alone never counts as an emission.

**FR-117: Loop safety guards.** Iteration cap, runtime cap, stale-loop detection (same
`(topic, source, payload_hash)` triple 3× in a row), and thrashing detection (a task re-queued after
abandonment 3+ times) terminate a stuck flow.

- AC: a stale loop terminates the flow.
- AC: a runtime overrun terminates the flow.

**FR-118: OrchestrationRunner.** The main loop: load definition + steps, register the fallback,
create the session, publish the starting event, run the event loop, and finalize on the completion
event.

- AC: a hand-authored flow runs end-to-end with correct routing.
- AC: the loop terminates on `FLOW_COMPLETE` (subject to FR-123 task enforcement).

**FR-119: Feature group + command palette.** A `orchestration_enabled` setting (mirroring
`memory_enabled`) gates the subsystem; toggling it reloads extensions. A "Notor: Run Orchestration"
command opens a flow picker and prompt entry.

- AC: the command and all scaffolds are absent when disabled.
- AC: enabling creates the `orchestrations/` directory and registers scaffolds.

### FR-120 group — Session workspace + tasks + conversation navigation (design Phase 2)

**FR-120: Session workspace.** `OrchestrationSessionManager` creates
`{notor_dir}/orchestrations/sessions/{id}/` with `session.json`, `session-log.jsonl`, `scratchpad/`,
and `tasks/`. The scratchpad is shared, restriction-free working space for the owning session.

- AC: the session directory and scratchpad are created on flow start.
- AC: the scratchpad path is auto-allowed in path enforcement for the owning session's steps.

**FR-121: Shared scratchpad.** Every step in a run can read/write the session scratchpad without
restriction; the prompt scaffold tells each step where it lives and to use it for cross-step state.

- AC: a step can write a file other steps then read.
- AC: scratchpad access bypasses per-step path constraints for the owning session.

**FR-122: Runtime task registry.** Four task tools (`orchestration_task_ensure`/`_start`/`_close`/
`_list`) maintain task notes under `sessions/{id}/tasks/` with `notor-type: orchestration-task`
frontmatter.

- AC: `ensure` is idempotent (no duplicate on repeat key).
- AC: `list` can filter by status.

**FR-123: Completion task enforcement.** When `FLOW_COMPLETE` is emitted with open/running tasks, the
engine rejects it and publishes `flow.tasks_remaining` instead, re-triggering with remaining-task
context.

- AC: `FLOW_COMPLETE` with open tasks is rejected and re-triggers.
- AC: `FLOW_COMPLETE` with all tasks closed finalizes the flow.

**FR-124: Persistent memory.** A cross-session `{notor_dir}/orchestrations/memories.md` note that the
prompt scaffold instructs steps to consult and append fix-memories to.

- AC: the memories note is seeded on first use.
- AC: steps are instructed to consult it before acting in unfamiliar territory.

**FR-125: Session recovery on reload.** On plugin load, sessions with status `active`/`interrupted`
are recovered by replaying `session-log.jsonl`: a dangling `turn.start` re-emits the trigger; a
dangling `event.emitted` re-publishes the event; the user is offered a resume prompt.

- AC: an interrupted turn re-emits its trigger (step retries from fresh context).
- AC: replay is idempotent.

**FR-126: Conversation edges + hidden-from-list.** Step conversations carry orchestration header
metadata including a typed-edge adjacency list `orchestration_edges` (`kind ∈ next/prev/child/parent`,
tree-constrained DAG), and are hidden from the flat conversation sidebar (generalizing the sub-agent
`isSubAgentFilename` / `_type` filter). Full schema: [contracts/edges.md](contracts/edges.md).

- AC: step conversations are excluded from `listConversations()`/`searchConversations()`.
- AC: `next`/`prev` edges are backfilled to chain a flow's step conversations; no cyclic edges.

### FR-130 group — Programmatic code steps (design Phase 3)

**FR-130: Code step execution mode.** A step with `notor-step-mode: code` executes a TypeScript code
fence deterministically with no LLM call and no JSONL conversation, via the existing Sucrase pipeline
(`stripTypes` + `AsyncFunction` arg injection). Arg signature: `[app, obsidian, utils, libs, event,
orchestration]`.

- AC: a code step creates no conversation and consumes no tokens.
- AC: a code error fires `{step}.code_error` with the stack and shows an error Notice, while still
  logging `turn.start`/`turn.complete`.

**FR-131: OrchestrationHelper runtime API.** Code steps receive an `orchestration` helper:
`emit(topic, payload?)`, `scratchpad` (read/write/list/exists), `callTool`, `callMcpTool`, `tasks`
(list/ensure/start/close), `flow` (name/iteration/sessionId), `eventHistory(limit?)`. Built on the
existing extension `runtime-context/`. Full API: [contracts/orchestration-helper.md](contracts/orchestration-helper.md).

- AC: `return orchestration.emit(...)` routes the next event deterministically.
- AC: `callTool`/`callMcpTool` dispatch through registered built-in tools / connected MCP servers.

**FR-132: `FLOW_CANCELLED` terminal event.** A terminal event (from code *or* conversation steps) that
ends the loop with status `cancelled` and **bypasses** completion task enforcement.

- AC: `FLOW_CANCELLED` terminates immediately with status `cancelled`.
- AC: open tasks do not block `FLOW_CANCELLED`.

### FR-140 group — Progress notices (design Phase 4)

**FR-140: Per-turn progress Notice.** After each step turn, a brief progress Notice surfaces what was
accomplished and what's next.

- AC: each turn synthesizes a Notice naming the flow, step, and iteration.

**FR-141: Right-click Notice jump-in.** On desktop, right-clicking a progress Notice opens the step's
conversation (reusing the `oncontextmenu` Notice pattern + `switchToConversationById`).

- AC: right-click navigates to the step's conversation.
- AC: mobile omits the right-click affordance (consistent with existing Notices).

### FR-150 group — Interactive orchestration + step→workflow (design Phase 5)

**FR-150: `user.input.required` pause.** A step can emit `user.input.required` to pause the loop
awaiting user input, then resume with the supplied payload. The paused state is a recoverable log
entry (interplays with FR-125).

- AC: emitting the event pauses the loop and surfaces a prompt.
- AC: a session paused on input survives a reload and resumes correctly.

**FR-151: Step-to-workflow invocation.** A step can invoke a named single-turn workflow to direct its
task, awaiting the workflow's result into the step's context (hooking the background loop in
`src/chat/workflow-executor.ts`).

- AC: a step can invoke a workflow and receive its result.

### FR-160 group — Built-in flows + orchestration-creator persona (design Phase 6)

**FR-160: `orchestration-creator` built-in persona.** A new built-in persona (mirroring `notor-help`
and `tool-creator`) that guides users through authoring flows: discussing the concept, creating the
flow directory + `definition.md` + step notes, suggesting/creating personas, and validating topology.
Includes code-step guidance.

- AC: registered in `BUILTIN_PERSONA_PROFILES` alongside the existing built-ins.
- AC: write access scoped to `orchestrations/` and `personas/`.

**FR-161: Reference flows.** Vault-native reference flows (code-assist, research, review) shipped as
examples, demonstrating conversation steps, code steps, and composition.

- AC: each reference flow runs end-to-end.

### FR-170 group — Composability + run-tree view (design Phase 7)

**FR-170: Self-describing flow contract.** Each flow declares freeform natural-language
`notor-flow-inputs` and `notor-flow-returns` in its own `definition.md`, plus `notor-flow-invocable`,
`notor-on-complete-flow`, `notor-handoff-isolation`, and `notor-max-depth`. The contract lives in the
callee so upstream callers stay decoupled.

- AC: composition fields parse and are inert when the feature group is disabled.
- AC: the contract is surfaced to callers from the callee.

**FR-171: FlowCompositionManager.** A stateless discovery manager (mirroring `SubAgentManager`) that
re-scans `orchestrations/*/definition.md` for `notor-flow-invocable: true` on demand.

- AC: discovery holds no active state and re-scans per request.

**FR-172: `run_flow` tool (flow-as-invocable-tool).** A single built-in tool (feature-group-gated)
with a dynamic `flow` enum of discovered invocable flows (each flow's `notor-flow-inputs` surfaced in
the description, mirroring `UseSubagentTool`) and a single loose `payload` arg.

- AC: the `flow` enum reflects currently discovered invocable flows.
- AC: caller can pre-bind args statically, have the LLM fill them dynamically, or mix.

**FR-173: Flow-as-tool execution + structured return.** `run_flow` runs the child flow to its terminal
event in a child session on a child `RunLoop`, then returns the child's result (prefer `structured`,
fall back to `text`). A terminal code step populates `structured` deterministically.

- AC: the child flow runs on a child `RunLoop` to a terminal event.
- AC: the tool result prefers `structured` and falls back to `text`.

**FR-174: Child sessions + isolation modes.** Child sessions record `parent_session_id` and link into
the parent's recovery tree. `notor-handoff-isolation` selects `isolated` (default; fresh
scratchpad/tasks) or `shared` (inherits parent scratchpad; the parent scratchpad path is auto-allowed
in the child's path enforcement).

- AC: `isolated` gives a fresh scratchpad; `shared` auto-allows the parent scratchpad path.
- AC: a child session links to its parent for coherent recovery.

**FR-175: Chaining / one-way handoff.** At the terminal event, if `notor-on-complete-flow` is set, the
runner launches the successor instead of finalizing (no return). The engine injects the successor's
`notor-flow-inputs` into the predecessor's terminal step (default prompt-injection; optional
code-step adapter for non-trivial reshaping).

- AC: a chained successor launches with the forwarded, shaped payload.
- AC: chaining does not return to the originator.

**FR-176: Cascading guardrails.** Aggregate `max_iterations` / `max_cost_usd` / `max_depth` across the
flow tree (on `RunContext`) gate child spawns; a blocked spawn returns control (flow-as-tool) or
terminates the chain (chaining).

- AC: a spawn is gated on `depth < maxDepth` AND aggregate budget `> 0`.
- AC: in-flight runs finish their current turn when the ceiling is hit.

**FR-177: Shared `child_run_metadata`.** `ToolResult.sub_agent_metadata` is generalized into a shared
`child_run_metadata` block used by both `use_subagent` and `run_flow`, with one rendering path and one
token-rollup path. For flows it carries aggregate subtree numbers; for sub-agents, single-run totals.
The shape keeps the old `sub_agent_metadata` fields readable for persisted conversations. Full schema:
[contracts/edges.md](contracts/edges.md).

- AC: one rendering + one rollup path serves both tools.
- AC: already-persisted `sub_agent_metadata` still parses.

**FR-178: Unified run-tree view.** A dedicated `ItemView` leaf renders a run as a navigable,
collapsible tree (orchestration steps via `orchestration_edges` **and** sub-agents via
`parent_conversation_id`), live for active runs (via `WorkflowActivityTracker.onChange()`) and static
for completed runs. Reachable from the spawning tool-call card, the activity indicator, and a progress
Notice. Selecting a node loads its conversation in the main chat. Detailed UX:
[Run-tree view note]; data model: [contracts/edges.md](contracts/edges.md).

- AC: one tree renders both orchestration steps and sub-agents.
- AC: live for active runs, static for completed; smart auto-expand to the active/most-recent node.

**FR-179: Inline peek card + unified activity indicator.** The spawning tool-call card renders an
inline one-level peek (direct child summary + aggregate rollup + "Open run tree") — **new chat UI**,
since `sub_agent_metadata` is currently rendered only in HTML export. The activity indicator is
generalized to typed entries (flow-run entries open the run-tree).

- AC: the inline card renders in the chat panel (not only HTML export).
- AC: there is one activity indicator with typed entries, not a second parallel one.

---

## Key Entities

See [data-model.md](data-model.md) for full schemas. Summary:

- **Flow** — `definition.md` topology + `steps/`. **Step** — a step note (conversation or code).
- **Persona** — existing concept; a step references one for system prompt / tools / model.
- **Event** — `{ topic, payload, source_step }`. **Session** — one flow execution + its workspace.
- **RunContext / RunResult** — the run-loop substrate's cascade + result types.
- **Conversation edges** — `orchestration_edges` typed adjacency; **`child_run_metadata`** — shared
  rollup block.

---

## Out of Scope (v1)

- Step-subgraph reuse (only whole-flow reuse — authors design flows for composability).
- Run-tree node actions (retry/resume/edit) — read-only navigation in v1.
- Live inline one-line summaries per run-tree node (status + name + metrics only in v1).
- A dedicated "Runs" history surface for aged-out completed runs (reachability is via spawning
  block / activity indicator / Notice in v1).
- Migrating existing `notor-workflow: true` notes to the `notor-type` discriminator (separate change).

---

## Dependencies & Assumptions

- All assumptions about existing code were **verified against HEAD** (`68f606e`); see
  [research.md](research.md) for the seam table. The `RunLoop` extraction is behavior-preserving by
  construction (sub-agents seed `maxDepth = 0`, budget `Infinity`).
- The design notes reference `shared/notor/src/...`; this repo's source is at `src/...`. All paths in
  these specs use real `src/` paths.
- The feature depends on existing subsystems: personas, extensions/feature-groups, tool-config/path
  enforcement, the Sucrase compile pipeline, the chat history/session model, and the
  `WorkflowActivityTracker`/`Notice` UI primitives.
