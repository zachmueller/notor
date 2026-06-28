# Contract: Orchestration Vault Schema

**Created:** 2026-06-27
**Specification:** [spec.md](../spec.md)
**Data Model:** [data-model.md](../data-model.md)
**Tasks:** [tasks.md](../tasks.md)
**Sibling contracts:** [contracts/run-loop.md](run-loop.md) · [contracts/edges.md](edges.md) · [contracts/orchestration-helper.md](orchestration-helper.md)

---

## Overview

This contract is the **single authority for every vault-persisted orchestration format**: the
on-disk directory layout, the frontmatter schema of `definition.md` and step notes, the runtime
session files (`session.json`, `session-log.jsonl`, scratchpad, task notes), and the cross-session
`memories.md` note. Parser/runtime *behavior* lives in [data-model.md](../data-model.md) (type
shapes) and the per-phase task files; this file pins down the bytes.

The conversation-header extensions (`_type`, `orchestration_session_id`, `orchestration_edges`) and
the shared `child_run_metadata` rollup block are **NOT** defined here — they are the single authority
of [contracts/edges.md](edges.md). This file links to them where relevant.

All paths use this repo's real source layout (`src/...`). The Sucrase compile pipeline, frontmatter
injection, and discovery scans referenced below are the existing ones at `src/extensions/compiler.ts`,
`src/workflows/workflow-frontmatter.ts`, and `src/workflows/workflow-discovery.ts` respectively;
the flow/step parser (FEAT-002) mirrors those patterns.

> Everything in this contract is **inert** unless `orchestration_enabled` is `true`
> (`src/settings/types.ts`; default `false` in `src/settings/defaults.ts`). The
> `{notor_dir}/orchestrations/` tree is created on first enable (ENV-001 / FR-119).

---

## Directory Structure

`{notor_dir}` is the configured Notor directory (e.g. `notor/`). Everything orchestration-related
lives under `{notor_dir}/orchestrations/`.

```
{vault}/
  {notor_dir}/
    orchestrations/                      # root for all orchestration content
      memories.md                        # persistent cross-session memory (seeded on first use)
      {flow-name}/                       # one directory per authored flow
        definition.md                    # flow topology, loop config, guardrails, composition
        steps/                           # step notes (one per step)
          planner.md                     # a conversation step
          verify-tests.md                # a code step (notor-step-mode: code)
          critic.md
          finalizer.md
      {another-flow}/
        definition.md
        steps/
          ...
      sessions/                          # created at runtime (one dir per flow execution)
        {session-id}/
          session.json                   # OrchestrationSessionMeta (status, iteration, active step)
          session-log.jsonl              # append-only turn+event log (crash-recovery source)
          scratchpad/                    # shared, restriction-free cross-step working dir (OVERWRITE-only writes; see FR-121/125)
            context.md                   #   (free-form; steps create whatever files they need)
            plan.md
            progress.md
          tasks/                         # runtime task notes
            {task-key}.md                #   notor-type: orchestration-task
    personas/                            # EXISTING persona dirs (not owned by this contract)
      planner-persona/
        system-prompt.md                 # persona referenced by a step's notor-step-persona
      builder-persona/
        system-prompt.md
```

Discovery (FEAT-002 / FR-110): flows are discovered by scanning `{notor_dir}/orchestrations/*/` for
a `definition.md` whose frontmatter `notor-type` is `orchestration-flow`, mirroring
`discoverWorkflows()` in `src/workflows/workflow-discovery.ts:73`. The `sessions/`, plus the
`steps/` subdir and `memories.md`, are excluded from flow discovery (the discriminator and the parent
directory name disambiguate). Step notes are resolved per flow from the `notor-steps` wikilinks
under that flow's `steps/`.

---

## `definition.md` — Flow Definition Note

The flow's topology, loop configuration, guardrails, and composition contract live **entirely in
frontmatter**. Parsed into `OrchestrationFlow` ([data-model.md](../data-model.md#orchestrationflow)).

### Frontmatter field table

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `notor-type` | `"orchestration-flow"` | yes | — | Discriminator; gates discovery. |
| `notor-flow-name` | string | yes | — | Display name (picker UI, conversation titles). |
| `notor-flow-description` | string | yes | — | Short description for the flow picker. |
| `notor-starting-event` | string | yes | — | First event published when the flow starts. |
| `notor-completion-event` | string | no | `FLOW_COMPLETE` | Terminal event that ends the loop; subject to task enforcement (FR-123). |
| `notor-max-iterations` | number | no | **`100`** (engine default; never absent at runtime) | Aggregate tree-wide ceiling on **LLM turns** (maps to `AggregateBudget.iterationsRemaining`; see [contracts/run-loop.md](run-loop.md)). **Code steps are not LLM turns and do not count toward it** — a code-step-only flow/cycle is bounded by `notor-max-runtime-minutes` + stale-loop detection instead (see [contracts/event-engine.md](event-engine.md)). When omitted, the `FlowDefinitionParser` injects the finite default (never `Infinity`). |
| `notor-max-runtime-minutes` | number | no | **`60`** (engine default; never absent at runtime) | Wall-clock runtime cap (FR-117). When omitted, the parser injects the finite default — so **every** flow (including a code-step-only flow that decrements no budget) has a wall-clock backstop and cannot run unbounded. |
| `notor-required-events` | string[] | no | `[]` | Events that must have been seen before `notor-completion-event` is accepted. |
| `notor-fanout-topics` | string[] | no | `[]` | Topics explicitly allowed to route to **more than one** step (ordered fan-out, FR-112). A topic with >1 subscriber that is **not** listed here is a load error (FR-111). See the routing rules in [contracts/event-engine.md](event-engine.md). |
| `notor-steps` | wikilink[] | yes | — | Ordered step references (`"[[planner]]"`), resolved under `steps/`. Order is the fan-out tie-break for a declared `notor-fanout-topics` topic (FR-112). |
| `notor-guardrails` | string[] | no | `[]` | Constraints injected into **every** step prompt (FR-114). |
| **Composition fields (design Phase 7; inert unless feature group enabled):** | | | | |
| `notor-flow-invocable` | boolean | no | `false` | Opt-in: the flow appears in the `run_flow` registry and may be called as a tool by other flows' steps (FR-171/172). |
| `notor-flow-inputs` | string | no | `null` | **Freeform natural-language** description of what the flow expects to begin. Not strictly typed. Lives in the callee; surfaced to every caller (FR-170). |
| `notor-flow-returns` | string | no | `null` | **Freeform** description of what the flow hands back to a caller (FR-170/173). |
| `notor-on-complete-flow` | wikilink \| null | no | `null` | Chaining: successor flow launched at the terminal event (one-way handoff, no return) (FR-175). |
| `notor-handoff-isolation` | `"isolated"` \| `"shared"` | no | `isolated` | Per-handoff scratchpad mode; `shared` inherits the parent's scratchpad and auto-allows its path (FR-174). |
| `notor-max-depth` | number \| null | no | `null` (unlimited *depth*) | Composition-depth guardrail (caps nesting/chaining) on `RunContext` (FR-176). `null` is acceptable: unlimited nesting depth is still bounded by the always-present iteration/cost/runtime ceilings, so only those three are defaulted. |
| `notor-max-cost-usd` | number | no | **`5.00`** (engine default; never absent at runtime) | Aggregate tree-wide USD cost ceiling on `RunContext` (FR-176). When omitted, the parser injects the finite default (never `Infinity`), so the cost fence is always active. |

> **All three runaway ceilings are defaulted, never `Infinity` (FR-117 / FR-119a).** Although
> `notor-max-iterations` / `notor-max-runtime-minutes` / `notor-max-cost-usd` are optional in
> frontmatter, the `FlowDefinitionParser` (FEAT-002) injects finite engine defaults
> (`100` / `60` / `5.00`, from `src/orchestration/constants.ts`) whenever a field is omitted — so a
> hand-authored flow can never run with no effective termination ceiling. This is what makes the
> "auto-terminate a stuck run" user story hold by construction even for a code-step-only flow (which
> decrements neither budget half and is bounded by the always-present `max-runtime-minutes`). See
> [data-model.md](../data-model.md) `OrchestrationFlow`.

**Note body is documentation only.** The Markdown body of `definition.md` is human-readable and is
**never injected into any LLM prompt** (FR-110 AC). Only the frontmatter drives engine behavior.

### Full YAML example

```yaml
---
notor-type: orchestration-flow
notor-flow-name: "Code Implementation"
notor-flow-description: "TDD implementation with planner, builder, verify, critic, finalizer"
notor-starting-event: build.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 100
notor-max-runtime-minutes: 240
notor-required-events:
  - review.approved
notor-fanout-topics: []   # e.g. [tasks.ready] to allow that one topic to drive >1 step in notor-steps order
notor-steps:
  - "[[planner]]"
  - "[[builder]]"
  - "[[verify-tests]]"
  - "[[critic]]"
  - "[[finalizer]]"
notor-guardrails:
  - "Verification is mandatory — tests must pass."
  - "YAGNI ruthlessly — no speculative features."
  - "Confidence >80: proceed autonomously; 50-80: document; <50: choose the safe default."
# --- Composition (Phase 7; inert unless orchestration_enabled) ---
notor-flow-invocable: true
notor-flow-inputs: "A natural-language description of the feature to implement, plus the target repo path."
notor-flow-returns: "A summary of what was implemented and the list of files changed."
notor-on-complete-flow: null
notor-handoff-isolation: isolated
notor-max-depth: 3
notor-max-cost-usd: 5.00
---

# Code Implementation Flow

Use this flow to implement features with TDD. Provide a description of what needs to be
implemented as the prompt. The flow runs planning → implementation → verification →
review → finalization automatically.

(This body is documentation only — it is never injected into a step's prompt.)
```

---

## Step Note Format

Step notes live under `{flow-dir}/steps/`. Each defines one step. Parsed into `StepDefinition`
([data-model.md](../data-model.md#stepdefinition)). The Markdown **body** is the step's instructions
(conversation mode) or the code (code mode).

### Frontmatter field table

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `notor-type` | `"orchestration-step"` | yes | — | Discriminator. |
| `notor-step-name` | string | yes | — | Display name (may include an emoji). |
| `notor-step-description` | string | no | `""` | Short description. |
| `notor-step-triggers` | string[] | yes | — | Event topics that activate this step. Each topic maps to **at most one step per flow** (FR-111 AC); ambiguous routing is rejected at load. |
| `notor-step-publishes` | string[] | yes | — | Event topics this step may emit. |
| `notor-step-default-publishes` | string \| null | no | `null` | Topic synthesized if a conversation step ends its turn without an emission (FR-115 AC). |
| `notor-step-persona` | string \| null | no | `null` | Persona name → system prompt, `<notor_tool_config>`, provider/model. Resolved via `PersonaManager.getPersonaByName()` (`src/personas/persona-manager.ts:106`) **without** mutating global state. Ignored in code mode. |
| `notor-step-model` | string \| null | no | `null` | Model override; takes precedence over the persona's model. |
| `notor-step-mode` | `"conversation"` \| `"code"` | no | `conversation` | Execution mode. `conversation` = LLM turn on the shared `RunLoop`; `code` = deterministic TypeScript, no LLM, no conversation. |
| `notor-step-mcp-servers` | string[] \| null | no | `null` | MCP servers active for this step (`null` = inherit all connected). |
| `notor-step-timeout-seconds` | number \| null | no | `null` (→ 300) | **Code steps only.** Outer timeout guard for the whole code-step async function (default **300 s**). Must exceed any inner `utils.executeShellCommand` `timeoutSeconds` or the outer guard kills the step first. Ignored in `conversation` mode. See [contracts/orchestration-helper.md](orchestration-helper.md). |

**Note body & `<include_note>`:** the Markdown body is injected into the `### 1. EXECUTE` section of
the step prompt scaffold (FR-114). The body may contain `<include_note>` tags to transclude other
vault notes (same mechanism as workflow bodies — see `resolveWorkflowIncludes` in
`src/workflows/workflow-executor.ts:98`).

### Example — conversation step

```yaml
---
notor-type: orchestration-step
notor-step-name: "📋 Planner"
notor-step-description: "Decomposes the objective and owns the task queue"
notor-step-triggers:
  - build.start
  - queue.advance
notor-step-publishes:
  - tasks.ready
  - FLOW_COMPLETE
notor-step-default-publishes: tasks.ready
notor-step-persona: planner-persona
notor-step-model: null
notor-step-mcp-servers: null
---

## PLANNER MODE

You own decomposition and queue progression. Do not implement. Do not review.

### Shared Documentation
Read `context.md` and `plan.md` in the session scratchpad before starting.
Write your decomposition to `plan.md` when complete.

<include_note>orchestrations/code-implementation/steps/_planner-rubric</include_note>

### Logic
1. Study the objective and any existing context.
2. Break the work into discrete, testable tasks (use `orchestration_task_ensure`).
3. Write the plan to the scratchpad.
4. Emit `tasks.ready` for the first task.
```

### Example — code step (`notor-step-mode: code`)

A code step uses the **same frontmatter schema** but declares `notor-step-mode: code` and places its
logic in the **first** `ts`/`typescript`/`js`/`javascript` code fence in the body. It creates no
conversation, consumes no tokens, and emits its next event by **returning** `orchestration.emit(...)`.
`notor-step-persona`/`notor-step-model` are ignored (no LLM call). Arg signature
`CODE_STEP_ARG_NAMES = ["app", "obsidian", "utils", "libs", "event", "orchestration"]` (compiled via
the existing `stripTypes()` + `AsyncFunction` pipeline at `src/extensions/compiler.ts:31`,`:76`). The
`orchestration` helper API is the authority of [contracts/orchestration-helper.md](orchestration-helper.md).

```yaml
---
notor-type: orchestration-step
notor-step-name: "🔍 Verify Tests"
notor-step-description: "Runs the test suite; routes on pass/fail"
notor-step-mode: code
notor-step-triggers:
  - build.done
notor-step-publishes:
  - tests.passed
  - tests.failed
notor-step-default-publishes: tests.failed
notor-step-mcp-servers: null
---

# Verify Tests

Runs `npm test` and routes based on the exit code. Replaces the legacy verification-step concept.

```typescript
const result = await utils.executeShellCommand("npm test", {
  cwd: event.payload, // repo path forwarded by the builder
  timeoutSeconds: 120,
});

// ShellExecuteResult.stdout is COMBINED stdout+stderr — there is no separate `stderr` field.
if (result.exitCode === 0 && !result.timedOut) {
  await orchestration.scratchpad.write("test-output.txt", result.stdout);
  return orchestration.emit("tests.passed", result.stdout);
}

return orchestration.emit("tests.failed", JSON.stringify({
  exitCode: result.exitCode,
  timedOut: result.timedOut,
  output: result.stdout,
}));
```
```

> A code step still writes `turn.start`/`turn.complete` to `session-log.jsonl` (audit + recovery). On
> a thrown error it fires `{notor-step-name}.code_error` with the stack and shows an error Notice
> while still logging the turn (FR-130 AC).

---

## `session.json` — Session Metadata

One per session at `sessions/{session-id}/session.json`. Shape is `OrchestrationSessionMeta`,
defined in [data-model.md](../data-model.md#sessionjson) — not redefined here. Field summary:

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | Matches the directory name. |
| `flow_name` | string | The flow's `notor-flow-name`. |
| `status` | `"active"` \| `"interrupted"` \| `"completed"` \| `"cancelled"` \| `"error"` | Recovery scans for `active`/`interrupted` (FR-125). |
| `iteration` | number | Current **step-turn / hop** count (display/sequence; **includes code steps**). This is the engine hop counter surfaced as `flow.iteration` and in the progress Notice — **not** the same unit as `notor-max-iterations` (which counts **LLM turns only**; see [run-loop.md](run-loop.md)). A code-step-heavy flow's `iteration` can climb well past `notor-max-iterations` without tripping it. |
| `active_step` | string \| null | Step currently executing (or last, on crash). |
| `started_at` | string | ISO timestamp. |
| `prompt` | string | The original user objective (injected into every step turn). |
| `parent_session_id` | string \| null | Composition linkage (FR-174). |
| `origin` | `"user"` \| `"run_flow"` \| `"chaining"` | **Always set at creation** (never null); the recovery discriminator. See [data-model.md](../data-model.md) `OrchestrationSessionMeta` and Parent-rooted recovery below. |

`status` is the recovery entry point; the authoritative replay source is `session-log.jsonl`.

---

## `session-log.jsonl` — Append-Only Turn + Event Log

The crash-recovery source of truth at `sessions/{session-id}/session-log.jsonl`. One JSON object per
line, written **by the engine** (never by step code). Newline-terminated, append-only. Written via the
`SessionLog` writer (FEAT-006).

**Malformed-line policy (recovery parser contract — FR-125 / TEST-005).** The replay parser tolerates
**only a malformed/truncated *final* line** — the expected crash signature of an append-only log (a
crash mid-append leaves a partial last line, treated as absent; the last *complete* entry governs). A
malformed line **in the interior** of the file (a torn non-atomic flush, an external sync/editor
touching the file) is **not** silently skipped or silently truncated-at: the parser **fails that
session's recovery loudly** — it surfaces a recovery error, marks the session `status: error`, and
offers the failure to the user — rather than dropping every entry after the bad line (which would
discard exactly the dangling `turn.start` / `event.emitted` tail that drives replay and silently
mis-recover the run). TEST-005 covers both the tolerated trailing-truncation case and an interior-
corruption case.

### Entry type table

| `type` | Written when | Key fields |
|---|---|---|
| `session.start` | Flow start, before the starting event | `session_id`, `flow`, `prompt`, `origin`, `parent_session_id`, `ts` |
| `event.emitted` | Immediately **before** an event is routed (write-before-route) | `turn`, `topic`, `payload`, `source_step`, `ts` |
| `turn.start` | **Before** the LLM call (conversation) or code execution (code) begins | `turn`, `step`, `trigger_topic`, `conversation_id` (null for code), `ts` |
| `side_effect.committed` | **After** a guarded side effect completes inside `orchestration.once(key, fn)` (FR-125) | `turn`, `step`, `key`, `ts` |
| `child.spawned` | **Before** a `run_flow` child is launched (FR-125 / FR-173 reuse anchor) | `turn`, `step`, `via_tool_call_id`, `child_session_id`, `ts` |
| `child.result` | **After** a `run_flow` child returns, **before** the parent turn continues | `turn`, `child_session_id`, `stop_reason`, `structured` (or null), `text`, `ts` |
| `turn.complete` | **After** the emitted event is captured (or `default_publishes` synthesized) | `turn`, `step`, `emitted_topic`, `conversation_id`, **`cost_usd`**, **`token_usage`** `{input,output}`, `ts` |
| `event.emission_overwritten` | A step's captured `pendingEmission` was **replaced** within a turn (audit; terminal-emit latch — [contracts/tools.md](tools.md)) | `turn`, `step`, `prev_topic`, `new_topic`, `ts` |
| `user.input.required` | A step emits the pausing event (FR-150) | `turn`, `step`, `prompt`, `ts` |
| `user.input.received` | The user supplies input and the loop resumes | `turn`, `payload`, `ts` |
| `session.cancelled` | `FLOW_CANCELLED` terminates the loop (FR-132) | `reason` (the payload), `ts` |
| `session.complete` | `notor-completion-event` finalizes the flow (FR-123 satisfied) | `ts` |

> **`turn.complete` carries per-turn cost/tokens (FR-125 budget reconstruction).** `cost_usd` (via
> `calculateCost`, [run-loop.md](run-loop.md)) and `token_usage` are recorded on every `turn.complete`
> so recovery can **rebuild the in-memory `AggregateBudget` cell and the run-tree header rollup** by
> replaying decrements — the aggregate cost/iteration ceiling and the rollup therefore survive a
> reload instead of silently resetting to full. A code step's `turn.complete` records
> `cost_usd: 0` / zero tokens (it is not an LLM turn).
>
> **`child.spawned` / `child.result` make a `run_flow` child re-usable across a crash.** A parent turn
> that invokes `run_flow` writes `child.spawned` before launching and `child.result` (the child's
> `structured`/`text` + `stop_reason`) when it returns. On recovery (Parent-rooted recovery, below),
> a re-run parent reuses a **terminal** child's recorded `child.result` instead of re-spawning — the
> durable artifact the earlier "reuse the child's recorded result" rule referenced but never persisted.

### Enforced write order (recovery invariant)

The order below is **mandatory** — recovery replay depends on it (FR-112, FR-125):

1. **`turn.start` before any LLM call or code execution.** A dangling `turn.start` with no matching
   `turn.complete` ⇒ the turn was interrupted ⇒ recovery re-emits the trigger (the step retries from
   fresh context).
2. **`turn.complete` after the emitted event is captured** (and after `default_publishes` synthesis,
   if the turn produced no emission). It records the topic that will be published next.
3. **`event.emitted` before the event is routed** — *write-before-route* (FR-112 AC). A dangling
   `event.emitted` with no following `turn.start` ⇒ the event was logged but not routed ⇒ recovery
   re-publishes it. Replay is idempotent (FR-125 AC).
4. **`side_effect.committed` after a guarded side effect lands** (within `orchestration.once`, FR-125).
   Recovery's at-least-once replay consults committed `key`s: when a re-run step calls
   `orchestration.once(key, fn)` for an already-committed `key`, `fn` is **skipped**. This is
   **best-effort**, not exactly-once — a crash *between* the external effect and this append can still
   re-run the effect (the irreducible window). Authority for the helper:
   [contracts/orchestration-helper.md](orchestration-helper.md) (At-least-once recovery). Recovery is
   **at-least-once**: a step with non-idempotent external effects must be idempotent or guard itself
   with `once(...)`.
5. **`child.spawned` before launching a `run_flow` child; `child.result` after it returns, before the
   parent turn continues.** `child.spawned` is the recovery anchor that lets a re-run parent find the
   child it previously spawned (matched by `via_tool_call_id` / occurrence order); `child.result`
   durably records the child's `structured`/`text` + `stop_reason` so a **terminal** child's result is
   *reused* on re-run rather than re-spawned. A `child.spawned` with no matching `child.result` ⇒ the
   child was non-terminal at crash ⇒ recovery **resumes that child session in place** (replaying its
   own log) and awaits its result — it is **not** tombstoned-and-respawned (see Parent-rooted recovery).
6. **`turn.complete` records `cost_usd` + `token_usage`** so recovery rebuilds the `AggregateBudget`
   cell and run-tree rollup by replaying decrements (budget survives reload). The safety guards' rolling
   stale window and per-task thrashing counters are likewise **rehydrated** from the replayed
   `event.emitted` / task history before the run resumes — so a near-stale self-loop is not reset by a
   reload (see Parent-rooted recovery, "State rehydration").

Sequence per step turn: `turn.start` → (LLM/code runs; `side_effect.committed` per guarded effect;
`child.spawned`/`child.result` per `run_flow` call) → `turn.complete` (with `cost_usd`/`token_usage`)
→ `event.emitted` → (route).

### Parent-rooted recovery (no duplicate child runs — FR-125)

Recovery is **parent-rooted**, with one explicit addition for chaining. The load-time scan selects a
session to recover by its `session.json` `origin` (always set — see [data-model.md](../data-model.md)):

| `origin` | Recovered by the top-level scan? | Lifecycle owner |
|---|---|---|
| `"user"` | **Yes**, always | itself (a root run) |
| `"chaining"` | **Yes, iff** its `parent_session_id` resolves to an **already-terminal** predecessor | itself (the predecessor finalized — there is no live parent; see below) |
| `"run_flow"` | **No** | its parent turn's replay (reuse / resume; see below) |
| `"chaining"` with a **non-terminal** parent | **No** | its parent's replay (the rare case the parent is still alive) |
| *absent / any other value* | **No, but surfaced as a recovery error** (loud, never silent) — offered as resume-as-root | n/a (a defaulting/write bug) |

**Why chaining must be a recovery root once its predecessor finalized.** Chaining
(`notor-on-complete-flow`, FR-175) is a **one-way, fire-and-forget** handoff: the predecessor
**finalizes** (status `completed`) *before* the successor launches, and the successor has **no
awaiting tool call** (its `child` edge omits `via_tool_call_id` — [edges.md](edges.md)). So unlike a
`run_flow` child, a chained successor has **no live parent turn to replay** — the predecessor is done.
If the scan excluded it, a crash mid-successor would leave a permanently abandoned `active`/`interrupted`
session (the orphan the parent-rooted model exists to prevent, reappearing for chaining). Therefore the
scan **does** recover an `origin: "chaining"` session whose `parent_session_id` points at an
already-terminal predecessor, treating it as its own root. Its `parent`/`child` edges are retained for
run-tree lineage only; recovery treats it as a root. Wiring: INT-005 (scan + chaining-root rule).

**`run_flow` child reconciliation (reuse a terminal child; resume a non-terminal one).** A `run_flow`
child (`origin: "run_flow"`) is reconciled when its **parent step turn** is replayed. The parent turn's
`child.spawned` / `child.result` log entries make this deterministic:

- **Terminal child (`completed`/`cancelled`) → reuse, do not re-spawn.** The parent's re-run finds the
  `child.spawned` for the `run_flow` call (matched by `via_tool_call_id` / occurrence order) and the
  matching `child.result`, and **feeds the recorded result back** to the re-run in place of a fresh
  spawn. This is the durable artifact the rule depends on — the child's `structured`/`text` +
  `stop_reason` live in `child.result`, so "reuse the child's recorded result" is literally backed by
  the log (closing the earlier "reuse has nothing to reuse" gap).
- **Non-terminal child → resume in place, do not tombstone-and-respawn.** A `child.spawned` with no
  matching `child.result` means the child was interrupted. Recovery **resumes that same child session**
  by replaying *its own* `session-log.jsonl` (re-running only its dangling tail), then awaits its
  completion and consumes its result. The child keeps its session id and its log, so its
  `side_effect.committed` markers **survive natively** — `once(...)` therefore dedupes correctly across
  the crash with **no** cross-session key needed. (The earlier "tombstone the stale child and re-spawn
  a fresh one" rule is **removed**: a fresh child got an empty log, so every `once()`-guarded external
  effect the interrupted child had already committed would re-run — a duplicate-effect hole. Resuming
  the child in place eliminates it.)

This preserves the no-double-execution invariant — a `run_flow` child is still **never** recovered
independently by the top-level scan; the parent orchestrates its reuse-or-resume — while making
`once()` truthful across recovery (Issue-2 fix) and giving "reuse" a real artifact (Issue-1 fix).

**State rehydration on recovery (budget + safety guards).** Before a resumed run continues, recovery
reconstructs the engine's in-memory runtime state from the replayed log, so it is not silently reset:

- the **`AggregateBudget` cell** is re-seeded from the flow's ceilings (the defaulted finite values)
  and then **decremented by replaying each `turn.complete`'s `cost_usd` / `token_usage`** — so the
  cost/iteration ceiling and the run-tree header rollup reflect pre-crash spend (a `$5.00` cap resumed
  mid-run does not reset to `$5.00`);
- the **stale-loop rolling window** (last 5 `(topic, source_step)` pairs) and the **per-task
  thrashing/abandonment counters** are rebuilt from the replayed `event.emitted` / task history — so a
  self-loop at 3 of 4 strikes before a reload fires on the **next** repeat, not 4 more.

Wiring: INT-005 (root-only + chaining-root scan, malformed-line policy, `child.spawned`/`child.result`
classification, resume-in-place, state rehydration) → INT-044 (composition: parent-replay reuse/resume).

### Sample lines

```jsonl
{"type":"session.start","session_id":"abc123","flow":"code-implementation","prompt":"implement --verbose flag","origin":"user","parent_session_id":null,"ts":"2026-06-27T10:00:00Z"}
{"type":"event.emitted","turn":1,"topic":"build.start","payload":"implement --verbose flag","source_step":null,"ts":"2026-06-27T10:00:00Z"}
{"type":"turn.start","turn":2,"step":"📋 Planner","trigger_topic":"build.start","conversation_id":"conv-uuid-1","ts":"2026-06-27T10:00:01Z"}
{"type":"turn.complete","turn":2,"step":"📋 Planner","emitted_topic":"tasks.ready","conversation_id":"conv-uuid-1","cost_usd":0.0123,"token_usage":{"input":4200,"output":900},"ts":"2026-06-27T10:00:42Z"}
{"type":"event.emitted","turn":2,"topic":"tasks.ready","payload":"{\"task\":\"step-01-impl\"}","source_step":"📋 Planner","ts":"2026-06-27T10:00:42Z"}
{"type":"turn.start","turn":3,"step":"🔍 Verify Tests","trigger_topic":"build.done","conversation_id":null,"ts":"2026-06-27T10:05:10Z"}
{"type":"turn.complete","turn":3,"step":"🔍 Verify Tests","emitted_topic":"tests.failed","conversation_id":null,"cost_usd":0,"token_usage":{"input":0,"output":0},"ts":"2026-06-27T10:05:31Z"}
{"type":"event.emitted","turn":3,"topic":"tests.failed","payload":"{\"exitCode\":1}","source_step":"🔍 Verify Tests","ts":"2026-06-27T10:05:31Z"}
{"type":"session.complete","ts":"2026-06-27T10:20:00Z"}
```

> Note the code step (turn 3, 🔍 Verify Tests) records `cost_usd: 0` and zero tokens — it is not an
> LLM turn. A `run_flow` parent turn would additionally bracket `child.spawned` … `child.result`
> entries between its `turn.start` and `turn.complete`.

---

## Task Note (`tasks/{key}.md`)

The runtime task registry (FR-122). One note per task at `sessions/{session-id}/tasks/{key}.md`,
maintained by the four task tools (`orchestration_task_ensure`/`_start`/`_close`/`_list`, INT-002).
Frontmatter only; the body is free-form notes. Frontmatter injected/updated via the existing
`injectWorkflowFrontmatter`-style helper (`src/workflows/workflow-frontmatter.ts:15`).

### Frontmatter field table

| Field | Type | Notes |
|---|---|---|
| `notor-type` | `"orchestration-task"` | Discriminator. |
| `notor-task-status` | `"open"` \| `"running"` \| `"closed"` | `ensure` creates `open`; `_start` → `running`; `_close` → `closed`. |
| `notor-task-key` | string | Unique key (matches the filename); `ensure` is idempotent on it (FR-122 AC). |
| `notor-task-created` | ISO timestamp | Set on `ensure`. |
| `notor-task-started` | ISO timestamp \| null | Set on `_start`. |
| `notor-task-completed` | ISO timestamp \| null | Set on `_close`. |

`FLOW_COMPLETE` is rejected and re-triggered as `flow.tasks_remaining` while any task is `open` or
`running` (FR-123); `FLOW_CANCELLED` bypasses this (FR-132).

### Example

```yaml
---
notor-type: orchestration-task
notor-task-status: running
notor-task-key: step-01-impl
notor-task-created: 2026-06-27T10:00:42Z
notor-task-started: 2026-06-27T10:01:00Z
notor-task-completed: null
---

Implement the `--verbose` flag in the CLI entry point.
```

---

## `memories.md` — Persistent Cross-Session Memory

A single plain note at `{notor_dir}/orchestrations/memories.md` (FR-124), **not** under any session.
Seeded on first use. The `StepPromptBuilder` (FR-114) instructs every step to consult it before
acting in unfamiliar territory and to append fix-memories when blocked. **Free-form; not parsed
structurally** — it is read/appended as plain Markdown. Conventional sections:

```markdown
# Orchestration Memories

## Patterns
- Verify before reporting done; a code step after each builder turn catches regressions cheaply.

## Decisions
- The scratchpad is the only cross-step state channel; never rely on conversation context.

## Fixes
- `npm test` needs `cwd` set to the repo root forwarded in the event payload, not the vault.

## Context
- The target repo lives outside the vault; use `utils.executeShellCommand` with an absolute `cwd`.
```

---

## Cross-references to other contracts

These formats are persisted into the **chat conversation** JSONL (not the orchestration session
files) and are therefore owned by other contracts — do not duplicate them here:

- **Conversation header extensions** (`_type: "orchestration_step_conversation"`,
  `orchestration_session_id`/`_flow_name`/`_step_name`/`_iteration`, the `orchestration_edges` typed
  adjacency list, and the hidden-from-list filter): [contracts/edges.md](edges.md).
- **`child_run_metadata`** (the shared `use_subagent`/`run_flow` rollup block on `ToolResult`):
  [contracts/edges.md](edges.md).
- **`RunContext` / `RunResult` / two-layer limit decision rule / `RunLoop` hook semantics**:
  [contracts/run-loop.md](run-loop.md).
- **`OrchestrationHelper` runtime API** consumed by code steps: [contracts/orchestration-helper.md](orchestration-helper.md).
