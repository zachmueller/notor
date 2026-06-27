# Task Bodies: Phase 1 — Core Engine + Flow Schema

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md)
**Data Model:** [../data-model.md](../data-model.md)
**Master Task Index:** [../tasks.md](../tasks.md)
**Contracts:** [../contracts/](../contracts/)
**Status:** Draft

This file holds the full task **bodies** for design Phase 1 (repo phase: **Core**) — task IDs
**FEAT-001…011** plus the Phase-1 quality gates **TEST-002** and **TEST-003**. The phase→task mapping,
dependency edges, critical path, parallelism groups, and the per-phase test gate are owned by
[../tasks.md](../tasks.md); the IDs and dependency edges below reproduce that index and must stay
consistent with it.

**Design references:** the canonical design doc sections *Event Engine*, *Step Turn Execution*,
*Prompt Construction*, *Tools (Built-in Scaffolds)*, *Implementation Phases → Phase 1*. (The canonical
design doc lives in the Obsidian vault; the spec/data-model in this package are the authoritative
restatement.)

**Goal of the phase:** run a hand-authored flow end-to-end with correct event routing and loop
termination. Every component here is gated behind `orchestration_enabled` (Phase 0, ENV-001/002) and
builds on the `RunLoop` substrate (Phase 0, ARCH-001…006). No new prompt seam is invented:
`StepTurnExecutor` runs each conversation step turn on the shared **`RunLoop`** (NOT
`ChatOrchestrator.responseLoop()`), and step personas are resolved with
`PersonaManager.getPersonaByName()` (`src/personas/persona-manager.ts:106`) **without** mutating
global state (no `activatePersona()`).

**Module:** all new code lands under `src/orchestration/` except the gated tool scaffold
(`src/extensions/builtin-tool-scaffolds/emit-event.ts`) and the command registration (`src/main.ts`).

---

## Dependency Recap (from master index)

`→` = depends on. Reproduced verbatim from [../tasks.md](../tasks.md); do not diverge.

| ID | One-liner | Depends on |
|---|---|---|
| FEAT-001 | Orchestration domain types | ENV-001, ARCH-001 |
| FEAT-002 | `FlowDefinitionParser` + `StepNoteParser` | FEAT-001 |
| FEAT-006 | `SessionLog` writer | FEAT-001 |
| FEAT-003 | `OrchestrationEventEngine` | FEAT-001, FEAT-006 |
| FEAT-004 | `FallbackCoordinator` | FEAT-003 |
| FEAT-005 | `StepPromptBuilder` | FEAT-001 |
| FEAT-009 | `emit_event` built-in tool scaffold (gated) | ENV-002, FEAT-001 |
| FEAT-007 | `StepTurnExecutor` | ARCH-002, ARCH-005, FEAT-002, FEAT-005, FEAT-006, FEAT-009 |
| FEAT-008 | `LoopSafetyGuards` | FEAT-001, FEAT-003 |
| FEAT-010 | `OrchestrationRunner` main loop | FEAT-002, FEAT-003, FEAT-004, FEAT-007, FEAT-008 |
| FEAT-011 | Command palette "Run Orchestration" + flow picker | FEAT-010, ENV-002 |
| TEST-002 | Event-engine / fallback / safety unit tests | FEAT-003/004/008 |
| TEST-003 | Flow/step parser unit tests | FEAT-002 |

**Parallelism (after FEAT-001):** FEAT-002 (parsers), FEAT-005 (prompt builder), FEAT-006 (session
log), FEAT-008 (safety) are independent tracks. FEAT-009 (scaffold) only needs ENV-002 + FEAT-001.
FEAT-007 is the convergence point (six edges); FEAT-010 funnels all integration lanes downstream.

---

## FEAT-001: Orchestration domain types

**Description:** Implement the orchestration domain types in `src/orchestration/types.ts` exactly as
defined in [../data-model.md](../data-model.md) (*Orchestration Domain Types*). These types are
imported by every other Phase-1 module, so they land first. Includes `OrchestrationFlow`,
`StepDefinition`, `OrchestrationEvent`, the terminal-event string constants, and the `CodeStep*` arg
constant. The composition fields on `OrchestrationFlow` (Phase 7) are declared now so the parser
(FEAT-002) and runner (FEAT-010) share one shape, but they are inert until the feature group is
enabled and unused before Phase 7. Do **not** redefine the run-loop types (`RunContext`/`RunResult`)
here — those are owned by ARCH-001 in `src/run-loop/types.ts` ([../contracts/run-loop.md](../contracts/run-loop.md)),
and orchestration imports them.

**FRs:** FR-110, FR-111 (the shapes that back the flow/step schema); FR-132 (terminal-event constants).

**Files:**
- `src/orchestration/types.ts` — `OrchestrationFlow`, `StepDefinition`, `OrchestrationEvent`;
  constants `FLOW_COMPLETE`, `FLOW_CANCELLED`, `FLOW_ERROR`; `CODE_STEP_ARG_NAMES = ["app",
  "obsidian", "utils", "libs", "event", "orchestration"] as const` (consumed in Phase 3 INT-010, but
  declared here as the single source).
- `src/orchestration/index.ts` — module barrel re-exporting the types (skeleton from ENV-001).

**Dependencies:** ENV-001 (module scaffold + `orchestration_enabled` setting), ARCH-001 (`RunContext`/
`RunResult`/`RunLoopOptions`/`RunLoopHooks` types — imported, not redefined).

**Acceptance Criteria:**
- [ ] `OrchestrationFlow` matches [../data-model.md](../data-model.md) field-for-field: `name`,
  `description`, `flowDir`, `startingEvent`, `completionEvent`, `maxIterations`, `maxRuntimeMinutes`,
  `requiredEvents`, `steps: StepDefinition[]`, `guardrails`, plus the inert composition fields
  (`invocable`, `flowInputs`, `flowReturns`, `onCompleteFlow`, `handoffIsolation`, `maxDepth`,
  `maxCostUsd`).
- [ ] `StepDefinition` matches the data model: `name`, `description`, `triggers`, `publishes`,
  `defaultPublishes`, `persona`, `model`, `mode: "conversation" | "code"`, `mcpServers`, `bodyContent`,
  `notePath`.
- [ ] `OrchestrationEvent` is `{ topic, payload, source_step: string | null, turn: number, ts: string }`.
- [ ] `FLOW_COMPLETE`/`FLOW_CANCELLED`/`FLOW_ERROR` exported as `const` string literals matching the
  data model.
- [ ] `RunContext`/`RunResult` are **imported** from `src/run-loop/types.ts`, never redeclared in
  `src/orchestration/`.
- [ ] `npm run build` succeeds with no type errors; no runtime behavior added.

---

## FEAT-002: `FlowDefinitionParser` + `StepNoteParser`

**Description:** Implement the two parsers that turn vault notes into `OrchestrationFlow` /
`StepDefinition`. **Mirror the existing workflow discovery/parse machinery** rather than inventing new
plumbing: `discoverWorkflows(vault, metadataCache, notorDir)` (`src/workflows/workflow-discovery.ts:73`,
scans `{notor_dir}/workflows/`) is the template for scanning `{notor_dir}/orchestrations/*/definition.md`,
and `injectWorkflowFrontmatter` / `workflow-frontmatter.ts:15` is the template for frontmatter
read/parse. `FlowDefinitionParser` reads a flow directory's `definition.md` (frontmatter discriminator
`notor-type: orchestration-flow`), resolves the `notor-steps` wikilinks against `{flow-dir}/steps/`,
and parses each via `StepNoteParser` (discriminator `notor-type: orchestration-step`). The note **body**
of `definition.md` is documentation only and is never read into any prompt; step bodies become
`StepDefinition.bodyContent` and may carry `<include_note>` tags (resolved later by the prompt builder,
not here). Build a trigger→step index and **reject at load** any topic that maps to more than one step
in the same flow (ambiguous routing), with a clear error.

**FRs:** FR-110 (flow definition discovery + body-is-docs-only), FR-111 (step note parse,
at-most-one-step-per-trigger, `<include_note>` allowed in bodies). Composition frontmatter
(`notor-flow-invocable` etc.) parses into the inert fields but is otherwise untouched here (the Phase-7
extension is INT-040).

**Files:**
- `src/orchestration/flow-parser.ts` — `FlowDefinitionParser` (discovery + `definition.md` parse +
  step resolution + trigger-uniqueness validation) and `StepNoteParser` (step frontmatter + body).
  Mirrors `src/workflows/workflow-discovery.ts:73` and `src/workflows/workflow-frontmatter.ts:15`.

**Dependencies:** FEAT-001 (domain types).

**Acceptance Criteria:**
- [ ] Flows are discovered by scanning `{notor_dir}/orchestrations/` for child directories containing a
  `definition.md` with `notor-type: orchestration-flow` (directories without it — e.g. `sessions/`,
  `memories.md` — are skipped).
- [ ] `FlowDefinitionParser` populates every `OrchestrationFlow` field from frontmatter; absent
  optional fields take documented defaults (`completionEvent` → `FLOW_COMPLETE`, `handoffIsolation` →
  `"isolated"`, `invocable` → `false`).
- [ ] `notor-steps` wikilinks resolve to step notes under `{flow-dir}/steps/`; an unresolved wikilink
  raises a clear load error naming the missing step.
- [ ] `StepNoteParser` parses all `StepDefinition` fields; `notor-step-mode` defaults to
  `"conversation"`; the Markdown body (excluding frontmatter) becomes `bodyContent`.
- [ ] The `definition.md` body is never returned as prompt content (only frontmatter drives behavior).
- [ ] A topic appearing in `notor-step-triggers` of two steps in the same flow is rejected at load with
  an error naming the topic and both steps. (Multiple steps in `notor-steps` order on one topic is a
  *runner* concern — FR-112; at-most-one is the load-time invariant per FR-111.)
- [ ] `<include_note>` tags in a step body are preserved verbatim in `bodyContent` (resolution is the
  prompt builder's job, not the parser's).
- [ ] Covered by TEST-003.

---

## FEAT-006: `SessionLog` writer (append-only JSONL + write order)

**Description:** Implement the append-only `session-log.jsonl` writer — the crash-recovery source of
truth. `SessionLog` exposes append methods for each entry type (`session.start`, `turn.start`,
`turn.complete`, `event.emitted`, `session.cancelled`, `session.complete`, and the later
`user.input.required`/`user.input.received`) and enforces the **write order** documented in
[../contracts/vault-schema.md](../contracts/vault-schema.md): for each turn, `turn.start` is written
**before** the LLM call (or code execution) begins, `turn.complete` after the emit is captured, and
`event.emitted` **before** the event is routed (write-before-route). Writes are append-only and
durable; the writer never rewrites or truncates the file. This task is the writer surface only — the
session **directory** lifecycle (`session.json`, `scratchpad/`, `tasks/`) is Phase 2 (INT-001), and
recovery replay is INT-005; FEAT-006 only guarantees the log is written in the recoverable order.

**FRs:** FR-112 (the write-before-route guarantee that the event engine depends on); FR-118 (the
runner's session lifecycle log entries). Underpins FR-125 recovery (Phase 2) by construction.

**Files:**
- `src/orchestration/session-log.ts` — `SessionLog` class: constructor takes the session-log file path;
  `appendSessionStart`, `appendTurnStart`, `appendTurnComplete`, `appendEventEmitted`,
  `appendSessionCancelled`, `appendSessionComplete`, and forward-declared `appendUserInputRequired`/
  `appendUserInputReceived` (Phase 5 INT-030 fills behavior). Each entry shape per
  [../data-model.md](../data-model.md) / [../contracts/vault-schema.md](../contracts/vault-schema.md).

**Dependencies:** FEAT-001 (`OrchestrationEvent` and entry shapes).

**Acceptance Criteria:**
- [ ] Every append writes exactly one newline-terminated JSON object; the file is opened append-only and
  never truncated or rewritten.
- [ ] Each entry carries `type`, `ts` (ISO), and `turn` where applicable, matching the entry-type union
  in [../data-model.md](../data-model.md).
- [ ] `appendEventEmitted` is the write-before-route hook: the event engine (FEAT-003) calls it
  **before** delivering to any subscriber.
- [ ] `appendTurnStart` is callable before any LLM/code execution; `appendTurnComplete` records the
  captured emitted topic.
- [ ] Concurrent appends from one runner are serialized (no interleaved partial lines).
- [ ] Unit-covered as part of TEST-002's write-order assertions (engine writes before routes).

---

## FEAT-003: `OrchestrationEventEngine` (pub/sub + wildcard, write-before-route)

**Description:** Implement the pub/sub event engine per the canonical design doc *Event Engine* and
FR-112. `subscribe(topic | "*", step)` registers a step for a topic; `publish(topic, payload,
sessionLog)` **appends to `session-log.jsonl` first** (via FEAT-006), then routes to subscribers;
`getSubscribers(topic)` returns matching steps; `getEventHistory()` returns the in-session
`OrchestrationEvent[]`. Routing rules: a topic with one or more concrete subscribers routes to them in
`notor-steps` order; a topic with **no** concrete subscriber routes to the `*` subscriber (the
`FallbackCoordinator`, FEAT-004), so an orphaned event never silently stalls the loop. The engine does
**not** execute steps — it identifies *which* step(s) should run and records history; the
`OrchestrationRunner` (FEAT-010) drives execution. Event routing happens **after** a turn completes
(the `emit_event` capture is read post-turn, FR-116) — the engine performs no mid-turn routing.

**FRs:** FR-112 (pub/sub + wildcard + write-before-route + `notor-steps` ordering), FR-113 (orphan →
fallback handoff, by routing contract).

**Files:**
- `src/orchestration/event-engine.ts` — `OrchestrationEventEngine` class (`subscribe`, `publish`,
  `getSubscribers`, `getEventHistory`); maintains the subscriber map (concrete topics + the single `*`
  slot) and the in-session event history list.

**Dependencies:** FEAT-001 (types), FEAT-006 (`SessionLog` for write-before-route).

**Acceptance Criteria:**
- [ ] `publish()` appends an `event.emitted` entry to the session log **before** routing to any
  subscriber (assert ordering against a fake log in TEST-002).
- [ ] `getSubscribers(topic)` returns concrete subscribers in `notor-steps` order; multiple steps on one
  topic are returned in that order.
- [ ] A topic with no concrete subscriber routes to the `*` subscriber; `getSubscribers` for such a
  topic surfaces the fallback (or the runner consults the fallback when concrete subscribers are empty).
- [ ] `getEventHistory()` returns events in publish order with `topic`, `payload`, `source_step`,
  `turn`, `ts`.
- [ ] The engine performs no step execution and no mid-turn routing (routing is invoked by the runner
  after `turn.complete`).
- [ ] Covered by TEST-002.

---

## FEAT-004: `FallbackCoordinator` (`*` subscriber, steer-or-`FLOW_ERROR`)

**Description:** Implement the mandatory `*` wildcard subscriber per FR-113 and the canonical design doc
*FallbackCoordinator*. It is **always registered** by the runner and **cannot be overridden** by a
flow's step subscriptions (a concrete subscriber for a topic always wins; the fallback only receives
genuinely orphaned events). On an orphaned event it: (1) logs a warning with the unmatched topic +
payload; (2) attempts to **steer** — if the payload/topic suggests a known topic was intended (e.g. a
near-miss of a registered trigger), re-publish with the corrected topic; (3) if unrecoverable,
terminate the flow by publishing the terminal `FLOW_ERROR` event. The coordinator never silently drops
an event — every orphan results in either a steer or a `FLOW_ERROR`.

**FRs:** FR-113 (always-registered, cannot-be-overridden, steer-or-error, no silent stall).

**Files:**
- `src/orchestration/fallback-coordinator.ts` — `FallbackCoordinator`: `handleOrphan(event, flow,
  engine)` → steers (re-publish corrected topic) or returns/publishes `FLOW_ERROR`. Registered by the
  runner against the engine's `*` slot.

**Dependencies:** FEAT-003 (event engine — the `*` subscription point and `publish` for steer/error).

**Acceptance Criteria:**
- [ ] The runner registers the coordinator on `*` and a flow cannot replace it (concrete subscribers
  shadow it only for their own topics).
- [ ] An orphaned event with a plausible near-miss to a registered trigger is steered (re-published with
  the corrected topic) exactly once.
- [ ] An unrecoverable orphan publishes `FLOW_ERROR` (terminal), terminating the loop with status
  `error`.
- [ ] No orphaned event is silently dropped — every orphan yields a steer or a `FLOW_ERROR`.
- [ ] A steer that itself goes orphaned does not loop infinitely (a steered event that re-orphans
  escalates to `FLOW_ERROR`).
- [ ] Covered by TEST-002.

---

## FEAT-005: `StepPromptBuilder` (scaffold + always-inject must-publish)

**Description:** Implement `StepPromptBuilder` per the canonical design doc *Prompt Construction* and
FR-114. The step's raw `bodyContent` is **never** passed to the LLM unwrapped; it is embedded in the
`### 1. EXECUTE` section of a structural scaffold (orientation → execute → verify → report →
guardrails). The builder **always** injects, regardless of the step's custom instructions:
- the **must-publish rule** (section *3. REPORT*: "You MUST call `emit_event` with one of
  `{step.publishes}`; narrative summaries do NOT count; emit before ending your turn; emit
  `FLOW_COMPLETE` if all flow work is done");
- the **objective** (original user prompt, set once at flow start, injected every turn);
- the **incoming event** (topic + payload);
- the **recent event history** (last N, e.g. 10);
- the **scratchpad path** (and tasks path) for cross-step state.
Flow `guardrails` from `definition.md` are injected into the `### GUARDRAILS` section of **every** step
turn. Persona content integrates through the **existing** `SystemPromptBuilder` append/replace
mechanism (per the persona's `notor-persona-prompt-mode`) — the step scaffold is appended after persona
content; this task does not reimplement system-prompt assembly. `<include_note>` tags in `bodyContent`
are resolved here (reusing the existing include-resolution path) before embedding.

**FRs:** FR-114 (scaffold + always-inject must-publish + objective + event + history + scratchpad +
per-turn guardrails + persona append/replace integration).

**Files:**
- `src/orchestration/step-prompt-builder.ts` — `StepPromptBuilder.build({ step, flow, event,
  eventHistory, objective, scratchpadPath, tasksPath, iteration })` → the assembled prompt (scaffold +
  embedded body + injected sections). Integrates with the existing `SystemPromptBuilder` append/replace
  path for persona content.

**Dependencies:** FEAT-001 (types).

**Acceptance Criteria:**
- [ ] The must-publish rule is present in the output **even when** the step body contains its own
  custom instructions (asserted directly — this is the Phase-1 gate in [../tasks.md](../tasks.md)).
- [ ] The objective, incoming event (topic + payload), recent event history, and scratchpad/tasks paths
  are present in every assembled prompt.
- [ ] Flow `guardrails` from `definition.md` appear in the `### GUARDRAILS` section of every step turn.
- [ ] The raw step body is embedded only inside `### 1. EXECUTE`, never emitted standalone.
- [ ] Persona content is composed via the existing `SystemPromptBuilder` append/replace mechanism (the
  builder does not duplicate that logic); the step scaffold follows persona content.
- [ ] `<include_note>` tags in `bodyContent` are expanded before embedding.
- [ ] Unit test asserts must-publish injection across both empty-body and custom-body steps (gate).

---

## FEAT-009: `emit_event` built-in tool scaffold (gated)

**Description:** Implement the `emit_event` built-in tool scaffold per the canonical design doc
*Tools → `emit_event`* and FR-116. **Mirror the existing built-in tool scaffolds** — use the scaffold
helper `_scaffold-helper.ts` (`featureGroup?` param at `src/extensions/builtin-tool-scaffolds/_scaffold-helper.ts:9`)
exactly as `capture-memory.ts` / `execute-command.ts` do, and set
**`featureGroup: "orchestration"`** so the `ExtensionManager` only compiles/registers it when
`orchestration_enabled` is true (gating wired in ENV-002 via `FEATURE_GROUP_TOGGLES`). The tool takes
`{ topic: string, payload: string }`, **captures** them onto the session context, and returns a
confirmation — it does **not** publish. The engine reads the captured `{topic, payload}` from the
session **after** the turn completes and routes then (no mid-turn routing). Narrative text alone never
counts as an emission. Mode is **`write`** (Act mode only). The capture surface on the session context
is the contract between this scaffold and `StepTurnExecutor` (FEAT-007); both read/write it.

**FRs:** FR-116 (capture-not-publish, post-turn routing, appears only when enabled, write mode,
narrative ≠ emission), FR-119 (scaffold absent when disabled).

**Files:**
- `src/extensions/builtin-tool-scaffolds/emit-event.ts` — `emit_event` scaffold built with the
  `_scaffold-helper.ts` builder; `featureGroup: "orchestration"`, mode `write`; params `{ topic,
  payload }`; execute captures onto the session context (the slot `StepTurnExecutor` reads post-turn)
  and returns a confirmation string.

**Dependencies:** ENV-002 (feature-group registration so the gate works), FEAT-001 (terminal-event
constants / topic vocabulary referenced in the description).

**Acceptance Criteria:**
- [ ] The scaffold sets `featureGroup: "orchestration"` and is registered only when
  `orchestration_enabled` is true (absent otherwise — verified via the gated reload path).
- [ ] `execute({topic, payload})` stores the pair on the session context and returns a confirmation; it
  performs **no** publish/routing.
- [ ] Mode is `write` (unavailable in non-Act mode).
- [ ] The capture slot is the documented contract consumed by `StepTurnExecutor` (FEAT-007) after the
  turn completes; emitting `FLOW_COMPLETE`/`FLOW_CANCELLED` via this tool is captured identically.
- [ ] Built via `_scaffold-helper.ts` (same construction as `capture-memory.ts`), not a bespoke tool
  class.

---

## FEAT-007: `StepTurnExecutor` (conversation path on `RunLoop`, persona wiring)

**Description:** Implement `StepTurnExecutor` per the canonical design doc *Step Turn Execution* and
FR-115 — the component that runs one conversation step turn. It runs on the shared **`RunLoop`**
(`src/run-loop/`, ARCH-002), **not** `ChatOrchestrator.responseLoop()` (which carries
persistence/compaction/view rendering Notor's orchestration does not want) and not a hand-rolled loop.
Per turn it: (1) writes `turn.start` to the session log (FEAT-006) **before** any LLM call; (2) resolves
the step's persona via `PersonaManager.getPersonaByName()` (`src/personas/persona-manager.ts:106`)
**without** mutating global state — never `activatePersona()`; the resolved persona supplies system
prompt (append/replace), `<notor_tool_config>` tool access/path enforcement, and provider/model (with
`notor-step-model` overriding the persona model); (3) creates an isolated `ConversationSession` (new
conversation id + JSONL file) seeded with the resolved persona/provider/model; (4) asks
`StepPromptBuilder` (FEAT-005) to assemble the prompt; (5) runs the turn on `RunLoop`, attaching the
JSONL-persistence `onPersist` hook (and progress hook) from `RunLoopHooks` so persistence stays out of
the engine; (6) after the turn, reads the captured `{topic, payload}` from the session context (written
by the `emit_event` scaffold, FEAT-009); (7) if no emission was captured, **synthesizes** the step's
`default_publishes` topic; (8) writes `turn.complete`; (9) returns the captured/synthesized event for
the runner to route. The `RunLoop` is seeded with the step's `RunContext` (depth/budget) supplied by
the runner; aggregate per-turn cost wiring uses ARCH-005's `budget.ts` (via `calculateCost`). The
**code-step** path (`notor-step-mode: code`) is dispatched to the `CodeStepExecutor` in Phase 3
(INT-010); FEAT-007 handles the conversation path and leaves a dispatch seam for it.

**FRs:** FR-115 (RunLoop execution, `getPersonaByName` no-global-mutation, per-turn `default_publishes`
synthesis on no-emit). Relies on FR-116's capture contract (FEAT-009).

**Files:**
- `src/orchestration/step-turn-executor.ts` — `StepTurnExecutor.execute(step, event, session)`:
  log `turn.start` → resolve persona (`getPersonaByName`, no global mutation) → create
  `ConversationSession` → build prompt (FEAT-005) → run on `RunLoop` (ARCH-002) with `onPersist`/
  progress hooks → capture emit / synthesize `default_publishes` → log `turn.complete` → return the
  event. Holds the dispatch seam for the Phase-3 code path.

**Dependencies:** ARCH-002 (`RunLoop` engine), ARCH-005 (two-layer budget helpers + per-turn cost via
`calculateCost`), FEAT-002 (`StepDefinition` from parser), FEAT-005 (`StepPromptBuilder`), FEAT-006
(`SessionLog` for `turn.start`/`turn.complete`), FEAT-009 (`emit_event` capture contract).

**Acceptance Criteria:**
- [ ] A conversation step turn runs on `RunLoop` (asserted: `ChatOrchestrator.responseLoop()` is **not**
  invoked by the executor).
- [ ] The step's persona is resolved with `PersonaManager.getPersonaByName()`; the global
  active-persona state is unchanged after the turn (no `activatePersona()` call).
- [ ] `notor-step-model`, when set, overrides the persona's preferred model for that turn; otherwise the
  persona's preset/provider/model preference applies.
- [ ] `turn.start` is written before any LLM call; `turn.complete` after the emit is captured.
- [ ] When the turn captures an `emit_event`, that `{topic, payload}` is returned; when it does not, the
  step's `default_publishes` topic is synthesized and returned.
- [ ] JSONL persistence is attached via the `RunLoopHooks.onPersist` hook, not baked into the engine.
- [ ] The `RunContext` (depth + aggregate budget) provided by the runner is threaded into the `RunLoop`;
  per-turn cost decrements the aggregate budget via ARCH-005's `budget.ts`.
- [ ] A code-mode step is dispatched through the seam reserved for INT-010 (not executed as a
  conversation turn).

---

## FEAT-008: `LoopSafetyGuards` (iteration/runtime/stale/thrashing)

**Description:** Implement the loop safety guards per the canonical design doc *Safety Mechanisms*
and FR-117. These are flow-level guards layered on top of the per-run `RunLoop` iteration cap (Phase 0)
— they terminate a *flow* that is stuck even when each individual turn is within its per-run cap.
Implement: (1) **iteration cap** — `flow.maxIterations` on total step turns; (2) **runtime cap** —
wall-clock check each turn against `flow.maxRuntimeMinutes`; (3) **stale-loop detection** — the same
`(topic, source_step, payload_hash)` triple emitted 3× consecutively over a rolling window of the last
5 events (`isStale` per the design); (4) **thrashing detection** — a task re-queued after abandonment
3+ times. Any guard firing terminates the flow (status `error`/terminal). The guards are pure
predicates over the event history + a small counters object; they do not perform I/O and do not own the
loop (the runner FEAT-010 consults them each turn). `required_events` enforcement and `FLOW_COMPLETE`
task enforcement are **not** here — `required_events` is checked by the runner at the completion event
(FR-118), and task enforcement is Phase 2 (FR-123/INT-003); thrashing's *task* signal is consumed once
the task registry exists but the detection predicate is defined here.

**FRs:** FR-117 (iteration cap, runtime cap, stale-loop, thrashing — each terminates a stuck flow).

**Files:**
- `src/orchestration/safety.ts` — `LoopSafetyGuards`: `checkIteration(turn, flow)`,
  `checkRuntime(startedAt, flow)`, `isStale(history)` (rolling window of 5, 3-consecutive identical
  `(topic, source_step, payload_hash)` triples), `isThrashing(taskKey, abandonCounts)`; a combined
  `evaluate(...)` the runner calls per turn returning a terminal reason or `null`.

**Dependencies:** FEAT-001 (`OrchestrationEvent`), FEAT-003 (consumes `getEventHistory()` for
stale-loop detection).

**Acceptance Criteria:**
- [ ] `isStale` returns true iff the last 3 events share the same `(topic, source_step, payload_hash)`
  triple (over the trailing window); fewer than 3 events → false.
- [ ] `checkRuntime` fires when wall-clock since `started_at` exceeds `maxRuntimeMinutes`.
- [ ] `checkIteration` fires when total step turns reach `maxIterations`.
- [ ] `isThrashing` fires when a task key is re-queued after abandonment 3+ times.
- [ ] Each guard maps to a terminal flow reason; the guards are pure (no I/O, no loop ownership).
- [ ] Guards are independent of the per-run `RunLoop` cap (they bound the *flow*, not a single runner).
- [ ] Covered by TEST-002.

---

## FEAT-010: `OrchestrationRunner` main loop

**Description:** Implement the main loop per the canonical design doc *Architecture → High-Level
Flow* and FR-118 — the component that wires every Phase-1 piece together and runs a flow end-to-end.
`start(flowDir, promptText)`: load `definition.md` + step notes (FEAT-002); register the
`FallbackCoordinator` on `*` and subscribe each step's `triggers` on the `OrchestrationEventEngine`
(FEAT-003/004); set up the session log (FEAT-006) and write `session.start`; publish the flow's
`startingEvent` with the user objective as payload. Then drive the event loop: resolve subscribers for
the current event (in `notor-steps` order), run each via `StepTurnExecutor` (FEAT-007), route the
captured/synthesized event back through the engine, consult `LoopSafetyGuards` (FEAT-008) each turn, and
seed each turn's `RunContext` (depth/aggregate budget). Terminate on the flow's `completionEvent`
(default `FLOW_COMPLETE`) — finalizing the session — subject to `required_events` enforcement (a
`FLOW_COMPLETE` before all `requiredEvents` are seen is blocked and re-injected). `FLOW_CANCELLED` /
`FLOW_ERROR` terminate immediately (cancelled / error). Full `FLOW_COMPLETE` **task** enforcement
(open/running tasks) is Phase 2 (FR-123/INT-003); the runner leaves the hook and enforces only
`required_events` in Phase 1. The runner owns the session-directory lifecycle stub for Phase 1; the full
`OrchestrationSessionManager` (workspace/scratchpad/tasks/recovery) lands in Phase 2 (INT-001) — Phase
1 needs only enough of a session to write the log and run turns.

**FRs:** FR-118 (load → register fallback → create session → publish starting event → run loop →
finalize on completion; terminate on `FLOW_COMPLETE` subject to FR-123 task enforcement). Touches
FR-117 (consults the guards) and FR-132 (`FLOW_CANCELLED` terminal handling).

**Files:**
- `src/orchestration/runner.ts` — `OrchestrationRunner` (`start(flowDir, promptText)` + the event loop:
  subscribe steps, register fallback, publish starting event, dispatch turns via `StepTurnExecutor`,
  route via the engine, consult `LoopSafetyGuards`, enforce `required_events`, finalize on terminal
  event). Leaves the FR-123 task-enforcement hook and INT-001 session-manager seam.

**Dependencies:** FEAT-002 (parsers), FEAT-003 (event engine), FEAT-004 (fallback), FEAT-007
(`StepTurnExecutor`), FEAT-008 (`LoopSafetyGuards`).

**Acceptance Criteria:**
- [ ] A hand-authored flow runs end-to-end with correct routing (starting event → step turns → terminal
  event), each step's emitted/synthesized event routed to the next subscriber in `notor-steps` order.
- [ ] The loop terminates on the flow's `completionEvent` (default `FLOW_COMPLETE`) and finalizes the
  session — subject to `required_events` (a completion before all required events are seen is blocked
  and re-injected with remaining-event context).
- [ ] `FLOW_CANCELLED` terminates with status `cancelled`; `FLOW_ERROR` (from the fallback) terminates
  with status `error`.
- [ ] `LoopSafetyGuards.evaluate()` is consulted each turn; a firing guard terminates the flow.
- [ ] Each turn's `RunContext` (depth + aggregate budget) is seeded and passed into
  `StepTurnExecutor`/`RunLoop`.
- [ ] `session.start` is written at start and a terminal session entry (`session.complete`/
  `session.cancelled`) at the end.
- [ ] The FR-123 (task enforcement) and INT-001 (session manager) seams exist but are inert in Phase 1.
- [ ] e2e-covered by TEST-007 (Phase 2 lane), with the single-flow happy path runnable in Phase 1.

---

## FEAT-011: Command palette "Run Orchestration" + flow picker

**Description:** Register the user entry point per FR-119 and the canonical design doc
*Implementation Phases → Phase 1*. Add a **"Notor: Run Orchestration"** command in `src/main.ts`
(alongside the existing command registrations) that is **only present when `orchestration_enabled` is
true** (gated like the other feature-group surfaces). Invoking it discovers flows via FEAT-002, presents
a flow picker (a `SuggestModal`/fuzzy picker over discovered `OrchestrationFlow`s, showing
`notor-flow-name` + `notor-flow-description`), prompts for the objective text, and calls
`OrchestrationRunner.start(flowDir, promptText)` (FEAT-010). Enabling the feature group ensures the
`orchestrations/` directory exists (mirrors how the memory toggle seeds its directory). When the feature
group is disabled, the command and all scaffolds are absent.

**FRs:** FR-119 (command + flow picker + prompt entry; command/scaffolds absent when disabled; enabling
creates `orchestrations/` and registers scaffolds).

**Files:**
- `src/main.ts` — register the "Notor: Run Orchestration" command (gated on `orchestration_enabled`),
  wire the flow picker → prompt → `OrchestrationRunner.start(...)`. Mirrors the existing command-
  registration pattern in `main.ts`.
- `src/orchestration/flow-picker.ts` *(optional)* — the `SuggestModal` flow-picker UI, if factored out
  of `main.ts` (kept small; reuses the discovery from FEAT-002).

**Dependencies:** FEAT-010 (`OrchestrationRunner.start`), ENV-002 (feature-group registration / gating
+ `settings/sections/orchestration.ts` directory seeding).

**Acceptance Criteria:**
- [ ] The "Notor: Run Orchestration" command is registered only when `orchestration_enabled` is true and
  absent otherwise.
- [ ] Invoking it shows a picker over discovered flows (name + description), then prompts for objective
  text.
- [ ] Selecting a flow + entering a prompt calls `OrchestrationRunner.start(flowDir, promptText)`.
- [ ] Enabling the feature group ensures `{notor_dir}/orchestrations/` exists (directory seeded, like
  the memory toggle).
- [ ] When disabled, neither the command nor any orchestration scaffold (`emit_event`) is present.

---

## TEST-002: Event-engine / fallback / safety unit tests

**Description:** Unit-test the deterministic engine core — the event engine (FEAT-003), fallback
coordinator (FEAT-004), and safety guards (FEAT-008) — with no LLM and no real vault I/O (fakes for
`SessionLog` and parsed flows). This is a Phase-1 quality gate per [../tasks.md](../tasks.md).

**FRs:** FR-112, FR-113, FR-117 (the behaviors verified).

**Files:**
- `src/orchestration/event-engine.test.ts` — write-before-route ordering, `notor-steps` subscriber
  ordering, orphan → fallback routing, event-history shape.
- `src/orchestration/fallback-coordinator.test.ts` — steer-on-near-miss, unrecoverable → `FLOW_ERROR`,
  no silent drop, re-orphaned-steer escalates to `FLOW_ERROR`.
- `src/orchestration/safety.test.ts` — `isStale` (3-consecutive triple, <3 → false), `checkRuntime`,
  `checkIteration`, `isThrashing`.

**Dependencies:** FEAT-003, FEAT-004, FEAT-008.

**Acceptance Criteria:**
- [ ] Event-engine test asserts `publish()` writes `event.emitted` to a fake `SessionLog` **before** any
  subscriber is invoked (call-order assertion).
- [ ] Multiple subscribers on one topic are dispatched in `notor-steps` order.
- [ ] An orphaned topic routes to the fallback; a near-miss is steered exactly once; an unrecoverable
  orphan yields `FLOW_ERROR`; no orphan is silently dropped.
- [ ] `isStale` true on 3 identical consecutive `(topic, source_step, payload_hash)` triples, false with
  fewer than 3 events or a varied window.
- [ ] `checkRuntime`/`checkIteration`/`isThrashing` each fire at their documented thresholds.
- [ ] All tests are pure (no network, no real vault writes) and pass under the existing Vitest config.

---

## TEST-003: Flow/step parser unit tests

**Description:** Unit-test `FlowDefinitionParser` and `StepNoteParser` (FEAT-002) against fixture
notes, with no real vault — fixtures fed through the same `metadataCache`/frontmatter path the parser
uses (mirroring how the workflow-discovery tests fixture their input). Phase-1 quality gate per
[../tasks.md](../tasks.md).

**FRs:** FR-110, FR-111 (the parse behaviors verified).

**Files:**
- `src/orchestration/flow-parser.test.ts` — `definition.md` field mapping + defaults, `notor-steps`
  wikilink resolution (incl. unresolved → error), step frontmatter/body parse, `notor-step-mode`
  default `conversation`, ambiguous-trigger rejection, `definition.md`-body-is-not-prompt, composition
  fields parse inertly, `<include_note>` preserved verbatim in `bodyContent`.

**Dependencies:** FEAT-002.

**Acceptance Criteria:**
- [ ] A valid flow fixture parses into an `OrchestrationFlow` with every field populated and documented
  defaults applied (`completionEvent` → `FLOW_COMPLETE`, `handoffIsolation` → `"isolated"`, `invocable`
  → `false`).
- [ ] Each step note parses into a `StepDefinition`; `notor-step-mode` defaults to `"conversation"`; the
  body becomes `bodyContent`.
- [ ] An unresolved `notor-steps` wikilink raises a clear error naming the missing step.
- [ ] A topic in two steps' `notor-step-triggers` within one flow is rejected at load with an error
  naming the topic and both steps.
- [ ] The `definition.md` body is not surfaced as prompt content.
- [ ] Composition frontmatter (`notor-flow-invocable`, `notor-flow-inputs`, etc.) parses into the inert
  fields without affecting Phase-1 behavior.
- [ ] `<include_note>` tags in a step body survive parsing verbatim (expansion is the prompt builder's
  job, FEAT-005).

---

## Phase-1 Exit Gate

Per the per-phase test gate in [../tasks.md](../tasks.md):

- [ ] **TEST-002** (event-engine / fallback / safety units) green.
- [ ] **TEST-003** (flow/step parser units) green.
- [ ] `step-prompt-builder` test asserts the **must-publish rule is always injected** (FEAT-005), across
  empty-body and custom-body steps.
- [ ] A hand-authored flow runs end-to-end via FEAT-010 (single-flow happy path; full e2e is TEST-007
  with the Phase-2 session lane).
