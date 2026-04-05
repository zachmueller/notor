# Implementation Tasks: Phase 5 — User-Defined Extensions

**Created:** 2026-04-06
**Plan:** [plan.md](./plan.md)
**Design:** [design/user-defined-tools.md](../../design/user-defined-tools.md)
**Status:** In Progress

---

## Phase 0: Dependencies & Scaffolding

### EXT-001 — Install Sucrase

- [x] Add `"sucrase": "^3.35.0"` to `dependencies` in `package.json`
- [x] Run `npm install` and verify `package-lock.json` updates
- [x] Run `npm run build` — confirm esbuild bundles sucrase without errors (it's not in the `external` array in `esbuild.config.mjs:31-45`, so it will be bundled)
- [x] Check bundle size delta is reasonable (~50KB)

### EXT-002 — Create `src/extensions/` module scaffolding

- [x] Create directory `src/extensions/`
- [x] Create `src/extensions/types.ts` with placeholder exports
- [x] Create `src/extensions/parser.ts` with module doc comment and placeholder export
- [x] Create `src/extensions/compiler.ts` with placeholder export
- [x] Create `src/extensions/discovery.ts` with placeholder export
- [x] Create `src/extensions/manager.ts` with placeholder export
- [x] Create `src/extensions/settings-schema.ts` with placeholder export
- [x] Create `src/extensions/param-schema.ts` with placeholder export
- [x] Create `src/extensions/runtime-context.ts` with placeholder export
- [x] Create `src/extensions/watcher.ts` with placeholder export

---

## Phase 1: Types & Data Model

### EXT-003 — Define extension types

**File:** `src/extensions/types.ts`

Define all shared types for the extension system. Reference existing types:
- `ToolPathParam` from `src/tool-config/types.ts:99-104` (`{ paramName: string; namespace: PathNamespace }`)
- `ToolResult` from `src/types.ts:174-214`
- `Tool` interface from `src/tools/tool.ts:71-91`

- [ ] Define `ExtensionType = "tool" | "automation" | "settings"` discriminator
- [ ] Define `UserToolDefinition` interface:
  - `filePath: string` — vault-relative source path
  - `name: string` — from frontmatter `notor-tool-name`
  - `description: string` — from frontmatter `notor-description`
  - `mode: "read" | "write"` — from frontmatter `notor-mode`
  - `params: ParamSchema` — parsed from YAML fence `params` block
  - `pathParams: ToolPathParam[]` — extracted from params with `path_namespace`
  - `settingsSchema: SettingsFieldSchema[] | null` — from YAML fence `settings` block
  - `rawCode: string` — TypeScript/JavaScript code from code fence
  - `compiledFn: CompiledExtensionFn | null` — null until compilation succeeds
- [ ] Define `AutomationTrigger` union type — LLM lifecycle (`pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`) + vault events (`on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule`)
- [ ] Define `UserAutomationDefinition` interface:
  - `filePath: string`
  - `displayName: string | null` — from `notor-display-name`
  - `trigger: AutomationTrigger` — from `notor-trigger`
  - `schedule: string | null` — cron expression, required when trigger is `on_schedule`
  - `toolFilter: string[] | null` — from `notor-tools`
  - `order: number` — from `notor-automation-order`, default 0
  - `settingsSchema: SettingsFieldSchema[] | null`
  - `rawCode: string`
  - `compiledFn: CompiledExtensionFn | null`
- [ ] Define `SharedSettingsDefinition` interface:
  - `filePath: string` — always `notor/settings.md`
  - `settingsSchema: SettingsFieldSchema[]`
- [ ] Define `SettingsFieldSchema` interface:
  - `key: string` — YAML key name
  - `name: string` — human-readable label for UI
  - `type: "string" | "number" | "boolean" | "string[]"` — value type
  - `description?: string` — sub-text for UI
  - `default?: string | number | boolean | string[]`
  - `secret?: boolean` — if true, use SecretStorage
  - `min?: number` — number type only
  - `max?: number` — number type only
  - `options?: string[]` — string type only, renders as dropdown
- [ ] Define `ParamSchema` interface — `Record<string, { type: string; description?: string; default?: unknown; enum?: string[]; items?: { type: string }; path_namespace?: "vault" | "filesystem" }>`
- [ ] Define `CompiledExtensionFn = (...args: unknown[]) => Promise<unknown>`
- [ ] Define `ExtensionError` interface — `{ filePath: string; message: string }`
- [ ] Define `ExtensionReloadResult` interface — `{ toolCount: number; automationCount: number; builtinOverrides: string[]; errors: ExtensionError[] }`
- [ ] Export all types

### EXT-004 — Add NotorSettings fields

**Files:** `src/settings/types.ts`, `src/settings/defaults.ts`

Add the two new settings fields for extension data persistence. Follow the existing pattern — settings are organized by phase/feature group with doc comments.

- [ ] Add to `NotorSettings` interface in `src/settings/types.ts` (after sub-agent settings block ~line 339, before settings UI state):
  - `user_extension_settings: Record<string, Record<string, string | number | boolean | string[]>>` — per-extension settings keyed by extension name then setting key
  - `user_shared_settings: Record<string, string | number | boolean | string[]>` — global shared settings keyed by setting key
- [ ] Add defaults in `src/settings/defaults.ts` `createDefaultSettings()`:
  - `user_extension_settings: {}`
  - `user_shared_settings: {}`

---

## Phase 2: Parsing Pipeline

### EXT-005 — Implement Markdown parser

**File:** `src/extensions/parser.ts`

Parse extension Markdown files: extract frontmatter, YAML code fence, and TS/JS code fence. Follow the pattern from `src/sub-agents/discovery.ts` (reads file content, extracts frontmatter from metadata cache or manual YAML, parses structured data).

- [ ] Implement `extractYamlFence(content: string): string | null`
  - Match the first `` ```yaml `` fenced code block
  - Use regex: `` /^```yaml\s*\n([\s\S]*?)^```\s*$/gm ``
  - Return inner content or null if not found
  - Handle edge cases: empty fences, multiple fences (take first only)
- [ ] Implement `extractCodeFence(content: string): { code: string; lang: string } | null`
  - Match the first `` ```ts ``, `` ```typescript ``, `` ```js ``, or `` ```javascript `` fence
  - Use regex: `` /^```(ts|typescript|js|javascript)\s*\n([\s\S]*?)^```\s*$/gm ``
  - Return `{ code, lang }` or null
- [ ] Implement `parseExtensionFile(content: string, frontmatter: Record<string, unknown>, filePath: string, parseYAML: (yaml: string) => unknown): UserToolDefinition | UserAutomationDefinition | SharedSettingsDefinition | ExtensionError`
  - Read `notor-type` from frontmatter — must be `"tool"`, `"automation"`, or `"settings"`
  - Extract YAML fence → parse with `parseYAML()` for `params` and `settings` blocks
  - Extract code fence → raw code string
  - Dispatch to type-specific parsing based on `notor-type`
- [ ] Implement tool parsing branch:
  - Validate required frontmatter: `notor-tool-name` (string), `notor-description` (string), `notor-mode` (`"read" | "write"`)
  - Code fence is required — return error if missing
  - Parse `params` from YAML fence (required) via `ParamSchema` type
  - Parse `settings` from YAML fence (optional) via settings schema parser
  - Extract `pathParams` from params with `path_namespace` field
  - Return `UserToolDefinition`
- [ ] Implement automation parsing branch:
  - Validate required frontmatter: `notor-trigger` (must be valid `AutomationTrigger` value)
  - Code fence is required — return error if missing
  - Parse optional fields: `notor-schedule` (required when trigger is `on_schedule`), `notor-tools` (string array), `notor-display-name` (string), `notor-automation-order` (number, default 0)
  - Parse `settings` from YAML fence (optional)
  - Return `UserAutomationDefinition`
- [ ] Implement settings parsing branch:
  - YAML fence with `settings` block is required
  - No code fence needed
  - Return `SharedSettingsDefinition`
- [ ] Return `ExtensionError` with file path and descriptive message for any validation failure

### EXT-006 — Implement param schema converter

**File:** `src/extensions/param-schema.ts`

Convert simplified YAML param schema to JSON Schema for LLM tool definitions. Reference `JSONSchema` type from `src/tools/tool.ts:37-55`.

- [ ] Implement `paramSchemaToJsonSchema(params: ParamSchema): JSONSchema`
  - Create `{ type: "object", properties: {}, required: [] }` wrapper
  - For each param entry, map to JSON Schema property:
    - `type: "string"` → `{ type: "string" }`
    - `type: "number"` → `{ type: "number" }`
    - `type: "boolean"` → `{ type: "boolean" }`
    - `type: "string[]"` → `{ type: "array", items: { type: "string" } }`
  - Pass through `description` and `default` fields
  - Map `enum` field to JSON Schema `enum`
  - Strip `path_namespace` (consumed by runtime, not sent to LLM)
  - Params without `default` are added to `required[]`
- [ ] Implement `extractPathParams(toolName: string, params: ParamSchema): ToolPathParam[]`
  - For each param with `path_namespace` field:
    - Create `{ paramName: key, namespace: param.path_namespace }` (note: `path_namespace` in YAML maps to `namespace` in `ToolPathParam` — drop the `path_` prefix)
  - Import `ToolPathParam` from `src/tool-config/types.ts`

### EXT-007 — Implement settings schema parser

**File:** `src/extensions/settings-schema.ts`

Parse and resolve extension settings. Reference:
- `getSecret()` from `src/utils/secrets.ts:44-63` (synchronous)
- `setSecret()` from `src/utils/secrets.ts:72-82` (synchronous)
- SecretStorage ID constraint: lowercase alphanumeric with dashes

- [ ] Implement `parseSettingsSchema(yamlSettings: Record<string, unknown>): { schemas: SettingsFieldSchema[]; errors: string[] }`
  - Each key in the YAML object becomes a `SettingsFieldSchema` entry with `key` set to the YAML key name
  - Validate required properties: `name` (string) and `type` (one of `"string" | "number" | "boolean" | "string[]"`)
  - Validate optional properties match expected types
  - Collect validation errors with descriptive messages
- [ ] Implement `resolveSettings(schemas: SettingsFieldSchema[], extensionName: string, persistedValues: Record<string, string | number | boolean | string[]>, app: App): { values: Record<string, unknown>; missing: string[] }`
  - **Synchronous function** — `getSecret()` and settings access are both sync
  - For each schema field:
    - If `secret: true`: read from SecretStorage via `getSecret(app, slugifySecretId("notor-ext", extensionName, field.key))`
    - Else: read from `persistedValues[field.key]`
    - Fall back to `field.default` if no persisted value
    - If no default and no persisted value → add to `missing[]`
  - Always reads from live `plugin.settings` reference (no caching)
- [ ] Implement `resolveSharedSettings(schemas: SettingsFieldSchema[], persistedValues: Record<string, string | number | boolean | string[]>, app: App): { values: Record<string, unknown>; missing: string[] }`
  - Same logic as `resolveSettings` but uses shared secret ID convention: `notor-shared-{key}`
- [ ] Implement `slugifySecretId(...parts: string[]): string`
  - Join parts with `-`, convert to lowercase, replace non-alphanumeric-dash chars with `-`, collapse consecutive dashes
  - Example: `slugifySecretId("notor-ext", "Custom Search", "api_key")` → `"notor-ext-custom-search-api-key"`
  - Satisfies SecretStorage constraint: "ID must be lowercase alphanumeric with dashes"

---

## Phase 3: Compilation Pipeline

### EXT-008 — Implement type stripping with Sucrase

**File:** `src/extensions/compiler.ts`

- [ ] Implement `stripTypes(code: string): string`
  - Import `{ transform }` from `"sucrase"`
  - Call `transform(code, { transforms: ["typescript"] })` — no JSX, no imports transform
  - Return `result.code`
- [ ] Implement error handling for Sucrase failures:
  - Catch Sucrase errors (syntax errors in user code)
  - Return descriptive error message including the original error message and file context
  - Handle common TS patterns: type annotations, interfaces, generics, `as` casts, type-only imports (stripped to empty)

### EXT-009 — Implement AsyncFunction compilation

**File:** `src/extensions/compiler.ts`

- [ ] Obtain `AsyncFunction` constructor: `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor`
- [ ] Implement `compileToolFunction(strippedCode: string): CompiledExtensionFn`
  - Arguments: `"app", "obsidian", "utils", "libs", "settings", "shared", "params"`
  - Return `new AsyncFunction(...argNames, strippedCode)`
- [ ] Implement `compileAutomationFunction(strippedCode: string): CompiledExtensionFn`
  - Arguments: `"app", "obsidian", "utils", "libs", "settings", "shared", "context"`
  - Return `new AsyncFunction(...argNames, strippedCode)`
- [ ] Implement `compileExtension(rawCode: string, type: "tool" | "automation"): { fn: CompiledExtensionFn } | { error: string }`
  - Pipeline: `stripTypes()` → `compile*Function()`
  - Catch compilation errors (syntax errors surviving type stripping) — return descriptive error with file path
- [ ] Handle error cases:
  - Sucrase transform failure → descriptive error
  - AsyncFunction constructor failure (runtime syntax error) → descriptive error

### EXT-010 — Build injected context objects

**File:** `src/extensions/runtime-context.ts`

Assemble the `utils`, `libs`, and `obsidian` objects passed to extensions at runtime. Reference existing utilities:
- `resolveNote` from `src/utils/resolve-note.ts:21-41`
- `StaleContentTracker` from `src/chat/stale-tracker.ts:33-142`
- `CheckpointManager` from `src/checkpoints/checkpoint.ts:25-231`
- `NoteOpener` from `src/tools/note-opener.ts:29-97`
- `logger` from `src/utils/logger.ts:83-90`
- `resolveAndValidatePath` from `src/utils/path-validation.ts:64-100`
- `executeShellCommand` from `src/shell/shell-executor.ts:72-76`
- `enforcePathConstraints` from `src/tool-config/path-enforcer.ts:64-93`
- `isPathWithin` from `src/utils/path-validation.ts:27-41`

- [ ] Implement `buildUtils(plugin: NotorPlugin)` returning:
  - `resolveNote`: `(path) => resolveNote(path, plugin.app.vault, plugin.app.metadataCache)`
  - `staleTracker`: `plugin.getStaleTracker()`
  - `checkpointManager`: `plugin.getCheckpointManager()`
  - `noteOpener`: `plugin.getNoteOpener()`
  - `logger`: `(name) => logger(\`ext:${name}\`)`
  - `resolveAndValidatePath`: `(path, allowedPaths?) => resolveAndValidatePath(path, plugin.vaultRootPath, allowedPaths ?? plugin.settings.read_file_allowed_paths)`
  - `executeShellCommand`: `(cmd, opts?) => executeShellCommand(cmd, plugin.settings, opts)`
  - `pathEnforcer`: `{ enforcePathConstraints, isPathWithin }` — wrappers around the dispatch-time functions
  - Note: `abortSignal` is NOT included here — it's per-call only, merged by `UserToolAdapter.execute()`
- [ ] Implement `buildLibs()` returning:
  - `mammoth` — static import from `"mammoth"`
  - `Turndown` — static import of `TurndownService` from `"turndown"`
  - `turndownGfm` — `{ gfm }` from `"turndown-plugin-gfm"`
  - `unpdf` — lazy wrapper: `() => import("unpdf")` (preserves deferred loading pattern from `src/media/pdf-processor.ts`)
  - `docx` — static import of `* as docx` from `"docx"`
  - `PizZip` — static import from `"pizzip"`
  - `marked` — `{ marked }` from `"marked"`
  - `xmldom` — `* as xmldom` from `"@xmldom/xmldom"`
  - `croner` — `{ Cron }` from `"croner"`
- [ ] Implement `buildObsidianExports()` returning commonly needed `obsidian` module exports:
  - `requestUrl`, `Notice`, `TFile`, `TFolder`, `getFrontMatterInfo`, `normalizePath`, `MarkdownView`
  - Import from `"obsidian"` module

---

## Phase 4: Discovery & Extension Manager

### EXT-011 — Implement discovery

**File:** `src/extensions/discovery.ts`

Follow patterns from `src/sub-agents/discovery.ts` (async, uses vault API) and `src/workflows/workflow-discovery.ts` (normalizes `notorDir`, collects `.md` files).

- [ ] Implement `discoverExtensions(vault: Vault, metadataCache: MetadataCache, notorDir: string, parseYAML: (yaml: string) => unknown): Promise<{ tools: UserToolDefinition[]; automations: UserAutomationDefinition[]; sharedSettings: SharedSettingsDefinition | null; errors: ExtensionError[] }>`
  - Normalize `notorDir`: `const baseDir = notorDir.replace(/\/$/, "")`
  - Scan `{baseDir}/tools/` for `.md` files — use `vault.getAbstractFileByPath()` then iterate children
  - For each file: read content via `vault.read(file)`, get frontmatter from `metadataCache.getFileCache(file)?.frontmatter` (fall back to manual YAML parsing), call `parseExtensionFile()`
  - Scan `{baseDir}/automations/` for `.md` files — same pattern
  - Check for `{baseDir}/settings.md` — if exists and has `notor-type: settings`, parse shared settings
  - Handle missing directories gracefully (not an error — just empty results)
  - Handle malformed files: log error via `logger("ExtensionDiscovery")`, add to errors array, skip file, continue
- [ ] Sort automations by `order` (ascending), then alphabetically by filename for ties
- [ ] Return aggregated results with all errors

### EXT-012 — Implement ExtensionManager

**File:** `src/extensions/manager.ts`

Central manager class orchestrating discovery, compilation, registration, and reload. Reference:
- `ToolRegistry` from `src/tools/index.ts:23-174` — `register()`, `unregister()`, `has()` methods
- `ToolDispatcher` from `src/chat/dispatcher.ts:81-597` — `registerTool()`, `unregisterTool()` methods
- `DispatchableTool` from `src/chat/dispatcher.ts:58-63` — subset interface `{ name, mode, execute }`
- `TOOL_PATH_PARAMS` from `src/tool-config/path-enforcer.ts:27-48` — mutable `Record<string, ToolPathParam[]>`
- `Tool` interface from `src/tools/tool.ts:71-91` — `{ name, description, input_schema, mode, execute }`
- `ToolResult` from `src/types.ts:174-214`
- `ToolExecuteOptions` from `src/tools/tool.ts:25-32` — has `abortSignal?: AbortSignal`

- [ ] Implement `ExtensionManager` class:
  - Fields: `tools: Map<string, UserToolDefinition>`, `automations: Map<string, UserAutomationDefinition>`, `sharedSettings: SharedSettingsDefinition | null`, `compiledLibs` (lazily built), `registeredToolNames: Set<string>` (tracks names for cleanup on reload)
  - Constructor: `(plugin: NotorPlugin, parseYAML: (yaml: string) => unknown)` — derives `app`, `vault`, `metadataCache`, `settings` from plugin
- [ ] Implement `async reload(isInitialLoad: boolean): Promise<ExtensionReloadResult>`:
  1. Call `discoverExtensions()` with `plugin.app.vault`, `plugin.app.metadataCache`, `plugin.settings.notor_dir`, `parseYAML`
  2. Compile each tool: `stripTypes()` → `compileToolFunction()`. Store in `this.tools`. Skip on error (add to errors)
  3. Compile each automation: `stripTypes()` → `compileAutomationFunction()`. Store in `this.automations`. Skip on error
  4. Parse shared settings from discovery result
  5. **Unregister** previous user tools: for each name in `registeredToolNames`, call `registry.unregister(name)`, `delete TOOL_PATH_PARAMS[name]`, and if `!isInitialLoad` also call `dispatcher.unregisterTool(name)`
  6. **Register** new user tools: for each compiled tool, create `UserToolAdapter`, call `registry.register(adapter)`. If `!isInitialLoad`, also call `dispatcher.registerTool(adapter)`. On initial load, skip dispatcher registration — it doesn't exist yet and will pick up tools from `registry.getAll()` when lazily created
  7. Register path params: for each tool with `pathParams`, set `TOOL_PATH_PARAMS[tool.name] = tool.pathParams`
  8. Update `registeredToolNames` set
  9. Detect built-in overrides: if a user tool name was already in the registry before unregister step → add to `builtinOverrides` and show Notice
  10. Log results and show Notice with summary
  11. Return `ExtensionReloadResult`
- [ ] Implement `UserToolAdapter` class implementing `Tool` interface:
  - Constructor: `(definition: UserToolDefinition, manager: ExtensionManager, plugin: NotorPlugin)`
  - Properties: `name`, `description`, `input_schema` (via `paramSchemaToJsonSchema()`), `mode`
  - `async execute(params, options?): Promise<ToolResult>`:
    1. Resolve settings via `manager.getResolvedSettings(this.definition.name)` (sync)
    2. Check for missing required settings → return error ToolResult if any
    3. Resolve shared settings via `manager.getResolvedSharedSettings()` (sync)
    4. Build utils via `buildUtils(plugin)`, merge `options?.abortSignal` into utils per-invocation
    5. Build libs and obsidian exports (cached on manager)
    6. Record `startTime = Date.now()`
    7. Call `definition.compiledFn(app, obsidian, utils, libs, settings, shared, params)`
    8. Map return value to `ToolResult` — populate `tool_name`, `success`, `result`, `duration_ms`. Pass through `content_blocks` if returned. `tool_call_id` set by dispatcher, NOT adapter
    9. On error: show Notice, log via logger, return `{ tool_name, success: false, error: error.message, duration_ms }`
  - `UserToolAdapter` satisfies `DispatchableTool` via structural typing (Tool is a superset)
- [ ] Implement `getTools(): UserToolDefinition[]`
- [ ] Implement `getAutomationsForTrigger(trigger: AutomationTrigger): UserAutomationDefinition[]`
  - Filter automations by trigger, return sorted by order
- [ ] Implement `getAutomationsForToolEvent(trigger: "on_tool_call" | "on_tool_result", toolName: string): UserAutomationDefinition[]`
  - Filter by trigger AND `toolFilter` (if `toolFilter` is null → matches all tools; if non-null → must include `toolName`)
- [ ] Implement `getResolvedSharedSettings(): Record<string, unknown>` (sync)
- [ ] Implement `getResolvedSettings(extensionName: string): Record<string, unknown>` (sync)
- [ ] Implement `destroy(): void`
  - Unregister all user tools from registry and `TOOL_PATH_PARAMS`
  - Clear internal maps

---

## Phase 5: Automation Dispatch Integration

### EXT-013 — Integrate automations with LLM lifecycle hooks

**File:** `src/hooks/hook-events.ts`

Extend the four dispatch functions to fire matching user automations after shell hooks. Current signatures (all have `overrideManager?` as last param):
- `dispatchPreSend(context: PreSendContext, settings, vaultRootPath, overrideManager?)` — line 296, async/awaited
- `dispatchOnToolCall(context: ToolHookContext, settings, vaultRootPath, overrideManager?)` — line 406, fire-and-forget
- `dispatchOnToolResult(context: ToolHookContext, settings, vaultRootPath, overrideManager?)` — line 489, fire-and-forget
- `dispatchAfterCompletion(context: CompletionContext, settings, vaultRootPath, overrideManager?)` — line 578, fire-and-forget

Use accessor callback pattern — no direct `ExtensionManager` dependency:

```typescript
type GetAutomationsForTrigger = (trigger: AutomationTrigger) => UserAutomationDefinition[];
type GetAutomationsForToolEvent = (trigger: "on_tool_call" | "on_tool_result", toolName: string) => UserAutomationDefinition[];
```

- [ ] Add `getAutomations?: GetAutomationsForTrigger` parameter to `dispatchPreSend()` signature (after `overrideManager`)
  - After existing shell hook execution, get automations: `const automations = getAutomations?.("pre_send") ?? []`
  - Execute sequentially (pre_send is inherently blocking/awaited)
  - Build context: `{ hookEvent: "pre_send", timestamp: context.timestamp, conversationId: context.conversationId }`
  - Invoke compiled function with `(app, obsidian, utils, libs, settings, shared, automationCtx)` — but automations don't have per-call app/utils. Instead, the automation's `compiledFn` is called with context built by the dispatch function. The `app`, `obsidian`, `utils`, `libs`, `settings`, `shared` must be provided by the caller or built inline. **Design note:** The accessor pattern returns `UserAutomationDefinition[]` which contain `compiledFn` but NOT the runtime context objects. The dispatch functions need access to `app`, `obsidian`, `utils`, `libs` to invoke automations. **Solution:** Add a second accessor `executeAutomation?: (automation: UserAutomationDefinition, context: Record<string, unknown>) => Promise<unknown>` that encapsulates the runtime context building. OR: pass the execution through the manager. **Simplest approach:** Add `executeAutomation` callback alongside `getAutomations`
  - Collect returned strings from pre_send automations and append to stdout array
  - Wrap each automation in try/catch — Notice + logger on error, continue with next
- [ ] Add `getAutomations?: GetAutomationsForToolEvent` parameter to `dispatchOnToolCall()` signature
  - Inside the existing fire-and-forget IIFE, after shell hooks, get automations: `getAutomations?.("on_tool_call", context.toolName) ?? []`
  - Execute sequentially in order
  - Build context: `{ hookEvent: "on_tool_call", timestamp: context.timestamp, conversationId: context.conversationId, toolName: context.toolName, params: context.toolParams }`
  - Wrap in try/catch per automation
- [ ] Add `getAutomations?: GetAutomationsForToolEvent` parameter to `dispatchOnToolResult()` signature
  - Same pattern as `dispatchOnToolCall`
  - Build context: `{ hookEvent: "on_tool_result", timestamp: context.timestamp, conversationId: context.conversationId, toolName: context.toolName, params: context.toolParams, result: context.toolResult, status: context.toolStatus }`
- [ ] Add `getAutomations?: GetAutomationsForTrigger` parameter to `dispatchAfterCompletion()` signature
  - Same fire-and-forget pattern
  - Build context: `{ hookEvent: "after_completion", timestamp: context.timestamp, conversationId: context.conversationId }`
- [ ] Define the automation execution callback type and integrate with dispatch functions. Two options (pick one during implementation):
  - **Option A (accessor pair):** `getAutomations` returns definitions, `executeAutomation(automation, context)` invokes with runtime objects
  - **Option B (single executor):** `dispatchAutomations(trigger, context)` does both lookup and execution
  - Either way, the hook module must NOT import from extensions module — keep the boundary clean via callbacks

### EXT-014 — Integrate automations with vault event hooks

**Files:**
- `src/hooks/vault-event-dispatcher.ts` — add automation dispatch step
- `src/hooks/vault-event-listener-manager.ts` — add setter + update `hasActiveHooks()`
- `src/hooks/vault-event-scheduler.ts` — add setter + automation schedule support
- `src/hooks/vault-event-handlers.ts` — no changes needed (accessor flows through `DispatcherDeps`)

- [ ] Add `getExtensionAutomations?: (trigger: AutomationTrigger) => UserAutomationDefinition[]` to `DispatcherDeps` interface in `vault-event-dispatcher.ts:46-65`
- [ ] Add automation dispatch step in `dispatchVaultEventHooks()` (after line ~132):
  - After the existing hook/workflow loop, get automations via `deps.getExtensionAutomations`
  - Map vault event type to `AutomationTrigger` (they use the same string values)
  - Build vault event context objects per event type:
    - `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`: `{ hookEvent, timestamp, notePath }`
    - `on_tag_change`: `{ hookEvent, timestamp, notePath, tagsAdded, tagsRemoved }`
    - `on_schedule`: `{ hookEvent, timestamp, schedule }`
  - Execute within the same `chain` context (for `ExecutionChainTracker.shouldSkipHook()`)
  - Wrap in independent try/catch block (separate from hook/workflow loop error handling)
  - Each individual automation also gets its own try/catch
- [ ] Add `setExtensionAutomations(accessor: (trigger: AutomationTrigger) => UserAutomationDefinition[])` setter on `VaultEventListenerManager` (NOT a constructor param — manager is constructed before extensions are discovered)
  - Store the accessor function
  - Update `hasActiveHooks()` (line ~331): alongside existing checks, call the stored accessor with the specific vault event type and check if result is non-empty
  - **Type note:** `hasActiveHooks()` accepts `VaultEventHookType` but accessor accepts `AutomationTrigger` — works at runtime (strings are strings), `getAutomationsForTrigger()` returns `[]` for non-matching triggers
- [ ] Add `setExtensionAutomations(accessor)` setter on `VaultEventScheduler`
  - Separate from existing `setDispatch()` setter (each data source has its own injection point)
  - Update `syncJobs()` (line ~108): add parallel loop for automation `on_schedule` entries
  - Job ID convention: `ext-auto:{filePath}` (e.g., `ext-auto:notor/automations/daily-cleanup.md`) to avoid collisions with hook UUIDs and workflow IDs in the `desiredJobs` map
- [ ] Also need an automation executor callback for vault event automations (same pattern as EXT-013 — the dispatch function needs to invoke the compiled function with runtime context objects)

---

## Phase 6: Settings UI

### EXT-015 — Create extensions settings section

**File:** `src/settings/sections/extensions.ts` (new)

Follow existing section patterns from `src/settings/sections/` (30 files). Reference:
- `createSettingsGroup()` from `src/settings/helpers.ts:83-108`
- `SettingsContext` from `src/settings/sections/context.ts:16-24`
- `SecretComponent` from `obsidian` (see usage in `src/settings/sections/provider-anthropic.ts:7-29`)
- Dynamic list pattern from `src/settings/sections/fetch-webpage.ts:82-139` (domain_denylist)

- [ ] Implement `renderExtensionsSection(containerEl: HTMLElement, ctx: SettingsContext): void`
  - Get extension manager from `ctx.plugin.getExtensionManager()`
  - Collect all extensions with settings schemas (tools, automations, shared)
  - If nothing to show (no settings and no shared settings), hide section entirely
- [ ] Implement shared settings sub-section (if `notor/settings.md` exists with settings):
  - Heading: "Shared settings"
  - Render each `SettingsFieldSchema` using the appropriate UI component
- [ ] Implement per-extension settings sub-sections:
  - One sub-section per tool/automation that has a `settings` block
  - Heading: "Tool: {name}" or "Automation: {displayName || filename}"
  - Render each field using the appropriate UI component
  - "Reset to defaults" button: clears `user_extension_settings[name]`, calls `saveSettings()` + `redisplay()`
- [ ] Implement field rendering for all 6 type variants:
  - `type: string` + no `options` → `Setting.addText()` with onChange saving to `user_extension_settings[extName][key]`
  - `type: string` + `secret: true` → `SecretComponent` with ID from `slugifySecretId()`
  - `type: string` + `options` → `Setting.addDropdown()` with options from schema
  - `type: number` → `Setting.addText()` with numeric validation, respect `min`/`max`
  - `type: boolean` → `Setting.addToggle()`
  - `type: string[]` → dynamic list with add/remove pattern (from fetch-webpage domain_denylist)
- [ ] Implement "Reload extensions" button at bottom of section:
  - Calls `extensionManager.reload(false)`, shows Notice with summary, calls `redisplay()`
- [ ] Wire into `src/settings/settings-tab.ts` render pipeline:
  - Add new settings group in `display()` method (after "Automation" group, before "Storage")
  - Use `createSettingsGroup(containerEl, "Extensions", false, persisted, onToggle)`
  - Call `renderExtensionsSection(groupBody, settingsContext)`

### EXT-016 — Register reload command

**File:** `src/main.ts`

- [ ] Register command `notor:reload-extensions` in `onload()` (near other command registrations, lines ~248-314):
  ```typescript
  this.addCommand({
    id: "reload-extensions",
    name: "Reload user extensions",
    callback: async () => {
      const result = await this.getExtensionManager().reload(false);
      new Notice(`Extensions reloaded: ${result.toolCount} tools, ${result.automationCount} automations` +
        (result.errors.length > 0 ? ` (${result.errors.length} errors)` : ""));
    },
  });
  ```

---

## Phase 7: Plugin Wiring & Lifecycle

### EXT-017 — Wire ExtensionManager into plugin lifecycle

**File:** `src/main.ts`

Follow existing lazy accessor patterns (lines 907-1228). Reference init sequence in `onLayoutReady()` (line ~423) and cleanup in `onunload()` (line ~435).

- [ ] Add `vaultRootPath` getter to `NotorPlugin`:
  - `get vaultRootPath(): string { return (this.app.vault.adapter as { basePath?: string }).basePath ?? ""; }`
  - Consolidates the `basePath` cast that appears at lines 578, 701, 1075, 1111
- [ ] Add lazy accessor `getExtensionManager()`:
  - Field: `private _extensionManager: ExtensionManager | null = null`
  - Pattern: check null → create `new ExtensionManager(this, parseYaml)` → return
  - Import `parseYaml` from `"obsidian"` (already imported at line 11)
- [ ] Wire initial `reload(true)` into `onLayoutReady()`:
  - After existing workflow discovery + vault watcher registration
  - Call `await this.getExtensionManager().reload(true)` — `isInitialLoad: true` skips dispatcher registration
  - After reload, call `evaluateListeners()` again on vault event listener manager to pick up automation vault event triggers
- [ ] Add `setExtensionAccessors()` method to `ChatOrchestrator`:
  - Store accessors: `{ getForTrigger, getForToolEvent, executeAutomation }` (exact shape depends on EXT-013 design choice)
  - Follow existing `setPersonaManager()` (line 171) and `setWorkflowHookOverrideManager()` (line 183) patterns
- [ ] Call `orchestrator.setExtensionAccessors()` in `main.ts` after creating extension manager:
  ```typescript
  const mgr = this.getExtensionManager();
  orchestrator.setExtensionAccessors({
    getForTrigger: (t) => mgr.getAutomationsForTrigger(t),
    getForToolEvent: (t, n) => mgr.getAutomationsForToolEvent(t, n),
  });
  ```
- [ ] Pass stored accessors through to ALL dispatch call sites in orchestrator:
  - **Static import sites (foreground `responseLoop`):**
    - `dispatchPreSend()` at orchestrator line ~1240 — add accessor param
    - `dispatchAfterCompletion()` at orchestrator line ~1693 (via `dispatchAfterCompletionHooks()`) — add accessor param
  - **Dynamic import sites (foreground `responseLoop`):**
    - `dispatchOnToolCall()` at orchestrator line ~1496 — add accessor param
    - `dispatchOnToolResult()` at orchestrator line ~1608 — add accessor param
  - **Dynamic import sites (background `_backgroundResponseLoop`):**
    - `dispatchOnToolCall()` at orchestrator line ~966 — add accessor param
    - `dispatchOnToolResult()` at orchestrator line ~981 — add accessor param
  - **Private wrapper:**
    - `dispatchAfterCompletionHooks()` at orchestrator line ~1688 — accept and forward accessor
- [ ] Wire `getExtensionAutomations` accessor into vault event `DispatcherDeps`:
  - In `main.ts` where `getDispatcherDeps()` closure is built (within `_initVaultEventHooks()`, line ~578)
  - Add `getExtensionAutomations: (trigger) => this.getExtensionManager().getAutomationsForTrigger(trigger)` to deps object
- [ ] Call `setExtensionAutomations()` on `VaultEventListenerManager`:
  - Wire before `onLayoutReady` calls `evaluateListeners()`
  - Accessor returns empty array until extensions are loaded
  - After `reload()` completes, call `evaluateListeners()` again to register listeners for new automation vault event triggers
- [ ] Call `setExtensionAutomations()` on `VaultEventScheduler`:
  - Wire similarly to how `setDispatch()` is called
  - Scheduler will pick up `on_schedule` automations in `syncJobs()`
- [ ] Wire `extensionManager.destroy()` into `onunload()` (line ~435):
  - Add `this._extensionManager?.destroy()` in cleanup sequence
  - Includes `TOOL_PATH_PARAMS` cleanup
- [ ] Ensure reload ordering: built-in tools → user tools → MCP tools (MCP is async and independent)

### EXT-024 — Extension file watcher with reload Notice

**File:** `src/extensions/watcher.ts` (helper functions) + `src/main.ts` (registration)

Follow the workflow vault watcher pattern from `main.ts:1335-1358` with `scheduleWorkflowRescan()` debounce at `main.ts:1314-1326`.

- [ ] Add class fields to `NotorPlugin`:
  - `private _extensionChangeTimer: ReturnType<typeof setTimeout> | null = null`
  - `private _extensionStaleNotice: Notice | null = null`
- [ ] Implement path matching helpers on `NotorPlugin` (or in `src/extensions/watcher.ts`):
  - `isExtensionToolFile(file)`: `file.path.startsWith(\`${this.settings.notor_dir}tools/\`) && file.path.endsWith(".md")`
  - `isExtensionAutomationFile(file)`: `file.path.startsWith(\`${this.settings.notor_dir}automations/\`) && file.path.endsWith(".md")`
  - `isExtensionSettingsFile(file)`: `file.path === \`${this.settings.notor_dir}settings.md\``
  - `isExtensionFile(file)`: any of the above
- [ ] Implement `scheduleExtensionChangeNotice()`:
  - Clear any pending debounce timer
  - Set new timer with 1000ms delay (longer than workflow watcher's 300ms — Notice-only, no auto-reload)
  - On fire: check duplicate Notice suppression via `_extensionStaleNotice` reference
  - Show persistent Notice (duration `0`): "Extension files changed. Reload extensions to apply updates."
  - Add click handler on Notice to trigger `this.getExtensionManager().reload(false)` directly
  - Clear Notice reference on successful reload
- [ ] Implement `registerExtensionVaultWatcher()` in `main.ts`:
  - Register four event listeners (same as workflow watcher pattern):
    - `this.registerEvent(this.app.vault.on("create", (file) => { if (this.isExtensionFile(file)) this.scheduleExtensionChangeNotice(); }))`
    - `this.registerEvent(this.app.vault.on("delete", (file) => { ... }))`
    - `this.registerEvent(this.app.vault.on("rename", (file, oldPath) => { ... }))` — check both new and old paths
    - `this.registerEvent(this.app.metadataCache.on("changed", (file) => { ... }))` — frontmatter changes
- [ ] Clear timer and Notice in `onunload()`:
  - `if (this._extensionChangeTimer !== null) clearTimeout(this._extensionChangeTimer)`
  - `this._extensionStaleNotice?.hide()`
- [ ] Register watchers in `onLayoutReady()` after initial extension discovery

---

## Phase 8: Error Handling & Validation

### EXT-018 — Implement runtime error handling

Augment `src/extensions/manager.ts` with comprehensive error handling.

- [ ] Implement try/catch in `UserToolAdapter.execute()`:
  - **On error:** 3 channels:
    1. Notice: `new Notice(\`Extension error in ${this.name}: ${error.message}\`)`
    2. ToolResult: `{ tool_name: this.name, success: false, error: error.message, duration_ms }`
    3. Logger: `log.error("User tool execution failed", { tool: this.name, error: String(error), stack: error.stack })`
- [ ] Implement try/catch in automation execution paths (EXT-013/014):
  - **On error:** 2 channels:
    1. Notice: `new Notice(\`Automation error in ${displayName}: ${error.message}\`)`
    2. Logger: `log.error("User automation execution failed", { automation: displayName, trigger, error: String(error), stack: error.stack })`
- [ ] Implement compilation error reporting in `reload()`:
  - Display Notice: `"Extension '{name}' failed to compile: {error}"`
  - Log with full details
  - Skip extension (don't register), continue loading others
- [ ] Implement required settings validation before execution:
  - Tool: check `resolveSettings()` for `missing` array — return `{ success: false, error: "Tool 'X' requires setting 'Y' to be configured in Settings." }`
  - Automation: check `resolveSettings()` — show Notice with same message, skip execution

---

## Phase 9: Testing

### EXT-019 — Unit tests for parsing pipeline

**File:** `src/extensions/__tests__/parser.test.ts`

- [ ] Test: valid tool file parses correctly (frontmatter + YAML fence + code fence)
- [ ] Test: valid automation file parses correctly with all optional fields
- [ ] Test: valid settings file parses correctly
- [ ] Test: missing `notor-type` field returns error
- [ ] Test: invalid `notor-type` value returns error
- [ ] Test: missing required tool frontmatter fields (`notor-tool-name`, `notor-description`, `notor-mode`) returns errors
- [ ] Test: missing required automation frontmatter (`notor-trigger`) returns error
- [ ] Test: missing code fence returns error for tools and automations
- [ ] Test: missing YAML fence settings block returns error for settings type
- [ ] Test: YAML fence parsing with `params` and `settings` blocks
- [ ] Test: code fence extraction with all language tags (ts, typescript, js, javascript)
- [ ] Test: multiple fences — only first of each type is extracted
- [ ] Test: prose outside fences is ignored
- [ ] Test: `notor-automation-order` defaults to 0 when not specified
- [ ] Test: `on_schedule` trigger requires `notor-schedule` field

### EXT-020 — Unit tests for param schema conversion

**File:** `src/extensions/__tests__/param-schema.test.ts`

- [ ] Test: basic types (string, number, boolean) convert to correct JSON Schema
- [ ] Test: `string[]` converts to `{ type: "array", items: { type: "string" } }`
- [ ] Test: params with `default` are NOT in `required[]`
- [ ] Test: params without `default` ARE in `required[]`
- [ ] Test: `enum` field maps to JSON Schema `enum`
- [ ] Test: `description` passes through correctly
- [ ] Test: `path_namespace` is stripped from JSON Schema output
- [ ] Test: `extractPathParams()` extracts entries with `path_namespace` correctly
- [ ] Test: `extractPathParams()` returns empty array when no path params
- [ ] Test: empty params object produces valid empty schema

### EXT-021 — Unit tests for compilation pipeline

**File:** `src/extensions/__tests__/compiler.test.ts`

- [ ] Test: TypeScript type annotations are stripped (e.g., `const x: string = "hello"`)
- [ ] Test: interface declarations are stripped
- [ ] Test: `as` casts are stripped (e.g., `const x = foo as string`)
- [ ] Test: generic type parameters are stripped
- [ ] Test: plain JavaScript code passes through unchanged
- [ ] Test: compiled tool function is callable with 7 arguments (app, obsidian, utils, libs, settings, shared, params)
- [ ] Test: compiled automation function is callable with 7 arguments (app, obsidian, utils, libs, settings, shared, context)
- [ ] Test: async/await works in compiled code
- [ ] Test: return value is accessible from compiled function
- [ ] Test: Sucrase syntax error produces descriptive error message
- [ ] Test: AsyncFunction constructor syntax error produces descriptive error message

### EXT-022 — Unit tests for settings resolution

**File:** `src/extensions/__tests__/settings-schema.test.ts`

- [ ] Test: schema defaults are used when no persisted values exist
- [ ] Test: persisted values override defaults
- [ ] Test: missing required settings (no default, no persisted) are reported in `missing[]`
- [ ] Test: type validation for string fields
- [ ] Test: type validation for number fields
- [ ] Test: type validation for boolean fields
- [ ] Test: type validation for string[] fields
- [ ] Test: `slugifySecretId()` normalizes to lowercase-alphanumeric-with-dashes
- [ ] Test: `slugifySecretId()` handles special characters and spaces
- [ ] Test: shared settings resolution works independently from per-extension

### EXT-023 — Integration tests

**File:** `src/extensions/__tests__/manager.test.ts`

- [ ] Test: full reload cycle discovers and compiles tools from mock vault files
- [ ] Test: user tool registers in ToolRegistry and is retrievable via `registry.get(name)`
- [ ] Test: user tool with same name as built-in overwrites it (last-write-wins)
- [ ] Test: `UserToolAdapter.execute()` returns valid ToolResult with correct fields
- [ ] Test: `UserToolAdapter.execute()` handles thrown errors gracefully (returns error ToolResult)
- [ ] Test: `getAutomationsForTrigger()` returns automations matching the trigger
- [ ] Test: `getAutomationsForToolEvent()` respects `notor-tools` filter
- [ ] Test: `getAutomationsForToolEvent()` with null filter matches all tools
- [ ] Test: automations execute sequentially in `order` order
- [ ] Test: reload clears previous registrations before re-registering
- [ ] Test: reload reports built-in name collisions in `builtinOverrides`
- [ ] Test: compilation error skips extension but continues loading others
- [ ] Test: missing required settings returns appropriate error ToolResult
- [ ] Test: `destroy()` cleans up registry entries and `TOOL_PATH_PARAMS`

---

## Dependency Graph

```
Phase 0 (EXT-001, EXT-002) — deps install + scaffolding
  |
  v
Phase 1 (EXT-003, EXT-004) — types + settings fields
  |
  v
Phase 2 (EXT-005, EXT-006, EXT-007) — parsing pipeline (parallelizable)
  |
  v
Phase 3 (EXT-008, EXT-009, EXT-010) — compilation pipeline (parallelizable after Phase 2)
  |
  v
Phase 4 (EXT-011, EXT-012) — discovery + manager
  |
  +---------------------------+
  |                           |
  v                           v
Phase 5 (EXT-013, EXT-014)  Phase 6 (EXT-015, EXT-016) — parallelizable
  |                           |
  +-------------+-------------+
                |
                v
Phase 7 (EXT-017, EXT-024) — wiring + watchers
  |
  v
Phase 8 (EXT-018) — error handling hardening
  |
  v
Phase 9 (EXT-019 — EXT-023) — testing
```
