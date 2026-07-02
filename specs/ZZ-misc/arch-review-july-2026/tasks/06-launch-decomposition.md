# Task 06 — Decompose `launch.ts`, define `OrchestrationHost`, test the integration layer

**Spec:** [../F6-launch-ts-decomposition.md](../F6-launch-ts-decomposition.md)
**Depends on:** Tasks 02, 03, 04 merged — **hard prerequisite by design**: the split moves the
exact lines those tasks edit; splitting first would force them to rebase across five new files.
Task 05 should also be merged (no file overlap, but keeps the end state stable).
**Blocks:** nothing — last in the package.

Note: all line numbers below are from `c0d21e9` and **will have drifted substantially** by the
time Tasks 02–04 land in this file. They locate symbols, not lines. Re-derive the move manifest
from the file as it exists then; the symbol list is the contract.

---

## Phase 1 — Mechanical file split + barrel (commit 1, zero logic changes)

Keep `launch.ts` as a **thin barrel** re-exporting the five public symbols (`VaultSessionFs`,
`launchOrchestration`, `makeChildFlowSpawner`, `recoverOrchestrations`,
`showOrchestrationPicker`) so the five importers stay untouched: `main.ts:89` (static),
`main.ts:740/1032/1135` and `commands/index.ts:332` (dynamic — the barrel preserves lazy
loading). Named exports must be preserved exactly (dynamic importers destructure).

- [x] Move by symbol:
      | New module | Symbols |
      |---|---|
      | `src/orchestration/launch-wiring.ts` | `buildExecutor`, `makeRuntimeFactory`, `makeCodeStepRuntimeFactory`, `buildToolDefinitions`, `VaultSessionLogWriter`, `VaultSessionFs`, `listOpenTaskKeys` |
      | `src/orchestration/run-lifecycle.ts` | `newSessionId`, `launchOrchestration`, `maybeWriteFailureReport`, `resolveSuccessorInputs`, `chainToSuccessor` |
      | `src/orchestration/child-spawn.ts` | `makeChildFlowSpawner`, `reconcileChildLedger`, `childErrorResult`, `resolveChildEntryConversationId`, **plus `resumeChildSession`** (one-line wrapper — moving it here instead of recovery-boot breaks the recovery↔child cycle) |
      | `src/orchestration/recovery-boot.ts` | `makeRecoveryFs`, `recoverOrchestrations`, `resumeRecoveredSession` |
      | `src/ui/orchestration-modals.ts` | `FlowPickerModal`, `ObjectiveModal`, `UserInputModal`, `requestOrchestrationInput`, `showOrchestrationPicker`, `jumpToStepConversation` |
      Task 03's `run-registry.ts` already exists as its own module; leave it.
- [x] Cross-edges to plan for, not fight: run-lifecycle's `launchOrchestration` ↔
      `chainToSuccessor` recursion; child-spawn → run-lifecycle (`launchOrchestration`) and →
      recovery-boot (`resumeRecoveredSession`, via the moved `resumeChildSession`).
- [x] `requestOrchestrationInput`: inject as the runner's `requestUserInput` callback from the
      composition site (both launch and resume wiring) rather than importing ui from lifecycle
      modules — keeps the ui→logic direction clean.
- [x] Both finalize sites (launch + resume) must keep calling `maybeWriteFailureReport` and
      resolving `openNotes = flow.openNotesInEditor ?? settings.orchestration_open_notes_in_editor`
      identically — extract a tiny shared `finalizeRun` helper in run-lifecycle so the
      invariant is structural; recovery-boot imports it.
- [x] Shared-by-reference run state must keep flowing as the same instances across the new
      boundaries: the `committedKeys: Set<string>` and the `AggregateBudget` cell in
      `inheritedContext`. Pass as parameters exactly as today; no module-level stashing.
      (Module-level state today: only the logger — the split is state-safe.)
- [x] Suite green on pure moves before proceeding.

## Phase 2 — `OrchestrationHost` + refactors (commit 2)

- [x] **2.1** New `src/orchestration/host.ts`:
      ```ts
      export interface OrchestrationHost {
          readonly app: App;
          readonly settings: NotorSettings;
          readonly vaultRootPath: string | null;
          getToolRegistry(): ToolRegistry;
          getSystemPromptBuilder(): SystemPromptBuilder;
          getProviderRegistry(): ProviderRegistry;
          getPersonaManager(): PersonaManager;
          upsertFlowRun(entry: FlowRunEntry): void;   // no longer optional — main.ts:385 is concrete
          openChatPanel(): Promise<...>;              // match main.ts signature
          getActiveOrchestrator(): ChatOrchestrator | null;
          buildExtensionUtils(): ExtensionUtils;      // wraps buildUtils(this) — the one plugin-shaped member
          getOrchestrationRunRegistry(): OrchestrationRunRegistry;  // added by Task 03
      }
      ```
- [x] **2.2** `NotorPlugin implements OrchestrationHost` (everything already exists; the clause
      makes the compiler enforce drift). All five new modules take `host: OrchestrationHost`;
      the type-only `import type NotorPlugin` disappears from all of them. Drop the `?.` on
      `upsertFlowRun` (dead defensive code standing in for a testable dependency).
- [x] **2.3** `buildUtils(plugin, …)` is the one hard case — wrap as
      `host.buildExtensionUtils()` implemented on the plugin as `buildUtils(this)`. Narrowing
      `buildUtils` itself is F5/worker-isolation territory — out of scope.
- [x] **2.4** Dedupe the dispatcher assembly: the two runtime factories duplicate it
      byte-for-byte except persona handling — extract
      `assembleStepDispatcher(host, { persona })` in launch-wiring.ts (~30 duplicated lines
      deleted). Note Task 04 will have edited both copies to build policyCtx; dedupe the
      post-Task-04 shape.
- [x] **2.5** Single owner for step-conversation header surgery: move `backfillParentEdge` into
      `VaultStepConversationStore` (alongside `backfillNextEdge`, same fs seam, same
      idempotent-edge idiom); child-spawn calls the store instead of raw adapter I/O.
      (`toggleFavorite` is chat-side, stays; Task 01 already made all three atomic.)
- [x] **2.6** Ledger fs injection (`reconcileChildLedger`/`resolveChildEntryConversationId` take
      a `RecoveryFs`-shaped reader) — **done by Task 03 Phase 3.1** (verified: `ChildLedgerFs`
      already injected). This task additionally routed the production reader through the
      `VaultSessionFs` seam (was raw `vault.adapter`) so the child-spawn `vault.adapter` grep gate → 0.
- [x] **2.7** Fix or delete the stale `reference-flows.ts:1–15` comment claiming the reference
      flows are e2e fixtures (no e2e uses them; all 10 scripts write bespoke inline fixtures).
      Rewrite to claim only what's true, or point TEST-007/008 at the Phase 3 parse gate —
      record the decision in the comment. **Done:** header rewritten to point at the unit-level
      flow-parse gate and record the live-provider-e2e decision as out of scope; also dropped the
      stale "This is the TEST-008 fixture" line from the materialized `review` definition body.
- [x] Do **not** fold in F13's `discoverFlows()` caching; keep this PR mechanical. (Not folded in.)

## Phase 3 — Tests (commits 3+, one file per commit)

Fakes ready for reuse: `FakeSessionFs` (`session-manager.test.ts:16–33`), `FakeRecoveryFs`
(`session-recovery.test.ts:305–321`), jsonl builders (`session-recovery.test.ts:25–55`),
`mockProvider` (`run-loop.test.ts:25–40`), canned-executor runner harness
(`runner.test.ts:~95–140`).

- [ ] **3.1** `child-spawn.test.ts` — ledger replay + ordinal matching: **written by Task 03**;
      extend if gaps remain after the move.
- [ ] **3.2** Emission matrix — **written by Task 02** at the step-turn-executor level; do not
      duplicate.
- [x] **3.3** `run-lifecycle.test.ts` — the chaining gate (`chainToSuccessor`; frontmatter key
      `notor-on-complete-flow` → `flow.onCompleteFlow`, `flow-parser.ts:427–428`; gate logic:
      `depth + 1 >= maxDepth || iterationsRemaining <= 0 || costRemainingUsd <= 0`). Asserts:
      chains only on `status === "completed"`; blocked handoff → Notice + **no successor launch
      and no status change**; budget cell passed to the successor **by reference**;
      `parentScratchpadPath` only when `handoffIsolation === "shared"`.
      **Decision locked: fixed the DOCSTRING to match the code** — a blocked handoff Notices and
      stops the chain, leaving the completed predecessor's status untouched (the code never
      mutated status to `error`; the old "FLOW_ERROR on block" docstring was the drift). Made
      `chainToSuccessor` exported + injectable (`resolveSuccessor`/`launch` seams) so the gate is
      unit-testable without a vault or runner. Added minimal `Modal`/`FuzzySuggestModal`/
      `ButtonComponent` stubs to `src/__mocks__/obsidian.ts` (the ui module is pulled in
      transitively through launch-wiring).
- [x] **3.4** `recovery-boot.test.ts` — over `FakeRecoveryFs` + a stubbed host: recoverable
      root → resume invoked with rebuilt budget/committedKeys; error sessions marked; liveness
      skip and offered-resume paths (from Task 03). Added behavior-preserving `RecoverDeps`
      seams (`recoveryFs`/`resolveFlows`/`isLive`/`offerResume`) to `recoverOrchestrations` so
      the scan's branch logic is testable without a runner or the DOM; the error-marking test
      exercises the real `updateStatus` path over an in-memory vault adapter.
- [ ] **3.5** Reference-flow parse gate (cheap version): extend `reference-flows.test.ts` to
      assert each `materializeReferenceFlows` output parses through `FlowDefinitionParser` with
      zero errors/warnings. A live-provider e2e for one reference flow is a separate
      team decision (the e2e harness has no provider stub; all 10 scripts hit live Bedrock) —
      record it in the reference-flows comment either way.

## Phase 4 — Optional follow-up

- [ ] Dynamize the `makeChildFlowSpawner` static import (`main.ts:89`) to restore full lazy
      loading of the orchestration layer.

## Verification

- [ ] `tsc` + full suite after **each** commit; the 10 orchestration e2e scripts as the
      integration backstop.
- [ ] Grep gates: `grep -c "plugin\." src/orchestration/launch*.ts
      src/orchestration/run-lifecycle.ts src/orchestration/child-spawn.ts
      src/orchestration/recovery-boot.ts` → 0 (all via `host.`);
      `grep -rn "upsertFlowRun?." src/` → 0;
      `grep -rn "vault.adapter" src/orchestration/child-spawn.ts` → 0.
- [ ] `wc -l` sanity: no new module > ~500 lines; barrel < 20.
- [ ] Pause/resume e2e (`orchestration-terminal-paths-test.ts` covers interactive pause) still
      passes — the `requestOrchestrationInput` injection touches the runner-deps wiring in two
      places.
