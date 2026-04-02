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
| `reassignIds()` | [`src/export/html-importer.ts:78-98`](../src/export/html-importer.ts) | Generates fresh UUID for conversation + all messages, preserves original timestamps. Fork needs this exact pattern. |
| `importConversation()` | [`src/chat/history.ts:230-256`](../src/chat/history.ts) | Batch-writes a conversation header + message array as a new JSONL file. Fork can call this directly. |
| `switchConversation()` | [`src/chat/orchestrator.ts:286`](../src/chat/orchestrator.ts) | Loads a JSONL file, populates in-memory state, re-renders all messages. Fork switches to the new conversation using this. |
| `loadConversation()` | [`src/chat/conversation.ts:137-147`](../src/chat/conversation.ts) | Loads conversation + messages into active memory. Already called by `switchConversation`. |

**Conclusion:** Forking is essentially "slice the current conversation's message array at a chosen point, run `reassignIds`, call `importConversation`, then `switchConversation`." No new persistence mechanisms are needed.

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
 * @returns Fork data, or null if the message ID is not found.
 */
prepareFork(forkAtMessageId: string): {
    conversation: Conversation;
    messages: Message[];
} | null
```

**Implementation details:**

1. **Find the fork point.** Linear scan of `this.messages` for the message whose `id` matches `forkAtMessageId`. Return `null` if not found (message may have been compacted away).

2. **Slice messages.** Take `this.messages[0..forkIndex]` inclusive.

3. **Handle tool_call / tool_result pairing.** If the fork-point message has `role === "tool_call"`, scan forward for the next message with `role === "tool_result"` whose `tool_result.tool_call_id` matches the tool_call's `tool_call.id`. If found (and it's the very next message), include it in the slice. This prevents orphaned tool calls that would break provider API calls when the user continues the forked conversation. The orchestrator's `toChatMessages` safety net (in [`src/chat/orchestrator.ts`](../src/chat/orchestrator.ts)) already injects synthetic "cancelled by user" tool_results for orphaned tool_calls, so even if the pairing is missed, the system degrades gracefully rather than erroring.

4. **Build the new Conversation.** Follows the same pattern as `createConversation()` ([`src/chat/conversation.ts:73-130`](../src/chat/conversation.ts)):

   ```typescript
   const now = new Date().toISOString();
   const newConversationId = crypto.randomUUID();

   const forkedConversation: Conversation = {
       id: newConversationId,
       created_at: now,
       updated_at: now,
       title: original.title ? `Fork of ${original.title}` : undefined,
       provider_id: original.provider_id,
       model_id: original.model_id,
       mode: original.mode,
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
       // Preserve workflow metadata for provenance
       ...(original.workflow_path !== undefined && {
           workflow_path: original.workflow_path,
       }),
       ...(original.workflow_name !== undefined && {
           workflow_name: original.workflow_name,
       }),
       // Clear is_background — forked conversations are always foreground
       is_background: false,
       ...(original.use_extended_context && {
           use_extended_context: original.use_extended_context,
       }),
   };
   ```

5. **Assign fresh IDs.** Same pattern as `reassignIds()` in [`src/export/html-importer.ts:78-98`](../src/export/html-importer.ts):

   ```typescript
   const newMessages = slicedMessages.map((msg) => ({
       ...msg,
       id: crypto.randomUUID(),
       conversation_id: newConversationId,
   }));
   ```

   Original timestamps are preserved so the fork displays with its original chronology.

6. **Return** `{ conversation: forkedConversation, messages: newMessages }`.

### 3.3 ChatOrchestrator — `forkConversation()`

**File: [`src/chat/orchestrator.ts`](../src/chat/orchestrator.ts)**

Add a new public method (alongside `newConversation` and `switchConversation`):

```typescript
/**
 * Fork the active conversation at the specified message.
 *
 * Creates a new independent conversation containing all messages up to
 * and including the fork point, persists it as a new JSONL file, and
 * switches to it.
 */
async forkConversation(forkAtMessageId: string): Promise<void> {
    const forkData = this.conversationManager.prepareFork(forkAtMessageId);
    if (!forkData) {
        new Notice("Cannot fork: message not found (it may have been compacted).");
        return;
    }

    const filename = await this.historyManager.importConversation(
        forkData.conversation,
        forkData.messages
    );

    await this.switchConversation(filename);
    new Notice(`Forked conversation: ${forkData.conversation.title ?? "Untitled"}`);
}
```

This follows the exact same pattern used by the import flow in [`src/main.ts:353-359`](../src/main.ts) and [`src/main.ts:1476-1483`](../src/main.ts).

### 3.4 Chat View — Fork UI

**File: [`src/ui/chat-view.ts`](../src/ui/chat-view.ts)**

#### 3.4.1 Message ID Tracking

Add a `data-message-id` attribute to each rendered message element so the context menu can identify the message. Four touch points:

| Method | Line | Element | Change |
|--------|------|---------|--------|
| `renderUserMessage()` | 1087 | `msgEl` (`.notor-message-user`) | `msgEl.dataset.messageId = message.id;` |
| `finalizeAssistantMessage()` | 1215 | The parent `.notor-message-assistant` div | `parentEl.dataset.messageId = message.id;` |
| `renderToolCall()` | 1308 | `toolEl` (`.notor-tool-call`) | `toolEl.dataset.messageId = message.id;` |
| `renderToolResult()` | 1346 | `resultEl` (`.notor-tool-result`) | `resultEl.dataset.messageId = message.id;` |

#### 3.4.2 Context Menu

Register a single `contextmenu` listener on `this.messageListEl` (the scrollable message container) that uses event delegation to find the closest `[data-message-id]` ancestor of the click target:

```typescript
this.messageListEl.addEventListener("contextmenu", (evt: MouseEvent) => {
    const target = (evt.target as HTMLElement).closest("[data-message-id]");
    if (!target) return;

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

In the conversation list rendering section (where `entries.push(...)` builds list items from `ConversationListEntry[]`), when `entry.forked_from_conversation_id` is present, append a subtle visual indicator:

```typescript
if (entry.forked_from_conversation_id) {
    const forkBadge = titleEl.createSpan({ cls: "notor-fork-badge" });
    forkBadge.textContent = "⑂"; // or use setIcon("git-branch-plus")
}
```

### 3.5 Wiring in main.ts

**File: [`src/main.ts`](../src/main.ts)**

In the view wiring section (where all other `setOn*` callbacks are registered), add:

```typescript
view.setOnForkConversation(async (messageId: string) => {
    await orchestrator.forkConversation(messageId);
});
```

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

Apply the same extraction in `searchConversations()` which has an identical entry-building block.

### 3.7 CSS

**File: [`styles.css`](../styles.css)**

```css
.notor-fork-badge {
    margin-left: 4px;
    opacity: 0.5;
    font-size: 0.85em;
}
```

---

## 4. Edge Cases

### 4.1 Fork at a `tool_call` Message

If the fork-point message has `role === "tool_call"`, the LLM provider expects a paired `tool_result` in the conversation history. Without it, the next API call after the user continues the fork would fail.

**Solution:** `prepareFork()` auto-extends the slice to include the paired `tool_result` if it is the immediately following message (see §3.2 step 3). If no paired result exists (tool was never executed), the orchestrator's existing `toChatMessages` safety net injects a synthetic "cancelled by user" tool_result, so the fork still works.

### 4.2 Compacted Conversations

When a conversation has been compacted ([`src/context/compaction.ts`](../src/context/compaction.ts)), older messages are replaced by a compaction summary (a system message with `CompactionRecord` JSON). The compacted-away messages no longer exist in the in-memory `messages[]` array.

- **Forking after compaction:** The fork contains the compaction summary + all messages from the summary onward up to the fork point. This is correct — the summary represents the available context.
- **Forking at a compacted-away message:** The message ID will not be found in the array. `prepareFork()` returns `null`, and the user sees a notice: "Cannot fork: message not found (it may have been compacted)."

### 4.3 Workflow Conversations

Workflow conversations ([`src/types.ts:33-62`](../src/types.ts)) have `workflow_path`, `workflow_name`, `persona_name`, and `is_background` fields.

- `workflow_path` and `workflow_name` are preserved in the fork for provenance tracking.
- `is_background` is cleared to `false` — the fork is always a foreground conversation.
- `is_workflow_message` flag on the first user message is preserved, so the `<workflow_instructions>` block still renders correctly in the fork.
- No persona switch is triggered — forking is a data operation, not a workflow execution.

### 4.4 Checkpoints

Checkpoints ([`src/checkpoints/checkpoint.ts`](../src/checkpoints/checkpoint.ts)) are scoped to `conversation_id` and reference specific `message_id` values. Copying them to the fork would create checkpoints pointing to message IDs that no longer match (since all IDs are regenerated).

**Decision:** Do not copy checkpoints. The forked conversation generates its own checkpoints as the user continues working.

### 4.5 Hook Injection Messages

Messages with `is_hook_injection: true` are rendered differently in the UI ([`src/ui/chat-view.ts:1082-1084`](../src/ui/chat-view.ts)). The `is_hook_injection` flag is preserved during fork (it's part of the message spread), so these messages render correctly in the forked conversation. The context menu is not shown on hook injection messages since they are rendered as collapsed `<details>` elements without the standard message wrapper.

### 4.6 System Messages

System messages are not rendered in the chat view, so no context menu appears on them. They are naturally included in the fork if they fall within the sliced range.

### 4.7 Empty Fork (Fork at First Message)

If the user forks at the very first message, the fork contains exactly one message. This is valid and should work — the user can continue from there.

### 4.8 Token/Cost Recalculation

The forked conversation's `total_input_tokens`, `total_output_tokens`, and `estimated_cost` are **re-summed** from the sliced messages, not copied from the parent. This ensures accuracy since the parent's totals include messages after the fork point.

---

## 5. What This Design Intentionally Does NOT Do

| Omission | Rationale |
|----------|-----------|
| **No conversation tree structure** | Forked conversations are fully independent. The `forked_from_*` fields are informational metadata, not structural links. Building a tree would add significant complexity for marginal UX gain. |
| **No "edit and regenerate" inline** | Forking replaces this by creating a fresh conversation. A future "edit message" feature could build on the same `data-message-id` infrastructure. |
| **No forking of a conversation you're not actively viewing** | The user must load the conversation first (which they'd need to do anyway to pick a fork point). |
| **No multi-fork tracking UI** | No tree visualization or branch navigator. The conversation list shows a simple fork badge. If users want to see all forks of a conversation, they can search by the original title. |
| **No checkpoint migration** | See §4.4. |

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
- Returns `null` for unknown message ID
- Preserves original timestamps on messages
- Preserves workflow metadata, clears `is_background`
- Title is `"Fork of {original}"`

### 6.2 E2E Test (Playwright script in [`e2e/scripts/`](../e2e/scripts/))

1. Create a conversation with several user/assistant exchanges
2. Fork at message N
3. Verify the fork JSONL file exists with correct message count
4. Verify all IDs in the fork are fresh (no overlap with original)
5. Verify the original conversation JSONL is byte-identical (unchanged)
6. Verify the fork can be continued (send a new message → get response)
7. Verify the conversation list shows the fork with lineage indicator
8. Verify forking a compacted conversation includes the compaction summary

### 6.3 Manual Testing

- Right-click a user message → "Fork conversation from here" → verify fork opens with correct history
- Right-click an assistant message → same flow
- Right-click a tool call → verify tool_result is included
- Check conversation list shows fork badge
- Continue chatting in the fork → verify messages are independent of original
- Switch back to original → verify it's unchanged
- Fork a workflow conversation → verify workflow metadata preserved
