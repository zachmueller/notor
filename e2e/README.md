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

## Troubleshooting

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