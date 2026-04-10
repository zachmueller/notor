# Multi-Conversation Robustness Redesign

**Status:** Draft
**Date:** 2026-04-10
**Prerequisite:** [thread-safe-streaming-multi-panel-design.md](done/thread-safe-streaming-multi-panel-design.md) (all 5 phases implemented)

---

## 1. Motivation

The thread-safe streaming and multi-panel design (Phases 1–5) has been fully implemented. The `ConversationSession` isolation model, per-orchestrator provider/model fields, and `getViewForSession()` rendering guards are all in place and working correctly for the core conversation loop.

However, post-implementation edge cases reveal that the **orchestrator ↔ view wiring layer** and **persistence lifecycle** have structural weaknesses that cause intermittent chat history loss. The user reports:

> Had a weird situation arise where the chat history apparently got dropped while continuously just chatting in a single thread. I don't recall changing into another conversation (though I did happen to have a secondary Notor chat panel opened elsewhere, though was not interacting with it at all when this arose). Also, when I ran Cmd + Shift + T to re-open the secondary Notor Chat Panel that I had just then closed, most of the chat history in the primary Notor chat panel (where I was in the middle of an active chat with Notor) flatly disappeared on me. Re-opening the conversation from the Conversation history tab seemed to solve these.

This spec addresses both the **immediate bugs** and the **structural weaknesses** that enable them.

### Key Architecture Reference

The multi-panel system is built on these classes (all implemented per the original spec):

- **`ChatOrchestrator`** ([`orchestrator.ts:63`](../../src/chat/orchestrator.ts)) — ~2,976 lines, manages conversations, sessions, and LLM interactions. Each panel (primary + secondary) gets its own instance. Key mutable fields: `conversationManager` (L64, display state), `activeSessions` (L148, `Map<string, ConversationSession>`), `view` (L165, single view pointer), `activeProviderType`/`activeModelId`/`activeUseExtendedContext` (L119/L130/L137, per-orchestrator state).
- **`ConversationSession`** ([`conversation-session.ts:41`](../../src/chat/conversation-session.ts)) — 110 lines, isolates all per-conversation state: own `ConversationManager` (L43), pinned persona/provider/model (L53-57), approval callback (L60), abort controller (L44). Created in `handleUserMessage()` at [`orchestrator.ts:1788-1801`](../../src/chat/orchestrator.ts) and `executeWorkflow()` at [`orchestrator.ts:908-921`](../../src/chat/orchestrator.ts).
- **`ConversationManager`** ([`conversation.ts`](../../src/chat/conversation.ts)) — Tracks `activeConversation` (L34) and `messages[]` (L37). Fire-and-forget persistence callbacks: `onMessageAdded` (L369) and `onConversationChanged` (L370/L130/L156).
- **`HistoryManager`** ([`history.ts:86`](../../src/chat/history.ts)) — JSONL persistence with per-file write queues (`writeQueues` Map at L93, serialized via `enqueueWrite()` at L127-138). No `flush()` method exists.
- **`NotorChatView`** ([`chat-view.ts`](../../src/ui/chat-view.ts)) — ~2,953 lines, 24+ callback properties (L173-213). `isSecondary` flag at L171 (default `false`). `getState()`/`setState()` at L711-753 for workspace restore.
- **`wireView()`** ([`main.ts:1995-2537`](../../src/main.ts)) — 542 lines, binds orchestrator ↔ view. Called from `registerView` factory (L295-308) and `wireViewAsSecondary` (L1697-1716).

---

## 2. Bug Analysis

### Bug A: Primary Panel History Vanishes on Secondary Panel Restore

**Severity:** High — active conversation state destroyed
**Trigger:** Cmd+Shift+T reopens a closed secondary panel

**Root cause:** `wireView()` ([`main.ts:1995-2537`](../../src/main.ts)) is called from the `registerView()` factory ([`main.ts:295-308`](../../src/main.ts)) **before** Obsidian calls `setState()` ([`chat-view.ts:727-753`](../../src/ui/chat-view.ts)) on the view. At this point, the view's `isSecondary` flag is `false` (default, [`chat-view.ts:171`](../../src/ui/chat-view.ts)). `wireView()` performs three dangerous operations that should only happen for the primary panel:

1. **`orchestrator.setView(view)`** ([`main.ts:2006`](../../src/main.ts)) — Calls [`orchestrator.ts:196-198`](../../src/chat/orchestrator.ts) (`setView()` is a simple assignment: `this.view = view`). Primary orchestrator's `this.view` now points to the new (soon-to-be secondary) view.
2. **`orchestrator.onSessionsChanged(...)`** ([`main.ts:2017`](../../src/main.ts)) — Calls [`orchestrator.ts:374-379`](../../src/chat/orchestrator.ts) which adds to `sessionChangeCallbacks` Set (L156). The return value (unregister function) is discarded. Another listener is added without cleaning up the old one.
3. **Conversation history loading** ([`main.ts:2493-2536`](../../src/main.ts)) — `view.getIsSecondary()` ([`chat-view.ts:756-758`](../../src/ui/chat-view.ts)) returns `false` so the guard at L2495 doesn't fire. Loads conversation list via `historyManager.listConversations()` (L2496) and calls `orchestrator.switchConversation(entries[0].filename)` (L2514) — which calls `this.view?.clearMessages()` ([`orchestrator.ts:635`](../../src/chat/orchestrator.ts)) and re-renders on `this.view` (which now points to the **wrong panel**)

**Exact sequence (with code references):**
```
1. User has primary panel showing conversation A (active chat)

2. User Cmd+Shift+T → Obsidian restores closed secondary panel

3. registerView factory [main.ts:295-308] creates new NotorChatView
   → calls wireView(newView) [main.ts:306]

4. wireView(newView) runs [main.ts:1995-2537]:
   a. orchestrator.setView(newView) [main.ts:2006]
      → calls setView() [orchestrator.ts:196-198]: this.view = view
      → primary orch.view → secondary view ❌

   b. orchestrator.onSessionsChanged(() => ...) [main.ts:2017]
      → adds to sessionChangeCallbacks Set [orchestrator.ts:375]
      → return value (unregister fn) discarded — 2nd listener ❌

   c. view.getIsSecondary() [main.ts:2495] → false (setState hasn't run yet)
      → guard doesn't fire → loads history [main.ts:2496-2536]
      → calls orchestrator.switchConversation(entries[0].filename) [main.ts:2514]

   d. switchConversation() [orchestrator.ts:560-675]:
      → loads JSONL via historyManager.loadConversation() [orchestrator.ts:569]
      → conversationManager.loadConversation(conv, msgs) [orchestrator.ts:632]
        → overwrites activeConversation to mostRecent (was conversation A)
      → this.view?.clearMessages() [orchestrator.ts:635]
        → clears SECONDARY view's DOM (this.view points there) but primary's DOM untouched
      → renders mostRecent's messages into secondary view [orchestrator.ts:636-638]

5. setState({ isSecondary: true }) fires [chat-view.ts:727-753]
   → detects s?.isSecondary && !this.isSecondary [chat-view.ts:731]
   → calls this.plugin.wireViewAsSecondary(this) [chat-view.ts:735]

6. wireViewAsSecondary(newView) [main.ts:1697-1716]:
   a. view.setIsSecondary(true) [main.ts:1698]
   b. const orchestrator = this.createSecondaryOrchestrator() [main.ts:1699]
      → creates new ChatOrchestrator [main.ts:1640-1687] sharing singletons
   c. this.wireView(newView, orchestrator) [main.ts:1700]
      → secondary orch.view → secondary view ✓
      → BUT: this triggers ANOTHER full wireView including history loading
   d. Re-wiring loop [main.ts:1709-1715]:
      → for (leaf of getLeavesOfType(CHAT_VIEW_TYPE))
      → finds primary panel (!v.getIsSecondary() && v !== view)
      → this.wireView(primaryView, primaryOrch) [main.ts:1712]
      → triggers THIRD wireView call including history loading AGAIN
      → orchestrator.setView(primaryView) → primary orch → primary view ✓ (restored)
      → But step 4d already overwrote conversationManager state
      → History loading at L2493-2536 reloads mostRecent from JSONL yet again

7. Result: Primary panel now shows mostRecent (not conversation A)
   → conversationManager.activeConversation was overwritten in step 4d
   → If A had unflushed messages, they're lost (reloaded from possibly-incomplete JSONL)
   → If A had an active session, the orchestrator's display state doesn't match it
   → getViewForSession(session) [orchestrator.ts:402-405] checks
     session.conversationId === this.conversationManager.getActiveConversation()?.id
     → if activeConversation was changed to mostRecent, this returns undefined
     → all subsequent renders for session A become no-ops
```

### Bug B: Fire-and-Forget Persistence Can Lose Messages

**Severity:** Medium — data loss on session cleanup or plugin close
**Trigger:** Session cleanup runs before JSONL writes flush

**Root cause:** `ConversationManager.addMessage()` ([`conversation.ts:293-373`](../../src/chat/conversation.ts)) fires persistence callbacks with `void` at L369-370:

```typescript
void this.onMessageAdded?.(message);           // L369
void this.onConversationChanged?.(this.activeConversation);  // L370
```

The `onMessageAdded` callback is wired in two places:
- **Display manager** (orchestrator constructor, [`orchestrator.ts:179-184`](../../src/chat/orchestrator.ts)): `await this.historyManager.appendMessage(conv, message)`
- **Session manager** (`handleUserMessage`, [`orchestrator.ts:1739-1744`](../../src/chat/orchestrator.ts)): Same pattern, but wired to the session's isolated `ConversationManager`

Both callbacks trigger `historyManager.appendMessage()` which calls `enqueueWrite()` ([`history.ts:127-138`](../../src/chat/history.ts)). The `enqueueWrite` method chains a promise onto the per-file write queue and returns it, but the `void` prefix in `addMessage()` means the promise is never awaited by the caller.

**The persistence data flow:**
```
addMessage() [conversation.ts:369]
  → void this.onMessageAdded?.(message)       ← fire-and-forget
    → historyManager.appendMessage(conv, msg)  [history.ts:176-199]
      → enqueueWrite(filePath, async () => {   [history.ts:127-138]
            const existing = await vault.adapter.read(filePath);
            await vault.adapter.write(filePath, existing + line + "\n");
        })
      → const next = current.then(operation, operation);  [history.ts:129]
      → this.writeQueues.set(filePath, next);              [history.ts:130]
      → return next;  ← returned to appendMessage, but never awaited
```

Session cleanup at [`orchestrator.ts:1828-1835`](../../src/chat/orchestrator.ts) deletes the session immediately without draining writes:

```typescript
// orchestrator.ts:1828-1835
finally {
    if (session.status === "running" || session.status === "waiting_approval") {
        session.setStatus("completed");          // L1830
    }
    this.activeSessions.delete(session.conversationId);  // L1832 ← immediate
    this.notifySessionsChanged();                         // L1833
    this.getViewForSession(session)?.setRespondingState(false);  // L1834
}
```

The same pattern exists in `executeWorkflow()` at [`orchestrator.ts:942-953`](../../src/chat/orchestrator.ts).

The `destroy()` method ([`orchestrator.ts:434-454`](../../src/chat/orchestrator.ts)) awaits `responsePromise` with a 2s timeout (L445-448), but `responsePromise` resolves when the response loop exits — the fire-and-forget writes from the loop's final messages may still be in the `writeQueues` Map. There is no `historyManager.flush()` call.

Plugin unload at [`main.ts:642-679`](../../src/main.ts) calls `orchestrator.destroy()` fire-and-forget (L649) because `onunload()` is synchronous.

### Bug C: Sync-Back Snapshot Race

**Severity:** Low — display-only, self-healing on re-switch
**Trigger:** Switching to a conversation with an active session while messages arrive

**Root cause:** In `switchConversation()` ([`orchestrator.ts:560-675`](../../src/chat/orchestrator.ts)), the sync-back path (L575-628) handles the case where the target conversation has an active session:

```typescript
// orchestrator.ts:575-589
const activeSession = this.activeSessions.get(conversation.id);
if (activeSession) {
    const sessionConv = activeSession.conversationManager.getActiveConversation()!;  // L577
    const sessionMessages = activeSession.conversationManager.getMessages();          // L578
    // getMessages() returns [...this.messages] — a snapshot copy [conversation.ts:378-379]

    this.conversationManager.loadConversation(sessionConv, sessionMessages, { silent: true });  // L583
    // loadConversation with silent:true [conversation.ts:146-158] — skips onConversationChanged

    this.view?.clearMessages();                     // L586
    for (const msg of sessionMessages) {            // L587
        this.renderMessage(msg);                    // L588
    }                                               // L589
```

If the response loop (`responseLoop()` at [`orchestrator.ts:1855`](../../src/chat/orchestrator.ts)) adds a message via `session.conversationManager.addMessage()` between the L578 snapshot and the L586-589 re-render, that message is not included in the snapshot and won't be displayed.

After the re-render, `getViewForSession(session)` ([`orchestrator.ts:402-405`](../../src/chat/orchestrator.ts)) will return `this.view` (since the display manager's conversation ID now matches the session), so subsequent messages from the response loop WILL render. The missed message is the one that fell into the gap.

This is a narrow race window (single JS event loop — the response loop yields at `for await` boundaries in `processStream()`), but it's possible if a message was enqueued as a pending microtask just before the snapshot.

### Bug D: Cross-Orchestrator Same-Conversation Conflict

**Severity:** Medium — potential JSONL corruption and state divergence
**Trigger:** Two panels send messages to the same conversation simultaneously

**Root cause:** The duplicate-send guard at [`orchestrator.ts:1614-1617`](../../src/chat/orchestrator.ts) is per-orchestrator:

```typescript
// orchestrator.ts:1613-1617
if (this.activeSessions.has(conv.id)) {
    new Notice("This conversation is already processing");
    return;
}
```

`activeSessions` is a `Map<string, ConversationSession>` at [`orchestrator.ts:148`](../../src/chat/orchestrator.ts) — each orchestrator has its own instance. There is no cross-orchestrator check.

**Scenario:** User opens conversation X in both primary and secondary panels. Each panel has its own orchestrator (secondary created via `createSecondaryOrchestrator()` at [`main.ts:1640-1687`](../../src/main.ts)). Both orchestrators share the same `HistoryManager` singleton (injected at [`main.ts:1652`](../../src/main.ts)).

If the user sends a message in both panels:
1. Primary orchestrator creates session A for conv X → `activeSessions.set(X, sessionA)`
2. Secondary orchestrator creates session B for conv X → `activeSessions.set(X, sessionB)` ← different map, passes guard
3. Both sessions wire `onMessageAdded` to the same `historyManager.appendMessage()` targeting the same JSONL file
4. `HistoryManager.enqueueWrite()` ([`history.ts:127-138`](../../src/chat/history.ts)) serializes per file path — writes are ordered
5. BUT: session A's `ConversationManager` and session B's `ConversationManager` have divergent in-memory `messages[]` arrays — each only sees its own messages
6. Token counts, message ordering, and compaction thresholds diverge between sessions
7. The JSONL file ends up with interleaved messages from both sessions — readable but semantically broken

---

## 3. Structural Weaknesses

These are not bugs per se, but architectural properties that make bugs like the above easy to create and hard to prevent.

### W1: `wireView()` is a 542-line All-or-Nothing Operation

[`main.ts:1995-2537`](../../src/main.ts) — `wireView()` performs three distinct categories of work in a single call:

| Category | Lines | What It Does | Safe to Run Before setState? |
|----------|-------|--------------|------------------------------|
| **Callback wiring** | 2031-2491 | Sets 24+ `setOn*` callbacks on the view (send message L2095, new conversation L2113, switch conversation L2162, mode toggle L2289, provider/model change L2323/L2347, approval L2456, etc.) | Yes — callbacks are just function references |
| **Orchestrator binding** | 2005-2017 | `orchestrator.setView(view)` (L2006), `onSessionsChanged()` (L2017), `view.setGetActiveSessions()` (L2016) | **No** — must know which orchestrator |
| **History loading** | 2493-2536 | Guard: `if (view.getIsSecondary()) return` (L2495). Lists conversations via `historyManager.listConversations()` (L2496), auto-starts new conversation (L2501) or restores most recent via `orchestrator.switchConversation(entries[0].filename)` (L2514) | **No** — must know if primary or secondary |

Because all three run together, `wireView()` cannot be safely called before the view's identity (primary vs secondary) is known. The `registerView` factory ([`main.ts:295-308`](../../src/main.ts)) has no choice but to call it early (Obsidian requires a fully constructed view from the factory, and `setState()` runs asynchronously after factory return), creating the race condition in Bug A.

### W2: No Persistence Backpressure

The `ConversationManager` → `HistoryManager` persistence path is entirely fire-and-forget. The callback signatures allow async but the callers discard the promise:

- `onMessageAdded` type: `(message: Message) => void | Promise<void>` — called with `void` prefix at [`conversation.ts:369`](../../src/chat/conversation.ts)
- `onConversationChanged` type: `(conv: Conversation) => void | Promise<void>` — called with `void` prefix at [`conversation.ts:370`](../../src/chat/conversation.ts), also at L130 and L156

```
addMessage() [conversation.ts:369]
  → void this.onMessageAdded?.(msg)
    → historyManager.appendMessage(conv, msg) [history.ts:176-199]
      → enqueueWrite(filePath, operation) [history.ts:127-138]
        → const next = current.then(operation, operation)  [L129]
        → this.writeQueues.set(filePath, next)              [L130]
        → void next.finally(() => { ... cleanup ... })      [L132-136]
        → return next   ← returned but never awaited
```

The `HistoryManager` has per-file write queues (`writeQueues` at [`history.ts:93`](../../src/chat/history.ts)) that serialize operations within a file, but:
- No `flush()` method to await all pending queues
- No way for callers to know when a specific write completed
- No way to block session cleanup or plugin unload until writes drain
- The `finally` cleanup in `enqueueWrite()` (L132-136) auto-removes settled queues, so by the time you'd want to check, the queue entry may already be gone

### W3: Session-Change Listener Accumulation

`onSessionsChanged()` ([`orchestrator.ts:374-379`](../../src/chat/orchestrator.ts)) adds the callback to `sessionChangeCallbacks` Set (L375) and returns an unregister function (L376-378). The caller at [`main.ts:2017`](../../src/main.ts) discards the return value:

```typescript
// main.ts:2017 — return value discarded
orchestrator.onSessionsChanged(() => view.updateActivityIndicator());
```

Each `wireView()` call adds another listener. Cleanup relies on `sessionChangeCallbacks.clear()` in `destroy()` ([`orchestrator.ts:452`](../../src/chat/orchestrator.ts)), which only runs on plugin unload.

During the Bug A sequence, the primary orchestrator receives 3 `wireView()` calls (initial → secondary restore → re-wire primary), accumulating 3 duplicate listeners for the same view's `updateActivityIndicator()`. The listeners fire on every session change via `notifySessionsChanged()` ([`orchestrator.ts:384-392`](../../src/chat/orchestrator.ts)) — called at L1805, L1833, L924, L951. Each invocation iterates the full Set and calls all registered callbacks. Functionally benign (updateActivityIndicator is idempotent) but wasteful.

### W4: No Global Session Guard

Each orchestrator independently tracks its own `activeSessions` Map ([`orchestrator.ts:148`](../../src/chat/orchestrator.ts)). Secondary orchestrators are tracked in `_secondaryOrchestrators` array ([`main.ts:155`](../../src/main.ts), populated by `createSecondaryOrchestrator()` at L1684), but there is no shared registry of globally active conversation IDs.

The duplicate-send guard (`this.activeSessions.has(conv.id)` at [`orchestrator.ts:1614`](../../src/chat/orchestrator.ts)) only checks the local Map. The deletion guard in `main.ts` (`orchestrator.getActiveSessions()` at [`main.ts:2228`](../../src/main.ts)) only checks the current panel's orchestrator. No code path iterates `_secondaryOrchestrators` to check all sessions before allowing a new one.

### W5: `wireViewAsSecondary()` Relies on Leaf Iteration

The re-wiring loop at [`main.ts:1709-1715`](../../src/main.ts) searches all workspace leaves to find the primary panel:

```typescript
// main.ts:1708-1715
const primaryOrch = this.getOrchestrator();
for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
    const v = leaf.view;
    if (v instanceof NotorChatView && !v.getIsSecondary() && v !== view) {
        this.wireView(v, primaryOrch);  // full wireView — including history loading
        return;
    }
}
```

Problems:
- **Full `wireView()` on re-wire:** Calls the complete 542-line `wireView()` including history loading (L2493-2536). This triggers `switchConversation()` which can overwrite the primary orchestrator's display state.
- **Fragile matching:** The condition `!v.getIsSecondary() && v !== view` depends on `isSecondary` being set correctly. During the workspace restore window (between `registerView` factory and `setState()`), newly created views have `isSecondary = false` even if they're about to become secondary.
- **Silent failure:** If no matching leaf is found (e.g., primary panel not yet constructed, or Obsidian hasn't attached the leaf to the workspace), the loop exits without re-wiring. The primary orchestrator's `this.view` remains pointing at the secondary view from step 4a of the Bug A sequence. No warning is logged.
- **Multiple iterations:** If there are multiple non-secondary views (e.g., two primary panels from a corrupted workspace layout), the loop re-wires the first one found and ignores others.

---

## 4. Design: Two-Phase View Wiring

**Goal:** Split `wireView()` so that identity-dependent operations only run after the view's primary/secondary status is known.

### 4.1 Phase 1: Callback Wiring (Safe Pre-setState)

New method `wireViewCallbacks(view, orchestrator?)`:
- Sets up all 24+ `setOn*` callback handlers
- Does NOT call `orchestrator.setView(view)`
- Does NOT register `onSessionsChanged` listener
- Does NOT load conversation history
- Uses the primary orchestrator by default for callback closures — these closures will be rebound if the view turns out to be secondary

Called from `registerView()` factory:

```typescript
this.registerView(CHAT_VIEW_TYPE, (leaf) => {
    const view = new NotorChatView(leaf, this);
    this.wireViewCallbacks(view);  // Phase 1 only
    return view;
});
```

### 4.2 Phase 2: Identity Binding (Post-setState)

New method `finalizeViewWiring(view, orchestrator?, savedState?)`:
- Calls `orchestrator.setView(view)`
- Registers `onSessionsChanged` listener (with cleanup — see Section 4.4)
- Loads conversation history — **this is the single owner of all conversation loading** (see Section 4.5)
- Accepts an optional `savedState` parameter containing `conversationId` and/or `conversationFilename` from workspace restore

Called from two places:

**A. `setState()` in `chat-view.ts`** (workspace restore path):
```typescript
async setState(state, result) {
    await super.setState(state, result);
    const s = state as Record<string, unknown> | null;

    if (s?.isSecondary && !this.isSecondary) {
        // Secondary panel — wireViewAsSecondary handles finalizeViewWiring internally
        this.plugin.wireViewAsSecondary(this);
    } else if (!this.isSecondary) {
        // Primary panel — finalize with primary orchestrator.
        // Pass the saved state so finalizeViewWiring can load the correct
        // conversation directly (not the most recent). This replaces the
        // previous setTimeout-deferred loading that was in setState.
        this.plugin.finalizeViewWiring(this, undefined, s);
    }

    this.isSecondary = !!s?.isSecondary;
    // NOTE: The previous setTimeout-deferred conversation loading that was
    // here (onSwitchConversation / onSwitchToConversationById) has been
    // removed. All conversation loading is now handled by finalizeViewWiring()
    // to prevent double-load races. See Section 4.5.
}
```

**Important: `setState` no longer loads conversations.** The existing deferred `setTimeout` blocks at [`chat-view.ts:740-752`](../../src/ui/chat-view.ts) that called `onSwitchConversation` and `onSwitchToConversationById` must be removed. `finalizeViewWiring()` is the single owner of conversation loading for all panels. This prevents the double-load race where `finalizeViewWiring` loads the most-recent conversation and then `setState`'s `setTimeout` overwrites it with the saved conversation ID.

**B. Deferred fallback** (initial plugin load — no `setState` called):

Obsidian calls `setState()` whenever it restores workspace layout (including on first plugin load if workspace.json has saved state). However, in edge cases (brand-new install, no saved workspace), `setState()` may not fire. Use a microtask fallback as a safety net:

```typescript
// In registerView factory, after wireViewCallbacks:
queueMicrotask(() => {
    if (!view.isWiringFinalized) {
        // setState didn't run — this is a fresh panel with no saved state
        this.finalizeViewWiring(view);
    }
});
```

Add `isWiringFinalized: boolean` flag to `NotorChatView`, set to `true` by `finalizeViewWiring()`.

**Ordering guarantee:** The `isWiringFinalized` flag ensures exactly one path runs:
- If `setState()` runs first (synchronously after factory return), it calls `finalizeViewWiring()` which sets `isWiringFinalized = true`. The microtask fires later, finds the flag set, and exits.
- If the microtask runs first (no `setState` call), it calls `finalizeViewWiring()` without `savedState`, loading the most-recent conversation. If `setState()` subsequently fires, it finds `isWiringFinalized = true` and skips finalization.
- Both paths are idempotent — the flag prevents double-finalization regardless of timing.

### 4.3 Updated `wireViewAsSecondary()`

With two-phase wiring, the primary orchestrator is never mis-wired to a secondary view. The re-wiring loop (W5) is no longer needed:

```typescript
wireViewAsSecondary(view: NotorChatView): void {
    view.setIsSecondary(true);
    const orchestrator = this.createSecondaryOrchestrator();
    
    // Rebind callbacks to secondary orchestrator
    this.wireViewCallbacks(view, orchestrator);
    
    // Finalize with secondary orchestrator
    this.finalizeViewWiring(view, orchestrator);
    
    // No loop to find and re-wire primary — it was never mis-wired
}
```

### 4.4 Session-Change Listener Cleanup

Add a field to `NotorChatView`:

```typescript
/** Unregister function for the onSessionsChanged listener. */
_unregisterSessionsChanged?: () => void;
```

In `finalizeViewWiring()`:

```typescript
// Clean up previous listener before registering new one
view._unregisterSessionsChanged?.();
view._unregisterSessionsChanged = orchestrator.onSessionsChanged(
    () => view.updateActivityIndicator()
);
```

### 4.5 Conversation Loading in `finalizeViewWiring()`

`finalizeViewWiring()` is the **single owner of all conversation loading** for both primary and secondary panels. This replaces the previous split where `setState()` had its own deferred `setTimeout` loading at [`chat-view.ts:740-752`](../../src/ui/chat-view.ts).

The `savedState` parameter (passed from `setState()` on workspace restore) determines which conversation to load:

```typescript
// In finalizeViewWiring(view, orchestrator?, savedState?):
view.isWiringFinalized = true;
orchestrator.setView(view);

// ... onSessionsChanged listener setup (Section 4.4) ...

// Conversation loading — only for primary panels without an active conversation.
// The !orchestrator.getDisplayedConversation() guard is defense-in-depth:
// it prevents re-wiring paths from clobbering in-flight state.
if (!view.getIsSecondary() && !orchestrator.getDisplayedConversation()) {
    historyManager.listConversations().then((entries) => {
        view.renderConversationList(entries);

        // Determine target conversation: saved state takes priority over most-recent.
        // savedState comes from setState() on workspace restore — it contains the
        // conversationId or conversationFilename that was active when the panel closed.
        const savedFilename = savedState?.conversationFilename as string | undefined;
        const savedId = savedState?.conversationId as string | undefined;

        if (savedFilename) {
            // "Open in new tab" passes a filename — load it directly
            orchestrator.switchConversation(savedFilename).then(/* ... */).catch(/* fallback to new */);
        } else if (savedId) {
            // Workspace restore passes a conversation ID — resolve and load
            orchestrator.switchToConversationById(savedId).then(/* ... */).catch(/* fallback to most recent */);
        } else if (entries.length === 0) {
            orchestrator.newConversation().then(/* ... */);
        } else {
            // No saved state — load most recent (default for fresh panels / microtask fallback)
            orchestrator.switchConversation(entries[0].filename).then(/* ... */);
        }
    });
}
```

This design prevents the double-load race that existed when `setState()` and `wireView()` both attempted to load conversations independently.

### 4.6 View Close Lifecycle

**Goal:** Handle panel closure gracefully — especially for secondary panels with active sessions.

**Problem:** `onClose()` at [`chat-view.ts:670-697`](../../src/ui/chat-view.ts) performs basic DOM cleanup but does no orchestrator lifecycle management. When a secondary panel is closed mid-session:
1. The orchestrator's `this.view` references a destroyed view — renders hit detached DOM
2. Tool approval callbacks reference destroyed UI — approvals hang forever
3. The orchestrator leaks in `_secondaryOrchestrators` until plugin unload

**Design:** Detach the view immediately but defer orchestrator destruction until active sessions complete. This preserves the user's expectation that in-progress work finishes even after closing the panel.

Wire a `setOnCloseCleanup` callback in `finalizeViewWiring()`:

```typescript
// In finalizeViewWiring():
view.setOnCloseCleanup(() => {
    // 1. Detach view — renders become no-ops via existing this.view?. guards
    orchestrator.setView(undefined);

    // 2. Clean up session-change listener
    view._unregisterSessionsChanged?.();

    // 3. Check for active sessions
    const activeSessions = orchestrator.getActiveSessions();

    if (activeSessions.length === 0) {
        // No active sessions — destroy immediately
        orchestrator.destroy();
        this.removeSecondaryOrchestrator(orchestrator);
        return;
    }

    // 4. Active sessions exist — let them finish, then destroy.
    // Auto-approve tool calls when view is detached (the user closed
    // the panel, implying they trust the remaining work to complete).
    let remaining = activeSessions.length;
    for (const session of activeSessions) {
        const previousOnStatusChange = session.onStatusChange;
        session.onStatusChange = (s) => {
            previousOnStatusChange?.(s);
            if (s.status === "completed" || s.status === "errored" || s.status === "cancelled") {
                remaining--;
                if (remaining === 0) {
                    // All sessions done — safe to destroy
                    orchestrator.destroy();
                    this.removeSecondaryOrchestrator(orchestrator);
                }
            }
        };
    }
});
```

In `onClose()` at [`chat-view.ts:670-697`](../../src/ui/chat-view.ts), add at the start:

```typescript
// Notify plugin to handle orchestrator lifecycle
this.onCloseCleanup?.();
```

**Primary panel close:** When the primary panel is closed while a secondary exists, `orchestrator.setView(undefined)` makes renders no-ops. The primary orchestrator stays alive (it's a singleton). When the primary panel is reopened, `finalizeViewWiring()` restores the view reference via `orchestrator.setView(view)`. The `!orchestrator.getDisplayedConversation()` guard in Section 4.5 allows re-loading only when the orchestrator has no active conversation.

**Helper method:** Add `removeSecondaryOrchestrator(orch)` to the plugin class that removes from `_secondaryOrchestrators` and unregisters from the global session guard.

---

## 5. Design: Persistence Flush

**Goal:** Ensure all JSONL writes complete before session cleanup and plugin unload.

### 5.1 `HistoryManager.flush()` and `flushFile()`

Add two public methods to [`history.ts`](../../src/chat/history.ts):

```typescript
/**
 * Await all pending write queues (best-effort).
 *
 * Returns when every in-flight enqueueWrite chain has settled.
 * Safe to call when no writes are pending (returns immediately).
 * Use for plugin unload where all writes must drain.
 */
async flush(): Promise<void> {
    const pending = Array.from(this.writeQueues.values());
    if (pending.length > 0) {
        await Promise.allSettled(pending);
    }
}

/**
 * Await pending writes for a specific conversation's JSONL file (best-effort).
 *
 * More precise than flush() — only blocks on writes for the given conversation,
 * avoiding cross-conversation blocking where a slow write for conversation Y
 * would delay cleanup of conversation X.
 *
 * @param conversationId - The conversation ID whose JSONL writes to drain.
 *   Resolves to the file path via the same logic as appendMessage().
 */
async flushFile(conversationId: string): Promise<void> {
    // Resolve the JSONL file path for this conversation.
    // The writeQueues Map is keyed by file path, not conversation ID.
    const filePath = this.getConversationFilePath(conversationId);
    const pending = this.writeQueues.get(filePath);
    if (pending) {
        await pending;
    }
}
```

**Note:** `getConversationFilePath()` must be extracted or exposed from the existing path-resolution logic used by `appendMessage()` at [`history.ts:176-199`](../../src/chat/history.ts).

### 5.2 Flush Before Session Deletion

In session cleanup finally blocks ([`orchestrator.ts:1828-1835`](../../src/chat/orchestrator.ts) for `handleUserMessage`, and the equivalent block in `executeWorkflow`):

```typescript
finally {
    if (session.status === "running" || session.status === "waiting_approval") {
        session.setStatus("completed");
    }
    // Drain pending JSONL writes for THIS conversation before removing the session.
    // Uses flushFile() (not flush()) to avoid blocking on unrelated conversations.
    // The sync-back path in switchConversation() checks activeSessions
    // to decide whether to use session state or JSONL — if we delete
    // the session before writes flush, sync-back falls through to
    // JSONL which may be incomplete.
    try {
        await this.historyManager.flushFile(session.conversationId);
    } catch {
        // Best-effort — don't block session cleanup on write errors
    }
    this.globalSessionGuard.unregister(session.conversationId);
    this.activeSessions.delete(session.conversationId);
    this.notifySessionsChanged();
    this.getViewForSession(session)?.setRespondingState(false);
}
```

### 5.3 Flush in `destroy()`

Extend [`orchestrator.ts:434-454`](../../src/chat/orchestrator.ts) to also flush after awaiting response promises:

```typescript
async destroy(timeoutMs: number = 2000): Promise<void> {
    // ... existing session abort + await logic ...

    // Flush any writes that may have been enqueued in finally blocks.
    // Uses global flush() here (not flushFile) because destroy() tears
    // down the entire orchestrator — draining all writes is correct.
    try {
        await Promise.race([
            this.historyManager.flush(),
            new Promise<void>((r) => setTimeout(r, Math.max(timeoutMs / 2, 500))),
        ]);
    } catch {
        // Best-effort
    }

    // Unregister all active session IDs from the global guard BEFORE
    // clearing the map. Without this, destroyed orchestrators leave
    // phantom entries that permanently block those conversations.
    for (const id of this.activeSessions.keys()) {
        this.globalSessionGuard.unregister(id);
    }

    this.activeSessions.clear();
    this.sessionChangeCallbacks.clear();
    log.info("Orchestrator destroyed", { abortedSessions: sessionPromises.length });
}
```

---

## 6. Design: Sync-Back Delta Check

**Goal:** Close the narrow race window where messages arrive between the sync-back snapshot and re-render.

After the sync-back render loop in [`orchestrator.ts:586-589`](../../src/chat/orchestrator.ts):

```typescript
// Existing: snapshot and render
const sessionMessages = activeSession.conversationManager.getMessages();
this.conversationManager.loadConversation(sessionConv, sessionMessages, { silent: true });
this.view?.clearMessages();
for (const msg of sessionMessages) {
    this.renderMessage(msg);
}

// NEW: catch messages that arrived during re-render
const postRenderMessages = activeSession.conversationManager.getMessages();
if (postRenderMessages.length > sessionMessages.length) {
    for (const msg of postRenderMessages.slice(sessionMessages.length)) {
        this.renderMessage(msg);
    }
    // Update display manager with the complete set
    this.conversationManager.loadConversation(
        activeSession.conversationManager.getActiveConversation()!,
        postRenderMessages,
        { silent: true }
    );
}
```

This is safe because:
- `getMessages()` returns a copy (`[...this.messages]`)
- The response loop yields at `for await` boundaries, so during synchronous re-rendering no new messages can arrive

**Note on rationale:** The snapshot at L578 and the render loop at L586-589 are in the same synchronous execution block with no `await` between them. Microtasks cannot interrupt synchronous JavaScript execution. Therefore, in the current code structure, the delta check has zero practical value — no messages can arrive between the snapshot and the render.

However, this check is retained as **defense-in-depth** against future code changes that might introduce an `await` between the snapshot and the render (e.g., an async render pipeline). The cost is negligible (one array length comparison) and it makes the sync-back path robust to refactoring.

---

## 7. Design: Global Active-Session Guard

**Goal:** Prevent two orchestrators from creating sessions for the same conversation.

### 7.1 Shared Guard in Plugin

Add to [`main.ts`](../../src/main.ts):

```typescript
/**
 * Global set of conversation IDs with active sessions across ALL orchestrators.
 * Prevents two panels from creating sessions for the same conversation,
 * which would cause divergent in-memory state and interleaved JSONL writes.
 */
private _globalActiveConversationIds = new Set<string>();
```

### 7.2 Guard Interface

```typescript
interface GlobalSessionGuard {
    isActive(conversationId: string): boolean;
    register(conversationId: string): void;
    unregister(conversationId: string): void;
}
```

Injected into each orchestrator (primary + secondary) as a **required constructor parameter**:

```typescript
// In ChatOrchestrator constructor:
constructor(
    // ... existing params ...
    private readonly globalSessionGuard: GlobalSessionGuard,
) { /* ... */ }

// In main.ts — create the guard once, pass to all orchestrators:
private _globalSessionGuard: GlobalSessionGuard = {
    isActive: (id) => this._globalActiveConversationIds.has(id),
    register: (id) => this._globalActiveConversationIds.add(id),
    unregister: (id) => this._globalActiveConversationIds.delete(id),
};

// In getOrchestrator() and createSecondaryOrchestrator():
new ChatOrchestrator(/* ... */, this._globalSessionGuard);
```

Making this a constructor parameter (not a setter) ensures the guard cannot be accidentally omitted. Optional chaining is not used — the guard is always present.

### 7.3 Check Before Session Creation

In `handleUserMessage()` and `executeWorkflow()`, before creating a session:

```typescript
// Existing per-orchestrator guard
if (this.activeSessions.has(conv.id)) {
    new Notice("This conversation is already processing");
    return;
}

// NEW: cross-orchestrator guard (non-optional — constructor-injected)
if (this.globalSessionGuard.isActive(conv.id)) {
    new Notice("This conversation is being processed in another panel.");
    return;
}

// Register globally before creating session
this.globalSessionGuard.register(conv.id);
```

In session cleanup finally blocks (already shown in Section 5.2):

```typescript
this.globalSessionGuard.unregister(session.conversationId);
```

---

## 8. Architectural Improvements (Medium-Term)

These are not required for the immediate bug fixes but would make the multi-conversation system significantly more robust.

### 8.1 Decompose Orchestrator into Focused Classes

The `ChatOrchestrator` ([`orchestrator.ts:63`](../../src/chat/orchestrator.ts)) is ~2,976 lines with 7 distinct responsibilities and 16+ mutable fields. Decompose behind the existing facade:

| New Class | Responsibility | Extracted Methods | Extracted Fields |
|-----------|---------------|-------------------|-----------------|
| `ConversationLifecycleManager` | Create, switch, fork, load conversations | `newConversation()` (L467-513), `switchConversation()` (L560-675), `forkConversation()` (L525-552), `switchToConversationById()` (L677-700) | `conversationManager` (L64), `workflowPreviousPersona` (L90) |
| `SessionManager` | Session creation, registry, cleanup, global guard | Session setup from `handleUserMessage()` (L1729-1804), `executeWorkflow()` (L860-924), `destroy()` (L434-454) | `activeSessions` (L148), `sessionChangeCallbacks` (L156) |
| `ViewRouter` | Route renders to correct panel, manage view binding | `setView()` (L196-198), `getViewForSession()` (L402-405), `renderMessage()`, `updateDisplayConfig()` (L1575-1579) | `view` (L165), `effectiveToolConfig` (L107), `activeParsedConfigs` (L99) |
| `ConfigResolver` | Resolve effective tool config per iteration | `resolveEffectiveConfig()` (L1508-1567) | None — already pure (returns result, no mutations) |

The `ChatOrchestrator` becomes a thin facade delegating to these classes. The `responseLoop()` (L1855-2210) stays on the orchestrator (it coordinates across all managers) but reads state through the focused classes.

**Extraction boundaries based on current field access patterns:**

- `ViewRouter` reads: `this.view`, `this.conversationManager.getActiveConversation()?.id` (for `getViewForSession`). No cross-dependency with `SessionManager`.
- `SessionManager` reads: `this.historyManager` (for flush), `this.panelApprovalCallback` (for session creation). Notifies `ViewRouter` via callback when sessions change.
- `ConversationLifecycleManager` reads: `this.conversationManager`, `this.historyManager`, `this.view` (for render). Checks `SessionManager.hasActiveSession()` for sync-back. This is the most coupled — it reads from all other managers.

**Benefit:** Each class is independently testable. View routing bugs are isolated to `ViewRouter`. Session lifecycle bugs are isolated to `SessionManager`. The wiring in `main.ts` becomes clearer because each callback maps to a specific manager.

**Implementation approach:** Incremental extraction — move one responsibility at a time, keeping the `ChatOrchestrator` facade's public API stable. Start with `ViewRouter` (most relevant to Bug A) and `SessionManager` (most relevant to Bugs B and D). `ConfigResolver` is already effectively pure — just needs to be moved to its own file.

### 8.2 Centralized State with Change Notifications

Replace ad-hoc callback sync with a lightweight observable state pattern per orchestrator:

```typescript
interface OrchestratorState {
    displayedConversation: Conversation | null;
    messages: Message[];
    isResponding: boolean;
    activeSessions: Map<string, ConversationSession>;
    effectiveConfig: EffectiveToolConfig | null;
    parsedConfigs: ParsedToolConfig[];
}

class StateStore {
    private state: OrchestratorState;
    private subscribers = new Set<(state: OrchestratorState) => void>();

    update(patch: Partial<OrchestratorState>): void {
        this.state = { ...this.state, ...patch };
        for (const sub of this.subscribers) sub(this.state);
    }

    subscribe(fn: (state: OrchestratorState) => void): () => void {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }
}
```

**Benefit:** Single source of truth per orchestrator. All state mutations go through `update()`, making them traceable. Subscribers (view rendering, activity indicator, inspector) are registered once and automatically updated. Eliminates the need for per-callback `getViewForSession()` guards — the view subscribes to state changes and re-renders when the displayed conversation changes.

**This is the largest change** and should be deferred until the immediate bugs are fixed. The class decomposition (8.1) is a prerequisite — it's much easier to introduce a state store into focused classes than into a 3,000-line monolith.

### 8.3 Persistence with Acknowledgment

Replace fire-and-forget persistence with an acknowledged write pattern:

```typescript
// Instead of:
void this.onMessageAdded?.(message);

// Use:
const writePromise = this.onMessageAdded?.(message);
this.pendingWrites.push(writePromise);
```

With a drain method:

```typescript
async drainPendingWrites(): Promise<void> {
    await Promise.allSettled(this.pendingWrites);
    this.pendingWrites = [];
}
```

**Benefit:** The ConversationManager itself tracks whether its persistence callbacks have completed. Session cleanup can call `convManager.drainPendingWrites()` instead of relying on `historyManager.flush()` (which flushes ALL writes across all conversations, not just this session's).

**Simpler alternative (recommended for now):** Keep fire-and-forget in `addMessage()` but add `historyManager.flush()` calls at cleanup boundaries (Section 5). The acknowledged pattern is cleaner but requires changing the callback signature from `void | Promise<void>` to `Promise<void>` and propagating that through all callers.

---

## 9. Files to Modify

### Immediate Fixes (Bugs A–D)

| File | Changes | Bug |
|------|---------|-----|
| [`src/main.ts`](../../src/main.ts) | Split `wireView()` into `wireViewCallbacks()` + `finalizeViewWiring(view, orch?, savedState?)`, update `registerView` factory (Phase 1 + microtask fallback), update `wireViewAsSecondary()` (remove re-wiring loop), create `GlobalSessionGuard` instance, pass as constructor param, add `removeSecondaryOrchestrator()` helper | A, D |
| [`src/ui/chat-view.ts`](../../src/ui/chat-view.ts) | Add `isWiringFinalized` flag, add `_unregisterSessionsChanged` field, add `onCloseCleanup` callback field, update `setState()` to pass state to `finalizeViewWiring()` and **remove** deferred `setTimeout` conversation loading (L740-752), update `onClose()` to call cleanup callback | A |
| [`src/chat/history.ts`](../../src/chat/history.ts) | Add `flush()` method (global), add `flushFile(conversationId)` method (per-file), extract `getConversationFilePath()` helper | B |
| [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts) | Add `globalSessionGuard` as required constructor parameter, await `flushFile()` in session cleanup finally blocks, unregister from guard in cleanup + `destroy()`, improve `destroy()` with flush + guard cleanup, add sync-back delta check | B, C, D |

### Medium-Term (Section 8)

| File | Changes |
|------|---------|
| `src/chat/view-router.ts` | **NEW** — Extract view routing from orchestrator |
| `src/chat/session-manager.ts` | **NEW** — Extract session lifecycle from orchestrator |
| `src/chat/conversation-lifecycle.ts` | **NEW** — Extract conversation CRUD from orchestrator |
| `src/chat/orchestrator.ts` | Thin facade delegating to focused classes |

---

## 10. Implementation Order

```
Phase A: Immediate bug fixes (Sections 4–7)
  ├── A1: Two-phase view wiring (Section 4) ← fixes Bug A
  ├── A2: Persistence flush (Section 5)     ← fixes Bug B
  ├── A3: Sync-back delta check (Section 6) ← fixes Bug C
  └── A4: Global session guard (Section 7)  ← fixes Bug D

Phase B: Orchestrator decomposition (Section 8.1)
  ├── B1: Extract ViewRouter
  ├── B2: Extract SessionManager
  ├── B3: Extract ConversationLifecycleManager
  └── B4: Extract ConfigResolver

Phase C: Centralized state (Section 8.2) — optional, depends on B
```

Phase A items are independent and can be implemented in any order. A1 is highest priority as it directly addresses the reported bug.

Phase B is incremental — each extraction is a standalone refactor that doesn't change behavior.

Phase C depends on B and is optional — evaluate after B whether the complexity justifies the investment.

---

## 11. Verification

### Bug A (Two-Phase Wiring)
1. Open primary panel with active conversation A
2. Open secondary panel → close it → Cmd+Shift+T to reopen
3. **Verify:** Primary panel still shows conversation A with full message history
4. **Verify:** Secondary panel loads independently (empty or restored from state)
5. **Verify:** No duplicate `onSessionsChanged` listeners (check via debug logging)

### Bug B (Persistence Flush)
1. Send several messages rapidly in a conversation
2. Close plugin immediately (or kill Obsidian process)
3. Reopen → load conversation from history
4. **Verify:** All messages present in JSONL
5. Start a streaming response → wait for completion → immediately close plugin
6. Reopen → **Verify:** Complete response in JSONL

### Bug C (Sync-Back Delta)
1. Start a streaming response that produces tool calls (multi-message)
2. Switch to a different conversation
3. Switch back to the streaming conversation
4. **Verify:** All messages rendered, including any that arrived during the switch

### Bug D (Global Session Guard)
1. Open same conversation in primary and secondary panels
2. Send a message in one panel
3. While streaming, try to send a message in the other panel
4. **Verify:** Second panel shows "This conversation is being processed in another panel" notice
5. Wait for first response to complete
6. **Verify:** Can now send from either panel

### Regression
1. All existing E2E tests pass (`e2e/scripts/session-sync-back-test.ts`, `e2e/scripts/phase4-multi-panel-test.ts`, `e2e/scripts/phase5-open-in-new-tab-test.ts`)
2. Normal single-panel chat works (new conversation, send messages, switch conversations)
3. Workflow execution works (foreground + background)
4. Plugin hot-reload preserves state
