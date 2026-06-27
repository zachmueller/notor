# Task Breakdown: Phase 3 — Programmatic Code Steps (Integration, Lane B)

**Created:** 2026-06-27
**Specification:** [../spec.md](../spec.md) (FR-130 group)
**Data Model:** [../data-model.md](../data-model.md) (`CodeStepEvent` / `CodeStepResult` / `OrchestrationHelper` shapes)
**Master task index:** [../tasks.md](../tasks.md)
**Contracts:** [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md) (authority for the code-step runtime API) · [../contracts/run-loop.md](../contracts/run-loop.md) · [../contracts/event-engine.md](../contracts/event-engine.md)
**Status:** Draft

This file holds the task **bodies** for **Lane B** (design Phase 3): the programmatic code-step
substrate. The phase→task mapping, dependency edges, critical path, and per-phase test gate are owned
by [../tasks.md](../tasks.md); the IDs and edges below must match it exactly.

A **code step** is a step note with `notor-step-mode: code` (see `StepDefinition` in
[../data-model.md](../data-model.md)) that executes a TypeScript code fence deterministically — **no
LLM call, no `ConversationSession`, no JSONL conversation file, zero tokens**. The full runtime API
(`OrchestrationHelper`, `CodeStepEvent`, `CodeStepResult`, `CODE_STEP_ARG_NAMES`) is the single
authority of [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md) — this file
references it and does **not** redefine it.

---

## Lane summary

| ID | One-liner | Depends on | FRs |
|---|---|---|---|
| INT-010 | `CodeStepExecutor` (Sucrase pipeline + timeout guard) | FEAT-007 | FR-130 |
| INT-011 | `OrchestrationHelper` runtime API | INT-010, INT-001, INT-002 | FR-131 |
| INT-012 | `FLOW_CANCELLED` terminal event (bypasses task enforcement) | FEAT-010, INT-010, INT-003 | FR-132 |
| INT-013 | Code-step guidance (carried into POL-001 / DOC-001) | INT-011 | FR-130, FR-131 |
| TEST-004 | Code-step executor + `OrchestrationHelper` unit tests | INT-010, INT-011 | gate for Phase 3 |

### Lane sequencing notes (from [../tasks.md](../tasks.md))

- Lane B branches off the Phase-1 core at **FEAT-007** (`StepTurnExecutor`) and runs concurrently
  with Lanes A/C/D once **FEAT-010** lands. Lane B and Lanes C/D share only **INT-001**
  (`OrchestrationSessionManager`, the scratchpad/session backing INT-011 needs).
- **Risk #8 (sequencing-risk register):** `FLOW_CANCELLED` (**INT-012**) must **bypass**
  `FLOW_COMPLETE` task enforcement (**INT-003**). **INT-003 lands first** so INT-012 wires the bypass
  against an existing enforcement path rather than inventing one.
- **Risk #10:** the Phase-7 chaining adapter (**INT-045**) depends on code steps (**INT-010**) — the
  optional code-step input-reshaping adapter for chaining reuses `CodeStepExecutor`. Do **not**
  parallelize INT-045 across Lane B; INT-010 is its prerequisite.
- A terminal code step is also what populates `RunResult.structured` for flow-as-tool (**INT-043** /
  FR-173); INT-010 is therefore on the composition path as well, but that wiring lives in Phase 7.

---

## INT-010: `CodeStepExecutor` (Sucrase pipeline + timeout guard)

**Description:** Implement the deterministic code-step execution path. When `StepTurnExecutor`
(FEAT-007) sees a step with `notor-step-mode: code`, it delegates to `CodeStepExecutor` instead of the
conversation path: the executor **skips** persona activation, `ConversationSession` creation, and
prompt assembly, and runs the step's code fence through the **existing** Sucrase pipeline. It reuses
`stripTypes()` (`src/extensions/compiler.ts:31`) and the same `new AsyncFunction(...names, code)`
mechanism as `compileToolFunction()` (`src/extensions/compiler.ts:76`), but with the code-step
argument list `CODE_STEP_ARG_NAMES = ["app", "obsidian", "utils", "libs", "event", "orchestration"]`
(authority: [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md)) — i.e.
`TOOL_ARG_NAMES` (`src/extensions/compiler.ts:67`) with the last three tool args (`settings`,
`shared`, `params`) swapped for `event` and `orchestration`. There is **no second compiler**.

The executor: (1) extracts the first fenced block tagged `ts`/`typescript`/`js`/`javascript` from the
step note `bodyContent`; (2) strips types and compiles; (3) executes the async function under a
**timeout guard** (default **60 s**, configurable — mirrors the per-server MCP timeout convention);
(4) captures the returned `CodeStepResult` and hands its `{topic, payload}` back to the engine for
write-before-route routing, exactly like a conversation step's captured `emit_event` call.

**Error handling (FR-130 AC):** a code step must **never crash the plugin**. On a missing fence,
compile error, runtime throw, unhandled rejection, or timeout, the executor fires a
**`{step}.code_error`** event whose payload carries the error message + stack, shows an error
`Notice`, and **still** writes `turn.start` / `turn.complete` to `session-log.jsonl` for audit and
crash recovery (write-order per [../contracts/event-engine.md](../contracts/event-engine.md) /
vault-schema). The error event then routes normally — to a step subscribing on `{step}.code_error`,
or to the `FallbackCoordinator` (FR-113).

**Cost / identity:** a code step creates no conversation and consumes zero tokens; it does **not**
draw on the aggregate `RunContext.costRemainingUsd` budget (it is not an LLM turn). It **does** count
as an engine turn for `notor-max-iterations` / runtime / stale-loop accounting — the engine
(FEAT-008), not the code, owns those guards (see [../contracts/run-loop.md](../contracts/run-loop.md)).

The runtime `event` / `orchestration` arguments are populated by INT-011; INT-010 establishes the
extraction → compile → execute → capture skeleton and injects placeholder `event` (the routed
`CodeStepEvent` projection) while wiring the helper itself in INT-011.

**FRs:** FR-130 (code step execution mode).

**Files:**
- `src/orchestration/code-step-executor.ts` — `CodeStepExecutor`: fence extraction, `stripTypes` +
  `AsyncFunction` compile with `CODE_STEP_ARG_NAMES`, timeout guard, `{step}.code_error` capture,
  `turn.start`/`turn.complete` logging hook.
- `src/orchestration/step-turn-executor.ts` — (FEAT-007) add the `notor-step-mode: code` branch that
  delegates to `CodeStepExecutor` and skips the conversation path.
- `src/orchestration/code-step-executor.test.ts` — unit coverage seed (assertions detailed in
  TEST-004).

**Dependencies:** FEAT-007 (`StepTurnExecutor` — the dispatch point that routes a `code`-mode step
into this executor; the conversation path it skips).

**Reuses (verified seams):**
- `src/extensions/compiler.ts:31` `stripTypes()` (Sucrase `typescript` transform).
- `src/extensions/compiler.ts:76` `compileToolFunction()` `new AsyncFunction(...names, code)` mechanism.
- `src/extensions/compiler.ts:67` `TOOL_ARG_NAMES` (the arg list this swaps the tail of).

**Acceptance Criteria:**
- [ ] A `notor-step-mode: code` step creates **no** conversation and consumes **zero** tokens.
- [ ] The first `ts`/`typescript`/`js`/`javascript` fence in `bodyContent` is extracted, type-stripped
  via `stripTypes()`, and compiled to an `AsyncFunction` with exactly `CODE_STEP_ARG_NAMES`.
- [ ] A missing/empty fence is treated as a code error (does not throw).
- [ ] Execution is bounded by a timeout guard (default 60 s, configurable); on expiry the run is
  abandoned and the step errors.
- [ ] On compile error, runtime throw, unhandled rejection, or timeout, the executor fires a
  `{step}.code_error` event carrying the error message + stack **and** shows an error `Notice`.
- [ ] `turn.start` and `turn.complete` are written to `session-log.jsonl` **even on error** (audit +
  recovery).
- [ ] A code step does **not** decrement `RunContext.costRemainingUsd` (it is not an LLM turn) but
  **does** advance the engine iteration / runtime / stale-loop counters.
- [ ] A returned `CodeStepResult`'s `{topic, payload}` is handed to the engine for write-before-route
  routing; a `topic` not in the step's `notor-step-publishes` is treated as an orphan
  (FallbackCoordinator, FR-113), identical to a conversation-step emission.

---

## INT-011: `OrchestrationHelper` runtime API

**Description:** Implement the `orchestration` helper object injected as the sixth code-step argument,
plus the read-only `event` (`CodeStepEvent`) projection of the routed `OrchestrationEvent`. The full
TypeScript surface and per-member semantics are the **single authority** of
[../contracts/orchestration-helper.md](../contracts/orchestration-helper.md) — implement to that
contract; do not redefine it here. Members:

- `emit(topic, payload?)` → builds the terminal `CodeStepResult` (the only constructor of it;
  `return`ing it is mandatory — a bare call is a no-op). A code step that returns nothing falls back
  to the step's `notor-step-default-publishes`, synthesized exactly as a no-emit conversation turn
  would be (FR-115).
- `scratchpad` (`read`/`write`/`list`/`exists`) → backed by the owning session's
  `sessions/{id}/scratchpad/` (INT-001). The session's scratchpad path is auto-allowed in path
  enforcement (FR-120/FR-121), so a code step needs no explicit `allowed_paths`.
- `callTool(name, params)` / `callMcpTool(server, tool, params)` → dispatch through the **same**
  `ToolDispatcher.dispatch()` seam (`src/chat/dispatcher.ts:388`) as LLM tool calls; honor path
  enforcement and the owning session's auto-allowed scratchpad path. `callMcpTool` namespaces as
  `{serverName}__{toolName}` and respects the step's `notor-step-mcp-servers` filter (null = inherit
  all). A dispatch rejection is caught by INT-010 and surfaces as `{step}.code_error`.
- `tasks` (`list`/`ensure`/`start`/`close`) → the **same backing** as the four task-tool scaffolds
  (INT-002 / FR-122); `ensure` is idempotent. Open/running tasks block `FLOW_COMPLETE` (FR-123) but
  not `FLOW_CANCELLED` (FR-132 / INT-012).
- `flow` (`name`/`iteration`/`sessionId`) → read-only metadata for the current turn.
- `eventHistory(limit?)` → the same history the conversation-step scaffold injects as prose, exposed
  here as data.

The helper is **built on the existing extension `runtime-context/`**: `utils` and `libs` injected into
a code step are the **identical objects** from `buildUtils()` (`src/extensions/runtime-context/index.ts:59`)
and `buildLibs()` (`src/extensions/runtime-context/index.ts:99`) used by user-defined tools/automations —
nothing orchestration-specific is added to them. All orchestration capability lives on the
`orchestration` helper. This is why a code step inherits `utils.executeShellCommand` (backed by
`src/shell/shell-executor.ts:80`; returns `ShellExecuteResult` whose `stdout` is **combined**
stdout+stderr — there is no separate `stderr` field), `utils.notify` (`plugin-utils.ts:308`),
`utils.resolveNote`, `utils.requestUrl`, etc., unchanged.

**FRs:** FR-131 (`OrchestrationHelper` runtime API).

**Files:**
- `src/orchestration/orchestration-helper.ts` — `buildOrchestrationHelper(session, event, engine, dispatcher, ...)`
  factory returning the `orchestration` object; `CodeStepEvent` projection from `OrchestrationEvent`.
- `src/orchestration/code-step-executor.ts` — (INT-010) inject the built `orchestration` + `event` as
  the final two `CODE_STEP_ARG_NAMES` args.
- `src/orchestration/orchestration-helper.test.ts` — unit coverage seed (assertions in TEST-004).

**Dependencies:** INT-010 (the executor that injects this helper), INT-001
(`OrchestrationSessionManager` — backs `scratchpad` + `flow.sessionId`), INT-002 (task tool scaffolds —
the `tasks` member shares their backing).

**Reuses (verified seams):**
- `src/extensions/runtime-context/index.ts:59` `buildUtils()`, `:99` `buildLibs()` (identical `utils`/`libs`).
- `src/chat/dispatcher.ts:388` `ToolDispatcher.dispatch()` (the `callTool`/`callMcpTool` seam).
- `src/extensions/runtime-context/plugin-utils.ts:308` `notify(...)`; `src/shell/shell-executor.ts:80`
  `executeShellCommand(...)` (inherited via `utils`).

**Acceptance Criteria:**
- [ ] `return orchestration.emit(topic, payload?)` routes the next event deterministically; a bare
  (un-`return`ed) call has no effect.
- [ ] A code step that returns no `CodeStepResult` synthesizes the step's
  `notor-step-default-publishes` (parity with a no-emit conversation turn, FR-115).
- [ ] `callTool` / `callMcpTool` dispatch through `ToolDispatcher.dispatch()` (registered built-in
  tools / connected MCP servers); a dispatch rejection surfaces as `{step}.code_error` (caught by
  INT-010, not a plugin crash).
- [ ] `callMcpTool` respects the step's `notor-step-mcp-servers` filter (null = inherit all).
- [ ] `scratchpad.read/write/list/exists` operate under `sessions/{id}/scratchpad/`; writes are
  readable by downstream steps; access bypasses per-step path constraints for the owning session.
- [ ] `tasks.ensure/start/close/list` share the INT-002 task backing; `ensure` is idempotent;
  `list({status})` filters by status.
- [ ] `flow.name`/`flow.iteration`/`flow.sessionId` reflect the current turn; `flow.iteration` equals
  the engine turn counter.
- [ ] `eventHistory(limit?)` returns the session's recent `OrchestrationEvent`s (newest last;
  `limit` defaults to all).
- [ ] `utils` and `libs` are the **identical** objects from `buildUtils()`/`buildLibs()` — no
  orchestration-specific members added to them.

---

## INT-012: `FLOW_CANCELLED` terminal event (bypasses task enforcement)

**Description:** Add `FLOW_CANCELLED` as a terminal event available from **both** code steps (via
`return orchestration.emit("FLOW_CANCELLED", reason)`) and conversation steps (via the `emit_event`
tool). When the runner routes `FLOW_CANCELLED` it terminates the loop immediately, sets session status
to **`cancelled`** (distinct from `completed`/`error`), and writes a `session.cancelled`
`session-log.jsonl` entry with the payload as the reason.

The defining behavior (FR-132 AC): `FLOW_CANCELLED` **bypasses** the `FLOW_COMPLETE` completion task
enforcement (INT-003 / FR-123) — open or running tasks do **not** block it. This lets a code-step
pre-flight cancel a flow that has nothing to do without first closing speculative tasks. Per
[../contracts/event-engine.md](../contracts/event-engine.md), the runner's terminal handling treats
`FLOW_COMPLETE` and `FLOW_CANCELLED` as distinct terminals: only the former passes through the
remaining-task gate; the latter short-circuits straight to `cancelled`.

**Sequencing (risk #8):** INT-003 (`FLOW_COMPLETE` task enforcement) is the prerequisite this work
opts *out* of, so it must land first — INT-012 wires the bypass against an existing enforcement path
rather than introducing one. The `FLOW_CANCELLED` constant is defined in
[../data-model.md](../data-model.md) (terminal event constants).

**FRs:** FR-132 (`FLOW_CANCELLED` terminal event).

**Files:**
- `src/orchestration/runner.ts` — (FEAT-010) terminal-event handling: `FLOW_CANCELLED`
  branch that bypasses the INT-003 remaining-task gate, sets status `cancelled`, writes
  `session.cancelled`.
- `src/orchestration/types.ts` — (FEAT-001) ensure `FLOW_CANCELLED` is exported among the terminal
  constants (consumed by the runner, the helper `emit`, and the `emit_event` tool).
- `src/orchestration/runner.test.ts` — terminal-handling coverage (open-tasks-bypass
  case noted in TEST-004 / the runner suite).

**Dependencies:** FEAT-010 (`OrchestrationRunner` — the loop that finalizes on a terminal event),
INT-010 (`CodeStepExecutor` — a code step is one of the two `FLOW_CANCELLED` producers), INT-003
(`FLOW_COMPLETE` task enforcement — the gate `FLOW_CANCELLED` bypasses; **must precede this task**).

**Acceptance Criteria:**
- [ ] `FLOW_CANCELLED` terminates the loop immediately with session status `cancelled`.
- [ ] Open/running tasks do **not** block `FLOW_CANCELLED` (the INT-003 remaining-task gate is
  bypassed) — contrast `FLOW_COMPLETE`, which they *do* block.
- [ ] `FLOW_CANCELLED` is emittable from a code step (`return orchestration.emit("FLOW_CANCELLED", …)`)
  **and** from a conversation step (`emit_event` tool).
- [ ] A `session.cancelled` entry is written to `session-log.jsonl` with the payload as the reason.
- [ ] Status `cancelled` is distinct from `completed` and `error` in `session.json` and in recovery.

---

## INT-013: Code-step guidance (carried into POL-001 / DOC-001)

**Description:** Author the durable code-step authoring guidance and thread it to its two downstream
consumers rather than shipping it as a standalone artifact. The guidance covers: when to use a code
step vs a conversation step (deterministic plumbing — branching, routing, verification, data-fetch,
notification — vs LLM judgment); the `notor-step-mode: code` frontmatter; the `event` /
`orchestration` argument surface; the `return orchestration.emit(...)` routing contract and the
`notor-step-default-publishes` fallback; the `{step}.code_error` failure path; the use-case catalog;
and the worked verify-step example (all per
[../contracts/orchestration-helper.md](../contracts/orchestration-helper.md)).

This guidance is **carried into** two places (it is not a separate doc file): the
`orchestration-creator` built-in persona system prompt (**POL-001**), so the persona can teach users
to author code steps, and the user-facing docs + `tool-creator`/`notor-help` persona updates
(**DOC-001**). INT-013 owns the *content*; POL-001 and DOC-001 own its *placement* and are the tasks
that consume it (POL-001 → FEAT-002/INT-040; DOC-001 → POL-001/INT-011 per [../tasks.md](../tasks.md)).

**FRs:** FR-130, FR-131 (the behavior this guidance describes).

**Files:**
- (No net-new source file.) Guidance content is consumed by:
  - `src/personas/builtin-personas.ts` — (POL-001) `orchestration-creator` `systemPromptContent`
    gains a code-step authoring section.
  - `docs/` + persona prompts — (DOC-001) user docs and `tool-creator`/`notor-help` updates.

**Dependencies:** INT-011 (`OrchestrationHelper` — the API the guidance documents must match the
shipped surface).

**Acceptance Criteria:**
- [ ] The code-step authoring guidance is written and matches the shipped
  [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md) surface (no drift in
  member names, arg signature, or error behavior).
- [ ] It explains code-step vs conversation-step selection, the `notor-step-mode: code` frontmatter,
  the `event`/`orchestration` args, the `return orchestration.emit(...)` contract +
  `default_publishes` fallback, and the `{step}.code_error` path.
- [ ] It is referenced by POL-001 (`orchestration-creator` persona) and DOC-001 (docs + persona
  updates) — INT-013 produces content; those tasks place it.

---

## TEST-004: Code-step executor + `OrchestrationHelper` unit tests

**Description:** Unit coverage for the code-step substrate (INT-010 + INT-011) and the
`FLOW_CANCELLED` terminal (INT-012). This is the **Phase 3 test gate** (per
[../tasks.md](../tasks.md) per-phase gate): fence extraction, timeout, `error → {step}.code_error`,
and helper dispatch must be green before Lane B merges. Tests parallelize across Core / Lane-B work.

**FRs:** gate for FR-130 / FR-131 / FR-132 (INT-010 / INT-011 / INT-012).

**Files:**
- `src/orchestration/code-step-executor.test.ts` — INT-010 surface.
- `src/orchestration/orchestration-helper.test.ts` — INT-011 surface.

**Dependencies:** INT-010, INT-011 (the units under test; the INT-012 terminal assertion rides the
runner suite but is verified here for the helper-emit path).

**Acceptance Criteria:**
- [ ] **Fence extraction:** first `ts`/`typescript`/`js`/`javascript` fence is extracted and compiled;
  a missing/empty fence → `{step}.code_error` (no throw).
- [ ] **Type strip + arg signature:** a typed fence compiles via `stripTypes()`; the compiled function
  is invoked with exactly `CODE_STEP_ARG_NAMES` (`app`, `obsidian`, `utils`, `libs`, `event`,
  `orchestration`).
- [ ] **Timeout:** a fence that exceeds the timeout guard is abandoned and surfaces `{step}.code_error`.
- [ ] **Error → `{step}.code_error`:** compile error, runtime throw, and unhandled rejection each fire
  `{step}.code_error` (payload carries message + stack), show an error `Notice`, and still write
  `turn.start`/`turn.complete`.
- [ ] **No tokens / no cost:** a code step records zero token usage and does not decrement
  `RunContext.costRemainingUsd`, while advancing the engine iteration counter.
- [ ] **Helper dispatch:** `callTool`/`callMcpTool` route through `ToolDispatcher.dispatch()` (mocked);
  `callMcpTool` honors the `notor-step-mcp-servers` filter; a dispatch rejection becomes
  `{step}.code_error`.
- [ ] **`emit` routing:** `return orchestration.emit(t, p)` yields `{topic: t, payload: p}`; a bare
  call is a no-op; returning nothing synthesizes `notor-step-default-publishes`.
- [ ] **`scratchpad` / `tasks` / `eventHistory`:** scratchpad round-trips under the session dir;
  `tasks.ensure` is idempotent and `list({status})` filters; `eventHistory(limit?)` returns the
  recent events (newest last).
- [ ] **`FLOW_CANCELLED` (INT-012):** an emitted `FLOW_CANCELLED` is a terminal that bypasses
  open-task enforcement (verified at the helper-emit boundary; full terminal-loop behavior in the
  runner suite).

---

## Cross-references

- **Runtime API authority** (`OrchestrationHelper`, `CodeStepEvent`, `CodeStepResult`,
  `CODE_STEP_ARG_NAMES`, member semantics, worked example): [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md).
- **Type shapes** (`StepDefinition` `mode: "conversation" | "code"`, `OrchestrationEvent`,
  `OrchestrationTask`, terminal constants `FLOW_COMPLETE`/`FLOW_CANCELLED`/`FLOW_ERROR`,
  `RunContext`/`RunResult.structured`): [../data-model.md](../data-model.md).
- **Why a code step does not draw on the cost budget** (per-run cap vs aggregate tree budget): [../contracts/run-loop.md](../contracts/run-loop.md).
- **Write-before-route, orphan → `FallbackCoordinator`, terminal-event ownership, `default_publishes`
  synthesis, `{step}.code_error` routing:** [../contracts/event-engine.md](../contracts/event-engine.md).
- **Phase prerequisites:** FEAT-007 / FEAT-010 in [../tasks/phase-1-engine.md](../tasks/phase-1-engine.md);
  INT-001 / INT-002 / INT-003 in [../tasks/phase-2-session-nav.md](../tasks/phase-2-session-nav.md).
- **Downstream:** INT-013 content lands in POL-001 / DOC-001 ([../tasks/phase-6-builtins.md](../tasks/phase-6-builtins.md));
  the chaining adapter INT-045 and flow-as-tool `structured` return INT-043 reuse INT-010
  ([../tasks/phase-7-composability.md](../tasks/phase-7-composability.md)).
- **Sucrase pipeline reuse:** `src/extensions/compiler.ts` (`stripTypes:31`, `TOOL_ARG_NAMES:67`,
  `compileToolFunction:76`). **Shared `utils`/`libs`:** `src/extensions/runtime-context/index.ts`
  (`buildUtils:59`, `buildLibs:99`); shell backing `src/shell/shell-executor.ts:80`.
