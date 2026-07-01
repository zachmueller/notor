# F3 — Stream errors must not masquerade as step success (HIGH)

**Status:** Ready to implement
**Source review:** `private/architecture-review-2026-07-01.md` §F3 (git-ignored)
**Code verified against:** HEAD `c0d21e9`, re-verified by direct read on 2026-07-01/02.
**Effort:** S–M (~1 day core + ~1 day accounting fixes and tests)
**Priority within slice 1:** **first** — smallest CRITICAL/HIGH-adjacent correctness fix; F1's replay
test and F2's RunLoop threading both touch neighboring code, so landing this first avoids rebase churn.

> **Path correction vs. review text:** RunLoop lives at **`src/run-loop/run-loop.ts`** (types in
> `src/run-loop/types.ts`, budget in `src/run-loop/budget.ts`), not `src/chat/run-loop.ts`. The
> review's line numbers match the real file. Re-locate by symbol at implementation time.

---

## 1. Problem statement

`RunLoop` maps provider stream `error` and `cancelled` events to `stopReason: "completed"`
(`run-loop.ts:239–261`; also the pre-turn abort check at :143–153):

```ts
if (streamResult.type === "error") {
    log.warn("Run stream error", { error: streamResult.error });
    return { text: `[Sub-agent error: ${streamResult.error}]`, structured: null, messages,
             tokenUsage, iterationCount, stopReason: "completed" };
}
```

`StepTurnExecutor.resolveEmission` (`step-turn-executor.ts:413–436`) branches only on `stopReason`:
`"completed"` with no captured emission → synthesize the step's `default_publishes` with an **empty
payload** (:421–424). `result.text` is never read by the executor, and no assistant message is appended
to `messages` on the error path — the error string is discarded entirely.

**Verified end-to-end consequence:** a throttled Bedrock call (`bedrock-provider.ts:705–712` yields
`{type:"error", error:"Bedrock rate limited"}`) makes the step "succeed"; the flow routes onward on
`default_publishes`; the next step's prompt renders `### INCOMING EVENT` with an **empty payload line**
(`step-prompt-builder.ts:98–102`); `turn.complete` records the successful-looking topic; the progress
Notice announces it (`step-turn-executor.ts:356–362`). The only trace is a console `warn`. This directly
violates the module's own FR-117a contract ("a cut-off turn never masquerades as success",
`step-turn-executor.ts:17–21` and :405–412).

For sub-agents the error text at least reaches the parent LLM inside `result` — but with
`success: true` unconditionally (`use-subagent.ts:476–492`) and `stop_reason: "completed"` persisted,
so the peek card renders "completed" (`message-renderer.ts:581–584`).

**Two accounting gaps to fix in the same pass (verified):**

1. **Wind-down turn is unaccounted.** `finishWithWindDown` (`run-loop.ts:395–469`) runs one extra LLM
   call (:433–438) and accumulates its tokens, but contains no `decrementAggregate` (only decrement in
   the file is the main-loop one at :225) and never fires `onTurnComplete` (only :274 and :311). So the
   shared budget cell is never drawn down for the wind-down call, and the executor's `perTurnCost`
   accumulator (fed exclusively by `onTurnComplete`, `step-turn-executor.ts:288–295`) omits its cost —
   `turn.complete.cost_usd` under-reports precisely on capped runs. Inverse skew also exists: the
   main-loop decrement at :224–230 runs *before* the error/cancelled check, so an errored turn draws
   down the budget but never reaches `onTurnComplete` — cost visible in the cell, invisible in the log.
2. **Recovered roots resume with inflated headroom.** `ChildResultEntry` carries no cost fields
   (`session-log.ts:99–106`), and recovery's `rebuildBudget` replays only `turn.complete` entries
   (`session-recovery.ts:206–216`). A root whose live run spent budget via child flows (shared cell,
   decremented by the child's own turns in the *child's* log) rebuilds its budget from its own log only
   — child spend vanishes. Related: the ledger reuse path returns a zeroed rollup
   (`launch.ts:941–953`).

## 2. Current-state reference (verified)

- `RunStopReason` (`run-loop/types.ts:238–244`):
  `"completed" | "iteration_cap" | "token_limit" | "context_window" | "cost_cap" | "depth_cap"`.
  `RunResult` (:255–268) has no error field.
- Stream wire: `ParsedStreamEvent` includes `{ type: "error"; message: string }` and
  `{ type: "cancelled"; text: string }` (`stream-utils.ts:21–32`). Yielded-error sources:
  bedrock-provider.ts:562–571, 687–694, 696–703, 705–712, 714–720; anthropic-provider.ts:492–498; and
  the parser itself synthesizes `error` for truncated tool-call JSON (`stream-utils.ts:226–234,
  285–288`). openai/local providers **throw** `ProviderError` instead (that path already propagates:
  RunLoop has no catch → `runner.start` → caught at `launch.ts:622–631`, session `interrupted`).
  Classification (`ProviderErrorCode`) exists only on thrown errors; yielded chunks carry a message
  string only.
- Failure channels: `{step}.capped` emitted only at `step-turn-executor.ts:432–435` with payload
  `JSON.stringify({ stopReason, step: step.name })`; `{step}.no_emit` (:426–429, :508–511,
  `code-step-executor.ts:256–259`); `{step}.code_error` (`code-step-executor.ts:268–280`, payload
  `{ step, error, stack }`). Recognition lists that must stay in sync (**three places**):
  `fallback-coordinator.ts:31–35` (`FAILURE_CHANNEL_SUFFIXES`), `flow-parser.ts:99–103` (validator
  exemption), `failure-report.ts:233–241` (`isTerminalLike`) + `findCodeError` (:196–214). Persona docs
  mention `.code_error` at `builtin-personas.ts:423,427`.
- Consumer blast radius for new stop reasons (complete, verified):
  - `sub-agent-runner.ts:45–49` `SubAgentStopReason` (narrower union) + narrowing cast at :168 with a
    comment whose soundness argument breaks once `error`/`cancelled` are reachable → **must widen**.
  - `use-subagent.ts:426, 462, 488` — string pass-throughs; `success: true` unconditional at :478.
  - `step-turn-executor.ts:330, 364` — the branch point; `StepTurnResult.stopReason` is `string`.
  - `code-step-executor.ts:157` already produces `stopReason: "error"` at the StepTurnResult level (so
    the *name* `"error"` is precedented downstream).
  - `runner.ts` never reads `stopReason` (only cost/usage/emission) — no change.
  - `message-renderer.ts:581–584` renders any non-`completed` reason as a `stopped: {reason}` chip —
    new values render automatically.
  - Tests asserting `"completed"` on error/abort: `sub-agent-runner.test.ts:334` (provider stream error
    → must flip), :392, :425 (abort paths); mocks returning `stopReason: "completed"`:
    `step-turn-executor.reconcile.test.ts:40`, `composition.test.ts:123,246`, `use-subagent.test.ts:79`.

## 3. Change

### 3.1 Honest stop reasons + error field (core)

1. `run-loop/types.ts`: extend the union and result:
   ```ts
   export type RunStopReason =
       | "completed" | "iteration_cap" | "token_limit" | "context_window"
       | "cost_cap" | "depth_cap" | "error" | "cancelled";

   export interface RunResult {
       // ...existing fields...
       /** Populated when stopReason === "error": the raw provider/parser error message. */
       errorMessage?: string;
   }
   ```
   Both the union members **and** the field: the members make every downstream `!== "completed"` branch
   correct with zero routing changes; the field preserves the raw message without string-scraping
   `text` (which today wraps it as `[Sub-agent error: …]`).
2. `run-loop.ts` return sites: :247 → `stopReason: "error", errorMessage: streamResult.error`;
   :259 → `stopReason: "cancelled"`; pre-turn abort :151 → `stopReason: "cancelled"`. Keep the existing
   `text` shapes (parents already rely on them).
3. `SubAgentRunner` (`sub-agent-runner.ts`): widen `SubAgentStopReason` with `"error" | "cancelled"`,
   delete the narrowing-cast comment/cast (:162–168) or update its justification.
4. `use-subagent.ts:478`: `success: result.stopReason !== "error"` — matching `run_flow`'s convention
   (`run-flow.ts:203–207`). Persisted `stop_reason` strings flow automatically.

### 3.2 Route to a first-class failure channel in orchestration

In `resolveEmission` (`step-turn-executor.ts:413–436`), before the `.capped` fallthrough:

```ts
if (stopReason === "error" || stopReason === "cancelled") {
    return {
        topic: `${step.name}.stream_error`,
        payload: JSON.stringify({ step: step.name, stopReason,
                                  error: errorMessage ?? null, stack: null }),
    };
}
```

- Payload mirrors `.code_error`'s `{ step, error, stack }` shape so `failure-report.ts:findCodeError`
  picks it up with a one-suffix extension.
- Thread `result.errorMessage` into the call (`step-turn-executor.ts:330` currently passes only
  `result.stopReason` — pass the result or add a param).
- Add `".stream_error"` to all three suffix lists: `fallback-coordinator.ts:31`
  (`FAILURE_CHANNEL_SUFFIXES`), `flow-parser.ts:99` (validator exemption so flows may explicitly
  subscribe to it), `failure-report.ts` (`isTerminalLike` :233–241 and `findCodeError` :196–214).
  Update the orchestration-creator persona docs (`builtin-personas.ts:423,427`) to list the fourth
  channel.
- **Design note — why not reuse `.capped`:** `.capped` semantically means "budget/limit cut-off," and
  flow authors may legitimately route `.capped` to a summarize-what-you-have step; a provider outage is
  a different failure mode they may want to retry instead. Distinct topic, same recognition machinery.
- With no explicit subscriber, the existing fallback path takes over: `FLOW_ERROR` naming the step and
  channel (`fallback-coordinator.ts:57–69`) → session `error` → failure report + Notice
  (`launch.ts:635–652, 246–273`). No new surfacing code needed.
- `cancelled` nuance: mapping mid-stream cancellation into `.stream_error` (rather than `"completed"` +
  spurious `default_publishes`) also closes the gap where a user Stop publishes a bogus success event
  before the runner's abort check (`runner.ts:386–388`) catches it next queue iteration. The
  `FLOW_CANCELLED` path still wins for between-turn aborts.

### 3.3 Accounting fixes (same pass)

1. **Wind-down:** in `finishWithWindDown` (`run-loop.ts:395–469`), after computing the wind-down turn's
   cost: `decrementAggregate(runContext.budget, windDownCostUsd, 1)` and fire
   `hooks.onTurnComplete(turn, outcome)` (build via the existing `buildTurnOutcome`, :487–494). This
   makes the shared cell and `turn.complete.cost_usd` agree on capped runs.
2. **Errored turn cost:** at the :224–230 decrement site, the turn's cost is already in the cell; make
   the error/cancelled return path fire `onTurnComplete` too (or move the decrement after the check and
   decrement inside each branch) so log and cell stay consistent. Prefer firing the hook — the cost was
   real and should be logged.
3. **Child cost visibility:** add optional cost fields to `ChildResultEntry` (`session-log.ts:99–106`):
   ```ts
   cost_usd?: number;
   iterations?: number;
   ```
   Write them at `launch.ts:856–864` from `result.rollup` (`SpawnChildFlowResult.rollup` already
   carries `{ costUsd, iterations, … }`, `child-flow.ts:48–68`). Extend `rebuildBudget`
   (`session-recovery.ts:206–216`) to also subtract `child.result` costs/iterations. Readers default
   missing fields to 0 (old logs keep today's behavior — inflated headroom on recovery — acceptable
   for pre-existing sessions). Coordinate with F4's `schema_version` stamping of the session log and
   F1's `ChildSpawnedEntry` enrichment — ideally one combined entry-shape change per release.

## 4. Test plan

| Test | File | Asserts |
|---|---|---|
| RunLoop error mapping | `run-loop.test.ts` (seam: `mockProvider(...)` at :25–40) | stream `{type:"error"}` → `stopReason:"error"`, `errorMessage` set; abort → `"cancelled"`; budget decremented; `onTurnComplete` fired |
| Wind-down accounting | `run-loop.test.ts` | capped run: cell decremented for the wind-down call; `onTurnComplete` fired for it |
| **Emission matrix** | `step-turn-executor.reconcile.test.ts` (or new `step-turn-executor.emission.test.ts`) — parametrize the module mock at :31–44 to return configurable results | captured `pendingEmission` wins; `completed`+default → default topic; `completed`+no default → `.no_emit`; each cap → `.capped` with stopReason payload; `error`/`cancelled` → `.stream_error` with error payload. (The existing mock always returning success is exactly why this bug shipped — the matrix is the regression gate.) |
| Fallback recognition | `fallback-coordinator.test.ts` (pattern at :53–63) | unsubscribed `.stream_error` → diagnosable FLOW_ERROR |
| Validator exemption | `flow-parser.test.ts` (pattern at :270–273) | a step subscribing to `x.stream_error` passes validation |
| Sub-agent surface | `sub-agent-runner.test.ts` | flip :334 (error → `"error"`), :392/:425 (abort → `"cancelled"`); `use-subagent` returns `success: false` on error |
| Budget rebuild with child costs | `session-recovery.test.ts` | log with `child.result{cost_usd, iterations}` → rebuilt budget subtracts them; legacy entry without fields → unchanged |

## 5. Verification

- `tsc` + suite green; the flipped assertions reviewed one-by-one (each represents an intentional
  behavior change).
- Manual: force a Bedrock throttle (or stub) mid-flow → flow terminates with FLOW_ERROR naming
  `{step}.stream_error`, failure report written, Notice shown — instead of silently advancing.
- Grep gate: `grep -rn '"completed"' src/run-loop/run-loop.ts` — no error/cancel path returns it.

## 6. Risks

- **Behavior change for sub-agents:** parents that pattern-matched on `success: true` + error text now
  get `success: false`. This matches `run_flow` semantics and is the honest signal; note in changelog.
- New union members flow into persisted headers (`stop_reason`) — strings, readers pass through;
  no version bump needed (peek card renders them generically).
- Flows in the wild have no `.stream_error` subscribers → all stream errors become FLOW_ERROR terminal.
  That is the intended default (fail loud); authors can now add retry/fallback steps explicitly.
