# Contract: Orchestration Event Engine + Fallback Coordinator

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-112, FR-113, FR-117, FR-123)
**Data Model:** [../data-model.md](../data-model.md) (`OrchestrationEvent`, terminal-event constants)
**Tasks:** [../tasks.md](../tasks.md) — FEAT-003 (engine), FEAT-004 (fallback), FEAT-008 (safety guards); tested by TEST-002
**Sibling contracts:** [edges.md](edges.md) (conversation edges / `child_run_metadata`) · [run-loop.md](run-loop.md) (two-layer limit + RunLoop hooks) · [vault-schema.md](vault-schema.md) (`session-log.jsonl` write order)
**Status:** Draft

---

## Overview

The `OrchestrationEventEngine` is the routing core of a flow run: steps communicate **only** by
publishing named events, and the engine routes each event to the next step(s) by trigger
subscription. It owns four invariants:

1. **Write-before-route** — an event is durably appended to `session-log.jsonl` *before* any
   subscriber is delivered it, so crash recovery (FR-125) can always replay (see
   [vault-schema.md](vault-schema.md) for the enforced log write order).
2. **No silent stalls** — every topic has a subscriber. Topics with no step subscriber route to a
   mandatory `FallbackCoordinator` wildcard (`*`) subscriber that can never be overridden.
3. **Deterministic fan-out order** — when multiple steps trigger on one topic, they execute in
   `notor-steps` declaration order.
4. **Terminal discipline** — the loop ends only on the three terminal events
   (`FLOW_COMPLETE` / `FLOW_CANCELLED` / `FLOW_ERROR`), each emitted by a defined producer.

The engine is consumed by the `OrchestrationRunner` (FEAT-010) main loop and is fed safety signals
by `LoopSafetyGuards` (FEAT-008). It holds **no LLM knowledge** — step *execution* is the
`StepTurnExecutor`'s job (FEAT-007). This file is the single authority for routing rules, the
fallback contract, `default_publishes` synthesis, terminal-event ownership, the stale-loop /
thrashing detectors, and `required_events` enforcement.

The `OrchestrationEvent` shape is defined in [../data-model.md](../data-model.md); the terminal
constants (`FLOW_COMPLETE`, `FLOW_CANCELLED`, `FLOW_ERROR`) are defined there and referenced, not
redefined, here.

---

## `OrchestrationEventEngine` Method Surface

Module: `src/orchestration/event-engine.ts`.

```typescript
type Unsubscribe = () => void;

class OrchestrationEventEngine {
  /**
   * Register a step to receive events on a topic, or "*" for the catch-all wildcard.
   * Wildcard registration is reserved for the FallbackCoordinator (see below); a second
   * "*" subscribe() is rejected — the wildcard cannot be overridden.
   * Returns an Unsubscribe handle (used at flow teardown / reload).
   */
  subscribe(topic: string | "*", step: StepDefinition): Unsubscribe;

  /**
   * Publish an event. WRITE-BEFORE-ROUTE: appends the OrchestrationEvent to
   * session-log.jsonl (via the SessionLog writer, FEAT-006) BEFORE delivering it to any
   * subscriber. The append is the durable routing point — recovery replays from it.
   * Pushes the event onto the in-memory history (the rolling window the safety guards read).
   */
  publish(topic: string, payload: string, sessionLog: SessionLog): void;

  /**
   * Find every step whose notor-step-triggers includes `topic`, returned in notor-steps
   * declaration order. Empty array ⇒ orphaned topic ⇒ FallbackCoordinator (see Routing).
   * Does NOT return the wildcard subscriber (the engine consults the wildcard only on empty).
   */
  getSubscribers(topic: string): StepDefinition[];

  /** The full ordered event history for the current session (newest last). */
  getEventHistory(): OrchestrationEvent[];
}
```

### `OrchestrationEvent` construction in `publish()`

`publish(topic, payload, sessionLog)` constructs the `OrchestrationEvent`
([../data-model.md](../data-model.md)) by stamping `source_step` (the currently-executing step
name, or `null` for the starting event), the current `turn`, and an ISO `ts`. The constructed event
is what is appended to the log and pushed to history — `getEventHistory()` and the safety detectors
operate on these full objects, not bare `(topic, payload)` pairs.

> **Why write-before-route and not after?** If the engine routed first and crashed before the
> append, recovery would have no record the event ever fired and the flow would stall. Appending
> first means a crash mid-route leaves a dangling `event.emitted` with no following `turn.start`,
> which FR-125 recovery re-publishes idempotently.

---

## Event Routing Rules

The runner calls `publish()` with a captured topic; routing then proceeds:

1. **Append, then resolve.** After the write-before-route append, the engine calls
   `getSubscribers(topic)`.
2. **One-or-more subscribers ⇒ deliver in order.** Steps that subscribe to `topic` (their
   `notor-step-triggers` contains it) are handed to the runner for execution in **`notor-steps`
   declaration order** (FR-112). Multiple subscribers on one topic execute sequentially, never
   concurrently — the engine itself spawns no parallelism.
3. **Zero subscribers ⇒ FallbackCoordinator.** An orphaned topic (no step triggers on it, and it is
   not a terminal constant) is delivered to the wildcard `*` subscriber — the `FallbackCoordinator`.
   An orphaned event **never silently stalls** the loop (FR-113 AC).
4. **Terminal topics short-circuit.** `FLOW_COMPLETE` / `FLOW_CANCELLED` / `FLOW_ERROR` are not
   routed to steps; they are intercepted by the runner as loop-terminating signals (subject to the
   completion checks below). They are still appended to the log first.

### Trigger-uniqueness load invariant (FR-111)

Within one flow, each trigger topic maps to **at most one step**. Ambiguous routing (two steps both
triggering on the same non-fan-out topic where the author did not intend ordered fan-out) is a
load-time concern of the `StepNoteParser` (FEAT-002), not a runtime concern of the engine: by the
time the engine routes, the subscriber set for a topic is already validated. The engine's ordered
fan-out (rule 2) handles the *intended* multi-subscriber case deterministically.

---

## Wildcard Subscription + `FallbackCoordinator` Contract

Module: `src/orchestration/fallback-coordinator.ts` (FEAT-004).

The `FallbackCoordinator` is the **mandatory** `*` subscriber. The runner registers it during
flow start (before the starting event is published) and it has three non-negotiable properties:

- **Always registered** — every run has exactly one; the engine refuses to route an orphaned event
  if none is present (a programming error, surfaced as `FLOW_ERROR`).
- **Cannot be overridden** — `subscribe("*", …)` from any source other than the coordinator
  registration is rejected. There is exactly one wildcard.
- **Lowest priority** — it receives an event **only** when `getSubscribers(topic)` is empty. A step
  that legitimately handles the topic always wins.

### Steer-or-`FLOW_ERROR` behavior

When the coordinator receives an orphaned event:

```typescript
class FallbackCoordinator {
  /**
   * Invoked by the runner when an event has no step subscriber.
   * Returns the corrected event to re-publish (steer) or null to terminate.
   */
  handle(event: OrchestrationEvent, flow: OrchestrationFlow): OrchestrationEvent | null;
}
```

1. **Log a warning** naming the unmatched `topic` and `payload` (so the orphan is diagnosable).
2. **Attempt to steer.** If the payload/topic plausibly indicates a known topic was intended (e.g.
   a near-miss of a declared trigger), re-publish with the corrected topic. Steering re-enters
   `publish()` — and is therefore itself subject to write-before-route and to stale-loop detection,
   so a coordinator that keeps re-emitting the same orphan is caught by the stale guard rather than
   looping forever.
3. **Terminate if unrecoverable.** If no known topic can be reached, the coordinator emits
   **`FLOW_ERROR`** with the orphan as context. `FLOW_ERROR` ends the loop with session status
   `error`.

`FLOW_ERROR` is the coordinator's terminal verdict; it is **the only producer of `FLOW_ERROR`**
(see Terminal Events below).

---

## `default_publishes` Synthesis

A conversation step is required to call the `emit_event` tool (FR-116); the must-publish rule is
**always** injected by the `StepPromptBuilder` (FR-114). But LLMs occasionally end a turn without
emitting. To guarantee the loop never stalls on a silent step:

- The `StepTurnExecutor` (FEAT-007) captures the emitted `{topic, payload}` from the session context
  **after** the turn completes (no mid-turn routing — see [run-loop.md](run-loop.md) on hook
  ordering and the `emit_event` capture seam).
- **If no `emit_event` was captured**, the executor synthesizes the step's
  `notor-step-default-publishes` topic (`StepDefinition.defaultPublishes`,
  [../data-model.md](../data-model.md)) with a synthesized payload (the turn's final text /
  wind-down summary), and the runner publishes *that*.
- **Narrative text alone never counts** as an emission (FR-116 AC). Only a captured `emit_event`
  call, or the synthesized default, advances the loop.
- A step with `defaultPublishes === null` that emits nothing is an orphan-by-construction: the
  runner publishes a `{step}.no_emit` event, which (having no subscriber) routes to the
  `FallbackCoordinator` for steering or `FLOW_ERROR`. **No-emit never silently halts.**

Code steps (`notor-step-mode: code`) have the symmetric rule via their return value: a code step
that returns no `orchestration.emit(...)` result falls back to `default_publishes` the same way; a
thrown error fires `{step}.code_error` (see [orchestration-helper.md](orchestration-helper.md)).

---

## Terminal Events — Producers and Semantics

The three terminal constants are defined in [../data-model.md](../data-model.md). Each has exactly
one class of producer and a distinct finalization path:

| Terminal event | Emitted by | Session status | Task enforcement | Notes |
|---|---|---|---|---|
| `FLOW_COMPLETE` | Any conversation step (`emit_event`) or code step (`orchestration.emit`) that judges the whole flow done | `completed` | **Enforced** (FR-123) — open/running tasks reject it | Writes `session.complete` after the open-task check passes |
| `FLOW_CANCELLED` | Any conversation **or** code step (FR-132) | `cancelled` | **Bypassed** (FR-132) — open tasks are acceptable | Writes `session.cancelled` with the payload as the reason; terminates immediately |
| `FLOW_ERROR` | **Only** the `FallbackCoordinator`, on an unrecoverable orphan | `error` | n/a — error path | Carries the orphaned event as context |

- The configured completion event is `notor-completion-event` (default `FLOW_COMPLETE`,
  [../data-model.md](../data-model.md) `OrchestrationFlow.completionEvent`). A flow may rename it,
  but the enforcement semantics attach to the *completion* role, not the literal string.
- `FLOW_CANCELLED` deliberately **bypasses** completion task enforcement so a code step's pre-flight
  "nothing to do" can abort cleanly with open tasks (the sequencing rule: INT-003 enforcement lands
  before INT-012 cancellation, so cancellation can opt out — [../tasks.md](../tasks.md) risk #8).

---

## `required_events` Enforcement at Completion (FR-123)

When the completion event (`FLOW_COMPLETE`) is published, the runner gates finalization on **two**
checks, both owned at the engine/runner boundary, before any `session.complete` is written:

### 1. Required-events gate

Every topic in `OrchestrationFlow.requiredEvents` (`notor-required-events`,
[../data-model.md](../data-model.md)) must appear in `getEventHistory()`. If a required event was
never seen:

- `FLOW_COMPLETE` is **rejected** (not written as terminal).
- The engine instead publishes `flow.requirements_unmet` (subscribed by the completing step, or
  steered by the fallback), with the list of missing required events as payload, re-triggering work.

### 2. Open-task gate

If any task note has `notor-task-status: open` or `running` ([../data-model.md](../data-model.md)
task note schema):

- `FLOW_COMPLETE` is **rejected**.
- The engine publishes `flow.tasks_remaining` instead, re-triggering with the remaining-task
  context (FR-123 AC).

Only when **both** gates pass does the runner write `session.complete` and end the loop with status
`completed`. `FLOW_CANCELLED` skips both gates (FR-132).

---

## Loop Safety Guards (FEAT-008)

Module: `src/orchestration/safety.ts`. The guards consume `getEventHistory()` and the task registry;
the engine surfaces the signals, the runner acts on them (terminating the flow). Full safety table
and the two-layer per-run-vs-aggregate budget model live in the design's *Safety Mechanisms* section
and in [run-loop.md](run-loop.md) (the per-run iteration cap and the tree-wide aggregate budget are
the run-loop's authority, not this contract's).

### Stale-loop detection

Track a **rolling window of the last 5 events**. The loop is stale when the **3 most recent** events
share the same `(topic, source_step, payload_hash)` triple:

```typescript
function isStale(history: OrchestrationEvent[]): boolean {
  if (history.length < 3) return false;
  const last3 = history.slice(-3);
  const sig = (e: OrchestrationEvent) =>
    `${e.topic}:${e.source_step}:${hash(e.payload)}`;
  return last3.every((e) => sig(e) === sig(last3[0]));
}
```

- The window holds 5 for context/diagnostics; the trigger is **3 consecutive identical triples**.
- `payload_hash` is a content hash of `payload` so byte-identical re-emissions are detected even
  when the payload is large.
- A stale verdict terminates the flow (status `error`); this also catches a `FallbackCoordinator`
  stuck re-steering the same orphan (its re-publishes flow through history).

### Thrashing detection

Track per-task **abandonment counts**. A task is "abandoned" when it is started (`_start`) and then
re-queued without being closed. When a step re-queues a task key (e.g. re-emits `tasks.ready` for it)
that has been abandoned **3 or more times**, the loop is thrashing and the flow terminates (status
`error`). This is distinct from stale-loop (which keys on event triples) — thrashing keys on the
task lifecycle in the runtime task registry (FR-122).

### Other guards (reference)

`iteration_cap` (per-run, default 20 — unchanged), aggregate `max_iterations` / `max_cost_usd` /
`max_depth` (tree-wide ceilings on `RunContext`), and `max_runtime` (wall-clock) are all enforced
per the two-layer model in [run-loop.md](run-loop.md). A turn proceeds iff both the per-run cap and
the aggregate budget have headroom; the engine's stale/thrashing guards are the *orchestration-level*
overlay on top of those substrate caps.

---

## Sequencing & Test Notes

- **FEAT-003 → FEAT-004 → FEAT-008** is the build order: the engine first (pub/sub + write-before-
  route), then the mandatory fallback, then the safety overlay ([../tasks.md](../tasks.md)).
  FEAT-008 depends on the engine because both detectors read `getEventHistory()`.
- **TEST-002** is the gate ([../tasks.md](../tasks.md) per-phase Phase-1 gate): unit tests for
  routing/fan-out order, orphan → fallback, steer-vs-`FLOW_ERROR`, `default_publishes` synthesis,
  the `isStale` triple-window, thrashing counts, and the two completion gates.
- **Write-before-route is observable in tests** by asserting the `session-log.jsonl` `event.emitted`
  append happens before any subscriber callback fires.
