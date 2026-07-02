# Task 02 — Stream errors must not masquerade as step success

**Spec:** [../F3-stream-error-masquerades-as-success.md](../F3-stream-error-masquerades-as-success.md)
**Depends on:** Task 01 Phase A.4 (session-log `schema_version`) — required only by Phase 3.3
here (`ChildResultEntry` cost fields). Phases 1–2 have no dependency and could start in parallel
with Task 01 if needed.
**Blocks:** Task 03 (its replay/liveness tests assume honest `error`/`cancelled` stop reasons).

Path note: RunLoop is `src/run-loop/run-loop.ts` (types in `src/run-loop/types.ts`, budget in
`src/run-loop/budget.ts`) — not `src/chat/`.

---

## Phase 1 — Honest stop reasons + error field (commit 1)

- [ ] **1.1** `run-loop/types.ts`: extend the union (`RunStopReason`, :238–244) with
      `"error" | "cancelled"`; add to `RunResult` (:255–268):
      `errorMessage?: string` — populated when `stopReason === "error"`, carrying the raw
      provider/parser message so nobody string-scrapes the `[Sub-agent error: …]` text wrapper.
- [ ] **1.2** `run-loop.ts` return sites (verified at c0d21e9): stream-error return around :247 →
      `stopReason: "error", errorMessage: streamResult.error`; stream-cancelled return around
      :259 → `stopReason: "cancelled"`; pre-turn abort check around :151 →
      `stopReason: "cancelled"`. Keep the existing `text` shapes — parents rely on them.
- [ ] **1.3** `sub-agent-runner.ts`: widen `SubAgentStopReason` (:45–49) with
      `"error" | "cancelled"`; delete or re-justify the narrowing cast + comment at :162–168
      (its soundness argument breaks once the new members are reachable).
- [ ] **1.4** `use-subagent.ts:478`: `success: result.stopReason !== "error"` (matches
      `run_flow`'s convention, `run-flow.ts:203–207`). Persisted `stop_reason` strings and the
      peek-card chip (`message-renderer.ts:581–584` renders any non-`completed` reason
      generically) flow automatically — no renderer change.

## Phase 2 — `{step}.stream_error` failure channel (commit 2)

- [ ] **2.1** In `resolveEmission` (`step-turn-executor.ts:413–436`), before the `.capped`
      fallthrough:
      ```ts
      if (stopReason === "error" || stopReason === "cancelled") {
          return {
              topic: `${step.name}.stream_error`,
              payload: JSON.stringify({ step: step.name, stopReason,
                                        error: errorMessage ?? null, stack: null }),
          };
      }
      ```
      Payload deliberately mirrors `.code_error`'s `{ step, error, stack }` shape.
- [ ] **2.2** Thread `result.errorMessage` into the call — `step-turn-executor.ts:330` passes
      only `result.stopReason` today; pass the result or add a param.
- [ ] **2.3** Add `".stream_error"` to **all three** recognition lists (they must stay in sync):
      - `fallback-coordinator.ts:31–35` (`FAILURE_CHANNEL_SUFFIXES`)
      - `flow-parser.ts:99–103` (validator exemption so flows may subscribe to it)
      - `failure-report.ts` — `isTerminalLike` (:233–241) and `findCodeError` (:196–214).
- [ ] **2.4** Update the orchestration-creator persona docs (`builtin-personas.ts:423,427`) to
      list the fourth failure channel.
- [ ] **2.5** No new surfacing code: with no explicit subscriber, the existing fallback
      (`fallback-coordinator.ts:57–69` → FLOW_ERROR → session `error` → failure report + Notice,
      `launch.ts:635–652, 246–273`) takes over — that's the intended fail-loud default.
- [ ] Design notes to preserve in code comments / PR: `.capped` is *not* reused because it means
      "budget cut-off" and authors may route it to summarize-what-you-have; a provider outage is
      a retry-shaped failure. The `cancelled` mapping also closes the gap where a user Stop
      published a bogus success event before the runner's between-turn abort check
      (`runner.ts:386–388`) caught it.

## Phase 3 — Accounting fixes (commit 3)

- [ ] **3.1 Wind-down turn accounting.** `finishWithWindDown` (`run-loop.ts:395–469`) runs one
      extra LLM call (:433–438) but never decrements the shared budget cell and never fires
      `onTurnComplete` — so `turn.complete.cost_usd` under-reports on exactly the capped runs.
      After computing the wind-down turn's cost: `decrementAggregate(runContext.budget,
      windDownCostUsd, 1)` and fire `hooks.onTurnComplete` (build via the existing
      `buildTurnOutcome`, :487–494).
- [ ] **3.2 Errored-turn cost.** The main-loop decrement (:224–230) runs *before* the
      error/cancelled check, so an errored turn draws down the cell but never reaches
      `onTurnComplete`. Fire the hook on the error/cancelled return paths too (preferred over
      moving the decrement — the cost was real and should be logged).
- [ ] **3.3 Child cost visibility** *(needs Task 01 A.4 landed)*: add optional
      `cost_usd?: number; iterations?: number` to `ChildResultEntry`
      (`session-log.ts:99–106`); write them at the `appendChildResult` call in
      `makeChildFlowSpawner` (`launch.ts:856–864`) from `result.rollup`
      (`SpawnChildFlowResult.rollup`, `child-flow.ts:48–68`). Extend `rebuildBudget`
      (`session-recovery.ts:206–216`) to also subtract `child.result` costs/iterations. Readers
      default missing fields to 0 — old logs keep today's (inflated-headroom) behavior, which is
      acceptable for pre-existing sessions.

## Phase 4 — Tests (commit 4; the emission matrix is the load-bearing deliverable)

- [ ] RunLoop error mapping (`run-loop.test.ts`, `mockProvider` seam at :25–40): stream
      `{type:"error"}` → `stopReason:"error"` + `errorMessage`; abort → `"cancelled"`; budget
      decremented; `onTurnComplete` fired.
- [ ] Wind-down accounting (`run-loop.test.ts`): capped run → cell decremented for the wind-down
      call, hook fired for it.
- [ ] **Emission matrix** — new `step-turn-executor.emission.test.ts` (or extend
      `step-turn-executor.reconcile.test.ts`; parametrize the module mock at :31–44, whose
      always-success shape is exactly why this bug shipped): captured `pendingEmission` wins;
      `completed`+default → default topic; `completed`+no default → `.no_emit`; each cap →
      `.capped` with stopReason payload; `error`/`cancelled` → `.stream_error` with error
      payload. **Task 06's test plan references this test — it is written once, here.**
- [ ] Fallback recognition (`fallback-coordinator.test.ts`, pattern at :53–63): unsubscribed
      `.stream_error` → diagnosable FLOW_ERROR.
- [ ] Validator exemption (`flow-parser.test.ts`, pattern at :270–273): a step subscribing to
      `x.stream_error` passes validation.
- [ ] Sub-agent surface (`sub-agent-runner.test.ts`): flip :334 (provider stream error →
      `"error"`), :392/:425 (abort → `"cancelled"`); `use-subagent` returns `success: false` on
      error. Each flipped assertion is an intentional behavior change — review one-by-one. Also
      check mocks returning `stopReason: "completed"` still make sense:
      `step-turn-executor.reconcile.test.ts:40`, `composition.test.ts:123,246`,
      `use-subagent.test.ts:79`.
- [ ] Budget rebuild with child costs (`session-recovery.test.ts`): log with
      `child.result{cost_usd, iterations}` → rebuilt budget subtracts them; legacy entry without
      fields → unchanged.

## Verification

- [ ] `tsc` + suite green.
- [ ] Manual: force/stub a Bedrock throttle mid-flow → flow terminates with FLOW_ERROR naming
      `{step}.stream_error`, failure report written, Notice shown — instead of silently
      advancing with an empty-payload `default_publishes`.
- [ ] Grep gate: `grep -rn '"completed"' src/run-loop/run-loop.ts` — no error/cancel path
      returns it.
- [ ] Changelog notes: sub-agent parents now get `success: false` on stream errors; flows without
      `.stream_error` subscribers now fail loud (FLOW_ERROR) instead of advancing silently.
