# Task 03 — Orchestration run lifecycle: registry, Stop UI, recovery liveness, deterministic child ledger

**Spec:** [../F1-orchestration-run-lifecycle.md](../F1-orchestration-run-lifecycle.md)
**Depends on:** Task 01 Phase A.4 (session-log versioned — Phase 3 here enriches
`ChildSpawnedEntry`); Task 02 (honest stop reasons — this task's tests assume them; ideally the
`ChildSpawnedEntry` enrichment here and Task 02's `ChildResultEntry` fields ship in one release
as a single entry-shape change).
**Blocks:** Task 04 (land this first so F2's launch.ts factory edits rebase over a stable file);
Task 06 (the split moves these lines).

Four independently landable phases, in order. Every line number verified at `c0d21e9`; re-locate
by symbol.

---

## Phase 1 — `OrchestrationRunRegistry`: abort path, Stop UI, unload teardown (commit 1)

- [x] **1.1** New file `src/orchestration/run-registry.ts` (pure, no Obsidian imports):
      ```ts
      export interface OrchestrationRunHandle {
          sessionId: string;
          flowName: string;
          controller: AbortController;
          /** Refreshed by the runner's onProgress; used by recovery liveness (Phase 2). */
          lastProgressAt: number;
      }
      export class OrchestrationRunRegistry {
          register(handle): void; unregister(sessionId): void;
          get(sessionId): OrchestrationRunHandle | undefined;
          isFlowRunning(flowName): boolean;   // Phase 4 consumes
          abort(sessionId): boolean;          // Stop button consumes
          abortAll(): AbortController[];      // onunload consumes
          touch(sessionId): void;             // heartbeat refresh
      }
      ```
- [x] **1.2** `NotorPlugin` owns one instance — plain field + getter, mirroring
      `_detachedSubAgents` placement (`main.ts:242–252`). No lazy construction needed.
- [x] **1.3** `launchOrchestration` registers after creating the controller (`launch.ts:569`),
      unregisters in a `finally` around the `runner.start()` await. Wire the runner's
      `onProgress` seam (`runner.ts:155`, fires per step turn :402 and on pause :620; currently
      `log.debug` only at `launch.ts:616, 1244`) to `registry.touch(sessionId)`.
- [x] **1.4** `resumeRecoveredSession`: replace the orphan controller at `launch.ts:1212`
      (`inheritedContext?.abort ?? new AbortController().signal`). Register **root sessions
      only** (when `inheritedContext` is undefined) — children are cancelled transitively via
      `cascade.abort` from the root signal.
- [x] **1.5** `onunload()` (`main.ts:749–851`, next to the `_detachedSubAgents` abort at
      :799–803): `abortAll()`, then a **bounded** await (`Promise.race` with ~1500 ms) of the
      runners' finalize writes. Best-effort by design: abort → `FLOW_CANCELLED` → finalize
      writes `cancelled` (`launch.ts:634–643`) when it completes; when it doesn't, the session
      stays `active` and Phase 2's liveness guard makes the subsequent auto-resume safe. Do not
      hang `onunload`.
- [x] **1.6 Stop UI:** add `onStopFlowRun?: (sessionId: string) => void` to
      `WorkflowActivityDropdown` (constructor-injected like `onOpenRunTree`, threaded via
      `workflow-activity-indicator.ts:130–138` and `chat-view.ts:652`). In `renderFlowRunEntry`
      (`workflow-activity-dropdown.ts:332–347`), for `status === "active"` entries render a stop
      icon-button (`setIcon` + `stopPropagation`, matching the file's hand-built DOM idiom) →
      `plugin.getOrchestrationRunRegistry().abort(sessionId)`. Optional cheap add: a
      `stop-orchestration` command in `src/commands/index.ts` next to `run-orchestration`
      (:326–340).
- [x] **1.7 Bug C (drive-by):** in the finalize upsert (`launch.ts:646–652`), stop overwriting
      `startedAt` with the finalize timestamp — preserve the entry's original value.

## Phase 2 — Recovery liveness guard + honest resume semantics (commit 2)

- [x] **2.1 Liveness check.** In `recoverOrchestrations` (`launch.ts:1120–1187`), before
      resuming a recoverable root with `status: "active"`: stat `ws.logPath` via
      `plugin.app.vault.adapter.stat`. If mtime is fresher than `LIVE_SESSION_MTIME_MS` (module
      constant, **90 s**; the log advances ≥2×/turn via `turn.start`/`turn.complete`,
      `step-turn-executor.ts:234–239, 336–343`), treat as **live**: skip with `log.info`, no
      Notice. `interrupted` (paused) sessions are exempt — legitimately idle. `adapter.stat`
      returning `null` → treat as not-live. Rationale for mtime over lockfile/heartbeat: zero
      new writes, works retroactively, no stale-lock cleanup. Risk note: live-seen-as-stale is
      the dangerous direction (recreates the double-runner) — keep the threshold generous.
- [x] **2.2 Make resume offered.** Replace the auto-resume at `launch.ts:1171–1185` with a
      Notice carrying a **Resume button** (Notice accepts a DocumentFragment; `ButtonComponent`
      is already imported in launch.ts). On click → `resumeRecoveredSession(...)`, keeping the
      fire-and-forget `.catch`. Update the docstring at `launch.ts:1116–1118` ("Resume is
      offered, not forced") to finally match the code.
- [x] **2.3 Bug A — recover scheduled runs:** add `"schedule"` to `KNOWN_ORIGINS`
      (`session-recovery.ts:141`) and a `case "schedule":` to `isRecoverableRoot` (:382–400)
      with the same policy as `"hook"` (root, resumable). Today a crashed scheduled run
      (origin stamped at `main.ts:1137`) surfaces as a loud recovery *error*.

## Phase 3 — Deterministic child ledger (commit 3) ← the data-integrity core

The bug: ledger matching keys on `via_tool_call_id` (`launch.ts:929–932`), minted from a random
UUID per `run_flow` execution (`run-flow.ts:148`) — recovery replay re-issues `run_flow` with a
fresh id, the `find` never hits, and a duplicate child re-executes side effects. The reuse
(:941–954) and resume-in-place (:956–993) branches are unreachable dead code today. The
provider-issued LLM tool-call id is no better (replay = new LLM call = new `tool_use` ids). The
replay-stable key is **occurrence order per (step name, callee flowName)** — exactly what the
doc comment at `launch.ts:794–798` already promises.

- [x] **3.1 Inject the fs seam.** `reconcileChildLedger` (`launch.ts:900–993`) and
      `resolveChildEntryConversationId` (:1017–1043) currently read the parent log via
      `plugin.app.vault.adapter` directly (:911–913). Change both to accept a minimal injected
      reader (reuse the `RecoveryFs` shape — `exists`/`read`). `makeChildFlowSpawner` builds the
      vault-backed adapter in production. Prerequisite for the replay test; aligns with Task
      06's child-spawn module.
- [x] **3.2 Enrich `ChildSpawnedEntry`** (`session-log.ts:91–97`): populate `turn` with the real
      turn number (hardcoded 0 today, `launch.ts:831`) and `step` with the real step name (holds
      the random per-turn conversation UUID today); add `flow_name: string` (callee) and
      `ordinal: number` (Nth `run_flow` dispatch for this (step, flow) within the step's
      execution). Keep `via_tool_call_id` for observability; stop matching on it.
- [x] **3.3 Thread the step identity:** add `stepName` (+ turn) to `SpawnChildFlowRequest`
      (`child-flow.ts:30–45`); the executor knows `req.step.name` — pass it into
      `OrchestrationToolContext` (`run-loop/types.ts:136–208`) alongside the scratchpad fields
      so `run-flow.ts` copies it into the spawn request.
- [x] **3.4 Ordinal computation:** per-step in-memory counter on the per-step
      `OrchestrationToolContext` keyed by (stepName, flowName). v1 runs `run_flow` serially
      within a step (per the existing comment) so a plain increment is correct.
- [x] **3.5 New matcher** in `reconcileChildLedger`: find the Nth `child.spawned` with matching
      `(step === stepName, flow_name === flowName, ordinal === n)`. On hit with a matching
      `child.result` → **reuse** (branch at :941–954 becomes live); spawned without result →
      **resume** via `resumeChildSession` (:956–993 becomes live; it inherits the parent cascade
      at :1277–1289 — verify the budget cell passes by reference). No hit → fresh spawn. Old
      logs lacking the new fields → non-matching → fresh spawn (today's behavior; safe).
- [x] **3.6** Fix the doc comment at `launch.ts:794–798` to describe the now-real mechanism.

## Phase 4 — Single-instance guard + thrashing-guard removal (commit 4)

- [x] **4.1 Per-flow single-instance:** in `launchOrchestration`, before creating the session,
      check `registry.isFlowRunning(flow.name)`. Policy: **skip with Notice** naming the flow
      and running sessionId (mirrors `isWorkflowRunning` consumption,
      `vault-event-dispatcher.ts:244`). Opt-out frontmatter `notor-flow-allow-concurrent: true`
      parsed in `flow-parser.ts` next to the other flow-level keys. Exempt origins: `run_flow`
      children and `chaining` (self-chaining is legal depth/budget-bounded recursion). Guard is
      deliberately in-memory only — after a crash, Phase 2's liveness guard is the protection.
- [x] **4.2 Delete the dead thrashing guard (FEAT-008).** `evaluate` checks thrashing only with
      a `taskKey` (`safety.ts:131`) that the runner's sole call site (`runner.ts:446–453`) never
      supplies; `abandonCounts` is only written during resume rehydration (`runner.ts:282–284`
      ← `session-recovery.ts:226–245`), never live. Delete: `taskKey`/`abandonCounts` params
      from `evaluate`, the `isThrashing` helper, the runner's `abandonCounts` field + resume
      rehydration, and `rehydrateSafetyState`'s abandon-count half. Update `safety.test.ts` /
      `session-recovery.test.ts`. Leave a
      `// FEAT-008 thrashing guard removed as dead code — see F1 spec` marker. (If product
      wants it later, it's a feature needing real task-registry abandon instrumentation.)
- [x] **4.3 Bug B (chaining await):** keep the await, fix the docs. `launch.ts:702–703` claims
      fire-and-forget; the code awaits the full successor chain (:663–667 → :755). Making it
      truly detached changes `run_flow` parent semantics and orphans the successor from the
      abort cascade — note as a follow-up candidate now that the registry could own detached
      chains. Update the docstring.

## Tests (per phase; the area has zero launch-layer tests today)

- [x] Registry unit — new `run-registry.test.ts`: register/unregister/abort/abortAll/
      isFlowRunning/touch (+ `listActive`).
- [x] **Replay no-respawn** — new `child-ledger.test.ts` (uses 3.1's pure matcher extracted to
      `child-ledger.ts`): a `child.spawned` (+ optionally `child.result`) matched with a *fresh
      random* `viaToolCallId` but the same (stepName, flowName, ordinal) → the reuse/resume path is
      taken, **no fresh spawn**. Tested at the matcher layer (rather than driving the full
      plugin-coupled spawner) — see deviation note in the PR/commit.
- [x] Ledger ordinal — `child-ledger.test.ts`: two `run_flow` calls to the same flow in one step
      match 1st→1st, 2nd→2nd; `run-flow.test.ts` asserts the tool assigns per-(step,flow) ordinals.
- [x] Liveness skip — `recovery-liveness.test.ts`: fresh mtime → live (skip); stale/null → not
      live (offer). (Pure predicate extracted to `recovery-liveness.ts`.)
- [x] Schedule origin — `session-recovery.test.ts`: `origin: "schedule"` classifies as
      recoverable root, no loud error.
- [x] Single-instance — registry-level (`run-registry.test.ts` isFlowRunning) + parser opt-out
      (`flow-parser.test.ts` `notor-flow-allow-concurrent`). The launch-side guard wiring
      (skip-with-Notice; `run_flow`/`chaining` exempt) is inline in `launchOrchestration` — covered
      by its component parts, not a full launch-side integration test (no plugin harness exists).
- [ ] Unload abort — manual/e2e only: disable plugin mid-run → runner stops, session `cancelled`
      (or left `active` + liveness-guarded). Not automated this pass.

## Verification

- [x] `tsc` + full suite green. (1,566 tests pass; baseline was 1,546 + 20 new across the phases.)
- [ ] Manual: long flow → Stop button appears in the activity dropdown and works; disable plugin
      mid-run → re-enable → no duplicate runner (liveness skip logged), Resume offered once
      truly idle. **(Human verification — not run in this pass.)**
- [x] Grep gate: `grep -n 'new AbortController' src/orchestration/launch.ts` — two hits, both flow
      into the registry (launch @ ~600 registers root controllers; resume @ ~1401 registers a root
      controller only, children inherit the parent cascade).
