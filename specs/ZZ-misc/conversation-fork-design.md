# Design: Conversation Forking

**Status:** Draft  
**Author:** Design spike  
**Date:** 2026-04-02

---

## 1. Motivation

Notor conversations are strictly linear and append-only. Once a conversation advances past a certain point, the user cannot revisit an earlier exchange and explore a different direction without manually creating a new conversation and re-typing context.

Conversation forking solves this by letting the user pick any message in an existing conversation and create a **new, independent conversation** containing all messages up to (and including) that point. The original conversation is untouched. The forked conversation is a fresh starting point the user can continue from.

**Use cases:**
- "The LLM went down the wrong path at message N — I want to rewind and try a different instruction."
- "I want to experiment with a different tool approach without losing the current thread."
- "I want to share just the first half of a conversation as a standalone thread."

---

## 2. Feasibility

### 2.1 Existing Infrastructure That Can Be Reused

The import/export system already implements the core operation: taking a `Conversation` header and a `Message[]` array and persisting them as a new JSONL file with fresh IDs.

| Component | File | Reusable Functionality |
|-----------|------|----------------------|
| `reassignIds()` | [`src/export/html-importer.ts:78-98`](../src/export/html-importer.ts) | Generates fresh UUID for conversation + all messages, preserves original timestamps. Fork reuses the **message ID reassignment pattern** but not the function itself — `reassignIds()` preserves `created_at`, whereas fork sets it to "now" (see §3.2 step 5). |
| `importConversation()` | [`src/chat/history.ts:230-256`](../src/chat/history.ts) | Batch-writes a conversation header + message array as a new JSONL file. Fork can call this directly. |
| `switchConversation()` | [`src/chat/orchestrator.ts:286`](../src/chat/orchestrator.ts) | Loads a JSONL file, populates in-memory state, re-renders all messages. Fork switches to the new conversation using this. |
| `loadConversation()` | [`src/chat/conversation.ts:137-147`](../src/chat/conversation.ts) | Loads conversation + messages into active memory. Already called by `switchConversation`. |

**Conclusion:** Forking is essentially "slice the current conversation's message array at a chosen point, apply the `reassignIds` pattern (with a fork-specific `created_at`), call `importConversation`, then `switchConversation`." No new persistence mechanisms are needed.

### 2.2 What Does Not Exist Yet

| Missing Piece | Scope |
|---------------|-------|
| Fork metadata on `Conversation` type | Two optional fields |
| `prepareFork()` method on `ConversationManager` | ~40 lines |
| `forkConversation()` method on `ChatOrchestrator` | ~15 lines |
| Right-click context menu on messages | ~30 lines in chat-view.ts |
| `data-message-id` attribute on message DOM elements | 4 lines across render methods |
| Fork lineage indicator in conversation list | ~10 lines |
| Callback wiring in `main.ts` | ~3 lines |

---

## 3. Design

### 3.1 Data Model Changes

**File: [`src/types.ts:12-70`](../src/types.ts) — `Conversation` interface**

Add two optional fields after the existing `use_extended_context` field (line 69):

```typescript
/**
 * ID of the conversation this was forked from (null/undefined for
 * non-forked conversations). Informational only — the parent
 * conversation is not structurally linked.
 */
forked_from_conversation_id?: string | null;

/**
 * ID of the message in the parent conversation that was the fork
 * point. Paired with `forked_from_conversation_id` for provenance.
 */
forked_from_message_id?: string | null;
```

These fields are optional and backward-compatible. Older JSONL files without them parse correctly — missing fields remain `undefined`, which is already the pattern used by workflow fields (lines 33-69) and extended context (lines 63-69).

**File: [`src/chat/history.ts:59-68`](../src/chat/history.ts) — `ConversationListEntry` interface**

Add one optional field:

```typescript
/** ID of the parent conversation if this was forked. */
forked_from_conversation_id?: string;
```

### 3.2 ConversationManager — `prepareFork()`

**File: [`src/chat/conversation.ts`](../src/chat/conversation.ts)**

Add a new public method to the `ConversationManager` class (after `loadConversation` at line 147):

```typescript
/**
 * Build fork data from the active conversation, slicing messages up to
 * and including the message with the given ID.
 *
 * Returns a new Conversation object and message array with fresh IDs,
 * ready for persistence via `HistoryManager.importConversation()`.
 *
 * Does NOT modify the active conversation state.
 *
 * The caller (ChatOrchestrator) passes the currently active provider,
 * model, and mode so the fork reflects the user's current session
 * settings rather than the parent conversation's (potentially stale)
 * values.
 *
 * @returns Fork data, or null if the message ID is not found.
 */
prepareFork(
    forkAtMessageId: string,
    currentProviderId: string,
    currentModelId: string,
    currentMode: ConversationMode
): {
    conversation: Conversation;
    messages: Message[];
} | null
```

**Implementation details:**

1. **Find the fork point.** Linear scan of `this.messages` for the message whose `id` matches `forkAtMessageId`. Return `null` if not found (message may have been compacted away).

2. **Slice messages.** Take `this.messages[0..forkIndex]` inclusive.

3. **Handle tool_call / tool_result pairing.** If the fork-point message has `role === "tool_call"`, scan forward for the next message with `role === "tool_result"` whose `tool_result.tool_call_id` matches the tool_call's effective ID. The effective ID is `tool_call.id ?? message.id` — the same fallback used by `toChatMessages` ([`src/chat/orchestrator.ts:1998`](../src/chat/orchestrator.ts)) since `ToolCall.id` is optional (`id?: string` at [`src/types.ts:146`](../src/types.ts)). If found (and it's the very next message), include it in the slice. This prevents orphaned tool calls that would break provider API calls when the user continues the forked conversation. The orchestrator's `toChatMessages` safety net (in [`src/chat/orchestrator.ts`](../src/chat/orchestrator.ts)) already injects synthetic "cancelled by user" tool_results for orphaned tool_calls, so even if the pairing is missed, the system degrades gracefully rather than erroring.

4. **Build the new Conversation.** Follows the same pattern as `createConversation()` ([`src/chat/conversation.ts:73-130`](../src/chat/conversation.ts)):

   ```typescript
   const now = new Date().toISOString();
   const newConversationId = crypto.randomUUID();

   // Title: prefer "Fork of {title}", fall back to first 8 chars of
   // parent conversation ID so the fork is identifiable.
   // Strip any existing "Fork of " prefix to prevent accumulation
   // when forking a fork (e.g., "Fork of Fork of X" → "Fork of X").
   const baseTitle = original.title?.replace(/^Fork of /, "")
       ?? original.id.substring(0, 8);
   const forkTitle = `Fork of ${baseTitle}`;

   const forkedConversation: Conversation = {
       id: newConversationId,
       // created_at is "now" (when the fork was created), NOT copied
       // from the parent. This differs from reassignIds() which
       // preserves the original created_at for full imports.
       created_at: now,
       updated_at: now,
       title: forkTitle,
       // Use the CURRENT session's provider, model, and mode — not
       // the parent conversation's values. The user may have changed
       // settings since the parent was created.
       provider_id: currentProviderId,
       model_id: currentModelId,
       mode: currentMode,
       // Re-sum tokens from sliced messages (not copied from parent)
       total_input_tokens: slicedMessages.reduce(
           (sum, m) => sum + (m.input_tokens ?? 0), 0
       ),
       total_output_tokens: slicedMessages.reduce(
           (sum, m) => sum + (m.output_tokens ?? 0), 0
       ),
       estimated_cost: slicedMessages.reduce(
           (sum, m) => sum + (m.cost_estimate ?? 0), 0
       ) || null,
       // Fork provenance
       forked_from_conversation_id: original.id,
       forked_from_message_id: forkAtMessageId,
       // Preserve ALL workflow metadata for provenance
       ...(original.workflow_path !== undefined && {
           workflow_path: original.workflow_path,
       }),
       ...(original.workflow_name !== undefined && {
           workflow_name: original.workflow_name,
       }),
       ...(original.persona_name !== undefined && {
           persona_name: original.persona_name,
       }),
       // Clear is_background — forked conversations are always foreground
       is_background: false,
       ...(original.use_extended_context && {
           use_extended_context: original.use_extended_context,
       }),
   };
   ```

5. **Assign fresh IDs.** Similar to `reassignIds()` in [`src/export/html-importer.ts:78-98`](../src/export/html-importer.ts), but note that `reassignIds()` is designed for full imports (preserves `created_at`), whereas forking sets `created_at` to "now" (see step 4). Only the message ID reassignment pattern is reused:

   ```typescript
   const newMessages = slicedMessages.map((msg) => ({
       ...msg,
       id: crypto.randomUUID(),
       conversation_id: newConversationId,
   }));
   ```

   **Note:** `crypto.randomUUID()` is used directly here (consistent with `reassignIds()` in `html-importer.ts`). The `ConversationManager` uses a local `generateId()` wrapper ([`src/chat/conversation.ts:18-19`](../src/chat/conversation.ts)) that delegates to `crypto.randomUUID()` — either approach is equivalent, and the implementation may use whichever is more convenient for the file's import structure.

   Original timestamps are preserved so the fork displays with its original chronology.

   **Provider tool_call ID preservation:** The spread operator preserves `tool_call.id` (provider-assigned, e.g. Bedrock `toolUseId`) and `tool_result.tool_call_id` on their respective messages. Only the message-level `id` is reassigned. This is correctness-critical — providers like Bedrock and Anthropic require `tool_call.id` and `tool_result.tool_call_id` to match when replaying conversation history. The spread-based reassignment preserves this correlation automatically.

6. **Return** `{ conversation: forkedConversation, messages: newMessages }`.

### 3.3 ChatOrchestrator — `forkConversation()`

**File: [`src/chat/orchestrator.ts`](../src/chat/orchestrator.ts)**

Add a new public method (alongside `newConversation` and `switchConversation`):

```typescript
/**
 * Fork the active conversation at the specified message.
 *
 * Creates a new independent conversation containing all messages up to
 * and including the fork point, persists it as a new JSONL file.
 *
 * Returns the filename and conversation object so the caller (main.ts)
 * can handle switching and post-switch wiring (checkpoint manager,
 * active conversation ID, stale tracker, vault rules). This mirrors
 * how switchConversation is wired in main.ts — the orchestrator
 * performs the data operation, and main.ts coordinates the side effects.
 *
 * Returns null if the fork-point message was not found.
 */
async forkConversation(forkAtMessageId: string): Promise<{
    filename: string;
    conversation: Conversation;
} | null> {
    const providerType = this.providerRegistry.getActiveType();
    const providerConfig = this.providerRegistry.getConfig(providerType);

    const forkData = this.conversationManager.prepareFork(
        forkAtMessageId,
        providerType,
        providerConfig.modelId,
        this.conversationManager.getActiveConversation()?.mode ?? "act"
    );
    if (!forkData) {
        new Notice("Cannot fork: message not found (it may have been compacted).");
        return null;
    }

    const filename = await this.historyManager.importConversation(
        forkData.conversation,
        forkData.messages
    );

    return { filename, conversation: forkData.conversation };
}
```

**Why the orchestrator does not call `switchConversation` itself:** The switch callback in [`src/main.ts:1449-1464`](../src/main.ts) performs critical post-switch wiring (`checkpointManager.setConversationId`, `view.setActiveConversationId`, stale tracker and vault rule cleanup). Having `forkConversation` call `switchConversation` internally would bypass this wiring. Instead, the caller in `main.ts` handles both the switch and the wiring (see §3.5).

### 3.4 Chat View — Fork UI

**File: [`src/ui/chat-view.ts`](../src/ui/chat-view.ts)**

#### 3.4.1 Message ID Tracking

Add a `data-message-id` attribute to each rendered message element so the context menu can identify the message.

**Note on assistant messages:** The `.notor-message-assistant` wrapper div is created in `createAssistantMessagePlaceholder()` ([`src/ui/chat-view.ts:1204`](../src/ui/chat-view.ts)), which returns only the inner `contentEl`. The message ID is not yet known at placeholder creation time (it's assigned after the LLM response completes). The ID must therefore be set in `finalizeAssistantMessage()` by navigating up to the parent element via `contentEl.parentElement`.

**Note on tool call messages:** `renderToolCall()` creates the tool call element *before* the tool is dispatched. A pending/running tool call should not be forkable (same rationale as the streaming assistant guard — the message is not yet "complete"). Therefore, `data-message-id` is **not** set in `renderToolCall()`. Instead, it is set by the orchestrator on the `toolEl` after dispatch completes, alongside the `updateToolCallStatus()` call. The orchestrator already has both the `toolEl` reference (returned by `renderToolCall()`) and the `message.id` at that point ([`src/chat/orchestrator.ts:1454-1459`](../src/chat/orchestrator.ts)).

| Method | Line | Element | Change |
|--------|------|---------|--------|
| `renderUserMessage()` | 1094 | `msgEl` (`.notor-message-user`) | `msgEl.dataset.messageId = message.id;` |
| `finalizeAssistantMessage()` | 1228 | `contentEl.parentElement` (the `.notor-message-assistant` wrapper created in `createAssistantMessagePlaceholder` at line 1204) | `contentEl.parentElement!.dataset.messageId = message.id;` |
| Orchestrator (after `updateToolCallStatus`) | ~1459 | `toolEl` (`.notor-tool-call`) | `toolEl.dataset.messageId = toolCallMessage.id;` — set in the orchestrator after dispatch completes, **not** in `renderToolCall()` |
| `renderToolResult()` | 1355 | `resultEl` (`.notor-tool-result`) | `resultEl.dataset.messageId = message.id;` |

#### 3.4.2 Context Menu

Register a single `contextmenu` listener on `this.messageListEl` (the scrollable message container) that uses event delegation to find the closest `[data-message-id]` ancestor of the click target.

**In-progress message guard:** The fork option must be suppressed for any message that is not yet "complete" — specifically, the **currently streaming** assistant message and any **pending/running tool call**. While a response is in progress, earlier (completed) messages in the conversation are still forkable — only in-progress elements are blocked. The guard works automatically via the `data-message-id` mechanism: both unfinalized assistant messages (ID set in `finalizeAssistantMessage()`) and pending tool calls (ID set by the orchestrator after dispatch completes — see §3.4.1) lack `data-message-id`, so they won't match `[data-message-id]` and the context menu won't fire for them.

```typescript
this.messageListEl.addEventListener("contextmenu", (evt: MouseEvent) => {
    const target = (evt.target as HTMLElement).closest("[data-message-id]");
    if (!target) return; // No message ID → unfinalized or non-message element

    const messageId = (target as HTMLElement).dataset.messageId;
    if (!messageId) return;

    evt.preventDefault();

    const menu = new Menu();
    menu.addItem((item) => {
        item.setTitle("Fork conversation from here")
            .setIcon("git-branch-plus")
            .onClick(() => {
                void this.onForkConversation?.(messageId);
            });
    });
    menu.showAtMouseEvent(evt);
});
```

This uses Obsidian's built-in `Menu` API (same API used by Obsidian's native context menus). The `"git-branch-plus"` icon is available in Obsidian's Lucide icon set.

#### 3.4.3 Fork Callback

Add a new callback following the existing pattern ([`src/ui/chat-view.ts:171-299`](../src/ui/chat-view.ts)):

```typescript
private onForkConversation?: (messageId: string) => Promise<void>;

setOnForkConversation(callback: (messageId: string) => Promise<void>): void {
    this.onForkConversation = callback;
}
```

#### 3.4.4 Fork Lineage in Conversation List

**File: [`src/ui/chat-view.ts`](../src/ui/chat-view.ts) — `renderConversationList()` method (lines 1545–1599)**

The conversation list is a sidebar panel toggled via the header "list" icon. Individual entries are rendered in `renderConversationList()`, where each `ConversationListEntry` becomes a `.notor-conversation-list-item` div. The title is set at line 1565 (`titleEl.textContent = entry.title ?? "Untitled"`).

Immediately after the title is set, when `entry.forked_from_conversation_id` is present, append a **clickable** fork lineage indicator. Clicking the badge navigates to the parent conversation. Before rendering the badge, verify the parent conversation still exists (it may have been deleted by the retention policy):

```typescript
if (entry.forked_from_conversation_id) {
    // Only show the badge if the parent conversation still exists
    // on the user's system (it may have been purged by retention).
    const parentExists = entries.some(
        (e) => e.id === entry.forked_from_conversation_id
    );
    if (parentExists) {
        const forkBadge = titleEl.createSpan({ cls: "notor-fork-badge" });
        setIcon(forkBadge, "git-branch-plus");
        forkBadge.setAttribute("aria-label", "Go to parent conversation");
        forkBadge.addEventListener("click", (e) => {
            e.stopPropagation(); // Don't trigger the item's own click handler
            const parent = entries.find(
                (e) => e.id === entry.forked_from_conversation_id
            );
            if (parent) {
                this.onSwitchConversation?.(parent.filename);
                this.toggleConversationList();
            }
        });
    }
}
```

**Note:** The `parentExists` check operates against the already-loaded `entries` array (which contains all conversations visible in the list). This is an O(n) scan per forked entry but is negligible given typical conversation counts. For the search path (`searchConversations`), the parent may not be in the filtered results — in that case, the badge is simply not shown, which is acceptable since the parent can still be found via the full list.

### 3.5 Wiring in main.ts

**File: [`src/main.ts`](../src/main.ts)**

In the view wiring section (where all other `setOn*` callbacks are registered, near [`src/main.ts:1449`](../src/main.ts)), add:

```typescript
view.setOnForkConversation(async (messageId: string) => {
    const result = await orchestrator.forkConversation(messageId);
    if (!result) return;

    // Switch to the forked conversation, then run the same post-switch
    // wiring as the regular switchConversation callback (lines 1449-1464).
    await orchestrator.switchConversation(result.filename);
    checkpointManager.setConversationId(result.conversation.id);
    view.setActiveConversationId(result.conversation.id);
    this.getStaleTracker().clear?.();
    this.getVaultRuleManager().clearAccessedNotes();

    new Notice(`Forked conversation: ${result.conversation.title ?? "Untitled"}`);
});
```

**Note:** This intentionally mirrors the post-switch wiring in the existing `setOnSwitchConversation` callback. The duplication is acceptable because fork is the only other path that triggers a conversation switch programmatically (imports go through a separate modal flow).

### 3.6 HistoryManager — Extract Fork Metadata

**File: [`src/chat/history.ts`](../src/chat/history.ts)**

In `listConversations()` at line 410-419, where the `ConversationListEntry` is assembled, add the fork field:

```typescript
entries.push({
    id: convId,
    title: headerObj.title as string | undefined,
    updated_at: convUpdatedAt,
    created_at: convCreatedAt,
    preview,
    provider_id: convProviderId,
    model_id: convModelId,
    filename,
    // Fork provenance (undefined if not a fork)
    forked_from_conversation_id: headerObj.forked_from_conversation_id as string | undefined,
});
```

**Important:** The same field extraction must also be applied in `searchConversations()` ([`src/chat/history.ts:439`](../src/chat/history.ts)), which has an identical entry-building block at lines 502–511. Both `listConversations()` and `searchConversations()` must include `forked_from_conversation_id` in their `entries.push(...)` calls for the fork badge to appear consistently regardless of whether the user is browsing or searching.

### 3.7 CSS

**File: [`styles.css`](../styles.css)**

```css
.notor-fork-badge {
    margin-left: 4px;
    opacity: 0.5;
    font-size: 0.85em;
    cursor: pointer;
}

.notor-fork-badge:hover {
    opacity: 0.8;
}
```

---

## 4. Edge Cases

### 4.1 Fork at a `tool_call` Message

If the fork-point message has `role === "tool_call"`, the LLM provider expects a paired `tool_result` in the conversation history. Without it, the next API call after the user continues the fork would fail.

**Solution:** `prepareFork()` auto-extends the slice to include the paired `tool_result` if it is the immediately following message (see §3.2 step 3). If no paired result exists (tool was never executed), the orchestrator's existing `toChatMessages` safety net ([`src/chat/orchestrator.ts:2028-2054`](../src/chat/orchestrator.ts)) injects a synthetic "cancelled by user" tool_result, so the fork still works.

**Multi-tool-call sequences:** The LLM can issue multiple consecutive tool calls (e.g., `tool_call A` → `tool_result A` → `tool_call B` → `tool_result B`). The fork slices at the **exact** user-selected message — no lookahead beyond the single tool_call/tool_result pairing rule:

| Fork point | Slice includes | Notes |
|------------|---------------|-------|
| `tool_call A` | …through `tool_result A` (auto-extended) | `tool_call B` and beyond are excluded |
| `tool_result A` | …through `tool_result A` exactly | `tool_call B` is excluded; this is a clean boundary |
| `tool_call B` | …through `tool_result B` (auto-extended) | Full sequence included |

**Interaction with `toChatMessages`:** The `toChatMessages` safety net operates on the `ChatMessage[]` sent to the provider, not on the persisted `Message[]`. If a fork ends up with an orphaned `tool_call` (e.g., the auto-extension didn't find a paired result), the safety net injects a synthetic `tool_result` at provider-call time. The orphaned `tool_call` is still persisted in the JSONL — it's only patched in-memory during the API call.

**E2E test coverage required:** Given the complexity of tool_call boundaries, the following scenarios must be covered by dedicated E2E tests:

1. Fork at a `tool_call` message → verify the paired `tool_result` is included in fork JSONL
2. Fork at a `tool_result` message → verify the next `tool_call` (if any) is NOT included
3. Fork at a `tool_call` with no paired result (interrupted execution) → verify the fork is still continuable (safety net injects synthetic result)
4. Fork in the middle of a multi-tool sequence → verify only messages up to and including the fork point (+ auto-extension) are present
5. Continue a forked conversation after a tool_call boundary → verify the LLM receives a valid message sequence and responds without error

### 4.2 Compacted Conversations

When a conversation has been compacted ([`src/context/compaction.ts`](../src/context/compaction.ts)), older messages are replaced by a compaction summary (a system message with `CompactionRecord` JSON). The compacted-away messages no longer exist in the in-memory `messages[]` array.

- **Forking after compaction:** The fork contains the compaction summary + all messages from the summary onward up to the fork point. This is correct — the summary represents the available context.
- **Compaction summary content:** The compaction summary system message contains a serialized `CompactionRecord` JSON that references the *original* conversation's ID. This is left as-is in the fork — the summary is purely informational context for the LLM and does not need to reference the fork's conversation ID.
- **Forking at a compacted-away message:** The message ID will not be found in the array. `prepareFork()` returns `null`, and the user sees a notice: "Cannot fork: message not found (it may have been compacted)."

### 4.3 Workflow Conversations

Workflow conversations ([`src/types.ts:33-62`](../src/types.ts)) have `workflow_path`, `workflow_name`, `persona_name`, and `is_background` fields.

- `workflow_path`, `workflow_name`, and `persona_name` are all preserved in the fork for provenance tracking.
- `is_background` is cleared to `false` — the fork is always a foreground conversation.
- `is_workflow_message` flag on the first user message is preserved, so the `<workflow_instructions>` block still renders correctly in the fork.
- No persona switch is triggered — forking is a data operation, not a workflow execution.

### 4.4 Checkpoints

Checkpoints ([`src/checkpoints/checkpoint.ts`](../src/checkpoints/checkpoint.ts)) are scoped to `conversation_id` and reference specific `message_id` values. Copying them to the fork would create checkpoints pointing to message IDs that no longer match (since all IDs are regenerated).

**Decision:** Do not copy checkpoints. The forked conversation generates its own checkpoints as the user continues working.

### 4.5 Hook Injection Messages

Messages with `is_hook_injection: true` are rendered differently in the UI ([`src/ui/chat-view.ts:1095-1097`](../src/ui/chat-view.ts) dispatches to `renderHookInjection` at [`src/ui/chat-view.ts:1181-1188`](../src/ui/chat-view.ts)). The `is_hook_injection` flag is preserved during fork (it's part of the message spread), so these messages render correctly in the forked conversation. The context menu is not shown on hook injection messages because `renderHookInjection` does not set `data-message-id`, so the `[data-message-id]` event delegation in the context menu handler (§3.4.2) naturally skips these elements.

### 4.6 System Messages

System messages are not rendered in the chat view, so no context menu appears on them. They are naturally included in the fork if they fall within the sliced range.

**Runtime behavior:** The forked JSONL will contain the parent conversation's system message (which may include stale vault rules, persona instructions, etc.). This is harmless because `toChatMessages()` ([`src/chat/orchestrator.ts:1957`](../src/chat/orchestrator.ts)) replaces the content of any `role === "system"` message with a freshly built system prompt on every LLM call. The persisted system message serves only as a historical record of what the LLM saw at the time.

### 4.7 Empty Fork (Fork at First Message)

If the user forks at the very first message, the fork contains exactly one message. This is valid and should work — the user can continue from there.

### 4.8 Token/Cost Recalculation

The forked conversation's `total_input_tokens`, `total_output_tokens`, and `estimated_cost` are **re-summed** from the sliced messages, not copied from the parent. This ensures accuracy since the parent's totals include messages after the fork point.

### 4.9 Imported Conversations

Any conversation loaded into the user's system can be forked, including conversations imported from HTML exports. Imported conversations have already been through `reassignIds()`, so their IDs are local. The fork's `forked_from_conversation_id` will reference the *imported copy's* ID (not the original pre-import ID), which is the correct behavior since that's the version the user has on their system.

### 4.10 Forking During Active Streaming or Tool Execution

While the assistant is streaming a response or a tool call is pending/executing, the user may still fork from any **earlier, completed** message in the conversation. Only in-progress elements are blocked from forking:

- **Streaming assistant message:** The ID is set in `finalizeAssistantMessage()`, so unfinalized messages have no `data-message-id` attribute and the context menu won't fire for them.
- **Pending/running tool call:** The ID is set by the orchestrator after dispatch completes (alongside `updateToolCallStatus()`), so pending tool calls have no `data-message-id` attribute either.

Both guards use the same `data-message-id` absence mechanism (see §3.4.2).

### 4.11 Fork Badge and Deleted Parent Conversations

The fork badge in the conversation list (§3.4.4) is only displayed when the parent conversation still exists in the user's history. If the parent has been purged by the retention policy or manually deleted, the badge is not rendered. The `forked_from_conversation_id` metadata remains on the fork's JSONL header for historical reference, but no UI element references a nonexistent conversation.

### 4.12 Truncated Messages

Messages in the parent conversation may have `truncated: true` set by the context window manager. This flag is copied into the fork via the spread operator. This is **harmless**: `assembleContextWindow()` ([`src/context/context.ts:120-122`](../src/chat/context.ts)) resets all `truncated` flags to `false` before recalculating on every LLM call. The stale `truncated` value in the fork's JSONL is overwritten in-memory before it has any effect.

---

## 5. What This Design Intentionally Does NOT Do

| Omission | Rationale |
|----------|-----------|
| **No conversation tree structure** | Forked conversations are fully independent. The `forked_from_*` fields are informational metadata, not structural links. Building a tree would add significant complexity for marginal UX gain. |
| **No "edit and regenerate" inline** | Forking replaces this by creating a fresh conversation. A future "edit message" feature could build on the same `data-message-id` infrastructure. |
| **No multi-fork tracking UI** | No tree visualization or branch navigator. The conversation list shows a clickable fork badge that navigates to the parent (see §3.4.4). If users want to see all forks *of* a conversation, they can search by the original title. |
| **No checkpoint migration** | See §4.4. |
| **No forking of conversations not actively loaded** | The user must load the conversation first (which they'd need to do anyway to pick a fork point). Any loaded conversation — including imports — can be forked (see §4.9). |

---

## 6. Testing Strategy

### 6.1 Unit Tests (Vitest)

**`ConversationManager.prepareFork()`:**
- Correct message slicing at various positions (first, middle, last)
- All IDs are fresh UUIDs, distinct from originals
- `conversation_id` on all messages matches the new conversation ID
- Token/cost totals are re-summed from sliced messages
- Fork metadata (`forked_from_conversation_id`, `forked_from_message_id`) is set correctly
- Tool call pairing: fork at `tool_call` includes paired `tool_result`
- Tool call pairing: fork at `tool_result` does NOT include next `tool_call`
- Multi-tool sequence: fork mid-sequence includes only messages up to fork point (+ auto-extension)
- Returns `null` for unknown message ID
- Preserves original timestamps on messages
- Preserves workflow metadata (`workflow_path`, `workflow_name`, `persona_name`), clears `is_background`
- Title is `"Fork of {original}"` when original has a title
- Title falls back to `"Fork of {first 8 chars of conversation ID}"` when original has no title
- Uses passed-in `currentProviderId`, `currentModelId`, and `currentMode` (not parent values)
- `created_at` is set to "now", not copied from parent

### 6.2 E2E Test (Playwright script in [`e2e/scripts/`](../e2e/scripts/))

> **Implementation note:** Use the `/write-e2e-test` command to guide the AI through writing these tests. The command encodes this repo's E2E conventions (helper utilities, fixture setup, assertion patterns, script naming) and ensures the resulting test scripts are consistent with the existing suite in `e2e/scripts/`.

**Core fork functionality:**
1. Create a conversation with several user/assistant exchanges
2. Fork at message N
3. Verify the fork JSONL file exists with correct message count
4. Verify all IDs in the fork are fresh (no overlap with original)
5. Verify the original conversation JSONL is byte-identical (unchanged)
6. Verify the fork can be continued (send a new message → get response)
7. Verify the conversation list shows the fork with lineage indicator
8. Verify forking a compacted conversation includes the compaction summary

**Tool call boundary tests (see §4.1):**
9. Fork at a `tool_call` message → verify the paired `tool_result` is included in fork JSONL
10. Fork at a `tool_result` message → verify the next `tool_call` (if any) is NOT included
11. Fork at a `tool_call` with no paired result → verify the fork is continuable (send a message → get valid response)
12. Fork in the middle of a multi-tool sequence → verify exact message count matches expectation
13. Continue a forked conversation after a tool_call boundary → verify the LLM responds without API errors

**Fork badge and navigation:**
14. Verify the fork badge is clickable and navigates to the parent conversation
15. Delete the parent conversation → verify the fork badge is no longer shown
16. Fork an imported conversation → verify `forked_from_conversation_id` references the import's local ID

**Streaming and in-progress message interaction:**
17. While assistant is streaming, right-click an earlier completed message → verify "Fork conversation from here" appears
18. While assistant is streaming, right-click the in-progress message → verify no context menu appears
19. While a tool call is pending/executing, right-click the pending tool call element → verify no context menu appears
20. While a tool call is pending/executing, right-click an earlier completed message → verify "Fork conversation from here" appears

### 6.3 Manual Testing

- Right-click a user message → "Fork conversation from here" → verify fork opens with correct history
- Right-click an assistant message → same flow
- Right-click a tool call → verify tool_result is included
- Check conversation list shows fork badge; click it → navigates to parent
- Continue chatting in the fork → verify messages are independent of original
- Switch back to original → verify it's unchanged
- Fork a workflow conversation → verify workflow metadata preserved (including `persona_name`)
- Fork with a different provider/model selected → verify fork header uses current session values, not parent's
