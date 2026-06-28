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

**FR-102: `RunContext` rides the dispatch seam.**
`RunContext = { depth, maxDepth, budget, subtreeConsumed, abort }` — where `budget` is a **shared
`AggregateBudget` cell** (`{ iterationsRemaining, costRemainingUsd }`) referenced (never copied) by
every `RunContext` in the run tree, and `subtreeConsumed` is a **per-node accumulator** (constructed
fresh per child, folded into the parent on settle — the authority for `child_run_metadata`, FR-177) — is
added as an optional `runContext?` field on `ToolExecuteOptions`, assembled once in
`ToolDispatcher.dispatch()` and threaded through `executeToolBatches`. Existing tools ignore it;
`use_subagent` (and later `run_flow`) read it.
A **separate** optional `orchestrationContext?` field (the per-step session carriage; see FR-116)
rides the same seam — distinct from both `runContext` and `ToolSessionContext`.

- AC: a child run inherits the parent's `budget` **by reference** (the same shared cell) and `depth + 1`.
- AC: `RunContext` is **not** merged into `ToolSessionContext` (different lifecycle); neither is
  `orchestrationContext`.

**FR-103: Depth model replaces the binary recursion ban.** The sub-agent no-nesting ban
(`SUBAGENT_EXCLUDED_TOOLS` + `_isSubAgentContext`) is replaced by a `depth < maxDepth` check on
`RunContext`. Sub-agents pass `maxDepth = 0` (nested `use_subagent` still rejected); flows pass
`maxDepth = N` or unlimited.

- AC: nested `use_subagent` is rejected exactly as today (depth 0).
- AC: the rejection path returns a clear tool error, not a throw.

**FR-104: Always-both `RunResult`.** `RunResult` always carries `text` plus an optional `structured`
payload slot. The **only** producer of `structured` is a terminal code step that passes a third arg to
`orchestration.emit(topic, payload?, structured?)`; the runner lifts that value onto
`RunResult.structured` verbatim (no JSON round-trip). `SubAgentResult` is a strict subset (`structured`
always null).

- AC: `stopReason ∈ {completed, iteration_cap, token_limit, context_window, cost_cap, depth_cap}`.
- AC: `structured` is populated **iff** a terminal code step supplied it via `emit`'s third arg; it is
  `null` for conversation-only and sub-agent runs.
- AC: the refactor of `SubAgentResult` is non-breaking.

**FR-105: Two-layer limit model.** A per-run iteration cap (unchanged, 20) and a new **aggregate
tree-wide budget** — a **shared `AggregateBudget` cell** (`iterationsRemaining` / `costRemainingUsd`)
referenced by reference from every `RunContext` in the tree, **not** value-copied per child — coexist.
A turn proceeds iff **both** layers have headroom. The shared cell is decremented in place per-turn;
exhaustion blocks new child spawns only (in-flight runs finish their current turn; bounded overshoot
under concurrency is accepted).

- AC: a turn proceeds iff `localIterations < iterationCap AND budget.iterationsRemaining > 0 AND
  budget.costRemainingUsd > 0`.
- AC: a child inherits the parent's `budget` cell **by reference**, so a deep/wide subtree draws down
  one shared ceiling (not a per-branch copy).
- AC: sub-agents seed a fresh `budget` cell to `Infinity`, so the per-run cap is the only effective
  limit.

**FR-106: Shared concurrency semaphore.** The counting `Semaphore` (currently `src/sub-agents/`) is
generalized into the run-loop layer so orchestration child-run concurrency uses the same primitive.

- AC: sub-agent concurrency cap (3) is unchanged.
- AC: the semaphore is importable by orchestration without sub-agent dependencies.

### FR-110 group — Core engine + flow schema (design Phase 1)

**FR-110: Flow definition as a vault note + load-time topology validation.** A flow is a directory
`{notor_dir}/orchestrations/{flow-name}/` with a `definition.md` (topology, loop config, guardrails)
and a `steps/` subdirectory of step notes. `definition.md` frontmatter uses the `notor-type:
orchestration-flow` discriminator. The parser **validates the flow graph at load** (deterministic, not
delegated to the authoring persona): it **hard-errors** on a structurally-broken flow — the
`notor-completion-event` unreachable from `notor-starting-event`; a `notor-required-events` topic that
no step publishes; **and (Issue-10 fix) any published-but-unsubscribed non-terminal topic** (a
`notor-step-publishes` entry that no step triggers on and that is not a terminal/auto-subscribed topic).
The published-orphan case was previously only a *warning*, which let a typo'd topic pass load and die at
runtime as an unrecoverable `FLOW_ERROR`; it is now **blocking**, so an orphan-prone topology cannot
run. It still **warns** on the remaining suspicious-but-legal cases (e.g. a step whose trigger topic is
never published — a dead step). The runtime-only failure channels (`{step}.capped` / `{step}.no_emit` /
`{step}.code_error`), which the static validator cannot see as "published," must have an explicit
subscriber **or** are handled by the engine's default failure handler (a diagnosable `FLOW_ERROR`); the
validator surfaces a step that can produce one with no handler. Full schema in
[data-model.md](data-model.md) and [contracts/vault-schema.md](contracts/vault-schema.md); routing
rules + the failure-channel handling in [contracts/event-engine.md](contracts/event-engine.md).

- AC: flows are discovered from `{notor_dir}/orchestrations/`.
- AC: the note body of `definition.md` is documentation only — never injected into any prompt.
- AC: a flow whose completion event is unreachable, whose required-event is never published, **or that
  has any published-but-unsubscribed non-terminal topic**, is rejected at load with a clear error; a
  dead step (trigger topic never published) produces a warning.
- AC: a step that can produce a `{step}.capped` / `{step}.no_emit` / `{step}.code_error` failure event
  with no subscriber is either flagged at load or handled at runtime by the engine's default failure
  handler (a diagnosable `FLOW_ERROR` naming the step) — never an anonymous fallback orphan.

**FR-111: Step note as a vault note; single-subscriber routing with opt-in fan-out.** Each step is a
note under `{flow-dir}/steps/` with `notor-type: orchestration-step` frontmatter (triggers, publishes,
default-publishes, persona, model, mode, mcp-servers) and a Markdown body of instructions. By default
each trigger topic maps to **exactly one step**; a topic may route to **more than one** step **only**
when it is declared in the flow's `notor-fanout-topics` (then the subscribers run in `notor-steps`
order, FR-112). An **undeclared** collision (two steps triggering on the same topic not in
`notor-fanout-topics`) is rejected at load — this declaration is the schema signal that distinguishes
intended fan-out from an accidental collision.

- AC: a topic in two steps' triggers is rejected at load (naming the topic + both steps) **unless** it
  is declared in `notor-fanout-topics`, in which case it is accepted as ordered fan-out.
- AC: step bodies may use `<include_note>` tags.

**FR-112: Event engine (pub/sub + wildcard).** `OrchestrationEventEngine` provides `subscribe`,
`publish` (write-before-route), `getSubscribers`, `getEventHistory`. A single-subscriber topic routes
to its one step; a topic declared in `notor-fanout-topics` with multiple subscribers executes them in
`notor-steps` order. The engine **auto-subscribes** its own synthesized re-trigger topics
(`flow.tasks_remaining` / `flow.requirements_unmet`, FR-123) to the step that emitted the blocked
`FLOW_COMPLETE` when no step declares a trigger for them, so completion-enforcement re-entry never
dead-ends at the fallback.

- AC: `publish` appends the event to `session-log.jsonl` before routing.
- AC: a declared fan-out topic dispatches its subscribers in `notor-steps` order.
- AC: a synthesized re-trigger topic with no explicit subscriber auto-routes to the completing step.
- AC: a topic with no subscriber (and not auto-subscribed) routes to the `FallbackCoordinator`.

**FR-113: FallbackCoordinator (pure backstop).** A mandatory `*` subscriber that receives any orphaned
event, logs it with context, and terminates with `FLOW_ERROR`. It is **deterministic and synchronous
— no LLM, no fuzzy/string-distance steering** (which a synchronous handler could not do without
risking silent mis-routing). Orphan-prone topologies are caught earlier by the FR-110 load-time
validator; the coordinator is the loud last line of defense, not a guesser.

- AC: it is always registered and cannot be overridden.
- AC: an orphaned event never silently stalls the loop — it always yields a logged `FLOW_ERROR`.
- AC: the coordinator performs no LLM call and no payload-based topic inference.
- AC (Issue-10): static published-but-unsubscribed non-terminal topics are blocked at **load** (FR-110
  hard-error), and the runtime-only failure channels (`{step}.capped`/`{step}.no_emit`/`{step}.code_error`)
  reach a **diagnosable** `FLOW_ERROR` (naming the step + reason) via the engine's default failure
  handler when unsubscribed — so reaching the bare coordinator on a clean authoring mistake is
  prevented, not relied upon.

**FR-114: Step prompt scaffold.** `StepPromptBuilder` wraps a step's raw instructions in a structural
scaffold (orientation → execute → verify → report → guardrails) and **always** injects the
must-publish rule, the objective, the incoming event, the recent event history, and the scratchpad
path. Persona content integrates via the existing `SystemPromptBuilder` append/replace mechanism.

- AC: the must-publish rule is present even when the step has custom instructions.
- AC: flow guardrails from `definition.md` are injected into every step turn.
- AC: the scaffold instructs **overwrite-only** scratchpad writes (write the complete content / use a
  per-iteration filename; never incrementally append) for recovery safety (FR-121/125).

**FR-115: Step turn execution.** `StepTurnExecutor` runs a conversation step on the shared `RunLoop`
(not `ChatOrchestrator.responseLoop()`): it creates a `ConversationSession`, resolves the step's
persona via `PersonaManager.getPersonaByName()` without mutating global state, **resolves the step's
provider/model into a pinned `ResolvedProviderConfig` value object via the pure
`resolvePersonaProviderConfig(...)` (ARCH-007) — never `applyProviderModelOverrides()`, which mutates
the global `ProviderRegistry`** — pins that config into the `ConversationSession`, runs the turn, and
captures the emitted event (or synthesizes `default_publishes` if none, or `{step}.capped` on a
non-`completed` stop reason; see FR-117a). `notor-step-model` overrides the persona's model preference
in the resolver.

- AC: a step turn runs on `RunLoop`.
- AC: a no-emit turn synthesizes the step's `default_publishes` topic.
- AC: resolving a step's provider/model performs **no** global registry mutation
  (`switchProvider`/`updateConfig`); two concurrent step turns with different `notor-step-model` values
  each run on their own pinned model, and the global active provider/model is unchanged by a step turn.

**FR-116: `emit_event` tool.** A built-in tool scaffold (feature-group-gated, mode `write`) that
captures `{topic, payload}` onto the per-step **`orchestrationContext`** carriage (the
`pendingEmission` slot on `ToolExecuteOptions.orchestrationContext`, distinct from `ToolSessionContext`
— a per-step instance, so concurrent step turns never race); the engine reads `pendingEmission` and
routes it **after** the turn completes (no mid-turn routing). Each step turn carries its own
`orchestrationContext` instance, so the capture is isolated per turn (no global "current session").

- AC: it appears only when `orchestration_enabled` is true.
- AC: it writes to `orchestrationContext.pendingEmission` (not a global/shared slot); concurrent step
  turns / `run_flow` children do not clobber each other's capture.
- AC: narrative text alone never counts as an emission.

**FR-117: Loop safety guards.** Iteration cap, runtime cap, stale-loop detection (same
`(topic, source_step)` pair — payload deliberately excluded — for **4** consecutive events), thrashing
detection (a task re-queued after abandonment 3+ times), and the **completion no-progress guard**
(FR-123) terminate a stuck flow. Payload is excluded because `default_publishes` synthesizes payloads
from per-turn LLM text that varies each turn, so a payload-keyed signature missed the common
non-converging-LLM-loop case. The stale rolling window and thrashing counters are **rehydrated from the
replayed log on recovery** (FR-125), so a reload does not reset a near-stale loop.

**Every flow is bounded (no unbounded run is authorable — see FR-119a).** The tree-wide ceilings
`notor-max-iterations` / `notor-max-runtime-minutes` / `notor-max-cost-usd` are **optional in
frontmatter but defaulted to finite values by the parser** (`100` / `60` min / `$5.00`) when omitted —
**never `Infinity`**. This closes the "flow authored with no ceiling" hole: a code-step-only cycle
(which decrements neither budget half) is bounded by the always-present `notor-max-runtime-minutes`, and
an LLM cycle by the always-present cost/iteration ceilings. The user story "terminate automatically if
it gets stuck" therefore holds by construction even when an author sets nothing.

**Scope of stale detection (known limitation, by decision).** The `(topic, source_step)` signature
catches a **self-loop** (one step re-firing one topic). It does **not** detect multi-step cycles
(`A→B→C→A…`, distinct topics) by a general cycle detector in v1. Two specific cases that the bare stale
signature also misses now have dedicated handling:

- The **completion-enforcement alternation** (`FLOW_COMPLETE ↔ flow.tasks_remaining`) is bounded
  **cheaply** by the **completion no-progress guard** (FR-123, Issue-9): the engine terminates after N
  consecutive blocked `FLOW_COMPLETE` from the same step where the open-task / missing-required-events
  set did not shrink — it no longer relies on draining the budget.
- A general **multi-step cycle** is bounded by the **aggregate budget** (LLM-driven cycles draw down
  `iterationsRemaining`/`costRemainingUsd` each hop) and **`max_runtime`**. A **code-step-only** cycle
  consumes neither LLM turns nor cost, so it is bounded by **`notor-max-runtime-minutes`** — which is
  now **always present** (parser-defaulted to 60 min when omitted, FR-119a), so a code-step-only flow
  can no longer run unbounded even if the author sets nothing. Authors of long code-step flows should
  still raise it deliberately.

Authoring mitigation: distinct topics per outcome, code-step routers for branching, and sensible
`max_iterations` + `max_runtime`. (Full rationale:
[contracts/event-engine.md](contracts/event-engine.md) "Known limitation".)

- AC: a stale loop (4 consecutive identical `(topic, source_step)` pairs) terminates the flow,
  regardless of payload variation.
- AC: a runtime overrun terminates the flow.
- AC: a flow that omits all of `notor-max-iterations` / `notor-max-runtime-minutes` /
  `notor-max-cost-usd` still has finite parser-injected defaults — no flow runs with an effective
  `Infinity` ceiling (FR-119a).
- AC: the completion-enforcement alternation terminates via the no-progress guard (FR-123), not only by
  budget exhaustion.
- AC: the cycle-detection limitation is documented (stale catches self-loops; multi-step cycles rely on
  budget/runtime; completion-alternation is bounded by the no-progress guard; code-step-only cycles rely
  on the always-present `max_runtime`).

**FR-117a: Capped-step failure channel.** When a conversation step's `RunLoop` turn returns a
**non-`completed`** `stopReason` (`iteration_cap` / `token_limit` / `context_window` / `cost_cap` /
`depth_cap`) **and** the step did not explicitly emit its own event, the executor does **not** synthesize
the step's normal `default_publishes` (which would falsely signal success). It instead synthesizes a
distinct **`{step}.capped`** topic carrying the `stopReason` + the wind-down text. This mirrors the
`{step}.code_error` channel: `{step}.capped` is a **recognized failure channel** — if no step subscribes
to it, the engine's **default failure handler** terminates with a **diagnosable** `FLOW_ERROR` naming
the step + `stopReason` (loud, never silent — not an anonymous fallback orphan, Issue-10); authors may
subscribe to it for graceful degradation or retry. A step that **did** explicitly emit an event before
being capped has its emission honored (the cap raced an already-decided turn).

**Design constraint (semantic verification is the code step's job).** `{step}.capped` catches a
*cut-off* turn; it does **not** catch a turn that completed normally but produced wrong/empty work and
emitted its success topic anyway. The engine has no semantic verifier — a `completed` emission is taken
at face value. Authors needing a quality gate on a step's output must wire a verification step (code or
conversation) on that edge (the `[Builder] → [Verify Tests] → …` pattern). The engine guarantees only
that a *cut-off* or *no-emit* step never silently advances as success.

- AC: a step turn ending non-`completed` with no explicit emission synthesizes `{step}.capped` (not
  `default_publishes`), carrying the `stopReason`.
- AC: an unsubscribed `{step}.capped` reaches the engine's default failure handler and terminates with a
  diagnosable `FLOW_ERROR` naming the step + `stopReason` (never silently advances as success).
- AC: the "semantic verification is the author's job (via a verifier step)" boundary is documented
  (scaffold guidance + `orchestration-creator` persona + docs).

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

**FR-119a: Finite ceiling defaults (no unbounded flow is authorable).** The three tree-wide runaway
ceilings are optional in `definition.md` frontmatter but **never absent at runtime**: when omitted, the
`FlowDefinitionParser` injects finite engine defaults — **`notor-max-iterations = 100`**,
**`notor-max-runtime-minutes = 60`**, **`notor-max-cost-usd = 5.00`** (tunable, in
`src/orchestration/constants.ts`) — **never `Infinity`**. `notor-max-depth` may still be `null`
(unlimited *depth* is acceptable because the three ceilings still bound total work). This guarantees the
FR-117 "auto-terminate a stuck run" story holds even for a flow that sets nothing, including a
code-step-only flow (bounded by the always-present runtime cap). Authority: [data-model.md](data-model.md)
`OrchestrationFlow` + [contracts/vault-schema.md](contracts/vault-schema.md) frontmatter table.

- AC: a flow omitting all three ceiling fields parses with the finite defaults (not `Infinity`); a
  code-step-only flow with no ceilings set still terminates at the default runtime cap.

### FR-120 group — Session workspace + tasks + conversation navigation (design Phase 2)

**FR-120: Session workspace.** `OrchestrationSessionManager` creates
`{notor_dir}/orchestrations/sessions/{id}/` with `session.json`, `session-log.jsonl`, `scratchpad/`,
and `tasks/`. The scratchpad is shared, restriction-free working space for the owning session.

- AC: the session directory and scratchpad are created on flow start.
- AC: the scratchpad path is auto-allowed in path enforcement for the owning session's steps.

**FR-121: Shared scratchpad (overwrite-only for recovery safety).** Every step in a run can read/write
the session scratchpad without restriction; the prompt scaffold tells each step where it lives and to use
it for cross-step state. Scratchpad writes **must be overwrite/idempotent** (write the complete current
content, or use a per-iteration filename) — **never incremental append** — because crash-recovery
(FR-125) re-runs an interrupted step from fresh context, and an append would duplicate content on
re-run (`once(...)` guards only *external* effects, not scratchpad state). The scaffold (FR-114), the
reference flows (FR-161), and the `orchestration-creator` persona (FR-160) all carry this overwrite-only
instruction.

- AC: a step can write a file other steps then read.
- AC: scratchpad access bypasses per-step path constraints for the owning session.
- AC: the prompt scaffold + reference flows + persona instruct overwrite-only (no incremental append)
  scratchpad writes, so a recovery re-run reproduces (not duplicates) content.

**FR-122: Runtime task registry.** Four task tools (`orchestration_task_ensure`/`_start`/`_close`/
`_list`) maintain task notes under `sessions/{id}/tasks/` with `notor-type: orchestration-task`
frontmatter.

- AC: `ensure` is idempotent (no duplicate on repeat key).
- AC: `list` can filter by status.

**FR-123: Completion task enforcement (+ no-progress guard).** When `FLOW_COMPLETE` is emitted with
open/running tasks, the engine rejects it and publishes `flow.tasks_remaining` instead, re-triggering
with remaining-task context. The synthesized `flow.tasks_remaining` (and the analogous
`flow.requirements_unmet`) is **auto-subscribed** to the step that emitted the blocked `FLOW_COMPLETE`
when no step declares a trigger for it (FR-112), so the re-trigger never dead-ends at the fallback.

**Completion no-progress guard (Issue-9).** Auto-routing the re-trigger back to the same completing
step risks an **alternation livelock** if that step structurally cannot close the work
(`FLOW_COMPLETE(stepX) → flow.tasks_remaining → FLOW_COMPLETE(stepX) → …`) — which the stale and
thrashing detectors both miss, and which would otherwise drain the **entire** aggregate budget before
terminating. The engine therefore terminates with **`FLOW_ERROR`** after
**`COMPLETION_NOPROGRESS_THRESHOLD` (default 3)** consecutive blocked completions from the same step
where the **open/running-task set (or missing-required-events set) did not shrink**. A block where the
set shrank (real progress) **resets** the counter, so a step that *can* finish the work on a second look
still proceeds. This needs no general cycle detection — the engine already computes the blocking set at
each gate. Full rule: [contracts/event-engine.md](contracts/event-engine.md) "Completion no-progress
guard".

- AC: `FLOW_COMPLETE` with open tasks is rejected and re-triggers.
- AC: `flow.tasks_remaining` reaches a step even when the author wired no explicit subscriber
  (auto-subscribed to the completing step).
- AC: `FLOW_COMPLETE` with all tasks closed finalizes the flow.
- AC: N consecutive blocked `FLOW_COMPLETE` from the same step with a non-shrinking blocking set
  terminates with `FLOW_ERROR` (the alternation does not silently drain the budget); a shrinking set
  resets the counter.

**FR-124: Persistent memory.** A cross-session `{notor_dir}/orchestrations/memories.md` note that the
prompt scaffold instructs steps to consult and append fix-memories to.

- AC: the memories note is seeded on first use.
- AC: steps are instructed to consult it before acting in unfamiliar territory.

**FR-125: Session recovery on reload (at-least-once, parent-rooted + chaining-root).** On plugin load,
recovery scans sessions and replays `session-log.jsonl`: a dangling `turn.start` re-emits the trigger
(the step **re-runs** from fresh context); a dangling `event.emitted` re-publishes the event; the user
is offered a resume prompt. Several properties make this safe and complete:

- **Recovery-root selection by `origin` (always set; loud on unexpected).** `session.json.origin` is
  **never null** — it is stamped at creation and is the recovery discriminator. The top-level scan
  recovers: **`origin: "user"`** (always); and **`origin: "chaining"` iff its `parent_session_id`
  resolves to an already-terminal predecessor** (a chained successor is fire-and-forget — its
  predecessor finalizes before it launches, so there is no live parent to reconcile it; it is therefore
  recovered as its own root, closing the "crashed chained successor is an orphan" hole, Issue-3).
  `origin: "run_flow"` (and a `chaining` session whose parent is still non-terminal) is reconciled by
  its parent's replay, not scanned independently. A session with an **absent or unexpected `origin`** is
  surfaced as a **loud recovery error** (offered as resume-as-root), never silently skipped (Issue-4b).
- **`run_flow` child reconciliation via the durable `child.spawned`/`child.result` ledger.** A parent
  turn that invokes `run_flow` writes **`child.spawned`** (before launch) and **`child.result`** (the
  child's `structured`/`text` + `stop_reason`, on return) to its log. On replay of a dangling parent
  turn: a child with a recorded `child.result` (terminal) is **reused** — the parent does **not**
  re-spawn (this is the durable artifact the old "reuse the child's recorded result" rule referenced but
  never persisted, Issue-1); a `child.spawned` with no `child.result` (non-terminal) is **resumed in
  place** — the child session replays its **own** log and the parent awaits it. **Tombstone-and-respawn
  is removed** (Issue-2): because the child keeps its session and log, its `side_effect.committed`
  markers survive, so `once(...)` dedupes correctly across the crash for child flows — a respawned fresh
  child would have re-run every prior `once()`-guarded external effect. `run_flow` is **gated to
  orchestration contexts** (FR-172) precisely so every child has a replayable orchestration parent or is
  a chaining-root — a chat-launched child (no orchestration parent, no session-log) can never arise.
- **Budget + safety state are reconstructed, not reset (Issues 5/6).** The in-memory `AggregateBudget`
  cell is re-seeded from the flow's (defaulted, finite) ceilings and decremented by replaying each
  `turn.complete`'s recorded **`cost_usd` / `token_usage`**, so the cost/iteration ceiling and the
  run-tree header rollup survive a reload (a `$5.00` cap resumed mid-run does not reset to `$5.00`,
  which a crash-resume loop could otherwise exceed). The stale rolling window and per-task thrashing
  counters are **rehydrated from the replayed event/task history** in the same pass, so a near-stale
  self-loop is not zeroed by a reload.
- **Scratchpad overwrite-idempotency.** Vault-state replay is safe **because scratchpad writes are
  overwrite/idempotent** (FR-121) — a re-run rewrites the whole file. Append-style writes are
  prohibited precisely because they would duplicate on re-run.
- **Malformed-line policy.** The replay parser tolerates **only a malformed/truncated final line** (the
  expected crash signature); a malformed **interior** line fails that session's recovery **loudly**
  (marks it `error`), never silently truncating replay at the bad line (Issue-13d).

Recovery is **at-least-once, not exactly-once**: replay is idempotent for the engine's own bookkeeping
(events/turns), budget, and overwrite-style vault state, but a re-run step **repeats any external,
non-idempotent side effect** (e.g. `git push`, a Slack/MCP post, a deploy) it performed before crashing,
**and re-spends budget / re-executes every intra-step tool call** that is not individually
`once()`-guarded (a step that crashed on its 19th internal iteration redoes all 19 — Issue-13g). Steps
with such effects must be idempotent or guard themselves with `orchestration.once(key, fn)` (FR-131),
which records a `side_effect.committed` log entry so a re-run skips the already-committed effect
(best-effort — it cannot cover a crash *during* the effect); `once()` must wrap **every** non-idempotent
intra-step effect, not only the obvious external ones. A plugin cannot make arbitrary shell/MCP effects
transactional, so this boundary is named explicitly rather than implied as solved. Full recovery rules:
[contracts/vault-schema.md](contracts/vault-schema.md) Parent-rooted recovery.

- AC: an interrupted turn re-emits its trigger (step re-runs from fresh context).
- AC: engine-bookkeeping replay is idempotent (no double-routed event, no double-counted turn); the
  `AggregateBudget` cell and stale/thrashing state are reconstructed from the replayed log (not reset).
- AC: a crash mid-`run_flow` does **not** produce a duplicate child run — the parent's replay **reuses**
  a terminal child's recorded `child.result` or **resumes** a non-terminal child in place (never
  tombstone-and-respawn), so the child's `once()` markers survive.
- AC: a **chained successor** whose predecessor has finalized is recovered as a root (not orphaned); a
  session with absent/unexpected `origin` is surfaced loudly, not silently skipped.
- AC: `origin` is always set at creation; `run_flow` is rejected when no `orchestrationContext` is
  present (so no chat-launched, unrecoverable child exists).
- AC: `orchestration.once(key, fn)` skips an already-committed side effect on re-run (including across a
  child resume); the at-least-once boundary (external effects + budget re-spend + intra-step tool replay
  may repeat) is documented for authors (scaffold + persona + docs).
- AC: a truncated final log line is tolerated; an interior malformed line fails recovery loudly (marks
  `error`), never silently truncating replay.

**FR-126: Conversation edges + hidden-from-list.** Step conversations carry orchestration header
metadata including a typed-edge adjacency list `orchestration_edges` (`kind ∈ next/prev/child/parent`,
tree-constrained DAG), and are hidden from the flat conversation sidebar (generalizing the sub-agent
`isSubAgentFilename` / `_type` filter). Full schema: [contracts/edges.md](contracts/edges.md).

- AC: step conversations are excluded from `listConversations()`/`searchConversations()`.
- AC: `next`/`prev` edges are backfilled to chain a flow's step conversations; no cyclic edges.
- AC: edge consumers (the run-tree) tolerate **dangling** `next`/`prev` edges — after a recovery re-run
  mints new conversation ids, a stale edge target is skipped (not fatal), and recovery re-backfills
  edges against the new ids.

### FR-130 group — Programmatic code steps (design Phase 3)

**FR-130: Code step execution mode.** A step with `notor-step-mode: code` executes a TypeScript code
fence deterministically with no LLM call and no JSONL conversation, via the existing Sucrase pipeline
(`stripTypes` + `AsyncFunction` arg injection). Arg signature: `[app, obsidian, utils, libs, event,
orchestration]`. The compiled function runs under an outer **timeout guard** defaulting to **300 s**,
overridable per step via `notor-step-timeout-seconds`; the outer timeout must exceed any inner
`utils.executeShellCommand` `timeoutSeconds` (the 300 s default comfortably exceeds the build/test
budgets in the reference flows).

**Timeout limitation — fires only at `await` boundaries (Issue-7).** Code steps run as
`new AsyncFunction(...)` on Obsidian's **main (renderer) event-loop thread** (full parity with
user-defined tools; no Worker/VM isolation). The timeout guard is a `Promise.race`/`setTimeout`, which
can only fire when control returns to the event loop — i.e. at an `await`. So an **unbounded
*synchronous* section is NOT interruptible**: a `while (true) {}` or CPU-bound loop with no `await`
never yields, the timeout never fires, the step is **not** abandoned, and the **whole plugin freezes**
(`runContext.abort` has the same limit). The timeout *does* bound a step that is slow because it is
`await`-ing (long shell command, network, many tool calls) — the common, intended shape; and the
**inner** `utils.executeShellCommand` timeout *is* a hard kill (it runs out-of-process). Because code
steps are **trusted, author-written** code, the mitigation is guidance, not isolation: the scaffold and
the `orchestration-creator` persona instruct authors to **never write unbounded synchronous loops** and
to **insert `await` yield points** in long loops. Worker-based hard isolation is **out of scope for v1**
(it would break the `app`/`obsidian`/`utils`/`libs` main-thread parity) and is noted as future work.
Full detail: [contracts/orchestration-helper.md](contracts/orchestration-helper.md) (Known limitation).

- AC: a code step creates no conversation and consumes no tokens.
- AC: a code error fires `{step}.code_error` with the stack and shows an error Notice, while still
  logging `turn.start`/`turn.complete`.
- AC: the code-step timeout (default 300 s, honoring `notor-step-timeout-seconds`) abandons a step that
  exceeds it **at the next `await` boundary**; a step whose inner shell `timeoutSeconds` is below the
  step timeout runs to the shell command's completion.
- AC: the sync-loop non-interruptibility is documented (Known-limitation box + author/persona guidance);
  the AC above is explicitly scoped to `await`-yielding code.

**FR-131: OrchestrationHelper runtime API.** Code steps receive an `orchestration` helper:
`emit(topic, payload?, structured?)`, `once(key, fn)`, `scratchpad` (read/write/list/exists; **overwrite
only — no append**, FR-121), `callTool`, `callMcpTool`, `tasks` (list/ensure/start/close), `flow`
(name/iteration/sessionId), `eventHistory(limit?)`. Built on the existing extension `runtime-context/`.
Full API: [contracts/orchestration-helper.md](contracts/orchestration-helper.md). `emit`'s optional
third arg is the **only** producer of `RunResult.structured` (a terminal code step's typed return for
flow-as-tool, FR-173); `once(key, fn)` is the at-least-once side-effect guard (FR-125).
**`callTool`/`callMcpTool` thread the step's `runContext` (depth + shared aggregate-budget cell + parent
abort) and `orchestrationContext` onto `ToolExecuteOptions`** — so a code-step `run_flow` is depth/budget
gated and abort-cascaded by the **same** spawn rule as an LLM-step `run_flow` (the cascading guardrail,
FR-176, has no code-step hole).

- AC: `return orchestration.emit(...)` routes the next event deterministically.
- AC: a terminal `emit(topic, payload, structured)` populates `RunResult.structured` (lifted verbatim,
  no JSON round-trip); a non-terminal emit ignores `structured`.
- AC: `once(key, fn)` runs `fn` once, records `side_effect.committed`, and skips on a recovery re-run.
- AC: `callTool`/`callMcpTool` dispatch through registered built-in tools / connected MCP servers,
  threading the step's `runContext` + `orchestrationContext`.
- AC: a code-step `run_flow` (via `callTool`) is gated on `depth < maxDepth` AND the shared budget cell
  exactly as an LLM-step `run_flow`; a blocked spawn returns a clear tool error (no guardrail bypass).

**FR-132: `FLOW_CANCELLED` terminal event.** A terminal event (from code *or* conversation steps) that
ends the loop with status `cancelled` and **bypasses** completion task enforcement.

- AC: `FLOW_CANCELLED` terminates immediately with status `cancelled`.
- AC: open tasks do not block `FLOW_CANCELLED`.

### FR-140 group — Progress notices (design Phase 4)

**FR-140: Per-turn progress Notice.** After each step turn, a brief progress Notice surfaces what was
accomplished and what's next.

- AC: each turn synthesizes a Notice naming the flow, step, and iteration.
- AC (Issue-13c): the iteration shown is the **step-turn / hop counter** (`session.iteration` /
  `flow.iteration`, which **includes code steps**) — the Notice copy and the `session.json.iteration`
  field doc both note that this is **not** the same unit as `notor-max-iterations` (which counts **LLM
  turns only**), so an author watching the Notice climb toward `max-iterations` is not misled in a
  code-step-heavy flow.

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
`src/chat/workflow-executor.ts`). Because that loop runs off-`RunLoop` (no `RunContext`), the
workflow's spend is folded into the aggregate budget by **post-hoc reconciliation**: at the
await-result boundary the invoking step subtracts the workflow's total reported cost/iterations from
the shared `RunContext.budget` cell, so the flow's `notor-max-cost-usd` / `notor-max-iterations`
ceilings account for workflow-invocation spend (accurate after the call; the workflow's own per-run
cap bounds it during).

- AC: a step can invoke a workflow and receive its result.
- AC: the workflow's total cost/iterations are reconciled into the shared aggregate-budget cell at the
  await-result boundary (the ceiling sees workflow-invocation spend).

### FR-160 group — Built-in flows + orchestration-creator persona (design Phase 6)

**FR-160: `orchestration-creator` built-in persona.** A new built-in persona (mirroring `notor-help`
and `tool-creator`) that guides users through authoring flows: discussing the concept, creating the
flow directory + `definition.md` + step notes, suggesting/creating personas, and validating topology.
Includes code-step guidance, and explicitly carries: **overwrite-only scratchpad** + **`once()` for
non-idempotent effects** (FR-121/125); **never write unbounded synchronous loops** in a code step, and
**insert `await` yield points** in long loops (the timeout fires only at `await`, FR-130/Issue-7); wire
a verifier on a step's output edge where quality matters (FR-117a); and prefer **distinct topics per
outcome + a code-step router** over relying on the stale window (FR-117).

- AC: registered in `BUILTIN_PERSONA_PROFILES` alongside the existing built-ins.
- AC: write access scoped to `orchestrations/` and `personas/`.
- AC: the persona carries the overwrite-only, `once()`, no-unbounded-sync-loop / `await`-yield, and
  verifier-edge guidance.

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

**FR-172: `run_flow` tool (flow-as-invocable-tool; orchestration-context-only).** A single built-in
tool (feature-group-gated) with a dynamic `flow` enum of discovered invocable flows (each flow's
`notor-flow-inputs` surfaced in the description, mirroring `UseSubagentTool`) and a single loose
`payload` arg. **`run_flow` requires an active `orchestrationContext`** (mirroring `emit_event`): if
reached from a foreground-chat turn or any non-orchestration context, it returns `success: false`
("run_flow can only be called from within an orchestration flow"). This guarantees every child flow has
a replayable orchestration parent (or is a chaining-root), so the parent-rooted recovery model (FR-125)
has no chat-launched-orphan hole (Issue-4a). A flow is still launchable directly via the "Run
Orchestration" command (an `origin: "user"` root) and from a step via `run_flow` /
`orchestration.callTool`.

- AC: the `flow` enum reflects currently discovered invocable flows.
- AC: caller can pre-bind args statically, have the LLM fill them dynamically, or mix.
- AC: `run_flow` invoked without an `orchestrationContext` returns `success: false` and spawns no child.

**FR-173: Flow-as-tool execution + structured return.** `run_flow` runs the child flow to its terminal
event in a child session on a child `RunLoop`, then returns the child's result (prefer `structured`,
fall back to `text`). `structured` is populated **only** by a terminal code step passing a third arg
to `orchestration.emit(topic, payload?, structured?)`, lifted onto `RunResult.structured` verbatim
(FR-104/131); absent that, the result is the closing `text` from a final conversation step instructed
via `notor-flow-returns`.

- AC: the child flow runs on a child `RunLoop` to a terminal event.
- AC: the tool result prefers `structured` (when a terminal code step supplied it) and falls back to
  `text` otherwise.

**FR-174: Child sessions + isolation modes.** A `run_flow` child session records `parent_session_id`
and `origin: "run_flow"`, and is durably anchored by the parent turn's `child.spawned`/`child.result`
log entries. `notor-handoff-isolation` selects `isolated` (default; fresh scratchpad/tasks) or `shared`
(inherits parent scratchpad; the parent scratchpad path is auto-allowed in the child's path
enforcement). A `run_flow` child is recovered **by its parent's replay** (FR-125), never independently:
a **terminal** child is **reused** (from the recorded `child.result`), a **non-terminal** child is
**resumed in place** (it replays its own log) — **never tombstoned-and-respawned**, so its `once()`
side-effect markers survive (Issue-1/2).

- AC: `isolated` gives a fresh scratchpad; `shared` auto-allows the parent scratchpad path.
- AC: a child session links to its parent and is reconciled by the parent's replay — reuse a terminal
  child's recorded result, or resume a non-terminal child in place (not tombstone-and-respawn, not
  double-executed); its `once()` markers survive the crash.

**FR-175: Chaining / one-way handoff (+ gate + recovery contract).** At the terminal event, if
`notor-on-complete-flow` is set, the runner launches the successor instead of finalizing (no return).
The engine injects the successor's `notor-flow-inputs` into the predecessor's terminal step (default
prompt-injection; optional code-step adapter for non-trivial reshaping). The handoff is **gated exactly
like a `run_flow` spawn** — the successor's `RunContext` inherits **`depth + 1`** and the **same
`AggregateBudget` cell by reference**, so an `A → B → A` on-complete cycle is bounded by `max_depth` /
the shared budget (not a fresh root budget per hop); a **blocked** handoff **terminates the chain with
`FLOW_ERROR`** (it has no caller to return to). Because the predecessor **finalizes before** the
successor launches, a crashed successor has no live parent to replay, so it is **recovered as a root**
once its predecessor is terminal (FR-125, Issue-3). Full contract:
[contracts/tools.md](contracts/tools.md) "Chaining".

- AC: a chained successor launches with the forwarded, shaped payload, inheriting `depth + 1` + the
  shared budget cell; an `A↔B` on-complete cycle terminates at `max_depth` / the budget.
- AC: chaining does not return to the originator; a blocked handoff terminates the chain with `FLOW_ERROR`.
- AC: a chained successor whose predecessor has finalized is recovered as a root (not orphaned).

**FR-176: Cascading guardrails (soft ceiling).** Aggregate `max_iterations` / `max_cost_usd` (the
**shared `AggregateBudget` cell** on `RunContext`) and `max_depth` across the flow tree gate child
spawns; because the cell is shared by reference, every descendant turn draws down one tree-wide ceiling
(not a per-branch copy). A blocked spawn returns control (flow-as-tool) or terminates the chain
(chaining). The cost ceiling is a **soft** ceiling: it is overshootable by **up to one full turn's
spend per in-flight runner** because cost is decremented *after* a turn and the gate is `> 0`
(decrement-after / check-before) — this holds **even serially** (concurrency = 1), independent of the
separate concurrency check-then-act window. In v1 a flow tree runs one LLM turn at a time (`run_flow` is
a `write` tool serialized within a turn; single-threaded routing; recursive `run_flow` is a serial
chain), so effective in-flight concurrency against one cell ≈ 1 — there is **no `run_flow` concurrency
semaphore in v1** (none is needed; the run-loop axes table documents this, correcting the earlier
"concurrent run_flow" overshoot justification, Issue-13b).

- AC: a spawn is gated on `depth < maxDepth` AND the shared `budget` cell `> 0`.
- AC: a deep/wide subtree collectively respects one shared ceiling (decrements are visible tree-wide).
- AC: the cost ceiling is soft — the budget can go negative by up to one max-cost turn per in-flight
  runner (decrement-after/check-before), documented as the accepted worst case; in-flight runs finish
  their current turn when the ceiling is hit.

**FR-177: Shared `child_run_metadata`.** `ToolResult.sub_agent_metadata` is generalized into a shared
`child_run_metadata` block used by both `use_subagent` and `run_flow`, with one rendering path and one
token-rollup path. For flows it carries aggregate subtree numbers; for sub-agents, single-run totals.
The aggregate per-subtree numbers come from the child run's **`RunContext.subtreeConsumed`** accumulator
(each node accrues its own turns + folds in settled descendants), **not** from a delta of the shared
`AggregateBudget` cell — a shared-cell delta would absorb concurrent siblings' spend and misattribute it
(Issue-12). The shared cell remains the authority for the spawn gate and the **root-header** rollup
(where a single read is correct). The shape keeps the old `sub_agent_metadata` fields readable for
persisted conversations. Full schema: [contracts/edges.md](contracts/edges.md).

- AC: one rendering + one rollup path serves both tools.
- AC: already-persisted `sub_agent_metadata` still parses.
- AC: a child's per-subtree numbers are sourced from `subtreeConsumed` (its own subtree only), not a
  shared-cell delta — correct even if concurrent siblings are introduced.

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
- **RunContext / RunResult** — the run-loop substrate's cascade + result types; `RunContext.budget` is
  a shared `AggregateBudget` cell (tree-wide, by reference); `RunContext.subtreeConsumed` is a per-node
  accumulator (the authority for `child_run_metadata`'s per-subtree numbers).
- **OrchestrationToolContext** — per-step session carriage on `ToolExecuteOptions` (session id,
  scratchpad/tasks paths, `pendingEmission` capture slot); distinct from `ToolSessionContext`.
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
