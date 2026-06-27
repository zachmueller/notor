# Orchestration: Multi-Step Flow Engine

> Canonical design document for Notor's orchestration capability.
>
> **Status:** Design — not yet implemented
> **Feature group:** `orchestration_enabled` (defaults to off)
> **Source location:** `src/orchestration/` (new directory)
> **Commit ref:** `77c2db1`

---

## Table of Contents

1. [Overview](#overview)
2. [Terminology](#terminology)
3. [Architecture](#architecture)
4. [Vault Schema](#vault-schema)
5. [Event Engine](#event-engine)
6. [Step Turn Execution](#step-turn-execution)
7. [Prompt Construction](#prompt-construction)
8. [Programmatic Code Steps](#programmatic-code-steps)
9. [Conversation Model](#conversation-model)
10. [Session Workspace](#session-workspace)
11. [Composition / Flow Handoff](#composition--flow-handoff)
12. [Safety Mechanisms](#safety-mechanisms)
13. [Tools (Built-in Scaffolds)](#tools-built-in-scaffolds)
14. [Feature Group Settings](#feature-group-settings)
15. [Built-in Orchestration Creator Persona](#built-in-orchestration-creator-persona)
16. [Implementation Phases](#implementation-phases)
17. [Risk Assessment](#risk-assessment)

---

## Overview

Notor currently executes single-turn workflows: one prompt → one response (with tool use
across multiple LLM turns). The orchestration engine extends this to **multi-step
event-driven flows** where specialized LLM roles take turns processing work, passing
signals to each other via named events until a terminal condition is reached.

**What it is:** A native, in-process orchestration engine that coordinates multiple
LLM conversations — each with its own persona, tools, and instructions — through an
event-driven loop. Each step in the flow gets its own conversation (persisted as a
separate JSONL file), its own persona for system prompt and tool access, and its own
instructions. Steps communicate by publishing events; the engine routes events to the
next step based on trigger subscriptions.

**What it is not:** A workflow. Workflows are single-turn prompt templates.
Orchestrations are multi-step event loops with state, coordination, and
programmatic control steps. They are launched separately from workflows (though individual steps may invoke
workflows).

**Design heritage:** Informed by research into the Ralph orchestrator, adapted for Notor's vault-native, extension-based, persona-driven architecture.

---

## Terminology

| Term | Definition |
|------|-----------|
| **Orchestration** / **Flow** | A multi-step automated process defined by a flow directory |
| **Step** | A discrete unit of work within a flow — has triggers, publishes, instructions, and a persona reference |
| **Persona** | Existing Notor concept — system prompt, tool access, provider/model preferences. Steps reference personas. |
| **Flow definition** | The `definition.md` file in a flow directory — specifies topology, loop config, guardrails |
| **Event** | A named signal with a payload, published by one step and routed to others |
| **Session** | A single execution of a flow — runtime state, workspace notes, event log |
| **Scratchpad** | Per-session shared workspace directory for cross-step state |
| **Code step** | A step with `notor-step-mode: code` — executes TypeScript deterministically without LLM |

**Removed terminology:** "Hat" (from the Ralph reference) is not used. Use "step" for
the flow unit and "persona" for the identity/access profile.

---

## Architecture

### High-Level Flow

```
User invokes flow (command palette / slash command)
  │
  ▼
OrchestrationRunner.start(flowDir, promptText)
  │
  ├── Load definition.md → parse flow topology
  ├── Load step notes → parse triggers/publishes/persona refs
  ├── Register FallbackCoordinator ("*" subscriber)
  ├── Create session workspace (vault directory)
  ├── Publish starting_event
  │
  ▼
┌─── Event Loop ───────────────────────────────────────────────┐
│                                                               │
│  EventEngine.getSubscribers(topic) → find matching step(s)   │
│                                                               │
│  StepTurnExecutor.execute(step, event, session):              │
│    1. Create ConversationSession (new JSONL file)             │
│    2. Activate step's persona                                 │
│    3. StepPromptBuilder assembles system prompt               │
│    4. Build user message from event + workspace context       │
│    5. Execute via responseLoop() with step-specific tools     │
│    6. Capture emit_event calls → topics + payloads            │
│    7. If no emit_event: synthesize default_publishes          │
│    8. Safety checks (iteration, runtime, stale, thrashing)    │
│                                                               │
│  EventEngine.publish(event) → route to next step              │
│                                                               │
│  Repeat until FLOW_COMPLETE / FLOW_CANCELLED or safety limit fires             │
│                                                               │
└───────────────────────────────────────────────────────────────┘
  │
  ▼
Finalize session, update workspace notes
```

### Component Diagram

```
OrchestrationRunner
  ├── FlowDefinitionParser          (reads definition.md)
  ├── StepNoteParser                (reads step notes)
  ├── OrchestrationEventEngine      (pub/sub with wildcard)
  │     └── FallbackCoordinator     ("*" wildcard subscriber)
  ├── StepPromptBuilder             (wraps instructions in scaffold)
  ├── StepTurnExecutor            (creates session, runs responseLoop OR code; runs step turns on the shared RunLoop)
  │     ├── PersonaManager          (activates step's persona — conversation steps)
  │     ├── emit_event scaffold     (captures events — conversation steps)
  │     └── CodeStepExecutor        (compiles + runs TypeScript — code steps)
  ├── LoopSafetyGuards              (iteration/runtime/stale/thrashing)
  ├── OrchestrationSessionManager   (workspace, event log, recovery)
  └── UI: command palette + Notice system
```

### Run-Loop Engine (shared execution substrate)

Step turns do **not** run on the full `ChatOrchestrator.responseLoop()` (which carries
persistence, compaction, view rendering, hooks) nor a hand-rolled loop. They run on a
generalized **`RunLoop`** — a headless turn engine extracted from `SubAgentRunner` (which
already describes itself as "a lightweight mini-orchestrator"). The same `RunLoop` underpins
sub-agents and flow-as-tool invocation.

- **`RunContext`** (carried as an optional field on `ToolExecuteOptions`, riding the existing
  dispatch seam): `{ depth, maxDepth, iterationsRemaining, costRemainingUsd, abort }`. A child
  run inherits the parent's remaining budget and `depth + 1`; spawning checks `depth <
  maxDepth` and budget before launching. This **replaces the sub-agent binary recursion ban**
  (`SUBAGENT_EXCLUDED_TOOLS` + `_isSubAgentContext`): sub-agents pass `maxDepth = 0`
  (identical behavior to today); flows pass `maxDepth = N` or unlimited.
- **`RunResult`** is always-both: `text` (always present) + optional `structured` payload slot
  (populated by a terminal code step). `SubAgentResult` is a strict subset (`structured` stays
  null), so the refactor is non-breaking.
- Child-run concurrency uses a shared semaphore in the run-loop layer. Aggregate
  `max_iterations` / `max_cost_usd` / `max_depth` are a **tree-wide ceiling** carried on
  `RunContext`, layered *on top of* (never replacing) each runner's per-run iteration cap.
  See [Safety Mechanisms → Two-Layer Limit Model](#two-layer-limit-model-per-run-cap--aggregate-tree-budget).

Full design: `ai/notor/ideas/Generalized run-loop engine for sub-agents and orchestration.md`.
This extraction is a prerequisite for Phase 1's `StepTurnExecutor` and Phase 7's flow-as-tool.

### Relationship to Existing Systems

| Existing System | How Orchestration Uses It |
|----------------|--------------------------|
| `PersonaManager` | Activates a persona per step turn (system prompt, tool config, model) |
| `ChatOrchestrator` / `responseLoop()` | Each step turn runs through the standard send/receive loop |
| `ConversationSession` | Each step turn creates an isolated session |
| `HistoryManager` | Each step's conversation persisted as a separate JSONL file |
| `ToolDispatcher` + path enforcer | Per-step tool access via persona's `<notor_tool_config>` |
| `WorkflowExecutor` | Steps can invoke workflows for their task |
| Extension scaffolds | `emit_event`, task tools are built-in scaffolds gated by feature group |
| Settings / feature groups | `orchestration_enabled` toggle, mirrors memory pattern |

---

## Vault Schema

### Directory Structure

```
{vault}/
  {notor_dir}/
    orchestrations/                    # root for all orchestration content
      {flow-name}/                     # one directory per flow definition
        definition.md                  # flow topology, loop config, guardrails
        steps/                         # step notes (one per step)
          planner.md
          builder.md
          critic.md
          finalizer.md
      {another-flow}/
        definition.md
        steps/
          ...
      sessions/                        # created at runtime
        {session-id}/
          session.json                 # metadata: status, iteration, active step
          session-log.jsonl            # append-only event+turn log (crash recovery)
          scratchpad/                  # shared cross-step working directory
          tasks/                       # runtime task notes
            {task-key}.md
      memories.md                      # persistent cross-session memory
    personas/                          # existing persona directories
      planner-persona/
        system-prompt.md               # persona referenced by the planner step
      builder-persona/
        system-prompt.md
```

### Flow Definition Note (`definition.md`)

```yaml
---
notor-type: orchestration-flow
notor-flow-name: "Code Implementation"
notor-flow-description: "TDD-based implementation with planner, builder, critic, finalizer"
notor-starting-event: build.start
notor-completion-event: FLOW_COMPLETE
notor-max-iterations: 100
notor-max-runtime-minutes: 240
notor-required-events:
  - review.approved
notor-steps:
  - "[[planner]]"
  - "[[builder]]"
  - "[[critic]]"
  - "[[finalizer]]"
notor-guardrails:
  - "Verification is mandatory — tests must pass"
  - "YAGNI ruthlessly — no speculative features"
  - "Confidence >80: proceed autonomously; 50-80: document; <50: safe default"
---

# Code Implementation Flow

Use this flow to implement features with TDD. Provide a description of what
needs to be implemented as the prompt.

The flow runs through planning, implementation, review, and finalization
phases automatically.
```

**Key frontmatter fields:**

| Field | Type | Description |
|-------|------|-------------|
| `notor-type` | `"orchestration-flow"` | Discriminator |
| `notor-flow-name` | string | Display name |
| `notor-flow-description` | string | Short description for picker UI |
| `notor-starting-event` | string | First event fired when flow starts |
| `notor-completion-event` | string | Terminal event that ends the loop (default: `FLOW_COMPLETE`) |
| `notor-max-iterations` | number | Safety limit on total step turns |
| `notor-max-runtime-minutes` | number | Wall-clock time limit |
| `notor-required-events` | string[] | Events that must have been seen before completion is accepted |
| `notor-steps` | wikilink[] | Ordered list of step note references (resolved under `steps/`) |
| `notor-guardrails` | string[] | Constraints injected into every step's system prompt |
| `notor-flow-invocable` | boolean | Whether this flow may be called as a tool by other flows' steps (default `false`; opt-in to appear in the `run_flow` registry) |
| `notor-flow-inputs` | string | **Freeform natural-language** description of what the flow expects to begin. Not strictly typed. Lives in the callee; surfaced to any caller. |
| `notor-flow-returns` | string | **Freeform** description of what the flow hands back to a caller. |
| `notor-on-complete-flow` | wikilink \| null | Chaining: successor flow launched at the terminal event (one-way handoff, no return) |
| `notor-handoff-isolation` | `"isolated"` \| `"shared"` | Per-handoff scratchpad mode (default `isolated`; `shared` inherits the parent's scratchpad) |
| `notor-max-depth` | number | Composition-depth guardrail (caps nesting/chaining; alongside cascading `max_iterations` / `max_cost_usd`) |

> Composition fields are inert unless the orchestration feature group is enabled. `notor-flow-inputs` / `notor-flow-returns` are deliberately loose (natural-language) — the design leans on LLM flexibility to coerce data to fit. See [[ai/notor/ideas/Make orchestration flows highly composable]].

**Note body:** The body of `definition.md` is human-readable documentation. It is not
injected into any LLM prompt — only the frontmatter drives engine behavior.

### Step Note Format

Step notes live under `{flow-dir}/steps/` and define a single step in the flow:

```yaml
---
notor-type: orchestration-step
notor-step-name: "📋 Planner"
notor-step-description: "Manages step decomposition and task queue"
notor-step-triggers:
  - build.start
  - queue.advance
notor-step-publishes:
  - tasks.ready
  - all_steps.done
notor-step-default-publishes: tasks.ready
notor-step-persona: planner-persona
notor-step-model: null
notor-step-mcp-servers: null
---

## PLANNER MODE — Step-Wave Strategy And Runtime Queue Ownership

You own decomposition and queue progression.
Do not implement. Do not review.

### Shared Documentation
Read context.md and plan.md in the session scratchpad before starting.
Write your decomposition to plan.md when complete.

### Logic
1. Study the objective and any existing context
2. Break the work into discrete, testable steps
3. Write the plan to the scratchpad
4. Emit `tasks.ready` for the first task
```

**Key frontmatter fields:**

| Field | Type | Description |
|-------|------|-------------|
| `notor-type` | `"orchestration-step"` | Discriminator |
| `notor-step-name` | string | Display name (can include emoji) |
| `notor-step-description` | string | Short description |
| `notor-step-triggers` | string[] | Events that activate this step |
| `notor-step-publishes` | string[] | Events this step may emit |
| `notor-step-default-publishes` | string | Event emitted if step doesn't call `emit_event` |
| `notor-step-persona` | string \| null | Persona name for system prompt + tool config + model |
| `notor-step-model` | string \| null | Optional model override (takes precedence over persona) |
| `notor-step-mode` | `"conversation"` \| `"code"` | Execution mode. `conversation` (default) = LLM-powered. `code` = programmatic TypeScript execution. |
| `notor-step-mcp-servers` | string[] \| null | MCP servers active for this step (null = inherit all) |

**Note body:** The Markdown body is the step's custom instructions. These are injected
into the `### EXECUTE` section of the prompt scaffold. The body can contain `<include_note>`
tags for referencing other vault notes.

### Step Notes Reference Personas

Steps reference personas by name via `notor-step-persona`. When a step turn begins:

1. `PersonaManager.getPersonaByName(step.persona)` resolves the persona
2. The persona's `prompt_content` is applied per its `prompt_mode` (append/replace)
3. The persona's `<notor_tool_config>` block defines tool access and path restrictions
4. The persona's `preferred_preset` / `preferred_provider` / `preferred_model` sets
   the LLM provider and model for this step's turn
5. If `notor-step-model` is set, it overrides the persona's model preference

**Why separate step notes from personas?** Steps define *what to do* (instructions,
triggers, publishes — flow-specific). Personas define *who you are* (system prompt
personality, tool access, model — reusable across flows). A single persona can be
referenced by steps in different flows.

---

## Event Engine

### OrchestrationEventEngine

```typescript
class OrchestrationEventEngine {
  /** Register a step to receive events on a topic. */
  subscribe(topic: string | "*", step: StepDefinition): Unsubscribe;

  /** Publish an event. Write-before-route: appends to session-log.jsonl first. */
  publish(topic: string, payload: string, sessionLog: SessionLog): void;

  /** Find all steps that would be triggered by an event on this topic. */
  getSubscribers(topic: string): StepDefinition[];

  /** Get the full event history for the current session. */
  getEventHistory(): OrchestrationEvent[];
}
```

**Wildcard subscriptions:** The `FallbackCoordinator` subscribes to `*` and receives
any event that has no other subscriber. This prevents orphaned events from silently
stalling the loop.

**Write-before-route:** `publish()` appends the event to `session-log.jsonl` before
delivering it to any subscriber. This ensures crash recovery can replay from the log.

### Event Routing Rules

1. When a step emits an event via `emit_event`, the engine finds all steps whose
   `notor-step-triggers` include that topic.
2. If multiple steps trigger on the same topic, they execute sequentially (in the
   order listed in `notor-steps`).
3. If no step triggers on the topic, the `FallbackCoordinator` receives it.
4. The `FallbackCoordinator` examines the event and either steers back to a known
   state or terminates with an error.

### FallbackCoordinator

Always registered. Cannot be overridden. Subscribes to `*`.

When triggered by an orphaned event (no other subscriber matched):
- Logs a warning with the unmatched topic and payload
- Attempts to steer: if the payload suggests a known topic was intended, re-publishes
  with the corrected topic
- If unrecoverable: terminates the flow with `FLOW_ERROR`

---

## Step Turn Execution

Each step turn is a full LLM conversation cycle:

### StepTurnExecutor.execute(step, event, session)

```
1.  Append turn.start to session-log.jsonl (before any LLM call)
2.  Activate step's persona via PersonaManager
3.  Create a new ConversationSession:
    - New conversation ID
    - New JSONL file in history directory
    - Conversation header includes orchestration metadata:
      { orchestration_session_id, flow_name, step_name,
        previous_step_conversation_id, iteration_number }
4.  StepPromptBuilder assembles the full system prompt
5.  Build user message:
    - Event topic and payload
    - References to scratchpad workspace notes
    - The original user objective (injected every turn)
6.  Run responseLoop() — the standard ChatOrchestrator send/receive loop
    - The LLM uses tools normally (read/write notes, shell commands, etc.)
    - The emit_event tool is available for publishing the next event
    - Tool access is governed by the step's persona
7.  After responseLoop() completes:
    - If emit_event was called: capture topic + payload
    - If emit_event was NOT called: synthesize step.default_publishes
8.  Append turn.complete to session-log.jsonl
9.  Safety checks (iteration, runtime, stale, thrashing)
10. Return the captured event for the engine to route
```

Note: For code steps (`notor-step-mode: code`), steps 2-6 are replaced by
TypeScript compilation and execution. See [Programmatic Code Steps](#programmatic-code-steps).

### Persona Activation per Step

Each step references a persona. The `StepTurnExecutor` calls
`PersonaManager.getPersonaByName()` to resolve it (without calling `activatePersona()`
which would mutate global state). The resolved persona is passed to the session:

- `pinnedPersona` → used by `SystemPromptBuilder` for system prompt assembly
- `ConfigResolver` → uses persona's `<notor_tool_config>` for tool filtering and path enforcement
- Provider/model → resolved from persona's preset/provider/model preferences

This means each step can use a different provider and model. A planner step might use
a fast, cheap model; a builder step might use a more capable model.

---

## Prompt Construction

### StepPromptBuilder

The step's instructions are never passed raw to the LLM. They are wrapped in a
structural scaffold that drives reliable behavior:

```
You are {step.name}, executing step {iteration} of the "{flow.name}" orchestration.
You have fresh context each iteration.

### 0. ORIENTATION
You MUST study the incoming event context before acting.
You MUST check the scratchpad workspace for shared state.
You MUST NOT assume work isn't done — verify first.

Session scratchpad: {session.scratchpad_path}
Session tasks: {session.tasks_path}

### 0b. TOOL DISCIPLINE
- Session state lives in the orchestration scratchpad, not in ad hoc notes.
- You MUST check open tasks before creating new ones.
- If blocked or a command fails, record it in the scratchpad.
- You can read and write to the scratchpad without restrictions.

### 1. EXECUTE

{step.body_content}

### 2. VERIFY
You MUST verify your work before reporting done.

### 3. REPORT
You MUST call emit_event with one of: {step.publishes}
Narrative summaries do NOT count as event emission.
You MUST call emit_event before ending your turn.

If you believe ALL work is complete across the entire flow, emit: FLOW_COMPLETE

### GUARDRAILS
{flow.guardrails — injected from definition.md}

---

## OBJECTIVE

{original_user_prompt — set once at flow start, injected every step turn}

## INCOMING EVENT

Topic: {event.topic}
Payload: {event.payload}

## EVENT HISTORY (last 10)

{recent events with topics, sources, and payloads}
```

The must-publish rule in section 3 is **always injected**, even when a step has explicit
instructions. Without it, LLMs reliably forget to emit and the loop stalls silently.

### Persona Prompt Integration

The step's persona content is integrated via the standard `SystemPromptBuilder.assemble()`
mechanism:

- If `prompt_mode: append` (default): persona content appended after the default system prompt,
  before the step scaffold
- If `prompt_mode: replace`: persona content replaces the default system prompt; step scaffold
  is appended after it

This means the final system prompt is:
```
[Default system prompt OR persona replacement]
[Persona append content, if append mode]
[Vault rules matching current context]
[Step scaffold (orientation → execute → verify → report → guardrails)]
```

---

## Programmatic Code Steps

Code steps are purely programmatic TypeScript steps that execute deterministically
without creating any LLM conversation. They wholly replace the previous "Verification
Steps" concept and are far more general-purpose.

### Design Principles

1. **Same step note format** — Code steps live in `steps/` alongside conversation steps.
   They use the same frontmatter schema but declare `notor-step-mode: code`.
2. **No conversation created** — No LLM call, no JSONL file. Pure code execution.
3. **Deterministic event emission** — The code's return value determines what event
   fires next, enabling deterministic branching and routing.
4. **Full runtime access** — Same as user-defined tools: full Obsidian API, Node.js,
   plugin privileges. Plus an orchestration helper library for built-in tools, MCP
   servers, and scratchpad.
5. **Silent execution** — No UI feedback unless the code errors (error Notice) or
   explicitly calls `utils.notify()`.

### Code Step Note Format

```yaml
---
notor-type: orchestration-step
notor-step-name: "🔍 Pre-flight Check"
notor-step-description: "Checks for new Slack messages before proceeding"
notor-step-mode: code
notor-step-triggers:
  - flow.start
notor-step-publishes:
  - messages.found
  - FLOW_CANCELLED
notor-step-default-publishes: FLOW_CANCELLED
notor-step-mcp-servers:
  - slack
---

# Pre-flight Check

Cancels the flow if there are no new unread Slack messages to process.

```typescript
// Access the incoming event
const { topic, payload } = event;

// Use MCP server to check for messages
const result = await orchestration.callMcpTool("slack", "get_unread_messages", {
  channel: payload.channel ?? "#general",
});

const messages = JSON.parse(result);

if (messages.length === 0) {
  // No messages — cancel the flow
  return orchestration.emit("FLOW_CANCELLED", "No unread messages found.");
}

// Write message list to scratchpad for downstream steps
await orchestration.scratchpad.write("messages.json", JSON.stringify(messages, null, 2));

// Continue the flow with the message count
return orchestration.emit("messages.found", JSON.stringify({
  count: messages.length,
  channel: payload.channel ?? "#general",
}));
```
```

**Key differences from conversation steps:**

| Aspect | Conversation Step | Code Step |
|--------|------------------|----------|
| Execution | LLM conversation via `responseLoop()` | TypeScript function execution |
| JSONL file | Created per turn | None |
| Persona | Required (system prompt + tools) | Not used (no LLM call) |
| Event emission | Via `emit_event` tool call | Via `return orchestration.emit()` |
| Output | Natural language + tool use | Programmatic return value |
| UI | Streams to conversation view | Silent (unless error or explicit Notice) |
| Iteration cost | LLM tokens | Zero tokens |

### Code Step Execution Flow

```
StepTurnExecutor detects notor-step-mode: code
  │
  ├── Skip: persona activation, ConversationSession, prompt building
  ├── Compile TypeScript via Sucrase (same pipeline as extensions)
  ├── Inject runtime context: app, obsidian, utils, libs, event, orchestration
  ├── Execute compiled function
  │
  ├── On success: capture returned emit topic + payload
  ├── On error: fire {step_name}.code_error event with stack trace
  │             Show error Notice
  │
  ├── Append turn.start + turn.complete to session-log.jsonl
  │   (for crash recovery and audit trail)
  │
  └── Return captured event for engine to route
```

### Runtime Context (Orchestration Helper)

Code steps receive all standard extension context (`app`, `obsidian`, `utils`, `libs`)
plus an `orchestration` helper object and an `event` object:

```typescript
/** Injected as `event` — the incoming trigger event. */
interface CodeStepEvent {
  topic: string;
  payload: string;
  source_step: string | null; // null for starting event
}

/** Injected as `orchestration` — orchestration-specific helper library. */
interface OrchestrationHelper {
  /** Emit an event to continue the flow. Must be returned from the code step. */
  emit(topic: string, payload?: string): CodeStepResult;

  /** Access the session scratchpad. */
  scratchpad: {
    read(filename: string): Promise<string | null>;
    write(filename: string, content: string): Promise<void>;
    list(): Promise<string[]>;
    exists(filename: string): Promise<boolean>;
  };

  /** Call a built-in tool by name with params. */
  callTool(toolName: string, params: Record<string, unknown>): Promise<string>;

  /** Call a tool on a connected MCP server. */
  callMcpTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<string>;

  /** Read the orchestration task list. */
  tasks: {
    list(filter?: { status?: string }): Promise<OrchestrationTask[]>;
    ensure(key: string, description: string): Promise<void>;
    start(key: string): Promise<void>;
    close(key: string): Promise<void>;
  };

  /** Get flow metadata. */
  flow: {
    name: string;
    iteration: number;
    sessionId: string;
  };

  /** Get recent event history. */
  eventHistory(limit?: number): OrchestrationEvent[];
}
```

### `FLOW_CANCELLED` Terminal Event

A new terminal event alongside `FLOW_COMPLETE`. When emitted:

- The orchestration loop terminates immediately
- Session status is set to `cancelled` (not `completed` or `error`)
- The session log records a `session.cancelled` entry with the payload as reason
- No task completion enforcement (unlike `FLOW_COMPLETE`, open tasks are acceptable)

Available from **both** code steps and conversation steps:

```typescript
// Code step:
return orchestration.emit("FLOW_CANCELLED", "No work needed.");
```

```
// Conversation step (via emit_event tool):
emit_event(topic: "FLOW_CANCELLED", payload: "User requested abort.")
```

### Compilation and Execution

Code steps are compiled via the same Sucrase pipeline used by user-defined extensions:

1. Extract first `ts`/`typescript`/`js`/`javascript` code fence from the step note body
2. Strip TypeScript types via `stripTypes()` (Sucrase `typescript` transform)
3. Compile to `AsyncFunction` with injected context arguments:
   `app`, `obsidian`, `utils`, `libs`, `event`, `orchestration`
4. Execute with timeout guard (configurable, default 60s)
5. Capture the returned `CodeStepResult` for event routing

**Argument signature:**
```typescript
const CODE_STEP_ARG_NAMES = [
  "app", "obsidian", "utils", "libs", "event", "orchestration"
] as const;
```

### Use Cases

| Use Case | How |
|----------|-----|
| Pre-flight checks | Check conditions, emit `FLOW_CANCELLED` if not met |
| Data fetching | Pull data via MCP/tools, write to scratchpad, route to agent |
| Build/test verification | Run `utils.executeShellCommand("npm test")`, route based on exit code |
| Iterative task management | Maintain a list in scratchpad, pop next item, route to worker step |
| External notifications | Call Slack/email MCP to notify team of progress |
| Conditional routing | Inspect event payload, route to different steps based on content |
| Aggregation | Collect results from scratchpad, synthesize, route to finalizer |

### Replaces Verification Steps

The old `notor-step-verification` frontmatter field is removed. To achieve
verification behavior, wire a code step after the conversation step:

```
[Builder] --build.done--> [Verify Tests] --tests.passed--> [Reviewer]
                                         --tests.failed--> [Builder]
```

The verify step:
```yaml
---
notor-step-mode: code
notor-step-triggers:
  - build.done
notor-step-publishes:
  - tests.passed
  - tests.failed
---
```

```typescript
const result = await utils.executeShellCommand("npm test", {
  cwd: "/path/to/project",
  timeout: 120000,
});

if (result.exitCode === 0) {
  return orchestration.emit("tests.passed", result.stdout);
} else {
  return orchestration.emit("tests.failed", JSON.stringify({
    exitCode: result.exitCode,
    stderr: result.stderr,
    stdout: result.stdout,
  }));
}
```

This is strictly more powerful than the old verification system:
- Arbitrary logic (not just pass/fail)
- Can route to different steps based on failure type
- Can inspect and transform outputs
- Can interact with external services
- Full control over failure context payload

---

## Conversation Model

### Per-Step Conversations

Each step turn creates a **separate conversation** with its own JSONL file in the
history directory. This enables:

- Users can deep-dive into any step's conversation independently
- Conversation search finds individual step interactions
- Token costs are tracked per step
- Steps don't share context windows (each starts fresh)

### Conversation Header Metadata

The JSONL header carries orchestration metadata plus a typed-edge adjacency list:

    {
      "_type": "conversation",
      "id": "step-conv-uuid",
      "title": "[Code Implementation] Planner — iteration 3",
      "orchestration_session_id": "session-uuid",
      "orchestration_flow_name": "Code Implementation",
      "orchestration_step_name": "📋 Planner",
      "orchestration_iteration": 3,
      "orchestration_edges": [
        { "kind": "prev",  "conversation_id": "..." },
        { "kind": "next",  "conversation_id": "..." },
        { "kind": "child", "conversation_id": "...", "session_id": "...", "via_tool_call_id": "..." },
        { "kind": "parent","conversation_id": "...", "session_id": "..." }
      ]
    }

**Edge model: typed edges, tree-constrained (a DAG).** `kind ∈ {next, prev, child, parent}`.
This **replaces** the earlier linear `orchestration_previous/next_conversation_id` scalars.

- `next` / `prev` — step chain within one flow (backfilled, as the old scalars were).
- `child` — a calling step's `run_flow` (or a chaining handoff) points to the child flow's
  entry conversation; carries `session_id` (child session) and `via_tool_call_id` (the
  specific invoking call, so the UI can render "descend" on that exact tool-call card). The
  `child` edge is the **uniform structural source for both invocation and chaining** (chained
  children have no tool call, so a tool-result-only scheme could not represent them).
- `parent` — back-link from the child entry to the caller.
- **No cyclic / sibling / `return` edges.** The mechanisms only ever produce hierarchy.
  Returning from a deep child to the caller is one hop via `parent`. Keeping it a pure DAG
  keeps crash-recovery replay and aggregate-budget rollup cycle-free.

### Child Run Metadata (shared with sub-agents)

The existing `ToolResult.sub_agent_metadata` is **generalized into a shared
`child_run_metadata` block** used by **both** `use_subagent` and `run_flow`, with one
rendering path (the inline expandable child-conversation card) and one token-rollup path
(`convManager.addTokens(...)` at tool-return time, in `orchestrator.ts` /
`chat/workflow-executor.ts`).

- Fields: `{ jsonl_filename | entry_conversation_id, session_id, token_usage, cost_usd,
  iteration_count, depth, stop_reason, name }`.
- For **flows**, the rollup carries **aggregate subtree numbers** (cost / iterations / depth
  accumulated across the entire child flow tree, sourced from the child `RunContext`) — not
  just the direct child. Sub-agents populate the same fields with single-run totals (subtree =
  themselves).
- **Back-compat:** the shared shape must keep `sub_agent_metadata`'s existing fields
  (`jsonl_filename`, `token_usage`, `iteration_count`, `stop_reason`, `profile_name`) readable
  for already-persisted conversations.

### Conversation Navigation — unified run-tree view

Orchestration step conversations **and** sub-agent conversations are **hidden from the flat
conversation sidebar** (sub-agents already are, via `isSubAgentFilename` / `_type:
"sub_agent_conversation"` filtered out of `listConversations()`). They are surfaced via a new
contextual **run-tree view**:

- Reachable by clicking the spawning block in the main chat (the `run_flow` / sub-agent
  tool-call card), reusing the existing `notor-conversation://{id}` jump + `switchToConversationById`.
- **Unified** for orchestration and sub-agents — one tree renders both (it reads
  `orchestration_edges` and sub-agents' existing `parent_conversation_id`).
- **Live for active runs, static for completed runs** — in-flight runs subscribe to runner
  state changes (reusing the `WorkflowActivityTracker.onChange()` pattern; turn.start /
  turn.complete / event.emitted are the `session-log.jsonl` write points), highlighting the
  current node; completed runs render once from the persisted log. A recovered run re-attaches
  its subscription.
- **Collapse/expand:** smart auto-expand the spine to the active / most-recent node and
  collapse finished branches on each open; manual collapse state is **ephemeral** (not
  persisted).

### Activity indicator (unified)

Generalize toward **one** "activity" indicator with **typed entries**: background-workflow
entries navigate to their conversation (as today); **flow-run entries open the run-tree
view**. Do not build a second parallel indicator. The surface reads from **two sources**:
in-memory for background workflows (`WorkflowConcurrencyManager`, lost on reload) and
session-file-backed for flows (which have crash recovery). Staged: the first orchestration cut
may feed flow runs in as a distinct source rather than a full `WorkflowActivityTracker`
refactor.

### Conversation Title Convention

Step conversations auto-title as:
```
[{flow_name}] {step_name} — iteration {n}
```

Example: `[Code Implementation] 📋 Planner — iteration 3`

---

## Session Workspace

### OrchestrationSessionManager

Creates and manages per-session workspace directories:

```
{notor_dir}/orchestrations/sessions/{session-id}/
  session.json           # metadata: status, iteration, flow name, started_at
  session-log.jsonl      # append-only event+turn log (crash recovery source)
  scratchpad/            # shared cross-step working directory
    context.md           # implementation context, patterns, dependencies
    plan.md              # numbered high-level steps
    progress.md          # current step, verification log
    decisions.md         # confidence-protocol decisions
  tasks/                 # runtime task notes
    {task-key}.md
```

### Shared Scratchpad

The scratchpad directory is the **cross-step shared state**. Every step can read and
write here without restriction (the path is auto-allowed in path enforcement when the
active step is part of the owning orchestration session).

The `StepPromptBuilder` tells every step where the scratchpad lives and that they
should use it for any state that other steps need to see:

```
Session scratchpad: notor/orchestrations/sessions/abc123/scratchpad/
Write plans, context, and intermediate findings here.
Other steps will read from this directory.
```

### Session Event Log

The most important session file for crash recovery. Written by the engine, not by steps:

```jsonl
{"type":"session.start","session_id":"...","flow":"code-assist","prompt":"implement --verbose flag","ts":"..."}
{"type":"event.emitted","turn":1,"topic":"build.start","payload":"implement --verbose flag","ts":"..."}
{"type":"turn.start","turn":2,"step":"planner","trigger_topic":"build.start","conversation_id":"...","ts":"..."}
{"type":"turn.complete","turn":2,"step":"planner","emitted_topic":"tasks.ready","conversation_id":"...","ts":"..."}
{"type":"event.emitted","turn":2,"topic":"tasks.ready","payload":"{...}","ts":"..."}
```

**Write order (enforced):**
1. `turn.start` → before `responseLoop()` begins (or code execution for code steps)
2. `turn.complete` → after emit captured
3. `event.emitted` → before the event is routed (write-before-route)

### Session Recovery

On plugin load, scan for sessions with `session.json` status `active` or `interrupted`:

1. Read `session-log.jsonl` to find the last complete state
2. If last entry is `turn.start` with no matching `turn.complete`: turn was interrupted
   → re-emit the triggering event (step retries from scratch with fresh context)
3. If last entry is `event.emitted` with no following `turn.start`: event was emitted
   but not routed → re-publish the event
4. Offer the user a "Resume orchestration?" prompt with a summary of where it left off

### Persistent Memory

Cross-session learnings at `{notor_dir}/orchestrations/memories.md`:

```markdown
# Orchestration Memories

## Patterns
- ...

## Decisions
- ...

## Fixes
- ...

## Context
- ...
```

The `StepPromptBuilder` tells every step to check this note before acting in
unfamiliar territory and to record fix memories when blocked.

### Parent/Child Sessions

`session.json` records `parent_session_id` and the invocation/chain origin. Child sessions
(from flow-as-tool or chaining) link into the parent's recovery tree so a crash can resume the
whole tree coherently. Child-run conversation/session handles also surface on the caller's
`child_run_metadata` (flow-as-tool) and via the `orchestration_edges` `child` edge.

### Scratchpad isolation modes

- `isolated` (default): child gets a fresh `scratchpad/` and `tasks/`, like a sub-agent.
- `shared` (`notor-handoff-isolation: shared`): child inherits the parent's scratchpad; the
  parent scratchpad path is auto-allowed in the child's path enforcement
  (`tool-config/path-enforcer.ts`).

---

## Composition / Flow Handoff

Flows compose as reusable building blocks. Two mechanisms share one self-describing,
loosely-typed contract. Full rationale: see the idea notes
(`ai/notor/ideas/Make orchestration flows highly composable.md`).

### The self-describing contract

Each flow declares, in its own `definition.md`, freeform natural-language descriptions of
what it consumes (`notor-flow-inputs`) and produces (`notor-flow-returns`). The contract
lives in the **callee**, so every upstream caller receives the same description and stays
decoupled. Deliberately not strictly typed — the LLM coerces messy data to fit.

### Mechanism A — Flow-as-invocable-tool (primary)

A flow with `notor-flow-invocable: true` becomes callable by other flows' steps via a
single built-in **`run_flow`** tool (gated by the orchestration feature group):

- `run_flow` has a `flow` parameter that is an **enum of discovered invocable flow names**,
  with each flow's `notor-flow-inputs` surfaced in the tool description — exactly the
  `use_subagent` pattern (dynamic `get description()` / `get input_schema()`). Flow names are
  enum *values*, so naming collisions are sidestepped entirely.
- A single loose `payload` arg matches the loose contract. The caller's LLM fills `{flow,
  payload}` (dynamic), `definition.md` can pre-bind them (static), or mix.
- Invocation runs the child flow to its terminal event in a **child session** on a child
  `RunLoop` (see Run-Loop Engine note), then returns the child's result to the caller.
- **Returns** are satisfied two ways: a terminal **code step** returns a structured payload
  deterministically (preferred, reliable), OR a final **conversation step** is instructed via
  `notor-flow-returns` to "produce this as your closing message". The executor reads whichever
  the terminal step produced; the `RunResult` is always-both (prefer `structured`, fall back
  to `text`).

Discovery mirrors `SubAgentManager`: a stateless `FlowCompositionManager` re-scans
`orchestrations/*/definition.md` for `notor-flow-invocable: true` on demand.

### Mechanism B — Chaining / one-way handoff (secondary)

At the terminal event, if `notor-on-complete-flow` is set, the runner launches the successor
instead of finalizing. No return to the originator — the chain *is* the end of the starting
flow.

- **Decoupling:** the engine injects the successor's `notor-flow-inputs` into the
  predecessor's terminal step, so the predecessor shapes its forwarded payload to fit without
  hardcoding knowledge of the successor.
- **Handoff adaptation (tiered):** default is free **prompt-injection** (inject the
  successor's input description into the terminal step). For non-trivial reshaping, the chain
  edge may declare an **optional adapter**, **code-step preferred** (deterministic), or an LLM
  turn if genuinely fuzzy.
- Data forwards via the emitted payload (default) or shared scratchpad
  (`notor-handoff-isolation: shared`).

### Callee-agnostic entry

A flow enters identically regardless of how it was reached — same `notor-starting-event`,
same payload-conforms-to-`notor-flow-inputs` expectation. Only the **return path** differs:
flow-as-tool routes the result back to the waiting caller; chaining treats completion as
terminal.

### Isolation

Per-handoff, default `isolated` (fresh scratchpad/tasks, like a sub-agent). `shared` mode
opts into the parent's scratchpad and auto-allows the parent scratchpad path in the child's
path enforcement.

---

## Safety Mechanisms

Essential to prevent infinite token burn on stuck loops:

| Mechanism | Trigger | Action |
|-----------|---------|--------|
| `iteration_cap` (per-run) | Counter check each turn within one runner (default 20) | Wind down that runner |
| `max_iterations` (aggregate) | Tree-wide turn counter check before each turn | Block new child spawns (tree ceiling) |
| `max_runtime` | Wall-clock check each step turn | Terminate flow |
| **Stale loop** | Same (topic + source + payload fingerprint) emitted 3× in a row | Terminate flow |
| **Thrashing** | Step redispatches 3+ already-abandoned tasks | Terminate flow |
| `default_publishes` synthesis | Step produces no `emit_event` call | Auto-fire the default topic |
| `required_events` enforcement | Completion event received before all required events seen | Block completion, inject resume |
| `max_cost_usd` (aggregate) | Cumulative LLM cost across the flow tree exceeds limit | Block new child spawns (tree ceiling) |
| `max_depth` | Composition depth exceeds limit when spawning a child flow/sub-agent | Reject the spawn; surface to caller |

### Stale Loop Detection

Track a rolling window of the last 5 events. If 3 consecutive events have the same
`(topic, source_step, payload_hash)` triple, the loop is stale:

```typescript
function isStale(history: OrchestrationEvent[]): boolean {
  if (history.length < 3) return false;
  const last3 = history.slice(-3);
  const sig = (e: OrchestrationEvent) =>
    `${e.topic}:${e.source_step}:${hash(e.payload)}`;
  return last3.every(e => sig(e) === sig(last3[0]));
}
```

### Thrashing Detection

Track per-task abandonment counts. When a step emits `tasks.ready` for a task key
that has been abandoned (started then re-queued) 3+ times, the loop is thrashing.

### Two-Layer Limit Model (per-run cap + aggregate tree budget)

Iteration and cost limits exist at **two independent scopes**. The aggregate budget is layered
*on top of* the per-run cap — it does **not** replace it. Conflating them is the single most
common way to break behavior-preservation during the `RunLoop` extraction.

| Layer | Scope | Lives on | Purpose | Status |
| ----- | ----- | -------- | ------- | ------ |
| **Per-run cap** (floor) | One runner | `RunLoop.iterationCap` (today's `SUB_AGENT_ITERATION_CAP = 20`) | Stop a *single* loop from spinning; resets fresh per runner | **Unchanged** by composition |
| **Aggregate budget** (ceiling) | The whole call tree | `RunContext.iterationsRemaining` / `costRemainingUsd` | Stop a *deep/wide tree* from collectively over-spending even when every node is individually within its per-run cap | **New** for composition |

**Decision rule:** a turn proceeds iff **both** layers have headroom — `localIterations <
iterationCap` AND `RunContext.iterationsRemaining > 0` AND `RunContext.costRemainingUsd > 0`.
Whichever is tighter wins.

**Resolved policies:**

1. **Independent layers, both must pass.** Aggregate is additive on top of the per-run cap,
   never a substitute.
2. **Per-turn decrement, checked before each turn.** Aggregate counters decrement as each turn
   completes and are checked before the next begins (catches cost drift mid-run, not only at
   spawn boundaries).
3. **Exhaustion blocks new child spawns only.** When the tree ceiling is hit, no new children
   launch; in-flight runs finish their current turn gracefully (no hard-abort, no forced
   mid-turn wind-down). A spawn is gated on `depth < maxDepth` AND aggregate budget `> 0`; a
   blocked spawn returns control to the caller (flow-as-tool) or terminates the chain
   (chaining).
4. **Sub-agent equivalence is provable, not coincidental.** Sub-agents pass `maxDepth = 0` and
   seed the aggregate budget to **`Infinity`**, so the per-run `iterationCap` is the only
   effective limit — behavior is identical to today by construction, and `sub-agent-runner.test.ts`
   stays green unmodified.

`max_depth` caps nesting/chaining depth; arbitrary depth is permitted unless a limit is set.
Full model: `ai/notor/ideas/Generalized run-loop engine for sub-agents and orchestration.md`.

---

## Tools (Built-in Scaffolds)

All orchestration tools are built-in extension scaffolds, gated by the `orchestration`
feature group (only compiled and registered when `orchestration_enabled` is true).

### `emit_event`

Publishes an orchestration event to advance the flow:

```yaml
params:
  topic:
    type: string
    description: "Event topic name (e.g., tasks.ready, review.passed, FLOW_COMPLETE)"
  payload:
    type: string
    description: "Evidence or context for the next step"
```

**Implementation:** The tool captures the topic and payload, stores them on the
session context, and returns a confirmation. The actual event publishing happens
after the `responseLoop()` completes (the engine reads the captured event from
the session). This prevents mid-turn event routing.

**Mode:** `write` (only available in Act mode)

### `run_flow`

Calls another flow as a tool (Mechanism A in [Composition / Flow Handoff](#composition--flow-handoff)).
Gated by the orchestration feature group. Mirrors the `use_subagent` dynamic-description pattern:

```yaml
params:
  flow:
    type: string  # enum of discovered invocable flow names (notor-flow-invocable: true)
    description: "Which flow to invoke; each flow's notor-flow-inputs is surfaced dynamically"
  payload:
    type: string
    description: "Loose, natural-language input conforming to the callee's notor-flow-inputs"
```

**Implementation:** A stateless `FlowCompositionManager` discovers invocable flows on demand;
the tool's `flow` enum and per-flow input descriptions are built dynamically (`get description()`
/ `get input_schema()`). Invocation runs the child flow to its terminal event on a child
`RunLoop` in a child session, then returns the child's `RunResult` (prefer `structured`, fall
back to `text`) to the caller.

**Mode:** `write` (only available in Act mode)

### `orchestration_task_ensure`

Create a task if it doesn't already exist:

```yaml
params:
  key:
    type: string
    description: "Unique task key (e.g., step-01-impl)"
  description:
    type: string
    description: "Task description"
```

Creates a task note at `sessions/{id}/tasks/{key}.md` with frontmatter:
```yaml
---
notor-type: orchestration-task
notor-task-status: open
notor-task-key: step-01-impl
notor-task-created: 2026-05-12T10:00:00Z
---
```

### `orchestration_task_start`

Mark a task as running (sets `notor-task-status: running`, `notor-task-started`).

### `orchestration_task_close`

Mark a task as closed (sets `notor-task-status: closed`, `notor-task-completed`).

### `orchestration_task_list`

List tasks for the current session, optionally filtered by status.

### Task Completion Enforcement

When `FLOW_COMPLETE` is emitted, the engine checks for open tasks:
- If any tasks have `notor-task-status: open` or `running`, the completion event
  is rejected
- A `flow.tasks_remaining` event is published instead, re-triggering the step with
  context about which tasks are still open

---

## Feature Group Settings

### Settings Interface Addition

```typescript
// In src/settings/types.ts — NotorSettings interface:

/** Master toggle for the orchestration subsystem. */
orchestration_enabled: boolean;
```

**Default:** `false` (disabled, like memory)

### Settings UI

A new settings section "Orchestration" (collapsed by default), rendered similarly
to the Memory section:

```typescript
// In src/settings/sections/orchestration.ts:

export function renderOrchestrationSection(containerEl, ctx): void {
  new Setting(containerEl)
    .setName("Enable orchestrations")
    .setDesc(
      "Multi-step automated flows where specialized LLM personas " +
      "collaborate through event-driven loops."
    )
    .addToggle(toggle =>
      toggle.setValue(ctx.settings.orchestration_enabled)
        .onChange(async value => {
          ctx.settings.orchestration_enabled = value;
          if (value) {
            await ensureOrchestrationDirectory(ctx);
          }
          await ctx.saveSettings();
          // Reload extensions to register/unregister orchestration scaffolds
          const manager = ctx.plugin.getExtensionManager();
          await manager.reload(false);
          ctx.redisplay();
        })
    );
}
```

### Feature Group Gating

Orchestration tool scaffolds and automation scaffolds set `featureGroup: "orchestration"`.
The `ExtensionManager` filters them out during compilation when
`settings.orchestration_enabled` is `false`.

```typescript
// In each orchestration scaffold definition:
{
  featureGroup: "orchestration",
  // ... rest of scaffold
}
```

---

## Built-in Orchestration Creator Persona

A new built-in persona (mirrors `notor-help` and `tool-creator`):

**Name:** `orchestration-creator`
**Location:** `{notor_dir}/personas/orchestration-creator/system-prompt.md`

### System Prompt Content

The persona guides users through creating orchestration flows interactively:

1. Discusses the flow concept with the user — what steps are needed, what events
   connect them, what code steps might be useful for deterministic behavior
2. Creates the flow directory and `definition.md`
3. Creates step notes with appropriate frontmatter (both conversation and code steps)
4. Suggests or creates personas for conversation steps that need them
5. Validates the flow topology (no orphaned events, all triggers have publishers)

### Tool Access

```yaml
<notor_tool_config>
write_note:
  enabled: true
  allowed_paths:
    - "{notor_dir}/orchestrations/"
    - "{notor_dir}/personas/"
read_note:
  enabled: true
  auto_approve: true
search_vault:
  enabled: true
  auto_approve: true
list_vault:
  enabled: true
  auto_approve: true
use_subagent:
  enabled: true
web_search:
  enabled: true
fetch_webpage:
  enabled: true
</notor_tool_config>
```

### Registration

Added to `BUILTIN_PERSONA_PROFILES` in `src/personas/builtin-personas.ts` alongside
`notor-help` and `tool-creator`.

---

## Implementation Phases

### Phase 1: Core Engine + Flow Definition Schema

**Goal:** Run a flow end-to-end with correct step routing and loop termination.

> **Prerequisite — Run-Loop extraction.** Before `StepTurnExecutor`, extract the generalized
> `RunLoop` from `SubAgentRunner` (new `src/run-loop/`), and refactor `SubAgentRunner` to
> consume it. This yields `RunContext` (depth/budget cascade) and the always-both `RunResult`
> that Phase 7 composition depends on. See
> `ai/notor/ideas/Generalized run-loop engine for sub-agents and orchestration.md`.
> Foundational steps: (1) extract `RunContext`/`RunResult`/hook types; (2) lift the loop into
> `RunLoop` + refactor `SubAgentRunner`; (3) add `runContext` to `ToolExecuteOptions` and
> enforce depth via it; (4) cascading budget/concurrency helpers.

| Component | Complexity | Description |
|-----------|-----------|-------------|
| `FlowDefinitionParser` | Low | Parse `definition.md` frontmatter |
| `StepNoteParser` | Low | Parse step note frontmatter + body |
| `OrchestrationEventEngine` | Low | Pub/sub with wildcard support |
| `FallbackCoordinator` | Low | Catch-all `*` subscriber |
| `emit_event` scaffold | Low | Built-in tool scaffold |
| `default_publishes` synthesis | Low | Fires when step produces no emit |
| `StepPromptBuilder` | **Medium** | Scaffold template — needs iteration |
| `StepTurnExecutor` | **Medium** | Session creation, persona wiring, responseLoop |
| `OrchestrationRunner` | **Medium** | Main loop wiring everything together |
| Session event log | Low | Append-only JSONL writer |
| Loop safety guards | Low-Medium | iteration, runtime, stale, thrashing |
| `orchestration_enabled` setting | Low | Feature group toggle + UI section |
| Command palette UI | Low | "Notor: Run Orchestration" + flow picker |

**Source files:**
```
src/orchestration/
  types.ts                    # OrchestrationFlow, StepDefinition, OrchestrationEvent, etc.
  flow-parser.ts              # FlowDefinitionParser + StepNoteParser
  event-engine.ts             # OrchestrationEventEngine
  fallback-coordinator.ts     # FallbackCoordinator
  step-prompt-builder.ts      # StepPromptBuilder
  step-turn-executor.ts       # StepTurnExecutor (dispatches to conversation or code path)
  code-step-executor.ts       # CodeStepExecutor (TypeScript compilation + execution)
  orchestration-helper.ts     # OrchestrationHelper runtime context for code steps
  runner.ts                   # OrchestrationRunner
  safety.ts                   # LoopSafetyGuards
  session-log.ts              # Session event log writer
```

### Phase 2: Session Workspace + Task Registry + Conversation Navigation

**Goal:** Steps share state via vault notes; tasks tracked and enforced; conversations navigable.

| Component | Complexity |
|-----------|-----------|
| `OrchestrationSessionManager` | Medium |
| Scratchpad workspace notes | Low |
| Task tools (4 scaffolds) | Medium |
| `FLOW_COMPLETE` task enforcement | Medium |
| Persistent memory note | Low |
| Session recovery on plugin reload | Medium |
| Conversation header orchestration metadata | Low |
| Conversation navigation extensions | Medium |

### Phase 3: Programmatic Code Steps

**Goal:** Deterministic TypeScript steps for verification, data fetching, routing, and flow control.

| Component | Complexity |
|-----------|------------|
| `CodeStepExecutor` | Medium |
| Code fence extraction + Sucrase compilation | Low (reuses extension pipeline) |
| `OrchestrationHelper` runtime context | Medium |
| `FLOW_CANCELLED` terminal event | Low |
| Built-in tool + MCP tool call wrappers | Medium |
| Scratchpad API for code steps | Low |
| `orchestration-creator` persona guidelines for code steps | Low |

### Phase 4: Progress Notices + Conversation Jump-in

**Goal:** User visibility into running flows.

| Component | Complexity |
|-----------|-----------|
| Progress Notice synthesis | Low-Medium |
| Right-click Notice → open step conversation | Medium |

### Phase 5: Interactive Orchestration + Step-to-Workflow Mapping

**Goal:** Steps can pause for user input; steps can invoke workflows.

| Component | Complexity |
|-----------|-----------|
| `user.input.required` event handling | Medium |
| Step-to-workflow invocation | Medium |

### Phase 6: Built-in Flows + Orchestration Creator Persona

**Goal:** Ship reference flows and guided creation.

| Component | Complexity |
|-----------|-----------|
| `orchestration-creator` built-in persona | Medium (prompt engineering) |
| Reference flows (code-assist, research, review) | Medium (prompt engineering) |

### Phase 7: Composability / Flow Handoff

**Goal:** flows compose via flow-as-tool (call/return) and chaining (one-way handoff) over the
self-describing loose contract. Full design:
`ai/notor/ideas/Make orchestration flows highly composable.md`.

| Component | Complexity |
|-----------|-----------|
| `definition.md` composition frontmatter + parser (`notor-flow-inputs/returns/invocable`, `notor-on-complete-flow`, `notor-handoff-isolation`, `notor-max-depth`) | Low |
| `FlowCompositionManager` — stateless re-scan discovery of invocable flows | Medium |
| Single `run_flow` tool (dynamic `flow` enum + loose `payload`); registers gated by feature group | Medium |
| Flow-as-tool execution + return capture over a child `RunLoop` (generalize `chat/workflow-executor.ts` await-result) | Medium |
| Child session creation + `parent_session_id` + isolation modes | Medium |
| Chaining at terminal event + input-description injection + optional code-step adapter | Medium |
| Cascading guardrails + `max_depth` on `RunContext` | Small/Medium |
| `orchestration_edges` typed-edge schema + `child_run_metadata` generalization + unified run-tree view | Medium |

Mechanism A (flow-as-tool) is the high-value core and can ship before chaining.

---

## Risk Assessment

### Low Risk
- Event engine (well-understood pub/sub pattern)
- Flow/step note parsing (clear frontmatter schema, existing parsing patterns)
- `emit_event` tool scaffold (straightforward)
- Feature group settings (mirrors memory pattern exactly)
- `default_publishes` synthesis

### Medium Risk
- **StepPromptBuilder** — needs iteration to produce reliable step behavior; the scaffold
  must be strong enough that steps reliably emit events, use the scratchpad, and respect
  role boundaries
- **Conversation threading** — linking step conversations with navigation metadata adds
  complexity to the history system; need careful header schema design
- **Code step runtime context** — the `OrchestrationHelper` API surface must be
  carefully designed; code steps have full plugin privileges and need guardrails
  (timeout, error handling) to prevent runaway execution
- **Task completion enforcement** — subtle edge cases when steps create tasks that other
  steps should close
- **Session recovery** — replaying from the event log must produce idempotent results;
  step instructions should be authored with retry safety in mind

### High Risk
- **Step prompt engineering quality** — getting steps to behave reliably within their
  role boundaries, consistently emit events, and use the scratchpad appropriately requires
  significant prompt iteration. The reference flows in Phase 6 are where this quality bar
  is proven.
- **Debugging failed flows** — when a flow stalls or produces wrong output, users need
  good tools to diagnose what happened. The per-step conversation model helps (each step
  is independently inspectable), but the flow-level view (which step ran when, what events
  were exchanged) needs thoughtful UX.

### Composition Risks (design resolved 2026-06-27)

- **Run-loop refactor regression (Medium).** `SubAgentRunner` is load-bearing
  (`use_subagent`, `sub-agent-runner.test.ts`). The `RunLoop` extraction must be
  behavior-preserving — identical caps, wind-down, abort behavior; gate on the existing suite.
- **Recursion/budget cascade (Low–Medium).** Replacing the binary sub-agent ban with a
  `RunContext` depth counter must preserve today's "no nested sub-agents" behavior
  (`maxDepth = 0`) while enabling arbitrary flow depth. The per-run cap and aggregate tree
  budget are independent layers (both must pass per turn); sub-agents seed the aggregate to
  `Infinity` so behavior is unchanged by construction. Aggregate budget accounting depends on
  per-turn cost (`message-pipeline.ts` `calculateCost`) being reachable from the run-loop
  layer without orchestrator-specific deps.
- **Structured-return reliability (Medium).** Reliable structured returns depend on a terminal
  code step populating the `structured` slot; the conversation-step `text` path is the loose
  fallback. Flows whose `notor-flow-returns` implies structure but produce none degrade to
  text (detectable, not fatal).
- **Run-tree dual-source state (Low).** The unified activity surface reads in-memory workflow
  state and session-file-backed flow state; the two must reconcile in one ordered view.


