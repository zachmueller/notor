# Ralph Orchestrator: Core Architecture

> Research compiled from direct source analysis of `../ralph-orchestrator/`.
> Sources:
> - Rust runtime: `crates/ralph-core/src/` and `crates/ralph-cli/src/`
> - Node.js management layer: `backend/ralph-web-server/src/`
>
> **Important:** The Node.js backend is a management/UI layer that runs and monitors
> the Rust binary. All actual orchestration logic lives in the Rust crates.

---

## What Ralph Is

Ralph is a **multi-hat, event-driven AI agent orchestration system**. It runs a loop where
specialized AI agent roles ("hats") collaborate by publishing and subscribing to named events.
The whole workflow is defined in a YAML config file.

The key differentiation from Notor's current single-turn workflow: Ralph produces **multi-step
autonomous execution** — Ralph (the always-present coordinator) runs one turn, emits an event
that triggers a hat, runs another turn playing that hat's role, emits another event, and so on,
until a terminal "loop complete" signal is reached. Custom hats define the topology and
per-role instructions; Ralph is the single executing agent that adapts its prompt accordingly.

---

## Event Loop Model

```
YAML Config defines:
  event_loop:
    starting_event: "build.start"
    completion_promise: "LOOP_COMPLETE"
    max_iterations: 100
    max_runtime_seconds: 14400

  hats:
    planner:
      triggers: ["build.start", "queue.advance"]
      publishes: ["tasks.ready"]
      instructions: "..."    # Full markdown prompt for this role

    builder:
      triggers: ["tasks.ready", "review.rejected"]
      publishes: ["review.ready", "build.blocked"]
      instructions: "..."

    critic:
      triggers: ["review.ready"]
      publishes: ["review.passed", "review.rejected"]
      instructions: "..."

    finalizer:
      triggers: ["review.passed"]
      publishes: ["queue.advance", "LOOP_COMPLETE"]
      instructions: "..."
```

### How It Actually Flows

1. `ralph run -c config.yml -P prompt.txt` is invoked (directly or as subprocess)
2. Ralph publishes the starting event (`task.start`) to the in-process `EventBus`
3. **Ralph ALWAYS executes** as the LLM agent — custom hats define topology and instructions but do not get separate LLM turns
4. Ralph assembles the **full system prompt** using `HatlessRalph.build_prompt()` (see below)
   - **Solo mode** (no custom hats): Ralph's workflow sections are shown
   - **Multi-hat, coordinating** (no hat triggered): `## HATS` topology table + Mermaid diagram is shown; Ralph must delegate via events
   - **Multi-hat, hat active** (pending events match a hat): `## ACTIVE HAT` section shows that hat's instructions + Event Publishing Guide
5. Ralph calls the configured LLM backend with that prompt
6. The LLM runs tools, including the `ralph emit` shell command, which **writes a JSONL line to `.ralph/events.jsonl`**
7. After the LLM turn, Ralph reads new lines from that events file (via `EventReader`)
8. Events are validated (backpressure checks, malformed line detection)
9. If valid, the event is published to `EventBus`, which determines the next hat to activate
10. Repeat until `LOOP_COMPLETE` is emitted or a termination condition fires

**Note:** An `EventParser` also exists that parses XML-style `<event topic="...">payload</event>` tags from CLI output, but per the `process_output()` source: *"Events are ONLY read from the JSONL file written by `ralph emit`. This enforces tool use and prevents confabulation."* The XML parser is used for diagnostics/logging only, not for event routing.

### The JSONL File Mechanism

The LLM does **not** call a function/tool to emit events. It runs a shell command:

```bash
ralph emit "tasks.ready" "task_id: step-01-impl, description: Add --verbose flag parsing"
```

This writes a line to `.ralph/events.jsonl`. After the LLM turn completes, the event loop
reads new lines from this file, validates them, and routes them.

This matters architecturally: the event bus and the ralph binary the LLM calls are separate.
The file is the bridge between LLM output and the routing engine.

### Event Wire Format (JSONL)

```json
{"ts":"2025-01-15T10:00:00Z","iteration":3,"hat":"builder","topic":"review.ready","payload":"tests: pass, lint: pass"}
```

Fields: `ts` (ISO timestamp), `iteration` (number), `hat` (emitting hat name),
`topic` (event name), `triggered` (what caused this), `payload` (plain string — not JSON).

---

## Prompt Architecture: HatlessRalph + InstructionBuilder

**Critical understanding:** Ralph ALWAYS executes as the LLM agent. The prompt builder is
`HatlessRalph.build_prompt(events_context, active_hats)`. How it varies by mode:

### Solo Mode (no custom hats)
Ralph's full workflow sections: ORIENTATION → SCRATCHPAD → STATE MANAGEMENT → GUARDRAILS →
OBJECTIVE → WORKFLOW (PLAN → IMPLEMENT → VERIFY → COMMIT → EXIT) → event writing instructions.

### Multi-hat Mode: Ralph Coordinating (no custom hat triggered)
Same core sections plus `## HATS` with:
- Full topology table (hat name / triggers / publishes / description)
- Mermaid flowchart showing event routing
- `CONSTRAINT:` listing which events Ralph may publish

### Multi-hat Mode: Hat Active (custom hat triggered by pending events)
Same core sections plus `## ACTIVE HAT` with:
- `### {hat.name} Instructions` — the hat's raw instructions verbatim
- `### Event Publishing Guide` — which events to emit and who receives them
- `### TOOL RESTRICTIONS` — if the hat has `disallowed_tools` configured

All modes include: scratchpad prepended, ready-tasks prepended, memories auto-injected
(when `memories.inject: auto`), robot guidance (from Telegram), skill index.

### InstructionBuilder.build_custom_hat()

A separate `InstructionBuilder` also exists and builds a standalone hat prompt with a
numbered scaffold structure:

```
You are {hat.name}. You have fresh context each iteration.

### 0. ORIENTATION
You MUST study the incoming event context.
You MUST NOT assume work isn't done — verify first.

### 0b. TOOL DISCIPLINE
Runtime work state lives in `ralph tools task`, not in ad hoc markdown checklists.
You MUST check <ready-tasks> before creating more tasks.
If this iteration creates or discovers durable work, you MUST represent it with
`ralph tools task ensure`, `start`, `close`, `reopen`, or `fail` as appropriate.
If entering an unfamiliar area, SHOULD search memories with `ralph tools memory search`.
[...additional tool discipline rules: decisions.md, interact progress, memory add on block...]

### 1. EXECUTE
{hat.instructions}          ← the hat's actual content goes here

You MUST NOT use more than 1 subagent for build/tests.

### 2. VERIFY
You MUST run tests and verify implementation before reporting done.
You MUST NOT close tasks unless ALL conditions are met.

### 3. REPORT
You MUST publish a result event with evidence using `ralph emit`.
You MUST emit exactly ONE of: `{publishes}` every iteration or the loop will terminate.
Plain-language summaries do NOT count as event publication.
You MUST stop immediately after emitting.
You MUST NOT end the iteration without publishing.

### GUARDRAILS
999. {guardrail_1}
1000. {guardrail_2}

---
You MUST handle these events:
{events_context}
```

Per the source code, `build_custom_hat()` is a **"backward compatibility and tests"** path.
In production, `next_hat()` always returns "ralph" in multi-hat mode, so `HatlessRalph.build_prompt()`
is the sole active path. Key behaviors the scaffold enforces (relevant for Notor's implementation):
- **Must-publish injection**: Even when a hat has explicit instructions, the "emit exactly one"
  rule is always injected into the REPORT section
- **Guardrails are numbered 999+**: Makes them appear last, signaling highest precedence
- **Derived behaviors fallback**: If `hat.instructions` is empty, behaviors are derived from
  the hat's pub/sub contract (trigger → default action, publish → default action)
- **TOOL DISCIPLINE block**: All hats get identical instructions about using `ralph tools task`
  and `ralph tools memory` — this is what drives reliable task management without repeating it
  in every hat's custom instructions

---

## HatlessRalph: The Always-Present Fallback Coordinator

There is always a special "Ralph" hat registered that subscribes to `*` (all topics).
Per the spec: *"Ralph is ALWAYS registered as the universal fallback. Cannot be replaced,
overwritten, or configured away."*

When an event is emitted that no custom hat handles (an **orphaned event**), Ralph catches it
and figures out what to do — typically steering the agent back on track. Without this fallback,
a single misnamed event topic would silently stall the loop.

In "solo mode" (no custom hats), Ralph is the only coordinator and handles everything itself.

---

## Hat Preset YAML Schema

The config supports two formats: **v1 (flat)** and **v2 (nested)**. v1 fields like
`agent:`, `completion_promise:`, `max_iterations:` map to v2 nested equivalents and are
still accepted for backward compatibility.

```yaml
# Top-level sections (v2 nested format)
event_loop:
  completion_promise: "LOOP_COMPLETE"   # default
  starting_event: "build.start"        # optional: event Ralph emits after initial coordination
  max_iterations: 100                  # default
  max_runtime_seconds: 14400           # default (4 hours)
  max_cost_usd: 10.00                  # optional: terminates on cost exceeded
  max_consecutive_failures: 5          # default: stop after 5 failures in a row
  cooldown_delay_seconds: 0            # delay between iterations (skipped for human events)
  required_events:                     # optional: LOOP_COMPLETE rejected unless these were seen
    - "review.approved"
  persistent: false                    # if true: suppresses LOOP_COMPLETE, loop stays alive
  cancellation_promise: ""             # set to "loop.cancel" to enable graceful abort event
  enforce_hat_scope: false             # if true: out-of-scope events replaced with scope_violation

cli:
  backend: "claude"            # which AI backend: claude, kiro, gemini, codex, amp, pi, custom

core:
  specs_dir: ".ralph/specs/"
  scratchpad: ".ralph/agent/scratchpad.md"
  guardrails:                  # injected into every LLM system prompt
    - "Fresh context each iteration - scratchpad is memory"
    - "Don't assume 'not implemented' - search first"
    - "Backpressure is law - tests/typecheck/lint/audit must pass"
    - "Confidence protocol: score decisions 0-100..."
    - "Commit atomically..."

memories:
  enabled: true                # enables .ralph/agent/memories.md; also gates task enforcement
  inject: auto                 # auto | manual | none (auto = injected every iteration)
  budget: 0                   # max tokens to inject (0 = unlimited)

tasks:
  enabled: true                # enables .ralph/agent/tasks.jsonl (separate from memories)

skills:
  enabled: true
  dirs:
    - .claude/skills

hats:
  planner:
    name: "📋 Planner"
    description: "Short description"      # REQUIRED — validation error if missing
    triggers: ["build.start", "queue.advance"]
    publishes: ["tasks.ready", "all_steps.done"]
    default_publishes: "tasks.ready"      # synthesized if hat produces no JSONL output
    max_activations: 10                   # optional: {hat_id}.exhausted if exceeded
    disallowed_tools: []                  # optional: tools blocked for this hat
    instructions: |
      ## PLANNER MODE
      Full markdown instructions for the LLM playing this role...
    backend:                          # optional per-hat model override
      model: "claude-opus-4-6"

events:                               # optional metadata about events
  build.start:
    description: "Triggers the build cycle"
    on_trigger: "Analyze incoming task and create plan."    # injected in derived behaviors
    on_publish: "When ready to start building."
```

**Reserved triggers:** `task.start` and `task.resume` are reserved for Ralph's coordination
layer. Custom hats may not subscribe to these — doing so causes a config validation error.

---

## Loop Termination Reasons

The event loop has **thirteen** distinct termination conditions (not just max_iterations):

| Reason | Trigger | Exit Code |
|--------|---------|-----------|
| `CompletionPromise` | `LOOP_COMPLETE` event seen | 0 |
| `Cancelled` | `loop.cancel` event (intentional abort) | 0 |
| `MaxIterations` | iteration count exceeded | 2 |
| `MaxRuntime` | wall-clock time exceeded | 2 |
| `MaxCost` | cumulative LLM cost exceeded | 2 |
| `ConsecutiveFailures` | too many failures in a row | 1 |
| `LoopThrashing` | planner redispatches 3+ already-abandoned tasks | 1 |
| `LoopStale` | same event+payload fingerprint emitted 3+ times in a row | 1 |
| `ValidationFailure` | 3+ consecutive malformed JSONL lines | 1 |
| `Stopped` | `.ralph/stop-requested` file appears | 1 |
| `WorkspaceGone` | worktree directory removed externally | 1 |
| `Interrupted` | SIGINT or SIGTERM signal received | 130 |
| `RestartRequested` | `.ralph/restart-requested` file appears (Telegram `/restart`) | 3 |

Stale loop and thrashing detection are critical for production use — without them, a stuck
agent burns tokens indefinitely. Both check recent history per-iteration.

`Cancelled` enables graceful workflow abort without required_events validation; enables
human rejection or timeout escalation paths. Set `event_loop.cancellation_promise: "loop.cancel"`
to activate this (disabled by default).

---

## `default_publishes` Synthesis

When the LLM completes a turn and produces **no JSONL events**, the loop doesn't stall.
The hat's `default_publishes` topic is synthesized and published automatically. This is the
safety net that keeps the loop progressing even when the LLM forgets to emit.

---

## `required_events` Validation on LOOP_COMPLETE

The config can specify `required_events: [event.a, event.b]` — topics that must have
been seen during the loop's lifetime before `LOOP_COMPLETE` is accepted. If the LLM
tries to complete early, the completion is rejected:

```
LOOP_COMPLETE rejected: missing required events: ["review.approved"].
The agent must complete all workflow phases before emitting LOOP_COMPLETE.
Use loop.cancel to abort the workflow instead.
```

A `task.resume` event is injected so the loop continues.

---

## Runtime Tasks: JSONL Store with Completion Enforcement

`memories` and `tasks` are **separate config sections**, both enabled by default.
The task store lives at `.ralph/agent/tasks.jsonl`. The LLM uses `ralph tools task ensure/start/close/reopen/fail`
to manage tasks. LOOP_COMPLETE rejection for open tasks is enforced when `memories.enabled = true`
(not `tasks.enabled`) — this is because memories mode is the "structured tracking" mode.

The loop **rejects LOOP_COMPLETE** if any tasks are still open:

```
Completion rejected: runtime tasks remain open: ["task-step-01-impl", "task-step-01-tests"].
Close, fail, or reopen outstanding tasks before emitting the completion promise.
```

This prevents the LLM from prematurely declaring success while work is incomplete. The
`InstructionBuilder`'s `### 0b. TOOL DISCIPLINE` block tells every hat to use
`ralph tools task` rather than ad hoc markdown checklists — and the loop enforces this
at completion time.

---

## Memory System

Persistent cross-session learning stored at `.ralph/agent/memories.md` with four types:

| Type | Section | Purpose |
|------|---------|---------|
| `pattern` | `## Patterns` | How this codebase does things |
| `decision` | `## Decisions` | Why something was chosen |
| `fix` | `## Fixes` | Solution to a recurring problem |
| `context` | `## Context` | Project-specific knowledge |

Memory ID format: `mem-{unix_timestamp}-{4_hex_chars}` (e.g., `mem-1737372000-a1b2`)

The `InstructionBuilder` `### 0b. TOOL DISCIPLINE` block tells every hat:
- Before acting in unfamiliar territory: `ralph tools memory search`
- When blocked or when a command fails: `ralph tools memory add` (type: fix)

Memories are **shared across worktree loops** via symlink — so parallel loops accumulate
knowledge into the same memories file.

---

## Lifecycle Hooks System (Separate from Hat Events)

Ralph has **two distinct hook systems**. The hat event system (triggers/publishes) is the
orchestration engine. The lifecycle hooks system is a separate meta-layer for observability
and external integrations.

Lifecycle hooks are shell commands that fire at loop **phases**:

```yaml
# In ralph.yml
hooks:
  enabled: true
  defaults:
    timeout_seconds: 30         # default
    max_output_bytes: 8192      # default
    suspend_mode: wait_for_resume

  events:
    pre.loop.start:
      - name: env-guard
        command: ["./scripts/check-env.sh"]
        on_error: block         # required per-hook field: warn | block | suspend

    post.iteration.start:
      - name: notify-slack
        command: ["./scripts/notify.sh"]
        on_error: warn

    pre.loop.complete:
      - name: cleanup
        command: ["./scripts/cleanup.sh"]
        on_error: warn

    pre.loop.error:
      - name: alert
        command: ["./scripts/alert.sh"]
        on_error: warn
```

Hook phases (12 total):
- `pre.loop.start` / `post.loop.start`
- `pre.iteration.start` / `post.iteration.start`
- `pre.plan.created` / `post.plan.created`
- `pre.human.interact` / `post.human.interact`
- `pre.loop.complete` / `post.loop.complete`
- `pre.loop.error` / `post.loop.error`

**Correction from earlier research:** There is no `pre.loop.terminate`/`post.loop.terminate`.
Loop end is split into `loop.complete` (clean exit) and `loop.error` (failure exit).
The `on_error` values are `warn | block | suspend` (not "fail").

Each hook receives a rich JSON payload on stdin:
```json
{
  "schema_version": 1,
  "phase": "post",
  "event": "iteration.start",
  "phase_event": "post.iteration.start",
  "timestamp": "2026-01-15T10:00:00Z",
  "loop": { "id": "loop-1234-abcd", "is_primary": false, "workspace": "...", "pid": 12345 },
  "iteration": { "current": 7, "max": 100 },
  "context": { "active_hat": "builder", "selected_hat": "builder", "selected_task": "task-abc" },
  "metadata": { "accumulated": {} }
}
```

Hooks are **not** part of the hat event bus. They're external shell commands that can
observe, notify, gate, or modify loop behavior. `on_error: suspend` blocks the loop
until a human resumes.

This is entirely separate from Notor's existing vault hook system (on-save, on-open, etc.)
and distinct from the hat event routing.

---

## Backpressure: Evidence-Based Payload Validation

See `docs/concepts/backpressure.md` and `crates/ralph-core/src/event_parser.rs`.

The backpressure mechanism is **not** a server-side "run this shell command before routing."
It's payload text validation in the Rust event loop.

When the LLM emits `build.done`, the event loop parses the payload for structured evidence:

```
ralph emit "build.done" "tests: pass, lint: pass, typecheck: pass, audit: pass, coverage: pass, complexity: 7.2, duplication: pass"
```

Required fields (all must be `pass` or within threshold):
- `tests: pass`
- `lint: pass`
- `typecheck: pass`
- `audit: pass`
- `coverage: pass`
- `complexity: <number>` — must be ≤ 10.0
- `duplication: pass`

Optional fields:
- `mutants: pass (82%)` — warning-only, never blocks
- `performance: pass` — blocks if `regression`
- `specs: pass` — blocks if explicitly `fail`

If evidence is missing or any required check failed, the event loop silently **substitutes
`build.blocked` for `build.done`**. The builder hat (or whichever hat triggers on
`build.blocked`) then gets a turn to fix things.

Same pattern for `review.done`: requires `tests: pass` and `build: pass`, otherwise
becomes `review.blocked`.

The `backpressure.gates` YAML section (shell commands in `ralph.yml`) configures what the
LLM is *instructed* to run. The loop doesn't run those commands independently — it trusts
the LLM ran them and validates the evidence format.

---

## HatRegistry and Event Routing

`HatRegistry` is built from config at startup. Hats are stored in a `BTreeMap<HatId, Hat>`
(sorted by key for deterministic ordering).

`subscribers(topic)` finds all hats whose trigger patterns match a topic. Pattern matching
supports wildcards: `task.*` matches `task.start`, `task.resume`, etc. A prefix index
provides O(1) early-exit for no-match lookups.

When multiple hats subscribe to the same topic, **all are activated** in sorted key order
(BTreeMap ensures deterministic alphabetical ordering).

The "ralph" hat with subscription `*` is always registered (after custom hats) as the
universal fallback. In multi-hat mode, `next_hat()` ALWAYS returns "ralph" — custom hats
define topology/instructions but don't execute separately. The `can_publish()` method
enforces hat scope: unregistered hats (including ralph) may publish any topic; registered
hats are limited to their declared `publishes` list.

---

## Preset Collection System (Node.js Management Layer)

The Node.js web server adds three sources for presets:
1. **Builtin** — `presets/` at repo root (shipped with ralph)
2. **Directory** — `.ralph/hats/*.yml` in the user's project
3. **Collection** — Visual workflow builder (React Flow graph → YAML)

Preset IDs: `builtin:code-assist`, `directory:my-hat`, or UUID for collection presets.

---

## ConfigMerger (Node.js Management Layer)

When a task runs with a preset, `ConfigMerger.merge(basePath, preset)`:
1. Loads `ralph.yml` (user's base config)
2. Loads the preset YAML
3. Replaces only `hats` and `events` sections from the preset
4. Preserves all other base config settings
5. Writes merged YAML to a temp file
6. Passes `-c <tempPath>` to the `ralph run` subprocess

---

## Process Execution Model (Node.js Management Layer)

The Node.js server manages ralph subprocesses via `ProcessSupervisor`:

```
~/.ralph/web/runs/{taskId}/
  pid          # process ID
  status.json  # { state, startedAt, completedAt, exitCode, signal, durationMs }
  prompt.txt   # the prompt passed to ralph
  stdout.log   # captured
  stderr.log   # captured
```

Key: processes are detached and `unref()`'d — they survive server restart. Liveness
checked via `process.kill(pid, 0)` (signal 0 = existence check only).

This layer is **not relevant for Notor's native implementation**, which runs in-process.

---

## LoopsManager: Parallel Worktree Execution

For projects that run multiple ralph loops in parallel (each in a git worktree):

```typescript
// Operations via ralph CLI subprocess
processMergeQueue()   // ralph loops process
listLoops()           // ralph loops list --json
pruneStale()          // ralph loops prune
retryMerge(id)        // ralph loops retry <id>
discardLoop(id)       // ralph loops discard -y <id>
stopLoop(id, force?)  // ralph loops stop [--force] <id>
mergeLoop(id, force?) // ralph loops merge [--force] <id>
```

Each loop runs in an isolated git worktree. State files (events, tasks, scratchpad) are
per-worktree. Memories and specs are symlinked back to the main repo root (shared).

Not in scope for Notor MVP.

---

## tRPC API Surface (Node.js Management Layer)

Top-level routers in `appRouter` (frontend ↔ Node.js server):
- `task.*` — CRUD + run/retry/cancel/archive/clearAll
- `hat.*` — list/get/setActive/save/delete hats (from DB settings)
- `loops.*` — list/process/prune/retry/discard/stop/merge/triggerMergeTask/mergeButtonState
- `collection.*` — list/get/create/update/delete/exportYaml/importYaml
- `presets.*` — list (builtin + directory + collections)
- `config.*` — get/update ralph.yml
- `planning.*` — list/get/start/respond/resume/delete/getArtifact

---

## Database Schema (Node.js Management Layer, SQLite)

```
tasks:
  id, title, status (open/pending/running/failed/closed),
  priority (1-5), blockedBy (FK to self),
  queuedTaskId, startedAt, completedAt, errorMessage,
  executionSummary, exitCode, durationMs, archivedAt,
  mergeLoopPrompt, preset, currentIteration, maxIterations, loopId

queued_tasks:
  id, taskType, payload (JSON), state (pending/running/completed/failed),
  priority, enqueuedAt, startedAt, completedAt, error, retryCount, dbTaskId

task_logs:
  id (auto-increment), taskId, timestamp, source (stdout/stderr), line

settings:
  key, value (JSON), updatedAt

collections:
  id, name, description, graphData (React Flow JSON), createdAt, updatedAt
```
