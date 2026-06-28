# Task Bodies: Phase 5 — Interactive Orchestration + Step-to-Workflow (Lane D)

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-150 group)
**Data Model:** [../data-model.md](../data-model.md)
**Master Task Index:** [../tasks.md](../tasks.md)
**Contracts:** [../contracts/vault-schema.md](../contracts/vault-schema.md) · [../contracts/event-engine.md](../contracts/event-engine.md) · [../contracts/run-loop.md](../contracts/run-loop.md)
**Status:** Implemented (INT-030 + INT-031)

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
- [x] A step emitting `user.input.required` **pauses** the loop (the runner suspends event consumption)
  and surfaces the captured payload as a prompt to the user.
- [x] On user input, a `user.input.received` entry is written, `session.json` `status` returns to
  `active`, and the loop **resumes** by publishing the resume event with the user's payload as its
  payload (write-before-route).
- [x] The pause is durable: `user.input.required` is appended to `session-log.jsonl` **before** the loop
  suspends, and `session.json` `status` is `interrupted` while paused.
- [x] A session paused on input **survives a reload**: `INT-005` recovery classifies the dangling
  `user.input.required` (no `user.input.received`) as "still paused" and re-surfaces the prompt — it
  does **not** re-emit a trigger or re-run the paused step.
- [x] Resuming a recovered paused session writes `user.input.received` and continues the loop exactly
  once (idempotent: re-running recovery over the same paused tail re-surfaces the same prompt and does
  not double-resume).
- [x] Declining the prompt finalizes the run via `FLOW_CANCELLED` (status `cancelled`), reusing
  `INT-012`'s terminal handling; open tasks do not block the cancel.
- [x] No `session-log.jsonl` entry schema is defined in this file — it links to
  [../contracts/vault-schema.md](../contracts/vault-schema.md).

**Implementation notes (INT-030):**
- The resume re-triggers the **paused step itself** with the user's answer as the resume event's
  payload (decision: re-trigger the paused step). `user.input.required` is intercepted by the runner at
  its routing boundary ([runner.ts](../../../../src/orchestration/runner.ts) `handlePause` /
  `collectInputAndResume`), never routed to a subscriber — the engine stays UI-agnostic. The
  `still_paused` recovery action now carries the paused `step` (surfaced from the existing log entry, no
  new classifier logic) so resume re-triggers exactly that step.
- The runner gained injected `requestUserInput` (collect the answer; `null` ⇒ decline ⇒ `FLOW_CANCELLED`)
  and `setSessionStatus` (mirror `interrupted`/`active`) deps, wired in [launch.ts](../../../../src/orchestration/launch.ts)
  to a `UserInputModal` + `OrchestrationSessionManager.updateStatus`. Omitting `requestUserInput` (unit
  tests) cancels the run rather than hanging the loop.
- `user.input.required` is exempted from the load-time static-orphan validator
  ([flow-parser.ts](../../../../src/orchestration/flow-parser.ts) `isValidatorExemptTopic`) — it is a
  runtime-intercepted pause signal, not a routable topic.

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

**Aggregate-budget reconciliation (FR-151, the accounting hole this closes) — uncapped during,
unbounded overshoot (Issue-13h).** The background-workflow loop has **no `RunContext`**, so its LLM
turns cannot decrement the shared aggregate-budget cell live — and, crucially, it also has **no per-run
iteration or cost cap of its own** (`_backgroundResponseLoop`'s `while(continueLoop)` toggles solely on
whether the model called a tool; workflow frontmatter exposes no max-iteration field). So the invoked
workflow is **not bounded during the call**. At the **await-result boundary** (where the step captures
the workflow's final output), the executor performs **post-hoc reconciliation**: it subtracts the
workflow's total reported cost/iterations from the **shared** `RunContext.budget` cell
(`decrementAggregate`, ARCH-005) in one decrement. The ceiling is therefore accurate **after** the
invocation (the next turn/spawn gate sees the real remaining total) but is **not** enforced during it —
so a single step→workflow call can overshoot the flow's `notor-max-cost-usd` / `notor-max-iterations` by
an **unbounded** amount (a whole workflow run). This is **larger and differently-shaped** than FR-176's
`run_flow` soft ceiling, whose overshoot is **bounded** (≤ one full turn per in-flight runner) because a
`run_flow` child runs on a child `RunLoop` that decrements the shared cell live — **FR-176 does not cover
step→workflow.** Bounding the invoked workflow during its run (a per-run cap or live gating) is **out of
scope for v1**; the accepted contract is "uncapped during, reconciled after, unbounded overshoot,"
surfaced to authors as a deliberate-delegation caveat (POL-001 / DOC-001). This keeps `RunContext` out of
the background loop while closing the *accounting* hole (the ceiling is correct going forward). Authority
for the shared cell: [../contracts/run-loop.md](../contracts/run-loop.md); the uncapped/unbounded-overshoot
budget model is the authority of [../contracts/tools.md](../contracts/tools.md) (`run_flow` vs
step→workflow table) and [../spec.md](../spec.md) FR-151.

**FRs:** FR-151 (step-to-workflow invocation — invoke a named single-turn workflow, await its result
into the step's context).

**Files:**
- `src/orchestration/step-turn-executor.ts` — `StepTurnExecutor` (`FEAT-007`): the path by which a
  conversation step invokes a named workflow and awaits the result into the step's context before the
  step emits its event. (Whether the invocation surfaces as a dedicated tool the step calls, or as a
  step-frontmatter binding, is an implementation choice resolved in this task; either way it drives the
  background loop below and folds the returned text into the step turn.)
- `src/chat/workflow-executor.ts` — the **background execution** loop (`_backgroundResponseLoop`,
  `while (continueLoop)` ~809; single `dispatcher.dispatch()` ~951) is the seam that runs the invoked
  workflow to completion. **Wrap, do not modify:** the loop returns `Promise<void>` today and serves live
  background workflows, so INT-031 **wraps** the existing entry point rather than changing its signature —
  it reads the workflow's cumulative spend from the background `ConversationManager` after the loop settles
  (the per-turn token rollup is already maintained on the background conversation, ~`:1003-1011`:
  `total_output_tokens` / `estimated_cost`) and derives the iteration count at that same await-result
  boundary. The captured `{ text, costUsd, iterations }` feeds both the step-context fold and the
  post-hoc `decrementAggregate` reconciliation. Leaving the shared loop's signature and live-workflow
  behavior untouched keeps the regression surface minimal (the same loop Phase 7 `run_flow` later
  generalizes — but Phase 7 owns that generalization, not INT-031).
- `src/run-loop/budget.ts` — reused (`ARCH-005`): at the await-result boundary, `StepTurnExecutor`
  calls `decrementAggregate(runContext.budget, workflowCostUsd, workflowIterations)` to fold the
  workflow's spend into the shared aggregate-budget cell (post-hoc reconciliation).
- `src/workflows/workflow-executor.ts` — **prompt assembly only**: `assembleWorkflowPrompt` (~262) /
  `readWorkflowBody` (~60) / `resolveWorkflowIncludes` (~98) build the workflow's prompt from the named
  workflow note; no change beyond reuse.
- `src/workflows/workflow-discovery.ts` — `discoverWorkflows(...)` (~73) resolves the workflow by name
  from `{notor_dir}/workflows/` (reuse; no change).

**Dependencies:** `FEAT-007` (`StepTurnExecutor` — the conversation step path on the shared `RunLoop`
that the workflow invocation hangs off of).

**Acceptance Criteria:**
- [x] A conversation step can invoke a **named single-turn workflow** (resolved via
  `discoverWorkflows`) and the workflow runs to completion through the **background loop** in
  `src/chat/workflow-executor.ts` (one tool call per iteration via `dispatcher.dispatch()`), not through
  `executeToolBatches`.
- [x] The workflow's final assistant output is **returned into the invoking step's context** so the step
  can reason over it before emitting its own event.
- [x] At the await-result boundary, the workflow's total cost/iterations are **reconciled** into the
  shared `RunContext.budget` cell (`decrementAggregate`), so the flow's `notor-max-cost-usd` /
  `notor-max-iterations` ceilings account for workflow-invocation spend (accurate **after** the call).
- [x] The invoked workflow runs **uncapped** during the call (the background loop has no per-run
  iteration/cost cap), so the aggregate overshoot is **unbounded** (a whole workflow run) — explicitly
  **unlike** FR-176's bounded `run_flow` soft ceiling. This is a documented, accepted v1 property (not a
  bug); no per-run cap or live gating is added here.
- [x] The invocation reuses the existing assembly path (`assembleWorkflowPrompt` in
  `src/workflows/workflow-executor.ts`) — no duplicate prompt-assembly logic is introduced.
- [x] The invoked workflow runs as its own (background) conversation; it does **not** become an
  orchestration step conversation (no `orchestration_edges`), and it does not consume an orchestration
  event-loop turn beyond the invoking step's own turn.
- [x] The mechanism is **distinct from `run_flow`**: no child flow session, no `parent_session_id`, no
  terminal event, no structured return, no `child_run_metadata` — those are Phase 7 (`INT-042`/`INT-043`)
  and are not introduced here.
- [x] `INT-031` introduces **no dependency** on any Phase 7 task; it depends only on `FEAT-007`.

**Implementation notes (INT-031):**
- Invocation surface is a **dedicated tool** (decision): the feature-gated `invoke_workflow` scaffold
  ([invoke-workflow.ts](../../../../src/extensions/builtin-tool-scaffolds/invoke-workflow.ts)) the step's
  LLM calls with a workflow name + task, mirroring `emit_event`. It reaches the seam via the
  `utils.invokeWorkflow` bridge ([orchestration-utils.ts](../../../../src/extensions/runtime-context/orchestration-utils.ts)),
  which resolves the workflow and drives the live orchestrator's background loop.
- The loop seam **wraps, does not modify** (decision; the task body reserves loop *generalization* for
  Phase 7): a new public `WorkflowExecutor.runWorkflowHeadless`
  ([workflow-executor.ts](../../../../src/chat/workflow-executor.ts)) drives the **existing**
  `_backgroundResponseLoop` (signature untouched) with a throwaway `WorkflowExecution` + a local
  `WorkflowConcurrencyManager`, then reads `{ text, costUsd, iterations }` off the settled background
  conversation. Exposed on `ChatOrchestrator.runWorkflowHeadless`.
- Reconciliation: `invoke_workflow` pushes the reported `{ costUsd, iterations }` onto the carriage's
  `workflowInvocations` accumulator; `StepTurnExecutor.reconcileWorkflowInvocations` drains it after the
  turn and applies one `decrementAggregate` per invocation (post-hoc; uncapped during the call).
- **v1 limitation (documented):** step→workflow requires a live chat orchestrator; when none is
  available (a hook-launched flow with no chat panel) the bridge is `null` and `invoke_workflow` errors
  cleanly (the step's LLM sees the error and proceeds), rather than opening a panel on demand.

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
