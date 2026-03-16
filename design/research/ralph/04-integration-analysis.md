# Integration Analysis: Bringing Ralph Orchestration Into Notor

> Synthesizes architecture of both systems to identify integration points,
> mapping, and implementation strategy.
>
> **Updated:** Reflects Rust core implementation details, not just the Node.js management layer.

---

## The Core Problem

Notor's current workflow system executes a **single LLM session** per workflow invocation.
The LLM can use tools within that session, but there's no multi-role orchestration,
no event routing between specialized agents, and no loop completion contract.

Ralph's orchestration model provides:
1. **Multi-hat event loops** — different LLM roles collaborate through named events
2. **Persistent shared state** — hats read/write shared files (scratchpad, tasks, memories)
3. **Loop completion semantics** — loops run until a `LOOP_COMPLETE` event or limits hit
4. **Quality gates** — backpressure validates evidence in event payloads before routing
5. **Interactive planning** — loops can pause for human input

**Goal:** Implement this same orchestration capability natively inside Notor as an
Obsidian plugin, without requiring an external Ralph CLI subprocess.

---

## Conceptual Mapping

| Ralph Concept | Notor Equivalent (Current) | Notes |
|---------------|---------------------------|-------|
| Hat (role definition) | Workflow note | Ralph hat = named role with triggers/publishes/instructions |
| Hat instructions | Workflow body content | Already similar structure |
| Preset YAML | New "Orchestration Preset" vault note | Need new frontmatter schema |
| Event loop | New core engine | Does not exist yet |
| Event pub/sub | N/A | Needs to be built |
| `ralph emit` shell command | `emit_event` tool call | Different mechanism — see below |
| HatlessRalph prompt builder | New: HatSystemPromptBuilder | Ralph's runtime builder; hat instructions alone are not enough |
| HatlessRalph fallback coordinator | New: fallback hat | Needed to handle orphaned events |
| runtime tasks (`ralph tools task`) | N/A | Notor has no task tracker |
| `.ralph/agent/memories.md` | Vault note (cross-session) | Maps well to a memories vault note |
| Shared scratchpad files | Vault notes | Natural fit — vault is Ralph's project files |
| Lifecycle hooks (pre/post loop phases) | Partial via existing vault hooks | Ralph's loop-phase hooks are a distinct concept |
| guardrails | Could be part of system prompt | Already have vault rules system |
| Per-hat `mcp_servers` | Notor already has MCP support | McpHub manages connections; per-hat activation needs design |
| Backpressure evidence validation | New: payload text parser | LLM claims, engine validates the claim format |
| Loop thrashing detection | N/A | Needs to be built |
| Stale loop detection | N/A | Needs to be built |
| `required_events` validation | N/A | Blocks premature LOOP_COMPLETE |
| Loop completion | N/A | Needs new concept |
| Persona per hat | Per-hat persona assignment | Notor already has personas |

---

## The Key Architectural Decision: In-Process vs External Process

### Option A: Spawn Ralph CLI (External Process)

Notor would spawn `ralph run -c <preset> -P <prompt>` as a subprocess (like ralph-web-server does).

**Pros:** Reuses all existing ralph logic exactly; get all ralph features for free.

**Cons:**
- Requires Ralph CLI installed (external dependency)
- No vault integration during execution
- Can't use Notor's provider/persona/tool/approval systems
- Tool calls happen in a subprocess with no Obsidian UI

### Option B: Native In-Process Orchestration (Recommended)

Implement the event loop engine directly in TypeScript/Notor:
- Parse hat presets from vault notes
- Run each hat as a Notor `sendMessage()` call with hat-specific system prompt
- Route events between hats using an in-memory pub/sub engine
- Use Notor's existing tool system during each hat turn
- Show each hat turn as messages in a special "Orchestration Conversation"

**Pros:**
- Full vault integration (hat turns read/write vault notes natively)
- Notor's existing provider, persona, tool, and approval systems apply per hat turn
- Rich UI: each hat's output visible, tool approvals work normally
- No external dependency

**Cons:**
- Significant engineering effort to build the event loop engine
- Some Ralph features (lifecycle hooks, worktree loops) need adaptation

**Recommendation: Option B.** Most powerful and most integrated.

---

## New Concepts Needed in Notor

### 1. Hat Definition (vault note)

A hat is a named role with triggers, publishes, and instructions. Stored as a vault note
with `notor-type: hat` frontmatter; note body = hat's custom instructions.

```yaml
---
notor-type: hat
notor-hat-name: "📋 Planner"
notor-hat-triggers:
  - build.start
  - queue.advance
notor-hat-publishes:
  - tasks.ready
  - all_steps.done
notor-hat-default-publishes: tasks.ready
notor-hat-persona: planner-persona    # optional Notor persona override
notor-hat-model: claude-opus-4-6      # optional model override
---

## PLANNER MODE — Step-Wave Strategy

You manage decomposition and queue progression.
Do not implement. Do not review.
...
```

### 2. Orchestration Preset (vault note)

```yaml
---
notor-type: orchestration-preset
notor-preset-name: "Code Implementation"
notor-loop-starting-event: build.start
notor-loop-completion-promise: LOOP_COMPLETE
notor-loop-max-iterations: 100
notor-loop-max-runtime-minutes: 240
notor-loop-required-events:          # LOOP_COMPLETE rejected unless these were seen
  - review.approved
notor-hats:
  - notor/orchestrations/hats/planner.md
  - notor/orchestrations/hats/builder.md
  - notor/orchestrations/hats/critic.md
  - notor/orchestrations/hats/finalizer.md
notor-guardrails:
  - "Verification is mandatory — tests must pass"
  - "YAGNI ruthlessly"
  - "Confidence >80: proceed. 50-80: document in decisions. <50: safe default."
---
```

### 3. `emit_event` Tool

In Ralph, the LLM emits events by running `ralph emit "topic" "payload"` as a shell command,
which writes to a JSONL file. **Notor uses a real tool call instead** — cleaner and avoids
the file-polling indirection. The mechanism is better; the LLM behavior is identical.

```typescript
{
  name: "emit_event",
  description: "Publish an orchestration event to advance the workflow to the next hat.",
  parameters: {
    topic: { type: "string", description: "Event topic name, e.g. tasks.ready" },
    payload: { type: "string", description: "Evidence or context for the next hat" }
  }
}
```

When called, the tool writes the event to `session-log.jsonl` (write-before-route) for crash
recoverability — an emitted event exists on disk even if the process dies before the next turn starts —
then signals the engine to route after the hat turn ends. No file polling is needed; the file write
still happens.

### 4. HatSystemPromptBuilder (equivalent to Ralph's HatlessRalph)

Hat instructions cannot be passed raw to the LLM — they need a structural scaffold.
Ralph's **runtime** prompt builder is `HatlessRalph.build_prompt()`, which operates in
two modes depending on whether a hat is active:

- **Coordination mode** (no active hat): injects a `## HATS` topology table (event routing
  summary across all hats) and a Mermaid diagram, so the agent understands the full workflow
- **Hat-active mode**: injects an `## ACTIVE HAT` section with the hat's instructions
  verbatim, plus an Event Publishing Guide listing the hat's allowed `publishes` events

Note: `InstructionBuilder.build_custom_hat()` (the numbered ORIENTATION/EXECUTE/VERIFY/REPORT
scaffold) is explicitly marked **"backward compatibility and tests"** in the source code — it
is not the runtime path.

**For Notor's in-process design**, each hat gets its own `sendMessage()` call (unlike Ralph
where "ralph" always executes). We need our own scaffold. The numbered structure below is a
reasonable Notor design choice even though it differs from Ralph's runtime approach:
Ralph wraps hat instructions verbatim; Notor can add more explicit framing since the
context window starts fresh per hat turn.

Ralph's `HatlessRalph.build_prompt()` injects these persistent sections into **every** prompt,
before the hat-specific content. Notor's builder should do the same:

```
### 0. ORIENTATION / SCRATCHPAD / STATE MANAGEMENT / GUARDRAILS
[skill index — compact reference table]
## OBJECTIVE       ← the user's original prompt; set once at start, injected every iteration
## PENDING EVENTS  ← events that triggered this hat turn
```

Full proposed scaffold for each hat turn:
```
You are {hat.name}. You have fresh context each iteration.

### 0. ORIENTATION
You MUST study the incoming event context.
You MUST NOT assume work isn't done — verify first.

### 0b. TOOL DISCIPLINE
Session state lives in orchestration workspace notes, not ad hoc text.
You MUST check open tasks before creating new ones.
If blocked or a command fails, record it in decisions.md.
[...task/memory/workspace tool discipline...]

### 1. EXECUTE
{hat.instructions}          ← the hat's custom content

### 2. VERIFY
You MUST run the required checks before reporting done.

### 3. REPORT
You MUST call emit_event with one of: {hat.publishes}
Narrative summaries do NOT count as event emission.
You MUST call emit_event before ending your turn or the loop will terminate.

### GUARDRAILS
999. {guardrail_1}
1000. {guardrail_2}

---
## OBJECTIVE

{original_user_prompt}

## PENDING EVENTS

Triggering event: {event.topic}
Payload: {event.payload}
```

The must-publish rule in section 3 is **always injected** even when a hat has explicit
instructions. This is critical — without it, LLMs regularly forget to emit and the loop stalls.

### 5. FallbackCoordinator (equivalent to HatlessRalph)

Always register a catch-all "Notor" hat that handles any event with no other subscriber.
Without this, a single misnamed event topic silently stalls the loop.

Behavior: when triggered by an orphaned event, the coordinator figures out what to do —
typically injects a helpful error message or steers back to a known state.

### 6. OrchestrationEventEngine

The core pub/sub routing:

```typescript
class OrchestrationEventEngine {
  publish(topic: string, payload: string): void  // write-before-route: appends to session log first
  subscribe(topic: string | "*", handler: EventHandler): Unsubscribe
  getSubscribers(topic: string): HatDefinition[]
  getEventHistory(): OrchestrationEvent[]
}
```

The engine supports wildcard subscriptions (`*`) for the fallback coordinator.

**Write-before-route:** `publish()` must append the event to the session log (`session-log.jsonl`)
*before* delivering it to any subscriber. This mirrors Ralph's file-write model and is the
foundation of crash recovery — an emitted event exists on disk even if the process dies before
the next turn starts.

### 7. Loop Safety Mechanisms

Ralph has 13 termination conditions (see `01-ralph-architecture.md`). The minimum
set Notor needs for safety:

| Mechanism | How |
|-----------|-----|
| `max_iterations` | simple counter check each iteration |
| `max_runtime` | `Date.now() - startedAt > maxMs` check each iteration |
| **Stale loop** | If same (topic + payload) seen 3+ times in a row → terminate |
| **Thrashing** | If planner redispatches 3+ already-abandoned tasks (tracked via per-task block counts) → terminate |
| `default_publishes` synthesis | When hat produces no emit_event call, synthesize the default |
| `required_events` enforcement | Reject LOOP_COMPLETE until all required events have been seen |

Stale loop and thrashing detection prevent infinite token burn on stuck loops.

### 8. Runtime Task Registry

Tasks at `.ralph/agent/tasks.jsonl` — when enabled, the loop **rejects LOOP_COMPLETE**
if any tasks are open. This enforces that the LLM actually closes work before declaring done.

**Important:** In Ralph, LOOP_COMPLETE task rejection is gated on `config.memories.enabled`
(not `tasks.enabled`). Both the task system and memories share the same enable flag — if you
want task enforcement, you must enable memories. In Notor we can decouple these.

In Notor: vault notes are the right storage (visible in Obsidian, version-controlled).
The task completion check on LOOP_COMPLETE should be implementable in Phase 2.

**Task note format:**
```yaml
---
notor-type: orchestration-task
notor-task-status: open           # open | running | closed | failed
notor-task-key: step-01:impl
notor-task-created: 2025-01-15T10:00:00Z
---

# Add --verbose flag parsing

Implement --verbose in CLI entry point with focused tests.
```

Tools needed: `orchestration_task_ensure`, `orchestration_task_start`,
`orchestration_task_close`, `orchestration_task_list`.

### 9. Persistent Memory Note

Ralph's `.ralph/agent/memories.md` persists cross-session learnings (patterns, decisions,
fixes, context). The hat prompt builder explicitly tells every hat to search memories before acting in
unfamiliar territory and to record fix memories when blocked.

In Notor: a `{notor_dir}/orchestrations/memories.md` vault note. The `HatSystemPromptBuilder`
includes analogous instructions about reading and writing this note.

### 10. Backpressure Evidence Validation

The engine intercepts specific events and validates payload evidence before routing:
- `build.done` → check for `tests: pass, lint: pass, typecheck: pass, audit: pass, coverage: pass, complexity: <n>, duplication: pass`
- If evidence missing or failed → substitute `build.blocked`

This is payload text parsing, not shell command execution. The LLM is responsible for
actually running checks. The engine validates the claim format.

Notor should implement the same `build.done`/`build.blocked` pattern. The checked
events and required evidence fields can be configurable in the preset.

---

## Architecture of the Orchestration Engine

```
OrchestrationRunner
  ├── OrchestrationEventEngine (pub/sub + wildcard)
  ├── HatRegistry (loaded from preset note)
  │     └── FallbackCoordinator ("*" wildcard subscriber)
  ├── HatSystemPromptBuilder (wraps hat instructions in scaffold template)
  ├── HatTurnExecutor (calls existing sendMessage() pipeline)
  │     └── emit_event tool (injected per hat turn)
  ├── BackpressureValidator (parses payload evidence for build.done etc.)
  ├── LoopSafetyGuards (stale/thrashing/iteration/runtime/required-events checks)
  ├── OrchestrationSession (tracks state + workspace notes)
  └── UI: OrchestrationView

Flow:
  1. User invokes preset (command palette or slash command)
  2. OrchestrationRunner.start(presetNote, promptText)
  3. Load hats from preset; register FallbackCoordinator
  4. Publish starting_event
  5. EventEngine.getSubscribers(topic) → find matching hat(s)
  6. HatTurnExecutor.execute(hat, event, session):
     a. Append turn.start to session-log.jsonl (before sendMessage)
     b. HatSystemPromptBuilder assembles full system prompt
     c. Build user message from event payload + workspace note context
     d. Execute via sendMessage() with emit_event tool injected
     e. If LLM calls emit_event: capture topic + payload
     f. If no emit_event call: synthesize hat.default_publishes
     g. BackpressureValidator: intercept build.done etc., validate evidence
     h. If validation fails: substitute build.blocked
     i. LoopSafetyGuards: check iteration, runtime, stale, thrashing, required_events
     j. Append turn.complete to session-log.jsonl (after emit captured, before routing)
  7. EventEngine.publish(event) → appends event.emitted to session-log.jsonl → routes to next hat
  8. Repeat until LOOP_COMPLETE passes all checks, or a safety limit fires
  9. Finalize session, update workspace notes
```

---

## Mapping Ralph Tools to Notor Tools

| Ralph Tool | Notor Equivalent |
|------------|-----------------|
| `ralph emit "topic" "payload"` | `emit_event` tool call (new — cleaner mechanism) |
| `ralph tools task ensure/start/close` | `orchestration_task_ensure/start/close` (new) |
| `ralph tools task show` | `read_note` on task note (existing) |
| `ralph tools task list` | `orchestration_task_list` (new) |
| `ralph tools memory add/search` | `write_note` / `read_note` on memories.md (existing) |
| `ralph tools interact progress` | `send_user_update` for non-blocking status (new) |
| `ralph tools interact ask` | `user_input_required` — pauses loop (new, Phase 4) |
| General shell commands | `execute_command` (existing) |
| File read/write | `read_note`, `write_note` (existing) |
| Search | `search_vault` (existing) |

---

## Implementation Phases

### Phase 1: Minimal Viable Orchestration

**Goal:** Run a preset end-to-end with correct hat routing and loop termination.

Components:
1. `HatNoteParser` — reads hat vault note frontmatter + body
2. `OrchestrationPresetParser` — reads preset vault note
3. `OrchestrationEventEngine` — pub/sub with wildcard support; `publish()` uses write-before-route
4. `FallbackCoordinator` — catch-all `*` subscriber to prevent orphaned-event stalls
5. `HatSystemPromptBuilder` — wraps hat instructions in scaffold template (orientation / execute / verify / report / guardrails)
6. `HatTurnExecutor` — calls `sendMessage()` with hat system prompt + `emit_event` tool injected;
   writes `turn.start` marker before calling `sendMessage()`, `turn.complete` after emit captured
7. `emit_event` tool — captures topic + payload, signals engine after turn ends
8. `default_publishes` synthesis — fires when hat turn produces no emit call
9. **Session event log** (`sessions/{id}/session-log.jsonl`) — append-only JSONL; records
   `session.start`, `turn.start`, `event.emitted`, and `turn.complete` entries; written before
   routing. **Must be in Phase 1**, not Phase 2 — without it, crash recovery in Phase 2 has
   nothing to replay from.
10. Loop safety: max_iterations, max_runtime, stale-loop detection (3× same signature), thrashing detection (planner redispatching 3+ abandoned tasks)
11. `OrchestrationRunner` — the main loop that wires these together
12. Command palette: "Notor: Run Orchestration" → preset picker → initial prompt

**This Phase 1 makes the core loop functional.** Hats activate, emit events, route correctly,
and the loop terminates cleanly. The event log makes every run recoverable from Phase 2 onward.

### Phase 2: Session Workspace + Task Registry

**Goal:** Hats share state via vault notes; tasks are tracked and enforced; crashes are recoverable.

1. `OrchestrationSessionManager` — creates `sessions/{id}/` directory, persists `session.json`
2. Workspace notes: `context.md`, `plan.md`, `progress.md`, `decisions.md` auto-created
3. Hat turn logs written to `logs/{n}-{hat}-output.md`
4. Runtime task vault notes + tools: `orchestration_task_ensure/start/close/list`
5. LOOP_COMPLETE enforcement: reject if open tasks exist, inject resume context
6. Persistent memory note: `{notor_dir}/orchestrations/memories.md` (cross-session)
7. **Session recovery** — on plugin load, scan for sessions with `session.json` status `active`
   or `interrupted`:
   - Read `session-log.jsonl` (written in Phase 1) to find the last complete state
   - If last entry is `turn.start` with no matching `turn.complete`: turn was interrupted
     mid-execution → re-emit the triggering event (the hat turn retries cleanly)
   - If last entry is `event.emitted` or `turn.complete` with no following `turn.start`:
     event was emitted but not yet routed → re-publish the event to resume routing
   - Scan task notes to reconstruct task state (task notes on disk are authoritative)
   - Offer the user a "Resume orchestration?" prompt with a summary of where it left off
   - Hat instructions must be idempotent (check before acting) to make retry safe;
     document this as a hat authoring requirement

### Phase 3: Backpressure Evidence Validation

**Goal:** Build quality gates that can't be skipped.

1. `BackpressureValidator` — parse `build.done` payload for evidence strings
2. Required fields: tests, lint, typecheck, audit, coverage, complexity, duplication
3. On failure: substitute `build.blocked` with specific failure context
4. `required_events` enforcement on LOOP_COMPLETE
5. Configurable: preset can declare which events require evidence and what fields are required

### Phase 4: Interactive Orchestration

**Goal:** A hat can pause and ask the user a question.

1. `user.input.required` special event — pauses loop, shows question in chat view
2. User types response in chat; it's injected as context into the next hat turn
3. Session state: `active` / `waiting_for_input` / `paused` / `completed`
4. `orchestration_task_progress` non-blocking update (inform without pausing)

### Phase 5: Lifecycle Hooks

**Goal:** Observable loop phases that integrate with external systems.

1. Hook phase events: `pre/post.loop.start`, `pre/post.iteration.start`, `pre/post.plan.created`,
   `pre/post.human.interact`, `pre/post.loop.complete`, `pre/post.loop.error`
2. Shell commands registered in preset that fire at each phase
3. Rich JSON payload to hook stdin (session ID, iteration, active hat, etc.)
4. `on_error: warn | block | suspend` — `block` returns non-zero and aborts the loop;
   `suspend` pauses the loop pending human approval
5. Maps to and extends Notor's existing hook system

---

## Key Differences from Ralph

### What's Easier in Notor

- **Vault integration** — hats read/write any note natively; no file path gymnastics
- **Tool approval** — existing rich diff/approval UI applies to orchestration automatically
- **Checkpoint protection** — existing checkpoint system protects notes during orchestration
- **Provider flexibility** — each hat can use a different provider/model via persona
- **No subprocess management** — no ProcessSupervisor, log file tailing, PID files
- **`emit_event` as a tool** — cleaner than writing to a JSONL file and polling

### What's Harder in Notor

- **Backend adapters** — Ralph supports many CLI backends; Notor uses its provider system
- **Parallel loops** — Ralph supports git worktree-based parallel execution; out of scope for now
- **Process survival across restarts** — Ralph subprocesses survive; Notor needs session.json recovery
- **Hat prompt engineering** — Ralph's instructions are long and detailed; reproducing quality matters

---

## Risk Assessment

### Low Risk
- Event engine implementation (well-understood pub/sub)
- Hat note format (clear YAML frontmatter schema)
- `emit_event` tool (straightforward tool addition)
- `default_publishes` synthesis

### Medium Risk
- `HatSystemPromptBuilder` template — needs iteration to produce reliable hat behavior
- Orchestration UI — need good UX for multi-hat conversation display
- Task registry + LOOP_COMPLETE enforcement — completion enforcement is subtle
- Stale/thrashing detection — needs careful implementation to not false-positive
- Backpressure evidence parsing — the payload format is loose, parsing must be robust
- Context budgeting — long orchestrations need token budget management per hat turn

### High Risk
- Hat prompt engineering quality — Ralph's instructions are 200–400 lines; reproducing
  reliable planner/builder/critic behavior requires careful prompt work
- Debugging failed orchestrations — need good logging and trace to diagnose stalls

