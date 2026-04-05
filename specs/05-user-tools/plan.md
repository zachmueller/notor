# Implementation Plan: Phase 5 — User-Defined Extensions

**Created:** 2026-04-05
**Design Doc:** [design/user-defined-tools.md](../../design/user-defined-tools.md)
**Status:** Complete

## Technical Context

### Architecture Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Extension module | New `src/extensions/` module | Keeps discovery, parsing, compilation, settings, and registration logic isolated from existing modules. Mirrors the pattern of `src/tool-config/`, `src/sub-agents/`, `src/workflows/` |
| File format | Markdown with YAML frontmatter + YAML code fence + TS/JS code fence | Consistent with vault-authored entities (workflows, personas, sub-agents). Prose serves as documentation visible in Obsidian |
| Type stripping | Sucrase (~50KB, new dependency) | Full TS syntax coverage (except `enum`, `namespace`). Regex too fragile for real-world TS. JS-only is worse DX since extension code is TypeScript-first |
| Compilation | `new AsyncFunction(argNames..., strippedCode)` | Extensions use `await` directly. Constructed via `Object.getPrototypeOf(async function(){}).constructor`. Same trust level as plugin code |
| YAML fence parsing | `parseYaml` from `obsidian` module | Already used by sub-agent discovery, tool config parser, workflow hook parser. No new dependency |
| Param schema format | Simplified YAML → JSON Schema conversion | User writes `params.path.type: string`; runtime converts to `{ type: "object", properties: { path: { type: "string" } }, required: [...] }`. Lowers the authoring bar vs. raw JSON Schema |
| Hot reload | Manual only (Settings button + command palette), with file watcher Notices | Avoids compilation during active LLM operations. File watchers on `notor/tools/` and `notor/automations/` show a 1000ms-debounced Notice prompting the user to reload — no auto-recompilation |
| Extension settings storage | Two new `NotorSettings` fields: `user_extension_settings` and `user_shared_settings` | Follows existing patterns. Secrets use `SecretStorage` with ID convention `notor-ext-{name}-{key}` / `notor-shared-{key}`. Extension names and keys are auto-slugified to lowercase-alphanumeric-with-dashes to satisfy `SecretStorage` ID constraints |
| Registration approach | User tools register in `ToolRegistry` via same `register()` method; user automations dispatched via lightweight accessor callbacks injected into existing dispatch functions | Tools integrate fully with existing dispatch pipeline. Automations coexist with shell hooks (not replace). Accessor pattern avoids coupling hook module to extension module |
| Discovery directories | `notor/tools/` and `notor/automations/` and `notor/settings.md` | Follows established `notor/{entity}/` convention. Discovered on plugin load and manual reload |

### Technology Stack

- **Type stripping:** Sucrase (new `devDependency` or `dependency` — bundles into plugin via esbuild)
- **YAML parsing:** `parseYaml` from `obsidian` (already available)
- **Compilation:** `AsyncFunction` constructor (built-in JS)
- **Settings UI:** Obsidian `Setting` API (existing patterns in `src/settings/sections/`)
- **Injected APIs:** References to already-loaded modules (`app`, `obsidian`, bundled libs)

### Integration Points

| Integration | Description |
|---|---|
| `ToolRegistry` | User tools call `register()` — if name matches built-in, it overwrites (last-write-wins). User tools loaded after built-ins so they always take precedence |
| `ToolDispatcher` | User tools registered via `registerTool()` — participate in full dispatch pipeline (Plan/Act, auto-approve, path enforcement, checkpoints, approval UI) |
| `ChatOrchestrator` | User automations fire at the same lifecycle points as shell hooks. `dispatchPreSend`, `dispatchOnToolCall`, `dispatchOnToolResult`, `dispatchAfterCompletion` extended with lightweight accessor callbacks (not full `ExtensionManager` reference) to invoke matching automations |
| `VaultEventListenerManager` | User automations with vault event triggers (`on_note_open`, `on_save`, etc.) register alongside workflow triggers. `evaluateListeners()` extended to include automation triggers |
| `VaultEventDispatcher` | `dispatchVaultEventHooks()` extended to collect and execute matching automations after shell hooks and workflow hooks |
| `SystemPromptBuilder` | Tool definitions include user tools (they're in the registry). No special handling needed — `getToolDefinitions()` / `getFilteredToolDefinitions()` already return all registered tools |
| `NotorSettings` | New fields: `user_extension_settings`, `user_shared_settings`. Settings defaults/merge in `loadSettings()` |
| `SettingsTab` | New "Extensions" settings group with per-extension settings and shared settings sub-sections |
| `main.ts` | New lazy accessor `getExtensionManager()`. Wired into reload command + settings button. Discovery runs on plugin load (`onLayoutReady`) |
| `tool-config/path-enforcer.ts` | `TOOL_PATH_PARAMS` is a `const` plain object (`Record<string, ToolPathParam[]>`). While `const` prevents reassignment, JS allows property mutation on plain objects, so adding/removing entries via `TOOL_PATH_PARAMS[toolName] = [...]` / `delete TOOL_PATH_PARAMS[toolName]` works at runtime. **Note:** No existing code mutates this object — this is a new usage pattern introduced by extensions. User tools declare path params in their YAML fence; the runtime adds/removes entries so `enforcePathConstraints()` applies. The path enforcer functions are also exposed via `utils.pathEnforcer` for extensions to use directly |
| `tool-orchestration.ts` | `partitionToolCalls()` needs to classify user tools. User tools with `mode: "read"` are concurrency-safe; `mode: "write"` are non-concurrent. Same logic as built-in tools |
| `esbuild.config.mjs` | Sucrase added as a bundled dependency (not external) |

---

## Phase 0: Dependencies & Scaffolding

### EXT-001 — Install Sucrase

Add sucrase as a production dependency (bundled by esbuild into the plugin).

**Files modified:** `package.json`, `package-lock.json`

- [x] Add `"sucrase": "^3.35.0"` to `dependencies` in `package.json`
- [x] Run `npm install`
- [x] Run `npm run build` and confirm the bundle compiles without errors
- [x] Verify sucrase's bundle impact is reasonable (~50KB as noted in design doc)

### EXT-002 — Create `src/extensions/` module scaffolding

Create the directory structure for the extensions module.

**Files created:**

```
src/extensions/
  types.ts          — Shared types (UserTool, UserAutomation, ExtensionSettings, etc.)
  parser.ts         — Markdown parsing (frontmatter + YAML fence + code fence extraction)
  compiler.ts       — Type stripping (sucrase) + AsyncFunction compilation
  discovery.ts      — File system scanning of notor/tools/, notor/automations/, notor/settings.md
  manager.ts        — ExtensionManager: discovery + compilation + registration + reload
  settings-schema.ts — Settings schema parsing + resolution (defaults + persisted + secrets)
  param-schema.ts   — YAML param schema → JSON Schema conversion
```

- [x] Create `src/extensions/types.ts` with type stubs
- [x] Create remaining files with module doc comments and placeholder exports

---

## Phase 1: Types & Data Model

### EXT-003 — Define extension types

Define all types for the user-defined extension system.

**File:** `src/extensions/types.ts`

```typescript
/** Discriminator for extension type. */
type ExtensionType = "tool" | "automation" | "settings";

/** Parsed representation of a user-defined tool. */
interface UserToolDefinition {
  /** Source vault-relative file path. */
  filePath: string;
  /** Tool name from frontmatter `notor-tool-name`. */
  name: string;
  /** Description from frontmatter `notor-description`. */
  description: string;
  /** Mode from frontmatter `notor-mode`. */
  mode: "read" | "write";
  /** Parsed param schema from YAML fence `params` block. */
  params: ParamSchema;
  /** Path parameter descriptors for path enforcement (from `params[x].path_namespace`). */
  pathParams: ToolPathParam[];
  /** Parsed settings schema from YAML fence `settings` block (optional). */
  settingsSchema: SettingsFieldSchema[] | null;
  /** Raw TypeScript/JavaScript code from code fence. */
  rawCode: string;
  /** Compiled async function (null until compilation succeeds). */
  compiledFn: CompiledExtensionFn | null;
}

/** Automation trigger — union of LLM lifecycle + vault events. */
type AutomationTrigger =
  | "pre_send"
  | "on_tool_call"
  | "on_tool_result"
  | "after_completion"
  | "on_note_open"
  | "on_note_create"
  | "on_save"
  | "on_manual_save"
  | "on_tag_change"
  | "on_schedule";

/** Parsed representation of a user-defined automation. */
interface UserAutomationDefinition {
  /** Source vault-relative file path. */
  filePath: string;
  /** Display name from frontmatter `notor-display-name`. */
  displayName: string | null;
  /** Trigger event from frontmatter `notor-trigger`. */
  trigger: AutomationTrigger;
  /** Cron expression — required when trigger is `on_schedule`. */
  schedule: string | null;
  /** Tool name filter from frontmatter `notor-tools`. */
  toolFilter: string[] | null;
  /** Execution order from frontmatter `notor-automation-order`. Default 0. */
  order: number;
  // NOTE: `notor-blocking` was removed from the design. All automations are
  // fire-and-forget (except pre_send which is inherently blocking).
  /** Parsed settings schema from YAML fence `settings` block (optional). */
  settingsSchema: SettingsFieldSchema[] | null;
  /** Raw TypeScript/JavaScript code from code fence. */
  rawCode: string;
  /** Compiled async function (null until compilation succeeds). */
  compiledFn: CompiledExtensionFn | null;
}

/** Global shared settings definition. */
interface SharedSettingsDefinition {
  /** Source vault-relative file path (`notor/settings.md`). */
  filePath: string;
  /** Parsed settings schema from YAML fence `settings` block. */
  settingsSchema: SettingsFieldSchema[];
}

/** Settings field schema — mirrors the design doc table. */
interface SettingsFieldSchema {
  /** Setting key (YAML key name). */
  key: string;
  /** Human-readable label for settings UI. */
  name: string;
  /** Value type. */
  type: "string" | "number" | "boolean" | "string[]";
  /** Sub-text for settings UI. */
  description?: string;
  /** Default value (type must match `type` field). */
  default?: string | number | boolean | string[];
  /** If true, stored in SecretStorage. */
  secret?: boolean;
  /** Min value (number type only). */
  min?: number;
  /** Max value (number type only). */
  max?: number;
  /** Enum constraint (string type only) — renders as dropdown. */
  options?: string[];
}

/** Simplified param schema from YAML fence. */
interface ParamSchema {
  [paramName: string]: {
    type: string;
    description?: string;
    default?: unknown;
    enum?: string[];
    items?: { type: string };
    /** If set, this param is a path and participates in path enforcement. */
    path_namespace?: "vault" | "filesystem";
  };
}

/** Compiled extension function signature. */
type CompiledExtensionFn = (...args: unknown[]) => Promise<unknown>;
```

- [x] Implement all types above
- [x] Export all types from `src/extensions/types.ts`

### EXT-004 — Add NotorSettings fields

Add the two new settings fields for extension data persistence.

**File:** `src/settings/types.ts` (modify existing)

```typescript
// Add to NotorSettings interface:

/** Per-extension settings, keyed by extension name then setting key. */
user_extension_settings: Record<string, Record<string, string | number | boolean | string[]>>;

/** Global shared extension settings, keyed by setting key. */
user_shared_settings: Record<string, string | number | boolean | string[]>;
```

**File:** `src/settings/defaults.ts` (modify existing)

- [x] Add `user_extension_settings: {}` to default settings
- [x] Add `user_shared_settings: {}` to default settings

---

## Phase 2: Parsing Pipeline

### EXT-005 — Implement Markdown parser

Parse extension Markdown files: extract frontmatter, YAML code fence, and TS/JS code fence.

**File:** `src/extensions/parser.ts`

**Input:** Raw Markdown string + vault-relative file path
**Output:** Parsed extension definition (or error)

**Parsing steps:**
1. Read frontmatter via Obsidian's `metadataCache.getFileCache(file)?.frontmatter` or manual YAML parsing
2. Validate `notor-type` field (must be `"tool"`, `"automation"`, or `"settings"`)
3. Extract first ` ```yaml ` fenced code block — parse with `parseYaml()` for `params` and/or `settings` schemas
4. Extract first ` ```ts `, ` ```typescript `, ` ```js `, or ` ```javascript ` fenced code block — raw code string
5. Validate required fields per extension type:
   - Tools: `notor-tool-name`, `notor-description`, `notor-mode`, code fence required
   - Automations: `notor-trigger`, code fence required
   - Settings: `settings` block in YAML fence required
6. Return typed definition or error with file path + reason

**Code fence extraction regex:**
```typescript
// Match the first code fence with a specific language tag
const CODE_FENCE_REGEX = /^```(yaml|ts|typescript|js|javascript)\s*\n([\s\S]*?)^```\s*$/gm;
```

**Frontmatter field mapping:**

| Frontmatter Field | Tool Property | Automation Property |
|---|---|---|
| `notor-type` | discriminator | discriminator |
| `notor-tool-name` | `name` | — |
| `notor-description` | `description` | — |
| `notor-mode` | `mode` | — |
| `notor-trigger` | — | `trigger` |
| `notor-schedule` | — | `schedule` |
| `notor-tools` | — | `toolFilter` |
| `notor-display-name` | — | `displayName` |
| `notor-automation-order` | — | `order` |

- [x] Implement `parseExtensionFile()` function
- [x] Implement `extractYamlFence()` helper (returns first YAML fence content or null)
- [x] Implement `extractCodeFence()` helper (returns first TS/JS fence content or null)
- [x] Validate frontmatter fields with type checking and error reporting
- [x] Default missing `notor-automation-order` to `0` in automation parsing (so discovery sort is deterministic)
- [x] Handle edge cases: missing fences, empty fences, multiple fences (take first only)

### EXT-006 — Implement param schema converter

Convert simplified YAML param schema to JSON Schema for LLM tool definitions.

**File:** `src/extensions/param-schema.ts`

**Input:**
```yaml
params:
  path:
    type: string
    description: "Path to note"
  include_frontmatter:
    type: boolean
    description: "Include frontmatter"
    default: false
```

**Output:**
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path to note" },
    "include_frontmatter": { "type": "boolean", "description": "Include frontmatter", "default": false }
  },
  "required": ["path"]
}
```

**Conversion rules:**
- Each param key becomes a `properties` entry
- Params without `default` are added to `required[]`
- `type: "string[]"` maps to `{ type: "array", items: { type: "string" } }`
- `enum` field maps to JSON Schema `enum`
- Pass through `description`, `default`
- `path_namespace` is consumed by the runtime (not passed to JSON Schema) — it populates `UserToolDefinition.pathParams`. The YAML field `path_namespace` maps to `ToolPathParam.namespace` (drop the `path_` prefix)

- [x] Implement `paramSchemaToJsonSchema(params: ParamSchema): JSONSchema`
- [x] Implement `extractPathParams(toolName: string, params: ParamSchema): ToolPathParam[]` — extracts entries with `path_namespace` into `ToolPathParam[]` for registration in `TOOL_PATH_PARAMS`
- [x] Handle all type mappings: `string`, `number`, `boolean`, `string[]`
- [x] Compute `required` array correctly (params without defaults)

### EXT-007 — Implement settings schema parser

Parse and validate the `settings` block from the YAML code fence.

**File:** `src/extensions/settings-schema.ts`

**Responsibilities:**
1. Parse the `settings:` section of the YAML fence into `SettingsFieldSchema[]`
2. Validate field types, required properties (`name`, `type`)
3. Resolve runtime values: merge schema defaults + persisted values from `user_extension_settings` + secrets from `SecretStorage`

```typescript
/** Parse YAML settings block into typed schema array. */
function parseSettingsSchema(
  yamlSettings: Record<string, unknown>
): { schemas: SettingsFieldSchema[]; errors: string[] }

/** Resolve settings values at runtime (synchronous — getSecret() and plugin.settings are both sync). */
function resolveSettings(
  schemas: SettingsFieldSchema[],
  extensionName: string,
  persistedValues: Record<string, string | number | boolean | string[]>,
  app: App
): { values: Record<string, unknown>; missing: string[] }

/** Resolve shared settings values at runtime (synchronous). */
function resolveSharedSettings(
  schemas: SettingsFieldSchema[],
  persistedValues: Record<string, string | number | boolean | string[]>,
  app: App
): { values: Record<string, unknown>; missing: string[] }
```

- [x] Implement `parseSettingsSchema()`
- [x] Implement `resolveSettings()` with SecretStorage integration for `secret: true` fields. Note: `getSecret()` from `src/utils/secrets.ts` is synchronous and `plugin.settings` access is also synchronous, so `resolveSettings()` should be a **synchronous** function (not `async`). It works fine when called from the `async` `UserToolAdapter.execute()` pipeline. Always reads from live `plugin.settings` reference (no caching/snapshots)
- [x] Implement `resolveSharedSettings()` for the global `notor/settings.md` settings
- [x] Implement `slugifySecretId()` — normalize extension names and setting keys to lowercase-alphanumeric-with-dashes for `SecretStorage` ID construction (per `SecretStorage` constraint: "ID must be lowercase alphanumeric with dashes")
- [x] Validate required settings (no `default`, not yet configured) — produce clear error messages

---

## Phase 3: Compilation Pipeline

### EXT-008 — Implement type stripping with Sucrase

Strip TypeScript type annotations from extension code using Sucrase.

**File:** `src/extensions/compiler.ts`

```typescript
import { transform } from "sucrase";

function stripTypes(code: string): string {
  const result = transform(code, {
    transforms: ["typescript"],
    // No JSX, no imports transform — just strip types
  });
  return result.code;
}
```

- [x] Implement `stripTypes()` function
- [x] Handle Sucrase errors (syntax errors in user code) — return descriptive error messages
- [x] Verify that common TS patterns work: type annotations, interfaces, generics, `as` casts, type-only imports (which should be stripped)

### EXT-009 — Implement AsyncFunction compilation

Compile stripped code into an async function with injected context variables.

**File:** `src/extensions/compiler.ts`

**Tool argument names:** `app`, `obsidian`, `utils`, `libs`, `settings`, `shared`, `params`
**Automation argument names:** `app`, `obsidian`, `utils`, `libs`, `settings`, `shared`, `context`

```typescript
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function compileToolFunction(strippedCode: string): CompiledExtensionFn {
  return new AsyncFunction(
    "app", "obsidian", "utils", "libs", "settings", "shared", "params",
    strippedCode
  );
}

function compileAutomationFunction(strippedCode: string): CompiledExtensionFn {
  return new AsyncFunction(
    "app", "obsidian", "utils", "libs", "settings", "shared", "context",
    strippedCode
  );
}
```

- [x] Implement `compileToolFunction()` and `compileAutomationFunction()`
- [x] Handle compilation errors (syntax errors that survive type stripping) — return descriptive messages with file path
- [x] Implement full `compileExtension()` pipeline: `stripTypes()` → `compile*Function()`

### EXT-010 — Build injected context objects

Assemble the `utils` and `libs` objects passed to extensions at runtime.

**File:** `src/extensions/runtime-context.ts`

**`utils` object:** References to existing utilities — must be a stable facade.

```typescript
function buildUtils(plugin: NotorPlugin): Record<string, unknown> {
  return {
    resolveNote: (path: string) => resolveNote(path, plugin.app.vault, plugin.app.metadataCache),
    staleTracker: plugin.getStaleTracker(),
    checkpointManager: plugin.getCheckpointManager(),
    noteOpener: plugin.getNoteOpener(),
    logger: (name: string) => logger(`ext:${name}`),
    resolveAndValidatePath: (path: string, allowedPaths?: string[]) => resolveAndValidatePath(path, plugin.vaultRootPath, allowedPaths ?? plugin.settings.read_file_allowed_paths),
    executeShellCommand: (cmd: string, opts?: ShellExecuteOptions) => executeShellCommand(cmd, plugin.settings, opts),
    pathEnforcer: {
      enforcePathConstraints: (toolName: string, params: Record<string, unknown>, entry: ResolvedToolConfigEntry) =>
        enforcePathConstraints(toolName, params, entry, plugin.vaultRootPath),
      isPathWithin: (target: string, base: string) => isPathWithin(target, base),
    },
  };
}
```

**Note:** `plugin.vaultRootPath` requires a new getter on `NotorPlugin` (see EXT-017). Implementation: `get vaultRootPath(): string { return (this.app.vault.adapter as { basePath?: string }).basePath ?? ""; }`. This consolidates an existing pattern — the same `(this.app.vault.adapter as { basePath?: string }).basePath` cast appears 4 times in `main.ts` and once in `ChatOrchestrator.getVaultRootPath()`. The new getter on the plugin centralizes this for DRY.

The `pathEnforcer` sub-object exposes the dispatch-time path enforcement and `isPathWithin` utility from `src/tool-config/path-enforcer.ts` and `src/utils/path-validation.ts`. This allows user tools to leverage the same path constraint logic used by built-in tools.

**`libs` object:** References to bundled libraries.

```typescript
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import * as docx from "docx";
import PizZip from "pizzip";
import { marked } from "marked";
import * as xmldom from "@xmldom/xmldom";
import { Cron } from "croner";

function buildLibs(): Record<string, unknown> {
  return {
    mammoth,
    Turndown: TurndownService,
    turndownGfm: { gfm },  // Wrapped in object for namespacing consistency — `gfm` is a named export from `turndown-plugin-gfm`. Usage: `new libs.Turndown().use(libs.turndownGfm.gfm)`
    unpdf: () => import("unpdf"),
    docx,
    PizZip,
    marked,
    xmldom,
    croner: { Cron },
  };
}
```

**Note on `unpdf`:** Currently dynamically imported in `src/media/pdf-processor.ts` to defer loading of the heavy PDF.js wrapper. We preserve this pattern — `libs.unpdf` is exposed as a lazy async wrapper (`() => import("unpdf")`). Extension code uses `const { getDocumentProxy } = await libs.unpdf();`. This avoids regressing plugin startup time for all users.

- [x] Implement `buildUtils()` — verify each utility reference resolves correctly from `main.ts` accessors. Note: `abortSignal` from `ToolExecuteOptions` is NOT included here (it's only available per-call); instead `UserToolAdapter.execute()` merges `abortSignal` into the utils object per-invocation (see EXT-012 adapter)
- [x] Implement `buildLibs()` — verify all 9 libraries import correctly (mammoth, Turndown, turndownGfm, unpdf, docx, PizZip, marked, xmldom, croner). Note: `unpdf` is a lazy wrapper (`() => import("unpdf")`), not a static import
- [x] Implement `buildObsidianExports()` — expose commonly needed `obsidian` module exports (`requestUrl`, `Notice`, `TFile`, `getFrontMatterInfo`, `normalizePath`, etc.)

---

## Phase 4: Discovery & Extension Manager

### EXT-011 — Implement discovery

Scan `notor/tools/`, `notor/automations/`, and `notor/settings.md` for extension files.

**File:** `src/extensions/discovery.ts`

**Pattern:** Follows `src/sub-agents/discovery.ts` and `src/workflows/workflow-discovery.ts`.

```typescript
async function discoverExtensions(
  vault: Vault,
  metadataCache: MetadataCache,
  notorDir: string,
  parseYAML: (yaml: string) => unknown,
): Promise<{
  tools: UserToolDefinition[];
  automations: UserAutomationDefinition[];
  sharedSettings: SharedSettingsDefinition | null;
  errors: ExtensionError[];
}>
```

**Discovery steps:**
1. Normalize `notorDir` — strip trailing slash to avoid double-slash in paths (matches `src/workflows/workflow-discovery.ts:421` pattern: `notorDir.replace(/\/$/, "")`)
2. Resolve `{notorDir}/tools/` directory — list `.md` files
3. For each file: read content, check `notor-type: tool` in frontmatter, parse via `parseExtensionFile()`
4. Resolve `{notorDir}/automations/` directory — list `.md` files
5. For each file: read content, check `notor-type: automation` in frontmatter, parse via `parseExtensionFile()`
6. Check for `{notorDir}/settings.md` — if exists and has `notor-type: settings`, parse shared settings
7. Collect all errors with file paths for user-visible reporting

- [x] Implement `discoverExtensions()` function — strip trailing slash from `notorDir` before building paths (e.g., `const baseDir = notorDir.replace(/\/$/, "")`)
- [x] Handle missing directories gracefully (no error, just empty results)
- [x] Handle malformed files gracefully (log error, skip file, continue)
- [x] Sort automations by `order` (ascending), then alphabetically by filename for ties

### EXT-012 — Implement ExtensionManager

Central manager class: orchestrates discovery, compilation, registration, and reload.

**File:** `src/extensions/manager.ts`

```typescript
class ExtensionManager {
  private tools = new Map<string, UserToolDefinition>();
  private automations = new Map<string, UserAutomationDefinition>();
  private sharedSettings: SharedSettingsDefinition | null = null;
  private compiledLibs: Record<string, unknown> | null = null;

  constructor(
    private readonly plugin: NotorPlugin,
    private readonly parseYAML: (yaml: string) => unknown,
  ) {}
  // Derives app, vault, metadataCache, settings from plugin (avoids redundant params)

  /** Full discovery + compilation + registration cycle. */
  async reload(isInitialLoad: boolean): Promise<ExtensionReloadResult>

  /** Get all compiled user tools (for registration). */
  getTools(): UserToolDefinition[]

  /** Get all compiled automations matching a specific trigger. */
  getAutomationsForTrigger(trigger: AutomationTrigger): UserAutomationDefinition[]

  /** Get automations matching a trigger + tool name filter. */
  getAutomationsForToolEvent(
    trigger: "on_tool_call" | "on_tool_result",
    toolName: string
  ): UserAutomationDefinition[]

  /** Get resolved shared settings object (synchronous — all underlying ops are sync). */
  getResolvedSharedSettings(): Record<string, unknown>

  /** Get resolved per-extension settings (synchronous). */
  getResolvedSettings(extensionName: string): Record<string, unknown>

  /** Destroy and clean up. */
  destroy(): void
}
```

**Reload flow:**
1. Discover all extensions via `discoverExtensions()`
2. For each tool: strip types → compile → validate. Store in `this.tools`
3. For each automation: strip types → compile → validate. Store in `this.automations`
4. Parse shared settings from `notor/settings.md` (if present)
5. Unregister previously-registered user tools from `ToolRegistry` and `TOOL_PATH_PARAMS`. Also unregister from `ToolDispatcher` if not initial load (see step 6)
6. Register tools in `ToolRegistry` (always). Register in `ToolDispatcher` **only if `isInitialLoad` is false** (i.e., manual reload). On initial load the dispatcher does not yet exist; it will pick up user tools automatically from `registry.getAll()` when it is lazily created on first chat. On manual reload the dispatcher IS already created and requires explicit `registerTool()` / `unregisterTool()` calls
7. Register user tool path params in `TOOL_PATH_PARAMS` (for `enforcePathConstraints()` at dispatch time)
8. Detect and warn about built-in tool name collisions via Notice (e.g., `'Tool "read_note" overrides built-in'`)
9. Report errors via Obsidian Notice + logger
10. Return summary: `{ toolCount, automationCount, builtinOverrides, errors }`

**Integration with ToolRegistry:**

User tools are wrapped in an adapter that implements the `Tool` interface:

```typescript
class UserToolAdapter implements Tool {
  name: string;
  description: string;
  input_schema: JSONSchema;
  mode: "read" | "write";

  constructor(
    private definition: UserToolDefinition,
    private manager: ExtensionManager,
    private plugin: NotorPlugin,
  ) {
    this.name = definition.name;
    this.description = definition.description;
    this.input_schema = paramSchemaToJsonSchema(definition.params);
    this.mode = definition.mode;
  }

  async execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult> {
    // 1. Resolve settings + shared settings synchronously (always reads from live plugin.settings reference)
    // 2. Build injected context (app, obsidian, utils, libs, settings, shared, params)
    //    - Merge options?.abortSignal into the utils object per-invocation (abortSignal is
    //      only available at call time, not when buildUtils() constructs the base object)
    // 3. Record start time via Date.now()
    // 4. Call compiled function
    // 5. Wrap return value as ToolResult:
    //    - Always populate: tool_name, success, result, duration_ms (measured by adapter)
    //    - User code may also return content_blocks (passed through if present)
    //    - tool_call_id is set by the dispatcher, NOT by the adapter
    //    - error populated only on failure
    // 6. On error: Notice + logger + return { tool_name: this.definition.name, success: false, error, duration_ms }
  }
}
```

- [x] Implement `ExtensionManager` class with all methods
- [x] Implement `UserToolAdapter` class implementing `Tool` interface
- [x] Implement the `reload()` flow with error aggregation
- [x] Implement tool registration: always register in `ToolRegistry`; conditionally register in `ToolDispatcher` only when `isInitialLoad` is false (avoids forcing premature creation of the dispatcher on initial load). Note: `ToolDispatcher.registerTool()` accepts `DispatchableTool` (subset: `name`, `mode`, `execute`); `UserToolAdapter` satisfies this via structural typing since `Tool` is a superset of `DispatchableTool`
- [x] Implement path param registration: for each user tool with `pathParams`, add entries to `TOOL_PATH_PARAMS` so `enforcePathConstraints()` applies at dispatch time
- [x] Track which tool names were registered by extensions so they can be unregistered on reload (before re-registering — includes clearing their `TOOL_PATH_PARAMS` entries and `ToolDispatcher` entries if dispatcher exists)
- [x] Clean up `TOOL_PATH_PARAMS` entries in `destroy()` (plugin unload), not just on reload

---

## Phase 5: Automation Dispatch Integration

### EXT-013 — Integrate automations with LLM lifecycle hooks

Extend the four LLM lifecycle dispatch functions to fire matching user automations after shell hooks.

**File:** `src/hooks/hook-events.ts` (modify existing)

**Execution order per the design doc:**
1. Global shell hooks (existing)
2. Workflow-scoped hooks (existing, if override active)
3. Vault-defined automations (new — sorted by `notor-automation-order`)

**Integration approach:** Use an accessor/callback pattern (not direct `ExtensionManager` dependency). Each dispatch function receives a lightweight accessor function rather than the full manager:

```typescript
type GetAutomationsForTrigger = (trigger: AutomationTrigger) => UserAutomationDefinition[];
type GetAutomationsForToolEvent = (
  trigger: "on_tool_call" | "on_tool_result",
  toolName: string
) => UserAutomationDefinition[];
```

This avoids coupling the hook module to the extension module. The orchestrator injects these accessors (bound to the `ExtensionManager` instance) when calling dispatch functions.

**All automations are fire-and-forget** (executed inside the existing `void (async () => { ... })()` IIFE). The exception is `pre_send` which is inherently blocking (its existing function is already `async` and awaited by the orchestrator).

**Changes to each dispatch function:**

- `dispatchPreSend()`:
  - Signature: add `getAutomations?: GetAutomationsForTrigger` parameter
  - After shell hooks, get automations with `trigger: "pre_send"`
  - Execute sequentially (inherently blocking since `dispatchPreSend` is awaited)
  - Collect returned strings and append to stdout array

- `dispatchOnToolCall()`:
  - Signature: add `getAutomations?: GetAutomationsForToolEvent` parameter
  - Inside the existing fire-and-forget IIFE, after shell hooks complete, execute automations sequentially in `order` order

- `dispatchOnToolResult()`:
  - Signature: add `getAutomations?: GetAutomationsForToolEvent` parameter
  - Same pattern as `dispatchOnToolCall`

- `dispatchAfterCompletion()`:
  - Signature: add `getAutomations?: GetAutomationsForTrigger` parameter
  - Same fire-and-forget pattern

**Context object construction:**

Each dispatch function translates from its internal context type to the design doc's extension-facing `context` object inline. Note that each dispatch function uses a **different context type** — `PreSendContext`, `ToolHookContext`, or `CompletionContext` — so the translation is specific to each function:

```typescript
// Example: inside dispatchPreSend() (context: PreSendContext), after shell hooks:
const automationCtx = {
  hookEvent: "pre_send",
  timestamp: context.timestamp,
  conversationId: context.conversationId,
};

// Example: inside dispatchOnToolCall() (context: ToolHookContext), after shell hooks:
const automationCtx = {
  hookEvent: "on_tool_call",
  timestamp: context.timestamp,
  conversationId: context.conversationId,
  toolName: context.toolName,
  params: context.toolParams,           // translated from internal toolParams
};

// Example: inside dispatchOnToolResult() (context: ToolHookContext), after shell hooks:
const automationCtx = {
  hookEvent: "on_tool_result",
  timestamp: context.timestamp,
  conversationId: context.conversationId,
  toolName: context.toolName,
  params: context.toolParams,           // translated from internal toolParams
  result: context.toolResult,           // translated from internal toolResult
  status: context.toolStatus,           // translated from internal toolStatus
};

// Example: inside dispatchAfterCompletion() (context: CompletionContext), after shell hooks:
const automationCtx = {
  hookEvent: "after_completion",
  timestamp: context.timestamp,
  conversationId: context.conversationId,
};
```

- [x] Add accessor parameter to all four dispatch functions in `hook-events.ts` (not `ExtensionManager` directly)
- [x] Implement automation execution within each dispatch function (fire-and-forget for all except `pre_send`)
- [x] Execute automations sequentially in `notor-automation-order` order
- [x] Translate field names from each function's context type (`PreSendContext`, `ToolHookContext`, or `CompletionContext`) to design-doc names inline in each dispatch function (no separate `buildAutomationContext()` helper)
- [x] Handle automation errors: Notice + logger (no ToolResult for automations)
- [x] Respect `notor-tools` filter for `on_tool_call` and `on_tool_result` (via `GetAutomationsForToolEvent`)

### EXT-014 — Integrate automations with vault event hooks

Extend vault event dispatch to include user automations alongside shell hooks and workflows.

**Files modified:**
- `src/hooks/vault-event-dispatcher.ts` — add automation dispatch step
- `src/hooks/vault-event-handlers.ts` — pass automations accessor through deps
- `src/hooks/vault-event-listener-manager.ts` — add `setExtensionAutomations()` setter + update `hasActiveHooks()`
- `src/hooks/vault-event-scheduler.ts` — add `setExtensionAutomations()` setter + automation schedule support in `syncJobs()`

**Execution order per design doc:**
1. Shell hooks (existing)
2. Workflow hooks (existing)
3. Vault-defined automations (new — **separate dispatch step**, not mixed into existing collection)

**Design decision:** Automations are dispatched in a separate step after the existing hooks+workflows, rather than being added to the `collectHooksAndWorkflows()` return type. This avoids modifying the `Array<VaultEventHook | Workflow>` union type and the `_executeOneHook()` discrimination logic. The existing `collectHooksAndWorkflows()` function remains unchanged.

**Changes:**

- `dispatchVaultEventHooks()` — after the existing hook/workflow loop, execute matching automations via a `getExtensionAutomations` accessor injected through `DispatcherDeps`. The accessor flows automatically from `main.ts` through the lazy `getDispatcherDeps()` closure → `VaultEventHandlerDeps.dispatch` callback → `dispatchVaultEventHooks()`. No changes to `VaultEventHandlerDeps` or `collectHooksAndWorkflows()` needed
- `DispatcherDeps` interface — add `getExtensionAutomations?: GetAutomationsForTrigger` field
- `VaultEventListenerManager` — add `setExtensionAutomations()` setter (NOT a constructor param, since the manager is constructed in `_initVaultEventHooks()` before `onLayoutReady()` and before extensions are discovered). The setter stores a `(trigger: AutomationTrigger) => UserAutomationDefinition[]` function (i.e., `getAutomationsForTrigger` from `ExtensionManager`). `hasActiveHooks()` calls this function with the specific vault event type and checks if the result is non-empty, alongside existing settings hooks and workflow trigger checks. **Type note:** `hasActiveHooks()` accepts `VaultEventHookType` but the accessor accepts `AutomationTrigger` (a superset that includes LLM lifecycle triggers). This is type-imprecise — passing a `VaultEventHookType` where `AutomationTrigger` is expected works at runtime (strings are strings), and `getAutomationsForTrigger()` will correctly return `[]` for LLM-only triggers. The filtering of LLM lifecycle triggers happens implicitly in `ExtensionManager`, not in the listener manager
- `VaultEventScheduler` — add `setExtensionAutomations()` setter (separate from the existing `setDispatch()`, since each data source has its own injection point). `syncJobs()` adds a parallel loop for automation `on_schedule` entries alongside existing hook and workflow schedule handling

**Vault event context for automations:**

```typescript
// on_note_open, on_note_create, on_save, on_manual_save:
{ hookEvent, timestamp, notePath }

// on_tag_change:
{ hookEvent, timestamp, notePath, tagsAdded, tagsRemoved }

// on_schedule:
{ hookEvent, timestamp, schedule }
```

- [x] Add `getExtensionAutomations?` and `executeExtensionAutomation?` accessors to `DispatcherDeps` interface. Flows through the dispatch chain automatically — no changes to `VaultEventHandlerDeps` or `collectHooksAndWorkflows()` needed
- [x] Dispatch automations as a separate step after hooks+workflows in `dispatchVaultEventHooks()`. Uses same `chain` context for `shouldSkipHook()`. Wrapped in independent try/catch; each automation also has its own try/catch. Early return updated to check for automations
- [x] Build vault event context objects (using design-doc field names): `hookEvent`, `timestamp`, conditionally `notePath`, `tagsAdded`, `tagsRemoved`
- [x] Add `setExtensionAutomations()` setter on `VaultEventListenerManager` (NOT a constructor param). Updated `hasActiveHooks()` to also check extension automations. Wiring deferred to EXT-017
- [x] Add `setExtensionAutomations()` setter on `VaultEventScheduler` (separate from `setDispatch()`); added parallel loop in `syncJobs()` for automation `on_schedule` entries. Job ID convention: `ext-auto:{filePath}`. Updated `startJob()`, `onJobFire()`, and `destroy()`
- [x] Wire `getExtensionAutomations` accessor through from `main.ts` when constructing `getDispatcherDeps()` closure and when calling setters on `VaultEventListenerManager` and `VaultEventScheduler` — **completed in EXT-017 (Phase 7 wiring)**

---

## Phase 6: Settings UI

### EXT-015 — Create extensions settings section

Add a new settings group for user-defined extensions.

**File:** `src/settings/sections/extensions.ts` (new)

**UI structure:**

```
[Extensions] (collapsible group)
  ├── [Shared settings] (sub-section, from notor/settings.md)
  │   ├── Setting field 1
  │   ├── Setting field 2
  │   └── "Reset to defaults" button
  │
  ├── [Tool: custom_search] (sub-section, per tool with settings)
  │   ├── Setting field 1
  │   ├── Setting field 2
  │   └── "Reset to defaults" button
  │
  ├── [Automation: tag-ai-writes] (sub-section, per automation with settings)
  │   ├── Setting field 1
  │   └── "Reset to defaults" button
  │
  └── "Reload extensions" button
```

**Rendering per field type (from design doc):**
- `type: string` + no `options` → text input (`Setting.addText()`)
- `type: string` + `secret: true` → `SecretComponent` (existing pattern from API key settings)
- `type: string` + `options` → dropdown (`Setting.addDropdown()`)
- `type: number` → text input with numeric validation (respects `min`/`max`)
- `type: boolean` → toggle (`Setting.addToggle()`)
- `type: string[]` → dynamic list with add/remove (same pattern as `domain_denylist` in `renderFetchWebpageSection()`)

- [x] Implement `renderExtensionsSection()` function
- [x] Implement shared settings sub-section (from `notor/settings.md`)
- [x] Implement per-extension settings sub-sections (one per tool/automation that has `settings`)
- [x] Implement field rendering for all 6 type variants
- [x] Implement "Reset to defaults" button per extension (clears `user_extension_settings[name]`)
- [x] Implement "Reload extensions" button (calls `extensionManager.reload()`)
- [x] Hide group entirely if no extensions have settings and no shared settings exist
- [x] Wire into `settings-tab.ts` render pipeline

### EXT-016 — Register reload command

Add the `notor:reload-extensions` Obsidian command.

**File:** `src/main.ts` (modify existing)

- [x] Register command `notor:reload-extensions` with label "Reload user extensions"
- [x] Command callback: call `extensionManager.reload(false)` (not initial load), show Notice with summary

---

## Phase 7: main.ts Wiring & Lifecycle

### EXT-024 — Extension file watcher with reload Notice

Watch `notor/tools/`, `notor/automations/`, and `notor/settings.md` for file changes and show a debounced Notice prompting the user to reload extensions.

**File:** `src/extensions/watcher.ts` (new)
**File:** `src/main.ts` (modify — register vault event listeners)

**Design:** Follows the existing `registerWorkflowVaultWatcher()` pattern in `main.ts` (lines 1335-1358) which uses `vault.on("create")`, `vault.on("delete")`, `vault.on("rename")`, and `metadataCache.on("changed")` with a debounced rescan timer.

**Watched events:**

| Vault Event | Trigger Condition |
|---|---|
| `vault.on("create")` | New `.md` file created in `notor/tools/` or `notor/automations/`, or `notor/settings.md` created |
| `vault.on("delete")` | `.md` file deleted from `notor/tools/` or `notor/automations/`, or `notor/settings.md` deleted |
| `vault.on("rename")` | File renamed into or out of `notor/tools/` or `notor/automations/` |
| `metadataCache.on("changed")` | Metadata (frontmatter) changed on a file in `notor/tools/` or `notor/automations/`, or on `notor/settings.md` |

**Debouncing:**

The existing workflow watcher uses a simple `setTimeout` debounce (see `scheduleWorkflowRescan()` in `main.ts`). Extensions use the same pattern:

```typescript
private _extensionChangeTimer: ReturnType<typeof setTimeout> | null = null;
private _extensionStaleNotice: Notice | null = null;

private static readonly EXTENSION_DEBOUNCE_MS = 1000;

private scheduleExtensionChangeNotice(): void {
  // Clear any pending debounce timer
  if (this._extensionChangeTimer !== null) {
    clearTimeout(this._extensionChangeTimer);
  }

  this._extensionChangeTimer = setTimeout(() => {
    this._extensionChangeTimer = null;

    // Don't show duplicate notices — if one is already visible, skip
    if (this._extensionStaleNotice) return;

    this._extensionStaleNotice = new Notice(
      "Extension files changed. Reload extensions to apply updates.",
      0  // persistent until clicked or dismissed
    );

    // Add click handler to trigger reload directly from the Notice
    this._extensionStaleNotice.noticeEl.addEventListener("click", () => {
      this._extensionStaleNotice?.hide();
      this._extensionStaleNotice = null;
      this.getExtensionManager().reload();
    });

    // Clear reference when Notice is dismissed (timeout or user action)
    // Notice auto-hides after ~8s by default; use 0 for persistent
  }, EXTENSION_DEBOUNCE_MS);
}
```

**Debounce rationale:** 1000ms debounce coalesces rapid bursts from:
- Obsidian sync writing multiple files
- Git operations updating several extension files at once
- Obsidian auto-saves during active editing (prevents Notice flicker)

Longer than the workflow watcher's 300ms because the watcher only shows a Notice (not auto-reload), and extension file edits are typically less frequent than workflow edits. The extra delay prevents distracting Notice flashes during normal editing.

**Path matching helpers:**

```typescript
private isExtensionToolFile(file: TAbstractFile): boolean {
  return file.path.startsWith(`${this.settings.notor_dir}tools/`) && file.path.endsWith(".md");
}

private isExtensionAutomationFile(file: TAbstractFile): boolean {
  return file.path.startsWith(`${this.settings.notor_dir}automations/`) && file.path.endsWith(".md");
}

private isExtensionSettingsFile(file: TAbstractFile): boolean {
  return file.path === `${this.settings.notor_dir}settings.md`;
}

private isExtensionFile(file: TAbstractFile): boolean {
  return this.isExtensionToolFile(file) || this.isExtensionAutomationFile(file) || this.isExtensionSettingsFile(file);
}
```

**Notice behavior:**
- Persistent Notice (duration `0`) — stays visible until clicked or manually dismissed
- Clicking the Notice triggers `extensionManager.reload()` directly (one-click reload UX)
- Only one "stale extensions" Notice is shown at a time (duplicate suppression via `_extensionStaleNotice` reference)
- Notice is cleared after successful reload

**Cleanup:** Timer and Notice reference cleared in `onunload()`.

- [x] Implement `registerExtensionVaultWatcher()` in `main.ts` using `registerEvent()` for all four vault events
- [x] Implement path matching helpers (`isExtensionFile()`, `isExtensionPath()`, etc.) in `src/extensions/watcher.ts`
- [x] Implement debounced Notice with 1000ms window
- [x] Implement click-to-reload on the Notice
- [x] Implement duplicate Notice suppression
- [x] Clear timer and Notice in `onunload()`
- [x] Register watchers in `onLayoutReady()` (after initial extension discovery)

---

### EXT-017 — Wire ExtensionManager into plugin lifecycle

Initialize and integrate the extension manager into the plugin's startup and teardown.

**File:** `src/main.ts` (modify existing)

**Startup sequence:**

```
onload()
  → onLayoutReady()
    → existing: workflow discovery, vault watcher, etc.
    → NEW: extensionManager.reload(isInitialLoad: true)
      → discovers tools, automations, shared settings
      → compiles all extensions
      → registers user tools in ToolRegistry only (isInitialLoad=true skips
        dispatcher registration — dispatcher does not exist yet and will
        pick up user tools from registry.getAll() when lazily created)
    → NEW: evaluateListeners() again (picks up automation vault event triggers)
```

**Lazy accessor pattern (matches existing):**

```typescript
private _extensionManager: ExtensionManager | null = null;

getExtensionManager(): ExtensionManager {
  if (!this._extensionManager) {
    this._extensionManager = new ExtensionManager(this, parseYaml);
  }
  return this._extensionManager;
}
```

**Integration points in main.ts:**

1. `getToolRegistry()` — no changes needed; user tools are registered in the registry during `extensionManager.reload()` which runs in `onLayoutReady()`
2. `getToolDispatcher()` — on lazy creation, it iterates `registry.getAll()` which already includes user tools (if reload ran first). On manual reload, `ExtensionManager` checks `plugin.hasDispatcher()` and explicitly registers/unregisters
3. `_initMcpHub()` — no changes needed (MCP tools register independently)
4. Orchestrator — call `orchestrator.setExtensionAccessors()` (same pattern as `setPersonaManager()` and `setWorkflowHookOverrideManager()`) so it can pass accessors at each dispatch call site
5. `onunload()` — call `extensionManager.destroy()` (includes `TOOL_PATH_PARAMS` cleanup)

**Passing to hook dispatch (orchestrator setter pattern):**

Add a `setExtensionAccessors()` method on `ChatOrchestrator` (matches existing `setPersonaManager()` and `setWorkflowHookOverrideManager()` patterns). The orchestrator stores the accessors and passes them at dispatch call sites.

**Important: mixed import pattern.** The four dispatch functions use two different import strategies in the orchestrator:
- `dispatchPreSend` and `dispatchAfterCompletion` are **statically imported** at the top of `orchestrator.ts` (line 32)
- `dispatchOnToolCall` and `dispatchOnToolResult` are **dynamically imported** at their call sites

There are **six call sites** across two execution paths, plus one private wrapper:

| Function | Foreground (`responseLoop`) | Background (`_backgroundResponseLoop`) | Import |
|---|---|---|---|
| `dispatchPreSend` | `orchestrator.ts:1240` | — | Static |
| `dispatchOnToolCall` | `orchestrator.ts:1495` | `orchestrator.ts:966` | Dynamic |
| `dispatchOnToolResult` | `orchestrator.ts:1604` | `orchestrator.ts:981` | Dynamic |
| `dispatchAfterCompletion` | `orchestrator.ts:1693` (via `dispatchAfterCompletionHooks()`) | — | Static |

Automations for `on_tool_call` and `on_tool_result` must fire in both the foreground and background loops for consistent behavior. **Note:** `pre_send` and `after_completion` automations only fire in the foreground `responseLoop` — the background `_backgroundResponseLoop` (used for vault-event-triggered workflow executions) does not call `dispatchPreSend` or `dispatchAfterCompletion`. This is an inherent asymmetry: background workflows don't have an interactive "send" or "completion" lifecycle. There are **5 direct call sites + 1 private wrapper** that forwards to `dispatchAfterCompletion`:

```typescript
// In ChatOrchestrator:
setExtensionAccessors(accessors: {
  getForTrigger: (trigger: AutomationTrigger) => UserAutomationDefinition[];
  getForToolEvent: (trigger: "on_tool_call" | "on_tool_result", toolName: string) => UserAutomationDefinition[];
}): void {
  this.extensionAccessors = accessors;
}

// Static import call sites — pass accessor directly from instance field:
dispatchPreSend(context, this.settings, vaultRootPath, this.workflowHookOverrideManager, this.extensionAccessors?.getForTrigger);

// Dynamic import call sites — accessor must be in closure scope:
const { dispatchOnToolCall } = await import("../hooks/hook-events");
dispatchOnToolCall(context, this.settings, vaultRootPath, this.workflowHookOverrideManager, this.extensionAccessors?.getForToolEvent);

// Private wrapper — must accept and forward the parameter:
private dispatchAfterCompletionHooks(): void {
  // ...
  dispatchAfterCompletion(context, this.settings, vaultRootPath, this.workflowHookOverrideManager, this.extensionAccessors?.getForTrigger);
}
```

```typescript
// In main.ts orchestrator setup:
const mgr = this.getExtensionManager();
orchestrator.setExtensionAccessors({
  getForTrigger: (t) => mgr.getAutomationsForTrigger(t),
  getForToolEvent: (t, n) => mgr.getAutomationsForToolEvent(t, n),
});
```

For vault event dispatch, inject `getAutomationsForTrigger` into `DispatcherDeps`.

- [x] Create `getExtensionManager()` lazy accessor (already existed from EXT-016)
- [x] Add `isInitialLoad` parameter to `ExtensionManager.reload(isInitialLoad: boolean)`. When `true` (called from `onLayoutReady()`), skip `ToolDispatcher` registration — the dispatcher doesn't exist yet and will pick up user tools from `registry.getAll()` when lazily created on first chat. When `false` (manual reload from command/settings), register/unregister in the dispatcher (already existed from EXT-012)
- [x] Add `get vaultRootPath(): string` getter to `NotorPlugin` (`(this.app.vault.adapter as { basePath?: string }).basePath ?? ""`). Consolidated 4 existing `basePath` casts in main.ts
- [x] Wire initial `reload(true)` into `onLayoutReady()` (after workflow discovery — `isInitialLoad: true` skips dispatcher registration)
- [x] Add `setExtensionAccessors()` method to `ChatOrchestrator` (stores `LifecycleAutomationAccessors` and `ToolEventAutomationAccessors`)
- [x] Call `orchestrator.setExtensionAccessors()` in `main.ts` after creating extension manager (in `getOrchestrator()` lazy accessor)
- [x] Pass stored accessors through to all **5 direct call sites + 1 private wrapper** (3 in foreground `responseLoop` + 2 in background `_backgroundResponseLoop` + `dispatchAfterCompletionHooks()` wrapper)
- [x] Update private `dispatchAfterCompletionHooks()` wrapper to forward the extension lifecycle accessor
- [x] Add `getExtensionAutomations` + `executeExtensionAutomation` accessors to vault event `DispatcherDeps` construction
- [x] Call `setExtensionAutomations()` setter on `VaultEventListenerManager` — wired before `onLayoutReady` calls `evaluateListeners()`. Accessor returns empty until extensions are loaded; `evaluateListeners()` called again after `reload()` completes
- [x] Call `setExtensionAutomations()` setter on `VaultEventScheduler` (wired alongside `setDispatch()`)
- [x] Wire `extensionManager.destroy()` into `onunload()` (includes `TOOL_PATH_PARAMS` cleanup)
- [x] Wire `registerExtensionVaultWatcher()` into `onLayoutReady()` (after initial extension reload, inside the `reload().then()` callback)
- [x] Ensure reload ordering: built-in tools → user tools → MCP tools (MCP is async, so user tools may register before MCP connects — that's fine, MCP tools don't conflict with user tools)

---

## Phase 8: Error Handling & Validation

### EXT-018 — Implement runtime error handling

Ensure extension errors are surfaced correctly without crashing the plugin.

**File:** `src/extensions/manager.ts` (augment)

**Tool errors (3 channels):**
1. **Notice** — `new Notice(\`Extension error in ${toolName}: ${error.message}\`)`
2. **ToolResult** — `{ success: false, error: error.message, tool_name: toolName }`
3. **Logger** — `log.error("User tool execution failed", { tool: toolName, error: String(error), stack: error.stack })`

**Automation errors (2 channels):**
1. **Notice** — `new Notice(\`Automation error in ${displayName}: ${error.message}\`)`
2. **Logger** — `log.error("User automation execution failed", { automation: displayName, trigger, error: String(error), stack: error.stack })`

**Compilation errors:**
- Displayed as Notice during reload: `"Extension '{name}' failed to compile: {error}"`
- Logged with full details
- Extension skipped (not registered), but other extensions continue loading

**Missing required settings:**
- Tool returns `{ success: false, error: "Tool 'X' requires setting 'Y' to be configured in Settings." }`
- Automation fires Notice with same message and skips execution

- [x] Implement try/catch in `UserToolAdapter.execute()` — already implemented in `manager.ts:136-153` (EXT-012)
- [x] Implement try/catch in automation execution paths — already implemented in `hook-events.ts` (EXT-013) and `vault-event-dispatcher.ts:168-180` (EXT-014)
- [x] Implement compilation error reporting in `reload()` — already implemented in `manager.ts:219-224, 235-240` (EXT-012)
- [x] Implement required settings validation before execution — already implemented in `manager.ts:68-76` (tool) and `391-398` (automation) (EXT-012)

---

## Phase 9: Testing

### EXT-019 — Unit tests for parsing pipeline

**File:** `src/extensions/__tests__/parser.test.ts`

- [x] Test: valid tool file parses correctly (frontmatter + YAML fence + code fence)
- [x] Test: valid automation file parses correctly
- [x] Test: valid settings file parses correctly
- [x] Test: missing required frontmatter fields produce errors
- [x] Test: missing code fence produces error
- [x] Test: YAML fence parsing with `params` and `settings` blocks
- [x] Test: code fence extraction with different language tags (ts, typescript, js, javascript)
- [x] Test: prose outside fences is ignored

### EXT-020 — Unit tests for param schema conversion

**File:** `src/extensions/__tests__/param-schema.test.ts`

- [x] Test: basic types (string, number, boolean) convert correctly
- [x] Test: `string[]` converts to array schema
- [x] Test: params with defaults are not in `required`
- [x] Test: params without defaults are in `required`
- [x] Test: `enum` field maps correctly

### EXT-021 — Unit tests for compilation pipeline

**File:** `src/extensions/__tests__/compiler.test.ts`

- [x] Test: TypeScript type annotations are stripped
- [x] Test: interface declarations are stripped
- [x] Test: `as` casts are stripped
- [x] Test: JavaScript code passes through unchanged
- [x] Test: compiled function is callable with correct arguments
- [x] Test: syntax errors produce descriptive error messages
- [x] Test: async/await works in compiled code

### EXT-022 — Unit tests for settings resolution

**File:** `src/extensions/__tests__/settings-schema.test.ts`

- [x] Test: schema defaults are used when no persisted values exist
- [x] Test: persisted values override defaults
- [x] Test: missing required settings (no default, no persisted) are reported
- [x] Test: type validation for each field type

### EXT-023 — Integration tests

**File:** `src/extensions/__tests__/manager.test.ts`

- [x] Test: full reload cycle discovers and compiles tools
- [x] Test: user tool registers in ToolRegistry and overwrites built-in
- [x] Test: user tool execute() returns ToolResult
- [x] Test: automation fires for matching trigger
- [x] Test: automation `notor-tools` filter works
- [x] Test: automations execute sequentially in `order` order
- [x] Test: reload clears previous registrations before re-registering
- [x] Test: reload reports built-in name collisions in summary

---

## Dependency Graph

```
Phase 0 (EXT-001, EXT-002)
  │
  ▼
Phase 1 (EXT-003, EXT-004)
  │
  ▼
Phase 2 (EXT-005, EXT-006, EXT-007)  ← can be parallel
  │
  ▼
Phase 3 (EXT-008, EXT-009, EXT-010)  ← can be parallel after Phase 2
  │
  ▼
Phase 4 (EXT-011, EXT-012)
  │
  ├──────────────────────┐
  ▼                      ▼
Phase 5 (EXT-013, 014)  Phase 6 (EXT-015, 016)  ← parallel
  │                      │
  └──────────┬───────────┘
             ▼
Phase 7 (EXT-017, EXT-024)
  │
  ▼
Phase 8 (EXT-018)
  │
  ▼
Phase 9 (EXT-019 — EXT-023)
```

---

## Risk Assessment

### R-1: Sucrase bundle size

**Risk:** Sucrase adds ~50KB to the plugin bundle.
**Mitigation:** Acceptable — the plugin already bundles heavy libraries (AWS SDK, mammoth, docx). 50KB is negligible. Measured during EXT-001.

### R-2: `AsyncFunction` CSP restrictions

**Risk:** Content Security Policy may block `new Function()` / `new AsyncFunction()` in some environments.
**Mitigation:** Obsidian desktop (Electron) has no restrictive CSP for plugin code. Community plugins already use dynamic code evaluation. The entire Notor plugin is desktop-only, so no mobile CSP concerns apply.

### R-3: User tool overwrites built-in with broken implementation

**Risk:** A user tool named `read_note` that throws on every call effectively disables note reading.
**Mitigation:** Phase 2 migration (future) adds a "Reset to default" button. For Phase 1, the reload mechanism lets users fix the file and reload. Built-in tools always re-register first, so deleting the user tool file and reloading restores the built-in.

### R-4: Automation infinite loops

**Risk:** An `on_tool_result` automation that calls `app.vault.process()` could trigger `on_save` hooks, which trigger workflows, which call tools, which trigger the automation again.
**Mitigation:** The existing `ExecutionChainTracker` detects loops via `shouldSkipHook()`. Automations must participate in this same chain tracking. Additionally, automations that fire from vault events already go through the existing loop prevention in `vault-event-handlers.ts`.

### R-5: Secret settings migration

**Risk:** If a user renames an extension, the old secret ID becomes orphaned in SecretStorage.
**Mitigation:** Acceptable for Phase 1. Secret IDs are keyed by extension name (`notor-ext-{name}-{key}`). Renaming creates a new entry; old ones are inert. Future cleanup is possible but not critical.

### R-6: `utils` API stability

**Risk:** Changes to internal utilities (`StaleContentTracker`, `CheckpointManager`) break user extensions.
**Mitigation:** Keep `utils` as a stable facade. Document the API surface. Future: `notor-api: 1` versioning in frontmatter for breaking change warnings.

### R-7: Concurrent reload during LLM operation

**Risk:** User triggers reload while LLM is mid-conversation, replacing tools mid-stream.
**Mitigation:** Design doc specifies: "In-flight tool calls continue using the version compiled at dispatch time; reloaded versions apply to subsequent calls." The `UserToolAdapter` holds a reference to the compiled function at dispatch time — reload replaces the adapter in the registry, but active calls use the old reference.

---

## Resolved Questions

### Q-1: Path enforcement for user tools — RESOLVED: Yes, first iteration

User tools participate in path enforcement via `TOOL_PATH_PARAMS`. The YAML fence param schema supports an optional `path_namespace: "vault" | "filesystem"` field. Params with this field are registered in `TOOL_PATH_PARAMS` during `reload()`, so `enforcePathConstraints()` in the dispatch pipeline applies to user tools the same way it does to built-ins.

Additionally, the path enforcer utilities are exposed via `utils.pathEnforcer` so user tool code can call `enforcePathConstraints()` and `isPathWithin()` directly for custom path validation logic.

**Example YAML fence with path enforcement:**
```yaml
params:
  path:
    type: string
    description: "Path to note"
    path_namespace: vault
  output_dir:
    type: string
    description: "Output directory"
    path_namespace: filesystem
```

### Q-2: Tool concurrency classification — RESOLVED: Use `mode` directly

`partitionToolCalls()` in `tool-orchestration.ts` has two classification branches: MCP tools use `hasExplicitUserReadClassification()` (non-concurrent by default, opt-in to concurrency via server config), while non-MCP tools use `!dispatcher.isWriteTool(toolName)` (which reads `tool.mode`). Since user tools are not MCP tools, they fall through to the non-MCP branch. `UserToolAdapter` exposes `mode` from the frontmatter `notor-mode` field, so user tools with `mode: "read"` are concurrency-safe and user tools with `mode: "write"` are non-concurrent. No changes to `partitionToolCalls()` needed.

### Q-3: User tool names in `<notor_tool_config>` blocks — RESOLVED: Works automatically (with caveat)

User tools register in `ToolRegistry` with their declared `notor-tool-name`. The `<notor_tool_config>` system operates on tool names from the registry, so user tools can be enabled/disabled and have `auto_approve` / path constraints set by personas, workflows, and rules — no special handling required. The tool config parser's `knownToolNames` validation will include user tool names since they're in the registry at parse time.

**Caveat:** If a user tool fails to compile (or hasn't been discovered yet on first load), a persona/workflow referencing that tool name in a `<notor_tool_config>` block may get an unknown-tool-name warning. This is acceptable for Phase 1 — the warning is non-blocking and the tool config will work once the extension loads successfully.

### Q-4: Extension file watching — RESOLVED: Watch + Notice (no auto-reload)

File watchers on `notor/tools/`, `notor/automations/`, and `notor/settings.md` detect changes and show a debounced Notice prompting the user to reload. No auto-recompilation occurs — the user must explicitly trigger reload via the Settings button or the `notor:reload-extensions` command.

See [EXT-024](#ext-024--extension-file-watcher-with-reload-notice) for full implementation details.
