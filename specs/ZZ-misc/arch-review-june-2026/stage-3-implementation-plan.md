# Stage 3 — Implementation Plan ("Decompose the composition root")

**Status:** Ready to implement (after Stage 1's contracts exist — see §0; benefits from Stage 0 but is not strictly gated by it)
**Parent spec:** [`../fable-architecture-review-2606.md`](../fable-architecture-review-2606.md) §4 (Stage 3), §5 matrix, §6 risk notes
**Sibling plans:** [`stage-0-implementation-plan.md`](./stage-0-implementation-plan.md) (item 4 fixes the `_personaManager` stale capture this plan's item 1 then dissolves) · [`stage-1-implementation-plan.md`](./stage-1-implementation-plan.md) (**the load-bearing prerequisite** — narrowing the three whole-plugin consumers onto interfaces only pays off once Runtime API v1 / the discovery + capability contracts exist; see §0) · [`stage-2-implementation-plan.md`](./stage-2-implementation-plan.md) (disjoint — Stage 2 is the agent loop, Stage 3 is the wiring around it)
**Source review:** `private/architecture-review-2026-06-11.md` + `private/architecture-review-2026-06-11-code-map.md` (git-ignored)
**Code verified against:** working tree at HEAD `104ef02` (which adds *only* the parent spec + Stage-0/1/2 plans on top of the reviewed `f7049d0`; all `src/` is byte-identical to the commit the review cites). Re-verified by direct read on 2026-06-14 via three parallel read-only agents (god-object surface, lifecycle/init/teardown/settings, UI callback wiring).

> **Line-number caveat.** Every `file:line` below was confirmed by direct read at `104ef02`. Line numbers
> drift. **Re-locate by symbol name at implementation time, not by line.** Where a range is given it is to
> scope the work, not to be applied as a patch coordinate.

---

## 0. Scope & sequencing

Stage 3 is **the P2 stage**: it decomposes `main.ts` — a 2,717-line god object / implicit service locator —
into a composition root with explicit lifetimes, ordered init, awaited teardown, and a subscription-based
settings bus, and replaces the 42 hand-wired UI callback setters with two compiler-checked interfaces. The
parent spec is emphatic about *when*: **do this after Stage 1's contracts exist**, so the three whole-plugin
consumers move onto interface slices rather than onto a renamed god object. None of it is a rewrite; every
item is a contained re-seating of wiring that already works, and three of the items (1.5 teardown, 1.6 hub,
5.1 view interfaces) make currently-untested logic testable as a side effect.

### The seven Stage-3 items

| # | Item | Issue | Effort | Risk | Depends on |
|---|------|-------|--------|------|------------|
| 1 | **`OrchestratorWiring` constructor arg** — collapse the 8 post-construction setters | 1.2 (medium half) | S | Low | — (good warm-up) |
| 2 | **Awaited teardown** — make `onunload` drain before infra teardown | 1.5 | M | Med | — |
| 3 | **Settings-change subscription bus** — replace the 14-block `saveSettings()` if-chain | 1.4 | M | Med | — |
| 4 | **`OrchestratorHub`** — one owner for the leaf→orch map, focus pointer, session guard | 1.6 | M | Med | — |
| 5 | **Explicit init phases + awaitable barriers** — delete the 3 race-compensation mechanisms | 1.3 | L | Med-High | item 4 (hub awaits the barrier); pairs with item 6 |
| 6 | **`PluginServices` container** — own the 51 fields + getters; narrow the 3 consumers to interfaces | 1.1 | L | Med-High | **Stage 1 contracts** (consumers move onto interfaces); items 4 & 5 land inside it |
| 7 | **Typed `ViewActions` / `ViewDataSource`** over the 42 setters | 5.1 | M | Med | — (fully independent UI track) |

> Renumbering note: this plan numbers items 1–7 for sequencing; the parent-spec issue ids (1.2, 1.5, 1.4,
> 1.6, 1.3, 1.1, 5.1) are kept in every heading so the mapping is unambiguous.

### Critical ordering — what gates what

1. **Item 6 (`PluginServices`) is conceptually gated on Stage 1, not on the other Stage-3 items.** The parent
   spec (§3, Issue 1.1) and §6 risk note #4 are explicit: extracting the container is only safe-and-worthwhile
   *after contracts exist*, because the payoff is narrowing `ExtensionManager` / `commands` / `wire-view` onto
   **interface slices** (`ExtensionManagerDeps`, a view-services slice, a commands slice) rather than onto a
   renamed god object. If Stage 1 has not landed, item 6 degrades to "rename `this` to `this.services`" — do
   **not** do that. Items 1–5 and 7 do not require Stage 1 and can proceed regardless.
2. **Items 4, 5, 6 are a coordinated sub-sequence** that all touch the same construction/ownership logic in
   `main.ts`. The clean internal order is **4 → 5 → 6**: the `OrchestratorHub` (item 4) gives the
   barrier-awaiting consumer (view restore, MCP `onStatusChange`) a single object to await against (item 5);
   the container (item 6) then *owns* both the hub and the `ready` barriers. They may land as three commits or
   one larger PR, but 4 before 5 before 6 keeps each diff reviewable.
3. **Item 1 (`OrchestratorWiring`) is independent and the recommended warm-up.** All 8 setters are called
   unconditionally at the same site immediately after construction — pure refactor, low risk, isolated to
   orchestrator construction in `main.ts` + the setter definitions in `orchestrator.ts`. Stage 0 item 4
   already fixes the `_personaManager` stale capture in `getDispatcherDeps()`; item 1 here finishes the job by
   removing the setter-wiring style entirely for the orchestrator.
4. **Item 3 (settings bus) is independent** but touches many component constructors; it is mechanical (migrate
   14 blocks, then audit the ~18 absent components). Do it before item 6 so the container's components are
   already subscription-shaped, or after — they do not hard-depend. Recommended before 6 to shrink `main.ts`
   incrementally.
5. **Item 2 (awaited teardown) is independent** — isolated to `onunload()` + `SessionManager.destroy()`.
6. **Item 7 (view interfaces) is a fully disjoint UI track** (`ui/chat-view.ts` + `ui/wire-view.ts`), parallelizable with everything else. It is the only **P1** item in the stage (a missing handler becomes a type error instead of a silent no-op, which matters most once third-party UI contributions are on the table per D-share).

### Recommended landing order

`1 (warm-up) → 2 (teardown) → 3 (settings bus) → 4 (hub) → 5 (barriers) → 6 (container, after Stage 1) → 7 (view interfaces, any time, parallel)`.
The only hard edges are **6 ⇐ Stage 1 contracts** and **4 → 5 → 6** internally. Item 7 can run start-to-finish alongside the rest.

### Corrections this plan folds in (verified at `104ef02`)

Three numbers in the source docs are off; the plan uses the verified facts:

- **Setter direction split.** Code-map §5.1 estimated "~24 `setOn*` view→app / ~9 `setGet*` app→view." The
  actual split is **30 `setOn*` + 12 `setGet*` = 42** (the 42 total is correct). Item 7's two interfaces are
  sized to 30 actions + 12 data queries, not 24 + 9.
- **`getActiveOrchestrator()` fallback depth.** Code-map §1.6 called it "4-level." It is a **3-level**
  fallback (active view → last-focused leaf id → first chat leaf → null is the *null tail*, not a fourth
  lookup). Minor, but item 4 reproduces the real shape.
- **Getter count.** Parent spec said "28 `getX()` methods + `vaultRootPath` getter"; code-map said 30. Direct
  count finds **~29 `getX()` methods + the `vaultRootPath` getter property**. Re-count by symbol at
  implementation time — the exact number is immaterial to the plan; the *surface-as-API* problem is the point.

### Relationship to other stages (do NOT scope-creep)

- **Stage 1 item 1 (Runtime API v1 facades)** narrows what `ExtensionManager` reaches through `utils`; item 6
  here narrows what it reaches through the `NotorPlugin` *constructor arg*. They are complementary — item 6
  consumes the interface that Stage 1's facade work motivates. Do not redo Stage 1's facade work here.
- **Stage 1 item 3 (renderer registry)** touches `ui/message-renderer.ts`; item 7 here touches
  `ui/chat-view.ts` + `wire-view.ts`. Disjoint files — but both are "make a UI seam a typed/registrable
  contract" moves; coordinate naming so `ViewActions`/`ViewDataSource` read as siblings of the renderer
  registry, not rivals.
- **Stage 2's loop work** is independent; the orchestrator's *internal* loop is not touched here — only how it
  is *constructed* (item 1), *owned* (item 4), *fed settings* (item 3), and *destroyed* (item 2).

---

## 1. `OrchestratorWiring` constructor arg (Issue 1.2, medium half) — S, low risk

`ChatOrchestrator` is constructed with 10 args and then **immediately** setter-wired with 8 more — every
setter called unconditionally at the same site. That is two dependency-flow styles for one object's
construction; there is no reason the 8 setter-injected deps are not constructor args.

### Current state (verified)

- **Construction** (`src/main.ts` ~1742–1753): `new ChatOrchestrator(app, providerRegistry,
  systemPromptBuilder, dispatcher, historyManager, settings, sessionGuard, view?, vaultRuleManager?,
  templateRegistry?)` — 10 args (constructor signature `src/chat/orchestrator.ts` ~184–195).
- **8 setters called immediately after** (`main.ts` ~1756–1791), in order:
  1. `setPersonaManager(this.getPersonaManager())` (~1756) — def `orchestrator.ts` ~420
  2. `setWorkflowHookOverrideManager(this.getWorkflowHookOverrideManager())` (~1757) — def ~442
  3. `setChatBlockRegistry(this.getChatBlockRegistry())` (~1760) — def ~494
  4. `setExtensionAccessors({…})` (~1764) — def ~465
  5. `setGetToolDefinitions(callback)` (~1777) — def ~693
  6. `setCheckpointManager(checkpointManager)` (~1789) — def ~481
  7. `setSharedCheckpointManager(() => this._sharedCheckpointManager)` (~1790) — def ~485
  8. `setStaleTracker(() => this.getStaleTracker())` (~1791) — def ~489
- The same construction path also produces `getDispatcherDeps()` (~908–927), which Stage 0 item 4 already
  converts `personaManager: this._personaManager` → `() => this.getPersonaManager()`. **Confirm Stage 0 item 4
  has landed before starting**, so this item is not racing that one-liner.
- `createHeadlessOrchestrator()` exists as a second construction path (referenced from `getDispatcherDeps`
  ~925) — **it must receive the same wiring.** Verify it does not silently skip any of the 8 setters today.

### Change

1. Define an `OrchestratorWiring` object grouping the 8 setter-injected deps:
   ```ts
   // Conceptual — names are a design choice; shape mirrors the 8 setters.
   interface OrchestratorWiring {
     personaManager: PersonaManager;
     workflowHookOverrideManager: WorkflowHookOverrideManager;
     chatBlockRegistry: ChatBlockRegistry;
     extensionAccessors: ExtensionAccessors;
     getToolDefinitions: () => ToolDefinition[];
     checkpointManager: CheckpointManager;
     getSharedCheckpointManager: () => SharedCheckpointManager | undefined;
     getStaleTracker: () => StaleTracker;
   }
   ```
   Note two of the 8 are already accessor *functions* (`getSharedCheckpointManager`, `getStaleTracker`) — keep
   them as functions (they are lazy by design); the rest are live instances at construction time.
2. Add `wiring: OrchestratorWiring` as a constructor arg (after the existing required args; before the
   optionals, or as a single trailing required object — pick the shape that keeps the optional `view?` /
   `vaultRuleManager?` / `templateRegistry?` ergonomics). The constructor assigns the 8 fields directly.
3. **Delete the 8 `set*()` methods** from `orchestrator.ts` (~420–494, ~693) once nothing calls them — or, if
   any are called from *elsewhere* (grep first: a re-wire path, a test), keep only those and document why. The
   verification confirms all 8 are called only at the single `main.ts` site, but re-grep at implementation time.
4. Update **both** construction paths (`main.ts` ~1742 and `createHeadlessOrchestrator()`) to pass `wiring`.

### Verification
- `tsc` green (the constructor signature change is compiler-enforced — a missing wiring field is a type error).
- A test constructing an orchestrator (existing `orchestrator`-adjacent suites) passes `wiring` and behaves
  identically; `getDispatcherDeps()` still resolves persona/extension deps lazily.
- Grep confirms zero remaining `setPersonaManager` / `setStaleTracker` / … call sites after deletion.

### Risk
**Low.** Pure mechanical re-seating; the compiler catches omissions. The only trap is a *second* construction
path (`createHeadlessOrchestrator`) or a re-wire site silently dropping a setter — grep before deleting the
setter methods. Keep this in its own commit.

---

## 2. Awaited teardown (Issue 1.5) — M, medium risk

`onunload()` is synchronous: Phase 1 fire-and-forgets `orch.destroy()` (which has up to a 2s JSONL-flush
window) and then **immediately** clears the map and runs Phase 2, which tears down the very infrastructure the
in-flight session teardown may still touch. Timer cleanup happens last. The JSONL flush "happens to not depend
on Phase 2 today," but that invariant is unstated and unenforced.

### Current state (verified)

- `onunload()` (`src/main.ts` ~688–789) is **synchronous**.
  - **Phase 1** (~691–700): `for (const orch of this._orchestrators.values()) orch.destroy().catch(…)` then
    immediate `this._orchestrators.clear()`. Comment (~691–693): *"Fire-and-forget since onunload() is
    synchronous — the 2s timeout in destroy() prevents hanging."*
  - **Phase 2** (~702–767): synchronous teardown of infra the destroys may touch —
    `notifyFileLeafActivated(null)` (~703), `_vaultRuleManager?.stop()` (~706), the Group-F vault-event
    components in reverse-init order (~712–720: `_vaultEventListenerManager`, `_vaultEventScheduler`,
    `_manualSaveDetector`, `_hookDelayManager`, `_tagSuppression`, `_vaultEventDebounce`, `_tagShadowCache`,
    `_workflowConcurrencyManager`), `_workflowActivityTracker?.destroy()` (~723), `_workflowHookOverrideManager?.destroy()` (~729),
    **`_taskLaneQueue?.destroy()`** (~733 — *rejects all pending waiters*), detached sub-agent abort loop
    (~737–741), spillover cleanup (~744), `_extensionManager?.destroy()` (~749).
  - **Phase 3** (~753–766): clear `_extensionChangeTimer` / `_personaChangeTimer`, hide stale Notices;
    the rest of timer/interval/event cleanup is Obsidian-automatic (~768–770).
- The flush chain being raced: `orchestrator.destroy(timeoutMs = 2000)` (`orchestrator.ts` ~641–642) →
  `SessionManager.destroy(2000)` (`session-manager.ts` ~134–177): aborts each session's controller, races
  `Promise.allSettled(sessionPromises)` vs **2000ms** (~145–148), deactivates workflow hook overrides
  (~151–156), then races `historyManager.flush()` vs `max(timeoutMs/2, 500)` = **500ms** (~161–164), then
  unregisters session ids + clears (~170–174).

### Change

Pick **one** of the two parent-spec options (recommended: option A — it is the smaller behavioral change and
Obsidian tolerates short awaits in `onunload`):

**Option A — make `onunload` await the drain before Phase 2.**
1. `async onunload()`; before Phase 2, `await Promise.race([Promise.allSettled([...allDestroys]), timeout(2500)])`
   — i.e. give the orchestrators their ~2s flush window *before* tearing down `_taskLaneQueue` and the vault
   managers they may touch. Keep the per-orch 2s internal timeout as the inner bound; the outer 2500ms is the
   hard ceiling so unload never hangs.
2. **Move timer/Notice clearing to the very top** (cheapest, prevents callbacks firing into half-destroyed
   members during the await). This is the one change to make regardless of option.

**Option B — keep `onunload` sync; make the flush self-contained.**
1. Have `SessionManager.destroy()` **synchronously snapshot** pending JSONL lines into the per-file write queue
   (which is promise-chained per file and survives member teardown), so the flush no longer depends on any
   Phase-2 singleton.
2. Phase 2 then awaits only `historyManager.flush()` (or nothing, if the write queue owns durability).

### Verification
- A turn that is mid-stream when the plugin unloads still flushes its JSONL (manual smoke: start a long
  response, disable the plugin, re-enable, confirm the partial conversation persisted). This is the
  data-integrity case the asymmetry threatens.
- No "task lane queue destroyed / rejected" errors logged during a normal unload with an in-flight session
  (today's latent race).
- `tsc` + suite green. If a `session-manager` test exists, extend it to assert the snapshot-or-await contract.

### Risk
**Medium** — this is data-durability-adjacent (JSONL flush on unload; a regression silently loses the tail of
a conversation). Mitigate by choosing option A (minimal behavioral delta) and manual-smoking the
mid-stream-unload case explicitly. Do **not** lengthen the outer timeout enough to make Obsidian feel hung
(2500ms is already at the edge of acceptable).

---

## 3. Settings-change subscription bus (Issue 1.4) — M, medium risk

`saveSettings()` carries a 14-block `if (this._component) component.setX(...)` propagation chain. Every new
settings consumer must remember to add itself; ~18 components that hold or could hold settings-derived state
are **not** in the chain — some legitimately read settings live, some are latent stale-config bugs. This is a
missing observer pattern.

### Current state (verified — `src/main.ts` ~1234–1335)

- `await this.saveData(this.settings)` (~1235), then **14 propagation blocks**:
  1. `_providerRegistry` (~1238–1246): `updateConfig()` loop + `switchProvider()`
  2. orchestrators loop (~1249–1250): `updateSettings(this.settings)`
  3. `_noteOpener` (~1253–1256): `setEnabled()` + `setFocusEnabled()`
  4. `_historyManager` (~1258–1263): `updateSettings()`
  5. `_checkpointStorage` (~1266–1271): `setBasePath()` + `setRetentionLimits()`
  6. `_vaultRuleManager` (~1274–1275): `setNotorDir()`
  7. `_systemPromptBuilder` (~1278–1279): `setNotorDir()`
  8. `_personaManager` (~1282–1283): `updateSettings()`
  9. `_vaultEventDebounce` (~1287–1290): `setCooldown()`
  10. `_workflowConcurrencyManager` (~1294–1297): `updateLimit()`
  11. `_workflowActivityTracker` (~1301–1304): `updateMaxEntries()`
  12. `_mcpHub` (~1309–1310): `updateSettings()`
  13. `_vaultEventListenerManager` (~1314–1315): `evaluateListeners()`
  14. `_vaultEventScheduler` (~1317–1321): `syncJobs()`
- Then fire-and-forget `rescanWorkflows()` (~1328) + `setLogLevel(this.settings.log_level)` (~1334).
- **~18 components NOT in the chain** (verified as private fields, absent from `saveSettings`): `_toolRegistry`,
  `_toolDispatcher`, `_staleTracker`, `_subAgentManager`, `_pendingMemoryManager`, `_extensionManager`,
  `_chatBlockRegistry`, `_tempOutputSpiller`, `_taskLaneQueue`, `_searchProviderRegistry`, `_webSearchQueue`,
  `_tagShadowCache`, `_tagSuppression`, `_executionChainTracker`, `_manualSaveDetector`, `_hookDelayManager`,
  `_workflowHookOverrideManager`, `_settingTab`. Several read settings live at call-time by design; the audit
  (step 3 below) establishes which are bugs.

### Change

1. **Introduce a settings bus.** A small typed emitter (own it on the future `PluginServices` container, or
   standalone for now):
   ```ts
   interface SettingsBus {
     subscribe(cb: (settings: NotorSettings) => void): () => void; // returns unsubscribe
     emit(settings: NotorSettings): void;
   }
   ```
   Components register `onSettingsChanged(cb)` at construction; `saveSettings()` becomes
   `await this.saveData(this.settings); this._settingsBus.emit(this.settings);`.
   - **Reuse the existing observer idiom** already in the codebase (the `onSessionsChanged` /
     `setOnPersonaChanged` pattern that returns an unregister fn — see item 7 §C) rather than inventing a new
     shape. Unsubscribe on component `destroy()`.
2. **Migrate the 14 blocks mechanically.** Each component's current `setX(settings)` body becomes its
   `onSettingsChanged` handler. The orchestrators loop (#2) is special — orchestrators are created/destroyed
   per panel, so either (a) each orchestrator subscribes on construction and unsubscribes on `destroy()`, or
   (b) the `OrchestratorHub` (item 4) fans the emit out to its live orchestrators. **Prefer (b)** once item 4
   lands, so subscription lifetime tracks the hub's map; until then (a).
3. **Audit the ~18 absent components.** For each, decide: subscribe (latent stale-config bug — fix it) or
   document "reads live, intentionally." Capture the verdict per component in a comment or the open-questions
   log so the next person does not re-litigate. The parent spec calls this out explicitly ("then audit the
   absent components").
4. **Keep `saveSettings()` ordering guarantees where they matter.** A few blocks are order-sensitive (e.g.
   `_providerRegistry.switchProvider()` after `updateConfig()`). A naive emit fan-out loses ordering. If any
   subscriber depends on another having run first, either keep that pair as an explicit ordered step before
   the generic emit, or give the bus a priority/phase notion. **Verify ordering dependencies before flattening**
   (open question §8).

### Verification
- Changing a setting still propagates to every one of the 14 components (regression-test the observable
  effects: provider switch, history retention, checkpoint path, vault-rule dir, debounce cooldown, scheduler
  jobs). A subscription-based path must be behaviorally identical to the if-chain.
- The audited absent components either now react to relevant setting changes (the ones that were bugs) or have
  a documented "reads live" rationale.
- A component that `destroy()`s unsubscribes (no emit-after-destroy errors; manual smoke: change settings
  after closing a panel).
- `tsc` + suite green.

### Risk
**Medium.** The hazard is **lost ordering** (the if-chain is implicitly ordered; a fan-out is not) and
**subscription-lifetime leaks** (a component that subscribes but never unsubscribes fires after teardown — the
exact class item 2 guards against). Mitigate: preserve order-sensitive pairs as explicit pre-emit steps, route
unsubscribe through `destroy()`, and migrate the 14 blocks one at a time with the observable-effect tests
green after each.

---

## 4. `OrchestratorHub` (Issue 1.6) — M, medium risk

Three fields reconcile "which orchestrator is active" by read-time lookup heuristics instead of one owner:
the leaf→orch map, the last-focused leaf pointer, and the session-liveness set. The focus handler also carries
a **hidden persona-sync side effect** that is easy to lose in this arrangement.

### Current state (verified — `src/main.ts`)

- `_orchestrators = new Map<string, ChatOrchestrator>()` keyed by leaf id (~173).
- `_activeConversationSessions = new Set<string>()` (~183), wrapped by the `_sessionGuard` literal (~198–202:
  `isActive` / `register` / `unregister`).
- `_lastFocusedChatLeafId?: string` (~213), written by the `active-leaf-change` handler (~472–482) — which
  **also syncs the dispatcher's active persona** as a side effect:
  ```ts
  this.app.workspace.on("active-leaf-change", (leaf) => {
    if (leaf?.view instanceof NotorChatView) {
      this._lastFocusedChatLeafId = leaf.id;
      const orch = this._orchestrators.get(leaf.id);
      const conv = orch?.getDisplayedConversation();
      this.getToolDispatcher().setActivePersonaName(conv?.persona_name ?? null); // hidden side effect
    }
  });
  ```
- `getActiveOrchestrator()` (~1821–1845): **3-level** fallback — active `NotorChatView` → `_lastFocusedChatLeafId`
  → first leaf of `CHAT_VIEW_TYPE` → null. Sibling `getLastFocusedOrchestrator()` (~1851–1854): just
  `_orchestrators.get(_lastFocusedChatLeafId)`.
- Map maintenance lives in the view factory (~403–433): stale-orchestrator replacement (~407–418, fire-and-forget
  `staleOrch.destroy()`), `setTimeout(0)` conversation-load fallback (~425–433). Consumers of the active
  orchestrator: `commands/index.ts` (~35/67/128/159/246), `wire-view.ts`, and `getAllActiveSessions()` (~1879).

### Change

1. **Extract `OrchestratorHub`** owning all three pieces:
   ```ts
   class OrchestratorHub {
     getForLeaf(leafId: string): ChatOrchestrator | null;
     getActive(): ChatOrchestrator | null;           // the 3-level fallback, moved verbatim
     getLastFocused(): ChatOrchestrator | null;
     set(leafId: string, orch: ChatOrchestrator): void;   // replaces stale, returns prior for cleanup
     remove(leafId: string): void;
     onFocusChanged(cb: (orch: ChatOrchestrator | null) => void): () => void;
     readonly sessionGuard: SessionGuard;             // owns _activeConversationSessions
     getAllActiveSessions(): ConversationSession[];
   }
   ```
2. **Move the focus side effect to a subscriber.** The hub fires `onFocusChanged` when the active leaf changes;
   the persona-sync (`dispatcher.setActivePersonaName(...)`) becomes a **named `onFocusChanged` subscriber**
   registered at composition time — visible and testable, not buried in a workspace-event closure. `main.ts`'s
   `active-leaf-change` handler shrinks to "tell the hub which leaf is focused."
3. **Route all map mutations through the hub.** The view factory calls `hub.set(leafId, orch)` (which returns
   any prior orchestrator for the caller to `destroy()`), `hub.remove(leafId)` on close. `getActiveOrchestrator`
   / `getLastFocusedOrchestrator` / `getAllActiveSessions` on the plugin delegate to the hub (keep thin
   plugin-level shims so `commands/` and `wire-view` need no change *in this item* — they get narrowed in item 6).
4. **The hub is the barrier-awaiting boundary for item 5.** View restore creating an orchestrator should
   `await services.ready.registries` before `hub.set(...)`; the hub does not itself own the barrier, but it is
   the natural place the awaiting consumer lands. Build item 4 with item 5's `ready` consumer in mind.

### Verification
- `getActive()` reproduces the exact 3-level fallback (port the logic verbatim; if a `getActiveOrchestrator`
  test exists, it stays green — if none does, **add one** now that the logic is in a testable object: this is
  one of Stage 3's "untested logic becomes testable" wins).
- Switching focus between two chat panels still syncs the dispatcher's active persona (manual smoke: two
  panels with different personas, focus each, confirm auto-approve uses the focused panel's persona — the side
  effect the hub now makes explicit).
- Stale-orchestrator replacement on re-opening a leaf still destroys the prior orchestrator (no leak).
- `tsc` + suite green.

### Risk
**Medium.** The persona-sync side effect is *load-bearing and easy to drop* during extraction — it is the
exact "logic that gets lost in this arrangement" the parent spec names. Mitigate with the two-panel persona
smoke test. The session-guard ownership move must preserve cross-panel "processing in another panel" behavior
(the guard is consulted during the ~2s destroy drain window — see item 2).

---

## 5. Explicit init phases + awaitable barriers (Issue 1.3) — L, medium-high risk

Three separate compensation mechanisms exist because nothing orders (a) view restore creating orchestrators,
(b) async extension discovery, (c) MCP server connection. Each new async subsystem adds a fourth patch. Replace
the patches with explicit init phases exposing awaitable barriers.

### Current state (verified — `src/main.ts`)

- `onload()` (~370–686): only **three awaited barriers** — `await loadSettings()` (~374), `await
  ensureSpillDir()` (~386, conditional), `await restoreFromSettings()` (persona restore is actually
  fire-and-forget ~492; verify). The rest of init is fire-and-forget: spillover stale cleanup (~387),
  `autoInjectUnidentifiedWorkflows().then()` (~600–623), `getExtensionManager().reload(true).then()`
  (~632–676), history retention (~680–682).
- **Race 1 — workspace-restore vs extension-discovery.** Comment (~628–631): *"if the dispatcher was already
  created (e.g., by workspace restore triggering wireView() → createOrchestrator() → getToolDispatcher())
  before this async reload completes, we must sync it afterwards."* Defensive **re-sync loop** (~637–643):
  iterate `getToolRegistry().getAll()`, `registerTool` any the dispatcher lacks.
- **Race 2 — MCP status.** `onStatusChange` guard (~1069–1075) logs *"MCP onStatusChange fired but
  ToolRegistry/Dispatcher not initialized"* and **drops the event**; compensated by `queueMicrotask(() =>
  this._syncMcpToolRegistrations())` (~1177) → `_syncMcpToolRegistrations()` (~1188–1227, idempotent re-register).
- **Defense 3 — eager pre-creation.** ToolRegistry + ToolDispatcher eagerly created (~574–578) *specifically*
  so fast stdio MCP servers don't hit Race 2. Comment confirms the intent.
- Other timing defenses: stale-orchestrator replacement (~407–418), `setTimeout(0)` conversation-load fallback
  (~425–433).

### Change

1. **Define explicit init phases with awaitable barriers** on the services container (item 6) — or, if landing
   item 5 before item 6, on the plugin temporarily:
   ```ts
   readonly ready: {
     registries: Promise<void>;   // ToolRegistry + ToolDispatcher constructed (+ built-in tools)
     discovery: Promise<void>;    // extension reload + workflow discovery complete
   };
   ```
   Each is a promise resolved exactly once when its phase completes. Keep the **eager registry creation**
   (~574–578) — it is cheap and harmless; it becomes the body that *resolves* `ready.registries`.
2. **Consumers await the barrier instead of compensating after the fact:**
   - **View restore** (view factory ~403–433): `await services.ready.registries` before constructing an
     orchestrator / calling `hub.set(...)` (item 4). Then the dispatcher always has the registry's tools at
     construction → **delete the re-sync loop (~637–643).**
   - **MCP `onStatusChange`** (~1069): `await services.ready.registries` at entry instead of the guard-and-drop
     → **delete the guard's drop path and the `queueMicrotask` catch-up (~1177).**
3. **Sequence the discovery phase** so `ready.discovery` resolves after extension reload + workflow
   auto-inject; consumers that need discovered content (e.g. anything reading `getDiscoveredWorkflows()`) await
   `ready.discovery` rather than racing it.
4. **Preserve the fire-and-forget *feel* where it is correct.** Not everything should block `onload` — history
   retention, spillover cleanup can stay background. The barriers are for the *ordering edges that today are
   raced*, not for serializing all of init. Be surgical: only the three documented races get barriers.

### Verification
- The re-sync loop (~637–643) and the microtask catch-up (~1177) are **deleted**, and a fast-connecting stdio
  MCP server still gets its tools registered (manual smoke with a stdio MCP server: tools appear without the
  "not initialized" warning ever logging).
- Workspace restore with a saved chat panel + extensions present: the restored orchestrator's dispatcher has
  *extension* tools immediately (not just built-ins), with no re-sync pass (the bug the loop papers over).
- The "ToolRegistry/Dispatcher not initialized" warning never fires (add a temporary tripwire `log.error` in
  the deleted guard's place for one dev session to confirm, mirroring the Stage-0.5 tripwire discipline).
- `tsc` + suite green.

### Risk
**Medium-high** — this is the riskiest Stage-3 item because it changes **init ordering**, and the three
compensation mechanisms exist precisely because the original ordering was subtle. A barrier awaited too late
(after a consumer already needs it) reintroduces the race; awaited too eagerly can deadlock `onload` if the
phase depends on something downstream. Mitigate: (a) land item 4 (hub) first so the awaiting consumers have a
clean home; (b) keep the eager registry creation as the `ready.registries` body (do not remove the defense,
*convert* it); (c) delete the compensation mechanisms **one at a time**, each behind a one-dev-session tripwire
confirming the race no longer fires; (d) manual-smoke both restore and stdio-MCP paths, which unit tests
under-cover (`main.ts` has no test harness — open question §8).

---

## 6. `PluginServices` container (Issue 1.1) — L, medium-high risk — **gated on Stage 1**

`main.ts` is the de-facto internal API: ~29 `getX()` accessors + 51 private fields, with three consumers
(`ExtensionManager`, `commands/`, `wire-view`) reaching through the whole plugin. Extract a composition root so
`main.ts` shrinks to Obsidian lifecycle glue, **and narrow the three consumers onto interface slices** — the
latter is the actual payoff and the reason this is gated on Stage 1's contracts.

> **Gate: Stage 1 must have landed.** Per parent spec §3 (Issue 1.1) and §6 risk note #4, do this *after*
> contracts exist so the consumers move onto interfaces, **not** onto a renamed god object. If Stage 1 is not
> in, stop — do items 1–5 and 7 and defer this.

### Current state (verified — `src/main.ts`)

- 2,717 lines; ~74 imports; **51 private `_` fields**; **~29 `getX()` methods** (~1342–2102) + the
  `vaultRootPath` getter property (~150). Roughly 1,300 of the 2,717 lines are fields + getters + construction.
- The ~29 getters (re-locate by symbol): `getProviderRegistry` (~1342), `getStaleTracker` (~1406),
  `getNoteOpener` (~1419), `getCheckpointStorage` (~1431), `getCheckpointManager` (~1444),
  `getSharedCheckpointManager` (~1464), `getToolRegistry` (~1478), `getToolDispatcher` (~1515),
  `getHistoryManager` (~1548), `getSystemPromptBuilder` (~1561), `getVaultRuleManager` (~1574),
  `getPersonaManager` (~1591), `getPendingMemoryManager` (~1606), `getSubAgentManager` (~1623),
  `getExtensionManager` (~1638), `getVaultEventScheduler` (~1646), `getTemplateRegistry` (~1651),
  `getChatBlockRegistry` (~1664), `getMarkdownExporter` (~1675), `getTaskLaneQueue` (~1680),
  `getWebSearchQueue` (~1701), `getActiveOrchestrator` (~1821 — moves to the hub, item 4),
  `getLastFocusedOrchestrator` (~1851 — hub), `getWorkflowActivityTracker` (~1874),
  `getAllActiveSessions` (~1879 — hub), `getWorkflowHookOverrideManager` (~2078),
  `getDiscoveredWorkflows` (~2102), + a few more (`getWebviewLeafCache` ~1402, `getTempOutputSpiller` ~1414).
- **The three consumers and exactly what they reach through** (verified by grep — this is what each interface
  slice must contain):
  - **`ExtensionManager`** (`src/extensions/manager.ts` ctor ~222–225, `constructor(private readonly plugin:
    NotorPlugin, …)`): uses only `getTemplateRegistry` (279/296/356/411), `getChatBlockRegistry` (433/480),
    `getToolRegistry` (545/567), `getToolDispatcher` (570/580). → **4-method `ExtensionManagerDeps`.**
  - **`registerCommands(plugin)`** (`src/commands/index.ts` ~18, called `main.ts` ~450): uses
    `getActiveOrchestrator` (35/67/128/159), `getLastFocusedOrchestrator` (246), `getHistoryManager` (209),
    `getPersonaManager` (287), `getExtensionManager` (265), `getPendingMemoryManager` (318). → **6-method
    `CommandDeps`** (3 of which are hub methods).
  - **`wireView(view, orch, plugin)`** (`src/ui/wire-view.ts` ~23, called `main.ts` ~2508): uses
    `getHistoryManager` (24), `getProviderRegistry` (25), `getToolDispatcher` (26), `getWorkflowActivityTracker`
    (48), `getAllActiveSessions` (54), `getPersonaManager` (81), `getDiscoveredWorkflows` (139),
    `getStaleTracker` (160/206/223), `getVaultRuleManager` (162/207/224). → **~9-method `ViewServices`.**

### Change

1. **Extract `PluginServices`** owning the 51 fields + the ~29 getters + the construction logic. It also owns
   the `OrchestratorHub` (item 4), the `ready` barriers (item 5), and the `SettingsBus` (item 3) — those three
   items are the *contents* of the container, which is why 4→5→6 is the order. `main.ts` keeps only `onload` /
   `onunload`, `registerView`, workspace-event registration, and `saveSettings` (now a one-liner `saveData +
   bus.emit`), delegating everything else to `this.services`.
2. **Narrow the three consumers to interface slices** (the payoff):
   - `ExtensionManager` takes `ExtensionManagerDeps` (the 4 methods above) instead of `NotorPlugin`.
   - `registerCommands` takes `CommandDeps`.
   - `wireView` takes `ViewServices` (+ the orchestrator it already takes).
   Each interface is satisfied by `PluginServices` (it `implements` them, or a small adapter exposes the slice).
   A consumer can no longer reach an arbitrary getter — and a getter rename is now a localized change behind the
   interface, not a cross-cutting one. **This is only worthwhile because Stage 1 made the underlying surfaces
   stable contracts; without that, the slices just defer the coupling.**
3. **Do it mechanically, behind a green build at each step.** Suggested sub-steps: (a) create `PluginServices`,
   move fields + getters into it, leave `main.ts` getters as `=> this.services.getX()` shims so nothing else
   changes; (b) move construction logic; (c) introduce the three interfaces and switch each consumer one at a
   time; (d) delete the `main.ts` getter shims once no caller remains (some may stay if Obsidian-lifecycle code
   needs them — that is fine, `main.ts` is allowed to use the container).

### Verification
- `tsc` green after each sub-step (the interface narrowing is compiler-enforced — a consumer reaching a method
  not in its slice is a type error).
- Each consumer compiles against its slice only; grep confirms `ExtensionManager` / `registerCommands` /
  `wireView` no longer reference `NotorPlugin` (or reference only a narrow typed slice).
- Full suite green; manual smoke of a full plugin load (commands fire, extensions load, a chat panel wires and
  sends a message) — the integration the unit tests do not cover.

### Risk
**Medium-high** by size, not by subtlety — it is a large mechanical move with many touch points, and `main.ts`
has no test harness, so the safety net is `tsc` + the existing subsystem suites + manual load smoke. Mitigate
with the shim-first approach (move fields/getters behind delegating shims, *then* narrow consumers) so each
sub-step is independently green and revertible. **Do not** combine this with behavioral changes — items 2/3/4/5
carry the behavior changes; item 6 is pure relocation + interface narrowing.

---

## 7. Typed `ViewActions` / `ViewDataSource` over the 42 setters (Issue 5.1) — M, medium risk — independent UI track

The 42 hand-wired `setOn*`/`setGet*` callback setters on `NotorChatView` mean one new button = setter +
wiring + handler across 4–5 files, and a forgotten wire is a **silent no-op** (the callbacks are optional).
Split by direction into two typed interfaces so a missing handler is a *type error*. Don't boil the ocean —
migrate group-by-group; a full event bus is optional after.

### Current state (verified)

- **42 setters on `NotorChatView`** (`src/ui/chat-view.ts` ~272–574): **30 `setOn*`** (view→app actions) +
  **12 `setGet*`** (app→view data queries). Grouped: sending/response 5, conversation mgmt 9, metadata/editing
  4+1, mode/settings 4, provider/model 7+5, thinking/checkpoints 2+2, workflows/personas 1+3, lifecycle 1.
  Each stores a callback and either injects it into a sub-component (`chatInput.deps.*`,
  `conversationList.deps.*`, `settingsPopover.deps.*`) or stores it on the view for direct use.
- **All wired in the single 661-line `wireView()`** (`src/ui/wire-view.ts` ~23–683), exactly once each;
  callbacks are optional → a forgotten wire silently no-ops (call sites use `this.onX?.()`).
- **Observer idioms already present to build on** (and to model the bus on if you go further): `orchestrator.onSessionsChanged(cb) → unregister` (~64), plugin activity-indicator callback set (~58–60),
  `personaManager.setOnPersonaChanged(cb) → unregister` (~85–95). Approval/interaction callbacks
  (`setApprovalCallback` ~598, `setInteractionCallback` ~649) are direct, lifetime-of-orchestrator.
- The **12 `setGet*` (→ `ViewDataSource`)**: `setGetActiveConversationMeta` (~317), `setGetAvailableProviders`
  (~383), `setGetAvailableModels` (~388), `setGetCurrentProvider` (~393), `setGetCurrentModel` (~398),
  `setGetAvailablePresets` (~408), `setGetCurrentPreset` (~413), `setGetActiveModelId` (~418),
  `setGetActiveThinkingLevel` (~423), `setGetWorkflows` (~507), `setGetActiveSessions` (~559),
  `setGetCurrentConversationId` (~574). The other **30 are `setOn*` (→ `ViewActions`)**.

### Change

1. **Define two interfaces:**
   ```ts
   interface ViewActions {            // the 30 setOn* — view → app
     onSendMessage(content: string, attachments?: Attachment[]): Promise<void>;
     onStopResponse(): void;
     onNewConversation(): void;
     /* …all 30, fully required… */
   }
   interface ViewDataSource {         // the 12 setGet* — app → view (pull)
     getAvailableProviders(): { id: string; type: string; displayName: string }[];
     getActiveConversationMeta(): ActiveConversationMeta | null;
     /* …all 12… */
   }
   ```
2. **Add `view.setActions(actions: ViewActions)` and `view.setDataSource(source: ViewDataSource)`** — one call
   each, replacing the 42 individual setters. Because the interfaces are **fully required**, a missing handler
   is a compile error — the silent-no-op class is eliminated. (Keep the sub-component injection internal: the
   view distributes `actions`/`source` fields into `chatInput.deps` / `conversationList.deps` /
   `settingsPopover.deps` as it does today.)
3. **Migrate group-by-group** (parent spec: "don't boil the ocean"). **Start with provider/model selection** —
   it is the largest single cluster (7 actions + 5 data queries = 12 of the 42) and pure plumbing, so the
   payoff/risk ratio is best. Then conversation mgmt, then the rest. During migration the view can support both
   the old setters and the new `setActions`/`setDataSource` for already-migrated groups; delete a setter only
   when its group has moved.
4. **A full event bus is explicitly out of scope** — the typed-interface step alone removes the silent-no-op
   problem, which is the whole point. Note the bus as a *possible* follow-up, not a Stage-3 deliverable.
5. **If Stage 1 item 3 (renderer registry) has touched `wire-view`'s renderer-facing callbacks** (e.g.
   `setOnOpenSettingsGroup` is consumed by `messageRenderer.deps`), coordinate so those land in the matching
   interface, not orphaned.

### Verification
- `tsc` green — and **deliberately omitting a handler is a compile error** (the headline win; demonstrate it
  once during review).
- Every migrated action/query behaves identically (manual smoke per group: provider switch, model switch,
  preset change still work after the provider/model group migrates; conversation new/switch/delete after that
  group; etc.).
- `wireView` shrinks to two object literals + the observer subscriptions (sessions/persona/activity) that
  legitimately stay as subscriptions.

### Risk
**Medium.** The migration is wide (42 call sites) and touches the most user-visible surface; a wrong wiring is
caught by `tsc` for the structure but **not** for *behavior* (wiring `onModelChange` to the provider handler
compiles). Mitigate with per-group manual smoke and by migrating one group at a time behind a green build.
The observer-shaped callbacks (sessions/persona/activity) are **not** part of `ViewActions`/`ViewDataSource` —
leave them as subscriptions; folding them in would lose their unregister semantics.

---

## 8. Cross-cutting: build / test / commit hygiene

- **Build gate:** every item ends with `npm run build` / `tsc --noEmit` clean. For items 5 and 6 specifically,
  `tsc` is the *primary* safety net (`main.ts` has no unit-test harness — see open question 1).
- **Manual smoke is non-optional for the lifecycle items.** Item 2 (unload-mid-stream flush), item 4 (two-panel
  persona sync), item 5 (workspace restore + stdio-MCP tool registration), and item 7 (per-group UI behavior)
  are under-covered by unit tests — run the `debug-in-obsidian` / `run` skills for each. Where the parent spec's
  "untested logic becomes testable" applies (item 4's `getActive()`, item 3's bus), **add the unit test** as
  part of the item.
- **Tripwire discipline for deletions** (mirrors Stage 0.5): item 5 deletes three race-compensation mechanisms
  — replace each with a one-dev-session `log.error` tripwire confirming the race no longer fires *before*
  deleting the compensation, one at a time.
- **Commit granularity** (per repo git rules — use `mcp__git` tools, not raw CLI; one logical unit per commit).
  Suggested commits:
  1. `Collapse orchestrator setter-wiring into OrchestratorWiring constructor arg` (item 1)
  2. `Await orchestrator drain before infrastructure teardown in onunload` (item 2)
  3. `Replace saveSettings if-chain with settings subscription bus` (item 3)
  4. `Extract OrchestratorHub owning leaf map, focus pointer, session guard` (item 4)
  5. `Introduce init-phase barriers; delete re-sync loop + MCP microtask catch-up` (item 5)
  6. `Extract PluginServices container; narrow ExtensionManager/commands/wireView to interface slices` (item 6 — after Stage 1)
  7. `Replace 42 view callback setters with typed ViewActions/ViewDataSource` (item 7 — splittable per group)

---

## 9. What this plan deliberately does NOT do

- **No `main.ts` rewrite.** Every item re-seats wiring that already works; item 6 is relocation + interface
  narrowing behind delegating shims, not a redesign.
- **No full UI event bus (Issue 5.1 stretch).** Item 7 stops at two typed interfaces; a bus is a noted possible
  follow-up, not a deliverable.
- **No registrable settings sections / settings namespacing (Issue 5.4).** That is deferred/opportunistic per
  the parent spec; the settings *bus* (item 3) is about propagation, not schema shape.
- **No Runtime API v1 / facade work (Issue 2.1).** That is Stage 1; item 6 *consumes* the stable surfaces Stage
  1 produced — it does not create them.
- **No renderer-registry migration (Issue 5.2).** Stage 1; item 7 only coordinates naming with it.
- **No changes to the agent loop, dispatcher, or message pipeline.** Stage 2 owns those; Stage 3 changes only
  how the orchestrator is constructed/owned/fed-settings/destroyed.
- **No removal of the eager registry pre-creation (Issue 1.3 defense 3).** It is kept and *repurposed* as the
  body that resolves `ready.registries` — converting a defense into the explicit phase, not deleting it.

---

## 10. Open questions to resolve at implementation time

1. **`main.ts` test harness.** There is no unit-test harness for the composition root today. Items 5 and 6
   lean entirely on `tsc` + manual smoke. Decide whether to stand up a minimal `PluginServices` construction
   test (it becomes feasible *because* of item 6) or accept manual smoke as the gate. Recommended: add a
   light construction/barrier-resolution test for `PluginServices` once item 6 lands.
2. **Teardown option A vs B** (item 2): async-onunload-with-await (smaller delta, ~2.5s ceiling) vs
   sync-onunload-with-write-queue-snapshot (no await, more invasive to `SessionManager`). Recommended: A,
   unless the ~2.5s unload pause is judged unacceptable.
3. **Settings-bus ordering** (item 3): which of the 14 propagation blocks are order-sensitive (at least
   `_providerRegistry` `updateConfig` → `switchProvider`)? Enumerate before flattening to a fan-out; keep
   order-sensitive pairs as explicit pre-emit steps or give the bus a phase/priority notion.
4. **Settings-bus subscription lifetime for per-panel orchestrators** (item 3): each orchestrator subscribes/
   unsubscribes on construct/destroy (pre-item-4) vs the hub fans the emit out to its live orchestrators
   (post-item-4). Recommended: hub-fanout once item 4 lands.
5. **The ~18 `saveSettings`-absent components** (item 3): which are latent stale-config bugs (subscribe them)
   vs read-live-by-design (document)? Resolve per component during the audit and record the verdict so it is
   not re-litigated.
6. **Barrier granularity** (item 5): is `{ registries, discovery }` sufficient, or does MCP connection warrant
   its own `ready.mcp` barrier? Recommended: start with the two the races actually need; add `ready.mcp` only
   if a consumer races it.
7. **Interface-slice home** (item 6): do `ExtensionManagerDeps` / `CommandDeps` / `ViewServices` live with
   their consumers (each declares what it needs) or centrally with `PluginServices`? Recommended: with the
   consumer (dependency-inversion — the consumer owns its requirement), `PluginServices` implements them.
8. **`getActiveOrchestrator` semantics under the hub** (item 4): the current 3-level fallback silently picks
   "first chat leaf" when nothing is focused — preserve verbatim, or make "no focused panel" explicit (return
   null and let callers decide)? Recommended: preserve verbatim in this stage; revisit only if a caller is
   shown to misbehave on the fallback.
