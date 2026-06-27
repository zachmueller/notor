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
          scratchpad/                    # shared, restriction-free cross-step working dir
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
| `notor-max-iterations` | number | no | — | Aggregate tree-wide turn ceiling (see [contracts/run-loop.md](run-loop.md)); a safety limit on total step turns. |
| `notor-max-runtime-minutes` | number | no | — | Wall-clock runtime cap (FR-117). |
| `notor-required-events` | string[] | no | `[]` | Events that must have been seen before `notor-completion-event` is accepted. |
| `notor-steps` | wikilink[] | yes | — | Ordered step references (`"[[planner]]"`), resolved under `steps/`. Order is the multi-subscriber tie-break (FR-112). |
| `notor-guardrails` | string[] | no | `[]` | Constraints injected into **every** step prompt (FR-114). |
| **Composition fields (design Phase 7; inert unless feature group enabled):** | | | | |
| `notor-flow-invocable` | boolean | no | `false` | Opt-in: the flow appears in the `run_flow` registry and may be called as a tool by other flows' steps (FR-171/172). |
| `notor-flow-inputs` | string | no | `null` | **Freeform natural-language** description of what the flow expects to begin. Not strictly typed. Lives in the callee; surfaced to every caller (FR-170). |
| `notor-flow-returns` | string | no | `null` | **Freeform** description of what the flow hands back to a caller (FR-170/173). |
| `notor-on-complete-flow` | wikilink \| null | no | `null` | Chaining: successor flow launched at the terminal event (one-way handoff, no return) (FR-175). |
| `notor-handoff-isolation` | `"isolated"` \| `"shared"` | no | `isolated` | Per-handoff scratchpad mode; `shared` inherits the parent's scratchpad and auto-allows its path (FR-174). |
| `notor-max-depth` | number \| null | no | `null` | Composition-depth guardrail (caps nesting/chaining) on `RunContext` (FR-176). |
| `notor-max-cost-usd` | number \| null | no | `null` | Aggregate tree-wide USD cost ceiling on `RunContext` (FR-176). |

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
  timeout: 120000,
});

if (result.exitCode === 0) {
  await orchestration.scratchpad.write("test-output.txt", result.stdout);
  return orchestration.emit("tests.passed", result.stdout);
}

return orchestration.emit("tests.failed", JSON.stringify({
  exitCode: result.exitCode,
  stderr: result.stderr,
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
| `iteration` | number | Current turn count. |
| `active_step` | string \| null | Step currently executing (or last, on crash). |
| `started_at` | string | ISO timestamp. |
| `prompt` | string | The original user objective (injected into every step turn). |
| `parent_session_id` | string \| null | Composition linkage (FR-174). |
| `origin` | `"user"` \| `"run_flow"` \| `"chaining"` \| null | How this session was launched. |

`status` is the recovery entry point; the authoritative replay source is `session-log.jsonl`.

---

## `session-log.jsonl` — Append-Only Turn + Event Log

The crash-recovery source of truth at `sessions/{session-id}/session-log.jsonl`. One JSON object per
line, written **by the engine** (never by step code). Newline-terminated, append-only; a truncated
trailing line is tolerated by the recovery replay (FR-125 / TEST-005). Written via the `SessionLog`
writer (FEAT-006).

### Entry type table

| `type` | Written when | Key fields |
|---|---|---|
| `session.start` | Flow start, before the starting event | `session_id`, `flow`, `prompt`, `ts` |
| `event.emitted` | Immediately **before** an event is routed (write-before-route) | `turn`, `topic`, `payload`, `source_step`, `ts` |
| `turn.start` | **Before** the LLM call (conversation) or code execution (code) begins | `turn`, `step`, `trigger_topic`, `conversation_id` (null for code), `ts` |
| `turn.complete` | **After** the emitted event is captured (or `default_publishes` synthesized) | `turn`, `step`, `emitted_topic`, `conversation_id`, `ts` |
| `user.input.required` | A step emits the pausing event (FR-150) | `turn`, `step`, `prompt`, `ts` |
| `user.input.received` | The user supplies input and the loop resumes | `turn`, `payload`, `ts` |
| `session.cancelled` | `FLOW_CANCELLED` terminates the loop (FR-132) | `reason` (the payload), `ts` |
| `session.complete` | `notor-completion-event` finalizes the flow (FR-123 satisfied) | `ts` |

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

Sequence per step turn: `turn.start` → (LLM/code runs) → `turn.complete` → `event.emitted` → (route).

### Sample lines

```jsonl
{"type":"session.start","session_id":"abc123","flow":"code-implementation","prompt":"implement --verbose flag","ts":"2026-06-27T10:00:00Z"}
{"type":"event.emitted","turn":1,"topic":"build.start","payload":"implement --verbose flag","source_step":null,"ts":"2026-06-27T10:00:00Z"}
{"type":"turn.start","turn":2,"step":"📋 Planner","trigger_topic":"build.start","conversation_id":"conv-uuid-1","ts":"2026-06-27T10:00:01Z"}
{"type":"turn.complete","turn":2,"step":"📋 Planner","emitted_topic":"tasks.ready","conversation_id":"conv-uuid-1","ts":"2026-06-27T10:00:42Z"}
{"type":"event.emitted","turn":2,"topic":"tasks.ready","payload":"{\"task\":\"step-01-impl\"}","source_step":"📋 Planner","ts":"2026-06-27T10:00:42Z"}
{"type":"turn.start","turn":3,"step":"🔍 Verify Tests","trigger_topic":"build.done","conversation_id":null,"ts":"2026-06-27T10:05:10Z"}
{"type":"turn.complete","turn":3,"step":"🔍 Verify Tests","emitted_topic":"tests.failed","conversation_id":null,"ts":"2026-06-27T10:05:31Z"}
{"type":"event.emitted","turn":3,"topic":"tests.failed","payload":"{\"exitCode\":1}","source_step":"🔍 Verify Tests","ts":"2026-06-27T10:05:31Z"}
{"type":"session.complete","ts":"2026-06-27T10:20:00Z"}
```

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
