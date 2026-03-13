# Ralph Orchestrator: Core Architecture

> Research compiled from direct source analysis of `../ralph-orchestrator/`.
> Source: `backend/ralph-web-server/src/`

## What Ralph Is

Ralph is a **multi-hat, event-driven AI agent orchestration system**. It runs a loop where
specialized AI agent roles ("hats") collaborate by publishing and subscribing to named events.
The whole workflow is defined in a YAML preset file.

The key differentiation from Notor's current single-turn workflow: Ralph produces **multi-step
autonomous execution** — an LLM plays the Planner role, emits an event, another LLM turn plays
the Builder role, emits an event, and so on, until a terminal "loop complete" signal is reached.

---

## Event Loop Model

```
YAML Preset defines:
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

### How It Flows

1. `ralph run -c preset.yml -P prompt.txt` is invoked as a subprocess
2. Ralph injects the starting event (`build.start`)
3. Hat matching `build.start` (planner) gets an LLM turn with its instructions + the event payload
4. The LLM emits a `ralph emit tasks.ready '{"task_id":"..."}' ` call from its tool belt
5. Ralph routes `tasks.ready` to the builder hat
6. Steps 3–5 repeat until `LOOP_COMPLETE` is emitted or max_iterations/max_runtime hit
7. Each LLM turn's output (JSONL events) is parsed from stdout by `RalphEventParser`

### Event Wire Format

Ralph emits JSONL events to stdout:
```json
{"ts":"2025-01-15T10:00:00Z","iteration":3,"hat":"builder","topic":"review.ready","payload":{"task_id":"xyz"}}
```

Fields: `ts` (ISO timestamp), `iteration` (number), `hat` (emitting hat name),
`topic` (event name), `triggered` (what caused this), `payload` (string or object).

---

## Hat Preset YAML Schema

```yaml
# Top-level sections
event_loop:
  prompt_file: "PROMPT.md"         # optional input file
  completion_promise: "LOOP_COMPLETE"
  starting_event: "build.start"
  max_iterations: 100
  max_runtime_seconds: 14400
  checkpoint_interval: 5           # how often to checkpoint state

cli:
  backend: "kiro"                  # which AI backend adapter to use
  prompt_mode: "arg"               # how prompt is passed to the CLI

core:
  specs_dir: ".agents/scratchpad/" # where specs/docs go
  guardrails:                      # injected into every LLM system prompt
    - "Verification is mandatory"
    - "YAGNI ruthlessly"

backpressure:
  gates:                           # shell commands that must pass before publish
    - name: fmt
      command: cargo fmt --all -- --check
      on_fail: "Formatting failed..."

hats:
  planner:
    name: "📋 Planner"
    description: "Short description"
    triggers: ["build.start", "queue.advance"]
    publishes: ["tasks.ready", "all_steps.done"]
    default_publishes: "tasks.ready"   # emitted if no explicit emit
    instructions: |
      ## PLANNER MODE
      Full markdown instructions for the LLM playing this role...

events:                            # optional metadata about events
  build.start:
    description: "Triggers the build cycle"
  tasks.ready:
    description: "A task is ready for building"
```

---

## Preset Collection System

Ralph has three sources of presets:
1. **Builtin** — `presets/` at repo root (shipped with ralph), e.g. `code-assist.yml`, `research.yml`, `review.yml`
2. **Directory** — `.ralph/hats/*.yml` in the user's project directory
3. **Collection** — Visual workflow builder in the web UI exports to YAML (stored in SQLite `collections` table)

Preset IDs follow the pattern:
- `builtin:code-assist`
- `directory:my-hat`
- UUID (for collection presets)

---

## ConfigMerger: Merging Presets with Base Config

When a task runs with a preset, `ConfigMerger.merge(basePath, preset)`:
1. Loads `ralph.yml` (user's base config)
2. Loads the preset YAML (from builtin/directory/collection)
3. Replaces only `hats` and `events` sections from the preset
4. Preserves all other base config settings (max_iterations, backend, guardrails, etc.)
5. Writes merged YAML to a temp file
6. Passes `-c <tempPath>` to the `ralph run` subprocess

This gives users the ability to define project-level settings in `ralph.yml` and override
just the hat workflow for individual tasks.

---

## Process Execution Model

### ProcessSupervisor

Manages detached ralph subprocess instances that survive server restarts.

```
~/.ralph/web/runs/{taskId}/
  pid          # process ID
  status.json  # { state, startedAt, completedAt, exitCode, signal, durationMs }
  prompt.txt   # the prompt passed to ralph
  stdout.log   # stdout captured by file redirection
  stderr.log   # stderr captured by file redirection
```

Key characteristics:
- Uses `spawn(command, args, { detached: true, stdio: ["ignore", stdoutFd, stderrFd] })`
- Child process `unref()`'d — survives server restart
- Process liveliness checked via `process.kill(pid, 0)` (signal 0 = existence check)
- On reconnect: reads PID from `pid` file, checks if alive

### FileOutputStreamer

Tails log files from the task directory, emitting lines to a callback:
- Uses file system watching or polling to detect new content
- Separate tracking for stdout vs stderr
- Streams to `LogStream` for in-memory buffering

### PromptWriter

Writes prompt content to a temp file and passes via `-P <filepath>` flag.
Supports both plain text and structured JSON prompt objects.

---

## RalphRunner State Machine

```
IDLE → SPAWNING → RUNNING → COMPLETED
                          → FAILED
                          → CANCELLED (via stop())
```

- `run(prompt, args, signal)` — starts the subprocess, returns Promise<RunnerResult>
- `stop(force?)` — sends SIGTERM (then SIGKILL after timeout)
- `dispose()` — force-kills and cleans up
- `reset()` — returns to IDLE for reuse

### RunnerResult

```typescript
interface RunnerResult {
  state: RunnerState;
  exitCode?: number;
  signal?: string;
  stdout: string;
  stderr: string;
  combined: string;     // interleaved by timestamp
  durationMs: number;
  error?: string;
}
```

---

## Dispatcher: Task Queue Engine

The `Dispatcher` is the polling engine that:
1. Polls `TaskQueueService` every 100ms for pending tasks
2. Dequeues up to `maxConcurrent` tasks (default: 1 for sequential)
3. Invokes registered `TaskHandler` functions
4. Manages state transitions with timeout and cancellation support
5. Publishes lifecycle events via `EventBus`

### Event Types

```typescript
type DispatcherEventType =
  | "dispatcher.started" | "dispatcher.stopped" | "dispatcher.idle"
  | "task.started" | "task.completed" | "task.failed"
  | "task.cancelled" | "task.timeout";
```

### TaskHandler Contract

```typescript
type TaskHandler<TPayload, TResult> =
  (task: QueuedTask, context: TaskExecutionContext) => Promise<TResult>;

interface TaskExecutionContext {
  eventBus: EventBus;
  correlationId: string;
  signal: AbortSignal;   // for cancellation
}
```

---

## TaskBridge: DB ↔ Queue Coordination

`TaskBridge` is the service that connects the user-facing task database with the execution queue:

```
UI creates task → tRPC task.create
  → TaskBridge.enqueueTask(dbTask, preset)
    → TaskQueueService.enqueue({ type: "ralph.run", payload: { prompt, args, cwd } })
    → taskIdMap: queuedTaskId → dbTaskId
    → DB: update task status = "pending"

Dispatcher picks up → RalphRunner executes
  → EventBus: "task.started" → TaskBridge → DB: status = "running"
  → EventBus: "task.completed" → TaskBridge → DB: status = "closed" + summary
  → EventBus: "task.failed" → TaskBridge → DB: status = "failed" + error
```

`TaskBridge` also handles:
- **Execution summary**: reads `.agent/scratchpad.md` or `.agent/summary.md` from the repo for rich completion info
- **Loop ID resolution**: polls `.ralph/loops.json` to link tasks to their loop IDs
- **Recovery**: marks stuck "running" tasks as failed on restart; reconnects live processes

---

## LogBroadcaster: Real-Time Streaming

WebSocket-based log streaming to the frontend:

```typescript
// Per-connection: subscribe to a task ID
broadcast(taskId, logEntry)       // individual log line
broadcastStatus(taskId, status)   // state change ("starting", "running", etc.)
broadcastError(taskId, errorMsg)  // error message
broadcastEvent(taskId, event)     // parsed Ralph JSONL event

// Message format
interface LogMessage {
  type: "log" | "status" | "error" | "event";
  taskId: string;
  data: LogEntry | { status: string } | { error: string } | RalphEvent;
  timestamp: string;
}
```

Features:
- Client subscribes with task ID; can request backlog from a given log entry ID
- Logs persisted to `task_logs` DB table (for replay on reconnect)
- Singleton pattern; configured with optional `TaskLogRepository`

---

## Database Schema (SQLite / Drizzle ORM)

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

---

## LoopsManager: Parallel Worktree Execution

For projects that run multiple ralph loops in parallel (each in a git worktree):

```typescript
// Operations via ralph CLI subprocess
processMergeQueue()         // ralph loops process
listLoops()                 // ralph loops list --json
pruneStale()                // ralph loops prune
retryMerge(id, steering?)   // ralph loops retry <id>
discardLoop(id)             // ralph loops discard -y <id>
stopLoop(id, force?)        // ralph loops stop [--force] <id>
mergeLoop(id, force?)       // ralph loops merge [--force] <id>
getMergeButtonState(id)     // ralph loops merge-button-state <id>
```

`LoopsManager` runs a periodic interval (default 30s) to automatically process the merge queue.

---

## PlanningService: Interactive Planning Sessions

The planning service supports interactive back-and-forth sessions:

1. Creates a session directory at `.ralph/planning-sessions/{sessionId}/`
2. Spawns `ralph run -c presets/planning.yml -p "{prompt}" --no-tui`
3. Polls `.ralph/current-events` to read Ralph's events file
4. Detects `user.prompt` events (where ralph asks the user a question)
5. Appends Q&A to `conversation.jsonl`
6. User responses submitted via tRPC `planning.respond`

Session structure:
```
.ralph/planning-sessions/{sessionId}/
  session.json         # metadata: id, prompt, status, created_at, iterations
  conversation.jsonl   # {"type":"user_prompt/user_response","id":"...","text":"...","ts":"..."}
  artifacts/           # any files generated during planning
```

---

## tRPC API Surface

Top-level routers in `appRouter`:
- `task.*` — CRUD + run/retry/cancel/archive/clearAll
- `hat.*` — list/get/setActive/save/delete hats (from DB settings)
- `loops.*` — list/process/prune/retry/discard/stop/merge/triggerMergeTask/mergeButtonState
- `collection.*` — list/get/create/update/delete/exportYaml/importYaml
- `presets.*` — list (builtin + directory + collections)
- `config.*` — get/update ralph.yml
- `planning.*` — list/get/start/respond/resume/delete/getArtifact
