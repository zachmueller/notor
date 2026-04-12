# Built-in Automation Parity with Built-in Tools

**Status:** Draft (v1.0)
**Date:** 2026-04-13
**Depends on:** Phase 5 (User-Defined Extensions) — complete, Built-in Tool Migration — complete

---

## 1. Motivation

The built-in tools went through a careful migration ([`specs/05-user-tools/builtin-tool-migration.md`](../05-user-tools/builtin-tool-migration.md)) that established clear architectural patterns:

- **Scaffold-as-fallback** — in-memory scaffold loaded when no vault file exists; vault file overrides scaffold (D-1)
- **Extension settings system** — tools declare settings in YAML `settings` fences; resolved via `resolveSettings()` with per-extension and shared channels; `pluginSettings` was explicitly rejected (D-2)
- **Schema-driven UI** — tools with `settingsSchema` get auto-rendered fields via `renderFieldList()` and `ToolSettingsModal`
- **Centralized dispatch** — all lifecycle hook dispatching lives in [`hook-events.ts`](../../src/hooks/hook-events.ts); tool and automation execution go through the same `ExtensionManager.executeAutomation()` pipeline

The `on_conversation_start` trigger and the title-generation automation were added as part of the model presets feature (Phases G/H of [`model-presets-design.md`](./model-presets-design.md)). They work but bypass every one of these patterns:

1. Title generation reads settings via `context.pluginSettings` — a direct `NotorSettings` reference
2. The settings UI is hard-coded (toggle + dropdown) rather than schema-driven
3. Dispatch happens ad-hoc in the orchestrator rather than through `hook-events.ts`
4. LLM access and conversation metadata API are built inline in the orchestrator closure

This creates inconsistency for users who want to customize automations the same way they customize tools, and makes it harder to add future built-in automations that follow the correct patterns.

---

## 2. Gap Analysis

| Area | Built-in Tools Pattern | Current Automation Pattern | Required Change |
|------|----------------------|--------------------------|-----------------|
| **Settings access** | Per-extension `settings` from YAML `settings` fence + `shared` from `notor/settings.md`. The `settings` arg (pos 5) in compiled fn IS the resolved values. ([`manager.ts:478`](../../src/extensions/manager.ts), [`compiler.ts:52`](../../src/extensions/compiler.ts)) | Title gen reads `context.pluginSettings` — a direct `NotorSettings` ref injected from orchestrator. Violates D-2 from migration spec. ([`orchestrator.ts:1427`](../../src/chat/orchestrator.ts), [`builtin-automation-scaffolds.ts:62-63`](../../src/extensions/builtin-automation-scaffolds.ts)) | Declare `title_generation_enabled` and `title_generation_preset` as `settingsSchema` fields on the scaffold. Read from `settings` arg. |
| **Settings UI** | Schema-driven: tools with `settingsSchema` get a gear icon -> `ToolSettingsModal` renders fields automatically. ([`tools.ts:294-312`](../../src/settings/sections/tools.ts)) | Hard-coded: `renderTitleGenerationSection()` manually creates toggle + dropdown. ([`user-automations.ts:29-62`](../../src/settings/sections/user-automations.ts)) | Use `renderFieldList()` driven by the automation's `settingsSchema`. Remove hard-coded toggle/dropdown. |
| **Settings defaults** | Declared in YAML fence `settings` block with `default:` field per schema entry. Resolved via `resolveSettings()`. ([`settings-schema.ts:129-170`](../../src/extensions/settings-schema.ts)) | Defaults hard-coded in scaffold code (`?? "small"`, `?? false`). | Move defaults to schema `default:` fields. |
| **Scaffold override detection** | Reload tracks `builtinOverrides[]` — vault files with same tool name as scaffold. UI shows override status. ([`manager.ts:322-329`](../../src/extensions/manager.ts)) | No override detection for automations. `builtinOverrides` only tracks tools. | Add automation override detection to reload result and settings UI. |
| **Dispatch location** | N/A (tools dispatched by LLM via ToolDispatcher) | Existing triggers (`pre_send`, `on_tool_call`, etc.) dispatched from centralized functions in [`hook-events.ts`](../../src/hooks/hook-events.ts) (L322-799). `on_conversation_start` dispatched ad-hoc from `orchestrator.ts:fireConversationStartTrigger()`. | Add `dispatchOnConversationStart()` to `hook-events.ts`. |
| **Context shape** | `params` (from LLM tool call JSON) | Existing triggers use standard shapes: `{ hookEvent, timestamp, conversationId, toolName?, params?, result? }` built in `hook-events.ts`. `on_conversation_start` has ad-hoc shape `{ conversationId, firstMessage, conversationApi, llmCall, pluginSettings }` built in orchestrator. | Define standard context shape for `on_conversation_start` in `hook-events.ts`. |
| **LLM access** | N/A (tools are called BY the LLM) | `context.llmCall` built inline in orchestrator — streaming collection, preset resolution, error handling all in one closure. Only available to `on_conversation_start`. | Promote to `ExtensionUtils.llmCall()` so ANY extension can make LLM calls. |
| **Conversation API** | N/A | `context.conversationApi` with `getTitle/setTitle/isFavorite/setFavorite`. Only available to `on_conversation_start`. Built inline in orchestrator. | Promote to `ExtensionUtils.conversationApi` available to all conversation-scoped triggers. |

---

## 3. Design: Settings via settingsSchema

### 3.1 Scaffold settings declaration

The title-generation scaffold in [`builtin-automation-scaffolds.ts`](../../src/extensions/builtin-automation-scaffolds.ts) should include a YAML `settings` fence:

```yaml
settings:
  title_generation_enabled:
    type: boolean
    name: Enable automatic title generation
    description: Each new conversation will use an additional LLM call to generate a descriptive title.
    default: false
  title_generation_preset:
    type: string
    name: Title generation preset
    description: The model preset used for title generation LLM calls.
    default: small
```

### 3.2 Settings field type for preset

The `title_generation_preset` field is a `string` type. The settingsSchema system currently supports `options?: string[]` for enum-style dropdowns ([`types.ts:184`](../../src/extensions/types.ts)). However, the list of configured presets is dynamic (changes as users add/remove presets). Two options:

**Option A: Static string field** — User types or pastes the preset name. Simple, no new infrastructure. The field renders as a text input.

**Option B: Dynamic options via callback** — Add a new `optionsProvider?: string` field to `SettingsFieldSchema` that names a function on `ExtensionUtils` returning `string[]`. The settings UI calls `utils[optionsProvider]()` to populate dropdown options. More complex, but better UX.

**Recommendation:** Start with Option A. The preset name is a short string users already know from the Models settings section. Option B can be added later as a general-purpose enhancement if demand arises.

### 3.3 Scaffold code changes

The scaffold code changes from:

```typescript
// BEFORE (reads from context.pluginSettings)
const pluginSettings = context.pluginSettings as Record<string, unknown>;
const presetName = pluginSettings.title_generation_preset as string ?? "small";
const enabled = pluginSettings.title_generation_enabled as boolean ?? false;
```

To:

```typescript
// AFTER (reads from per-extension settings — the "settings" arg)
const presetName = settings.title_generation_preset as string;
const enabled = settings.title_generation_enabled as boolean;
```

The `settings` arg at position 5 is automatically populated from the extension's `settingsSchema` via `resolveSettings()`. Defaults are handled by the schema, not by `??` fallbacks.

### 3.4 NotorSettings cleanup

Remove from [`settings/types.ts`](../../src/settings/types.ts):
- `title_generation_enabled: boolean`
- `title_generation_preset: string`

Remove from [`settings/defaults.ts`](../../src/settings/defaults.ts):
- `title_generation_enabled: false`
- `title_generation_preset: "small"`

These fields are replaced by the automation's `settingsSchema` defaults, resolved via the per-extension settings system (`user_extension_settings["Title Generation"]`).

---

## 4. Design: Centralized Dispatch

### 4.1 New dispatch function

Add to [`hook-events.ts`](../../src/hooks/hook-events.ts):

```typescript
/**
 * Dispatch all `on_conversation_start` automations non-blocking.
 *
 * Fires once per conversation after the first user message is submitted,
 * before the LLM call. No shell hooks exist for this trigger — only
 * user automations.
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 10
 */
export function dispatchOnConversationStart(
  context: {
    conversationId: string;
    firstMessage: string;
    timestamp: string;
  },
  extensionAutomations?: LifecycleAutomationAccessors,
): void {
  const automations = extensionAutomations?.getForTrigger("on_conversation_start") ?? [];
  if (automations.length === 0) return;

  void (async () => {
    const automationCtx: Record<string, unknown> = {
      hookEvent: "on_conversation_start",
      timestamp: context.timestamp,
      conversationId: context.conversationId,
      firstMessage: context.firstMessage,
    };
    for (const automation of automations) {
      try {
        await extensionAutomations!.execute(automation, automationCtx);
      } catch (e) {
        const displayName = automation.displayName ?? automation.filePath;
        const message = e instanceof Error ? e.message : String(e);
        new Notice(`Automation error in ${displayName}: ${message}`);
        log.error("User automation execution failed", {
          automation: displayName,
          trigger: "on_conversation_start",
          error: String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
      }
    }
  })();
}
```

### 4.2 Orchestrator changes

In [`orchestrator.ts`](../../src/chat/orchestrator.ts):

1. Import `dispatchOnConversationStart` from `hook-events.ts`
2. Replace the inline first-message detection block (L726-738) with a call to `dispatchOnConversationStart()`
3. Delete the entire `fireConversationStartTrigger()` method (L1366-1442)
4. Remove `context.pluginSettings` injection (no longer needed)

The first-message detection logic (checking `userMessages.length === 1`) stays in the orchestrator — it's the right place for that check. Only the dispatch mechanics move to `hook-events.ts`.

---

## 5. Design: LLM Access via ExtensionUtils

### 5.1 Interface addition

Add to `ExtensionUtils` in [`runtime-context.ts`](../../src/extensions/runtime-context.ts):

```typescript
/**
 * Make an LLM call using a named model preset.
 *
 * Resolves the preset to a provider+model, sends the messages, and
 * collects the streaming response into a string. Returns null if the
 * preset is unconfigured or the call fails.
 *
 * Available to all extensions (tools and automations).
 */
llmCall: (
  presetName: string,
  messages: Array<{ role: string; content: string }>,
) => Promise<string | null>;
```

### 5.2 Implementation in buildUtils()

`buildUtils()` already receives the plugin instance. The implementation:

1. Import `resolvePreset` from `presets/preset-resolver.ts`
2. Access `plugin.getProviderRegistry()` and `plugin.settings.model_presets`
3. Resolve preset -> get provider -> call `sendMessage()` -> collect `text_delta` chunks
4. Return concatenated text or null on failure
5. Wrap in try/catch with logging (no thrown errors to caller)

This is the same logic currently in `fireConversationStartTrigger()` but extracted to a reusable utility.

### 5.3 Scaffold code update

The scaffold changes from:

```typescript
// BEFORE (reads llmCall from context)
const llmCall = context.llmCall as (...) => Promise<string | null>;
const response = await llmCall(presetName, [...]);
```

To:

```typescript
// AFTER (uses utils.llmCall — available to all extensions)
const response = await utils.llmCall(presetName, [...]);
```

---

## 6. Design: Conversation Metadata API

### 6.1 Interface addition

Add to `ExtensionUtils` in [`runtime-context.ts`](../../src/extensions/runtime-context.ts):

```typescript
/**
 * API for reading/writing conversation metadata.
 *
 * Returns null when no active conversation exists (e.g., tool executed
 * outside a conversation context). Methods throw if called on a null API.
 */
conversationApi: {
  getTitle: () => string | undefined;
  setTitle: (title: string) => void;
  isFavorite: () => boolean;
  setFavorite: (favorite: boolean) => void;
} | null;
```

### 6.2 Implementation in buildUtils()

The active `ConversationManager` is accessible via the plugin's orchestrator(s). Since `buildUtils()` is called per-execution, it can capture the current active conversation at call time:

1. Access the plugin's active orchestrator(s)
2. Get the displayed `ConversationManager`
3. Build the API object delegating to `convManager.setTitle()` and `convManager.setFavorite()`
4. Return null if no active conversation exists

**Important:** The `conversationApi` captures the conversation state at execution time. For automations running asynchronously (like `on_conversation_start`), the conversation may have changed by the time `setTitle()` is called. This is acceptable — `setTitle()` operates on whichever conversation is currently active. The existing race-safe write queue in `HistoryManager.enqueueWrite()` handles concurrent writes.

### 6.3 Scaffold code update

```typescript
// BEFORE (reads from context)
const api = context.conversationApi as { setTitle: (t: string) => Promise<void> };
await api.setTitle(title);
```

```typescript
// AFTER (uses utils.conversationApi)
if (utils.conversationApi) {
  utils.conversationApi.setTitle(title);
}
```

---

## 7. Settings Migration

### 7.1 Migration function

Add `migrateAutomationSettings()` to [`main.ts`](../../src/main.ts), called from `loadSettings()` after `migrateModelPresets()`:

```typescript
private async migrateAutomationSettings(): Promise<void> {
  const raw = this.settings as unknown as Record<string, unknown>;
  if (raw.title_generation_enabled === undefined) return; // Already migrated

  // Copy to per-extension settings
  const extKey = "Title Generation"; // matches scaffold displayName
  if (!this.settings.user_extension_settings[extKey]) {
    this.settings.user_extension_settings[extKey] = {};
  }
  this.settings.user_extension_settings[extKey].title_generation_enabled =
    raw.title_generation_enabled as boolean;
  this.settings.user_extension_settings[extKey].title_generation_preset =
    raw.title_generation_preset as string;

  // Remove from NotorSettings
  delete raw.title_generation_enabled;
  delete raw.title_generation_preset;

  await this.saveSettings();
}
```

### 7.2 Timing

This migration is safe to run after `loadSettings()` because:
- `Object.assign()` merges saved data over defaults, preserving the old fields
- The migration copies them to the extension settings key before any automation runs
- The next `saveSettings()` persists the cleaned state

---

## 8. Automation Settings UI Parity

### 8.1 Current state

Built-in automations currently render via `renderUserAutomationsSection()` in [`user-automations.ts`](../../src/settings/sections/user-automations.ts). Title generation has a dedicated hard-coded section. Other automations show name + trigger + Open button.

### 8.2 Target state

After this work, the automation settings UI should mirror how tools work:

1. **Built-in automations** section showing each scaffold:
   - Name + trigger description
   - "Built-in" or "Customized" badge (based on vault file presence)
   - Auto-rendered settings fields from `settingsSchema` via `renderFieldList()`
   - Open button (creates vault file on demand)
   - Reset button (if vault file exists)

2. **User automations** section showing vault-authored automations:
   - Name + trigger
   - "User" badge
   - Open button
   - Auto-rendered settings fields

### 8.3 Override detection

Add `builtinAutomationOverrides: string[]` to `ExtensionReloadResult` ([`types.ts:177-186`](../../src/extensions/types.ts)). Populate in `reload()` by checking if any compiled automation has a vault file path matching a scaffold name but is not marked `isScaffold`.

---

## 9. Implementation Phases

### Phase 1: ExtensionUtils additions
- Add `llmCall` to `ExtensionUtils` interface and `buildUtils()`
- Add `conversationApi` to `ExtensionUtils` interface and `buildUtils()`
- Files: `runtime-context.ts`

### Phase 2: Centralize dispatch
- Add `dispatchOnConversationStart()` to `hook-events.ts`
- Update orchestrator to call it instead of inline `fireConversationStartTrigger()`
- Delete `fireConversationStartTrigger()` and `context.pluginSettings` injection
- Files: `hook-events.ts`, `orchestrator.ts`

### Phase 3: Settings via settingsSchema
- Add YAML `settings` fence to title-generation scaffold
- Update scaffold code to read from `settings` arg and `utils.llmCall` / `utils.conversationApi`
- Files: `builtin-automation-scaffolds.ts`

### Phase 4: Settings migration + cleanup
- Add `migrateAutomationSettings()` to `main.ts`
- Remove `title_generation_enabled` and `title_generation_preset` from `NotorSettings`
- Remove `renderTitleGenerationSection()` hard-coded UI
- Files: `main.ts`, `settings/types.ts`, `settings/defaults.ts`, `user-automations.ts`

### Phase 5: Automation settings UI parity
- Rewrite automation settings to auto-render `settingsSchema` fields
- Add automation override detection to `ExtensionReloadResult`
- Show badges (Built-in / Customized / User) consistently
- Files: `user-automations.ts`, `manager.ts`, `types.ts`

---

## 10. Verification

### Unit-level
- `resolveSettings()` correctly resolves title generation settings from `user_extension_settings["Title Generation"]`
- `buildUtils().llmCall()` resolves preset and collects stream
- `dispatchOnConversationStart()` fires automations with correct context shape
- Settings migration copies values and removes old fields

### Manual testing
1. Fresh install: title generation automation appears in Automation settings with schema-driven toggle + text input
2. Enable title generation -> new conversation -> title updates asynchronously
3. Open automation -> vault file created with full working code -> edit prompt -> reload -> custom prompt used
4. Reset to default -> vault file deleted -> scaffold restored on next reload
5. Upgrade from pre-parity install: existing `title_generation_enabled: true` migrated to extension settings, automation continues working
