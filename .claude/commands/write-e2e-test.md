# Write E2E Test Script

Write a new end-to-end test script for the Notor Obsidian plugin. E2E tests launch the real Obsidian app, connect via Playwright + CDP, and exercise plugin behavior in the actual runtime environment.

**ARGUMENTS:** A description of what the test should validate — e.g. feature name, spec reference, or list of scenarios.

---

## Architecture Overview

All e2e test scripts live in `e2e/scripts/` and follow a standardized pattern built on three shared modules:

| Module | Purpose |
|--------|---------|
| `e2e/lib/test-harness.ts` | `runTest(config, testFn)` — orchestrates the full lifecycle: build, vault reset, data.json inject, Obsidian launch, CDP connect, page discovery, log collection, teardown, results summary |
| `e2e/lib/test-helpers.ts` | Shared constants, element helpers, LLM interaction helpers, UI action helpers, `buildDefaultSettings()` |
| `e2e/lib/log-collector.ts` | `LogCollector` — captures structured `[NOTOR_LOG]` entries from console via CDP. Exposes `getStructuredLogs()`, `getLogsByLevel()`, `getLogsBySource()` |

**You MUST use these modules.** Never duplicate boilerplate that they already provide.

---

## Step 1: Read the shared modules

Before writing any code, read these files to understand the available APIs:

```
e2e/lib/test-harness.ts
e2e/lib/test-helpers.ts
e2e/lib/log-collector.ts
```

Key exports from `test-helpers.ts`:
- **Constants:** `PROJECT_ROOT`, `BUILD_DIR`, `VAULT_PATH`, `PLUGIN_DATA_PATH`, `RESULTS_DIR`, `LOGS_DIR`, `CDP_PORT`
- **Settings:** `buildDefaultSettings(overrides?)` — returns a complete plugin settings object; only pass fields that differ from defaults
- **Page finders:** `findVaultPage(browser, timeout?)` — finds the Obsidian page with `.notor-chat-container`
- **Element helpers:** `waitForSelector(page, selector, timeoutMs?)`
- **LLM helpers:** `sendMessage(page, message)`, `sendMessageWithApprovalHandling(page, message)`, `waitForResponse(page, timeoutMs?)`, `getLastAssistantMessage(page)`, `getLastToolCallNames(page)`
- **UI helpers:** `newConversation(page)`, `setMode(page, "Plan" | "Act")`, `selectPersona(page, name | null)`
- **State helpers:** `ensureCleanState(page)` — aborts any in-progress LLM response and waits for the chat input to become editable; call at the start of tests that require a clean input state, especially after tests that may leave a streaming response in flight
- **Workspace helpers:** `writeCleanWorkspace(vaultPath)` — call from `setupVault` so Obsidian starts with exactly one chat panel
- **Obsidian settings helpers:** `openPluginSettings(page, tabId?)`, `closeSettings(page)`, `expandSettingsGroup(page, groupTitle)`, `scrollToSettingsSubsection(page, name)`, `SETTINGS_CONTENT_SELECTOR`, `disableSettingsPopout(vaultPath)` — see the settings section below

Key exports from `test-harness.ts`:
- **`runTest(config, testFn)`** — the only entry point; handles everything from build to teardown
- **`TestContext`** — passed to your test function, provides: `page`, `browser`, `obsidian`, `collector`, `results`, `vaultPath`, `screenshotsDir`, `pass()`, `fail()`, `screenshot()`
- **`TestConfig`** — `{ name, settings?, skipBuild?, setupVault?, cleanupFiles?, skipCleanWorkspace?, vaultResetOptions?, cdpPort?, launchTimeout? }`

`runTest()` also does two things automatically before launch, so tests don't repeat them:
- `writeCleanWorkspace()` — resets `workspace.json` to a single chat panel (opt out via `skipCleanWorkspace`)
- `disableSettingsPopout()` — makes the settings modal render inline (see the settings section)

---

## Step 2: Understand the required structure

Every test script MUST follow this structure:

```ts
#!/usr/bin/env npx tsx
/**
 * [Test Name] E2E Test (TEST-NNN)
 *
 * [Brief description of what is validated]
 *
 * Scenarios:
 *   1. [First test scenario]
 *   2. [Second test scenario]
 *   ...
 *
 * @see specs/[spec-path] — [requirement IDs]
 */

import { runTest, type TestContext } from "../lib/test-harness";
import { buildDefaultSettings, /* other helpers as needed */ } from "../lib/test-helpers";

// ---------------------------------------------------------------------------
// Local constants (test-specific only)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local helpers (test-specific only — NOT duplicates of shared helpers)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testScenarioOne(ctx: TestContext): Promise<void> {
    console.log("\nTest 1: [Description]");
    const { page } = ctx;
    // ... test logic ...
    // Use ctx.pass() / ctx.fail() for assertions — NEVER soft-pass expected functionality
}

// ... more test functions ...

// ---------------------------------------------------------------------------
// Main test function
// ---------------------------------------------------------------------------

async function tests(ctx: TestContext): Promise<void> {
    const { page } = ctx;
    await page.waitForTimeout(5_000); // Wait for plugin init
    await testScenarioOne(ctx);
    // ...
}

// ---------------------------------------------------------------------------
// Settings & entry point
// ---------------------------------------------------------------------------

const settings = buildDefaultSettings({
    // Only include overrides that differ from defaults
});

runTest({ name: "my-test-name", settings }, tests);
```

---

## Step 3: Write the test script

Follow these rules strictly:

### DO:
- **Import from shared modules** — `runTest`, `TestContext`, `buildDefaultSettings`, and any helpers you need
- **Use `buildDefaultSettings(overrides)`** — only pass fields that differ from the defaults (read the function to see what defaults exist)
- **Use `ctx.pass()` / `ctx.fail()`** for every assertion — include a descriptive name and detail string
- **Use `ctx.screenshot(name)`** at key verification points — include the screenshot path in pass/fail calls
- **Use `ctx.collector`** to inspect structured logs — call `collector.getStructuredLogs()`, `collector.getLogsByLevel("error")`, or `collector.getLogsBySource("ComponentName")`
- **Use `page.evaluate()`** to interact with plugin internals — access via `(window as any).app?.plugins?.plugins?.["notor"]`
- **Use `TestConfig.setupVault`** callback for creating test fixture files before Obsidian launches
- **Use `TestConfig.cleanupFiles`** array for vault-relative paths to delete during teardown
- **Fail hard on expected functionality** — if a feature should work, use `ctx.fail()` when it doesn't, not `ctx.pass()` with a "skipped" message
- **Filter expected errors in "no unexpected errors" tests** — e.g., exclude known connection-refused errors when testing against unreachable URLs
- **Use separate `async function testXxx(ctx)` functions** for each logical test scenario
- **Pre-configure state in initial settings** when the plugin needs it at render time (e.g., MCP servers must be in settings before load for the status indicator to render)
- **Use `ensureCleanState(page)`** at the start of tests that require a ready chat input — especially when earlier tests may leave a streaming response or pending tool call in flight. This aborts any in-progress response and waits for the input to re-enable

### DO NOT:
- **Never duplicate shared boilerplate** — no inline path constants, result tracking, screenshot helpers, pass/fail functions, findVaultPage, build/launch/connect/teardown, data.json backup/restore, or results printing
- **Never define local `buildSettings()`** — use `buildDefaultSettings(overrides)` from test-helpers
- **Never read `window.__notorStructuredLogs`** — this property doesn't exist; use `ctx.collector` instead
- **Never use `ctx.pass()` for expected-but-missing elements** — this creates tests that can never fail. Use `ctx.fail()` when something expected is absent
- **Never use `keyboard.type()` for chat input** — it dispatches Enter keydown events for `\n` characters, triggering the plugin's send handler. Use `sendMessage()` from test-helpers or set `el.textContent` via `page.evaluate()` + dispatch an input event
- **Never hard-code paths** like `/Volumes/...` — use the constants from test-helpers (`VAULT_PATH`, `PLUGIN_DATA_PATH`, etc.)
- **Never await `connectMcpServer()` fire-and-forget calls** — MCP connection is async; use polling (`pollUntil`) to wait for status changes
- **Never open settings with `Meta+,` + clicking the "Notor" nav item** — the hotkey lands on the About tab; use `openPluginSettings(page)`
- **Never write a local `openNotorSettings` / `closeSettings` / `expandSettingsGroup`** — import them from test-helpers
- **Never declare nested functions inside a typed `page.evaluate` callback** — esbuild rewrites them to an undefined `__name` helper (see below)
- **Never scope settings queries to `app.setting.tabContentContainer`, or hunt for a settings popout page** — the harness disables the popout, so `document` queries and `ctx.screenshot()` work directly

### CSS Selector Reference (common plugin elements):
- Chat container: `.notor-chat-container`
- Chat input: `.notor-text-input` (contenteditable div)
- Send button: `.notor-send-btn`
- Assistant messages: `.notor-message-assistant`
- Tool call cards: `.notor-tool-call`
- Tool name in card: `.notor-tool-call-header`, `.notor-tool-name`
- Mode toggle: `.notor-mode-toggle`
- New conversation: `.notor-chat-header-btn[aria-label='New conversation']`
- Settings gear: `.notor-chat-header-btn[aria-label='Chat settings']`
- MCP status button: `.notor-mcp-status-btn` (aria-label: `"MCP servers"`)
- MCP popover: `.notor-mcp-popover`
- MCP server row: `.notor-mcp-popover-row`
- MCP status dot: `.notor-mcp-popover-dot`
- Approve button: `.notor-approve-btn`
- Settings popover: `.notor-settings-popover`

### Interacting with Obsidian settings

Obsidian 1.12 reworked the settings modal. The rules below are verified against the
installed build — do not reinvent them, and do not copy pre-1.12 patterns from old
test scripts.

**The popout window is the big one.** By default Obsidian mounts the settings modal
into a *separate OS window* (`about:blank`) that has **no `window.app` of its own** —
the vault page owns the app object while the popout owns the DOM. In that state
`document.querySelector(".setting-item")` finds nothing, `page.click()` on a settings
selector times out, and `ctx.screenshot()` only ever captures the chat view.

`runTest()` already calls `disableSettingsPopout(vaultPath)`, which writes
`settingsPopoutWindow: false` into the vault's `.obsidian/app.json` before launch.
That restores inline rendering, so **plain `document` queries, `page.click()`, and
`ctx.screenshot()` all work normally.** You get this for free — just don't fight it:

- **Do** use the shared helpers (`openPluginSettings`, `expandSettingsGroup`, …).
- **Do not** re-implement a "find the settings popout page" helper, screenshot a
  second page, or scope queries to `app.setting.tabContentContainer`. Those are
  workarounds for the popout and are now dead weight.
- If a test writes `.obsidian/app.json` itself in `setupVault`, preserve the
  `settingsPopoutWindow: false` key (the harness re-applies it after `setupVault`,
  so this is normally automatic).

**Open settings via the API, not the hotkey.** `Meta+,` *does* open the modal over
CDP, but it lands on the **About** tab, not the plugin's — and clicking a
`.vertical-tab-nav-item` by its visible label ("Notor") is brittle. Use:

```ts
const opened = await openPluginSettings(page);        // drives app.setting.openTabById("notor")
if (!opened) { ctx.fail("Open settings", "app.setting API unavailable"); return; }
```

**Scope every settings query.** Obsidian's left-sidebar search pane renders three
`.setting-item` rows of its own ("Collapse results", "Show more context", "Explain
search terms"), so a bare `document.querySelectorAll(".setting-item")` over-counts.
Scope to `SETTINGS_CONTENT_SELECTOR` (`.modal.mod-settings .vertical-tab-content`):

```ts
const rows = await page.evaluate((scopeSelector: string) => {
    const scope = document.querySelector(scopeSelector) ?? document.body;
    return scope.querySelectorAll(".setting-item").length;
}, SETTINGS_CONTENT_SELECTOR);
```

**Expand groups by attribute, and set `open` rather than clicking.** Notor's groups
are `<details class="notor-settings-group" data-notor-group="Tools">`. Clicking the
summary *toggles*, so it collapses an already-open group; set the attribute instead.
`expandSettingsGroup()` does this (attribute first, summary text as fallback).
Subsection headings carry `data-notor-subsection="<name>"` and double as the
`notor-settings://` deep-link targets — `scrollToSettingsSubsection()` scrolls to one.

**Current settings DOM facts (verified, not guessed):**
- Modal root: `.modal.mod-settings.mod-sidebar-layout` inside `.modal-container`
- Active tab content: `.vertical-tab-content` in `.vertical-tab-content-container`
- Extra row buttons: **`.extra-setting-button`** (also carries `.clickable-icon`).
  The pre-1.12 `.setting-editor-extra-setting-button` matches **nothing** today.
- Tool row buttons are identified by `aria-label`: `"Open tool definition"`,
  `"Configure tool settings"`; toggles by `"Enabled"` / `"Auto-approve"`
- Non-configurable tools render `.extra-setting-button.notor-tool-icon-placeholder`
- Toggles are `.checkbox-container` labels — `.click()` them, don't set `.checked`
- Both `Escape` and `app.setting.close()` close the modal; `closeSettings()` uses the API
- Top-level groups today: General, Providers, Models, Conversation, Personas,
  Sub-agents, Memory, Templates, Orchestration, Rules and workflows, Tools,
  MCP servers, Automation, Storage, Reference

**Per-tool settings live in a modal, not the settings tab.** Click the row's
`"Configure tool settings"` gear, then scope queries to `.modal:not(.mod-settings)`
so the ~190 setting rows in the tab underneath don't leak into your assertions.

### `page.evaluate` and the `__name` trap

tsx compiles the e2e scripts with esbuild, which rewrites **nested function
declarations inside a typed callback** to reference an esbuild `__name` helper that
does not exist in the page. The call then throws `ReferenceError: __name is not
defined` at runtime — not at compile time.

```ts
// ✗ THROWS: nested arrow fn inside a typed evaluate callback
await page.evaluate((sel: string) => {
    const norm = (el: Element | null) => el?.textContent?.trim() ?? "";  // → __name
    return norm(document.querySelector(sel));
}, selector);

// ✓ OK: no nested function declarations
await page.evaluate((sel: string) => {
    const el = document.querySelector(sel);
    return el?.textContent?.trim() ?? "";
}, selector);

// ✓ OK: inline array callbacks (.map/.filter/.find) are fine
await page.evaluate((sel: string) => {
    const scope = document.querySelector(sel);
    return Array.from(scope?.querySelectorAll(".setting-item-name") ?? [])
        .map((n) => n.textContent?.trim() ?? "");
}, selector);

// ✓ OK: template-string form — immune to the transform, nested fns allowed
await page.evaluate(`(() => {
    const norm = (el) => (el && el.textContent ? el.textContent : "").trim();
    return norm(document.querySelector(${JSON.stringify(selector)}));
})()`);
```

Rule of thumb: prefer typed callbacks with no nested `function`/arrow *declarations*;
switch to the template-string form when you genuinely need local helpers.

### Deferred views: `.notor-chat-container` never mounts

Obsidian defers view rendering. If a stale `workspace.json` leaves the chat leaf
inactive, the view never mounts, `findVaultPage()` times out, and the run reports
`Passed: 0/0` with a `Fatal error` instead of a real failure.

`runTest()` handles this: it calls `writeCleanWorkspace()` before every run, *before*
`setupVault`, so a test that writes its own layout still wins. Pass
`skipCleanWorkspace: true` only when a test deliberately asserts on a restored
multi-panel layout.

### Plugin internal access patterns:
```ts
// Get the plugin instance
const plugin = (window as any).app?.plugins?.plugins?.["notor"];

// Access settings
plugin.settings.some_setting

// Access McpHub
plugin._mcpHub  // private — cast needed in TS but accessible in page.evaluate

// McpHub methods
plugin._mcpHub.getConnection(serverName)      // → McpConnection | undefined
plugin._mcpHub.getAllConnections()             // → McpConnection[]
plugin._mcpHub.connectServer(serverName)       // → Promise<void>
plugin._mcpHub.disconnectServer(serverName)    // → Promise<void>

// McpConnection shape
{ serverName: string, status: "disconnected"|"connecting"|"connected"|"error", error: string|null, ... }
```

---

## Step 4: Run and verify

After writing the script, run it:

```bash
npx tsx e2e/scripts/{script-name}.ts
```

Review the output:
- All tests should show `PASS` or meaningful `FAIL` (no silent skips)
- Results JSON is written to `e2e/results/{test-name}-results.json`
- Screenshots are in `e2e/results/screenshots/{test-name}/`

If tests fail, diagnose using:
- The console output and error messages
- Screenshots at the failure point
- `e2e/results/logs/latest-summary.json` for structured plugin logs
- The plugin source under `src/` to verify the actual API surface and CSS class names

---

## Step 5: Review for common mistakes

Before considering the script complete, verify:

1. **No soft-pass on expected functionality** — every `ctx.pass("...skipped...")` or `ctx.pass("...not found...")` for a feature that should exist is a bug in the test
2. **Selectors match actual DOM** — check the plugin source (`src/ui/`, `src/settings/`) for the real CSS class names; don't guess
3. **Timing is correct** — features that render at plugin load need config in initial settings, not injected after load
4. **Log access uses collector** — `ctx.collector.getStructuredLogs()`, not window properties
5. **No boilerplate duplication** — diff against the shared modules to confirm nothing is reinvented
6. **Settings tests use the shared helpers** — `openPluginSettings` / `expandSettingsGroup` / `closeSettings`, queries scoped to `SETTINGS_CONTENT_SELECTOR`, no `Meta+,`, no popout hunting
7. **No nested function declarations in typed `page.evaluate` callbacks** — they throw `__name is not defined` at runtime, and a passing typecheck will not catch it
8. **`0/0` results mean a fatal error, not success** — the run died before any assertion; check for the `findVaultPage` timeout and add `writeCleanWorkspace`

### Verifying an Obsidian API assumption

When behavior depends on Obsidian internals (rather than plugin code), don't guess and
don't trust a comment in an existing test — comments go stale when Obsidian updates.
Write a throwaway diagnostic script that dumps the real shape, run it, then encode what
it proves:

```ts
// Dump the live object instead of assuming its shape.
const shape = await page.evaluate(`(() => {
    const s = window.app.setting;
    const keys = [];
    for (const k in s) keys.push(k + ": " + typeof s[k]);
    return { keys: keys.sort(), activeTab: s.activeTab ? s.activeTab.id : null };
})()`);
console.log(JSON.stringify(shape, null, 2));
```

Useful probes: enumerate keys with `for...in`; `String(someFn)` to read a function's
source (this is how `shouldUsePopout`'s `settingsPopoutWindow` config flag was found);
compare `el.ownerDocument === document` to detect cross-window DOM; and walk
`parentElement` to capture a real ancestor chain for selector work. Delete the
diagnostic once its findings are captured in the test or in this document.
