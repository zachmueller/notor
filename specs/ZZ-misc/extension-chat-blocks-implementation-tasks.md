# Extension Chat Blocks — Implementation Tasks

Companion to: [extension-chat-blocks-design.md](extension-chat-blocks-design.md)
Source planning doc: [extension-chat-blocks-plan.md](../../private/extension-chat-blocks-plan.md)

---

## Phase 1 — Foundation: Compaction Fix + `addMessage()` Expansion + `updateMessage()`

Standalone bug fix + new method. Ships independently, unblocks everything else. The compaction re-append loops at [`compaction-manager.ts:106-112`](../../src/chat/compaction-manager.ts#L106-L112) and [`:205-211`](../../src/chat/compaction-manager.ts#L205-L211) currently list only `role`, `content`, `tool_call`, `tool_result` — silently dropping `is_hook_injection`, `is_workflow_message`, and (soon) `source_extension`, `exclude_from_compaction`.

- [x] **1.1 — Add `source_extension` + `exclude_from_compaction` + `transient` to `addMessage()` in `conversation.ts`**
  - Current signature at [`conversation.ts:306-320`](../../src/chat/conversation.ts#L306-L320) lists fields explicitly in a params object
  - Add three new optional fields to the params type:
    - `source_extension?: string | null`
    - `exclude_from_compaction?: boolean`
    - `transient?: boolean`
  - Add corresponding lines in the function body (message construction at [`conversation.ts:325-342`](../../src/chat/conversation.ts#L325-L342)):
    - `source_extension: params.source_extension ?? null`
    - `exclude_from_compaction: params.exclude_from_compaction ?? false`
  - When `params.transient === true`, skip firing `this.onMessageAdded?.(message)` at [`conversation.ts:383`](../../src/chat/conversation.ts#L383). This prevents JSONL persistence while still adding the message to the in-memory array. Used for loading block placeholders.
  - Do NOT widen the type to `Omit<Partial<Message>>` — keep the explicit params object for type safety and clarity about defaults
  - Verify all existing callers still compile (search for `addMessage(` across the codebase)

- [x] **1.2 — Fix compaction re-append loops to spread all message fields**
  - [`compaction-manager.ts:106-113`](../../src/chat/compaction-manager.ts#L106-L113) and [`compaction-manager.ts:205-212`](../../src/chat/compaction-manager.ts#L205-L212) currently only spread `role`, `content`, `tool_call`, `tool_result`
  - Fields currently dropped: `is_hook_injection`, `is_workflow_message`, `hook_injections`, `attachments`, `auto_context`, `source_extension`, `exclude_from_compaction`, `input_tokens`, `output_tokens`, `cost_estimate`
  - Dropping `input_tokens`/`output_tokens`/`cost_estimate` is intentional (avoids inflating totals on re-append). Dropping the rest is a bug.
  - Fix: explicitly list all fields to preserve in the `addMessage()` call (cannot destructure-spread a `Message` into the explicit params type — `truncated` and other system fields would cause a type error):
    ```typescript
    for (const pending of pendingMessages) {
        convManager.addMessage({
            role: pending.role,
            content: pending.content,
            tool_call: pending.tool_call ?? undefined,
            tool_result: pending.tool_result ?? undefined,
            is_hook_injection: pending.is_hook_injection,
            is_workflow_message: pending.is_workflow_message,
            hook_injections: pending.hook_injections ?? undefined,
            attachments: pending.attachments ?? undefined,
            auto_context: pending.auto_context ?? undefined,
            source_extension: pending.source_extension ?? undefined,
            exclude_from_compaction: pending.exclude_from_compaction,
        });
    }
    ```
  - This preserves `is_hook_injection`, `is_workflow_message`, `hook_injections`, `attachments`, `auto_context`, `source_extension`, `exclude_from_compaction`

- [x] **1.3 — Add `updateMessage()` method to `ConversationManager`**
  - Signature: `updateMessage(messageId: string, patch: Partial<Pick<Message, 'content' | 'exclude_from_compaction'>>): Message | null`
  - **In-memory only — no JSONL persistence.** Used for transient state transitions (loading → real block). The final real block is persisted separately via `addMessage()` or `chatBlocks.emit()`.
  - Find message by `id` in `this.messages` array
  - Apply patch via `Object.assign()`
  - Fire new `onMessageUpdated` callback (add alongside existing `onMessageAdded` — setter at [`conversation.ts:57-59`](../../src/chat/conversation.ts#L57-L59), invocation site at [`conversation.ts:383`](../../src/chat/conversation.ts#L383))
  - Return updated message, or `null` if not found
  - Add `setOnMessageUpdated(callback)` setter following the pattern of `setOnMessageAdded` and `setOnConversationChanged`

- [x] **1.4 — Add `addMessageToConversation()` for non-active conversation emission**
  - New method on `HistoryManager`: `addMessageToConversation(conversationId: string, params: AddMessageParams): Promise<Message | null>`
  - `HistoryManager` already has all required methods (`listConversations()`, `loadConversation(filename)`, `appendMessage()`). The ID-to-filename resolution pattern is already used in `runtime-context.ts:341-345`.
  - **Note:** `HistoryManager.loadConversation(filename)` takes a JSONL **filename** (`{timestamp}_{id}.jsonl`), not a conversation ID. Implementation must resolve ID → filename first:
    1. Call `listConversations()` to find the entry with matching `id` → get its filename
    2. Call `loadConversation(filename)` to get the `Conversation` object
    3. Construct the `Message` from params
    4. Call `appendMessage(conversation, message)` to persist
  - This involves a directory scan — acceptable for this non-hot-path (detached sub-agent `onComplete` only)
  - Does NOT require `activeConversation` — operates independently
  - Returns `null` if the conversation doesn't exist
  - Used by `chatBlocks.emit()` when targeting a non-active conversation (e.g., detached sub-agent `onComplete`)
  - **Note:** The active-vs-non-active check belongs in `chatBlocks.emit()` (Task 9.1), not here. This method always operates via JSONL persistence.

- [x] **1.5 — Verify no regressions**
  - Search all `addMessage(` call sites — confirm they still compile with the new type
  - Confirm compaction flow: trigger compaction → re-appended messages preserve `is_hook_injection`, `is_workflow_message`, `hook_injections`, `attachments`, `auto_context`

---

## Phase 2 — Exhaustive Switch Guards

Standalone hardening. Add `assertUnreachable` (or `satisfies never`) guards to all role-dispatch switch statements so the compiler flags future role additions.

- [x] **2.1 — Create `assertUnreachable` utility**
  - Add to `src/utils/` (or inline where TypeScript's `never` type suffices)
  - Signature: `function assertUnreachable(x: never): never { throw new Error("Unreachable: " + x); }`

- [x] **2.2 — Audit and guard all role-dispatch sites**
  - Sites needing explicit `extension_block` case or default guard (per the plan's audit):
    - [x] [`message-pipeline.ts:140`](../../src/chat/message-pipeline.ts#L140) — `toChatMessages()` switch (no default) → added `assertUnreachable` default
    - [x] [`view-router.ts:54`](../../src/chat/view-router.ts#L54) — `renderMessage()` switch (no default) → added explicit `case "system"` + `assertUnreachable` default
    - [x] [`compaction.ts:237-269`](../../src/context/compaction.ts#L237-L269) — compaction input if/else-if chain (no else) → added trailing comment; Phase 3.6 implements `extension_block` handling
    - [x] [`context.ts:190-198`](../../src/chat/context.ts#L190-L198) — truncation walk-forward → added comment marking Phase 3.7 TODO
    - [x] [`markdown-exporter.ts:74`](../../src/export/markdown-exporter.ts#L74) — switch with `default: null` → replaced with `assertUnreachable`
    - [x] [`html-exporter.ts:381`](../../src/export/html-exporter.ts#L381) — switch with `default: null` → replaced with `assertUnreachable`
    - [x] [`html-exporter.ts:578`](../../src/export/html-exporter.ts#L578) — sub-agent message switch → replaced `default: null` with `assertUnreachable`
    - [x] [`conversation.ts:368`](../../src/chat/conversation.ts#L368) — title generation `role === "user"` check → no change needed; `extension_block` inherently excluded
    - [x] [`runtime-context.ts:352`](../../src/extensions/runtime-context.ts#L352) — recent-turns filter → added comment confirming `extension_block` intentionally excluded
  - Sites verified safe (document as comments or no-op cases):
    - Provider adapters (`anthropic-provider.ts:70`, `bedrock-provider.ts:106`, `openai-provider.ts:57`, `local-provider.ts:82`) — never see `extension_block` (translated in pipeline)
    - `compaction.ts:84` — token estimation fallback path, safe for any role
    - `context.ts:84` — same
    - `message-pipeline.ts:291-342` — tool call coalescing, only walks `tool_call`/`tool_result`
    - `message-pipeline.ts:225-289` — tool call repair, only inspects `tool_call`/`tool_result`/`assistant`
    - `message-pipeline.ts:369` — `extractPendingMessages()` backward search — only checks for `assistant` role boundary; all other roles implicitly included in the pending slice via `messages.slice(i + 1)`
    - `history.ts:490`, `:547`, `:645` — correctly skips/includes based on explicit role checks
    - `conversation.ts:199-206` — fork auto-pairing, `tool_call`/`tool_result` only
    - `orchestrator.ts:755` — `on_conversation_start` trigger, explicit `user` check
    - `orchestrator.ts:975`, `workflow-executor.ts:649` — system message existence check

- [x] **2.3 — Add `MessageRole` member count assertion test**
  - If the union gains a member, the test breaks until all dispatch sites are updated

- [x] **2.4 — Audit ContentBlock type-dispatch sites**
  - [x] [`tokens.ts:84-94`](../../src/utils/tokens.ts#L84-L94) — `estimateContentTokens()` switch (no default) — added comment; Phase 3.2 adds the real `custom_block` case
  - [x] [`media/types.ts:35-43`](../../src/media/types.ts#L35-L43) — `getTextContent()` — no change needed (custom_blocks silently excluded by existing `.filter()`); verified that `image` and `document` blocks continue to return `""` as expected
  - [x] [`html-exporter.ts:443-451`](../../src/export/html-exporter.ts#L443-L451) — inline media rendering — added comment noting user messages won't contain custom blocks

---

## Phase 3 — `custom_block` Content Variant + `extension_block` Role + Wire Translation + Coalescing + Token Estimation

The core message shape. After this phase, extension blocks can be emitted (manually for testing) and will persist, render (via fallback), and translate to the wire correctly.

- [x] **3.1 — Add `custom_block` to `ContentBlock` union**
  - In [`src/media/types.ts`](../../src/media/types.ts): add the `custom_block` variant with fields: `type`, `kind`, `data`, `fallback_text?`, `estimated_wire_tokens?`, `loading?`
  - `getTextContent()` requires NO changes — the existing `.filter(block.type === "text")` pattern already silently excludes unknown block types, returning `""` for arrays with only custom blocks

- [x] **3.2 — Add `custom_block` case to `estimateContentTokens()`**
  - In [`src/utils/tokens.ts`](../../src/utils/tokens.ts): add `case "custom_block":`
  - Use `estimated_wire_tokens` when present (set at emission time from `toLLMText` output)
  - Fall back to `estimateTokenCount(fallback_text)`, then `estimateTokenCount(JSON.stringify(data))` as last resort
  - Blocks with `toLLMText → null` should set `estimated_wire_tokens: 0` at emission → counted as zero wire cost

- [x] **3.3 — Add `"extension_block"` to `MessageRole` union**
  - In [`src/types.ts`](../../src/types.ts): extend the `MessageRole` union type
  - Add `source_extension?: string | null` to `Message` interface
  - Add `exclude_from_compaction?: boolean` to `Message` interface

- [x] **3.4 — Handle `extension_block` in `toChatMessages()` + create `getWireText()`**
  - **Create `getWireText(content, registry?)` function** in `message-pipeline.ts`: resolves `custom_block` entries to their wire text via `registry.get(kind)?.toLLMText?.(data)`, falling back to `fallback_text ?? ""` when the registry has no definition for a kind. Returns combined text or `null` when all blocks produce empty output.
  - **Registry injection:** Add `setChatBlockRegistry(registry)` module-scoped setter in `message-pipeline.ts`. Called once at plugin init (Task 5.4). `toChatMessages()` signature does NOT change — reads registry from module state.
  - In [`src/chat/message-pipeline.ts`](../../src/chat/message-pipeline.ts) at the role switch (~line 140):
  - Add `case "extension_block":` that:
    - Calls `getWireText(msg.content, moduleRegistry)` for the message
    - Wraps non-null results in `<notor-ext source="{source_extension}">…</notor-ext>` tags
    - When result is `null` (all blocks empty) → skip the message entirely (zero tokens)
    - Otherwise emit as `role: "user"` `ChatMessage` with the tagged text
  - **Phase 5 stub note:** Until Phase 5.5 wires in the real registry, `getWireText()` will have `registry = undefined` and will use `fallback_text` for all custom blocks. This is correct initial behavior.

- [x] **3.5 — Add Phase 4 consecutive-same-role coalescing pass**
  - Create a **separate** post-processing loop after Phase 3's tool-coalescing while-loop (which ends at line 346). Do NOT modify the Phase 3 while-loop (lines 296-346) — it handles `tool_call`/`tool_result` coalescing only.
  - Operates on the `coalesced` array (output of Phase 3) and produces a `final` array, returned instead of `coalesced` (currently returned at line 356)
  - Iterate `ChatMessage[]`: when `messages[i].role === messages[i-1].role` and neither carries `tool_calls`/`tool_results`, merge content
  - **Important:** `ChatMessage.content` is `string | ContentBlock[]` ([provider.ts:26](../../src/providers/provider.ts#L26)). When merging:
    - If both are `string`: produce a single `{ type: "text", text: a + "\n\n" + b }` wrapped in an array (or concatenate strings directly)
    - If either is `ContentBlock[]`: normalize both to `ContentBlock[]` (wrap bare `string` in `{ type: "text", text }`), then concatenate the arrays
  - Addresses both extension-block adjacency AND a pre-existing hook-injection alternation bug (Bedrock's strict alternation requirement)
  - **Note on merged content:** After coalescing, extension_block wire text (`<notor-ext>` tagged) may appear in the same `ChatMessage` as user text. This is by design — LLMs handle inline XML tags in user messages correctly. The extension block text typically precedes the user's text within the merged message, providing context before the user's question.

- [x] **3.6 — Handle `extension_block` in compaction input assembly**
  - In [`src/context/compaction.ts:236-269`](../../src/context/compaction.ts#L236-L269):
  - If `msg.exclude_from_compaction === true` → skip entirely (not seen by the summarizer)
  - Otherwise extract text via `getTextContent()` and include as user-role in compaction input
  - **Note:** `exclude_from_compaction` controls what the summarizer SEES, not what survives compaction. Pending messages (after last assistant) are always re-appended regardless of this flag.

- [x] **3.7 — Handle `extension_block` in truncation walk-forward**
  - In [`src/chat/context.ts:190-198`](../../src/chat/context.ts#L190-L198):
  - Add `extension_block` to the break condition at line 193: change `if (m.role === "user") break;` to `if (m.role === "user" || m.role === "extension_block") break;`
  - This prevents blocking `on_conversation_start` blocks from being silently truncated when they appear before the first user message

- [x] **3.8 — Handle `extension_block` in exporters**
  - [`markdown-exporter.ts`](../../src/export/markdown-exporter.ts): add case rendering source label + fallback text in Obsidian callout format
  - [`html-exporter.ts`](../../src/export/html-exporter.ts): add case at both `:381` and `:578` switches

- [x] **3.9 — Handle `extension_block` in remaining dispatch sites**
  - [`conversation.ts:368`](../../src/chat/conversation.ts#L368): no code change needed — title generation already checks `params.role === "user"`, so `extension_block` is inherently excluded
  - [`runtime-context.ts:352`](../../src/extensions/runtime-context.ts#L352): the `loadConversation` filter already checks `m.role === "user" || m.role === "assistant"` — `extension_block` is excluded. Decide if this is correct or if extensions should see their own prior emissions.
  - [`compaction-manager.ts`](../../src/chat/compaction-manager.ts): handle `exclude_from_compaction` messages during compaction:
    1. **Separate** `exclude_from_compaction === true` messages from the completed-messages set before building the summarizer input (they should NOT be seen by the summarizer)
    2. **Re-append** these excluded messages between the summary message and the pending messages — this ensures they survive compaction cycles (e.g., memory-recalled blocks at conversation start are not silently dropped)
    3. Without this preservation, excluded messages would be neither summarized (excluded from input) nor pending (too old) — they would vanish entirely after compaction

- [ ] **3.10 — Smoke test with hand-emitted block**
  - Temporarily add a test pathway (e.g., a debug command) that calls `addMessage({ role: "extension_block", content: [{ type: "custom_block", kind: "test", data: { message: "hello" }, fallback_text: "Test block" }], source_extension: "test" })`
  - Verify: renders in chat (fallback text), persists in JSONL, survives reload, appears in wire as tagged user-role text, exports correctly, compaction handles it

---

## Phase 4 — Collapsible Helper + Refactor

DRY up the duplicated toggle pattern. Small scope, high payoff — every block-kind renderer will use this.

- [x] **4.1 — Create `renderCollapsibleCard` helper**
  - Create [`src/ui/chat-blocks/collapsible-card.ts`](../../src/ui/chat-blocks/collapsible-card.ts)
  - Signature: `renderCollapsibleCard(container, opts: { headerText, icon?, defaultExpanded?, rootClass? }) → { root, header, body }`
  - Reuse existing CSS primitives: `.notor-tool-call-toggle`, `.notor-hidden`
  - Toggle behavior: click header → toggle `.notor-hidden` on body, swap `▶`/`▼` chevron
  - Returns `header` (for callers to append badges/buttons) and `body` (for content)

- [x] **4.2 — Refactor `tool-call-ui.ts` to use helper (both toggles)**
  - [`tool-call-ui.ts:66-77`](../../src/ui/tool-call-ui.ts#L66-L77): replace the parameters toggle in `renderToolCallCard` with `renderCollapsibleCard()`
  - [`tool-call-ui.ts:127-144`](../../src/ui/tool-call-ui.ts#L127-L144): replace the result toggle in `renderToolResultSummary` with `renderCollapsibleCard()`
  - Verify: tool call cards expand/collapse identically, chevron animation unchanged

- [x] **4.3 — Refactor `chat-view.ts` to use helper (both toggles)**
  - [`chat-view.ts:2225-2236`](../../src/ui/chat-view.ts#L2225-L2236): replace the toggle in `renderToolCall` with `renderCollapsibleCard()`
  - [`chat-view.ts:2277-2289`](../../src/ui/chat-view.ts#L2277-L2289): replace the toggle in `renderToolResult` with `renderCollapsibleCard()`
  - Verify: tool result cards expand/collapse identically

---

## Phase 5 — `ChatBlockRegistry` + Renderer Contract

Make block kinds pluggable. After this phase, block kinds can be registered and resolved at render time.

- [x] **5.1 — Create `ChatBlockRegistry` class**
  - Create [`src/ui/chat-blocks/registry.ts`](../../src/ui/chat-blocks/registry.ts)
  - Implement `register(def)`: store by `kind`, log error on duplicate (keep first)
  - Implement `get(kind)`: return definition or undefined
  - Implement `has(kind)`, `list()`
  - Implement `unregister(kind)` for extension reload cleanup

- [x] **5.2 — Define `ChatBlockDefinition` interface**
  - Fields: `kind`, `displayName`, `icon?`, `render`, `toLLMText?`, `excludeFromCompaction?`, `renderLoading?`
  - Generic type parameter `<TData>` for typed `data` payloads

- [x] **5.3 — Define `ChatBlockRenderContext` interface**
  - Fields: `message`, `app`, `openInternalLink`, `collapsibleCard` (from Phase 4 helper)

- [x] **5.4 — Instantiate registry in `main.ts`**
  - Create `ChatBlockRegistry` instance during plugin `onload()`
  - Call `setChatBlockRegistry(registry)` on the message-pipeline module (module-scoped setter from Task 3.4)
  - Wire into: view router (for rendering), orchestrator (for emission-time `estimated_wire_tokens` calculation)
  - Added `getChatBlockRegistry()` public getter (with lazy-init fallback for tests)

- [x] **5.5 — Verify registry wiring in `toChatMessages()`**
  - After Task 5.4 calls `setChatBlockRegistry()`, the `extension_block` case from Phase 3.4 automatically uses the real registry via `getWireText()`
  - Verify: `toLLMText` from registered definitions is now called; when `toLLMText` is undefined or kind is unregistered, falls back to `fallback_text ?? ""`

---

## Phase 6 — Chat View Integration

Render `extension_block` messages as dedicated rows in the chat panel.

- [x] **6.1 — Add `extension_block` case to `view-router.ts`**
  - In [`view-router.ts`](../../src/chat/view-router.ts) `renderMessage()` switch:
  - `case "extension_block": this.view?.renderExtensionBlock(message); break;`

- [x] **6.2 — Implement `renderExtensionBlock()` in `chat-view.ts`**
  - Create row container with class `.notor-extension-block` (styled like `.notor-tool-call`)
  - Optional source header showing `source_extension` with icon
  - Iterate `message.content`:
    - For `custom_block`: look up `ChatBlockRegistry.get(kind)`
      - If found: call `def.render(container, block.data, ctx)` **wrapped in try-catch**
        - On error: clear container, show fallback error card with "Block render error: {kind}" header and raw JSON `data` in `<pre>` block. Log error with kind, data summary, stack trace
      - If `loading === true` and `def.renderLoading` exists: call `def.renderLoading(container, ctx)` instead
      - If `loading === true` and no `renderLoading`: show default spinner with `displayName`
      - If not found: render `fallback_text` in a collapsible with "Unregistered block kind: {kind}" warning
    - For `text` blocks: render as plain text (above/below custom block)
  - Shared `populateExtensionBlockEl()` private helper used by both `renderExtensionBlock()` and `reRenderExtensionBlock()`

- [x] **6.3 — Add minimal CSS for `.notor-extension-block`**
  - In [`styles.css`](../../styles.css): add `.notor-extension-block` styling
  - Reuse tool-call card CSS patterns (margin, border, padding)
  - Add subtle visual distinction (e.g., left-border accent color) to differentiate from tool calls

- [x] **6.4 — Handle message update re-render**
  - Wire `onMessageUpdated` callback (from Phase 1.3) to the chat view
  - When an `extension_block` message is updated (loading → real), re-render the row:
    - Find the existing DOM element for the message
    - Clear its contents
    - Re-invoke `renderExtensionBlock()` with the updated message
  - Wired in `orchestrator.ts` via `conversationManager.setOnMessageUpdated()`

- [x] **6.5 — Verify reload persistence**
  - E2E script: [`e2e/scripts/extension-block-reload-test.ts`](../../e2e/scripts/extension-block-reload-test.ts) — 14/14 passing
  - Test 1: block renders as `.notor-extension-block` row with source label and fallback text
  - Test 2: JSONL on disk contains extension_block with `source_extension` and `exclude_from_compaction` preserved
  - Test 3: switch away and back → block re-renders from persisted `data`
  - Test 4: unregistered kind with no `fallback_text` renders without crash, no ChatView errors

---

## Phase 7 — `notor-type: block` Extension Type + Manager Integration

Allow user-authored block kinds in vault scaffolds and built-in block scaffolds.

- [x] **7.1 — Add `"block"` to `ExtensionType` and define `UserBlockDefinition`**
  - In [`src/extensions/types.ts`](../../src/extensions/types.ts):
  - Extend `ExtensionType`: `"tool" | "automation" | "settings" | "block"`
  - Add `UserBlockDefinition` interface: `filePath`, `kind`, `displayName`, `icon?`, `rendererExport`, `toLLMTextExport?`, `excludeFromCompaction?`, `rawCode`, `compiledFn`, `isScaffold?`
  - Add `BlockKindDeclaration` interface for `blocks:` YAML on tools/automations: `kind`, `displayName`, `icon?`, `rendererExport`, `toLLMTextExport?`, `excludeFromCompaction?`
  - Add optional `blocks?: BlockKindDeclaration[]` to `UserToolDefinition` and `UserAutomationDefinition`
  - Add `blockCount` to `ExtensionReloadResult`

- [x] **7.2 — Add `case "block"` to parser dispatch**
  - In [`src/extensions/parser.ts`](../../src/extensions/parser.ts) at the switch (~line 122-129):
  - Add `case "block": return parseBlockFile(frontmatter, codeFence, filePath);`
  - Implement `parseBlockFile()`: parse frontmatter fields `notor-block-kind`, `notor-display-name`, `notor-icon`, `notor-exclude-from-compaction`, `notor-renderer-export`, `notor-to-llm-text-export`, and code fence. No `params` or `settings` YAML section
  - Add `parseBlockKindDeclarations()` helper to parse `blocks:` YAML section on tool/automation scaffolds (added to `parseToolFile` and `parseAutomationFile`)

- [x] **7.3 — Update discovery to scan `{notor_dir}/blocks/`**
  - In [`src/extensions/discovery.ts`](../../src/extensions/discovery.ts):
  - Add `blocks: UserBlockDefinition[]` to `DiscoveryResult` interface
  - Add scan of `{notor_dir}/blocks/` directory for `.md` files, following the same pattern as `tools/` and `automations/` scans
  - Type-check: files must parse as `notor-type: block`; log and skip unexpected types

- [x] **7.4 — Update manager to compile/register block kinds**
  - In [`src/extensions/manager.ts`](../../src/extensions/manager.ts):
  - Add `compileBlockModule()` to [`src/extensions/compiler.ts`](../../src/extensions/compiler.ts): strips types, compiles code into an AsyncFunction with `exports` param, executes synchronously to populate named exports
  - On extension (re)compile:
    - For `notor-type: block` scaffolds: compile via `compileBlockModule()`, extract named exports (renderer, toLLMText), register with `ChatBlockRegistry`
    - For tool/automation scaffolds with `blocks:` YAML: compile module separately via `registerInlineBlockKinds()`, pull named exports, register
  - On extension unload/reload: unregister from `ChatBlockRegistry` (via `registeredBlockKinds` set)
  - Duplicate kind detection: delegated to `ChatBlockRegistry.register()` (logs error, keeps first)
  - `destroy()` also cleans up registered block kinds

---

## Phase 8 — `notor-blocking` Opt-In for `on_conversation_start`

Enable blocking automations that emit blocks visible to the LLM on the first turn.

- [x] **8.1 — Add blocking fields to automation definition**
  - In [`src/extensions/types.ts`](../../src/extensions/types.ts): add to `UserAutomationDefinition`:
    - `blocking?: boolean`
    - `blockingEmitKind?: string`
    - `blockingTimeout?: number`

- [x] **8.2 — Parse `notor-blocking` frontmatter**
  - In [`src/extensions/parser.ts`](../../src/extensions/parser.ts): parse `notor-blocking` (boolean), `notor-blocking-emit-kind` (string), `notor-blocking-timeout` (number, default 10000ms) for automation files

- [x] **8.3 — Partition `dispatchOnConversationStart()` into blocking/non-blocking**
  - In [`src/hooks/hook-events.ts`](../../src/hooks/hook-events.ts) at [`dispatchOnConversationStart()`](../../src/hooks/hook-events.ts#L823-L866):
  - **Full async conversion required:** The function is currently synchronous (returns `void`) with async work inside a fire-and-forget IIFE. Changes needed:
    1. Change function signature to `async`, return type from `void` to `Promise<void>`
    2. Restructure internal IIFE: blocking automations awaited directly in the function body, non-blocking automations remain in a fire-and-forget IIFE
    3. Add per-automation timeout logic
  - Partition automations by `automation.blocking === true`
  - For each blocking automation with `blockingEmitKind`:
    - Emit preliminary loading `extension_block` message via `addMessage({ ..., transient: true })` (the `transient` flag from Task 1.1 skips `onMessageAdded`, preventing JSONL persistence while still adding to the in-memory array and rendering in the view): `role: "extension_block"`, `custom_block` with `kind: blockingEmitKind`, `data: {}`, `loading: true`
    - Store the loading message ID for later replacement
  - Await blocking automations sequentially with per-automation timeout
  - On timeout: detach (continue in background), update loading block to timed-out indicator
  - Non-blocking automations: fire-and-forget as today
  - Add `emitLoadingBlock?: (kind: string) => Message` callback parameter to the function signature. The orchestrator wires this to `ConversationManager.addMessage()` at the call site — keeps `hook-events.ts` decoupled from the conversation system

- [x] **8.4 — `await` the dispatch in orchestrator + verify session snapshot**
  - In [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts) at ~line 756 (call spans lines 756-763):
  - Change from bare `dispatchOnConversationStart(...)` to `await dispatchOnConversationStart(...)`
  - Safe because the function only blocks when there are blocking automations; otherwise the returned promise resolves immediately
  - **Verification sub-task:** Trace the code path and confirm: blocking automations emit `extension_block` via `addMessage()` on the display `ConversationManager` → session snapshot (created at ~lines 770-771) reads from the display manager's message list → snapshot includes the newly-emitted messages → LLM sees them in its context on the first turn

- [x] **8.5 — Loading → real block replacement**
  - Loading blocks are in-memory only (not persisted to JSONL — see Task 8.3, `transient: true`)
  - When blocking automation calls `chatBlocks.emit(kind, data)` (same kind as loading block):
    1. Find the loading message by stored message ID in `this.messages[]`
    2. **Mutate in place:** overwrite `content` with the real `custom_block` payload, set `loading: false` on the block
    3. Fire `onMessageAdded` callback — this persists the now-real message to JSONL (the message was transient before, so this is its first persistence)
    4. Fire `onMessageUpdated` callback to trigger re-render at the loading block's DOM position in chat view (Phase 6.4)
  - **Why mutate in place:** The previous remove-then-add approach broke chronological ordering — `addMessage()` always appends to the end of `this.messages[]` via `push()`, so if messages arrived during async automation execution, the real block would land after them. In-place mutation preserves the message's position in the array.
  - If plugin reloads mid-automation: loading block is gone (never persisted), automation does not re-fire — acceptable behavior

---

## Phase 9 — `utils.chatBlocks.emit()` API

The side-effect emission API for automations and tools. This is the sole block-emission path for pre_send automations.

- [x] **9.1 — Implement `chatBlocks.emit` on `ExtensionUtils`**
  - In [`src/extensions/runtime-context.ts`](../../src/extensions/runtime-context.ts):
  - Add `chatBlocks` property to `ExtensionUtils`:
    ```
    chatBlocks: {
      emit: (kind, data, opts?) => Promise<Message | null>;
    } | null
    ```
  - Implementation:
    - Resolve conversation: `opts.conversationId` → explicit target; else `context.conversationId` from automation context; else `null`
    - Validate kind against `ChatBlockRegistry` — if unregistered, log warning but still emit with fallback rendering
    - Validate `data`: must be JSON-serializable, reject if `JSON.stringify(data).length > 102400` (100KB) with error log
    - Compute `estimated_wire_tokens`: if kind is registered and `toLLMText` exists, compute from `toLLMText` output length. If kind is **unregistered** (no registry entry), compute `estimated_wire_tokens = estimateTokenCount(fallback_text ?? "")`. If `fallback_text` is also absent, set `estimated_wire_tokens = 0`.
    - **LLM visibility warning:** After resolving `toLLMText` and `fallback_text`, if both are absent/null, log warning: `"Block kind '{kind}' will not be visible to the LLM — no toLLMText or fallback_text."` This does not block emission (decorative/UI-only blocks are valid), but surfaces the issue to extension authors during development.
    - **Active conversation path:** Call `ConversationManager.addMessage({ role: "extension_block", content: [custom_block], source_extension, exclude_from_compaction })` — message persists and renders live
    - **Non-active conversation path:** Call `HistoryManager.addMessageToConversation(conversationId, params)` (from Task 1.4) — message persists to JSONL but does not live-render; appears on next conversation reload
    - Return the created `Message`, or `null` if no conversation found
  - Set `chatBlocks` to `null` when no conversation is available (background vault events)

- [x] **9.2 — Wire `chatBlocks` into automation execution contexts**
  - Ensure `chatBlocks` is available in all automation triggers: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`, `on_conversation_start`, `on_schedule`, vault events
  - For vault events with no active conversation: `chatBlocks` is `null`
  - For `pre_send` (blocking): blocks land before session snapshot → LLM sees them
  - For `after_completion` (non-blocking): blocks land after snapshot → visible on subsequent turns

- [x] **9.3 — Document LLM visibility constraint**
  - Add inline code comment at the emission site explaining: blocking automations → current-turn visibility; non-blocking → next-turn only
  - This is by design, not a bug

---

## Phase 10 — Tool `content_blocks` → `extension_block` Bridge

When a tool's `ToolResult.content_blocks` contains a `custom_block`, the orchestrator emits an `extension_block` message.

- [x] **10.1 — Detect `custom_block` in tool results + validate**
  - In [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts), after tool results are added to conversation:
  - Check each `ToolResult.content_blocks` for entries where `type === "custom_block"`
  - **Validate each custom_block:** (a) check `kind` is registered — if not, log warning, proceed with fallback rendering, (b) verify `JSON.stringify(data)` succeeds (JSON-serializable), (c) reject if `JSON.stringify(data).length > 102400` with error log
  - **Compute `estimated_wire_tokens`** at emission time via `registry.get(kind)?.toLLMText?.(data)` output length, matching the logic in `chatBlocks.emit()` (Task 9.1). Blocks with `toLLMText → null` get `estimated_wire_tokens: 0`.
  - If valid blocks found, collect them into a new `extension_block` message

- [x] **10.2 — Emit `extension_block` after tool_result group**
  - Emit the `extension_block` message **after the entire tool_result group** in the current batch (after all tool results are added), but **before the next LLM call**
  - This preserves tool_call/tool_result coalescing that providers require
  - Set `source_extension` to the tool name

- [x] **10.3 — Tool's textual result stays inline**
  - The tool-result bubble continues to render the text/media content blocks as before
  - The `extension_block` row is an additional rendering, not a replacement

---

## Phase 11 — `utils.runSubAgent` + Detached Spawn

Enable extensions to run sub-agents for background data gathering.

- [x] **11.1 — Add `runSubAgent` to `ExtensionUtils`**
  - In [`src/extensions/runtime-context.ts`](../../src/extensions/runtime-context.ts):
  - Signature:
    ```
    runSubAgent: (opts: {
      profileName: string;
      task: string;
      detached?: boolean;
      onComplete?: (result: SubAgentResult) => Promise<void> | void;
      iterationCap?: number;
      timeout?: number;
    }) => Promise<SubAgentResult | null>
    ```
  - Wraps `SubAgentRunner` ([`sub-agent-runner.ts:92`](../../src/chat/sub-agent-runner.ts#L92))
  - Resolves profile via `SubAgentManager` ([`sub-agents/manager.ts`](../../src/sub-agents/manager.ts))
  - Depth guard: max depth 1 (sub-agents spawned from extensions cannot spawn sub-agents)

- [x] **11.2 — Implement detached sub-agent lifecycle**
  - **Abort signal ownership:** Detached sub-agents create their own `AbortController`, linked to parent's signal (parent abort cascades to child, but child cleanup doesn't wait for parent)
  - **Active agent registry:** Plugin-level `Set<AbortController>` for running detached agents
    - Checked during `plugin.onunload()` — abort all active agents
    - Entries removed in a `finally` block wrapping the entire lifecycle (run → onComplete → cleanup)
  - **`onComplete` error boundary:** Framework wraps every `onComplete` invocation in try-catch. On error: log with profile name, conversation ID, stack trace. Never re-throw. Registry cleanup in enclosing `finally` (not dependent on `onComplete` succeeding)
  - **Timeout:** Configurable per invocation (default 60s). `setTimeout` calls `controller.abort()`. Existing abort handling in `SubAgentRunner` takes care of the rest

- [x] **11.3 — Result delivery to inactive conversations**
  - `onComplete` calls `utils.chatBlocks.emit` with explicit `conversationId`
  - If conversation view is no longer active: `chatBlocks.emit` uses `addMessageToConversation()` (Task 1.4) — message persists in JSONL but view doesn't live-update
  - Block appears on next conversation reload — acceptable expected behavior

- [x] **11.4 — Verify integration**
  - `addMessageToConversation()` works for non-active conversations (via explicit `conversationId`)
  - If the target IS the active conversation, `chatBlocks.emit` uses regular `addMessage()` (live rendering)
  - Depth guard does not block recursive resolver calls from within sub-agents
  - Detached agent closure cleanup: no leaked registry entries after completion/abort/error/timeout

---

## Phase 12 — Rate Limit + Emission Gates

Safety controls for block emission.

- [x] **12.1 — Add rate-limit settings**
  - In [`src/settings/types.ts`](../../src/settings/types.ts):
  - Add `extension_block_max_emits_per_window: number` (default 10)
  - Add `extension_block_rate_window_seconds: number` (default 60)

- [x] **12.2 — Implement time-based sliding window rate limiter**
  - Per-conversation emission tracker (e.g., `Map<conversationId, number[]>` of timestamps)
  - On each `emit()` call: check count within the sliding window
  - If over limit: log warning, return `null`
  - Window slides automatically — after `rate_window_seconds`, old entries expire

- [x] **12.3 — Implement emission gate for disabled extensions**
  - When the emitting extension is disabled (per existing enable semantics at [`manager.ts:495`](../../src/extensions/manager.ts#L495)):
    - Existing blocks in transcript render as `[disabled extension: {name}]` placeholders
    - New `emit()` calls no-op and return `null`

---

## Phase 13 — Verification & Polish

Comprehensive testing across all phases.

- [ ] **13.1 — Unit tests: ContentBlock**
  - `getTextContent` returns `""` (empty string) for an array containing only `custom_block` entries
  - `getTextContent` returns only `text` block content when array contains both `custom_block` and `text` blocks
  - JSON round-trip preserves the `custom_block` variant

- [ ] **13.2 — Unit tests: Token estimation**
  - `custom_block` with `estimated_wire_tokens: 0` → returns 0
  - With `estimated_wire_tokens: 150` → returns 150
  - Without `estimated_wire_tokens` but with `fallback_text` → estimate from fallback
  - Without either → `JSON.stringify(data)` estimate

- [ ] **13.3 — Unit tests: Registry**
  - Register/get/list; duplicate kind logs and keeps first; unregister on extension reload

- [ ] **13.4 — Unit tests: Wire translation**
  - `toChatMessages()` with `extension_block` → `user`-role `ChatMessage` with tagged `toLLMText` output
  - All blocks null + no fallback → entire message dropped (zero tokens)
  - Coalescing: extension_block + user message → single merged user message on wire
  - Coalescing: hook injection + user message → also merged (pre-existing case)
  - Coalescing: two consecutive extension_blocks → merged
  - Coalescing: merged user + extension_block text preserves `<notor-ext>` tags and user content as separate `\n\n`-delimited sections
  - Coalescing: user message with `ContentBlock[]` content (e.g., image) + extension_block with string content → normalized to `ContentBlock[]` array

- [ ] **13.5 — Unit tests: Compaction**
  - Block with `excludeFromCompaction: true` → skipped from compaction input
  - Block with `excludeFromCompaction: true` → preserved verbatim after compaction (re-appended between summary and pending messages)
  - Block without flag → compacted normally
  - Re-appended messages preserve `source_extension`, `exclude_from_compaction`, `is_hook_injection`, `is_workflow_message`, `hook_injections`, `attachments`, `auto_context`

- [ ] **13.6 — Unit tests: `addMessage()` fields + `updateMessage()` + `addMessageToConversation()`**
  - `addMessage()` with `source_extension` and `exclude_from_compaction` → message has those fields set
  - `addMessage()` with `transient: true` → message added to in-memory array, `onMessageAdded` NOT fired (no JSONL persistence)
  - `addMessage()` without `transient` → `onMessageAdded` fires normally
  - `updateMessage` with valid ID → patches content in-memory, fires callback, no JSONL write
  - `updateMessage` with invalid ID → returns null, no callback
  - Loading → real transition: loading block mutated in place (content overwritten, `loading` flipped to false), `onMessageAdded` fires (first persistence), `onMessageUpdated` fires (re-render), message position in array preserved
  - `HistoryManager.addMessageToConversation` with valid conversation ID → resolves filename via `listConversations()`, message persisted to JSONL
  - `HistoryManager.addMessageToConversation` with invalid conversation ID → returns null

- [ ] **13.7 — Unit tests: Rate limit**
  - 11 emits in 60 seconds → 10 succeed, 11th returns null with warning
  - After window slides → emits succeed again

- [ ] **13.8 — E2E tests: Block rendering**
  - Author a minimal block extension in vault; emit from `pre_send`; confirm it renders as its own row
  - Collapsible works; header shows `source_extension`
  - Reload conversation → block persists and re-renders
  - Unregister kind → fallback text placeholder, no crash

- [ ] **13.9 — E2E tests: Render ≠ wire**
  - Block kind with `render` showing links and `toLLMText` returning full bodies
  - UI shows only links; wire payload contains full bodies

- [ ] **13.10 — E2E tests: Blocking automation**
  - `notor-blocking: true` + `on_conversation_start` → emitted block in LLM context on first turn
  - Non-blocking automation's emitted block NOT in first-turn context
  - Loading block → real block transition (spinner → content)
  - Timeout: slow automation → turn proceeds → block eventually replaced

- [ ] **13.11 — E2E tests: Detached sub-agent**
  - `after_completion` spawns detached sub-agent → `onComplete` fires later → block emitted
  - Stop button while detached agent running → aborted via linked signal
  - Navigate away → block persists in JSONL, appears on conversation reload
  - Plugin unload → all active agents aborted

- [ ] **13.12 — E2E tests: Export**
  - Emit extension_block → markdown export includes fallback_text with source label
  - HTML export same

- [ ] **13.13 — Visual verification**
  - Collapsible helper refactor: tool-call cards expand/collapse identically to before
  - Extension block rows visually distinct from tool calls
  - Loading spinner renders and transitions cleanly

- [ ] **13.14 — Move design doc to `done/`**
  - After full verification: `mv specs/ZZ-misc/extension-chat-blocks-design.md specs/ZZ-misc/done/`
