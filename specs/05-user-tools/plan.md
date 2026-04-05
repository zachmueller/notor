# Implementation Plan: Phase 5 — User-Defined Extensions

**Created:** 2026-04-05
**Design Doc:** [design/user-defined-tools.md](../../design/user-defined-tools.md)
**Status:** Planning

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
| Hot reload | Manual only (Settings button + command palette) | Avoids compilation during active LLM operations. Design doc resolved decision |
| Extension settings storage | Two new `NotorSettings` fields: `user_extension_settings` and `user_shared_settings` | Follows existing patterns. Secrets use `SecretStorage` with ID convention `notor-ext-{name}-{key}` / `notor-shared-{key}` |
| Registration approach | User tools register in `ToolRegistry` via same `register()` method; user automations register in a new `AutomationRegistry` alongside existing hook dispatch | Tools integrate fully with existing dispatch pipeline. Automations coexist with shell hooks (not replace) |
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
| `ChatOrchestrator` | User automations fire at the same lifecycle points as shell hooks. `dispatchPreSend`, `dispatchOnToolCall`, `dispatchOnToolResult`, `dispatchAfterCompletion` extended to also invoke matching automations |
| `VaultEventListenerManager` | User automations with vault event triggers (`on_note_open`, `on_save`, etc.) register alongside workflow triggers. `evaluateListeners()` extended to include automation triggers |
| `VaultEventDispatcher` | `dispatchVaultEventHooks()` extended to collect and execute matching automations after shell hooks and workflow hooks |
| `SystemPromptBuilder` | Tool definitions include user tools (they're in the registry). No special handling needed — `getToolDefinitions()` / `getFilteredToolDefinitions()` already return all registered tools |
| `NotorSettings` | New fields: `user_extension_settings`, `user_shared_settings`. Settings defaults/merge in `loadSettings()` |
| `SettingsTab` | New "Extensions" settings group with per-extension settings and shared settings sub-sections |
| `main.ts` | New lazy accessor `getExtensionManager()`. Wired into reload command + settings button. Discovery runs on plugin load (`onLayoutReady`) |
| `tool-config/path-enforcer.ts` | `TOOL_PATH_PARAMS` table — user tools that declare path params need a registration mechanism so path enforcement works. Initially, user tools are exempt from path enforcement (they control their own path handling) |
| `tool-orchestration.ts` | `partitionToolCalls()` needs to classify user tools. User tools with `mode: "read"` are concurrency-safe; `mode: "write"` are non-concurrent. Same logic as built-in tools |
| `esbuild.config.mjs` | Sucrase added as a bundled dependency (not external) |

---

## Phase 0: Dependencies & Scaffolding

### EXT-001 — Install Sucrase

Add sucrase as a production dependency (bundled by esbuild into the plugin).

**Files modified:** `package.json`, `package-lock.json`

- [ ] Add `"sucrase": "^3.35.0"` to `dependencies` in `package.json`
- [ ] Run `npm install`
- [ ] Run `npm run build` and confirm the bundle compiles without errors
- [ ] Verify sucrase's bundle impact is reasonable (~50KB as noted in design doc)

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

- [ ] Create `src/extensions/types.ts` with type stubs
- [ ] Create remaining files with module doc comments and placeholder exports

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
  /** Blocking mode from frontmatter `notor-blocking`. Default false. */
  blocking: boolean;
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
  };
}

/** Compiled extension function signature. */
type CompiledExtensionFn = (...args: unknown[]) => Promise<unknown>;
```

- [ ] Implement all types above
- [ ] Export all types from `src/extensions/types.ts`

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

- [ ] Add `user_extension_settings: {}` to default settings
- [ ] Add `user_shared_settings: {}` to default settings

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
| `notor-blocking` | — | `blocking` |

- [ ] Implement `parseExtensionFile()` function
- [ ] Implement `extractYamlFence()` helper (returns first YAML fence content or null)
- [ ] Implement `extractCodeFence()` helper (returns first TS/JS fence content or null)
- [ ] Validate frontmatter fields with type checking and error reporting
- [ ] Handle edge cases: missing fences, empty fences, multiple fences (take first only)

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

- [ ] Implement `paramSchemaToJsonSchema(params: ParamSchema): JSONSchema`
- [ ] Handle all type mappings: `string`, `number`, `boolean`, `string[]`
- [ ] Compute `required` array correctly (params without defaults)

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

/** Resolve settings values at runtime. */
async function resolveSettings(
  schemas: SettingsFieldSchema[],
  extensionName: string,
  persistedValues: Record<string, string | number | boolean | string[]>,
  app: App
): Promise<{ values: Record<string, unknown>; missing: string[] }>

/** Resolve shared settings values at runtime. */
async function resolveSharedSettings(
  schemas: SettingsFieldSchema[],
  persistedValues: Record<string, string | number | boolean | string[]>,
  app: App
): Promise<{ values: Record<string, unknown>; missing: string[] }>
```

- [ ] Implement `parseSettingsSchema()`
- [ ] Implement `resolveSettings()` with SecretStorage integration for `secret: true` fields
- [ ] Implement `resolveSharedSettings()` for the global `notor/settings.md` settings
- [ ] Validate required settings (no `default`, not yet configured) — produce clear error messages

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

- [ ] Implement `stripTypes()` function
- [ ] Handle Sucrase errors (syntax errors in user code) — return descriptive error messages
- [ ] Verify that common TS patterns work: type annotations, interfaces, generics, `as` casts, type-only imports (which should be stripped)

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

- [ ] Implement `compileToolFunction()` and `compileAutomationFunction()`
- [ ] Handle compilation errors (syntax errors that survive type stripping) — return descriptive messages with file path
- [ ] Implement full `compileExtension()` pipeline: `stripTypes()` → `compile*Function()`

### EXT-010 — Build injected context objects

Assemble the `utils` and `libs` objects passed to extensions at runtime.

**File:** `src/extensions/runtime-context.ts`

**`utils` object:** References to existing utilities — must be a stable facade.

```typescript
function buildUtils(plugin: NotorPlugin): Record<string, unknown> {
  return {
    resolveNote: (path: string) => resolveNote(plugin.app.vault, plugin.app.metadataCache, path),
    staleTracker: plugin.getStaleContentTracker(),
    checkpointManager: plugin.getCheckpointManager(),
    noteOpener: plugin.getNoteOpener(),
    logger: (name: string) => logger(`ext:${name}`),
    resolveAndValidatePath: (path: string) => resolveAndValidatePath(path, plugin.vaultRootPath, plugin.settings.read_file_allowed_paths),
    executeShellCommand: (cmd: string, opts?: unknown) => executeShellCommand(cmd, plugin.settings, opts),
  };
}
```

**`libs` object:** References to bundled libraries.

```typescript
import mammoth from "mammoth";
import TurndownService from "turndown";
import * as unpdf from "unpdf";
import * as docx from "docx";
import PizZip from "pizzip";
import { marked } from "marked";
import * as xmldom from "@xmldom/xmldom";
import { Cron } from "croner";

function buildLibs(): Record<string, unknown> {
  return {
    mammoth,
    Turndown: TurndownService,
    unpdf,
    docx,
    PizZip,
    marked,
    xmldom,
    croner: { Cron },
  };
}
```

**Note on `unpdf`:** Currently dynamically imported in `src/media/pdf-processor.ts`. The `libs` object should use the same lazy import pattern or accept that it's bundled.

- [ ] Implement `buildUtils()` — verify each utility reference resolves correctly from `main.ts` accessors
- [ ] Implement `buildLibs()` — verify all 9 libraries import correctly
- [ ] Handle the `unpdf` dynamic import edge case (either eager import or lazy proxy)
- [ ] Implement `buildObsidianExports()` — expose commonly needed `obsidian` module exports (`requestUrl`, `Notice`, `TFile`, `getFrontMatterInfo`, `normalizePath`, etc.)

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
1. Resolve `{notorDir}/tools/` directory — list `.md` files
2. For each file: read content, check `notor-type: tool` in frontmatter, parse via `parseExtensionFile()`
3. Resolve `{notorDir}/automations/` directory — list `.md` files
4. For each file: read content, check `notor-type: automation` in frontmatter, parse via `parseExtensionFile()`
5. Check for `{notorDir}/settings.md` — if exists and has `notor-type: settings`, parse shared settings
6. Collect all errors with file paths for user-visible reporting

- [ ] Implement `discoverExtensions()` function
- [ ] Handle missing directories gracefully (no error, just empty results)
- [ ] Handle malformed files gracefully (log error, skip file, continue)
- [ ] Sort automations by `order` (ascending), then alphabetically by filename for ties

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
    private readonly app: App,
    private readonly plugin: NotorPlugin,
    private readonly vault: Vault,
    private readonly metadataCache: MetadataCache,
    private readonly settings: NotorSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly parseYAML: (yaml: string) => unknown,
  ) {}

  /** Full discovery + compilation + registration cycle. */
  async reload(): Promise<ExtensionReloadResult>

  /** Get all compiled user tools (for registration). */
  getTools(): UserToolDefinition[]

  /** Get all compiled automations matching a specific trigger. */
  getAutomationsForTrigger(trigger: AutomationTrigger): UserAutomationDefinition[]

  /** Get automations matching a trigger + tool name filter. */
  getAutomationsForToolEvent(
    trigger: "on_tool_call" | "on_tool_result",
    toolName: string
  ): UserAutomationDefinition[]

  /** Get resolved shared settings object. */
  async getResolvedSharedSettings(): Promise<Record<string, unknown>>

  /** Get resolved per-extension settings. */
  async getResolvedSettings(extensionName: string): Promise<Record<string, unknown>>

  /** Destroy and clean up. */
  destroy(): void
}
```

**Reload flow:**
1. Discover all extensions via `discoverExtensions()`
2. For each tool: strip types → compile → validate. Store in `this.tools`
3. For each automation: strip types → compile → validate. Store in `this.automations`
4. Parse shared settings from `notor/settings.md` (if present)
5. Register tools in `ToolRegistry` and `ToolDispatcher` (overwrites built-in if same name)
6. Report errors via Obsidian Notice + logger
7. Return summary: `{ toolCount, automationCount, errors }`

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

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    // 1. Resolve settings + shared settings
    // 2. Build injected context (app, obsidian, utils, libs, settings, shared, params)
    // 3. Call compiled function
    // 4. Wrap return value as ToolResult
    // 5. On error: Notice + logger + return { success: false, error }
  }
}
```

- [ ] Implement `ExtensionManager` class with all methods
- [ ] Implement `UserToolAdapter` class implementing `Tool` interface
- [ ] Implement the `reload()` flow with error aggregation
- [ ] Implement tool registration (register in both `ToolRegistry` and `ToolDispatcher`)
- [ ] Track which tool names were registered by extensions so they can be unregistered on reload (before re-registering)

---

## Phase 5: Automation Dispatch Integration

### EXT-013 — Integrate automations with LLM lifecycle hooks

Extend the four LLM lifecycle dispatch functions to fire matching user automations after shell hooks.

**File:** `src/hooks/hook-events.ts` (modify existing)

**Execution order per the design doc:**
1. Global shell hooks (existing)
2. Workflow-scoped hooks (existing, if override active)
3. Vault-defined automations (new — sorted by `notor-automation-order`)

**Changes to each dispatch function:**

- `dispatchPreSend()`:
  - After shell hooks, get automations with `trigger: "pre_send"` from `ExtensionManager`
  - Execute blocking automations sequentially (inherently blocking)
  - Collect returned strings and append to stdout array
  - Signature: add `extensionManager?: ExtensionManager` parameter

- `dispatchOnToolCall()`:
  - After shell hooks, get automations with `trigger: "on_tool_call"` filtered by `toolName`
  - Execute blocking automations first (sequential, awaited)
  - Fire non-blocking automations in parallel
  - Build `context` object with `toolName`, `params`, `conversationId`, `timestamp`, `hookEvent`

- `dispatchOnToolResult()`:
  - After shell hooks, get automations with `trigger: "on_tool_result"` filtered by `toolName`
  - Execute blocking automations first (sequential, awaited)
  - Fire non-blocking automations in parallel
  - Build `context` object with `toolName`, `params`, `result`, `status`, `conversationId`, `timestamp`, `hookEvent`

- `dispatchAfterCompletion()`:
  - After shell hooks, get automations with `trigger: "after_completion"`
  - Execute blocking then non-blocking

**Context object construction:**

```typescript
function buildAutomationContext(
  trigger: AutomationTrigger,
  hookData: {
    conversationId?: string;
    toolName?: string;
    params?: Record<string, unknown>;
    result?: string;
    status?: "success" | "error";
    notePath?: string;
    oldTags?: string[];
    newTags?: string[];
    schedule?: string;
  }
): Record<string, unknown> {
  return {
    hookEvent: trigger,
    timestamp: new Date().toISOString(),
    ...hookData,
  };
}
```

- [ ] Add `extensionManager` parameter to all four dispatch functions
- [ ] Implement automation execution within each dispatch function
- [ ] Implement blocking vs. non-blocking ordering per design doc
- [ ] Build context objects for each event type
- [ ] Handle automation errors: Notice + logger (no ToolResult for automations)
- [ ] Respect `notor-tools` filter for `on_tool_call` and `on_tool_result`

### EXT-014 — Integrate automations with vault event hooks

Extend vault event dispatch to include user automations alongside shell hooks and workflows.

**File:** `src/hooks/vault-event-handlers.ts` (modify existing)
**File:** `src/hooks/vault-event-dispatcher.ts` (modify existing)

**Execution order per design doc:**
1. Shell hooks (existing)
2. Workflow hooks (existing)
3. Vault-defined automations (new)

**Changes:**

- `collectHooksAndWorkflows()` → rename to `collectHooksWorkflowsAndAutomations()` or add automations to return value
- `handleNoteOpen()`, `handleNoteCreate()`, `handleModify()`, etc. — pass automations to dispatch
- `dispatchVaultEventHooks()` — execute automations after hooks and workflows

**Vault event context for automations:**

```typescript
// on_note_open, on_note_create, on_save, on_manual_save:
{ hookEvent, timestamp, notePath }

// on_tag_change:
{ hookEvent, timestamp, notePath, oldTags, newTags }

// on_schedule:
{ hookEvent, timestamp, schedule }
```

**`on_schedule` integration:** Automations with `notor-trigger: on_schedule` need cron timers. Extend `VaultEventScheduler` to include automation schedules alongside workflow schedules and shell hook schedules.

- [ ] Extend `collectHooksAndWorkflows()` to include matching automations
- [ ] Extend `dispatchVaultEventHooks()` to execute automations
- [ ] Build vault event context objects
- [ ] Extend `VaultEventListenerManager.evaluateListeners()` to consider automation triggers
- [ ] Extend `VaultEventScheduler` for `on_schedule` automations
- [ ] Ensure loop prevention (`ExecutionChainTracker`) works with automations

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

- [ ] Implement `renderExtensionsSection()` function
- [ ] Implement shared settings sub-section (from `notor/settings.md`)
- [ ] Implement per-extension settings sub-sections (one per tool/automation that has `settings`)
- [ ] Implement field rendering for all 6 type variants
- [ ] Implement "Reset to defaults" button per extension (clears `user_extension_settings[name]`)
- [ ] Implement "Reload extensions" button (calls `extensionManager.reload()`)
- [ ] Hide group entirely if no extensions have settings and no shared settings exist
- [ ] Wire into `settings-tab.ts` render pipeline

### EXT-016 — Register reload command

Add the `notor:reload-extensions` Obsidian command.

**File:** `src/main.ts` (modify existing)

- [ ] Register command `notor:reload-extensions` with label "Reload user extensions"
- [ ] Command callback: call `extensionManager.reload()`, show Notice with summary
- [ ] Command only available on desktop (same as shell hooks)

---

## Phase 7: main.ts Wiring & Lifecycle

### EXT-017 — Wire ExtensionManager into plugin lifecycle

Initialize and integrate the extension manager into the plugin's startup and teardown.

**File:** `src/main.ts` (modify existing)

**Startup sequence:**

```
onload()
  → onLayoutReady()
    → existing: workflow discovery, vault watcher, etc.
    → NEW: extensionManager.reload()
      → discovers tools, automations, shared settings
      → compiles all extensions
      → registers user tools in ToolRegistry + ToolDispatcher
```

**Lazy accessor pattern (matches existing):**

```typescript
private _extensionManager: ExtensionManager | null = null;

getExtensionManager(): ExtensionManager {
  if (!this._extensionManager) {
    this._extensionManager = new ExtensionManager(
      this.app, this, this.app.vault, this.app.metadataCache,
      this.settings, () => this.saveSettings(),
      parseYaml,
    );
  }
  return this._extensionManager;
}
```

**Integration points in main.ts:**

1. `getToolRegistry()` — call `extensionManager.reload()` after registering built-in tools (ensures user tools overwrite built-ins)
2. `getToolDispatcher()` — user tools already registered via reload, no extra wiring needed
3. `_initMcpHub()` — no changes needed (MCP tools register independently)
4. Orchestrator — pass `extensionManager` to dispatch functions for automation firing
5. `onunload()` — call `extensionManager.destroy()`

**Passing to hook dispatch:**

The orchestrator needs to pass `extensionManager` when calling `dispatchPreSend()`, `dispatchOnToolCall()`, `dispatchOnToolResult()`, `dispatchAfterCompletion()`. This follows the same pattern as `WorkflowHookOverrideManager`.

- [ ] Create `getExtensionManager()` lazy accessor
- [ ] Wire initial `reload()` into `onLayoutReady()` (after tool registry initialization)
- [ ] Pass `extensionManager` to orchestrator
- [ ] Pass `extensionManager` through to all four LLM lifecycle dispatch calls
- [ ] Pass `extensionManager` through to vault event handler deps
- [ ] Wire `extensionManager.destroy()` into `onunload()`
- [ ] Ensure reload ordering: built-in tools → user tools → MCP tools (MCP is async, so user tools may register before MCP connects — that's fine, MCP tools don't conflict with user tools)

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

- [ ] Implement try/catch in `UserToolAdapter.execute()`
- [ ] Implement try/catch in automation execution paths
- [ ] Implement compilation error reporting in `reload()`
- [ ] Implement required settings validation before execution

---

## Phase 9: Testing

### EXT-019 — Unit tests for parsing pipeline

**File:** `src/extensions/__tests__/parser.test.ts`

- [ ] Test: valid tool file parses correctly (frontmatter + YAML fence + code fence)
- [ ] Test: valid automation file parses correctly
- [ ] Test: valid settings file parses correctly
- [ ] Test: missing required frontmatter fields produce errors
- [ ] Test: missing code fence produces error
- [ ] Test: YAML fence parsing with `params` and `settings` blocks
- [ ] Test: code fence extraction with different language tags (ts, typescript, js, javascript)
- [ ] Test: prose outside fences is ignored

### EXT-020 — Unit tests for param schema conversion

**File:** `src/extensions/__tests__/param-schema.test.ts`

- [ ] Test: basic types (string, number, boolean) convert correctly
- [ ] Test: `string[]` converts to array schema
- [ ] Test: params with defaults are not in `required`
- [ ] Test: params without defaults are in `required`
- [ ] Test: `enum` field maps correctly

### EXT-021 — Unit tests for compilation pipeline

**File:** `src/extensions/__tests__/compiler.test.ts`

- [ ] Test: TypeScript type annotations are stripped
- [ ] Test: interface declarations are stripped
- [ ] Test: `as` casts are stripped
- [ ] Test: JavaScript code passes through unchanged
- [ ] Test: compiled function is callable with correct arguments
- [ ] Test: syntax errors produce descriptive error messages
- [ ] Test: async/await works in compiled code

### EXT-022 — Unit tests for settings resolution

**File:** `src/extensions/__tests__/settings-schema.test.ts`

- [ ] Test: schema defaults are used when no persisted values exist
- [ ] Test: persisted values override defaults
- [ ] Test: missing required settings (no default, no persisted) are reported
- [ ] Test: type validation for each field type

### EXT-023 — Integration tests

**File:** `src/extensions/__tests__/manager.test.ts`

- [ ] Test: full reload cycle discovers and compiles tools
- [ ] Test: user tool registers in ToolRegistry and overwrites built-in
- [ ] Test: user tool execute() returns ToolResult
- [ ] Test: automation fires for matching trigger
- [ ] Test: automation `notor-tools` filter works
- [ ] Test: blocking vs non-blocking automation ordering
- [ ] Test: reload clears previous registrations before re-registering

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
Phase 7 (EXT-017)
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
**Mitigation:** Obsidian desktop (Electron) has no restrictive CSP for plugin code. Community plugins already use dynamic code evaluation. Mobile Obsidian may have restrictions — verify during testing. If blocked on mobile, extensions are desktop-only (consistent with shell hooks).

### R-3: User tool overwrites built-in with broken implementation

**Risk:** A user tool named `read_note` that throws on every call effectively disables note reading.
**Mitigation:** Phase 2 migration (future) adds a "Reset to default" button. For Phase 1, the reload mechanism lets users fix the file and reload. Built-in tools always re-register first, so deleting the user tool file and reloading restores the built-in.

### R-4: Automation infinite loops

**Risk:** A blocking `on_tool_result` automation that calls `app.vault.process()` could trigger `on_save` hooks, which trigger workflows, which call tools, which trigger the automation again.
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

## Open Questions

### Q-1: Path enforcement for user tools

User tools manage their own path handling (they call `app.vault.read()` directly). Should `TOOL_PATH_PARAMS` in `path-enforcer.ts` be extended to support user-declared path params? **Proposed:** Defer to Phase 2. User tools are trusted code — they run with full `app` access.

### Q-2: Tool concurrency classification

`partitionToolCalls()` in `tool-orchestration.ts` classifies tools as concurrent-safe (read) or not (write). User tools with `mode: "read"` should be concurrent-safe. **Proposed:** Use the `mode` field directly — same logic as built-in tools.

### Q-3: User tool names in `<notor_tool_config>` blocks

User tools participate in the tool config system. They can be enabled/disabled and have auto_approve set by personas/workflows/rules. **Proposed:** This works automatically — tool config operates on tool names, and user tools are in the registry with their declared names.

### Q-4: Extension file watching

The design doc specifies manual reload only. Should we also watch `notor/tools/` and `notor/automations/` for file changes and prompt the user to reload? **Proposed:** Defer. Manual reload is simpler and avoids the compilation timing issues noted in the design doc.
