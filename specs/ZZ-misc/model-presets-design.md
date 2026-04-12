# Model Presets, Settings Restructure, and LLM Title Generation

**Status:** Draft (v1.0)
**Date:** 2026-04-12

---

## 1. Motivation

Today, model selection in Notor uses a split `active_provider` type + per-provider `model_id` — two fields joined at runtime and threaded through settings, chat panel, conversations, personas, and orchestration. This forces users to think in terms of provider+model pairs rather than intent (e.g., "use my cheap model" vs "use my powerful model"). Changing models requires navigating two separate dropdowns, and there's no way to express model *roles* that other features (personas, workflows, title generation) can reference by name.

This spec introduces three connected features:

1. **Model Presets** — named aliases (`tiny`, `small`, `medium`, `large`, plus user-defined) that each map to a single `provider_type + model_id + use_extended_context` tuple. Presets become the universal model selection abstraction across the system.
2. **Settings restructure** — "Provider setup" splits into "Providers" (connection configs) and "Models" (preset management + default selection). Chat panel popover consolidates to a single preset dropdown.
3. **LLM-powered title generation** — enabled by new automation infrastructure: an `on_conversation_start` trigger and a conversation metadata extension API. Ships as a pre-packaged user automation, default off.

### Key Architecture Reference

The model selection system is built on these classes:

- **`ProviderRegistry`** ([`providers/index.ts`](../../src/providers/index.ts)) — manages provider instances, caches model lists with 5-minute TTL, factory-based lazy initialization for 4 provider types (local, anthropic, openai, bedrock).
- **`ChatOrchestrator`** ([`chat/orchestrator.ts`](../../src/chat/orchestrator.ts)) — per-orchestrator mutable state: `activeProviderType`, `activeModelId`, `activeUseExtendedContext`. These are the resolved concrete values used by session creation.
- **`ConversationSession`** ([`chat/conversation-session.ts`](../../src/chat/conversation-session.ts)) — pins `providerType`, `modelId`, `useExtendedContext` at creation (immutable for session lifetime). The response loop reads these pinned values.
- **`ConversationLifecycleManager`** ([`chat/conversation-lifecycle.ts`](../../src/chat/conversation-lifecycle.ts)) — `newConversation()` reads the orchestrator's active provider/model fields; `switchConversation()` display-restores from stored `Conversation.provider_id`/`model_id` and syncs back to orchestrator state.
- **`NotorChatView`** ([`ui/chat-view.ts`](../../src/ui/chat-view.ts)) — `openSettingsPopover()` (L2588) and `buildModelSelect()` (L2687) render the current separate Provider + Model dropdowns. Display override methods: `updateProviderDisplay()`, `updateModelDisplay()`, `clearDisplayOverrides()`.
- **`ConversationManager`** ([`chat/conversation.ts`](../../src/chat/conversation.ts)) — `generateTitle()` (L490) is purely local string truncation (first user message -> 80 chars). `addMessage()` (L293) auto-generates title from first non-hook user message.
- **`HistoryManager`** ([`chat/history.ts`](../../src/chat/history.ts)) — JSONL persistence with per-file write queue (`enqueueWrite()`, L92-138). Race-safe serialization of header updates.
- **`ExtensionManager`** ([`extensions/manager.ts`](../../src/extensions/manager.ts)) — user automation discovery, compilation, registration. Automations trigger on `AutomationTrigger` events. Built-in tools/automations use `isScaffold` pattern.
- **`Persona`** ([`types.ts:342`](../../src/types.ts)) — `preferred_provider` + `preferred_model` override fields. Parsed from frontmatter.

### Current Model Selection Flow

```
Settings Popover (chat-view.ts)
  ├── Provider dropdown → onProviderChange()
  └── Model dropdown → onModelChange()
          │
          ▼
main.ts callback (L2566)
  ├── parseOptionValue() → { modelId, isExtendedContext }
  ├── orchestrator.setActiveModel(modelId, isExtendedContext)
  ├── registry.updateConfig(model_id)
  └── historyManager.updateConversationHeader()
          │
          ▼
Session creation (orchestrator.ts)
  ├── Reads activeProviderType / activeModelId / activeUseExtendedContext
  └── Pins them on ConversationSession (immutable)
          │
          ▼
Response loop (orchestrator.ts:945-952)
  ├── provider = registry.getProvider(session.providerType)
  └── provider.sendMessage(messages, tools, { model: session.modelId })
```

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Preset shape | Single mapping (one provider + model + extended_context per preset) | Simple, predictable. No fallback chains. Users create separate presets if they want alternatives. |
| Extended context | Part of the preset definition | When a user picks a model for a preset, they inherently configure whether it's the 1M variant. No auto-doubling of default presets — users add variants to their liking. |
| Preset scope | Universal — presets everywhere | Presets become THE model selection abstraction (Personas, Workflows, sub-agents, chat panel, orchestration). Direct provider+model becomes fallback/override only. |
| Conversation storage | Dual: preset_name + provider_id + model_id | Robust recovery. Preset name for display, concrete values for actual execution. Stale presets fall back to stored concrete values as "Custom". |
| Settings layout | "Providers" (connections) + "Models" (presets + default) | Clean separation of concerns. Default preset selector lives in the Models section. |
| Chat panel | Single preset dropdown + "Custom" escape hatch | Replaces the current two-dropdown (provider + model) approach. "Custom" reveals provider+model dropdowns for one-off selection. |
| Title generation | Pre-packaged user automation (not hard-coded feature) | Requires new infra: `on_conversation_start` trigger + conversation metadata API. Ships default-off. Fully customizable. |
| Trigger type | New discrete `on_conversation_start` trigger | Cleaner semantics than a filter on `pre_send`. Fires once per conversation after first user message, before LLM call. |
| Metadata API scope | Safe subset (title, is_favorite) | Prevents automations from corrupting provider/model/token tracking. Expandable later. |
| Persona integration | New `preferred_preset` field, takes precedence over direct fields | Gradual migration. Old `preferred_provider` + `preferred_model` continue working as fallback. |

---

## 3. Data Model Changes

### 3.1 New type: `ModelPreset`

**File:** [`src/types.ts`](../../src/types.ts)

```typescript
/** A named model preset mapping a user-facing name to concrete provider+model details. */
export interface ModelPreset {
  /** User-visible name — unique key (e.g., "tiny", "small", "medium", "large", or custom). */
  name: string;
  /** Provider type this preset maps to (null = not yet configured by user). */
  provider_type: LLMProviderType | null;
  /** Model ID this preset maps to (null = not yet configured by user). */
  model_id: string | null;
  /** Whether to use extended context (1M) for this model. */
  use_extended_context: boolean;
}
```

### 3.2 Settings additions

**File:** [`src/settings/types.ts`](../../src/settings/types.ts) — `NotorSettings`

```typescript
/** Ordered list of model presets. Order determines display order in chat panel dropdown. */
model_presets: ModelPreset[];

/** Name of the default preset for new conversations (must reference a configured preset). */
default_preset: string;

/** Whether the built-in title generation automation is enabled. Default: false. */
title_generation_enabled: boolean;

/** Preset name to use for title generation LLM calls. Default: "small". */
title_generation_preset: string;
```

### 3.3 Conversation additions

**File:** [`src/types.ts`](../../src/types.ts) — `Conversation`

```typescript
/**
 * Preset name active when conversation was created (null/undefined for pre-preset
 * conversations or "Custom" manual selection).
 */
preset_name?: string | null;
```

### 3.4 Persona additions

**File:** [`src/types.ts`](../../src/types.ts) — `Persona`

```typescript
/**
 * Override preset name (null = use global default). Takes precedence over
 * preferred_provider/preferred_model when set and the preset is valid.
 * Parsed from frontmatter key `notor-preferred-preset`.
 */
preferred_preset: string | null;
```

### 3.5 Default presets

**File:** [`src/settings/defaults.ts`](../../src/settings/defaults.ts)

```typescript
export const DEFAULT_MODEL_PRESETS: ModelPreset[] = [
  { name: "tiny",   provider_type: null, model_id: null, use_extended_context: false },
  { name: "small",  provider_type: null, model_id: null, use_extended_context: false },
  { name: "medium", provider_type: null, model_id: null, use_extended_context: false },
  { name: "large",  provider_type: null, model_id: null, use_extended_context: false },
];
```

Default `default_preset: "medium"` — but since `medium` has `provider_type: null`, users must configure a provider before they can use it.

### 3.6 AutomationTrigger addition

**File:** [`src/extensions/types.ts`](../../src/extensions/types.ts)

```typescript
export type AutomationTrigger =
  | "pre_send"
  | "on_tool_call"
  | "on_tool_result"
  | "after_completion"
  | "on_conversation_start"  // NEW — fires once per conversation, before first LLM call
  | "on_note_open"
  | "on_note_create"
  | "on_save"
  | "on_manual_save"
  | "on_tag_change"
  | "on_schedule";
```

---

## 4. Preset Resolver

**New file:** `src/presets/preset-resolver.ts`

Central module — the single source of truth for converting a preset name into concrete provider+model+extended values.

```typescript
export interface ResolvedPreset {
  presetName: string;
  providerType: LLMProviderType;
  modelId: string;
  useExtendedContext: boolean;
}

/**
 * Resolve a preset name to concrete model details.
 * Returns null if the preset doesn't exist or isn't configured (provider_type/model_id is null).
 */
export function resolvePreset(presetName: string, presets: ModelPreset[]): ResolvedPreset | null;

/**
 * Check if a stored preset is stale — i.e., the preset name still exists but now
 * maps to a different provider/model than what was stored on the conversation.
 */
export function isPresetStale(
  presetName: string,
  storedProvider: string,
  storedModel: string,
  presets: ModelPreset[],
): boolean;

/**
 * Find the first configured preset (provider_type != null) in the list.
 * Used as ultimate fallback when the default preset is unconfigured.
 */
export function findFirstConfiguredPreset(presets: ModelPreset[]): ResolvedPreset | null;
```

**Usage:** Every call site that currently reads `active_provider` + `model_id` from settings should instead resolve through the default preset. Fallback: if preset is null/unconfigured, fall back to the existing `active_provider` + provider config `model_id` for backward compat.

---

## 5. Settings UI Restructure

### 5.1 Rename "Provider setup" to "Providers"

The section contains ONLY connection/credential configuration (API keys, endpoints, regions, auth methods). The active provider dropdown remains here — it controls which provider connections are available.

Model selection is removed from individual provider sections (model_id selection moves to preset rows in the Models section).

### 5.2 New "Models" section

Positioned between "Providers" and "Conversation" in the settings tab.

**New file:** `src/settings/sections/model-presets.ts`

Contents:
1. **Default preset selector** — dropdown showing only configured presets (those where `provider_type != null`). If no presets are configured, shows a message directing users to configure one below.
2. **Preset list** — editable rows, each containing:
   - Name (text input, must be unique, non-empty)
   - Provider dropdown (from enabled providers; shows "(not configured)" if provider_type is null)
   - Model dropdown (populated from selected provider's model list via existing `ProviderRegistry.getModels()` + `model-grouping.ts`; `::1m` variants represent extended context)
   - Delete button (disabled for the preset that is `default_preset`)
3. **Add preset button** — appends a new unconfigured preset with auto-generated name
4. Reorder support (up/down arrows or drag — order = display order in chat panel dropdown)

### 5.3 Settings tab group order

**File:** [`src/settings/settings-tab.ts`](../../src/settings/settings-tab.ts)

```
1. General (expanded)
2. Providers (was "Provider setup", expanded)
3. Models (new, expanded)
4. Conversation (expanded)
5. Personas (collapsed)
6. Sub-agents (collapsed)
7. Rules and workflows (collapsed)
8. Tools (expanded)
9. MCP servers (expanded)
10. Automation (collapsed) — gains title generation toggle + preset selector
11. Storage (collapsed)
12. Reference (collapsed)
```

### Files modified
- [`src/settings/settings-tab.ts`](../../src/settings/settings-tab.ts) — rename group, add Models group, reorder
- [`src/settings/sections/active-provider.ts`](../../src/settings/sections/active-provider.ts) — update section heading
- New: `src/settings/sections/model-presets.ts` — Models section renderer
- Provider sections — remove model_id selection UI (model selection moves to preset rows)

---

## 6. Chat Panel Popover Overhaul

### 6.1 New preset dropdown

**File:** [`src/ui/chat-view.ts`](../../src/ui/chat-view.ts)

Replace the current separate Provider + Model dropdowns in `openSettingsPopover()` with a single preset-based selector. New method: `buildPresetSelect()` (replaces `buildModelSelect()`).

**Dropdown structure:**
```
[Model Preset ▾]
  ├── tiny          greyed: Anthropic · claude-haiku-4-5
  ├── small         greyed: Bedrock · claude-sonnet-4-6
  ├── medium  ✓     greyed: Bedrock · claude-sonnet-4-6 · 1M
  ├── large         greyed: Anthropic · claude-opus-4-6
  ├── ──────────────
  └── Custom...     greyed: Select specific provider & model
```

When "Custom..." is selected:
- Show the existing Provider dropdown + Model dropdown (reuse current logic from `buildModelSelect()`)
- This selection stores `preset_name: null` on the conversation

Unconfigured presets (provider_type is null) are shown but disabled/greyed with "(not configured)" text.

### 6.2 Callbacks

New callback: `onPresetChange(presetName: string | null, providerType?: LLMProviderType, modelId?: string, useExtendedContext?: boolean)`

- When a preset is selected: resolve it via `resolvePreset()`, call the callback with all values
- When "Custom" + manual provider/model selection: callback with `presetName: null` and the selected provider/model
- The callback (wired in `main.ts`) updates orchestrator's `activeProviderType`/`activeModelId`/`activeUseExtendedContext` and persists to conversation header

### 6.3 Display-restore on conversation switch

In `switchConversation()` ([`conversation-lifecycle.ts`](../../src/chat/conversation-lifecycle.ts)):

1. If `preset_name` is set:
   - Check `isPresetStale()` against stored `provider_id`/`model_id`
   - If not stale: show preset name in dropdown
   - If stale: show "Custom" with notice: "Preset '{name}' has changed since this conversation was created"
2. If `preset_name` is null/undefined: show "Custom" with stored provider+model
3. If stored provider/model is no longer accessible (provider disabled/removed): show notice, fall back to default preset

New view methods:
- `updatePresetDisplay(presetName: string | null)` — replaces current `updateProviderDisplay()` + `updateModelDisplay()` pair
- Internally manages the dropdown selected state and the "Custom" fallback display

### Files modified
- [`src/ui/chat-view.ts`](../../src/ui/chat-view.ts) — `buildPresetSelect()`, `updatePresetDisplay()`, popover restructure
- [`src/main.ts`](../../src/main.ts) — wire up `onPresetChange` callback
- [`src/chat/conversation-lifecycle.ts`](../../src/chat/conversation-lifecycle.ts) — preset-aware display restore in `switchConversation()`

---

## 7. Conversation Storage and Lifecycle

### 7.1 Creating conversations

In `newConversation()` ([`conversation-lifecycle.ts`](../../src/chat/conversation-lifecycle.ts)):
- Pass `preset_name` alongside `provider_id` + `model_id` + `use_extended_context`
- If using a preset: `preset_name = "medium"`, `provider_id = "bedrock"`, `model_id = "..."`, etc.
- If using Custom: `preset_name = null`

`createConversation()` in [`conversation.ts`](../../src/chat/conversation.ts) gains an optional `preset_name` parameter.

### 7.2 JSONL header

The `Conversation` header line gains `preset_name`. Old JSONL files without it parse as `undefined` (treated as Custom). **No migration script needed.**

### 7.3 ConversationListEntry

The `ConversationListEntry` interface ([`chat-view.ts`](../../src/ui/chat-view.ts)) gains an optional `preset_name?: string` field for display context in the conversation list (could show preset badge).

### 7.4 Switching conversations

In `switchConversation()`:
- Read `preset_name` from loaded conversation header
- Run `isPresetStale()` to determine dropdown display
- Call `view.updatePresetDisplay(presetName | null)`
- Continue syncing `setActiveProviderType` / `setActiveModelId` / `setActiveUseExtendedContext` from the **stored concrete values** (not from preset resolution — the stored values are authoritative for the conversation)

---

## 8. Orchestration Integration

### 8.1 Session creation — no changes needed

`ConversationSession` continues to pin `providerType`, `modelId`, `useExtendedContext` at creation. These are resolved from the preset at **selection time** (in the chat panel callback), not at send time. The session and response loop are unaffected.

### 8.2 Per-orchestrator state — no changes needed

The orchestrator's `activeProviderType` / `activeModelId` / `activeUseExtendedContext` fields remain the resolved concrete values. Preset resolution happens at the UI layer boundary.

### 8.3 Background workflows

Background workflow model resolution flows through the **persona system**, not the workflow executor. `WorkflowExecutor` ([`workflows/workflow-executor.ts`](../../src/workflows/workflow-executor.ts)) is a stateless prompt-assembly pipeline (body reading, include resolution, wrapping, context building) — it does not interact with the provider registry.

Provider/model resolution for workflows happens in `PersonaManager.applyProviderModelOverrides()` ([`personas/persona-manager.ts`](../../src/personas/persona-manager.ts), private method called during `activatePersona()`), which calls `providerRegistry.switchProvider()` and `providerRegistry.updateConfig()`. The preset-aware integration point is therefore `persona-manager.ts`: when a workflow activates a persona with `preferred_preset`, the `applyProviderModelOverrides()` resolution priority (see Section 9.1) handles preset resolution. For workflows without a persona override, the orchestrator's active preset (resolved at session creation time) applies.

---

## 9. Persona and Workflow Integration

### 9.1 Persona preset override

**File:** [`src/personas/persona-manager.ts`](../../src/personas/persona-manager.ts)

Resolution priority in `applyProviderModelOverrides()`:
1. `preferred_preset` -> resolve via `resolvePreset()` -> if valid, use its provider+model+extended
2. `preferred_provider` + `preferred_model` -> existing direct override (fallback)
3. Global default (from default preset or settings)

### 9.2 Persona frontmatter

**File:** [`src/personas/persona-discovery.ts`](../../src/personas/persona-discovery.ts)

Parse new frontmatter key `notor-preferred-preset`:

```yaml
---
notor-preferred-preset: small
notor-preferred-provider: null    # optional fallback
notor-preferred-model: null       # optional fallback
---
```

### 9.3 Workflows

Workflows that override persona inherit this behavior through the persona system. No direct preset field on Workflow is needed at this stage — it flows through persona overrides.

---

## 10. `on_conversation_start` Trigger

### 10.1 Trigger semantics

Fires **once per conversation**, after the first user message is submitted but **before** it is sent to the LLM. Semantically distinct from `pre_send` (which fires on every message).

The trigger should be **non-blocking** — automations fire asynchronously and do not delay the first LLM call. This is important because title generation involves its own LLM call and should not add latency to the user's first response.

### 10.2 Trigger point

In the orchestrator's response loop (or the `addMessage()` path), detect the first user message of a conversation:
- Check: `role === "user"` AND `!is_hook_injection` AND conversation has no prior user messages
- Fire `extensionManager.getAutomationsForTrigger("on_conversation_start")` and execute them asynchronously (fire-and-forget with error logging)

### 10.3 Automation context

The `on_conversation_start` automations receive their data via the `context` parameter (the 7th positional arg to the compiled automation function — `Record<string, unknown>`, see `executeAutomation()` in [`manager.ts:418-455`](../../src/extensions/manager.ts)). The `context` object for this trigger contains:

- `context.conversationId` — the conversation UUID
- `context.firstMessage` — text content of the first user message
- `context.conversationApi` — the new metadata API (see Section 11)

The standard `utils`, `libs`, `settings`, and `shared` objects are passed as separate positional args by `executeAutomation()` as usual.

### Files modified
- [`src/extensions/types.ts`](../../src/extensions/types.ts) — add `"on_conversation_start"` to `AutomationTrigger`
- [`src/extensions/manager.ts`](../../src/extensions/manager.ts) — handle in `getAutomationsForTrigger()`
- [`src/extensions/discovery.ts`](../../src/extensions/discovery.ts) — recognize trigger in frontmatter parsing
- [`src/chat/orchestrator.ts`](../../src/chat/orchestrator.ts) or [`src/chat/conversation.ts`](../../src/chat/conversation.ts) — fire trigger at the right point

---

## 11. Conversation Metadata Extension API

### 11.1 API surface

New utility object injected into the automation execution context:

```typescript
interface ConversationApi {
  /** Get the current conversation's title. */
  getTitle(): string | undefined;
  /** Set the conversation title. Persists to JSONL header. */
  setTitle(title: string): Promise<void>;
  /** Get the current favorite state. */
  isFavorite(): boolean;
  /** Set the favorite state. Persists to JSONL header. */
  setFavorite(favorite: boolean): Promise<void>;
}
```

### 11.2 Implementation

- `setTitle()` updates `conversationManager.activeConversation.title` in memory, then calls `onConversationChanged()` which triggers `historyManager.updateConversationHeader()` through the existing write queue (race-safe via `enqueueWrite()`)
- Same pattern for `setFavorite()`
- The API is only available when there's an active conversation; methods throw otherwise
- The view's conversation list should refresh when title changes (existing `onConversationChanged` callback path should handle this)

### 11.3 ConversationManager additions

**File:** [`src/chat/conversation.ts`](../../src/chat/conversation.ts)

New public methods:
```typescript
/** Set the conversation title programmatically. Fires onConversationChanged. */
setTitle(title: string): void;

/** Set the favorite state programmatically. Fires onConversationChanged. */
setFavorite(favorite: boolean): void;
```

### Files modified
- [`src/chat/conversation.ts`](../../src/chat/conversation.ts) — `setTitle()`, `setFavorite()` methods
- [`src/extensions/manager.ts`](../../src/extensions/manager.ts) — inject `conversationApi` into automation execution context
- Automation runtime context types (wherever `utils` is defined for user extensions)

---

## 12. Pre-packaged Title Generation Automation

### 12.1 Ships as built-in automation scaffold

Ship title generation as a built-in automation scaffold, parallel to the existing tool scaffold system (`BUILTIN_TOOL_SCAFFOLDS`, `isScaffold` on `UserToolDefinition`). **Note:** The automation scaffold system does not exist yet — `UserAutomationDefinition` has no `isScaffold` field and there is no `BUILTIN_AUTOMATION_SCAFFOLDS` map. This requires new infrastructure (see Phase G scope below).

Configuration:

- Trigger: `on_conversation_start`
- Default: **disabled** (setting `title_generation_enabled: false`)
- Preset: configurable via `title_generation_preset` setting (default: `"small"`)

### 12.2 Automation logic (pseudo-code)

**LLM access:** `ExtensionUtils` ([`runtime-context.ts`](../../src/extensions/runtime-context.ts)) does not currently expose provider or LLM access. To enable automations to make LLM calls, inject a scoped `llmCall` helper into the `context` object for `on_conversation_start` triggers. This helper resolves a preset name to concrete provider+model, calls `provider.sendMessage()` internally, and returns the response. It is **not** added to `ExtensionUtils` (which is shared across all triggers) — it's trigger-specific context, keeping the general automation API surface unchanged.

```typescript
// Built-in scaffold: title-generation automation
// Trigger: on_conversation_start

const messageText = context.firstMessage;
if (!messageText || messageText.length < 10) return; // Skip trivial messages

const presetName = settings.title_generation_preset ?? "small";

const response = await context.llmCall(presetName, [
  { role: "system", content: "Generate a concise title (5-8 words) for this conversation based on the user's message. Reply with ONLY the title text, no quotes, no punctuation wrapping." },
  { role: "user", content: messageText.substring(0, 500) },
]);
if (!response) return; // Preset not configured or LLM call failed

const title = extractTextContent(response).trim();
if (title) {
  await context.conversationApi.setTitle(title);
}
```

**`context.llmCall` signature:**

```typescript
/** Resolve a preset and make an LLM call. Returns null if preset is unconfigured or call fails. */
llmCall(presetName: string, messages: Message[], options?: { tools?: Tool[] }): Promise<LLMResponse | null>;
```

Implementation lives in the orchestrator's trigger dispatch code — it has access to `ProviderRegistry` and `resolvePreset()`. The compiled automation never touches the provider directly.

### 12.3 Title race behavior

The `on_conversation_start` trigger fires **asynchronously** (Section 10.1), but `ConversationManager.addMessage()` ([`conversation.ts:353-361`](../../src/chat/conversation.ts)) already generates a truncated 80-char title **synchronously** from the first user message. This creates a deliberate two-phase title flow:

1. **Immediate:** `addMessage()` sets `title = generateTitle(firstMessage)` (80-char truncation). The sidebar shows this immediately.
2. **Async:** The title generation automation's LLM call completes and overwrites via `conversationApi.setTitle()`. The sidebar updates to the LLM-generated title.

This means:
- Users will see a brief "flash" from truncated title → LLM title (typically 1-3 seconds).
- If the LLM call fails silently, the truncated title remains — **graceful degradation, no data loss.**
- The existing `generateTitle()` in `addMessage()` continues to run regardless of `title_generation_enabled` — it serves as the fallback.
- `historyManager.updateConversationHeader()` is race-safe via the per-file write queue (`enqueueWrite()` in [`history.ts`](../../src/chat/history.ts)), so concurrent title writes from `addMessage()` and `setTitle()` are serialized correctly.

### 12.4 Settings UI

In the **Automation** settings section, add a prominent subsection:

```
Title Generation
  [x] Enable automatic title generation          (toggle, default off)
  [ ] Preset: [small ▾]                          (dropdown of configured presets)
  Note: Each new conversation will use an additional LLM call to generate a descriptive title.
```

### Files modified
- [`src/settings/types.ts`](../../src/settings/types.ts) — `title_generation_enabled`, `title_generation_preset`
- [`src/settings/defaults.ts`](../../src/settings/defaults.ts) — defaults (`false`, `"small"`)
- Built-in automation scaffold (wherever scaffolds are defined/registered)
- [`src/settings/sections/user-automations.ts`](../../src/settings/sections/user-automations.ts) or new subsection in Automation — toggle + preset selector

---

## 13. Migration and Backward Compatibility

### 13.1 Settings migration

On plugin load, if `model_presets` is absent from saved settings:
1. Initialize with `DEFAULT_MODEL_PRESETS` (4 presets, all unconfigured)
2. Set `default_preset: "medium"`
3. **Auto-configure the `medium` preset** from the current `active_provider` + its `model_id` — so existing users don't lose their working model and can continue chatting immediately
4. Initialize `title_generation_enabled: false`, `title_generation_preset: "small"`

### 13.2 JSONL backward compat

- Old conversations without `preset_name` -> treated as Custom (undefined is handled, no migration needed)
- New conversations always write `preset_name` (either the preset name or null for Custom)

### 13.3 Chat panel fallback

If NO presets are configured (all `provider_type: null`):
- Chat panel dropdown shows only "Custom" as the available option
- "Custom" reveals the current provider+model dropdowns (identical to today's UX)
- This ensures the plugin is usable immediately without configuring presets

### 13.4 Persona/Workflow fallback

`preferred_preset` defaults to `null`. Existing personas/workflows without it continue using `preferred_provider` + `preferred_model` unchanged. No breaking changes.

### 13.5 `active_provider` field

The `active_provider` setting field remains for backward compat and as the ultimate fallback. It is no longer the primary model selection mechanism but is still read when:
- No preset is configured
- The default preset's provider is unavailable
- Custom selection needs to know which provider was last used

---

## 14. Implementation Phases

### Phase A: Core types + preset resolver
- `ModelPreset` type, settings additions, defaults
- `preset-resolver.ts` module
- Settings migration logic

### Phase B: Settings UI restructure
- Rename "Provider setup" -> "Providers"
- New "Models" section with preset management UI
- Remove model_id selection from provider sections

### Phase C: Chat panel popover overhaul
- `buildPresetSelect()` replacing provider+model dropdowns
- "Custom" escape hatch
- `onPresetChange` callback wiring in `main.ts`

### Phase D: Conversation storage + lifecycle
- `preset_name` on Conversation
- `createConversation()` with preset_name
- Display-restore in `switchConversation()` with stale detection

### Phase E: Orchestration + workflow integration
- Background workflow preset resolution
- Verify session creation path needs no changes

### Phase F: Persona integration
- `preferred_preset` on Persona
- Frontmatter parsing
- Resolution priority in `applyProviderModelOverrides()`

### Phase G: Automation infrastructure
- `on_conversation_start` trigger type
- Conversation metadata API (`setTitle`, `setFavorite`)
- Wire trigger firing point
- **Automation scaffold system** (new infra, parallel to tool scaffolds):
  - Add `isScaffold?: boolean` to `UserAutomationDefinition` in `src/extensions/types.ts`
  - Create `BUILTIN_AUTOMATION_SCAFFOLDS` map (analogous to `BUILTIN_TOOL_SCAFFOLDS` in `src/extensions/builtin-tool-scaffolds.ts`)
  - Modify `ExtensionManager.reload()` in `src/extensions/manager.ts` to inject missing automation scaffolds (same pattern as tool scaffold injection at L216-240)
  - Add override detection for automations (vault file with same trigger/name overrides scaffold)
  - Update `src/settings/sections/user-automations.ts` to distinguish built-in automations from user-defined ones

### Phase H: Title generation automation
- Title generation scaffold (registered in `BUILTIN_AUTOMATION_SCAFFOLDS`)
- Settings UI (toggle + preset selector in Automation section)
- End-to-end wiring

---

## 15. Verification Plan

### Unit tests
- `resolvePreset()`: configured preset, unconfigured preset, missing preset, stale check
- Settings migration: fresh install, upgrade from pre-preset settings (auto-configures medium)
- Conversation header serialization with `preset_name`
- `isPresetStale()` edge cases (renamed preset, changed model, deleted preset)

### Manual testing
1. **Fresh install**: Settings -> Models section shows 4 unconfigured presets -> configure `medium` with provider+model -> new conversation uses it
2. **Chat panel**: Dropdown shows preset list with provider+model details -> select different preset -> verify model changes -> select "Custom" -> verify provider+model dropdowns appear
3. **Conversation switch**: Create conversations with different presets -> switch between them -> verify correct preset displays in dropdown
4. **Stale preset**: Change a preset's model -> switch to old conversation -> verify "Custom" fallback with notice
5. **Persona override**: Create persona with `notor-preferred-preset: small` -> activate -> verify model switches to the small preset's model
6. **Title generation**: Enable in Automation settings -> start new conversation -> verify title updates asynchronously after first message
7. **Backward compat**: Load old conversations (no `preset_name`) -> verify they display as Custom with correct provider+model
8. **No presets configured**: Reset all presets to unconfigured -> verify chat panel shows only "Custom" and functions identically to pre-preset behavior
9. **Provider unavailable**: Configure a preset with a provider -> disable that provider -> verify notice and fallback behavior
