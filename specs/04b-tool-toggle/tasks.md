# Task Breakdown: Phase 4b — `<notor_tool_config>` XML Tag System

**Created:** 2026-03-22
**Implementation Plan:** [plan.md](plan.md)
**Specification:** [spec.md](spec.md)
**Status:** Planning

## Task Summary

**Total Tasks:** 27
**Phases:** 6 (Setup → Foundation → Core → Integration → Quality → Polish)
**Estimated Complexity:** High
**Parallel Execution Opportunities:** 8 task groups

---

## Phase 0: Setup & Environment

### ENV-001: Create `src/tool-config/` module structure
**Description:** Create the new `src/tool-config/` directory and its type definitions file.
**Files:**
- Create `src/tool-config/types.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] `ParsedToolConfig` interface exported with fields: `source`, `sourceFile`, `documentPosition`, `tools`
- [ ] `ToolConfigEntry` interface exported with optional fields: `enabled`, `auto_approve`, `allowed_paths`, `blocked_paths`
- [ ] `EffectiveToolConfig` interface exported with `tools: Record<string, ResolvedToolConfigEntry>`
- [ ] `ResolvedToolConfigEntry` interface exported with all non-optional fields: `enabled`, `auto_approve`, `allowed_paths`, `blocked_paths`
- [ ] `PathNamespace` type (`"vault" | "filesystem"`) and `ToolPathParam` interface exported
- [ ] `ToolConfigValidationError` interface exported with fields: `sourceFile: string`, `detail: string`
- [ ] TypeScript compilation succeeds with no errors

---

## Phase 1: Foundation — Parsing & Merging Engine

### PARSE-001: Implement `<notor_tool_config>` tag extraction and parsing
**Description:** Implement the core `extractToolConfigs()` function that extracts, validates, and strips `<notor_tool_config>` blocks from source text.
**Files:**
- Create `src/tool-config/parser.ts`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [ ] Hardened regex `/^<notor_tool_config([^>]*)>([\s\S]*?)<\/notor_tool_config>/gm` used for extraction (RT-2 confirmed)
- [ ] `version` attribute parsed from opening tag; major > max supported → `console.warn` and skip block
- [ ] YAML body parsed via `parseYAML` from `obsidian`
- [ ] Explicit type guard after `parseYAML`: `null`, `undefined`, non-object, or array → error added to `errors` array + skip block
- [ ] `try/catch` around `parseYAML` for structurally invalid YAML → error added to `errors` array + skip block
- [ ] Multiple `<notor_tool_config>` blocks per file supported; merged in document order (last occurrence per field wins within a file)
- [ ] Matched blocks replaced with empty string in returned `strippedContent`
- [ ] Returns `{ strippedContent, configs: ParsedToolConfig[], errors: ToolConfigValidationError[] }` — errors are structured data (sourceFile + detail), not Notices. The parser has no Obsidian dependency; callers are responsible for surfacing errors as Notices.

### PARSE-002: Implement validation and error reporting
**Description:** Implement per-field validation logic within the parser (returning structured errors) and a separate `showToolConfigError()` Notice helper for callers.
**Files:**
- `src/tool-config/parser.ts` (validation logic within `extractToolConfigs`)
- Create `src/tool-config/notices.ts` (`showToolConfigError()` helper)
**Dependencies:** PARSE-001
**Acceptance Criteria:**
- [ ] Unrecognized top-level key (tool name not in registry) → error added to `errors` array; skip that tool entry (FR-82)
- [ ] Unrecognized field within a tool entry → error added; skip that field
- [ ] `enabled` not a boolean → error added; skip field
- [ ] `auto_approve` not a boolean → error added; skip field
- [ ] `allowed_paths` not an array of strings → error added; skip field
- [ ] `blocked_paths` not an array of strings → error added; skip field
- [ ] `allowed_paths`/`blocked_paths` specified for MCP tool → error added stating path enforcement not yet implemented for MCP; skip those fields (keep `enabled`/`auto_approve`)
- [ ] All errors returned as `ToolConfigValidationError[]` (structured data with `sourceFile` and `detail` fields) — the parser does **not** import from `obsidian` and does **not** create Notices
- [ ] `showToolConfigError(plugin, sourceFile, detail)` helper in `src/tool-config/notices.ts` creates Obsidian Notices with source file name, "right-click to jump to note" text, right-click handler (`notice.noticeEl.oncontextmenu`) navigating via `app.workspace.openLinkText()` (RT-3 confirmed), gated on `Platform.isDesktop`
- [ ] `showToolConfigError()` is reusable across all call sites that surface parser errors (SystemPromptBuilder, WorkflowExecutor)
- [ ] Callers iterate the returned `errors` array and call `showToolConfigError()` for each entry

### MERGE-001: Implement precedence merge engine
**Description:** Implement `mergeToolConfigs()` that merges multiple `ParsedToolConfig` objects into a single `EffectiveToolConfig` using defined precedence order.
**Files:**
- Create `src/tool-config/merger.ts`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [ ] Precedence order: workflow (highest) > persona > rule > global defaults
- [ ] Configs sorted by precedence level (rule=0, persona=1, workflow=2), then by `documentPosition` ascending within same source type
- [ ] Field-by-field sparse merge: last non-undefined value wins per field
- [ ] `allowed_paths` and `blocked_paths` use replace semantics (highest-priority level replaces entirely)
- [ ] Default fill for tools not mentioned: `enabled: true`, `auto_approve: globalAutoApprove[toolName] ?? false`, `allowed_paths: []`, `blocked_paths: []`
- [ ] `globalAutoApprove` map includes both built-in defaults and pre-flattened MCP server-level `autoApprove[]` entries
- [ ] `allToolNames` uses the same namespaced `server__tool` format as `globalAutoApprove` keys for MCP tools, so default fill lookups match correctly
- [ ] Returns `EffectiveToolConfig` with all fields non-optional on every tool entry

### PATH-001: Implement path constraint enforcement
**Description:** Implement `enforcePathConstraints()` and the `TOOL_PATH_PARAMS` descriptor table for dispatch-time path enforcement.
**Files:**
- Create `src/tool-config/path-enforcer.ts`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [ ] `TOOL_PATH_PARAMS` table maps all 13 built-in tools to their path parameters and namespaces (RT-1 confirmed)
- [ ] Vault-namespace tools: string prefix matching on vault-relative path
- [ ] Filesystem-namespace tools: resolve to absolute path via `resolveAndValidatePath` / `isPathWithin` from `src/utils/path-validation.ts`
- [ ] `blocked_paths` takes precedence over `allowed_paths` (path in both → blocked)
- [ ] When `allowed_paths` is empty → no allowlist restriction
- [ ] When `blocked_paths` is empty → no blocklist restriction
- [ ] `fetch_webpage` (empty params entry) → skip enforcement
- [ ] MCP tools (not in `TOOL_PATH_PARAMS`) → skip enforcement
- [ ] Returns `null` if allowed, or error message string if blocked

---

## Phase 2: Core — Dispatcher & Registry Modifications

### DISP-001: Add `setEffectiveToolConfig()` to ToolDispatcher
**Description:** Add the method and private field for storing the effective tool config on the dispatcher.
**Files:**
- Modify `src/chat/dispatcher.ts`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [ ] Private field `effectiveToolConfig: EffectiveToolConfig | null = null` added
- [ ] Public method `setEffectiveToolConfig(config: EffectiveToolConfig | null): void` added
- [ ] No changes to existing dispatch behavior when `effectiveToolConfig` is null

### DISP-002: Implement disabled-tool blocking in dispatcher
**Description:** Add the FR-83 enabled check as the first check in `dispatch()`, before mode/approve checks.
**Files:**
- Modify `src/chat/dispatcher.ts`
**Dependencies:** DISP-001
**Acceptance Criteria:**
- [ ] Enabled check runs **before** existing mode check in `dispatch()`
- [ ] If tool disabled: `toolCall.status = "error"`, `onToolCallStatusChanged` emitted, `ToolResult` returned with `success: false` and error message: `"Tool '{toolName}' is disabled and cannot be used in this context."`
- [ ] Disabled tool is never executed regardless of auto-approve or any other state
- [ ] Log entry at `info` level: "Blocked disabled tool" with `toolName`

### DISP-003: Implement path enforcement in dispatcher
**Description:** Add FR-84 path enforcement after mode/approve checks but before `tool.execute()`.
**Files:**
- Modify `src/chat/dispatcher.ts`
**Dependencies:** DISP-001, PATH-001
**Acceptance Criteria:**
- [ ] Path enforcement runs after approve/mode checks, before `tool.execute()`
- [ ] Calls `enforcePathConstraints()` with tool name, parameters, resolved config entry, and vault root path. Uses `this.vaultRootPath ?? ''` as fallback when vault root path is not set.
- [ ] If path blocked: `toolCall.status = "error"`, `onToolCallStatusChanged` emitted, `ToolResult` returned with `success: false` and blocked path error message
- [ ] Built-in tools only; MCP tools exempted via `TOOL_PATH_PARAMS` lookup

### DISP-004: Implement unified auto-approve from effective config
**Description:** When `effectiveToolConfig` is active, use its merged `auto_approve` value as a unified early-return before the existing MCP/built-in auto-approve branching logic.
**Files:**
- Modify `src/chat/dispatcher.ts`
**Dependencies:** DISP-001
**Acceptance Criteria:**
- [ ] When `effectiveToolConfig` is active, `effectiveToolConfig.tools[toolName]?.auto_approve` is checked as a unified early-return **before** the MCP/built-in branching (`resolveMcpAutoApprove()` / `resolveAutoApprove()`)
- [ ] Neither `resolveMcpAutoApprove()` nor `resolveAutoApprove()` is consulted when effective config provides a value
- [ ] Existing MCP/built-in branching remains as fallback when `effectiveToolConfig` is null

### REG-001: Add `getFilteredToolDefinitions()` to ToolRegistry
**Description:** Add the new method that filters tool definitions based on the effective tool config.
**Files:**
- Modify `src/tools/index.ts`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [ ] New method `getFilteredToolDefinitions(config: EffectiveToolConfig): ToolDefinition[]` added
- [ ] Only tools with `enabled: true` in the config are included in the returned array
- [ ] Existing `getToolDefinitions()` method unchanged (backward compatible)
- [ ] Handles empty `EffectiveToolConfig.tools` gracefully (returns all tools if tool not in config). _This is a defensive fallback — the merger should always produce entries for all tools, but this handles the edge case gracefully._

---

## Phase 3: Integration — Pipeline Modifications

### SYS-001: Split `SystemPromptBuilder` into two-phase API
**Description:** Split the builder into a config-extraction phase and a prompt-building phase to resolve the circular dependency between `assemble()` and `resolveEffectiveConfig()` (RT-6.1). The extraction phase resolves `<include_note>` tags, extracts `<notor_tool_config>` blocks, and caches stripped content internally. The prompt-building phase uses cached stripped content and the now-available filtered `toolDefinitions`.
**Files:**
- Modify `src/chat/system-prompt.ts`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [ ] New method `extractSourceToolConfigs(matchedRules?: VaultRule[], persona?: Persona | null): Promise<ExtractedToolConfigResult>` added
- [ ] `ExtractedToolConfigResult` contains: `personaToolConfigs: ParsedToolConfig[]`, `ruleToolConfigs: ParsedToolConfig[]`
- [ ] Extraction phase resolves `<include_note>` tags for persona and each matched rule, then runs `extractToolConfigs()` on each source
- [ ] Stripped content cached internally on the builder instance for use in the subsequent `assemble()` call
- [ ] `assemble()` parameter changed from `vaultRuleContent?: string` to `matchedRules?: VaultRule[]` (no longer used for content — rules content comes from cache; parameter retained for backward compatibility if needed, or removed)
- [ ] `assemble()` continues to return `Promise<string>` (no return type change needed — tool configs are returned by the extraction phase)
- [ ] `assemble()` uses cached stripped content from `extractSourceToolConfigs()` and receives filtered `toolDefinitions` from the orchestrator
- [ ] TypeScript compilation succeeds (all call sites updated — see ORCH-001, ORCH-002)

### SYS-002: Implement tool config extraction in `extractSourceToolConfigs()`
**Description:** Implement `<notor_tool_config>` extraction for persona content and per-rule content within the new `extractSourceToolConfigs()` method (phase 1 of the two-phase builder).
**Files:**
- Modify `src/chat/system-prompt.ts`
**Dependencies:** SYS-001, PARSE-001
**Acceptance Criteria:**
- [ ] In `extractSourceToolConfigs()`: after `resolveIncludeNotesIfAvailable()` for persona content → `extractToolConfigs(resolved, "persona", persona.system_prompt_path)` called
- [ ] In `extractSourceToolConfigs()`: for each matched rule → `<include_note>` tags resolved, then `extractToolConfigs(resolved, "rule", rule.file_path)` called
- [ ] `<include_note>` resolution for individual rules migrates from `VaultRuleManager.getActiveRuleContent()` to the builder. The builder iterates each `VaultRule`, resolves includes via `resolveIncludeNotesIfAvailable()`, extracts tool configs, and concatenates stripped content. Error handling per-rule follows the existing try/catch pattern in `vault-rules.ts:202-210`.
- [ ] Stripped persona content and stripped per-rule contents cached on the builder instance
- [ ] `<include_note>` resolution runs **before** `<notor_tool_config>` extraction in all cases
- [ ] `assemble()` (phase 2) uses cached stripped content and receives filtered `toolDefinitions` from the orchestrator — no re-extraction occurs in `assemble()`

### RULE-001: Add `getMatchedRules()` to VaultRuleManager
**Description:** Expose the existing private rule evaluation logic as a public API. Deprecate `getActiveRuleContent()`.
**Files:**
- Modify `src/rules/vault-rules.ts`
**Dependencies:** None
**Acceptance Criteria:**
- [ ] New public method `getMatchedRules(): Promise<VaultRule[]>` added
- [ ] Method exposes existing `evaluateRules()` logic
- [ ] `getActiveRuleContent()` marked as deprecated (not deleted yet — removed when all call sites migrated)
- [ ] No changes to `VaultRule` struct, `loadRuleFile()`, or `evaluateRules()` internals
- [ ] Rule manager has zero knowledge of `<notor_tool_config>` — extraction handled downstream

### WF-001: Implement tool config extraction in WorkflowExecutor
**Description:** Modify `assembleWorkflowPrompt()` to extract and strip `<notor_tool_config>` blocks, adding `toolConfigs` to `WorkflowAssemblyResult`.
**Files:**
- Modify `src/workflows/workflow-executor.ts`
**Dependencies:** PARSE-001
**Acceptance Criteria:**
- [ ] `WorkflowAssemblyResult` gets new field: `toolConfigs: ParsedToolConfig[]`
- [ ] Extraction happens after `<include_note>` resolution (step 2) and validation (step 3), but **before** XML wrapping (step 4)
- [ ] `extractToolConfigs(resolvedBody, "workflow", workflow.file.path)` called
- [ ] `strippedContent` (not original resolved body) passed to XML wrapper
- [ ] Full `configs` array (not just `configs[0]`) attached to result

---

## Phase 4: Integration — Orchestrator & main.ts Wiring

### ORCH-001: Implement `resolveEffectiveConfig()` in ChatOrchestrator
**Description:** Add the private method that collects tool configs from all sources, merges them, injects into dispatcher, and computes filtered tool definitions. Uses the two-phase builder split (RT-6.1 resolution): extraction runs *before* merge/filter, then `assemble()` runs *after* with the filtered tool definitions.
**Files:**
- Modify `src/chat/orchestrator.ts`
**Dependencies:** MERGE-001, DISP-001, REG-001, SYS-001
**Acceptance Criteria:**
- [ ] Private method `resolveEffectiveConfig()` added
- [ ] Calls `systemPromptBuilder.extractSourceToolConfigs(matchedRules, persona)` first (phase 1) to get `{ personaToolConfigs, ruleToolConfigs }` — this caches stripped content on the builder
- [ ] Collects `workflowToolConfigs` from active workflow's `WorkflowAssemblyResult.toolConfigs`
- [ ] Calls `mergeToolConfigs()` with all configs, `globalAutoApprove`, and `allToolNames`
- [ ] Stores contributing `ParsedToolConfig[]` as `this.activeParsedConfigs`
- [ ] Stores merged result as `this.effectiveToolConfig`
- [ ] Calls `dispatcher.setEffectiveToolConfig(result)`
- [ ] Computes filtered tool definitions via `this.getToolDefinitionsCallback(result)`
- [ ] Returns filtered tool definitions for use in both `assemble()` (phase 2) and `sendMessage()`

### ORCH-002: Wire `resolveEffectiveConfig()` into foreground `responseLoop()`
**Description:** Remove `toolDefinitions` parameter from `responseLoop()` and compute tool definitions fresh on each iteration using the two-phase builder pattern: extract → merge → filter → assemble.
**Files:**
- Modify `src/chat/orchestrator.ts`
**Dependencies:** ORCH-001, SYS-002, RULE-001
**Acceptance Criteria:**
- [ ] `toolDefinitions` parameter removed from `responseLoop()`
- [ ] Per-iteration flow inside the while-loop: (1) call `resolveEffectiveConfig()` which internally calls `extractSourceToolConfigs()` + merge + filter, (2) call `assemble()` with the filtered tool definitions returned by step 1
- [ ] `vaultRuleManager.getMatchedRules()` called per iteration and passed into `resolveEffectiveConfig()` (which forwards to `extractSourceToolConfigs(matchedRules, persona)`)
- [ ] Filtered tool definitions from `resolveEffectiveConfig()` passed to both `assemble()` and `sendMessage()`
- [ ] Callers of `responseLoop()` (`handleUserMessage()`, `executeWorkflow()`) no longer pass `toolDefinitions`
- [ ] Migrated from `getActiveRuleContent()` to `getMatchedRules()`

### ORCH-003: Wire `resolveEffectiveConfig()` into background `_backgroundResponseLoop()`
**Description:** Apply the same per-iteration `resolveEffectiveConfig()` pattern to the background workflow execution path.
**Files:**
- Modify `src/chat/orchestrator.ts`
**Dependencies:** ORCH-001
**Acceptance Criteria:**
- [ ] `toolDefinitions` parameter removed from `_backgroundResponseLoop()`
- [ ] `resolveEffectiveConfig()` called per-iteration inside the background loop
- [ ] Background loop uses workflow's `WorkflowAssemblyResult.toolConfigs`
- [ ] Background loop's `getActiveRuleContent()` call migrated to `getMatchedRules()`
- [ ] Pre-dispatch auto-approve status check (line ~846) updated to use `effectiveToolConfig.tools[toolName]?.auto_approve` instead of `this.settings.auto_approve[toolName]`, so the concurrency manager UI status (`"waiting_approval"` vs `"running"`) reflects the effective config, not just global settings
- [ ] Background workflow execution has same tool config behavior as foreground path

### ORCH-004: Add inspector getter methods to ChatOrchestrator
**Description:** Add getter methods for the live inspector to read effective config state.
**Files:**
- Modify `src/chat/orchestrator.ts`
**Dependencies:** ORCH-001
**Acceptance Criteria:**
- [ ] `getEffectiveToolConfig(): EffectiveToolConfig | null` getter added
- [ ] `getActiveParsedConfigs(): ParsedToolConfig[]` getter added
- [ ] Both fields cleared on conversation end
- [ ] Fields are fully derived runtime values — not persisted to conversation history

### MAIN-001: Wire `globalAutoApprove` and callback widening in main.ts
**Description:** Build the unified `globalAutoApprove` map, widen `getToolDefinitionsCallback`, and handle conversation-end cleanup.
**Files:**
- Modify `src/main.ts`
**Dependencies:** ORCH-001, REG-001
**Acceptance Criteria:**
- [ ] `globalAutoApprove: Record<string, boolean>` built by merging built-in defaults (`settings.auto_approve`) with MCP server-level `autoApprove[]` lists (expanded into namespaced `server__tool` keys)
- [ ] `globalAutoApprove` injected into orchestrator
- [ ] `getToolDefinitionsCallback` widened to accept optional `EffectiveToolConfig`: when provided → `toolRegistry.getFilteredToolDefinitions(config)`; when omitted → `toolRegistry.getToolDefinitions()`
- [ ] On conversation end: `dispatcher.setEffectiveToolConfig(null)` called and orchestrator's `activeParsedConfigs`/`effectiveToolConfig` cleared

---

## Phase 5: Cleanup — Remove Phase 4 `persona_auto_approve`

### CLEAN-001: Remove `persona_auto_approve` infrastructure
**Description:** Remove the Phase 4 per-persona auto-approve settings UI mechanism, fully replaced by `<notor_tool_config>`.
**Files:**
- Modify `src/settings/types.ts` (remove `persona_auto_approve` field)
- Modify `src/settings/defaults.ts` (remove default value)
- Delete `src/settings/sections/persona-auto-approve.ts`
- Modify `src/personas/auto-approve-resolver.ts` (delete `getPersonaOverrides()`, `setPersonaToolOverride()`, `removePersonaOverrides()`, `getStaleToolNames()`; simplify `resolveAutoApprove()` to remove persona branch)
- Modify `src/chat/dispatcher.ts` (remove `setPersonaAutoApprove()` method and `personaAutoApprove` field)
- Modify `src/main.ts` (remove 3 call sites to `setPersonaAutoApprove()`)
- Modify `src/chat/orchestrator.ts` (remove 1 call site to `setPersonaAutoApprove()`)
- Modify `src/settings/settings-tab.ts` (remove `renderPersonaAutoApproveSection()` reference)
- Modify `e2e/scripts/auto-approve-test.ts` (remove `persona_auto_approve` references)
- Modify `e2e/scripts/mcp-auto-approve-test.ts` (remove `persona_auto_approve` references)
- Modify `e2e/scripts/workflow-hooks-test.ts` (remove `persona_auto_approve` references)
- Modify `e2e/scripts/activity-indicator-test.ts` (remove `persona_auto_approve` references)
**Dependencies:** ORCH-002, MAIN-001
**Acceptance Criteria:**
- [ ] `persona_auto_approve` field removed from `NotorSettings` type and defaults
- [ ] `src/settings/sections/persona-auto-approve.ts` deleted
- [ ] Storage helpers in auto-approve-resolver.ts deleted; `resolveAutoApprove()` simplified
- [ ] `setPersonaAutoApprove()` removed from dispatcher
- [ ] All call sites in main.ts and orchestrator.ts removed
- [ ] Settings tab no longer renders persona auto-approve section
- [ ] No remaining references to `persona_auto_approve` in e2e test files
- [ ] TypeScript compilation succeeds with no errors
- [ ] No remaining references to `persona_auto_approve` in codebase

---

## Phase 6: UI — Settings & Inspector

### UI-001 [P]: "Copy tool config YAML" helper button
**Description:** Add a button in Settings → Tools & permissions that generates and copies a starter `<notor_tool_config>` snippet to clipboard.
**Files:**
- Modify `src/settings/sections/auto-approve.ts`
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [ ] "Copy tool config YAML" button appears in Settings → Tools & permissions
- [ ] Snippet contains only tools whose auto-approve differs from default `false`
- [ ] Comment at top notes unlisted tools inherit global defaults
- [ ] Generated snippet includes `version="1.0"` attribute
- [ ] Snippet copied to clipboard via `navigator.clipboard.writeText()`
- [ ] If no tools differ from defaults, snippet contains just the comment block with no tool entries

### UI-002 [P]: Settings → Personas section
**Description:** Add a new top-level Settings → Personas section with persona creation and listing.
**Files:**
- Create `src/settings/sections/personas.ts`
- Modify `src/settings/settings-tab.ts` (register new section)
**Dependencies:** None
**Acceptance Criteria:**
- [ ] New **Settings → Personas** section at top level of plugin settings
- [ ] "Create new persona" button prompts for name, creates skeleton `system-prompt.md` at `{notor_dir}/personas/{name}/system-prompt.md`
- [ ] Skeleton includes placeholder `<notor_tool_config>` block
- [ ] Existing personas list shows all personas from `{notor_dir}/personas/`
- [ ] Each entry has persona name and "Open system prompt" button that opens the note in the editor
- [ ] List populated at settings open time (no live-update while open)
- [ ] Section does not replicate tool configuration controls

### UI-003: Effective Config Inspector leaf view
**Description:** Implement the FR-88 standalone leaf view for inspecting the merged effective tool config during live conversations.
**Files:**
- Create `src/ui/effective-config-inspector.ts`
- Modify `src/main.ts` (register view type)
**Dependencies:** ORCH-004
**Acceptance Criteria:**
- [ ] `ItemView` registered under view type `"notor-tool-config-inspector"`
- [ ] Openable alongside chat panel via button or command palette action
- [ ] **Live in-chat mode:** reads `EffectiveToolConfig` and `activeParsedConfigs` from orchestrator getter methods
- [ ] Each tool field shows effective value and source link to the specific note driving it
- [ ] Display updates as `activeParsedConfigs` changes between messages
- [ ] When no conversation is active, displays a "requires active conversation" message
- [ ] Table per tool: `enabled`, `auto_approve`, `allowed_paths`, `blocked_paths`, source note link
- [ ] Fields at global defaults shown in muted style
- [ ] Built entirely on shared resolution functions — no inspector-specific duplicate logic (NFR-25)
- [ ] Pre-flight mode deferred (not implemented in this phase)

---

## Phase 7: Quality & Validation

### TEST-001: Unit tests for parser
**Description:** Test `extractToolConfigs()` covering all parsing, validation, and edge cases.
**Files:**
- Create test file for `src/tool-config/parser.ts`
**Dependencies:** PARSE-001, PARSE-002
**Acceptance Criteria:**
- [ ] Valid single-block extraction and stripping
- [ ] Multiple blocks per file (document-order merge)
- [ ] Version attribute parsing: missing, valid, unsupported major
- [ ] YAML parse failures: malformed YAML, null/undefined/array/scalar returns from `parseYAML`
- [ ] Field validation: unrecognized tool name, unrecognized field, wrong types for each field
- [ ] MCP tool path field Notice
- [ ] Content fully stripped from output

### TEST-002 [P]: Unit tests for merger
**Description:** Test `mergeToolConfigs()` covering precedence, sparse merge, and defaults.
**Files:**
- Create test file for `src/tool-config/merger.ts`
**Dependencies:** MERGE-001
**Acceptance Criteria:**
- [ ] Precedence order: workflow > persona > rule > global
- [ ] Sparse merge: higher-priority omitted field does not override lower-priority value
- [ ] Replace semantics for `allowed_paths` / `blocked_paths`
- [ ] Default fill for unmentioned tools
- [ ] `globalAutoApprove` correctly applied (built-in + MCP server-level)
- [ ] Document position ordering within same source type

### TEST-003 [P]: Unit tests for path enforcer
**Description:** Test `enforcePathConstraints()` for all tool types and path scenarios.
**Files:**
- Create test file for `src/tool-config/path-enforcer.ts`
**Dependencies:** PATH-001
**Acceptance Criteria:**
- [ ] Vault-namespace: prefix match allows, non-match blocks
- [ ] Filesystem-namespace: absolute path resolution and comparison
- [ ] `blocked_paths` overrides `allowed_paths`
- [ ] Empty `allowed_paths` → no restriction
- [ ] Empty `blocked_paths` → no restriction
- [ ] `fetch_webpage` exempt
- [ ] MCP tools exempt
- [ ] `write_docx` dual path params (`output_path` + `template_path`) both enforced

### TEST-004: Integration test — end-to-end tool config flow
**Description:** Test the full pipeline from tag in source file through to dispatcher enforcement.
**Files:**
- Create integration test file
**Dependencies:** All Phase 2–4 tasks
**Acceptance Criteria:**
- [ ] Persona with `<notor_tool_config>` disabling tools → LLM tool list excludes disabled tools
- [ ] Workflow overriding persona config → correct precedence applied
- [ ] Rule activating mid-conversation → config recomputed on next message
- [ ] Disabled tool call → blocked with correct error message
- [ ] Path-restricted tool call → blocked when path outside allowed range
- [ ] `<include_note>` embedding a shared config → extracted correctly post-resolution

---

## Phase 8: Final Validation & Commit

### VAL-001: Final cross-reference validation
**Description:** Validate all functional requirements are implemented and the codebase compiles cleanly.
**Files:** All modified and created files
**Dependencies:** All previous tasks
**Acceptance Criteria:**
- [ ] TypeScript compilation succeeds with no errors
- [ ] All FRs covered: FR-78 (tag syntax), FR-79 (supported contexts), FR-80 (precedence), FR-81 (pipeline), FR-82 (validation), FR-83 (disabled blocking), FR-84 (path enforcement), FR-85 (versioning), FR-86 (copy helper), FR-87 (personas section), FR-88 (inspector)
- [ ] All NFRs satisfied: NFR-22 (performance), NFR-23 (portability), NFR-24 (robustness), NFR-25 (inspector fidelity)
- [ ] No remaining references to deprecated `persona_auto_approve`
- [ ] No remaining calls to deprecated `getActiveRuleContent()` in Phase 4b code paths
- [ ] `<notor_tool_config>` tags fully stripped before LLM sees content in all contexts

---

## Dependency Graph

```
ENV-001
├── PARSE-001 → PARSE-002
│              └──→ TEST-001
├── MERGE-001 ────→ TEST-002
├── PATH-001 ─────→ TEST-003
├── DISP-001
│   ├── DISP-002
│   ├── DISP-003 (+ PATH-001)
│   └── DISP-004
├── REG-001
└── UI-001

(no deps) RULE-001
(no deps) UI-002

SYS-001 (+ ENV-001) → SYS-002 (+ PARSE-001)    [two-phase builder: extractSourceToolConfigs → assemble]
WF-001 (+ PARSE-001)

ORCH-001 (+ MERGE-001, DISP-001, REG-001, SYS-001)
├── ORCH-002 (+ SYS-002, RULE-001)
├── ORCH-003
├── ORCH-004 → UI-003
└── MAIN-001

CLEAN-001 (+ ORCH-002, MAIN-001)

TEST-004 (all Phase 2–4)

VAL-001 (all tasks)
```

## Critical Path

```
ENV-001 → PARSE-001 → SYS-002 → ORCH-001 → ORCH-002 → CLEAN-001 → VAL-001
```

The critical path runs through type definitions → parser → builder integration → orchestrator wiring → cleanup → validation. Phases 1–2 (parser, merger, path-enforcer, dispatcher, registry) can be parallelized heavily since they are independent new modules.

## Parallel Execution Opportunities

| Group | Tasks | Rationale |
|---|---|---|
| **A** | PARSE-001, MERGE-001, PATH-001 | Independent new modules, all depend only on ENV-001 |
| **B** | DISP-002, DISP-003, DISP-004 | Independent dispatcher modifications, all depend on DISP-001 |
| **C** | REG-001, RULE-001 | Independent single-method additions |
| **D** | SYS-002, WF-001 | Both depend on PARSE-001 but modify different files |
| **E** | ORCH-002, ORCH-003, ORCH-004 | Independent orchestrator modifications, all depend on ORCH-001 |
| **F** | UI-001, UI-002 | Independent settings UI additions |
| **G** | TEST-001, TEST-002, TEST-003 | Independent test suites |
| **H** | CLEAN-001, UI-003 | Can run in parallel once their deps are met |
