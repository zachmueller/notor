# Multi-Conversation Robustness Redesign — Implementation Tasks

**Spec:** [multi-conversation-robustness-redesign.md](multi-conversation-robustness-redesign.md)
**Created:** 2026-04-10
**Status:** Not started

---

## Phase A1: Orchestrator Registry + Factory Rewrite

**Goal:** Replace primary/secondary orchestrator distinction with a unified `Map<leafId, ChatOrchestrator>` registry. All panels become equal.

**Files:** `src/main.ts`, `src/chat/orchestrator.ts`, `src/checkpoints/checkpoint.ts`

**Bugs addressed:** A (primary), D (partial)

- [ ] **A1.1 — Define `SessionGuard` interface**
  - Add `SessionGuard` interface to `src/chat/orchestrator.ts` (or a shared types file): `isActive(id)`, `register(id)`, `unregister(id)`
  - This is needed by the orchestrator constructor change in A1.4, so define it first

- [ ] **A1.2 — Replace orchestrator fields on plugin class** (`src/main.ts`)
  - Delete `_orchestrator?: ChatOrchestrator` field (L145)
  - Delete `_secondaryOrchestrators: ChatOrchestrator[]` field (L155)
  - Add `_orchestrators = new Map<string, ChatOrchestrator>()`
  - Add `_activeConversationSessions = new Set<string>()` for session guard
  - Add `_sessionGuard: SessionGuard` implementation object (using `_activeConversationSessions`)
  - Add `_lastFocusedChatLeafId?: string` field (Amendment R2-5)

- [ ] **A1.3 — Register `active-leaf-change` listener** (`src/main.ts`)
  - In `onload()`, register `this.app.workspace.on('active-leaf-change', ...)` to track `_lastFocusedChatLeafId` when a `NotorChatView` gains focus

- [ ] **A1.4 — Update `ChatOrchestrator` constructor** (`src/chat/orchestrator.ts`)
  - Add `sessionGuard: SessionGuard` as a required parameter (before the optional `view` and `vaultRuleManager` params)
  - Store as `private readonly sessionGuard: SessionGuard`
  - Update all existing call sites that construct `ChatOrchestrator`

- [ ] **A1.5 — Create unified `createOrchestrator()` method** (`src/main.ts`)
  - Consolidate `getOrchestrator()` (L1585-1628) and `createSecondaryOrchestrator()` (L1640-1687) into a single `createOrchestrator()` that returns a new `ChatOrchestrator` every time
  - Follow Amendment R2-4 consolidated setup checklist:
    1. Construct `ChatOrchestrator` with shared singletons + `this._sessionGuard`
    2. Wire `PersonaManager` (`setPersonaManager`)
    3. Wire `WorkflowHookOverrideManager` (`setWorkflowHookOverrideManager`)
    4. Wire extension accessors (`setExtensionAccessors`)
    5. Set tool definitions (`setGetToolDefinitions`) — moved from `wireView()` (Amendment R3)
    6. Create per-orchestrator `CheckpointManager` and wire it (Amendment A1)
    7. `sessionGuard` already passed as constructor param
  - Do NOT call `personaManager.restoreFromSettings()` here (moves to `onload()` — Amendment R5)

- [ ] **A1.6 — Make `CheckpointManager` per-orchestrator** (`src/checkpoints/checkpoint.ts`, `src/main.ts`)
  - Remove singleton `_checkpointManager` field and `getCheckpointManager()` lazy getter from plugin class
  - Create a new `CheckpointManager` instance inside `createOrchestrator()` for each orchestrator
  - Pass the per-orchestrator checkpoint manager to the orchestrator (add a setter or constructor param)
  - Remove all `checkpointManager.setConversationId()` calls from `wireView()` callbacks (L2142, 2167, 2185, 2251, 2258, 2504, 2517, 2525) — orchestrator manages its own checkpoint manager's conversation scope internally

- [ ] **A1.7 — Move `personaManager.restoreFromSettings()` to `onload()`** (`src/main.ts`)
  - Currently called inside `wireView()` (L2061-2068), which runs on every wireView call
  - Move to `onload()` as a one-time global restore (Amendment R5)

- [ ] **A1.8 — Update `registerView` factory** (`src/main.ts`, L295-308)
  - In the factory callback:
    1. Check for stale orchestrator at `leaf.id` and destroy it if found (Amendment R2-7)
    2. Call `createOrchestrator()` to create a new orchestrator for this view
    3. Store in `_orchestrators.set(leaf.id, orchestrator)`
    4. Call `wireView(view, orchestrator)` (callbacks only — no history loading)
    5. Schedule `setTimeout(0)` fallback for conversation loading; store timeout ID on `view._loadFallbackTimeout` (Amendment R2-2)
  - Remove the old default-to-primary wireView pattern

- [ ] **A1.9 — Add `getActiveOrchestrator()` method** (`src/main.ts`)
  - Returns orchestrator for focused chat panel, falling back to `_lastFocusedChatLeafId`, then any open panel, then `null` (Amendment R2-5 pattern)

- [ ] **A1.10 — Add `getOrchestratorForView()` method** (`src/main.ts`)
  - Returns `_orchestrators.get(view.leaf.id) ?? null`
  - Used by `setState()` to find the correct orchestrator

- [ ] **A1.11 — Delete obsolete methods** (`src/main.ts`)
  - Delete `getOrchestrator()` (L1585-1628)
  - Delete `createSecondaryOrchestrator()` (L1640-1687)
  - Delete `wireViewAsSecondary()` (L1697-1716)
  - Delete `getPrimaryChatLeaf()` (L2576-2583)

---

## Phase A2: Conversation Loading Extraction

**Goal:** Extract conversation loading from `wireView()` into a single-owner `loadConversation()` method. Update `setState()` to use it.

**Files:** `src/main.ts`, `src/ui/chat-view.ts`, `src/chat/orchestrator.ts`

**Bugs addressed:** A (completes fix)

- [ ] **A2.1 — Add new fields to `NotorChatView`** (`src/ui/chat-view.ts`)
  - Add `isConversationLoaded: boolean = false`
  - Add `_loadConversationAbort?: AbortController`
  - Add `_loadFallbackTimeout?: ReturnType<typeof setTimeout>`

- [ ] **A2.2 — Thread `AbortSignal` into orchestrator switch methods** (`src/chat/orchestrator.ts`)
  - Update `switchConversation(filename, opts?: { signal?: AbortSignal })` — check `signal.aborted` after each `await` point and bail early (Amendment R2-1)
  - Update `switchToConversationById(id, opts?: { signal?: AbortSignal })` — same pattern
  - Update `newConversation(opts?: { signal?: AbortSignal })` — same pattern

- [ ] **A2.3 — Implement `loadConversation()` on plugin class** (`src/main.ts`)
  - Async method (Amendment R2-6 rewrite) that is the single owner of all conversation loading
  - Aborts any in-flight load for this view via `_loadConversationAbort`
  - Creates new `AbortController`, stores on view
  - Sets `view.isConversationLoaded = true`
  - Lists conversations, renders conversation list on view
  - Determines what to load: `savedFilename` > `savedId` > most-recent > new conversation
  - Passes `{ signal }` to all orchestrator switch/new calls
  - Calls `syncViewAfterLoad()` on success
  - See spec Section 4.5 / Amendment R2-6 for full implementation

- [ ] **A2.4 — Implement `syncViewAfterLoad()`** (`src/main.ts`)
  - Sets `view.setActiveConversationId(conv.id)` from orchestrator's active conversation
  - No checkpoint manager involvement (Amendment R7 / A1 handles that internally)

- [ ] **A2.5 — Rewrite `setState()`** (`src/ui/chat-view.ts`, L727-753)
  - Remove secondary panel detection (`isSecondary` checks, `wireViewAsSecondary()` call)
  - Remove deferred `setTimeout` blocks for `onSwitchConversation`/`onSwitchToConversationById`
  - New logic: if `!isConversationLoaded || savedConversationId`, call `plugin.loadConversation(this, orchestrator, savedState)` via `plugin.getOrchestratorForView(this)`
  - `setState()` overrides fallback loading when it fires later (Amendment A5) — AbortController handles the race

---

## Phase A3: wireView Simplification

**Goal:** Slim down `wireView()` to callback-wiring only. Remove all history loading and `isSecondary` logic.

**Files:** `src/main.ts`, `src/ui/chat-view.ts`

**Bugs addressed:** A (structural prevention), W1/W3/W5 (eliminated)

- [ ] **A3.1 — Remove history loading block from `wireView()`** (`src/main.ts`, L2493-2537)
  - Delete the entire `historyManager.listConversations().then(...)` block and all nested conversation loading logic
  - Delete the `if (view.getIsSecondary()) return` guard (L2495)

- [ ] **A3.2 — Remove orchestrator default fallback from `wireView()`** (`src/main.ts`, L1996-1998)
  - The `if (!orchestrator) { orchestrator = this.getOrchestrator(); }` fallback is no longer needed — orchestrator is always passed explicitly from the factory

- [ ] **A3.3 — Remove `setGetToolDefinitions()` from `wireView()`** (`src/main.ts`, L2073-2084)
  - Already moved to `createOrchestrator()` in A1.5 (Amendment R3)

- [ ] **A3.4 — Remove `personaManager.restoreFromSettings()` from `wireView()`** (`src/main.ts`, L2061-2068)
  - Already moved to `onload()` in A1.7 (Amendment R5)

- [ ] **A3.5 — Store session-change listener unregister function** (`src/main.ts`)
  - Add `_unregisterSessionsChanged?: () => void` field to `NotorChatView`
  - In `wireView()`: call `view._unregisterSessionsChanged?.()` before registering, then store the return value of `orchestrator.onSessionsChanged(...)` on `view._unregisterSessionsChanged`

- [ ] **A3.6 — Audit wireView closures for hardcoded orchestrator refs** (`src/main.ts`)
  - Amendment R1: All closures that reference `this._orchestrator`, `this.getOrchestrator()`, or `this._secondaryOrchestrators` must use the closure-captured `orchestrator` parameter or `this._orchestrators.values()`
  - Known instances:
    - `setOnNewConversation` (L2128-2129): `this._orchestrator.updateSettings()` → `orchestrator.updateSettings()`
    - Any other direct `_orchestrator` references in callbacks

- [ ] **A3.7 — Update `_personaNameChangeWired` callback** (`src/main.ts`, L2041-2060)
  - Amendment R6: Replace `[this._orchestrator, ...this._secondaryOrchestrators].filter(Boolean)` with `[...this._orchestrators.values()]`

- [ ] **A3.8 — Add `clearCallbacks()` method to `NotorChatView`** (`src/ui/chat-view.ts`)
  - Nulls all 27+ `setOn*` / callback properties to release GC references (Amendment A6)
  - Called from `onClose()` after cleanup callback (Amendment R2-8 ordering)

- [ ] **A3.9 — Remove all `checkpointManager.setConversationId()` from wireView callbacks** (`src/main.ts`)
  - Remove from switch conversation callback (~L2167), new conversation callback (~L2142), fork callback (~L2185), delete callback (~L2251, 2258), and history loading blocks (~L2504, 2517, 2525)
  - Per Amendment A1: the orchestrator manages its own checkpoint manager internally

---

## Phase A4: Command Routing + Eliminated Code

**Goal:** Route all commands to the focused panel. Delete all `isSecondary` infrastructure. Wire `UseSubAgentTool` via dispatch context.

**Files:** `src/main.ts`, `src/ui/chat-view.ts`, `src/chat/dispatcher.ts` (or tool-dispatcher equivalent), `src/ui/effective-config-inspector.ts`

**Bugs addressed:** Settings propagation bug, correct command targeting

- [ ] **A4.1 — Update all `getOrchestrator()` call sites to `getActiveOrchestrator()`** (`src/main.ts`)
  - Inspector view factory (L313) — see A4.5 instead
  - Manual compaction command (L335)
  - Run workflow command (L368)
  - Active note workflow command (L424)
  - Export conversation (L451)
  - Import conversation (L499)
  - New conversation command (L2612-2615)
  - Add null guards (`?.`) since `getActiveOrchestrator()` can return `null`

- [ ] **A4.2 — Fix settings propagation** (`src/main.ts`, L1218-1220)
  - Replace `if (this._orchestrator) { this._orchestrator.updateSettings(...) }` with iteration: `for (const orch of this._orchestrators.values()) { orch.updateSettings(this.settings); }`
  - Also update the settings change handler around L2128-2135

- [ ] **A4.3 — Update vault event dispatcher** (`src/main.ts`, L970-982)
  - Replace `orchestrator: this.getOrchestrator()` with `orchestrator: this.getActiveOrchestrator()` in `getDispatcherDeps()` (Amendment A7/R8)
  - Ensure the dispatcher handles `null` orchestrator gracefully (skip workflow execution)

- [ ] **A4.4 — Wire `UseSubAgentTool` via dispatch context** (`src/main.ts`, L1425-1441; `src/chat/dispatcher.ts`)
  - Amendment A2/R9: Extend tool execute options with an optional `sourceOrchestrator` field
  - The orchestrator passes itself when dispatching tool calls in a session
  - `UseSubAgentTool` reads orchestrator from options to resolve effective tool config and active conversation
  - Keep closure accessors as fallback for non-session contexts

- [ ] **A4.5 — Update inspector view to subscribe to focus changes** (`src/ui/effective-config-inspector.ts`)
  - Amendment A4: Subscribe to `workspace.on('active-leaf-change')`
  - When a chat panel gains focus, update orchestrator reference via `setOrchestrator()`
  - When a non-chat leaf gains focus, retain last orchestrator
  - Unsubscribe on inspector close

- [ ] **A4.6 — Delete `isSecondary` infrastructure** (`src/ui/chat-view.ts`)
  - Delete `isSecondary` field (L171)
  - Delete `getIsSecondary()` method (L756-758)
  - Delete `setIsSecondary()` method (L761-763)
  - Remove `isSecondary` from `getState()` return (L714)
  - Remove all `isSecondary` detection from `setState()` (L731-738)

- [ ] **A4.7 — Simplify "open-secondary-chat" command** (`src/main.ts`, L534)
  - Remove `state: { isSecondary: true }` from the leaf state — just open a new leaf
  - The factory creates a fresh orchestrator automatically

- [ ] **A4.8 — Update `onunload()`** (`src/main.ts`, L642-690)
  - Replace separate destroy loops for `_orchestrator` and `_secondaryOrchestrators` with:
    ```
    for (const orch of this._orchestrators.values()) { orch.destroy().catch(...); }
    this._orchestrators.clear();
    ```

---

## Phase A5: Persistence Flush

**Goal:** Ensure all JSONL writes complete before session cleanup and plugin unload.

**Files:** `src/chat/history.ts`, `src/chat/orchestrator.ts`

**Bugs addressed:** B

- [ ] **A5.1 — Add `flush()` method to `HistoryManager`** (`src/chat/history.ts`)
  - Awaits all pending write queues via `Promise.allSettled(Array.from(this.writeQueues.values()))`
  - Safe to call when no writes are pending (returns immediately)

- [ ] **A5.2 — Add `flushConversation()` method to `HistoryManager`** (`src/chat/history.ts`)
  - Takes a `Conversation` object (not just ID — filename requires `created_at` + `id`)
  - Resolves the file path via `getFilename()` + `getFilePath()`
  - Awaits the pending write for that specific file path from `writeQueues`

- [ ] **A5.3 — Await `flushConversation()` in `handleUserMessage()` finally block** (`src/chat/orchestrator.ts`, L1828-1835)
  - Before `this.activeSessions.delete(...)`, await `this.historyManager.flushConversation(conv)` wrapped in try/catch (best-effort)
  - Get `conv` from `session.conversationManager.getActiveConversation()`

- [ ] **A5.4 — Await `flushConversation()` in `executeWorkflow()` finally block** (`src/chat/orchestrator.ts`, L942-953)
  - Same pattern as A5.3

- [ ] **A5.5 — Add workflow hook deactivation to both finally blocks** (`src/chat/orchestrator.ts`)
  - In both `handleUserMessage` and `executeWorkflow` finally blocks, call `workflowHookOverrideManager.deactivate(session.conversationId)` if the session has a `workflowAssembly`
  - Ensure `deactivate()` is idempotent (Amendment R4) — it may also be called from `destroy()`

- [ ] **A5.6 — Enhance `destroy()` with flush + hook cleanup + guard unregister** (`src/chat/orchestrator.ts`, L434-454)
  - After existing session abort + await logic:
    1. Deactivate workflow hook overrides for all active sessions
    2. Flush all pending writes via `historyManager.flush()` with timeout (half of `timeoutMs`, min 500ms)
    3. Unregister all active session IDs from `sessionGuard` before clearing the map
    4. Then `activeSessions.clear()` and `sessionChangeCallbacks.clear()`

---

## Phase A6: Session Guard

**Goal:** Prevent two orchestrators from creating sessions for the same conversation.

**Files:** `src/chat/orchestrator.ts`, `src/main.ts`

**Bugs addressed:** D

- [ ] **A6.1 — Add cross-orchestrator guard to `handleUserMessage()`** (`src/chat/orchestrator.ts`, after L1614-1617)
  - After the existing per-orchestrator `activeSessions.has(conv.id)` check, add: `if (this.sessionGuard.isActive(conv.id)) { new Notice("This conversation is being processed in another panel."); return; }`
  - After both guards pass: `this.sessionGuard.register(conv.id)`

- [ ] **A6.2 — Add both guards to `executeWorkflow()`** (`src/chat/orchestrator.ts`)
  - Amendment A3: `executeWorkflow()` currently has NO `activeSessions.has(conv.id)` guard — add it
  - Then add cross-orchestrator `sessionGuard.isActive()` check
  - Then `sessionGuard.register(conv.id)` before creating session

- [ ] **A6.3 — Add `sessionGuard.unregister()` to cleanup paths** (`src/chat/orchestrator.ts`)
  - In `handleUserMessage()` finally block: add `this.sessionGuard.unregister(session.conversationId)` before `activeSessions.delete()`
  - In `executeWorkflow()` finally block: same pattern
  - In `destroy()`: loop all `activeSessions.keys()` and unregister before clearing

---

## Phase A7: View Close Lifecycle

**Goal:** Handle panel closure gracefully — detach view, drain sessions, destroy orchestrator.

**Files:** `src/ui/chat-view.ts`, `src/main.ts`, `src/chat/orchestrator.ts`

**Bugs addressed:** Lifecycle robustness (renders to destroyed DOM, hanging approvals, orchestrator leaks)

- [ ] **A7.1 — Update `setView()` to accept `undefined`** (`src/chat/orchestrator.ts`, L196-198)
  - Change signature from `setView(view: NotorChatView)` to `setView(view: NotorChatView | undefined)`
  - Existing `this.view?.` guards throughout the orchestrator already handle `undefined`

- [ ] **A7.2 — Add close cleanup infrastructure to `NotorChatView`** (`src/ui/chat-view.ts`)
  - Add `onCloseCleanup?: () => Promise<void>` field
  - Add `setOnCloseCleanup(cb: () => Promise<void>)` setter

- [ ] **A7.3 — Wire close cleanup in `wireView()`** (`src/main.ts`)
  - Set `view.setOnCloseCleanup(async () => { ... })` that:
    1. Clears fallback timeout: `clearTimeout(view._loadFallbackTimeout)` (Amendment R2-2)
    2. Detaches view: `orchestrator.setView(undefined)`
    3. Cleans up session listener: `view._unregisterSessionsChanged?.()`
    4. Removes from registry: `this._orchestrators.delete(leafId)`
    5. Awaits `orchestrator.destroy()` (Amendment R2-3 — async + awaited)

- [ ] **A7.4 — Update `onClose()`** (`src/ui/chat-view.ts`, L670-698)
  - Make async: `async onClose(): Promise<void>`
  - At the start: `await this.onCloseCleanup?.()`
  - After cleanup: `this.clearCallbacks()` (Amendment R2-8 ordering)
  - Keep existing DOM cleanup code after

---

## Phase A-Verify: Verification & Regression Testing

**Goal:** Confirm all bug fixes and no regressions.

- [ ] **AV.1 — Bug A verification: Panel restore doesn't destroy primary panel state**
  - Open chat panel with active conversation A
  - Open second panel, close it, Cmd+Shift+T to reopen
  - Verify: first panel still shows conversation A with full history
  - Verify: second panel loads independently

- [ ] **AV.2 — Bug B verification: Persistence flush prevents message loss**
  - Send several messages rapidly, close plugin immediately
  - Reopen and verify all messages present in JSONL
  - Start streaming response, wait for completion, close plugin immediately
  - Reopen and verify complete response in JSONL

- [ ] **AV.3 — Bug D verification: Cross-panel session guard**
  - Open same conversation in two panels
  - Send message in one, try to send in other while streaming
  - Verify: "being processed in another panel" notice appears
  - Wait for completion, verify can now send from either panel

- [ ] **AV.4 — Command routing verification**
  - Open two panels side by side
  - Focus panel 2, run workflow from command palette → verify executes in panel 2
  - Focus panel 1, run "New conversation" → verify created in panel 1

- [ ] **AV.5 — Settings propagation verification**
  - Open two panels, change a setting → verify both panels reflect the update

- [ ] **AV.6 — Regression: Existing E2E tests pass**
  - `e2e/scripts/session-sync-back-test.ts`
  - `e2e/scripts/phase4-multi-panel-test.ts`
  - `e2e/scripts/phase5-open-in-new-tab-test.ts`

- [ ] **AV.7 — Regression: Core functionality**
  - Single-panel chat: new conversation, send messages, switch conversations
  - Workflow execution (foreground + background)
  - Plugin hot-reload preserves state
  - Workspace restore with multiple panels restores each panel's conversation

---

## Phase B: Orchestrator Decomposition (Medium-Term)

**Goal:** Break up the ~2,976-line `ChatOrchestrator` into focused, independently testable classes behind the existing facade.

**Prerequisite:** Phase A complete.

**Files:** New files + `src/chat/orchestrator.ts`

### B1: Extract ViewRouter

- [ ] **B1.1 — Create `src/chat/view-router.ts`**
  - Extract view routing responsibility: `setView()`, `getViewForSession()`, `renderMessage()`, `updateDisplayConfig()`
  - Extract fields: `view` (L165), `effectiveToolConfig` (L107), `activeParsedConfigs` (L99)

- [ ] **B1.2 — Wire ViewRouter into orchestrator**
  - Orchestrator delegates view-related calls to ViewRouter
  - Public API of ChatOrchestrator remains stable

### B2: Extract SessionManager

- [ ] **B2.1 — Create `src/chat/session-manager.ts`**
  - Extract session lifecycle: session creation from `handleUserMessage()` (L1729-1804) and `executeWorkflow()` (L860-924), `destroy()` (L434-454)
  - Extract fields: `activeSessions` (L148), `sessionChangeCallbacks` (L156)
  - Include `SessionGuard` integration

- [ ] **B2.2 — Wire SessionManager into orchestrator**
  - Orchestrator delegates session operations to SessionManager
  - Public API of ChatOrchestrator remains stable

### B3: Extract ConversationLifecycleManager

- [ ] **B3.1 — Create `src/chat/conversation-lifecycle.ts`**
  - Extract conversation CRUD: `newConversation()` (L467-513), `switchConversation()` (L560-675), `forkConversation()` (L525-552), `switchToConversationById()` (L677-700)
  - Extract fields: `conversationManager` (L64), `workflowPreviousPersona` (L90)

- [ ] **B3.2 — Wire ConversationLifecycleManager into orchestrator**
  - Orchestrator delegates conversation operations to lifecycle manager
  - Public API of ChatOrchestrator remains stable

### B4: Extract ConfigResolver

- [ ] **B4.1 — Create `src/chat/config-resolver.ts`**
  - Extract `resolveEffectiveConfig()` (L1508-1567)
  - Already pure (returns result, no mutations) — cleanest extraction

- [ ] **B4.2 — Wire ConfigResolver into orchestrator**
  - Orchestrator delegates config resolution
  - Public API of ChatOrchestrator remains stable

---

## Phase C: Centralized State (Optional, Long-Term)

**Goal:** Replace ad-hoc callback sync with a lightweight observable state pattern per orchestrator.

**Prerequisite:** Phase B complete.

- [ ] **C1 — Design `OrchestratorState` interface**
  - `displayedConversation`, `messages`, `isResponding`, `activeSessions`, `effectiveConfig`, `parsedConfigs`

- [ ] **C2 — Implement `StateStore` class**
  - Immutable update pattern: `update(patch)` creates new state, notifies subscribers
  - `subscribe(fn)` returns unsubscriber

- [ ] **C3 — Migrate orchestrator internals to StateStore**
  - Replace direct field mutations with `store.update()`
  - Replace callback registrations with `store.subscribe()`

- [ ] **C4 — Migrate view layer to subscribe to state**
  - `NotorChatView` subscribes to orchestrator's state store
  - Remove manual callback wiring from `wireView()`
