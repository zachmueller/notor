# Integration Analysis: Bringing Ralph Orchestration Into Notor

> Synthesizes architecture of both systems to identify integration points,
> mapping, and implementation strategy.

---

## The Core Problem

Notor's current workflow system executes a **single LLM session** per workflow invocation.
The LLM can use tools within that session, but there's no multi-role orchestration,
no event routing between specialized agents, and no loop completion contract.

Ralph's orchestration model provides:
1. **Multi-hat event loops** — different LLM roles collaborate through named events
2. **Persistent shared state** — hats read/write shared files (scratchpad, plan, progress)
3. **Loop completion semantics** — loops run until a `LOOP_COMPLETE` event or limits hit
4. **Quality gates** — backpressure gates enforce automated checks before publishing
5. **Interactive planning** — loops can pause for human input

**Goal:** Implement this same orchestration capability natively inside Notor as an
Obsidian plugin, without requiring an external Ralph CLI subprocess.

---

## Conceptual Mapping

| Ralph Concept | Notor Equivalent (Current) | Notes |
|---------------|---------------------------|-------|
| Hat (role definition) | Workflow note | Ralph hat = named role with triggers/publishes/instructions |
| Hat instructions | Workflow body content | Already similar structure |
| Preset YAML | New "Orchestration Workflow" note format | Need new frontmatter schema |
| Event loop | New core engine | Does not exist yet |
| Event pub/sub | N/A | Needs to be built |
| `ralph run` subprocess | In-process orchestration | Key architectural difference |
| runtime tasks (`ralph tools task`) | N/A | Notor has no task tracker |
| Shared scratchpad files | Vault notes | Natural fit — Notor vault = Ralph's project files |
| guardrails | Could be part of system prompt | Already have vault rules system |
| backpressure gates | Could map to hooks | Hooks already support shell command execution |
| Loop completion | N/A | Needs new concept |
| Planning sessions | New conversational workflow mode | Partially similar to multi-turn chat |
| Persona per hat | Per-hat persona assignment | Notor already has personas, could assign per hat |

---

## The Key Architectural Decision: In-Process vs External Process

### Option A: Spawn Ralph CLI (External Process)

Notor would spawn `ralph run -c <preset> -P <prompt>` as a subprocess (like ralph-web-server does):
- Parse JSONL events from stdout
- Stream logs to chat view via `RalphEventParser`
- Show Ralph event loop as a special conversation view

**Pros:**
- Reuses all existing ralph logic exactly
- Get all ralph features for free (backpressure, all backends, loop management)
- Much simpler implementation in Notor

**Cons:**
- Requires Ralph CLI to be installed (external dependency)
- Can't show the same rich Obsidian UI for tool calls/approval
- Tool calls happen outside Obsidian (no vault integration during execution)
- Can't use Notor's provider configuration
- Can't use Notor's persona system per-hat
- No real-time tool approval UI during execution

### Option B: Native In-Process Orchestration

Implement the event loop engine directly in TypeScript/Notor:
- Parse hat presets from vault YAML files
- Run each hat as a Notor `sendMessage()` call with hat-specific system prompt + instructions
- Route events between hats using an in-memory pub/sub engine
- Use Notor's existing tool system during each hat turn
- Show each hat turn as messages in a special "Orchestration Conversation"

**Pros:**
- Full vault integration (hat turns can read/write vault notes)
- Uses Notor's existing provider, persona, tool, and approval systems
- Rich UI: each hat's output visible, tool approvals work normally
- No external dependency
- Notor's checkpoint system protects note changes during orchestration

**Cons:**
- Significant engineering effort to build the event loop engine
- Some Ralph features (backpressure gates, worktree loops) need adaptation
- May not achieve 1:1 parity with Ralph's CLI behavior

### Option C: Hybrid — Ralph CLI + Notor Observation

Notor shows a live view of a running Ralph process (read JSONL events from logs),
but doesn't control the execution:
- Monitor `~/.ralph/web/runs/{taskId}/stdout.log` for events
- Show status in Notor UI
- Allow cancellation

**Cons:** Very limited — Notor just watches, no integration.

**Recommendation: Option B (Native In-Process)** is the most powerful and most
integrated approach, aligning with Notor's vision of deep vault integration.
This is what the rest of this document analyzes.

---

## New Concepts Needed in Notor

### 1. Hat Definition

A hat is a named role with:
- `triggers: string[]` — event topics that activate this hat
- `publishes: string[]` — events this hat can emit
- `default_publishes: string` — event emitted if hat doesn't emit anything
- `instructions: string` — detailed markdown prompt for this role

**Where to store:** Vault notes, with a new frontmatter schema. The workflow body
becomes the hat's instructions.

```yaml
---
notor-trigger: orchestration  # marks this as a hat definition
notor-hat-triggers:
  - build.start
  - queue.advance
notor-hat-publishes:
  - tasks.ready
notor-hat-default-publishes: tasks.ready
notor-hat-name: "📋 Planner"
notor-hat-description: "Manages step decomposition and task queue"
---

## PLANNER MODE

Your instructions here...
```

### 2. Orchestration Preset

A "preset" is a collection of hats + event loop configuration. In Notor, this
would be a note that lists the hats participating in the orchestration.

```yaml
---
notor-trigger: orchestration-preset
notor-loop-starting-event: build.start
notor-loop-completion-promise: LOOP_COMPLETE
notor-loop-max-iterations: 100
notor-loop-max-runtime-minutes: 240
notor-guardrails:
  - "Verification is mandatory"
  - "YAGNI ruthlessly"
notor-hats:                           # ordered list of hat note paths
  - notor/orchestrations/planner.md
  - notor/orchestrations/builder.md
  - notor/orchestrations/critic.md
  - notor/orchestrations/finalizer.md
---

# My Code Implementation Workflow

Brief description of the workflow...
```

### 3. Orchestration Event Engine

The core new module: `src/orchestration/event-engine.ts`

```typescript
interface OrchestratorEvent {
  id: string;
  topic: string;
  payload: unknown;
  ts: string;
  iteration: number;
  emittedBy?: string;  // hat name
}

class OrchestrationEventEngine {
  subscribe(topic: string, handler: (event) => void): void
  publish(topic: string, payload: unknown): void
  getEventHistory(): OrchestratorEvent[]
}
```

### 4. Hat Turn Executor

Executes one LLM turn for a hat:
- Assembles system prompt: global prompt + guardrails + hat persona + hat instructions
- Includes event payload as the user message
- Wires up a special "emit event" tool that the LLM can call
- Uses `sendMessage()` in the existing Notor orchestrator
- Returns the emitted events

### 5. Orchestration Session

Tracks the full execution of a multi-hat preset:
```typescript
interface OrchestrationSession {
  id: string;
  preset_path: string;
  conversation_id: string;   // the main conversation showing all turns
  status: "running" | "paused" | "completed" | "errored" | "stopped";
  current_iteration: number;
  max_iterations: number;
  started_at: string;
  completed_at: string | null;
  event_history: OrchestratorEvent[];
  active_hat: string | null;
}
```

### 6. "Emit Event" Tool

A new tool available only during orchestration hat turns:
```typescript
// Tool definition for the LLM
{
  name: "emit_event",
  description: "Publish an orchestration event to advance the workflow.",
  parameters: {
    topic: { type: "string", description: "Event topic name" },
    payload: { type: "object", description: "Event data" }
  }
}
```

When the LLM calls this tool, the orchestration engine routes to the next hat.

### 7. Task Registry (Runtime Tasks)

The code-assist preset heavily uses `ralph tools task ensure/start/close/show`.
These are lightweight task tracking entries for subtasks within an orchestration.

In Notor: Could be implemented as vault notes in a special `notor/tasks/` directory,
or as in-memory records in the OrchestrationSession.

**Option A: Vault notes** — each task is a note with frontmatter tracking status
**Option B: In-memory** — ephemeral, not persisted across plugin reloads
**Option C: SQLite** — add a `orchestration_tasks` table to the existing DB

### 8. Backpressure Gates

Before a hat can emit an event, configured shell commands must pass.
Maps naturally to Notor's existing `execute_command` tool + hook system.

Implementation: After hat LLM turn completes but before routing the event,
run configured gate commands. If any fail, inject failure feedback into
the next hat turn (rather than routing the event).

---

## Architecture of the Orchestration Engine

```
OrchestrationRunner
  ├── EventEngine (pub/sub)
  ├── HatRegistry (loaded from preset note)
  ├── HatTurnExecutor (calls existing ChatOrchestrator)
  ├── BackpressureGates (shell command runner)
  ├── OrchestrationSession (tracks state)
  └── UI: OrchestrationView (special Obsidian view)

Flow:
  1. User invokes orchestration preset (command palette or slash command)
  2. OrchestrationRunner.start(presetNote, promptText)
  3. Load hats from preset's hat list
  4. Publish starting_event
  5. EventEngine finds matching hat for event
  6. HatTurnExecutor.executeHatTurn(hat, event, session)
     a. Assemble system prompt (global + guardrails + hat instructions)
     b. Build user message from event payload + current vault context
     c. Execute via ChatOrchestrator.sendMessage()
     d. If LLM calls emit_event tool: capture event
     e. Run backpressure gates for the emitted event
     f. If gates pass: EventEngine.publish(event)
     g. If gates fail: inject failure feedback, re-run hat
  7. EventEngine routes to next hat matching the topic
  8. Repeat until LOOP_COMPLETE or limits exceeded
  9. Finalize session, update conversation
```

---

## UI Approach

### Orchestration Conversation View

Each orchestration session creates a special conversation that shows:
- **Hat turns as collapsible sections**: each hat's output folded under a header
- **Event flow visualization**: breadcrumb showing event chain (e.g., `build.start → tasks.ready → review.ready → review.passed`)
- **Tool calls within hat turns**: using the existing approval UI
- **Live status indicator**: which hat is currently executing
- **Session controls**: pause, stop, inject steering input

This could be implemented as:
- A new `OrchestrationView` (ItemView)
- Or as special rendering within the existing `ChatView` with a new rendering mode

### Mapping to Existing Chat UI

The simplest approach: each hat turn appears as a separate "message group" in the
chat view, with the hat name shown as a label. The LLM's output is shown normally,
tool calls work with the existing approval UI. Events emitted by the LLM are shown
as special "event" markers in the chat.

---

## Hat Notes as "Personas" Extension

An elegant mapping: hats are essentially personas scoped to an orchestration.
Notor already has a persona system with system prompt overrides. Extending it to
support "hat mode" (with triggers/publishes) would allow hat notes to use the
full persona system (provider overrides, model selection per hat).

This means:
- Each hat can use a different LLM model (e.g., planner uses Sonnet, builder uses Haiku)
- Each hat can have different auto-approve settings for tools
- Hats are just personas with additional orchestration metadata

---

## Shared State via Vault Notes

Ralph uses shared files (scratchpad, plan, progress) that persist between hat turns.
In Notor, these map naturally to vault notes:
- The orchestration session could have a "workspace folder" (e.g., `notor/orchestrations/sessions/{id}/`)
- Hat instructions reference these via `<include_note>` tags
- Hats write to these notes using the `write-note` and `replace-in-note` tools
- Checkpoints protect these files from accidental corruption

This is a huge advantage of the in-process approach: hats write to the Obsidian vault
directly, with full checkpoint protection and diff view for reviews.

---

## Mapping Ralph Tools to Notor Tools

| Ralph Tool | Notor Equivalent |
|------------|-----------------|
| `ralph emit <event> <payload>` | `emit_event` tool (new) |
| `ralph tools task ensure/start/close` | `manage_task` tool (new) or vault note CRUD |
| `ralph tools task show` | `read_note` on task note |
| `ralph tools interact progress` | N/A — could be `send_user_message` for human-in-loop |
| `ralph tools memory add` | `write-note` to a memories vault note |
| General shell commands | `execute_command` (already exists) |
| File read/write | `read-note`, `write-note` (already exist) |
| Search | `search-vault` (already exists) |

The `emit_event` tool is the most critical new addition.

---

## Implementation Priority

### Phase 1: Minimal Viable Orchestration

1. Parse orchestration preset from vault note (hats list + loop config)
2. Load hat definitions from vault notes (triggers/publishes/instructions)
3. Build minimal EventEngine (in-memory pub/sub)
4. Build HatTurnExecutor using existing `sendMessage()` pipeline
5. Add `emit_event` tool to tool registry (available in orchestration mode only)
6. Build OrchestrationRunner that wires these together
7. Minimal UI: shows hat turns in chat view with event markers

**This Phase 1 would implement the core event loop and allow running presets like code-assist.**

### Phase 2: Task Registry

1. Add runtime task tracking (vault notes or SQLite)
2. Add `manage_task` tool (ensure/start/close/show)
3. Add task list view in UI

### Phase 3: Backpressure Gates

1. Add gate configuration to preset notes
2. Run gate commands after hat turn, before event routing
3. Inject failure feedback into hat on gate failure

### Phase 4: Interactive Planning Mode

1. Add `user.prompt` event handling in event engine
2. Pause execution when `user.prompt` emitted
3. Show prompt in chat UI as a question
4. Resume on user response

### Phase 5: Preset Library

1. Convert ralph's builtin presets to Notor vault format
2. Add preset browser in settings or command palette
3. Template system for creating new presets

---

## Key Differences from Ralph

### What's Easier in Notor

- **Vault integration** — hats can read/write any note; no file path gymnastics
- **Tool approval** — existing rich diff/approval UI automatically applies to orchestration
- **Checkpoint protection** — existing checkpoint system protects notes during orchestration
- **Provider flexibility** — each hat can use a different provider/model via persona
- **No subprocess management** — no ProcessSupervisor, no log file tailing
- **Integrated UI** — orchestration visible in Obsidian alongside notes being modified

### What's Harder in Notor

- **Backend adapters** — Ralph has many backends (Claude, Gemini, Codex, Kiro, Amp); Notor
  uses its provider system which currently supports Anthropic, OpenAI, Bedrock, local
- **Parallel loops** — Ralph supports git worktree-based parallel execution; Notor is single-process
- **Backpressure enforcement** — needs new implementation
- **CLI tool ecosystem** — Ralph has `ralph tools task`, `ralph emit`, etc.; Notor needs new tools
- **Process survival across restarts** — Ralph processes survive server restart; Notor orchestration
  is in-memory and would need checkpoint/resume logic to survive plugin reload

---

## Risk Assessment

### Low Risk
- Event engine implementation (well-understood pub/sub)
- Hat note format (clear YAML frontmatter schema)
- HatTurnExecutor (thin wrapper around existing sendMessage)
- `emit_event` tool (straightforward tool addition)

### Medium Risk
- Orchestration UI (need good UX for showing multi-hat conversation)
- Task registry design (which storage model is best)
- Preset migration from YAML to vault notes (format translation)
- Context management per hat (each hat needs fresh context vs shared context)

### High Risk
- Handling very long orchestrations (token budgeting across many hat turns)
- Backpressure gate reliability (shell commands may be slow or flaky)
- Debugging failed orchestrations (need good logging/trace)
- hat prompt engineering (ralph's instructions are very detailed; reproducing them well matters)
