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
| Isolation unit | Per-response `ConversationManager` instance | Mirrors the proven `executeBackgroundWorkflow()` pattern (orchestrator.ts:710-724). Each response loop gets its own manager, wired to the shared `HistoryManager`. |
| Session tracking | `ResponseSession` class + `Map<string, ResponseSession>` on orchestrator | Lightweight wrapper capturing conversation ID, abort controller, status. Registry enables activity indicator and prevents duplicate requests to the same conversation. |
| UI ↔ streaming decoupling | `this.conversationManager` becomes "UI display manager" only | The main orchestrator's `conversationManager` tracks what's *shown* in the panel. Response loops use isolated managers. Switching the display manager has no effect on in-flight responses. |
| Activity indicator | Extend existing `WorkflowActivityIndicator` | Reuse the badge + dropdown pattern rather than adding a separate icon. Combined count: workflows + foreground sessions. |
| Multi-panel approach | Reuse `CHAT_VIEW_TYPE` with per-panel orchestrator | Same view type, differentiated by `{ isSecondary: true }` constructor option. Each panel gets its own `ChatOrchestrator` (lightweight — shares expensive singletons like `ProviderRegistry`, `HistoryManager`, `SystemPromptBuilder`). Own `ConversationManager` for independent state. Avoids maintaining two view registrations and divergent wire-up paths. |
| Secondary panel simplification | Reduced header toolbar | Only: "New conversation", "Settings", "Conversation history". Omits: workflow indicator, MCP status, persona picker, mode toggle. |
| Sync-back on return | In-memory diff from session manager | When user switches back to a conversation with an active session, diff the session manager's message array against the UI manager and append only new messages. Falls back to JSONL reload for completed sessions without an active session. Avoids expensive disk I/O during active streaming. |
| Tool approval routing | Required per-invocation approval callback | Remove global `setApprovalCallback()`. The dispatcher requires an approval callback per `dispatch()` call — no global fallback. Each panel/session passes its own view-bound callback. |

---

## 3. Architecture Overview

### Current Architecture (Single-Threaded)

```
ChatView (UI)
    ↕ callbacks
ChatOrchestrator (one per panel)
    → ConversationManager (instance-per-orchestrator, mutable activeConversation)
        → onMessageAdded → HistoryManager.appendMessage(getActiveConversation(), msg)
```

**Problem:** `getActiveConversation()` resolves at write time, not at request time.

### Proposed Architecture (Isolated Sessions)

```
ChatView (UI)
    ↕ callbacks
ChatOrchestrator
    → this.conversationManager          (UI display state — what's shown in the panel)
    → activeSessions: Map<convId, ResponseSession>
        → session.manager               (isolated ConversationManager per response)
            → onMessageAdded → HistoryManager.appendMessage(session.conv, msg)
```

**Fix:** Each response loop creates its own `ConversationManager`. The `onMessageAdded` callback on that instance always resolves to the correct (pinned) conversation.

### Multi-Panel Architecture

```
Primary NotorChatView
    → ChatOrchestrator (primary — full toolbar)
        → ConversationManager (UI display)
        → activeSessions Map

Secondary NotorChatView(s)
    → ChatOrchestrator (per-panel — reduced toolbar)
        → ConversationManager (independent display)
        → activeSessions Map

Shared singletons:
    → ProviderRegistry
    → HistoryManager (with per-file write queues)
    → SystemPromptBuilder
    → ToolDispatcher (with per-invocation approval callback)
    → PersonaManager
    → VaultRuleManager
```

---

## 4. Implementation Phases

### Phase 1: Per-Response ConversationManager Isolation (Bug Fix)

**Goal:** In-flight LLM responses always write to the correct JSONL file, regardless of UI navigation.

**Scope:** This phase alone fixes the data corruption bug and is independently shippable.

#### 4.1.1 New file: `src/chat/response-session.ts`

```typescript
export type ResponseSessionStatus =
  | "running"
  | "waiting_approval"
  | "completed"
  | "errored"
  | "cancelled";

export class ResponseSession {
  readonly conversationId: string;
  readonly conversationManager: ConversationManager;
  readonly abortController: AbortController;
  readonly title: string;
  readonly startedAt: number;

  private _status: ResponseSessionStatus = "running";
  onStatusChange?: (session: ResponseSession) => void;

  constructor(
    conversationManager: ConversationManager,
    abortController: AbortController,
    title: string
  ) {
    const conv = conversationManager.getActiveConversation();
    if (!conv) throw new Error("No active conversation");
    this.conversationId = conv.id;
    this.conversationManager = conversationManager;
    this.abortController = abortController;
    this.title = title;
    this.startedAt = Date.now();
  }

  get status(): ResponseSessionStatus { return this._status; }

  setStatus(status: ResponseSessionStatus): void {
    this._status = status;
    this.onStatusChange?.(this);
  }
}
```

#### 4.1.2 Changes to `src/chat/orchestrator.ts`

**`handleUserMessage()` (line 1217):**

After the existing conversation/model guards and before `responseLoop()`:

1. Snapshot the current conversation and messages from `this.conversationManager`
2. Create a new `ConversationManager` instance (same pattern as lines 710-724)
3. Wire `onMessageAdded` / `onConversationChanged` to `this.historyManager`
4. Load the snapshot into the new manager via `loadConversation()`
5. Create a `ResponseSession` wrapping the new manager
6. Pass the session's `conversationManager` into `responseLoop()`

```typescript
// Snapshot active persona at session start so mid-stream persona changes
// don't affect this response (same isolation principle as conversation state)
const pinnedPersona = this.personaManager?.getActivePersona() ?? null;

// Create isolated manager for this response (same pattern as executeBackgroundWorkflow:710-724)
const sessionManager = new ConversationManager(mode);
sessionManager.setOnMessageAdded(async (message) => {
  const conv = sessionManager.getActiveConversation();
  if (conv) await this.historyManager.appendMessage(conv, message);
});
sessionManager.setOnConversationChanged(async (conv) => {
  await this.historyManager.updateConversationHeader(conv);
});

// Snapshot current state into the isolated manager
const currentConv = this.conversationManager.getActiveConversation()!;
const currentMsgs = this.conversationManager.getMessages();
sessionManager.loadConversation(currentConv, [...currentMsgs]);

// Add the user message to the isolated manager (not the UI manager)
// Move the addMessage calls above to use sessionManager instead of this.conversationManager
```

**`responseLoop()` signature change:**

```typescript
private async responseLoop(
  mode: ConversationMode,
  sessionManager: ConversationManager,  // NEW — isolated conversation state
  pinnedPersona: Persona | null         // NEW — snapshot at session start
): Promise<void>
```

Inside the loop, replace `this.personaManager?.getActivePersona() ?? null` (line 1386) with `pinnedPersona`. This ensures the system prompt stays consistent across multi-turn tool loops even if the user changes persona mid-stream.

All internal `this.conversationManager` references change to `sessionManager`:
- `sessionManager.getMessages()` (line 1400)
- `sessionManager.getActiveConversation()` (line 1408, 1466, 1493, 1527, 1638, 1661)
- `sessionManager.addMessage()` (lines 1453, 1484, 1511, 1619, 1687, etc.)
- `sessionManager.addTokens()` (sub-agent token rollup, line 1630)
- `checkAndPerformCompaction()` (line 1368) — must accept `sessionManager` parameter since it reads conversation/messages from `this.conversationManager` internally (line 1755-1759)
- Hook dispatch calls: `dispatchOnToolCall` (line 1527) and `dispatchOnToolResult` (line 1638) both resolve conversation ID via `this.conversationManager.getActiveConversation()` — must use `sessionManager` instead

**View render guarding:** `responseLoop` also makes ~25 `this.view?.` calls for rendering (placeholders, tool calls, tool results, token footers, etc.). When the user navigates away mid-stream, these would render into the wrong conversation's DOM. Add a conversation-match guard:

```typescript
/** Returns the view only if it's currently displaying this session's conversation. */
private getViewForSession(sessionManager: ConversationManager): NotorChatView | undefined {
  const sessionConvId = sessionManager.getActiveConversation()?.id;
  const displayConvId = this.conversationManager.getActiveConversation()?.id;
  return sessionConvId === displayConvId ? this.view : undefined;
}
```

All `this.view?.` calls inside `responseLoop` change to `this.getViewForSession(sessionManager)?.`. When the user navigates away, this returns `undefined` and render calls become no-ops. Data writes (via `sessionManager`) continue unaffected. When the user navigates back, subsequent loop iterations pick up the view again.

**`switchConversation()` (line 356):**

In-flight sessions continue on their isolated managers, but the UI state must be reset for the new conversation:

1. **Reset `isResponding`:** Call `this.view?.setRespondingState(false)` so the input area is unlocked for the new conversation. Without this, `handleSend()` (line 1166) returns early due to the `isResponding` guard, blocking all input until the old response finishes.
2. **Decouple AbortController from the view:** The `ResponseSession` owns its own `AbortController` (not created via `this.view?.createAbortController()`). The session creates `new AbortController()` directly. The view's stop button must target the *current session's* controller:
   - When switching TO a conversation with an active session (Phase 2), wire the view's stop button to `session.abortController.abort()`
   - When switching TO a conversation without an active session, the stop button is hidden (responding state is false)

**Message flow:**
1. Add user message to `this.conversationManager` (persists to JSONL via its `onMessageAdded` callback, renders in UI via `renderUserMessage()`)
2. Snapshot conversation + messages (now including the user message) into `sessionManager`
3. Run `responseLoop(mode, sessionManager)` — all assistant/tool messages go through `sessionManager`

The session manager's `onMessageAdded` only fires for NEW messages added during the response loop, avoiding double-writes.

#### 4.1.3 Handling `_backgroundResponseLoop` unification

The existing `_backgroundResponseLoop` (line 839) already uses a passed-in `ConversationManager`. After Phase 1, the foreground `responseLoop` follows the same pattern. Consider whether to unify them into a single method. **Recommendation: defer unification** — the background loop has different tool handling (one-at-a-time) and no UI rendering. Unifying would add complexity without functional benefit.

#### 4.1.4 Files modified

- `src/chat/response-session.ts` — NEW
- `src/chat/orchestrator.ts` — `handleUserMessage()` (session manager creation, persona snapshot), `responseLoop()` (signature + body: `sessionManager` param, `pinnedPersona` param, `getViewForSession()` guard on all view calls), `checkAndPerformCompaction()` (accept session manager param), `switchConversation()` (reset `isResponding`, decouple abort controller)
- `src/ui/chat-view.ts` — decouple `AbortController` from view (stop button targets session's controller)

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

**File:** `src/chat/dispatcher.ts`

Remove the global `setApprovalCallback()` method (line 148) and its backing field. Replace with a **required** per-invocation approval callback in `dispatch()`:

```typescript
async dispatch(
  toolName: string,
  parameters: Record<string, unknown>,
  mode: ConversationMode,
  messageId: string,
  approvalCallback: ApprovalCallback,  // REQUIRED — no global fallback
  options?: { abortSignal?: AbortSignal }
): Promise<ToolResult>
```

All callers must pass their own callback:
- **Foreground `responseLoop`:** Passes the panel's view-bound approval callback (renders approval UI in the correct panel)
- **Background `_backgroundResponseLoop`:** Passes the `concurrencyManager` status-update callback (existing pattern)
- **`executeToolBatches`:** Signature updated to accept and forward the callback

This eliminates shared mutable state on the dispatcher. Each panel/session routes approvals to its own UI without conflict.

**Migration:** The existing `setApprovalCallback()` wiring in `wireView()` (main.ts ~line 2070) is removed. Instead, the orchestrator captures the approval callback at construction time and passes it per-dispatch.

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
- `src/chat/dispatcher.ts` — remove global `setApprovalCallback()`, require per-invocation approval callback in `dispatch()` options

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
| Tool dispatcher contention | Two panels both need tool approval simultaneously | Per-invocation approval callback (Phase 4.4.3). Each panel routes approval to its own view. |
| Persona state is global | Changing persona mid-stream affects in-flight sessions | Mitigated in Phase 1: active persona is snapshotted at session creation and passed into `responseLoop` as `pinnedPersona`. Secondary panels inherit persona at session start but don't show picker. Per-panel persona scoping deferred to v2. |
| Provider rate limits | Multiple concurrent conversations hit API rate limits | Not architecturally addressed — existing `RATE_LIMITED` error handling surfaces a Notice to the user. |
| Memory pressure | Multiple ConversationManagers holding message arrays | Each manager only holds messages for one conversation. Lightweight compared to the LLM context window. |
| Stale UI on return | User switches back to a conversation that streamed in the background — may not see latest messages | In-memory diff from session manager for active sessions (Phase 2). JSONL reload for completed sessions without an active session. |
| AbortController scoping | Closing a panel while response is streaming | `ResponseSession` owns its `AbortController`. Panel `onClose()` aborts all sessions for that panel. |
| `resolveEffectiveConfig` concurrency | Two concurrent sessions interleave tool config resolution, producing inconsistent state in the shared `ToolDispatcher` | **Blocking pre-Phase-1 investigation required.** Determine whether `resolveEffectiveConfig` can be made pure (return definitions without mutating dispatcher state) or whether tool config must be scoped per-session. Current code mutates shared dispatcher state on every loop iteration. |

---

## 6. Implementation Order & Dependencies

```
Phase 0 (investigation — resolveEffectiveConfig concurrency)
    ↓
Phase 1 (bug fix — per-response isolation)
    ↓
Phase 2 (session registry + sync-back)
    ↓
    ├──→ Phase 3 (activity indicator)
    │
    └──→ Phase 4 (multi-panel)
              ↓
         Phase 5 (open in new tab)
```

- **Phase 0** is a blocking investigation: determine whether `resolveEffectiveConfig` can be made pure or needs per-session scoping. This must be resolved before Phase 1 implementation begins.
- **Phase 1** is independently shippable and fixes the critical data corruption bug.
- **Phase 2** builds on Phase 1 and is required for Phases 3-5.
- **Phases 3, 4, 5** can be developed in parallel after Phase 2.

---

## 7. Verification Plan

### Phase 1 Verification
1. Start a conversation, send a message that triggers a long LLM response
2. While streaming, switch to a different conversation (or create a new one)
3. Verify: the input area is unlocked in the new conversation (isResponding reset)
4. Send a message in the new conversation — verify it works independently
5. Wait for the original response to complete
6. Verify: original conversation's JSONL has the complete assistant response
7. Verify: new conversation's JSONL is clean (no stray messages from the first response)
8. Switch back to original conversation — verify all messages render correctly
9. Verify: no stray DOM elements from the background response leaked into the new conversation's view

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
| `WorkflowActivityTracker` | [`src/workflows/workflow-activity-tracker.ts`](../../src/workflows/workflow-activity-tracker.ts) | `onChange()` / `getActiveCount()` / `hasActiveWorkflows()` pattern |
| `WorkflowActivityDropdown` | [`src/ui/workflow-activity-dropdown.ts`](../../src/ui/workflow-activity-dropdown.ts) | Positioned popover with live-update entries |
| HistoryManager write queues | [`src/chat/history.ts`](../../src/chat/history.ts) | Per-file promise chains serialize concurrent writes — no changes needed |
| View state persistence | Obsidian `ItemView.getState()` / `setState()` | Standard pattern for workspace restore |
