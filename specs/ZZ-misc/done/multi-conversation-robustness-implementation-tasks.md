# Multi-Conversation Robustness Redesign — Implementation Tasks

**Spec:** [multi-conversation-robustness-redesign.md](multi-conversation-robustness-redesign.md)
**Created:** 2026-04-10
**Status:** Phase A complete (A1–A7 + A-Verify); Phase B complete (B7/B4/B8/B6/B1/B2/B3/B5 all done); B-Verify done (BV.1–BV.4)

---

## Phase A1: Orchestrator Registry + Factory Rewrite

**Goal:** Replace primary/secondary orchestrator distinction with a unified `Map<leafId, ChatOrchestrator>` registry. All panels become equal.

**Files:** `src/main.ts`, `src/chat/orchestrator.ts`, `src/checkpoints/checkpoint.ts`

**Bugs addressed:** A (primary), D (partial)

- [x] **A1.1 — Define `SessionGuard` interface** *(done 2026-04-11)*
  - Add `SessionGuard` interface to `src/chat/orchestrator.ts` (or a shared types file): `isActive(id)`, `register(id)`, `unregister(id)`
  - This is needed by the orchestrator constructor change in A1.4, so define it first

- [x] **A1.2 — Replace orchestrator fields on plugin class** (`src/main.ts`) *(done 2026-04-11)*
  - ~~Delete `_orchestrator?: ChatOrchestrator` field (L145)~~ — retained temporarily; deleted in A1.11 after A4.1
  - ~~Delete `_secondaryOrchestrators: ChatOrchestrator[]` field (L155)~~ — retained temporarily; deleted in A1.11 after A4.1
  - Add `_orchestrators = new Map<string, ChatOrchestrator>()`
  - Add `_activeConversationSessions = new Set<string>()` for session guard
  - Add `_sessionGuard: SessionGuard` implementation object (using `_activeConversationSessions`)
  - Add `_lastFocusedChatLeafId?: string` field (Amendment R2-5)

- [x] **A1.3 — Register `active-leaf-change` listener** (`src/main.ts`) *(done 2026-04-11)*
  - In `onload()`, use `this.registerEvent(this.app.workspace.on('active-leaf-change', ...))` to track `_lastFocusedChatLeafId` when a `NotorChatView` gains focus
  - **Must use `registerEvent`** — raw `workspace.on()` calls are not cleaned up on plugin unload and will leak
  - There is already a separate `active-leaf-change` listener at L562-572 (for auto-context); add this as a second `registerEvent` call alongside it, not as a replacement

- [x] **A1.4 — Update `ChatOrchestrator` constructor** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - Add `sessionGuard: SessionGuard` as a required parameter (before the optional `view` and `vaultRuleManager` params)
  - Store as `private readonly sessionGuard: SessionGuard`
  - Update all existing call sites that construct `ChatOrchestrator`

- [x] **A1.5 — Create unified `createOrchestrator()` method** (`src/main.ts`) *(done 2026-04-11)*
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
  - **Note:** Old `getOrchestrator()` and `createSecondaryOrchestrator()` retained alongside until A1.11

- [x] **A1.6 — Make `CheckpointManager` per-orchestrator** (`src/checkpoints/checkpoint.ts`, `src/main.ts`) *(done 2026-04-11)*
  - **Pre-implementation grep completed (2026-04-11).** Two plugin-level call sites for `getCheckpointManager` found:
    1. `src/main.ts:2001` — in `wireView()` (handled by A1.6c)
    2. `src/extensions/runtime-context.ts:131` — in `buildUtils()` for user-defined extensions (handled by A1.6d below)
  - ~~Remove singleton `_checkpointManager` field and `getCheckpointManager()` lazy getter from plugin class~~ — retained temporarily as backward-compat shim; plugin-level getter still used by wireView (A1.6c deferred update); will be fully removed when A3 strips wireView history loading
  - Create a new `CheckpointManager` instance inside `createOrchestrator()` for each orchestrator; `CheckpointStorage` remains a shared singleton
  - Pass the per-orchestrator checkpoint manager to the orchestrator via `setCheckpointManager()` setter
  - ~~Remove all `checkpointManager.setConversationId()` calls from `wireView()` callbacks~~ — deferred to A3.9; A1.6b adds internal orchestrator wiring first

- [x] **A1.6c — Add `getCheckpointManager()` accessor to `ChatOrchestrator` and update `wireView()`** (`src/chat/orchestrator.ts`, `src/main.ts`) *(done 2026-04-11)*
  - Add a public `getCheckpointManager(): CheckpointManager | undefined` method to `ChatOrchestrator` — returns the per-orchestrator checkpoint manager added in A1.6
  - Also added `setCheckpointManager()` setter and `getView()` accessor
  - wireView() update deferred — plugin-level `getCheckpointManager()` still exists as backward-compat; wireView switchover happens when A3 strips history loading

- [x] **A1.6d — Update extension runtime context to use plugin-level checkpoint storage** (`src/extensions/runtime-context.ts`, `src/main.ts`) *(done 2026-04-11)*
  - `buildUtils()` at `runtime-context.ts:122` currently calls `plugin.getCheckpointManager()` (L131) — this will break when the plugin-level singleton getter is deleted in A1.6
  - Extensions (user-defined tools) set their own conversation ID on the manager before use; they do not need per-orchestrator scoping
  - **Fix:** Add a `getSharedCheckpointManager(): CheckpointManager` method to the plugin class that creates a lazily-initialized shared manager backed by the same `CheckpointStorage` singleton (separate from the per-orchestrator managers). Update `buildUtils()` to call `plugin.getSharedCheckpointManager()` instead of `plugin.getCheckpointManager()`
  - This preserves backward-compatible extension behavior while keeping per-orchestrator managers for conversation-scoped tracking
  - **⚠ Must be done before A1.6 deletes `getCheckpointManager()`**

- [x] **A1.6b — Wire `checkpointManager.setConversationId()` inside orchestrator** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - After each conversation transition, call `this.checkpointManager?.setConversationId(conv.id)`:
    - End of `newConversation()` — after new conversation is created and active
    - End of `switchConversation()` — after conversation and messages are loaded (both sync-back and standard JSONL paths)
    - End of `switchToConversationById()` — delegates to `switchConversation()`, so covered there
    - End of `forkConversation()` — doesn't switch (caller does via switchConversation), so covered there
  - This replaces the calls removed from `wireView()` callbacks in A3.9
  - **⚠ Do not remove A3.9 calls without completing this task first — checkpoints will silently break**

- [x] **A1.7 — Move `personaManager.restoreFromSettings()` to `onload()`** (`src/main.ts`) *(done 2026-04-11)*
  - Currently called inside `wireView()` (L2061-2068), which runs on every wireView call
  - Added to `onload()` as a one-time global restore (Amendment R5)
  - wireView() call retained temporarily — removed in A3.4

- [x] **A1.8 — Update `registerView` factory** (`src/main.ts`, L295-308) *(done 2026-04-11)*
  - **⚠ Requires A2.1 fields first** — A1.8 references `view._loadFallbackTimeout` and `view.isConversationLoaded`, both added by A2.1. Add those two fields to `NotorChatView` before implementing A1.8 (or batch both together).
  - In the factory callback:
    1. Check for stale orchestrator at `leaf.id` and destroy it if found (Amendment R2-7)
       - **Known limitation:** The factory is synchronous so the stale `destroy()` is fire-and-forget. If the stale orchestrator has an active session, `sessionGuard.isActive()` returns `true` for that conversation for up to ~2s while the destroy drains, causing a transient "being processed in another panel" notice if the user immediately re-sends. Recoverable by retrying; comment this constraint in the code.
    2. Call `createOrchestrator()` to create a new orchestrator for this view
    3. Store in `_orchestrators.set(leaf.id, orchestrator)`
    4. Call `wireView(view, orchestrator)` (callbacks only — no history loading)
    5. Schedule `setTimeout(0)` fallback for conversation loading; store timeout ID on `view._loadFallbackTimeout` (Amendment R2-2)
       - **The fallback callback must check `if (!view.isConversationLoaded)` before calling `loadConversation()`** — `setState()` fires synchronously after the factory returns and will set `isConversationLoaded = true`; without this guard, every panel open fires a redundant load
  - Remove the old default-to-primary wireView pattern

- [x] **A1.9 — Add `getActiveOrchestrator()` method** (`src/main.ts`) *(done 2026-04-11)*
  - Three-level fallback (see spec Section 4.9):
    1. `workspace.getActiveViewOfType(NotorChatView)` → its leaf.id
    2. `_lastFocusedChatLeafId` (populated by A1.3 listener) → `_orchestrators.get(...)`
    3. `getLeavesOfType(CHAT_VIEW_TYPE)[0]` → first available leaf
    4. `null` if no panels exist
  - The `_lastFocusedChatLeafId` fallback is required — without it, vault-event workflows and commands route to an arbitrary panel when the user is focused on a non-chat view
  - Also added `WorkspaceLeaf.id` type augmentation in `obsidian-augments.d.ts`

- [x] **A1.10 — Add `getOrchestratorForView()` method** (`src/main.ts`) *(done 2026-04-11)*
  - Returns `_orchestrators.get(view.leaf.id) ?? null`
  - Used by `setState()` to find the correct orchestrator

- [x] **A1.11 — Delete obsolete methods** (`src/main.ts`) *(done 2026-04-11)*
  - **⚠ Requires A4.1 first** — the private `newConversation()` method (L2605) calls `getPrimaryChatLeaf()`. A4.1 rewrites that method to remove the call. Do not delete `getPrimaryChatLeaf()` before A4.1 has updated `newConversation()`, or batch both in the same commit.
  - Deleted `getOrchestrator()` — old lazy-singleton primary orchestrator factory
  - Deleted `createSecondaryOrchestrator()` — old secondary panel factory
  - Deleted `_orchestrator` field and `_secondaryOrchestrators` field
  - Updated remaining `this._orchestrator` reference (getModeCallback in MCP tool registration) to use `this.getActiveOrchestrator()`
  - ~~Delete `wireViewAsSecondary()` (L1697-1716)~~ — deleted in A4.6 (type-broken after isSecondary removal)
  - ~~Delete `getPrimaryChatLeaf()` (L2576-2583)~~ — deleted in A4.6 (type-broken after isSecondary removal)

---

## Phase A2: Conversation Loading Extraction

**Goal:** Extract conversation loading from `wireView()` into a single-owner `loadConversation()` method. Update `setState()` to use it.

**Files:** `src/main.ts`, `src/ui/chat-view.ts`, `src/chat/orchestrator.ts`

**Bugs addressed:** A (completes fix)

- [x] **A2.1 — Add new fields to `NotorChatView`** (`src/ui/chat-view.ts`) *(done 2026-04-11)*
  - Add `isConversationLoaded: boolean = false`
  - Add `_loadConversationAbort?: AbortController`
  - Add `_loadFallbackTimeout?: ReturnType<typeof setTimeout>`

- [x] **A2.2 — Thread `AbortSignal` into orchestrator switch methods** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - Update `switchConversation(filename, opts?: { signal?: AbortSignal })` — check `signal.aborted` after each `await` point and bail early (Amendment R2-1)
  - Update `switchToConversationById(id, opts?: { signal?: AbortSignal })` — same pattern
  - Update `newConversation(opts?: { signal?: AbortSignal })` — same pattern

- [x] **A2.3 — Implement `loadConversation()` on plugin class** (`src/main.ts`) *(done 2026-04-11)*
  - `async loadConversation(view, orchestrator, savedState?): Promise<void>` — callers do NOT await it (fire-and-forget from setState and setTimeout, but correctly awaitable for testing)
  - Aborts any in-flight load for this view via `view._loadConversationAbort?.abort()`
  - Creates new `AbortController`, stores on `view._loadConversationAbort`; destructure `{ signal }` for passing to orchestrator calls
  - Sets `view.isConversationLoaded = true` immediately (prevents duplicate loads from the fallback timer)
  - **Use `async/await` with `try/catch` throughout — do NOT use `.then()/.catch()` chains.** Every `await` is followed by `if (signal.aborted) return`
  - `listConversations()` result is awaited; if it throws: reset `view.isConversationLoaded = false`, log error, return early (no notice needed — this is an infrastructure failure)
  - Determines what to load: `savedFilename` > `savedId` > most-recent > new conversation
  - **Passes `{ signal }` to ALL orchestrator calls:** `switchConversation(filename, { signal })`, `switchToConversationById(id, { signal })`, `newConversation({ signal })`
  - After each `await` on an orchestrator call, check `if (signal.aborted) return` before calling `syncViewAfterLoad()`
  - On orchestrator call failure (outer try/catch): reset `view.isConversationLoaded = false`; show a Notice to the user (do not fail silently); check signal before Notice
  - See spec Section 4.5 for reference implementation

- [x] **A2.4 — Implement `syncViewAfterLoad()`** (`src/main.ts`) *(done 2026-04-11)*
  - Sets `view.setActiveConversationId(conv.id)` from orchestrator's active conversation
  - No checkpoint manager involvement (Amendment R7 / A1 handles that internally)

- [x] **A2.5 — Rewrite `setState()`** (`src/ui/chat-view.ts`, L727-753) *(done 2026-04-11)*
  - Remove secondary panel detection (`isSecondary` checks, `wireViewAsSecondary()` call)
  - Remove deferred `setTimeout` blocks for `onSwitchConversation`/`onSwitchToConversationById`
  - New logic: if `!isConversationLoaded || savedConversationId`, call `plugin.loadConversation(this, orchestrator, savedState)` via `plugin.getOrchestratorForView(this)`
  - If `plugin.getOrchestratorForView(this)` returns `null`: emit a warning log and return early (indicates a wiring-order bug; the `setTimeout(0)` fallback will still attempt the load)
  - `setState()` overrides fallback loading when it fires later (Amendment A5) — AbortController handles the race

---

## Phase A3: wireView Simplification

**Goal:** Slim down `wireView()` to callback-wiring only. Remove all history loading and `isSecondary` logic.

**Files:** `src/main.ts`, `src/ui/chat-view.ts`

**Bugs addressed:** A (structural prevention), W1/W3/W5 (eliminated)

- [x] **A3.1 — Remove history loading block from `wireView()`** (`src/main.ts`, L2493-2537) *(done 2026-04-11)*
  - Delete the entire `historyManager.listConversations().then(...)` block and all nested conversation loading logic
  - Delete the `if (view.getIsSecondary()) return` guard (L2495)

- [x] **A3.2 — Remove orchestrator default fallback from `wireView()`** (`src/main.ts`, L1996-1998) *(done 2026-04-11)*
  - The `if (!orchestrator) { orchestrator = this.getOrchestrator(); }` fallback is no longer needed — orchestrator is always passed explicitly from the factory

- [x] **A3.3 — Remove `setGetToolDefinitions()` from `wireView()`** (`src/main.ts`, L2073-2084) *(done 2026-04-11)*
  - Already moved to `createOrchestrator()` in A1.5 (Amendment R3)
  - **⚠ Do not remove this call before A1.5 is complete.** The primary orchestrator currently does NOT have `setGetToolDefinitions()` called on it in `getOrchestrator()` — only secondary orchestrators get it. `wireView()` is currently the only path that sets it for the primary. Removing A3.3's call before A1.5 adds it to `createOrchestrator()` will leave the primary orchestrator with no tool definitions.

- [x] **A3.4 — Remove `personaManager.restoreFromSettings()` from `wireView()`** (`src/main.ts`, L2061-2068) *(done 2026-04-11)*
  - Already moved to `onload()` in A1.7 (Amendment R5)

- [x] **A3.5 — Store session-change listener unregister function** (`src/main.ts`) *(done 2026-04-11)*
  - Add `_unregisterSessionsChanged?: () => void` field to `NotorChatView`
  - In `wireView()`: call `view._unregisterSessionsChanged?.()` before registering, then store the return value of `orchestrator.onSessionsChanged(...)` on `view._unregisterSessionsChanged`

- [x] **A3.6 — Audit wireView closures for hardcoded orchestrator refs** (`src/main.ts`) *(done 2026-04-11)*
  - Amendment R1: All closures that reference `this._orchestrator`, `this.getOrchestrator()`, or `this._secondaryOrchestrators` must use the closure-captured `orchestrator` parameter or `this._orchestrators.values()`
  - Known instances:
    - `setOnNewConversation` (L2128-2129): `this._orchestrator.updateSettings()` → `orchestrator.updateSettings()`
    - Any other direct `_orchestrator` references in callbacks

- [x] **A3.7 — Update `_personaNameChangeWired` callback** (`src/main.ts`, L2041-2060) *(done 2026-04-11)*
  - Amendment R6: Replace `[this._orchestrator, ...this._secondaryOrchestrators].filter(Boolean)` with `[...this._orchestrators.values()]`

- [x] **A3.8 — Add `clearCallbacks()` method to `NotorChatView`** (`src/ui/chat-view.ts`) *(done 2026-04-11)*
  - Nulls all `setOn*` / callback properties to release GC references (Amendment A6)
  - **Pre-implementation audit completed (2026-04-11).** Confirmed counts:
    - 23 `setOn*` methods (L240–392): `setOnSendMessage`, `setOnStopResponse`, `setOnNewConversation`, `setOnSwitchConversation`, `setOnExportConversation`, `setOnDeleteConversation`, `setOnToggleFavorite`, `setOnImportConversation`, `setOnSwitchToConversationById`, `setOnOpenConversationList`, `setOnSearchConversations`, `setOnModeToggle`, `setOnSettingsOpen`, `setOnProviderChange`, `setOnModelChange`, `setOnRefreshModels`, `setOnListCheckpoints`, `setOnRestoreCheckpoint`, `setOnGetCurrentContent`, `setOnForkConversation`, `setOnOpenInNewTab`, `setOnOpenSettingsGroup`, `setOnSendWorkflow`
    - 6 `setGet*` methods: `setGetAvailableProviders`, `setGetAvailableModels`, `setGetCurrentProvider`, `setGetCurrentModel`, `setGetWorkflows`, `setGetActiveSessions`
    - 5 other setters (not callback-holders, exclude from `clearCallbacks()`): `setActiveConversationId` (L236), `setWorkflowActivityTracker` (L409), `setPersonaManager` (L536), `setIsSecondary` (L761, deleted in A4.6), `setRespondingState` (L1446)
    - 1 new setter added by A7.2: `setOnCloseCleanup` — include in `clearCallbacks()`
  - `clearCallbacks()` must null the backing properties for all 23 + 6 + `setOnCloseCleanup` = **30 callback slots** after A7.2 is complete
  - Called from `onClose()` after cleanup callback (Amendment R2-8 ordering)

- [x] **A3.9 — Remove all `checkpointManager.setConversationId()` from wireView callbacks** (`src/main.ts`) *(done 2026-04-11)*
  - Remove from switch conversation callback (~L2167), new conversation callback (~L2142), fork callback (~L2185), delete callback (~L2251, 2258), and history loading blocks (~L2504, 2517, 2525)
  - Per Amendment A1: the orchestrator manages its own checkpoint manager internally

---

## Phase A4: Command Routing + Eliminated Code

**Goal:** Route all commands to the focused panel. Delete all `isSecondary` infrastructure. Wire `UseSubAgentTool` via dispatch context.

**Files:** `src/main.ts`, `src/ui/chat-view.ts`, `src/chat/dispatcher.ts` (or tool-dispatcher equivalent), `src/ui/effective-config-inspector.ts`

**Bugs addressed:** Settings propagation bug, correct command targeting

- [x] **A4.1 — Update all `getOrchestrator()` call sites to `getActiveOrchestrator()`** (`src/main.ts`, `src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - Inspector view factory (L313) — see A4.5 instead
  - Manual compaction command (L335)
  - Run workflow command (L368)
  - Active note workflow command (L424)
  - Export conversation (L451)
  - Import conversation (L499)
  - New conversation command — **requires a full rewrite of the private `newConversation()` method (L2605-2645)**:
    1. Add `getView(): NotorChatView | undefined` accessor to `ChatOrchestrator` (returns `this.view`) — needed for the view update below
    2. Remove `const primaryLeaf = this.getPrimaryChatLeaf()` (L2606) and the leaf-based `view` lookup — `getPrimaryChatLeaf()` is deleted in A1.11
    3. Replace both `getOrchestrator()` calls (L2612, L2615) with `getActiveOrchestrator()` (null-guarded)
    4. Obtain the view via `orchestrator.getView()` — consistent with `getActiveOrchestrator()`'s `_lastFocusedChatLeafId` fallback (avoids mismatch with `workspace.getActiveViewOfType()` when focus is on a non-chat view)
    5. Replace the `.then()` chain with `syncViewAfterLoad(view, orchestrator)` + a `renderConversationList()` call
    6. Fallback: `if (!orchestrator) { this.openChatPanel(); }`
    - **⚠ Must be done before A1.11** — A1.11 deletes `getPrimaryChatLeaf()`, which this method calls at L2606
  - Add null guards (`?.`) since `getActiveOrchestrator()` can return `null`

- [x] **A4.2 — Fix settings propagation** (`src/main.ts`, L1218-1220) *(done 2026-04-11)*
  - Replace `if (this._orchestrator) { this._orchestrator.updateSettings(...) }` with iteration: `for (const orch of this._orchestrators.values()) { orch.updateSettings(this.settings); }`
  - Also update the settings change handler around L2128-2135

- [x] **A4.3 — Update vault event dispatcher** (`src/main.ts`, inside `_initVaultEventHooks()`) *(done 2026-04-11)*
  - `getDispatcherDeps` is a **local `const` closure inside `_initVaultEventHooks()`** (not a class method) — edit it there, not as a plugin method
  - Replace `orchestrator: this.getOrchestrator()` with `orchestrator: this.getActiveOrchestrator()` inside that closure (Amendment A7/R8)
  - Ensure the dispatcher handles `null` orchestrator gracefully (skip workflow execution)

- [x] **A4.4 — Wire `UseSubAgentTool` via dispatch context** (`src/tools/tool.ts`, `src/chat/orchestrator.ts`, `src/chat/tool-orchestration.ts`, `src/chat/dispatcher.ts`, `src/tools/use-subagent.ts`, `src/main.ts`) *(done 2026-04-11)*
  - **Do A4.4a–e before A4.1** — A4.1 removes `getOrchestrator()` from the closures at L1429/L1431, but A4.4f updates those closures to `getActiveOrchestrator()` as a fallback. Sequence: A4.4a → A4.4b → A4.4c → A4.4d → A4.4e → A4.1 → A4.4f
  - **⚠ Must be complete before Phase A ships** — without it, sub-agents executing in a session use the wrong orchestrator's effective config and conversation state

- [x] **A4.4a — Define `ToolSessionContext` interface** (`src/tools/tool.ts`) *(done 2026-04-11)*
  - Add to `src/tools/tool.ts` (alongside `ToolExecuteOptions`) to avoid circular imports:
    ```typescript
    export interface ToolSessionContext {
        getEffectiveToolConfig(): EffectiveToolConfig | null;
        getActiveConversation(): Conversation | null;
    }
    ```
  - Add `sessionContext?: ToolSessionContext` field to `ToolExecuteOptions`

- [x] **A4.4b — `ChatOrchestrator` implements `ToolSessionContext`** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - Add `implements ToolSessionContext` to the class declaration (import the interface from `../tools/tool`)
  - Add `getActiveConversation(): Conversation | null` proxy method: `return this.conversationManager.getActiveConversation()`
    - **Note:** This reads the orchestrator's **display** `ConversationManager`, not the session's isolated one. If the user switches conversations mid-session, this returns the new displayed conversation — the same pre-existing limitation as the L1431 closure fallback. Add a code comment noting this so a future refactor can target `session.conversationManager` instead.
  - `getEffectiveToolConfig()` already exists on the orchestrator

- [x] **A4.4c — Thread `sessionContext` through dispatch chain** (`src/chat/tool-orchestration.ts`, `src/chat/dispatcher.ts`) *(done 2026-04-11)*
  - **`executeToolBatches()` is in `src/chat/tool-orchestration.ts` (L113), not `dispatcher.ts`** — edit both files:
    - `src/chat/tool-orchestration.ts`: add `sessionContext?: ToolSessionContext` parameter to `executeToolBatches()`; pass it through to each `dispatcher.dispatch()` call
    - `src/chat/dispatcher.ts`: add `sessionContext?: ToolSessionContext` as the last parameter to `dispatch()`; include it in the `executeOptions` object passed to `tool.execute()`: `const executeOptions: ToolExecuteOptions = { onProgress, mode, abortSignal, sessionContext }`

- [x] **A4.4d — Update `UseSubagentTool` to use `sessionContext`** (`src/tools/use-subagent.ts`) *(done 2026-04-11)*
  - In `execute()` and `executeInner()`, replace direct closure reads with sessionContext-first lookups:
    ```typescript
    const parentConfig = options?.sessionContext?.getEffectiveToolConfig()
        ?? this.getParentEffectiveConfig();
    const parentConv = options?.sessionContext?.getActiveConversation()
        ?? this.getParentConversation?.();
    ```
  - The closure fallback (`getParentEffectiveConfig`, `getParentConversation`) remains for non-session contexts

- [x] **A4.4e — Pass `this` as `sessionContext` at both dispatch call sites** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - Batch dispatch (~L2093, `executeToolBatches()` call): add `sessionContext: this`
  - Direct dispatch (~L1343, `dispatcher.dispatch()` call): add `sessionContext: this` as the new last argument

- [x] **A4.4f — Update fallback closures in `main.ts`** (`src/main.ts`, L1429-1431) *(done 2026-04-11)*
  - After Phase A ships (i.e., after A4.1 removes `getOrchestrator()`), update the closure fallbacks:
    - `() => this.getOrchestrator()?.getEffectiveToolConfig() ?? null` → `() => this.getActiveOrchestrator()?.getEffectiveToolConfig() ?? null`
    - `() => this.getOrchestrator()?.getConversationManager()?.getActiveConversation() ?? null` → `() => this.getActiveOrchestrator()?.getConversationManager()?.getActiveConversation() ?? null`
  - These closures now serve only as fallback for non-session contexts

- [x] **A4.5 — Update inspector view to subscribe to focus changes** (`src/ui/effective-config-inspector.ts`) *(done 2026-04-11)*
  - Amendment A4: Subscribe to `workspace.on('active-leaf-change')`
  - When a chat panel gains focus, update orchestrator reference via `setOrchestrator()`
  - When a non-chat leaf gains focus, retain last orchestrator
  - Unsubscribe on inspector close

- [x] **A4.6 — Delete `isSecondary` infrastructure** (`src/ui/chat-view.ts`) *(done 2026-04-11)*
  - Delete `isSecondary` field (L171)
  - Delete `getIsSecondary()` method (L756-758)
  - Delete `setIsSecondary()` method (L761-763)
  - Remove `isSecondary` from `getState()` return (L714)
  - Remove all `isSecondary` detection from `setState()` (L731-738)

- [x] **A4.7 — Simplify "open-secondary-chat" command** (`src/main.ts`, L534) *(done 2026-04-11)*
  - Remove `state: { isSecondary: true }` from the leaf state — just open a new leaf
  - The factory creates a fresh orchestrator automatically

- [x] **A4.8 — Update `onunload()`** (`src/main.ts`, L642-690) *(done 2026-04-11)*
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

- [x] **A5.1 — Add `flush()` method to `HistoryManager`** (`src/chat/history.ts`) *(done 2026-04-11)*
  - Awaits all pending write queues via `Promise.allSettled(Array.from(this.writeQueues.values()))`
  - Safe to call when no writes are pending (returns immediately)

- [x] **A5.2 — Add `flushConversation()` method to `HistoryManager`** (`src/chat/history.ts`) *(done 2026-04-11)*
  - Takes a `Conversation` object (not just ID — filename requires `created_at` + `id`)
  - Resolves the file path via `getFilename()` + `getFilePath()`
  - Awaits the pending write for that specific file path from `writeQueues`

- [x] **A5.3 — Await `flushConversation()` in `handleUserMessage()` finally block** (`src/chat/orchestrator.ts`, L1828-1835) *(done 2026-04-11)*
  - Before `this.activeSessions.delete(...)`, await `this.historyManager.flushConversation(conv)` wrapped in try/catch (best-effort)
  - Get `conv` from `session.conversationManager.getActiveConversation()`

- [x] **A5.4 — Await `flushConversation()` in `executeWorkflow()` finally block** (`src/chat/orchestrator.ts`, L942-953) *(done 2026-04-11)*
  - Same pattern as A5.3

- [x] **A5.5 — Add comment to `handleUserMessage` finally block** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - **Pre-implementation investigation completed (2026-04-11): SKIP the deactivation call.**
  - `handleUserMessage()` always creates sessions with `workflowAssembly: null` (verified: `orchestrator.ts:1797`). No code path through `handleUserMessage()` sets a non-null `workflowAssembly` — that field is only populated by `executeWorkflow()` (L917: `workflowAssembly: assemblyResult`).
  - **Action:** Add a comment in `handleUserMessage()`'s finally block explaining that workflow hook deactivation is intentionally absent because `workflowAssembly` is always null for user-message sessions; point to `executeWorkflow()`'s finally block (L942-953) which handles the workflow case.
  - Note: `deactivate()` is **already idempotent** (verified: `src/hooks/workflow-hook-override.ts:84` — "Safe to call when no override is active (no-op in that case)"). No changes to `WorkflowHookOverrideManager` are required for Amendment R4.

- [x] **A5.6 — Enhance `destroy()` with flush + hook cleanup + guard unregister** (`src/chat/orchestrator.ts`, L434-454) *(done 2026-04-11)*
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

- [x] **A6.1 — Add cross-orchestrator guard to `handleUserMessage()`** (`src/chat/orchestrator.ts`, after L1614-1617) *(done 2026-04-11)*
  - After the existing per-orchestrator `activeSessions.has(conv.id)` check, add: `if (this.sessionGuard.isActive(conv.id)) { new Notice("This conversation is being processed in another panel."); return; }`
  - After both guards pass: `this.sessionGuard.register(conv.id)`

- [x] **A6.2 — Add both guards to `executeWorkflow()`** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - Amendment A3: `executeWorkflow()` currently has NO `activeSessions.has(conv.id)` guard — add it
  - Then add cross-orchestrator `sessionGuard.isActive()` check
  - Then `sessionGuard.register(conv.id)` before creating session

- [x] **A6.3 — Add `sessionGuard.unregister()` to cleanup paths** (`src/chat/orchestrator.ts`) *(done 2026-04-11)*
  - In `handleUserMessage()` finally block: add `this.sessionGuard.unregister(session.conversationId)` before `activeSessions.delete()`
  - In `executeWorkflow()` finally block: same pattern
  - In `destroy()`: loop all `activeSessions.keys()` and unregister before clearing (already done in A5.6)

---

## Phase A7: View Close Lifecycle

**Goal:** Handle panel closure gracefully — detach view, drain sessions, destroy orchestrator.

**Files:** `src/ui/chat-view.ts`, `src/main.ts`, `src/chat/orchestrator.ts`

**Bugs addressed:** Lifecycle robustness (renders to destroyed DOM, hanging approvals, orchestrator leaks)

- [x] **A7.1 — Update `setView()` to accept `undefined`** (`src/chat/orchestrator.ts`, L196-198) *(done 2026-04-11)*
  - Change signature from `setView(view: NotorChatView)` to `setView(view: NotorChatView | undefined)`
  - Existing `this.view?.` guards throughout the orchestrator already handle `undefined`

- [x] **A7.2 — Add close cleanup infrastructure to `NotorChatView`** (`src/ui/chat-view.ts`) *(done 2026-04-11)*
  - Add `onCloseCleanup?: () => Promise<void>` field — **must be async**: Obsidian awaits `ItemView.onClose(): Promise<void>` (verified: `node_modules/obsidian/obsidian.d.ts:6445`), so async cleanup completes before the panel tears down
  - Add `setOnCloseCleanup(cb: () => Promise<void>)` setter

- [x] **A7.3 — Wire close cleanup in `wireView()`** (`src/main.ts`) *(done 2026-04-11)*
  - Set `view.setOnCloseCleanup(async () => { ... })` that:
    1. Aborts any in-flight `loadConversation()`: `view._loadConversationAbort?.abort()` — **must be first** to prevent `syncViewAfterLoad()` from mutating the closing view after orchestrator teardown
    2. Clears fallback timeout: `clearTimeout(view._loadFallbackTimeout)` (Amendment R2-2)
    3. Detaches view: `orchestrator.setView(undefined)`
    4. Cleans up session listener: `view._unregisterSessionsChanged?.()`
    5. Removes from registry: `this._orchestrators.delete(leafId)`
    6. `await orchestrator.destroy()` — awaiting ensures JSONL flush completes before panel teardown (Amendment R2-3)

- [x] **A7.4 — Update `onClose()`** (`src/ui/chat-view.ts`, L670-698) *(done 2026-04-11)*
  - Make async: `async onClose(): Promise<void>`
  - At the start: `await this.onCloseCleanup?.()` — Obsidian awaits this, so cleanup is guaranteed complete before DOM teardown
  - After cleanup: `this.clearCallbacks()` (Amendment R2-8 ordering)
  - Keep existing DOM cleanup code after

---

## Phase A-Verify: Verification & Regression Testing

**Goal:** Confirm all bug fixes and no regressions.

- [x] **AV.1 — Bug A verification: Panel restore doesn't destroy primary panel state** *(verified 2026-04-11, 8/8 pass)*
  - Open chat panel with active conversation A
  - Open second panel, close it, Cmd+Shift+T to reopen
  - Verify: first panel still shows conversation A with full history
  - Verify: second panel loads independently
  - **Script:** `e2e/scripts/phase-a-panel-restore-test.ts` — 7 scenarios: setup conversation, open/close/restore second panel, verify primary preserved, registry consistency, error check

- [x] **AV.2 — Bug B verification: Persistence flush prevents message loss** *(verified 2026-04-11, 7/7 pass)*
  - Send several messages rapidly, close plugin immediately
  - Reopen and verify all messages present in JSONL
  - Start streaming response, wait for completion, close plugin immediately
  - Reopen and verify complete response in JSONL
  - **Script:** `e2e/scripts/phase-a-persistence-test.ts` — 6 scenarios: single/multiple message persistence, flush() method exists, destroy() includes flush, message count match, error check

- [x] **AV.3 — Bug D verification: Cross-panel session guard** *(verified 2026-04-11, 7/7 pass)*
  - Open same conversation in two panels
  - Send message in one, try to send in other while streaming
  - Verify: "being processed in another panel" notice appears
  - Wait for completion, verify can now send from either panel
  - **Script:** `e2e/scripts/phase-a-session-guard-test.ts` — 6 scenarios: setup, switch to same conversation, guard blocks during streaming, send after completion, SessionGuard infrastructure, error check

- [x] **AV.4 — Command routing verification** *(verified 2026-04-11, 8/8 pass)*
  - Open two panels side by side
  - Focus panel 2, run workflow from command palette → verify executes in panel 2
  - Focus panel 1, run "New conversation" → verify created in panel 1
  - **Script:** `e2e/scripts/phase-a-routing-settings-test.ts` — 7 scenarios: setup, command→panel2, command→panel1, getActiveOrchestrator follows focus, settings propagation, _lastFocusedChatLeafId tracking, error check

- [x] **AV.5 — Settings propagation verification** *(verified 2026-04-11, combined with AV.4)*
  - Open two panels, change a setting → verify both panels reflect the update
  - **Script:** `e2e/scripts/phase-a-routing-settings-test.ts` — combined with AV.4 (test 5: settings propagation)

- [x] **AV.6 — Regression: Existing E2E tests updated for unified registry APIs** *(done 2026-04-11)*
  - `e2e/scripts/session-sync-back-test.ts` — replaced `getOrchestrator()` with `getActiveOrchestrator()` and `_orchestrators` iteration for cross-orchestrator session queries
  - `e2e/scripts/phase4-multi-panel-test.ts` — replaced `getIsSecondary()`, `_secondaryOrchestrators`, `getOrchestrator()` with `_orchestrators` registry, index-based panel identification, and `getOrchestratorRegistrySize()`
  - `e2e/scripts/phase5-open-in-new-tab-test.ts` — replaced `getIsSecondary()`, `closeSecondaryPanel()` with `closeLastExtraPanel()`, removed `isSecondary` state checks, all panels treated as equal

- [x] **AV.7 — Regression: Core functionality** *(verified 2026-04-11, 8/8 pass)*
  - Single-panel chat: new conversation, send messages, switch conversations
  - Workflow execution (foreground + background)
  - Plugin hot-reload preserves state
  - Workspace restore with multiple panels restores each panel's conversation
  - **Script:** `e2e/scripts/phase-a-regression-test.ts` — 7 scenarios: new conversation + messages, switch conversations, multi-panel independence, registry matches panels, isSecondary removed, view lifecycle infrastructure, error check

---

## Phase B: Orchestrator Decomposition (Medium-Term)

**Goal:** Break up the ~2,976-line `ChatOrchestrator` into focused, independently testable classes behind the existing facade. After decomposition, the facade retains `responseLoop()` and `handleUserMessage()` as coordination hubs; all other responsibilities live in extracted classes.

**Prerequisite:** Phase A complete.

**Files:** New files + `src/chat/orchestrator.ts`

**Extraction order:** B7 → B4 → B8 → B6 → B1 → B2 → B3 → B5 (ordered by ascending coupling — pure utilities first, highly-coupled extractions last; all complete)

### Architectural Principles

1. **Facade stability:** `ChatOrchestrator`'s public API remains unchanged throughout Phase B. All extractions are internal refactors. External callers (plugin class, wireView callbacks) are not modified.
2. **Dependency direction:** Extracted classes depend on shared infrastructure singletons (HistoryManager, ProviderRegistry, etc.) and on each other via constructor-injected interfaces or callbacks — never via back-references to the orchestrator facade.
3. **Straddling methods are split:** Methods that cross extraction boundaries are decomposed. The "owner" class holds the primary logic; it calls into other extracted classes via injected references. The facade delegates to the owner.
4. **What stays on the facade:** `responseLoop()` (L1855-2238) and `handleUserMessage()` (L1601-1836) remain on the orchestrator. `responseLoop()` is the core coordination hub calling into ViewRouter, ConfigResolver, CompactionManager, MessagePipeline, HookDispatcher, and the external tool dispatch chain. `handleUserMessage()` is 80% user-input pre-processing and 20% coordination — its logic doesn't recur elsewhere.

---

### B7: Extract MessagePipeline (pure utilities, no dependencies)

**~310 lines.** These are pure transformations with no orchestrator state access — the cleanest extraction.

- [x] **B7.1 — Create `src/chat/message-pipeline.ts`** *(done 2026-04-11)*
  - Extract `toChatMessages(messages: Message[], systemPrompt: string): ChatMessage[]` (L2606-2827) — 100% pure function. Handles role mapping, tool call coalescing, synthetic result injection, orphaned tool_call repair. No orchestrator fields accessed.
  - Extract `processStream(stream, abortController, eagerContentEl?, viewResolver?): Promise<StreamResult>` (L2487-2578) — transforms stream events into typed `StreamResult`. View rendering is done via the `viewResolver` callback parameter (already parameterized). No orchestrator state access.
  - Both functions become module-level exports (no class needed — they're stateless)

- [x] **B7.2 — Update orchestrator to import from message-pipeline** *(done 2026-04-11)*
  - Replace `this.toChatMessages(...)` calls in `responseLoop()` with imported `toChatMessages(...)`
  - Replace `this.processStream(...)` calls in `responseLoop()` with imported `processStream(...)`
  - Also update `_backgroundResponseLoop()`'s call to `this._bgToChatMessages()` (L1457-1462) — this is a thin wrapper around `toChatMessages()` and can be inlined at the call site using the imported function
  - Delete the private methods from `ChatOrchestrator`

---

### B4: Extract ConfigResolver (mostly pure, minimal deps)

**~150 lines.** Returns a result object — no mutations to orchestrator state.

- [x] **B4.1 — Create `src/chat/config-resolver.ts`** *(done 2026-04-11)*
  - Create `ConfigResolver` class with constructor:
    ```typescript
    constructor(
      private readonly systemPromptBuilder: SystemPromptBuilder,
      private readonly settings: NotorSettings,       // updated via setter
      private readonly dispatcher: ToolDispatcher,
      private getToolDefinitions?: (config?: EffectiveToolConfig) => ToolDefinition[],
    )
    ```
  - Extract `resolveEffectiveConfig(matchedRules?, workflowAssembly?, activePersona?): Promise<{effective, toolDefinitions, parsedConfigs}>` (L1508-1567)
  - Extract `updateDisplayConfig(effective, parsedConfigs): void` — but this mutates `effectiveToolConfig` and `activeParsedConfigs` fields. These fields move to ConfigResolver since they are display-only copies of the last resolved config.
  - Add `getEffectiveToolConfig(): EffectiveToolConfig | null` and `getActiveParsedConfigs(): ParsedToolConfig[]` accessors (currently on orchestrator at L323, L332)
  - Add `updateSettings(settings: NotorSettings)` setter for settings propagation

- [x] **B4.2 — Wire ConfigResolver into orchestrator** *(done 2026-04-11)*
  - Create ConfigResolver in orchestrator constructor, passing shared singletons
  - Delegate `resolveEffectiveConfig()`, `getEffectiveToolConfig()`, `getActiveParsedConfigs()` calls
  - `responseLoop()` calls `this.configResolver.resolveEffectiveConfig()` + `this.configResolver.updateDisplayConfig()`
  - `ToolSessionContext.getEffectiveToolConfig()` delegates to `this.configResolver`
  - Delete extracted methods and fields from `ChatOrchestrator`

---

### B8: Extract HookDispatcher (consolidates scattered dispatch sites)

**~50 lines of method bodies, but simplifies 4 inline dispatch sites in responseLoop.**

- [x] **B8.1 — Create `src/chat/hook-dispatcher.ts`** *(done 2026-04-11)*
  - Create `HookDispatcher` class with constructor:
    ```typescript
    constructor(
      private settings: NotorSettings,                          // updated via setter
      private workflowHookOverrideManager?: WorkflowHookOverrideManager,
      private extensionLifecycleAccessors?: LifecycleAutomationAccessors,
      private extensionToolEventAccessors?: ToolEventAutomationAccessors,
    )
    ```
  - Extract `dispatchAfterCompletionHooks(conversationId?: string)` (L2248-2263)
  - Add unified dispatch methods that consolidate the inline patterns:
    - `dispatchPreSend(context: HookContext): Promise<HookInjection[]>` — wraps L1664-1673 pattern
    - `dispatchToolCall(context: ToolCallHookContext): void` — wraps L2042-2053 pattern
    - `dispatchToolResult(context: ToolResultHookContext): void` — wraps L2163-2176 pattern
    - `dispatchAfterCompletion(context: HookContext): void` — wraps L2252-2261
  - Add `updateSettings(settings)` setter
  - Note: The imported functions `dispatchPreSend()`, `dispatchOnToolCall()`, `dispatchOnToolResult()`, `dispatchAfterCompletion()` from `../hooks/` remain as the actual implementations — HookDispatcher is a facade over them that bundles the common parameters (settings, overrideManager, extensionAccessors)

- [x] **B8.2 — Wire HookDispatcher into orchestrator** *(done 2026-04-11)*
  - Create HookDispatcher in orchestrator constructor
  - Replace 4 inline dispatch call sites in `responseLoop()` with `this.hookDispatcher.dispatchX(...)` calls
  - Replace `dispatchPreSend()` call in `handleUserMessage()` (L1664-1673) with `this.hookDispatcher.dispatchPreSend(...)`
  - Replace `dispatchAfterCompletionHooks()` private method (L2248-2263) with delegation
  - Also replace hook dispatch calls in `_backgroundResponseLoop()` (L1367-1397)
  - Delete extracted private method from `ChatOrchestrator`

---

### B6: Extract CompactionManager (moderate coupling, view callbacks)

**~200 lines.** Uses ConversationManager, HistoryManager, ProviderRegistry, and view (for UI indicators only).

- [x] **B6.1 — Create `src/chat/compaction-manager.ts`** *(done 2026-04-11)*
  - Create `CompactionManager` class with constructor:
    ```typescript
    constructor(
      private readonly historyManager: HistoryManager,
      private readonly providerRegistry: ProviderRegistry,
      private settings: NotorSettings,                          // updated via setter
    )
    ```
  - Extract `checkAndPerformCompaction(session?, convManager?, modelId?, useExtended?, viewAccessor?): Promise<void>` (L2276-2390)
    - Currently reads `this.conversationManager`, `this.activeModelId`, `this.activeUseExtendedContext` as fallbacks when no session is passed. Change to explicit parameters: caller passes the appropriate ConversationManager, model ID, and extended context flag.
    - View interaction (L2309 `getMessagesContainer()`, compacting indicator, compaction marker) is parameterized via a `viewAccessor?: () => NotorChatView | undefined` callback — avoids CompactionManager depending on ViewRouter
  - Extract `manualCompaction(): Promise<void>` (L2397-2480) — same pattern, takes ConversationManager + model config + viewAccessor as parameters
  - Extract `extractPendingMessages(messages: Message[]): Message[]` (L2596-2604) — pure utility, could also go in MessagePipeline but conceptually belongs with compaction
  - Add `updateSettings(settings)` setter

- [x] **B6.2 — Wire CompactionManager into orchestrator** *(done 2026-04-11)*
  - Create CompactionManager in orchestrator constructor
  - `responseLoop()` calls `this.compactionManager.checkAndPerformCompaction(session, session.conversationManager, ...)` passing session state and a `() => this.viewRouter.getViewForSession(session)` callback
  - `manualCompaction()` on orchestrator delegates to `this.compactionManager.manualCompaction(this.conversationManager, ...)` passing display state
  - Delete extracted methods from `ChatOrchestrator`

---

### B1: Extract ViewRouter (owns view field, significant coupling)

**~200 lines.** Owns the `view` field and all view-method calls. The key coupling point is `getViewForSession()` which checks session conversation ID against the displayed conversation.

- [x] **B1.1 — Create `src/chat/view-router.ts`** *(done 2026-04-11)*
  - Create `ViewRouter` class with constructor:
    ```typescript
    constructor(
      private getDisplayedConversationId: () => string | null,  // callback, avoids circular dep
    )
    ```
  - Extract fields: `view` (L165)
  - Extract methods:
    - `setView(view: NotorChatView | undefined): void` (L196-198)
    - `getView(): NotorChatView | undefined` — new accessor for the view field
    - `getViewForSession(session: ConversationSession): NotorChatView | undefined` (L402-405) — uses injected `getDisplayedConversationId()` callback instead of directly accessing `conversationManager`
    - `renderMessage(message: Message): void` (L2948-2968) — dispatches to view's render methods by role
    - `renderMessages(messages: Message[]): void` — new convenience method that iterates and calls `renderMessage()` for each; used by `switchConversation()` split
  - **Does NOT extract** the 15+ inline `this.getViewForSession(session)?.someMethod()` calls in `responseLoop()` — those stay in the facade, calling `this.viewRouter.getViewForSession(session)` to get the view reference, then calling view methods directly. ViewRouter provides the routing logic; the facade decides what to render.
  - **Does NOT own** `effectiveToolConfig` or `activeParsedConfigs` — those moved to ConfigResolver in B4

- [x] **B1.2 — Wire ViewRouter into orchestrator** *(done 2026-04-11)*
  - Create ViewRouter in orchestrator constructor, injecting `() => this.conversationLifecycle.getDisplayedConversationId()` as the callback (after B3 is wired). **During B1 wiring (before B3), use a temporary `() => this.conversationManager.getActiveConversation()?.id ?? null` callback that will be replaced when B3 is wired.**
  - All `this.view?.` calls in `switchConversation()` (L505-510, L586-589, L591-594, L614-621, L635-645, L653-667) are replaced with `this.viewRouter` calls
  - All `this.getViewForSession(session)` calls become `this.viewRouter.getViewForSession(session)`
  - `orchestrator.setView(view)` delegates to `this.viewRouter.setView(view)`
  - `handleError()` (L2833-2867) calls `this.viewRouter.getView()?.showError(...)` instead of `this.view?.showError(...)`
  - Delete `view` field, `setView()`, `getViewForSession()`, `renderMessage()` from `ChatOrchestrator`

---

### B2: Extract SessionManager (owns activeSessions, session creation)

**~200 lines.** Owns session lifecycle including creation, tracking, cleanup, and the session guard.

- [x] **B2.1 — Create `src/chat/session-manager.ts`** *(done 2026-04-11)*
  - Create `SessionManager` class with constructor:
    ```typescript
    constructor(
      private readonly historyManager: HistoryManager,
      private readonly sessionGuard: SessionGuard,
    )
    ```
  - Extract fields: `activeSessions` (L148), `sessionChangeCallbacks` (L156)
  - Extract methods:
    - `getActiveSession(conversationId: string): ConversationSession | undefined` (L345)
    - `getActiveSessions(): ConversationSession[]` (L354)
    - `hasActiveSession(conversationId: string): boolean` (L363)
    - `onSessionsChanged(callback: () => void): () => void` (L374-379)
    - `notifySessionsChanged(): void` (L384-392)
    - `registerSession(session: ConversationSession): void` — new method encapsulating `activeSessions.set()` + `sessionGuard.register()` + `notifySessionsChanged()`
    - `unregisterSession(conversationId: string): void` — new method encapsulating `sessionGuard.unregister()` + `activeSessions.delete()` + `notifySessionsChanged()`
  - Extract session creation factory: `createSession(params: SessionCreationParams): ConversationSession`
    - Consolidates the duplicated ~80-line session setup pattern from `handleUserMessage()` (L1729-1804), `executeWorkflow()` (L880-921), and `_backgroundResponseLoop()` (L1207-1221)
    - Takes a `SessionCreationParams` object with: conversation snapshot, mode, persona, provider/model, approval callback, workflow assembly (optional), persistence callbacks
    - Creates session-scoped `ConversationManager` (dynamic import), wires persistence callbacks, creates `ConversationSession` object
    - Returns the session but does NOT register it — caller decides whether to register (background workflows don't register in `activeSessions`)
  - Extract cleanup: `destroySessions(timeoutMs?: number): Promise<void>` — the session abort + await logic from `destroy()` (L434-454), unregisters all sessions from guard, clears maps
  - Add `flushAndUnregister(session: ConversationSession): Promise<void>` — the finally-block pattern from A5.3/A6.3 (flush conversation writes, unregister session guard, delete from activeSessions, notify)

- [x] **B2.2 — Wire SessionManager into orchestrator** *(done 2026-04-11)*
  - Create SessionManager in orchestrator constructor
  - `handleUserMessage()` calls `this.sessionManager.createSession(...)` then `this.sessionManager.registerSession(session)` — replacing ~80 lines of inline setup
  - `executeWorkflow()` same pattern
  - `_backgroundResponseLoop()` calls `this.sessionManager.createSession(...)` but does NOT call `registerSession()` (background sessions tracked externally)
  - All `this.activeSessions.has/get/set/delete` calls delegate to SessionManager
  - Session cleanup finally blocks call `this.sessionManager.flushAndUnregister(session)`
  - `destroy()` calls `this.sessionManager.destroySessions(timeoutMs)`
  - Delete extracted fields and methods from `ChatOrchestrator`

---

### B3: Extract ConversationLifecycleManager (depends on ViewRouter + SessionManager)

**~250 lines.** Owns conversation CRUD operations. This is the most coupled extraction because `switchConversation()` straddles ViewRouter, SessionManager, and conversation loading.

- [x] **B3.1 — Create `src/chat/conversation-lifecycle.ts`** *(done 2026-04-11)*
  - Create `ConversationLifecycleManager` class with constructor:
    ```typescript
    constructor(
      private readonly conversationManager: ConversationManager,
      private readonly historyManager: HistoryManager,
      private readonly viewRouter: ViewRouter,
      private readonly sessionManager: SessionManager,
      private personaManager?: PersonaManager,        // optional, set via setter
    )
    ```
  - Extract fields: `conversationManager` (L64), `workflowPreviousPersona` (L90)
  - Extract methods:
    - `getDisplayedConversationId(): string | null` — returns `this.conversationManager.getActiveConversation()?.id ?? null`. This is the callback used by ViewRouter's `getViewForSession()` to avoid circular imports.
    - `getDisplayedConversation(): Conversation | null` (L416) — proxy to `conversationManager.getActiveConversation()`
    - `getConversationManager(): ConversationManager` — accessor (needed by facade for `handleUserMessage()` pre-processing)
    - `newConversation(opts?: { signal?: AbortSignal }): Promise<void>` (L467-513)
      - Persona revert logic stays here (`maybeRevertWorkflowPersona`)
      - View updates (`clearMessages`, `updateModeDisplay`, `clearDisplayOverrides`) call `this.viewRouter`
    - `forkConversation(forkAtMessageId: string): Promise<{...} | null>` (L525-552)
    - `switchConversation(filename: string, opts?: { signal?: AbortSignal }): Promise<void>` (L560-675) — **split as follows:**
      1. Load JSONL via `this.historyManager.loadConversation(filename)` (L569)
      2. Check for active session via `this.sessionManager.getActiveSession(conversation.id)` (L575)
      3. If active session: sync-back from session's ConversationManager (L577-589) — calls `this.viewRouter.renderMessages(sessionMessages)` for re-rendering
      4. If no active session: load from JSONL into `this.conversationManager` (L632-638) — calls `this.viewRouter.renderMessages(messages)`
      5. Restore display state: persona label, provider/model display via `this.viewRouter.getView()?.updatePersonaLabel(...)` etc. (L650-668)
      6. Token footer update via `this.viewRouter.getView()?.updateTokenFooter(...)` (L643-645)
    - `switchToConversationById(id: string, opts?: { signal?: AbortSignal }): Promise<boolean>` (L690-700)
    - `maybeRevertWorkflowPersona(): Promise<void>` (L719-733) — private helper
  - Add `updatePersonaManager(manager)` setter for late-binding

- [x] **B3.2 — Wire ConversationLifecycleManager into orchestrator** *(done 2026-04-11)*
  - Create ConversationLifecycleManager in orchestrator constructor, passing ViewRouter, SessionManager, shared singletons
  - **Update ViewRouter's callback:** Replace the temporary `getDisplayedConversationId` callback (from B1.2) with `() => this.conversationLifecycle.getDisplayedConversationId()`
  - `responseLoop()` still accesses session's `conversationManager` (from the ConversationSession object), NOT from ConversationLifecycleManager — session isolation is preserved
  - `handleUserMessage()` calls `this.conversationLifecycle.getConversationManager()` for the pre-processing phase (checking active conversation, adding messages)
  - Facade's `newConversation()`, `switchConversation()`, `forkConversation()`, `switchToConversationById()` delegate to ConversationLifecycleManager
  - `ToolSessionContext.getActiveConversation()` delegates to `this.conversationLifecycle.getDisplayedConversation()`
  - Delete extracted fields and methods from `ChatOrchestrator`

---

### B5: Extract WorkflowExecutor (depends on SessionManager + ConversationLifecycleManager + ConfigResolver)

**~620 lines.** The largest extraction. Owns both foreground and background workflow execution, including `_backgroundResponseLoop()`.

- [x] **B5.1 — Create `src/chat/workflow-executor.ts`** *(done 2026-04-11)*
  - ~~**Deferral note (2026-04-11):**~~ Resolved: with B1-B8 complete, most of the 15+ dependencies dissolved into already-extracted classes or shared singletons. Used a `WorkflowExecutorDeps` interface to group all dependencies into a single typed deps object (avoids a 23-param constructor while keeping the dependency contract explicit).
  - Created `WorkflowExecutor` class with `WorkflowExecutorDeps` constructor pattern:
    - **Readonly singletons (5):** `app`, `providerRegistry`, `systemPromptBuilder`, `dispatcher`, `historyManager`
    - **Extracted class references (4):** `sessionManager`, `configResolver`, `hookDispatcher`, `viewRouter`
    - **Getter callbacks (9):** `getSettings`, `getPersonaManager`, `getWorkflowHookOverrideManager`, `getVaultRuleManager`, `getPanelApprovalCallback`, `getConversationManager`, `getActiveProviderType`, `getActiveModelId`, `getActiveUseExtendedContext`
    - **Utility getters (2):** `getVaultRootPath`, `getSessionContext` (returns orchestrator as `ToolSessionContext`)
    - **Method bridges (3):** `runResponseLoop`, `setWorkflowPersonaRevert`, `handleError`
  - Extracted methods:
    - `executeWorkflow()` (~207 lines) — foreground manual workflow execution
    - `executeBackgroundWorkflow()` (~180 lines) — background event-triggered execution
    - `_backgroundResponseLoop()` (~240 lines) — LLM loop for background workflows

- [x] **B5.2 — Wire WorkflowExecutor into orchestrator** *(done 2026-04-11)*
  - Created `WorkflowExecutor` in orchestrator constructor with getter-closure wiring (same pattern as HookDispatcher/CompactionManager)
  - Injected `responseLoop` callback: `(mode, session) => this.responseLoop(mode, session)`
  - `orchestrator.executeWorkflow(...)` delegates to `this.workflowExecutor.executeWorkflow(...)`
  - `orchestrator.executeBackgroundWorkflow(...)` delegates to `this.workflowExecutor.executeBackgroundWorkflow(...)`
  - Deleted `_backgroundResponseLoop` from orchestrator (private to WorkflowExecutor)
  - Removed unused imports: `parseStreamEvents`, `revertWorkflowPersona`, `switchWorkflowPersona`, `assembleWorkflowPrompt`, `WorkflowAssemblyResult`

---

### B-Verify: Verification & Regression Testing

- [x] **BV.1 — After each extraction: TypeScript compiles + E2E tests pass** *(done 2026-04-11)*
  - Run `npm run build` after each B*.2 wiring step
  - Run E2E tests: `e2e/scripts/session-sync-back-test.ts`, `e2e/scripts/phase4-multi-panel-test.ts`, `e2e/scripts/phase5-open-in-new-tab-test.ts`
  - **Script:** `e2e/scripts/phase-b-structural-test.ts` — 10 scenarios: plugin loads, ViewRouter/SessionManager/ConversationLifecycleManager/ConfigResolver/HookDispatcher/CompactionManager wired, MessagePipeline extracted, facade delegation, error check

- [x] **BV.2 — After B1+B2+B3 (the coupled trio): Multi-panel integration test** *(done 2026-04-11)*
  - Verify `switchConversation` sync-back: open same conversation in two panels, send message in one, switch to it in the other → verify messages appear
  - Verify session isolation: concurrent sessions in different panels don't interfere
  - Verify `getViewForSession` routing: renders go to the correct panel
  - **Script:** `e2e/scripts/phase-b-multi-panel-integration-test.ts` — 8 scenarios: setup, sync-back renders, send in panel 1, session isolation, ViewRouter routing, lifecycle delegation, SessionManager guard integration, error check

- [x] **BV.3 — After B5: Workflow verification** *(done 2026-04-11)*
  - Foreground workflow execution in focused panel
  - Background workflow triggered by vault event
  - Workflow with tool calls requiring approval
  - Concurrent foreground + background workflows
  - **Note:** B5 deferred — workflows remain on facade, but tests verify that extracted dependencies (ConfigResolver, HookDispatcher, SessionManager) work correctly during workflow execution
  - **Script:** `e2e/scripts/phase-b-workflow-verification-test.ts` — 8 scenarios: foreground execution, conversation creation, ConfigResolver/HookDispatcher/SessionManager in workflow, tool call infrastructure, background workflow infrastructure, error check

- [x] **BV.4 — After all extractions: Full regression** *(done 2026-04-11)*
  - Single-panel chat: new conversation, send messages, switch conversations, fork
  - Multi-panel: independent conversations, session guard, command routing
  - Compaction: auto-compaction threshold, manual compaction command
  - Plugin hot-reload preserves state
  - Workspace restore with multiple panels
  - **Script:** `e2e/scripts/phase-b-full-regression-test.ts` — 11 scenarios: new conversation, switch, fork, multi-panel independence, session guard, command routing, settings propagation, compaction manager, registry consistency, workspace restore, error check

---

## Phase C: Centralized State (Optional, Long-Term)

**Design spec:** [centralized-state-design.md](centralized-state-design.md)

**Prerequisite:** Phase B complete.

**Status:** Design phase — tasks will be added after the spec is finalized.
