# Thread-Safe Streaming & Multi-Panel Chat: Implementation Tasks

**Spec:** [thread-safe-streaming-multi-panel-design.md](./thread-safe-streaming-multi-panel-design.md)
**Created:** 2026-04-08

---

## Phase 1: Per-Conversation Session Isolation

> Bug fix + architecture. Independently shippable. Fixes data corruption on mid-stream conversation switch.

### Step 1a: Extract tool policy from dispatcher (pure refactor)

Extracts policy enforcement from `ToolDispatcher.dispatch()` into a pure function. No behavior change -- all existing tests must continue to pass.

- [ ] **Create `src/chat/tool-policy.ts`**
  - [ ] Define `ToolPolicyContext` interface with fields: `effectiveConfig: EffectiveToolConfig`, `mode: ConversationMode`, `domainDenylist?: string[]`, `vaultRootPath: string`
  - [ ] Define `PolicyDecision` interface with fields: `allowed: boolean`, `autoApproved: boolean`, `error?: string`
  - [ ] Implement `evaluateToolPolicy(toolName, parameters, tool, ctx)` pure function extracting these checks from `dispatcher.ts`:
    - [ ] Enabled check (dispatcher.ts:292-310) -- reads `ctx.effectiveConfig`
    - [ ] Plan/Act mode check (dispatcher.ts:312-332) -- reads `ctx.mode` + `tool.mode`
    - [ ] Domain denylist check (dispatcher.ts:337-363) -- reads `ctx.domainDenylist`, preserves `toolName === "fetch_webpage"` guard
    - [ ] Auto-approve resolution (dispatcher.ts:365-406) -- reads `ctx.effectiveConfig`, handles MCP/built-in branching
    - [ ] Path enforcement (dispatcher.ts:412-438) -- reads `ctx.effectiveConfig` + `ctx.vaultRootPath`
  - [ ] Export all types and the function

- [ ] **Modify `src/chat/dispatcher.ts`**
  - [ ] Add optional `policyCtx?: ToolPolicyContext` parameter to `dispatch()` (line 262)
  - [ ] Add optional `approvalCallback?: ApprovalCallback` parameter to `dispatch()` (line 262)
  - [ ] When `policyCtx` provided: call `evaluateToolPolicy()` instead of inline policy checks
  - [ ] When `approvalCallback` provided: use it instead of `this.approvalCallback`
  - [ ] When omitted: fallback to current behavior (backward compat during migration)

- [ ] **Modify `src/chat/tool-orchestration.ts`**
  - [ ] Add `policyCtx?: ToolPolicyContext` parameter to `executeToolBatches()` (line 112)
  - [ ] Add `approvalCallback?: ApprovalCallback` parameter to `executeToolBatches()` (line 112)
  - [ ] Thread both through to `runConcurrentBatch()` (line 186) and `safeDispatch()` (line 249)
  - [ ] `safeDispatch()` passes them to `dispatcher.dispatch()` (line 258)

- [ ] **Verify:** All existing tests pass unchanged (pure refactor, fallback path exercises old code)

### Step 1b: Make `resolveEffectiveConfig` pure (pure refactor)

Changes `resolveEffectiveConfig()` from mutating shared state to returning a structured result. Breaking change to return type -- all call sites must be updated.

- [ ] **Modify `resolveEffectiveConfig()` in `src/chat/orchestrator.ts` (line 1138)**
  - [ ] Change signature to accept explicit parameters:
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
  - [ ] Line 1141: Use `activePersona` parameter instead of `this.personaManager?.getActivePersona() ?? null`
  - [ ] Line 1148: Use `workflowAssembly?.toolConfigs ?? []` instead of `this.activeWorkflowAssemblyResult?.toolConfigs ?? []`
  - [ ] Lines 1184-1188: REMOVE the three mutations (`this.activeParsedConfigs`, `this.effectiveToolConfig`, `this.dispatcher.setEffectiveToolConfig()`)
  - [ ] Return `{ effective, toolDefinitions, parsedConfigs }` instead of just `ToolDefinition[]`

- [ ] **Add `updateDisplayConfig()` helper to `src/chat/orchestrator.ts`**
  - [ ] Method stores `effective` and `parsedConfigs` on orchestrator fields for inspector access
  - [ ] `getEffectiveToolConfig()` (line 249) and `getActiveParsedConfigs()` (line 258) continue returning these fields

- [ ] **Update all call sites** (return type changes from `ToolDefinition[]` to structured object):
  - [ ] `responseLoop()` (line 1378): Destructure result, update `session.effectiveConfig` and `session.parsedConfigs`, call `updateDisplayConfig()` for displayed conversation
  - [ ] `_backgroundResponseLoop()` (multiple sites): Destructure result
  - [ ] `handleUserMessage()` (if called there): Destructure result
  - [ ] `executeWorkflow()` (line 472+): Destructure result

- [ ] **Verify:** Inspector still shows correct config. Background workflow tool config still works. `activeWorkflowAssemblyResult` save/restore hack (lines 851-852, 1076) will be eliminated in Step 1e.

### Step 1c: Create `ConversationSession` class

New file encapsulating all per-conversation state for an active response loop.

- [ ] **Create `src/chat/conversation-session.ts`**
  - [ ] Define `SessionStatus` type: `"running" | "waiting_approval" | "completed" | "errored" | "cancelled"`
  - [ ] Implement `ConversationSession` class with fields:
    - [ ] `readonly conversationId: string`
    - [ ] `readonly conversationManager: ConversationManager` (isolated per-session)
    - [ ] `readonly abortController: AbortController` (independent per-session)
    - [ ] `readonly title: string`
    - [ ] `readonly startedAt: number`
    - [ ] `effectiveConfig: EffectiveToolConfig` (updated each iteration)
    - [ ] `parsedConfigs: ParsedToolConfig[]` (updated each iteration)
    - [ ] `readonly pinnedPersona: Persona | null` (snapshotted, immutable)
    - [ ] `readonly providerType: LLMProviderType` (snapshotted, immutable)
    - [ ] `readonly modelId: string` (snapshotted, immutable)
    - [ ] `readonly useExtendedContext: boolean` (snapshotted, immutable)
    - [ ] `readonly workflowAssembly: WorkflowAssemblyResult | null` (snapshotted, immutable)
    - [ ] `readonly approvalCallback: ApprovalCallback` (bound to correct panel)
    - [ ] `responsePromise?: Promise<void>` (set by handleUserMessage, used by destroy)
    - [ ] `private _status: SessionStatus` (defaults to "running")
    - [ ] `onStatusChange?: (session: ConversationSession) => void`
  - [ ] Implement `get status()` getter
  - [ ] Implement `setStatus(status)` setter that calls `onStatusChange` callback
  - [ ] Implement `buildPolicyContext(settings, vaultRootPath): ToolPolicyContext`
    - [ ] Reads `effectiveConfig` from session
    - [ ] Reads `mode` dynamically from `this.conversationManager.getActiveConversation()?.mode` (mode can toggle mid-stream)
    - [ ] Reads `domainDenylist` from settings
    - [ ] Reads `vaultRootPath` from parameter
  - [ ] Constructor accepts options object with all readonly fields + `initialConfig` + `initialParsedConfigs`

### Step 1d: Update `responseLoop` to use `ConversationSession`

This is the largest step. Replaces all shared-state reads in the response path with session-scoped reads.

- [ ] **Add `activeSessions` map to `src/chat/orchestrator.ts`**
  - [ ] `private activeSessions = new Map<string, ConversationSession>()`
  - [ ] Add `getActiveSession(conversationId: string): ConversationSession | undefined` accessor

- [ ] **Add `getViewForSession()` helper**
  ```typescript
  private getViewForSession(session: ConversationSession): NotorChatView | undefined {
    const displayConvId = this.conversationManager.getActiveConversation()?.id;
    return session.conversationId === displayConvId ? this.view : undefined;
  }
  ```

- [ ] **Modify `handleUserMessage()` (line 1217)**
  - [ ] Add duplicate-send guard: `if (this.activeSessions.has(conv.id))` -> show Notice, return
  - [ ] Snapshot conversation + messages from `this.conversationManager`
  - [ ] Create isolated `ConversationManager` (pattern from `executeBackgroundWorkflow`, lines 710-724)
  - [ ] Wire `onMessageAdded` / `onConversationChanged` to `this.historyManager`
  - [ ] Load snapshot into new manager via `loadConversation()`
  - [ ] Snapshot persona: `this.personaManager?.getActivePersona() ?? null`
  - [ ] Snapshot provider: conversation header `provider_id` if provider still configured, else `this.providerRegistry.getActiveType()`
  - [ ] Snapshot model: conversation header `model_id` if provider still configured, else `this.getActiveModelId()`
  - [ ] Snapshot extended context: `this.providerRegistry.getConfig(providerType)?.use_extended_context ?? false`
  - [ ] Resolve initial config via pure `resolveEffectiveConfig(matchedRules, null, pinnedPersona)`
  - [ ] Create `ConversationSession` with all snapshots
  - [ ] Register in `this.activeSessions`
  - [ ] Store response loop promise: `session.responsePromise = this.responseLoop(mode, session)`
  - [ ] Update finally block to clean up session:
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

- [ ] **Change `responseLoop()` signature**
  ```typescript
  private async responseLoop(mode: ConversationMode, session: ConversationSession): Promise<void>
  ```

- [ ] **Substitute all `this.conversationManager` reads in `responseLoop` (14 sites)**
  - [ ] L1400 `getMessages()` -> `session.conversationManager.getMessages()`
  - [ ] L1408 `getActiveConversation()!.id` -> `session.conversationManager.getActiveConversation()!.id`
  - [ ] L1453 `addMessage()` -> `session.conversationManager.addMessage()`
  - [ ] L1466 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [ ] L1484 `addMessage()` -> `session.conversationManager.addMessage()`
  - [ ] L1493 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [ ] L1511 `addMessage()` -> `session.conversationManager.addMessage()`
  - [ ] L1527 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [ ] L1619 `addMessage()` -> `session.conversationManager.addMessage()`
  - [ ] L1630 `addTokens()` -> `session.conversationManager.addTokens()`
  - [ ] L1638 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [ ] L1661 `getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [ ] L1687 `addMessage()` -> `session.conversationManager.addMessage()`
  - [ ] L1728 `getActiveConversation()` -> pass `session` or `conversationId` to `dispatchAfterCompletionHooks()`

- [ ] **Substitute all `this.view` reads in `responseLoop` (17 sites) with `this.getViewForSession(session)?.`**
  - [ ] L1423 `showTruncationWarning()`
  - [ ] L1430 `setRespondingState(true)`
  - [ ] L1431 `createAbortController()` -> REMOVE, session owns its own `AbortController`
  - [ ] L1436 `createAssistantMessagePlaceholder()`
  - [ ] L1462 `finalizeAssistantMessage()`
  - [ ] L1468 `updateTokenFooter()`
  - [ ] L1495 `updateTokenFooter()`
  - [ ] L1522 `renderToolCall()`
  - [ ] L1571 `updateToolCallProgress()`
  - [ ] L1595 `updateToolCallStatus()`
  - [ ] L1602 `appendForkButton()`
  - [ ] L1633 `renderToolResult()`
  - [ ] L1663 `updateTokenFooter()`
  - [ ] L1694 `finalizeAssistantMessage()`
  - [ ] L1697 `createAssistantMessagePlaceholder()`
  - [ ] L1699 `finalizeAssistantMessage()`
  - [ ] L1708 `showError()`

- [ ] **Substitute other global reads in `responseLoop` (8 sites)**
  - [ ] L1386 `this.personaManager?.getActivePersona()` -> `session.pinnedPersona`
  - [ ] L1418 `this.getActiveModelId()` -> `session.modelId`
  - [ ] L1419 `this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [ ] L1438 `this.providerRegistry.getActiveProvider()` -> `this.providerRegistry.getProvider(session.providerType)`
  - [ ] L1440 `this.getActiveModelId()` -> `session.modelId`
  - [ ] L1442 `this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [ ] L1458 `this.calculateCost(in, out)` -> `this.calculateCost(in, out, session.modelId)`
  - [ ] L1489 `this.calculateCost(in, out)` -> `this.calculateCost(in, out, session.modelId)`

- [ ] **Substitute `resolveEffectiveConfig` call in `responseLoop`**
  - [ ] Call `resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona)`
  - [ ] Store result on `session.effectiveConfig` and `session.parsedConfigs`
  - [ ] If session matches displayed conversation: call `this.updateDisplayConfig()`

- [ ] **Thread policy context and approval through tool dispatch**
  - [ ] `executeToolBatches()` receives `session.buildPolicyContext(this.settings, vaultRootPath)` and `session.approvalCallback`

- [ ] **Update `processStream()` (line 1962) for session-aware view guarding**
  - [ ] Add view-resolver parameter: `viewResolver: () => NotorChatView | undefined`
  - [ ] L1981 `this.view?.createAssistantMessagePlaceholder()` -> `viewResolver()?.createAssistantMessagePlaceholder()`
  - [ ] L1985 `this.view?.appendStreamChunk()` -> `viewResolver()?.appendStreamChunk()`
  - [ ] Caller passes `() => this.getViewForSession(session)` as resolver
  - [ ] Guard `eagerContentEl` creation at L1436 with `getViewForSession(session)`

- [ ] **Update `checkAndPerformCompaction()` (line 1755) to accept session**
  - [ ] Change signature to `checkAndPerformCompaction(session: ConversationSession)`
  - [ ] L1756 `this.conversationManager.getActiveConversation()` -> `session.conversationManager.getActiveConversation()`
  - [ ] L1759 `this.conversationManager.getMessages()` -> `session.conversationManager.getMessages()`
  - [ ] L1760 `this.getActiveModelId()` -> `session.modelId`
  - [ ] L1762 `this.getActiveUseExtendedContext()` -> `session.useExtendedContext` (note: actual line may differ from spec -- verify)
  - [ ] L1786 `this.view?.getMessagesContainer()` -> `this.getViewForSession(session)?.getMessagesContainer()`
  - [ ] L1798 `this.providerRegistry.getActiveProvider()` -> `this.providerRegistry.getProvider(session.providerType)`
  - [ ] L1811 `this.conversationManager.replaceMessages()` -> `session.conversationManager.replaceMessages()`
  - [ ] L1818 `this.conversationManager.addMessage()` -> `session.conversationManager.addMessage()`
  - [ ] L1836 compaction marker display -> `this.getViewForSession(session)?.`

- [ ] **Update `calculateCost()` (line 2359) to accept optional `modelId`**
  - [ ] Change signature: `calculateCost(inputTokens, outputTokens, modelId?: string)`
  - [ ] L2360: Use `modelId ?? this.getActiveModelId()` for backward compat

- [ ] **Update `dispatchAfterCompletionHooks()` (line 1727) to accept session**
  - [ ] Change signature to accept `conversationId: string` or full session
  - [ ] L1728: Use parameter instead of `this.conversationManager.getActiveConversation()`

- [ ] **Update `switchConversation()` (line 356) for session compatibility**
  - [ ] Call `this.view?.setRespondingState(false)` to unlock input on switch
  - [ ] Decouple AbortController: session owns its own, not via `this.view?.createAbortController()`
  - [ ] Update `onStopResponse` in `wireView()`: dynamically resolve displayed conversation's active session -> call `session.abortController.abort()`

- [ ] **Wire mode toggle propagation in `src/main.ts`**
  - [ ] In `wireView()` `onModeToggle` callback (line 1942):
    - [ ] After `convManager.setMode(mode)`: look up displayed conversation's active session
    - [ ] Call `session?.conversationManager.setMode(mode)` to propagate

- [ ] **Enforce isolation invariant:** After all substitutions, verify `this.conversationManager` has ZERO reads inside `responseLoop`, `processStream`, `checkAndPerformCompaction`, and `dispatchAfterCompletionHooks`

### Step 1e: Update `_backgroundResponseLoop` to use sessions

Removes the `activeWorkflowAssemblyResult` save/restore hack and uses `ConversationSession` instead.

- [ ] **Modify `_backgroundResponseLoop()` in `src/chat/orchestrator.ts` (line 839)**
  - [ ] Remove lines 850-852 (`previousAssemblyResult` save)
  - [ ] Remove line 1076 (`previousAssemblyResult` restore)
  - [ ] Create `ConversationSession` from existing `bgConvManager`, `workflowAssembly`, and concurrency manager's approval callback
  - [ ] Snapshot `useExtendedContext` from provider config for the background execution (extend lines 892-894)
  - [ ] Replace `resolveEffectiveConfig(matchedRules)` calls with `resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona)`
  - [ ] L895: `this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [ ] L909: `use_extended_context: this.getActiveUseExtendedContext()` -> `session.useExtendedContext`
  - [ ] L962-964: direct `this.effectiveToolConfig` read -> `session.effectiveConfig.tools[toolName]?.auto_approve ?? false`
  - [ ] L975: `dispatcher.dispatch()` -> pass `session.buildPolicyContext()` and `session.approvalCallback`
  - [ ] Remove `this.activeWorkflowAssemblyResult` field from class (if no other consumers)

### Step 1f: Display-restore persona + model on `switchConversation`

When loading a conversation, restore its persona/provider/model in the UI without mutating global state.

- [ ] **Add `getPersonaByName()` to `src/personas/persona-manager.ts`**
  - [ ] New read-only method: `async getPersonaByName(name: string): Promise<Persona | null>`
  - [ ] Implementation: call existing `getDiscoveredPersonas()` (line 99), find by name
  - [ ] Return `null` if persona has been deleted

- [ ] **Add display-only update methods to `src/ui/chat-view.ts`**
  - [ ] Add `updateProviderDisplay(providerId: string)` -- updates provider selector UI without triggering global `onProviderChange` callback
  - [ ] Add `updateModelDisplay(modelId: string)` -- updates model selector UI without triggering global `onModelChange` callback
  - [ ] Note: `updatePersonaLabel()` already exists at line 492

- [ ] **Modify `switchConversation()` in `src/chat/orchestrator.ts` (line 356)**
  - [ ] After loading conversation from history:
    - [ ] Display-restore persona: `getPersonaByName(conversation.persona_name)` -> `this.view?.updatePersonaLabel(persona)`
    - [ ] Display-restore provider: `this.view?.updateProviderDisplay(conversation.provider_id)` if provider_id present
    - [ ] Display-restore model: `this.view?.updateModelDisplay(conversation.model_id)` if model_id present
  - [ ] Do NOT call `activatePersona()` or `switchProvider()` (would mutate global state)

- [ ] **Pin from restored values on new message send**
  - [ ] In `handleUserMessage()`: check if displayed conversation has restored provider/model from JSONL header
  - [ ] If so: session pins from header values, not `this.providerRegistry.getActiveType()`
  - [ ] If user explicitly changes picker: update both global state AND conversation header
  - [ ] For new conversations (no header yet): snapshot from global state as before

- [ ] **Wire header mutation on change (Step 1f-addendum)**
  - [ ] Note: `HistoryManager.updateConversationHeader()` already exists at history.ts:206-229
  - [ ] **Trigger 1 -- On message send (`handleUserMessage()`):**
    - [ ] After creating session, compare pinned values against conversation header
    - [ ] If dirty: update header fields + call `this.historyManager.updateConversationHeader(conv)`
  - [ ] **Trigger 2 -- On picker change in `src/main.ts` `wireView()`:**
    - [ ] In `onProviderChange` callback (line 1969): also update conversation header if viewing one
    - [ ] In `onModelChange` callback (line 1978): also update conversation header if viewing one
    - [ ] In persona change callback: also update conversation header if viewing one

### Step 1g: Inspector shows displayed conversation's config

- [ ] **Wire `updateDisplayConfig()` in orchestrator**
  - [ ] Call from `responseLoop()` when session matches displayed conversation
  - [ ] Call from `switchConversation()` when switching to a conversation with active session (use session's config)
  - [ ] `getEffectiveToolConfig()` and `getActiveParsedConfigs()` continue returning stored fields
  - [ ] No changes needed to `src/ui/effective-config-inspector.ts`

### Step 1h: Session cleanup on plugin deactivation

- [ ] **Add `destroy()` method to `src/chat/orchestrator.ts`**
  ```typescript
  async destroy(timeoutMs: number = 2000): Promise<void>
  ```
  - [ ] Signal all active sessions to abort via `session.abortController.abort()`
  - [ ] Collect all `session.responsePromise` values
  - [ ] `Promise.race([Promise.allSettled(sessionPromises), timeout])` for best-effort cleanup
  - [ ] `this.activeSessions.clear()`

- [ ] **Wire in `src/main.ts` `onunload()` (line 497)**
  - [ ] Call `orchestrator.destroy()` -- fire-and-forget since `onunload()` is synchronous
  - [ ] Add before existing cleanup at line 501

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
- [ ] Manual: Persona/model restoration on conversation switch (Step 1f)
- [ ] Manual: Inspector shows correct config for displayed conversation (Step 1g)

---

## Phase 2: Session Registry Enhancements & Sync-Back

> Public session accessors, sync state when user returns to a streaming conversation, deletion guard.

### Step 2a: Public session accessors

- [ ] **Add public methods to `src/chat/orchestrator.ts`**
  - [ ] `getActiveSessions(): ConversationSession[]` -- returns `Array.from(this.activeSessions.values())`
  - [ ] `hasActiveSession(conversationId: string): boolean` -- returns `this.activeSessions.has(conversationId)`

### Step 2b: Sync-back on conversation switch

Full replace from session's in-memory message array when switching to a conversation with an active session.

- [ ] **Add `{ silent?: boolean }` option to `loadConversation()` in `src/chat/conversation.ts`**
  - [ ] Current signature at line 139: `loadConversation(conversation, messages)`
  - [ ] New signature: `loadConversation(conversation, messages, opts?: { silent?: boolean })`
  - [ ] When `silent: true`: skip `onConversationChanged` callback at line 148
  - [ ] Purpose: prevent mid-stream token count writes during sync-back

- [ ] **Update `switchConversation()` in `src/chat/orchestrator.ts` (line 356)**
  - [ ] Before loading from history, check `this.activeSessions.has(conversation.id)`
  - [ ] **If active session exists:**
    - [ ] Get messages from `session.conversationManager.getMessages()`
    - [ ] Call `this.conversationManager.loadConversation(conv, messages, { silent: true })`
    - [ ] `this.view?.clearMessages()`
    - [ ] Re-render all messages via `this.renderMessage(msg)` loop
    - [ ] `this.view?.setRespondingState(true)` (stream is ongoing)
    - [ ] Register `session.onStatusChange` callback to call `this.view?.setRespondingState(false)` on completion
  - [ ] **If no active session:** Load from `HistoryManager` as normal (existing path)

### Step 2c: Deletion guard for active sessions

- [ ] **In conversation delete handler in `src/chat/orchestrator.ts`**
  - [ ] Before deleting: `if (this.activeSessions.has(conversationId))` -> show Notice "Cannot delete -- conversation is still streaming. Stop it first." and return
  - [ ] Also wire in `src/main.ts` `onDeleteConversation` callback (line 1885) if the guard is on the orchestrator side

### Phase 2 Verification

- [ ] Send message, switch away mid-stream, switch back -- all messages render via full replace
- [ ] Verify JSONL header NOT written during sync-back (silent loadConversation)
- [ ] Stop button targets active session's AbortController
- [ ] Wait for completion, navigate back -- shows completed response (JSONL reload path)
- [ ] `activeSessions` map is empty after all responses complete
- [ ] Trigger compaction mid-stream, switch away and back -- full replace handles post-compaction array
- [ ] Cannot delete a conversation that is still streaming

---

## Phase 3: Activity Indicator for Active Conversations

> Badge count and dropdown entries for detached foreground conversations.

### Step 3a: Extend `WorkflowActivityIndicator`

- [ ] **Modify `src/ui/workflow-activity-indicator.ts`**
  - [ ] Add `getActiveSessions?: () => ConversationSession[]` to constructor (line 51)
  - [ ] `updateBadge()` (line 153): include `sessionCount` in total: `const count = workflowCount + sessionCount`
  - [ ] `updateAnimationState()` (line 178): include sessions in `hasActive` check

### Step 3b: Extend `WorkflowActivityDropdown`

- [ ] **Modify `src/ui/workflow-activity-dropdown.ts`**
  - [ ] Add `getActiveSessions?: () => ConversationSession[]` to constructor (line 59)
  - [ ] Add "Conversations" section to `renderEntries()` (line 189+)
    - [ ] Each entry shows: conversation title, status badge ("Streaming" / "Waiting for approval"), elapsed time
    - [ ] Click handler calls `onNavigate(session.conversationId)`

### Step 3c: Wire in `main.ts`

- [ ] **Modify `src/main.ts`**
  - [ ] Pass session accessor when constructing indicator: `() => orchestrator.getActiveSessions()`
  - [ ] Wire `session.onStatusChange` to trigger `indicator.update()` (or have orchestrator emit event)

### Phase 3 Verification

- [ ] Send message, switch away mid-stream -- badge shows count > 0
- [ ] Open dropdown -- conversation entry with "Streaming" status visible
- [ ] Click entry -- navigates back to streaming conversation
- [ ] Wait for completion -- badge returns to 0

---

## Phase 4: Multiple Chat Panels

> Allow opening additional Notor chat panels, each with its own orchestrator sharing infrastructure singletons.

### Step 4a: Secondary panel option (same view type)

- [ ] **Modify `src/ui/chat-view.ts`**
  - [ ] Add `isSecondary?: boolean` to constructor options
  - [ ] Full toolbar for secondary panels (same as primary)
  - [ ] Implement `getState()` / `setState()` for workspace restore:
    - [ ] Save: `{ conversationFilename, isSecondary }`
    - [ ] Restore: set `isSecondary`, load conversation from filename
  - [ ] Note: chat-view.ts currently has NO getState/setState -- these are entirely new

### Step 4b: Per-panel orchestrator

- [ ] **Modify `src/main.ts`**
  - [ ] Update `registerView(CHAT_VIEW_TYPE, ...)` callback to detect primary vs. secondary
  - [ ] For each secondary leaf: create new `ChatOrchestrator` sharing singletons (`ProviderRegistry`, `HistoryManager`, `SystemPromptBuilder`, `ToolDispatcher`, etc.)
  - [ ] Refactor `wireView()` to accept orchestrator as parameter (currently reads from `this._orchestrator`)
  - [ ] Call same `wireView()` for both primary and secondary (no `wireSecondaryView`)

- [ ] **Add per-orchestrator provider/model fields**
  - [ ] Each `ChatOrchestrator` tracks own `activeProviderType` and `activeModelId`
  - [ ] Initialize from `ProviderRegistry.getActiveType()` at construction
  - [ ] Picker changes update panel's orchestrator, NOT global `ProviderRegistry`

- [ ] **Update singleton-assumption code**
  - [ ] `getLeavesOfType(CHAT_VIEW_TYPE)` at lines 2182, 2199: handle multiple leaves
  - [ ] Add `getPrimaryChatLeaf()` helper to filter

### Step 4c: Per-server MCP dispatch queue

- [ ] **Modify `src/mcp/mcp-hub.ts` (line 449)**
  - [ ] Add `private readonly callQueues = new Map<string, Promise<unknown>>()`
  - [ ] Implement `enqueueCall<T>(serverName, operation)` -- same pattern as `HistoryManager.enqueueWrite()` (history.ts:127-138)
  - [ ] Extract call logic from `callTool()` into private `executeCallTool()`
  - [ ] `callTool()` becomes: validation + `return this.enqueueCall(serverName, () => this.executeCallTool(...))`

### Step 4d: Command registration

- [ ] **Add command in `src/main.ts`**
  - [ ] ID: `open-secondary-chat`, Name: "Open new chat panel"
  - [ ] Opens new tab leaf with `{ type: CHAT_VIEW_TYPE, state: { isSecondary: true } }`

### Step 4e: Remove global `setApprovalCallback()` fallback

- [ ] **Modify `src/chat/dispatcher.ts`**
  - [ ] Remove `setApprovalCallback()` method (line 148) and `approvalCallback` field (line 100)
  - [ ] `dispatch()` requires per-call `approvalCallback` (already added in Step 1a)
  - [ ] Verify all callers pass per-call callback

### Step 4f: Global listener audit

Audit all callbacks/listeners in `wireView()` and `ChatOrchestrator` constructor for safe duplication.

- [ ] **Safe to duplicate per-panel (no changes needed):**
  - [ ] `conversationManager.setOnMessageAdded()` (orchestrator.ts:127)
  - [ ] `conversationManager.setOnConversationChanged()` (orchestrator.ts:134)
  - [ ] `view.setOnSendMessage()`, `view.setOnSendWorkflow()`
  - [ ] `view.setOnModeToggle()`
  - [ ] `view.setOnOpenConversationList()`, `view.setOnSearchConversations()`
  - [ ] Read-only provider/model getters
  - [ ] Checkpoint callbacks
  - [ ] Export callback

- [ ] **Must NOT duplicate -- refactor:**
  - [ ] `app.workspace.on("active-leaf-change")` (main.ts:417): single global listener
  - [ ] `view.setOnProviderChange()` (main.ts:1969): update panel's orchestrator, not global registry
  - [ ] `view.setOnModelChange()` (main.ts:1978): same treatment
  - [ ] `view.setOnNewConversation()` (main.ts:1785): split into per-panel (orchestrator.newConversation) + plugin-level (settings reload)
  - [ ] `view.setOnSwitchConversation()` (main.ts:1834): split global clears (StaleTracker, VaultRuleManager) from per-panel switch
  - [ ] `view.setOnDeleteConversation()` (main.ts:1885): same global-clear split
  - [ ] `view.setOnForkConversation()` (main.ts:1851): same global-clear split

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
| `src/chat/orchestrator.ts` | 1b-1h, 2a-2c | Pure `resolveEffectiveConfig`, session creation/management, sync-back, display-restore, inspector, destroy |
| `src/chat/conversation.ts` | 2b | `{ silent?: boolean }` option on `loadConversation()` |
| `src/chat/history.ts` | -- | No changes (already has `updateConversationHeader`, `enqueueWrite`) |
| `src/personas/persona-manager.ts` | 1f | Add `getPersonaByName()` read-only lookup |
| `src/ui/chat-view.ts` | 1d, 1f, 4a, 5a | AbortController decoupling, display-only update methods, `getState`/`setState`, menu item |
| `src/main.ts` | 1d, 1f, 1h, 3c, 4b, 4d, 5b | Mode propagation, picker header updates, destroy wiring, indicator wiring, panel management |
| `src/ui/workflow-activity-indicator.ts` | 3a | Dual data source (workflows + sessions) |
| `src/ui/workflow-activity-dropdown.ts` | 3b | Conversation entries section |
| `src/mcp/mcp-hub.ts` | 4c | Per-server promise queue |
