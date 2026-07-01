# F1 — Orchestration runs need a lifecycle owner (CRITICAL)

**Status:** Ready to implement
**Source review:** `private/architecture-review-2026-07-01.md` §F1 (git-ignored)
**Code verified against:** HEAD `c0d21e9`, clean tree, re-verified by direct read on 2026-07-01/02.
**Effort:** M–L (four sub-fixes, independently landable; ~2–4 days total)
**Priority within slice 1:** second (after F3, which is smaller and whose `RunResult` changes this work does not depend on).

> **Line-number caveat.** Every `file:line` below was confirmed by direct read at `c0d21e9`. Line numbers
> drift. **Re-locate by symbol name at implementation time, not by line.**

---

## 1. Problem statement

A running orchestration flow is an unowned resource. Verified consequences, all in the untested
integration layer (`src/orchestration/launch.ts`):

1. **Uncancellable.** `launchOrchestration` creates an `AbortController` at `launch.ts:569` that is
   never stored, never returned, and never aborted — `grep '\.abort(' src/orchestration/*.ts`
   (non-test) has zero hits. `resumeRecoveredSession` roots a second orphan at `launch.ts:1212`
   (`inheritedContext?.abort ?? new AbortController().signal`). The flow-run indicator entry
   (`FlowRunEntry`, `src/workflows/workflow-activity-tracker.ts:31–37`) carries no handle, and its
   dropdown row (`src/ui/workflow-activity-dropdown.ts:332–347`) is click-to-navigate only. No command
   stops a flow. Downstream abort *plumbing works* if the signal ever fired: `runner.ts:386–388` checks
   `abortSignal.aborted` per queue iteration → `FLOW_CANCELLED`, and RunLoop links `runContext.abort`
   into its own controller. Only the trigger is missing.
2. **Unload-unsafe → double runner.** `onunload()` (`main.ts:749–851`) destroys chat orchestrators and
   aborts `_detachedSubAgents` but contains **zero** orchestration teardown. In-flight promise chains
   survive plugin disable and keep executing. `session.json` stays `status: "active"` for the whole run
   (writers enumerated in §2.1), and `RECOVERABLE_STATUSES = new Set(["active", "interrupted"])`
   (`session-recovery.ts:143`), so re-enabling the plugin auto-resumes the session
   (`recoverOrchestrations`, `launch.ts:1120–1187` — Notice at :1171, fire-and-forget
   `resumeRecoveredSession` at :1180) **while the original runner may still be live**: two writers
   appending to one `session-log.jsonl`, racing on `session.json`. The docstring at `launch.ts:1116–1118`
   ("Resume is offered, not forced") does not match the code — there is no prompt.
3. **Child-flow double-execution on recovery replay.** The `child.spawned`/`child.result` ledger is
   matched by exact `via_tool_call_id` (`launch.ts:929–932`), but that id is minted from a **random UUID
   inside every `run_flow` execution** (`run-flow.ts:148`:
   `` const viaToolCallId = `runflow-${crypto.randomUUID().slice(0, 12)}`; ``). Recovery replays a step
   from fresh context (at-least-once boundary, `runner.ts:257–260, 317–319`), the LLM re-issues
   `run_flow`, a new id is minted, the ledger `find` can never hit, and a **fresh child is spawned**,
   re-executing the child flow's side effects. The doc comment at `launch.ts:794–798` describes
   occurrence-order matching that was never implemented; `child.spawned` is written with `turn: 0` and
   `step:` = the per-turn random *conversation* UUID (`launch.ts:830–837`), so no ordering/step data is
   even recorded. The reuse (`launch.ts:941–954`) and resume-in-place (`launch.ts:956–993`) branches and
   `resumeChildSession` (`launch.ts:1277–1289`) are consequently **unreachable dead code**. The orphaned
   old child session (origin `run_flow`) is also never recovered by the top-level scan
   (`session-recovery.ts:396–398`).
4. **No per-flow single-instance guard.** `launchOrchestration` (`launch.ts:491–670`) performs no
   is-already-running check. Colliding launch paths: cron (`vault-event-scheduler.ts:246–262, 455–466` →
   `main.ts:1137`), manual picker (`launch.ts:1486`), hook (`main.ts:1048`), auto-resume
   (`launch.ts:1180`), chaining (`launch.ts:755`). The workflow subsystem already has the analogous
   guard: `WorkflowConcurrencyManager.isWorkflowRunning(workflowPath)`
   (`src/workflows/workflow-concurrency.ts:399–411`), consumed with skip-and-Notice semantics at
   `vault-event-dispatcher.ts:244, 304, 456`.
5. **Thrashing guard (FEAT-008) is dead end-to-end.** `LoopSafetyGuards.evaluate` checks thrashing only
   when a `taskKey` is supplied (`safety.ts:131`); the runner's single call site (`runner.ts:446–453`)
   never supplies one; `abandonCounts` is only written during resume rehydration (`runner.ts:282–284`
   from `session-recovery.ts:226–245`), never during a live run. Dead both ways.

**Additional verified bugs found during cross-referencing (fix in the same package):**

- **A. `"schedule"` origin missing from recovery.** `KNOWN_ORIGINS` (`session-recovery.ts:141`) and
  `isRecoverableRoot` (`session-recovery.ts:382–400`) omit `"schedule"`, a legal `origin` value
  (`types.ts:168`) stamped at `main.ts:1137`. A crashed scheduled run is surfaced as a loud recovery
  *error* ("Unexpected or absent origin", marked `error` at `launch.ts:1154`) instead of being resumed.
- **B. Chaining is awaited, contra its own doc.** `launch.ts:702–703` says the successor launch "is
  fire-and-forget"; the code `await`s it (`launch.ts:663–667` → full `launchOrchestration` at :755). A
  `run_flow` parent awaiting a chaining child awaits the entire chain (this is review item F13; decide
  code-or-docs here since we touch the file).
- **C. `upsertFlowRun` at finalize overwrites `startedAt`** with the finalize timestamp
  (`launch.ts:651`), mis-sorting completed entries. Trivial; fix while touching the registry.

---

## 2. Verified current-state reference

### 2.1 Session status lifecycle (`OrchestrationSessionMeta["status"]`, `types.ts:156`)

| Status | Writers |
|---|---|
| `active` | `createSession` (`session-manager.ts:134`); resume start (`launch.ts:1203`); pause→resume restore (`runner.ts:667` via `setSessionStatus` seam → `launch.ts:615`/`1243`) |
| `interrupted` | interactive pause (`runner.ts:619`); crash catch (`launch.ts:626–630`); resume crash catch (`launch.ts:1251`) |
| `completed`/`cancelled`/`error` | finalize after `runner.start` (`launch.ts:634–643`); finalize after resume (`launch.ts:1254–1262`); recovery-scan errors → `error` (`launch.ts:1154`) |

`SessionManager` API: `resolveWorkspace(sessionId)` (`session-manager.ts:105–115`, returns
`{ sessionId, sessionDir, scratchpadPath, tasksPath, metaPath, logPath }`), `updateStatus(sessionId,
status, patch?)` (`:174–184`, read-modify-write — F4 hardens this). Workspace root:
`{notor_dir}/orchestrations/sessions/{sessionId}/`.

### 2.2 The pattern to mirror: `_detachedSubAgents`

`main.ts:242–252`:

```ts
private _detachedSubAgents = new Set<AbortController>();
registerDetachedSubAgent(controller: AbortController): void { this._detachedSubAgents.add(controller); }
unregisterDetachedSubAgent(controller: AbortController): void { this._detachedSubAgents.delete(controller); }
```

Registered/unregistered around the run with `finally` (`sub-agent-utils.ts:181–200`); unload aborts all
and clears (`main.ts:799–803`).

### 2.3 Heartbeat attach points (verified seams)

- `OrchestrationRunnerDeps.onProgress?: (status: string) => void` (`runner.ts:155`) — fires once per
  step turn (`runner.ts:402`) and on pause (`runner.ts:620`); currently wired to `log.debug` only
  (`launch.ts:616`, `1244`).
- `session-log.jsonl` **mtime already advances ≥2×/turn** (`turn.start` at `step-turn-executor.ts:234–239`,
  `turn.complete` at `:336–343`) — a free liveness signal. `vault.adapter.stat` is already used in the
  repo (`history.ts:871, 890`).
- `RunLoopHooks.onTurnComplete` (`run-loop/types.ts:309–318`) per LLM turn, hooks bag built per step at
  `step-turn-executor.ts:285–296`.

### 2.4 Ledger entry types (`session-log.ts:91–106`)

```ts
export interface ChildSpawnedEntry extends BaseEntry {
    type: "child.spawned";
    turn: number;            // ← hardcoded 0 today (launch.ts:831)
    step: string;            // ← holds parentConversationId (random per-turn UUID), not a step name
    via_tool_call_id: string;
    child_session_id: string;
}
export interface ChildResultEntry extends BaseEntry {
    type: "child.result";
    turn: number;
    child_session_id: string;
    structured?: unknown;
    text: string;
    stop_reason: string;
}
```

Writers: `appendChildSpawned`/`appendChildResult` (`session-log.ts:252–258`). Reader:
`reconcileChildLedger` (`launch.ts:900–993`) re-reads the parent's `session-log.jsonl` **directly via
`plugin.app.vault.adapter`** (`launch.ts:911–913`) — not through an injectable seam (testability
obstacle; see §3.3 step 1).

`makeChildFlowSpawner(plugin: NotorPlugin): SpawnChildFlow` (`launch.ts:800`), where
`SpawnChildFlowRequest` (`child-flow.ts:30–45`) = `{ flowName, payload, parentSessionId,
parentScratchpadPath, parentConversationId?, viaToolCallId, cascade: { budget, depth, abort } }`.
Wired once at `main.ts:1680` (`new RunFlowTool(composition, makeChildFlowSpawner(this))`).

**Stable-id analysis (important nuance vs. the review text):** the provider-issued LLM tool-call id *is*
captured (`run-loop.ts:562–566` → `ToolCallInfo.toolCallId`) and reaches `dispatch()` as `messageId`,
but it is **not replay-stable**: recovery replays the step with a brand-new LLM call, which mints new
`tool_use` ids. Keying the ledger off the provider id would fix nothing for the crash-replay case.
**The deterministic cross-replay key must be occurrence order per (step name, callee flowName)** — which
is exactly what the doc comment at `launch.ts:794–798` already describes. That requires enriching
`ChildSpawnedEntry` with the real step name and per-step ordinal (neither is recorded today) and
threading the step name to the spawner (available as `req.step.name` in the executor; absent from
`OrchestrationToolContext`, `run-loop/types.ts:136–208`).

---

## 3. Change

Four independently landable sub-fixes, in recommended land order.

### 3.1 Fix 1 — `OrchestrationRunRegistry`: abort path, Stop UI, unload teardown (S–M)

New file `src/orchestration/run-registry.ts` (pure, no Obsidian imports):

```ts
export interface OrchestrationRunHandle {
    sessionId: string;
    flowName: string;
    controller: AbortController;
    /** Refreshed by the runner's onProgress; used by recovery liveness (Fix 2). */
    lastProgressAt: number;
}

export class OrchestrationRunRegistry {
    private runs = new Map<string, OrchestrationRunHandle>();
    register(handle: OrchestrationRunHandle): void;
    unregister(sessionId: string): void;
    get(sessionId: string): OrchestrationRunHandle | undefined;
    isFlowRunning(flowName: string): boolean;         // Fix 4 consumes this
    abort(sessionId: string): boolean;                // Stop button consumes this
    abortAll(): AbortController[];                    // onunload consumes this
    touch(sessionId: string): void;                   // heartbeat refresh
}
```

Wiring:

1. `NotorPlugin` owns one instance (field + getter, mirroring `_detachedSubAgents` placement at
   `main.ts:242`). Lazy-construct is unnecessary — it is a Map wrapper.
2. `launchOrchestration` registers after creating the controller (`launch.ts:569`) and unregisters in a
   `finally` around the `runner.start()` await. **Same for `resumeRecoveredSession`** — replace the
   orphan at `launch.ts:1212` with a registered controller when `inheritedContext?.abort` is absent
   (when a parent signal *is* inherited, register a handle that wraps the parent's controller or skip
   registration for children — children are cancelled transitively via `cascade.abort`; recommended:
   register **root sessions only**, i.e. when `inheritedContext` is undefined, since child cancellation
   cascades from the root signal already).
3. `onunload()` (`main.ts`, in the teardown sequence near the `_detachedSubAgents` abort at
   `main.ts:799–803`): `for (const c of registry.abortAll()) …` then a **bounded** await (e.g.
   `Promise.race` with a ~1500 ms timeout) of the runners' status writes. The runner already maps abort →
   `FLOW_CANCELLED` → finalize writes `cancelled` (`launch.ts:634–643`), so no extra "interrupted" write
   is needed *if* the finalize completes; the bounded await is best-effort — if it times out, the session
   stays `active` and Fix 2's liveness guard makes the subsequent auto-resume safe.
4. **Stop UI:** add an `onStopFlowRun?: (sessionId: string) => void` callback to
   `WorkflowActivityDropdown` (constructor-injected like `onOpenRunTree`, threaded via
   `workflow-activity-indicator.ts:130–138` and `chat-view.ts:652`). In `renderFlowRunEntry`
   (`workflow-activity-dropdown.ts:332–347`), for entries with `status === "active"`, render a small
   stop icon-button (`setIcon` + `stopPropagation`, matching the hand-built DOM idiom already in that
   file) that calls `plugin.getOrchestrationRunRegistry().abort(sessionId)`. No new command is required
   for v1 (the dropdown is the canonical surface), but a `stop-orchestration` command listing active
   registry entries is a cheap optional add in `src/commands/index.ts` next to `run-orchestration`
   (:326–340).
5. While here (bug C): in the finalize upsert (`launch.ts:646–652`), stop overwriting `startedAt` —
   preserve the entry's original value.

### 3.2 Fix 2 — Recovery liveness guard + honest resume semantics (S)

Goal: re-enabling the plugin must never start a second runner on a session that is still live, and the
"offered" claim must become true or be deleted.

1. **Liveness check in the recovery scan.** In `recoverOrchestrations` (`launch.ts:1120–1187`), before
   resuming a recoverable root with `status: "active"`, stat the session's `session-log.jsonl`
   (`ws.logPath` from `resolveWorkspace`) via `plugin.app.vault.adapter.stat`. If `mtime` is fresher
   than a threshold (recommend **90 s** — the log advances at least twice per LLM turn, and a turn
   rarely exceeds that; make it a module constant `LIVE_SESSION_MTIME_MS`), treat the session as
   **live**: skip it with `log.info` and *no* Notice. This covers the double-runner window without a
   lockfile: the only writer that keeps mtime fresh is a live runner. Sessions with `status:
   "interrupted"` (pause) are *not* subject to the check — they are legitimately idle. Rationale for
   mtime over a heartbeat file: zero new writes, works retroactively on existing sessions, and F4 is
   already reducing write surfaces; a lockfile adds a stale-lock cleanup problem.
   - Edge: `adapter.stat` may return `null` (adapter differences) — treat `null` as not-live.
2. **Make resume offered.** Replace the auto-resume at `launch.ts:1171–1185` with a Notice carrying a
   **Resume button** (Obsidian `Notice` accepts a DocumentFragment; a `ButtonComponent` is already
   imported in launch.ts). On click → `resumeRecoveredSession(...)`. Keep the existing fire-and-forget
   `.catch` handling. Update the docstring at `launch.ts:1116–1118` to match. If product prefers
   auto-resume, the alternative is to fix the comment instead — but offered-resume is recommended
   because combined with Fix 1 the user may have deliberately stopped Obsidian mid-run.
3. **Bug A — recover scheduled runs:** add `"schedule"` to `KNOWN_ORIGINS` (`session-recovery.ts:141`)
   and a `case "schedule":` to `isRecoverableRoot` (`session-recovery.ts:382–400`) returning the same
   policy as `"hook"` (root, resumable). Add a scan test in `session-recovery.test.ts` (fixtures/fakes
   already there: `FakeRecoveryFs` at :305–321).

### 3.3 Fix 3 — Deterministic child ledger (M) **← the data-integrity core of F1**

Implement the occurrence-order matching the doc comment already promises.

1. **Inject the fs seam.** Change `reconcileChildLedger` and `resolveChildEntryConversationId`
   (`launch.ts:1017–1043`) to read the parent log through a minimal injected reader (reuse the existing
   `RecoveryFs` shape — `exists`/`read` — or accept a `SessionFs`). `makeChildFlowSpawner` builds the
   vault-backed adapter in production. This is a prerequisite for the replay test and aligns with the
   F6 split (child-spawn.ts becomes pure).
2. **Enrich the entries.** `ChildSpawnedEntry`: populate `turn` with the real turn number and `step`
   with the real **step name**; add `flow_name: string` (callee) and `ordinal: number` (Nth `run_flow`
   dispatch for this (step, flow) within the step's execution). Threading: add `stepName` (and the
   turn) to `SpawnChildFlowRequest` (`child-flow.ts:30–45`) — the executor knows `req.step.name`; pass
   it into `OrchestrationToolContext` alongside the existing `scratchpadPath` fields
   (`run-loop/types.ts:136–208`) so `run-flow.ts` can copy it into the spawn request. Keep
   `via_tool_call_id` in the entry for observability, but stop matching on it. Old logs without the new
   fields: matcher treats them as non-matching (safe: worst case is today's behavior). This is a
   persisted-format change — land **after or with** F4's `schema_version` stamping of the session log.
3. **Ordinal computation.** In the spawner (per step execution), count prior `run_flow` dispatches for
   the same (stepName, flowName) in-memory — a counter on the per-step `OrchestrationToolContext` is
   simplest (v1 runs `run_flow` serially within a step, per the existing comment, so a plain increment
   is correct).
4. **New matcher** in `reconcileChildLedger`: find the Nth `child.spawned` with matching
   `(step === stepName, flow_name === flowName, ordinal === n)`. On hit:
   - matching `child.result` exists → **reuse** (existing branch at `launch.ts:941–954` becomes live);
   - spawned but no result → **resume the child** via `resumeChildSession` (existing branch
     `launch.ts:956–993` becomes live). Note `resumeChildSession` inherits the parent's cascade
     (`launch.ts:1277–1289`) — verify budget cell identity is preserved (it is passed by reference).
   - no hit → fresh spawn (today's only behavior).
5. **Fix the doc comment** at `launch.ts:794–798` to describe the now-real mechanism.
6. **Replay test** (the load-bearing deliverable), new `src/orchestration/child-spawn.test.ts` (or into
   the F6 module if that lands first): over a fake fs seeded with a parent log containing
   `child.spawned` (+ optionally `child.result`), call the spawner with a *fresh random*
   `viaToolCallId` but same (stepName, flowName, ordinal), assert **no second child session is
   created** and the recorded result/resume path is taken. Fakes to reuse: `FakeRecoveryFs`
   (`session-recovery.test.ts:305–321`), `FakeSessionFs` (`session-manager.test.ts:16–33`), jsonl
   builder helpers (`session-recovery.test.ts:25–55`).

### 3.4 Fix 4 — Single-instance guard + honest thrashing story (S)

1. **Per-flow single-instance:** in `launchOrchestration`, before creating the session, check
   `registry.isFlowRunning(flow.name)` (Fix 1). Default policy: **skip with Notice** (mirroring
   `isWorkflowRunning` consumption at `vault-event-dispatcher.ts:244`), message naming the flow and the
   running sessionId. Add optional frontmatter `notor-flow-allow-concurrent: true` (parsed in
   `flow-parser.ts` next to the other flow-level keys) to opt out per flow. Apply the guard to all
   origins except `run_flow` children and `chaining` (a flow chaining to itself is legal recursion
   bounded by depth/budget; children are depth-gated already).
2. **Thrashing guard — recommend delete, not wire.** FEAT-008's live half was never built:
   `evaluate` (`safety.ts:99–140`) never receives a `taskKey` from the runner (`runner.ts:446–453`),
   and no live code increments `abandonCounts` (`runner.ts:182` written only at resume,
   `runner.ts:282–284`). Wiring it for real means instrumenting task-registry mutations
   (`task-registry.ts`) with abandon detection — a feature, not a fix. **Delete** `taskKey`/
   `abandonCounts` from `evaluate`'s params, the `isThrashing` helper, the runner's `abandonCounts`
   field and its resume rehydration, and `rehydrateSafetyState`'s abandon-count half
   (`session-recovery.ts:226–245`), updating `safety.test.ts` / `session-recovery.test.ts`
   accordingly, and leave a `// FEAT-008 thrashing guard removed as dead code — see F1 spec` marker.
   If product wants it later, spec it as a feature with real abandon instrumentation. (If the team
   prefers keep-and-wire, the minimal wiring is: runner passes the active step's task key when the
   step's prompt carries one, and task registry `ensure→close` transitions without completion increment
   the counter — but do not leave the current pretend-guard in place.)
3. **Bug B (chaining await):** recommend **fix the docs, keep the await** for now — making it truly
   fire-and-forget changes `run_flow` parent semantics (parents currently see the whole chain's
   result) and risks orphaning the successor from the abort cascade; note it as a candidate follow-up
   once Fix 1's registry gives detached chains an owner. Update the docstring at `launch.ts:702–703`.

---

## 4. Test plan (all new; the area currently has zero launch-layer tests)

| Test | File | Asserts |
|---|---|---|
| Registry unit | `run-registry.test.ts` | register/unregister/abort/abortAll/isFlowRunning/touch semantics |
| Replay no-respawn | `child-spawn.test.ts` (needs §3.3.1 seam) | fresh `viaToolCallId`, same (step, flow, ordinal) → no new session; result reused / child resumed |
| Ledger ordinal | same | two `run_flow` calls to the same flow in one step match 1st→1st, 2nd→2nd |
| Liveness skip | extend `session-recovery.test.ts` + a small launch-side test over a stat-able fake | fresh mtime → skipped; stale mtime → offered |
| Schedule origin | `session-recovery.test.ts` | `origin: "schedule"` classifies as recoverable root, no loud error |
| Single-instance | launch-side test (or registry-level) | second launch of a running flow is refused; `allow-concurrent` opts out; `run_flow`/`chaining` exempt |
| Unload abort | manual/e2e | disable plugin mid-run → runner stops, session finalized `cancelled` (or left `active` + liveness-guarded) |

E2e (optional, after unit coverage): extend one existing `e2e/scripts/orchestration-*-test.ts` to click
Stop mid-run and assert `session.json` → `cancelled`.

## 5. Verification

- `tsc` + full vitest suite green (1,496 tests baseline).
- Manual: launch a long flow → Stop button appears in the activity dropdown and works; disable plugin
  mid-run → re-enable → no duplicate runner (liveness skip logged), Resume offered once truly idle.
- Grep gate: `grep -n 'new AbortController' src/orchestration/launch.ts` — every hit must flow into the
  registry or a parent cascade.

## 6. Risk & sequencing notes

- **Fix 3 changes a persisted format** (`child.spawned` shape). Coordinate with F4: land F4's
  `schema_version` stamp on the session log first (or in the same release) so the enriched entries ride
  a versioned format. Old-log tolerance is required either way (matcher misses → fresh spawn = current
  behavior, no regression).
- **Fix 1's bounded unload await** must not hang `onunload` — Obsidian gives limited teardown time.
  Keep the timeout small and best-effort; correctness is guaranteed by Fix 2's liveness guard, not by
  the await completing.
- **Fix 2 threshold:** if users run flows against very slow models (>90 s/turn), the liveness guard
  could mistake a live run for stale *only* in the reverse direction (stale seen as live is impossible;
  live seen as stale is the risk). A missed detection re-creates today's double-runner, so prefer a
  generous threshold (90–120 s) — the cost of a false "live" is merely a delayed resume offer on next
  layout-ready or restart.
- Fix 4's guard intentionally does **not** persist across restarts (in-memory registry) — after a crash
  the liveness guard (Fix 2) is the protection, and recovery itself is the resume path.
