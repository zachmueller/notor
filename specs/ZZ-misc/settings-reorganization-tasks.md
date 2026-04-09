# Settings Reorganization — Implementation Tasks

**Design doc:** [settings-reorganization-design.md](settings-reorganization-design.md)
**Status:** In progress — Phase 8 complete
**Date:** 2026-04-09

---

## Phase 1: Extract Field Renderer Module

> **Goal:** Extract field-rendering infrastructure from `extensions.ts` into a shared module so it can be imported by the new `ToolSettingsModal`, the Automation section, and the shared settings sub-section.
>
> **Why first:** This is a pure refactor with no behavioral changes, and every subsequent phase depends on these exports being available from the new location.

- [x] **1.1 Create `src/settings/sections/field-renderer.ts`**
  - Copy these items from `extensions.ts`:
    - `FieldTarget` type (lines 345-347) — discriminated union: `{ kind: "shared" } | { kind: "extension"; extensionName: string }`
    - `renderFieldList()` (lines 352-361) — iterates schema array, calls `renderField()` per field
    - `renderField()` (lines 392-589) — renders a single field by type (string, number, boolean, string[], secret, dropdown)
    - `getPersistedValue()` (lines 364-373) — reads field value from `user_shared_settings` or `user_extension_settings`
    - `saveFieldValue()` (lines 376-389) — writes field value and calls `saveSettings()`
  - Export all five items
  - Preserve the `@internal Exported for tests` JSDoc on `renderField` and `FieldTarget`
  - Imports needed: `Setting`, `Notice` from obsidian; `SecretComponent` from `../../secret/secret-component`; `SettingsContext` from `./context`; `SettingsFieldSchema` from `../../extensions/types`

- [x] **1.2 Update `extensions.ts` to import from `field-renderer.ts`**
  - Remove the copied function/type bodies from `extensions.ts`
  - Add `import { FieldTarget, renderFieldList, renderField, getPersistedValue, saveFieldValue } from "./field-renderer"`
  - Re-export `FieldTarget` and `renderField` from `extensions.ts` for backward compatibility with the test file (temporary — removed in Phase 7)

- [x] **1.3 Update test imports**
  - In `src/settings/sections/__tests__/extensions-string-array.test.ts`:
    - Change `import { renderField, type FieldTarget } from "../extensions"` to `import { renderField, type FieldTarget } from "../field-renderer"`
  - Run tests to confirm no regressions: `npx vitest run src/settings/sections/__tests__/extensions-string-array.test.ts`

- [x] **1.4 Verify build**
  - Run `npm run build` (or equivalent) to confirm no circular imports or missing references

---

## Phase 2: Create Tool Settings Modal

> **Goal:** Build the `ToolSettingsModal` component that provides focused, per-tool settings access via a gear icon click.
>
> **Why now:** The modal is the centerpiece of the new UX. Building it before wiring it into tool rows lets us test it in isolation.

- [x] **2.1 Create `src/ui/tool-settings-modal.ts`**
  - Extend Obsidian's `Modal` class (same pattern as `confirm-modal.ts`)
  - Constructor takes `SettingsContext`, `toolName: string`, and optional `scrollToGroup` callback
  - `onOpen()` calls `renderContent()`
  - `onClose()` empties `contentEl` and calls `ctx.redisplay()` to refresh the parent settings tab

- [x] **2.2 Implement modal header**
  - Render `<h2>` with tool name
  - Render `<p class="setting-item-description">` with tool description (from `registry.get(toolName)?.description`)

- [x] **2.3 Implement "Reset to default" section (built-in tools only)**
  - Check if tool is built-in via `manager.getBuiltinToolNames()`
  - Check if vault override file exists at `normalizePath({notor_dir}/tools/{toolName}.md)`
  - If override exists: render a `Setting` with "Custom definition active" name and "Reset to default" warning button
  - On click: show `ConfirmModal`, then call `manager.resetBuiltinToolToDefault()`, `manager.reload(false)`, show `Notice`, re-render modal content
  - Import `ConfirmModal` from `./confirm-modal`

- [x] **2.4 Implement shell configuration section (`execute_command` only)**
  - If `toolName === "execute_command"`: call `renderShellSection(contentEl, ctx)` from `execute-command.ts`
  - The existing `renderShellSection` renders its own heading ("Shell configuration") — this is fine inside the modal
  - No changes needed to `execute-command.ts` at this point (description text update is Phase 8)

- [x] **2.5 Implement per-tool settings section**
  - Look up tool definition via `manager.getTools()` to find `settingsSchema`
  - If `settingsSchema` exists and has entries:
    - Render "Settings" heading via `new Setting(contentEl).setHeading().setName("Settings")`
    - Call `renderFieldList(contentEl, ctx, toolDef.settingsSchema, { kind: "extension", extensionName: toolName })`
    - Render "Reset to defaults" warning button that deletes `ctx.settings.user_extension_settings[toolName]`, saves, and re-renders

- [x] **2.6 Implement shared settings note**
  - If `manager.getSharedSettingsDefinition()` returns a definition:
    - Render a `Setting` with description: "This tool may also be affected by shared settings."
    - Add an anchor element "Edit shared settings →" that on click: closes modal, then calls `scrollToGroup("Tools")` via callback
    - `scrollToGroup` is passed as an optional callback in the constructor (cleanest approach since `_settingTab` is private on the plugin)

- [x] **2.7 Implement "Done" button**
  - Render `new Setting(contentEl).addButton(btn => btn.setButtonText("Done").setCta().onClick(() => this.close()))`

- [x] **2.8 Add modal CSS (if needed)**
  - Tested: Obsidian's default modal styling is sufficient — no additional CSS needed

---

## Phase 3: Refactor Tool Rows — Add Gear and Open-File Icons

> **Goal:** Each built-in and user tool row gains an open-file icon and a conditional gear icon. This requires refactoring `renderBuiltinToolRow()` and `renderUserToolRow()` to expose the `Setting` object for icon attachment.
>
> **Why now:** With the modal ready, we can wire gear icons to open it. The open-file icon replaces the old "Customize" button from extensions.ts.

- [x] **3.1 Refactor `renderBuiltinToolRow()` to return `Setting`**
  - Current signature (tools.ts:193): returns `void`, creates `Setting` internally
  - Change return type to `Setting`
  - Add `return setting;` at end of function
  - Update caller in `renderBuiltinTools()` (tools.ts:162-183) — capture the returned `Setting` for icon attachment

- [x] **3.2 Refactor `renderUserToolRow()` to return `Setting`**
  - Same pattern as 3.1 — change return type to `Setting`, return the object
  - Update caller in `renderUserTools()` (tools.ts:242-271)

- [x] **3.3 Add open-file icon to built-in tool rows**
  - After the auto-approve toggle, add: `setting.addExtraButton(btn => btn.setIcon("square-arrow-out-up-right").setTooltip("Open tool definition").onClick(...))`
  - On click logic (mirrors existing "Customize"/"Open" in extensions.ts:122-181):
    - Check if vault override file exists at `normalizePath({notor_dir}/tools/{toolName}.md)`
    - If exists: open the file via `app.workspace.openLinkText()`
    - If not: call `manager.ensureBuiltinToolVaultFile(toolName)`, then open, show Notice
  - Need access to extension manager: `ctx.plugin.getExtensionManager()`
  - Consider using `addExtraButton` instead of `addButton` to get the smaller icon-only button style

- [x] **3.4 Add open-file icon to user tool rows**
  - Similar to 3.3 but simpler: always open `tool.filePath` directly
  - `setting.addExtraButton(btn => btn.setIcon("square-arrow-out-up-right").setTooltip("Open tool definition").onClick(...))`

- [x] **3.5 Add gear icon to built-in tool rows (conditional)**
  - After the open-file icon, conditionally add gear icon
  - Show gear icon when ANY of:
    - Tool has `settingsSchema` (from extension manager's tool definitions)
    - Tool has a vault override file
    - Tool is `execute_command`
  - On click: `new ToolSettingsModal(ctx, toolId).open()`
  - Import `ToolSettingsModal` from `../../ui/tool-settings-modal`
  - Need to look up tool definitions: `manager.getTools()` → build `Map<string, ToolDef>` at top of section renderer

- [x] **3.6 Add gear icon to user tool rows (conditional)**
  - Show gear icon only if `tool.settingsSchema?.length > 0` (user tool has settings)
  - On click: `new ToolSettingsModal(ctx, tool.name).open()`

- [x] **3.7 Update column headers**
  - `renderColumnHeaders()` (tools.ts:185-191) currently renders "Enabled" and "Auto-approve" only
  - Add spacer column(s) for the open-file and gear icon columns to maintain alignment
  - The exact approach depends on how Obsidian `Setting` renders extra buttons — may need CSS adjustments

- [x] **3.8 Add CSS for icon alignment in tool rows**
  - Add styles to `styles.css` for consistent icon sizing and spacing
  - Ensure open-file and gear icons don't push toggles out of alignment
  - Test with tools that have icons and tools that don't (MCP tools have neither)

---

## Phase 4: Extract Shared Settings and Reload Button

> **Goal:** Extract the shared settings renderer and the reload button from `extensions.ts` into standalone functions that `settings-tab.ts` can call within the Tools section.

- [x] **4.1 Create `src/settings/sections/tool-shared-settings.ts`**
  - Export `renderSharedSettingsSection(containerEl, ctx)`
  - Extract logic from `extensions.ts` lines 28-45:
    - Get shared settings definition from `manager.getSharedSettingsDefinition()`
    - Early return if no definition
    - Render "Shared settings" heading
    - Call `renderFieldList()` from `field-renderer.ts` with target `{ kind: "shared" }`
    - Render "Reset to defaults" button that clears `ctx.settings.user_shared_settings` and redisplays
  - Approximately 30 lines

- [x] **4.2 Extract reload button to a standalone function**
  - Option A: Add `renderReloadExtensionsButton(containerEl, ctx)` to `tool-shared-settings.ts`
  - Option B: Create a separate tiny file
  - Prefer Option A (keeps related tools-section extras together)
  - Extract logic from `extensions.ts` lines 54-67:
    - Render "Reload extensions" `Setting` with description and button
    - On click: `manager.reload(false)`, show Notice with counts, `ctx.redisplay()`

---

## Phase 5: Extract User Automations

> **Goal:** Move user automations rendering from `extensions.ts` to a standalone file so the Automation section can import it.

- [x] **5.1 Create `src/settings/sections/user-automations.ts`**
  - Export `renderUserAutomationsSection(containerEl, ctx)`
  - Extract logic from `extensions.ts` lines 278-338:
    - Get extension manager and automations list
    - Early return if no automations
    - Render "User automations" heading
    - Loop through automations: render label, trigger description, "User" badge, "Open" button, inline settings fields (via `renderFieldList` from `field-renderer.ts`), "Reset to defaults" button
  - Import `renderFieldList` and `FieldTarget` from `./field-renderer`
  - Approximately 60-70 lines

- [x] **5.2 Verify automations render correctly**
  - `extensions.ts` now imports from the new module and delegates to it — the existing Extensions section renders automations identically
  - Build and all 593 tests pass

---

## Phase 6: Rewire Settings Tab Orchestrator

> **Goal:** Update `settings-tab.ts` to implement the new section layout: move file attachments to Conversation, add shared settings and reload to Tools, add user automations to Automation, delete Tool configuration and Extensions groups.
>
> **Why now:** All the extracted pieces are ready. This is the big wiring change.

- [x] **6.1 Add file attachments to Conversation group**
  - In `settings-tab.ts`, after `renderCompactionSection(conversationGroup, ctx)` (around line 144), add:
    ```typescript
    renderFileAttachmentsSection(conversationGroup, ctx);
    ```
  - `renderFileAttachmentsSection` is already imported (used by the old Tool configuration group)

- [x] **6.2 Add shared settings and reload to Tools group**
  - After `renderToolsSection(toolsGroup, ctx)` (around line 160), add:
    ```typescript
    renderSharedSettingsSection(toolsGroup, ctx);
    renderReloadExtensionsButton(toolsGroup, ctx);
    ```
  - Add import for `renderSharedSettingsSection` and `renderReloadExtensionsButton` from `./sections/tool-shared-settings`

- [x] **6.3 Add user automations to Automation group**
  - After `renderVaultEventHooksSection(automationGroup, ctx)` (around line 177), add:
    ```typescript
    renderUserAutomationsSection(automationGroup, ctx);
    ```
  - Add import from `./sections/user-automations`

- [x] **6.4 Delete "Tool configuration" group**
  - Remove the `createSettingsGroup(containerEl, "Tool configuration", ...)` block (around lines 169-173)
  - Remove `renderShellSection(toolConfigGroup, ctx)` call — shell config is now in `execute_command`'s modal
  - Remove `renderFileAttachmentsSection(toolConfigGroup, ctx)` call — moved to Conversation
  - Remove import of `renderShellSection` from `./sections/execute-command` (it's still used by the modal, but not by settings-tab.ts)

- [x] **6.5 Delete "Extensions" group**
  - Remove the `createSettingsGroup(containerEl, "Extensions", ...)` block (around lines 179-181)
  - Remove `renderExtensionsSection(extensionsGroup, ctx)` call
  - Remove import of `renderExtensionsSection` from `./sections/extensions`

- [x] **6.6 Add persisted collapsed-section migration**
  - In the migration block (lines 119-123 of `settings-tab.ts`), after the existing `"Built-in tools"` → `"Tools"` migration, add:
    ```typescript
    delete persisted["Tool configuration"];
    delete persisted["Extensions"];
    ```
  - This prevents stale keys from causing issues when those sections no longer exist

- [x] **6.7 Verify section ordering**
  - Confirm the final order matches the design doc Section 3:
    1. Provider setup [expanded]
    2. Conversation [expanded] — now includes file attachments
    3. Personas [collapsed]
    4. Sub-agents [collapsed]
    5. Rules and workflows [collapsed]
    6. Tools [expanded] — now includes shared settings + reload
    7. MCP servers [expanded]
    8. Automation [collapsed] — now includes user automations
    9. Storage [collapsed]
    10. Reference [collapsed]

---

## Phase 7: Clean Up `extensions.ts`

> **Goal:** With all functionality relocated, remove or gut `extensions.ts`.

- [x] **7.1 Remove re-exports from `extensions.ts`**
  - Remove the temporary re-exports of `FieldTarget` and `renderField` added in Phase 1.2 (test imports were already updated in Phase 1.3)

- [x] **7.2 Delete `extensions.ts`**
  - Verify no remaining imports reference `extensions.ts`:
    - `settings-tab.ts` — import removed in Phase 6.5
    - `extensions-string-array.test.ts` — import updated in Phase 1.3
    - Any other files — search with `grep -r "from.*extensions" src/settings/`
  - Delete `src/settings/sections/extensions.ts`

- [x] **7.3 Verify build after deletion**
  - Run `npm run build` to confirm no broken imports
  - Run `npx vitest run` to confirm all tests pass

---

## Phase 8: Update Cross-References and Polish

> **Goal:** Update all references to the removed sections and polish the implementation.

- [x] **8.1 Update `execute-command.ts` description text**
  - Line 22 currently says: `"and allowed directories are now configured per-tool in Extensions settings."`
  - Replace with: `"and allowed directories are now configured per-tool via the gear icon in Tools settings."`

- [x] **8.2 Update `builtin-profiles.ts` settings deep-link list**
  - In `src/sub-agents/builtin-profiles.ts` around line 148:
    - Remove `"Tool configuration"` from the list of section names
    - Remove `"Extensions"` if present
    - Add guidance that shell config is in the `execute_command` gear-icon modal
    - Add guidance that file attachments are under "Conversation"
  - The AI sub-agent needs to know where these settings moved, not just that they were removed

- [x] **8.3 Review badge styling**
  - The "Built-in" and "User" badges in `extensions.ts` use inline JS styles (marginLeft, fontSize, opacity, fontStyle)
  - These badges are now rendered in:
    - `user-automations.ts` (User badge on automations)
    - Tool rows in `tools.ts` do NOT currently have badges — the design doc removes the "Customized" badge
  - Consider creating CSS classes (`notor-extension-badge-builtin`, `notor-extension-badge-user`) in `styles.css` to replace the inline styles
  - Low priority — can be deferred if the inline approach works fine

- [x] **8.4 Review and update CSS in `styles.css`**
  - Verify `.notor-tool-column-headers` alignment still works with the new icon columns
  - Add any needed styles for gear/open icons in tool rows (from Phase 3.8)
  - Test in both light and dark themes

---

## Phase 9: Testing and Verification

> **Goal:** Ensure everything works correctly through automated and manual testing.

- [ ] **9.1 Update unit tests**
  - Confirm `extensions-string-array.test.ts` passes with the new `field-renderer.ts` import path
  - Consider adding tests for `ToolSettingsModal` rendering:
    - Tool name and description display
    - Settings fields render for tools with `settingsSchema`
    - Shell config renders for `execute_command`
    - Reset button appears for built-in tools with vault override
    - Shared settings note appears when shared definition exists

- [ ] **9.2 Manual testing — Tools section**
  - Open Settings > Tools — verify open-file icons appear on all built-in and user tool rows
  - Verify gear icons appear only on configurable tools (those with settingsSchema, vault override, or execute_command)
  - Verify MCP tools have neither icon
  - Click open-file icon on a non-customized built-in tool — confirm vault override file is created and opened
  - Click open-file icon on a customized built-in tool — confirm vault file opens directly
  - Click open-file icon on a user tool — confirm source file opens
  - Click gear icon — confirm modal opens with correct name, description, and sections
  - Click gear on `execute_command` — confirm shell config fields appear in modal
  - Change a setting in the modal, close it — confirm change persists and Tools section refreshes
  - Verify "Copy tool config YAML" still works
  - Verify shared settings appear at bottom of Tools section with reset button
  - Verify "Reload extensions" button works from the Tools section

- [ ] **9.3 Manual testing — Tool Settings Modal**
  - Test shared settings note link: closes modal and scrolls to shared settings heading
  - Test "Reset to default" on a customized built-in tool: vault file deleted, tool reverts
  - Test "Reset to defaults" on per-tool settings: settings cleared, fields reset
  - Test "Done" button closes modal
  - Test closing modal via Escape key / clicking outside

- [ ] **9.4 Manual testing — Automation section**
  - Open Settings > Automation — verify user automations appear after hooks and vault event hooks
  - Verify automation settings and open buttons work correctly
  - Verify "Reset to defaults" works on automation settings

- [ ] **9.5 Manual testing — Conversation section**
  - Open Settings > Conversation — verify file attachment threshold appears after compaction settings
  - Verify the setting saves and persists correctly

- [ ] **9.6 Manual testing — Removed sections**
  - Confirm "Tool configuration" section no longer appears
  - Confirm "Extensions" section no longer appears
  - Collapse/expand sections, close and reopen settings — verify no errors from removed section keys
  - Verify persisted collapsed state migrates correctly

- [ ] **9.7 Run full test suite**
  - `npx vitest run` — all tests pass
  - `npm run build` — clean build with no errors or warnings

---

## Dependency Graph

```
Phase 1 (field-renderer extraction)
  └─► Phase 2 (ToolSettingsModal) ──────────────────┐
  └─► Phase 4 (shared settings + reload extraction)  ├─► Phase 6 (rewire settings-tab)
  └─► Phase 5 (user automations extraction) ────────┘        │
       Phase 3 (tool row refactor) ─── needs Phase 2 ────────┘
                                                              │
                                                              ▼
                                                     Phase 7 (delete extensions.ts)
                                                              │
                                                              ▼
                                                     Phase 8 (cross-references)
                                                              │
                                                              ▼
                                                     Phase 9 (testing)
```

**Parallelizable work:**
- Phases 2, 4, and 5 can be done in parallel after Phase 1 completes
- Phase 3 can start after Phase 2 completes
- Phase 6 requires Phases 2-5 to be complete
- Phases 7-9 are sequential
