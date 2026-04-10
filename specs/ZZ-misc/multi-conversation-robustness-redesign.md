# Multi-Conversation Robustness Redesign

**Status:** Draft (v2.1 — unified view model + architecture review amendments)
**Date:** 2026-04-10
**Prerequisite:** [thread-safe-streaming-multi-panel-design.md](done/thread-safe-streaming-multi-panel-design.md) (all 5 phases implemented)

---

## 1. Motivation

The thread-safe streaming and multi-panel design (Phases 1–5) has been fully implemented. The `ConversationSession` isolation model, per-orchestrator provider/model fields, and `getViewForSession()` rendering guards are all in place and working correctly for the core conversation loop.

However, post-implementation edge cases reveal that the **orchestrator ↔ view wiring layer** and **persistence lifecycle** have structural weaknesses that cause intermittent chat history loss. The user reports:

> Had a weird situation arise where the chat history apparently got dropped while continuously just chatting in a single thread. I don't recall changing into another conversation (though I did happen to have a secondary Notor chat panel opened elsewhere, though was not interacting with it at all when this arose). Also, when I ran Cmd + Shift + T to re-open the secondary Notor Chat Panel that I had just then closed, most of the chat history in the primary Notor chat panel (where I was in the middle of an active chat with Notor) flatly disappeared on me. Re-opening the conversation from the Conversation history tab seemed to solve these.

Investigation reveals that the root cause is the **primary/secondary orchestrator distinction** — the factory must guess which orchestrator to bind a view to before Obsidian's `setState()` fires, then re-wire after the fact. This spec **eliminates that distinction entirely** in favor of a unified view model where every panel gets its own orchestrator from creation. It also addresses fire-and-forget persistence and cross-panel session conflicts.

### Key Architecture Reference

The multi-panel system is built on these classes (all implemented per the original spec):

- **`ChatOrchestrator`** ([`orchestrator.ts:63`](../../src/chat/orchestrator.ts)) — ~2,976 lines, manages conversations, sessions, and LLM interactions. Each panel gets its own instance. Key mutable fields: `conversationManager` (L64, display state), `activeSessions` (L148, `Map<string, ConversationSession>`), `view` (L165, single view pointer), `activeProviderType`/`activeModelId`/`activeUseExtendedContext` (L119/L130/L137, per-orchestrator state).
- **`ConversationSession`** ([`conversation-session.ts:41`](../../src/chat/conversation-session.ts)) — 110 lines, isolates all per-conversation state: own `ConversationManager` (L43), pinned persona/provider/model (L53-57), approval callback (L60), abort controller (L44). Created in `handleUserMessage()` at [`orchestrator.ts:1788-1801`](../../src/chat/orchestrator.ts) and `executeWorkflow()` at [`orchestrator.ts:908-921`](../../src/chat/orchestrator.ts).
- **`ConversationManager`** ([`conversation.ts`](../../src/chat/conversation.ts)) — Tracks `activeConversation` (L34) and `messages[]` (L37). Fire-and-forget persistence callbacks: `onMessageAdded` (L369) and `onConversationChanged` (L370/L130/L156).
- **`HistoryManager`** ([`history.ts:86`](../../src/chat/history.ts)) — JSONL persistence with per-file write queues (`writeQueues` Map at L93, serialized via `enqueueWrite()` at L127-138). No `flush()` method exists.
- **`NotorChatView`** ([`chat-view.ts`](../../src/ui/chat-view.ts)) — ~2,953 lines, 27+ callback properties (L240-392). `isSecondary` flag at L171 (default `false`). `getState()`/`setState()` at L711-753 for workspace restore.
- **`wireView()`** ([`main.ts:1995-2537`](../../src/main.ts)) — 542 lines, binds orchestrator ↔ view. Called from `registerView` factory (L295-308) and `wireViewAsSecondary` (L1697-1716).

### Current Primary/Secondary Model (Being Replaced)

The current multi-panel implementation distinguishes between a "primary" orchestrator (singleton, created eagerly in `getOrchestrator()` at [`main.ts:1585-1627`](../../src/main.ts)) and "secondary" orchestrators (created on-demand, tracked in `_secondaryOrchestrators[]` at [`main.ts:155`](../../src/main.ts)). Secondary orchestrators are **functionally identical** to the primary — `createSecondaryOrchestrator()` at [`main.ts:1640-1687`](../../src/main.ts) constructs the same `ChatOrchestrator` class with the same shared singletons. The only difference is lifecycle tracking and the `isSecondary` flag on the view.

This distinction is the source of the bugs described below.

---

## 2. Bug Analysis

### Bug A: Panel History Vanishes on Secondary Panel Restore

**Severity:** High — active conversation state destroyed
**Trigger:** Cmd+Shift+T reopens a closed secondary panel
**Fix:** Section 4 (Unified View Model) — eliminated structurally

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
**Fix:** Section 5 (Persistence Flush)

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
**Fix:** None required (see analysis below — the race window cannot occur in practice)

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

This appears to be a narrow race window. However, the snapshot at L578 and the render loop at L586-589 are in the same synchronous execution block with no `await` between them. Microtasks cannot interrupt synchronous JavaScript execution. Therefore, no messages can arrive between the snapshot and the render — the race window is theoretical, not practical. No fix is needed.

### Bug D: Cross-Orchestrator Same-Conversation Conflict

**Severity:** Medium — potential JSONL corruption and state divergence
**Trigger:** Two panels send messages to the same conversation simultaneously
**Fix:** Section 6 (Registry-Based Session Guard)

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

These are not bugs per se, but architectural properties that make bugs like the above easy to create and hard to prevent. All five weaknesses trace back to the primary/secondary orchestrator distinction. The unified view model (Section 4) eliminates W1, W3, W4, and W5 structurally, and Section 5 addresses W2.

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

## 4. Design: Unified View Model

**Goal:** Eliminate the primary/secondary orchestrator distinction. Every chat panel gets its own orchestrator from creation — no guessing, no re-wiring, no re-wiring loop.

### 4.1 Architectural Change

Replace the current model:

```
Plugin
  ├── _orchestrator (primary singleton)        ◄── special, lives forever
  ├── _secondaryOrchestrators[]                ◄── separate tracking
  └── isSecondary flag on each view            ◄── conditional logic everywhere
```

With a unified model:

```
Plugin
  └── _orchestrators: Map<leafId, ChatOrchestrator>    ◄── one per view, all equal
```

Every view gets its own orchestrator when the `registerView` factory creates it. No orchestrator is "primary" or "secondary" — they are all identical instances sharing the same infrastructure singletons (`HistoryManager`, `ProviderRegistry`, `ToolDispatcher`, etc.).

### 4.2 Orchestrator Registry

Replace `_orchestrator` ([`main.ts:145`](../../src/main.ts)) and `_secondaryOrchestrators` ([`main.ts:155`](../../src/main.ts)) with a single registry:

```typescript
/**
 * One orchestrator per open chat panel, keyed by leaf ID.
 * All orchestrators are equal — no primary/secondary distinction.
 * Created in registerView factory, removed in onClose cleanup.
 */
private _orchestrators = new Map<string, ChatOrchestrator>();
```

### 4.3 Updated `registerView` Factory

The factory creates an orchestrator per view and wires everything **except** conversation loading (which must wait for `setState()` to know which conversation to restore):

```typescript
this.registerView(CHAT_VIEW_TYPE, (leaf) => {
    const view = new NotorChatView(leaf, this);

    // Create this view's own orchestrator — always correct, no guessing
    const orchestrator = this.createOrchestrator();
    this._orchestrators.set(leaf.id, orchestrator);

    // Wire orchestrator ↔ view + all callbacks (safe — correct orch from the start)
    this.wireView(view, orchestrator);
    // wireView NO LONGER loads conversation history (moved to loadConversation below)

    // Deferred conversation loading — setState() wins if it fires, otherwise
    // the fallback loads the most-recent conversation.
    // setTimeout (not queueMicrotask) because setState() is async — its
    // continuation is scheduled as a microtask after `await super.setState()`.
    // A queueMicrotask would fire BEFORE setState completes, losing saved state.
    setTimeout(() => {
        if (!view.isConversationLoaded) {
            // setState didn't fire (brand-new install, no saved workspace)
            this.loadConversation(view, orchestrator);
        }
    }, 0);

    return view;
});
```

**Why `setTimeout` and not `queueMicrotask`:** `setState()` is an `async` method that hits `await super.setState(state, result)` on its first line ([`chat-view.ts:728`](../../src/ui/chat-view.ts)). Even if `super.setState()` resolves immediately, the `await` schedules the continuation as a microtask. A `queueMicrotask` registered in the factory would fire BEFORE setState's continuation (microtask queue is FIFO — factory's microtask was queued first). `setTimeout(fn, 0)` schedules a macrotask, which runs after all microtasks drain, guaranteeing setState wins the race when it fires.

**Note (Amendment R2):** The `setTimeout(0)` ordering is an **optimization** (avoids an unnecessary most-recent load when setState fires), not a **correctness requirement**. If Obsidian defers setState to a later macrotask, the fallback fires first but setState overrides it. `loadConversation()` uses an AbortController to cancel the fallback's in-flight async chain, preventing races. See Section 4.4 and 4.5.

### 4.4 Updated `setState()`

`setState()` no longer detects secondary panels or re-wires orchestrators. It only loads the correct conversation:

```typescript
async setState(state: unknown, result: ViewStateResult): Promise<void> {
    await super.setState(state, result);
    const s = state as Record<string, unknown> | null;
    const savedConversationId = (s?.conversationId ?? s?.conversationFilename) as string | undefined;

    // Load the saved conversation. The orchestrator was already correctly
    // bound in the registerView factory — no re-wiring needed.
    //
    // Amendment A5 + R2: If the setTimeout fallback already loaded
    // (isConversationLoaded === true), but we have a saved conversation to
    // restore, override it. loadConversation() uses an AbortController to
    // cancel any in-flight fallback load, preventing races.
    if (!this.isConversationLoaded || savedConversationId) {
        this.isConversationLoaded = true;
        const orchestrator = this.plugin.getOrchestratorForView(this);
        if (orchestrator) {
            this.plugin.loadConversation(this, orchestrator, s);
        }
    }
}
```

Add to `NotorChatView`:
- `isConversationLoaded: boolean = false` — set by both `setState()` and the `setTimeout` fallback
- `_loadConversationAbort?: AbortController` — used by `loadConversation()` to cancel superseded loads (Amendment R2)

The `isConversationLoaded` flag is an optimization, not a correctness requirement. `setTimeout(0)` ensures `setState()` wins the race in the common case (avoids an unnecessary most-recent load). The AbortController ensures correctness if Obsidian defers `setState()` to a later macrotask — the fallback's in-flight async chain is cancelled before the override starts.

**Important:** The deferred `setTimeout` blocks at [`chat-view.ts:740-752`](../../src/ui/chat-view.ts) that called `onSwitchConversation` and `onSwitchToConversationById` must be **removed**. The new `loadConversation()` method is the single owner of all conversation loading, preventing double-load races.

### 4.5 `loadConversation()` Method

New method on the plugin class — the **single owner of all conversation loading** for all panels:

```typescript
/**
 * Load a conversation into a panel. Determines which conversation to load
 * from savedState (workspace restore) or falls back to most-recent.
 *
 * Called from setState() (workspace restore) and the setTimeout fallback
 * (fresh install). This is the ONLY place conversation loading happens.
 */
loadConversation(
    view: NotorChatView,
    orchestrator: ChatOrchestrator,
    savedState?: Record<string, unknown> | null,
): void {
    // Abort any in-flight load for this view (Amendment R2).
    // This prevents races when setState() overrides the setTimeout fallback
    // (Amendment A5) — the fallback's async chain is cancelled before the
    // override's chain starts.
    view._loadConversationAbort?.abort();
    const controller = new AbortController();
    view._loadConversationAbort = controller;

    view.isConversationLoaded = true;
    const historyManager = this.getHistoryManager();

    historyManager.listConversations().then((entries) => {
        if (controller.signal.aborted) return;  // superseded by a later load
        view.renderConversationList(entries);

        const savedFilename = savedState?.conversationFilename as string | undefined;
        const savedId = savedState?.conversationId as string | undefined;

        if (savedFilename) {
            // "Open in new tab" passes a filename — load it directly
            orchestrator.switchConversation(savedFilename)
                .then(() => { if (!controller.signal.aborted) this.syncViewAfterLoad(view, orchestrator); })
                .catch(() => orchestrator.newConversation());
        } else if (savedId) {
            // Workspace restore passes a conversation ID — resolve and load
            orchestrator.switchToConversationById(savedId)
                .then(() => { if (!controller.signal.aborted) this.syncViewAfterLoad(view, orchestrator); })
                .catch(() => {
                    if (controller.signal.aborted) return;
                    // Conversation may have been deleted — fall back to most recent
                    if (entries.length > 0) {
                        orchestrator.switchConversation(entries[0].filename)
                            .then(() => { if (!controller.signal.aborted) this.syncViewAfterLoad(view, orchestrator); })
                            .catch(() => orchestrator.newConversation());
                    } else {
                        orchestrator.newConversation();
                    }
                });
        } else if (entries.length === 0) {
            orchestrator.newConversation()
                .then(() => { if (!controller.signal.aborted) this.syncViewAfterLoad(view, orchestrator); });
        } else {
            // No saved state — load most recent
            orchestrator.switchConversation(entries[0].filename)
                .then(() => { if (!controller.signal.aborted) this.syncViewAfterLoad(view, orchestrator); })
                .catch(() => orchestrator.newConversation());
        }
    }).catch((e) => {
        log.error("Failed to load conversation history", { error: String(e) });
        orchestrator.newConversation().catch(() => {});
    });
}

/**
 * Sync view state after conversation load (Amendment R7: checkpoint manager
 * removed per Amendment A1 — orchestrator manages its own CheckpointManager).
 */
private syncViewAfterLoad(
    view: NotorChatView,
    orchestrator: ChatOrchestrator,
): void {
    const conv = orchestrator.getConversationManager().getActiveConversation();
    if (conv) {
        view.setActiveConversationId(conv.id);
    }
}
```

### 4.6 Simplified `wireView()`

`wireView()` is simplified: it **always** receives the correct orchestrator (created in the factory) and **no longer loads conversation history**. The conversation loading concern is fully extracted to `loadConversation()`.

Changes to the existing `wireView()` at [`main.ts:1995-2537`](../../src/main.ts):

1. **Remove the orchestrator default fallback** (L1996-1998) — orchestrator is now always passed explicitly.
2. **Keep** all 27+ `setOn*` callback wiring (L2031-2491) — unchanged.
3. **Keep** `orchestrator.setView(view)` (L2006) — safe now because the orchestrator is always correct.
4. **Keep** `onSessionsChanged` listener registration (L2017) — but store the unregister function (see Section 4.7).
5. **Remove** the entire history loading block (L2493-2536) — moved to `loadConversation()`.
6. **Remove** the `if (view.getIsSecondary()) return` guard (L2495) — no longer needed.
7. **Remove** `setGetToolDefinitions()` call — moved to `createOrchestrator()` (Amendment R3).
8. **Remove** `personaManager.restoreFromSettings()` call (L2061-2068) — moved to `onload()` (Amendment R5).

**Amendment R1 — Closure audit:** All callback closures in `wireView()` that reference `this._orchestrator`, `this.getOrchestrator()`, or `this._secondaryOrchestrators` must be changed to use either the closure-captured `orchestrator` parameter (for single-panel operations) or `this._orchestrators.values()` (for broadcast operations like settings propagation). Known instances:
- `setOnNewConversation` (L2128-2129): `this._orchestrator.updateSettings()` → `orchestrator.updateSettings()`
- `_personaNameChangeWired` callback (L2043-2059): `[this._orchestrator, ...this._secondaryOrchestrators]` → `this._orchestrators.values()` (Amendment R6)

### 4.7 Session-Change Listener Cleanup

Since `wireView()` is now called exactly once per view (at creation in the factory), listener accumulation (W3) cannot occur. However, for defense-in-depth and to support the close lifecycle, store the unregister function:

```typescript
// In wireView():
view._unregisterSessionsChanged?.();
view._unregisterSessionsChanged = orchestrator.onSessionsChanged(
    () => view.updateActivityIndicator()
);
```

Add `_unregisterSessionsChanged?: () => void` to `NotorChatView`.

### 4.8 Eliminated Code

The following code is **deleted** (not refactored — removed entirely):

| Code | Location | Why |
|------|----------|-----|
| `_orchestrator` field | [`main.ts:145`](../../src/main.ts) | Replaced by `_orchestrators` Map |
| `_secondaryOrchestrators` field | [`main.ts:155`](../../src/main.ts) | Replaced by `_orchestrators` Map |
| `getOrchestrator()` method | [`main.ts:1585-1627`](../../src/main.ts) | Replaced by `getActiveOrchestrator()` and `getOrchestratorForView()` |
| `createSecondaryOrchestrator()` method | [`main.ts:1640-1687`](../../src/main.ts) | Replaced by `createOrchestrator()` (identical body, no "secondary" concept) |
| `wireViewAsSecondary()` method | [`main.ts:1697-1716`](../../src/main.ts) | Eliminated — no re-wiring needed |
| `getPrimaryChatLeaf()` method | [`main.ts:2576-2583`](../../src/main.ts) | Replaced by `getActiveChatLeaf()` (returns focused panel) |
| `isSecondary` field | [`chat-view.ts:171`](../../src/ui/chat-view.ts) | Eliminated — all panels are equal |
| `getIsSecondary()` / `setIsSecondary()` | [`chat-view.ts:756-763`](../../src/ui/chat-view.ts) | Eliminated |
| `isSecondary` detection in `setState()` | [`chat-view.ts:731-735`](../../src/ui/chat-view.ts) | Eliminated — setState only loads conversation |
| `isSecondary` guard in `wireView()` | [`main.ts:2495`](../../src/main.ts) | Eliminated — history loading moved out entirely |
| `_personaNameChangeWired` guard | [`main.ts:158`](../../src/main.ts) | Still needed but callback body iterates `_orchestrators.values()` (Amendment R6) |
| "open-secondary-chat" command `state: { isSecondary: true }` | [`main.ts:534`](../../src/main.ts) | Simplified — just opens a new leaf (no special state needed) |
| `isSecondary` in `getState()` | [`chat-view.ts:714`](../../src/ui/chat-view.ts) | Removed from saved state |
| `setGetToolDefinitions()` in `wireView()` | [`main.ts:2078-2084`](../../src/main.ts) | Moved to `createOrchestrator()` (Amendment R3) |
| `personaManager.restoreFromSettings()` in `wireView()` | [`main.ts:2061-2068`](../../src/main.ts) | Moved to `onload()` — one-time global restore (Amendment R5) |

### 4.9 `getActiveOrchestrator()` — Command Routing

Commands that previously targeted `getOrchestrator()` (the primary singleton) now route to the focused panel:

```typescript
/**
 * Return the orchestrator for the currently focused chat panel,
 * or any open panel if none is focused, or null if no panels exist.
 */
getActiveOrchestrator(): ChatOrchestrator | null {
    // Prefer the focused chat panel
    const activeView = this.app.workspace.getActiveViewOfType(NotorChatView);
    if (activeView) {
        return this._orchestrators.get(activeView.leaf.id) ?? null;
    }
    // Fall back to any open chat panel
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (leaves.length > 0) {
        return this._orchestrators.get(leaves[0].id) ?? null;
    }
    return null;
}

/** Return the orchestrator for a specific view (used by setState). */
getOrchestratorForView(view: NotorChatView): ChatOrchestrator | null {
    return this._orchestrators.get(view.leaf.id) ?? null;
}
```

This is better UX — workflows, exports, and compaction affect the panel the user is looking at, not a hardcoded "primary" one.

**Call sites to update** (all currently call `this.getOrchestrator()`):

| Call Site | Line | What It Does | Update |
|-----------|------|-------------|--------|
| Inspector view | L313 | Sets orchestrator for tool config inspector | Use `getActiveOrchestrator()` or subscribe to focus changes |
| Manual compaction command | L335 | Triggers compaction | `getActiveOrchestrator()?.manualCompaction()` |
| Run workflow command | L368 | Executes workflow from command palette | `getActiveOrchestrator()?.executeWorkflow(workflow)` |
| Active note workflow command | L424 | Executes active-note workflow | `getActiveOrchestrator()?.executeWorkflow(workflow, resolvedPrompt)` |
| Export conversation | L451 | Exports active conversation | `getActiveOrchestrator()?.getConversationManager()` |
| Import conversation | L499 | Loads imported conversation | `getActiveOrchestrator()?.switchConversation(filename)` |
| UseSubAgentTool accessors | L1429-1431 | Gets effective config + active conversation | `getActiveOrchestrator()?.getEffectiveToolConfig()` |
| Vault event dispatcher | L974 | Runs background workflows from vault events | See Section 4.10 |
| Settings update | L1218-1219 | Propagates settings changes | Iterate `_orchestrators.values()` |
| New conversation command | L2612-2615 | Creates new conversation in primary | `getActiveOrchestrator()?.newConversation()` |

### 4.10 Background Vault-Event Workflows

The vault event dispatcher at [`main.ts:974`](../../src/main.ts) currently references `this.getOrchestrator()` to execute background workflows triggered by file changes. With the unified model, there may be no focused panel when a vault event fires.

**Solution:** Use a lazy accessor that returns any available orchestrator:

```typescript
// In vault event dispatcher deps:
orchestrator: (() => {
    // Prefer focused panel, fall back to any open panel
    const orch = this.getActiveOrchestrator();
    if (orch) return orch;
    // No panels open — open one first
    // (vault-event workflows are user-configured, so opening a panel is expected)
    return null; // Dispatcher should skip execution if null
})(),
```

The vault event dispatcher already handles the "no orchestrator" case gracefully — if the orchestrator is null, the workflow is skipped and a warning is logged. This is acceptable because vault-event workflows require user interaction (configuring the workflow file) and a chat panel to show results.

**Alternative (deferred):** Create a headless orchestrator pool for background work that doesn't need a view. This is a larger refactor best done in Phase B (orchestrator decomposition) when session management is extracted from the view-bound orchestrator.

### 4.11 `setView()` Type Update

`setView()` at [`orchestrator.ts:196-198`](../../src/chat/orchestrator.ts) must accept `undefined` for the close lifecycle (Section 7):

```typescript
setView(view: NotorChatView | undefined): void {
    this.view = view;
}
```

### 4.12 Settings Propagation Fix

Settings updates at [`main.ts:1218-1219`](../../src/main.ts) currently only update the primary orchestrator. This is a **pre-existing bug** — secondary orchestrators don't receive settings updates. Fix by iterating all orchestrators:

```typescript
for (const orch of this._orchestrators.values()) {
    orch.updateSettings(this.settings);
}
```

### 4.13 Updated `getState()` / Workspace Restore

`getState()` at [`chat-view.ts:711-716`](../../src/ui/chat-view.ts) no longer saves `isSecondary`:

```typescript
getState(): Record<string, unknown> {
    return {
        conversationId: this.activeConversationId,
        // isSecondary removed — all panels are equal
    };
}
```

On workspace restore, Obsidian recreates each leaf and calls `setState()` with the saved state. Each recreated view gets its own orchestrator from the factory, then `setState()` loads the saved `conversationId`. No special handling needed.

The "Open in new tab" command at [`main.ts:2213-2222`](../../src/main.ts) still passes `conversationFilename` via `setViewState()` state — this is handled by `loadConversation()` (Section 4.5).

---

## 5. Design: Persistence Flush

**Goal:** Ensure all JSONL writes complete before session cleanup and plugin unload.

### 5.1 `HistoryManager.flush()` and `flushConversation()`

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
 * @param conversation - The conversation whose JSONL writes to drain.
 *   The conversation object is required (not just the ID) because the
 *   filename encodes both `created_at` and `id`. The writeQueues Map is
 *   keyed by file path, so we need the full conversation to resolve the path.
 */
async flushConversation(conversation: Conversation): Promise<void> {
    const filename = this.getFilename(conversation);
    const filePath = this.getFilePath(filename);
    const pending = this.writeQueues.get(filePath);
    if (pending) {
        await pending;
    }
}
```

**Note on API design:** The earlier draft proposed `flushFile(conversationId: string)`, but the filename is derived from both `created_at` and `id` ([`history.ts:783-791`](../../src/chat/history.ts)). A conversation ID alone cannot resolve to a file path. The session cleanup has access to the full `Conversation` object via `session.conversationManager.getActiveConversation()`, so accepting the full object is natural.

### 5.2 Flush Before Session Deletion

In session cleanup finally blocks ([`orchestrator.ts:1828-1835`](../../src/chat/orchestrator.ts) for `handleUserMessage`, and the equivalent block in `executeWorkflow` at [`orchestrator.ts:942-953`](../../src/chat/orchestrator.ts)):

```typescript
finally {
    if (session.status === "running" || session.status === "waiting_approval") {
        session.setStatus("completed");
    }
    // Drain pending JSONL writes for THIS conversation before removing the session.
    // The sync-back path in switchConversation() checks activeSessions to decide
    // whether to use session state or JSONL — if we delete the session before writes
    // flush, sync-back falls through to JSONL which may be incomplete.
    try {
        const conv = session.conversationManager.getActiveConversation();
        if (conv) {
            await this.historyManager.flushConversation(conv);
        }
    } catch {
        // Best-effort — don't block session cleanup on write errors
    }
    // Deactivate workflow hook overrides (if this was a workflow session)
    if (session.workflowAssembly && this.workflowHookOverrideManager) {
        this.workflowHookOverrideManager.deactivate(session.conversationId);
    }
    this.sessionGuard.unregister(session.conversationId);
    this.activeSessions.delete(session.conversationId);
    this.notifySessionsChanged();
    this.getViewForSession(session)?.setRespondingState(false);
}
```

**Note:** Workflow hook deactivation (`workflowHookOverrideManager.deactivate()`) is included here because `destroy()` may win the timeout race against the finally block, leaving hook overrides active. Having it in both the finally block and `destroy()` (see below) ensures cleanup regardless of which path runs.

### 5.3 Flush in `destroy()`

Extend [`orchestrator.ts:434-454`](../../src/chat/orchestrator.ts):

```typescript
async destroy(timeoutMs: number = 2000): Promise<void> {
    // ... existing session abort + await logic ...

    // Deactivate workflow hook overrides for all active sessions.
    // This runs regardless of whether the finally blocks completed
    // (destroy may have won the timeout race).
    // NOTE (Amendment R4): deactivate() must be idempotent — it may be
    // called here AND from the session cleanup finally block (Section 5.2)
    // for the same conversation ID if the finally block runs before destroy.
    for (const session of this.activeSessions.values()) {
        if (session.workflowAssembly && this.workflowHookOverrideManager) {
            this.workflowHookOverrideManager.deactivate(session.conversationId);
        }
    }

    // Flush any writes that may have been enqueued in finally blocks.
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
        this.sessionGuard.unregister(id);
    }

    this.activeSessions.clear();
    this.sessionChangeCallbacks.clear();
    log.info("Orchestrator destroyed", { abortedSessions: sessionPromises.length });
}
```

---

## 6. Design: Registry-Based Session Guard

**Goal:** Prevent two orchestrators from creating sessions for the same conversation.

### 6.1 The Guard IS the Registry

With the unified model, the plugin already tracks all orchestrators in `_orchestrators`. The session guard is a simple `Set<string>` on the plugin, exposed to orchestrators as an interface:

```typescript
// In plugin class:

/**
 * Global set of conversation IDs with active sessions across ALL orchestrators.
 * Prevents two panels from creating sessions for the same conversation,
 * which would cause divergent in-memory state and interleaved JSONL writes.
 */
private _activeConversationSessions = new Set<string>();

private _sessionGuard: SessionGuard = {
    isActive: (id) => this._activeConversationSessions.has(id),
    register: (id) => { this._activeConversationSessions.add(id); },
    unregister: (id) => { this._activeConversationSessions.delete(id); },
};
```

### 6.2 Guard Interface

```typescript
interface SessionGuard {
    isActive(conversationId: string): boolean;
    register(conversationId: string): void;
    unregister(conversationId: string): void;
}
```

Passed to each orchestrator via `createOrchestrator()`. Making it a required constructor parameter ensures it cannot be accidentally omitted:

```typescript
// In ChatOrchestrator constructor:
constructor(
    private readonly app: App,
    private readonly providerRegistry: ProviderRegistry,
    private readonly systemPromptBuilder: SystemPromptBuilder,
    private readonly dispatcher: ToolDispatcher,
    private readonly historyManager: HistoryManager,
    private settings: NotorSettings,
    private readonly sessionGuard: SessionGuard,    // NEW — required, before optional params
    private view?: NotorChatView,
    private readonly vaultRuleManager?: VaultRuleManager
) { /* ... */ }
```

**Note:** The guard is placed before the optional `view` and `vaultRuleManager` parameters to satisfy TypeScript's requirement that required parameters precede optional ones.

### 6.3 Check Before Session Creation

In `handleUserMessage()` and `executeWorkflow()`, before creating a session:

```typescript
// Existing per-orchestrator guard
if (this.activeSessions.has(conv.id)) {
    new Notice("This conversation is already processing");
    return;
}

// Cross-orchestrator guard
if (this.sessionGuard.isActive(conv.id)) {
    new Notice("This conversation is being processed in another panel.");
    return;
}

// Register globally before creating session
this.sessionGuard.register(conv.id);
```

### 6.4 Unregister on Session Cleanup

In session cleanup finally blocks (shown in Section 5.2):

```typescript
this.sessionGuard.unregister(session.conversationId);
this.activeSessions.delete(session.conversationId);
```

In `destroy()` (shown in Section 5.3), unregister all before clearing:

```typescript
for (const id of this.activeSessions.keys()) {
    this.sessionGuard.unregister(id);
}
this.activeSessions.clear();
```

---

## 7. Design: View Close Lifecycle

**Goal:** Handle panel closure gracefully — detach the view, drain sessions, then destroy the orchestrator.

### 7.1 Problem

`onClose()` at [`chat-view.ts:670-697`](../../src/ui/chat-view.ts) performs DOM cleanup but no orchestrator lifecycle management. When a panel is closed mid-session:
1. The orchestrator's `this.view` references a destroyed view — renders hit detached DOM
2. Tool approval callbacks reference destroyed UI — approvals hang forever
3. The orchestrator leaks in `_orchestrators` until plugin unload

### 7.2 Close Cleanup Callback

Wire a `setOnCloseCleanup` callback during `wireView()`:

```typescript
// In wireView():
view.setOnCloseCleanup(() => {
    const leafId = view.leaf.id;

    // 1. Detach view — renders become no-ops via existing this.view?. guards
    orchestrator.setView(undefined);

    // 2. Clean up session-change listener
    view._unregisterSessionsChanged?.();

    // 3. Remove from registry
    this._orchestrators.delete(leafId);

    // 4. Check for active sessions
    const activeSessions = orchestrator.getActiveSessions();

    if (activeSessions.length === 0) {
        // No active sessions — destroy immediately
        orchestrator.destroy();
        return;
    }

    // 5. Active sessions exist — abort them.
    // Closing a panel does NOT imply consent for unreviewed tool execution.
    // Abort is the safe default; the user can re-run if needed.
    orchestrator.destroy();
});
```

In `onClose()` at [`chat-view.ts:670-697`](../../src/ui/chat-view.ts), add at the start:

```typescript
this.onCloseCleanup?.();
```

Add `onCloseCleanup?: () => void` field and `setOnCloseCleanup(cb)` setter to `NotorChatView`.

**Why abort (not auto-approve):** The previous design proposed auto-approving tool calls when a panel closes. This is unsafe — closing a panel does not signal consent for unreviewed file writes, command execution, or other destructive tools. Aborting sessions on close is the safe default. The `destroy()` method already handles abort + await with a 2s timeout and JSONL flush (Section 5.3), so in-flight messages are persisted before cleanup.

### 7.3 Panel Reopen

When a panel reopens (user opens a new chat leaf), the `registerView` factory creates a fresh orchestrator. The `setState()` / `setTimeout` fallback loads the saved conversation from JSONL. Since `destroy()` flushed pending writes (Section 5.3), the JSONL is complete.

If the orchestrator had an active displayed conversation when the panel closed (i.e., the user was viewing Conv_A), that state was in-memory only. On reopen, the conversation is loaded from JSONL, which is the correct behavior — the persistence flush ensures nothing is lost.

---

## 8. Architectural Improvements (Medium-Term)

These are not required for the immediate bug fixes but would make the multi-conversation system significantly more robust. The unified view model makes these easier because each orchestrator is a self-contained unit.

### 8.1 Decompose Orchestrator into Focused Classes

The `ChatOrchestrator` ([`orchestrator.ts:63`](../../src/chat/orchestrator.ts)) is ~2,976 lines with 7 distinct responsibilities and 16+ mutable fields. Decompose behind the existing facade:

| New Class | Responsibility | Extracted Methods | Extracted Fields |
|-----------|---------------|-------------------|-----------------|
| `ConversationLifecycleManager` | Create, switch, fork, load conversations | `newConversation()` (L467-513), `switchConversation()` (L560-675), `forkConversation()` (L525-552), `switchToConversationById()` (L677-700) | `conversationManager` (L64), `workflowPreviousPersona` (L90) |
| `SessionManager` | Session creation, registry, cleanup, session guard | Session setup from `handleUserMessage()` (L1729-1804), `executeWorkflow()` (L860-924), `destroy()` (L434-454) | `activeSessions` (L148), `sessionChangeCallbacks` (L156) |
| `ViewRouter` | Route renders to correct panel, manage view binding | `setView()` (L196-198), `getViewForSession()` (L402-405), `renderMessage()`, `updateDisplayConfig()` (L1575-1579) | `view` (L165), `effectiveToolConfig` (L107), `activeParsedConfigs` (L99) |
| `ConfigResolver` | Resolve effective tool config per iteration | `resolveEffectiveConfig()` (L1508-1567) | None — already pure (returns result, no mutations) |

**Benefit:** Each class is independently testable. The unified view model means there's no "primary orchestrator" special casing to complicate extraction boundaries.

**Implementation approach:** Incremental extraction — move one responsibility at a time, keeping the `ChatOrchestrator` facade's public API stable.

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

**This is the largest change** and should be deferred until the immediate bugs are fixed. The class decomposition (8.1) is a prerequisite.

### 8.3 Headless Orchestrator Pool

For background vault-event workflows (Section 4.10), create orchestrators that don't require a view:

```typescript
class HeadlessOrchestrator extends ChatOrchestrator {
    // No view — all render calls are no-ops (view is undefined)
    // Sessions run to completion; results persisted to JSONL only
}
```

This cleanly separates "user-facing panels" from "background execution" and eliminates the need for the fallback accessor in Section 4.10.

---

## 9. Files to Modify

### Immediate Fixes (Bugs A–D)

| File | Changes | Bug |
|------|---------|-----|
| [`src/main.ts`](../../src/main.ts) | Replace `_orchestrator` + `_secondaryOrchestrators` with `_orchestrators` Map, replace `getOrchestrator()` with `getActiveOrchestrator()` + `getOrchestratorForView()`, replace `createSecondaryOrchestrator()` with `createOrchestrator()`, delete `wireViewAsSecondary()` + `getPrimaryChatLeaf()`, update `registerView` factory (create orch + setTimeout fallback), extract `loadConversation()` from `wireView()`, simplify `wireView()` (remove history loading + isSecondary guard), create `SessionGuard` instance + pass as constructor param, add close cleanup callback in wireView, update `onunload()` to iterate `_orchestrators`, fix settings propagation to iterate all orchestrators, update command routing to `getActiveOrchestrator()`, update persona name change propagation, update vault event dispatcher accessor | A, D |
| [`src/ui/chat-view.ts`](../../src/ui/chat-view.ts) | Add `isConversationLoaded` flag, add `_unregisterSessionsChanged` field, add `onCloseCleanup` callback field + setter, remove `isSecondary` field + `getIsSecondary()` + `setIsSecondary()`, update `setState()` (remove secondary detection + deferred setTimeout loading, add loadConversation call), update `getState()` (remove `isSecondary`), update `onClose()` (call cleanup callback) | A |
| [`src/chat/history.ts`](../../src/chat/history.ts) | Add `flush()` method (global), add `flushConversation(conversation)` method (per-file) | B |
| [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts) | Add `sessionGuard: SessionGuard` as required constructor parameter (before optional params), register/unregister in session creation + cleanup, await `flushConversation()` in session cleanup finally blocks, deactivate workflow hooks in cleanup + `destroy()`, improve `destroy()` with flush + hook cleanup + guard unregister, update `setView()` to accept `undefined` | B, D |

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
Phase A: Unified view model + bug fixes (Sections 4–7)
  ├── A1: Orchestrator registry + factory rewrite (Section 4.1-4.3)
  │       Replace _orchestrator + _secondaryOrchestrators with _orchestrators Map
  │       Update registerView factory to create per-view orchestrator
  │       Add setTimeout fallback for conversation loading
  │
  ├── A2: Conversation loading extraction (Section 4.4-4.5)
  │       Extract loadConversation() from wireView()
  │       Update setState() — remove secondary detection, add loadConversation call
  │       Remove deferred setTimeout loading from setState()
  │       Add isConversationLoaded flag
  │
  ├── A3: wireView simplification (Section 4.6-4.7)
  │       Remove history loading block from wireView()
  │       Remove isSecondary guard from wireView()
  │       Remove wireViewAsSecondary() entirely
  │       Store onSessionsChanged unregister function
  │
  ├── A4: Command routing + eliminated code (Section 4.8-4.9)
  │       Replace getOrchestrator() with getActiveOrchestrator()
  │       Delete isSecondary flag + getIsSecondary/setIsSecondary
  │       Update getState() — remove isSecondary
  │       Delete getPrimaryChatLeaf() → getActiveChatLeaf()
  │       Fix settings propagation to all orchestrators
  │       Update vault event dispatcher accessor
  │
  ├── A5: Persistence flush (Section 5)
  │       Add flush() + flushConversation() to HistoryManager
  │       Await flushConversation() in session cleanup finally blocks
  │       Add flush to destroy() with timeout
  │       Add workflow hook deactivation to cleanup + destroy()
  │
  ├── A6: Session guard (Section 6)
  │       Add SessionGuard interface + implementation on plugin
  │       Add sessionGuard as required constructor param on ChatOrchestrator
  │       Add cross-orchestrator check before session creation
  │       Add unregister in session cleanup + destroy()
  │
  └── A7: View close lifecycle (Section 7)
          Add onCloseCleanup callback to NotorChatView
          Wire cleanup in wireView()
          Update onClose() to call cleanup
          Update setView() to accept undefined

Phase B: Orchestrator decomposition (Section 8.1)
  ├── B1: Extract ViewRouter
  ├── B2: Extract SessionManager
  ├── B3: Extract ConversationLifecycleManager
  └── B4: Extract ConfigResolver

Phase C: Centralized state (Section 8.2) — optional, depends on B
```

**Recommended execution order for Phase A:** A1 → A2 → A3 (these three are sequential — each builds on the previous). Then A5, A6, A7 can be done in any order (independent concerns). A4 can be interleaved after A1.

A1 through A3 together fix Bug A (the highest-severity reported bug). A5 fixes Bug B. A6 fixes Bug D. A7 completes the lifecycle robustness.

---

## 11. Verification

### Bug A (Unified View Model — Sections 4 + 7)
1. Open a chat panel with active conversation A
2. Open a second chat panel → close it → Cmd+Shift+T to reopen
3. **Verify:** First panel still shows conversation A with full message history
4. **Verify:** Second panel loads independently (restored from saved state or most-recent)
5. **Verify:** No duplicate `onSessionsChanged` listeners (check via debug logging)
6. **Verify:** Closing a panel mid-session aborts the session and flushes writes
7. **Verify:** Reopening after close loads the conversation correctly from JSONL

### Bug B (Persistence Flush — Section 5)
1. Send several messages rapidly in a conversation
2. Close plugin immediately (or kill Obsidian process)
3. Reopen → load conversation from history
4. **Verify:** All messages present in JSONL
5. Start a streaming response → wait for completion → immediately close plugin
6. Reopen → **Verify:** Complete response in JSONL

### Bug D (Session Guard — Section 6)
1. Open same conversation in two panels
2. Send a message in one panel
3. While streaming, try to send a message in the other panel
4. **Verify:** Second panel shows "This conversation is being processed in another panel" notice
5. Wait for first response to complete
6. **Verify:** Can now send from either panel

### Command Routing
1. Open two chat panels side by side
2. Focus panel 2, run "Run workflow" from command palette
3. **Verify:** Workflow executes in panel 2 (the focused one), not panel 1
4. Focus panel 1, run "New conversation"
5. **Verify:** New conversation created in panel 1

### Settings Propagation
1. Open two chat panels
2. Change a setting (e.g., switch provider)
3. **Verify:** Both panels reflect the updated setting

### Regression
1. All existing E2E tests pass (`e2e/scripts/session-sync-back-test.ts`, `e2e/scripts/phase4-multi-panel-test.ts`, `e2e/scripts/phase5-open-in-new-tab-test.ts`)
2. Normal single-panel chat works (new conversation, send messages, switch conversations)
3. Workflow execution works (foreground + background)
4. Plugin hot-reload preserves state
5. Workspace restore with multiple panels restores each panel's conversation correctly

---

## 12. Architecture Review Amendments

The following issues were identified during cross-referencing the spec against the codebase. All bug analysis, line numbers, and race condition traces in Sections 1–7 have been validated as accurate. The amendments below address design gaps not covered by the original spec.

### Amendment A1: CheckpointManager Must Be Per-Orchestrator (HIGH)

**Problem:** `CheckpointManager` ([`checkpoint.ts:25`](../../src/checkpoints/checkpoint.ts)) is a singleton with a single mutable `conversationId` field (L27). The spec's `syncViewAfterLoad()` (Section 4.5) calls `checkpointManager.setConversationId(conv.id)` for every panel that loads. With multiple panels, the last panel to load/switch wins — checkpoint operations from other panels silently target the wrong conversation.

This is a **pre-existing bug** — 9 call sites in `wireView()` already overwrite the singleton (`main.ts:2142,2167,2185,2251,2258,2504,2517,2525`). The unified model makes it systematically worse.

**Resolution:** Each orchestrator creates its own `CheckpointManager` instance. The `CheckpointStorage` layer is unchanged (it already takes `conversationId` as a parameter to query methods). Remove all `checkpointManager.setConversationId()` calls from `syncViewAfterLoad()` and `wireView()` callbacks. The orchestrator sets its CheckpointManager's conversation ID when switching conversations internally.

**Spec changes required:**
- Section 4.5: Remove `checkpointManager` from `syncViewAfterLoad()` parameters and body
- Section 4.5: Remove `checkpointManager.setConversationId(conv.id)` from `loadConversation()`
- Section 9: Add `checkpoint.ts` — change constructor to accept per-instance conversation scoping
- Section 9: Add `main.ts` — `createOrchestrator()` creates a new `CheckpointManager` per orchestrator

### Amendment A2: UseSubAgentTool Must Resolve via Dispatch Context (MEDIUM)

**Problem:** `UseSubAgentTool` at [`main.ts:1429-1431`](../../src/main.ts) captures closures that call `this.getOrchestrator()` to resolve effective tool config and active conversation at call time. The spec's Section 4.9 says to update these to `getActiveOrchestrator()`, but sub-agents are spawned from a specific session in a specific orchestrator. If the user focuses a different panel while a sub-agent runs, `getActiveOrchestrator()` resolves to the wrong orchestrator.

**Resolution:** Keep `UseSubAgentTool` as a singleton. Extend `ToolExecuteOptions` (or equivalent) with an optional `sourceOrchestrator` field. The orchestrator passes itself when dispatching tool calls for a session. `UseSubAgentTool.execute()` reads the orchestrator from options instead of closure accessors. Closure accessors remain as fallback for non-session contexts (e.g., sub-agent tool preview in UI). This ensures sub-agents always resolve config from the orchestrator that spawned them.

**Spec changes required:**
- Section 4.9 table: UseSubAgentTool entry should say "Pass orchestrator via dispatch context (keep singleton, extend ToolExecuteOptions)"
- Section 9: Add `tool-dispatcher.ts` — extend `ToolExecuteOptions` with optional `sourceOrchestrator` reference

### Amendment A3: `executeWorkflow()` Needs Per-Orchestrator Duplicate Guard (MEDIUM)

**Problem:** The spec's Section 6.3 shows both per-orchestrator and cross-orchestrator guards being added to `handleUserMessage()` and `executeWorkflow()`. However, `executeWorkflow()` ([`orchestrator.ts:763-954`](../../src/chat/orchestrator.ts)) currently has **no** `activeSessions.has(conv.id)` guard — unlike `handleUserMessage()` which has one at L1614. The spec implicitly assumes it exists.

**Resolution:** Add `activeSessions.has(conv.id)` check at the top of `executeWorkflow()`, before the cross-orchestrator `sessionGuard.isActive()` check. This is independent of the unified model — it's a pre-existing gap.

**Spec changes required:**
- Section 6.3: Note that the per-orchestrator guard is being *added* to `executeWorkflow()`, not just the cross-orchestrator one
- Section 9: `orchestrator.ts` changes should list this explicitly

### Amendment A4: Inspector View Must Subscribe to Focus Changes (LOW-MEDIUM)

**Problem:** The inspector view at [`main.ts:311-314`](../../src/main.ts) calls `inspectorView.setOrchestrator(this.getOrchestrator())` once in its factory. The spec's Section 4.9 says to "Use `getActiveOrchestrator()` or subscribe to focus changes" but doesn't specify which.

**Resolution:** The inspector subscribes to Obsidian's `workspace.on('active-leaf-change')` event. When a chat panel gains focus, the inspector updates its orchestrator reference via `setOrchestrator()`. When a non-chat leaf gains focus, the inspector retains its last orchestrator reference (doesn't clear). Unsubscribe on inspector close.

**Spec changes required:**
- Section 4.9 table: Inspector row should say "Subscribe to `active-leaf-change`, update on chat panel focus"
- Section 9: Add `effective-config-inspector.ts` to modified files list

### Amendment A5: `setState()` Should Override Fallback Loading (LOW)

**Problem:** Section 4.3 argues `setTimeout(fn, 0)` guarantees `setState()` wins the race. This is correct per the JS event loop spec but assumes Obsidian calls `setState()` synchronously or via microtask in the same turn as the factory return. If Obsidian defers to a later macrotask, the fallback fires first and loads the wrong conversation.

**Resolution:** Allow `setState()` to override the fallback. If `setState()` fires after the fallback already loaded (`isConversationLoaded === true`), re-call `loadConversation()` with the saved state. `loadConversation()` uses an `AbortController` (Amendment R2) to cancel any in-flight fallback load, preventing two async `switchConversation()` chains from racing.

See updated Section 4.4 for the `setState()` implementation and Section 4.5 for the AbortController integration in `loadConversation()`.

**Spec changes required:**
- Section 4.4: Updated — `setState()` handles the override case, `loadConversation()` AbortController prevents races
- Section 4.3: Add note that `setTimeout(0)` is an optimization (avoids unnecessary most-recent load), not a correctness requirement

### Amendment A6: Null Callback References on View Close (LOW)

**Problem:** Section 7.2's close cleanup detaches the view from the orchestrator and calls `destroy()`, but `wireView()` sets 29+ callback closures on the view that capture the orchestrator. If Obsidian retains references to the closed view, those closures keep the orchestrator alive.

**Resolution:** Add a `clearCallbacks()` method to `NotorChatView` that nulls all `setOn*` properties. Call it from `onClose()` after the cleanup callback.

**Spec changes required:**
- Section 7.2: Add `view.clearCallbacks()` call in `onClose()` after `this.onCloseCleanup?.()`

### Amendment A7: Vault Event Dispatcher Must Capture Orchestrator at Dispatch Time (LOW)

**Problem:** Section 4.10 proposes using `getActiveOrchestrator()` for vault-event workflows. But `executeBackgroundWorkflow()` uses the orchestrator's shared singletons (`historyManager`, `providerRegistry`, `personaManager`). If `getActiveOrchestrator()` returns a different orchestrator each time (user switched focus) and that orchestrator is later destroyed (panel closed), the background workflow breaks mid-execution.

**Resolution:** The vault event dispatcher should capture the orchestrator reference at dispatch time (when the event fires), not resolve it lazily during execution. The captured reference remains valid for the workflow's duration. If no orchestrator is available at dispatch time, skip the workflow.

**Clarification (Amendment R8):** The current `getDispatcherDeps()` pattern already captures at call time (it's a function called per dispatch). The actual change is replacing `this.getOrchestrator()` with `this.getActiveOrchestrator()` inside `getDispatcherDeps()`. The call-time capture pattern is already correct.

**Spec changes required:**
- Section 4.10: Replace `this.getOrchestrator()` with `this.getActiveOrchestrator()` in `getDispatcherDeps()`

### Updated Files to Modify (incorporating amendments)

| File | Additional Changes | Amendment |
|------|-------------------|-----------|
| [`src/checkpoints/checkpoint.ts`](../../src/checkpoints/checkpoint.ts) | Per-orchestrator instantiation (remove singleton assumption) | A1 |
| [`src/main.ts`](../../src/main.ts) | Create CheckpointManager per orchestrator in `createOrchestrator()`, move `setGetToolDefinitions()` to `createOrchestrator()`, move `restoreFromSettings()` to `onload()`, remove all `checkpointManager.setConversationId()` from wireView callbacks, audit wireView closures for hardcoded orchestrator refs, update `_personaNameChangeWired` callback to iterate `_orchestrators.values()`, capture orchestrator at vault event dispatch time | A1, A7, R1, R3, R5, R6 |
| [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts) | Add per-orchestrator `activeSessions.has()` guard to `executeWorkflow()` | A3 |
| [`src/tools/tool-dispatcher.ts`](../../src/tools/tool-dispatcher.ts) | Extend `ToolExecuteOptions` with optional `sourceOrchestrator` reference | A2, R9 |
| [`src/ui/effective-config-inspector.ts`](../../src/ui/effective-config-inspector.ts) | Subscribe to `active-leaf-change`, update orchestrator on chat panel focus | A4 |
| [`src/ui/chat-view.ts`](../../src/ui/chat-view.ts) | Add `clearCallbacks()` method, call from `onClose()`. Add `_loadConversationAbort` field. Update `setState()` to allow override of fallback loading with AbortController race protection. | A5, A6, R2 |

### Updated Implementation Order

Amendments slot into Phase A as follows:

```
Phase A: Unified view model + bug fixes
  ├── A1: Orchestrator registry + factory rewrite (Section 4.1-4.3)
  │       + Amendment A1: Per-orchestrator CheckpointManager
  │       + Amendment A7/R8: Replace getOrchestrator() with getActiveOrchestrator() in vault event dispatcher
  │       + Amendment R3: Move setGetToolDefinitions() to createOrchestrator()
  │       + Amendment R5: Move restoreFromSettings() to onload()
  │
  ├── A2: Conversation loading extraction (Section 4.4-4.5)
  │       + Amendment A5: setState override of fallback loading
  │       + Amendment R2: AbortController in loadConversation() to prevent races
  │       + Amendment R7: Remove checkpointManager from syncViewAfterLoad()
  │
  ├── A3: wireView simplification (Section 4.6-4.7)
  │       + Amendment A6: clearCallbacks() on view close
  │       + Amendment R1: Audit wireView closures for hardcoded orchestrator refs
  │       + Amendment R6: Update _personaNameChangeWired callback body
  │
  ├── A4: Command routing + eliminated code (Section 4.8-4.9)
  │       + Amendment A2/R9: UseSubAgentTool via ToolExecuteOptions dispatch context
  │       + Amendment A4: Inspector view focus subscription
  │
  ├── A5: Persistence flush (Section 5)
  │       + Amendment R4: Note deactivate() idempotency requirement
  │
  ├── A6: Session guard (Section 6)
  │       + Amendment A3: Per-orchestrator guard in executeWorkflow()
  │
  └── A7: View close lifecycle (Section 7)
```

---

## 13. Architecture Review Amendments (Round 2)

The following issues were identified during a second cross-referencing pass of the spec against the codebase (2026-04-10). All original bug analysis, line numbers, and race condition traces in Sections 1–7 were re-validated as accurate. The amendments below address design gaps in the proposed implementation that could cause new bugs.

### Amendment R2-1: `switchConversation()` Must Accept an AbortSignal (HIGH)

**Problem:** The `AbortController` in `loadConversation()` (Section 4.5) only prevents `.then()` continuations from running — it does **not** cancel an already-dispatched `switchConversation()` call. When `setState()` overrides the `setTimeout(0)` fallback, two `switchConversation()` calls execute simultaneously on the same orchestrator:

1. Fallback fires → `orchestrator.switchConversation("most-recent")` → async JSONL load starts
2. `setState()` fires → aborts controller → calls `loadConversation()` again → `orchestrator.switchConversation("saved-conv")` on the **same orchestrator**
3. Both calls execute `this.view?.clearMessages()` and render messages. User sees a flash of wrong content.

The final state is correct (second call wins), but the visual glitching and wasted rendering are unacceptable.

**Resolution:** Thread an `AbortSignal` into `switchConversation()`:

```typescript
async switchConversation(
    filename: string,
    opts?: { signal?: AbortSignal }
): Promise<void> {
    // After each await point:
    if (opts?.signal?.aborted) return;
    // ... continue
}
```

The `loadConversation()` AbortController creates the signal; `switchConversation(filename, { signal })` checks `signal.aborted` after each async step (JSONL read, conversation load, message render) and bails early if superseded. This is composable — other callers (user-initiated switches, conversation deletion) can also use it.

Also apply to `switchToConversationById()` and `newConversation()` as called from `loadConversation()`.

**Spec changes required:**
- Section 4.5: `loadConversation()` passes `{ signal: controller.signal }` to all orchestrator switch/new calls
- Section 9: `orchestrator.ts` — update `switchConversation()`, `switchToConversationById()`, `newConversation()` signatures

### Amendment R2-2: Close-Before-setTimeout Race (HIGH)

**Problem:** If a view is created and immediately closed (e.g., Obsidian workspace rearrangement during startup), the `setTimeout(0)` fallback fires after close cleanup has destroyed the orchestrator:

1. Factory creates orchestrator, registers in `_orchestrators`, schedules `setTimeout(0)`
2. View closes immediately → `onCloseCleanup` removes orchestrator, calls `destroy()`
3. `setTimeout(0)` fires → `isConversationLoaded` is `false` → calls `loadConversation()` on destroyed orchestrator

The `_loadConversationAbort` AbortController doesn't help because close cleanup doesn't know about the timeout's scope.

**Resolution:** Store the timeout ID on the view and clear it in close cleanup:

```typescript
// In registerView factory:
view._loadFallbackTimeout = setTimeout(() => {
    if (!view.isConversationLoaded) {
        this.loadConversation(view, orchestrator);
    }
}, 0);

// In onCloseCleanup:
clearTimeout(view._loadFallbackTimeout);
```

Add `_loadFallbackTimeout?: ReturnType<typeof setTimeout>` to `NotorChatView`.

**Spec changes required:**
- Section 4.3: Store timeout ID on view
- Section 7.2: Add `clearTimeout(view._loadFallbackTimeout)` to close cleanup
- Section 9: `chat-view.ts` — add `_loadFallbackTimeout` field

### Amendment R2-3: `onCloseCleanup` Must Be Async (MEDIUM)

**Problem:** Section 7.2 defines `onCloseCleanup` as `() => void` and calls `orchestrator.destroy()` without awaiting. `destroy()` performs critical work: aborting sessions, flushing JSONL writes (Section 5.3), unregistering session guards. Fire-and-forgetting means:
- Session guard entries may not clean up before another panel uses that conversation
- JSONL flush may not complete before Obsidian tears down
- The 2s timeout in `destroy()` is meaningless if nothing awaits

Obsidian's `onClose()` returns `Promise<void>` — the current implementation at [`chat-view.ts:670`](../../src/ui/chat-view.ts) is `return Promise.resolve()`, so async is supported.

**Resolution:** Make `onCloseCleanup` async, await `destroy()`:

```typescript
// Field type:
onCloseCleanup?: () => Promise<void>;

// In wireView():
view.setOnCloseCleanup(async () => {
    clearTimeout(view._loadFallbackTimeout);
    orchestrator.setView(undefined);
    view._unregisterSessionsChanged?.();
    this._orchestrators.delete(leafId);
    await orchestrator.destroy();  // awaited — flushes JSONL + cleans guards
});

// In onClose():
async onClose(): Promise<void> {
    await this.onCloseCleanup?.();
    this.clearCallbacks();
    // ... existing DOM cleanup ...
}
```

**Spec changes required:**
- Section 7.2: Update `onCloseCleanup` type to `() => Promise<void>`, await `destroy()`, await in `onClose()`

### Amendment R2-4: `createOrchestrator()` Consolidated Setup Checklist (MEDIUM)

**Problem:** The spec replaces both `getOrchestrator()` (L1585-1627) and `createSecondaryOrchestrator()` (L1640-1687) with a single `createOrchestrator()`. These methods have **different** setup sequences, and the required setup steps are scattered across amendments R1, R3, R5, R6 without a unified checklist. Missing a step causes silent failures.

**Resolution:** The new `createOrchestrator()` must perform the following (union of both existing methods + amendments):

| # | Setup Step | Currently In | Moves To |
|---|-----------|-------------|----------|
| 1 | Construct `ChatOrchestrator` with shared singletons | Both methods | `createOrchestrator()` |
| 2 | Wire `PersonaManager` (setPersonaManager) | `getOrchestrator()` L1605, `createSecondary` L1663 | `createOrchestrator()` |
| 3 | Wire `WorkflowHookOverrideManager` (setWorkflowHookOverrideManager) | `getOrchestrator()` L1608, `createSecondary` L1666 | `createOrchestrator()` |
| 4 | Wire extension accessors (setExtensionAccessors) | `getOrchestrator()` L1616, `createSecondary` L1672 | `createOrchestrator()` |
| 5 | Set tool definitions (setGetToolDefinitions) | `wireView()` L2073 for primary, `createSecondary` L1676 | `createOrchestrator()` (Amendment R3) |
| 6 | Create per-orchestrator `CheckpointManager` | Singleton in `onload()` | `createOrchestrator()` (Amendment A1) |
| 7 | Pass `SessionGuard` as constructor param | N/A (new) | `createOrchestrator()` (Section 6.2) |
| 8 | `personaManager.restoreFromSettings()` | `wireView()` L2061-2068 | `onload()` — one-time only (Amendment R5) |

**Spec changes required:**
- Section 4.3 or new Section 4.3.1: Add this table as the canonical `createOrchestrator()` contract

### Amendment R2-5: `getActiveOrchestrator()` Should Track Last-Focused Panel (MEDIUM)

**Problem:** Section 4.9's `getActiveOrchestrator()` falls back to `leaves[0]` when no chat panel is focused. `leaves[0]` is non-deterministic — Obsidian returns leaves in DOM order which varies by workspace layout. Commands like "Run workflow", "Export conversation", and "Manual compaction" could target a random panel.

**Resolution:** Track the most-recently-focused chat panel:

```typescript
private _lastFocusedChatLeafId?: string;

// In onload():
this.registerEvent(
    this.app.workspace.on('active-leaf-change', (leaf) => {
        if (leaf?.view instanceof NotorChatView) {
            this._lastFocusedChatLeafId = leaf.id;
        }
    })
);

// In getActiveOrchestrator():
getActiveOrchestrator(): ChatOrchestrator | null {
    const activeView = this.app.workspace.getActiveViewOfType(NotorChatView);
    if (activeView) {
        return this._orchestrators.get(activeView.leaf.id) ?? null;
    }
    // Fall back to last-focused chat panel
    if (this._lastFocusedChatLeafId) {
        const orch = this._orchestrators.get(this._lastFocusedChatLeafId);
        if (orch) return orch;
    }
    // Last resort: any open panel
    const leaves = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (leaves.length > 0) {
        return this._orchestrators.get(leaves[0].id) ?? null;
    }
    return null;
}
```

**Spec changes required:**
- Section 4.9: Update `getActiveOrchestrator()` with last-focused fallback
- Section 9: `main.ts` — add `_lastFocusedChatLeafId` field + `active-leaf-change` listener

### Amendment R2-6: `loadConversation()` Should Use async/await (LOW-MEDIUM)

**Problem:** Section 4.5's `loadConversation()` uses nested `.then()/.catch()` chains (4 levels deep in the `savedId` branch). Each branch must manually check `controller.signal.aborted`, and a missed check creates a silent race condition. This is the **single owner of all conversation loading** — the most critical new code path — and should be maximally readable.

**Resolution:** Rewrite as an `async` method. The abort checks become a repeatable `if (signal.aborted) return` pattern:

```typescript
async loadConversation(
    view: NotorChatView,
    orchestrator: ChatOrchestrator,
    savedState?: Record<string, unknown> | null,
): Promise<void> {
    view._loadConversationAbort?.abort();
    const controller = new AbortController();
    view._loadConversationAbort = controller;
    const signal = controller.signal;

    view.isConversationLoaded = true;

    try {
        const entries = await this.getHistoryManager().listConversations();
        if (signal.aborted) return;
        view.renderConversationList(entries);

        const savedFilename = savedState?.conversationFilename as string | undefined;
        const savedId = savedState?.conversationId as string | undefined;

        if (savedFilename) {
            await orchestrator.switchConversation(savedFilename, { signal });
        } else if (savedId) {
            try {
                await orchestrator.switchToConversationById(savedId, { signal });
            } catch {
                if (signal.aborted) return;
                if (entries.length > 0) {
                    await orchestrator.switchConversation(entries[0].filename, { signal });
                } else {
                    await orchestrator.newConversation({ signal });
                }
            }
        } else if (entries.length === 0) {
            await orchestrator.newConversation({ signal });
        } else {
            await orchestrator.switchConversation(entries[0].filename, { signal });
        }

        if (signal.aborted) return;
        this.syncViewAfterLoad(view, orchestrator);
    } catch (e) {
        if (signal.aborted) return;
        log.error("Failed to load conversation history", { error: String(e) });
        try { await orchestrator.newConversation(); } catch { /* last resort */ }
    }
}
```

**Spec changes required:**
- Section 4.5: Replace `loadConversation()` implementation with async/await version

### Amendment R2-7: Leaf ID Reuse Guard in Factory (LOW-MEDIUM)

**Problem:** The `_orchestrators` Map (Section 4.2) is keyed by `leaf.id`. If Obsidian reuses leaf IDs during workspace restore, the factory overwrites the old entry without destroying the orphaned orchestrator — leaking it along with its session guard entries.

**Resolution:** Check and destroy stale entries in the factory:

```typescript
// In registerView factory, before creating new orchestrator:
const existing = this._orchestrators.get(leaf.id);
if (existing) {
    log.warn("Stale orchestrator found for leaf, destroying", { leafId: leaf.id });
    existing.destroy();  // fire-and-forget OK here — stale, no active view
}
```

**Spec changes required:**
- Section 4.3: Add stale orchestrator check before `_orchestrators.set()`

### Amendment R2-8: `clearCallbacks()` Sequencing (LOW)

**Problem:** Amendment A6 proposes `clearCallbacks()` but doesn't specify ordering relative to `onCloseCleanup()`. If `clearCallbacks()` runs first, the cleanup callback can't use view callbacks. If it runs after, there's a window where callbacks reference a destroyed orchestrator.

**Resolution:** The correct order is:
1. `await this.onCloseCleanup?.()` — detaches orchestrator (sets `view` to undefined), destroys orchestrator
2. `this.clearCallbacks()` — nulls all `setOn*` properties to release GC references

After step 1, the orchestrator's `this.view` is `undefined`, so all `this.view?.` callback invocations become no-ops. Step 2 ensures the view doesn't retain references to the destroyed orchestrator's closures.

**Spec changes required:**
- Section 7.2 / Amendment A6: Specify ordering — cleanup first, then clearCallbacks

### Amendment R2-9: Leaf Detach/Reattach Is a Known Limitation (LOW)

**Problem:** Obsidian can detach leaves (move to sidebar, popout window) and reattach them without triggering `onClose()`/`registerView`. The spec's lifecycle model assumes create-once/destroy-once. Detached leaves have valid orchestrators but disconnected DOMs — renders go nowhere.

**Resolution:** Acknowledge as a known limitation. This is a pre-existing issue not introduced by this redesign. The unified model is no worse than the current primary/secondary model in this regard. A future improvement could add a `workspace.on('layout-change')` listener that validates orchestrator-view DOM bindings, but this is out of scope for this spec.

### Updated Implementation Order (with R2 amendments)

```
Phase A: Unified view model + bug fixes
  ├── A1: Orchestrator registry + factory rewrite (Section 4.1-4.3)
  │       + Amendment A1: Per-orchestrator CheckpointManager
  │       + Amendment A7/R8: Replace getOrchestrator() with getActiveOrchestrator()
  │       + Amendment R3: Move setGetToolDefinitions() to createOrchestrator()
  │       + Amendment R5: Move restoreFromSettings() to onload()
  │       + Amendment R2-4: Consolidated setup checklist
  │       + Amendment R2-5: Track _lastFocusedChatLeafId
  │       + Amendment R2-7: Leaf ID reuse guard in factory
  │
  ├── A2: Conversation loading extraction (Section 4.4-4.5)
  │       + Amendment A5: setState override of fallback loading
  │       + Amendment R2: AbortController in loadConversation()
  │       + Amendment R2-1: Thread AbortSignal into switchConversation()
  │       + Amendment R2-2: Store timeout ID on view, clear in close cleanup
  │       + Amendment R2-6: Rewrite loadConversation() as async/await
  │       + Amendment R7: Remove checkpointManager from syncViewAfterLoad()
  │
  ├── A3: wireView simplification (Section 4.6-4.7)
  │       + Amendment A6: clearCallbacks() on view close
  │       + Amendment R2-8: clearCallbacks() sequencing (after onCloseCleanup)
  │       + Amendment R1: Audit wireView closures for hardcoded orchestrator refs
  │       + Amendment R6: Update _personaNameChangeWired callback body
  │
  ├── A4: Command routing + eliminated code (Section 4.8-4.9)
  │       + Amendment A2/R9: UseSubAgentTool via ToolExecuteOptions dispatch context
  │       + Amendment A4: Inspector view focus subscription
  │
  ├── A5: Persistence flush (Section 5)
  │       + Amendment R4: Note deactivate() idempotency requirement
  │
  ├── A6: Session guard (Section 6)
  │       + Amendment A3: Per-orchestrator guard in executeWorkflow()
  │
  └── A7: View close lifecycle (Section 7)
          + Amendment R2-3: Make onCloseCleanup async, await destroy()
```
