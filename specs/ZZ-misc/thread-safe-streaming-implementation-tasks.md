# Thread-Safe Streaming & Multi-Panel Chat: Implementation Tasks

**Spec:** [thread-safe-streaming-multi-panel-design.md](./thread-safe-streaming-multi-panel-design.md)
**Created:** 2026-04-08

---

## Phase 1: Per-Conversation Session Isolation

> Bug fix + architecture. Fixes data corruption on mid-stream conversation switch.
> Split into 4 sub-phases: 1A (pure refactors), 1B (session core), 1C (background loop), 1D (UI/lifecycle).

### Phase 1A — Pure Refactors

### Step 1a: Extract tool policy from dispatcher (pure refactor)

Extracts policy enforcement from `ToolDispatcher.dispatch()` into a pure function. No behavior change -- all existing tests must continue to pass.

- [x] **Create `src/chat/tool-policy.ts`**
  - [x] Define `ToolPolicyContext` interface with fields: `effectiveConfig: EffectiveToolConfig`, `mode: ConversationMode`, `domainDenylist?: string[]`, `vaultRootPath: string`
  - [x] Define `PolicyDecision` interface with fields: `allowed: boolean`, `autoApproved: boolean`, `error?: string`
  - [x] Implement `evaluateToolPolicy(toolName, parameters, tool, ctx)` pure function extracting these checks from `dispatcher.ts`:
    - [x] Enabled check (dispatcher.ts:292-310) -- reads `ctx.effectiveConfig`
    - [x] Plan/Act mode check (dispatcher.ts:312-332) -- reads `ctx.mode` + `tool.mode`
    - [x] Domain denylist check (dispatcher.ts:337-363) -- reads `ctx.domainDenylist`, preserves `toolName === "fetch_webpage"` guard
    - [x] Auto-approve resolution (dispatcher.ts:365-406) -- reads `ctx.effectiveConfig`, handles MCP/built-in branching
    - [x] Path enforcement (dispatcher.ts:412-438) -- reads `ctx.effectiveConfig` + `ctx.vaultRootPath`
  - [x] Export all types and the function

- [x] **Modify `src/chat/dispatcher.ts`**
  - [x] Add optional `policyCtx?: ToolPolicyContext` parameter to `dispatch()` (line 262)
  - [x] Add optional `approvalCallback?: ApprovalCallback` parameter to `dispatch()` (line 262)
  - [x] When `policyCtx` provided: call `evaluateToolPolicy()` instead of inline policy checks
  - [x] When `approvalCallback` provided: use it instead of `this.approvalCallback`
  - [x] When omitted: fallback to current behavior (backward compat during migration)

- [x] **Modify `src/chat/tool-orchestration.ts`**
  - [x] Add `policyCtx?: ToolPolicyContext` parameter to `executeToolBatches()` (line 112)
  - [x] Add `approvalCallback?: ApprovalCallback` parameter to `executeToolBatches()` (line 112)
  - [x] Thread both through to `runConcurrentBatch()` (line 186) and `safeDispatch()` (line 249)
  - [x] `safeDispatch()` passes them to `dispatcher.dispatch()` (line 258)

- [x] **Verify:** All existing tests pass (pure refactor, fallback path exercises old code)

### Step 1b: Make `resolveEffectiveConfig` pure (pure refactor)

Changes `resolveEffectiveConfig()` from mutating shared state to returning a structured result. Breaking change to return type -- all call sites must be updated.

- [x] **Modify `resolveEffectiveConfig()` in `src/chat/orchestrator.ts` (line 1138)**
  - [x] Change signature to accept explicit parameters:
    ```typescript
    private async resolveEffectiveConfig(
      matchedRules?: VaultRule[],
      workflowAssembly?: WorkflowAssemblyResult | null,
      activePersona?: Persona | null,
    ): Promise<{
      effective: EffectiveToolConfig;
      toolDefinitions: ToolDefinition[];
      parsedConfigs: ParsedToolConfig[];
    }>
    ```
  - [x] Line 1141: Use `activePersona` parameter instead of `this.personaManager?.getActivePersona() ?? null`
  - [x] Line 1148: Use `workflowAssembly?.toolConfigs ?? []` instead of `this.activeWorkflowAssemblyResult?.toolConfigs ?? []`
  - [x] Lines 1184-1188: REMOVE the three mutations (`this.activeParsedConfigs`, `this.effectiveToolConfig`, `this.dispatcher.setEffectiveToolConfig()`)
  - [x] Return `{ effective, toolDefinitions, parsedConfigs }` instead of just `ToolDefinition[]`

- [x] **Add `updateDisplayConfig()` helper to `src/chat/orchestrator.ts`**
  - [x] Method stores `effective` and `parsedConfigs` on orchestrator fields for inspector access
  - [x] `getEffectiveToolConfig()` (line 249) and `getActiveParsedConfigs()` (line 258) continue returning these fields

- [x] **Update all call sites** (return type changes from `ToolDefinition[]` to structured object):
  - [x] `responseLoop()` (line 1384): Destructure result, call `updateDisplayConfig()` for displayed conversation
  - [x] `_backgroundResponseLoop()`: Destructure result, pass `workflowAssembly` parameter directly (removes save/restore hack)
  - [x] `handleUserMessage()`: No call site (calls `responseLoop()` which handles it)
  - [x] `executeWorkflow()` (line 472+): No direct call (calls `responseLoop()` which handles it). Full session creation addressed in Step 1d-workflow.

- [x] **Verify:** Inspector still shows correct config via `updateDisplayConfig()`. Background workflow tool config works via direct `workflowAssembly` parameter. `activeWorkflowAssemblyResult` save/restore hack removed from `_backgroundResponseLoop` (restore line deleted; field still exists for `responseLoop`/`executeWorkflow` path until Step 1e).

### Phase 1B — Session Core

### Step 1c: Create `ConversationSession` class

New file encapsulating all per-conversation state for an active response loop.

- [x] **Create `src/chat/conversation-session.ts`**
  - [x] Define `SessionStatus` type: `"running" | "waiting_approval" | "completed" | "errored" | "cancelled"`
  - [x] Implement `ConversationSession` class with fields:
    - [x] `readonly conversationId: string`
    - [x] `readonly conversationManager: ConversationManager` (isolated per-session)
    - [x] `readonly abortController: AbortController` (independent per-session)
    - [x] `readonly title: string`
    - [x] `readonly startedAt: number`
    - [x] `effectiveConfig: EffectiveToolConfig` (updated each iteration)
    - [x] `parsedConfigs: ParsedToolConfig[]` (updated each iteration)
    - [x] `readonly pinnedPersona: Persona | null` (snapshotted, immutable)
    - [x] `readonly providerType: LLMProviderType` (snapshotted, immutable)
    - [x] `readonly modelId: string` (snapshotted, immutable)
    - [x] `readonly useExtendedContext: boolean` (snapshotted, immutable)
    - [x] `readonly workflowAssembly: WorkflowAssemblyResult | null` (snapshotted, immutable)
    - [x] `readonly approvalCallback: ApprovalCallback` (bound to correct panel)
    - [x] `responsePromise?: Promise<void>` (set by handleUserMessage, used by destroy)
    - [x] `private _status: SessionStatus` (defaults to "running")
    - [x] `onStatusChange?: (session: ConversationSession) => void`
  - [x] Implement `get status()` getter
  - [x] Implement `setStatus(status)` setter that calls `onStatusChange` callback
  - [x] Implement `buildPolicyContext(settings, vaultRootPath): ToolPolicyContext`
    - [x] Reads `effectiveConfig` from session
    - [x] Reads `mode` dynamically from `this.conversationManager.getActiveConversation()?.mode` (mode can toggle mid-stream)
    - [x] Reads `domainDenylist` from settings
    - [x] Reads `vaultRootPath` from parameter
  - [x] Constructor accepts options object with all readonly fields + `initialConfig` + `initialParsedConfigs`

### Step 1d: Update `responseLoop` to use `ConversationSession`

This is the largest step. Replaces all shared-state reads in the response path with session-scoped reads.

- [x] **Add `activeSessions` map to `src/chat/orchestrator.ts`**
  - [x] `private activeSessions = new Map<string, ConversationSession>()`
  - [x] Add `getActiveSession(conversationId: string): ConversationSession | undefined` accessor

- [x] **Add `getViewForSession()` helper**
  ```typescript
  private getViewForSession(session: ConversationSession): NotorChatView | undefined {
    const displayConvId = this.conversationManager.getActiveConversation()?.id;
    return session.conversationId === displayConvId ? this.view : undefined;
  }
  ```

- [x] **Modify `handleUserMessage()` (line 1217)**
  - [x] Add duplicate-send guard: `if (this.activeSessions.has(conv.id))` -> show Notice, return
  - [x] Snapshot conversation + messages from `this.conversationManager`
  - [x] Create isolated `ConversationManager` (pattern from `executeBackgroundWorkflow`, lines 710-724)
  - [x] Wire `onMessageAdded` / `onConversationChanged` to `this.historyManager`
  - [x] Load snapshot into new manager via `loadConversation()`
  - [x] Snapshot persona: `this.personaManager?.getActivePersona() ?? null`
  - [x] Snapshot provider: conversation header `provider_id` if provider still configured, else `this.providerRegistry.getActiveType()`
  - [x] Snapshot model: conversation header `model_id` if provider still configured, else `this.getActiveModelId()`
  - [x] Snapshot extended context: `this.providerRegistry.getConfig(providerType)?.use_extended_context ?? false`
  - [x] Resolve initial config via pure `resolveEffectiveConfig(matchedRules, null, pinnedPersona)`
  - [x] Create `ConversationSession` with all snapshots
  - [x] Register in `this.activeSessions`
  - [x] Store response loop promise: `session.responsePromise = this.responseLoop(mode, session)`
  - [x] Update finally block to clean up session:
    ```typescript
    try { await session.responsePromise; }
    catch (e) { session.setStatus("errored"); this.handleError(e); }
    finally {
      if (session.status === "running" || session.status === "waiting_approval")
        session.setStatus("completed");
      this.activeSessions.delete(session.conversationId);
      this.view?.setRespondingState(false);
    }
    ```

- [x] **Change `responseLoop()` signature**
  ```typescript
  private async responseLoop(mode: ConversationMode, session: ConversationSession): Promise<void>
  ```

- [x] **Substitute all `this.conversationManager` reads in `responseLoop` (14 sites)**
  - [x] L1400 `getMessages()` -> `session.conversationManager.getMessages()`
  - [x] L1408 `getActiveConversation()!.id` -> `session.conversationManager.getActiveConversation()!.id`
  - [x] L1453 `addMessage()` -> `session.conversationManager.addMessage()`
  - [x] L1466 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [x] L1484 `addMessage()` -> `session.conversationManager.addMessage()`
  - [x] L1493 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [x] L1511 `addMessage()` -> `session.conversationManager.addMessage()`
  - [x] L1527 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [x] L1619 `addMessage()` -> `session.conversationManager.addMessage()`
  - [x] L1630 `addTokens()` -> `session.conversationManager.addTokens()`
  - [x] L1638 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [x] L1661 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [x] L1687 `addMessage()` -> `session.conversationManager.addMessage()`
  - [x] L1728 `getActiveConversation()` -> pass `session` or `conversationId` to `dispatchAfterCompletionHooks()`

- [x] **Substitute all `this.view` reads in `responseLoop` (17 sites) with `this.getViewForSession(session)?.`**
  - [x] L1423 `showTruncationWarning()`
  - [x] L1430 `setRespondingState(true)`
  - [x] L1431 `createAbortController()` -> REMOVE, session owns its own `AbortController`
  - [x] L1436 `createAssistantMessagePlaceholder()`
  - [x] L1462 `finalizeAssistantMessage()`
  - [x] L1468 `updateTokenFooter()`
  - [x] L1495 `updateTokenFooter()`
  - [x] L1522 `renderToolCall()`
  - [x] L1571 `updateToolCallProgress()`
  - [x] L1595 `updateToolCallStatus()`
  - [x] L1602 `appendForkButton()`
  - [x] L1633 `renderToolResult()`
  - [x] L1663 `updateTokenFooter()`
  - [x] L1694 `finalizeAssistantMessage()`
  - [x] L1697 `createAssistantMessagePlaceholder()`
  - [x] L1699 `finalizeAssistantMessage()`
  - [x] L1708 `showError()`

- [x] **Substitute other global reads in `responseLoop` (8 sites)**
  - [x] L1386 `this.personaManager?.getActivePersona()` -> `session.pinnedPersona`
  - [x] L1418 `this.getActiveModelId()` -> `session.modelId`
  - [x] L1419 `this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [x] L1438 `this.providerRegistry.getActiveProvider()` -> `this.providerRegistry.getProvider(session.providerType)`
  - [x] L1440 `this.getActiveModelId()` -> `session.modelId`
  - [x] L1442 `this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [x] L1458 `this.calculateCost(in, out)` -> `this.calculateCost(in, out, session.modelId)`
  - [x] L1489 `this.calculateCost(in, out)` -> `this.calculateCost(in, out, session.modelId)`

- [x] **Substitute `resolveEffectiveConfig` call in `responseLoop`**
  - [x] Call `resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona)`
  - [x] Store result on `session.effectiveConfig` and `session.parsedConfigs`
  - [x] If session matches displayed conversation: call `this.updateDisplayConfig()`

- [x] **Thread policy context and approval through tool dispatch**
  - [x] `executeToolBatches()` receives `session.buildPolicyContext(this.settings, vaultRootPath)` and `session.approvalCallback`

- [x] **Update `processStream()` (line 1962) for session-aware view guarding**
  - [x] Add view-resolver parameter: `viewResolver: () => NotorChatView | undefined`
  - [x] L1981 `this.view?.createAssistantMessagePlaceholder()` -> `viewResolver()?.createAssistantMessagePlaceholder()`
  - [x] L1985 `this.view?.appendStreamChunk()` -> `viewResolver()?.appendStreamChunk()`
  - [x] Caller passes `() => this.getViewForSession(session)` as resolver
  - [x] Guard `eagerContentEl` creation at L1436 with `getViewForSession(session)`

- [x] **Update `checkAndPerformCompaction()` (line 1755) to accept session**
  - [x] Change signature to `checkAndPerformCompaction(session: ConversationSession)`
  - [x] L1756 `this.conversationManager.getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [x] L1759 `this.conversationManager.getMessages()` -> `session.conversationManager.getMessages()`
  - [x] L1760 `this.getActiveModelId()` -> `session.modelId`
  - [x] L1762 `this.getActiveUseExtendedContext()` -> `session.useExtendedContext` (note: actual line may differ from spec -- verify)
  - [x] L1786 `this.view?.getMessagesContainer()` -> `this.getViewForSession(session)?.getMessagesContainer()`
  - [x] L1798 `this.providerRegistry.getActiveProvider()` -> `this.providerRegistry.getProvider(session.providerType)`
  - [x] L1811 `this.conversationManager.replaceMessages()` -> `session.conversationManager.replaceMessages()`
  - [x] L1818 `this.conversationManager.addMessage()` -> `session.conversationManager.addMessage()`
  - [x] L1836 compaction marker display -> `this.getViewForSession(session)?.`

- [x] **Update `calculateCost()` (line 2359) to accept optional `modelId`**
  - [x] Change signature: `calculateCost(inputTokens, outputTokens, modelId?: string)`
  - [x] L2360: Use `modelId ?? this.getActiveModelId()` for backward compat

- [x] **Update `dispatchAfterCompletionHooks()` (line 1727) to accept session**
  - [x] Change signature to accept `conversationId: string` or full session
  - [x] L1728: Use parameter instead of `this.conversationManager.getActiveConversation()`

- [x] **Update `switchConversation()` (line 356) for session compatibility**
  - [x] Call `this.view?.setRespondingState(false)` to unlock input on switch
  - [x] Decouple AbortController: session owns its own, not via `this.view?.createAbortController()`
  - [x] Update `onStopResponse` in `wireView()`: dynamically resolve displayed conversation's active session -> call `session.abortController.abort()`

- [x] **Wire mode toggle propagation in `src/main.ts`**
  - [x] In `wireView()` `onModeToggle` callback (line 1942):
    - [x] After `convManager.setMode(mode)`: look up displayed conversation's active session
    - [x] Call `session?.conversationManager.setMode(mode)` to propagate

- [x] **Enforce isolation invariant:** After all substitutions, verify `this.conversationManager` has ZERO reads inside `responseLoop`, `processStream`, `checkAndPerformCompaction`, and `dispatchAfterCompletionHooks`

### Step 1d-workflow: Update `executeWorkflow` to use `ConversationSession`

`executeWorkflow()` is the second caller of `responseLoop()` (at L602). It must also create a `ConversationSession` to match the new signature.

- [x] **Modify `executeWorkflow()` in `src/chat/orchestrator.ts` (line 472)**
  - [x] After creating conversation and adding user message (L574-578), before response loop:
    - [x] Create isolated `ConversationManager` (same pattern as `handleUserMessage`)
    - [x] Snapshot persona: `this.personaManager?.getActivePersona() ?? null` (already switched by L485-498)
    - [x] Snapshot provider: from L536 `providerType`
    - [x] Snapshot model: from L538 `modelId`
    - [x] Snapshot extended context: from L556 `providerConfig?.use_extended_context ?? false`
    - [x] Resolve initial config via `resolveEffectiveConfig(matchedRules, assemblyResult, pinnedPersona)`
    - [x] Create `ConversationSession` with `workflowAssembly: assemblyResult`
  - [x] **Remove** `this.activeWorkflowAssemblyResult = assemblyResult` at L598 -- assembly is now on the session
  - [x] Register session in `this.activeSessions`
  - [x] Store `session.responsePromise = this.responseLoop(currentMode, session)`
  - [x] Preserve hook override lifecycle in try/finally:
    - [x] `workflowHookOverrideManager.activate()` before `responseLoop` (keep at L589-594)
    - [x] `workflowHookOverrideManager.deactivate()` in finally block (keep at L607-608)
    - [x] Add session cleanup to finally: `session.setStatus()`, `this.activeSessions.delete()`, `setRespondingState(false)`

### Phase 1C — Background Loop

### Step 1e: Update `_backgroundResponseLoop` to use sessions

Removes the `activeWorkflowAssemblyResult` save/restore hack and uses `ConversationSession` instead.

- [x] **Modify `_backgroundResponseLoop()` in `src/chat/orchestrator.ts` (line 839)**
  - [x] Remove lines 850-852 (`previousAssemblyResult` save)
  - [x] Remove line 1076 (`previousAssemblyResult` restore)
  - [x] Create `ConversationSession` from existing `bgConvManager`, `workflowAssembly`, and concurrency manager's approval callback
  - [x] Snapshot `useExtendedContext` from provider config for the background execution (extend lines 892-894)
  - [x] Replace `resolveEffectiveConfig(matchedRules)` calls with `resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona)`
  - [x] L895: `this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [x] L909: `use_extended_context: this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [x] L962-964: direct `this.effectiveToolConfig` read -> `session.effectiveConfig.tools[toolName]?.auto_approve ?? false`
  - [x] L975: `dispatcher.dispatch()` -> pass `session.buildPolicyContext()` and `session.approvalCallback`
  - [x] Remove `this.activeWorkflowAssemblyResult` field from class (dead after Step 1d-workflow + 1e -- no remaining consumers)
  - [x] Clean up dead shared-state writes in `newConversation()` at L278-281: remove `this.activeParsedConfigs = []`, `this.effectiveToolConfig = null`, `this.activeWorkflowAssemblyResult = null`, `this.dispatcher.setEffectiveToolConfig(null)` (all now passed per-session, not stored on orchestrator)

### Phase 1D — UI Restoration & Lifecycle

### Step 1f: Display-restore persona + model on `switchConversation`

When loading a conversation, restore its persona/provider/model in the UI without mutating global state.

- [x] **Add `getPersonaByName()` to `src/personas/persona-manager.ts`**
  - [x] New read-only method: `async getPersonaByName(name: string): Promise<Persona | null>`
  - [x] Implementation: call existing `getDiscoveredPersonas()` (line 99), find by name
  - [x] Return `null` if persona has been deleted

- [x] **Add display-only update methods to `src/ui/chat-view.ts`**
  - [x] Add `updateProviderDisplay(providerId: string)` -- updates provider selector UI without triggering global `onProviderChange` callback
  - [x] Add `updateModelDisplay(modelId: string)` -- updates model selector UI without triggering global `onModelChange` callback
  - [x] Add `clearDisplayOverrides()` -- clears display overrides on new conversation or explicit picker change
  - [x] Note: `updatePersonaLabel()` already exists at line 492

- [x] **Modify `switchConversation()` in `src/chat/orchestrator.ts` (line 356)**
  - [x] After loading conversation from history:
    - [x] Display-restore persona: `getPersonaByName(conversation.persona_name)` -> `this.view?.updatePersonaLabel(persona)`
    - [x] Display-restore provider: `this.view?.updateProviderDisplay(conversation.provider_id)` if provider_id present
    - [x] Display-restore model: `this.view?.updateModelDisplay(conversation.model_id)` if model_id present
  - [x] Do NOT call `activatePersona()` or `switchProvider()` (would mutate global state)

- [x] **Pin from restored values on new message send**
  - [x] In `handleUserMessage()`: check if displayed conversation has restored provider/model from JSONL header
  - [x] If so: session pins from header values, not `this.providerRegistry.getActiveType()`
  - [x] If user explicitly changes picker: update both global state AND conversation header
  - [x] For new conversations (no header yet): snapshot from global state as before

- [x] **Wire header mutation on change (Step 1f-addendum)**
  - [x] Note: `HistoryManager.updateConversationHeader()` already exists at history.ts:206-229
  - [x] **Trigger 1 -- On message send (`handleUserMessage()`):**
    - [x] After creating session, compare pinned values against conversation header
    - [x] If dirty: update header fields + call `this.historyManager.updateConversationHeader(conv)`
  - [x] **Trigger 2 -- On picker change in `src/main.ts` `wireView()`:**
    - [x] In `onProviderChange` callback (line 1969): also update conversation header if viewing one
    - [x] In `onModelChange` callback (line 1978): also update conversation header if viewing one
    - [x] In persona change callback: also update conversation header if viewing one

### Step 1g: Inspector shows displayed conversation's config

- [x] **Wire `updateDisplayConfig()` in orchestrator**
  - [x] Call from `responseLoop()` when session matches displayed conversation
  - [x] Call from `switchConversation()` when switching to a conversation with active session (use session's config)
  - [x] `getEffectiveToolConfig()` and `getActiveParsedConfigs()` continue returning stored fields
  - [x] No changes needed to `src/ui/effective-config-inspector.ts`

### Step 1h: Session cleanup on plugin deactivation

- [x] **Add `destroy()` method to `src/chat/orchestrator.ts`**
  ```typescript
  async destroy(timeoutMs: number = 2000): Promise<void>
  ```
  - [x] Signal all active sessions to abort via `session.abortController.abort()`
  - [x] Collect all `session.responsePromise` values
  - [x] `Promise.race([Promise.allSettled(sessionPromises), timeout])` for best-effort cleanup
  - [x] `this.activeSessions.clear()`

- [x] **Wire in `src/main.ts` `onunload()` (line 497)**
  - [x] Call `orchestrator.destroy()` -- fire-and-forget since `onunload()` is synchronous
  - [x] Add before existing cleanup at line 501

### Step 1 Verification

- [ ] All existing Vitest tests pass (Steps 1a-1b are pure refactors)
- [ ] Manual: Start conversation, send message triggering long LLM response
- [ ] Manual: While streaming, switch to different conversation -- verify input unlocked, no stray messages
- [ ] Manual: Send message in new conversation while original is streaming -- both work independently
- [ ] Manual: Original conversation JSONL has complete response, new conversation JSONL is clean
- [ ] Manual: Switch back to original -- all messages render correctly
- [ ] Manual: Try duplicate send to same conversation -- "already processing" Notice appears
- [ ] Manual: Toggle plan->act mid-stream -- next tool dispatch respects act mode
- [ ] Manual: Navigate away mid-stream -- streaming text does NOT appear in wrong view
- [ ] Manual: Trigger compaction mid-stream -- uses session's model ID for threshold
- [ ] Manual: Background workflow + foreground streaming simultaneously -- correct tool configs
- [x] Manual: Persona/model restoration on conversation switch (Step 1f) (E2E: `phase1d-display-restore-test.ts` Tests 1-3)
- [x] Manual: Inspector shows correct config for displayed conversation (Step 1g) (E2E: `phase1d-display-restore-test.ts` Tests 4-6)

---

## Phase 2: Session Registry Enhancements & Sync-Back

> Public session accessors, sync state when user returns to a streaming conversation, deletion guard.

### Step 2a: Public session accessors

- [x] **Add public methods to `src/chat/orchestrator.ts`**
  - [x] `getActiveSessions(): ConversationSession[]` -- returns `Array.from(this.activeSessions.values())`
  - [x] `hasActiveSession(conversationId: string): boolean` -- returns `this.activeSessions.has(conversationId)`

### Step 2b: Sync-back on conversation switch

Full replace from session's in-memory message array when switching to a conversation with an active session.

- [x] **Add `{ silent?: boolean }` option to `loadConversation()` in `src/chat/conversation.ts`**
  - [x] Current signature at line 139: `loadConversation(conversation, messages)`
  - [x] New signature: `loadConversation(conversation, messages, opts?: { silent?: boolean })`
  - [x] When `silent: true`: skip `onConversationChanged` callback at line 148
  - [x] Purpose: prevent mid-stream token count writes during sync-back

- [x] **Update `switchConversation()` in `src/chat/orchestrator.ts` (line 356)**
  - [x] Before loading from history, check `this.activeSessions.has(conversation.id)`
  - [x] **If active session exists:**
    - [x] Get messages from `session.conversationManager.getMessages()`
    - [x] Call `this.conversationManager.loadConversation(conv, messages, { silent: true })`
    - [x] `this.view?.clearMessages()`
    - [x] Re-render all messages via `this.renderMessage(msg)` loop
    - [x] `this.view?.setRespondingState(true)` (stream is ongoing)
    - [x] Register `session.onStatusChange` callback to call `this.view?.setRespondingState(false)` on completion
  - [x] **If no active session:** Load from `HistoryManager` as normal (existing path)

### Step 2c: Deletion guard for active sessions

- [x] **In conversation delete handler in `src/main.ts` `onDeleteConversation` callback**
  - [x] Before showing confirm dialog: check `orchestrator.getActiveSessions()` for matching conversation ID in filename
  - [x] If match found: show Notice "Cannot delete -- conversation is still streaming. Stop it first." and return

### Phase 2 Verification

- [x] Send message, switch away mid-stream, switch back -- all messages render via full replace (E2E: `session-sync-back-test.ts` Test 2)
- [x] Verify JSONL header NOT written during sync-back (silent loadConversation) (E2E: `session-sync-back-test.ts` Test 3)
- [x] Stop button targets active session's AbortController (E2E: `session-sync-back-test.ts` Test 4)
- [x] Wait for completion, navigate back -- shows completed response (JSONL reload path) (E2E: `session-sync-back-test.ts` Test 6)
- [x] `activeSessions` map is empty after all responses complete (E2E: `session-sync-back-test.ts` Test 5)
- [ ] Trigger compaction mid-stream, switch away and back -- full replace handles post-compaction array (manual only -- requires specific token count thresholds)
- [x] Cannot delete a conversation that is still streaming (E2E: `session-sync-back-test.ts` Test 7)

---

## Phase 3: Activity Indicator for Active Conversations

> Badge count and dropdown entries for detached foreground conversations.

### Step 3a: Extend `WorkflowActivityIndicator`

- [x] **Modify `src/ui/workflow-activity-indicator.ts`**
  - [x] Add `getActiveSessions?: () => ConversationSession[]` to constructor (line 51)
  - [x] `updateBadge()` (line 153): include `sessionCount` in total: `const count = workflowCount + sessionCount`
  - [x] `updateAnimationState()` (line 178): include sessions in `hasActive` check

### Step 3b: Extend `WorkflowActivityDropdown`

- [x] **Modify `src/ui/workflow-activity-dropdown.ts`**
  - [x] Add `getActiveSessions?: () => ConversationSession[]` to constructor (line 59)
  - [x] Add "Conversations" section to `renderEntries()` (line 189+)
    - [x] Each entry shows: conversation title, status badge ("Streaming" / "Waiting for approval"), elapsed time
    - [x] Click handler calls `onNavigate(session.conversationId)`

### Step 3c: Wire in `main.ts`

- [x] **Modify `src/main.ts`**
  - [x] Pass session accessor when constructing indicator: `() => orchestrator.getActiveSessions()`
  - [x] Wire `session.onStatusChange` to trigger `indicator.update()` (or have orchestrator emit event)
- [x] **Modify `src/chat/orchestrator.ts`**
  - [x] Add `onSessionsChanged(callback): () => void` public method with `sessionChangeCallbacks` set
  - [x] Add `notifySessionsChanged()` private method fired on session add/remove
  - [x] Clean up callbacks in `destroy()`
- [x] **Modify `src/ui/chat-view.ts`**
  - [x] Add `setGetActiveSessions(getter)` method to accept session accessor
  - [x] Add `updateActivityIndicator()` method for reactive updates
  - [x] Pass `getActiveSessions` to `WorkflowActivityIndicator` constructor

### Phase 3 Verification

- [x] Send message, switch away mid-stream -- badge shows count > 0 (E2E: `session-activity-indicator-test.ts` Test 1)
- [x] Open dropdown -- conversation entry with "Streaming" status visible (E2E: `session-activity-indicator-test.ts` Test 2)
- [x] Click entry -- navigates back to streaming conversation (E2E: `session-activity-indicator-test.ts` Test 3)
- [x] Wait for completion -- badge returns to 0 (E2E: `session-activity-indicator-test.ts` Test 4)

---

## Phase 4: Multiple Chat Panels

> Allow opening additional Notor chat panels, each with its own orchestrator sharing infrastructure singletons.

### Step 4a: Secondary panel option (same view type)

- [x] **Modify `src/ui/chat-view.ts`**
  - [x] Add `isSecondary?: boolean` to constructor options
  - [x] Full toolbar for secondary panels (same as primary)
  - [x] Implement `getState()` / `setState()` for workspace restore:
    - [x] Save: `{ conversationId, isSecondary }`
    - [x] Restore: set `isSecondary`, load conversation from ID via `onSwitchToConversationById`
  - [x] Note: chat-view.ts currently has NO getState/setState -- these are entirely new

### Step 4b: Per-panel orchestrator

- [x] **Modify `src/main.ts`**
  - [x] Update `registerView(CHAT_VIEW_TYPE, ...)` callback to detect primary vs. secondary
  - [x] For each secondary leaf: create new `ChatOrchestrator` sharing singletons (`ProviderRegistry`, `HistoryManager`, `SystemPromptBuilder`, `ToolDispatcher`, etc.)
  - [x] Refactor `wireView()` to accept orchestrator as parameter (currently reads from `this._orchestrator`)
  - [x] Call same `wireView()` for both primary and secondary (no `wireSecondaryView`)

- [x] **Add per-orchestrator provider/model fields**
  - [x] Each `ChatOrchestrator` tracks own `activeProviderType` and `activeModelId`
  - [x] Initialize from `ProviderRegistry.getActiveType()` at construction
  - [x] Picker changes update panel's orchestrator, NOT global `ProviderRegistry`

- [x] **Update singleton-assumption code**
  - [x] `getLeavesOfType(CHAT_VIEW_TYPE)` at lines 2182, 2199: handle multiple leaves
  - [x] Add `getPrimaryChatLeaf()` helper to filter

### Step 4c: Per-server MCP dispatch queue

> **Dependency:** Requires [`task-lane-queue-design.md`](./task-lane-queue-design.md) to be implemented first.

- [x] **Modify `src/mcp/mcp-hub.ts` (line 449)**
  - [x] Add `private readonly taskQueue?: TaskLaneQueue` constructor parameter (optional for backward compat)
  - [x] Extract call logic from `callTool()` into private `executeCallTool()`
  - [x] `callTool()` becomes: validation + `return this.taskQueue.enqueue(\`mcp:${serverName}\`, () => this.executeCallTool(...), 0)`
  - [x] Fallback to direct `executeCallTool()` when no `taskQueue` injected

- [x] **Modify `src/main.ts`**
  - [x] Pass `this.getTaskLaneQueue()` to `McpHub` constructor

### Step 4d: Command registration

- [x] **Add command in `src/main.ts`**
  - [x] ID: `open-secondary-chat`, Name: "Open new chat panel"
  - [x] Opens new tab leaf with `{ type: CHAT_VIEW_TYPE, state: { isSecondary: true } }`

### Step 4e: Remove global `setApprovalCallback()` fallback

- [x] **Modify `src/chat/dispatcher.ts`**
  - [x] Remove `getApprovalCallback()` method — orchestrator no longer reads from dispatcher
  - [x] Move approval callback ownership to per-orchestrator `panelApprovalCallback` field
  - [x] `dispatch()` policy path uses per-call `approvalCallback` only; legacy path falls back to instance field for sub-agent dispatchers
  - [x] Verify all callers pass per-call callback (main send path, background loop, workflow execution)

### Step 4f: Global listener audit

Audit all callbacks/listeners in `wireView()` and `ChatOrchestrator` constructor for safe duplication.

- [x] **Safe to duplicate per-panel (no changes needed):**
  - [x] `conversationManager.setOnMessageAdded()` (orchestrator.ts:127)
  - [x] `conversationManager.setOnConversationChanged()` (orchestrator.ts:134)
  - [x] `view.setOnSendMessage()`, `view.setOnSendWorkflow()`
  - [x] `view.setOnModeToggle()`
  - [x] `view.setOnOpenConversationList()`, `view.setOnSearchConversations()`
  - [x] Read-only provider/model getters
  - [x] Checkpoint callbacks
  - [x] Export callback

- [x] **Must NOT duplicate -- refactor:**
  - [x] `app.workspace.on("active-leaf-change")` (main.ts:417): single global listener (already in onload, not wireView — no change needed)
  - [x] `view.setOnProviderChange()` (main.ts:1969): update panel's orchestrator + global registry
  - [x] `view.setOnModelChange()` (main.ts:1978): update panel's orchestrator + global registry
  - [x] `personaManager.setOnPersonaNameChanged()`: guarded with `_personaNameChangeWired` to run once; broadcasts header update to all orchestrators
  - [x] `personaManager.setOnPersonaChanged()`: converted to multi-listener Set on PersonaManager; each view registers/unregisters independently
  - [x] `personaManager.restoreFromSettings()`: guarded to run only for primary panel
  - [x] Conversation history auto-restore at end of wireView: skipped for secondary panels (they restore via setState)
  - [x] `view.setOnNewConversation()` (main.ts:1785): global operations (loadSettings, stale clear) are idempotent — safe per-panel
  - [x] `view.setOnSwitchConversation()` (main.ts:1834): global clears (StaleTracker, VaultRuleManager) are idempotent — safe per-panel
  - [x] `view.setOnDeleteConversation()` (main.ts:1885): guard checks per-orchestrator active sessions — safe per-panel
  - [x] `view.setOnForkConversation()` (main.ts:1851): per-panel orchestrator + idempotent global clears — safe per-panel

### Phase 4 Verification

- [ ] Open secondary panel via command -- full toolbar appears
- [ ] Send messages in both panels simultaneously -- separate JSONL files
- [ ] Close + reopen Obsidian -- secondary panel restores with its conversation
- [ ] Change provider in Panel A -- Panel B's next new conversation uses Panel B's provider
- [ ] MCP tools from both panels to same server -- per-server serialization (no concurrent JSON-RPC)
- [ ] Settings changes, new conversation, switch callbacks don't double-fire across panels

---

## Phase 5: "Open in New Tab" from Conversation History

> Context menu option to open any conversation in a new secondary panel.

### Step 5a: Add menu item

- [ ] **Modify `src/ui/chat-view.ts`**
  - [ ] In conversation list 3-dot context menu: add "Open in new tab" item with `external-link` icon
  - [ ] Add callback setter: `setOnOpenInNewTab(callback: (filename: string) => void)`

### Step 5b: Wire callback

- [ ] **Modify `src/main.ts`**
  - [ ] Wire `view.setOnOpenInNewTab()` to create new tab leaf with `{ type: CHAT_VIEW_TYPE, state: { conversationFilename: filename, isSecondary: true } }`

### Phase 5 Verification

- [ ] Open conversation history, click 3-dot menu -> "Open in new tab"
- [ ] Conversation opens in new secondary panel with full message history
- [ ] Works for favorited and non-favorited conversations

---

## Files Modified Summary

| File | Phases | Changes |
|------|--------|---------|
| `src/chat/tool-policy.ts` | 1a | **NEW** -- `evaluateToolPolicy()`, `ToolPolicyContext`, `PolicyDecision` |
| `src/chat/conversation-session.ts` | 1c | **NEW** -- `ConversationSession` class |
| `src/chat/dispatcher.ts` | 1a, 4e | Optional `policyCtx` + `approvalCallback` on `dispatch()`; remove global fallback (P4) |
| `src/chat/tool-orchestration.ts` | 1a | Thread `policyCtx` + `approvalCallback` through batch execution |
| `src/chat/orchestrator.ts` | 1b-1h (incl. 1d-workflow), 2a-2c | Pure `resolveEffectiveConfig`, session creation/management (handleUserMessage + executeWorkflow + background), sync-back, display-restore, inspector, destroy, dead shared-state cleanup |
| `src/chat/conversation.ts` | 2b | `{ silent?: boolean }` option on `loadConversation()` |
| `src/chat/history.ts` | -- | No changes (already has `updateConversationHeader`, `enqueueWrite`) |
| `src/personas/persona-manager.ts` | 1f | Add `getPersonaByName()` read-only lookup |
| `src/ui/chat-view.ts` | 1d, 1f, 4a, 5a | AbortController decoupling, display-only update methods, `getState`/`setState`, menu item |
| `src/main.ts` | 1d, 1f, 1h, 3c, 4b, 4d, 5b | Mode propagation, picker header updates, destroy wiring, indicator wiring, panel management |
| `src/ui/workflow-activity-indicator.ts` | 3a | Dual data source (workflows + sessions) |
| `src/ui/workflow-activity-dropdown.ts` | 3b | Conversation entries section |
| `src/mcp/mcp-hub.ts` | 4c | Accept injected `TaskLaneQueue` for per-server serialization (see [`task-lane-queue-design.md`](./task-lane-queue-design.md)) |
