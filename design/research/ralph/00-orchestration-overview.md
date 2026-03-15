# Orchestration Integration: Research Overview

> Aggregated findings from research into the Ralph orchestrator codebase and how to
> reimplement equivalent functionality as a first-class feature in the Notor Obsidian plugin.
>
> Sub-documents: [01] Architecture · [02] Notor · [03] Presets · [04] Integration · [05] Services · [06] Schema
>
> **Source layers researched:**
> - `crates/ralph-core/src/` — Rust orchestration runtime (event loop, InstructionBuilder, hat registry, memory, tasks, lifecycle hooks, backpressure)
> - `crates/ralph-cli/src/` — Rust CLI entry point and loop runner
> - `crates/ralph-api/src/` — Newer Rust Axum HTTP API server (parallel to the Node.js layer; JSON-RPC + WebSocket)
> - `backend/ralph-web-server/src/` — Node.js management layer (runs and monitors the Rust binary; not the orchestration engine)

---

## What We're Building

Notor currently executes single-turn LLM workflows: one prompt, one response.

The goal is **multi-hat orchestration** — a loop where specialized LLM roles ("hats") collaborate
through named events, each hat getting its own system prompt and tool access, passing work forward
until a terminal "loop complete" signal is reached.

Ralph is the reference implementation. We build this natively in Notor, integrated with the vault.

---

## The Layers of Ralph

**Critical understanding:** The management API layers are separate from the orchestration engine.
All actual orchestration logic lives in the Rust crates. There are two management surfaces:

| Layer | What it does | Relevant for Notor? |
|-------|-------------|---------------------|
| Rust `ralph-core` + `ralph-cli` | Event loop, hat routing, InstructionBuilder, memory, tasks, hooks, backpressure | Yes — this is what we replicate |
| Rust `ralph-api` (`crates/ralph-api/`) | Newer Axum HTTP API server; JSON-RPC v1 + WebSocket streaming; parallel replacement for the Node.js layer | No — management layer |
| Node.js `ralph-web-server` | Original process supervision, task queue, tRPC, React UI | No — replaced by Notor's plugin systems |

---

## Ralph in One Page

Ralph is a multi-hat event-driven agent framework. A YAML config defines hats and event routing:

```yaml
hats:
  planner:
    triggers: [build.start, queue.advance]
    publishes: [tasks.ready, all_steps.done]
    default_publishes: tasks.ready
    instructions: |
      # PLANNER MODE
      Break the work into tasks. Emit tasks.ready for each.

  builder:
    triggers: [tasks.ready, review.rejected]
    publishes: [review.ready]
    instructions: |
      # BUILDER MODE
      Implement the assigned task. Run checks. Emit review.ready.
```

The runtime:
1. Fires the starting event (`task.start` or a configured `starting_event`)
2. **Ralph ALWAYS executes** — custom hats define topology, not separate LLM turns
3. Assembles **full system prompt** via `HatlessRalph.build_prompt()`:
   - Every iteration: injects `## OBJECTIVE` (the original user prompt, set once at init);
     optional `## ROBOT GUIDANCE` (from `human.guidance` events); `## PENDING EVENTS`
   - Coordinating (no hat triggered): shows `## HATS` topology table + Mermaid diagram
   - Hat active: shows `## ACTIVE HAT` section with that hat's instructions inline
4. LLM runs `ralph emit "topic" "payload"` as a shell command, writing to `.ralph/events.jsonl`
5. Event loop reads and routes the JSONL entries; determines which hat(s) are now triggered
6. Repeat until `LOOP_COMPLETE` or a termination condition fires

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

**Key capabilities reused by orchestration:**
- `sendMessage(message)` — reused per hat turn
- `activatePersona(name)` — per-hat persona switching
- Tool approval gating — inherited by each hat turn
- Checkpoint system — vault note history and rollback
- Streaming output — hat turn output streams to chat view normally

See [02-notor-architecture.md](02-notor-architecture.md) for full detail.

---

## Architecture Decision: Native In-Process

| Option | Approach | Verdict |
|--------|----------|---------|
| A | Spawn `ralph run` CLI as subprocess | Rejected — external dependency, no vault integration |
| B | Native in-process orchestration engine | **Recommended** |
| C | Hybrid: observe ralph subprocess events | Rejected — worst of both worlds |

**Option B wins:** reuses all of Notor's existing systems per hat turn; `emit_event` as a tool call
is cleaner than ralph's JSONL file-polling mechanism; works offline; orchestration state is vault
notes.

---

## The New System: Ten Concepts

### 1. Hat Definition (vault note)

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
notor-hat-persona: planner-persona    # optional
notor-hat-model: claude-opus-4-6      # optional
---

## PLANNER MODE

You manage task decomposition...
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
notor-loop-required-events:
  - review.approved                              # LOOP_COMPLETE blocked until these are seen
notor-hats:                    # wikilink resolved to the hat note in hats/ directory;
  - "[[planner]]"             # note titles must be unique — if a conflict exists elsewhere
  - "[[builder]]"             # in the vault, Notor resolves to the note under hats/ first
  - "[[critic]]"
  - "[[finalizer]]"
notor-guardrails:                                # inline strings injected verbatim into every
  - "Verification is mandatory — tests must pass" # hat's GUARDRAILS section of the system prompt
  - "YAGNI ruthlessly"
---
```

### 3. `emit_event` Tool

In Ralph, the LLM runs `ralph emit "topic" "payload"` as a shell command that writes to a JSONL
file, which the event loop then polls. Notor uses a proper tool call instead — the tool triggers
a write to `session-log.jsonl` (write-before-route) for crash recoverability, then signals the
engine to route after the hat turn ends. No polling is needed; the file write still happens.

```typescript
{
  name: "emit_event",
  description: "Publish an orchestration event to route to the next hat",
  parameters: {
    topic: string,    // e.g. "tasks.ready"
    payload: string   // evidence or context for the next hat
  }
}
```

### 4. HatSystemPromptBuilder

**The most important non-obvious concept from the Rust implementation.**

Hat instructions are never passed raw to the LLM. Ralph's `HatlessRalph.build_prompt()`
wraps them in a structural prompt that drives reliable behavior. **In multi-hat mode, Ralph
is ALWAYS the executing agent.** When a custom hat is triggered, its instructions appear
as `## ACTIVE HAT` section within Ralph's broader prompt — not as a standalone system prompt.

Every prompt (regardless of hat active or not) contains these sections in order:
```
0. ORIENTATION / SCRATCHPAD / STATE MANAGEMENT / GUARDRAILS
[skill index — compact table of available skills]
## OBJECTIVE       ← the user's original prompt, stored once at init, injected every iteration
## ROBOT GUIDANCE  ← only present if human.guidance events arrived this iteration
## PENDING EVENTS  ← events that must be handled this iteration
## WORKFLOW / HATS or ACTIVE HAT
```

When Ralph is coordinating (no specific hat triggered), the end of the prompt contains:
````
## HATS
| Hat | Triggers On | Publishes | Description |
...topology table...
```mermaid
flowchart LR
...diagram...
```
CONSTRAINT: You MUST only publish events from this list: `build.task`, `review.request`...
````

When a custom hat is triggered, the end of the prompt contains:
```
## ACTIVE HAT

### Builder Instructions

{hat.instructions goes here}

### Event Publishing Guide

You MUST publish exactly ONE event when your work is complete...
When you publish:
- `build.done` → Received by: Reviewer
- `build.blocked` → Received by: Ralph (coordinates next steps)
```

`InstructionBuilder.build_custom_hat()` also exists with a numbered scaffold structure
(0. ORIENTATION / 0b. TOOL DISCIPLINE / 1. EXECUTE / 2. VERIFY / 3. REPORT / GUARDRAILS)
but per the source code it is a "backward compatibility and tests" path — not the primary
runtime path. Its structural principles are still important to replicate in Notor since
they encode the must-publish enforcement and guardrails injection.

The must-publish rule in REPORT is always injected, even when a hat has custom instructions.
Without it, LLMs reliably forget to emit and the loop stalls silently.

### 5. FallbackCoordinator

Always register a catch-all "Notor" hat that subscribes to `*` (all events). Without this, a
single misnamed event topic silently stalls the entire loop. The fallback provides steering
context and prevents dead-ends.

Ralph calls this "HatlessRalph" and explicitly forbids overriding it.

### 6. OrchestrationEventEngine

```typescript
class OrchestrationEventEngine {
  publish(topic: string, payload: string): void
  subscribe(topic: string | "*", handler: EventHandler): Unsubscribe
  getSubscribers(topic: string): HatDefinition[]  // includes wildcard subscribers
  getEventHistory(): OrchestrationEvent[]
}
```

### 7. Loop Safety Mechanisms

Essential to prevent infinite token burn on stuck loops:

| Mechanism | Trigger |
|-----------|---------|
| `max_iterations` | counter check each iteration |
| `max_runtime` | wall-clock check each iteration |
| `max_cost_usd` | cumulative LLM cost check each iteration |
| **Stale loop** | same (topic + source + payload fingerprint) emitted 3× in a row → `LoopStale` |
| **Thrashing** | planner redispatches 3+ already-abandoned tasks → `LoopThrashing` |
| **Validation failure** | 3+ consecutive malformed JSONL lines → `ValidationFailure` |
| `default_publishes` synthesis | hat produces no JSONL output → auto-fire the default topic |
| `required_events` enforcement | LOOP_COMPLETE blocked until all required events were seen |
| `persistent` mode | LOOP_COMPLETE suppressed entirely; `task.resume` injected instead |
| `cancellation_promise` | `loop.cancel` event triggers clean exit without required_events check |
| `max_activations` per hat | `{hat_id}.exhausted` event injected when exceeded |

### 8. OrchestrationSessionManager

Session lifecycle + vault workspace directory creation. State persisted to `session.json`.
Workspace notes (`context.md`, `plan.md`, `progress.md`, `decisions.md`) auto-created on start.

### 9. Runtime Task Registry

When enabled, tasks are vault notes in `sessions/{id}/tasks/`. **LOOP_COMPLETE is rejected if
any tasks are open** — this enforces the LLM actually closes work before declaring done.

Tools: `orchestration_task_ensure`, `orchestration_task_start`, `orchestration_task_close`,
`orchestration_task_list`.

### 10. Persistent Memory Note

Cross-session learnings at `{notor_dir}/orchestrations/memories.md`. Four sections: Patterns,
Decisions, Fixes, Context. The `HatSystemPromptBuilder` tells every hat to search this note before
acting in unfamiliar territory, and to record fix memories when blocked.

This persists across sessions — unlike workspace notes which are scoped to one session.

---

## Vault Directory Structure

```
{vault}/
  {notor_dir}/
    orchestrations/
      presets/
        code-assist.md          # orchestration preset note
        research.md
      hats/
        planner.md              # hat definition note
        builder.md
        critic.md
        finalizer.md
      memories.md               # persistent cross-session memory (NOT session-scoped)
      sessions/                 # created at runtime
        {session-id}/
          session.json          # metadata: status, iteration, active hat
          context.md            # shared context
          plan.md               # shared plan
          progress.md           # step tracking
          decisions.md          # confidence decisions
          tasks/
            {task-key}.md       # runtime task notes
          logs/
            {n}-{hat}-output.md # hat turn output
```

---

## Key Design Patterns from Ralph

### Hat Instructions as the Core Value

Hat instructions are long (often 200–400 lines) and detailed. They encode:
- Role boundaries ("Do not implement. Do not review.")
- Decision protocols ("Confidence >80: proceed. 50-80: document. <50: safe default.")
- What to read from shared workspace, what to write
- Backpressure evidence requirements ("tests: pass, lint: pass, ...")

The LLM needs explicit, detailed guidance to play a constrained role reliably.

### Scaffold Template + Custom Instructions, Not Instructions Alone

Ralph's `InstructionBuilder` provides consistent structure (ORIENTATION / TOOL DISCIPLINE /
EXECUTE / VERIFY / REPORT / GUARDRAILS) across all hats. The hat's custom instructions fill
only the EXECUTE section. This structure is what makes hats behave reliably — not the
instructions alone.

### Shared State via Workspace Notes

Hats read and write shared vault notes between turns. Payloads are small (IDs and signals);
context is in the notes. The task registry provides structured subtask tracking with
completion enforcement at loop end.

### Backpressure is Payload Validation, Not Shell Gates

When the builder emits `build.done`, the event loop parses the payload text for evidence
strings (`tests: pass, lint: pass, ...`). If evidence is missing or a check failed, `build.done`
is silently substituted with `build.blocked`. The LLM is responsible for actually running
checks; the engine validates the claim format.

---

## Implementation Phases

### Phase 1: Minimal Viable Orchestration

All components required for a working end-to-end loop:
1. `HatNoteParser` + `OrchestrationPresetParser`
2. `OrchestrationEventEngine` (pub/sub with wildcard support)
3. `FallbackCoordinator` (`*` subscriber — prevents orphaned-event stalls)
4. `HatSystemPromptBuilder` (orientation/execute/verify/report/guardrails scaffold)
5. `HatTurnExecutor` (`sendMessage()` + `emit_event` tool injection)
6. `emit_event` tool
7. `default_publishes` synthesis (fires when hat turn produces no emit call)
8. Loop safety guards (max_iterations, max_runtime, stale-loop, thrashing)
9. `required_events` check before accepting LOOP_COMPLETE
10. `OrchestrationRunner` — main loop wiring everything together
11. Command palette UI

### Phase 2: Session Workspace + Task Registry + Memory

1. `OrchestrationSessionManager` + workspace notes auto-creation
2. Runtime task vault notes + tools (ensure/start/close/list)
3. LOOP_COMPLETE enforcement when open tasks exist
4. Persistent `memories.md` vault note (cross-session)
5. Session recovery on plugin load

### Phase 3: Backpressure Evidence Validation

1. `BackpressureValidator` — parse `build.done` payload for evidence fields
2. Substitute `build.blocked` when evidence missing or checks failed
3. Configurable per preset (which events require evidence, which fields)

### Phase 4: Interactive Orchestration

1. `user.input.required` special event — pauses loop, shows question in chat view
2. User response injected as context into next hat turn

### Phase 5: Lifecycle Hooks

1. Pre/post loop-phase shell commands (`pre.loop.start`, `post.iteration.start`, etc.)
2. Rich JSON payload to hook stdin (session ID, iteration, active hat, etc.)
3. `on_error: warn | block | suspend` — `block` stops the lifecycle action as failure; `suspend` blocks the loop pending human approval

### Phase 6: Built-in Preset Library

Vault-native ports of Ralph's builtin presets: code-assist, research, review.

---

## Component Complexity Summary

| Component | Phase | Complexity |
|-----------|-------|-----------|
| HatNoteParser / PresetParser | 1 | Low |
| OrchestrationEventEngine | 1 | Low |
| FallbackCoordinator | 1 | Low |
| `emit_event` tool | 1 | Low |
| `default_publishes` synthesis | 1 | Low |
| Loop safety guards | 1 | Low-Medium |
| `required_events` enforcement | 1 | Low |
| **HatSystemPromptBuilder** | **1** | **Medium — needs iteration to get reliable** |
| HatTurnExecutor | 1 | Medium |
| OrchestrationRunner | 1 | Medium |
| Command palette UI | 1 | Low |
| OrchestrationSessionManager | 2 | Medium |
| Workspace notes | 2 | Low |
| Runtime task registry + tools | 2 | Medium |
| LOOP_COMPLETE task enforcement | 2 | Medium |
| Persistent memory note | 2 | Low |
| Session recovery | 2 | Medium |
| BackpressureValidator | 3 | Low-Medium |
| Interactive orchestration | 4 | Medium |
| Lifecycle hooks | 5 | Medium |
| Built-in presets | 6 | Medium (prompt engineering work) |

---

## Critical Differences from Ralph

| Concern | Ralph | Notor |
|---------|-------|-------|
| Hat instructions source | YAML field in `.ralph/hats/*.yml` | Vault note body |
| Preset source | YAML file on disk | Vault note with frontmatter |
| LLM backend | External CLI (`ralph run --backend ...`) | Notor's existing provider system |
| Event emission | `ralph emit <topic> <payload>` shell cmd → JSONL file → polled | `emit_event` tool call (cleaner) |
| Hat system prompt | `HatlessRalph.build_prompt()` — Ralph always runs; hat instructions appear as `## ACTIVE HAT` section | `HatSystemPromptBuilder` equivalent (same concept, different prompt structure) |
| Fallback coordinator | HatlessRalph (always registered, can't override) | FallbackCoordinator (new) |
| Shared state | Filesystem files | Vault notes via vault tools |
| Memory | `.ralph/agent/memories.md` (cross-session) | `memories.md` vault note (cross-session) |
| Task completion enforcement | Loop rejects LOOP_COMPLETE if tasks open | Same behavior in Phase 2 |
| Process model | Detached subprocess (survives restart) | In-process (session.json for recovery) |
| Management API | Two surfaces: Node.js `ralph-web-server` (tRPC/SQLite) + Rust `ralph-api` (Axum/JSON-RPC) | Not applicable — Notor is the UI |
| Lifecycle hooks | Pre/post loop-phase shell commands | Phase 5 |
| Git worktrees | LoopsManager (parallel isolated branches) | Not in scope |

---

## Source Files

| Document | Contents |
|----------|----------|
| [01-ralph-architecture.md](01-ralph-architecture.md) | Ralph's Rust core: event loop, InstructionBuilder, HatlessRalph, memory, tasks, lifecycle hooks, backpressure evidence validation, 13 termination conditions; plus Node.js management layer, Rust API server, and skills system |
| [02-notor-architecture.md](02-notor-architecture.md) | Notor's current systems: chat, provider, tools, workflows, personas, hooks |
| [03-ralph-preset-examples.md](03-ralph-preset-examples.md) | Real preset analysis (code-assist.yml, ralph.yml) with key learnings |
| [04-integration-analysis.md](04-integration-analysis.md) | Architecture options, recommendation, all ten new concepts, corrected implementation phases, tool mapping, risk assessment |
| [05-ralph-services-deep-dive.md](05-ralph-services-deep-dive.md) | Detailed analysis of each Node.js service with Notor implementation complexity |
| [06-vault-schema-design.md](06-vault-schema-design.md) | Vault-native format spec: hat notes, preset notes, workspace notes, directory layout |
