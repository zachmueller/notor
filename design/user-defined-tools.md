# Design: User-Defined Extensions (Vault-Authored TypeScript)

**Created:** 2026-04-05
**Status:** Exploration

## Problem

Notor's tool system and hook system are currently closed to user authoring. Users can extend the tool surface through MCP servers, but MCP requires running an external process and writing a protocol-compliant server — a high bar for most users. Meanwhile, personas, workflows, rules, and sub-agent profiles are all defined as Markdown files in the vault, making them accessible to anyone comfortable editing notes.

Beyond new tools, users have no way to customize existing built-in tool behavior. A user who wants `read_note` to strip HTML comments, or `write_note` to auto-tag created notes, must request a feature or write an MCP server. Similarly, lifecycle hooks are limited to shell commands — users who want to interact with the vault in response to tool calls must work outside Obsidian's APIs.

## Core Idea

Introduce two vault-defined extension types that share a common TypeScript runtime:

- **Vault-defined tools** (`notor/tools/*.md`) — called by the LLM via tool_use, return a `ToolResult`
- **Vault-defined automations** (`notor/automations/*.md`) — fire at LLM lifecycle hook events, run as side effects

Both are Markdown notes with YAML frontmatter + fenced code blocks (YAML for configuration, TypeScript/JavaScript for logic). Prose outside the code fences serves as user-facing documentation visible in Obsidian. At plugin load, Notor discovers these files, extracts the code fences, strips types, compiles via `new Function()`, injects Obsidian APIs and bundled libraries as arguments, and registers them appropriately.

A third extension type shares the same file format:

- **Global extension settings** (`notor/settings.md`) — declares shared settings accessible to all tools and automations via a `shared` object

---

## Shared Runtime

Both tools and automations share the same underlying execution infrastructure.

### File Format Convention

All user-defined extensions are **Markdown notes** (`.md`). The code lives inside a single fenced code block. This mirrors how workflows are already Markdown notes with frontmatter — extensions add a code fence.

**Parsing rules:**
- **YAML fence** — The plugin extracts the first ` ```yaml``` ` fenced code block. This contains nested configuration (parameter schemas, settings schemas) that would exceed Obsidian frontmatter's depth limitations. Optional — extensions without params or settings can omit it.
- **Code fence** — The plugin extracts the first ` ```ts``` `, ` ```typescript``` `, ` ```js``` `, or ` ```javascript``` ` fenced code block. This contains the extension's executable logic.
- Everything outside the fences (prose, headings, etc.) is documentation — ignored by the runtime but visible when the user opens the note in Obsidian. This lets users document what the extension does, why it exists, and how to customize it, all in the same file.

**Split between frontmatter and YAML fence:** Flat scalar fields (`notor-tool-name`, `notor-description`, `notor-mode`, `notor-trigger`, `notor-display-name`, etc.) live in frontmatter. Nested structures (`params`, `settings`) live in the YAML code fence to avoid Obsidian's frontmatter depth limitations.

### Injected Context (Shared)

All user-defined extension code executes with these variables in scope:

#### Obsidian APIs

| Variable | Type | Description |
|----------|------|-------------|
| `app` | `App` | Full Obsidian App instance (access `app.vault`, `app.metadataCache`, `app.fileManager`, `app.workspace`, etc.) |
| `obsidian` | module | Obsidian module exports (`requestUrl`, `Notice`, `TFile`, `getFrontMatterInfo`, etc.) |

#### Notor Utilities

| Variable                               | Type                  | Description                                                        |
| -------------------------------------- | --------------------- | ------------------------------------------------------------------ |
| `utils.resolveNote(path)`              | function              | Resolve a note path (handles bare names, missing `.md`, wikilinks) |
| `utils.staleTracker`                   | `StaleContentTracker` | Record reads and check for concurrent edits before writes          |
| `utils.checkpointManager`              | `CheckpointManager`   | Create snapshots before destructive operations                     |
| `utils.noteOpener`                     | `NoteOpener`          | Open notes in the editor                                           |
| `utils.logger(name)`                   | function              | Create a scoped logger                                             |
| `utils.resolveAndValidatePath(path)`   | function              | Validate and resolve filesystem paths                              |
| `utils.executeShellCommand(cmd, opts)` | function              | Run a shell command                                                |

#### Bundled Libraries

| Variable | Library | Use Case |
|----------|---------|----------|
| `libs.mammoth` | mammoth | DOCX to HTML conversion |
| `libs.Turndown` | turndown | HTML to Markdown conversion |
| `libs.unpdf` | unpdf | PDF text extraction |
| `libs.docx` | docx | Programmatic DOCX generation |
| `libs.PizZip` | pizzip | ZIP/DOCX archive manipulation |
| `libs.marked` | marked | Markdown parsing and lexing |
| `libs.xmldom` | @xmldom/xmldom | XML/DOM parsing |
| `libs.croner` | croner | Cron expression parsing |

All of these are already bundled into the plugin by esbuild. Exposing them is zero-cost — just passing references to loaded modules.

#### Extension Settings

| Variable | Type | Description |
|----------|------|-------------|
| `settings` | `Record<string, unknown>` | Per-extension settings declared in the YAML fence's `settings` block, resolved from schema defaults + user-configured values. See [Extension Settings](#extension-settings). |
| `shared` | `Record<string, unknown>` | Global shared settings from `notor/settings.md`, available to all extensions. Empty `{}` if no shared settings exist. |

### Compilation Pipeline

1. **Discover** — scan `notor/tools/`, `notor/automations/`, and `notor/settings.md` recursively on plugin load and on manual reload. Files must be `.md` with `notor-type` frontmatter set to `tool`, `automation`, or `settings`.
2. **Parse** — extract YAML frontmatter (flat fields), locate the first YAML fenced code block (nested config: `params`, `settings`), and locate the first TypeScript/JavaScript fenced code block (logic).
3. **Strip types** — run the code block through sucrase (or regex for simple cases) to remove TypeScript type annotations.
4. **Resolve settings** — merge schema defaults with persisted user values and SecretStorage secrets to produce the `settings` and `shared` objects.
5. **Compile** — create an `async` function via `new AsyncFunction(argNames..., strippedCode)` with the injected context variables (including `settings`, `shared`) as named arguments. The function body is wrapped as `async` so user code can use `await` directly (most vault operations are async). `AsyncFunction` is obtained via `Object.getPrototypeOf(async function(){}).constructor`.
6. **Cache** — store the compiled function keyed by file path. Recompile on manual reload.

**Manual reload:** Extensions are recompiled on demand — there is no automatic hot reload on vault file changes. This avoids uncertain compilation timing if users edit extension files while the LLM is mid-operation. Two reload mechanisms are provided:

- **Settings UI** — A "Reload extensions" button in the Extensions settings group re-discovers and recompiles all extensions.
- **Command** — The `notor:reload-extensions` Obsidian command does the same, accessible from the command palette or a hotkey.

In-flight tool calls continue using the version compiled at dispatch time; reloaded versions apply to subsequent calls.

### Error Handling

When a user extension throws at runtime, errors are surfaced through three channels:

**Tools:**
1. **Notice** — An Obsidian Notice is shown with the error message for immediate visibility.
2. **ToolResult** — The error is returned to the LLM as `{ success: false, error: "<message>" }` so the LLM can react appropriately.
3. **Logger** — The full stack trace is written via the extension's scoped logger (`utils.logger(name)`) for debugging.

Tool code can also return a custom error result directly (e.g., `return { success: false, error: "Note not found — try a different path" }`) to control the message the LLM sees and direct its reaction to the specific failure, without throwing an exception.

**Automations:**
1. **Notice** — An Obsidian Notice is shown with the error message.
2. **Logger** — The full stack trace is written via the extension's scoped logger.

Automations have no ToolResult channel since they are side effects, not tool invocations.

### Type Stripping Strategy

| Approach | Size | Coverage | Tradeoffs |
|----------|------|----------|-----------|
| **Sucrase** | ~50KB | Full TS syntax minus `enum`, `namespace` | Battle-tested, fast, minimal bundle impact |
| **Regex-based** | ~0KB | Simple type annotations only | Fragile on complex types, but extensions are short |
| **Accept JS only** | 0KB | N/A | Worse DX; users expect TS in a TS project |

**Decision: Sucrase.** It is small (~50KB), fast, and handles the full TypeScript syntax surface users need in extension bodies. The TS code fence signals to Obsidian's editor to provide syntax highlighting.

### API Stability Considerations

The injected context (`app`, `obsidian`, `utils`, `libs`) becomes a public API contract. Changes to the `utils` surface (e.g., renaming `staleTracker` methods, changing `CheckpointManager` interface) become breaking changes for user extensions.

Mitigations:
- Keep `utils` as a stable facade with documented methods, not raw internal objects
- Version the injected API shape (e.g., `notor-api: 1` in frontmatter) so the plugin can warn on breaking changes
- Obsidian's own API (`app`, `vault`, `metadataCache`) is already stable — that's the majority of what extensions use

### Security Model

User extensions run with full `app` access — the same trust level as the plugin itself. This is consistent with Obsidian's security model: community plugins already have unrestricted access, and Notor workflows can execute arbitrary shell commands via hooks. Users should treat extension code with the same caution as any plugin code. Documentation should note this explicitly so users understand the trust boundary.

---

## Vault-Defined Tools

### File Format

````markdown
<!-- notor/tools/read_note.md -->
---
notor-type: tool
notor-tool-name: read_note
notor-description: "Read a vault note, stripping HTML comments"
notor-mode: read
---

# Read Note (Custom)

Customized version of the built-in `read_note` tool that strips HTML comments
from note content before returning it.

```yaml
params:
  path:
    type: string
    description: "Path to note relative to vault root"
  include_frontmatter:
    type: boolean
    description: "Include YAML frontmatter"
    default: false
```

```typescript
const file = utils.resolveNote(params.path);
if (!file) return { success: false, error: `Note not found: ${params.path}` };

let content = await app.vault.read(file);

if (!params.include_frontmatter) {
  const fmInfo = obsidian.getFrontMatterInfo(content);
  if (fmInfo.exists) {
    content = content.slice(fmInfo.contentStart).replace(/^\n/, "");
  }
}

// User customization: strip HTML comments
content = content.replace(/<!--[\s\S]*?-->/g, "");

return { success: true, result: content };
```
````

### Frontmatter Schema

| Field | Required | Description |
|-------|----------|-------------|
| `notor-type` | yes | Must be `tool`. Identifies this note as a vault-defined tool. |
| `notor-tool-name` | yes | Tool name (unique identifier). If it matches a built-in tool name, overrides it. |
| `notor-description` | yes | Human-readable description sent to the LLM. Reuses the same property used by sub-agent profiles. |
| `notor-mode` | yes | `"read"` or `"write"`. Determines Plan/Act mode behavior. |

### YAML Fence Schema

| Field | Required | Description |
|-------|----------|-------------|
| `params` | yes | Parameter schema (simplified YAML that maps to JSON Schema). |
| `settings` | no | Settings schema — declares user-configurable fields rendered in the settings UI. See [Extension Settings](#extension-settings). |

### Tool-Specific Injected Context

In addition to the shared runtime, tools receive:

| Variable | Type | Description |
|----------|------|-------------|
| `params` | `Record<string, unknown>` | Parameters passed by the LLM, validated against the YAML fence schema |

The function body is expected to return a `ToolResult` object (`{ success, result, error? }`).

### Registration

1. User-defined tools register in `ToolRegistry` via the same `register()` method as built-in tools.
2. If a user tool's `notor-tool-name` matches a built-in tool, it replaces the built-in (last-write-wins; user tools load after built-ins).
3. User tools participate fully in the existing dispatch pipeline: Plan/Act enforcement, auto-approve resolution, `<notor_tool_config>` overrides, checkpoint creation, approval UI.

### Integration with Existing Systems

| System | Integration |
|--------|-------------|
| **Plan/Act mode** | Enforced via `notor-mode` field in frontmatter — identical to built-in tools |
| **Auto-approve** | Participates in the same resolution chain (global, persona, workflow, rule overrides) |
| **`<notor_tool_config>`** | User tools can be toggled/configured in persona/workflow/rule YAML blocks by name |
| **Effective Config Inspector** | User tools appear alongside built-in and MCP tools |
| **Tool call UI** | Rendered identically — name, parameters, result |
| **Diff view** | If a user tool calls `app.vault.process()`, diffs work the same way |
| **Checkpoints** | User tools can call `utils.checkpointManager.createCheckpoint()` directly |

### Built-in Tool Migration Path

Every existing built-in tool (except `use_subagent`) could be reimplemented as a vault-defined tool. The implementations are straightforward Obsidian API usage:

- `read_note` — ~80 lines: `app.vault.read()` + frontmatter stripping + stale tracking
- `write_note` — ~100 lines: `app.vault.create()`/`app.vault.process()` + frontmatter preservation + checkpoints
- `search_vault` — ~120 lines: file iteration + content matching
- `get_backlinks` / `get_outlinks` — ~40 lines: `app.metadataCache.resolvedLinks` queries
- `move_note` — ~50 lines: `app.fileManager.renameFile()` (auto-rewrites wikilinks)
- `manage_tags` — ~60 lines: `app.fileManager.processFrontMatter()`
- `fetch_webpage` — ~80 lines: `requestUrl()` + Turndown HTML-to-Markdown
- `web_search` — ~70 lines: `requestUrl()` to DuckDuckGo + HTML parsing
- `read_docx` / `write_docx` — ~150 lines: mammoth/docx library usage

#### Migration Strategy

Phase 1 (initial release): User-defined tools work alongside built-ins. Built-ins remain as TypeScript classes in `src/tools/`.

Phase 2 (future): Expose built-in tools through a Settings UI that mirrors the existing sub-agent profile pattern:

- Built-in tools are listed in a "Built-in tools" section within the Extension settings group. Each entry shows the tool name, description, and a "Built-in" badge.
- A **"Customize"** button writes the tool's reference implementation to `notor/tools/{name}.md` and opens it for editing. This mirrors `SubAgentManager.ensureBuiltinVaultFile()`.
- A **"Reset to default"** button overwrites the vault file with the built-in implementation, discarding user customizations. This mirrors `SubAgentManager.resetToDefault()`.
- If no vault file exists for a tool, the built-in TypeScript class in `src/tools/` is used. If a vault file exists, it takes precedence (same override semantics as Phase 1).

This is a non-breaking, incremental path identical to the sub-agent profile pattern already shipped. Users who never customize tools get the same experience as today.

### Scope Exclusion

`use_subagent` remains a built-in-only tool. It orchestrates Notor's internal agent infrastructure (SubAgentManager, SubAgentRunner, isolated conversations) and is not meaningfully customizable via a tool body.

---

## Vault-Defined Automations

### File Format

````markdown
<!-- notor/automations/tag-ai-writes.md -->
---
notor-type: automation
notor-trigger: on_tool_result
notor-tools: [write_note, replace_in_note]
notor-display-name: "Tag AI-modified notes"
notor-automation-order: 10
---

# Tag AI-Modified Notes

Automatically adds a configurable tag to any note written or modified by the AI.
Only fires on successful write operations. The tag name can be changed in Settings.

```yaml
settings:
  tag_name:
    name: "Tag Name"
    type: string
    description: "Tag to add to AI-modified notes"
    default: "ai-modified"
```

```typescript
if (context.status !== "success") return;

const notePath = context.params.path as string;
const file = utils.resolveNote(notePath);
if (!file) return;

await app.fileManager.processFrontMatter(file, (fm: any) => {
  fm.tags = fm.tags || [];
  if (!fm.tags.includes(settings.tag_name)) fm.tags.push(settings.tag_name);
});
```
````

### Frontmatter Schema

| Field | Required | Description |
|-------|----------|-------------|
| `notor-type` | yes | Must be `automation`. Identifies this note as a vault-defined automation. |
| `notor-trigger` | yes | Hook event to fire on. LLM lifecycle: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion`. Vault events: `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule`. Reuses the same property used by workflows. |
| `notor-schedule` | conditional | Cron expression (required when `notor-trigger: on_schedule`). Same property used by workflows. |
| `notor-tools` | no | Array of tool names to filter on (only for `on_tool_call`/`on_tool_result`; ignored for other events). If omitted, fires for all tools. |
| `notor-display-name` | no | Human-readable label for settings UI and logging. Reuses the same property used by workflows. |
| `notor-automation-order` | no | Numeric execution priority. Lower values fire first. Default: `0`. Ties broken alphabetically by filename. |
| ~~`notor-blocking`~~ | — | **Removed.** All automations are fire-and-forget (except `pre_send` which is inherently blocking). The existing LLM lifecycle dispatch functions (`dispatchOnToolCall`, `dispatchOnToolResult`, `dispatchAfterCompletion`) use a fire-and-forget `void (async () => { ... })()` pattern — the orchestrator does not await them. Supporting true pipeline-blocking would require changing these signatures to `async` and updating all call sites, which is out of scope for the first iteration. |

### YAML Fence Schema (Automations)

| Field | Required | Description |
|-------|----------|-------------|
| `settings` | no | Settings schema — declares user-configurable fields rendered in the settings UI. See [Extension Settings](#extension-settings). |

### Automation-Specific Injected Context

In addition to the shared runtime (`app`, `obsidian`, `utils`, `libs`), automations receive a `context` object with event-specific data:

**Common fields (all events):**

| Field | Type | Description |
|-------|------|-------------|
| `context.timestamp` | `string` | ISO 8601 event timestamp |
| `context.hookEvent` | `string` | The event name |

**LLM lifecycle fields:**

| Field | Available On | Type | Description |
|-------|-------------|------|-------------|
| `context.conversationId` | all LLM events | `string` | Current conversation UUID |
| `context.toolName` | `on_tool_call`, `on_tool_result` | `string` | Tool that was called |
| `context.params` | `on_tool_call`, `on_tool_result` | `Record<string, unknown>` | Tool parameters (parsed, not serialized) |
| `context.result` | `on_tool_result` | `string` | Tool result output |
| `context.status` | `on_tool_result` | `"success" \| "error"` | Whether the tool succeeded |

**Vault event fields:**

| Field | Available On | Type | Description |
|-------|-------------|------|-------------|
| `context.notePath` | `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change` | `string` | Vault-relative path of the affected note |
| `context.oldTags` | `on_tag_change` | `string[]` | Tags before the change |
| `context.newTags` | `on_tag_change` | `string[]` | Tags after the change |
| `context.schedule` | `on_schedule` | `string` | The cron expression that fired |

Note: tools get `params` (from the LLM). Automations get `context` (from the hook lifecycle). This makes it unambiguous which type of extension you're writing.

### Return Semantics

| Event | Return Type | Behavior |
|-------|------------|----------|
| `pre_send` | `string \| void` | Inherently blocking — returned string injected into conversation |
| `on_tool_call` | `void` | Fire-and-forget side effect |
| `on_tool_result` | `void` | Fire-and-forget side effect |
| `after_completion` | `void` | Fire-and-forget side effect |
| `on_note_open` | `void` | Fire-and-forget side effect |
| `on_note_create` | `void` | Fire-and-forget side effect |
| `on_save` | `void` | Fire-and-forget side effect |
| `on_manual_save` | `void` | Fire-and-forget side effect |
| `on_tag_change` | `void` | Fire-and-forget side effect |
| `on_schedule` | `void` | Fire-and-forget side effect |

All automations are fire-and-forget — they execute asynchronously without blocking the pipeline. This matches existing shell hook behavior. The only exception is `pre_send`, which is inherently blocking because its return value is injected into the conversation.

**Ordering:** When multiple automations fire for the same event, they execute sequentially in `notor-automation-order` order (ascending, ties broken alphabetically).

### The `notor-tools` Filter

The `notor-tools` field in frontmatter is the key ergonomic improvement over shell hooks. Instead of writing `if (context.toolName === "write_note")` in the body, users declare the filter declaratively:

```yaml
notor-trigger: on_tool_result
notor-tools: [write_note, replace_in_note]
```

The plugin evaluates this filter *before* invoking the function — automations that don't match the current tool are skipped entirely (no overhead). This filter only applies to `on_tool_call` and `on_tool_result` events; it is ignored for vault events.

**MCP tools:** The `notor-tools` filter supports MCP tool names using the same `{serverName}__{toolName}` double-underscore naming convention used elsewhere in Notor. For example, `notor-tools: [write_note, my-server__query]` fires the automation for both the built-in `write_note` tool and the MCP tool `query` from `my-server`. MCP tools pass through the same dispatch pipeline as built-in and vault-defined tools, so no special handling is needed beyond using the correct name.

### Discovery & Registration

- Discovered from `notor/automations/` (`.md` files with `notor-type: automation` in frontmatter).
- Registered alongside existing shell hooks in the hook dispatch pipeline.
- Execution order: global shell hooks first, then vault-defined automations sorted by `notor-automation-order` (ascending, default `0`). Ties broken alphabetically by filename.
- Vault-defined automations do NOT replace shell hooks — they coexist. Shell hooks remain for users who prefer simple shell commands.

### Interaction with Existing Hook Systems

| System | Relationship |
|--------|-------------|
| **Global shell hooks** (settings UI) | Coexist. Shell hooks fire first, automations fire after. |
| **Workflow-scoped hooks** (G-004) | Automations are global by default. Workflow-scoped override could suppress them (future). |
| **Vault event hooks** (on_note_open, on_save, etc.) | Coexist. Vault-defined automations with vault event triggers register alongside existing shell/workflow hooks in the vault event dispatch pipeline. Execution order: shell hooks first, then workflow hooks, then vault-defined automations. |

---

## Extension Settings

Both tools and automations can declare a `settings` block in their YAML code fence. This provides user-configurable values that appear in the plugin's settings UI and are injected at runtime.

### Settings Schema

Each entry under `settings:` declares one setting field:

| Property | Required | Type | Description |
|----------|----------|------|-------------|
| `name` | yes | `string` | Human-readable label displayed as the setting name in the UI (maps to Obsidian `Setting.setName()`) |
| `type` | yes | `"string" \| "number" \| "boolean" \| "string[]"` | Value type |
| `description` | no | `string` | Sub-text displayed below the setting name (maps to Obsidian `Setting.setDesc()`) |
| `default` | no | matches `type` | Default value (used if user hasn't configured) |
| `secret` | no | `boolean` | If `true`, stored in Obsidian's `SecretStorage` API (OS-level encrypted storage) and rendered via `SecretComponent`. Same mechanism used for API keys elsewhere in the plugin. |
| `min` | no | `number` | Minimum value (number type only) |
| `max` | no | `number` | Maximum value (number type only) |
| `options` | no | `string[]` | Enum constraint — renders as dropdown (string type only) |

### Example: Tool with Settings

````markdown
---
notor-type: tool
notor-tool-name: custom_search
notor-description: "Search via custom API"
notor-mode: read
---

# Custom Search

Searches a custom API. Configure the API key and timeout in Settings.

```yaml
params:
  query:
    type: string
    description: "Search query"
  num_results:
    type: number
    description: "Number of results"
    default: 5
settings:
  api_key:
    name: "API Key"
    type: string
    description: "API key for the search service"
    secret: true
  timeout:
    name: "Request Timeout"
    type: number
    description: "Request timeout in seconds"
    default: 30
  base_url:
    name: "API Base URL"
    type: string
    description: "Base URL for the search API"
    default: "https://api.example.com"
```

```typescript
const resp = await obsidian.requestUrl({
  url: `${settings.base_url}/search?q=${params.query}&n=${params.num_results}`,
  headers: { Authorization: `Bearer ${settings.api_key}` },
  timeout: settings.timeout * 1000,
});
return { success: true, result: resp.text };
```
````

### Global Shared Settings

Built-in tools already share settings across tools — `domain_denylist` is used by both `fetch_webpage` and `web_search`, and `read_file_allowed_paths` is shared by 6 file tools. User-defined extensions need the same capability.

A dedicated `notor/settings.md` file defines shared settings using the same schema:

````markdown
<!-- notor/settings.md -->
---
notor-type: settings
---

# Shared Extension Settings

Settings shared across multiple user-defined tools and automations.

```yaml
settings:
  custom_domain_denylist:
    name: "Custom Domain Denylist"
    type: string[]
    description: "Domains blocked from custom tools"
    default: []
  shared_api_key:
    name: "Shared API Key"
    type: string
    description: "API key used by multiple tools"
    secret: true
```
````

Global settings are injected as a `shared` object alongside `settings`:

```typescript
// In any tool or automation body:
const blocked = shared.custom_domain_denylist; // from notor/settings.md
const timeout = settings.timeout;              // from this extension's own settings
```

The `shared` object is always available (empty `{}` if `notor/settings.md` doesn't exist or has no settings).

### Storage

Two generic buckets in `NotorSettings`:

```typescript
/** Per-extension settings, keyed by extension name then setting key. */
user_extension_settings: Record<string, Record<string, string | number | boolean | string[]>>;

/** Global shared extension settings, keyed by setting key. */
user_shared_settings: Record<string, string | number | boolean | string[]>;
```

Both default to `{}`. Populated lazily as users configure extensions.

Settings with `secret: true` use Obsidian's `SecretStorage` API (via existing `getSecret()`/`setSecret()` helpers). Secret ID conventions:
- Per-extension: `notor-ext-{extension-name}-{setting-key}`
- Shared: `notor-shared-{setting-key}`

Secret values are stored in OS-level encrypted storage (Keychain on macOS, DPAPI on Windows, libsecret on Linux) via Obsidian's `SecretStorage` API — never persisted in `data.json`.

### Settings UI

The plugin auto-generates a settings UI section from each extension's `settings` schema. This appears under a new **"Extension settings"** collapsible group in the settings tab.

Rendering per field type:
- `type: string` + no `options` → text input
- `type: string` + `secret: true` → `SecretComponent` (password-masked input backed by Obsidian's `SecretStorage` API for OS-level encrypted storage — the same mechanism used for Anthropic/OpenAI API keys in the plugin)
- `type: string` + `options` → dropdown
- `type: number` → text input with numeric validation (respects `min`/`max`)
- `type: boolean` → toggle
- `type: string[]` → dynamic list with add/remove buttons (same pattern as the domain denylist)

Global shared settings render in their own sub-section labeled "Shared settings" at the top of the group. Each per-extension section includes a **"Reset to defaults"** button.

Extensions with no `settings` block don't appear in the settings UI. If no extensions have settings, the group is hidden entirely.

### Runtime Resolution

At execution time, `settings` and `shared` are resolved by merging:

1. Schema defaults from the YAML fence
2. Persisted values from `user_extension_settings[name]` / `user_shared_settings`
3. Secret values from SecretStorage (for `secret: true` fields)

**Validation:** Before executing, the runtime checks that all required settings (no `default`, not yet configured by the user) have values. Missing required settings produce an error returned to the LLM: `"Tool 'custom_search' requires setting 'api_key' to be configured in Settings."` This prevents cryptic runtime failures and applies to both per-extension and shared settings.

---

## Resolved Decisions

The following design questions were resolved during the exploration phase:

1. **Editor support (TS declaration file)** — Deferred. Not included in the first iteration. A `notor-extensions-api.d.ts` for autocomplete is future work.

2. **Hot reload** — Manual reload only. Extensions are recompiled via a Settings UI button ("Reload extensions") or the `notor:reload-extensions` command. No automatic hot reload on vault file changes, to avoid uncertain compilation timing during LLM operations. See [Compilation Pipeline](#compilation-pipeline).

3. **Error UX** — All three channels. Tools: Notice + ToolResult (`success: false`) + logger with stack trace. Automations: Notice + logger. Tool code can return custom `{ success: false, error: "..." }` to direct the LLM's reaction. See [Error Handling](#error-handling).

4. **Async support** — Yes. The compiled function is wrapped as `async` so user code can use `await` directly. See [Compilation Pipeline](#compilation-pipeline) step 5.

5. **Security model** — Documentation note. User extensions run with full `app` access, same trust level as the plugin. See [Security Model](#security-model).

6. **Automation ordering** — `notor-automation-order` numeric frontmatter field. Default `0`, ascending sort, alphabetical tie-break. See [Automations Frontmatter Schema](#frontmatter-schema-1) and [Discovery & Registration](#discovery--registration).

7. **MCP tool filter** — Yes. `notor-tools` supports MCP tool names using `{serverName}__{toolName}` double-underscore convention. See [The `notor-tools` Filter](#the-notor-tools-filter).

8. **Blocking automations** — **Removed.** All automations are fire-and-forget (except `pre_send` which is inherently blocking). The existing LLM lifecycle dispatch functions use a fire-and-forget pattern — the orchestrator does not await them. True pipeline-blocking would require changing dispatch signatures and all call sites, which is deferred. See [Return Semantics](#return-semantics).
