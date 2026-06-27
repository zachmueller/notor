# Contract: Code-Step Runtime API (`OrchestrationHelper`)

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-130, FR-131, FR-132)
**Data Model:** [../data-model.md](../data-model.md) (`CodeStepEvent` / `CodeStepResult` / `OrchestrationHelper` — this file is the single authority for their shapes)
**Tasks:** [../tasks.md](../tasks.md) — INT-010 (`CodeStepExecutor`), INT-011 (`OrchestrationHelper` runtime API), INT-012 (`FLOW_CANCELLED` terminal event)
**Sibling contracts:** [run-loop.md](run-loop.md) · [edges.md](edges.md) · [vault-schema.md](vault-schema.md)
**Module:** `src/orchestration/code-step-executor.ts` (INT-010) + `src/orchestration/orchestration-helper.ts` (INT-011)

---

## Overview

A **code step** is a step note with `notor-step-mode: code` (see `StepDefinition` in
[../data-model.md](../data-model.md)). It executes a TypeScript code fence **deterministically**:
no LLM call, no `ConversationSession`, no JSONL conversation file, **zero tokens**. Its return value
decides which event fires next, so it is the flow's reliable, free plumbing for branching, routing,
verification, data-fetch, and notification.

This contract defines:

1. The **compilation/execution path** (`CodeStepExecutor`, INT-010) — how the fence is extracted,
   stripped, compiled, and run under a timeout.
2. The injected **`event`** object (`CodeStepEvent`).
3. The injected **`orchestration`** helper (`OrchestrationHelper`, INT-011) — its full TypeScript
   surface and per-member semantics.
4. The **`CodeStepResult`** routing shape returned from a code step.

> A code step **wholly replaces** the superseded per-step "verification step" concept (the old
> `notor-step-verification` frontmatter field is removed). Verification is now just a code step that
> runs a check and routes on the outcome — strictly more general (arbitrary logic, multi-way routing,
> transformed failure payloads). See [Replaces verification steps](#replaces-verification-steps).

---

## Compilation and Execution (INT-010)

Code steps reuse the **existing Sucrase pipeline** that powers user-defined tools
(`src/extensions/compiler.ts`) — no second compiler. `CodeStepExecutor` runs when
`StepTurnExecutor` (FEAT-007) sees `notor-step-mode: code`; it **skips** persona activation,
`ConversationSession` creation, and prompt assembly (the conversation-step path), but it still writes
the `turn.start` / `turn.complete` entries to `session-log.jsonl` for crash-recovery and audit
(see [vault-schema.md](vault-schema.md) write-order).

Pipeline:

1. **Extract** the first fenced code block tagged `ts` / `typescript` / `js` / `javascript` from the
   step note `bodyContent`. No fence → the step errors (see [Error handling](#error-handling)).
2. **Strip types** via `stripTypes()` (`src/extensions/compiler.ts:31`, Sucrase `typescript`
   transform). Compile errors surface as the `{step}.code_error` event, not a thrown exception.
3. **Compile** to an `AsyncFunction` using the same `new AsyncFunction(...names, code)` mechanism as
   `compileToolFunction()` (`src/extensions/compiler.ts:76`), but with a code-step argument list that
   mirrors `TOOL_ARG_NAMES` (`src/extensions/compiler.ts:67`) and **swaps the last two args**
   (`settings`, `shared` / `params`) for `event` and `orchestration`:

   ```typescript
   // src/orchestration/code-step-executor.ts — authority for the arg signature.
   const CODE_STEP_ARG_NAMES = [
     "app",            // Obsidian App (same as user tools)
     "obsidian",       // the obsidian module (same as user tools)
     "utils",          // ExtensionUtils — IDENTICAL to user-defined tools (see below)
     "libs",           // bundled libs — IDENTICAL to user-defined tools (see below)
     "event",          // CodeStepEvent — the incoming trigger event
     "orchestration",  // OrchestrationHelper — orchestration-specific helper
   ] as const;
   ```

   For comparison, user tools use
   `["app", "obsidian", "utils", "libs", "settings", "shared", "params"]`.

4. **Execute** the compiled async function with a **timeout guard** (default **60 s**, configurable;
   mirrors the per-server MCP timeout convention). On expiry the run is abandoned and the step errors.
5. **Capture** the returned `CodeStepResult` and hand its `{topic, payload}` back to the engine to
   route the next event (write-before-route, exactly like a conversation step's captured emit).

**Cost / identity:** a code step creates **no** conversation, consumes **zero** tokens, and does
**not** count against the aggregate `RunContext` cost budget (it is not an LLM turn). It *does* count
as an engine turn for `notor-max-iterations` / runtime / stale-loop accounting (the engine, not the
code, owns those guards — see [run-loop.md](run-loop.md) and the spec FR-117 safety guards).

---

## `utils` / `libs` are the SAME as user-defined tools

`CodeStepExecutor` builds `utils` and `libs` from the **existing extension runtime context**
(`src/extensions/runtime-context/index.ts` — `buildUtils()` ~59, `buildLibs()` ~99). They are the
**identical objects** injected into user-defined tools and automations — nothing orchestration-specific
is added to them; orchestration-specific capability lives entirely on the `orchestration` helper.

Notable members a code step inherits unchanged (full surface:
`src/extensions/runtime-context/types.ts`):

| Member | Use in a code step |
|---|---|
| `utils.executeShellCommand(cmd, opts?)` | Run build/test/git commands. Backed by `src/shell/shell-executor.ts:80`. Returns `ShellExecuteResult` `{ stdout, exitCode, timedOut, truncated, ... }` (`stdout` is combined stdout+stderr; **there is no separate `stderr` field**). Desktop-only. |
| `utils.notify(message, opts?)` | Surface an explicit Notice (`plugin-utils.ts:308`). Code steps are otherwise silent; this is the only intentional UI feedback path. |
| `utils.resolveNote(path)` / `utils.requestUrl(...)` / `utils.ensureDirectoryExists(...)` | Vault + network I/O, identical to user tools. |
| `app`, `obsidian` | Full Obsidian API + module, identical to user tools. |
| `libs` | Bundled libraries (`buildLibs()`), identical to user tools. |

> Because code steps run with full plugin privileges (same as user tools), the **timeout guard** and
> `{step}.code_error` capture are the only runtime guardrails — by design, a code step is trusted code
> the flow author wrote, not LLM-generated.

---

## Injected `event` — `CodeStepEvent`

The incoming trigger event, injected as `event`:

```typescript
interface CodeStepEvent {
  topic: string;             // the topic that triggered this step
  payload: string;           // the event payload (string; JSON-encode structured data)
  source_step: string | null; // emitting step's name; null for the flow's starting event
}
```

This is the read-only projection of the routed `OrchestrationEvent`
([../data-model.md](../data-model.md)); the engine-only fields (`turn`, `ts`) are not exposed on the
code-step surface. `payload` is always a **string** — author conventions JSON-encode structured data
and `JSON.parse` it in the step (see the [worked example](#worked-example-a-verify-step)).

---

## Injected `orchestration` — `OrchestrationHelper` (INT-011)

The orchestration-specific helper, injected as `orchestration`. **This file is the single authority
for this interface.**

```typescript
interface OrchestrationHelper {
  /**
   * Build the terminal CodeStepResult that routes the next event.
   * MUST be `return`ed from the code step — calling it without returning has no effect
   * (the engine only routes the returned value). `payload` defaults to "".
   */
  emit(topic: string, payload?: string): CodeStepResult;

  /** The session scratchpad — shared, restriction-free working space for the owning session. */
  scratchpad: {
    /** Read a scratchpad file; null if it does not exist. */
    read(file: string): Promise<string | null>;
    /** Write (create or overwrite) a scratchpad file. */
    write(file: string, content: string): Promise<void>;
    /** List scratchpad file names (relative to scratchpad/). */
    list(): Promise<string[]>;
    /** True if the scratchpad file exists. */
    exists(file: string): Promise<boolean>;
  };

  /**
   * Dispatch a registered built-in tool by name. Returns the tool's textual output.
   * Routes through the same ToolDispatcher pipeline as an LLM tool call; honors path
   * enforcement and the owning session's auto-allowed scratchpad path.
   */
  callTool(toolName: string, params: Record<string, unknown>): Promise<string>;

  /**
   * Dispatch a tool on a connected MCP server (server + tool named separately —
   * the helper namespaces them as `{serverName}__{toolName}` internally). Returns textual output.
   */
  callMcpTool(serverName: string, toolName: string, params: Record<string, unknown>): Promise<string>;

  /** The runtime task registry for this session (same backing as the task tool scaffolds, FR-122). */
  tasks: {
    /** List tasks, optionally filtered by status (open | running | closed). */
    list(filter?: { status?: "open" | "running" | "closed" }): Promise<OrchestrationTask[]>;
    /** Idempotently create a task note (no duplicate on repeat key). */
    ensure(key: string, description: string): Promise<void>;
    /** Mark a task running (sets notor-task-status: running + notor-task-started). */
    start(key: string): Promise<void>;
    /** Mark a task closed (sets notor-task-status: closed + notor-task-completed). */
    close(key: string): Promise<void>;
  };

  /** Read-only flow/session metadata for the current turn. */
  flow: {
    name: string;       // OrchestrationFlow.name
    iteration: number;  // current engine iteration (turn number)
    sessionId: string;  // owning session id
  };

  /** Recent event history for the current session (newest last), most-recent `limit` (default: all). */
  eventHistory(limit?: number): OrchestrationEvent[];
}
```

`OrchestrationTask` and `OrchestrationEvent` are defined in [../data-model.md](../data-model.md). The
`tasks` backing notes and write order are owned by [vault-schema.md](vault-schema.md); `callTool` /
`callMcpTool` dispatch through the same seam as LLM tool calls (`ToolDispatcher.dispatch()`,
`src/chat/dispatcher.ts:388`).

### Member semantics

| Member | Semantics |
|---|---|
| `emit(topic, payload?)` | The **only** way a code step routes the next event. The engine routes **the returned value**, so `return orchestration.emit(...)` is mandatory; a bare call is a no-op. A code step that returns no `CodeStepResult` falls back to the step's `notor-step-default-publishes` (synthesized exactly as a no-emit conversation turn would be, FR-115). |
| `scratchpad.*` | Reads/writes under `sessions/{id}/scratchpad/`. The owning session's scratchpad path is auto-allowed in path enforcement (FR-120/FR-121), so a code step never needs explicit `allowed_paths`. This is the cross-step state channel: a code step writes here for downstream steps. |
| `callTool` | Dispatches a built-in tool (the same registry the LLM sees). Throws/rejects on dispatch failure (the rejection is caught and surfaces as `{step}.code_error`). |
| `callMcpTool` | Dispatches against a **connected** MCP server. Subject to the step's `notor-step-mcp-servers` filter (null = inherit all). |
| `tasks.ensure` | Idempotent; repeat keys do not duplicate. Pairs with `FLOW_COMPLETE` task-completion enforcement (FR-123) — open/running tasks block `FLOW_COMPLETE` (but **not** `FLOW_CANCELLED`, FR-132). |
| `flow.iteration` | The engine turn counter, identical to the conversation-step prompt scaffold's `{iteration}`. |
| `eventHistory(limit?)` | The same history the conversation-step scaffold injects as "EVENT HISTORY (last 10)"; here it is data, not prose. |

---

## `CodeStepResult` — the routing return shape

The value a code step **returns** to route the next event. It is the deterministic analog of a
conversation step's captured `emit_event` call.

```typescript
interface CodeStepResult {
  topic: string;     // next event topic (may be a terminal: FLOW_COMPLETE / FLOW_CANCELLED / FLOW_ERROR)
  payload: string;   // next event payload (defaults to "")
}
```

- Only `orchestration.emit(...)` constructs a `CodeStepResult` — authors never build the object by
  hand (keeps the contract one-way and future-proof).
- The engine validates `topic` against the step's `notor-step-publishes` set the same way it validates
  a conversation step's emission; an unlisted topic is treated as an orphan and routed to the
  `FallbackCoordinator` (FR-113).
- A terminal `topic` ends the loop (see [Terminal events](#terminal-events-flow_complete--flow_cancelled)).

---

## Terminal events: `FLOW_COMPLETE` / `FLOW_CANCELLED`

A code step ends the flow by returning a terminal emit. The two terminals differ only in completion
enforcement:

```typescript
// Normal completion — subject to FR-123 task enforcement (open/running tasks reject it):
return orchestration.emit("FLOW_COMPLETE", "All work done.");

// FLOW_CANCELLED (FR-132 / INT-012) — terminates immediately with session status `cancelled`,
// BYPASSES completion-task enforcement (open tasks are acceptable):
return orchestration.emit("FLOW_CANCELLED", "No unread messages — nothing to do.");
```

`FLOW_CANCELLED` is available from **both** code steps (this return form) and conversation steps (via
the `emit_event` tool); it records a `session.cancelled` log entry with the payload as the reason
(status `cancelled`, distinct from `completed`/`error`). The terminal constants are defined in
[../data-model.md](../data-model.md).

---

## Error handling

A code step **never crashes the plugin**. On compile error, runtime throw, unhandled rejection, or
timeout (per INT-010 / FR-130):

1. The engine fires a **`{step}.code_error`** event whose payload carries the error message + stack.
2. An **error `Notice`** is shown (the one non-silent UI path besides explicit `utils.notify`).
3. `turn.start` / `turn.complete` are **still written** to `session-log.jsonl` (audit + recovery).

Author a step subscribing to `{step}.code_error` to handle failures, or let it route to the
`FallbackCoordinator` (which steers or terminates with `FLOW_ERROR`, FR-113).

---

## Use cases

| Use case | How a code step does it |
|---|---|
| **Pre-flight check** | Inspect a condition; `return orchestration.emit("FLOW_CANCELLED", reason)` if the flow has nothing to do. |
| **Data fetch** | `await orchestration.callMcpTool(...)` / `callTool(...)`, persist via `orchestration.scratchpad.write(...)`, route to a worker step. |
| **Build/test verify** | `await utils.executeShellCommand("npm test", { timeoutSeconds })`, branch on `result.exitCode` → `tests.passed` / `tests.failed`. |
| **Task management** | `orchestration.tasks.ensure/start/close/list(...)` to drive a runtime work queue; pop the next item and route to a worker. |
| **External notify** | `await orchestration.callMcpTool("slack", "post_message", {...})` or `utils.notify(...)` to surface progress to a team/user. |
| **Conditional routing** | `JSON.parse(event.payload)`, inspect, and `emit` a different topic per branch — multi-way routing impossible in the old pass/fail verification model. |
| **Aggregation** | Read several `orchestration.scratchpad` files, synthesize a combined payload, `emit` to a finalizer (or populate a terminal-step `structured` return for flow-as-tool, FR-173). |

---

## Worked example: a verify step

A code step that runs the test suite and deterministically routes the outcome. Wired between a builder
and a reviewer:

```
[Builder] --build.done--> [Verify Tests] --tests.passed--> [Reviewer]
                                          --tests.failed--> [Builder]
```

The step note's frontmatter (`StepDefinition` in [../data-model.md](../data-model.md); full
frontmatter schema in [vault-schema.md](vault-schema.md)):

```yaml
---
notor-type: orchestration-step
notor-step-name: "🔍 Verify Tests"
notor-step-description: "Runs the test suite and routes on the result"
notor-step-mode: code
notor-step-triggers:
  - build.done
notor-step-publishes:
  - tests.passed
  - tests.failed
notor-step-default-publishes: tests.failed
---
```

...and the first `typescript` fence in that step note's body (the code that runs):

```typescript
// `event.payload` carries the builder's context (e.g. the project path), JSON-encoded.
const { projectPath } = JSON.parse(event.payload);

const result = await utils.executeShellCommand("npm test", {
  cwd: projectPath,
  timeoutSeconds: 120,
});

// ShellExecuteResult.stdout is COMBINED stdout+stderr (no separate stderr field).
if (result.exitCode === 0 && !result.timedOut) {
  await orchestration.scratchpad.write("last-test-run.txt", result.stdout);
  return orchestration.emit("tests.passed", "Test suite green.");
}

// Failure: forward the full context so the builder can fix it.
return orchestration.emit("tests.failed", JSON.stringify({
  exitCode: result.exitCode,
  timedOut: result.timedOut,
  output: result.stdout,
}));
```

This is strictly more powerful than the removed verification system: arbitrary logic, multi-way
routing on failure *type*, transformed failure payloads, and access to external services — all with
zero tokens and deterministic branching.

---

## Replaces verification steps

The superseded design carried a per-step `notor-step-verification` field that ran a fixed pass/fail
check. That field is **removed**. The equivalent (and more general) pattern is a code step wired after
the step to verify, as in the worked example above. The advantages: arbitrary logic instead of binary
pass/fail, routing to different steps by failure type, output inspection/transformation, external
service calls, and full control over the failure-context payload. No part of the engine retains the
old verification concept.

---

## Cross-references

- **Shapes** (`CodeStepEvent` / `CodeStepResult` / `OrchestrationHelper` / `CODE_STEP_ARG_NAMES`):
  this file is the authority; [../data-model.md](../data-model.md) links here.
- **`OrchestrationTask` / `OrchestrationEvent` / terminal constants:** [../data-model.md](../data-model.md).
- **Task notes + scratchpad + `session-log.jsonl` write order:** [vault-schema.md](vault-schema.md).
- **Per-run cap vs. aggregate budget + `RunContext`:** [run-loop.md](run-loop.md) (a code step is not
  an LLM turn and does not draw on the cost budget).
- **`structured` return populated by a terminal code step (flow-as-tool):** [edges.md](edges.md)
  (`child_run_metadata`) and spec FR-173.
- **Sucrase pipeline reuse:** `src/extensions/compiler.ts` (`stripTypes:31`, `TOOL_ARG_NAMES:67`,
  `compileToolFunction:76`).
- **Shared `utils` / `libs` builders:** `src/extensions/runtime-context/index.ts`
  (`buildUtils:59`, `buildLibs:99`); shell backing `src/shell/shell-executor.ts:80`.
