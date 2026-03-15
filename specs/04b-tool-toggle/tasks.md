# Task Breakdown: Phase 4b — Per-Tool Enable/Disable Toggles

**Created:** 2026-03-15
**Specification:** [spec.md](spec.md)
**Data Model:** [data-model.md](data-model.md)
**Status:** Not Started

## Task Summary

**Total Tasks:** 8
**Groups:** 6 (Types → Resolver → Global UI → Persona UI → Dispatcher → Wiring)

### Group → Dependency Mapping

```
Group T-A (Types & schema)     → no dependencies
Group T-B (Resolver)           → T-A
Group T-C (Global settings UI) → T-A
Group T-D (Persona UI ext.)    → T-B, T-C
Group T-E (Dispatcher)         → T-B
Group T-F (Filtering & wiring) → T-B, T-E
```

### Critical Path

```
T-A-001 → T-A-002 → T-A-003 → T-B-001 → T-E-001 → T-F-001
```

Groups T-C and T-D can proceed in parallel with T-E and T-F once T-B is complete.

---

## Group T-A: Types & Settings Schema

### T-A-001: Add `ToolEnabledState` type

**Description:** Add the `ToolEnabledState` union type to `src/types.ts`, parallel to `AutoApproveState`.

**FRs:** FR-67
**Files:**
- `src/types.ts` — add `export type ToolEnabledState = "global" | "enabled" | "disabled";` after the `AutoApproveState` definition

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `ToolEnabledState` is exported from `src/types.ts`
- [ ] Type is positioned directly after `AutoApproveState` in the file
- [ ] `npm run build` succeeds with no type errors

---

### T-A-002: Add settings fields to `NotorSettings`

**Description:** Add `tool_enabled` and `persona_tool_enabled` fields to the `NotorSettings` interface in `src/settings/types.ts`.

**FRs:** FR-64, FR-67, FR-68, FR-69
**Files:**
- `src/settings/types.ts` — add two fields in the Phase 4 persona settings block, after `persona_auto_approve`

**Dependencies:** T-A-001

**Acceptance Criteria:**
- [ ] `tool_enabled: Record<string, boolean>` added to `NotorSettings` with JSDoc referencing FR-64, FR-65
- [ ] `persona_tool_enabled: Record<string, Record<string, string>>` added to `NotorSettings` with JSDoc referencing FR-67, FR-68
- [ ] Fields placed in the Phase 4 persona settings comment block, after `persona_auto_approve`
- [ ] `npm run build` succeeds with no type errors (settings fields with no defaults yet will cause no errors — `createDefaultSettings` will be updated in T-A-003)

---

### T-A-003: Add default values

**Description:** Add `DEFAULT_TOOL_ENABLED` exported constant and wire both new fields into `createDefaultSettings()` in `src/settings/defaults.ts`.

**FRs:** FR-64, FR-69
**Files:**
- `src/settings/defaults.ts` — add `DEFAULT_TOOL_ENABLED` constant; update `createDefaultSettings()`

**Dependencies:** T-A-002

**Acceptance Criteria:**
- [ ] `DEFAULT_TOOL_ENABLED` exported constant maps all 10 built-in tool names to `true`: `read_note`, `search_vault`, `list_vault`, `read_frontmatter`, `fetch_webpage`, `write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`, `execute_command`
- [ ] `createDefaultSettings()` includes `tool_enabled: DEFAULT_TOOL_ENABLED`
- [ ] `createDefaultSettings()` includes `persona_tool_enabled: {}`
- [ ] Constant placed in the sub-defaults section alongside `DEFAULT_AUTO_APPROVE`
- [ ] `npm run build` succeeds with no type errors

---

## Group T-B: Resolver Module

### T-B-001: Create `tool-enabled-resolver.ts`

**Description:** Create `src/personas/tool-enabled-resolver.ts` as a pure logic module (no Obsidian API dependencies), mirroring the structure of `src/personas/auto-approve-resolver.ts`. Exports four functions used by the settings UI, dispatcher, and main.ts filtering.

**FRs:** FR-65, FR-66, FR-67, FR-68
**Files:**
- `src/personas/tool-enabled-resolver.ts` — new file

**Dependencies:** T-A-001, T-A-002

**Acceptance Criteria:**
- [ ] `resolveToolEnabled(toolName, personaName, personaOverrides, globalToolEnabled): boolean` exported
  - No active persona → returns `globalToolEnabled[toolName] ?? true`
  - Active persona with `"enabled"` override → returns `true`
  - Active persona with `"disabled"` override → returns `false`
  - Active persona with `"global"` or absent → returns `globalToolEnabled[toolName] ?? true`
- [ ] `setPersonaToolEnabledOverride(settings, personaName, toolName, state: ToolEnabledState): void` exported
  - Creates persona entry if missing
  - Deletes entry when `state === "global"`
  - Cleans up empty persona entries (same pattern as `setPersonaToolOverride`)
- [ ] `removePersonaToolEnabledOverrides(settings, personaName): void` exported
  - Deletes `settings.persona_tool_enabled[personaName]`
- [ ] `getStaleToolEnabledNames(personaOverrides, registeredToolNames): string[]` exported
  - Returns tool names present in overrides but not in `registeredToolNames`
- [ ] Module-level JSDoc comment referencing `auto-approve-resolver.ts` as the parallel implementation
- [ ] `npm run build` succeeds with no type errors

---

## Group T-C: Global Settings UI

### T-C-001: Add "Enabled tools" settings section

**Description:** Create `src/settings/sections/tool-enabled.ts` and register it in `src/settings/settings-tab.ts`. The section renders a toggle per built-in tool in the same "Tools & permissions" group, immediately before the auto-approve section.

**FRs:** FR-64
**Files:**
- `src/settings/sections/tool-enabled.ts` — new file: `renderToolEnabledSection(containerEl, ctx)`
- `src/settings/settings-tab.ts` — import and call `renderToolEnabledSection` before `renderAutoApproveSection`

**Dependencies:** T-A-003

**Acceptance Criteria:**
- [ ] `renderToolEnabledSection` exported from `src/settings/sections/tool-enabled.ts`
- [ ] Section heading: "Enabled tools"
- [ ] Description paragraph: "Disabled tools are not sent to the AI and cannot be used, even if the AI requests them."
- [ ] Two sub-groups using `Setting.setHeading()`: "Read-only tools" and "Write tools"
- [ ] Each tool row renders using `Setting` with the tool's display name from `TOOL_DISPLAY_NAMES` and a toggle component
- [ ] Toggle reads from `ctx.settings.tool_enabled[toolId] ?? true`
- [ ] Toggle change handler sets `ctx.settings.tool_enabled[toolId] = value` and calls `ctx.saveSettings()`
- [ ] Section appears in **Settings → Notor** under "Tools & permissions" immediately before the "Auto-approve" section
- [ ] MCP tools are not listed in this section
- [ ] Plugin loads and Settings renders without errors
- [ ] Toggling a built-in tool off and reloading Settings shows the toggle in the off state (persisted correctly)

---

## Group T-D: Per-Persona UI Extension

### T-D-001: Add tool-enabled overrides to persona auto-approve section

**Description:** Extend `src/settings/sections/persona-auto-approve.ts` to render a "Tool enabled" sub-group within each persona's collapsible section, alongside the existing auto-approve rows. Also extends stale tool detection and updates the override count badge.

**FRs:** FR-67, FR-68
**Files:**
- `src/settings/sections/persona-auto-approve.ts` — extend per-persona rendering

**Dependencies:** T-B-001, T-C-001

**Acceptance Criteria:**
- [ ] Each persona's collapsible body renders a "Tool enabled" sub-group after the existing auto-approve rows
- [ ] Sub-group heading: "Tool enabled"
- [ ] Built-in tools listed in two sub-groups (read / write) with three-state dropdown: "Global default" / "Enabled" / "Disabled"
- [ ] MCP tools listed (when connected servers exist) grouped by server name, with the same three-state dropdown
- [ ] Dropdown value reads from `ctx.settings.persona_tool_enabled[personaName][toolId]` (defaults to `"global"` if absent)
- [ ] Dropdown change handler calls `setPersonaToolEnabledOverride(ctx.settings, personaName, toolId, state)` then `ctx.saveSettings()`
- [ ] Stale detection: `getStaleToolEnabledNames(ctx.settings.persona_tool_enabled[personaName] ?? {}, registeredToolNames)` used to identify stale entries
- [ ] Stale entries rendered with warning indicator and "Remove" button (same visual style as existing stale auto-approve entries)
- [ ] "Remove" button calls `setPersonaToolEnabledOverride(ctx.settings, personaName, staleName, "global")` then `ctx.saveSettings()` and re-renders the section
- [ ] Override count badge in persona `<summary>` includes count of entries in both `persona_auto_approve[personaName]` and `persona_tool_enabled[personaName]`
- [ ] Imports `setPersonaToolEnabledOverride`, `getStaleToolEnabledNames` from `../../personas/tool-enabled-resolver`
- [ ] Imports `ToolEnabledState` from `../../types`
- [ ] Plugin loads and Settings renders without errors; existing auto-approve functionality unaffected

---

## Group T-E: Dispatcher Blocking

### T-E-001: Add tool-enabled check to dispatcher

**Description:** Add `toolEnabled` and `personaToolEnabled` state fields, two new setter methods, and a blocking check in `dispatch()` to `src/chat/dispatcher.ts`.

**FRs:** FR-66
**Files:**
- `src/chat/dispatcher.ts` — add fields, setters, and dispatch step 1.5

**Dependencies:** T-B-001

**Acceptance Criteria:**
- [ ] `private toolEnabled: Record<string, boolean> = {}` field added
- [ ] `private personaToolEnabled: Record<string, Record<string, string>> = {}` field added
- [ ] `setToolEnabled(settings: Record<string, boolean>): void` method added (copies with spread, same as `setAutoApprove`)
- [ ] `setPersonaToolEnabled(overrides: Record<string, Record<string, string>>): void` method added (assigns directly, same as `setPersonaAutoApprove`)
- [ ] In `dispatch()`, after step 1 (tool found) and before step 2 (Plan/Act check), a new check resolves tool enabled state via `resolveToolEnabled(toolName, this.activePersonaName, this.personaToolEnabled, this.toolEnabled)`
- [ ] If not enabled: `toolCall.status = "error"`, emit `onToolCallStatusChanged`, return `ToolResult` with `success: false` and `error: "Tool '${toolName}' is disabled. Enable it in Settings → Tools & permissions to use this tool."`
- [ ] `log.info("Blocked disabled tool", { toolName })` emitted on block
- [ ] `resolveToolEnabled` imported from `../personas/tool-enabled-resolver`
- [ ] The dispatch comment block updated to reflect step 1.5
- [ ] Existing dispatch functionality (Plan/Act check, pre-execution checks, auto-approve, execution) is unaffected
- [ ] `npm run build` succeeds with no type errors

---

## Group T-F: Filtering & Wiring

### T-F-001: Filter tool definitions at send time and wire dispatcher state

**Description:** Add `getFilteredToolDefinitions()` to the plugin class in `src/main.ts`, replace both `getToolDefinitions()` call sites with the filtered variant, and wire `setToolEnabled`/`setPersonaToolEnabled` to all three dispatcher update locations.

**FRs:** FR-65, FR-69
**Files:**
- `src/main.ts` — add helper method, update 2 call sites, update 3 wiring locations

**Dependencies:** T-B-001, T-E-001

**Acceptance Criteria:**
- [ ] Private `getFilteredToolDefinitions()` method added to the plugin class
  - Calls `this.getToolRegistry().getToolDefinitions()`
  - Filters using `resolveToolEnabled(def.name, this.settings.active_persona || null, this.settings.persona_tool_enabled, this.settings.tool_enabled)`
  - Returns filtered array cast to `ToolDefinition[]`
- [ ] `setGetToolDefinitions` callback (line ~1179) updated: replaces `toolRegistry.getToolDefinitions()` with `this.getFilteredToolDefinitions()`
- [ ] `setOnSendMessage` handler (line ~1200) updated: replaces `toolRegistry.getToolDefinitions()` with `this.getFilteredToolDefinitions()`
- [ ] `getToolDispatcher()` init block: `this._toolDispatcher.setToolEnabled(this.settings.tool_enabled)` and `this._toolDispatcher.setPersonaToolEnabled(this.settings.persona_tool_enabled)` added after existing `setPersonaAutoApprove` call
- [ ] `saveSettings()` dispatcher update block: same two calls added after existing `setPersonaAutoApprove` call
- [ ] `setOnNewConversation` reload callback: same two calls added after existing `setPersonaAutoApprove` / `setActivePersonaName` calls
- [ ] `resolveToolEnabled` imported from `./personas/tool-enabled-resolver`
- [ ] `npm run build` succeeds with no type errors
- [ ] Manual test: disable a built-in tool in Settings, send a message, confirm that tool definition does not appear in the LLM call (verifiable via debug logging or by observing AI cannot use the tool)

---

## Implementation Order

Recommended execution sequence respecting dependencies:

1. **T-A-001** → **T-A-002** → **T-A-003** (in sequence — each builds on the previous)
2. **T-B-001** (resolver — unblocks all remaining groups)
3. Parallel: **T-C-001** (global UI) + **T-E-001** (dispatcher)
4. **T-D-001** (persona UI — requires T-B + T-C)
5. **T-F-001** (wiring — requires T-B + T-E; best done last to tie everything together)

Minimum viable feature for testing: T-A-001 through T-A-003 + T-B-001 + T-E-001 + T-F-001 (Groups T-A, T-B, T-E, T-F). The settings UI (T-C, T-D) can follow independently.
