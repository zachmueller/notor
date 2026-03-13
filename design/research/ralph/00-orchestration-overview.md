# Orchestration Integration: Research Overview

> Aggregated findings from research into the Ralph orchestrator codebase and how to
> reimplement equivalent functionality as a first-class feature in the Notor Obsidian plugin.
>
> Sub-documents: [01] Architecture · [02] Notor · [03] Presets · [04] Integration · [05] Services · [06] Schema

---

## What We're Building

Notor currently executes single-turn LLM workflows: one prompt, one response.

The goal is **multi-hat orchestration** — a loop where specialized LLM roles ("hats") collaborate
through named events, each hat getting its own system prompt and tool access, passing work forward
until a terminal "loop complete" signal is reached.

Ralph is the reference implementation. We build this natively in Notor, integrated with the vault.

---

## Ralph in One Page

Ralph is a multi-hat event-driven agent framework. A YAML preset defines:

```
event_loop:
  starting_event: build.start
  completion_promise: LOOP_COMPLETE
  max_iterations: 100

hats:
  planner:
    triggers: [build.start, queue.advance]
    publishes: [tasks.ready, all_steps.done]
    instructions: |
      # PLANNER MODE
      Break the work into tasks. Emit tasks.ready for each.

  builder:
    triggers: [tasks.ready, review.rejected]
    publishes: [review.ready]
    instructions: |
      # BUILDER MODE
      Implement the assigned task. Run tests. Emit review.ready.

  critic:
    triggers: [review.ready]
    publishes: [review.passed, review.rejected]
    instructions: |
      # CRITIC MODE
      Review the implementation. Emit review.passed or review.rejected.

  finalizer:
    triggers: [review.passed]
    publishes: [queue.advance, LOOP_COMPLETE]
    instructions: |
      # FINALIZER MODE
      Advance the queue or complete the loop.
```

The runtime:
1. Fires the starting event
2. Finds hats whose `triggers` include that event
3. Gives the matching hat an LLM turn (instructions + event payload as context)
4. The LLM calls `emit_event` tool to publish the next event
5. Loop routes to the next hat; repeat until `LOOP_COMPLETE`

Optional features: backpressure gates (shell commands that must pass), guardrails (constraints
injected into every hat's system prompt), runtime tasks (sub-task tracking within a session).

See [01-ralph-architecture.md](01-ralph-architecture.md) for full detail.

---

## Notor's Current Architecture (What We Build On)

| System | Entry Point | Notes |
|--------|-------------|-------|
| Chat | `src/chat/chat-view.ts` | Message I/O, streaming, conversation state |
| Provider | `src/providers/` | Abstracted LLM API calls (Claude, OpenAI, etc.) |
| Tools | `src/tools/` | Vault tools, shell tools, approval gating |
| Workflows | `src/workflows/` | Single-turn: load note → assemble prompt → sendMessage |
| Personas | `src/personas/` | System prompt profiles with model/provider overrides |
| Hooks | `src/hooks/` | Vault event triggers (note-open, on-save, etc.) |
| Context | `src/context/` | Include blocks, note attachments |
| Rules | `src/rules/` | Vault-scoped instructions injected into system prompt |
| Settings | `src/settings/` | Provider credentials, defaults |
| Shell | `src/shell/` | Subprocess execution for tool calls |

**Key capabilities available for orchestration:**
- `sendMessage(message)` — the existing LLM call mechanism; orchestration reuses this per hat turn
- `activatePersona(name)` — per-hat persona switching
- Tool approval gating — inherited by each hat turn
- Checkpoint system — vault note history and rollback; hat turns naturally extend this
- Streaming output — already works; hat turn output streams to chat view normally

See [02-notor-architecture.md](02-notor-architecture.md) for full detail.

---

## Architecture Decision: Native In-Process

**Three options were evaluated:**

| Option | Approach | Verdict |
|--------|----------|---------|
| A | Spawn `ralph run` CLI as subprocess | Rejected — external dependency, no vault integration |
| B | Native in-process orchestration engine | **Recommended** |
| C | Hybrid: observe ralph subprocess events | Rejected — worst of both worlds |

**Option B wins because:**
- Reuses Notor's existing provider/tool/approval/persona/checkpoint systems for every hat turn
- Hat instructions can reference vault notes via `<include_note>` (no subprocess boundary)
- Backpressure gates use Notor's shell tool with existing approval gating
- No subprocess lifecycle management complexity
- Works offline (no `ralph` CLI required)
- Orchestration state is vault notes — visible and editable in Obsidian

---

## The New System: Eight Concepts

### 1. Hat Definition (vault note)

A hat is a vault note with `notor-type: hat` frontmatter. Its body is the hat's LLM instructions.

```yaml
---
notor-type: hat
notor-hat-name: "📋 Planner"
notor-hat-triggers: [build.start, queue.advance]
notor-hat-publishes: [tasks.ready, all_steps.done]
notor-hat-default-publishes: tasks.ready
notor-hat-persona: planner-persona    # optional
notor-hat-model: claude-opus-4-6      # optional
---

## PLANNER MODE

You manage task decomposition...
```

Stored under `{notor_dir}/orchestrations/hats/`.

### 2. Orchestration Preset (vault note)

A preset is a vault note with `notor-type: orchestration-preset` frontmatter. It references hats
and configures the loop.

```yaml
---
notor-type: orchestration-preset
notor-preset-name: "Code Implementation"
notor-loop-starting-event: build.start
notor-loop-completion-promise: LOOP_COMPLETE
notor-loop-max-iterations: 100
notor-loop-max-runtime-minutes: 240
notor-hats:
  - notor/orchestrations/hats/planner.md
  - notor/orchestrations/hats/builder.md
  - notor/orchestrations/hats/critic.md
  - notor/orchestrations/hats/finalizer.md
notor-guardrails:
  - "Verification is mandatory — tests must pass"
  - "YAGNI ruthlessly"
notor-backpressure-gates:
  - name: tests
    command: "npm test"
    on_fail: "Tests failed. Fix before proceeding."
---
```

### 3. OrchestrationEventEngine

A simple in-process pub/sub system for hat-to-hat event routing. Separate from Notor's existing
hook system (which is for vault events, not orchestration events).

```typescript
class OrchestrationEventEngine {
  emit(topic: string, payload: unknown): void
  subscribe(topic: string, handler: EventHandler): Unsubscribe
  waitForEvent(topic: string): Promise<OrchestrationEvent>
}
```

The event engine lives only for the duration of an orchestration session.

### 4. HatTurnExecutor

Executes a single hat turn by calling Notor's existing `sendMessage` with:
- The hat's instructions as the system prompt (or merged with active persona)
- The triggering event's payload as context
- Access to all vault tools (hat can read/write notes, run shell commands)
- The `emit_event` tool injected into the tool list

After the LLM response completes, if no `emit_event` was called, fires `notor-hat-default-publishes`.

```typescript
class HatTurnExecutor {
  execute(hat: HatDefinition, triggerEvent: OrchestrationEvent): Promise<HatTurnResult>
}
```

### 5. `emit_event` Tool

A new tool the LLM calls during a hat turn to publish an orchestration event:

```typescript
// Tool definition
{
  name: "emit_event",
  description: "Publish an orchestration event to route to the next hat",
  parameters: {
    topic: string,    // event name, e.g. "tasks.ready"
    payload: object   // arbitrary JSON payload
  }
}
```

When called, the engine routes to the next hat in the same iteration.

### 6. OrchestrationSessionManager

Manages session lifecycle: create, run, pause, resume, cancel, complete.

```typescript
class OrchestrationSessionManager {
  startSession(preset: OrchestrationPreset, initialPrompt: string): Promise<SessionId>
  pauseSession(id: SessionId): void
  resumeSession(id: SessionId): void
  cancelSession(id: SessionId): void
  getSession(id: SessionId): OrchestrationSession | undefined
}
```

Session state persisted to `{notor_dir}/orchestrations/sessions/{session-id}/session.json`.

### 7. Runtime Task Registry (vault notes)

Subtask tracking within a session — lightweight tasks representing individual units of work:

```
sessions/{id}/tasks/
  step-01-impl.md      # notor-type: orchestration-task; notor-task-status: open
  step-01-tests.md
```

Tools: `orchestration_task_ensure`, `orchestration_task_start`, `orchestration_task_close`,
`orchestration_task_list`.

### 8. Backpressure Gates

Shell commands that must pass before an event is routed to the next hat. Defined in the preset.
Executed via Notor's existing shell tool. On failure, the failure message is injected as context
for the current hat to fix the issue.

```typescript
async function runBackpressureGate(gate: BackpressureGate): Promise<GateResult> {
  const result = await shell.exec(gate.command)
  return result.exitCode === 0
    ? { passed: true }
    : { passed: false, feedback: gate.on_fail + "\n\n" + result.output }
}
```

---

## Vault Directory Structure

```
{vault}/
  {notor_dir}/                     # e.g. "notor/"
    orchestrations/
      presets/
        code-assist.md             # orchestration preset note
        research.md
      hats/
        planner.md                 # hat definition note
        builder.md
        critic.md
        finalizer.md
      sessions/                    # created at runtime
        {session-id}/
          session.json             # metadata: status, iteration, active hat
          context.md               # shared context (hats write here)
          plan.md                  # shared plan
          progress.md              # step tracking
          decisions.md             # confidence-protocol decisions
          tasks/
            {task-key}.md          # runtime task notes
          logs/
            {n}-{hat}-output.md    # hat turn output capture
```

All session files are regular vault notes: visible in Obsidian, editable, version-controlled.

---

## Implementation Phases

### Phase 1: Minimal Viable Orchestration

**Goal:** Run a preset, hat turns execute, events route, loop terminates.

Components to build:
1. `HatNoteParser` — reads hat vault note, extracts frontmatter + body
2. `OrchestrationPresetParser` — reads preset vault note
3. `OrchestrationEventEngine` — simple in-process pub/sub
4. `HatTurnExecutor` — calls `sendMessage` with hat instructions + event context
5. `emit_event` tool — LLM publishes events
6. `OrchestrationRunner` — the main loop: fire starting event → route → execute → repeat
7. Command palette: "Notor: Run Orchestration" → preset picker → prompt input

**Iteration safety:** max_iterations + max_runtime_minutes guards.

**Not in Phase 1:** task registry, backpressure, interactive pausing, preset library.

### Phase 2: Session Workspace

**Goal:** Hats can share state via vault notes; session is inspectable in Obsidian.

1. `OrchestrationSessionManager` — creates session directory, persists `session.json`
2. Workspace notes: `context.md`, `plan.md`, `progress.md` created automatically
3. Hat turn logs written to `logs/{n}-{hat}-output.md`
4. Session recovery: on plugin load, check for incomplete sessions, offer resume

### Phase 3: Runtime Task Registry

**Goal:** Hats can track subtasks as vault notes.

1. Task vault note format (frontmatter + acceptance criteria body)
2. Task management tools: ensure, start, close, list
3. Task notes appear in Obsidian graph view alongside session notes
4. Optional: SQLite index for fast queries during orchestration

### Phase 4: Backpressure Gates

**Goal:** Shell commands gate event routing; quality enforced automatically.

1. Gate runner — executes shell commands, captures output
2. Failure injection — if gate fails, feedback added to next hat turn's context
3. Gate definitions in preset frontmatter

### Phase 5: Interactive Orchestration

**Goal:** A hat can pause and ask the user a question.

1. `user.input.required` special event — pauses loop, shows question in chat view
2. User response injected into next hat turn as context
3. Session state: Active / WaitingForInput / Paused / Completed

### Phase 6: Built-in Preset Library

**Goal:** Ship with useful presets out of the box.

Presets to include (ported from Ralph):
- `code-assist` — TDD implementation: planner → builder → critic → finalizer
- `research` — research synthesis workflow
- `review` — code or document review workflow

---

## Key Design Patterns from Ralph

### Hat Instructions as the Core Value

The markdown instructions each hat receives are the primary design artifact. They encode:
- Role boundaries ("Do not implement. Do not review.")
- Decision protocols ("Confidence >80: proceed. 50-80: document. <50: choose safe default.")
- Output format expectations
- What to read from shared workspace
- What to write to shared workspace

The instructions are long — often 200-400 lines. This is intentional. The LLM needs explicit,
detailed guidance to play a constrained role reliably.

### Shared State via Workspace Notes

Hats don't pass state through event payloads alone. They read and write vault notes:
- `context.md` — implementation context, repo patterns, dependencies
- `plan.md` — high-level steps
- `progress.md` — current step, verified sub-tasks, notes
- `decisions.md` — confidence-protocol decision log

This keeps payloads small (just IDs and signals) while allowing rich context sharing.

### Default Publishes as Safety Net

Every hat has a `default_publishes` event that fires automatically if the LLM doesn't call
`emit_event`. This prevents silent loop stalls when a hat forgets to emit.

### Guardrails Are System-Prompt Injections

The preset's `notor-guardrails` list is injected verbatim into every hat's system prompt, before
the hat's instructions. This ensures cross-cutting constraints (testing, YAGNI, confidence
protocol) apply to all hats without repeating them in each hat note.

### Event Payloads Carry Task Identity

The event payload (usually `{ task_id, task_key }`) is how hats know which task they're working
on. The planner sets it; builder, critic, and finalizer all receive and propagate it.

---

## Critical Differences from Ralph

| Concern | Ralph | Notor |
|---------|-------|-------|
| Hat instructions source | YAML field in `.ralph/hats/*.yml` | Vault note body (markdown) |
| Preset source | YAML file on disk | Vault note with frontmatter |
| LLM backend | External CLI (`ralph run --backend kiro`) | Notor's existing provider system |
| Event emission | `ralph emit <topic> <payload>` CLI call (parsed from stdout) | `emit_event` tool call in LLM response |
| Shared state | Filesystem paths relative to cwd | Vault notes via vault tools |
| Process model | Detached subprocess (survives restart) | In-process async (session.json for recovery) |
| Log streaming | FileOutputStreamer → WebSocket → browser | Notor's existing streaming → chat view |
| Visual builder | React Flow graph → YAML export (collections) | Future: graph view of hat connections |
| Git worktrees | LoopsManager (parallel isolated branches) | Not in scope |

---

## Component Implementation Complexity

| Component | Complexity | Notes |
|-----------|-----------|-------|
| HatNoteParser | Low | Parse YAML frontmatter + extract body |
| OrchestrationPresetParser | Low | Parse YAML frontmatter + body |
| OrchestrationEventEngine | Low | Simple pub/sub, ~50 lines |
| emit_event tool | Low | Thin wrapper that calls engine.emit() |
| HatTurnExecutor | Medium | Wire hat instructions + event context into sendMessage |
| OrchestrationRunner | Medium | Main loop with iteration/runtime guards |
| OrchestrationSessionManager | Medium | Session lifecycle + vault directory creation |
| Workspace notes | Low | Create .md files; hats use existing write-note tool |
| Task registry | Medium | Vault notes + SQLite index optional |
| Backpressure gates | Low | Shell exec + failure context injection |
| Interactive pausing | Medium | New session state + chat view integration |
| Preset discovery | Low | Scan directory for `notor-type: orchestration-preset` notes |
| Command palette UI | Low | Extend existing WorkflowPickerModal pattern |
| Built-in presets | Medium | Write hat instructions for each role |

---

## Source Files

| Document | Contents |
|----------|----------|
| [01-ralph-architecture.md](01-ralph-architecture.md) | Ralph's event loop, process model, DB schema, tRPC API, all major services |
| [02-notor-architecture.md](02-notor-architecture.md) | Notor's current systems: chat, provider, tools, workflows, personas, hooks |
| [03-ralph-preset-examples.md](03-ralph-preset-examples.md) | Real preset analysis (code-assist.yml, ralph.yml) with key learnings |
| [04-integration-analysis.md](04-integration-analysis.md) | Architecture options, recommendation, component mapping, risk assessment |
| [05-ralph-services-deep-dive.md](05-ralph-services-deep-dive.md) | Detailed analysis of each Ralph service; Notor implementation complexity |
| [06-vault-schema-design.md](06-vault-schema-design.md) | Vault-native format spec: hat notes, preset notes, workspace notes, directory layout |
