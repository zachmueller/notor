# E2E Script Migration Plan: Adopt Shared Test Harness

## Context

The project has 35 e2e test scripts (`e2e/scripts/*.ts`) totaling ~32,800 lines. Three shared modules were recently introduced to eliminate boilerplate:

| Module | Purpose |
|--------|---------|
| `e2e/lib/test-harness.ts` | `runTest(config, testFn)` orchestrates the full lifecycle: build, vault reset, data.json backup/inject, Obsidian launch, CDP connect, page discovery, log collection, teardown, results summary |
| `e2e/lib/test-helpers.ts` | Shared constants (`PROJECT_ROOT`, `VAULT_PATH`, etc.), element helpers (`waitForSelector`), LLM interaction helpers (`sendMessage`, `waitForResponse`, `sendMessageWithApprovalHandling`, `getLastAssistantMessage`, `getLastToolCallNames`), UI action helpers (`newConversation`, `setMode`, `selectPersona`), and `buildDefaultSettings()` |
| `e2e/lib/vault-reset.ts` | `resetVault()` — deletes known test artifacts while preserving base fixtures |

**Only 3 scripts were initially migrated**; 22 more have since been migrated:
- `interaction-test.ts` (490 lines)
- `tool-config-inspector-test.ts` (552 lines)
- `tool-config-settings-ui-test.ts` (580 lines)

The remaining **5 scripts** (excluding `setup-vault.ts` which is a utility, not a test) all duplicate the same boilerplate inline.

---

## What "Migrated" Looks Like

A migrated script:
1. Imports `runTest` and `TestContext` from `../lib/test-harness`
2. Imports helpers from `../lib/test-helpers` as needed
3. Uses `buildDefaultSettings(overrides)` instead of a local `buildSettings()` function
4. Defines a single `async function tests(ctx: TestContext)` with only test logic
5. Calls `runTest({ name, settings, setupVault, cleanupFiles }, tests)` at the bottom
6. Has **no** inline: path constants, result tracking, screenshot helpers, `pass()`/`fail()`, `waitForResponse()`, `sendMessage()`, `findVaultPage()`, `selectPersona()`, build/launch/connect/teardown, data.json backup/restore, or results printing

**Expected line reduction per script:** 100-250 lines of boilerplate removed.

---

## Migration Inventory

### Already Migrated (32 scripts)

| Script | Lines | Notes |
|--------|-------|-------|
| `interaction-test.ts` | 490 | Uses `runTest`, `waitForSelector` from helpers |
| `tool-config-inspector-test.ts` | 552 | Uses `runTest`, `waitForSelector`, `VAULT_PATH` |
| `tool-config-settings-ui-test.ts` | 580 | Uses `runTest`, `waitForSelector`, `VAULT_PATH` |
| `llm-interaction-test.ts` | 587→398 | Phase 1. Uses `runTest`, `buildDefaultSettings` with custom providers (no model_id for live list selection) |
| `plan-mode-enforcement-test.ts` | 900→599 | Phase 1. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Imports `sendMessage`, `setMode`, `newConversation` from helpers |
| `chat-scroll-test.ts` | 736→526 | Phase 1. Uses `runTest`, `buildDefaultSettings`. Retains local scroll helpers (`sendMessageNoWait`, `waitForStreamingStart`, `getScrollState`, etc.) |
| `compaction-test.ts` | 376→219 | Phase 1. Uses `runTest`, `buildDefaultSettings({ compaction_threshold: 0.3 })`. Retains local `findCompactionRecord` |
| `compaction-debug-test.ts` | 621→541 | Phase 1 — partial. Multi-session lifecycle incompatible with `runTest`; imported shared constants, `findVaultPage`, `buildDefaultSettings` only |
| `auto-approve-test.ts` | 422→261 | Phase 1. Uses `runTest`, `buildDefaultSettings`, `setupVault` for persona fixtures |
| `persona-test.ts` | 922→806 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault` for persona fixtures, `cleanupFiles`. Retains local `ensureTestPersonas` |
| `tool-interaction-test.ts` | 1277→892 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Imports `sendMessage`, `getLastAssistantMessage`, `getLastToolCallNames`, `newConversation`, `setMode`. Retains local `getLastError`, `VAULT_NOTES` |
| `diff-approval-test.ts` | 915→606 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `waitForApprovalUI`, `sendMessageNoWait`, `getLastError`. Mid-test settings change via `PLUGIN_DATA_PATH` |
| `stale-content-test.ts` | 721→554 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `scanHistoryFiles`, `parseHistoryFile`, `HISTORY_PATH` |
| `include-note-test.ts` | 811→664 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local log helpers (`getResolverLogs`, `findLogWithData`, etc.), `dumpRelevantLogs`. Imports `LogCollector`/`LogEntry` from log-collector |
| `attachment-test.ts` | 422→253 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `getLatestUserMessage`, `HISTORY_DIR` |
| `fetch-webpage-test.ts` | 840→546 | Phase 2. Uses `runTest`, `buildDefaultSettings`. Retains local `getLastFetchWebpageResult`, `injectSettings` for mid-test settings+reload. No vault fixtures. |
| `abort-and-error-test.ts` | 846→557 | Phase 2. Uses `runTest`, `buildDefaultSettings`. Imports `setMode`, `newConversation`, `getLastAssistantMessage` from helpers. Retains local `waitForInputEnabled`, `waitForStopButton`, `sendMessageNoWait`, `sendMessage`, `getCurrentMode`. Multi-phase: Bedrock abort tests → UI provider switch → error tests. |
| `activity-indicator-test.ts` | 1613→1312 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `safeRun` (error-catching wrapper), `dismissNotices`, structured log helpers, background workflow helpers. Mid-test settings change via `PLUGIN_DATA_PATH`. |
| `execute-command-test.ts` | 329→188 | Phase 2. Uses `runTest`, `buildDefaultSettings`. Mid-test settings change via `PLUGIN_DATA_PATH` for timeout and output cap tests. Imports `sendMessage`, `newConversation`, `setMode` from helpers. |
| `tool-config-auto-approve-test.ts` | 1075→619 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local approval-rejection polling loop in Test 2. Imports `sendMessage`, `selectPersona`, `getLastAssistantMessage`, `getLastToolCallNames`, `waitForResponse`, `newConversation`, `setMode` from helpers. |
| `tool-config-disabled-tool-test.ts` | 1002→559 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Uses `sendMessageWithApprovalHandling` from helpers for Test 10. Imports `sendMessage`, `selectPersona`, `getLastAssistantMessage`, `getLastToolCallNames`, `newConversation`, `setMode` from helpers. |
| `tool-config-parse-strip-test.ts` | 643→486 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `sendMessageNoWait` (differs from shared `sendMessage`), `dismissNotices`. Imports `selectPersona`, `waitForSelector` from helpers. |
| `tool-config-path-enforce-test.ts` | 1255→868 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `executeWorkflow`. Imports `sendMessage`, `sendMessageWithApprovalHandling`, `selectPersona`, `getLastAssistantMessage`, `getLastToolCallNames`, `newConversation`, `setMode`, `waitForResponse` from helpers. |
| `tool-config-precedence-test.ts` | 1263→850 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `executeWorkflow`. Imports `sendMessage`, `waitForResponse`, `selectPersona`, `getLastAssistantMessage`, `getLastToolCallNames`, `newConversation`, `setMode` from helpers. |
| `mcp-auto-approve-test.ts` | 569→409 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `injectSimulatedMcpServer`, `resolveAutoApprove`, and all test functions. Imports `waitForSelector` from helpers. |
| `auto-context-test.ts` | 2543→2282 | Phase 2. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local JSONL history helpers, system prompt log helpers, note-tab helpers (openNoteInNewTab, activateNote, etc.), parsing helpers. Mid-test settings changes via `PLUGIN_DATA_PATH`. |
| `hook-execution-test.ts` | 770→573 | Phase 3. Uses `runTest`, `buildDefaultSettings`, `cleanupFiles`. Retains local `sendMessageLocal` (uses `el.textContent` assignment), `buildHookSettings`, JSONL history helpers (`getLatestUserMessage`, `getAllMessages`). Mid-test settings changes via `PLUGIN_DATA_PATH`. |
| `vault-event-hooks-test.ts` | 1968→1695 | Phase 3. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `buildVaultEventSettings`, `emptyVaultEventHooks`, `openNotorSettings`, `readHookFireCount`, `clearHookFiles`, `logsBySource`, `logsContaining`. Mid-test settings changes via `PLUGIN_DATA_PATH`. |
| `workflow-discovery-test.ts` | 806→578 | Phase 3. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `getWorkflowDiscoveryLogs`, `findLogMatching`, `findDiscoveryCompletionLog` structured log helpers. |
| `workflow-execution-test.ts` | 1751→1631 | Phase 3. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `getWorkflowExecutorLogs`, `getChatOrchestratorLogs`, `getIncludeNoteResolverLogs`, `getPersonaManagerLogs` structured log helpers and 21 test functions. |
| `workflow-hooks-test.ts` | 1547→1326 | Phase 3. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local `sendMessageLocal`, `newConversationLocal`, `clearHookFiles`, `readHookFireCount`, structured log helpers. Mid-test settings changes via `PLUGIN_DATA_PATH`. |
| `workflow-watcher-test.ts` | 722→594 | Phase 3. Uses `runTest`, `buildDefaultSettings`, `setupVault`, `cleanupFiles`. Retains local vault API helpers (`getWorkflowNames`, `vaultCreate`, `vaultDelete`, `vaultRename`, `vaultModify`), `RESCAN_WAIT_MS`. |

### Not a Test (exclude)

| Script | Lines | Notes |
|--------|-------|-------|
| `setup-vault.ts` | 208 | Vault setup utility — not a test script |

### Needs Migration (3 scripts)

#### ~~Tier 1 — Simple~~ ✅ COMPLETE

All 6 Tier 1 scripts migrated. Total lines removed: **1,098** (3,642→2,544).

#### Tier 2 — Medium (custom vault fixtures or approval handling)

These need `setupVault` callback and/or use `sendMessageWithApprovalHandling`. May need `cleanupFiles`.

| Script | Lines | Key Notes |
|--------|-------|-----------|
| ~~`fetch-webpage-test.ts`~~ | ~~840~~ | ✅ Migrated. |
| ~~`abort-and-error-test.ts`~~ | ~~846~~ | ✅ Migrated. |
| ~~`activity-indicator-test.ts`~~ | ~~1613~~ | ✅ Migrated. |
| ~~`auto-context-test.ts`~~ | ~~2543~~ | ✅ Migrated. |
| ~~`execute-command-test.ts`~~ | ~~329~~ | ✅ Migrated. |
| ~~`tool-config-auto-approve-test.ts`~~ | ~~1075~~ | ✅ Migrated. |
| ~~`tool-config-disabled-tool-test.ts`~~ | ~~1002~~ | ✅ Migrated. |
| ~~`tool-config-parse-strip-test.ts`~~ | ~~643~~ | ✅ Migrated. |
| ~~`tool-config-path-enforce-test.ts`~~ | ~~1255~~ | ✅ Migrated. |
| ~~`tool-config-precedence-test.ts`~~ | ~~1263~~ | ✅ Migrated. |
| ~~`mcp-auto-approve-test.ts`~~ | ~~569~~ | ✅ Migrated. |

#### Tier 3 — Complex (hooks, workflows, MCP servers, or heavily custom lifecycle)

These have significant custom setup beyond vault fixtures (external processes, file watchers, hooks).

| Script | Lines | Key Notes |
|--------|-------|-----------|
| ~~`hook-execution-test.ts`~~ | ~~770~~ | ✅ Migrated. |
| ~~`vault-event-hooks-test.ts`~~ | ~~1968~~ | ✅ Migrated. |
| ~~`workflow-discovery-test.ts`~~ | ~~806~~ | ✅ Migrated. |
| ~~`workflow-execution-test.ts`~~ | ~~1751~~ | ✅ Migrated. |
| ~~`workflow-hooks-test.ts`~~ | ~~1547~~ | ✅ Migrated. |
| ~~`workflow-watcher-test.ts`~~ | ~~722~~ | ✅ Migrated. |
| `mcp-http-test.ts` | 712 | Spins up external HTTP MCP server. |
| `mcp-stdio-test.ts` | 884 | Spins up external stdio MCP server. |
| `checkpoint-test.ts` | 1190 | Reads/counts checkpoint files on disk; tests restore UI flow. Custom helpers: `countCheckpointFiles`, `readAllCheckpoints`, `openCheckpointsSection`. |

---

## Common Boilerplate to Remove

Every unmigrated script duplicates some or all of these (~100-250 lines each):

1. **Path constants** — `VAULT_PATH`, `CDP_PORT`, `RESULTS_DIR`, `SCREENSHOTS_DIR`, `LOGS_DIR`, `BUILD_DIR`, `PLUGIN_DATA_PATH` (5-10 lines)
2. **Timing constants** — `RESPONSE_TIMEOUT_MS`, `POLL_INTERVAL_MS` (2 lines)
3. **TestResult interface + results array + pass/fail functions** (15 lines)
4. **screenshot() helper** (5 lines)
5. **waitForSelector() helper** (5 lines)
6. **findVaultPage() helper** (15 lines)
7. **waitForResponse() helper** (20 lines)
8. **sendMessage() helper** (15 lines)
9. **sendMessageWithApprovalHandling() helper** (30 lines)
10. **getLastAssistantMessage() helper** (5 lines)
11. **getLastToolCallNames() helper** (10 lines)
12. **newConversation() helper** (5 lines)
13. **setMode() helper** (10 lines)
14. **selectPersona() helper** (25 lines)
15. **buildSettings() function** (20-50 lines) — replaced by `buildDefaultSettings(overrides)`
16. **main() boilerplate**: build step, data.json backup/inject, mkdir for dirs, Obsidian launch, CDP connect, page find, log collector attach, browser close, Obsidian close, data.json restore (40-60 lines)
17. **Results summary printing + JSON write** (15-20 lines)

---

## Migration Strategy

### Phase 1: Tier 1 Scripts (6 scripts, ~3,640 lines)

Straightforward mechanical migration:
1. Delete all boilerplate (items 1-17 above)
2. Replace `buildSettings()` with `buildDefaultSettings(overrides)` — only include overrides that differ from defaults
3. Wrap test logic in `async function tests(ctx: TestContext)`
4. Replace bare `pass()`/`fail()` calls with `ctx.pass()`/`ctx.fail()`
5. Replace bare `screenshot()` calls with `ctx.screenshot()`
6. Call `runTest({ name, settings }, tests)`

### Phase 2: Tier 2 Scripts (18 scripts, ~16,300 lines)

Same as Phase 1 plus:
- Move fixture creation functions into `setupVault` callback in `TestConfig`
- Add cleanup paths to `cleanupFiles` in `TestConfig`
- Import `sendMessageWithApprovalHandling`, `selectPersona`, etc. from test-helpers instead of defining locally
- For `execute-command-test.ts` (mid-test settings changes): keep the `page.reload()` approach but use `PLUGIN_DATA_PATH` from test-helpers and `buildDefaultSettings()` for the temporary overrides

### Phase 3: Tier 3 Scripts (7 scripts, ~8,580 lines)

Same as Phase 2 plus:
- Scripts with external processes (MCP servers) may need to manage those in `setupVault` or in the test function itself. The harness's signal cleanup and try/finally will still handle Obsidian lifecycle.
- Scripts with custom disk-reading helpers (checkpoint counting, etc.) keep those as local functions — only the boilerplate is removed.
- Workflow/hook tests that create files can use `setupVault` for file creation and `cleanupFiles` for teardown.

---

## Potential Enhancements to Shared Tooling

During migration, we may discover needs for small additions to the shared modules:

| Enhancement | Where | Rationale |
|-------------|-------|-----------|
| `buildDefaultSettings()` usage | All scripts | Currently 0 scripts use it; every script has a local `buildSettings()` |
| `vaultResetOptions.extraDeletePaths` | vault-reset.ts | Some scripts clean up custom files; this is already supported |
| `TestConfig.setupVault` | test-harness.ts | Already supported — just needs to be used |
| Access to `collector` on `TestContext` | test-harness.ts | Already exposed as `ctx.collector` — scripts that inspect structured logs can use it directly |

No new features appear to be needed in the shared tooling.

---

## Execution Plan

Each script migration is a single commit. Scripts within a tier can be done in any order. Suggested batching:

| Batch | Scripts | Est. Lines Removed |
|-------|---------|-------------------|
| ~~1~~ | ~~`llm-interaction-test`, `plan-mode-enforcement-test`, `chat-scroll-test`~~ | ✅ 700 |
| ~~2~~ | ~~`compaction-test`, `compaction-debug-test`, `auto-approve-test`~~ | ✅ 398 |
| ~~3~~ | ~~`persona-test`, `tool-interaction-test`, `diff-approval-test`~~ | ✅ 810 |
| ~~3b~~ | ~~`stale-content-test`~~ | ✅ 167 |
| ~~4~~ | ~~`include-note-test`, `attachment-test`, `fetch-webpage-test`~~ | ✅ 610 |
| ~~5~~ | ~~`abort-and-error-test`, `activity-indicator-test`, `execute-command-test`~~ | ✅ 731 |
| ~~6~~ | ~~`tool-config-auto-approve-test`, `tool-config-disabled-tool-test`, `tool-config-parse-strip-test`~~ | ✅ 1,056 |
| ~~7~~ | ~~`tool-config-path-enforce-test`, `tool-config-precedence-test`, `mcp-auto-approve-test`~~ | ✅ 960 |
| ~~8~~ | ~~`auto-context-test`~~ | ✅ 261 |
| ~~9~~ | ~~`hook-execution-test`, `vault-event-hooks-test`~~ | ✅ 470 |
| ~~10~~ | ~~`workflow-discovery-test`, `workflow-execution-test`, `workflow-hooks-test`, `workflow-watcher-test`~~ | ✅ 696 |
| 11 | `mcp-http-test`, `mcp-stdio-test`, `checkpoint-test` | ~500 |

**Total estimated boilerplate removal: ~5,000-6,000 lines across 31 scripts.**

---

## Validation

After each batch:
1. Run the migrated scripts to verify they still pass
2. Verify JSON results files are written correctly
3. Verify screenshots are captured to the correct directories
4. Confirm data.json is properly backed up and restored (crash recovery still works)

---

## Risks

| Risk | Mitigation |
|------|------------|
| Subtle behavioral differences in shared helpers vs. inline copies | Some scripts have slightly divergent implementations (e.g., `checkpoint-test.ts` uses `textarea.fill()` instead of `keyboard.type()`). Verify behavior matches after migration. |
| Mid-test settings changes | `execute-command-test.ts` reloads the page with new settings mid-test. This pattern is compatible with the harness (settings are written to `PLUGIN_DATA_PATH` which is available from test-helpers). |
| Scripts that attach log collector to ALL pages | `tool-config-auto-approve-test.ts` attaches to all pages, not just the vault page. The harness only attaches to the vault page. Verify log capture is sufficient. |
| External process lifecycle (MCP servers) | MCP test scripts spin up external servers. These need explicit start/stop in the test function since the harness doesn't manage them. |
