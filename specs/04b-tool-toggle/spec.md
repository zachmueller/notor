# Phase 4b — Per-Tool Enable/Disable Toggles

**Created:** 2026-03-15
**Status:** Draft
**Branch:** 04b-tool-toggle

## Overview

Phase 4b adds fine-grained control over which tools the AI has access to. Currently all registered tools — both built-in (read_note, search_vault, write_note, etc.) and MCP server tools — are always sent to the LLM and always executable. Users have no way to exclude a tool short of disabling an entire MCP server.

This phase introduces per-tool enable/disable toggles. A disabled tool is fully hidden from the AI: its definition is not included in the tool list sent to the LLM, it does not appear in the system prompt tool section, and the dispatcher blocks any attempt to call it. This gives users granular control over AI capabilities and reduces context window consumption when unwanted tools are present (especially on large MCP servers).

The feature builds directly on the persona auto-approve system introduced in Phase 4 (FR-40). The same three-state override pattern (`"global"` / `"enabled"` / `"disabled"`) and the same per-persona settings structure are used, keeping the implementation consistent with existing patterns.

This specification covers:

- **Global tool enabled/disabled toggles**: per-tool on/off settings in Settings → Tools & permissions, applying to all conversations unless overridden by a persona.
- **LLM tool definition filtering**: disabled tools are excluded from `tools` arrays and system prompt sections before each LLM call.
- **Dispatcher blocking**: a safety-net check that blocks execution of any disabled tool that the LLM somehow calls.
- **Per-persona tool enabled overrides**: persona-level three-state overrides that follow the same precedence chain as auto-approve overrides.
- **MCP tool support**: MCP tools (dynamically discovered, namespaced as `server__tool`) are not listed in the global toggle section but appear in per-persona override sections. Global default for all MCP tools is enabled.

## User stories

### Global tool toggles

- As a user, I want to disable individual tools so the AI doesn't have access to capabilities I don't want it to use.
- As a user, I want to disable the `execute_command` tool entirely so there's no chance the AI can run shell commands in my vault, even accidentally.
- As a user, I want to disable tools I never use so the AI receives a smaller, more focused tool set that reduces context window usage.
- As a user, I want all tools enabled by default so I don't have to reconfigure anything after upgrading.

### LLM tool definition filtering

- As a user, I want disabled tools excluded from what's sent to the LLM — not just blocked after the fact — so the AI never even considers using them.
- As a user, I want my changes to take effect immediately on the next message without needing to reload the plugin.

### Per-persona tool overrides

- As a power user, I want a "researcher" persona to have only read-only tools enabled, so it cannot modify my vault.
- As a power user, I want a "writer" persona to have all write tools enabled while a "read-only" persona has them disabled, giving each persona a tailored capability set.
- As a user, I want per-persona overrides to fall back to my global settings for tools I haven't explicitly configured on the persona, so I only need to set the exceptions.

### MCP tools

- As a user with a large MCP server, I want to disable specific MCP tools per persona so I can give each persona access to only the MCP capabilities relevant to its role.
- As a user, I want stale per-persona MCP tool overrides (from a server that was removed or a tool that no longer exists) to be flagged with a warning and removable, consistent with how auto-approve handles stale entries.

## Functional requirements

### FR-64: Global tool enabled/disabled toggles

**Description:** Users can toggle each built-in tool on or off globally in **Settings → Notor → Tools & permissions**. All tools default to enabled. Changes take effect on the next message sent.

**Acceptance criteria:**
- A new "Enabled tools" section appears in **Settings → Notor → Tools & permissions**, rendered immediately before the existing "Auto-approve" section.
- The section lists all 10 built-in tools, split into two sub-groups: "Read-only tools" and "Write tools", in the same grouping as the auto-approve section.
- Each tool row shows the tool's display name and a toggle switch (on = enabled, off = disabled).
- All tools default to enabled (`true`). New installations and upgrades from previous versions start with all tools enabled.
- Changes persist immediately to plugin settings via the standard `saveSettings()` call.
- Changes take effect on the next message: the next LLM call uses the updated tool list.
- MCP tools are not listed in this global section. The global default for all MCP tools is enabled. Per-persona overrides are the mechanism for controlling individual MCP tools (FR-68).

### FR-65: Disabled tools excluded from LLM

**Description:** When a tool is disabled (globally or via active persona override), its definition is excluded from the tool definitions sent to the LLM and from the system prompt tool section before each message.

**Acceptance criteria:**
- Before each LLM call, the full tool definition list is filtered using the effective enabled state for each tool (resolved per FR-67's precedence chain).
- Disabled tools do not appear in the `tools` array sent to the Anthropic (or other provider) API.
- Disabled tools do not appear in the system prompt's tool definitions section.
- Filtering uses the active persona name from `settings.active_persona` at send time.
- When all tools are enabled (the default), behavior is identical to the current behavior — no performance impact, no tool list changes.
- Filtering is applied at both message send call sites in `main.ts` (user-initiated messages and workflow-initiated messages) so disabled tools are consistently excluded regardless of how a conversation is started.

### FR-66: Dispatcher blocking for disabled tools

**Description:** If the LLM somehow generates a tool call for a disabled tool (e.g., due to a cached context window from before the tool was disabled), the dispatcher blocks execution and returns a clear error result to the LLM.

**Acceptance criteria:**
- The dispatcher checks each tool call against the effective enabled state before proceeding to Plan/Act mode checks or any other validation.
- If the tool is disabled, the tool call status is set to `"error"`, the `onToolCallStatusChanged` event is emitted, and a `ToolResult` is returned with:
  - `success: false`
  - `error: "Tool '{toolName}' is disabled. Enable it in Settings → Tools & permissions to use this tool."`
- The disabled check occurs after the tool-found check (step 1 in `dispatch()`) and before the Plan/Act mode check (step 2), so it is the second guard in the dispatch pipeline.
- A disabled tool is never executed, regardless of auto-approve settings or persona state.
- Log entry emitted at `info` level: "Blocked disabled tool" with `toolName`.

### FR-67: Per-persona tool enabled overrides

**Description:** Users can override the global enabled state for any tool on a per-persona basis using a three-state value. The precedence chain mirrors the auto-approve override system (FR-40).

**Acceptance criteria:**
- Per-persona tool enabled overrides are displayed within each persona's collapsible section in **Settings → Notor → Tools & permissions → Persona auto-approve**, alongside the existing auto-approve override rows.
- A "Tool enabled" sub-group is rendered after the auto-approve rows for each persona. It lists all 10 built-in tools (split read/write) with a three-state dropdown per tool:
  - "Global default" — uses `tool_enabled[toolName]` (or `true` if unset)
  - "Enabled" — tool is enabled for this persona regardless of global setting
  - "Disabled" — tool is disabled for this persona regardless of global setting
- The override count badge shown in each persona's `<summary>` element is updated to reflect combined auto-approve + tool-enabled override counts.
- Selecting "Global default" removes the stored entry for that tool (same cleanup pattern as auto-approve's `"global"` state).
- Changes persist immediately via `saveSettings()` and take effect on the next message.
- The precedence chain for resolving a tool's effective enabled state:
  1. If no persona is active → use `tool_enabled[toolName] ?? true`
  2. If a persona is active → check `persona_tool_enabled[personaName][toolName]`:
     - `"enabled"` → tool is enabled
     - `"disabled"` → tool is disabled
     - `"global"` or absent → fall back to step 1

### FR-68: MCP tool toggling per persona

**Description:** MCP tools are not listed in the global "Enabled tools" section (because they are dynamically discovered and may not be connected), but they do appear in per-persona tool enabled override sections. The global default for all MCP tools is enabled.

**Acceptance criteria:**
- MCP tools appear in the "Tool enabled" sub-group within each persona's collapsible section (FR-67), grouped visually by MCP server name, in the same grouping pattern as the MCP tools in the persona auto-approve sub-group.
- MCP tool entries use the namespaced tool name (`server__tool`) as the settings key and a friendlier `server/tool` display format in the UI.
- The global default for all MCP tools is `true` (enabled). There is no separate global MCP tool toggle — only per-persona overrides.
- Stale MCP tool override entries (tools stored in `persona_tool_enabled` that are no longer registered in the tool registry — e.g., the server was removed or the tool no longer exists) are detected and displayed with a warning indicator and a "Remove" button, consistent with the stale auto-approve entry pattern in FR-40.
- When an MCP server reconnects after a disconnection, any stored per-persona tool enabled overrides for its tools take effect on the next message.

### FR-69: Settings persistence and migration

**Description:** New settings fields introduced by this feature default to all-enabled states. Existing installations are fully backward-compatible — no data migration is required.

**Acceptance criteria:**
- Two new fields are added to `NotorSettings`: `tool_enabled: Record<string, boolean>` and `persona_tool_enabled: Record<string, Record<string, string>>`.
- Default values: `tool_enabled` maps all 10 built-in tool names to `true`. `persona_tool_enabled` is `{}`.
- Plugin settings are loaded via `Object.assign({}, createDefaultSettings(), await loadData())`. Missing fields in existing `data.json` files (pre-upgrade) are automatically filled with defaults. No explicit migration code is needed.
- Stale keys in `tool_enabled` (e.g., old MCP tool names stored from a previous session) have no runtime effect: `getToolDefinitions()` only generates definitions for currently registered tools, and `resolveToolEnabled` for an unregistered tool key is never consulted.

## Non-functional requirements

### NFR-17: Performance

**Description:** Tool filtering adds negligible overhead to message processing.

**Acceptance criteria:**
- Filtering is O(n) where n = number of registered tools (typically ≤ 20). No async operations or vault reads are required.
- No perceptible latency increase on message send.
- When all tools are enabled (the default), behavior is identical to the pre-feature baseline — the filter returns all tools unchanged.

### NFR-18: Consistency with auto-approve pattern

**Description:** The tool enabled/disabled feature follows the same patterns as the auto-approve system to minimize cognitive overhead for users and code complexity for maintainers.

**Acceptance criteria:**
- Settings field names follow the same convention: `tool_enabled` (parallel to `auto_approve`), `persona_tool_enabled` (parallel to `persona_auto_approve`).
- The resolver module (`tool-enabled-resolver.ts`) mirrors the structure of `auto-approve-resolver.ts` exactly.
- The settings UI sub-group within persona sections follows the same visual pattern as auto-approve rows.
- Stale tool detection and removal follows the same pattern as `getStaleToolNames` / `removePersonaOverrides`.

## User scenarios & testing

### Primary flow: Disable a built-in tool globally

1. User opens **Settings → Notor → Tools & permissions**.
2. In the new "Enabled tools" section, user toggles `execute_command` to off.
3. User returns to the chat panel and sends a message asking the AI to run a shell command.
4. The AI's tool list no longer includes `execute_command` — the AI cannot even attempt to use it. The AI responds that it cannot run shell commands.
5. User re-enables `execute_command` in Settings. On the next message, the tool reappears in the AI's tool set.

### Primary flow: Per-persona tool restriction

1. User has a persona "researcher" configured in their vault.
2. User opens **Settings → Notor → Tools & permissions → Persona auto-approve** and expands the "researcher" section.
3. Under the "Tool enabled" sub-group, user sets `write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`, and `execute_command` all to "Disabled".
4. User activates the "researcher" persona in the chat panel.
5. The AI's tool set now contains only the 5 read-only tools: `read_note`, `search_vault`, `list_vault`, `read_frontmatter`, `fetch_webpage`.
6. User switches to the default (no persona) state. All 10 tools are available again.

### Primary flow: Per-persona MCP tool restriction

1. User has an MCP server "data-tools" connected with 5 discovered tools.
2. User opens the "researcher" persona section in Settings and finds "data-tools" tools in the "Tool enabled" sub-group.
3. User sets 3 of the 5 MCP tools to "Disabled" for this persona.
4. With "researcher" active, only 2 of the 5 MCP tools appear in the AI's tool set.

### Alternative flow: LLM calls a disabled tool

1. User disables `write_note` globally mid-conversation (the LLM's context window still mentions `write_note` from a previous message).
2. The LLM generates a `write_note` tool call.
3. The dispatcher catches the call: tool call status set to `"error"`, error result returned to LLM: "Tool 'write_note' is disabled. Enable it in Settings → Tools & permissions to use this tool."
4. The LLM acknowledges it cannot write the note and adjusts its response.

### Alternative flow: Stale MCP tool override

1. User has per-persona overrides for an MCP tool `old-server__search`. The MCP server "old-server" is later removed from Settings.
2. The stale `old-server__search` entry in `persona_tool_enabled` is detected on Settings open (the tool name is no longer in the registered tool list).
3. A warning row is shown: "old-server__search (unknown tool)" with a "Remove" button.
4. User clicks "Remove". The stale entry is deleted from `persona_tool_enabled` and settings are saved.

### Edge case: No active persona

1. No persona is active.
2. Tool enabled state resolves from `tool_enabled[toolName] ?? true` for all tools.
3. All built-in tools not explicitly set to `false` in `tool_enabled` are included in the LLM tool list.

### Edge case: MCP server reconnects

1. User has `data-tools__query` set to "Disabled" for the "researcher" persona.
2. The "data-tools" MCP server disconnects and reconnects.
3. On reconnect, `data-tools__query` is re-registered in the tool registry.
4. With "researcher" active, `data-tools__query` remains excluded from the LLM tool list because the persona override is still `"disabled"` in settings.

### Edge case: All tools disabled for a persona

1. User disables all 10 built-in tools for a persona and has no MCP servers connected.
2. With that persona active, `getFilteredToolDefinitions()` returns an empty array.
3. The LLM call proceeds with no tools. The provider handles empty tool arrays gracefully (no tools in request body).
4. The AI responds in text-only mode, noting it has no tools available.

## Success criteria

1. **Users can toggle individual tools on/off globally** — the "Enabled tools" section appears in Settings and persists changes immediately without plugin reload.
2. **Disabled tools are fully hidden from the LLM** — the `tools` array and system prompt tool section exclude disabled tools before each LLM call. The AI never sees or attempts to call disabled tools in normal operation.
3. **Dispatcher blocks disabled tool calls** — if the LLM somehow calls a disabled tool, the dispatcher returns an error result without executing the tool.
4. **Per-persona overrides work correctly** — activating a persona with tool-enabled overrides changes the tool set visible to the LLM. Switching personas or deactivating all personas restores the expected tool set.
5. **MCP tools are controllable per persona** — MCP tools appear in persona tool-enabled override sections and are correctly excluded from the LLM when disabled for the active persona.
6. **Backward compatibility preserved** — existing installations upgrade seamlessly with all tools enabled by default. No data migration is needed.

## Key entities

### ToolEnabledState

A three-state type used for per-persona overrides, parallel to `AutoApproveState`:

```typescript
type ToolEnabledState = "global" | "enabled" | "disabled";
```

| Value | Meaning |
|---|---|
| `"global"` | No override; use the global `tool_enabled` setting (default for all tools) |
| `"enabled"` | Tool is enabled for this persona regardless of global setting |
| `"disabled"` | Tool is disabled for this persona regardless of global setting |

`"global"` is not stored in settings — when a user selects "Global default", the entry is deleted (same pattern as `AutoApproveState`).

### tool_enabled (settings field)

Global per-tool enabled flags. Key: tool name. Value: `boolean` (true = enabled, false = disabled).

Default: all 10 built-in tool names map to `true`. MCP tools are not stored here — their global default is implicitly `true`.

### persona_tool_enabled (settings field)

Per-persona per-tool enabled overrides. Outer key: persona name. Inner key: tool name (namespaced for MCP tools). Value: `"global"` | `"enabled"` | `"disabled"` (stored as string).

Default: `{}` (no overrides).

## Assumptions

- The existing `ToolRegistry.getToolDefinitions()` returns a flat array of all registered tools with no filtering. Filtering is applied at the two call sites in `main.ts` that consume this array, keeping the registry itself clean.
- `settings.active_persona` is the authoritative source of the active persona name at message-send time. It is kept in sync with the live dispatcher state via `PersonaManager`'s callbacks.
- The `TOOL_DISPLAY_NAMES` constant in `src/settings/constants.ts` is the canonical list of built-in tool names and display metadata. The new "Enabled tools" UI section iterates this same constant.
- MCP tool discovery is asynchronous and may complete after plugin load. Per-persona tool enabled overrides for MCP tools are checked at dispatch time; if a tool is not yet registered (server still connecting), it does not appear in `getToolDefinitions()` output regardless of override state.
- Provider implementations handle empty `tools` arrays correctly (no tools in request body). This is consistent with how providers behave when no tools are registered.

## Out of scope

The following are explicitly excluded from Phase 4b and deferred to later iterations:

- **Global MCP tool toggles**: the global "Enabled tools" section covers only built-in tools. A global per-MCP-tool disable (without using personas) is deferred — per-persona overrides are sufficient for the initial feature.
- **Tool groups or categories**: grouping tools into named bundles that can be toggled as a unit. All toggles are per-tool only.
- **Hiding tools from the Settings UI**: disabled tools still appear in the Settings UI — they are only hidden from the LLM. A future option to hide disabled tools from the settings display is out of scope.
- **Enabling/disabling tools from the chat panel**: tool toggles are a settings-only feature in Phase 4b. There is no quick-toggle in the chat panel UI.
- **Per-workflow tool overrides**: workflows (Phase 4) can activate a persona, and that persona's tool overrides apply. Direct per-workflow tool configuration (without a persona) is out of scope.
