# E2E Testing: Obsidian + Playwright + Cline

This directory contains the infrastructure for running the Notor Obsidian plugin inside the real Obsidian app, capturing structured logs via Playwright, and feeding those logs back to Cline for autonomous iterative debugging.

## Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│                    Cline (in VS Code)                    │
│                                                         │
│  1. Edits plugin source code                            │
│  2. Runs: npm run e2e:run                               │
│  3. Reads: e2e/results/logs/latest-summary.json         │
│  4. Analyzes errors → goes back to step 1               │
└────────────┬───────────────────────────────┬────────────┘
             │ execute_command               │ read_file
             ▼                               ▼
┌────────────────────────┐    ┌──────────────────────────┐
│   run-and-collect.ts   │    │  latest-summary.json     │
│                        │    │  (structured log output)  │
│  • Builds plugin       │    │                          │
│  • Launches Obsidian   │    │  {                       │
│    with --remote-      │    │    stats: {...},          │
│    debugging-port      │    │    recentErrors: [...],   │
│  • Connects Playwright │    │    lastEntries: [...]     │
│    via CDP             │    │  }                       │
│  • Captures console    │    └──────────────────────────┘
│    logs for N seconds  │
│  • Writes summary      │
│  • Shuts down Obsidian │
└────────┬───────────────┘
         │ CDP (Chrome DevTools Protocol)
         ▼
┌────────────────────────┐
│   Obsidian (Electron)  │
│                        │
│  • Loads test vault    │
│  • Plugin emits        │
│    structured JSON     │
│    via console.log     │
│  • [NOTOR_LOG] prefix  │
│    identifies plugin   │
│    log entries         │
└────────────────────────┘
```

## How it works

### 1. Structured logging in the plugin

The plugin uses a structured logger (`src/utils/logger.ts`) that emits JSON-formatted log entries via `console.log` with a `[NOTOR_LOG]` prefix:

```ts
import { logger } from "./utils/logger";
const log = logger("MyComponent");

log.info("Something happened", { key: "value" });
// Output: [NOTOR_LOG] {"timestamp":"...","level":"info","source":"MyComponent","message":"Something happened","data":{"key":"value"}}
```

### 2. Obsidian launches with CDP

Obsidian is an Electron app (Chromium-based). Launching it with `--remote-debugging-port=9222` exposes a Chrome DevTools Protocol endpoint that Playwright can connect to.

**Vault isolation**: The launcher temporarily modifies Obsidian's global config (`obsidian.json`) so that *only* the test vault is marked as open. This prevents your personal/main vault from opening during E2E runs. The original config is backed up before launch and automatically restored after shutdown — even if the process crashes.

### 3. Playwright captures logs

Playwright connects to the running Obsidian via `chromium.connectOverCDP()`, attaches to the page's console events, and filters for `[NOTOR_LOG]` entries. These are parsed and written to JSONL files.

### 4. Log summary for Cline

After capture, a `latest-summary.json` file is written containing:
- **Stats**: total entries, error/warning counts, unique sources
- **Recent errors**: last 20 error-level entries with full data
- **Recent warnings**: last 10 warning-level entries
- **Last entries**: last 30 log entries of any level

Cline reads this file with `read_file` and uses the structured information to understand what went wrong and how to fix it.

## Prerequisites

1. **Obsidian** installed at the default location:
   - macOS: `/Applications/Obsidian.app`
   - Windows: `%LOCALAPPDATA%\Obsidian\Obsidian.exe`
   - Linux: on `$PATH` or set `OBSIDIAN_PATH` env var

2. **Node.js** 18+ and **npm**

3. **Dependencies installed**:
   ```bash
   npm install
   ```

## Quick start

### One-time setup

```bash
# Install dependencies (includes Playwright, tsx, etc.)
npm install

# Build the plugin
npm run build

# Set up the test vault (creates e2e/test-vault/ with plugin symlinked in)
npm run e2e:setup-vault
```

### Run the debug cycle

```bash
# Build + launch Obsidian + capture logs for 15 seconds + write summary
npm run e2e:run

# Quick 10-second capture
npm run e2e:run:quick

# Custom duration
npm run e2e:run -- --duration 30

# Skip rebuild (if you just want to re-capture)
npm run e2e:run -- --skip-build

# Use your own vault instead of the test vault
npm run e2e:run -- --vault /path/to/your/vault
```

### Run Playwright tests

```bash
# Run the full test suite
npm run e2e
```

## Cline integration workflow

The intended workflow for Cline to autonomously debug the plugin:

### Step 1: Make code changes
Cline edits the plugin source files in `src/`.

### Step 2: Run and capture
```
execute_command: npm run e2e:run
```
This builds the plugin, launches Obsidian, captures logs, and writes the summary.

### Step 3: Read the results
```
read_file: e2e/results/logs/latest-summary.json
```
Cline reads the structured summary to see:
- Did the plugin load without errors?
- What warnings/errors occurred?
- What was the plugin's behavior?

### Step 4: Analyze and iterate
Based on the summary, Cline can:
- Fix errors in source code
- Add more logging to investigate issues
- Run again to verify fixes

### Example Cline prompt for autonomous debugging

> Build and test the plugin in Obsidian. Run `npm run e2e:run` to launch Obsidian and capture plugin logs, then read `e2e/results/logs/latest-summary.json` to check for errors. If there are errors, fix the source code and re-run until the plugin loads cleanly.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OBSIDIAN_PATH` | Auto-detected | Path to Obsidian executable |
| `E2E_VAULT_PATH` | `e2e/test-vault` | Path to the test vault |
| `CDP_PORT` | `9222` | Chrome DevTools Protocol port |

## File structure

```
e2e/
├── README.md                  # This file
├── playwright.config.ts       # Playwright test configuration
├── tsconfig.json             # TypeScript config for e2e code
├── run-and-collect.ts        # Standalone debug runner (Cline's main entry point)
├── lib/
│   ├── obsidian-launcher.ts  # Launch Obsidian with CDP debugging
│   ├── obsidian-fixture.ts   # Playwright test fixtures
│   └── log-collector.ts      # Console log capture and JSONL output
├── scripts/
│   └── setup-vault.ts        # Test vault setup/configuration
├── tests/
│   └── plugin-loads.spec.ts  # Smoke test: plugin loads without errors
├── results/                   # (gitignored) Output artifacts
│   ├── logs/
│   │   ├── latest-summary.json        # ← Cline reads this
│   │   ├── plugin-logs-*.jsonl        # Structured plugin logs
│   │   └── console-all-*.jsonl        # All console output
│   └── screenshots/
│       ├── obsidian-startup.png
│       └── obsidian-after-capture.png
└── test-vault/                # (gitignored) Ephemeral test vault
    ├── .obsidian/
    │   ├── plugins/notor → ../../../build  (symlink to build/)
    │   └── community-plugins.json
    └── Test Note.md
```

## Interacting with Obsidian settings

Obsidian 1.12 reworked the settings modal. `runTest()` and `e2e/lib/test-helpers.ts`
absorb the differences, so tests should use the shared helpers rather than driving
`app.setting` by hand.

### The settings popout window

By default Obsidian 1.12+ mounts the settings modal into a **separate OS window**
(`about:blank`) that has **no `window.app` of its own** — the vault page owns the app
object while the popout owns the DOM. In that state:

- `document.querySelector(".setting-item")` on the vault page finds nothing
- `page.click()` against a settings selector times out
- `ctx.screenshot()` only ever captures the chat view

The popout is gated on a vault config flag:

```js
shouldUsePopout() { return canPopoutWindow && this.app.vault.getConfig("settingsPopoutWindow") }
```

`runTest()` calls `disableSettingsPopout(vaultPath)`, which writes
`settingsPopoutWindow: false` into the vault's `.obsidian/app.json` **before launch**
(and **after** `setupVault`, so a fixture that rewrites `app.json` can't clobber it).
That restores the pre-1.12 layout: the modal renders into the vault page's own
document, so plain `document` queries, `page.click()`, and `ctx.screenshot()` all work.

`openPluginSettings()` also calls `app.vault.setConfig("settingsPopoutWindow", false)`
at runtime as a belt-and-braces fallback.

### Helpers

| Helper | Purpose |
|--------|---------|
| `openPluginSettings(page, tabId = "notor")` | Open settings on a plugin tab via `app.setting.openTabById`; returns `false` if the API or tab is unavailable |
| `closeSettings(page)` | Close the modal via `app.setting.close()` |
| `expandSettingsGroup(page, title)` | Force a `<details data-notor-group>` group open (sets `open`; a click would *toggle*) |
| `scrollToSettingsSubsection(page, name)` | Scroll a `[data-notor-subsection]` heading into view |
| `SETTINGS_CONTENT_SELECTOR` | `.modal.mod-settings .vertical-tab-content` — scope for all settings queries |
| `disableSettingsPopout(vaultPath)` | Write the `settingsPopoutWindow: false` flag (called by `runTest`) |

### Rules

- **Open via the API, not `Meta+,`.** The hotkey *does* work over CDP, but it lands on
  the **About** tab — and matching a `.vertical-tab-nav-item` by its visible label
  ("Notor") is brittle.
- **Scope every query to `SETTINGS_CONTENT_SELECTOR`.** Obsidian's left-sidebar search
  pane renders three `.setting-item` rows of its own ("Collapse results", "Show more
  context", "Explain search terms"), so a bare `.setting-item` query over-counts.
- **Per-tool settings live in their own modal.** Click a tool row's
  `"Configure tool settings"` gear, then scope to `.modal:not(.mod-settings)` so the
  ~190 rows in the tab underneath don't leak into assertions.

### Current settings DOM

- Modal root: `.modal.mod-settings.mod-sidebar-layout` inside `.modal-container`
- Active tab content: `.vertical-tab-content` in `.vertical-tab-content-container`
- Extra row buttons: **`.extra-setting-button`** (plus `.clickable-icon`). The pre-1.12
  `.setting-editor-extra-setting-button` matches **nothing** today.
- Tool row buttons by `aria-label`: `"Open tool definition"`, `"Configure tool settings"`;
  toggles by `"Enabled"` / `"Auto-approve"`
- Non-configurable tools render `.extra-setting-button.notor-tool-icon-placeholder`
- Toggles are `.checkbox-container` labels — `.click()` them, don't set `.checked`
- Both `Escape` and `app.setting.close()` close the modal

### The `__name` trap in `page.evaluate`

tsx compiles e2e scripts with esbuild, which rewrites **nested function declarations
inside a typed callback** to reference an esbuild `__name` helper that doesn't exist in
the page. The call throws `ReferenceError: __name is not defined` **at runtime** — a
passing typecheck won't catch it.

```ts
// ✗ throws — nested arrow declaration
await page.evaluate((sel: string) => {
    const norm = (el: Element | null) => el?.textContent?.trim() ?? "";
    return norm(document.querySelector(sel));
}, sel);

// ✓ fine — inline .map/.filter/.find callbacks are not affected
await page.evaluate((sel: string) =>
    Array.from(document.querySelectorAll(sel)).map((n) => n.textContent?.trim() ?? ""), sel);

// ✓ fine — template-string form is immune; nested fns allowed
await page.evaluate(`(() => {
    const norm = (el) => (el && el.textContent ? el.textContent : "").trim();
    return norm(document.querySelector(${JSON.stringify(sel)}));
})()`);
```

## Troubleshooting

### A test reports `Passed: 0/0`
The run hit a fatal error before any assertion ran — look for `Fatal error:` in the
output. The most common cause is
`Could not find vault page with .notor-chat-container within timeout`: Obsidian defers
view rendering, so a stale `workspace.json` that leaves the chat leaf inactive means the
view never mounts.

`runTest()` now calls `writeCleanWorkspace()` before every run (before `setupVault`, so
a test can still write its own layout), which prevents this. Tests that deliberately
assert on a restored multi-panel layout can opt out with `skipCleanWorkspace: true`.

### Obsidian doesn't launch
- Verify Obsidian is installed at the expected path
- Set `OBSIDIAN_PATH` explicitly: `OBSIDIAN_PATH=/path/to/obsidian npm run e2e:run`
- Check that no other Obsidian instance is using the same CDP port

### CDP connection fails
- Ensure port 9222 (or your custom port) isn't in use: `lsof -i :9222`
- Close any existing Obsidian instances first
- Increase timeout: `npm run e2e:run -- --duration 30`

### Plugin doesn't load
- Run `npm run build` first to generate `main.js`
- Run `npm run e2e:setup-vault` to verify the symlink
- Check `e2e/results/logs/console-all-*.jsonl` for Obsidian-level errors

### No structured logs captured
- Verify the plugin uses the `logger` utility from `src/utils/logger.ts`
- Check that the `[NOTOR_LOG]` prefix is present in raw console output
- Look at `e2e/results/logs/console-all-*.jsonl` for unstructured output

### macOS: Obsidian asks to be moved to Applications
- This is normal for first launch. Accept the dialog or move Obsidian to `/Applications` manually.

### Vault shows "Trust author" dialog
- On first launch with a new vault, Obsidian may show a trust dialog. This needs to be accepted manually the first time. After that, subsequent launches will work automatically.