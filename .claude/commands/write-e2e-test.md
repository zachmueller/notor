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
- **LLM helpers:** `sendMessage(page, message)`, `sendMessageWithApprovalHandling(page, message)`, `waitForResponse(page)`, `getLastAssistantMessage(page)`, `getLastToolCallNames(page)`
- **UI helpers:** `newConversation(page)`, `setMode(page, "Plan" | "Act")`, `selectPersona(page, name | null)`

Key exports from `test-harness.ts`:
- **`runTest(config, testFn)`** — the only entry point; handles everything from build to teardown
- **`TestContext`** — passed to your test function, provides: `page`, `browser`, `obsidian`, `collector`, `results`, `vaultPath`, `screenshotsDir`, `pass()`, `fail()`, `screenshot()`
- **`TestConfig`** — `{ name, settings?, skipBuild?, setupVault?, cleanupFiles?, vaultResetOptions?, cdpPort?, launchTimeout? }`

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

### DO NOT:
- **Never duplicate shared boilerplate** — no inline path constants, result tracking, screenshot helpers, pass/fail functions, findVaultPage, build/launch/connect/teardown, data.json backup/restore, or results printing
- **Never define local `buildSettings()`** — use `buildDefaultSettings(overrides)` from test-helpers
- **Never read `window.__notorStructuredLogs`** — this property doesn't exist; use `ctx.collector` instead
- **Never use `ctx.pass()` for expected-but-missing elements** — this creates tests that can never fail. Use `ctx.fail()` when something expected is absent
- **Never use `keyboard.type()` for chat input** — it dispatches Enter keydown events for `\n` characters, triggering the plugin's send handler. Use `sendMessage()` from test-helpers or set `el.textContent` via `page.evaluate()` + dispatch an input event
- **Never hard-code paths** like `/Volumes/...` — use the constants from test-helpers (`VAULT_PATH`, `PLUGIN_DATA_PATH`, etc.)
- **Never await `connectMcpServer()` fire-and-forget calls** — MCP connection is async; use polling (`pollUntil`) to wait for status changes

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
2. **Selectors match actual DOM** — check the plugin source (`src/ui/`) for the real CSS class names; don't guess
3. **Timing is correct** — features that render at plugin load need config in initial settings, not injected after load
4. **Log access uses collector** — `ctx.collector.getStructuredLogs()`, not window properties
5. **No boilerplate duplication** — diff against the shared modules to confirm nothing is reinvented
