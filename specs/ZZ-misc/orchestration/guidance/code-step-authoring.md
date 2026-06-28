# Code-Step Authoring Guidance (INT-013)

**Created:** 2026-06-28
**Owner task:** INT-013 ([../tasks/phase-3-code-steps.md](../tasks/phase-3-code-steps.md))
**Authority for the runtime surface:** [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md)
**Consumed by (placement tasks, Phase 6):** POL-001 (`orchestration-creator` persona `systemPromptContent`) ·
DOC-001 (user docs + `tool-creator` / `notor-help` persona updates)

> **INT-013 owns this *content*; POL-001 and DOC-001 own its *placement*.** This file is the single
> durable source of the code-step authoring guidance so the persona prompt and the docs do not drift
> from each other. When POL-001 / DOC-001 land, they lift this content into the persona system prompt
> and the docs verbatim (or near-verbatim); they do not re-derive it. Any future change to the
> `OrchestrationHelper` surface updates [../contracts/orchestration-helper.md](../contracts/orchestration-helper.md)
> first, then this file, then the two placements — in that order.

The guidance below is written to match the **shipped** surface (INT-010 `CodeStepExecutor` +
INT-011 `OrchestrationHelper`). Member names, the arg signature, and the error behavior must not drift
from the implementation in `src/orchestration/code-step-executor.ts` / `src/orchestration/orchestration-helper.ts`.

---

## When to use a code step vs a conversation step

A **code step** (`notor-step-mode: code`) runs a TypeScript code fence **deterministically** — no LLM
call, no conversation, **zero tokens**. A **conversation step** (the default) runs an LLM turn with a
persona and tools.

Pick by the kind of work:

| Use a **code step** for… | Use a **conversation step** for… |
|---|---|
| Deterministic plumbing — branching, routing, data-fetch, notification | Open-ended judgment, synthesis, writing prose/code |
| Verification (run tests, inspect a condition, route on the outcome) | Anything requiring an LLM to *decide* or *create* |
| Reshaping / aggregating payloads between steps | Tasks where the next event depends on model reasoning |
| Calling a tool / MCP server on a fixed contract | Multi-step tool use guided by the model |

Rule of thumb (the intended division of labor): **conversation steps do work; code steps verify and
route it.** The engine has no semantic verifier, so if you need a quality gate on a conversation step's
output, wire a code step after it.

---

## Frontmatter: `notor-step-mode: code`

A code step is a step note with `notor-step-mode: code`. Its body's **first** fenced code block tagged
` ```ts ` / ` ```typescript ` / ` ```js ` / ` ```javascript ` is the code that runs.

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
notor-step-default-publishes: tests.failed   # synthesized if the step returns nothing
notor-step-timeout-seconds: 300              # optional; default 300s (must exceed any inner shell timeout)
notor-step-mcp-servers: null                 # optional; null = inherit all connected (else a whitelist)
---
```

`notor-step-persona` / `notor-step-model` are **ignored** in code mode (there is no LLM turn).

---

## The injected arguments

A code step's fence is compiled with exactly these six arguments
(`CODE_STEP_ARG_NAMES`):

```typescript
// app, obsidian, utils, libs  — IDENTICAL to user-defined tools
// event                       — the incoming trigger (CodeStepEvent)
// orchestration               — the orchestration-specific helper
```

- **`utils` / `libs` / `app` / `obsidian`** are the **same objects user-defined tools receive** —
  nothing orchestration-specific is added to them. So a code step inherits `utils.executeShellCommand`,
  `utils.notify`, `utils.resolveNote`, `utils.requestUrl`, etc. unchanged. (`ShellExecuteResult.stdout`
  is **combined** stdout+stderr — there is no separate `stderr` field.)
- **`event`** is the read-only trigger: `{ topic, payload, source_step }`. `payload` is always a
  **string** — JSON-encode structured data and `JSON.parse` it in the step.
- **`orchestration`** is the helper (below).

---

## The `orchestration` helper

```typescript
orchestration.emit(topic, payload?, structured?)   // build the CodeStepResult to RETURN
orchestration.once(key, fn)                          // at-least-once side-effect guard (FR-125)
orchestration.scratchpad.read/write/list/exists      // session working space (OVERWRITE-ONLY)
orchestration.callTool(name, params)                 // dispatch a built-in tool
orchestration.callMcpTool(server, tool, params)      // dispatch an MCP tool ({server}__{tool})
orchestration.tasks.list/ensure/start/close          // runtime task registry (FR-122)
orchestration.flow.name / iteration / sessionId      // read-only metadata
orchestration.eventHistory(limit?)                   // recent events (newest last; default all)
```

### Routing: `return orchestration.emit(...)`

`emit(...)` is the **only** way to route the next event, and **you must `return` it** — a bare call is a
no-op (the engine routes the returned value). The emitted `topic` must be in the step's
`notor-step-publishes`; an unlisted topic is treated as an orphan (FallbackCoordinator → `FLOW_ERROR`).

A code step that **returns nothing** falls back to the step's `notor-step-default-publishes` (synthesized
exactly as a no-emit conversation turn would be, FR-115); if none is declared, it publishes
`{step}.no_emit` (a recognized failure channel).

`payload` defaults to `""`. Keep it a clean string (it is used for routing + logging).

### Typed return for flow-as-tool: the third `structured` arg

On a **terminal** emit (`FLOW_COMPLETE` / your `notor-completion-event`), the optional third argument is
lifted verbatim onto `RunResult.structured`, which `run_flow` returns in preference to `text` (FR-173).
On a **non-terminal** emit it is ignored. This is the only producer of `structured`.

```typescript
return orchestration.emit("FLOW_COMPLETE", "Done; 3 files changed.",
  { filesChanged: ["a.ts", "b.ts", "c.ts"], summary });
```

### Terminals: `FLOW_COMPLETE` vs `FLOW_CANCELLED`

```typescript
return orchestration.emit("FLOW_COMPLETE", "All work done.");        // subject to task enforcement
return orchestration.emit("FLOW_CANCELLED", "Nothing to do.");       // BYPASSES task enforcement
```

`FLOW_CANCELLED` (FR-132) terminates immediately with session status `cancelled` and **bypasses** the
`FLOW_COMPLETE` open-task gate — use it for a pre-flight that finds nothing to do without first closing
speculative tasks.

---

## At-least-once recovery — wrap non-idempotent effects in `once(...)`

Crash recovery (FR-125) re-runs an interrupted step from fresh context. This is safe for scratchpad
state because `scratchpad.write` is **overwrite-only** (no `append`) — a re-run reproduces, not
duplicates. But an **external, non-idempotent** effect (a `git push`, a Slack post, a deploy) would
**repeat** on a re-run. Guard every such effect:

```typescript
await orchestration.once("push-main", async () => {
  await utils.executeShellCommand("git push origin main", { cwd: repoPath });
});
```

`once(key, fn)` runs `fn` only if no `side_effect.committed` entry for `key` exists this session, and
records one on success — so a recovery re-run skips it. It is **best-effort, not exactly-once**: it
cannot cover a crash *during* `fn` (after the effect landed, before the marker was written). The markers
survive a child-flow resume (a non-terminal child is resumed in place, never tombstoned-and-respawned),
so `once()` dedupes across recovery for child flows too. Wrap **every** non-idempotent intra-step effect,
not just the obvious external ones.

---

## The `{step}.code_error` failure path

A code step **never crashes the plugin**. On a missing/empty fence, compile error, runtime throw,
unhandled rejection, or timeout, the executor:

1. fires a **`{step}.code_error`** event whose payload carries the error message + stack;
2. shows an error `Notice`;
3. still writes `turn.start` / `turn.complete` to `session-log.jsonl` (audit + recovery).

`{step}.code_error` is a **recognized failure channel** — subscribe a step to it to handle failures
gracefully (degrade / retry / route elsewhere); unsubscribed, the engine's default failure handler
terminates with a *diagnosable* `FLOW_ERROR` naming the step (not an anonymous orphan).

---

## ⚠️ Known limitation — the timeout fires only at `await` boundaries (never write an unbounded sync loop)

Code steps run as `new AsyncFunction(...)` on Obsidian's **main event-loop thread** — there is **no
Worker/VM isolation in v1**. The timeout guard (default **300 s**, override with
`notor-step-timeout-seconds`) is a `setTimeout` race, so it can only preempt the step **when it yields at
an `await`**.

- **Bounded:** a step that is slow because it is `await`-ing (a long shell command, network I/O, many
  tool calls) — the guard fires at the next `await` after expiry. This is the common, intended shape.
- **NOT bounded:** an unbounded **synchronous** loop (`while (true) {}`, a tight CPU loop with no
  `await`) never yields, so the timeout never fires and **the entire plugin freezes**.

**Mitigation (this is trusted, author-written code):** **never write an unbounded synchronous loop in a
code step**, and **insert `await` yield points** (e.g. `await Promise.resolve()` or any tool/IO await)
inside long loops so the guard can fire between iterations. The outer `notor-step-timeout-seconds` must
also **exceed** any inner `utils.executeShellCommand` `timeoutSeconds` (the inner shell timeout *is* a
hard kill because the command runs out-of-process). Worker-based hard isolation is future work, out of
scope for v1.

---

## Cost / identity

A code step creates **no conversation and consumes zero tokens** — it is **not an LLM turn**, so it draws
on neither `notor-max-cost-usd` nor `notor-max-iterations` (which counts LLM turns only). It **does**
advance the engine step-turn counter (`flow.iteration`), participate in stale-loop detection (it emits an
event), and elapse wall-clock runtime (`notor-max-runtime-minutes`). A flow whose only steps are code
steps is bounded by `max-runtime` and stale-loop detection, not by `max-iterations`.

`callTool("run_flow", …)` from a code step is depth/budget-gated and abort-cascaded **identically** to an
LLM-step `run_flow` (the step's `runContext` is threaded onto the dispatch) — there is no code-step
bypass of `max_depth` or the aggregate cost ceiling.

---

## Use-case catalog

| Use case | How a code step does it |
|---|---|
| **Pre-flight check** | Inspect a condition; `return orchestration.emit("FLOW_CANCELLED", reason)` if nothing to do. |
| **Data fetch** | `await orchestration.callMcpTool(...)` / `callTool(...)`, persist via `scratchpad.write(...)`, route to a worker step. |
| **Build/test verify** | `await utils.executeShellCommand("npm test", { timeoutSeconds })`, branch on `result.exitCode`. |
| **Task management** | `orchestration.tasks.ensure/start/close/list(...)` to drive a runtime work queue. |
| **External notify** | `await orchestration.callMcpTool("slack", "post_message", {...})` or `utils.notify(...)`. |
| **Conditional routing** | `JSON.parse(event.payload)`, inspect, and `emit` a different topic per branch. |
| **Aggregation / structured return** | Read several `scratchpad` files, synthesize, and pass the result as the terminal emit's 3rd arg (FR-173). |

---

## Worked example: a verify step

Wired between a builder and a reviewer:

```
[Builder] --build.done--> [Verify Tests] --tests.passed--> [Reviewer]
                                          --tests.failed--> [Builder]
```

The first `typescript` fence in the step note's body:

```typescript
// event.payload carries the builder's context (e.g. the project path), JSON-encoded.
const { projectPath } = JSON.parse(event.payload);

const result = await utils.executeShellCommand("npm test", {
  cwd: projectPath,
  timeoutSeconds: 120,   // inner shell timeout < the 300s outer step timeout
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

This is strictly more powerful than the removed `notor-step-verification` pass/fail field: arbitrary
logic, multi-way routing on failure *type*, transformed failure payloads, and access to external
services — all with zero tokens and deterministic branching.
