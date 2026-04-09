# Settings Reorganization for Extensions Paradigm

**Status:** Draft
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
| Shell config home | Absorbed into "Tools" section | Shell executable/args are global tool infrastructure. They don't warrant their own section. |
| File attachment home | Absorbed into "Conversation" section | File attachments are a conversation-level feature (attaching files to messages), not tool-specific. |
| Shared settings home | Rendered in "Tools" section | Shared settings apply to all tools/extensions; keeping them near tool controls is logical. |
| Automations home | Move to "Automation" section | Automations are event-triggered behaviors, like hooks and vault event hooks. Grouping them together is semantically correct. |
| Field renderer extraction | Shared module | `renderField()` and helpers must be usable by both the modal and the Automation section's inline automation settings. Extract to `src/settings/sections/field-renderer.ts`. |
| Existing deep-link system | Extended, not replaced | `scrollToGroup()` continues working for group-level navigation. The new modal is a different access pattern (click gear icon). |
| "Customized" badge | Show on built-in tools with vault overrides | Quick indicator in the Tools list that a tool has been customized, without needing to open the modal. |

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
│  ├─ read_note        [toggle] [toggle]  [⚙️ gear]?  [customized badge]?
│  ├─ search_vault     [toggle] [toggle]  [⚙️ gear]?
│  └─ ...
│
├─ [Heading] Write tools
│  ├─ [Column headers: Enabled | Auto-approve]
│  ├─ execute_command  [toggle] [toggle]  [⚙️ gear]   [customized badge]?
│  ├─ write_note       [toggle] [toggle]  [⚙️ gear]?
│  └─ ...
│
├─ [Divider]
├─ [Heading] User tools  (only if user tools exist)
│  ├─ [Column headers]
│  ├─ my_tool          [toggle] [toggle]  [⚙️ gear]?
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
├─ [Heading] Shell configuration  (absorbed from old "Tool configuration") *
│  ├─ [Description] "Configure the shell used by execute_command..."
│  ├─ Shell executable  [text input]
│  └─ Shell arguments   [text input]
│
├─ [Heading] Shared settings  (absorbed from old "Extensions") *
│  ├─ [rendered shared settings fields]
│  └─ [Button] Reset to defaults
│
├─ [Button] Copy tool config YAML
└─ [Button] Reload extensions
```

**Gear icon rules:**
- Built-in tools: gear icon shown if the tool has a settings schema OR the tool can be customized (has a scaffold). In practice, this means all built-in tools get a gear icon since they are all customizable.
- User tools: gear icon shown if the tool has a settings schema.
- MCP tools: no gear icon (MCP tools don't have extension settings).

**"Customized" badge:** Shown next to a built-in tool's name when a vault override file exists at `notor/tools/{toolName}.md`.

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
│ ── Customize ──────────────────────────         │
│ [Customize] or [Open] + [Reset to default]      │
│ (only for built-in tools)                       │
│                                                 │
│ ── Settings ───────────────────────────         │
│ [rendered settings fields from schema]          │
│ [Reset to defaults]                             │
│ (only if tool has settingsSchema)               │
│                                                 │
│ ── Shared settings ────────────────────         │
│ "This tool may use shared settings."            │
│ [View shared settings →]  (link to Tools section│
│ (only if shared settings definition exists)     │
│                                                 │
│                                    [Done]       │
└─────────────────────────────────────────────────┘
```

**For built-in tools**, the modal shows:
1. Tool name + description
2. **Customize section:** "Customize" button (creates vault file) or "Open" + "Reset to default" buttons (if vault file exists)
3. **Settings section:** Per-tool settings fields (if the tool's extension definition has a `settingsSchema`)
4. **Shared settings link:** A brief note ("This tool may use shared settings") with a clickable link that scrolls to the Shared Settings heading in the Tools section (only if a shared settings definition exists). Not editable — shared settings are global, so they are edited in one place only.

**For user tools**, the modal shows:
1. Tool name + description
2. **Open button** to open the extension file
3. **Settings section:** Per-tool settings fields (if defined)
4. **Shared settings link:** (same as above)

**For tools with no settings and no customization possible** (e.g., MCP tools): no gear icon is shown, so no modal is needed.

### 4.2 Modal Behavior

- Extends Obsidian's `Modal` class (same pattern as `ConfirmModal`)
- Reuses the extracted `renderField()` / `renderFieldList()` helpers for per-tool settings fields
- On field change: saves immediately via `saveFieldValue()` (same as current inline behavior)
- Shared settings link uses `scrollToGroup("Tools")` + scroll-to-heading to jump to the Shared Settings area (not editable in the modal)
- "Done" button closes the modal
- Parent settings tab calls `redisplay()` after the modal closes to reflect any changes (e.g., "customized" badge appearing)
- The `onClose()` callback triggers `ctx.redisplay()` to ensure the Tools section reflects any state changes made inside the modal

### 4.3 Implementation

**New file:** `src/ui/tool-settings-modal.ts`

```typescript
// Sketch — not final implementation
import { Modal, Setting } from "obsidian";
import type { SettingsContext } from "../settings/sections/context";
import { renderFieldList, type FieldTarget } from "../settings/sections/field-renderer";

export class ToolSettingsModal extends Modal {
    constructor(
        private ctx: SettingsContext,
        private toolName: string,
    ) {
        super(ctx.app);
    }

    onOpen(): void {
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

        // Customize section (built-in only)
        if (isBuiltin) {
            this.renderCustomizeSection(contentEl);
        } else if (toolDef) {
            // User tool — open button
            new Setting(contentEl).addButton(btn =>
                btn.setIcon("square-arrow-out-up-right")
                    .setTooltip("Open extension file")
                    .onClick(async () => {
                        await this.ctx.app.workspace.openLinkText(
                            toolDef.filePath, "", true
                        );
                    })
            );
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
                        // Re-render modal content
                        this.onOpen();
                    })
            );
        }

        // Shared settings — link only (not editable in modal)
        const sharedDef = manager.getSharedSettingsDefinition();
        if (sharedDef) {
            new Setting(contentEl)
                .setHeading()
                .setName("Shared settings");
            new Setting(contentEl)
                .setDesc("This tool may use shared settings.")
                .addButton((btn) =>
                    btn.setButtonText("View shared settings")
                        .onClick(() => {
                            this.close();
                            // Scroll to Shared Settings in Tools section
                            this.ctx.redisplay();
                        })
                );
        }

        // Done button
        new Setting(contentEl)
            .addButton((btn) =>
                btn.setButtonText("Done").setCta().onClick(() => this.close())
            );
    }

    onClose(): void {
        this.contentEl.empty();
        // Refresh the settings tab to reflect changes
        this.ctx.redisplay();
    }

    private renderCustomizeSection(containerEl: HTMLElement): void {
        // Same logic as current extensions.ts built-in tool rendering:
        // check vault file existence, show Customize or Open + Reset buttons
    }
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
1. The new `ToolSettingsModal`
2. The Automation section (for user automation inline settings)
3. Any remaining inline rendering in the Tools section (shared settings)

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
 renderToolsSection(toolsGroup, ctx);
+renderShellSection(toolsGroup, ctx);
+renderSharedSettingsSection(toolsGroup, ctx);
+renderCopyToolConfigButton(toolsGroup, ctx);   // extracted from renderToolsSection
+renderReloadExtensionsButton(toolsGroup, ctx);

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

### 7.1 Gear Icon on Tool Rows

Each built-in and user tool row gains a gear icon button (rendered after the auto-approve toggle):

```typescript
// After the auto-approve toggle on each row:
const hasSettings = toolDef?.settingsSchema?.length;
const isBuiltin = builtinNames.has(toolId);
const isCustomizable = isBuiltin || hasSettings;

if (isCustomizable) {
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

### 7.2 "Customized" Badge

For built-in tools, check if a vault override file exists and show a badge:

```typescript
const vaultFilePath = normalizePath(`${ctx.settings.notor_dir}/tools/${toolId}.md`);
const isCustomized = ctx.app.vault.getAbstractFileByPath(vaultFilePath) !== null;

if (isCustomized) {
    setting.nameEl.createSpan({
        text: "Customized",
        cls: "notor-extension-badge-customized",
    });
}
```

### 7.3 New Sub-Sections at Bottom

The "Copy tool config YAML" button is **extracted** from `renderToolsSection()` into its own `renderCopyToolConfigButton()` function so that `settings-tab.ts` controls ordering. The final order rendered by `settings-tab.ts` after `renderToolsSection()`:

1. **Shell configuration** — calls the existing `renderShellSection()`
2. **Shared settings** — extracted from `extensions.ts`, renders shared settings fields + reset button
3. **Copy tool config YAML** — extracted from `tools.ts` into `renderCopyToolConfigButton()`
4. **Reload extensions** button — extracted from `extensions.ts`

All four are rendered by `settings-tab.ts` directly (passing `toolsGroup` as the container), keeping `tools.ts` focused on tool rows.

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
| `src/settings/sections/tools.ts` | **Edit** | Add gear icon + modal trigger to tool rows, add "Customized" badge to built-in tools |
| `src/settings/sections/extensions.ts` | **Delete** | All functionality relocated to modal, field-renderer, user-automations, and settings-tab |
| `src/settings/sections/field-renderer.ts` | **Create** | Extract `FieldTarget`, `renderFieldList`, `renderField`, `getPersistedValue`, `saveFieldValue` from extensions.ts |
| `src/settings/sections/shared-settings.ts` | **Create** | Extract shared settings rendering (small, ~30 lines) |
| `src/settings/sections/user-automations.ts` | **Create** | Extract user automations rendering from extensions.ts (~60 lines) |
| `src/settings/sections/execute-command.ts` | **Edit** | `renderShellSection()` is called from a different parent (function itself unchanged). Update stale comment on line 22 that references "Extensions settings" — should reference the gear-icon modal / Tools section instead. |
| `src/settings/sections/file-attachments.ts` | **No change** | `renderFileAttachmentsSection()` is called from Conversation group instead of Tool configuration |
| `src/ui/tool-settings-modal.ts` | **Create** | New modal for per-tool settings (~150-200 lines) |
| `src/ui/confirm-modal.ts` | **No change** | Referenced as pattern for the new modal |
| `src/settings/sections/__tests__/extensions-string-array.test.ts` | **Edit** | Update imports to `field-renderer.ts`, remove tests for deleted rendering, add tests for modal if applicable |
| `src/sub-agents/builtin-profiles.ts` | **Edit** | Update hardcoded settings deep-link list: remove "Tool configuration" (section no longer exists). Shell config is now under "Tools", file attachments under "Conversation". |
| `styles.css` | **Edit** | Add `.notor-extension-badge-customized` styling (use inline JS like existing badges, or migrate all badges to CSS — see note below), gear icon alignment in tool rows |

**Note on badge styling:** The existing "Built-in" and "User" badges (`notor-extension-badge-builtin`, `notor-extension-badge-user`) are styled entirely via inline JavaScript in `extensions.ts` (marginLeft, fontSize, opacity, fontStyle), not through CSS classes defined in `styles.css`. The new "Customized" badge should follow the same inline-JS pattern for consistency, unless this redesign migrates all badges to CSS classes. Pick one approach and apply it uniformly.

---

## 11. Verification

### Manual Testing
1. Open Settings > Tools — verify gear icons appear on built-in and user tools with settings/scaffolds
2. Click a gear icon — verify modal opens with correct tool name, description, customize actions, and settings fields
3. Change a setting in the modal, close it — verify the change persists and the Tools section reflects updates
4. Click "Customize" in the modal for a built-in tool — verify vault file is created and modal updates to show "Open" + "Reset"
5. Verify "Customized" badge appears on tool rows with vault override files
6. Open Settings > Automation — verify user automations appear after hooks and vault event hooks, with correct settings and open buttons
7. Open Settings > Conversation — verify file attachment threshold appears after compaction settings
8. Verify "Tool configuration" and "Extensions" sections no longer appear
9. Verify shell config appears at the bottom of the Tools section
10. Verify shared settings appear at the bottom of the Tools section with reset button
11. Verify "Reload extensions" button works from the Tools section
12. Verify "Copy tool config YAML" still works
13. Collapse/expand sections, close and reopen settings — verify persisted state is correct and no errors from removed section keys

### Automated Testing
- Update existing `extensions-string-array.test.ts` to test extracted `renderField()` from `field-renderer.ts`
- Add unit tests for `ToolSettingsModal` rendering (tool name, description, settings fields, customize section)
- Verify build succeeds with no circular imports after file moves
