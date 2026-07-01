# F6 — Decompose `launch.ts`, define `OrchestrationHost`, test the integration layer (HIGH)

**Status:** Ready to implement — **after** F1 and F3 land (they change the exact code being moved;
splitting first would force them to rebase across five new files)
**Source review:** `private/architecture-review-2026-07-01.md` §F6 (git-ignored)
**Code verified against:** HEAD `c0d21e9`, re-verified by direct read on 2026-07-02.
**Effort:** M–L (~3–4 days: mechanical split ~1, host interface ~1, tests ~1–2)

> Corrections to the review text, from verification: the `NotorPlugin` import is **type-only**
> (`launch.ts:23`) — coupling is type-level, no runtime cycle; the file is not literally untested —
> **10 live-Bedrock e2e scripts** exercise it (but zero unit tests); it contains **three** modal
> classes plus two UI functions, not four modal classes; the chaining frontmatter key is
> `notor-on-complete-flow` (not `notor-flow-chain`); launch.ts needs **no MCP host member**.

---

## 1. Problem statement

`src/orchestration/launch.ts` is 1,494 lines, 5 exports, ~8 responsibilities (explicit `// ---`
section dividers at :770, :1077, :1291, :1374), 86 `plugin.`-referencing lines, all typed against the
concrete `NotorPlugin`. The orchestration *core* got 22 Obsidian-free test files; this integration
layer got zero unit tests — and it is exactly where the review's two correctness bugs live (F1's
child-ledger bug, F3's error masquerade is only *catchable* here/executor-level). Symptoms verified:

- `plugin.upsertFlowRun?.(...)` at :554, :646, :1173 — optional-chaining a method that is a plain,
  always-present method (`main.ts:385`). Dead defensive code standing in for a testable dependency.
- The two runtime factories duplicate the dispatcher assembly **byte-for-byte** (:289–319 vs
  :414–436) except: code-step factory omits `setActivePersonaName`, passes persona `null` to
  `resolveEffectiveConfig`, and destructures only `{ effective }`.
- `reconcileChildLedger` / `resolveChildEntryConversationId` read the session log via
  `plugin.app.vault.adapter` directly (:911–913, :1030–1033) — untestable without a real vault,
  despite `FakeSessionFs`/`FakeRecoveryFs` sitting ready in sibling tests.
- JSONL header-edge surgery exists in three places with one owner missing: `backfillParentEdge`
  (launch.ts:1045–1076, raw adapter), `backfillNextEdge` (`step-conversation-store.ts:148–172`, via
  its fs seam), `toggleFavorite` (`history.ts:353–376`, chat-side).
- `reference-flows.ts:1–15` claims the three reference flows "double as the fixtures for the e2e
  gates (TEST-007/TEST-008)" — **no e2e uses them**; all 10 `e2e/scripts/orchestration-*-test.ts`
  write bespoke inline fixtures. Stale/aspirational comment.
- Module-level state: none except the logger (:59) — the split is state-safe.

## 2. Target structure

Keep `launch.ts` as a **thin barrel** re-exporting the five public symbols (`VaultSessionFs`,
`launchOrchestration`, `makeChildFlowSpawner`, `recoverOrchestrations`, `showOrchestrationPicker`), so
the five importers stay untouched: `main.ts:89` (static, `makeChildFlowSpawner`), `main.ts:740/1032/1135`
and `commands/index.ts:332` (dynamic imports — the barrel preserves lazy loading; the one static
import at main.ts:89 already defeats laziness today, optional follow-up to dynamize it).

| New module | Moves there (symbol, current lines) |
|---|---|
| `src/orchestration/launch-wiring.ts` | `buildExecutor` (124–185), `makeRuntimeFactory` (281–346), `makeCodeStepRuntimeFactory` (361–466), `buildToolDefinitions` (469–486), `VaultSessionLogWriter` (187–199), `VaultSessionFs` (201–234), `listOpenTaskKeys` (96–115) |
| `src/orchestration/run-lifecycle.ts` | `newSessionId` (62–64), `launchOrchestration` (491–670), `maybeWriteFailureReport` (246–274), `resolveSuccessorInputs` (677–693), `chainToSuccessor` (704–768) |
| `src/orchestration/child-spawn.ts` | `makeChildFlowSpawner` (800–893), `reconcileChildLedger` (900–993), `childErrorResult` (996–1010), `resolveChildEntryConversationId` (1017–1043) |
| `src/orchestration/recovery-boot.ts` | `makeRecoveryFs` (1082–1105), `recoverOrchestrations` (1120–1188), `resumeRecoveredSession` (1195–1269), `resumeChildSession` (1277–1289) |
| `src/ui/orchestration-modals.ts` | `FlowPickerModal` (1295–1325), `ObjectiveModal` (1327–1372), `UserInputModal` (1383–1441), `requestOrchestrationInput` (1447–1456), `showOrchestrationPicker` (1462–1494), `jumpToStepConversation` (75–88) |

Known cross-edges (verified; plan for them, don't fight them):
- run-lifecycle ↔ itself: `launchOrchestration` ↔ `chainToSuccessor` recursion (:662 ↔ :755).
- child-spawn → run-lifecycle (`launchOrchestration` at :842) **and** → recovery-boot
  (`resumeChildSession` at :979). `resumeChildSession` is a one-line wrapper — move it to
  **child-spawn** to break the recovery↔child cycle (recovery-boot then has no inbound edge from
  child-spawn; child-spawn calls `resumeRecoveredSession` directly through it).
- run-lifecycle + recovery-boot → ui (`requestOrchestrationInput` at :611, :1242) — inject it as the
  runner's `requestUserInput` callback from the composition site rather than importing ui from
  lifecycle modules (keeps the ui→logic direction clean; the review's F13 notes the existing
  ui/chat inversion elsewhere — don't add another).
- Both finalize sites (launch :655, resume :1266) must keep calling `maybeWriteFailureReport` and
  resolving `openNotes = flow.openNotesInEditor ?? settings.orchestration_open_notes_in_editor`
  identically (invariant documented at :241–242) — extract a tiny shared `finalizeRun` helper in
  run-lifecycle so the invariant is structural, and recovery-boot imports it.

Shared-by-reference run state that must keep flowing as the same object instances across the new
module boundaries: the `committedKeys: Set<string>` (created :567, seeded :1211, mutated in place by
code-step `once()` effects) and the `AggregateBudget` cell in `inheritedContext` (comments :509–513,
:604–606, :764). Pass them as parameters exactly as today; no module-level stashing.

## 3. `OrchestrationHost` interface

Home: `src/orchestration/host.ts`. Derived from the deduplicated access inventory (verified):

```ts
export interface OrchestrationHost {
    readonly app: App;                                   // vault/metadataCache/workspace + modal ctors
    readonly settings: NotorSettings;                    // notor_dir, mode, history_path, orchestration_* flags
    readonly vaultRootPath: string | null;
    getToolRegistry(): ToolRegistry;
    getSystemPromptBuilder(): SystemPromptBuilder;
    getProviderRegistry(): ProviderRegistry;
    getPersonaManager(): PersonaManager;
    upsertFlowRun(entry: FlowRunEntry): void;            // no longer optional — main.ts:385 is concrete
    openChatPanel(): Promise<...>;                       // match main.ts signature
    getActiveOrchestrator(): ChatOrchestrator | null;
    buildExtensionUtils(): ExtensionUtils;               // wraps buildUtils(plugin) — see note
}
```

- `NotorPlugin implements OrchestrationHost` structurally (add the `implements` clause; everything
  already exists — the compiler enforces drift from then on).
- All five new modules take `host: OrchestrationHost` instead of `plugin: NotorPlugin`; the type-only
  `import type NotorPlugin` disappears from all of them. Drop the `?.` on `upsertFlowRun`.
- **The one hard case:** `buildUtils(plugin: NotorPlugin, …)` (`runtime-context/index.ts:60`) is
  called at launch.ts:441 with the whole plugin. Wrap it as `host.buildExtensionUtils()` (implemented
  on the plugin as `buildUtils(this)`), so the host interface stays plugin-shaped in exactly one
  member instead of leaking the whole type. Narrowing `buildUtils` itself is F5/worker-isolation
  territory — out of scope here.
- If F1 lands first (it should), add its registry accessor (`getOrchestrationRunRegistry()`) to the
  host as well.

Precedent for the deps-interface style: `StepTurnExecutorDeps` / `OrchestrationRunnerDeps` in the
core — this extends the same pattern one layer out.

## 4. Behavior-preserving refactors bundled with the split

1. **Dedupe the dispatcher assembly:** extract `assembleStepDispatcher(host, { persona })` in
   launch-wiring.ts used by both factories (differences become the persona arg + which fields the
   caller destructures). ~30 duplicated lines deleted.
2. **Single owner for step-conversation header surgery:** move `backfillParentEdge` into
   `VaultStepConversationStore` (alongside `backfillNextEdge`, same fs seam, same idempotent-edge
   idiom) — child-spawn then calls the store instead of raw adapter I/O. (`toggleFavorite` is
   chat-side and stays; F4 makes all three atomic.)
3. **Inject fs into the ledger:** `reconcileChildLedger`/`resolveChildEntryConversationId` take a
   `RecoveryFs`-shaped reader (exists/read). Production adapter built in `makeChildFlowSpawner`.
   *(If F1's Fix 3 already did this, this item is done.)*
4. **Fix or delete the stale reference-flows comment** (`reference-flows.ts:1–15`): either point
   TEST-007/008 at a real gate (see §5's e2e decision) or rewrite the comment to claim only what is
   true ("first-party examples materialized on enable").
5. Do **not** fold in F13's `discoverFlows()` caching or the chaining-doc fix if F1 already handled
   the latter — keep this PR mechanical.

## 5. Test plan (the actual payoff — ordered by what catches real bugs)

Fakes ready for reuse: `FakeSessionFs` (`session-manager.test.ts:16–33`), `FakeRecoveryFs`
(`session-recovery.test.ts:305–321`), jsonl builders (`session-recovery.test.ts:25–55`),
`mockProvider(...)` (`run-loop.test.ts:25–40`), canned-executor runner harness (`runner.test.ts:~95–140`).

1. **`child-spawn.test.ts` — ledger replay** (catches F1.3; if F1 landed with this test, extend it):
   spawner over fake fs; `child.spawned`(+`result`) seeded; replayed request → no re-spawn / resume
   path taken; ordinal matching for two same-flow calls in one step.
2. **Executor emission matrix** (catches F3; lives at `step-turn-executor` level — coordinate with
   F3's test plan so it is written once, there).
3. **`run-lifecycle.test.ts` — chaining gate:** target `chainToSuccessor` (frontmatter key
   `notor-on-complete-flow` → `flow.onCompleteFlow`, `flow-parser.ts:427–428`; gate logic
   launch.ts:728–753: `depth + 1 >= maxDepth || iterationsRemaining <= 0 || costRemainingUsd <= 0`).
   Asserts: chains only on `status === "completed"`; blocked handoff → Notice + **no successor
   launch and no status change** (note: the docstring at :698–700 claims FLOW_ERROR on block — the
   code just Notices and returns; **fix the docstring**, or the code, and lock the choice in this
   test); budget cell passed to the successor **by reference**; `parentScratchpadPath` only when
   `handoffIsolation === "shared"`.
4. **`recovery-boot.test.ts`:** over `FakeRecoveryFs` + a stubbed host — recoverable root → resume
   invoked with rebuilt budget/committedKeys; error sessions marked; (with F1) liveness-skip and
   offered-resume paths.
5. **Reference-flow gate (cheap version):** unit test asserting each `materializeReferenceFlows`
   output parses through `FlowDefinitionParser` with zero errors/warnings (extends the existing
   `reference-flows.test.ts`). The full fake-provider e2e is possible (`mockProvider` pattern exists;
   e2e harness has **no** provider stub today — all 10 scripts hit live Bedrock) but is a separate
   decision with real cost; recommend: unit-level flow-parse gate now, live-provider e2e for one
   reference flow only if the team wants TEST-007 to mean something. Record the decision in the
   reference-flows comment (§4.4).

## 6. Sequencing & landing order

1. (Pre-req) F1 + F3 merged.
2. Commit 1 — mechanical file split + barrel; zero logic changes; suite green (pure moves).
3. Commit 2 — `OrchestrationHost` + `implements` on NotorPlugin + `?.` removals + dispatcher-assembly
   dedupe + fs injection (§4.1–.3).
4. Commit 3+ — tests (§5.1, .3, .4, .5), one file per commit.
5. Optional follow-up — dynamize the `makeChildFlowSpawner` static import (main.ts:89) to restore
   full lazy loading of the orchestration layer.

## 7. Verification

- `tsc` + full suite after each commit; the 10 orchestration e2e scripts on the release branch as the
  integration backstop.
- Grep gates: `grep -c "plugin\." src/orchestration/launch*.ts src/orchestration/run-lifecycle.ts
  src/orchestration/child-spawn.ts src/orchestration/recovery-boot.ts` → 0 (all via `host.`);
  `grep -rn "upsertFlowRun?." src/` → 0; `grep -rn "vault.adapter" src/orchestration/child-spawn.ts`
  → 0.
- `wc -l` sanity: no new module > ~500 lines; barrel < 20.

## 8. Risks

- **Merge friction** is the main one — this file is where F1/F2/F3 all land. Hence the hard
  sequencing rule (split last) and the pure-move first commit.
- The barrel must preserve **named** exports exactly (dynamic importers destructure
  `{ recoverOrchestrations }` etc.).
- `VaultSessionFs` is exported but has zero external importers (verified) — safe to move; keep the
  re-export anyway since it is public API.
- Moving `requestOrchestrationInput` behind an injected callback changes no behavior but touches the
  runner-deps wiring in two places (launch :611, resume :1242) — verify pause/resume e2e
  (`orchestration-terminal-paths-test.ts` covers interactive pause) still passes.
