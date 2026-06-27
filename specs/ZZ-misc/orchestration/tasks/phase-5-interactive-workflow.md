# Task Bodies: Phase 5 — Interactive Orchestration + Step-to-Workflow (Lane D)

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-150 group)
**Data Model:** [../data-model.md](../data-model.md)
**Master Task Index:** [../tasks.md](../tasks.md)
**Contracts:** [../contracts/vault-schema.md](../contracts/vault-schema.md) · [../contracts/event-engine.md](../contracts/event-engine.md) · [../contracts/run-loop.md](../contracts/run-loop.md)
**Status:** Draft

This file holds the full task **bodies** for design Phase 5 (repo phase: Integration, **Lane D**) —
task IDs **INT-030** and **INT-031**. Task IDs and their dependency edges are owned by
[../tasks.md](../tasks.md); the IDs and edges reproduced here match it exactly. The covered functional
requirements are **FR-150** (interactive pause) and **FR-151** (step-to-workflow invocation) — see
[../spec.md](../spec.md).

Design reference: [orchestration.md → Phase 5: Interactive Orchestration + Step-to-Workflow Mapping]
(canonical vault design doc). Schema authorities are linked, not redefined: the
`user.input.required` / `user.input.received` `session-log.jsonl` entries and their enforced write
order are the authority of [../contracts/vault-schema.md](../contracts/vault-schema.md); the
terminal-event / write-before-route routing rules are the authority of
[../contracts/event-engine.md](../contracts/event-engine.md); the two-layer limit model and `RunLoop`
hook semantics are the authority of [../contracts/run-loop.md](../contracts/run-loop.md).

## Lane scope and sequencing

Lane D opens once the Phase 1 core runner lands (`FEAT-010`) and runs concurrently with Lanes A/B/C.
The two tasks in this lane are **independent of each other** (no edge between `INT-030` and `INT-031`)
but each has a cross-lane prerequisite:

- `INT-030` (`user.input.required` pause) depends on `FEAT-010` (the runner that owns the event loop)
  **and** on `INT-005` (Lane A session recovery), because a paused-on-input session must be modeled as
  a recoverable `session-log.jsonl` state, not an interrupted turn.
- `INT-031` (step-to-workflow invocation) depends on `FEAT-007` (the `StepTurnExecutor`, the conversation
  step path on the shared `RunLoop` that a workflow invocation hangs off of).

One sequencing-risk register entry (from [../tasks.md](../tasks.md)) governs this lane:

- **Risk #9 — recovery idempotency (INT-005) ⇄ interactive pause (INT-030).** Treat paused-on-input as
  a **recoverable log state**: the pause is durably recorded as a `user.input.required` entry and the
  resume as a `user.input.received` entry ([../contracts/vault-schema.md](../contracts/vault-schema.md)).
  `INT-005` lands **before** `INT-030` and already defines its recovery classifier to leave room for a
  dangling `user.input.required` (no following `user.input.received`) to be classified as "still paused,
  re-surface the prompt" rather than as a dangling `turn.start` that re-emits a trigger (see `INT-005`
  AC in [phase-2-session-nav.md](phase-2-session-nav.md)). `INT-030` therefore lists `INT-005` as a
  dependency and consumes — does not redefine — that classifier slot.

**Per-phase test gate (Phases 4–5, from [../tasks.md](../tasks.md)):** Notice synthesis unit (Lane C);
**pause/resume + paused-session recovery** (this lane); context-menu jump in e2e (Lane C). The
pause/resume + paused-session-recovery coverage for `INT-030` is specified in the test note at the end
of this file; it extends the `INT-005` recovery suite (`TEST-005`) with the paused-tail case rather
than standing up a parallel harness.

---

## INT-030: `user.input.required` pausing event

**Description:** Add the interactive-pause capability (FR-150): a step can emit the
`user.input.required` event to **pause** the orchestration loop awaiting user input, then **resume**
with the supplied payload threaded into the run as the next event. This makes a flow able to ask for
human judgment mid-run (a design decision, a missing fact, an approval) without abandoning the run.

The pause is an ordinary emitted event with extraordinary handling at the runner's routing boundary
(routing rules: [../contracts/event-engine.md](../contracts/event-engine.md)). The flow:

1. A conversation step emits `user.input.required` via the `emit_event` tool (or a code step returns
   `orchestration.emit("user.input.required", prompt)`), with the **payload carrying the question /
   prompt** to show the user. As with every event, the runner captures the emission **after** the turn
   completes — no mid-turn routing ([../contracts/run-loop.md](../contracts/run-loop.md) hook ordering;
   `default_publishes` synthesis still does **not** apply, because an explicit emission occurred).
2. `OrchestrationRunner` (`FEAT-010`) recognizes `user.input.required` as a **pause signal**, not a
   topic to route to a subscriber step. It writes the `user.input.required` `session-log.jsonl` entry
   (`turn`, `step`, `prompt`, `ts` — [../contracts/vault-schema.md](../contracts/vault-schema.md)),
   sets `session.json` `status` to `interrupted` (the same status the recovery scan looks for — this
   is the single status reused for "paused"; the dangling-`user.input.required` tail is what
   distinguishes a *paused* interrupt from a *crashed* interrupt), and **suspends the event loop**
   (stops consuming further events) rather than terminating it.
3. The runner surfaces a prompt to the user (a Notice + the captured question, reusing the existing UI
   primitives; on desktop the same `oncontextmenu`/`Notice` affordances Lane C uses — but this task
   only needs a way to collect the answer, e.g. a modal / input prompt, not the right-click jump).
4. When the user supplies input, the runner writes a `user.input.received` entry (`turn`, `payload`,
   `ts`), restores `session.json` `status` to `active`, and **resumes the loop** by publishing the
   resume event with the user's payload — the topic the paused step's `notor-step-publishes` /
   `notor-step-default-publishes` designates for "I have the input" (concretely: the runner re-publishes
   through `OrchestrationEventEngine.publish()` so the resume is itself write-before-route, and routes
   to whichever step subscribes to that topic). The user's answer becomes the resumed event's payload.
5. If the user declines / dismisses the prompt, the runner may finalize via `FLOW_CANCELLED`
   (status `cancelled`, bypassing task enforcement — [../contracts/event-engine.md](../contracts/event-engine.md));
   that path reuses `INT-012`'s terminal handling and is not re-implemented here.

**Recoverability (the defining property; Risk #9).** The pause must survive a plugin reload. Because
the pause is recorded as a `user.input.required` log entry **with no following `user.input.received`**,
the `INT-005` recovery classifier (Lane A) sees a paused tail and recovers it as **"still paused —
re-surface the prompt"**, *not* as a dangling `turn.start` (which would re-emit a trigger and re-run
the step). This task supplies the runner-side resume entry point that `INT-005`'s `resume(session)`
calls for the paused tail; it does **not** modify the classifier (that slot already exists per
`INT-005`). The write order is the existing recovery invariant: the `user.input.required` entry is
durable **before** the loop suspends, so a crash between "asked" and "answered" reliably re-surfaces
the prompt; a crash after `user.input.received` resumes from the published resume event (an ordinary
`event.emitted` tail, re-published idempotently by the existing rule).

**FRs:** FR-150 (`user.input.required` pause; the paused state is a recoverable log entry, interplays
with FR-125).

**Files:**
- `src/orchestration/runner.ts` — `OrchestrationRunner` event-loop boundary: recognize
  `user.input.required` as a pause signal (suspend, don't terminate); write `user.input.required`; set
  `session.json` `status: interrupted`; on input, write `user.input.received`, restore `status: active`,
  and re-publish the resume event through the engine; expose a `resume(session, userInput)` /
  paused-resume entry point that `INT-005` recovery invokes for a paused tail.
- `src/orchestration/session-log.ts` — `SessionLog` writer/reader (writer is `FEAT-006`; reader added
  in `INT-005`): support the `user.input.required` / `user.input.received` entry types from
  [../contracts/vault-schema.md](../contracts/vault-schema.md) (no new schema — the entry types are
  already enumerated in the contract; this task wires their write + classify).
- `src/orchestration/session-recovery.ts` — (`INT-005`-owned) **consume only**: the classifier already
  reserves the dangling-`user.input.required` ⇒ "still paused" branch; this task plugs the runner's
  paused-resume entry point into that branch. No classifier logic is added here.
- `src/orchestration/event-engine.ts` — no schema change; `user.input.required` is an ordinary topic at
  the engine layer (write-before-route applies). The pause is the **runner's** interpretation of the
  captured topic, not an engine routing rule — keeping the engine LLM- and UI-agnostic
  ([../contracts/event-engine.md](../contracts/event-engine.md)).
- `src/main.ts` — load-time recovery (gated on `orchestration_enabled`) already invokes session
  recovery (`INT-005`); a paused session surfaces its resume prompt through the same path rather than a
  new load hook.

**Dependencies:** `FEAT-010` (the runner that owns the event loop and terminal/pause handling),
`INT-005` (session recovery — the paused state is a recoverable log entry; Risk #9: `INT-005` before
`INT-030`).

**Acceptance Criteria:**
- [ ] A step emitting `user.input.required` **pauses** the loop (the runner suspends event consumption)
  and surfaces the captured payload as a prompt to the user.
- [ ] On user input, a `user.input.received` entry is written, `session.json` `status` returns to
  `active`, and the loop **resumes** by publishing the resume event with the user's payload as its
  payload (write-before-route).
- [ ] The pause is durable: `user.input.required` is appended to `session-log.jsonl` **before** the loop
  suspends, and `session.json` `status` is `interrupted` while paused.
- [ ] A session paused on input **survives a reload**: `INT-005` recovery classifies the dangling
  `user.input.required` (no `user.input.received`) as "still paused" and re-surfaces the prompt — it
  does **not** re-emit a trigger or re-run the paused step.
- [ ] Resuming a recovered paused session writes `user.input.received` and continues the loop exactly
  once (idempotent: re-running recovery over the same paused tail re-surfaces the same prompt and does
  not double-resume).
- [ ] Declining the prompt finalizes the run via `FLOW_CANCELLED` (status `cancelled`), reusing
  `INT-012`'s terminal handling; open tasks do not block the cancel.
- [ ] No `session-log.jsonl` entry schema is defined in this file — it links to
  [../contracts/vault-schema.md](../contracts/vault-schema.md).

---

## INT-031: Step-to-workflow invocation

**Description:** Let a conversation step invoke a named **single-turn workflow** to direct its task,
**awaiting the workflow's result into the step's context** (FR-151). This is the mechanism by which a
step delegates a well-bounded sub-task to an existing Notor workflow (a reusable prompt template) and
folds the workflow's output back into its own turn before emitting its event. It is **distinct from
`run_flow`** (Phase 7, `INT-042`/`INT-043`): `run_flow` invokes another multi-step *flow* on a child
`RunLoop` and returns a flow result; `INT-031` invokes a single-turn *workflow* (no event loop, no
child flow session) and returns the workflow's assistant output.

**Seam — the BACKGROUND workflow loop (not `executeToolBatches`).** A workflow's single-turn execution
runs through the **background execution** loop in `src/chat/workflow-executor.ts` —
`while (continueLoop)` (~809) — which dispatches **one tool at a time** via a single
`dispatcher.dispatch()` call (~951), *not* through the batched `executeToolBatches` path used by chat,
sub-agents, and step turns. This is the deliberate hook point: the step's workflow invocation drives
this background loop to completion and captures its final assistant text. Disambiguation
([../tasks.md](../tasks.md) seam table): `src/workflows/workflow-executor.ts` is **prompt assembly
only** (no loop — `readWorkflowBody` ~60, `resolveWorkflowIncludes` ~98, `assembleWorkflowPrompt` ~262)
and is the source of the workflow's assembled prompt; `src/chat/workflow-executor.ts` is the loop that
*executes* that assembled prompt headlessly. The invocation path uses both: assemble via
`src/workflows/workflow-executor.ts`, execute via `src/chat/workflow-executor.ts`'s background loop.

**Wiring.** The invoking step is a conversation step running on the shared `RunLoop` via
`StepTurnExecutor` (`FEAT-007`). The workflow is selected by name and resolved through the existing
workflow discovery (`discoverWorkflows(vault, metadataCache, notorDir)` in
`src/workflows/workflow-discovery.ts:73`, scanning `{notor_dir}/workflows/`). The step invokes the
workflow, the background loop runs it to its terminal state (one tool call per iteration; tool config
governed as today — note the headless background loop leaves `interactionCallback` undefined, so
`ask_user`-style tools error out cleanly), and the workflow's final assistant text is returned **into
the step's context** so the step can reason over it and then emit its own event. The workflow runs as
its own background conversation (`ConversationSession`, ~792); its conversation is a leaf that does
**not** become an orchestration step conversation (no `orchestration_edges` chaining — it is a
single-turn workflow, not a step), and it does not consume an orchestration event-loop turn beyond the
invoking step's own turn.

**Distinct from `run_flow` (do not conflate).** `INT-031` is **single-turn workflow** invocation
awaited into a step's context — there is no child flow session, no `parent_session_id`, no terminal
event, no structured return, and no `child_run_metadata` rollup. The flow-as-tool mechanism with all of
those (child `RunLoop`, child session, structured-vs-text return) is Phase 7's `run_flow` and is built
separately. The shared lineage is only the "drive a headless loop and await its result" pattern that
Phase 7 generalizes (design note: "generalize `chat/workflow-executor.ts` await-result" —
[orchestration.md → Phase 7]); `INT-031` is the simpler, workflow-scoped consumer of that loop and does
not depend on Phase 7.

**FRs:** FR-151 (step-to-workflow invocation — invoke a named single-turn workflow, await its result
into the step's context).

**Files:**
- `src/orchestration/step-turn-executor.ts` — `StepTurnExecutor` (`FEAT-007`): the path by which a
  conversation step invokes a named workflow and awaits the result into the step's context before the
  step emits its event. (Whether the invocation surfaces as a dedicated tool the step calls, or as a
  step-frontmatter binding, is an implementation choice resolved in this task; either way it drives the
  background loop below and folds the returned text into the step turn.)
- `src/chat/workflow-executor.ts` — the **background execution** loop (`while (continueLoop)` ~809;
  single `dispatcher.dispatch()` ~951) is the seam that runs the invoked workflow to completion; expose
  / reuse an entry point that runs an assembled workflow prompt headlessly and returns its final
  assistant text (this is the await-result capture FR-151 needs, and the same loop Phase 7 `run_flow`
  later generalizes).
- `src/workflows/workflow-executor.ts` — **prompt assembly only**: `assembleWorkflowPrompt` (~262) /
  `readWorkflowBody` (~60) / `resolveWorkflowIncludes` (~98) build the workflow's prompt from the named
  workflow note; no change beyond reuse.
- `src/workflows/workflow-discovery.ts` — `discoverWorkflows(...)` (~73) resolves the workflow by name
  from `{notor_dir}/workflows/` (reuse; no change).

**Dependencies:** `FEAT-007` (`StepTurnExecutor` — the conversation step path on the shared `RunLoop`
that the workflow invocation hangs off of).

**Acceptance Criteria:**
- [ ] A conversation step can invoke a **named single-turn workflow** (resolved via
  `discoverWorkflows`) and the workflow runs to completion through the **background loop** in
  `src/chat/workflow-executor.ts` (one tool call per iteration via `dispatcher.dispatch()`), not through
  `executeToolBatches`.
- [ ] The workflow's final assistant output is **returned into the invoking step's context** so the step
  can reason over it before emitting its own event.
- [ ] The invocation reuses the existing assembly path (`assembleWorkflowPrompt` in
  `src/workflows/workflow-executor.ts`) — no duplicate prompt-assembly logic is introduced.
- [ ] The invoked workflow runs as its own (background) conversation; it does **not** become an
  orchestration step conversation (no `orchestration_edges`), and it does not consume an orchestration
  event-loop turn beyond the invoking step's own turn.
- [ ] The mechanism is **distinct from `run_flow`**: no child flow session, no `parent_session_id`, no
  terminal event, no structured return, no `child_run_metadata` — those are Phase 7 (`INT-042`/`INT-043`)
  and are not introduced here.
- [ ] `INT-031` introduces **no dependency** on any Phase 7 task; it depends only on `FEAT-007`.

---

## Test note (Phase 4–5 gate, this lane): pause/resume + paused-session recovery

The Phase 4–5 gate for this lane (from [../tasks.md](../tasks.md)) is **pause/resume + paused-session
recovery** (the context-menu jump-in is Lane C's `INT-021` e2e). There is no dedicated `TEST-0xx` ID
allocated to Lane D in the master index; this coverage extends the existing recovery suite rather than
standing up a parallel harness:

- **Unit (pause/resume), in `src/orchestration/runner.test.ts` (or colocated `INT-030` runner tests):**
  - Emitting `user.input.required` suspends the loop (no further events consumed) and writes the
    `user.input.required` entry **before** suspending; `session.json` `status` becomes `interrupted`.
  - Supplying input writes `user.input.received`, restores `status: active`, and re-publishes the resume
    event with the user's payload exactly once (write-before-route observable, as in the engine tests).
  - Declining routes to `FLOW_CANCELLED` (status `cancelled`), reusing `INT-012`.

- **Recovery (extends `TEST-005`, `src/orchestration/session-recovery.test.ts`):** add the **paused-tail**
  case — a `session-log.jsonl` ending in a dangling `user.input.required` (no `user.input.received`) is
  classified as **"still paused"** and recovers by **re-surfacing the prompt**, *not* by re-emitting a
  trigger; running recovery twice over the same paused tail is **idempotent** (same prompt, no
  double-resume). This is the forward-compat slot `INT-005` AC already reserves (see
  [phase-2-session-nav.md](phase-2-session-nav.md) `INT-005` / `TEST-005`).

- **e2e (optional, folds into the Lane-A `TEST-007` flow harness):** run a small flow whose step emits
  `user.input.required`, assert the run pauses; simulate a reload (re-run recovery against the persisted
  `session-log.jsonl`) and assert the run re-surfaces the prompt; supply input and assert the run
  resumes to `FLOW_COMPLETE`. Follows the repo's e2e conventions (the chat container needs a clean
  workspace in `setupVault` or the deferred Notor chat view never mounts — see the `write-e2e-test`
  skill).

`INT-031` has no recovery dimension (a single-turn workflow invocation is awaited synchronously within
the invoking step's turn; a crash mid-invocation surfaces as a dangling `turn.start` on the *step*,
which the existing `INT-005` re-emit-trigger rule already covers — the step retries from fresh context).
A unit test asserting the background loop is driven (one `dispatcher.dispatch()` per iteration) and the
final assistant text is returned into the step context is sufficient.
