# Implementation Plan: Conversation Forking

**Design doc:** [conversation-fork-design.md](conversation-fork-design.md)  
**Date:** 2026-04-03  
**Status:** Ready for implementation

---

## Phase 1: Data Model & Core Fork Logic

The foundation — add fork metadata to types and implement the core `prepareFork()` method that slices messages and builds the forked conversation object. No UI or wiring yet; this phase is fully unit-testable in isolation.

### 1.1 Add fork fields to `Conversation` type
- [ ] Add `forked_from_conversation_id?: string | null` to `Conversation` interface in [types.ts:69](../src/types.ts) (after `use_extended_context`)
- [ ] Add `forked_from_message_id?: string | null` to `Conversation` interface in [types.ts:69](../src/types.ts)

### 1.2 Add fork field to `ConversationListEntry`
- [ ] Add `forked_from_conversation_id?: string` to `ConversationListEntry` in [history.ts:59-68](../src/chat/history.ts)

### 1.3 Implement `ConversationManager.prepareFork()`
- [ ] Add `prepareFork(forkAtMessageId, currentProviderId, currentModelId, currentMode)` method to `ConversationManager` class in [conversation.ts](../src/chat/conversation.ts) (after `loadConversation` at line ~147)
- [ ] Implement message slice — linear scan for `forkAtMessageId`, return `null` if not found
- [ ] Implement tool_call/tool_result auto-pairing — if fork-point message has `role === "tool_call"`, scan forward for the paired `tool_result` whose `tool_call_id` matches (`tool_call.id ?? message.id` fallback per [orchestrator.ts:1998](../src/chat/orchestrator.ts))
- [ ] Build new `Conversation` object with:
  - Fresh UUID via `crypto.randomUUID()`
  - `created_at` / `updated_at` set to "now" (not copied from parent)
  - Title: `"Fork of {baseTitle}"` with `"Fork of "` prefix stripping to prevent accumulation
  - Uses caller-provided `currentProviderId`, `currentModelId`, `currentMode`
  - Re-summed `total_input_tokens`, `total_output_tokens`, `estimated_cost` from sliced messages
  - Fork provenance: `forked_from_conversation_id`, `forked_from_message_id`
  - Spread workflow metadata (`workflow_path`, `workflow_name`, `persona_name`) from parent
  - `is_background: false` always
  - Conditionally spread `use_extended_context`
- [ ] Assign fresh message IDs — `crypto.randomUUID()` for each message's `id`, set `conversation_id` to new conversation ID, preserve all other fields (timestamps, tool_call.id, tool_result.tool_call_id) via spread
- [ ] Return `{ conversation, messages }` or `null`

### 1.4 Extract fork metadata in `HistoryManager`
- [ ] In `listConversations()` ([history.ts](../src/chat/history.ts) ~line 410-419), add `forked_from_conversation_id: headerObj.forked_from_conversation_id as string | undefined` to the `entries.push(...)` call
- [ ] In `searchConversations()` ([history.ts](../src/chat/history.ts) ~line 502-511), add the same `forked_from_conversation_id` field to its `entries.push(...)` call

---

## Phase 2: Orchestrator & main.ts Wiring

Connect the core logic to the orchestrator and wire the fork callback through main.ts. After this phase, forking works programmatically (callable from dev console) but has no UI trigger yet.

### 2.1 Implement `ChatOrchestrator.forkConversation()`
- [ ] Add `forkConversation(forkAtMessageId: string)` method to `ChatOrchestrator` in [orchestrator.ts](../src/chat/orchestrator.ts) (alongside `newConversation` and `switchConversation`)
- [ ] Get current provider type and config from `this.providerRegistry`
- [ ] Get current mode from `this.conversationManager.getActiveConversation()?.mode`
- [ ] Call `this.conversationManager.prepareFork(...)` — return `null` with `Notice` if fork data is null
- [ ] Call `this.historyManager.importConversation(forkData.conversation, forkData.messages)` to persist
- [ ] Return `{ filename, conversation }` (do NOT call `switchConversation` internally — main.ts handles post-switch wiring)

### 2.2 Add fork callback to `ChatView`
- [ ] Add `private onForkConversation?: (messageId: string) => Promise<void>` property to `NotorChatView` in [chat-view.ts](../src/ui/chat-view.ts)
- [ ] Add `setOnForkConversation(callback)` setter method in the callback setters section (~line 171-299)

### 2.3 Wire fork callback in `main.ts`
- [ ] In the view wiring section of [main.ts](../src/main.ts) (~line 1449), register `view.setOnForkConversation(...)` callback
- [ ] Callback implementation:
  - Call `orchestrator.forkConversation(messageId)`
  - If result is null, return early
  - Call `orchestrator.switchConversation(result.filename)`
  - Run post-switch wiring: `checkpointManager.setConversationId(...)`, `view.setActiveConversationId(...)`, stale tracker clear, vault rule clear
  - Show `Notice` with fork title

---

## Phase 3: Message ID Tracking & Fork UI

Add `data-message-id` attributes to rendered messages and implement both the context menu and hover fork button. This is the user-facing surface.

### 3.1 Set `data-message-id` on rendered messages
- [ ] In `renderUserMessage()` ([chat-view.ts](../src/ui/chat-view.ts) ~line 1094): set `msgEl.dataset.messageId = message.id` on the `.notor-message-user` element
- [ ] In `finalizeAssistantMessage()` ([chat-view.ts](../src/ui/chat-view.ts) ~line 1228): set `contentEl.parentElement!.dataset.messageId = message.id` on the `.notor-message-assistant` wrapper (ID not known at placeholder creation time)
- [ ] In orchestrator after tool dispatch completes ([orchestrator.ts](../src/chat/orchestrator.ts) ~line 1454-1459): set `toolEl.dataset.messageId = toolCallMessage.id` on the `.notor-tool-call` element alongside `updateToolCallStatus()` — NOT in `renderToolCall()` (pending tool calls should not be forkable)
- [ ] In `renderToolResult()` ([chat-view.ts](../src/ui/chat-view.ts) ~line 1355): set `resultEl.dataset.messageId = message.id` on the `.notor-tool-result` element
- [ ] Verify: `renderHookInjection()` does NOT set `data-message-id` (hook injections are not forkable — this should already be the case since the method doesn't set it)

### 3.2 Add hover fork button to messages
- [ ] Create a helper method (e.g., `appendForkButton(msgEl)`) that:
  - Creates a `div` with class `notor-fork-btn`
  - Sets `git-branch-plus` icon via Obsidian's `setIcon()`
  - Sets `aria-label: "Fork conversation from here"`
  - Adds click handler that reads `msgEl.dataset.messageId` and calls `this.onForkConversation?.(messageId)`
  - Stops click propagation
- [ ] Call `appendForkButton()` in `renderUserMessage()` after setting `data-message-id`
- [ ] Call `appendForkButton()` in `finalizeAssistantMessage()` after setting `data-message-id` (on `contentEl.parentElement`)
- [ ] Call `appendForkButton()` in orchestrator after setting `data-message-id` on tool call elements
- [ ] Call `appendForkButton()` in `renderToolResult()` after setting `data-message-id`

### 3.3 Add context menu via event delegation
- [ ] Register a single `contextmenu` event listener on `this.messageListEl` (the scrollable message container)
- [ ] Use event delegation: find closest `[data-message-id]` ancestor of click target
- [ ] If no match (unfinalized message or non-message element), return without preventing default
- [ ] Create Obsidian `Menu` with "Fork conversation from here" item (`git-branch-plus` icon)
- [ ] On click: call `this.onForkConversation?.(messageId)`
- [ ] Call `menu.showAtMouseEvent(evt)` and `evt.preventDefault()`

---

## Phase 4: Conversation List Fork Badge

Show a clickable fork lineage badge next to forked conversations in the sidebar list, enabling navigation to the parent conversation.

### 4.1 Render fork badge in conversation list
- [ ] In `renderConversationList()` ([chat-view.ts](../src/ui/chat-view.ts) ~line 1545-1599), after setting `titleEl.textContent`:
  - Check if `entry.forked_from_conversation_id` is present
  - Verify parent still exists by scanning the `entries` array
  - If parent exists, create a `span` with class `notor-fork-badge`
  - Set `git-branch-plus` icon via `setIcon()`
  - Set `aria-label: "Go to parent conversation"`
  - Add click handler: `stopPropagation()`, find parent entry by ID, call `this.onSwitchConversation?.(parent.filename)`, toggle conversation list closed

---

## Phase 5: CSS Styling

Add styles for the fork badge in the conversation list and the hover fork button on messages.

### 5.1 Fork badge styles
- [ ] Add `.notor-fork-badge` styles to [styles.css](../styles.css): `margin-left: 4px`, `opacity: 0.5`, `font-size: 0.85em`, `cursor: pointer`
- [ ] Add `.notor-fork-badge:hover` styles: `opacity: 0.8`

### 5.2 Hover fork button styles
- [ ] Ensure `.notor-message` (or equivalent message wrapper classes) has `position: relative`
- [ ] Add `.notor-fork-btn` styles: `position: absolute`, `top: 4px`, `right: 4px`, `opacity: 0`, `cursor: pointer`, `padding: 2px`, `border-radius: var(--radius-s)`, `transition: opacity 150ms ease`
- [ ] Add `.notor-message:hover .notor-fork-btn` (or per-role selectors as needed): `opacity: 0.4`
- [ ] Add `.notor-fork-btn:hover`: `opacity: 0.8`, `background: var(--background-modifier-hover)`

---

## Phase 6: Unit Tests

Test `prepareFork()` thoroughly in isolation. These tests validate the core slicing, ID reassignment, metadata, and edge case logic without needing UI or persistence.

### 6.1 Create test file
- [ ] Create `src/chat/conversation.test.ts` (or add to existing test file if one exists for `ConversationManager`)

### 6.2 Basic slicing tests
- [ ] Test: fork at first message — fork contains exactly 1 message
- [ ] Test: fork at middle message — fork contains messages 0..N inclusive
- [ ] Test: fork at last message — fork contains all messages

### 6.3 ID reassignment tests
- [ ] Test: all message IDs in fork are fresh UUIDs, none match originals
- [ ] Test: `conversation_id` on every message matches the new conversation's ID
- [ ] Test: new conversation ID is a fresh UUID, different from parent

### 6.4 Metadata tests
- [ ] Test: `forked_from_conversation_id` matches parent conversation ID
- [ ] Test: `forked_from_message_id` matches the fork-point message's original ID
- [ ] Test: `created_at` is set to "now" (not copied from parent)
- [ ] Test: `total_input_tokens` / `total_output_tokens` / `estimated_cost` are re-summed from sliced messages only
- [ ] Test: uses caller-provided `currentProviderId`, `currentModelId`, `currentMode` (not parent values)

### 6.5 Title tests
- [ ] Test: title is `"Fork of {original title}"` when parent has a title
- [ ] Test: title falls back to `"Fork of {first 8 chars of ID}"` when parent has no title
- [ ] Test: forking a fork strips existing `"Fork of "` prefix (prevents `"Fork of Fork of X"`)

### 6.6 Tool call pairing tests
- [ ] Test: fork at `tool_call` message auto-includes paired `tool_result` (next message)
- [ ] Test: fork at `tool_result` does NOT include next `tool_call`
- [ ] Test: fork at `tool_call` with no paired result — still returns valid data (no auto-extension)
- [ ] Test: multi-tool sequence — fork mid-sequence includes only messages up to fork point + auto-extension

### 6.7 Preservation tests
- [ ] Test: original message timestamps are preserved (not overwritten)
- [ ] Test: provider `tool_call.id` and `tool_result.tool_call_id` are preserved (not reassigned)
- [ ] Test: workflow metadata (`workflow_path`, `workflow_name`, `persona_name`) is preserved from parent
- [ ] Test: `is_background` is cleared to `false`
- [ ] Test: `use_extended_context` is preserved when truthy

### 6.8 Edge case tests
- [ ] Test: returns `null` for unknown/nonexistent message ID
- [ ] Test: works with a conversation that has only system + 1 user message

---

## Phase 7: E2E Tests

End-to-end Playwright tests validating the full fork flow through the UI. Use the `/write-e2e-test` command to generate test scripts following the repo's E2E conventions in `e2e/scripts/`.

### 7.1 Core fork flow
- [ ] Test: create conversation with several exchanges, fork at message N, verify fork JSONL exists with correct message count
- [ ] Test: verify all IDs in fork JSONL are fresh (no overlap with original conversation)
- [ ] Test: verify original conversation JSONL is byte-identical after fork (unchanged)
- [ ] Test: verify forked conversation can be continued (send a new message, get a response)
- [ ] Test: verify conversation list shows the fork with lineage badge

### 7.2 Tool call boundary tests
- [ ] Test: fork at `tool_call` → paired `tool_result` is included in fork JSONL
- [ ] Test: fork at `tool_result` → next `tool_call` is NOT included
- [ ] Test: fork at `tool_call` with no paired result → fork is still continuable
- [ ] Test: fork mid-multi-tool sequence → exact message count matches expectation
- [ ] Test: continue forked conversation after tool_call boundary → LLM responds without API errors

### 7.3 Fork badge and navigation
- [ ] Test: fork badge is clickable and navigates to parent conversation
- [ ] Test: delete parent conversation → fork badge is no longer shown
- [ ] Test: fork an imported conversation → `forked_from_conversation_id` references the import's local ID

### 7.4 Streaming and in-progress guards
- [ ] Test: while assistant is streaming, right-click an earlier completed message → context menu appears
- [ ] Test: while assistant is streaming, right-click the in-progress message → no context menu
- [ ] Test: while tool call is pending, right-click the pending tool call → no context menu
- [ ] Test: while tool call is pending, right-click an earlier completed message → context menu appears

---

## Suggested Implementation Order

| Order | Phase | Rationale |
|-------|-------|-----------|
| 1st | **Phase 1** (Data Model & Core Logic) | Foundation — everything else depends on this |
| 2nd | **Phase 6** (Unit Tests) | Validate Phase 1 before building on top of it |
| 3rd | **Phase 2** (Orchestrator & Wiring) | Makes fork callable end-to-end (testable from dev console) |
| 4th | **Phase 3** (Message ID Tracking & Fork UI) | User-facing trigger for forking |
| 5th | **Phase 5** (CSS) | Style the UI added in Phase 3 & 4 |
| 6th | **Phase 4** (Conversation List Badge) | Polish — fork lineage in sidebar |
| 7th | **Phase 7** (E2E Tests) | Full integration validation after all features are in place |
