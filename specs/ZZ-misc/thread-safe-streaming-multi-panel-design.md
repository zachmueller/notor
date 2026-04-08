# Thread-Safe Streaming & Multi-Panel Chat

**Status:** Design complete — revised after second codebase cross-reference audit (added `useExtendedContext` pin, `calculateCost` session-awareness, `dispatchAfterCompletionHooks` fix, compaction provider fix, exhaustive shared-state enumeration table)
**Author:** Design spike
**Date:** 2026-04-08

---

## 1. Motivation

Notor's `ChatOrchestrator` uses a single `ConversationManager` with one `activeConversation` field. When a user switches conversations while an LLM response is streaming, the `onMessageAdded` callback resolves the target conversation via `getActiveConversation()` — which now points to the *new* conversation. This causes the in-flight response to either write to the wrong JSONL file (corrupting the new conversation) or get dropped entirely.

**The problems:**

1. **Data corruption on navigation** — Switching conversations mid-stream re-routes the response to the wrong JSONL file, breaking conversation thread integrity.

2. **No concurrent foreground conversations** — Only one LLM conversation can run at a time. Users cannot kick off a new conversation while one is still streaming.

3. **No visibility into detached responses** — When a user navigates away from a streaming conversation, there is no indication that work is still happening in the background.

4. **Single chat panel** — Users cannot view or interact with multiple conversations simultaneously.

**Existing pattern to generalize:** `executeBackgroundWorkflow()` ([`src/chat/orchestrator.ts:644`](../../src/chat/orchestrator.ts)) already creates a separate `ConversationManager` per background execution, wired to the shared `HistoryManager`. The foreground conversation needs the same isolation.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Isolation unit | `ConversationSession` class per conversation (while active) | One active `ConversationSession` per conversation at a time. Duplicate sends to the same conversation are rejected. Each session owns: isolated `ConversationManager`, resolved `EffectiveToolConfig`, pinned persona, snapshotted provider type + model ID, approval callback, abort controller. All per-conversation state lives here — not on shared orchestrator/dispatcher fields. |
| Dispatcher architecture | Split into registry (global) + policy (pure function, per-call) | `ToolDispatcher` becomes a pure registry: lookup + execute. Policy checks (enabled, auto-approve, path constraints) extracted to `evaluateToolPolicy()` pure function. Each session builds a `ToolPolicyContext` from its own resolved config. Eliminates all shared mutable config state on the dispatcher. |
| Config resolution | `resolveEffectiveConfig` is pure (no side effects) | Accepts `(matchedRules, workflowAssembly?, activePersona?)`, returns `{ effective, toolDefinitions, parsedConfigs }`. No writes to orchestrator or dispatcher fields. Eliminates the `activeWorkflowAssemblyResult` save/restore hack in the background loop. Persona passed explicitly — not read from global `PersonaManager`. |
| Per-conversation persistence | Display-restore AND use persona + model from JSONL header on load | `Conversation` header already stores `persona_name` ([`types.ts:56`](../../src/types.ts)), `provider_id`, `model_id`. `switchConversation()` updates the UI display (persona label, model selector) without calling `activatePersona()` or `switchProvider()` — those mutate global state and would corrupt active sessions. The restored provider/model are also used for the next message sent in this conversation (not the global state), ensuring display and behavior are consistent. |
| UI ↔ streaming decoupling | `this.conversationManager` becomes "UI display manager" only | The main orchestrator's `conversationManager` tracks what's *shown* in the panel. Response loops use the session's isolated manager. Switching the display manager has no effect on in-flight responses. |
| Inspector scoping | Shows config for the currently displayed conversation | Orchestrator keeps `effectiveToolConfig` / `activeParsedConfigs` fields for inspector, but only updates them from the displayed conversation's session (or on explicit conversation switch). |
| Activity indicator | Extend existing `WorkflowActivityIndicator` | Reuse the badge + dropdown pattern rather than adding a separate icon. Combined count: workflows + foreground sessions. |
| Multi-panel approach | Reuse `CHAT_VIEW_TYPE` with per-panel orchestrator | Same view type, differentiated by `{ isSecondary: true }` constructor option. Each panel gets its own `ChatOrchestrator` (lightweight — shares expensive singletons like `ProviderRegistry`, `HistoryManager`, `SystemPromptBuilder`). Own `ConversationManager` for independent state. Avoids maintaining two view registrations and divergent wire-up paths. |
| Secondary panel toolbar | Full toolbar (same as primary) | Secondary panels get the same toolbar as primary. Per-session scoping from Phase 1 means persona, provider, and tool config are already isolated. No reason to artificially reduce secondary panel capability. |
| Sync-back on return | Full replace from session's in-memory message array | `clearMessages()` + re-render all messages from `session.conversationManager.getMessages()`. Same pattern already used by `switchConversation()` (orchestrator.ts:365-368). Compaction-safe (no index tracking to break). Performance is acceptable because compaction keeps conversations under ~200 messages in memory. Scroll lands at bottom (desired behavior when returning to active stream). Falls back to JSONL reload for completed sessions without an active session. |
| Tool approval routing | Per-session approval callback | Each `ConversationSession` owns its approval callback (bound to the correct panel's view). Passed per-`dispatch()` call — no global `setApprovalCallback()`. Each panel/session routes approvals to its own UI without conflict. |
| Shared vs. per-conversation state | Only infrastructure stays global | Global: MCP connections (with per-server dispatch queues added in Phase 4), tool registry (implementations), provider registry (API connections — instances cached, but which provider/model to use is per-session; per-orchestrator active provider/model fields in Phase 4), history manager (file I/O), vault rule manager, system prompt builder. Per-conversation: effective tool config, persona, provider type, model ID, mode, approval routing, abort controller, conversation manager. |
| MCP concurrency | Per-server promise queue in `McpHub` (Phase 4) | MCP servers may not handle concurrent JSON-RPC requests safely (many are single-threaded). Add a per-server promise queue to `McpHub.callTool()` using the same `Map<string, Promise>` + `enqueueWrite()` pattern as `HistoryManager.writeQueues` ([`history.ts:93-138`](../../src/chat/history.ts)). Note: MCP tools are already serialized *within* a single session by `tool-orchestration.ts:91` (`isMcpTool()` → sequential batch). The queue only matters for *cross-session* concurrent access (Phase 4 multi-panel) — deferred to Phase 4 to keep Phase 1 focused. |

---

## 3. Architecture Overview

### Current Architecture (Single-Threaded)

```
ChatView (UI)
    ↕ callbacks
ChatOrchestrator (single shared instance — one per plugin, not enforced as singleton)
    → ConversationManager (instance-per-orchestrator, mutable activeConversation)
        → onMessageAdded → HistoryManager.appendMessage(getActiveConversation(), msg)
    → ToolDispatcher (shared instance — mixes registry + policy + mutable config state)
        → effectiveToolConfig: set per-iteration, read at dispatch time (RACE!)
        → approvalCallback: shared instance field (can't route to correct panel)
```

**Problems:**
- `getActiveConversation()` resolves at write time, not at request time.
- `resolveEffectiveConfig()` mutates shared state on orchestrator + dispatcher every loop iteration.
- Concurrent loops (foreground + background, or multiple foreground) overwrite each other's config.
- Background loop uses save/restore hack for `activeWorkflowAssemblyResult` (not concurrent-safe).

### Proposed Architecture (Per-Conversation Sessions)

```
ChatView (UI)
    ↕ callbacks
ChatOrchestrator
    → this.conversationManager          (UI display state — what's shown in the panel)
    → activeSessions: Map<convId, ConversationSession>
        → session.conversationManager   (isolated ConversationManager per response)
            → onMessageAdded → HistoryManager.appendMessage(session.conv, msg)
        → session.effectiveConfig       (resolved per-iteration, stored per-session)
        → session.pinnedPersona         (snapshotted at session start)
        → session.approvalCallback      (bound to correct panel's view)
        → session.abortController       (independent per-session)
    → ToolDispatcher                    (pure registry — lookup + execute only)
    → evaluateToolPolicy()              (pure function — reads session's config)
```

**Fixes:**
- Each response loop creates its own `ConversationManager`. Writes always target the correct conversation.
- `resolveEffectiveConfig()` is pure — returns config without mutating shared state.
- Each session owns its resolved config. No shared mutable `effectiveToolConfig` on dispatcher.
- Policy enforcement is a pure function called per-dispatch with the session's config.
- Approval callbacks route to the correct panel via the session.

### Multi-Panel Architecture

```
Primary NotorChatView
    → ChatOrchestrator (primary — full toolbar)
        → ConversationManager (UI display)
        → activeSessions Map<convId, ConversationSession>

Secondary NotorChatView(s)
    → ChatOrchestrator (per-panel — full toolbar)
        → ConversationManager (independent display)
        → activeSessions Map<convId, ConversationSession>

Shared singletons (infrastructure only):
    → ToolDispatcher (registry: lookup + execute — NO policy state)
    → ProviderRegistry
    → HistoryManager (with per-file write queues)
    → SystemPromptBuilder
    → PersonaManager
    → VaultRuleManager
```

---

## 4. Implementation Phases

### Phase 1: Per-Conversation Session Isolation (Bug Fix + Architecture)

**Goal:** In-flight LLM responses always write to the correct JSONL file regardless of UI navigation. All per-conversation state is scoped to a `ConversationSession`. Tool policy enforcement is pure (no shared mutable state). Loading a conversation restores its persona and model.

**Scope:** This phase fixes the data corruption bug, eliminates the `resolveEffectiveConfig` concurrency hazard (former Phase 0), and ships the per-conversation state model. Independently shippable.

#### 4.1.1 Step 1a: Extract tool policy from dispatcher (pure refactor)

**Problem:** `ToolDispatcher.dispatch()` mixes two concerns: tool registry (lookup + execute) and policy enforcement (enabled/auto-approve/path constraints). Policy reads from `this.effectiveToolConfig` — shared mutable state that concurrent loops overwrite.

**New file: `src/chat/tool-policy.ts`**

```typescript
export interface ToolPolicyContext {
  effectiveConfig: EffectiveToolConfig;
  mode: ConversationMode;
  domainDenylist?: string[];
  vaultRootPath: string;
}

export interface PolicyDecision {
  allowed: boolean;
  autoApproved: boolean;
  error?: string;
}

/**
 * Pure function — evaluates tool policy without reading any shared state.
 * Extracts checks from dispatcher.ts:292-438.
 */
export function evaluateToolPolicy(
  toolName: string,
  parameters: Record<string, unknown>,
  tool: DispatchableTool,
  ctx: ToolPolicyContext,
): PolicyDecision
```

Extracts these checks from `dispatcher.ts`:
- Enabled check (L293-310) → reads `ctx.effectiveConfig`
- Plan/Act mode check (L312-332) → reads `ctx.mode` + `tool.mode`
- Domain denylist check (L334-363) → reads `ctx.domainDenylist` (note: currently hardcoded to `toolName === "fetch_webpage"` — the extracted function must preserve this tool-specific guard)
- Auto-approve resolution (L365-406) → reads `ctx.effectiveConfig` (note: extends to ~L406 due to fallback MCP/built-in branching logic)
- Path enforcement (L412-438) → reads `ctx.effectiveConfig` + `ctx.vaultRootPath`

**Changes to `src/chat/dispatcher.ts`:**
- `dispatch()` gains optional `policyCtx?: ToolPolicyContext` and `approvalCallback?: ApprovalCallback` parameters
- When `policyCtx` provided: call `evaluateToolPolicy()` instead of reading `this.effectiveToolConfig`
- When `approvalCallback` provided: use it instead of `this.approvalCallback`
- When omitted: fallback to current behavior (backward compat during migration)

**Changes to `src/chat/tool-orchestration.ts`:**
- `executeToolBatches()`, `safeDispatch()`, `runConcurrentBatch()` gain `policyCtx?` and `approvalCallback?` params, threading them through to `dispatcher.dispatch()`

**Verification:** All existing tests pass unchanged (fallback path exercises old code). Pure refactor.

#### 4.1.2 Step 1b: Make `resolveEffectiveConfig` pure (pure refactor)

**Problem:** `resolveEffectiveConfig()` mutates three shared fields and reads a fourth:
- **Mutates** `this.activeParsedConfigs` (orchestrator, L1184)
- **Mutates** `this.effectiveToolConfig` (orchestrator, L1185)
- **Mutates** `this.dispatcher.effectiveToolConfig` (via `setEffectiveToolConfig()`, L1188)
- **Reads** `this.activeWorkflowAssemblyResult` (written by background loop's save/restore hack at L851-852)

**Current signature** (L1138-1140):
```typescript
private async resolveEffectiveConfig(
  matchedRules?: VaultRule[],
): Promise<ToolDefinition[]>
```

**New signature** (breaking change — return type changes from `ToolDefinition[]` to structured object; all call sites must be updated):
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

Changes inside the method:
- L1141: Use `activePersona` parameter instead of `this.personaManager?.getActivePersona() ?? null`
- L1148: `workflowAssembly?.toolConfigs ?? []` instead of `this.activeWorkflowAssemblyResult?.toolConfigs ?? []`
- L1184-1188: **REMOVE** — no longer stores on orchestrator fields or injects into dispatcher
- Returns `{ effective, toolDefinitions, parsedConfigs }`

**Call site migration:** Every caller currently expects `ToolDefinition[]`. After this change, callers must destructure the result: `const { effective, toolDefinitions, parsedConfigs } = await this.resolveEffectiveConfig(...)`. Audit all call sites in `responseLoop()`, `_backgroundResponseLoop()`, and `handleUserMessage()`.

**Inspector bridge:** Add `updateDisplayConfig(effective, parsedConfigs)` helper that callers invoke explicitly for the displayed conversation only. `getEffectiveToolConfig()` and `getActiveParsedConfigs()` continue returning these fields for the inspector.

**Verification:** Existing behavior preserved. Inspector works for single-conversation case. Background loop's `activeWorkflowAssemblyResult` save/restore hack (L851-852, L1076) eliminated.

#### 4.1.3 Step 1c: Create `ConversationSession` class

**New file: `src/chat/conversation-session.ts`**

```typescript
export type SessionStatus =
  | "running"
  | "waiting_approval"
  | "completed"
  | "errored"
  | "cancelled";

export class ConversationSession {
  readonly conversationId: string;
  readonly conversationManager: ConversationManager;
  readonly abortController: AbortController;
  readonly title: string;
  readonly startedAt: number;

  // Per-session resolved state (updated after resolveEffectiveConfig each iteration)
  effectiveConfig: EffectiveToolConfig;
  parsedConfigs: ParsedToolConfig[];

  // Snapshotted at session creation — immutable for the session's lifetime
  readonly pinnedPersona: Persona | null;
  readonly providerType: LLMProviderType;
  readonly modelId: string;
  readonly useExtendedContext: boolean;
  readonly workflowAssembly: WorkflowAssemblyResult | null;

  // Per-session routing
  readonly approvalCallback: ApprovalCallback;

  // The response loop promise — used by destroy() to await cleanup.
  responsePromise?: Promise<void>;

  // Tracks the last message index rendered in the UI — used for incremental
  // append when the user switches back to this conversation mid-stream.
  // Not needed — sync-back uses full replace from session's in-memory messages.
  // Incremental append was rejected due to fragility under compaction.

  private _status: SessionStatus = "running";
  onStatusChange?: (session: ConversationSession) => void;

  constructor(opts: {
    conversationManager: ConversationManager;
    abortController: AbortController;
    title: string;
    pinnedPersona: Persona | null;
    providerType: LLMProviderType;
    modelId: string;
    useExtendedContext: boolean;
    workflowAssembly?: WorkflowAssemblyResult | null;
    approvalCallback: ApprovalCallback;
    initialConfig: EffectiveToolConfig;
    initialParsedConfigs: ParsedToolConfig[];
  });

  get status(): SessionStatus;
  setStatus(status: SessionStatus): void;

  /**
   * Build a ToolPolicyContext from this session's resolved state.
   *
   * Design note — why `mode` is dynamic while persona/provider are pinned:
   * - Persona is pinned because it affects system prompt content and tool config
   *   resolution. Changing it mid-stream would produce incoherent instructions.
   * - Provider/model are pinned because switching mid-stream would break the
   *   conversation format (different providers have different tool_call schemas).
   * - Mode (plan/act) is a user-facing toggle that gates tool execution policy.
   *   Users expect toggling plan→act to take immediate effect (e.g., to unblock
   *   a tool call that was blocked in plan mode). The risk of mid-stream policy
   *   change is accepted as a deliberate user action.
   *
   * Mode propagation: The mode toggle callback (main.ts) must propagate
   * changes to the active session's ConversationManager — not just the
   * display manager. See Step 1d "Mode toggle propagation" below.
   */
  buildPolicyContext(settings: NotorSettings, vaultRootPath: string): ToolPolicyContext {
    return {
      effectiveConfig: this.effectiveConfig,
      mode: this.conversationManager.getActiveConversation()?.mode ?? "act",
      domainDenylist: settings.domain_denylist,
      vaultRootPath,
    };
  }
}
```

#### 4.1.4 Step 1d: Update `responseLoop` to use `ConversationSession`

**`handleUserMessage()` (line 1217):**

After existing guards, before `responseLoop()`:

0. **Duplicate-send guard:** `if (this.activeSessions.has(conv.id))` → show `new Notice("This conversation is already processing")` and return. Prevents a second session for the same conversation, which would cause interleaved JSONL writes (the same corruption class this spec fixes).
1. Snapshot current conversation + messages from `this.conversationManager`
2. Create isolated `ConversationManager` (same pattern as `executeBackgroundWorkflow` L710-724)
3. Wire `onMessageAdded` / `onConversationChanged` to `this.historyManager`
4. Load snapshot into new manager via `loadConversation()`
5. Snapshot persona: `const pinnedPersona = this.personaManager?.getActivePersona() ?? null`
6. Snapshot provider: Use the conversation header's `provider_id` if the provider is still configured (restored conversation), otherwise fall back to `this.providerRegistry.getActiveType()` (new conversation or unavailable provider)
7. Snapshot model: Use the conversation header's `model_id` if the provider is still configured (restored conversation), otherwise fall back to `this.getActiveModelId()` (new conversation or unavailable provider)
7b. Snapshot extended context: `const useExtendedContext = this.providerRegistry.getConfig(providerType)?.use_extended_context ?? false` — pinned at session creation like provider/model, since it determines context window size for truncation and compaction thresholds
8. Resolve initial config via pure `resolveEffectiveConfig(matchedRules, null, pinnedPersona)`
9. Create `ConversationSession` with all the above (including `providerType`, `modelId`)
10. Store response loop promise on session: `session.responsePromise = this.responseLoop(mode, session)`
11. Register in `this.activeSessions: Map<string, ConversationSession>`

**`responseLoop()` signature:**
```typescript
private async responseLoop(
  mode: ConversationMode,
  session: ConversationSession,
): Promise<void>
```

Inside the loop, all shared state reads become session reads:
- `this.conversationManager` → `session.conversationManager` (also for `getMessages()` call at L1400 and `addMessage()` calls)
- `this.personaManager?.getActivePersona()` → `session.pinnedPersona`
- `this.providerRegistry.getActiveProvider()` → `this.providerRegistry.getProvider(session.providerType)` (provider pinned from conversation header or global state at session creation)
- `this.getActiveModelId()` → `session.modelId` (model pinned from conversation header or global state at session creation)
- `this.getActiveUseExtendedContext()` → `session.useExtendedContext` (pinned at session creation from provider config — determines context window size for truncation and compaction)
- `this.calculateCost(inputTokens, outputTokens)` → `this.calculateCost(inputTokens, outputTokens, session.modelId)` (add optional `modelId` parameter to `calculateCost()` with fallback to `this.getActiveModelId()` for backward compat; the method internally calls `getActiveModelId()` to look up pricing — with sessions, the global active model may differ from the session's pinned model)
- `resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona)` → updates `session.effectiveConfig` and `session.parsedConfigs`
- If session matches displayed conversation: `this.updateDisplayConfig(session.effectiveConfig, session.parsedConfigs)`
- `executeToolBatches()` passes `session.buildPolicyContext(this.settings, vaultRootPath)` and `session.approvalCallback`
- `checkAndPerformCompaction(session)` accepts the full `ConversationSession`. The method currently reads five pieces of shared state that must all come from the session: (1) `this.conversationManager` → `session.conversationManager` for conversation and messages, (2) `this.getActiveModelId()` → `session.modelId` for token threshold calculation, (3) `this.getActiveUseExtendedContext()` → `session.useExtendedContext` for window size, (4) `this.view?.getMessagesContainer?.()` → `this.getViewForSession(session)?.getMessagesContainer?.()` for the compacting indicator, (5) `this.providerRegistry.getActiveProvider()` → `this.providerRegistry.getProvider(session.providerType)` for the compaction summarization LLM call (L1798). Getting the provider wrong would send the compaction summary to the wrong LLM; getting model ID wrong would use the wrong compaction threshold; getting the view wrong would show the indicator in the wrong panel.
- `toChatMessages()` is called at L1427 but defined at L2074. It is a `private` instance method on the orchestrator, not a free function. While its core logic doesn't read `this` state (it operates on the `messages` and `systemPrompt` parameters), it does call `log.warn()` (L2101). For session isolation, it can remain on the orchestrator (session calls through the orchestrator instance). The caller changes to pass messages from `session.conversationManager`

**View render guarding:**
```typescript
/** Returns the view only if it's currently displaying this session's conversation. */
private getViewForSession(session: ConversationSession): NotorChatView | undefined {
  const displayConvId = this.conversationManager.getActiveConversation()?.id;
  return session.conversationId === displayConvId ? this.view : undefined;
}
```

All `this.view?.` calls inside `responseLoop` change to `this.getViewForSession(session)?.`. When the user navigates away, render calls become no-ops. Data writes continue unaffected.

**Critical: `processStream()` must also use session-aware view guarding.** `processStream()` (called at L1448) is the most view-intensive method in the response loop — it handles token-by-token streaming text rendering via `this.view` callbacks. If the user navigates away mid-stream and `processStream()` still references `this.view`, streaming tokens render into the wrong conversation's DOM.

**Approach:** `processStream()` accepts a view-resolver function `() => this.getViewForSession(session)` and re-resolves on each chunk. This handles mid-stream navigation: when the user switches away, the resolver returns `undefined` and rendering becomes a no-op while data writes continue. When the user switches back, sync-back re-renders all messages from the session's in-memory array.

**`eagerContentEl` guarding:** The placeholder created at L1436 via `this.view?.createAssistantMessagePlaceholder()` must also use `getViewForSession`. If the user navigates away before `processStream` starts, the placeholder would be created in the wrong panel's DOM. Change to:
```typescript
const view = this.getViewForSession(session);
const eagerContentEl = view?.createAssistantMessagePlaceholder();
```
If `eagerContentEl` is null (user already navigated away), `processStream` streams silently — the assistant message is still added to the session's `ConversationManager` and persisted to JSONL, just not rendered until sync-back.

This is the most visible symptom of the navigation bug — streaming text appearing in the wrong panel — so it must not be missed.

**`switchConversation()` (line 356):**

1. **Reset `isResponding`:** Call `this.view?.setRespondingState(false)` to unlock input.
2. **Decouple AbortController:** Session owns its own `AbortController` (not via `this.view?.createAbortController()`). The existing `onStopResponse` callback in `wireView()` is updated to dynamically resolve the session: find displayed conversation ID → look up in `activeSessions` map → call `session.abortController.abort()`. Falls back to existing behavior if no active session. No new view API needed.

**Mode toggle propagation:**

The mode toggle callback in `main.ts` currently calls `orchestrator.getConversationManager().setMode(mode)` — this only updates the display manager. Since `buildPolicyContext()` reads mode from the **session's** `ConversationManager`, the toggle must also propagate to the active session:

```typescript
// In main.ts wireView(), extend the existing onModeToggle callback:
view.setOnModeToggle((mode) => {
  const convManager = orchestrator.getConversationManager();
  convManager.setMode(mode);

  // Propagate to active session so buildPolicyContext reads the new mode
  const displayedConvId = convManager.getActiveConversation()?.id;
  if (displayedConvId) {
    const session = orchestrator.getActiveSession(displayedConvId);
    session?.conversationManager.setMode(mode);
  }
});
```

Without this wiring, toggling plan→act mid-stream would have no effect on tool policy — `buildPolicyContext()` would keep returning the mode from session start.

**Message flow:**
1. Add user message to `this.conversationManager` (persists to JSONL, renders in UI)
2. Snapshot conversation + messages into session's isolated manager
3. Run `responseLoop(mode, session)` — all assistant/tool messages go through session manager

The session manager's `onMessageAdded` only fires for NEW messages added during the response loop, avoiding double-writes.

**Session cleanup on completion:**

The `responseLoop`'s `finally` block must remove the session from `activeSessions` and update its status. Without this, the duplicate-send guard permanently blocks re-sending to completed conversations, and Phase 3's activity indicator shows phantom "active" sessions.

```typescript
// In the finally block of the response loop (or handleUserMessage's try/catch wrapper):
try {
  await this.responseLoop(mode, session);
} catch (e) {
  session.setStatus("errored");
  this.handleError(e);
} finally {
  if (session.status === "running" || session.status === "waiting_approval") {
    session.setStatus("completed");
  }
  this.activeSessions.delete(session.conversationId);
  this.view?.setRespondingState(false);
}
```

Completed sessions are removed immediately — no grace period. Switch-back after completion falls through to the standard JSONL reload path in `switchConversation()`.

**`dispatchAfterCompletionHooks()` session awareness:** The `responseLoop`'s `finally` block (L1711) calls `dispatchAfterCompletionHooks()` (L1727), which reads `this.conversationManager.getActiveConversation()` at L1728 to obtain the `conversationId` for hook payloads. After mid-stream navigation, the shared manager points to the *new* conversation — so the hook fires with the wrong `conversationId`. Fix: change the method to accept a `conversationId: string` parameter (or the full session), and have the `finally` block pass `session.conversationManager.getActiveConversation()?.id`.

**Isolation invariant:** After this refactor, `this.conversationManager` must have **zero reads** inside `responseLoop`, `processStream`, and any method they call (including `checkAndPerformCompaction` and `dispatchAfterCompletionHooks`). Since `switchConversation()` mutates the shared manager mid-stream, any straggling `this.conversationManager` read in the response path would silently resolve to the wrong conversation. All reads must go through `session.conversationManager`.

**Complete shared-state access enumeration:** The following is an exhaustive list of every `this.conversationManager`, `this.view`, and other global-state read inside `responseLoop`, `processStream`, and `checkAndPerformCompaction` — each must be substituted during this step. Use this as a checklist during implementation.

*`this.conversationManager` in `responseLoop` (14 sites):*
| Line | Call | Substitution |
|------|------|-------------|
| L1400 | `getMessages()` | `session.conversationManager.getMessages()` |
| L1408 | `getActiveConversation()!.id` | `session.conversationManager.getActiveConversation()!.id` |
| L1453 | `addMessage()` (text result) | `session.conversationManager.addMessage()` |
| L1466 | `getActiveConversation()` (token footer) | `session.conversationManager.getActiveConversation()` |
| L1484 | `addMessage()` (tool call tokens) | `session.conversationManager.addMessage()` |
| L1493 | `getActiveConversation()` (tool call token footer) | `session.conversationManager.getActiveConversation()` |
| L1511 | `addMessage()` (tool_call) | `session.conversationManager.addMessage()` |
| L1527 | `getActiveConversation()` (hook dispatch) | `session.conversationManager.getActiveConversation()` |
| L1619 | `addMessage()` (tool_result) | `session.conversationManager.addMessage()` |
| L1630 | `addTokens()` (sub-agent tokens) | `session.conversationManager.addTokens()` |
| L1638 | `getActiveConversation()` (hook dispatch) | `session.conversationManager.getActiveConversation()` |
| L1661 | `getActiveConversation()` (token footer after tool result) | `session.conversationManager.getActiveConversation()` |
| L1687 | `addMessage()` (cancelled) | `session.conversationManager.addMessage()` |
| L1728 | `getActiveConversation()` (after-completion hooks) | Pass `session` or `conversationId` to `dispatchAfterCompletionHooks()` |

*`this.conversationManager` in `checkAndPerformCompaction` (5 sites):*
| Line | Call | Substitution |
|------|------|-------------|
| L1756 | `getActiveConversation()` | `session.conversationManager.getActiveConversation()` |
| L1759 | `getMessages()` | `session.conversationManager.getMessages()` |
| L1811 | `replaceMessages()` | `session.conversationManager.replaceMessages()` |
| L1818 | `addMessage()` (pending re-append) | `session.conversationManager.addMessage()` |
| L1827 | `appendMessage(conv, ...)` via historyManager | No change needed — `conv` is a local variable |

*`this.view` in `responseLoop` (17 sites) — all become `this.getViewForSession(session)?.`:*
| Line | Call |
|------|------|
| L1423 | `showTruncationWarning()` |
| L1430 | `setRespondingState(true)` |
| L1431 | `createAbortController()` — **removed**: session owns its own `AbortController` |
| L1436 | `createAssistantMessagePlaceholder()` |
| L1462 | `finalizeAssistantMessage()` |
| L1468 | `updateTokenFooter()` |
| L1495 | `updateTokenFooter()` |
| L1522 | `renderToolCall()` |
| L1571 | `updateToolCallProgress()` |
| L1595 | `updateToolCallStatus()` |
| L1602 | `appendForkButton()` |
| L1633 | `renderToolResult()` |
| L1663 | `updateTokenFooter()` |
| L1694 | `finalizeAssistantMessage()` |
| L1697 | `createAssistantMessagePlaceholder()` |
| L1699 | `finalizeAssistantMessage()` |
| L1708 | `showError()` |

*`this.view` in `processStream` (2 sites) — use view-resolver function:*
| Line | Call |
|------|------|
| L1981 | `createAssistantMessagePlaceholder()` |
| L1985 | `appendStreamChunk()` |

*`this.view` in `checkAndPerformCompaction` (2 sites) — become `this.getViewForSession(session)?.`:*
| Line | Call |
|------|------|
| L1786 | `getMessagesContainer()` |
| L1836 | (compaction marker display) |

*Other global reads in `responseLoop` (8 sites):*
| Line | Current | Substitution |
|------|---------|-------------|
| L1386 | `this.personaManager?.getActivePersona()` | `session.pinnedPersona` |
| L1418 | `this.getActiveModelId()` | `session.modelId` |
| L1419 | `this.getActiveUseExtendedContext()` | `session.useExtendedContext` |
| L1438 | `this.providerRegistry.getActiveProvider()` | `this.providerRegistry.getProvider(session.providerType)` |
| L1440 | `this.getActiveModelId()` | `session.modelId` |
| L1442 | `this.getActiveUseExtendedContext()` | `session.useExtendedContext` |
| L1458 | `this.calculateCost(in, out)` | `this.calculateCost(in, out, session.modelId)` |
| L1489 | `this.calculateCost(in, out)` | `this.calculateCost(in, out, session.modelId)` |

*Other global reads in `checkAndPerformCompaction` (2 sites):*
| Line | Current | Substitution |
|------|---------|-------------|
| L1760 | `this.getActiveModelId()` | `session.modelId` |
| L1798 | `this.providerRegistry.getActiveProvider()` | `this.providerRegistry.getProvider(session.providerType)` |

#### 4.1.5 Step 1e: Update `_backgroundResponseLoop` to use sessions

The background loop currently uses a save/restore hack for `activeWorkflowAssemblyResult` (L851-852, L1076). With sessions, this goes away.

**Changes:**
- Remove L850-852 (`previousAssemblyResult` save) and L1076 (restore)
- Create a `ConversationSession` for the background execution using the existing `bgConvManager`, the `workflowAssembly` parameter, and the concurrency manager's approval callback. Snapshot `useExtendedContext` from the provider config used for the background execution (L892-894 resolve provider type and model — extend to also resolve `use_extended_context`)
- `resolveEffectiveConfig(matchedRules, session.workflowAssembly)` passes assembly directly
- L895: `this.getActiveUseExtendedContext()` → `session.useExtendedContext` (context window assembly)
- L909: `use_extended_context: this.getActiveUseExtendedContext()` → `use_extended_context: session.useExtendedContext` (send message options)
- L962-964 (direct `this.effectiveToolConfig` read): replaced with `session.effectiveConfig.tools[toolName]?.auto_approve ?? false`
- L975 `dispatcher.dispatch()` call: passes `session.buildPolicyContext()` and `session.approvalCallback`

#### 4.1.6 Step 1f: Display-restore persona + model on `switchConversation`

The `Conversation` header already stores `persona_name` ([`types.ts:56`](../../src/types.ts)), `provider_id`, and `model_id`. Currently `switchConversation()` ignores them on load.

**Important:** Restoration must NOT call `activatePersona()` or `switchProvider()` — those mutate global settings, persist to disk, and fire callbacks that would corrupt active sessions. Instead, use display-only updates.

**Changes to `switchConversation()` (~L356):**

After loading conversation from history manager:
```typescript
// Display-restore persona label from conversation header
// (Does NOT call activatePersona — no global mutation)
// NOTE: getPersonaByName() is a **NEW** read-only method that must be
// added to PersonaManager. Implementation: calls getDiscoveredPersonas()
// (which exists at persona-manager.ts:99) and finds by name.
// Returns null if the persona has been deleted since the conversation was created.
const persona = conversation.persona_name
  ? await this.personaManager?.getPersonaByName(conversation.persona_name) ?? null
  : null;
this.view?.updatePersonaLabel(persona);

// Display-restore provider/model in UI selectors
// (Does NOT call switchProvider — no global mutation)
// NOTE: updateProviderDisplay() and updateModelDisplay() are NEW methods
// that must be added to NotorChatView. The view currently has callback
// setters (setOnProviderChange, setOnModelChange) but no display-only
// update methods. These new methods must update the UI selector state
// without triggering the global provider/model switch callbacks.
if (conversation.provider_id) {
  this.view?.updateProviderDisplay(conversation.provider_id);
}
if (conversation.model_id) {
  this.view?.updateModelDisplay(conversation.model_id);
}
```

**Provider/model pinning on switch-back:** When the user sends a NEW message in a restored conversation, `handleUserMessage()` must snapshot the **displayed** (restored) provider/model — not the current global state. This ensures the conversation continues with the same provider/model shown in the UI. Specifically:
- `handleUserMessage()` checks if the displayed conversation has a restored provider/model from the JSONL header
- If so, the session pins from those restored values (not `this.providerRegistry.getActiveType()` / `this.getActiveModelId()`)
- If the user explicitly changes the provider/model picker while viewing this conversation, that picker change updates both the global state AND the displayed conversation's restored values — the next message uses the user's explicit choice
- For **new** conversations (no JSONL header yet), snapshot from global state as before

**Persona changes:** If the user switches persona mid-conversation via the persona picker, the new persona applies to the next message (picker updates global state, which `handleUserMessage()` reads for persona). The conversation header's `persona_name` should be updated to reflect the most-recently-used persona — see Step 1f-addendum below for header mutation requirements.

#### 4.1.6a Step 1f-addendum: Wire header mutation for persona/provider/model changes

**Resolution:** `HistoryManager.updateConversationHeader()` **already exists** at [`history.ts:206-229`](../../src/chat/history.ts). It performs read-modify-write on line 0 of the JSONL file and is serialized through the existing per-file write queue (`enqueueWrite`). No new infrastructure needed.

**When to update:** Only when persona/provider/model actually changes (avoids redundant I/O).

**Trigger 1 — On message send (`handleUserMessage()`):**

After creating the `ConversationSession`, compare the session's pinned values against the conversation header:
```typescript
const conv = session.conversationManager.getActiveConversation()!;
const headerDirty =
    conv.persona_name !== (session.pinnedPersona?.name ?? null) ||
    conv.provider_id !== session.providerType ||
    conv.model_id !== session.modelId;

if (headerDirty) {
    conv.persona_name = session.pinnedPersona?.name ?? null;
    conv.provider_id = session.providerType;
    conv.model_id = session.modelId;
    await this.historyManager.updateConversationHeader(conv);
}
```

**Trigger 2 — On picker change (persona/provider/model picker while viewing a conversation):**

When the user changes the persona, provider, or model picker while viewing a conversation — even before sending a message — update the header to reflect the user's intent. This requires wiring the existing picker-change callbacks in `wireView()` to also call `updateConversationHeader()` when there is an active conversation:

```typescript
// In wireView(), extend the existing onProviderChange / onModelChange / onPersonaChange callbacks:
// After the global state mutation (switchProvider, activatePersona, etc.),
// also update the displayed conversation's header:
const conv = orchestrator.getDisplayedConversation();
if (conv) {
    conv.provider_id = newProviderId;  // or persona_name, model_id
    await historyManager.updateConversationHeader(conv);
}
```

**Note:** Picker changes update both the global state (existing behavior) AND the conversation header (new behavior). The next session created for this conversation will snapshot from the updated header values.

#### 4.1.7 Step 1g: Inspector shows displayed conversation's config

- `updateDisplayConfig()` (from Step 1b) stores the displayed conversation's config on orchestrator fields
- Called from `responseLoop` when session matches displayed conversation
- Called from `switchConversation()` when switching to a conversation with an active session (use session's config)
- `getEffectiveToolConfig()` and `getActiveParsedConfigs()` continue returning these fields
- No changes needed to `src/ui/effective-config-inspector.ts`

#### 4.1.8 Step 1h: Session cleanup on plugin deactivation

The orchestrator must abort all active sessions when the plugin is disabled, hot-reloaded, or Obsidian closes.

**Changes to `src/chat/orchestrator.ts`:**

Add an async `destroy()` method (called from `main.ts` `onunload()`):
```typescript
async destroy(timeoutMs: number = 2000): Promise<void> {
  // 1. Signal all active sessions to abort
  const sessionPromises: Promise<void>[] = [];
  for (const session of this.activeSessions.values()) {
    // Each session's responseLoop should resolve/reject after abort
    // Track the response loop promise (stored on session at creation time)
    if (session.responsePromise) {
      sessionPromises.push(session.responsePromise);
    }
    session.abortController.abort();
  }

  // 2. Best-effort await: wait for all response loops to complete their
  //    finally blocks (JSONL writes, status updates), but don't block
  //    plugin unload indefinitely.
  if (sessionPromises.length > 0) {
    await Promise.race([
      Promise.allSettled(sessionPromises),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  }

  this.activeSessions.clear();
}
```

**Note:** This requires `ConversationSession` to store a `responsePromise: Promise<void>` field, set by `handleUserMessage()` when the response loop is started.

**Changes to `src/main.ts`:**
- Call `orchestrator.destroy()` in the plugin's `onunload()` path. Since Obsidian's `onunload()` is synchronous, use `this.register(() => { orchestrator.destroy(); })` or fire-and-forget the async call (the timeout ensures it doesn't hang).

#### ~~4.1.9 Step 1i: Per-server MCP dispatch queue~~ → Moved to Phase 4

**Rationale for deferral:** Within a single session, MCP tools are already serialized by `tool-orchestration.ts:91` (`isMcpTool()` → sequential batch). The per-server queue only matters for cross-session concurrent access, which cannot occur until Phase 4 (multi-panel) ships. Keeping Phase 1 focused on session isolation reduces scope and regression risk. See Phase 4, Section 4.4.7 for the full implementation.

#### 4.1.10 Files modified

- `src/chat/tool-policy.ts` — **NEW**: `evaluateToolPolicy()` pure function, `ToolPolicyContext` interface, `PolicyDecision` interface
- `src/chat/conversation-session.ts` — **NEW**: `ConversationSession` class (no `lastDisplayedIndex` — sync-back uses full replace)
- `src/chat/dispatcher.ts` — `dispatch()` gains optional `policyCtx` + `approvalCallback` params
- `src/chat/tool-orchestration.ts` — `executeToolBatches()`, `safeDispatch()`, `runConcurrentBatch()` thread `policyCtx` + `approvalCallback`
- `src/chat/orchestrator.ts` — `resolveEffectiveConfig()` (pure signature + body, return type changes from `ToolDefinition[]` to `{ effective, toolDefinitions, parsedConfigs }`), `handleUserMessage()` (session creation, stores `responsePromise` on session, snapshots `useExtendedContext`, header dirty-check + update), `responseLoop()` (uses session — see exhaustive shared-state substitution table in Step 1d), `processStream()` (session-aware view guarding via view-resolver), `checkAndPerformCompaction(session)` (uses session for conversation, model, extended context, provider, and view), `calculateCost()` (add optional `modelId` parameter with fallback to global), `dispatchAfterCompletionHooks()` (accept `conversationId` or session — no longer reads shared `conversationManager`), `_backgroundResponseLoop()` (uses session, removes save/restore hack), `switchConversation()` (persona+model restoration with display-AND-use semantics, display config update, isResponding reset, abort controller decoupling, full-replace sync-back for active sessions), `updateDisplayConfig()` helper, `getViewForSession()` helper, `getDisplayedConversation()` helper, `activeSessions` map, `destroy()` async with timeout
- `src/personas/persona-manager.ts` — add `getPersonaByName(name: string): Promise<Persona | null>` read-only lookup (calls `getDiscoveredPersonas()`, finds by name)
- `src/ui/chat-view.ts` — decouple `AbortController` from view (session owns its own), add `updateProviderDisplay()`, `updateModelDisplay()` **NEW** display-only methods for conversation switch restoration (must update UI selector state without triggering global provider/model switch callbacks; `updatePersonaLabel()` already exists at L492)
- `src/main.ts` — extend picker-change callbacks in `wireView()` to also call `historyManager.updateConversationHeader()` when persona/provider/model changes while viewing a conversation; extend `onModeToggle` callback to propagate mode changes to active sessions

---

### Phase 2: Session Registry Enhancements & Sync-Back

**Goal:** Public session accessors, sync state when user returns, deletion guard. (Note: the `activeSessions` map, session registration, duplicate-send guard, and `finally` cleanup were moved to Phase 1 Step 1d.)

#### 4.2.1 Public session accessors

**File:** `src/chat/orchestrator.ts`

**Public accessor:**
```typescript
getActiveSessions(): ConversationSession[] {
  return Array.from(this.activeSessions.values());
}

hasActiveSession(conversationId: string): boolean {
  return this.activeSessions.has(conversationId);
}
```

#### 4.2.2 Sync-back on conversation switch

**File:** `src/chat/orchestrator.ts` — `switchConversation()`

**Approach: Full replace** from session's in-memory message array. Same pattern already used by `switchConversation()` for JSONL-loaded conversations (orchestrator.ts:365-368). Compaction-safe — no index tracking to break when `replaceMessages()` swaps the array.

When switching to a conversation that has an active session:

1. Check `this.activeSessions.has(conversation.id)`
2. **If active session exists:**
   ```typescript
   const session = this.activeSessions.get(conversation.id)!;
   const messages = session.conversationManager.getMessages();
   // Use silent: true to skip the onConversationChanged callback.
   // Without this, loadConversation fires updateConversationHeader(),
   // writing mid-stream token counts to the JSONL header — creating a
   // timing dependency on when the user switches back. The session's
   // own ConversationManager is the authoritative header writer.
   this.conversationManager.loadConversation(
     session.conversationManager.getActiveConversation()!,
     messages,
     { silent: true }
   );
   this.view?.clearMessages();
   for (const msg of messages) {
     this.renderMessage(msg);
   }
   ```
3. Set `this.view?.setRespondingState(true)`. The stop button uses the existing `onStopResponse` callback — the orchestrator's handler looks up the displayed conversation's active session and calls `session.abortController.abort()`.
4. Register a one-time callback on the session's `onStatusChange` to call `this.view?.setRespondingState(false)` when it completes
5. **If no active session:** Load from `HistoryManager` as normal (standard JSONL load for completed conversations)

**Why not incremental append:** Compaction calls `replaceMessages()` which replaces the entire message array with ~2 synthetic messages. Any `lastDisplayedIndex` tracking would break, requiring compaction detection + fallback — two code paths for marginal gain. Full replace is a single code path that handles all cases.

#### 4.2.3 Deletion guard for active sessions

**File:** `src/chat/orchestrator.ts` — in conversation delete handler

Before deleting a conversation, check whether it has an active session:

```typescript
if (this.activeSessions.has(conversationId)) {
  new Notice("Cannot delete — conversation is still streaming. Stop it first.");
  return;
}
```

#### 4.2.4 Files modified

- `src/chat/orchestrator.ts` — public session accessors, sync-back logic (uses `silent: true`), deletion guard
- `src/chat/conversation.ts` — add `{ silent?: boolean }` option to `loadConversation()` to skip `onConversationChanged` callback

---

### Phase 3: Activity Indicator for Active Conversations

**Goal:** Badge count on the workflow activity indicator showing detached foreground conversations.

#### 4.3.1 Extend `WorkflowActivityIndicator`

**File:** `src/ui/workflow-activity-indicator.ts`

Add a second data source:

```typescript
constructor(
  containerEl: HTMLElement,
  tracker: WorkflowActivityTracker,
  private readonly getActiveSessions?: () => ConversationSession[]
)
```

`updateBadge()` changes:
```typescript
const workflowCount = this.tracker.getActiveCount();
const sessionCount = this.getActiveSessions?.().length ?? 0;
const count = workflowCount + sessionCount;
```

`updateAnimationState()` changes:
```typescript
const hasActive = this.tracker.hasActiveWorkflows() || (this.getActiveSessions?.().length ?? 0) > 0;
```

#### 4.3.2 Extend `WorkflowActivityDropdown`

**File:** `src/ui/workflow-activity-dropdown.ts`

Add a "Conversations" section to the dropdown render method. Each entry shows:
- Conversation title (from `ConversationSession.title`)
- Status badge: "Streaming" / "Waiting for approval"
- Elapsed time since `session.startedAt`
- Click handler: `onNavigate(session.conversationId)`

The dropdown already has `onNavigate` callback wired to `switchToConversationById`.

#### 4.3.3 Wire in `main.ts`

**File:** `src/main.ts`

When constructing the indicator, pass the session accessor:
```typescript
const indicator = new WorkflowActivityIndicator(
  headerEl,
  workflowActivityTracker,
  () => orchestrator.getActiveSessions()
);
```

Wire the session's `onStatusChange` to trigger `indicator.update()` (or have the orchestrator emit an event that the indicator listens to — same pattern as `WorkflowActivityTracker.onChange()`).

#### 4.3.4 Files modified

- `src/ui/workflow-activity-indicator.ts` — dual data source
- `src/ui/workflow-activity-dropdown.ts` — conversation entries section
- `src/main.ts` — pass session accessor

---

### Phase 4: Multiple Chat Panels

**Goal:** Allow opening additional simplified Notor chat leaves.

#### 4.4.1 Secondary panel option (same view type)

**File:** `src/ui/chat-view.ts`

Reuse the existing `CHAT_VIEW_TYPE` ("notor-chat-view"). No new view type registration needed.

Add constructor option:
```typescript
interface ChatViewOptions {
  isSecondary?: boolean;
}
```

Secondary panels render the **full toolbar** (same as primary). Per-session scoping from Phase 1 means persona, provider, and tool config are already isolated — no reason to reduce capability. The `isSecondary` flag is used for workspace restore logic and command behavior, not toolbar rendering.

The input area remains the same (text input, send/stop, attachments).

**Singleton-assumption updates:** Code in `main.ts` that assumes one leaf of `CHAT_VIEW_TYPE` (e.g., `getLeavesOfType(CHAT_VIEW_TYPE)` at line 2182 and line 2199) must be updated to handle multiple leaves. Add a `getPrimaryChatLeaf()` helper that filters `getLeavesOfType` results. The primary panel is the first leaf opened; subsequent leaves are secondary. Audit all call sites to use the helper where appropriate.

#### 4.4.2 Per-panel orchestrator

**File:** `src/main.ts`

The existing `registerView(CHAT_VIEW_TYPE, ...)` callback must detect whether this is a primary or secondary leaf and wire accordingly. Secondary leaves get `{ isSecondary: true }` passed to the constructor.

**Important: Same class, same wiring path.** Both primary and secondary panels use the exact same `ChatOrchestrator` class and the same `wireView()` method. There is no `wireSecondaryView()` — that would duplicate callback setup and inevitably diverge. Instead:

1. For each secondary leaf, create a new `ChatOrchestrator` instance sharing expensive singletons:
```typescript
const orchestrator = new ChatOrchestrator(
  this.app,
  this.getProviderRegistry(),   // shared
  this.getSystemPromptBuilder(), // shared
  this.getToolDispatcher(),      // shared
  this.getHistoryManager(),      // shared
  this.settings,
  view,
  this.getVaultRuleManager(),    // shared
);
```
2. Call the **same** `wireView(view, orchestrator)` method used for the primary panel. This requires refactoring `wireView()` to accept the orchestrator as a parameter (currently it reads from `this._orchestrator`).

**Per-orchestrator active provider/model:** Each `ChatOrchestrator` must track its own `activeProviderType` and `activeModelId` fields. Picker changes in one panel update that panel's orchestrator — NOT the global `ProviderRegistry.activeType`. New conversations snapshot from the orchestrator's fields. Without this, a provider change in Panel A would affect Panel B's next new conversation through the shared `ProviderRegistry` global state. Phase 1's conversation-header-based snapshotting handles restored conversations correctly regardless.

**ProviderRegistry role change:** After Phase 4, `ProviderRegistry` becomes provider-instance management and defaults only. Its `activeType` serves as the initial default for newly created orchestrators (each orchestrator initializes its `activeProviderType` from `ProviderRegistry.getActiveType()` at construction time). All subsequent "which provider is active" reads go through the orchestrator, not the registry. `ProviderRegistry.switchProvider()` should no longer be called from picker-change callbacks — those update the orchestrator's fields instead.

**Alignment needed:** Audit `wireView()` and the `ChatOrchestrator` constructor for any primary-only assumptions (e.g., singleton references, global event listeners that should only fire once). Any such assumptions must be parameterized or guarded by `isSecondary`. See Section 4.4.8 for the required audit.

#### 4.4.3 Tool approval routing

**Simplified by Phase 1:** Steps 1a and 1d already added per-invocation `approvalCallback` and `policyCtx` parameters to `dispatch()`. Each `ConversationSession` owns its approval callback. The global `setApprovalCallback()` fallback path can be removed once all callers pass per-call callbacks.

**Remaining Phase 4 work:** When creating a secondary panel's orchestrator, wire the panel's view-bound approval callback so that secondary panel sessions route approvals to the correct DOM. This is straightforward: `wireView()` (the same method used for primary panels) captures the view's approval callback and passes it to the orchestrator.

#### 4.4.4 Command registration

**File:** `src/main.ts`

```typescript
this.addCommand({
  id: "open-secondary-chat",
  name: "Open new chat panel",
  callback: () => {
    const leaf = this.app.workspace.getLeaf('tab');
    leaf.setViewState({
      type: CHAT_VIEW_TYPE,
      state: { isSecondary: true },
    });
  },
});
```

#### 4.4.5 State persistence

`NotorChatView` saves/restores via Obsidian's `getState()` / `setState()`:

```typescript
getState(): Record<string, unknown> {
  return {
    conversationFilename: this.activeConversationFilename,
    isSecondary: this.isSecondary,
  };
}

setState(state: Record<string, unknown>): Promise<void> {
  this.isSecondary = !!state.isSecondary;
  if (state.conversationFilename) {
    // Load this conversation on view open
    this.onSwitchConversation?.(state.conversationFilename as string);
  }
  // Re-build header if isSecondary changed (e.g., on workspace restore)
  if (this.isSecondary) {
    this.rebuildHeader();
  }
}
```

#### 4.4.6 Files modified

- `src/ui/chat-view.ts` — `isSecondary` constructor option (full toolbar, same as primary), state persistence via `getState()`/`setState()`
- `src/main.ts` — update `registerView` callback to handle secondary leaves, refactor `wireView()` to accept orchestrator parameter, command, update singleton-assumption code (`getLeavesOfType`)
- `src/chat/dispatcher.ts` — remove global `setApprovalCallback()` fallback (per-call approval already added in Phase 1 Step 1a)
- `src/mcp/mcp-hub.ts` — add per-server promise queue (`callQueues` map), extract `executeCallTool()`, wrap `callTool()` with `enqueueCall()` (moved from Phase 1 Step 1i)

#### 4.4.7 Per-server MCP dispatch queue (moved from Phase 1)

**Problem:** `McpHub.callTool()` ([`mcp-hub.ts:449-528`](../../src/mcp/mcp-hub.ts)) dispatches tool calls immediately with no per-server serialization. Within a single session, MCP tools are already serialized by `tool-orchestration.ts:91` (`isMcpTool()` → sequential batch). With multi-panel support, two panels could dispatch tools to the same MCP server simultaneously. Many MCP servers are single-threaded and may not handle concurrent JSON-RPC requests safely.

**Implementation:** Copy the `HistoryManager.writeQueues` pattern ([`history.ts:93-138`](../../src/chat/history.ts)) into `McpHub`:

```typescript
// In src/mcp/mcp-hub.ts:
private readonly callQueues = new Map<string, Promise<unknown>>();

private enqueueCall<T>(serverName: string, operation: () => Promise<T>): Promise<T> {
    const current = this.callQueues.get(serverName) ?? Promise.resolve();
    const next = current.then(operation, operation);
    this.callQueues.set(serverName, next);
    void next.finally(() => {
        if (this.callQueues.get(serverName) === next) {
            this.callQueues.delete(serverName);
        }
    });
    return next;
}
```

**Changes to `McpHub.callTool()`:**
- Extract the actual call logic (connection lookup, timeout, `client.callTool()`, result extraction) into a private `executeCallTool()` method
- `callTool()` becomes a thin wrapper: validation checks + `return this.enqueueCall(serverName, () => this.executeCallTool(...))`

**Upgradability:** If users report that MCP serialization is too slow, this can be upgraded to a per-server semaphore with configurable concurrency limit (add `concurrency?: number` to `McpServerConfig`, default 1) without changing the external API.

#### 4.4.8 Global listener audit for `wireView()` and `ChatOrchestrator` constructor

The following audit enumerates every callback/listener registered during orchestrator construction and view wiring, categorized by whether it's safe to duplicate per-panel.

**Safe to duplicate per-panel** (each orchestrator gets its own copy):
- `conversationManager.setOnMessageAdded()` (orchestrator.ts:127) — per-instance, writes to own conv
- `conversationManager.setOnConversationChanged()` (orchestrator.ts:134) — per-instance header updates
- `view.setOnSendMessage()`, `view.setOnSendWorkflow()` — per-orchestrator message/workflow handling
- `view.setOnModeToggle()` — per-orchestrator mode state
- `view.setOnOpenConversationList()`, `view.setOnSearchConversations()` — read-only queries
- `view.setGetAvailableProviders()`, `view.setGetAvailableModels()`, `view.setGetCurrentProvider()`, `view.setGetCurrentModel()` — read-only ProviderRegistry queries
- `view.setOnSettingsOpen()`, `view.setOnOpenSettingsGroup()` — UI navigation only
- `view.setOnExportConversation()` — read-only + modal
- Checkpoint callbacks (`setOnListCheckpoints`, `setOnRestoreCheckpoint`, `setOnGetCurrentContent`) — per-conversation scope

**Must NOT duplicate — wire once at plugin level or coordinate:**
- `app.workspace.on("active-leaf-change")` (main.ts:417) — auto-context tracking; single global listener
- `view.setOnProviderChange()` (main.ts:1969) — mutates global `ProviderRegistry.activeType` + settings. With per-orchestrator provider fields (Section 4.4.2), this must update the **panel's orchestrator**, not the global registry.
- `view.setOnModelChange()` (main.ts:1978) — mutates global provider config + settings. Same treatment as provider change.
- `toolDispatcher.setApprovalCallback()` (main.ts:2071) — overwrites single shared callback. Phase 1 Step 1a/1d already adds per-dispatch approval callbacks, so this global setter can be removed in Phase 4.
- `view.setOnNewConversation()` (main.ts:1785) — calls `this.loadSettings()` (global reload) and `toolDispatcher.setAutoApprove()` (shared dispatcher). Extract settings reload to plugin level; per-panel part (`orchestrator.newConversation()`) is safe.
- `view.setOnSwitchConversation()` (main.ts:1834) — clears global `StaleTracker` and `VaultRuleManager.accessedNotes`. Per-panel part (`orchestrator.switchConversation()`) is safe; global clears must be coordinated.
- `view.setOnDeleteConversation()` (main.ts:1885) — same global-clear issue as switch
- `view.setOnForkConversation()` (main.ts:1851) — same global-clear issue as switch

**Refactoring approach for unsafe callbacks:** Split each callback into (a) a per-panel part that calls through the panel's orchestrator, and (b) a plugin-level part that handles global state (settings reload, stale tracker clear, vault rule clear). The per-panel part is wired in `wireView()`; the plugin-level part is a shared handler that any panel can invoke but that deduplicates or coordinates the global mutation.

---

### Phase 5: "Open in New Tab" from Conversation History

**Goal:** Context menu option to open any conversation in a new secondary panel.

#### 4.5.1 Menu item

**File:** `src/ui/chat-view.ts` — in the conversation list 3-dot context menu

```typescript
menu.addItem((item) => {
  item.setTitle("Open in new tab")
    .setIcon("external-link")
    .onClick(() => this.onOpenInNewTab?.(entry.filename));
});
```

Add callback setter:
```typescript
private onOpenInNewTab?: (filename: string) => void;

setOnOpenInNewTab(callback: (filename: string) => void): void {
  this.onOpenInNewTab = callback;
}
```

#### 4.5.2 Wire callback

**File:** `src/main.ts`

```typescript
view.setOnOpenInNewTab((filename: string) => {
  const leaf = this.app.workspace.getLeaf('tab');
  leaf.setViewState({
    type: CHAT_VIEW_TYPE,
    state: { conversationFilename: filename, isSecondary: true },
  });
});
```

#### 4.5.3 Files modified

- `src/ui/chat-view.ts` — menu item, callback setter
- `src/main.ts` — wire callback

---

## 5. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Tool dispatcher contention | Two panels both need tool approval simultaneously | **Resolved in Phase 1 (Step 1a/1d).** Each `ConversationSession` owns its approval callback, passed per-`dispatch()` call. No global `setApprovalCallback()`. |
| Persona state is global | Changing persona mid-stream affects in-flight sessions | **Resolved in Phase 1 (Step 1d).** Active persona snapshotted at session creation as `session.pinnedPersona`. Provider type and model ID also snapshotted as `session.providerType` and `session.modelId`. Mid-stream persona/provider changes don't affect in-flight sessions. `resolveEffectiveConfig()` accepts persona as a parameter — not read from global `PersonaManager`. |
| `resolveEffectiveConfig` concurrency | Two concurrent sessions interleave tool config resolution, producing inconsistent state | **Resolved in Phase 1 (Steps 1a-1b).** `resolveEffectiveConfig()` is pure — returns results without mutating shared state. Policy enforcement is a pure function per-dispatch. Each session owns its resolved config. No shared mutable `effectiveToolConfig` on dispatcher. |
| `activeWorkflowAssemblyResult` race | Background loop save/restore hack not concurrent-safe | **Resolved in Phase 1 (Step 1e).** `resolveEffectiveConfig()` accepts `workflowAssembly` as parameter. Background session passes its assembly directly. Save/restore hack eliminated. |
| Provider rate limits | Multiple concurrent conversations hit API rate limits | Not architecturally addressed — existing `RATE_LIMITED` error handling surfaces a Notice to the user. |
| Memory pressure | Multiple ConversationManagers holding message arrays | Each manager only holds messages for one conversation. Lightweight compared to the LLM context window. |
| Stale UI on return | User switches back to a conversation that streamed in the background — may not see latest messages | **Resolved in Phase 2 (Step 2.2).** Full replace from session's in-memory message array (`clearMessages()` + re-render). Same pattern as existing `switchConversation()`. Compaction-safe — no index tracking. JSONL reload for completed sessions without an active session. |
| AbortController scoping | Closing a panel while response is streaming | `ConversationSession` owns its `AbortController`. Panel `onClose()` aborts all sessions for that panel. |
| Persona/model restoration edge cases | Conversation's persona deleted or provider unconfigured since last use | Graceful fallback: `getPersonaByName()` returns null if persona deleted → `updatePersonaLabel(null)` clears the label. If provider not configured, fall back silently to the current global provider/model — the session pins from global state instead of the stale header values. No global state mutation on failure. |
| Plugin deactivation / hot-reload | Active sessions left dangling with live AbortControllers and callbacks | **Resolved in Phase 1 (Step 1h).** `orchestrator.destroy()` aborts all active sessions and awaits their cleanup with a 2-second timeout (best-effort JSONL flush). Called from plugin `onunload()`. |
| Conversation deletion while streaming | Session continues writing to JSONL file the UI considers deleted | **Resolved in Phase 2 (Step 2.3).** Deletion handler checks `activeSessions` and blocks with a Notice if the conversation is still streaming. |
| Per-panel orchestrator weight | Each secondary panel creates a full `ChatOrchestrator` (~2400 lines) | Same class, same wiring path (`wireView()`). Shares expensive singletons (ProviderRegistry, HistoryManager, etc.) so memory footprint is modest. No `wireSecondaryView()` — both primary and secondary panels use the same code path. |
| MCP server concurrency | Multiple sessions dispatch tools to the same MCP server concurrently | **Mitigated by per-server dispatch queue (Phase 4, Step 4.4.7).** Serializes tool calls per MCP server (same pattern as `HistoryManager.writeQueues`). Not needed until Phase 4 — within a single session, MCP tools are already serialized by `tool-orchestration.ts:91`. |
| Mode toggle mid-stream | User toggles plan/act while a session is streaming — policy doesn't update | **Resolved in Phase 1 (Step 1d).** Mode toggle propagates to active session's ConversationManager via `activeSessions` map lookup. `buildPolicyContext()` reads the updated mode on each dispatch. |
| Duplicate send to same conversation | User sends two messages to a conversation that already has an active session | **Resolved in Phase 1 (Step 1d).** Duplicate-send guard checks `activeSessions.has(conv.id)` before creating a session. Rejects with a Notice if a session already exists. |
| Sync-back JSONL header write | Navigating back to streaming conversation fires `onConversationChanged`, writing mid-stream token counts | **Resolved in Phase 2 (Step 2.2).** Sync-back uses `loadConversation(..., { silent: true })` to skip the callback. Session's own ConversationManager is the authoritative header writer. |
| Cross-panel provider/model mutation | Picker change in Panel A affects Panel B's new conversations via global ProviderRegistry | **Resolved in Phase 4 (Step 4.4.2).** Per-orchestrator `activeProviderType` and `activeModelId` fields. Picker changes update the panel's orchestrator, not the global registry. |
| wireView global listener duplication | Multiple per-panel orchestrators duplicate global event listeners | **Resolved in Phase 4 (Step 4.4.8).** Audit identifies safe-to-duplicate vs. must-deduplicate callbacks. Unsafe callbacks split into per-panel + plugin-level parts. |

---

## 6. Implementation Order & Dependencies

```
Phase 1 (per-conversation session isolation — bug fix + architecture)
  ├── Step 1a: Extract policy from dispatcher (pure refactor, no behavior change)
  ├── Step 1b: Make resolveEffectiveConfig pure (pure refactor)
  ├── Step 1c: Create ConversationSession class
  ├── Step 1d: Update responseLoop to use sessions (includes activeSessions map,
  │            duplicate-send guard, mode toggle propagation)
  ├── Step 1e: Update _backgroundResponseLoop to use sessions
  ├── Step 1f: JSONL persona + model restoration + header mutation on change
  ├── Step 1g: Inspector display-conversation scoping
  └── Step 1h: Session cleanup on plugin deactivation
    ↓
Phase 2 (session registry enhancements + sync-back)
    ↓
    ├──→ Phase 3 (activity indicator)
    │
    └──→ Phase 4 (multi-panel + per-server MCP queue + global listener audit)
              ↓
         Phase 5 (open in new tab)
```

- **Phase 0 is eliminated.** The `resolveEffectiveConfig` concurrency investigation is resolved: Steps 1a-1b make config resolution pure and tool policy a per-call function. No shared mutable config state remains.
- **Phase 1** is independently shippable. Steps 1a-1b are pure refactors (backward compatible, can be verified independently). Steps 1c-1e fix the data corruption bug. Step 1d includes the `activeSessions` map, duplicate-send guard, and mode toggle propagation to active sessions. Step 1f adds persona/model restoration + header mutation on change. Step 1g scopes the inspector. Step 1h handles plugin deactivation. Step 1i (per-server MCP queue) deferred to Phase 4 — not needed until multi-panel.
- **All open design questions are resolved:** Sync-back uses full replace with `silent: true` on `loadConversation` (no index tracking, no spurious header writes). Header updates only when persona/provider/model actually changes. Picker changes also update the conversation header. `processStream` uses a view-resolver function re-resolved per chunk. `checkAndPerformCompaction` accepts the full session. `ConversationSession` pins `useExtendedContext` alongside `providerType` and `modelId`. `calculateCost()` accepts an optional `modelId` parameter for session-aware pricing. `dispatchAfterCompletionHooks()` accepts session/conversationId to avoid reading the shared manager. Step 1d includes an exhaustive shared-state access enumeration table (14 `this.conversationManager`, 5 compaction, 17+2 `this.view`, 10 other global reads) as an implementation checklist.
- **Phase 2** builds on Phase 1 and is required for Phases 3-5. Adds public session accessors, sync-back (silent `loadConversation`), and deletion guard.
- **Phase 4 scope expanded:** Includes per-panel orchestrators, per-orchestrator provider/model fields (replaces global ProviderRegistry mutation), per-server MCP dispatch queue (moved from Phase 1), and global listener audit (Section 4.4.8). The tool approval routing refactor is already handled by Phase 1 Steps 1a/1d.
- **Phases 3, 4, 5** can be developed in parallel after Phase 2.

---

## 7. Verification Plan

### Phase 1 Verification

**Steps 1a-1b (pure refactors):**
1. Run existing test suite — all pass (no behavior change)
2. Manually verify tool dispatch still respects enabled/disabled, auto-approve, path constraints
3. Verify inspector still shows correct config for single-conversation case
4. Verify background workflow tool config resolution still works

**Steps 1c-1e (session isolation — critical bug fix):**
1. Start a conversation, send a message that triggers a long LLM response
2. While streaming, switch to a different conversation (or create a new one)
3. Verify: the input area is unlocked in the new conversation (isResponding reset)
4. Send a message in the new conversation — verify it works independently
5. Wait for the original response to complete
6. Verify: original conversation's JSONL has the complete assistant response
7. Verify: new conversation's JSONL is clean (no stray messages from the first response)
8. Switch back to original conversation — verify all messages render correctly
9. Verify: no stray DOM elements from the background response leaked into the new conversation's view
10. Start a background workflow while a foreground conversation is streaming — verify both use correct tool configs (no cross-contamination)
11. Try to send a second message to the same conversation while it's streaming — verify "already processing" notice (duplicate-send guard)
12. While streaming, toggle plan→act mode — verify the next tool dispatch respects act mode (mode propagation)
13. While streaming, navigate away — verify streaming text does NOT appear in the new conversation's view (processStream view-resolver)
14. Trigger compaction mid-stream — verify it uses the session's model ID for token threshold, not the global active model

**Step 1f (JSONL restoration):**
1. Create conversation with persona "researcher" active
2. Switch to a different conversation (persona changes/clears)
3. Switch back to the first conversation
4. Verify: persona "researcher" is re-activated, model matches what was used
5. Load a conversation whose persona no longer exists — verify graceful fallback (keeps current persona, logs warning)
6. Load a conversation from a provider that's no longer configured — verify graceful fallback

**Step 1g (inspector):**
1. Open inspector while a conversation is active — shows correct config
2. Switch conversations — inspector still shows config for displayed conversation
3. Start streaming, switch away, switch back — inspector shows session's current config

### Phase 2 Verification
1. Send a message, switch away mid-stream
2. Duplicate-send guard already tested in Phase 1 (Step 1c-1e item 11)
3. Switch back to the streaming conversation mid-stream — verify all messages render correctly via full replace (clearMessages + re-render from session's in-memory array). Verify JSONL header is NOT written during sync-back (silent loadConversation)
4. Verify the stop button correctly targets the active session's AbortController
5. Wait for completion, navigate back — verify conversation shows the completed response
6. Verify `activeSessions` map is empty after all responses complete
7. Trigger compaction mid-stream (long conversation), switch away and back — verify full replace handles the post-compaction message array correctly

### Phase 3 Verification
1. Send a message, switch away mid-stream
2. Verify workflow activity badge shows count > 0
3. Open dropdown — verify conversation entry appears with "Streaming" status
4. Click the entry — verify navigation back to the streaming conversation
5. Wait for completion — verify badge returns to 0

### Phase 4 Verification
1. Open secondary panel via "Open new chat panel" command
2. Verify full toolbar (same capabilities as primary panel)
3. Send messages in both primary and secondary panels simultaneously
4. Verify both conversations write to separate JSONL files
5. Close and reopen Obsidian — verify secondary panel restores with its conversation
6. Change provider picker in Panel A — verify Panel B's next new conversation uses Panel B's provider, not Panel A's (per-orchestrator provider fields)
7. Dispatch MCP tools from both panels to the same MCP server — verify per-server serialization (no concurrent JSON-RPC)
8. Verify settings changes, new conversation, and conversation switch callbacks don't double-fire across panels (global listener audit)

### Phase 5 Verification
1. Open conversation history in the primary panel
2. Click 3-dot menu on a conversation → "Open in new tab"
3. Verify the conversation opens in a new secondary panel tab
4. Verify the conversation loads correctly with full message history

---

## 8. Key Existing Patterns to Reuse

| Pattern | Location | Reuse |
|---------|----------|-------|
| Background workflow isolation | [`orchestrator.ts:700-724`](../../src/chat/orchestrator.ts) | Per-response `ConversationManager` creation + wiring |
| `_backgroundResponseLoop` | [`orchestrator.ts:839-1078`](../../src/chat/orchestrator.ts) | Self-contained response loop using passed-in manager |
| Sub-agent dispatcher creation | [`use-subagent.ts:314-319`](../../src/tools/use-subagent.ts) | Separate config per dispatch context (proven per-session isolation pattern) |
| Persona activate/deactivate | [`persona-manager.ts:117-147`](../../src/personas/persona-manager.ts) | `activatePersona(name)` for user-initiated persona changes only; NOT used for conversation-switch restoration (display-only update instead) |
| Provider switching | [`providers/index.ts:158`](../../src/providers/index.ts) | `switchProvider()` for conversation load |
| `mergeToolConfigs` (pure) | [`tool-config/merger.ts:55-103`](../../src/tool-config/merger.ts) | Already pure — accepts inputs, returns merged config. No changes needed. |
| `getFilteredToolDefinitions` | [`tools/index.ts:124`](../../src/tools/index.ts) | Already pure — accepts `EffectiveToolConfig`, returns filtered defs. |
| `WorkflowActivityTracker` | [`src/workflows/workflow-activity-tracker.ts`](../../src/workflows/workflow-activity-tracker.ts) | `onChange()` / `getActiveCount()` / `hasActiveWorkflows()` pattern |
| `WorkflowActivityDropdown` | [`src/ui/workflow-activity-dropdown.ts`](../../src/ui/workflow-activity-dropdown.ts) | Positioned popover with live-update entries |
| HistoryManager write queues | [`src/chat/history.ts`](../../src/chat/history.ts) | Per-file promise chains serialize concurrent writes — no changes needed |
| View state persistence | Obsidian `ItemView.getState()` / `setState()` | Standard pattern for workspace restore |
| Conversation header persistence | [`types.ts:14-94`](../../src/types.ts) | `persona_name` ([L56](../../src/types.ts)), `provider_id`, `model_id` already stored in JSONL header — used for display-restore on load and session snapshot at creation |
| Header mutation | [`history.ts:206-229`](../../src/chat/history.ts) | `updateConversationHeader()` already exists — read-modify-write on line 0, serialized via per-file write queue. Used for persona/provider/model updates on change. |
| MCP tool dispatch | [`mcp-hub.ts:449-528`](../../src/mcp/mcp-hub.ts) | `callTool()` dispatches to MCP SDK. Will be wrapped with per-server promise queue (same pattern as `HistoryManager.writeQueues`). |
