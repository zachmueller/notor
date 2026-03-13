# Ralph Backend Services: Deep Dive

> Detailed analysis of each backend service module for integration planning.
> Source: `../ralph-orchestrator/backend/ralph-web-server/src/`

---

## EventBus (`queue/EventBus.ts`)

Ralph's internal pub/sub system (separate from the hat event loop):
- Used for Dispatcher lifecycle events (`task.started`, `task.completed`, etc.)
- Subscribers receive `Event<TPayload>` objects with `id`, `topic`, `payload`, `correlationId`
- Synchronous and async publish variants
- Returns `Subscription` with `unsubscribe()` method

```typescript
class EventBus {
  subscribe<T>(topic: string, handler: (event: Event<T>) => void): Subscription
  publish<T>(topic: string, payload: T, options?: {correlationId?}): Promise<void>
  publishSync<T>(topic: string, payload: T): void
  listSubscriptions(): Map<string, number>  // topic → count
}
```

**Notor integration:** Notor already has a hook system that fires events. The orchestration
event engine would be a NEW pub/sub system separate from the existing hook system — specifically
for hat-to-hat event routing within an orchestration session.

---

## TaskQueueService (`queue/TaskQueueService.ts`)

In-memory task queue:
```typescript
class TaskQueueService {
  enqueue({ taskType, payload, priority }): QueuedTask
  dequeue(): { task: QueuedTask | null }
  getTask(id): QueuedTask | undefined
  complete(id): void
  fail(id, error): void
  cancel(id): void
  getPendingCount(): number
  getRunningCount(): number
}
```

State machine: PENDING → RUNNING → COMPLETED/FAILED/CANCELLED

**For Notor:** The orchestration engine manages its own execution flow in-process;
no separate task queue needed for the basic case. If we want to support queued/deferred
orchestration starts (e.g., schedule an orchestration), we'd need this pattern.

---

## PersistentTaskQueueService (`queue/PersistentTaskQueueService.ts`)

SQLite-backed version of TaskQueueService:
- Persists queue state across server restarts
- On startup: recovers pending tasks (re-queues) and running tasks (marks as failed or reconnects)
- Uses `queued_tasks` table from schema

**For Notor:** If we want orchestration sessions to survive plugin reloads,
we need either this pattern or a different persistence approach (e.g., vault notes for state).

---

## CollectionService (`services/CollectionService.ts`)

Manages the visual workflow builder (React Flow graph → YAML export):
- CRUD for collections in `collections` DB table
- `exportToYaml(id)`: Converts React Flow graph data → Ralph YAML preset format
  - Each graph node = a hat (with its configuration)
  - Graph edges show event routing (source event → target hat)
- `importFromYaml(yaml, name)`: Parses Ralph YAML → React Flow graph

The collection format stores:
```json
{
  "nodes": [{"id": "n1", "type": "hat", "position": {"x":0,"y":0}, "data": {"key":"planner","name":"...","triggersOn":[],"publishes":[],"instructions":"..."}}],
  "edges": [{"id": "e1", "source": "n1", "target": "n2", "label": "tasks.ready"}],
  "viewport": {"x": 0, "y": 0, "zoom": 1}
}
```

**For Notor:** A visual hat flow builder (like n8n) would be a compelling future feature.
But for MVP, vault notes as hat definitions + preset notes as collections is sufficient.

---

## HatManager (`services/HatManager.ts`)

Loads YAML hat preset files:
```yaml
# .ralph/hats/my-hat.yml
name: "Custom Hat"
description: "Description"
triggers: [build.start]
publishes: [result.done]
default_publishes: result.done
mcp_servers:                    # optional MCP server configs for this hat
  my-server:
    command: npx
    args: ["-y", "my-mcp-server"]
    env: {}
instructions: |
  Your detailed instructions...
```

Validates with Zod, caches in memory, supports `listPresets()` and `load(name)`.

**For Notor:** Hat definitions are vault notes (frontmatter + body = configuration + instructions).
The body content is the hat's instructions (same as Ralph's `instructions` field).

---

## SettingsService (`services/SettingsService.ts`)

Manages persona (system prompt personality) and hat (operational role) configurations
in SQLite settings table.

In Ralph's web UI context:
- Persona = personality/voice layer (system prompt)
- Hat = operational role definition (triggers/publishes)
These are separate concepts from the YAML preset hats.

**For Notor:** Notor already has the persona system. Hats are the new concept.
The `persona` + `hat` concepts in Ralph settings map to:
- Persona → Notor's existing Persona system (system-prompt.md files)
- Hat definitions from settings → Notor's vault-note-based hat system

---

## ConfigMerger (`services/ConfigMerger.ts`)

Deep dive into the merge algorithm:

```typescript
merge(basePath, preset):
  1. Load base ralph.yml
  2. If preset === "default": return base as-is
  3. Resolve preset (builtin/directory/collection/UUID)
  4. Extract from preset: { hats, events, eventLoopOverrides }
     - hats: Record<string, HatConfig>
     - events: derived from hat triggers/publishes if not explicit
     - eventLoopOverrides: only starting_event is carried over
  5. Merge: { ...baseConfig, hats, events, event_loop: { ...base.event_loop, ...overrides } }
  6. Write to temp file, return { config, tempPath }
```

**For Notor:** When running an orchestration from a preset note, Notor builds
the effective configuration by combining:
- Global settings (from Notor settings: provider, model, context limits)
- Orchestration preset note (hats list, loop config)
- Individual hat notes (triggers, publishes, instructions)

No file merging needed — Notor builds the config in-memory from these sources.

---

## RalphEventParser (`runner/RalphEventParser.ts`)

Parses JSONL events from ralph's stdout:
```typescript
// Detects lines matching: { "topic": "...", ... }
// Returns: { ts, iteration?, hat?, topic, triggered?, payload }
class RalphEventParser {
  parseLine(line: string): void  // fires callback if line is event JSON
  static isEventLine(line: string): boolean
}
```

**For Notor:** Not needed in native implementation — instead, the LLM calls
the `emit_event` tool when it wants to publish an event.

---

## PlanningService — Interactive Session Detail

```
Session lifecycle:
  startSession(prompt) →
    create directory, spawn ralph, start event polling

  pollEventsFile() [every 500ms] →
    read .ralph/current-events → get path to events JSONL
    parse JSONL for "user.prompt" events
    append to conversation.jsonl
    update session status to waiting_for_input

  submitResponse(sessionId, promptId, response) →
    append to conversation.jsonl
    update session status to active

  ralph process reads conversation.jsonl for responses,
  continues when response appears
```

The polling mechanism is necessary because Ralph is a subprocess — there's no
direct API. In Notor's native implementation, the LLM calling `user.prompt`
(or equivalent) would directly pause the orchestration and show a prompt in the UI.

**For Notor:** "Interactive orchestration" — where a hat needs human input —
maps to:
1. Hat emits a special `user.input.required` event with a question in payload
2. OrchestrationEngine pauses, shows question in chat view
3. User types response
4. Response injected into next hat turn as context
5. Orchestration resumes

---

## LogStream (`runner/LogStream.ts`)

In-memory buffer for process output:
- Maintains separate stdout/stderr buffers
- Interleaves by timestamp for combined view
- `maxBufferSize` prevents OOM
- `getStdoutText()`, `getStderrText()`, `getCombinedText()`
- `writeStdout(buffer)`, `writeStderr(buffer)` — called from FileOutputStreamer

**For Notor:** Hat output is the LLM's response text, captured naturally
by the existing streaming mechanism. No need for a separate log stream.

---

## FileOutputStreamer (`runner/FileOutputStreamer.ts`)

Tails log files from the ProcessSupervisor's task directory:
- Maintains file read position per task
- Polls for new content
- Handles file rotation/truncation
- Emits new lines to callback with source tag (stdout/stderr)

**For Notor:** Not needed — no subprocess, no log files.

---

## ProcessSupervisor Key Behaviors for Notor Reference

Even if not using ProcessSupervisor directly, its patterns inform Notor's design:

1. **Task ID as directory name** — clean correlation between task and its artifacts
2. **Status.json persistence** — small JSON file tracks state across restarts
3. **PID file** — simple liveness check without a full process registry
4. **Detached + unref** — process survives parent restart; critical for long-running tasks
5. **signal(0) for liveness** — idiomatic Node.js process existence check

**For Notor:** If we DO want orchestrations to survive plugin reload:
- Write a `session.json` to the vault with current orchestration state
- On plugin load: check for incomplete sessions, offer to resume
- State includes: current iteration, last event, which hat was active

---

## Summary: What Notor Needs to Build

| Ralph Component | Notor Need | Implementation Complexity |
|-----------------|-----------|--------------------------|
| EventBus | OrchestrationEventEngine | Low — simple pub/sub |
| HatManager | HatNoteParser | Low — parse vault note frontmatter |
| PresetLoader | OrchestrationPresetNote | Low — parse vault note |
| ConfigMerger | In-memory config assembly | Low — no file I/O |
| RalphRunner | HatTurnExecutor (calls sendMessage) | Medium — wires into existing system |
| RalphTaskHandler | OrchestrationSessionManager | Medium |
| Dispatcher | OrchestrationRunner (replaces polling with direct execution) | Low |
| ProcessSupervisor | N/A (in-process) | Not needed |
| FileOutputStreamer | N/A (streaming already works) | Not needed |
| LogBroadcaster | ChatView already shows output | Not needed |
| RalphEventParser | emit_event tool | Low |
| TaskBridge | OrchestrationConversationBridge | Medium |
| PlanningService | User input in orchestration | Medium |
| LoopsManager | N/A (no git worktrees in Notor) | Not needed initially |
| CollectionService | Future: visual workflow builder | High — defer |
| TaskQueueService | In-memory session state | Low |
| DB schema | New tables: orchestration_sessions, orchestration_events, tasks | Medium |
