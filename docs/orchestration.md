# Orchestration

Orchestration flows are multi-step, event-driven pipelines that run a sequence of **conversation steps** (LLM turns) and **code steps** (deterministic TypeScript) to a terminal event — with cascading guardrails on depth, iterations, cost, and runtime, plus crash-recovery. A flow is authored as plain Obsidian notes and run from the command palette or a hook.

> **Feature group.** Orchestration is gated behind a master toggle and is **completely absent** when disabled — no command, no tool scaffolds, no run-tree view. Enable it under **Settings → Notor → Orchestration** ([Open Orchestration](notor-settings://Orchestration)). Enabling it also seeds the `orchestrations/` directory and the three reference flows, and makes the `orchestration-creator` persona's flows runnable.

## Enabling the feature group

Toggle **Enable orchestration** under [Settings → Notor → Orchestration](notor-settings://Orchestration). When enabled, Notor:

- creates `{notor_dir}/orchestrations/` and materializes the reference flows (`code-assist`, `research`, `review`) — preserving any edits you've made on subsequent enables;
- registers the orchestration tool scaffolds (`emit_event`, `run_flow`, and the four `orchestration_task_*` tools) and the **Notor: Run orchestration** command;
- enables the unified **run-tree view** and the `flow-run` entries in the activity indicator.

Toggling it off removes the command and all scaffolds after the extension reload. (Authoring a flow with the `orchestration-creator` persona works regardless — only *running* a flow needs the group on.)

## Anatomy of a flow

A flow is a directory under `{notor_dir}/orchestrations/{flow-name}/`:

```
{notor_dir}/orchestrations/{flow-name}/
  definition.md        # flow topology, loop config, guardrails, composition (frontmatter only)
  steps/
    planner.md         # a conversation step
    verify-tests.md    # a code step (notor-step-mode: code)
    ...
```

Steps communicate **only by publishing events**. A step is triggered by a topic, does its work, and emits exactly one next topic. The engine routes each topic to the single step that triggers on it (one topic → one step by default). The body of `definition.md` is documentation and is **never injected into any prompt** — only the frontmatter drives the engine.

### `definition.md` frontmatter

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `notor-type` | `orchestration-flow` | yes | — | Discriminator; gates discovery. |
| `notor-flow-name` | string | yes | — | Display name (picker, conversation titles). |
| `notor-flow-description` | string | yes | — | Short description for the picker. |
| `notor-starting-event` | string | yes | — | First event published when the flow starts. |
| `notor-completion-event` | string | no | `FLOW_COMPLETE` | Terminal event; subject to task enforcement. |
| `notor-max-iterations` | number | no | `100` | Aggregate tree-wide ceiling on **LLM turns**. |
| `notor-max-runtime-minutes` | number | no | `60` | Wall-clock runtime cap. |
| `notor-required-events` | string[] | no | `[]` | Events that must be seen before completion is accepted. |
| `notor-fanout-topics` | string[] | no | `[]` | Topics explicitly allowed to route to **more than one** step (ordered). |
| `notor-steps` | wikilink[] | yes | — | Ordered step references (`"[[planner]]"`), resolved under `steps/`. |
| `notor-guardrails` | string[] | no | `[]` | Constraints injected into **every** step prompt. |
| `notor-schedule` | string (cron) | no | `null` | Standard 5-field cron expression; launches the flow on a schedule (see below). Invalid expressions are ignored with a warning. |
| `notor-flow-invocable` | boolean | no | `false` | The flow appears in the `run_flow` registry (callable by other flows). |
| `notor-flow-inputs` | string | no | `null` | Freeform NL description of what the flow expects to begin. |
| `notor-flow-returns` | string | no | `null` | Freeform NL description of what the flow hands back. |
| `notor-on-complete-flow` | wikilink \| null | no | `null` | Chaining successor launched at the terminal event (one-way handoff). |
| `notor-handoff-isolation` | `isolated` \| `shared` | no | `isolated` | `shared` inherits the parent's scratchpad. |
| `notor-max-depth` | number \| null | no | `null` | Composition-depth cap (`null` = unlimited depth). |
| `notor-max-cost-usd` | number | no | `5.00` | Aggregate tree-wide USD cost ceiling. |
| `notor-open-notes-in-editor` | boolean | no | _(global setting)_ | Open each note this flow's steps read/write in the editor. Omit to inherit the global **Settings → Orchestration → "Open notes in editor"** toggle (default off); set `true`/`false` to force it for this flow, independent of the General "Open notes on access" chat setting. |

> **Every flow is bounded by construction.** `notor-max-iterations`, `notor-max-runtime-minutes`, and `notor-max-cost-usd` are optional in frontmatter but **never absent at runtime** — the parser injects finite defaults (`100` / `60` / `5.00`, never `Infinity`). So even a hand-authored flow that sets nothing auto-terminates.

> **Scheduling a flow.** A flow with a valid `notor-schedule` cron expression launches itself on that schedule (each run stamped `origin: schedule`) and appears in **Settings → Automations** under "Scheduled" — with a next-run time, an active/inactive status dot, and a per-flow enable toggle — exactly like a scheduled workflow. Direct scheduling requires the orchestration feature group to be enabled. For **event-driven** triggers (on-save, on-tag-change, …) wire a "Run an orchestration" action under **Settings → Vault Event Hooks** instead.

### Step note frontmatter

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `notor-type` | `orchestration-step` | yes | — | Discriminator. |
| `notor-step-name` | string | yes | — | Display name (may include an emoji). |
| `notor-step-description` | string | no | `""` | Short description. |
| `notor-step-triggers` | string[] | yes | — | Topics that activate this step (≤1 step per topic per flow). |
| `notor-step-publishes` | string[] | yes | — | Topics this step may emit. |
| `notor-step-default-publishes` | string \| null | no | `null` | Topic synthesized if a conversation step ends with no emission. |
| `notor-step-persona` | string \| null | no | `null` | Persona → system prompt, tools, provider/model. Ignored in code mode. |
| `notor-step-model` | string \| null | no | `null` | Model override (takes precedence over the persona's model). |
| `notor-step-mode` | `conversation` \| `code` | no | `conversation` | `conversation` = LLM turn; `code` = deterministic TypeScript. |
| `notor-step-mcp-servers` | string[] \| null | no | `null` | MCP servers active for this step (`null` = inherit all). |
| `notor-step-timeout-seconds` | number \| null | no | `null` (→ 300) | **Code steps only.** Outer timeout for the code-step function. |

The body of a **conversation step** is its instructions (injected into the prompt's EXECUTE section, alongside the always-injected objective, event history, scratchpad path, guardrails, and must-publish rule). The body may use `<include_note>` tags. For a **code step**, the first `ts`/`typescript`/`js`/`javascript` fence is the code that runs.

## Conversation steps

A conversation step runs one LLM turn driven by its persona. The engine **always** injects a must-publish rule: the step MUST call `emit_event` with exactly one of its `notor-step-publishes` topics — narrative text alone never counts. If the step ends its turn without emitting, the engine synthesizes its `notor-step-default-publishes` topic so the loop never stalls.

> **Conversation steps read/write Markdown only.** A conversation step has no `orchestration.scratchpad` helper — it touches the scratchpad through its normal note tools (`read_note` / `write_note`), which handle **Markdown (`.md`) only**. Non-Markdown coordination files (e.g. a `.json` manifest) are written and read by **code steps**; a conversation step receives whatever it needs from such a file via the **incoming event payload** — it must not `read_note` a `.json` (that errors). When a downstream conversation step needs structured state a code step produced, have the code step assemble it into the event payload (the reference flows and the `notor-usage-miner` example follow this pattern).

## Code steps

A code step (`notor-step-mode: code`) runs deterministic TypeScript with **no LLM call, no conversation, and zero tokens**. Use one for verification, conditional/multi-way routing, pre-flight checks, data-fetch, notifications, aggregation, and the reliable **structured return** of an invocable flow. The step routes by its **return value**.

The code receives the same arg signature as a snippet of a user-defined tool, plus two orchestration-specific args:

```
[app, obsidian, utils, libs, event, orchestration]
```

- `app` / `obsidian` / `utils` / `libs` are **identical** to user-defined tools (`utils.executeShellCommand`, `utils.notify`, etc. — see [Extensions](extensions.md)).
- `event` — `{ topic, payload, source_step }`, the incoming trigger (payload is a string; JSON-encode structured data).
- `orchestration` — the code-step helper:

| Member | What it does |
|---|---|
| `emit(topic, payload?, structured?)` | The **only** way a code step routes the next event — you MUST `return` it. On a **terminal** emit, the optional 3rd `structured` arg is the typed return a `run_flow` caller receives in preference to `text`. |
| `once(key, fn)` | At-least-once guard for non-idempotent external effects (git push, Slack post, deploy). Runs `fn` once, records it, and **skips** it on a recovery re-run. |
| `scratchpad.{read,write,list,exists}` | The shared cross-step working dir. **Overwrite-only** — there is no `append`. |
| `callTool(name, params)` / `callMcpTool(server, tool, params)` | Dispatch a built-in / MCP tool, threading the step's depth + budget + abort (so a code-step `run_flow` is depth/budget-gated identically to an LLM-step one). |
| `tasks.{list,ensure,start,close}` | The runtime task registry (same backing as the task tools). |
| `flow` | `{ name, iteration, sessionId }` — read-only flow/session metadata. |
| `eventHistory(limit?)` | Recent event history for the session. |

> **`callTool` returns a string — JSON for structured tools.** `callTool` / `callMcpTool` always resolve to a **`string`** (and **throw** on dispatch failure — an uncaught throw becomes `{step}.code_error`). For tools that return structured data the string is `JSON.stringify`'d, so you must **`JSON.parse`** it (`search_chat_history`, `read_chat_history`, `search_vault`, `list_vault`, `read_frontmatter`, `orchestration_task_list`); tools that return prose (`read_note`, `get_backlinks`, …) are used directly. Confirm a tool's exact output shape before consuming it — read its definition (user tools live at `{notor_dir}/tools/{name}.md`; for a built-in, open it from Settings → Tools to materialize the same file) or ask the `notor-help` sub-agent. The `orchestration-creator` persona walks you through this.

A worked verify step:

````markdown
---
notor-type: orchestration-step
notor-step-name: "🔍 Verify Tests"
notor-step-mode: code
notor-step-triggers: [build.done]
notor-step-publishes: [tests.passed, tests.failed]
notor-step-default-publishes: tests.failed
---

```typescript
const result = await utils.executeShellCommand("npm test", {
  cwd: event.payload,        // repo path forwarded by the builder
  timeoutSeconds: 120,
});
// ShellExecuteResult.stdout is COMBINED stdout+stderr (no separate stderr field).
if (result.exitCode === 0 && !result.timedOut) {
  return orchestration.emit("tests.passed", event.payload);
}
return orchestration.emit("tests.failed", JSON.stringify({ exitCode: result.exitCode, output: result.stdout }));
```
````

A thrown error fires a `{step}.code_error` event (with the stack) and shows an error Notice, while still logging the turn.

> **⚠️ Code-step timeout caveat.** Code steps run as `AsyncFunction` on Obsidian's **main event-loop thread** — there is no Worker isolation in v1. The timeout (default 300 s, overridable via `notor-step-timeout-seconds`) fires **only at `await` boundaries**. An unbounded *synchronous* loop (`while (true) {}`, a long CPU-bound loop with no `await`) is **not interruptible** and freezes the whole plugin. Always insert `await` yield points in long loops and bound iteration counts. The outer step timeout must exceed any inner `utils.executeShellCommand` `timeoutSeconds`.

### Verification + routing discipline

The engine has **no semantic verifier** — a step that emits its success topic is taken at face value (a `completed`-but-wrong emission still advances the flow). The division of labor is: **conversation steps do work; code steps verify it.** Place a code-step verifier on a step's output edge (`[Builder] → [Verify Tests] → tests.passed / tests.failed`), and route distinct outcomes through **distinct topics** driven by a deterministic code-step router rather than re-firing one topic.

## Session workspace

Each run gets a session directory under `{notor_dir}/orchestrations/sessions/{session-id}/`:

- `session.json` — the run's status (`active` / `interrupted` / `completed` / `cancelled` / `error`), iteration, active step, origin, and parent linkage.
- `session-log.jsonl` — the append-only, write-before-route turn + event log (the crash-recovery source of truth).
- `scratchpad/` — the restriction-free shared working dir for cross-step state. Its path is auto-allowed for the session's steps. **Write overwrite-only** (write the complete current content, or a per-iteration filename) — recovery re-runs a step from fresh context, so an *append* would duplicate content.
- `tasks/` — the runtime task registry (`orchestration_task_ensure` / `_start` / `_close` / `_list`). `FLOW_COMPLETE` is rejected and re-triggered while any task is `open`/`running`; `FLOW_CANCELLED` bypasses this.

A persistent cross-session note, `{notor_dir}/orchestrations/memories.md`, is seeded on first use; the prompt scaffold instructs every step to consult it before acting in unfamiliar territory and append fix-memories when blocked.

### Debugging failed runs

The per-session `session.json` / `session-log.jsonl` are raw machine state — useful but not browsable. Enable **Write failed-run debug notes** ([Settings → Notor → Orchestration](notor-settings://Orchestration)) and any run that ends in `error` also writes a human-readable Markdown report to `{notor_dir}/orchestrations/failures/{flow-slug}-{session-id}.md`. The note distils data already captured — the objective, the failure reason (the terminal `FLOW_ERROR` payload), the failing step + stack (from the `{step}.code_error` event), and a compact turn-by-turn timeline — plus pointers to the raw session files. Open it, or `@`-reference it in a Notor chat, to debug the run. The setting is **off by default** and read at finalize time (no extension reload needed); the note carries `notor-type: orchestration-failure-report` so flow discovery ignores it.

## Running a flow

Open the command palette → **Notor: Run orchestration**, pick a flow, and enter an objective. After each step turn a brief progress **Notice** names the flow, step, and iteration (right-click a Notice on desktop to jump into that step's conversation).

> **Iteration counter.** The `iteration N` shown in Notices (and `session.json`'s `iteration`) is the **step-turn / hop counter, which includes code steps** — it is **not** the same unit as `notor-max-iterations`, which counts **LLM turns only**. A code-step-heavy flow's hop counter can climb well past `notor-max-iterations` without tripping it (such flows are bounded by `notor-max-runtime-minutes` + stale-loop detection instead).

A flow can also be launched unattended by a **hook** with the `run_orchestration` action type (Settings → Notor → Hooks), stamped `origin: "hook"`.

Each step turn creates its own conversation, but step conversations are **hidden from the flat conversation sidebar** (the run-tree is their only surface).

## The run-tree view

The **run-tree view** is the unified, navigable tree of a run — orchestration steps (via conversation edges) **and** sub-agents (via the sub-agent parent link), in one collapsible hierarchy. Open it from:

- the **"Open run tree"** affordance on a `run_flow` / `use_subagent` tool-call card (which also shows an inline peek: the direct child's summary + aggregate rollup);
- a **flow-run entry** in the activity indicator;
- (selecting a node loads that node's conversation in the main chat).

The view is **live** while a run is active (updating as turns complete) and **static** once it finishes; a recovered run re-attaches its live subscription. It tolerates dangling edges (a crash-recovery re-run mints new conversation ids) by rendering only resolvable edges.

## Composition

A flow can call another flow two ways:

- **`run_flow` (call/return).** A step (conversation or code) invokes another **invocable** flow (`notor-flow-invocable: true`) as a tool. It runs the callee to its terminal event on a **child session**, then returns the child's result — **preferring `structured`** (populated only by a terminal **code step**'s `emit(topic, payload, structured)`), falling back to the closing `text` (shaped by the callee's `notor-flow-returns`). `run_flow` is **orchestration-context-only** — it returns `success: false` from foreground chat, so a parentless, unrecoverable child flow can never exist. The child links into the parent's recovery tree via `parent_session_id`; `isolated` (default) gives it a fresh scratchpad, `shared` inherits the parent's.
- **Chaining (`notor-on-complete-flow`, one-way handoff).** At the terminal event the successor launches **instead of returning** — the chain *is* the end of the predecessor. The engine injects the successor's `notor-flow-inputs` into the predecessor's terminal step so it shapes the forwarded payload.

### Cascading guardrails

Composition guardrails are **aggregate** across the whole flow tree, held on a single **shared budget cell** referenced by every descendant run:

- A child spawn (or chaining handoff) proceeds only if `depth < notor-max-depth` **AND** the shared aggregate budget has headroom (`max_iterations` and `max_cost_usd` both `> 0`). Every descendant turn draws down the **same** tree-wide ceiling, so a deep/wide subtree (and an `A → B → A` chaining cycle) is genuinely bounded.
- The cost ceiling is a **soft** ceiling: it can overshoot by at most one full turn per in-flight runner (cost is decremented after a turn, and the gate is strict-positive). A blocked `run_flow` spawn returns a tool error to the caller; a blocked chaining handoff terminates the chain with `FLOW_ERROR`.

The shared **`child_run_metadata`** block on a `run_flow` / `use_subagent` tool result carries the aggregate-subtree rollup (cost / iterations / depth / tokens), sourced from each run's own subtree accumulator (not a shared-cell delta), and feeds the inline peek card and the run-tree header.

## Step → workflow (a distinct mechanism)

A conversation step can also invoke a single-turn **workflow** by name and fold its result into the step's context before emitting. This runs on the **background-workflow loop** (not a child flow — no run-tree nesting), and the workflow runs **uncapped** during the call: its cost/iterations are reconciled into the flow's shared budget only **after** the call, so a single step→workflow invocation can overshoot the flow's `notor-max-cost-usd` / `notor-max-iterations` by an unbounded amount (a whole workflow run). Treat it as a deliberate, potentially expensive delegation — distinct from `run_flow`'s bounded soft ceiling.

## Crash recovery

On plugin load, Notor scans `orchestrations/sessions/` for `active`/`interrupted` sessions and offers to resume. Recovery replays `session-log.jsonl` idempotently:

- A dangling `turn.start` re-emits the step's trigger (the step re-runs from fresh context); a dangling `event.emitted` re-publishes the event.
- The aggregate budget is **rebuilt** by replaying each turn's recorded cost/tokens (a `$5.00` cap that had spent `$4.90` resumes at `$0.10`, not `$5.00`), and the stale-loop window + thrashing counters are rehydrated — so reloading does not "unstick" a near-stale loop.
- A `run_flow` child is reconciled by the parent's replay via its durable `child.spawned` / `child.result` ledger: a **terminal** child's recorded result is **reused** (no re-spawn); a **non-terminal** child is **resumed in place** (it replays its own log) — never tombstoned-and-respawned, so its `once()` markers survive. A **chained successor** whose predecessor has finalized is recovered as a **root**.

> **At-least-once boundary.** Recovery is at-least-once, not exactly-once. Engine bookkeeping (events/turns), budget, and **overwrite-style** scratchpad state replay safely. But a re-run step **repeats any external, non-idempotent side effect** it performed before crashing, and re-spends budget / re-executes intra-step tool calls that are not individually guarded. Wrap every non-idempotent external effect in `orchestration.once(key, fn)`, and write scratchpad files overwrite-only.

## Authoring with the persona

The built-in **`orchestration-creator`** persona (Settings → Notor → Personas) interactively guides you through authoring a flow — discussing the topology, writing `definition.md` + step notes (conversation and code), suggesting personas, and validating the topology. Its `write_note` access is scoped to `{notor_dir}/orchestrations/` and `{notor_dir}/personas/`. (Authoring a flow does not require the feature group; *running* it does.)

## Reference flows

Enabling the feature group materializes three first-party reference flows under `{notor_dir}/orchestrations/` (your edits are preserved on re-enable):

- **`code-assist`** — a TDD build loop (planner → builder → a code-step test verifier → critic → finalizer) that returns a structured summary. Invocable.
- **`research`** — a multi-phase research loop ending in a code step that returns a **structured** report. Invocable.
- **`review`** — a composition demo: a code step invokes `code-assist` via `run_flow`, then a report step composes the result.

## See also

- [Personas](personas.md) — conversation steps reference personas; the `orchestration-creator` persona authors flows.
- [Sub-agents](sub-agents.md) — the run-tree unifies orchestration steps and sub-agents; `run_flow` generalizes the sub-agent pattern from one conversation to a whole flow.
- [Extensions](extensions.md) — code steps reuse the same `utils` / `libs` runtime as user-defined tools.
- [Workflows](workflows.md) — step→workflow invocation delegates a bounded sub-task to a workflow.
