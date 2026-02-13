# Debug plugin in Obsidian

This workflow builds the Notor plugin, launches it inside the real Obsidian app, captures structured logs via Playwright + CDP, and iteratively fixes any errors found.

## Prerequisites

Before running this workflow, ensure the test vault has been set up at least once:
```bash
npm run e2e:setup-vault
```
This creates `e2e/test-vault/` with the plugin symlinked to `build/`.

## Step 1: Build and capture logs

Run the E2E debug runner. This will:
- Build the plugin (`npm run build`)
- Launch Obsidian with Chrome DevTools Protocol enabled
- Connect Playwright via CDP and capture console logs for 15 seconds
- Write a structured summary and shut down Obsidian

```bash
npm run e2e:run
```

If you only need a quick smoke test (10 seconds), use:
```bash
npm run e2e:run:quick
```

If the build itself fails, stop here and fix the TypeScript/build errors before re-running.

## Step 2: Read the log summary

Read the structured summary that the runner produced:

```
e2e/results/logs/latest-summary.json
```

This JSON file contains:
- **`stats`**: total log entries, error count, warning count, list of unique source components
- **`recentErrors`**: last 20 error-level entries with full data/stack traces
- **`recentWarnings`**: last 10 warning-level entries
- **`lastEntries`**: last 30 log entries of any level (shows plugin behavior timeline)

## Step 3: Analyze the results

Evaluate the summary:

1. **If `stats.errors` is 0 and the plugin loaded successfully** (look for an info-level entry from source `"Plugin"` or `"main"` with a message like "loaded" or "onload"): The plugin is working. Report success and stop.

2. **If there are errors**: Examine each entry in `recentErrors`. Each error entry has:
   - `source`: which component emitted the error
   - `message`: human-readable description
   - `data`: may contain `stack` traces or other context
   
   Use the source and stack trace to locate the relevant source files under `src/`.

3. **If there are warnings but no errors**: Review `recentWarnings` to decide if they need fixing.

4. **If `stats.totalEntries` is 0**: The plugin may not have loaded at all. Check:
   - Was the build successful? (re-run `npm run build`)
   - Is the test vault set up? (re-run `npm run e2e:setup-vault`)
   - Read `e2e/results/logs/console-all-*.jsonl` for raw Obsidian console output that may reveal loading issues

## Step 4: Fix the source code

Based on the errors identified in Step 3, edit the relevant files under `src/`. Common fixes include:

- **Runtime errors**: Fix the code at the file/line indicated by the stack trace
- **Missing imports or APIs**: Check the Obsidian API types
- **Plugin lifecycle issues**: Review `src/main.ts` onload/onunload methods
- **Settings issues**: Review `src/settings.ts`

When adding diagnostic logging to investigate unclear issues, use the structured logger:

```ts
import { logger } from "./utils/logger";
const log = logger("ComponentName");
log.info("Descriptive message", { relevantData: value });
```

This ensures the logs are captured by the E2E runner in subsequent runs.

## Step 5: Re-run and verify

Go back to **Step 1** and run `npm run e2e:run` again. Repeat the cycle until:
- `stats.errors` is `0`
- The plugin loads and initializes without issues
- Any specific functionality you were debugging works correctly

For faster iteration when you only changed source files (no dependency changes):
```bash
npm run e2e:run
```

The runner rebuilds automatically each time. To skip the rebuild (e.g., if you just want to re-capture without code changes):
```bash
npm run e2e:run -- --skip-build
```

## Step 6: Optionally run the full test suite

Once the plugin loads cleanly, run the Playwright test suite for more thorough validation:

```bash
npm run e2e
```

This executes the tests in `e2e/tests/` (e.g., `plugin-loads.spec.ts`) which perform assertions beyond just log capture.

## Additional debugging tips

- **Screenshots** are saved at `e2e/results/screenshots/obsidian-startup.png` and `e2e/results/screenshots/obsidian-after-capture.png`. These can help identify visual issues.
- **Raw console logs** (including non-plugin output) are in `e2e/results/logs/console-all-*.jsonl` — useful when the plugin fails to load entirely.
- **Longer capture window**: Use `npm run e2e:run -- --duration 30` if the plugin needs more time to initialize or if you're debugging async behavior.
- **Custom vault**: Use `npm run e2e:run -- --vault /path/to/vault` to test against a specific vault instead of the ephemeral test vault.