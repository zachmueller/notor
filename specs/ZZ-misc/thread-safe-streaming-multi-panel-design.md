# Thread-Safe Streaming & Multi-Panel Chat

**Status:** Draft
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
| Isolation unit | `ConversationSession` class per response | Each response gets a `ConversationSession` owning: isolated `ConversationManager`, resolved `EffectiveToolConfig`, pinned persona, approval callback, abort controller. All per-conversation state lives here — not on shared orchestrator/dispatcher fields. |
| Dispatcher architecture | Split into registry (global) + policy (pure function, per-call) | `ToolDispatcher` becomes a pure registry: lookup + execute. Policy checks (enabled, auto-approve, path constraints) extracted to `evaluateToolPolicy()` pure function. Each session builds a `ToolPolicyContext` from its own resolved config. Eliminates all shared mutable config state on the dispatcher. |
| Config resolution | `resolveEffectiveConfig` is pure (no side effects) | Accepts `(matchedRules, workflowAssembly?)`, returns `{ effective, toolDefinitions, parsedConfigs }`. No writes to orchestrator or dispatcher fields. Eliminates the `activeWorkflowAssemblyResult` save/restore hack in the background loop. |
| Per-conversation persistence | Auto-restore persona + model from JSONL header on load | `Conversation` header already stores `persona_name`, `provider_id`, `model_id`. `switchConversation()` now calls `activatePersona()` and `switchProvider()` to restore them. Provides continuity when resuming old conversations. |
| UI ↔ streaming decoupling | `this.conversationManager` becomes "UI display manager" only | The main orchestrator's `conversationManager` tracks what's *shown* in the panel. Response loops use the session's isolated manager. Switching the display manager has no effect on in-flight responses. |
| Inspector scoping | Shows config for the currently displayed conversation | Orchestrator keeps `effectiveToolConfig` / `activeParsedConfigs` fields for inspector, but only updates them from the displayed conversation's session (or on explicit conversation switch). |
| Activity indicator | Extend existing `WorkflowActivityIndicator` | Reuse the badge + dropdown pattern rather than adding a separate icon. Combined count: workflows + foreground sessions. |
| Multi-panel approach | Reuse `CHAT_VIEW_TYPE` with per-panel orchestrator | Same view type, differentiated by `{ isSecondary: true }` constructor option. Each panel gets its own `ChatOrchestrator` (lightweight — shares expensive singletons like `ProviderRegistry`, `HistoryManager`, `SystemPromptBuilder`). Own `ConversationManager` for independent state. Avoids maintaining two view registrations and divergent wire-up paths. |
| Secondary panel simplification | Reduced header toolbar | Only: "New conversation", "Settings", "Conversation history". Omits: workflow indicator, MCP status, persona picker, mode toggle. |
| Sync-back on return | In-memory diff from session manager | When user switches back to a conversation with an active session, diff the session manager's message array against the UI manager and append only new messages. Falls back to JSONL reload for completed sessions without an active session. Avoids expensive disk I/O during active streaming. |
| Tool approval routing | Per-session approval callback | Each `ConversationSession` owns its approval callback (bound to the correct panel's view). Passed per-`dispatch()` call — no global `setApprovalCallback()`. Each panel/session routes approvals to its own UI without conflict. |
| Shared vs. per-conversation state | Only infrastructure stays global | Global: MCP connections, tool registry (implementations), provider registry (API connections), history manager (file I/O), vault rule manager, system prompt builder. Per-conversation: effective tool config, persona, mode, approval routing, abort controller, conversation manager. |

---

## 3. Architecture Overview

### Current Architecture (Single-Threaded)

```
ChatView (UI)
    ↕ callbacks
ChatOrchestrator (one per panel)
    → ConversationManager (instance-per-orchestrator, mutable activeConversation)
        → onMessageAdded → HistoryManager.appendMessage(getActiveConversation(), msg)
    → ToolDispatcher (shared singleton — mixes registry + policy + mutable config state)
        → effectiveToolConfig: set per-iteration, read at dispatch time (RACE!)
        → approvalCallback: global singleton (can't route to correct panel)
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
    → ChatOrchestrator (per-panel — reduced toolbar)
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
- Domain denylist check (L334-363) → reads `ctx.domainDenylist`
- Auto-approve resolution (L365-381) → reads `ctx.effectiveConfig`
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

**Problem:** `resolveEffectiveConfig()` mutates four shared fields:
- `this.activeParsedConfigs` (orchestrator)
- `this.effectiveToolConfig` (orchestrator)
- `this.dispatcher.effectiveToolConfig` (via `setEffectiveToolConfig()`)
- Reads `this.activeWorkflowAssemblyResult` (written by background loop's save/restore hack at L851-852)

**New signature:**
```typescript
private async resolveEffectiveConfig(
  matchedRules?: VaultRule[],
  workflowAssembly?: WorkflowAssemblyResult | null,
): Promise<{
  effective: EffectiveToolConfig;
  toolDefinitions: ToolDefinition[];
  parsedConfigs: ParsedToolConfig[];
}>
```

Changes inside the method:
- L1148: `workflowAssembly?.toolConfigs ?? []` instead of `this.activeWorkflowAssemblyResult?.toolConfigs ?? []`
- L1184-1188: **REMOVE** — no longer stores on orchestrator fields or injects into dispatcher
- Returns `{ effective, toolDefinitions, parsedConfigs }`

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

  // Snapshotted at session creation
  readonly pinnedPersona: Persona | null;
  readonly workflowAssembly: WorkflowAssemblyResult | null;

  // Per-session routing
  readonly approvalCallback: ApprovalCallback;

  private _status: SessionStatus = "running";
  onStatusChange?: (session: ConversationSession) => void;

  constructor(opts: {
    conversationManager: ConversationManager;
    abortController: AbortController;
    title: string;
    pinnedPersona: Persona | null;
    workflowAssembly?: WorkflowAssemblyResult | null;
    approvalCallback: ApprovalCallback;
    initialConfig: EffectiveToolConfig;
    initialParsedConfigs: ParsedToolConfig[];
  });

  get status(): SessionStatus;
  setStatus(status: SessionStatus): void;

  /** Build a ToolPolicyContext from this session's resolved state. */
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

1. Snapshot current conversation + messages from `this.conversationManager`
2. Create isolated `ConversationManager` (same pattern as `executeBackgroundWorkflow` L710-724)
3. Wire `onMessageAdded` / `onConversationChanged` to `this.historyManager`
4. Load snapshot into new manager via `loadConversation()`
5. Snapshot persona: `const pinnedPersona = this.personaManager?.getActivePersona() ?? null`
6. Resolve initial config via pure `resolveEffectiveConfig(matchedRules)`
7. Create `ConversationSession` with all the above
8. Register in `this.activeSessions: Map<string, ConversationSession>`
9. Pass session into `responseLoop()`

**`responseLoop()` signature:**
```typescript
private async responseLoop(
  mode: ConversationMode,
  session: ConversationSession,
): Promise<void>
```

Inside the loop, all shared state reads become session reads:
- `this.conversationManager` → `session.conversationManager`
- `this.personaManager?.getActivePersona()` → `session.pinnedPersona`
- `resolveEffectiveConfig(matchedRules, session.workflowAssembly)` → updates `session.effectiveConfig` and `session.parsedConfigs`
- If session matches displayed conversation: `this.updateDisplayConfig(session.effectiveConfig, session.parsedConfigs)`
- `executeToolBatches()` passes `session.buildPolicyContext(this.settings, vaultRootPath)` and `session.approvalCallback`
- `checkAndPerformCompaction()` accepts session's conversation manager

**View render guarding:**
```typescript
/** Returns the view only if it's currently displaying this session's conversation. */
private getViewForSession(session: ConversationSession): NotorChatView | undefined {
  const displayConvId = this.conversationManager.getActiveConversation()?.id;
  return session.conversationId === displayConvId ? this.view : undefined;
}
```

All `this.view?.` calls inside `responseLoop` change to `this.getViewForSession(session)?.`. When the user navigates away, render calls become no-ops. Data writes continue unaffected.

**`switchConversation()` (line 356):**

1. **Reset `isResponding`:** Call `this.view?.setRespondingState(false)` to unlock input.
2. **Decouple AbortController:** Session owns its own `AbortController` (not via `this.view?.createAbortController()`). Stop button targets current session's controller.

**Message flow:**
1. Add user message to `this.conversationManager` (persists to JSONL, renders in UI)
2. Snapshot conversation + messages into session's isolated manager
3. Run `responseLoop(mode, session)` — all assistant/tool messages go through session manager

The session manager's `onMessageAdded` only fires for NEW messages added during the response loop, avoiding double-writes.

#### 4.1.5 Step 1e: Update `_backgroundResponseLoop` to use sessions

The background loop currently uses a save/restore hack for `activeWorkflowAssemblyResult` (L851-852, L1076). With sessions, this goes away.

**Changes:**
- Remove L850-852 (`previousAssemblyResult` save) and L1076 (restore)
- Create a `ConversationSession` for the background execution using the existing `bgConvManager`, the `workflowAssembly` parameter, and the concurrency manager's approval callback
- `resolveEffectiveConfig(matchedRules, session.workflowAssembly)` passes assembly directly
- L962-964 (direct `this.effectiveToolConfig` read): replaced with `session.effectiveConfig.tools[toolName]?.auto_approve ?? false`
- L975 `dispatcher.dispatch()` call: passes `session.buildPolicyContext()` and `session.approvalCallback`

#### 4.1.6 Step 1f: JSONL persona + model restoration on `switchConversation`

The `Conversation` header already stores `persona_name` (L544), `provider_id`, and `model_id`. Currently `switchConversation()` ignores them on load.

**Changes to `switchConversation()` (~L356):**

After loading conversation from history manager:
```typescript
// Restore persona from conversation header
if (conversation.persona_name && this.personaManager) {
  await this.personaManager.activatePersona(conversation.persona_name);
} else if (this.personaManager) {
  this.personaManager.deactivatePersona();
}

// Restore provider from conversation header
if (conversation.provider_id) {
  try {
    this.providerRegistry.switchProvider(conversation.provider_id as LLMProviderType);
  } catch {
    log.warn("Conversation provider not available, keeping current", {
      provider: conversation.provider_id
    });
  }
}
```

Also ensure `updateConversationHeader()` propagates persona changes if the user switches persona mid-conversation (the header's `persona_name` should stay current).

#### 4.1.7 Step 1g: Inspector shows displayed conversation's config

- `updateDisplayConfig()` (from Step 1b) stores the displayed conversation's config on orchestrator fields
- Called from `responseLoop` when session matches displayed conversation
- Called from `switchConversation()` when switching to a conversation with an active session (use session's config)
- `getEffectiveToolConfig()` and `getActiveParsedConfigs()` continue returning these fields
- No changes needed to `src/ui/effective-config-inspector.ts`

#### 4.1.8 Files modified

- `src/chat/tool-policy.ts` — **NEW**: `evaluateToolPolicy()` pure function, `ToolPolicyContext` interface, `PolicyDecision` interface
- `src/chat/conversation-session.ts` — **NEW**: `ConversationSession` class
- `src/chat/dispatcher.ts` — `dispatch()` gains optional `policyCtx` + `approvalCallback` params
- `src/chat/tool-orchestration.ts` — `executeToolBatches()`, `safeDispatch()`, `runConcurrentBatch()` thread `policyCtx` + `approvalCallback`
- `src/chat/orchestrator.ts` — `resolveEffectiveConfig()` (pure signature + body), `handleUserMessage()` (session creation), `responseLoop()` (uses session), `_backgroundResponseLoop()` (uses session, removes save/restore hack), `switchConversation()` (persona+model restoration, display config update, isResponding reset, abort controller decoupling), `updateDisplayConfig()` helper, `getViewForSession()` helper, `activeSessions` map
- `src/ui/chat-view.ts` — decouple `AbortController` from view (session owns its own)

---

### Phase 2: Session Registry & Duplicate Prevention

**Goal:** Track all in-flight response sessions. Prevent duplicate requests to the same conversation. Sync state when user returns.

#### 4.2.1 Session registry

**File:** `src/chat/orchestrator.ts`

```typescript
private activeSessions: Map<string, ResponseSession> = new Map();
```

**In `handleUserMessage()`:**
- Before creating a session, check: `if (this.activeSessions.has(conv.id))` → show `new Notice("This conversation is already processing")` and return
- After creating session: `this.activeSessions.set(session.conversationId, session)`
- In `finally` block: `this.activeSessions.delete(session.conversationId)`

**Public accessor:**
```typescript
getActiveSessions(): ResponseSession[] {
  return Array.from(this.activeSessions.values());
}

hasActiveSession(conversationId: string): boolean {
  return this.activeSessions.has(conversationId);
}
```

#### 4.2.2 Sync-back on conversation switch

**File:** `src/chat/orchestrator.ts` — `switchConversation()`

When switching to a conversation that has an active session, use the session's in-memory state instead of reloading from JSONL:

1. Check `this.activeSessions.has(conversation.id)`
2. **If active session exists:** Diff the session manager's messages against the UI manager's messages. Append only new messages (those added since the snapshot) to the UI manager and render them. This avoids re-parsing JSONL and preserves any in-progress rendering state.
3. Set `this.view?.setRespondingState(true)` and wire the stop button to `session.abortController`
4. Register a one-time callback on the session's `onStatusChange` to call `this.view?.setRespondingState(false)` when it completes
5. **If no active session:** Load from `HistoryManager` as normal (standard JSONL load for completed conversations)

#### 4.2.3 Files modified

- `src/chat/orchestrator.ts` — session map, duplicate guard, sync-back logic

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
  private readonly getActiveSessions?: () => ResponseSession[]
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
- Conversation title (from `ResponseSession.title`)
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

When `isSecondary === true`, `buildHeader()` renders only:
- "New conversation" button (message-square-plus icon)
- "Settings" gear button
- "Conversation history" list toggle

Omits: workflow activity indicator, MCP status indicator.

The input area remains the same (text input, send/stop, attachments).

**Singleton-assumption updates:** Code in `main.ts` that assumes one leaf of `CHAT_VIEW_TYPE` (e.g., `getLeavesOfType(CHAT_VIEW_TYPE)` at line 2182) must be updated to handle multiple leaves. The primary panel is the first leaf opened; subsequent leaves are secondary.

#### 4.4.2 Per-panel orchestrator

**File:** `src/main.ts`

The existing `registerView(CHAT_VIEW_TYPE, ...)` callback must detect whether this is a primary or secondary leaf and wire accordingly. Secondary leaves get `{ isSecondary: true }` passed to the constructor.

`wireSecondaryView(view)` creates a new `ChatOrchestrator` sharing expensive singletons:

```typescript
private wireSecondaryView(view: NotorChatView): void {
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

  // Wire same callbacks as wireView() but scoped to this orchestrator
  view.setOnSendMessage(async (content, attachments) => {
    await orchestrator.handleUserMessage(content, attachments);
  });
  view.setOnSwitchConversation((filename) => {
    orchestrator.switchConversation(filename);
  });
  view.setOnNewConversation(() => {
    orchestrator.newConversation();
  });
  // ... etc
}
```

#### 4.4.3 Tool approval routing

**Simplified by Phase 1:** Steps 1a and 1d already added per-invocation `approvalCallback` and `policyCtx` parameters to `dispatch()`. Each `ConversationSession` owns its approval callback. The global `setApprovalCallback()` fallback path can be removed once all callers pass per-call callbacks.

**Remaining Phase 4 work:** When creating a secondary panel's orchestrator, wire the panel's view-bound approval callback so that secondary panel sessions route approvals to the correct DOM. This is straightforward: `wireSecondaryView()` captures the secondary view's approval callback and passes it to the orchestrator at construction time.

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

- `src/ui/chat-view.ts` — `isSecondary` constructor option, reduced header, state persistence via `getState()`/`setState()`, `rebuildHeader()`
- `src/main.ts` — update `registerView` callback to handle secondary leaves, `wireSecondaryView()`, command, update singleton-assumption code (`getLeavesOfType`)
- `src/chat/dispatcher.ts` — remove global `setApprovalCallback()` fallback (per-call approval already added in Phase 1 Step 1a)

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
| Persona state is global | Changing persona mid-stream affects in-flight sessions | **Resolved in Phase 1 (Step 1d).** Active persona snapshotted at session creation as `session.pinnedPersona`. Mid-stream persona changes don't affect in-flight sessions. Secondary panels inherit persona at session start but don't show picker. Per-panel persona scoping deferred to v2. |
| `resolveEffectiveConfig` concurrency | Two concurrent sessions interleave tool config resolution, producing inconsistent state | **Resolved in Phase 1 (Steps 1a-1b).** `resolveEffectiveConfig()` is pure — returns results without mutating shared state. Policy enforcement is a pure function per-dispatch. Each session owns its resolved config. No shared mutable `effectiveToolConfig` on dispatcher. |
| `activeWorkflowAssemblyResult` race | Background loop save/restore hack not concurrent-safe | **Resolved in Phase 1 (Step 1e).** `resolveEffectiveConfig()` accepts `workflowAssembly` as parameter. Background session passes its assembly directly. Save/restore hack eliminated. |
| Provider rate limits | Multiple concurrent conversations hit API rate limits | Not architecturally addressed — existing `RATE_LIMITED` error handling surfaces a Notice to the user. |
| Memory pressure | Multiple ConversationManagers holding message arrays | Each manager only holds messages for one conversation. Lightweight compared to the LLM context window. |
| Stale UI on return | User switches back to a conversation that streamed in the background — may not see latest messages | In-memory diff from session manager for active sessions (Phase 2). JSONL reload for completed sessions without an active session. |
| AbortController scoping | Closing a panel while response is streaming | `ConversationSession` owns its `AbortController`. Panel `onClose()` aborts all sessions for that panel. |
| Persona/model restoration edge cases | Conversation's persona deleted or provider unconfigured since last use | Graceful fallback: `activatePersona()` returns false if persona not found, keeps current persona with warning. `switchProvider()` wrapped in try/catch, keeps current provider on failure. |

---

## 6. Implementation Order & Dependencies

```
Phase 1 (per-conversation session isolation — bug fix + architecture)
  ├── Step 1a: Extract policy from dispatcher (pure refactor, no behavior change)
  ├── Step 1b: Make resolveEffectiveConfig pure (pure refactor)
  ├── Step 1c: Create ConversationSession class
  ├── Step 1d: Update responseLoop to use sessions
  ├── Step 1e: Update _backgroundResponseLoop to use sessions
  ├── Step 1f: JSONL persona + model restoration
  └── Step 1g: Inspector display-conversation scoping
    ↓
Phase 2 (session registry + sync-back)
    ↓
    ├──→ Phase 3 (activity indicator)
    │
    └──→ Phase 4 (multi-panel — simplified: approval routing already per-session)
              ↓
         Phase 5 (open in new tab)
```

- **Phase 0 is eliminated.** The `resolveEffectiveConfig` concurrency investigation is resolved: Steps 1a-1b make config resolution pure and tool policy a per-call function. No shared mutable config state remains.
- **Phase 1** is independently shippable. Steps 1a-1b are pure refactors (backward compatible, can be verified independently). Steps 1c-1e fix the data corruption bug. Step 1f adds persona/model restoration. Step 1g scopes the inspector.
- **Phase 2** builds on Phase 1 and is required for Phases 3-5.
- **Phase 4 is simplified:** The spec's original Phase 4.4.3 (tool approval routing refactor) is already handled by Steps 1a/1d. Phase 4 only needs to wire per-panel callbacks when creating secondary orchestrators.
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
2. Try to send another message in the SAME original conversation (via navigating back) — verify "already processing" notice
3. Switch back to the streaming conversation mid-stream — verify new messages appear incrementally (in-memory diff, no full reload)
4. Verify the stop button correctly targets the active session's AbortController
5. Wait for completion, navigate back — verify conversation shows the completed response
6. Verify `activeSessions` map is empty after all responses complete

### Phase 3 Verification
1. Send a message, switch away mid-stream
2. Verify workflow activity badge shows count > 0
3. Open dropdown — verify conversation entry appears with "Streaming" status
4. Click the entry — verify navigation back to the streaming conversation
5. Wait for completion — verify badge returns to 0

### Phase 4 Verification
1. Open secondary panel via "Open new chat panel" command
2. Verify reduced toolbar (no workflow indicator, no MCP status)
3. Send messages in both primary and secondary panels simultaneously
4. Verify both conversations write to separate JSONL files
5. Close and reopen Obsidian — verify secondary panel restores with its conversation

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
| `_backgroundResponseLoop` | [`orchestrator.ts:839-1040`](../../src/chat/orchestrator.ts) | Self-contained response loop using passed-in manager |
| Sub-agent dispatcher creation | [`use-subagent.ts:314-319`](../../src/tools/use-subagent.ts) | Separate config per dispatch context (proven per-session isolation pattern) |
| Persona activate/deactivate | [`persona-manager.ts:117-147`](../../src/personas/persona-manager.ts) | `activatePersona(name)` for conversation load; handles provider/model overrides |
| Provider switching | [`providers/index.ts:158`](../../src/providers/index.ts) | `switchProvider()` for conversation load |
| `mergeToolConfigs` (pure) | [`tool-config/merger.ts:55-103`](../../src/tool-config/merger.ts) | Already pure — accepts inputs, returns merged config. No changes needed. |
| `getFilteredToolDefinitions` | [`tools/index.ts:124`](../../src/tools/index.ts) | Already pure — accepts `EffectiveToolConfig`, returns filtered defs. |
| `WorkflowActivityTracker` | [`src/workflows/workflow-activity-tracker.ts`](../../src/workflows/workflow-activity-tracker.ts) | `onChange()` / `getActiveCount()` / `hasActiveWorkflows()` pattern |
| `WorkflowActivityDropdown` | [`src/ui/workflow-activity-dropdown.ts`](../../src/ui/workflow-activity-dropdown.ts) | Positioned popover with live-update entries |
| HistoryManager write queues | [`src/chat/history.ts`](../../src/chat/history.ts) | Per-file promise chains serialize concurrent writes — no changes needed |
| View state persistence | Obsidian `ItemView.getState()` / `setState()` | Standard pattern for workspace restore |
| Conversation header persistence | [`types.ts:14-94`](../../src/types.ts) | `persona_name`, `provider_id`, `model_id` already stored in JSONL header — just need restoration on load |
