# Settings Reorganization for Extensions Paradigm

**Status:** In progress — Phase 1 (field renderer extraction) complete
**Date:** 2026-04-09

---

## 1. Motivation

After migrating built-in tools to user extensions, the settings UI has four sections all partially related to tools:

| Section | Default State | Contents |
|---------|--------------|----------|
| **Tools** | Expanded | Enable/auto-approve toggles for all tools (built-in, user, MCP) |
| **MCP servers** | Expanded | Server CRUD, transport config, env vars, tool discovery |
| **Tool configuration** | Collapsed | Shell executable/args (2 fields) + file attachment threshold (1 field) |
| **Extensions** | Collapsed | Built-in tool customize/open/reset + per-tool settings, shared settings, user tools + settings, user automations + settings, reload button |

**Problems:**

1. **"Tool configuration" is misleadingly named and nearly empty.** It contains only 3 fields. Its comment even says "Per-tool settings... are now configured through the extension settings UI."

2. **"Extensions" is a flat list with poor visual hierarchy.** Tool entries, their settings fields, and "Reset to defaults" buttons all render at the same level with similar styling. There is no visual demarcation between "this is a tool" and "these are settings for that tool." Scrolling through many tools is tedious.

3. **No navigation between related sections.** A user sees a tool's enable toggle in "Tools" but must separately find and open the "Extensions" section, then scroll to find that tool's detailed settings. There is no link or shortcut between them.

4. **Automations are grouped with tools** in Extensions, even though they are semantically closer to hooks and vault event hooks (the "Automation" section).

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Section count | 4 tool-related sections become 3 total | Eliminates both "Tool configuration" and "Extensions." Clear mental model: Tools = tool config, MCP servers = server infra, Automation = automated behaviors. |
| Tool detail access | Gear-icon modal per tool | Focused UX: user clicks gear on the tool they care about, sees its settings in isolation. No scrolling through a flat list. Modal pattern already exists (`ConfirmModal`). |
| Shell config home | Absorbed into `execute_command` gear-icon modal | Shell executable/args affect only `execute_command` (per `execute-command.ts` docstring). The modal is the focused UX surface for per-tool config. |
| File attachment home | Absorbed into "Conversation" section | File attachments are a conversation-level feature (attaching files to messages), not tool-specific. |
| Shared settings home | Rendered in "Tools" section | Shared settings apply to all tools/extensions; keeping them near tool controls is logical. |
| Automations home | Move to "Automation" section | Automations are event-triggered behaviors, like hooks and vault event hooks. Grouping them together is semantically correct. |
| Field renderer extraction | Shared module | `renderField()` and helpers must be usable by both the modal and the Automation section's inline automation settings. Extract to `src/settings/sections/field-renderer.ts`. |
| Existing deep-link system | Extended, not replaced | `scrollToGroup()` continues working for group-level navigation. The new modal is a different access pattern (click gear icon). |
| Open-file icon on all tool rows | Replace "Customized" badge with an actionable open-file icon on every built-in and user tool row | For built-in tools: creates vault override if needed, then opens the file. For user tools: opens source file. Makes customization discoverable without a static badge. MCP tools have no open icon. |

---

## 3. New Settings Layout

After the reorganization, the settings tab renders these groups (changes marked with `*`):

```
Provider setup          [expanded]    — unchanged
Conversation            [expanded]    — unchanged, + file attachments absorbed *
Personas                [collapsed]   — unchanged
Sub-agents              [collapsed]   — unchanged
Rules and workflows     [collapsed]   — unchanged
Tools                   [expanded]    — restructured *
MCP servers             [expanded]    — unchanged
Automation              [collapsed]   — absorbs user automations *
Storage                 [collapsed]   — unchanged
Reference               [collapsed]   — unchanged
```

**Deleted sections:** "Tool configuration", "Extensions"

### 3.1 New "Tools" Section Layout

```
Tools [expanded]
├─ [Heading] Tools
├─ [Description] "Control which tools the AI can use..."
│
├─ [Heading] Read-only tools
│  ├─ [Column headers: Enabled | Auto-approve]
│  ├─ read_note        [toggle] [toggle]  [📂 open]  [⚙️ gear]
│  ├─ search_vault     [toggle] [toggle]  [📂 open]  [⚙️ gear]
│  └─ ...
│
├─ [Heading] Write tools
│  ├─ [Column headers: Enabled | Auto-approve]
│  ├─ execute_command  [toggle] [toggle]  [📂 open]  [⚙️ gear]
│  ├─ write_note       [toggle] [toggle]  [📂 open]  [⚙️ gear]
│  └─ ...
│
├─ [Divider]
├─ [Heading] User tools  (only if user tools exist)
│  ├─ [Column headers]
│  ├─ my_tool          [toggle] [toggle]  [📂 open]  [⚙️ gear]?
│  └─ ...
│
├─ [Divider]
├─ [Heading] MCP tools  (only if MCP servers configured)
│  ├─ [Server name + status]
│  │  ├─ [Column headers: Classification | Enabled | Auto-approve]
│  │  ├─ tool_name     [dropdown] [toggle] [toggle]
│  │  └─ ...
│  └─ ...
│
├─ [Divider]
├─ [Heading] Shared settings  (absorbed from old "Extensions") *
│  ├─ [rendered shared settings fields]
│  └─ [Button] Reset to defaults
│
├─ [Button] Copy tool config YAML
└─ [Button] Reload extensions
```

**Gear icon rules:**
- Built-in tools: gear icon shown only when configurable — tool has `settingsSchema`, has a vault override file, or is `execute_command`. Avoids empty modals for tools with no actionable config.
- User tools: gear icon shown if the tool has a settings schema.
- MCP tools: no gear icon (MCP tools don't have extension settings).

**Open-file icon rules:**
- Built-in tools: all built-in tools get an open-file icon. If no vault override file exists yet, clicking creates it (same as existing "Customize" logic in `extensions.ts`) and opens it. If the file exists, opens it directly.
- User tools: all user tools get an open-file icon that opens the source extension file.
- MCP tools: no open icon (no source file to open).

**Implementation note:** `renderBuiltinToolRow()` and `renderUserToolRow()` in `tools.ts` currently create the `Setting` object internally without returning it. These functions must be refactored (e.g., return the `Setting`, or accept a post-render callback) so the gear and open icons can be added to each row.

### 3.2 New "Automation" Section Layout

```
Automation [collapsed]
├─ [Heading] Hooks
│  ├─ [existing hooks UI — unchanged]
│  └─ ...
│
├─ [Heading] Vault event hooks
│  ├─ [existing vault event hooks UI — unchanged]
│  └─ ...
│
├─ [Heading] User automations  (absorbed from old "Extensions") *
│  ├─ my_automation  [User badge]  [Open button]
│  │  ├─ [inline settings fields if present]
│  │  └─ [Button] Reset to defaults
│  └─ ...
```

### 3.3 File Attachments in "Conversation"

The single "External file size threshold (MB)" setting moves from the deleted "Tool configuration" section into the "Conversation" group, rendered after the existing compaction section. File attachments are a conversation-level feature (attaching files to messages), not a tool-specific setting.

```
Conversation [expanded]
├─ [existing: General, Auto-context, Compaction]
└─ [Heading] File attachments  *
   ├─ [Description] "Settings for attaching external files..."
   └─ External file size threshold (MB)  [text input]
```

---

## 4. Tool Settings Modal

A new `ToolSettingsModal` provides focused access to a single tool's configuration. It opens when the user clicks the gear icon on any tool row in the Tools section.

### 4.1 Modal Structure

```
┌─────────────────────────────────────────────────┐
│ [Tool name]                                     │
│ [Tool description — from registry or extension] │
│                                                 │
│ ── Reset ──────────────────────────────         │
│ [Reset to default]                              │
│ (only for built-in tools with vault override)   │
│                                                 │
│ ── Shell configuration ────────────────         │
│ Shell executable  [text input]                  │
│ Shell arguments   [text input]                  │
│ (only for execute_command)                      │
│                                                 │
│ ── Settings ───────────────────────────         │
│ [rendered settings fields from schema]          │
│ [Reset to defaults]                             │
│ (only if tool has settingsSchema)               │
│                                                 │
│ [Note: "This tool may also be affected by       │
│  shared settings." → link to shared settings]   │
│ (only if shared settings definition exists)     │
│                                                 │
│                                    [Done]       │
└─────────────────────────────────────────────────┘
```

**For built-in tools**, the modal shows:
1. Tool name + description
2. **Reset section:** "Reset to default" button (only if a vault override file exists). The "Customize" and "Open" actions have moved to the open-file icon on the tool row.
3. **Shell configuration:** Shell executable + shell arguments fields (only for `execute_command` — absorbed from old "Tool configuration" section). Reuses the existing `renderShellSection()` from `execute-command.ts` rather than duplicating the field rendering logic.
4. **Settings section:** Per-tool settings fields (if the tool's extension definition has a `settingsSchema`)
5. **Shared settings note:** A brief note that shared settings may affect this tool, with a link that closes the modal and scrolls to the Shared Settings heading in the Tools section (only if a shared settings definition exists). No read-only field rendering — keeps the modal focused.

**For user tools**, the modal shows:
1. Tool name + description
2. **Settings section:** Per-tool settings fields (if defined)
3. **Shared settings note:** (same as above)

**For tools with no settings and no customization possible** (e.g., MCP tools): no gear icon is shown, so no modal is needed.

### 4.2 Modal Behavior

- Extends Obsidian's `Modal` class (same pattern as `ConfirmModal`)
- Reuses the extracted `renderField()` / `renderFieldList()` helpers for per-tool settings fields
- On field change: saves immediately via `saveFieldValue()` (same as current inline behavior)
- For `execute_command`: reuses `renderShellSection()` from `execute-command.ts` (refactored to optionally suppress heading if needed)
- Shared settings note with link that closes the modal and uses `scrollToGroup("Tools")` + DOM scroll to the Shared Settings heading
- "Done" button closes the modal
- Parent settings tab calls `redisplay()` after the modal closes to reflect any changes (e.g., "customized" badge appearing)
- The `onClose()` callback triggers `ctx.redisplay()` to ensure the Tools section reflects any state changes made inside the modal

### 4.3 Implementation

**New file:** `src/ui/tool-settings-modal.ts`

```typescript
// Sketch — not final implementation
import { Modal, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "../settings/sections/context";
import { renderFieldList, type FieldTarget } from "../settings/sections/field-renderer";
import { renderShellSection } from "../settings/sections/execute-command";

export class ToolSettingsModal extends Modal {
    constructor(
        private ctx: SettingsContext,
        private toolName: string,
    ) {
        super(ctx.app);
    }

    onOpen(): void {
        this.renderContent();
    }

    onClose(): void {
        this.contentEl.empty();
        // Refresh the settings tab to reflect changes
        this.ctx.redisplay();
    }

    private renderContent(): void {
        const { contentEl } = this;
        contentEl.empty();

        const manager = this.ctx.plugin.getExtensionManager();
        const registry = this.ctx.plugin.getToolRegistry();
        const tool = registry.get(this.toolName);
        const toolDefs = new Map(manager.getTools().map(t => [t.name, t]));
        const toolDef = toolDefs.get(this.toolName);
        const builtinNames = new Set(manager.getBuiltinToolNames());
        const isBuiltin = builtinNames.has(this.toolName);

        // Header
        contentEl.createEl("h2", { text: this.toolName });
        if (tool?.description) {
            contentEl.createEl("p", {
                text: tool.description,
                cls: "setting-item-description",
            });
        }

        // Reset to default (built-in only, when vault override exists)
        if (isBuiltin) {
            const vaultFilePath = normalizePath(
                `${this.ctx.settings.notor_dir}/tools/${this.toolName}.md`,
            );
            const vaultFileExists =
                this.ctx.app.vault.getAbstractFileByPath(vaultFilePath) !== null;

            if (vaultFileExists) {
                new Setting(contentEl)
                    .setName("Custom definition active")
                    .addButton(btn =>
                        btn.setButtonText("Reset to default")
                            .setWarning()
                            .onClick(async () => {
                                // Same deletion logic as current extensions.ts
                                // ... delete vault file, reload, re-render
                                this.renderContent();
                            })
                    );
            }
        }

        // Shell configuration (execute_command only) — reuses renderShellSection()
        if (this.toolName === "execute_command") {
            renderShellSection(contentEl, this.ctx);
        }

        // Per-tool settings
        if (toolDef?.settingsSchema?.length) {
            new Setting(contentEl).setHeading().setName("Settings");
            const target: FieldTarget = {
                kind: "extension",
                extensionName: this.toolName,
            };
            renderFieldList(contentEl, this.ctx, toolDef.settingsSchema, target);

            new Setting(contentEl).addButton(btn =>
                btn.setButtonText("Reset to defaults")
                    .setWarning()
                    .onClick(async () => {
                        delete this.ctx.settings
                            .user_extension_settings[this.toolName];
                        await this.ctx.saveSettings();
                        this.renderContent();
                    })
            );
        }

        // Shared settings note + link
        const sharedDef = manager.getSharedSettingsDefinition();
        if (sharedDef) {
            const noteEl = new Setting(contentEl)
                .setDesc(
                    "This tool may also be affected by shared settings."
                );
            noteEl.descEl.createEl("a", {
                text: "Edit shared settings →",
                href: "#",
            }).addEventListener("click", (e) => {
                e.preventDefault();
                this.close();
                // scrollToGroup("Tools") + scroll to Shared Settings heading
            });
        }

        // Done button
        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Done").setCta().onClick(() => this.close())
            );
    }

    // Shell config reuses renderShellSection() from execute-command.ts — no duplication needed
}
```

---

## 5. Field Renderer Extraction

Currently, the field rendering infrastructure lives inside `extensions.ts`. Two items are already exported (used by `extensions-string-array.test.ts`); the rest are module-private:

- `renderFieldList()` — iterates schemas and calls `renderField()` per field *(not exported)*
- `renderField()` — renders a single field (string, number, boolean, string[], secret) *(exported)*
- `getPersistedValue()` — reads a field's current value from settings *(not exported)*
- `saveFieldValue()` — writes a field's value to settings *(not exported)*
- `FieldTarget` type — discriminated union for shared vs. per-extension targeting *(exported)*

These must be extracted to a shared module so they can be used by:
1. The new `ToolSettingsModal` (per-tool settings fields)
2. The Automation section (for user automation inline settings)
3. The shared settings sub-section in Tools

**New file:** `src/settings/sections/field-renderer.ts`

Exports: `FieldTarget`, `renderFieldList`, `renderField`, `getPersistedValue`, `saveFieldValue`

The existing `extensions.ts` and its tests update their imports to point at the new module. No behavioral changes.

---

## 6. Changes to `settings-tab.ts`

The orchestrator's `display()` method changes as follows:

```diff
 // --- Conversation (expanded by default) ---
 const conversationGroup = createSettingsGroup(containerEl, "Conversation", true, persisted, onToggle);
 renderGeneralSection(conversationGroup, ctx);
 renderAutoContextSection(conversationGroup, ctx);
 renderCompactionSection(conversationGroup, ctx);
+renderFileAttachmentsSection(conversationGroup, ctx);

 // ... (Personas, Sub-agents, Rules and workflows unchanged) ...

 // --- Tools (expanded by default) ---
 const toolsGroup = createSettingsGroup(containerEl, "Tools", true, persisted, onToggle);
 renderToolsSection(toolsGroup, ctx);  // includes "Copy tool config YAML" button
+renderSharedSettingsSection(toolsGroup, ctx);
+renderReloadExtensionsButton(toolsGroup, ctx);
 // Note: Shell config moved to execute_command's ToolSettingsModal

 // --- MCP Servers (expanded by default) ---
 const mcpGroup = createSettingsGroup(containerEl, "MCP servers", true, persisted, onToggle);
 renderMcpServersSection(mcpGroup, ctx);

-// --- Tool Configuration (collapsed by default) ---
-const toolConfigGroup = createSettingsGroup(containerEl, "Tool configuration", false, persisted, onToggle);
-renderShellSection(toolConfigGroup, ctx);
-renderFileAttachmentsSection(toolConfigGroup, ctx);

 // --- Automation (collapsed by default) ---
 const automationGroup = createSettingsGroup(containerEl, "Automation", false, persisted, onToggle);
 renderHooksSection(automationGroup, ctx);
 renderVaultEventHooksSection(automationGroup, ctx);
+renderUserAutomationsSection(automationGroup, ctx);

-// --- Extensions (collapsed by default) ---
-const extensionsGroup = createSettingsGroup(containerEl, "Extensions", false, persisted, onToggle);
-renderExtensionsSection(extensionsGroup, ctx);
```

### 6.1 Persisted Collapsed-Section Migration

Users who have a saved collapsed-section state for "Tool configuration" or "Extensions" need migration. Add to the **existing** migration block in `display()` (lines 119-123 of `settings-tab.ts`, alongside the `"Built-in tools"` → `"Tools"` rename):

```typescript
// Migrate removed section keys (alongside existing "Built-in tools" → "Tools" migration)
delete persisted["Tool configuration"];
delete persisted["Extensions"];
```

---

## 7. Changes to `tools.ts`

### 7.1 Open-File Icon and Gear Icon on Tool Rows

Each built-in and user tool row gains two icon buttons (rendered after the auto-approve toggle). Note: `renderBuiltinToolRow()` and `renderUserToolRow()` must be refactored to return the `Setting` object (or accept a callback), since they currently create it internally without exposing it.

```typescript
// After the auto-approve toggle on each row:

// Open-file icon (built-in + user tools, not MCP)
setting.addButton((btn) =>
    btn
        .setIcon("square-arrow-out-up-right")
        .setTooltip("Open tool definition")
        .onClick(async () => {
            // For built-in tools: create vault override if needed, then open
            // For user tools: open source file directly
        })
);

// Gear icon (built-in: only if configurable; user: only if settingsSchema)
const hasSettings = toolDef?.settingsSchema?.length;
const isBuiltin = builtinNames.has(toolId);
const hasVaultOverride = isBuiltin && app.vault.getAbstractFileByPath(
    normalizePath(`${ctx.settings.notor_dir}/tools/${toolId}.md`)
) !== null;
const isExecuteCommand = toolId === "execute_command";
if ((isBuiltin && (hasSettings || hasVaultOverride || isExecuteCommand)) || hasSettings) {
    setting.addButton((btn) =>
        btn
            .setIcon("settings")  // Lucide gear icon
            .setTooltip("Configure tool settings")
            .onClick(() => {
                new ToolSettingsModal(ctx, toolId).open();
            })
    );
}
```

The "Customized" badge from the original design is **removed**. The open-file icon on every built-in tool row makes customization discoverable without a static indicator.

### 7.3 New Sub-Sections at Bottom

The "Copy tool config YAML" button **stays inside** `renderToolsSection()` (no extraction needed — avoids exporting private `generateToolConfigSnippet()` and `getMcpHub()`).

After `renderToolsSection()`, `settings-tab.ts` appends:

1. **Shared settings** — extracted from `extensions.ts`, renders shared settings fields + reset button
2. **Reload extensions** button — extracted from `extensions.ts`

Shell configuration has moved to the `execute_command` tool's `ToolSettingsModal` and is no longer rendered as a standalone sub-section.

---

## 8. Changes to `extensions.ts`

This file is effectively **deleted or gutted**:

- **Built-in tools section** (`renderBuiltinToolsSection`) — Replaced by the `ToolSettingsModal`. The customize/open/reset logic moves to the modal's `renderCustomizeSection()`.
- **Shared settings** — Extracted to a standalone `renderSharedSettingsSection()` function (new file or inline in `settings-tab.ts`).
- **User tools section** (`renderUserToolsSection`) — No longer needed as a settings section. User tool settings are accessed via the gear icon modal.
- **User automations section** (`renderUserAutomationsSection`) — Extracted and moved to a new file or into the Automation section renderer.
- **Reload button** — Extracted to a standalone `renderReloadExtensionsButton()`.
- **Field rendering** (`renderField`, `renderFieldList`, etc.) — Extracted to `field-renderer.ts` (Section 5).

The `renderExtensionsSection()` export is removed. The file can be deleted once all pieces are relocated.

---

## 9. Changes to Automation Section

The "Automation" group currently renders hooks and vault event hooks. It now also renders user automations.

**Option A:** Add a `renderUserAutomationsSection()` call in `settings-tab.ts` after the vault event hooks call. The function is extracted from `extensions.ts` with the same logic (badge, open button, inline settings, reset button). It imports `renderFieldList` from `field-renderer.ts`.

**Option B:** Inline the automation rendering into a new file `src/settings/sections/user-automations.ts` that exports `renderUserAutomationsSection()`.

Option B is cleaner. The new file is a straightforward extraction from `extensions.ts` lines 278-338 with updated imports.

---

## 10. File Changes Summary

| File | Action | Details |
|------|--------|---------|
| `src/settings/settings-tab.ts` | **Edit** | Reorder section group creation, delete "Tool configuration" and "Extensions" groups, add file attachments to Conversation, add shell/shared/reload to Tools, add user automations to Automation |
| `src/settings/sections/tools.ts` | **Edit** | Add open-file icon + gear icon + modal trigger to tool rows. Refactor `renderBuiltinToolRow()` and `renderUserToolRow()` to return `Setting` (or accept callback). "Copy tool config YAML" button stays in `renderToolsSection()`. |
| `src/settings/sections/extensions.ts` | **Delete** | All functionality relocated to modal, field-renderer, user-automations, and settings-tab |
| `src/settings/sections/field-renderer.ts` | **Create** | Extract `FieldTarget`, `renderFieldList`, `renderField`, `getPersistedValue`, `saveFieldValue` from extensions.ts |
| `src/settings/sections/tool-shared-settings.ts` | **Create** | Extract shared settings rendering (small, ~30 lines) |
| `src/settings/sections/user-automations.ts` | **Create** | Extract user automations rendering from extensions.ts (~60 lines) |
| `src/settings/sections/execute-command.ts` | **Edit** | `renderShellSection()` is no longer called from `settings-tab.ts` — it is reused by `ToolSettingsModal` for `execute_command` only. Update stale description text on line 22 that says "configured per-tool in Extensions settings" — should reference the gear-icon modal instead. |
| `src/settings/sections/file-attachments.ts` | **No change** | `renderFileAttachmentsSection()` is called from Conversation group instead of Tool configuration. |
| `src/ui/tool-settings-modal.ts` | **Create** | New modal for per-tool settings (~150-200 lines) |
| `src/ui/confirm-modal.ts` | **No change** | Referenced as pattern for the new modal |
| `src/settings/sections/__tests__/extensions-string-array.test.ts` | **Edit** | Update imports to `field-renderer.ts`, remove tests for deleted rendering, add tests for modal if applicable |
| `src/sub-agents/builtin-profiles.ts` | **Edit** | Update hardcoded settings deep-link list: remove "Tool configuration" (section no longer exists). **Replace** with guidance that shell config is in the `execute_command` gear-icon modal and file attachments are under "Conversation." Do not simply delete — the AI sub-agent needs to know where these settings moved. |
| `styles.css` | **Edit** | Add CSS for open-file and gear icon alignment in tool rows. Consider migrating existing badge inline styles to CSS classes for consistency. |

**Note on badge styling:** The existing "Built-in" and "User" badges (`notor-extension-badge-builtin`, `notor-extension-badge-user`) are styled entirely via inline JavaScript in `extensions.ts` (marginLeft, fontSize, opacity, fontStyle), not through CSS classes defined in `styles.css`. Since the "Customized" badge is removed (replaced by the open-file icon), this is less urgent, but migrating existing badges to CSS classes during this redesign would improve maintainability.

---

## 11. Verification

### Manual Testing
1. Open Settings > Tools — verify open-file icons and gear icons appear on built-in and user tool rows
2. Click the open-file icon on a non-customized built-in tool — verify vault override file is created and opened
3. Click the open-file icon on a customized built-in tool — verify vault file opens
4. Click the open-file icon on a user tool — verify source file opens
5. Click a gear icon — verify modal opens with correct tool name, description, and settings fields
6. Click the gear icon on `execute_command` — verify shell configuration fields appear in the modal
7. Change a setting in the modal, close it — verify the change persists and the Tools section reflects updates
8. In the modal, verify shared settings appear read-only with an "Edit shared settings" link
9. Click "Edit shared settings" — verify modal closes and scrolls to the Shared Settings heading
10. Click "Reset to default" in the modal for a customized built-in tool — verify vault file is deleted and tool reverts
11. Open Settings > Automation — verify user automations appear after hooks and vault event hooks, with correct settings and open buttons
12. Open Settings > Conversation — verify file attachment threshold appears after compaction settings
13. Verify "Tool configuration" and "Extensions" sections no longer appear
14. Verify shared settings appear at the bottom of the Tools section with reset button
15. Verify "Reload extensions" button works from the Tools section
16. Verify "Copy tool config YAML" still works
17. Collapse/expand sections, close and reopen settings — verify persisted state is correct and no errors from removed section keys

### Automated Testing
- Update existing `extensions-string-array.test.ts` to test extracted `renderField()` from `field-renderer.ts`
- Add unit tests for `ToolSettingsModal` rendering (tool name, description, settings fields, shell config for execute_command, read-only shared settings)
- Verify build succeeds with no circular imports after file moves

---

## 12. Code Review Notes

Issues identified during cross-referencing this design against the codebase (2026-04-09):

### Implementation Gaps (must address before implementation)
1. **`renderBuiltinToolRow()` / `renderUserToolRow()` encapsulate `Setting` creation** — these functions must be refactored to expose the `Setting` object for icon attachment (Section 7.1).
2. ~~**`generateToolConfigSnippet()` and `getMcpHub()` are private** in `tools.ts`~~ — resolved: "Copy tool config YAML" button stays in `renderToolsSection()`, no export needed.
3. **Column headers** (`tools.ts:185-191`) render only "Enabled" and "Auto-approve" — need updating for the new open/gear icon columns.
4. **`execute-command.ts` line 22** description text references "Extensions settings" — needs concrete replacement text.
5. **`shared.ts` already exists** in `src/settings/sections/` (contains name-prompt helpers). The proposed `tool-shared-settings.ts` won't conflict but may cause confusion — resolved: file is now named `tool-shared-settings.ts`.

### Minor Implementation Notes
- Modal uses `renderContent()` instead of re-calling `onOpen()` for re-renders.
- Shared settings "Edit" link must implement actual DOM scroll to heading, not just `redisplay()`.
- Section 6.1 migration (`delete persisted[...]`) runs on every `display()` call — acceptable (matches existing pattern) but not ideal.
