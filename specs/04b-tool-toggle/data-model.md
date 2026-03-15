# Data Model: Phase 4b — Per-Tool Enable/Disable Toggles

**Created:** 2026-03-15
**Specification:** [specs/04b-tool-toggle/spec.md](spec.md)
**Tasks:** [specs/04b-tool-toggle/tasks.md](tasks.md)

---

## Persisted Entities

These entities are added to Notor's plugin settings (`data.json` via `loadData`/`saveData`).

### NotorSettings Extension

Two new fields are added to the existing `NotorSettings` interface, in the Phase 4 persona settings block (after `persona_auto_approve`):

```typescript
interface NotorSettings {
  // ... existing settings ...

  /**
   * Per-tool enabled flags (true = included in LLM tool list, false = hidden).
   *
   * Key: tool name (built-in tool ID, e.g. "write_note").
   * Value: boolean — true means the tool is sent to the LLM; false means excluded.
   *
   * MCP tools are not stored here. Their global default is implicitly true.
   * Stale keys (tools no longer registered) have no runtime effect.
   *
   * @see specs/04b-tool-toggle/spec.md — FR-64, FR-65
   */
  tool_enabled: Record<string, boolean>;

  /**
   * Per-persona per-tool enabled overrides.
   *
   * Outer key: persona name. Inner key: tool name (namespaced for MCP tools,
   * e.g. "my-server__query"; plain ID for built-in tools).
   * Value: "global" | "enabled" | "disabled".
   *
   * @see specs/04b-tool-toggle/spec.md — FR-67, FR-68
   */
  persona_tool_enabled: Record<string, Record<string, string>>;
}
```

#### Default Values

Added to `createDefaultSettings()` in `src/settings/defaults.ts`:

```typescript
export const DEFAULT_TOOL_ENABLED: Record<string, boolean> = {
  read_note: true,
  search_vault: true,
  list_vault: true,
  read_frontmatter: true,
  fetch_webpage: true,
  write_note: true,
  replace_in_note: true,
  update_frontmatter: true,
  manage_tags: true,
  execute_command: true,
};
```

```typescript
// In createDefaultSettings():
tool_enabled: DEFAULT_TOOL_ENABLED,
persona_tool_enabled: {},
```

#### Settings Migration

No explicit migration is required. The existing load pattern in `main.ts`:

```typescript
this.settings = Object.assign({}, createDefaultSettings(configDir), await this.loadData());
```

fills in missing fields from `createDefaultSettings()` when loading from an older `data.json`. Existing installations upgrade seamlessly with all tools enabled.

---

## Types

### ToolEnabledState

Defined in `src/types.ts`, parallel to `AutoApproveState`:

```typescript
/**
 * Per-persona per-tool enabled override state.
 *
 * - "global"   — no override; falls back to global tool_enabled setting
 * - "enabled"  — tool is enabled for this persona regardless of global setting
 * - "disabled" — tool is disabled for this persona regardless of global setting
 *
 * "global" is never persisted — selecting "Global default" in the UI
 * deletes the entry from persona_tool_enabled (same pattern as AutoApproveState).
 *
 * @see specs/04b-tool-toggle/spec.md — FR-67
 */
export type ToolEnabledState = "global" | "enabled" | "disabled";
```

| Value | Persisted | UI Label | Behavior |
|---|---|---|---|
| `"global"` | No (entry deleted) | "Global default" | Falls back to `tool_enabled[toolName] ?? true` |
| `"enabled"` | Yes | "Enabled" | Tool included in LLM tool list for this persona |
| `"disabled"` | Yes | "Disabled" | Tool excluded from LLM tool list for this persona |

---

## Resolver Contract

### Module: `src/personas/tool-enabled-resolver.ts`

A pure logic module with no Obsidian API dependencies, parallel to `src/personas/auto-approve-resolver.ts`.

#### `resolveToolEnabled`

```typescript
/**
 * Resolve the effective enabled state for a tool given an active persona.
 *
 * Resolution logic (mirrors resolveAutoApprove):
 * 1. If no persona is active (personaName is null) → use global setting.
 * 2. If a persona is active → check personaOverrides[personaName][toolName]:
 *    - "enabled"  → return true
 *    - "disabled" → return false
 *    - "global" or absent → fall back to global setting.
 *
 * The global default for any tool not explicitly listed in globalToolEnabled
 * is true (enabled) — unlike auto-approve whose default is false.
 *
 * @param toolName          - Name of the tool (built-in ID or namespaced MCP name)
 * @param personaName       - Active persona name, or null if no persona is active
 * @param personaOverrides  - Full persona_tool_enabled config from settings
 * @param globalToolEnabled - Global per-tool enabled settings (settings.tool_enabled)
 * @returns true if the tool should be included in the LLM tool list
 */
export function resolveToolEnabled(
  toolName: string,
  personaName: string | null,
  personaOverrides: Record<string, Record<string, string>>,
  globalToolEnabled: Record<string, boolean>
): boolean
```

Resolution branches:

| Condition | Result |
|---|---|
| No active persona | `globalToolEnabled[toolName] ?? true` |
| Active persona, override = `"enabled"` | `true` |
| Active persona, override = `"disabled"` | `false` |
| Active persona, override = `"global"` or absent | `globalToolEnabled[toolName] ?? true` |

**Key difference from `resolveAutoApprove`:** the fallback default is `true` (enabled), not `false`. All tools are enabled unless explicitly disabled.

#### `setPersonaToolEnabledOverride`

```typescript
/**
 * Set a single tool override for a persona.
 *
 * If state is "global", the entry is deleted (not stored — "global" is the
 * implicit default). Cleans up empty persona entries.
 * The caller is responsible for calling saveData() after mutation.
 *
 * @param settings    - Plugin settings object (mutated in place)
 * @param personaName - Persona name
 * @param toolName    - Tool name
 * @param state       - Override state to set
 */
export function setPersonaToolEnabledOverride(
  settings: NotorSettings,
  personaName: string,
  toolName: string,
  state: ToolEnabledState
): void
```

#### `removePersonaToolEnabledOverrides`

```typescript
/**
 * Remove all tool-enabled overrides for a persona.
 * Used for cleanup when a persona is deleted.
 * The caller is responsible for calling saveData() after mutation.
 */
export function removePersonaToolEnabledOverrides(
  settings: NotorSettings,
  personaName: string
): void
```

#### `getStaleToolEnabledNames`

```typescript
/**
 * Identify tool names in a persona's tool-enabled overrides that are no
 * longer registered in the tool registry.
 *
 * Stale entries occur when an MCP tool is removed or a built-in tool is
 * renamed. The settings UI uses this to display warning indicators.
 *
 * @param personaOverrides    - Tool-enabled overrides for a single persona
 *        (e.g., settings.persona_tool_enabled["researcher"])
 * @param registeredToolNames - Array of currently registered tool names
 * @returns Array of tool names present in overrides but not in the registry
 */
export function getStaleToolEnabledNames(
  personaOverrides: Record<string, string>,
  registeredToolNames: string[]
): string[]
```

---

## Filtering Contract

### Location

Applied at two call sites in `src/main.ts`:

1. **`setGetToolDefinitions` callback** (line ~1179) — used by `ChatOrchestrator` for workflow-initiated messages via `executeWorkflow()`.
2. **`setOnSendMessage` handler** (line ~1200) — used for user-initiated messages.

Both call sites replace `toolRegistry.getToolDefinitions()` with a filtered variant. A private helper method on the plugin class consolidates the logic:

```typescript
private getFilteredToolDefinitions(): ToolDefinition[] {
  const personaName = this.settings.active_persona || null;
  return this.getToolRegistry()
    .getToolDefinitions()
    .filter((def) =>
      resolveToolEnabled(
        def.name,
        personaName,
        this.settings.persona_tool_enabled,
        this.settings.tool_enabled
      )
    ) as ToolDefinition[];
}
```

### When Filtering Applies

- Filtering runs at message-send time (not at registration time), so toggling a tool mid-session takes effect on the next message without any reconnection or reload.
- Filtering does not modify `ToolRegistry` state — tools remain registered and can be re-enabled at any time.
- The dispatcher's blocking check (FR-66) is independent of filtering and serves as a safety net for edge cases (e.g., stale LLM context).

---

## Dispatcher State

### New fields in `ToolDispatcher` (`src/chat/dispatcher.ts`)

```typescript
/** Global per-tool enabled flags (from settings.tool_enabled). */
private toolEnabled: Record<string, boolean> = {};

/** Per-persona per-tool enabled overrides (from settings.persona_tool_enabled). */
private personaToolEnabled: Record<string, Record<string, string>> = {};
```

### New setter methods

```typescript
/** Update global tool-enabled settings. */
setToolEnabled(settings: Record<string, boolean>): void

/** Update per-persona tool-enabled overrides. */
setPersonaToolEnabled(overrides: Record<string, Record<string, string>>): void
```

### Dispatch check (step 1.5)

Inserted in `dispatch()` after the tool-found check (step 1) and before the Plan/Act mode check (step 2):

```typescript
// 1.5. Check tool enabled state
const isEnabled = resolveToolEnabled(
  toolName,
  this.activePersonaName,
  this.personaToolEnabled,
  this.toolEnabled
);
if (!isEnabled) {
  toolCall.status = "error";
  this.events.onToolCallStatusChanged?.(toolCall, messageId);
  const result: ToolResult = {
    tool_name: toolName,
    success: false,
    result: "",
    error: `Tool '${toolName}' is disabled. Enable it in Settings → Tools & permissions to use this tool.`,
  };
  log.info("Blocked disabled tool", { toolName });
  this.events.onToolCallResult?.(toolCall, result, messageId);
  return result;
}
```

### Wiring in `main.ts`

Three locations updated to propagate state to the dispatcher:

1. **`getToolDispatcher()` init** — after existing `setAutoApprove`/`setPersonaAutoApprove` calls:
   ```typescript
   this._toolDispatcher.setToolEnabled(this.settings.tool_enabled);
   this._toolDispatcher.setPersonaToolEnabled(this.settings.persona_tool_enabled);
   ```

2. **`saveSettings()`** — in the `if (this._toolDispatcher)` block:
   ```typescript
   this._toolDispatcher.setToolEnabled(this.settings.tool_enabled);
   this._toolDispatcher.setPersonaToolEnabled(this.settings.persona_tool_enabled);
   ```

3. **`setOnNewConversation` reload callback** — after existing `setPersonaAutoApprove`/`setActivePersonaName` calls:
   ```typescript
   toolDispatcher.setToolEnabled(this.settings.tool_enabled);
   toolDispatcher.setPersonaToolEnabled(this.settings.persona_tool_enabled);
   ```

---

## Settings UI Contract

### New section: `src/settings/sections/tool-enabled.ts`

`renderToolEnabledSection(containerEl, ctx)` — mirrors `renderAutoApproveSection` in `src/settings/sections/auto-approve.ts`.

- Heading: "Enabled tools"
- Description: "Disabled tools are not sent to the AI and cannot be used, even if the AI requests them."
- Two sub-groups: "Read-only tools" and "Write tools" (same split as auto-approve, using `TOOL_DISPLAY_NAMES` metadata)
- Each tool row: display name + toggle (on = `true`, off = `false`)
- Read from `ctx.settings.tool_enabled[toolId] ?? true`
- Write via `ctx.settings.tool_enabled[toolId] = value` then `ctx.saveSettings()`

Registered in `src/settings/settings-tab.ts` immediately before `renderAutoApproveSection`.

### Extension: `src/settings/sections/persona-auto-approve.ts`

Within each persona's collapsible body, after the existing auto-approve rows, add a "Tool enabled" sub-group:

- Heading text: "Tool enabled"
- Three-state dropdown per tool: "Global default" / "Enabled" / "Disabled"
- Built-in tools: same `TOOL_DISPLAY_NAMES` split (read / write)
- MCP tools: grouped by server name (same as existing MCP auto-approve grouping in the section)
- Storage: `setPersonaToolEnabledOverride(ctx.settings, personaName, toolId, state)`
- Stale detection: `getStaleToolEnabledNames(ctx.settings.persona_tool_enabled[personaName], registeredToolNames)` — shown with warning + remove button
- Override count badge: updated to include count from both `persona_auto_approve` and `persona_tool_enabled` for this persona

---

## Entity Relationship Summary

```
NotorSettings
  ├── tool_enabled: Record<string, boolean>          ← global enabled flags
  └── persona_tool_enabled: Record<                   ← per-persona overrides
          personaName, Record<toolName, ToolEnabledState>>

ToolDispatcher (runtime)
  ├── toolEnabled: Record<string, boolean>            ← copy of tool_enabled
  ├── personaToolEnabled: Record<...>                 ← copy of persona_tool_enabled
  └── dispatch() step 1.5: resolveToolEnabled()       ← blocking check

main.ts getFilteredToolDefinitions()
  └── toolRegistry.getToolDefinitions()
        .filter(def => resolveToolEnabled(def.name, ...))
              ↓
        ToolDefinition[] (filtered)
              ↓
        provider.sendMessage(chatMessages, toolDefinitions, ...)
        + SystemPromptBuilder.assemble(mode, toolDefinitions, ...)
```
