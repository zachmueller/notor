# Extension Chat Blocks — Design Spec

**Status:** Draft
**Date:** 2026-04-19
**Prerequisite:** None (foundational primitive)
**Source:** [extension-chat-blocks-plan.md](../../private/extension-chat-blocks-plan.md) (detailed planning doc)

---

## 1. Motivation

Notor's extension system (`src/extensions/`) lets users author tools and automations as Markdown files. Today these extensions can be invoked by the LLM (tools), observe LLM lifecycle events (automations), and return a string from `pre_send` automations that renders as a collapsible `<details>` block. However, they **cannot**:

1. Publish a **first-class, structured, persistently-rendered block** as its own chat row — with collapsible cards, clickable links, per-row actions, and custom body content.
2. Emit blocks from **any context** — today only `pre_send` reaches the UI. Tools emit inline text only. Automations outside `pre_send` (`after_completion`, `on_schedule`, vault events) are fully silent.
3. Spawn a **sub-agent** from extension code — the runner only exists behind the `use_subagent` tool.

This spec introduces a **generalized extension-chat-block primitive** that closes these gaps. Motivated by (but not limited to) the memory feature — any extension should be able to surface rich, interactive, persisted chat rows.

**Non-goals:** This does not change how tools return inline results (tool-result bubbles stay as-is), does not add a proactive/unsolicited LLM-to-user whisper channel, and does not generalize rendering beyond Notor's chat panel.

---

## 2. Design Overview

Four additions, each narrowly scoped:

1. **`ContentBlock` gains a `custom_block` variant** — a structured, typed payload that the chat view renders via a registered renderer.
2. **A new `"extension_block"` message role** — makes these blocks first-class rows in the transcript (persisted, replayable on reload, role-dispatched in the view router).
3. **A registry + renderer contract** (`ChatBlockRegistry`) — extensions associate a block `kind` with render/serializer functions, instead of the chat view baking in each block type.
4. **Emission APIs** — `utils.chatBlocks.emit()` for automations, `content_blocks` bridge for tools, `utils.runSubAgent` for background data gathering.

A reusable **`renderCollapsibleCard`** helper consolidates the duplicated toggle pattern from [`tool-call-ui.ts:44-81`](../../src/ui/tool-call-ui.ts#L44-L81) and [`chat-view.ts:2208-2244`](../../src/ui/chat-view.ts#L2208-L2244).

---

## 3. The `custom_block` Content Block Variant

**Modify** [`src/media/types.ts`](../../src/media/types.ts):

Add a fourth union member to `ContentBlock`:

```typescript
| {
    type: "custom_block";
    kind: string;                        // Registered block kind → resolved to renderer via ChatBlockRegistry
    data: Record<string, unknown>;       // Block-specific structured payload, opaque to core
    fallback_text?: string;              // Rendered when renderer unavailable or for getTextContent()
    estimated_wire_tokens?: number;      // Pre-computed from toLLMText output length; avoids registry lookups in estimation
    loading?: boolean;                   // True during blocking automation placeholder phase
  }
```

**`getTextContent()` update:** For a `custom_block`, return `fallback_text ?? ""`. Keeps existing call sites (search, history, title generation) working.

**Design decision:** Extend `ContentBlock` union rather than a parallel field — keeps the message content model unified (one array, one type) and flows through the existing content pipeline without special cases.

---

## 4. The `"extension_block"` Message Role

**Modify** [`src/types.ts`](../../src/types.ts):

```typescript
export type MessageRole = "system" | "user" | "assistant" | "tool_call" | "tool_result" | "extension_block";
```

Add to `Message`:

```typescript
source_extension?: string | null;      // Extension name that produced this message (role === "extension_block" only)
exclude_from_compaction?: boolean;      // Denormalized from ChatBlockDefinition; checked by compaction manager
```

**Rules:**
- `content` must contain at least one `custom_block`. Additional `text` blocks may accompany.
- Persisted in JSONL like any other message — replayed identically on reload.
- Rendered as a dedicated row between surrounding messages.
- **Provider-wire translation:** configurable per block kind via `toLLMText`. When all blocks resolve to `null` (no `fallback_text`), the entire message is **dropped from wire** — zero LLM tokens. When non-null, emitted as `role: "user"` with tagged `toLLMText` output (e.g., `<notor-ext source="memory-search">…</notor-ext>`).
- **Consecutive-role coalescing:** A general pass at the end of `toChatMessages()` merges consecutive same-role messages. Fixes both extension blocks and a pre-existing hook-injection alternation bug.

**Why a new role:** Transcript/UI clarity (distinct from user/assistant), fits existing role-dispatch pattern in view-router, and the role is Notor-internal — providers never see it (translated at the pipeline boundary).

### Role-dispatch audit

Adding a new role requires explicit handling at **22+ role-dispatch sites**. After adding, every switch on `msg.role` must have an explicit `extension_block` case or verified safe fall-through. Add `assertUnreachable` guards to enforce compiler-checked exhaustiveness.

### ContentBlock type-dispatch audit

Adding `custom_block` requires handling at: `estimateContentTokens()` (currently no default — silently contributes 0), `getTextContent()` (§3 above), and export renderers (safe — user messages won't contain custom blocks).

---

## 5. ChatBlock Registry + Renderer Contract

**Create** [`src/ui/chat-blocks/registry.ts`](../../src/ui/chat-blocks/registry.ts):

```typescript
export interface ChatBlockDefinition<TData = Record<string, unknown>> {
  kind: string;                   // Globally unique block kind identifier
  displayName: string;            // e.g., "Memories Recalled"
  icon?: string;                  // Emoji or Lucide icon name
  render: (container: HTMLElement, data: TData, ctx: ChatBlockRenderContext) => void;
  toLLMText?: (data: TData) => string | null;     // null → omit from LLM context
  excludeFromCompaction?: boolean;                 // Default false
  renderLoading?: (container: HTMLElement, ctx: ChatBlockRenderContext) => void;
}

export interface ChatBlockRenderContext {
  message: Message;
  app: import("obsidian").App;
  openInternalLink: (linkText: string) => void;
  collapsibleCard: (container, opts) => { header: HTMLElement; body: HTMLElement };
}

export class ChatBlockRegistry {
  register(def: ChatBlockDefinition): void;
  get(kind: string): ChatBlockDefinition | undefined;
  has(kind: string): boolean;
  list(): ChatBlockDefinition[];
}
```

**Key design principle: render ≠ wire.** `render` and `toLLMText` are deliberately independent projections of the same `data` payload. A block might render only clickable links in the UI while sending full note bodies to the LLM. This is a first-class design contract, not an implementation detail.

**Registration lifecycle:** Plugin-scoped registry instantiated in `main.ts`. Built-in kinds register at plugin load. User extensions register via scaffold frontmatter + code fence exports.

**Unknown kind fallback:** Renders `fallback_text` inside a minimal collapsible with "Unregistered block kind: {kind}" warning header.

---

## 6. Shared Collapsible Helper

**Create** [`src/ui/chat-blocks/collapsible-card.ts`](../../src/ui/chat-blocks/collapsible-card.ts):

```typescript
export function renderCollapsibleCard(
  container: HTMLElement,
  opts: { headerText: string; icon?: string; defaultExpanded?: boolean; rootClass?: string },
): { root: HTMLElement; header: HTMLElement; body: HTMLElement };
```

Reuses existing `.notor-tool-call-toggle` / `.notor-hidden` CSS primitives. **Refactors** [`tool-call-ui.ts:44-81`](../../src/ui/tool-call-ui.ts#L44-L81) and [`chat-view.ts:2208-2244`](../../src/ui/chat-view.ts#L2208-L2244) to use this helper — eliminates current duplication and ensures all collapsible cards share one interaction model.

---

## 7. Extension Authoring Surface

### 7a. Block kinds declared in tool/automation scaffolds

Extensions declare blocks in a `blocks:` YAML section alongside `params` and `settings`:

```yaml
blocks:
  - kind: memory_recalled
    display_name: Memories Recalled
    icon: 🧠
    renderer_export: renderMemoryRecalledBlock
    to_llm_text_export: memoryRecalledBlockToText
```

The code fence exports the named render/serializer functions.

### 7b. `notor-type: block` — Standalone block-kind extension type

Block kinds that exist independently (not attached to a tool or automation) are authored as `notor-type: block` scaffolds. Discovered from `{notor_dir}/blocks/`. Frontmatter: `notor-type: block`, `notor-block-kind`, `notor-display-name`, `notor-icon`, `notor-exclude-from-compaction`.

Adds `"block"` to `ExtensionType` union and `UserBlockDefinition` interface to [`src/extensions/types.ts`](../../src/extensions/types.ts).

### 7c. `notor-blocking` — Opt-in blocking for `on_conversation_start`

**Problem:** `on_conversation_start` is fire-and-forget. Any `extension_block` emitted by an async automation arrives after the orchestrator's message snapshot — the LLM never sees it on the first turn.

**Solution:** `notor-blocking: true` frontmatter opt-in. Only meaningful for `on_conversation_start`.

- Blocking automations are awaited before the turn proceeds, subject to configurable timeout (`notor-blocking-timeout`, default 10s).
- If `notor-blocking-emit-kind` is set, a preliminary loading `extension_block` is emitted before execution (rendered via `renderLoading` or default spinner).
- On timeout, the automation is detached (continues in background); the turn proceeds without the block in LLM context.
- Non-blocking automations remain fire-and-forget.
- Orchestrator changes from bare `dispatchOnConversationStart(...)` to `await dispatchOnConversationStart(...)`.

---

## 8. Emission APIs

### 8a. From a tool (via `content_blocks`)

Tools already return `content_blocks?: ContentBlock[]` in `ToolResult`. When a tool's `content_blocks` contains a `custom_block`, the orchestrator emits an additional `role: "extension_block"` message **after the entire tool_result group** (preserving tool_call/tool_result coalescing). The tool's textual result stays inline in the tool bubble.

### 8b. From an automation (`utils.chatBlocks.emit`)

```typescript
chatBlocks: {
  emit: (kind: string, data: Record<string, unknown>, opts?: { fallbackText?: string; conversationId?: string }) => Promise<Message | null>;
} | null;
```

Wraps `ConversationManager.addMessage` with `role: "extension_block"` and bookkeeping. Returns `null` when no active conversation.

**LLM visibility constraint:** Blocks emitted during **blocking** automations (`pre_send`, blocking `on_conversation_start`) land before the session snapshot → included in LLM context. Blocks from **non-blocking** automations land after → visible on subsequent turns only.

### 8c. `utils.runSubAgent` — Detached sub-agent spawn

```typescript
runSubAgent: (opts: {
  profileName: string;
  task: string;
  detached?: boolean;
  onComplete?: (result: SubAgentResult) => Promise<void> | void;
  iterationCap?: number;
}) => Promise<SubAgentResult | null>;
```

Wraps `SubAgentRunner`. Detached sub-agents create their own `AbortController` linked to parent's signal. Plugin maintains an active-agent registry for cleanup on `onunload()`. `onComplete` callbacks are wrapped in try-catch error boundaries. Configurable timeout (default 60s).

---

## 9. Emission Gates (Safety + User Control)

1. **Registry-level:** Blocks only render if the owning extension is enabled. Disabled extensions' blocks render as `[disabled extension: {name}]` placeholders.
2. **Per-conversation rate limit:** `extension_block_max_emits_per_window` (default 10) with `extension_block_rate_window_seconds` (default 60). Time-based sliding window — handles all emission contexts uniformly.

---

## 10. Storage & Persistence

- `extension_block` messages persist in existing conversation JSONL.
- `custom_block.data` must be JSON-serializable (extensions derive runtime state from serialized data at render time).
- No separate storage layer.

---

## 11. Files to Create/Modify

| File | Action |
|------|--------|
| `src/media/types.ts` | Add `custom_block` variant to `ContentBlock`; update `getTextContent` |
| `src/types.ts` | Add `"extension_block"` to `MessageRole`; add `source_extension`, `exclude_from_compaction` to `Message` |
| `src/ui/chat-blocks/registry.ts` | **Create** — `ChatBlockDefinition`, `ChatBlockRegistry` |
| `src/ui/chat-blocks/collapsible-card.ts` | **Create** — `renderCollapsibleCard` helper |
| `src/ui/chat-view.ts` | Add `renderExtensionBlock`; refactor collapsible duplication |
| `src/ui/tool-call-ui.ts` | Refactor to use collapsible helper |
| `src/chat/view-router.ts` | Dispatch `extension_block` role |
| `src/chat/message-pipeline.ts` | Translate `extension_block` → `user`-role wire text; add consecutive-role coalescing pass |
| `src/chat/conversation.ts` | Expand `addMessage()` signature; add `updateMessage()` + `onMessageUpdated` callback |
| `src/chat/compaction-manager.ts` | Filter `exclude_from_compaction` messages; fix re-append loops to spread all fields |
| `src/chat/orchestrator.ts` | Emit `extension_block` from tool `content_blocks`; `await dispatchOnConversationStart()` |
| `src/extensions/types.ts` | Add `"block"` to `ExtensionType`; `UserBlockDefinition`; blocking fields on automation def |
| `src/extensions/parser.ts` | Add `case "block"` dispatch; parse `blocks:` YAML; parse `notor-blocking` frontmatter |
| `src/extensions/discovery.ts` | Add `blocks` to `DiscoveryResult`; scan `{notor_dir}/blocks/` |
| `src/extensions/manager.ts` | Discover/compile/register block scaffolds; register kinds from tool/automation `blocks:` sections |
| `src/extensions/runtime-context.ts` | Add `chatBlocks.emit` + `runSubAgent` to `ExtensionUtils` |
| `src/hooks/hook-events.ts` | Partition `dispatchOnConversationStart` into blocking/non-blocking; loading block lifecycle |
| `src/utils/tokens.ts` | Add `custom_block` case to `estimateContentTokens()` |
| `src/settings/types.ts` | Add rate-limit settings |
| `src/context/compaction.ts` | Handle `extension_block` in compaction input assembly |
| `src/chat/context.ts` | Treat `extension_block` like `user` in truncation walk-forward |
| `src/export/markdown-exporter.ts` | Add `extension_block` case |
| `src/export/html-exporter.ts` | Add `extension_block` case |
| `src/main.ts` | Instantiate `ChatBlockRegistry`; wire into view and pipeline |
| `styles.css` | Minimal `.notor-extension-block` styling |

---

## 12. Relationship to the Memory Plan

This primitive is a **prerequisite** for the memory plan:

- Memory-search runs from an `on_conversation_start` automation with `notor-blocking: true`, using `utils.runSubAgent`.
- Matches are emitted via `chatBlocks.emit` using a built-in `memory_recalled` block kind.
- Capture runs from an `after_completion` automation using `utils.runSubAgent({ detached: true })`.
- Dream runs from an `on_schedule` automation, also via `utils.runSubAgent`.

The memory plan layers built-in scaffolds on top of this primitive. None of the memory code needs to touch the chat view, the role system, or the extension manager.

---

## 13. Open Questions

1. **Token accounting:** `extension_block` wire text counts toward input tokens like any `user` message. Worth a `MessageRole`-aware note in the accounting path.
2. **Streaming render:** Initial scope assumes atomic emission. A future `stream` variant (incremental data + live re-render) can be added later.
3. **Cross-conversation emission:** `chatBlocks.emit` accepts explicit `conversationId`; returns `null` if the conversation doesn't exist.
