# Extension Chat Blocks — Implementation Tasks

Companion to: [extension-chat-blocks-design.md](extension-chat-blocks-design.md)
Source planning doc: [extension-chat-blocks-plan.md](../../private/extension-chat-blocks-plan.md)

---

## Phase 1 — Foundation: Compaction Fix + `addMessage()` Expansion + `updateMessage()`

Standalone bug fix + new method. Ships independently, unblocks everything else. The compaction re-append loops at [`compaction-manager.ts:106-112`](../../src/chat/compaction-manager.ts#L106-L112) and [`:205-211`](../../src/chat/compaction-manager.ts#L205-L211) currently list only `role`, `content`, `tool_call`, `tool_result` — silently dropping `is_hook_injection`, `is_workflow_message`, and (soon) `source_extension`, `exclude_from_compaction`.

- [ ] **1.1 — Expand `addMessage()` parameter type in `conversation.ts`**
  - Current signature at [`conversation.ts:306-320`](../../src/chat/conversation.ts#L306-L320) lists fields explicitly in a params object
  - Change to: `Omit<Partial<Message>, 'id' | 'conversation_id' | 'timestamp'> & { role: MessageRole; content: string | ContentBlock[] }`
  - The `Omit` prevents callers from setting system-managed fields (`id`, `conversation_id`, `timestamp` are always assigned internally)
  - The function body already assigns defaults for missing fields — only the parameter type changes
  - Verify all existing callers still compile (search for `addMessage(` across the codebase)

- [ ] **1.2 — Fix compaction re-append loops to spread all message fields**
  - [`compaction-manager.ts:106-112`](../../src/chat/compaction-manager.ts#L106-L112) — change from `{ role: pending.role, content: pending.content, tool_call: ..., tool_result: ... }` to `{ ...pending }` (the expanded `addMessage()` type now accepts this)
  - [`compaction-manager.ts:205-211`](../../src/chat/compaction-manager.ts#L205-L211) — same change
  - The spread will include `id`, `conversation_id`, `timestamp` from the original message, but `addMessage()` overwrites these internally — no conflict
  - Actually: the `Omit` type will reject `id`/`conversation_id`/`timestamp` from the spread. Use a destructuring pattern: `const { id, conversation_id, timestamp, ...rest } = pending; convManager.addMessage(rest);`

- [ ] **1.3 — Add `updateMessage()` method to `ConversationManager`**
  - Signature: `updateMessage(messageId: string, patch: Partial<Pick<Message, 'content' | 'exclude_from_compaction'>>): Message | null`
  - Find message by `id` in `this.messages` array
  - Apply patch via `Object.assign()`
  - Fire new `onMessageUpdated` callback (add alongside existing `onMessageAdded` at [`conversation.ts:369`](../../src/chat/conversation.ts#L369))
  - Return updated message, or `null` if not found
  - Add `setOnMessageUpdated(callback)` setter following the pattern of `setOnMessageAdded` and `setOnConversationChanged`

- [ ] **1.4 — Verify no regressions**
  - Search all `addMessage(` call sites — confirm they still compile with the new type
  - Confirm compaction flow: trigger compaction → re-appended messages preserve `is_hook_injection`, `is_workflow_message`, `hook_injections`, `attachments`, `auto_context`

---

## Phase 2 — Exhaustive Switch Guards

Standalone hardening. Add `assertUnreachable` (or `satisfies never`) guards to all role-dispatch switch statements so the compiler flags future role additions.

- [ ] **2.1 — Create `assertUnreachable` utility**
  - Add to `src/utils/` (or inline where TypeScript's `never` type suffices)
  - Signature: `function assertUnreachable(x: never): never { throw new Error("Unreachable: " + x); }`

- [ ] **2.2 — Audit and guard all role-dispatch sites**
  - Sites needing explicit `extension_block` case or default guard (per the plan's audit):
    - [ ] [`message-pipeline.ts:140`](../../src/chat/message-pipeline.ts#L140) — `toChatMessages()` switch (no default)
    - [ ] [`view-router.ts:53`](../../src/chat/view-router.ts#L53) — `renderMessage()` switch (no default)
    - [ ] [`compaction.ts:237-269`](../../src/context/compaction.ts#L237-L269) — compaction input if/else-if chain (no else)
    - [ ] [`context.ts:190-193`](../../src/chat/context.ts#L190-L193) — truncation walk-forward
    - [ ] [`markdown-exporter.ts:74`](../../src/export/markdown-exporter.ts#L74) — switch with `default: null`
    - [ ] [`html-exporter.ts:381`](../../src/export/html-exporter.ts#L381) — switch with `default: null`
    - [ ] [`html-exporter.ts:578`](../../src/export/html-exporter.ts#L578) — sub-agent message switch
    - [ ] [`conversation.ts:368`](../../src/chat/conversation.ts#L368) — title generation `role === "user"` check
    - [ ] [`runtime-context.ts:352`](../../src/extensions/runtime-context.ts#L352) — recent-turns filter
    - [ ] [`message-pipeline.ts:368`](../../src/chat/message-pipeline.ts#L368) — `extractPendingMessages()` backward search
  - Sites verified safe (document as comments or no-op cases):
    - Provider adapters (`anthropic-provider.ts:70`, `bedrock-provider.ts:106`, `openai-provider.ts:57`, `local-provider.ts:82`) — never see `extension_block` (translated in pipeline)
    - `compaction.ts:76` — token estimation fallback path, safe for any role
    - `context.ts:79` — same
    - `message-pipeline.ts:231-246` — tool call coalescing, only walks `tool_call`/`tool_result`
    - `message-pipeline.ts:300-331` — tool call repair, only inspects `tool_call`/`tool_result`/`assistant`
    - `history.ts:490`, `:547`, `:645` — correctly skips/includes based on explicit role checks
    - `conversation.ts:201-204` — fork auto-pairing, `tool_call`/`tool_result` only
    - `orchestrator.ts:748` — `on_conversation_start` trigger, explicit `user` check
    - `orchestrator.ts:975`, `workflow-executor.ts:649` — system message existence check

- [ ] **2.3 — Add `MessageRole` member count assertion test**
  - If the union gains a member, the test breaks until all dispatch sites are updated

- [ ] **2.4 — Audit ContentBlock type-dispatch sites**
  - [ ] [`tokens.ts:84-94`](../../src/utils/tokens.ts#L84-L94) — `estimateContentTokens()` switch (no default) — add default case
  - [ ] [`media/types.ts:40`](../../src/media/types.ts#L40) — `getTextContent()` — already planned for Phase 3
  - [ ] [`html-exporter.ts:443-451`](../../src/export/html-exporter.ts#L443-L451) — inline media rendering — add comment noting user messages won't contain custom blocks

---

## Phase 3 — `custom_block` Content Variant + `extension_block` Role + Wire Translation + Coalescing + Token Estimation

The core message shape. After this phase, extension blocks can be emitted (manually for testing) and will persist, render (via fallback), and translate to the wire correctly.

- [ ] **3.1 — Add `custom_block` to `ContentBlock` union**
  - In [`src/media/types.ts`](../../src/media/types.ts): add the `custom_block` variant with fields: `type`, `kind`, `data`, `fallback_text?`, `estimated_wire_tokens?`, `loading?`
  - Update `getTextContent()`: add a branch for `custom_block` → return `fallback_text ?? ""`

- [ ] **3.2 — Add `custom_block` case to `estimateContentTokens()`**
  - In [`src/utils/tokens.ts`](../../src/utils/tokens.ts): add `case "custom_block":`
  - Use `estimated_wire_tokens` when present (set at emission time from `toLLMText` output)
  - Fall back to `estimateTokenCount(fallback_text)`, then `estimateTokenCount(JSON.stringify(data))` as last resort
  - Blocks with `toLLMText → null` should set `estimated_wire_tokens: 0` at emission → counted as zero wire cost

- [ ] **3.3 — Add `"extension_block"` to `MessageRole` union**
  - In [`src/types.ts`](../../src/types.ts): extend the `MessageRole` union type
  - Add `source_extension?: string | null` to `Message` interface
  - Add `exclude_from_compaction?: boolean` to `Message` interface

- [ ] **3.4 — Handle `extension_block` in `toChatMessages()`**
  - In [`src/chat/message-pipeline.ts`](../../src/chat/message-pipeline.ts) at the role switch (~line 140):
  - Add `case "extension_block":` that:
    - Iterates `custom_block` entries in `msg.content`, calls `registry.toLLMText(data)` for each
    - Wraps non-null results in `<notor-ext source="{source_extension}">…</notor-ext>` tags
    - When all blocks resolve to `null` with no `fallback_text` → skip the message entirely (zero tokens)
    - Otherwise emit as `role: "user"` `ChatMessage` with the tagged text
  - The registry reference needs to be passed into `toChatMessages()` (add parameter or inject via closure)

- [ ] **3.5 — Add general consecutive-same-role coalescing pass**
  - After the existing tool-call coalescing (Phase 3 in the pipeline), add a final pass:
  - Iterate `ChatMessage[]`: when `messages[i].role === messages[i-1].role` and neither carries `tool_calls`/`tool_results`, merge `messages[i].content` into `messages[i-1].content` separated by `\n\n`
  - Fixes both extension-block adjacency AND the pre-existing hook-injection alternation bug (Bedrock's strict alternation requirement at [`bedrock-provider.ts:73`](../../src/providers/bedrock-provider.ts#L73))

- [ ] **3.6 — Handle `extension_block` in compaction input assembly**
  - In [`src/context/compaction.ts:237-269`](../../src/context/compaction.ts#L237-L269):
  - If `msg.exclude_from_compaction === true` → skip entirely
  - Otherwise extract text via `getTextContent()` and include as user-role in compaction input

- [ ] **3.7 — Handle `extension_block` in truncation walk-forward**
  - In [`src/chat/context.ts:190-193`](../../src/chat/context.ts#L190-L193):
  - Treat `extension_block` like `user` (it resolves to user on the wire) — don't orphan it as "non-user non-system"

- [ ] **3.8 — Handle `extension_block` in exporters**
  - [`markdown-exporter.ts`](../../src/export/markdown-exporter.ts): add case rendering source label + fallback text in Obsidian callout format
  - [`html-exporter.ts`](../../src/export/html-exporter.ts): add case at both `:381` and `:578` switches

- [ ] **3.9 — Handle `extension_block` in remaining dispatch sites**
  - [`conversation.ts:368`](../../src/chat/conversation.ts#L368): exclude `extension_block` from title generation (like `is_hook_injection`)
  - [`runtime-context.ts:352`](../../src/extensions/runtime-context.ts#L352): include `extension_block` in recent-turns context if relevant (or exclude — decide based on whether extensions benefit from seeing their own prior emissions)
  - [`compaction-manager.ts`](../../src/chat/compaction-manager.ts): filter out messages where `exclude_from_compaction === true` from the completed-messages set before compaction

- [ ] **3.10 — Smoke test with hand-emitted block**
  - Temporarily add a test pathway (e.g., a debug command) that calls `addMessage({ role: "extension_block", content: [{ type: "custom_block", kind: "test", data: { message: "hello" }, fallback_text: "Test block" }], source_extension: "test" })`
  - Verify: renders in chat (fallback text), persists in JSONL, survives reload, appears in wire as tagged user-role text, exports correctly, compaction handles it

---

## Phase 4 — Collapsible Helper + Refactor

DRY up the duplicated toggle pattern. Small scope, high payoff — every block-kind renderer will use this.

- [ ] **4.1 — Create `renderCollapsibleCard` helper**
  - Create [`src/ui/chat-blocks/collapsible-card.ts`](../../src/ui/chat-blocks/collapsible-card.ts)
  - Signature: `renderCollapsibleCard(container, opts: { headerText, icon?, defaultExpanded?, rootClass? }) → { root, header, body }`
  - Reuse existing CSS primitives: `.notor-tool-call-toggle`, `.notor-hidden`
  - Toggle behavior: click header → toggle `.notor-hidden` on body, swap `▶`/`▼` chevron
  - Returns `header` (for callers to append badges/buttons) and `body` (for content)

- [ ] **4.2 — Refactor `tool-call-ui.ts` to use helper**
  - [`tool-call-ui.ts:44-81`](../../src/ui/tool-call-ui.ts#L44-L81): replace the manual toggle creation with `renderCollapsibleCard()`
  - Verify: tool call cards expand/collapse identically, chevron animation unchanged

- [ ] **4.3 — Refactor `chat-view.ts` tool result rendering to use helper**
  - [`chat-view.ts:2208-2244`](../../src/ui/chat-view.ts#L2208-L2244): replace with `renderCollapsibleCard()`
  - Verify: tool result cards expand/collapse identically

---

## Phase 5 — `ChatBlockRegistry` + Renderer Contract

Make block kinds pluggable. After this phase, block kinds can be registered and resolved at render time.

- [ ] **5.1 — Create `ChatBlockRegistry` class**
  - Create [`src/ui/chat-blocks/registry.ts`](../../src/ui/chat-blocks/registry.ts)
  - Implement `register(def)`: store by `kind`, log error on duplicate (keep first)
  - Implement `get(kind)`: return definition or undefined
  - Implement `has(kind)`, `list()`
  - Implement `unregister(kind)` for extension reload cleanup

- [ ] **5.2 — Define `ChatBlockDefinition` interface**
  - Fields: `kind`, `displayName`, `icon?`, `render`, `toLLMText?`, `excludeFromCompaction?`, `renderLoading?`
  - Generic type parameter `<TData>` for typed `data` payloads

- [ ] **5.3 — Define `ChatBlockRenderContext` interface**
  - Fields: `message`, `app`, `openInternalLink`, `collapsibleCard` (from Phase 4 helper)

- [ ] **5.4 — Instantiate registry in `main.ts`**
  - Create `ChatBlockRegistry` instance during plugin `onload()`
  - Wire into: view router (for rendering), message pipeline (for `toLLMText` resolution), orchestrator (for emission-time `estimated_wire_tokens` calculation)

- [ ] **5.5 — Wire registry into `toChatMessages()` for `toLLMText` resolution**
  - Update the `extension_block` case from Phase 3.4 to use registry's `toLLMText` instead of a placeholder
  - When `toLLMText` is undefined on the definition, fall back to `fallback_text ?? ""`

---

## Phase 6 — Chat View Integration

Render `extension_block` messages as dedicated rows in the chat panel.

- [ ] **6.1 — Add `extension_block` case to `view-router.ts`**
  - In [`view-router.ts`](../../src/chat/view-router.ts) `renderMessage()` switch:
  - `case "extension_block": this.view?.renderExtensionBlock(message); break;`

- [ ] **6.2 — Implement `renderExtensionBlock()` in `chat-view.ts`**
  - Create row container with class `.notor-extension-block` (styled like `.notor-tool-call`)
  - Optional source header showing `source_extension` with icon
  - Iterate `message.content`:
    - For `custom_block`: look up `ChatBlockRegistry.get(kind)`
      - If found: call `def.render(container, block.data, ctx)` **wrapped in try-catch**
        - On error: clear container, show fallback error card with "Block render error: {kind}" header and raw JSON `data` in `<pre>` block. Log error with kind, data summary, stack trace
      - If `loading === true` and `def.renderLoading` exists: call `def.renderLoading(container, ctx)` instead
      - If `loading === true` and no `renderLoading`: show default spinner with `displayName`
      - If not found: render `fallback_text` in a collapsible with "Unregistered block kind: {kind}" warning
    - For `text` blocks: render as plain markdown (above/below custom block)

- [ ] **6.3 — Add minimal CSS for `.notor-extension-block`**
  - In [`styles.css`](../../styles.css): add `.notor-extension-block` styling
  - Reuse tool-call card CSS patterns (margin, border, padding)
  - Add subtle visual distinction (e.g., left-border accent color) to differentiate from tool calls

- [ ] **6.4 — Handle message update re-render**
  - Wire `onMessageUpdated` callback (from Phase 1.3) to the chat view
  - When an `extension_block` message is updated (loading → real), re-render the row:
    - Find the existing DOM element for the message
    - Clear its contents
    - Re-invoke `renderExtensionBlock()` with the updated message

- [ ] **6.5 — Verify reload persistence**
  - Emit a block, reload the plugin, reopen the conversation → block re-renders from persisted `data`
  - Unregister the block kind, reopen → renders fallback-text placeholder, no crash

---

## Phase 7 — `notor-type: block` Extension Type + Manager Integration

Allow user-authored block kinds in vault scaffolds and built-in block scaffolds.

- [ ] **7.1 — Add `"block"` to `ExtensionType` and define `UserBlockDefinition`**
  - In [`src/extensions/types.ts`](../../src/extensions/types.ts):
  - Extend `ExtensionType`: `"tool" | "automation" | "settings" | "block"`
  - Add `UserBlockDefinition` interface: `filePath`, `kind`, `displayName`, `icon?`, `rendererExport`, `toLLMTextExport?`, `excludeFromCompaction?`, `rawCode`, `compiledFn`, `isScaffold?`
  - Add `BlockKindDeclaration` interface for `blocks:` YAML on tools/automations: `kind`, `displayName`, `icon?`, `rendererExport`, `toLLMTextExport?`, `excludeFromCompaction?`
  - Add optional `blocks?: BlockKindDeclaration[]` to `UserToolDefinition` and `UserAutomationDefinition`

- [ ] **7.2 — Add `case "block"` to parser dispatch**
  - In [`src/extensions/parser.ts`](../../src/extensions/parser.ts) at the switch (~line 122-129):
  - Add `case "block": return parseBlockFile(frontmatter, codeFence, filePath);`
  - Implement `parseBlockFile()`: parse frontmatter fields `notor-block-kind`, `notor-display-name`, `notor-icon`, `notor-exclude-from-compaction`, and code fence (renderer + toLLMText exports). No `params` or `settings` YAML section
  - Also parse `blocks:` YAML section on tool/automation scaffolds (add to `parseToolFile` and `parseAutomationFile`)

- [ ] **7.3 — Update discovery to scan `{notor_dir}/blocks/`**
  - In [`src/extensions/discovery.ts`](../../src/extensions/discovery.ts):
  - Add `blocks: UserBlockDefinition[]` to `DiscoveryResult` interface
  - Add scan of `{notor_dir}/blocks/` directory for `.md` files, following the same pattern as `tools/` and `automations/` scans
  - Type-check: files must parse as `notor-type: block`; log and skip unexpected types

- [ ] **7.4 — Update manager to compile/register block kinds**
  - In [`src/extensions/manager.ts`](../../src/extensions/manager.ts):
  - On extension (re)compile:
    - For `notor-type: block` scaffolds: compile code fence, extract named exports (renderer, toLLMText), register with `ChatBlockRegistry`
    - For tool/automation scaffolds with `blocks:` YAML: pull named exports from compiled module, register
  - On extension unload/reload: unregister from `ChatBlockRegistry`
  - Duplicate kind detection: log error, keep first registration
  - Follow the existing `UserToolAdapter` compilation pattern at [`manager.ts:45-152`](../../src/extensions/manager.ts#L45-L152)

---

## Phase 8 — `notor-blocking` Opt-In for `on_conversation_start`

Enable blocking automations that emit blocks visible to the LLM on the first turn.

- [ ] **8.1 — Add blocking fields to automation definition**
  - In [`src/extensions/types.ts`](../../src/extensions/types.ts): add to `UserAutomationDefinition`:
    - `blocking?: boolean`
    - `blockingEmitKind?: string`
    - `blockingTimeout?: number`

- [ ] **8.2 — Parse `notor-blocking` frontmatter**
  - In [`src/extensions/parser.ts`](../../src/extensions/parser.ts): parse `notor-blocking` (boolean), `notor-blocking-emit-kind` (string), `notor-blocking-timeout` (number, default 10000ms) for automation files

- [ ] **8.3 — Partition `dispatchOnConversationStart()` into blocking/non-blocking**
  - In [`src/hooks/hook-events.ts`](../../src/hooks/hook-events.ts) at [`dispatchOnConversationStart()`](../../src/hooks/hook-events.ts#L823-L866):
  - Partition automations by `automation.blocking === true`
  - For each blocking automation with `blockingEmitKind`:
    - Emit preliminary loading `extension_block` message: `role: "extension_block"`, `custom_block` with `kind: blockingEmitKind`, `data: {}`, `loading: true`
    - Store the loading message ID for later replacement
  - Await blocking automations sequentially with per-automation timeout
  - On timeout: detach (continue in background), update loading block to timed-out indicator
  - Non-blocking automations: fire-and-forget as today
  - Change return type from `void` to `Promise<void>`
  - Need to pass `ConversationManager` (or an `emit` callback) into the function for loading block emission

- [ ] **8.4 — `await` the dispatch in orchestrator**
  - In [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts) at ~line 756:
  - Change from bare `dispatchOnConversationStart(...)` to `await dispatchOnConversationStart(...)`
  - Safe because the function only blocks when there are blocking automations; otherwise the returned promise resolves immediately

- [ ] **8.5 — Loading → real block replacement**
  - When blocking automation calls `chatBlocks.emit(kind, data)` (same kind as loading block):
  - Find the loading message by stored message ID
  - Call `ConversationManager.updateMessage(loadingMessageId, { content: updatedBlocks })` — replacing `data`, clearing `loading` flag
  - `onMessageUpdated` callback triggers re-render in chat view (Phase 6.4)

---

## Phase 9 — `utils.chatBlocks.emit()` API

The side-effect emission API for automations and tools. This is the sole block-emission path for pre_send automations.

- [ ] **9.1 — Implement `chatBlocks.emit` on `ExtensionUtils`**
  - In [`src/extensions/runtime-context.ts`](../../src/extensions/runtime-context.ts):
  - Add `chatBlocks` property to `ExtensionUtils`:
    ```
    chatBlocks: {
      emit: (kind, data, opts?) => Promise<Message | null>;
    } | null
    ```
  - Implementation:
    - Resolve conversation: `opts.conversationId` → explicit target; else `context.conversationId` from automation context; else `null`
    - Validate kind against `ChatBlockRegistry` — if unregistered, log warning, fall back to text-only block
    - Compute `estimated_wire_tokens` from `toLLMText` output length (via registry)
    - Call `ConversationManager.addMessage({ role: "extension_block", content: [custom_block], source_extension })` — use the display `ConversationManager` (not the session snapshot) so the message persists and renders
    - Set `exclude_from_compaction` on the message based on block kind's `ChatBlockDefinition.excludeFromCompaction`
    - Return the created `Message`, or `null` if no conversation found
  - Set `chatBlocks` to `null` when no conversation is available (background vault events)

- [ ] **9.2 — Wire `chatBlocks` into automation execution contexts**
  - Ensure `chatBlocks` is available in all automation triggers: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`, `on_conversation_start`, `on_schedule`, vault events
  - For vault events with no active conversation: `chatBlocks` is `null`
  - For `pre_send` (blocking): blocks land before session snapshot → LLM sees them
  - For `after_completion` (non-blocking): blocks land after snapshot → visible on subsequent turns

- [ ] **9.3 — Document LLM visibility constraint**
  - Add inline code comment at the emission site explaining: blocking automations → current-turn visibility; non-blocking → next-turn only
  - This is by design, not a bug

---

## Phase 10 — Tool `content_blocks` → `extension_block` Bridge

When a tool's `ToolResult.content_blocks` contains a `custom_block`, the orchestrator emits an `extension_block` message.

- [ ] **10.1 — Detect `custom_block` in tool results**
  - In [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts), after tool results are added to conversation:
  - Check each `ToolResult.content_blocks` for entries where `type === "custom_block"`
  - If found, collect them into a new `extension_block` message

- [ ] **10.2 — Emit `extension_block` after tool_result group**
  - Emit the `extension_block` message **after the entire tool_result group** in the current batch (after all tool results are added), but **before the next LLM call**
  - This preserves tool_call/tool_result coalescing that providers require
  - Set `source_extension` to the tool name

- [ ] **10.3 — Tool's textual result stays inline**
  - The tool-result bubble continues to render the text/media content blocks as before
  - The `extension_block` row is an additional rendering, not a replacement

---

## Phase 11 — `utils.runSubAgent` + Detached Spawn

Enable extensions to run sub-agents for background data gathering.

- [ ] **11.1 — Add `runSubAgent` to `ExtensionUtils`**
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

- [ ] **11.2 — Implement detached sub-agent lifecycle**
  - **Abort signal ownership:** Detached sub-agents create their own `AbortController`, linked to parent's signal (parent abort cascades to child, but child cleanup doesn't wait for parent)
  - **Active agent registry:** Plugin-level `Set<AbortController>` for running detached agents
    - Checked during `plugin.onunload()` — abort all active agents
    - Entries removed in a `finally` block wrapping the entire lifecycle (run → onComplete → cleanup)
  - **`onComplete` error boundary:** Framework wraps every `onComplete` invocation in try-catch. On error: log with profile name, conversation ID, stack trace. Never re-throw. Registry cleanup in enclosing `finally` (not dependent on `onComplete` succeeding)
  - **Timeout:** Configurable per invocation (default 60s). `setTimeout` calls `controller.abort()`. Existing abort handling in `SubAgentRunner` takes care of the rest

- [ ] **11.3 — Result delivery to inactive conversations**
  - `onComplete` calls `utils.chatBlocks.emit` with explicit `conversationId`
  - If conversation view is no longer active: message persists in JSONL but view doesn't live-update
  - Block appears on next conversation reload — acceptable expected behavior

- [ ] **11.4 — Verify integration**
  - `addMessage()` works on non-active conversations (via explicit `conversationId`)
  - Depth guard does not block recursive resolver calls from within sub-agents
  - Detached agent closure cleanup: no leaked registry entries after completion/abort/error/timeout

---

## Phase 12 — Rate Limit + Emission Gates

Safety controls for block emission.

- [ ] **12.1 — Add rate-limit settings**
  - In [`src/settings/types.ts`](../../src/settings/types.ts):
  - Add `extension_block_max_emits_per_window: number` (default 10)
  - Add `extension_block_rate_window_seconds: number` (default 60)

- [ ] **12.2 — Implement time-based sliding window rate limiter**
  - Per-conversation emission tracker (e.g., `Map<conversationId, number[]>` of timestamps)
  - On each `emit()` call: check count within the sliding window
  - If over limit: log warning, return `null`
  - Window slides automatically — after `rate_window_seconds`, old entries expire

- [ ] **12.3 — Implement emission gate for disabled extensions**
  - When the emitting extension is disabled (per existing enable semantics at [`manager.ts:495`](../../src/extensions/manager.ts#L495)):
    - Existing blocks in transcript render as `[disabled extension: {name}]` placeholders
    - New `emit()` calls no-op and return `null`

---

## Phase 13 — Verification & Polish

Comprehensive testing across all phases.

- [ ] **13.1 — Unit tests: ContentBlock**
  - `getTextContent` returns `fallback_text` for `custom_block`
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

- [ ] **13.5 — Unit tests: Compaction**
  - Block with `excludeFromCompaction: true` → skipped from compaction input
  - Block without flag → compacted normally
  - Re-appended messages preserve `source_extension`, `exclude_from_compaction`

- [ ] **13.6 — Unit tests: `addMessage()` expansion + `updateMessage()`**
  - `addMessage({ ...existingMessage })` preserves all fields
  - `updateMessage` with valid ID → patches content, fires callback
  - `updateMessage` with invalid ID → returns null, no callback
  - Loading → real transition: `loading: true` cleared, data replaced

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
