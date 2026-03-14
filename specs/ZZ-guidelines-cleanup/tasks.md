# Task Breakdown: Obsidian Plugin Guidelines Cleanup

**Created:** 2026-03-14
**Reference:** https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
**Status:** Phase 1 Complete

## Context

Pre-submission audit against the official Obsidian plugin guidelines. Nine violation categories identified across security, styling, API usage, and UI text conventions. Tasks are ordered by guideline category and have minimal interdependencies — most can be executed in parallel.

## Task Summary

**Total Tasks:** 10
**Phases:** 2 (Quick wins → Structural fixes)
**Estimated Complexity:** Low–Medium

---

## Phase 1: Quick Wins (Isolated, Low Risk)

### GUIDE-001: Fix sentence case in settings group headings

**Guideline:** Use sentence case, not title case.

**Description:** Three settings group headings in `settings-tab.ts` use title case. Rename them to sentence case. Also audit all `Setting.setName()` and `setDesc()` calls across the 22 section files for any title-case label strings.

**Files:**
- `src/settings/settings-tab.ts` — change group heading strings (lines ~88, ~102, ~130):
  - `"Provider Setup"` → `"Provider setup"`
  - `"Tools & Permissions"` → `"Tools & permissions"`
  - `"Tool Configuration"` → `"Tool configuration"`
- `src/settings/sections/*.ts` — audit and fix any title-case `setName()`/`setDesc()` strings

**Dependencies:** None

**Acceptance Criteria:**
- [x] All three affected group headings render in sentence case
- [x] No `Setting.setName()` calls across sections use title case for multi-word labels
- [ ] No regressions in settings tab rendering (`npm run build` passes)

---

### GUIDE-002: Wrap hardcoded hex colors in CSS variables

**Guideline:** Leverage Obsidian's CSS variables for theme compatibility.

**Description:** Several raw hex color values in `styles.css` have no Obsidian CSS variable wrapper. Wrap each in the appropriate variable with the hex as the fallback. The MCP status dot colors and a few error/accent colors are the primary offenders.

**Files:**
- `styles.css` — wrap the following:

| Line(s) | Current | Replace With |
|---------|---------|--------------|
| ~542 | `#ff8080` | `var(--color-red, #ff8080)` |
| ~547 | `#c0392b` | `var(--color-red, #c0392b)` |
| ~2165 | `#4caf50` | `var(--color-green, #4caf50)` |
| ~2166 | `#ff9800` | `var(--color-orange, #ff9800)` |
| ~2167 | `#9e9e9e` | `var(--text-muted, #9e9e9e)` |
| ~2168 | `#f44336` | `var(--color-red, #f44336)` |
| ~2265, ~2301 | `#e8a838` | `var(--color-orange, #e8a838)` |

**Dependencies:** None

**Acceptance Criteria:**
- [x] No bare hex color literals remain without a CSS variable wrapper
- [ ] Colors render correctly in both light and dark Obsidian themes
- [ ] MCP status dots (connected/connecting/disconnected/error) remain visually distinct across themes

---

### GUIDE-003: Replace `.style.display` show/hide with CSS class toggles

**Guideline:** Avoid hardcoded styles; use CSS classes instead.

**Description:** Two files toggle element visibility by directly setting `.style.display`. Replace with a utility CSS class and use Obsidian's `.toggleClass()` / `.addClass()` / `.removeClass()` methods.

**Files:**
- `styles.css` — add utility rule:
  ```css
  .notor-hidden { display: none; }
  ```
- `src/ui/compaction-marker.ts` — lines ~102, ~115–116: replace `details.style.display = "none"/"block"` with `.addClass("notor-hidden")` / `.removeClass("notor-hidden")`
- `src/settings/sections/mcp-servers.ts` — lines ~733, ~753: replace `stdioWarningEl.style.display = "none"/"block"` with `.toggleClass("notor-hidden", condition)`

**Dependencies:** None

**Acceptance Criteria:**
- [x] No `.style.display` assignments for show/hide remain in the two affected files
- [ ] Compaction marker show/hide behavior unchanged
- [ ] stdio warning banner in MCP settings shows/hides correctly based on transport type selection

---

### GUIDE-004: Route bedrock debug console.error through Logger

**Guideline:** Minimize console logging; configure to show only errors by default.

**Description:** A `console.error(...)` for debugging is left in production code in the Bedrock provider. Route it through the existing structured `Logger` utility instead.

Note: the Logger has no configurable level filtering — it always emits all levels (debug/info/warn/error) to the console, prefixed with `[NOTOR_LOG]` and JSON-formatted for Playwright CDP capture. There is no user-facing log level setting. The value of routing through Logger is consistency and structured output, not filtering.

**Files:**
- `src/providers/bedrock-provider.ts` — line ~354: replace `console.error("[Notor] Bedrock stream error (full object for debugging):", e)` with `log.error(...)` using the existing scoped logger for that module

**Dependencies:** None

**Acceptance Criteria:**
- [x] No bare `console.error` / `console.log` calls remain in non-logger production code
- [x] Bedrock stream error is still observable in the console as a structured `[NOTOR_LOG]` JSON entry

---

### GUIDE-005: Use Obsidian's `normalizePath()` in history module

**Guideline:** Normalize user-defined paths with `normalizePath()`.

**Description:** `src/chat/history.ts` has a custom private `normalizePath()` method. Replace it with Obsidian's built-in `normalizePath` imported from `obsidian`, which handles platform-specific path separators correctly.

**Files:**
- `src/chat/history.ts` — lines ~508–514: remove the custom `normalizePath()` implementation; import `normalizePath` from `'obsidian'`; update all call sites within the class

**Dependencies:** None

**Acceptance Criteria:**
- [x] Custom `normalizePath()` method removed from `HistoryManager`
- [x] `normalizePath` imported from `'obsidian'`
- [x] All history path construction call sites updated
- [ ] History read/write operations function correctly (existing e2e tests pass)

---

## Phase 2: Structural Fixes (Requires More Care)

### GUIDE-006: Replace `innerHTML` SVG assignments with `setIcon()` or `createEl()`

**Guideline:** Avoid `innerHTML`, `outerHTML`, and `insertAdjacentHTML`.

**Description:** 11 `innerHTML` assignments across 4 files all set hardcoded SVG icon strings. Replace each with either:
- `setIcon(el, 'lucide-icon-name')` if a matching Obsidian/Lucide icon exists
- Constructed SVG elements via `createEl('svg', ...)` + `createEl('path', ...)` if no Lucide equivalent

For each replacement, identify the best matching Lucide icon name first (Obsidian ships Lucide icons). The MCP status icons (check-circle, loader, minus-circle, alert-circle) all have Lucide equivalents.

**Files:**
- `src/ui/chat-view.ts` — lines ~484, ~492, ~502, ~644 (list, new-conversation, settings, send/stop icons)
- `src/ui/attachment-picker.ts` — line ~484 (attachment icon)
- `src/ui/mcp-status-indicator.ts` — lines ~91, ~177 (MCP button icon, status dot icon)
- `src/settings/sections/mcp-servers.ts` — line ~210 (status dot icon)

**Lucide icon mapping (to verify):**

| Current SVG | Suggested Lucide name |
|-------------|----------------------|
| Message list icon | `list` |
| New conversation | `message-square-plus` |
| Settings | `settings` |
| Send arrow | `send` |
| Stop square | `square-x` |
| Attachment/paperclip | `paperclip` |
| MCP connected (checkmark circle) | `circle-check` |
| MCP connecting (loader) | `loader` |
| MCP disconnected (minus circle) | `circle-minus` |
| MCP error (alert circle) | `circle-alert` |

**Dependencies:** None (can be done file by file)

**Acceptance Criteria:**
- [ ] Zero `innerHTML` assignments remain across all source files
- [ ] All icons render correctly and are visually equivalent to previous SVGs
- [ ] `setIcon()` used where a Lucide equivalent exists
- [ ] `createEl('svg', ...)` pattern used only where no Lucide equivalent exists

---

### GUIDE-007: Migrate `Vault.modify()` to `Vault.process()`

**Guideline:** Use `Vault.process()` instead of `Vault.modify()` for background file modifications.

**Description:** Two background write operations use `Vault.modify()`. Migrate to `Vault.process()`, which provides atomic read-modify-write semantics and avoids conflicts. The callback receives the current content and returns the new content string.

`Vault.process()` signature:
```typescript
vault.process(file: TFile, fn: (data: string) => string): Promise<string>
```

**Files:**
- `src/checkpoints/checkpoint.ts` — line ~184: restore checkpoint by replacing entire file content
  ```typescript
  // Before
  await this.app.vault.modify(file, checkpoint.content);
  // After
  await this.app.vault.process(file, () => checkpoint.content);
  ```
- `src/tools/write-note.ts` — line ~160: write AI-generated content to a note
  ```typescript
  // Before
  await this.app.vault.modify(existingFile, finalContent);
  // After
  await this.app.vault.process(existingFile, () => finalContent);
  ```

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Both `vault.modify()` calls replaced with `vault.process()`
- [ ] Checkpoint restore writes the correct content to the file
- [ ] `write_note` tool overwrites existing file content correctly
- [ ] E2E test for write-note and checkpoint restore passes

---

### GUIDE-008: Fix `document.body.appendChild()` in workflow activity dropdown

**Guideline:** [Support pop-out windows](https://docs.obsidian.md/Plugins/Guides/Support+pop-out+windows) — each pop-out window has its own `Window` and `Document`; use `activeDocument`/`activeWindow` instead of bare globals.

**Description:** `workflow-activity-dropdown.ts` appends its dropdown element directly to `document.body` and registers event listeners on bare `document`/`window` globals. All five references must be replaced with `activeDocument`/`activeWindow` equivalents so the dropdown works correctly when Obsidian is in a popout window.

The `Menu` API is not a viable replacement — each entry renders two-row structured content (name + status badge, trigger source + timestamp) with live updates while open, which `Menu` does not support.

Import both exports from `obsidian`:
```typescript
import { ..., activeDocument, activeWindow } from 'obsidian';
```

**Files:**
- `src/ui/workflow-activity-dropdown.ts`:
  - line ~114: `document.body.appendChild(this.dropdownEl)` → `activeDocument.body.appendChild(this.dropdownEl)`
  - lines ~143–144: `document.addEventListener(...)` → `activeDocument.addEventListener(...)`
  - lines ~160, ~165: `document.removeEventListener(...)` → `activeDocument.removeEventListener(...)`
  - line ~375: `window.innerWidth` → `activeWindow.innerWidth`
  - line ~381: `window.innerHeight` → `activeWindow.innerHeight`

**Dependencies:** None

**Acceptance Criteria:**
- [ ] `activeDocument` and `activeWindow` imported from `obsidian`
- [ ] `document.body.appendChild` → `activeDocument.body.appendChild` (line ~114)
- [ ] Both `document.addEventListener` calls → `activeDocument.addEventListener` (lines ~143–144)
- [ ] Both `document.removeEventListener` calls → `activeDocument.removeEventListener` (lines ~160, ~165)
- [ ] `window.innerWidth` → `activeWindow.innerWidth` (line ~375)
- [ ] `window.innerHeight` → `activeWindow.innerHeight` (line ~381)
- [ ] Dropdown renders and positions correctly in the main window
- [ ] No regressions to workflow activity dropdown open/close and live-update behavior

---

### GUIDE-009: Add `setHeading()` to settings sections that use raw heading elements

**Guideline:** Use `setHeading()` instead of HTML heading elements for consistency across plugins.

**Description:** Audit all 22 settings section files for any raw `createEl("h2")`, `createEl("h3")`, or `createEl("h4")` heading elements. Replace them with the proper Obsidian pattern:
```typescript
new Setting(containerEl).setHeading().setName("Section title");
```

The collapsible `<details>/<summary>` groups via `createSettingsGroup()` are fine — this only applies to heading elements used as visual dividers within a section's body.

**Files:**
- `src/settings/sections/*.ts` — all 22 files (audit each for raw heading elements)

**Dependencies:** None

**Acceptance Criteria:**
- [ ] No `createEl("h2")`, `createEl("h3")`, or `createEl("h4")` calls remain in settings sections
- [ ] Any replaced headings render with consistent Obsidian heading styles
- [ ] Settings tab visual hierarchy unchanged

---

### GUIDE-010: Add configurable minimum log level (default: error)

**Guideline:** Minimize console logging; configure to show only errors by default.

**Description:** The Logger currently has no level filtering — every `log.debug(...)` and `log.info(...)` call across the codebase emits to the console unconditionally. Add a minimum log level that defaults to `"error"` so production installs are quiet, while developers can lower it to `"debug"` by editing `data.json` directly.

The setting is intentionally hidden from the Settings UI — it's a developer/power-user escape hatch, not an end-user option.

**Implementation sketch:**
1. Add `log_level: LogLevel` to `NotorSettings` with default `"error"`
2. Add a module-level `setLogLevel(level: LogLevel)` export to `logger.ts`; the `emit()` function skips emission when `level` is below the current minimum
3. Call `setLogLevel(settings.log_level)` in `main.ts` after settings load, and again after any settings save

Level ordering for filtering: `debug < info < warn < error`

**Files:**
- `src/utils/logger.ts` — add module-level `currentLevel: LogLevel = "error"` and `setLogLevel()` export; update `emit()` to skip when level is below minimum
- `src/settings/types.ts` — add `log_level: LogLevel` to `NotorSettings`
- `src/settings/defaults.ts` — add `log_level: "error"` to defaults
- `src/main.ts` — call `setLogLevel(this.settings.log_level)` after `loadSettings()` and after each `saveSettings()`

**Dependencies:** None (can land before or after GUIDE-004)

**Acceptance Criteria:**
- [ ] With default settings (`log_level: "error"`), only `error`-level entries appear in the console during normal use
- [ ] Setting `"log_level": "debug"` in `data.json` and reloading the plugin restores full logging
- [ ] `log_level` field does not appear anywhere in the Settings UI
- [ ] Level filtering applies to all Logger instances (module-level state, not per-instance)
- [ ] `npm run build` passes with no type errors

---

## Verification

1. **Build:** `npm run build` — no TypeScript errors after all changes
2. **Settings visual check:** Open Settings → Notor and verify:
   - All group headings use sentence case
   - Section sub-headings (if any replaced) render correctly with Obsidian styling
3. **Theme check:** Toggle between light and dark themes; verify MCP status dot colors are distinct and theme-appropriate
4. **Icon check:** Verify all replaced `innerHTML` icons render correctly in the chat panel header and settings
5. **Functional check:** Trigger a `write_note` tool call and a checkpoint restore to verify `Vault.process()` migration
6. **E2E tests:** Run existing Playwright suite — `npm run test:e2e` — to confirm no regressions
