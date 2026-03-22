# Implementation Plan: Phase 4b — `<notor_tool_config>` XML Tag System

**Created:** 2026-03-22
**Specification:** [spec.md](spec.md)
**Status:** Planning

## Technical Context

### Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Config extraction layer | New `src/tool-config/` module | Keeps parsing, merging, and enforcement logic isolated and testable; avoids scattering tool-config concerns across existing modules |
| YAML parsing | `js-yaml` (already a transitive dep via Obsidian's bundled environment; use `parseYAML` from `obsidian` if available, otherwise `js-yaml`) | The spec bodies are already YAML; a dedicated parser handles edge cases cleanly; avoid rolling a hand-written parser for structured data |
| Regex approach for tag extraction | Hardened regex: `/^<notor_tool_config([^>]*)>([\s\S]*?)<\/notor_tool_config>/gm` | RT-2 confirmed: ~4× faster than line-by-line on all realistic input; `^`+`m` hardening eliminates pathological backtracking |
| `EffectiveToolConfig` scope | Recomputed before each LLM call; stored on the active conversation context as `activeParsedConfigs: ParsedToolConfig[]` + resolved `EffectiveToolConfig`; cleared on conversation end | Per-message recomputation reflects dynamic rule activation/deactivation (spec clarification Q5); no persistence between conversations |
| `ToolRegistry.getFilteredToolDefinitions()` | New method alongside existing `getToolDefinitions()` | Additive change; existing callers unaffected; filtered variant called before each LLM call in `ChatOrchestrator.responseLoop()` |
| Dispatcher enforcement | `setEffectiveToolConfig()` injected before each LLM call; enabled check runs first in `dispatch()`, path enforcement runs after mode/approve checks | Matches FR-83 (enabled check first) and FR-84 (path enforcement before execution) |
| Tool config extraction ownership | `SystemPromptBuilder` owns extraction for persona and rule sources; `WorkflowExecutor` owns extraction for workflow source | Builder already processes each source in distinct labeled code paths (persona content, per-rule content) so source attribution (`"persona"` / `"rule"`) is natural. VaultRuleManager stays extraction-unaware; it just exposes `getMatchedRules()` for stateless dynamic evaluation. See RT-4 Risk 3 resolution. |
| Inspector code sharing | Pre-flight and live modes both call the same `resolveEffectiveConfig()` function used by `ChatOrchestrator` | NFR-25 mandate: no duplicate logic; inspector is a pure consumer of shared pipeline functions |

### Technology Stack

This feature is entirely within the existing TypeScript/Obsidian plugin stack:

- **Parsing:** `js-yaml` for YAML body parsing (same dependency used elsewhere in the Obsidian ecosystem). Specifically, `parseYAML` from the `obsidian` package is available as a built-in — use that to avoid adding a new dependency.
- **UI:** Obsidian `ItemView` (leaf view) for the Effective Config Inspector; standard Obsidian `Setting` API for the new Settings sections.
- **Path comparison:** Existing `resolveAndValidatePath` / `isPathWithin` utilities in `src/utils/path-validation.ts` for filesystem-namespace tools; custom vault-prefix comparison for vault-namespace tools.

### Integration Points

| Integration | Description |
|---|---|
| `SystemPromptBuilder` | Owns `<notor_tool_config>` extraction for both persona content and per-rule content. Receives `matchedRules: VaultRule[]` instead of a pre-merged string; runs `extractToolConfigs()` on each source with per-file attribution. Returns `{ prompt, personaToolConfigs, ruleToolConfigs }` |
| `VaultRuleManager` | Exposes `getMatchedRules(): VaultRule[]` — stateless dynamic evaluation of rules against current `accessedNotes`. No tool config awareness; extraction is handled by `SystemPromptBuilder` |
| `WorkflowExecutor` | After resolving `<include_note>` in workflow body, extract and strip tool config; include `ParsedToolConfig` in `WorkflowAssemblyResult` |
| `ToolDispatcher` | New `setEffectiveToolConfig()` method; enabled check + path enforcement in `dispatch()` |
| `ToolRegistry` | New `getFilteredToolDefinitions(config)` method called before each LLM call |
| `ChatOrchestrator` | Owns `resolveEffectiveConfig()`: collects `ParsedToolConfig[]` from `SystemPromptBuilder.assemble()` result (persona + rule configs) and active workflow's `WorkflowAssemblyResult`, merges into `EffectiveToolConfig`, injects into dispatcher, and calls `getFilteredToolDefinitions()` before each provider call in `responseLoop()`. Passes `VaultRuleManager.getMatchedRules()` to the builder on each iteration. |
| `main.ts` | Injects dependencies into the orchestrator (tool registry, vault rule manager, global/persona auto-approve maps); clears `effectiveToolConfig` on conversation end |

---

## Phase 0: Research & Architecture — COMPLETE

All three research tasks are resolved:

| Task | Status | Outcome |
|---|---|---|
| RT-1 — Per-tool path argument inspection | Complete | `TOOL_PATH_PARAMS` descriptor table defined; vault vs. filesystem namespace strategies confirmed. See [`research/RT-1-path-argument-inspection.md`](research/RT-1-path-argument-inspection.md). |
| RT-2 — Regex vs. line-by-line extraction benchmark | Complete | Use hardened regex `/^<notor_tool_config([^>]*)>([\s\S]*?)<\/notor_tool_config>/gm`. See [`research/RT-2-extraction-parser-benchmark.md`](research/RT-2-extraction-parser-benchmark.md). |
| RT-3 — Obsidian Notice right-click navigation | Complete | Use `notice.noticeEl.oncontextmenu` + `app.workspace.openLinkText()`; gate on `Platform.isDesktop`. See [`research/RT-3-notice-right-click.md`](research/RT-3-notice-right-click.md). |

No NEEDS CLARIFICATION items remain in the specification. All clarifications were resolved in the 2026-03-22 session (see spec.md § Clarifications).

---

## Phase 1: Design & Contracts

### Data Model

The spec defines the two key entities. They live in `src/tool-config/types.ts`.

#### `ParsedToolConfig`

Structured output of parsing a single `<notor_tool_config>` block. All `ToolConfigEntry` fields are optional — sparse model.

```typescript
interface ParsedToolConfig {
  source: "persona" | "workflow" | "rule";
  sourceFile: string;           // vault-relative path, for Notice attribution
  documentPosition: number;     // character offset in the source file, for within-file merge ordering
  tools: Record<string, ToolConfigEntry>;
}

interface ToolConfigEntry {
  enabled?: boolean;
  auto_approve?: boolean;
  allowed_paths?: string[];
  blocked_paths?: string[];
}
```

#### `EffectiveToolConfig`

Fully merged result. All `ResolvedToolConfigEntry` fields are non-optional — defaults filled during resolution.

```typescript
interface EffectiveToolConfig {
  tools: Record<string, ResolvedToolConfigEntry>;
}

interface ResolvedToolConfigEntry {
  enabled: boolean;
  auto_approve: boolean;
  allowed_paths: string[];
  blocked_paths: string[];
}
```

#### `TOOL_PATH_PARAMS` descriptor table

Lives in `src/tool-config/path-enforcer.ts`. Drives dispatch-time path enforcement for all 13 built-in tools.

```typescript
type PathNamespace = "vault" | "filesystem";

interface ToolPathParam {
  param: string;
  namespace: PathNamespace;
}

const TOOL_PATH_PARAMS: Record<string, ToolPathParam[]> = {
  read_note:         [{ param: "path",              namespace: "vault" }],
  write_note:        [{ param: "path",              namespace: "vault" }],
  replace_in_note:   [{ param: "path",              namespace: "vault" }],
  read_frontmatter:  [{ param: "path",              namespace: "vault" }],
  update_frontmatter:[{ param: "path",              namespace: "vault" }],
  manage_tags:       [{ param: "path",              namespace: "vault" }],
  search_vault:      [{ param: "path",              namespace: "vault" }],
  list_vault:        [{ param: "path",              namespace: "vault" }],
  read_file:         [{ param: "path",              namespace: "filesystem" }],
  read_docx:         [{ param: "path",              namespace: "filesystem" }],
  write_docx:        [{ param: "output_path",       namespace: "filesystem" },
                      { param: "template_path",     namespace: "filesystem" }],
  execute_command:   [{ param: "working_directory", namespace: "filesystem" }],
  fetch_webpage:     [],  // no path params — exempt from enforcement
};
```

### Module Contracts

#### New module: `src/tool-config/types.ts`

Export all type definitions: `ParsedToolConfig`, `ToolConfigEntry`, `EffectiveToolConfig`, `ResolvedToolConfigEntry`, `PathNamespace`, `ToolPathParam`.

---

#### New module: `src/tool-config/parser.ts`

Primary public API:

```typescript
/**
 * Extract and strip all <notor_tool_config> blocks from a text string.
 *
 * Returns the stripped content (for passing to the LLM) and the
 * list of ParsedToolConfig objects (for the precedence merge).
 *
 * Ordering: <include_note> resolution MUST run before calling this.
 */
function extractToolConfigs(
  text: string,
  source: ParsedToolConfig["source"],
  sourceFile: string,
): {
  strippedContent: string;
  configs: ParsedToolConfig[];
}
```

Internal steps:
1. Run the hardened regex over `text` to find all `<notor_tool_config>` blocks.
2. For each match:
   a. Parse `version` attribute from the opening tag. If major > max supported → `console.warn` and skip.
   b. Parse YAML body via `parseYAML` (Obsidian built-in).
   c. Validate structure — emit `Notice` per FR-82 for each invalid field; skip invalid entries, continue processing valid ones.
   d. Build `ParsedToolConfig` with `documentPosition` = match index.
3. Replace each matched block with `""` in the working text.
4. Return `{ strippedContent, configs }`.

---

#### New module: `src/tool-config/merger.ts`

Primary public API:

```typescript
/**
 * Merge a list of ParsedToolConfig objects (from all active sources)
 * into a single EffectiveToolConfig using the defined precedence order.
 *
 * Precedence (highest first): workflow > persona > rule > global defaults.
 * Within a source type, document position determines order (last wins).
 * Field merge is sparse (field-by-field); path lists use replace semantics.
 *
 * For auto_approve defaults: personaAutoApprove > globalAutoApprove > false.
 * globalAutoApprove includes both built-in tool defaults (from Settings)
 * and MCP server-level autoApprove[] lists (pre-flattened by the caller
 * into namespaced server__tool keys).
 */
function mergeToolConfigs(
  configs: ParsedToolConfig[],
  globalAutoApprove: Record<string, boolean>,
  personaAutoApprove: Record<string, boolean>,
  allToolNames: string[],
): EffectiveToolConfig
```

Merge algorithm:
1. Sort `configs` by precedence level (workflow=0, persona=1, rule=2), then by `documentPosition` ascending within the same source type.
2. For each tool across all configs, iterate in sort order; for each field, the last non-undefined value wins (sparse merge).
3. For `allowed_paths` / `blocked_paths`, use replace semantics: the highest-priority config that sets the field completely replaces lower-level values.
4. Fill in defaults for any tool not mentioned in any config: `enabled: true`, `auto_approve: personaAutoApprove[toolName] ?? globalAutoApprove[toolName] ?? false` (where `globalAutoApprove` includes both built-in defaults from Settings and MCP server-level `autoApprove[]` entries pre-flattened into namespaced keys), `allowed_paths: []`, `blocked_paths: []`.
5. Return `{ tools: ... }`.

---

#### New module: `src/tool-config/path-enforcer.ts`

```typescript
/**
 * Check whether a tool call's path arguments satisfy the effective
 * allowed_paths / blocked_paths constraints.
 *
 * Returns null if the call is allowed, or an error message string if blocked.
 * Caller should return a ToolResult with success:false and this error string.
 */
function enforcePathConstraints(
  toolName: string,
  parameters: Record<string, unknown>,
  entry: ResolvedToolConfigEntry,
  vaultRootPath: string,
): string | null
```

Uses `TOOL_PATH_PARAMS` to identify which parameters carry path values. For each path param:
- Vault-namespace: use `vaultPathMatchesPrefix()` (pure string prefix logic from RT-1).
- Filesystem-namespace: resolve to absolute path via existing `resolveAndValidatePath`, then compare with `isPathWithin`.

`fetch_webpage` (empty `TOOL_PATH_PARAMS` entry) → skip enforcement.
MCP tools (not in `TOOL_PATH_PARAMS`) → skip enforcement (deferred per spec).

---

#### Modified: `src/tools/index.ts` — `ToolRegistry`

Add one new method:

```typescript
/**
 * Get tool definitions filtered by the effective tool config.
 * Only tools with enabled:true are included.
 * Used before each LLM call to build the tool list sent to the LLM.
 */
getFilteredToolDefinitions(config: EffectiveToolConfig): ToolDefinition[]
```

---

#### Modified: `src/chat/dispatcher.ts` — `ToolDispatcher`

Add:
- Private field: `private effectiveToolConfig: EffectiveToolConfig | null = null`
- New method: `setEffectiveToolConfig(config: EffectiveToolConfig | null): void`

Modify `dispatch()` to prepend the following check **before** the existing mode check:

```typescript
// FR-83: enabled check (before mode/approve/execution)
if (this.effectiveToolConfig) {
  const entry = this.effectiveToolConfig.tools[toolName];
  if (entry && !entry.enabled) {
    log.info("Blocked disabled tool", { toolName });
    toolCall.status = "error";
    this.events.onToolCallStatusChanged?.(toolCall, messageId);
    return {
      tool_name: toolName,
      success: false,
      result: "",
      error: `Tool '${toolName}' is disabled and cannot be used in this context.`,
    };
  }
}
```

After the approve/mode checks and before `tool.execute()`, add:

```typescript
// FR-84: path enforcement
if (this.effectiveToolConfig) {
  const entry = this.effectiveToolConfig.tools[toolName];
  if (entry) {
    const pathError = enforcePathConstraints(toolName, parameters, entry, this.vaultRootPath ?? "");
    if (pathError) {
      toolCall.status = "error";
      this.events.onToolCallStatusChanged?.(toolCall, messageId);
      return { tool_name: toolName, success: false, result: "", error: pathError };
    }
  }
}
```

Also expose `auto_approve` from `effectiveToolConfig` in the auto-approve resolution: when `effectiveToolConfig` is set and the tool has an entry, the config's `auto_approve` value takes precedence over the `resolveAutoApprove()` result. The merger already incorporates Phase 4 `persona_auto_approve` into its defaults (see `mergeToolConfigs()` signature), so the dispatcher does not need to consult `resolveAutoApprove()` at all when `effectiveToolConfig` is active.

---

#### Modified: `src/chat/system-prompt.ts` — `SystemPromptBuilder`

`assemble()` currently accepts `vaultRuleContent?: string` and returns `Promise<string>`. Two changes:

1. **Parameter change:** Replace `vaultRuleContent?: string` with `matchedRules?: VaultRule[]`. The builder receives individual matched rule objects (from `VaultRuleManager.getMatchedRules()`) instead of a pre-merged content string. For each matched rule, the builder resolves `<include_note>` tags, runs `extractToolConfigs()` with the rule's `file_path` for per-file source attribution, then concatenates stripped content for the rules section.

2. **Return type change:** Change from `Promise<string>` to:

```typescript
interface SystemPromptAssemblyResult {
  prompt: string;
  personaToolConfigs: ParsedToolConfig[];  // extracted from persona content
  ruleToolConfigs: ParsedToolConfig[];     // extracted from matched rule content (per-file attributed)
}
```

The builder owns `<notor_tool_config>` extraction for both persona and rule sources:
- After `resolveIncludeNotesIfAvailable()` for persona content → `extractToolConfigs(resolved, "persona", persona.system_prompt_path)`.
- For each matched rule → resolve `<include_note>` tags (currently done in `VaultRuleManager.getActiveRuleContent()`), then `extractToolConfigs(resolved, "rule", rule.file_path)`.

Stripped content goes into the prompt; `ParsedToolConfig[]` arrays are returned for the precedence merge.

---

#### Modified: `src/rules/vault-rules.ts` — `VaultRuleManager`

Add one new public method:

```typescript
/**
 * Get the VaultRule objects that match the current accessedNotes context.
 * Stateless — evaluates triggers dynamically each time, no persistent
 * "active" flag on VaultRule. Reloads from disk if cache is stale.
 */
async getMatchedRules(): Promise<VaultRule[]>
```

This exposes the existing private `evaluateRules()` logic as a public API. The rule manager has zero knowledge of `<notor_tool_config>` — extraction is handled downstream by `SystemPromptBuilder`.

`getActiveRuleContent()` remains available for backward compatibility but the orchestrator will shift to calling `getMatchedRules()` so the builder can process each rule individually (per-file `<include_note>` resolution + per-file tool config extraction with source attribution).

No changes to `VaultRule` struct, `loadRuleFile()`, or `evaluateRules()` internals.

---

#### Modified: `src/workflows/workflow-executor.ts`

- `WorkflowAssemblyResult` gets a new optional field: `toolConfig: ParsedToolConfig | null`.
- After `<include_note>` resolution, pipe the resolved body through `extractToolConfigs(body, "workflow", workflow.file.path)`. Use `strippedContent` as the workflow body; attach `configs[0]` (merged within-file per FR-78) or `null` to `WorkflowAssemblyResult`.

---

#### Modified: `src/chat/orchestrator.ts` — `ChatOrchestrator`

Add a private `resolveEffectiveConfig()` method that:
1. Collects `personaToolConfigs` and `ruleToolConfigs` from the most recent `SystemPromptBuilder.assemble()` result (the builder now extracts tool configs from both persona content and per-rule content, returning both arrays).
2. Collects `workflowToolConfig` from the active workflow's `WorkflowAssemblyResult.toolConfigs` (if any).
3. Reads `personaAutoApprove` from the active persona's Phase 4 overrides (if any).
4. Merges via `mergeToolConfigs([...workflowConfigs, ...personaToolConfigs, ...ruleToolConfigs], globalAutoApprove, personaAutoApprove, allToolNames)`.
5. Stores the contributing `ParsedToolConfig[]` as `activeParsedConfigs` on the orchestrator's runtime state (accessible to the inspector).
6. Calls `dispatcher.setEffectiveToolConfig(result)`.
7. Uses `toolRegistry.getFilteredToolDefinitions(result)` when building the tool list for the `provider.sendMessage()` call.

Call `resolveEffectiveConfig()` inside `responseLoop()` **before each `provider.sendMessage()` call** (at the same point where `systemPromptBuilder.assemble()` is already called per-iteration). The orchestrator calls `vaultRuleManager.getMatchedRules()` and passes the result to `assemble(matchedRules)` on each iteration, so the builder can process each rule individually. This ensures dynamic rule activation/deactivation is reflected in the effective config on every loop iteration, not just at conversation start.

The orchestrator receives the following dependencies (injected from `main.ts` at construction or via setters):
- `toolRegistry: ToolRegistry`
- `globalAutoApprove: Record<string, boolean>` — includes both built-in tool defaults (from Settings → Tools & permissions) and MCP server-level `autoApprove[]` lists pre-flattened into namespaced `server__tool` keys. `main.ts` builds this unified map before injection.
- `personaAutoApprove: Record<string, boolean>`

---

#### Modified: `src/main.ts`

- Builds a unified `globalAutoApprove: Record<string, boolean>` map that merges built-in tool defaults (from `settings.auto_approve`) with MCP server-level `autoApprove[]` lists (iterates all configured MCP servers, expands each server's `autoApprove: string[]` into namespaced `server__tool` keys set to `true`). Injects this along with `toolRegistry` and `personaAutoApprove` into the orchestrator (via constructor params or setters) so the orchestrator can call `resolveEffectiveConfig()` independently.
- On conversation end, calls `dispatcher.setEffectiveToolConfig(null)` and clears `activeParsedConfigs` to revert to global defaults.
- No longer owns `resolveEffectiveConfig()` — that logic now lives in the orchestrator where it has direct access to `assemble()` output and the per-loop call cadence.

---

#### New: `src/settings/sections/personas.ts` — Settings → Personas

Implements FR-87. UI section with:
- **Create new persona** button: prompts for name via `Modal`, creates skeleton `system-prompt.md` at `{notor_dir}/personas/{name}/system-prompt.md` with a placeholder `<notor_tool_config>` block.
- **Existing personas list**: populated by calling `personaManager.getDiscoveredPersonas()` at settings open time. Each entry shows persona name + an "Open system prompt" button that calls `app.workspace.openLinkText(persona.system_prompt_path, "", false)`.

---

#### Modified: `src/settings/sections/auto-approve.ts`

Add a **"Copy tool config YAML"** button (FR-86) at the top of the Tools & permissions section.

When clicked:
1. Identify tools whose current `auto_approve` setting differs from the hardcoded global default (all `false`). Only non-default entries go in the snippet; any tool set to `true` is listed.
2. Build the snippet:
   ```
   <notor_tool_config version="1.0">
   # Only tools that differ from global defaults are listed.
   # Unlisted tools inherit their settings from global defaults.
   {tool_name}:
     auto_approve: true
   </notor_tool_config>
   ```
3. Copy to clipboard via `navigator.clipboard.writeText()`.

If no tools differ from defaults, copy a snippet with just the comment block and no tool entries.

---

#### New: `src/ui/effective-config-inspector.ts` — Effective Config Inspector

Implements FR-88. A `ItemView` registered under a unique view type (e.g., `"notor-tool-config-inspector"`).

**Pre-flight mode** (no active conversation):
- Persona picker dropdown — calls `personaManager.getDiscoveredPersonas()`.
- Workflow picker dropdown — calls `workflowDiscovery.discoverWorkflows()`.
- Optional prompt input field — fed to the existing rule trigger evaluation function in `VaultRuleManager` (same `ruleMatches()` logic, called with a synthetic accessed-notes context derived from prompt keyword analysis, per the clarification in spec.md § Session 2026-03-22).
- On any selection change: calls `resolveEffectiveConfig()` (the same shared function from `main.ts`) with the selected persona/workflow/rules and displays the result.

**Live in-chat mode** (active conversation):
- Reads the `EffectiveToolConfig` and `activeParsedConfigs: ParsedToolConfig[]` from the conversation context object.
- Displays each tool's resolved values with source attribution — the source file name comes from `ParsedToolConfig.sourceFile` in `activeParsedConfigs`. The display updates automatically as `activeParsedConfigs` changes between messages (e.g., when rules activate/deactivate).

**Display format**: a table per tool showing `enabled`, `auto_approve`, `allowed_paths`, `blocked_paths`, and the source note link for each field. Fields at global defaults shown in muted style.

---

### Validation Notice helper

Shared helper in `src/tool-config/parser.ts` (or a new `src/tool-config/notices.ts`):

```typescript
function showToolConfigError(
  plugin: NotorPlugin,
  sourceFile: string,
  detail: string,
): void {
  const jumpHint = Platform.isDesktop ? " Right-click to jump to note." : "";
  const notice = new Notice(
    `[${sourceFile}] notor_tool_config: ${detail}.${jumpHint}`,
    10_000,
  );
  if (Platform.isDesktop) {
    notice.noticeEl.oncontextmenu = () => {
      plugin.app.workspace.openLinkText(sourceFile, "", false);
    };
  }
}
```

---

## Implementation Readiness Validation

### Technical Completeness Check

- [x] All technology choices made and documented
- [x] Data model covers all functional requirements (FR-78 through FR-88)
- [x] Module contracts defined for all new and modified files
- [x] Security requirements addressed (path enforcement, disabled-tool blocking)
- [x] Performance requirements documented (O(n) regex, no async in merge; NFR-22 satisfied by RT-2 findings)
- [x] Integration points defined (all call sites in `main.ts` and pipeline stages)
- [x] No Settings UI state for tool enabled/disabled (per spec assumptions — tag is sole source of truth)

### Quality Validation

- [x] Architecture supports NFR-23 (portability) — no config stored in `data.json`
- [x] NFR-24 (graceful degradation) addressed — parse errors skip the block, never crash
- [x] NFR-25 (inspector fidelity) addressed — inspector shares `resolveEffectiveConfig()` directly
- [x] MCP tool exemption from path enforcement documented at every enforcement call site
- [x] `<include_note>` ordering constraint enforced — extraction always runs after resolution

---

## Risk Assessment

### Technical Risks

- **Medium:** `parseYAML` from `obsidian` package behavior under malformed input needs verification — confirm it throws rather than returning `undefined` on invalid YAML, so the try/catch in the parser catches it correctly.
- **Medium:** `SystemPromptBuilder.assemble()` return type change is a breaking signature change — the orchestrator (primary call site) and any tests must be updated. Strictly additive to the returned object, so runtime compatibility is not a concern, but TypeScript compilation will surface all sites.
- **Low:** `EffectiveToolConfig` is recomputed before each LLM call (spec clarification Q5). This subsumes the workflow-invocation recomputation concern — `resolveEffectiveConfig()` runs every message, so workflow changes and rule activation/deactivation are picked up automatically. The per-message overhead is negligible (NFR-22: O(t × l) merge with t ≤ ~15 tools and l ≤ 4 levels).
- **Low:** Inspector pre-flight rule evaluation uses a synthetic prompt. The existing `ruleMatches()` function in `VaultRuleManager` currently uses `accessedNotes` (a Set of vault paths), not prompt text. A thin adapter in the inspector will map the typed prompt into a synthetic accessed-notes set (e.g., extract note path mentions). This is documented in the spec clarification and does not require changes to `ruleMatches()` itself.

### Mitigation Strategies

- Verify `parseYAML` behavior with a targeted unit test before wiring into the parser.
- Update orchestrator call sites immediately after changing `SystemPromptBuilder.assemble()` — treat this as an atomic change.
- `resolveEffectiveConfig()` runs before each LLM call, so no special `WorkflowInvokedEvent` call site is needed — workflow and rule changes are picked up automatically.

### Dependencies and Assumptions

- **Assumption:** `parseYAML` is available as a named export from `obsidian`. If not available, fall back to `js-yaml.load()` which is transitively available in the Obsidian bundler environment.
- **Assumption:** `ToolRegistry.getToolDefinitions()` continues to return all registered tools unfiltered (per spec Assumptions). `getFilteredToolDefinitions()` is a new additive method — existing callers are unchanged.
- **Assumption:** Provider implementations handle an empty `tools` array correctly (no tools in request body). Verified as a spec assumption — no defensive code needed in the provider layer.
- **External dependency:** `MCP tool names` follow the `server__tool` namespacing convention already in place. The MCP-server-inactive Notice (FR-82) requires checking whether a tool name prefix matches a configured-but-inactive MCP server in settings.

---

## Next Phase Preparation

### Task Breakdown Readiness

- [x] Module structure defined — each FR maps to a specific module and method
- [x] No unresolved NEEDS CLARIFICATION items
- [x] `TOOL_PATH_PARAMS` table fully specified (RT-1)
- [x] Extraction regex finalized (RT-2)
- [x] Notice right-click pattern confirmed (RT-3)
- [x] Dispatcher modification plan is non-destructive (additive fields + prepend checks)
- [x] Return type change for `SystemPromptBuilder.assemble()` identified as the only breaking signature change

### Implementation Prerequisites

- [x] Research completed and documented
- [x] Existing ingestion pipeline understood (include_note → tool_config extraction ordering confirmed)
- [x] Path-validation utilities confirmed available in `src/utils/path-validation.ts`
- [x] Existing `Notice` + `Platform` imports confirmed via RT-3

### Task Grouping (for speckit-05-tasks)

Suggested task groups:

| Group | Scope |
|---|---|
| **A** | New `src/tool-config/` module: `types.ts`, `parser.ts`, `merger.ts`, `path-enforcer.ts` |
| **B** | Dispatcher modifications: `setEffectiveToolConfig()`, enabled check, path enforcement |
| **C** | Ingestion pipeline modifications: `SystemPromptBuilder`, `VaultRuleManager`, `WorkflowExecutor` |
| **D** | `ToolRegistry.getFilteredToolDefinitions()` + `ChatOrchestrator` wiring (`resolveEffectiveConfig()`, `responseLoop()` integration) + `main.ts` dependency injection |
| **E** | Settings UI: "Copy tool config YAML" button + Settings → Personas section |
| **F** | Effective Config Inspector leaf view |
