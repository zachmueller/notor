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

4. **Execute** the compiled async function with a **timeout guard** wrapping the *whole* async function.
   The default is **300 s (5 min)**, overridable per step via the **`notor-step-timeout-seconds`**
   frontmatter field ([vault-schema.md](vault-schema.md)). On expiry — **at the next `await` boundary**,
   see the limitation below — the run is abandoned and the step errors (`{step}.code_error`).

   > **The step timeout must exceed any inner shell timeout.** A code step that runs a long command
   > (e.g. `utils.executeShellCommand("npm test", { timeoutSeconds: 120 })`) sets an **inner** budget;
   > the **outer** code-step timeout must be larger or the outer guard kills the step before the command
   > can finish. The 300 s default comfortably exceeds the 120 s shell budget in the worked examples; a
   > step that needs a longer command (large test suite, deploy) raises `notor-step-timeout-seconds`
   > accordingly. (This is why the default is 300 s, not the 60 s an MCP-style convention would suggest —
   > build/test verification is a primary code-step use case.)

   > ### ⚠️ Known limitation — the timeout only fires at `await` boundaries; a synchronous loop is NOT interruptible
   >
   > The timeout guard is a `Promise.race` / `setTimeout` around the compiled `AsyncFunction`. Code steps
   > run as `new AsyncFunction(...)` **on Obsidian's main (renderer) event-loop thread** — there is no
   > Worker / VM isolation (full parity with user-defined tools, by design). A `setTimeout` callback can
   > only fire when control **returns to the event loop**, i.e. at an `await`. Therefore:
   >
   > - **An unbounded *synchronous* section is NOT interruptible** by the timeout. A `while (true) {}`, a
   >   CPU-bound transform, or a long synchronous loop with no `await` never yields, so the timeout never
   >   fires, the step is **not** abandoned, and **the entire plugin freezes** (UI, foreground chat, every
   >   other flow). `runContext.abort` has the same limitation — abort is observed only at `await` points.
   > - **What the timeout *does* bound:** a step that is slow because it is `await`-ing (a long shell
   >   command, network I/O, many tool calls) — the guard fires at the next `await` after expiry. This is
   >   the common, intended shape (build/test verify, data fetch). Contrast the **inner**
   >   `utils.executeShellCommand` timeout, which *is* a hard kill because the command runs
   >   out-of-process (`child_process`), not on the event-loop thread.
   >
   > **Mitigation (this is trusted, author-written code — not LLM-generated):** the scaffold author
   > guidance and the `orchestration-creator` persona instruct authors to **never write unbounded
   > synchronous loops** and to **insert `await` yield points** (e.g. `await Promise.resolve()` or any
   > tool/IO await) inside long loops so the timeout/abort can fire between iterations. **Future work:**
   > running code steps in a `worker_threads` Worker with a watchdog that can hard-terminate a runaway is
   > the only true fix, but it is **out of scope for v1** — it would break the `app`/`obsidian`/`utils`/
   > `libs` main-thread parity that is the whole point of reusing the user-tool pipeline. The AC
   > "the code-step timeout … abandons the step on expiry" is accordingly scoped to **`await`-yielding
   > code**.
5. **Capture** the returned `CodeStepResult` and hand its `{topic, payload}` back to the engine to
   route the next event (write-before-route, exactly like a conversation step's captured emit).

**Cost / identity:** a code step creates **no** conversation, consumes **zero** tokens, and is **not an
LLM turn**. Consequently it does **not** count against either half of the aggregate `RunContext` budget:
neither `costRemainingUsd` (zero tokens) **nor `iterationsRemaining`** — `notor-max-iterations` counts
**LLM turns only** (the authoritative unit; see [run-loop.md](run-loop.md) "Two-Layer Limit Model" and
[../data-model.md](../data-model.md) `AggregateBudget`). A code step **is** still an *event-producing*
step: its emitted event is appended to history, so it **does** participate in **stale-loop** detection
(the `(topic, source_step)` window) and in **wall-clock runtime** accounting (`notor-max-runtime-minutes`
elapses regardless of token spend). The practical consequence — a flow whose only steps are code steps
is bounded by **`max-runtime`** (and stale-loop detection), **not** by `max-iterations` — is called out
explicitly in [event-engine.md](event-engine.md) (Loop Safety Guards) and the spec FR-117 safety guards.

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
> the flow author wrote, not LLM-generated. **Caveat (see the Known-limitation box above):** the timeout
> guard only fires at `await` boundaries, so it does **not** protect against an unbounded *synchronous*
> loop (which freezes the plugin). Author guidance + the `orchestration-creator` persona cover this;
> Worker-based hard isolation is future work, out of scope for v1.

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
   *
   * The optional `structured` is the DATA PATH for a terminal code step's typed return: when this
   * step's emitted topic is the flow's terminal/completion event, the runner lifts `structured` onto
   * RunResult.structured verbatim (no JSON round-trip), which `run_flow` returns in preference to
   * `text` (FR-173). For non-terminal emits, `structured` is ignored (routing uses topic/payload).
   * Keep `payload` a clean string (routing + logging); put the typed object in `structured`.
   */
  emit(topic: string, payload?: string, structured?: unknown): CodeStepResult;

  /**
   * At-least-once side-effect guard for crash recovery (FR-125). Runs `fn` only if a side effect
   * keyed `key` has not already been recorded committed for this session; on success it appends a
   * `side_effect.committed` entry (keyed) to session-log.jsonl, so a recovery RE-RUN of this step
   * skips the already-committed effect. Returns `fn`'s result (or the prior result is NOT replayed —
   * a skipped effect returns undefined). Use it to wrap NON-IDEMPOTENT external effects (git push,
   * Slack post, deploy, charge) that a re-run after an interrupted turn would otherwise repeat.
   *
   * BEST-EFFORT, not exactly-once: it cannot cover a crash that occurs DURING `fn` (after the effect
   * landed but before `side_effect.committed` is written) — such an effect may still re-run. It
   * collapses the common window, not the irreducible one. See "At-least-once recovery" below.
   *
   * Works for CHILD flows too: a non-terminal child is RESUMED in place on recovery (it replays its
   * own session log), so its side_effect.committed markers survive — once() is NOT defeated by child
   * recovery (the old tombstone-and-respawn rule, which gave a respawned child an empty log, is gone).
   */
  once<T>(key: string, fn: () => Promise<T>): Promise<T | undefined>;

  /**
   * The session scratchpad — shared, restriction-free working space for the owning session.
   * OVERWRITE-ONLY by design: there is deliberately NO `append`. Crash-recovery (FR-125) re-runs an
   * interrupted step from fresh context, so writes must be idempotent — a step writes the COMPLETE
   * current content (or uses a per-iteration filename), so a re-run reproduces rather than duplicates.
   * `once(...)` guards only EXTERNAL effects, never scratchpad state. (See "At-least-once recovery".)
   */
  scratchpad: {
    /** Read a scratchpad file; null if it does not exist. */
    read(file: string): Promise<string | null>;
    /** Write (create or OVERWRITE) a scratchpad file with its complete content. Idempotent by design — no append variant. */
    write(file: string, content: string): Promise<void>;
    /** List scratchpad file names (relative to scratchpad/). */
    list(): Promise<string[]>;
    /** True if the scratchpad file exists. */
    exists(file: string): Promise<boolean>;
  };

  /**
   * Dispatch a registered built-in tool by name. Returns the tool's textual output.
   * Routes through the same ToolDispatcher pipeline as an LLM tool call, threading the step's
   * `runContext` (depth + SHARED aggregate-budget cell + parent abort) AND `orchestrationContext`
   * onto `ToolExecuteOptions` — so a child-spawning tool (e.g. `run_flow`) is depth/budget-gated and
   * abort-cascaded exactly as it would be from an LLM turn (see "runContext propagation" below).
   * Honors path enforcement and the owning session's auto-allowed scratchpad path.
   */
  callTool(toolName: string, params: Record<string, unknown>): Promise<string>;

  /**
   * Dispatch a tool on a connected MCP server (server + tool named separately —
   * the helper namespaces them as `{serverName}__{toolName}` internally). Returns textual output.
   * Threads `runContext` + `orchestrationContext` identically to `callTool` (below).
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
| `emit(topic, payload?, structured?)` | The **only** way a code step routes the next event. The engine routes **the returned value**, so `return orchestration.emit(...)` is mandatory; a bare call is a no-op. A code step that returns no `CodeStepResult` falls back to the step's `notor-step-default-publishes` (synthesized exactly as a no-emit conversation turn would be, FR-115). The optional `structured` is lifted onto `RunResult.structured` only when `topic` is the flow's terminal/completion event (FR-173); ignored otherwise. |
| `once(key, fn)` | At-least-once side-effect guard (FR-125). Runs `fn` and appends a keyed `side_effect.committed` log entry on success; on a recovery re-run of the step, an already-committed `key` skips `fn` (returns `undefined`). Wrap non-idempotent external effects (push/post/deploy). Best-effort — cannot cover a crash *during* `fn`; see [At-least-once recovery](#at-least-once-recovery-fr-125). |
| `scratchpad.*` | Reads/writes under `sessions/{id}/scratchpad/`. The owning session's scratchpad path is auto-allowed in path enforcement (FR-120/FR-121), so a code step never needs explicit `allowed_paths`. This is the cross-step state channel: a code step writes here for downstream steps. **Overwrite-only** — `write` replaces the whole file; there is no `append`, because recovery re-runs would duplicate appended content (FR-125). Write the complete current content, or a per-iteration filename. |
| `callTool` | Dispatches a built-in tool (the same registry the LLM sees), threading the step's `runContext` + `orchestrationContext` (see "runContext propagation"). Throws/rejects on dispatch failure (the rejection is caught and surfaces as `{step}.code_error`). A child-spawning tool (`run_flow`) is depth/budget-gated and abort-cascaded just as from an LLM turn. |
| `callMcpTool` | Dispatches against a **connected** MCP server, threading `runContext` + `orchestrationContext` identically. Subject to the step's `notor-step-mcp-servers` filter (null = inherit all). |
| `tasks.ensure` | Idempotent; repeat keys do not duplicate. Pairs with `FLOW_COMPLETE` task-completion enforcement (FR-123) — open/running tasks block `FLOW_COMPLETE` (but **not** `FLOW_CANCELLED`, FR-132). |
| `flow.iteration` | The engine **step-turn** counter (increments once per executed step, code or conversation), identical to the conversation-step prompt scaffold's `{iteration}`. This is a *display/sequence* counter — distinct from `notor-max-iterations`, which counts **LLM turns only** ([run-loop.md](run-loop.md)). |
| `eventHistory(limit?)` | The same history the conversation-step scaffold injects as "EVENT HISTORY (last 10)"; here it is data, not prose. |

---

## `CodeStepResult` — the routing return shape

The value a code step **returns** to route the next event. It is the deterministic analog of a
conversation step's captured `emit_event` call.

```typescript
interface CodeStepResult {
  topic: string;       // next event topic (may be a terminal: FLOW_COMPLETE / FLOW_CANCELLED / FLOW_ERROR)
  payload: string;     // next event payload (defaults to "")
  structured?: unknown;// optional typed return; lifted onto RunResult.structured by a TERMINAL emit
}
```

- Only `orchestration.emit(...)` constructs a `CodeStepResult` — authors never build the object by
  hand (keeps the contract one-way and future-proof).
- The engine validates `topic` against the step's `notor-step-publishes` set the same way it validates
  a conversation step's emission; an unlisted topic is treated as an orphan and routed to the
  `FallbackCoordinator` (FR-113).
- A terminal `topic` ends the loop (see [Terminal events](#terminal-events-flow_complete--flow_cancelled)).
- **`structured` is the flow-as-tool return channel.** On a **terminal** emit, the runner copies
  `structured` to `RunResult.structured` verbatim; `run_flow` returns it in preference to `text`
  (FR-173). On a non-terminal emit it is ignored. This is the only mechanism that populates
  `structured` — without it `RunResult.structured` is always `null` and `run_flow` falls back to
  `text`. `payload` stays a string for routing/logging even when `structured` is set.

---

## `runContext` propagation from a code step (the spawn-gate is not bypassable)

A code step runs as a deterministic `AsyncFunction`, **not** on a `RunLoop` turn — so, unlike a
conversation step, there is no `RunLoop` to assemble and thread the `RunContext` into
`executeToolBatches`. Left unaddressed, a code step's `orchestration.callTool("run_flow", …)` would
dispatch a child-spawning tool with **no** depth/budget context, letting a code step spawn child flows
that escape `notor-max-depth` and the aggregate `notor-max-cost-usd` ceiling entirely (and miss the
parent abort cascade). That hole is closed explicitly:

- **`CodeStepExecutor` constructs the step's `RunContext`** for the turn — `{ depth, maxDepth, budget,
  abort }` — using the **current depth** and the **shared `AggregateBudget` cell** the runner passes in
  (the same cell every node in the tree references; [run-loop.md](run-loop.md)), and the parent abort
  signal.
- **`orchestration.callTool` / `callMcpTool` thread that `runContext` (and the step's
  `orchestrationContext`) onto `ToolExecuteOptions`** at the same `ToolDispatcher.dispatch()` assembly
  site an LLM turn uses. The dispatch path is therefore identical for code-step and LLM-step tool calls.
- **Consequence:** a code-step `run_flow` is gated by the **same** spawn rule as an LLM-step `run_flow`
  — `depth < maxDepth` AND the shared budget cell has headroom — and a blocked spawn returns the same
  clear tool error (authority: [run-loop.md](run-loop.md) spawn gate, [tools.md](tools.md) `run_flow`).
  A long-running code step's tool calls also observe parent abort via the threaded `runContext.abort`.

This makes the cascading-guardrail model (FR-176) hole-free regardless of whether composition is driven
from a conversation step or a code step. (Authority for the gate itself stays [run-loop.md](run-loop.md);
this section only states that a code step's tool dispatch carries the same `runContext`.)

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

Author a step subscribing to `{step}.code_error` to handle failures. `{step}.code_error` is a
**recognized failure channel** (Issue-10): unsubscribed, it is handled by the engine's default failure
handler → a *diagnosable* `FLOW_ERROR` naming the step + carrying the error/stack (not an anonymous
`FallbackCoordinator` orphan). See [event-engine.md](event-engine.md) (FallbackCoordinator — failure
channels).

---

## At-least-once recovery (FR-125)

Crash recovery (FR-125) replays `session-log.jsonl`: a dangling `turn.start` with no matching
`turn.complete` means the turn was interrupted, so the engine **re-emits the trigger and the step
runs again** from fresh context. This is safe for vault state **only because scratchpad writes are
overwrite/idempotent** — a re-run rewrites the whole file, reproducing (not duplicating) it. An
**append** would duplicate on re-run, which is exactly why the scratchpad API has no `append` and the
scaffold/persona instruct overwrite-only writes (FR-121). But **recovery is at-least-once, not
exactly-once**: a step that performed an **external, non-idempotent side effect** (e.g.
`utils.executeShellCommand("git push")`, a Slack post via `callMcpTool`, a deploy) and then crashed
before `turn.complete` will **repeat that effect** on re-run.

> **A re-run re-does the *whole* turn — it re-spends budget and replays intra-step tool calls (Issue-13g).**
> "Re-runs from fresh context" means the entire interrupted step turn is repeated, not just the final
> emission. A conversation step can run up to the per-run `iterationCap` (20) LLM turns of tool use
> before emitting; a step that crashed on its 19th internal iteration redoes all 19 — **re-spending the
> aggregate budget** (each re-run turn decrements the cost/iteration cell afresh) and **re-executing
> every intra-step tool call that is not individually `once()`-guarded**. The corollary authors must
> internalize: `once(...)` must wrap **every** non-idempotent intra-step effect — not only the obvious
> external ones (`git push`/Slack/deploy) shown below, but any side-effecting MCP/shell/tool call made
> mid-turn — and `notor-max-cost-usd` should be sized with the possibility of reload re-runs in mind.
> (Recovery is offered as a user *resume prompt*, not silent auto-re-execution, which bounds how often
> this happens in practice.)

This is an inherent property — a plugin cannot make `git push` transactional — so the contract is
named honestly and a guard primitive is provided rather than a guarantee implied:

- **The boundary is the step author's to manage.** A code (or conversation) step with irreversible
  external effects must be idempotent or guard itself.
- **`orchestration.once(key, fn)` is the guard, and it now survives a child-flow crash.** It runs `fn`
  only if no `side_effect.committed` entry for `key` exists in this session's log, and appends one on
  success. On a recovery re-run, the already-committed `key` is skipped. **Because a non-terminal child
  flow is now *resumed in place* (it replays its own `session-log.jsonl`) rather than
  tombstoned-and-respawned (FR-125, [vault-schema.md](vault-schema.md) Parent-rooted recovery), the
  child keeps its session log — so its `side_effect.committed` markers survive the crash and `once()`
  dedupes correctly across recovery for child flows too** (the earlier tombstone-and-respawn rule gave
  the respawned child an empty log, defeating `once()` for every prior effect; that hole is closed). On
  a recovery re-run, the already-committed `key` is skipped:

  ```typescript
  // Without a guard, a crash after push but before turn.complete re-pushes on recovery.
  await orchestration.once("push-main", async () => {
    await utils.executeShellCommand("git push origin main", { cwd: repoPath });
  });
  ```

- **Best-effort, not exactly-once.** `once` collapses the *common* re-run window (crash anywhere
  after `fn` fully completed and the marker was written). It cannot cover the *irreducible* window — a
  crash that lands **after** the external effect but **before** `side_effect.committed` is appended —
  so an effect can still, rarely, repeat. Design genuinely irreversible actions accordingly (prefer
  idempotent operations; use natural idempotency keys on the remote where one exists).

The `side_effect.committed` log entry shape and write order are owned by
[vault-schema.md](vault-schema.md); recovery's classifier consuming it is INT-005 (FR-125). The
prompt scaffold and `orchestration-creator` persona instruct authors to wrap non-idempotent effects
in `once(...)`.

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
| **Aggregation / structured return** | Read several `orchestration.scratchpad` files, synthesize a combined result, and on the terminal emit pass it as the 3rd arg so a `run_flow` caller gets a typed object: `return orchestration.emit("FLOW_COMPLETE", "Done; 3 files changed.", { filesChanged: ["a.ts","b.ts","c.ts"], summary })` (FR-173). |

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
  an LLM turn — it draws on neither the cost budget nor `notor-max-iterations`, which counts LLM turns
  only; it is bounded by `max-runtime` and stale-loop detection).
- **`structured` return populated by a terminal code step (flow-as-tool):** [edges.md](edges.md)
  (`child_run_metadata`) and spec FR-173.
- **Sucrase pipeline reuse:** `src/extensions/compiler.ts` (`stripTypes:31`, `TOOL_ARG_NAMES:67`,
  `compileToolFunction:76`).
- **Shared `utils` / `libs` builders:** `src/extensions/runtime-context/index.ts`
  (`buildUtils:59`, `buildLibs:99`); shell backing `src/shell/shell-executor.ts:80`.
