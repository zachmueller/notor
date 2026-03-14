# GUIDE-013-R: Promise Handling Audit

**Created:** 2026-03-15
**Purpose:** Classify every floating promise and promise-in-void-context violation before GUIDE-013 implementation begins.

---

## Legend

| Field | Values |
|---|---|
| Rule | `no-floating-promises` or `no-misused-promises` |
| Intent | fire-and-forget / caller-should-await / intentional-async-callback |
| Error visibility | whether a rejection would be observable before/after fix |
| Correct fix | `void fn()` / `.catch(...)` / `await fn()` / update callback type / `void (async () => {...})()` |
| Risk | Low / Medium / High |

---

## Part 1: Floating Promises (`no-floating-promises` — 13 occurrences)

### 1. `src/chat/history.ts:L125–L129`

**Code:**
```typescript
next.finally(() => {
    if (this.writeQueues.get(filePath) === next) {
        this.writeQueues.delete(filePath);
    }
});
```

**Context:** Inside `enqueueWrite`. The `finally` is cleanup to prevent unbounded Map growth once the write chain settles. The return value of `next.finally(...)` (a new Promise) is not used.

| Field | Value |
|---|---|
| Intent | Fire-and-forget cleanup; the result Promise is irrelevant |
| Error visibility | Errors from the write chain propagate through `next` (the returned Promise), not through the `finally` Promise. Not changed by fix. |
| Execution order sensitivity | None — cleanup runs after `next` settles regardless |
| Correct fix | `void next.finally(...)` |
| Risk | **Low** |

---

### 2. `src/chat/orchestrator.ts:L1846`

**Code:**
```typescript
const el = this.view?.createAssistantMessagePlaceholder();
if (el) {
    this.view?.finalizeAssistantMessage(el, message);  // L1846
}
```

**Context:** Inside `renderMessage()` (a sync `void` method). `finalizeAssistantMessage` is `async` (it calls `MarkdownRenderer.render`). The rendering Promise is silently discarded.

| Field | Value |
|---|---|
| Intent | Intentional fire-and-forget UI render — callers of `renderMessage` don't await it |
| Error visibility | If markdown rendering fails, the error is currently silently swallowed. After fix (`void`), same behavior — consider adding `.catch(log.error)` |
| Execution order sensitivity | None — rendering is best-effort; the message has already been appended to history |
| Correct fix | `void this.view?.finalizeAssistantMessage(el, message)` — add `.catch(err => log.error("render failed", err))` for visibility |
| Risk | **Low** |

---

### 3. `src/main.ts:L1446`

**Code (inside async `openChatPanel()`):**
```typescript
workspace.revealLeaf(existing[0] as WorkspaceLeaf);
return;
```

**Context:** `WorkspaceLeaf.revealLeaf` / `workspace.revealLeaf` returns `void` in the Obsidian type declarations (it's not async). However, the lint rule flags this because the Obsidian typing is `void` on older SDK versions but some versions return `Promise<void>`. This call is inside an `async` function but the callee is sync/void.

| Field | Value |
|---|---|
| Intent | Reveal and focus an existing leaf — no async semantics needed |
| Error visibility | N/A — revealLeaf is synchronous |
| Execution order sensitivity | None; `return` follows immediately |
| Correct fix | `void workspace.revealLeaf(existing[0] as WorkspaceLeaf)` — or confirm the Obsidian type is truly `void` and the lint is a false positive; add explicit type annotation if needed |
| Risk | **Low** |

---

### 4. `src/main.ts:L1454`

**Code (inside async `openChatPanel()`):**
```typescript
await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
workspace.revealLeaf(leaf);
```

**Context:** Same as L1446 — `revealLeaf` called without await. `setViewState` is correctly awaited above it.

| Field | Value |
|---|---|
| Intent | Same as L1446 |
| Error visibility | N/A |
| Execution order sensitivity | None; `revealLeaf` fires synchronously after `setViewState` resolves |
| Correct fix | `void workspace.revealLeaf(leaf)` (or `await` if the type is `Promise<void>`) |
| Risk | **Low** |

---

### 5. `src/settings/sections/connection-test.ts:L32`

**Code (inside sync void function `renderConnectionTestButton`):**
```typescript
renderBedrockConnectionTestButton(containerEl, setting, ctx);
return;
```

**Context:** `renderBedrockConnectionTestButton` is declared `async function renderBedrockConnectionTestButton(...)`. It awaits nothing itself currently (GUIDE-017 will likely remove the async), but it registers a `.setDesc(...)` and `.addButton(...)` on the Setting — all synchronous Obsidian API calls. So the async is spurious; removal via GUIDE-017 resolves this automatically.

| Field | Value |
|---|---|
| Intent | Call is synchronous in practice; the async keyword is the bug |
| Error visibility | No actual awaited operations inside the function |
| Execution order sensitivity | None — all work is synchronous |
| Correct fix | Fix in **GUIDE-017** (remove spurious `async` from `renderBedrockConnectionTestButton`). Once `async` is removed, the floating promise disappears. No separate fix needed here. |
| Risk | **Low** — GUIDE-017 resolves this |

---

### 6. `src/settings/sections/mcp-servers.ts:L562`

**Code:**
```typescript
sensitiveCheck.addEventListener("change", () => {
    valueInput.type = sensitiveCheck.checked ? "password" : "text";
    valueInput.placeholder = sensitiveCheck.checked ? "••••••••" : "Value";
    emitChange();  // L569 — async call not awaited
});
```

**Context:** `emitChange` is `async` (it awaits `onChange`). The event listener is a sync wrapper. `emitChange()` is floating inside the listener body.

| Field | Value |
|---|---|
| Intent | Fire-and-forget settings persistence; the listener updates UI first, then persists |
| Error visibility | If `onChange` rejects, error is silently dropped. Medium concern — should surface |
| Execution order sensitivity | UI update (type/placeholder) is synchronous and happens before emitChange; order is correct |
| Correct fix | `void emitChange()` inside the sync listener — sufficient. Add `.catch(err => log.error(...))` on `emitChange` itself if error surfacing is desired. |
| Risk | **Low** |

---

### 7. `src/settings/sections/provider-reference.ts:L62–L67`

**Code:**
```typescript
providerCopyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(providerConfig.type).then(() => {
        providerCopyBtn.textContent = "Copied";
        setTimeout(() => {
            providerCopyBtn.textContent = "Copy";
        }, 1500);
    });
});
```

**Context:** `navigator.clipboard.writeText(...).then(...)` returns a Promise (the `.then()` result). It's floating inside the event listener.

| Field | Value |
|---|---|
| Intent | Fire-and-forget clipboard copy with UI feedback |
| Error visibility | If clipboard write fails, error is silently dropped (no `.catch`) |
| Execution order sensitivity | None |
| Correct fix | `void navigator.clipboard.writeText(providerConfig.type).then(() => { ... })` — optionally add `.catch(err => log.warn("clipboard copy failed", err))` |
| Risk | **Low** |

---

### 8. `src/settings/sections/provider-reference.ts:L110–L115`

**Code (same pattern as #7 but for model copy button):**
```typescript
modelCopyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(modelId).then(() => {
        modelCopyBtn.textContent = "Copied";
        setTimeout(() => {
            modelCopyBtn.textContent = "Copy";
        }, 1500);
    });
});
```

| Field | Value |
|---|---|
| Intent | Same as #7 — clipboard copy with UI feedback |
| Error visibility | Same gap — no `.catch` |
| Correct fix | `void navigator.clipboard.writeText(modelId).then(() => { ... })` |
| Risk | **Low** |

---

### 9. `src/ui/chat-view.ts:L305`

**Code:**
```typescript
this.workflowActivityIndicator.setOnNavigateToConversation(
    (conversationId: string) => {
        this.switchToConversation(conversationId);  // L305
    }
);
```

**Context:** `switchToConversation` is `async`. The outer callback is typed as `(conversationId: string) => void` (sync). The returned Promise is floating.

| Field | Value |
|---|---|
| Intent | Fire-and-forget navigation triggered by UI interaction |
| Error visibility | If navigation fails, error is silently dropped |
| Execution order sensitivity | None — user clicks and navigation runs |
| Correct fix | `void this.switchToConversation(conversationId)` inside the callback |
| Risk | **Low** |

---

### 10. `src/ui/chat-view.ts:L332`

**Code (inside async `switchToConversation`):**
```typescript
this.app.workspace.revealLeaf(this.leaf);
```

**Context:** Inside an `async` function. `workspace.revealLeaf` is typed `void` in Obsidian API, so no actual floating promise — this is likely a lint false-positive due to optional-chaining or TS type inference nuance.

| Field | Value |
|---|---|
| Intent | Reveal the chat panel synchronously |
| Error visibility | N/A — no Promise |
| Correct fix | `void this.app.workspace.revealLeaf(this.leaf)` to silence lint, or verify Obsidian type and add a type annotation |
| Risk | **Low** |

---

### 11. `src/ui/chat-view.ts:L595`

**Code (inside sync keydown handler):**
```typescript
this.textInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();  // L595
    }
    ...
});
```

**Context:** `handleSend` is `async Promise<void>`. The keydown handler is sync; the returned Promise is floating. `handleSend` is the main send path.

| Field | Value |
|---|---|
| Intent | Fire-and-forget send initiation; user expects message to send asynchronously |
| Error visibility | If `handleSend` rejects, error is silently dropped; internal error handling inside `handleSend` exists |
| Execution order sensitivity | None — handler returns immediately; sending proceeds async |
| Correct fix | `void this.handleSend()` |
| Risk | **Low** |

---

### 12. `src/ui/chat-view.ts:L1520`

**Code (inside sync setup method body):**
```typescript
const loadCheckpoints = async () => { ... };

refreshBtn.addEventListener("click", () => loadCheckpoints());  // L1517 — also a void-context issue
// Load immediately when the section is created
loadCheckpoints();  // L1520
```

**Context:** `loadCheckpoints` is async. Called directly in a sync function body to trigger the initial load. This is intentional fire-and-forget initialization.

| Field | Value |
|---|---|
| Intent | Fire-and-forget initial load; display will update when it resolves |
| Error visibility | `loadCheckpoints` has try/catch internally, errors shown in UI |
| Execution order sensitivity | None — the loading is background |
| Correct fix | `void loadCheckpoints()` |
| Risk | **Low** |

---

### 13. `src/ui/persona-picker.ts:L104–L108`

**Code:**
```typescript
personaManager.activatePersona(value).then((success) => {
    if (!success) {
        log.warn("Failed to activate persona from picker", { name: value });
    }
});
```

**Context:** The `.then()` callback handles success/failure logging. The Promise returned by `.then()` is floating; there's no `.catch()` on the chain.

| Field | Value |
|---|---|
| Intent | Fire-and-forget persona activation with logging |
| Error visibility | If `activatePersona` rejects (vs returns false), the rejection is silently dropped — the `.then()` only handles resolved value. Should add `.catch(err => log.error(...))` |
| Execution order sensitivity | None |
| Correct fix | `void personaManager.activatePersona(value).then((success) => { ... }).catch((err) => log.error("persona activation error", { name: value, err }))` |
| Risk | **Low-Medium** — rejection from `activatePersona` would currently be swallowed |

---

## Part 2: Promise in Void-Context (`no-misused-promises` — 16 occurrences)

### 14. `src/chat/orchestrator.ts:L100–L105` (and `L591–L596`)

**Code:**
```typescript
this.conversationManager.setOnMessageAdded(async (message: Message) => {
    const conv = this.conversationManager.getActiveConversation();
    if (conv) {
        await this.historyManager.appendMessage(conv, message);
    }
});
```

**Context:** `setOnMessageAdded` accepts `(message: Message) => void`, but an `async` function returning `Promise<void>` is passed. The ConversationManager calls `this.onMessageAdded?.(message)` and discards the returned Promise — history writes are fire-and-forget from the ConversationManager's perspective.

The same pattern repeats in the background conversation manager setup at L591–L596.

| Field | Value |
|---|---|
| Intent | Intentional async callback — history persistence must be async because file I/O is async |
| Error visibility | History write errors currently silently discarded by ConversationManager (it calls `this.onMessageAdded?.(message)` with no await). The write queue in HistoryManager handles serialization. |
| Correct fix | **Change the callback type** in ConversationManager from `(message: Message) => void` to `(message: Message) => void \| Promise<void>`. This makes the async callback explicit and type-correct without requiring ConversationManager to await it. Same fix applies to `onConversationChanged`. |
| Risk | **Medium** — requires modifying ConversationManager's public API; callers that pass sync callbacks are unaffected |

---

### 15. `src/chat/orchestrator.ts:L107–L109` (and `L597–L599`)

**Code:**
```typescript
this.conversationManager.setOnConversationChanged(async (conv) => {
    await this.historyManager.updateConversationHeader(conv);
});
```

**Context:** Same as #14 — `setOnConversationChanged` typed `(conversation: Conversation) => void`, but async callback passed.

| Field | Value |
|---|---|
| Intent | Same — async callback for persistence |
| Correct fix | Same as #14: change callback type to `(conversation: Conversation) => void \| Promise<void>` |
| Risk | **Medium** (same as #14) |

**Note:** Items #14 and #15 appear 4 times total (main orchestrator constructor + background conversation manager setup). All four are resolved by the single type change in ConversationManager.

---

### 16. `src/mcp/mcp-hub.ts:L751–L791`

**Code:**
```typescript
const timer = setTimeout(async () => {
    ...
    try {
        await this.connectServer(serverName);
    } catch (e) {
        log.warn("Reconnect attempt failed", { ... });
        ...
    }
}, delay);
```

**Context:** `setTimeout` expects a `() => void` callback. The async callback returns `Promise<void>` — a no-misused-promises violation. Errors inside the async body are correctly caught with try/catch, so rejection won't be silently dropped.

| Field | Value |
|---|---|
| Intent | Intentional async timer callback — reconnect logic must be async |
| Error visibility | Well-handled — try/catch covers all async operations |
| Execution order sensitivity | None — timer fires independently |
| Correct fix | Wrap async body: `setTimeout(() => { void (async () => { ... })(); }, delay)` |
| Risk | **Low** — only a structural change; behavior is identical |

---

### 17. `src/settings/sections/mcp-servers.ts:L557–L558`

**Code:**
```typescript
keyInput.addEventListener("change", emitChange);
valueInput.addEventListener("change", emitChange);
```

**Context:** `emitChange` is `async () => { await onChange(...); }`. Passing it directly as an event listener violates no-misused-promises since addEventListener expects `() => void`.

| Field | Value |
|---|---|
| Intent | Intentional async settings persistence |
| Error visibility | If `onChange` rejects, error is silently dropped. Acceptable for settings — the UI doesn't need to reflect save failures here. |
| Correct fix | Wrap: `keyInput.addEventListener("change", () => void emitChange())` and same for `valueInput`. The arrow wrapper has `void` return type, satisfying the rule. |
| Risk | **Low** |

---

### 18. `src/settings/sections/mcp-servers.ts:L564–L567`

**Code:**
```typescript
sensitiveCheck.addEventListener("change", () => {
    valueInput.type = sensitiveCheck.checked ? "password" : "text";
    valueInput.placeholder = sensitiveCheck.checked ? "••••••••" : "Value";
    emitChange();  // floating promise inside sync callback
});
```

**Context:** The outer callback is sync (void), but `emitChange()` is async inside it. Both `no-floating-promises` (#6 above) and `no-misused-promises` apply here. The outer callback is fine (sync), but `emitChange()` call is floating.

| Field | Value |
|---|---|
| Intent | Same as #17 |
| Correct fix | `void emitChange()` inside the sync callback (fixes the floating promise; the outer callback remains sync, which is fine) |
| Risk | **Low** |

---

### 19. `src/settings/sections/mcp-servers.ts:L592–L605`

**Code:**
```typescript
refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    try {
        await mcpHub?.refreshTools(serverName);
        new Notice(`Tools refreshed for "${serverName}".`);
        refresh();
    } catch (e) {
        new Notice(`Failed to refresh tools: ...`);
    } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "Refresh tools";
    }
});
```

**Context:** Async callback to `addEventListener`. Errors are caught. UI feedback provided.

| Field | Value |
|---|---|
| Intent | Intentional async — refresh requires awaiting the hub call |
| Error visibility | Errors caught and shown via Notice |
| Correct fix | `refreshBtn.addEventListener("click", () => { void (async () => { ... })(); })` |
| Risk | **Low** |

---

### 20. `src/settings/sections/mcp-servers.ts:L654–L663`

**Code:**
```typescript
classSelect.addEventListener("change", async () => {
    const val = classSelect.value as "read" | "write";
    ...
    await ctx.saveSettings();
});
```

**Context:** Async callback for a dropdown change event.

| Field | Value |
|---|---|
| Intent | Intentional async settings save |
| Error visibility | If `saveSettings` rejects, error is silently dropped. Acceptable — Obsidian's `saveData` rarely fails |
| Correct fix | `classSelect.addEventListener("change", () => { void (async () => { ... })(); })` |
| Risk | **Low** |

---

### 21. `src/settings/sections/mcp-servers.ts:L671–L679`

**Code:**
```typescript
autoApproveCheck.addEventListener("change", async () => {
    if (!config.autoApprove) config.autoApprove = [];
    if (autoApproveCheck.checked) { ... }
    else { ... }
    await ctx.saveSettings();
});
```

**Context:** Same pattern as #20 — async callback for settings persistence.

| Field | Value |
|---|---|
| Intent | Intentional async settings save |
| Correct fix | `autoApproveCheck.addEventListener("change", () => { void (async () => { ... })(); })` |
| Risk | **Low** |

---

### 22. `src/ui/chat-view.ts:L645`

**Code:**
```typescript
this.sendButtonEl.addEventListener("click", () => this.handleSend());
```

**Context:** `handleSend` is async. The arrow callback `() => this.handleSend()` returns `Promise<void>`, making it a void-context violation.

| Field | Value |
|---|---|
| Intent | Fire-and-forget send trigger |
| Error visibility | `handleSend` has its own internal error handling |
| Correct fix | `this.sendButtonEl.addEventListener("click", () => void this.handleSend())` |
| Risk | **Low** |

---

### 23. `src/ui/chat-view.ts:L1413–L1425`

**Code:**
```typescript
refreshBtn.addEventListener("click", async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "…";
    try {
        await this.onRefreshModels?.();
        this.refreshModelSelect();
    } catch {
        // Fall through to text input
    } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "↻";
    }
});
```

**Context:** Async callback for a button click. Errors are caught.

| Field | Value |
|---|---|
| Intent | Intentional async — model refresh is async |
| Error visibility | Caught via try/catch |
| Correct fix | `refreshBtn.addEventListener("click", () => { void (async () => { ... })(); })` |
| Risk | **Low** |

---

### 24. `src/ui/chat-view.ts:L1517`

**Code:**
```typescript
refreshBtn.addEventListener("click", () => loadCheckpoints());
```

**Context:** `loadCheckpoints` is async. The arrow callback returns `Promise<void>`.

| Field | Value |
|---|---|
| Intent | Fire-and-forget load trigger |
| Error visibility | `loadCheckpoints` has internal try/catch |
| Correct fix | `refreshBtn.addEventListener("click", () => void loadCheckpoints())` |
| Risk | **Low** |

---

### 25. `src/ui/chat-view.ts:L1549–L1556`

**Code:**
```typescript
compareBtn.addEventListener("click", async () => {
    const current = await this.onGetCurrentContent?.(cp.note_path);
    if (current == null) {
        new Notice(`Note not found: ${cp.note_path}`);
        return;
    }
    this.showCheckpointDiffModal(cp, current);
});
```

**Context:** Async callback for button click. No try/catch — if `onGetCurrentContent` rejects, error is silently dropped.

| Field | Value |
|---|---|
| Intent | Intentional async — must await current note content |
| Error visibility | **Gap**: rejection from `onGetCurrentContent` is unhandled. Should add try/catch. |
| Correct fix | `compareBtn.addEventListener("click", () => { void (async () => { try { ... } catch (err) { log.error("compare failed", err); new Notice("Failed to compare checkpoint"); } })(); })` — or add `.catch` on the inner async call |
| Risk | **Low-Medium** — structural change + gap in error handling |

---

### 26. `src/ui/chat-view.ts:L1564–L1580`

**Code:**
```typescript
restoreBtn.addEventListener("click", async () => {
    restoreBtn.disabled = true;
    restoreBtn.textContent = "Restoring…";
    try {
        const ok = await this.onRestoreCheckpoint?.(cp.id);
        if (ok) { new Notice(...); }
        else { new Notice(`Failed to restore checkpoint`); }
    } catch {
        new Notice(`Failed to restore checkpoint`);
    } finally {
        restoreBtn.disabled = false;
        restoreBtn.textContent = "Restore";
    }
});
```

**Context:** Async callback for button click. Errors are caught.

| Field | Value |
|---|---|
| Intent | Intentional async — restore is async, UI feedback needed |
| Error visibility | Well handled — try/catch/finally covers all cases |
| Correct fix | `restoreBtn.addEventListener("click", () => { void (async () => { ... })(); })` |
| Risk | **Low** |

---

## High-Risk Sites Summary

No sites are classified as High risk. There are two Low-Medium sites requiring attention:

1. **`src/ui/persona-picker.ts:L104–L108` (#13)**: `activatePersona` rejection currently silently dropped — only `.then()` is chained, no `.catch()`. Fix should add `.catch(err => log.error(...))`.

2. **`src/ui/chat-view.ts:L1549–L1556` (#25)**: `onGetCurrentContent` rejection in the compare button handler is unhandled. Fix should wrap in try/catch.

---

## Decisions Needed Before GUIDE-013 Implementation

### Decision 1: ConversationManager callback type widening

Sites #14 and #15 require changing the callback type signatures in `src/chat/conversation.ts`:
- `(message: Message) => void` → `(message: Message) => void | Promise<void>`
- `(conversation: Conversation) => void` → `(conversation: Conversation) => void | Promise<void>`

This is the cleanest fix and keeps the async callbacks readable. It does NOT change ConversationManager's call sites (they already fire-and-forget). **Recommended: proceed with type widening.**

### Decision 2: `no-misused-promises` pattern for DOM event listeners

For all `addEventListener("event", async () => {...})` sites, two patterns are available:

**Option A** (concise): `addEventListener("event", () => void (async () => { ... })())`
**Option B** (cleaner inner function): Extract the async body into a named async function, pass `() => void namedFn()`.

For the majority of these sites, Option A is fine since the async bodies are small. For larger callbacks (like `scheduleReconnect` in mcp-hub.ts), extracting into a named method is cleaner but out of scope for GUIDE-013. **Recommended: Option A for all.**

---

## Fix Summary Table

| # | Location | Rule | Fix | Risk |
|---|---|---|---|---|
| 1 | `chat/history.ts:L125` | floating | `void next.finally(...)` | Low |
| 2 | `chat/orchestrator.ts:L1846` | floating | `void this.view?.finalizeAssistantMessage(...)` | Low |
| 3 | `main.ts:L1446` | floating | `void workspace.revealLeaf(...)` | Low |
| 4 | `main.ts:L1454` | floating | `void workspace.revealLeaf(...)` | Low |
| 5 | `settings/connection-test.ts:L32` | floating | Resolved by GUIDE-017 (remove spurious `async`) | Low |
| 6 | `settings/mcp-servers.ts:L569` | floating | `void emitChange()` | Low |
| 7 | `settings/provider-reference.ts:L62` | floating | `void navigator.clipboard...` | Low |
| 8 | `settings/provider-reference.ts:L110` | floating | `void navigator.clipboard...` | Low |
| 9 | `ui/chat-view.ts:L305` | floating | `void this.switchToConversation(...)` | Low |
| 10 | `ui/chat-view.ts:L332` | floating | `void this.app.workspace.revealLeaf(...)` | Low |
| 11 | `ui/chat-view.ts:L595` | floating | `void this.handleSend()` | Low |
| 12 | `ui/chat-view.ts:L1520` | floating | `void loadCheckpoints()` | Low |
| 13 | `ui/persona-picker.ts:L104` | floating | `void ...activatePersona(...).then(...).catch(err => log.error(...))` | Low-Medium |
| 14+15 | `chat/orchestrator.ts:L100,107,591,597` | misused | Widen callback types in ConversationManager | Medium |
| 16 | `mcp/mcp-hub.ts:L751` | misused | `setTimeout(() => void (async () => {...})(), delay)` | Low |
| 17 | `settings/mcp-servers.ts:L564-565` | misused | `() => void emitChange()` wrappers | Low |
| 18 | `settings/mcp-servers.ts:L569` | misused | `void emitChange()` (also fixes #6) | Low |
| 19 | `settings/mcp-servers.ts:L599` | misused | `() => void (async () => {...})()` | Low |
| 20 | `settings/mcp-servers.ts:L661` | misused | `() => void (async () => {...})()` | Low |
| 21 | `settings/mcp-servers.ts:L678` | misused | `() => void (async () => {...})()` | Low |
| 22 | `ui/chat-view.ts:L645` | misused | `() => void this.handleSend()` | Low |
| 23 | `ui/chat-view.ts:L1413` | misused | `() => void (async () => {...})()` | Low |
| 24 | `ui/chat-view.ts:L1517` | misused | `() => void loadCheckpoints()` | Low |
| 25 | `ui/chat-view.ts:L1549` | misused | `() => void (async () => { try {...} catch {...} })()` | Low-Medium |
| 26 | `ui/chat-view.ts:L1564` | misused | `() => void (async () => {...})()` | Low |
