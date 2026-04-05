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

Both are Markdown notes with YAML frontmatter + a single fenced TypeScript/JavaScript code block. Prose outside the code fence serves as user-facing documentation visible in Obsidian. At plugin load, Notor discovers these files, extracts the code fence, strips types, compiles via `new Function()`, injects Obsidian APIs and bundled libraries as arguments, and registers them appropriately.

---

## Shared Runtime

Both tools and automations share the same underlying execution infrastructure.

### File Format Convention

All user-defined extensions are **Markdown notes** (`.md`). The code lives inside a single fenced code block. This mirrors how workflows are already Markdown notes with frontmatter — extensions add a code fence.

**Parsing rule:** The plugin extracts the first `` ```ts ```, `` ```typescript ```, `` ```js ```, or `` ```javascript `` fenced code block from the note body. Everything outside the fence (prose, headings, etc.) is documentation — ignored by the runtime but visible when the user opens the note in Obsidian. This lets users document what the extension does, why it exists, and how to customize it, all in the same file.

### Injected Context (Shared)

All user-defined extension code executes with these variables in scope:

#### Obsidian APIs

| Variable | Type | Description |
|----------|------|-------------|
| `app` | `App` | Full Obsidian App instance |
| `vault` | `Vault` | Shorthand for `app.vault` |
| `metadataCache` | `MetadataCache` | Shorthand for `app.metadataCache` |
| `fileManager` | `FileManager` | Shorthand for `app.fileManager` |
| `workspace` | `Workspace` | Shorthand for `app.workspace` |
| `obsidian` | module | Obsidian module exports (`requestUrl`, `Notice`, `TFile`, `getFrontMatterInfo`, etc.) |

#### Notor Utilities

| Variable | Type | Description |
|----------|------|-------------|
| `utils.resolveNote(path)` | function | Resolve a note path (handles bare names, missing `.md`, wikilinks) |
| `utils.staleTracker` | `StaleContentTracker` | Record reads and check for concurrent edits before writes |
| `utils.checkpointManager` | `CheckpointManager` | Create snapshots before destructive operations |
| `utils.noteOpener` | `NoteOpener` | Open notes in the editor |
| `utils.logger(name)` | function | Create a scoped logger |
| `utils.resolveAndValidatePath(path)` | function | Validate and resolve filesystem paths |
| `utils.executeShellCommand(cmd, opts)` | function | Run a shell command |

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

### Compilation Pipeline

1. **Discover** — scan `notor/tools/` and `notor/automations/` recursively on plugin load and on file changes. Files must be `.md` with the appropriate frontmatter marker (`notor-tool: true` or `notor-automation: true`).
2. **Parse** — extract YAML frontmatter and locate the first TypeScript/JavaScript fenced code block in the body.
3. **Strip types** — run the code block through sucrase (or regex for simple cases) to remove TypeScript type annotations.
4. **Compile** — create a function via `new Function(argNames..., strippedCode)` with the injected context variables as named arguments.
5. **Cache** — store the compiled function keyed by file path. Recompile only when the file changes.

### Type Stripping Strategy

| Approach | Size | Coverage | Tradeoffs |
|----------|------|----------|-----------|
| **Sucrase** | ~50KB | Full TS syntax minus `enum`, `namespace` | Battle-tested, fast, minimal bundle impact |
| **Regex-based** | ~0KB | Simple type annotations only | Fragile on complex types, but extensions are short |
| **Accept JS only** | 0KB | N/A | Worse DX; users expect TS in a TS project |

Recommendation: **Sucrase**. It's small, fast, and handles everything users would realistically write in an extension body. The TS code fence signals to Obsidian's editor to provide syntax highlighting.

### API Stability Considerations

The injected context (`app`, `vault`, `utils`, `libs`) becomes a public API contract. Changes to the `utils` surface (e.g., renaming `staleTracker` methods, changing `CheckpointManager` interface) become breaking changes for user extensions.

Mitigations:
- Keep `utils` as a stable facade with documented methods, not raw internal objects
- Version the injected API shape (e.g., `notor-api: 1` in frontmatter) so the plugin can warn on breaking changes
- Obsidian's own API (`app`, `vault`, `metadataCache`) is already stable — that's the majority of what extensions use

---

## Vault-Defined Tools

### File Format

````markdown
<!-- notor/tools/read_note.md -->
---
notor-tool: true
name: read_note
description: "Read a vault note, stripping HTML comments"
mode: read
params:
  path:
    type: string
    description: "Path to note relative to vault root"
  include_frontmatter:
    type: boolean
    description: "Include YAML frontmatter"
    default: false
---

# Read Note (Custom)

Customized version of the built-in `read_note` tool that strips HTML comments
from note content before returning it.

```typescript
const file = utils.resolveNote(params.path);
if (!file) return { success: false, error: `Note not found: ${params.path}` };

let content = await vault.read(file);

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
| `notor-tool` | yes | Must be `true`. Identifies this note as a vault-defined tool. |
| `name` | yes | Tool name (unique identifier). If it matches a built-in tool name, overrides it. |
| `description` | yes | Human-readable description sent to the LLM. |
| `mode` | yes | `"read"` or `"write"`. Determines Plan/Act mode behavior. |
| `params` | yes | Parameter schema (simplified YAML that maps to JSON Schema). |

### Tool-Specific Injected Context

In addition to the shared runtime, tools receive:

| Variable | Type | Description |
|----------|------|-------------|
| `params` | `Record<string, unknown>` | Parameters passed by the LLM, validated against the frontmatter schema |

The function body is expected to return a `ToolResult` object (`{ success, result, error? }`).

### Registration

1. User-defined tools register in `ToolRegistry` via the same `register()` method as built-in tools.
2. If a user tool's `name` matches a built-in tool, it replaces the built-in (last-write-wins; user tools load after built-ins).
3. User tools participate fully in the existing dispatch pipeline: Plan/Act enforcement, auto-approve resolution, `<notor_tool_config>` overrides, checkpoint creation, approval UI.

### Integration with Existing Systems

| System | Integration |
|--------|-------------|
| **Plan/Act mode** | Enforced via `mode` field in frontmatter — identical to built-in tools |
| **Auto-approve** | Participates in the same resolution chain (global, persona, workflow, rule overrides) |
| **`<notor_tool_config>`** | User tools can be toggled/configured in persona/workflow/rule YAML blocks by name |
| **Effective Config Inspector** | User tools appear alongside built-in and MCP tools |
| **Tool call UI** | Rendered identically — name, parameters, result |
| **Diff view** | If a user tool calls `vault.process()`, diffs work the same way |
| **Checkpoints** | User tools can call `utils.checkpointManager.createCheckpoint()` directly |

### Built-in Tool Migration Path

Every existing built-in tool (except `use_subagent`) could be reimplemented as a vault-defined tool. The implementations are straightforward Obsidian API usage:

- `read_note` — ~80 lines: `vault.read()` + frontmatter stripping + stale tracking
- `write_note` — ~100 lines: `vault.create()`/`vault.process()` + frontmatter preservation + checkpoints
- `search_vault` — ~120 lines: file iteration + content matching
- `get_backlinks` / `get_outlinks` — ~40 lines: `metadataCache.resolvedLinks` queries
- `move_note` — ~50 lines: `fileManager.renameFile()` (auto-rewrites wikilinks)
- `manage_tags` — ~60 lines: `fileManager.processFrontMatter()`
- `fetch_webpage` — ~80 lines: `requestUrl()` + Turndown HTML-to-Markdown
- `web_search` — ~70 lines: `requestUrl()` to DuckDuckGo + HTML parsing
- `read_docx` / `write_docx` — ~150 lines: mammoth/docx library usage

#### Migration Strategy

Phase 1 (initial release): User-defined tools work alongside built-ins. Built-ins remain as TypeScript classes in `src/tools/`.

Phase 2 (optional future): Ship built-in tool reference implementations as default `.md` files that the plugin writes to `notor/tools/` on first load (or via a "Reset to defaults" action). The `src/tools/` classes become fallbacks — used only if no vault-defined tool with the same name exists.

This is a non-breaking, incremental path. Users who never touch `notor/tools/` get the same experience as today.

### Scope Exclusion

`use_subagent` remains a built-in-only tool. It orchestrates Notor's internal agent infrastructure (SubAgentManager, SubAgentRunner, isolated conversations) and is not meaningfully customizable via a tool body.

---

## Vault-Defined Automations

### File Format

````markdown
<!-- notor/automations/tag-ai-writes.md -->
---
notor-automation: true
event: on_tool_result
tools: [write_note, replace_in_note]
label: "Tag AI-modified notes"
---

# Tag AI-Modified Notes

Automatically adds `#ai-modified` tag to any note written or modified by the AI.
Only fires on successful write operations.

```typescript
if (context.status !== "success") return;

const notePath = context.params.path as string;
const file = utils.resolveNote(notePath);
if (!file) return;

await fileManager.processFrontMatter(file, (fm: any) => {
  fm.tags = fm.tags || [];
  if (!fm.tags.includes("ai-modified")) fm.tags.push("ai-modified");
});
```
````

### Frontmatter Schema

| Field | Required | Description |
|-------|----------|-------------|
| `notor-automation` | yes | Must be `true`. Identifies this note as a vault-defined automation. |
| `event` | yes | Hook lifecycle event: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion` |
| `tools` | no | Array of tool names to filter on (only for `on_tool_call`/`on_tool_result`). If omitted, fires for all tools. |
| `label` | no | Human-readable label for settings UI and logging. |

### Automation-Specific Injected Context

In addition to the shared runtime (`app`, `vault`, `libs`, `utils`, `obsidian`), automations receive a `context` object with event-specific data:

| Field | Available On | Type | Description |
|-------|-------------|------|-------------|
| `context.conversationId` | all events | `string` | Current conversation UUID |
| `context.timestamp` | all events | `string` | ISO 8601 event timestamp |
| `context.hookEvent` | all events | `string` | The event name |
| `context.toolName` | `on_tool_call`, `on_tool_result` | `string` | Tool that was called |
| `context.params` | `on_tool_call`, `on_tool_result` | `Record<string, unknown>` | Tool parameters (parsed, not serialized) |
| `context.result` | `on_tool_result` | `string` | Tool result output |
| `context.status` | `on_tool_result` | `"success" \| "error"` | Whether the tool succeeded |

Note: tools get `params` (from the LLM). Automations get `context` (from the hook lifecycle). This makes it unambiguous which type of extension you're writing.

### Return Semantics

| Event | Return Type | Behavior |
|-------|------------|----------|
| `pre_send` | `string \| void` | Returned string is injected into the conversation (same as shell hook stdout) |
| `on_tool_call` | `void` | Fire-and-forget side effect |
| `on_tool_result` | `void` | Fire-and-forget side effect |
| `after_completion` | `void` | Fire-and-forget side effect |

### The `tools` Filter

The `tools` field in frontmatter is the key ergonomic improvement over shell hooks. Instead of writing `if (context.toolName === "write_note")` in the body, users declare the filter declaratively:

```yaml
event: on_tool_result
tools: [write_note, replace_in_note]
```

The plugin evaluates this filter *before* invoking the function — automations that don't match the current tool are skipped entirely (no overhead).

### Discovery & Registration

- Discovered from `notor/automations/` (`.md` files with `notor-automation: true` in frontmatter).
- Registered alongside existing shell hooks in the hook dispatch pipeline.
- Execution order: global shell hooks first, then vault-defined automations.
- Vault-defined automations do NOT replace shell hooks — they coexist. Shell hooks remain for users who prefer simple shell commands.

### Interaction with Existing Hook Systems

| System | Relationship |
|--------|-------------|
| **Global shell hooks** (settings UI) | Coexist. Shell hooks fire first, automations fire after. |
| **Workflow-scoped hooks** (G-004) | Automations are global by default. Workflow-scoped override could suppress them (future). |
| **Vault event hooks** (on_note_open, on_save, etc.) | Separate system — not affected. Could extend automations to vault events in the future. |

---

## Open Questions

1. **Editor support**: Should the plugin provide a TypeScript declaration file (`notor-extensions-api.d.ts`) that users can reference for autocomplete? This would describe the shapes of `app`, `params`, `context`, `utils`, `libs`, etc.

2. **Hot reload**: Should editing an extension file immediately update the registered tool/automation, or require a plugin reload? Hot reload is better UX but adds complexity (need to handle in-flight tool calls).

3. **Error UX**: When a user extension throws at runtime, how is the error surfaced? Options: Notice, chat message, log only. Probably all three — Notice for visibility, error returned to LLM as ToolResult (for tools), and detailed stack trace in the log.

4. **Async support**: Extension bodies should support `await` (most vault operations are async). The compiled function needs to be wrapped as `async`.

5. **Security model**: User extensions run with full `app` access — same trust level as the plugin itself. This is consistent with how workflows can already execute arbitrary shell commands via hooks. Worth a clear note in documentation.

6. **Automation ordering**: Should users control execution order between automations? Options: alphabetical by filename, explicit `order` field in frontmatter, or undefined (no guaranteed order).

7. **MCP tool filter**: Should the `tools` filter in automations support MCP tool names (e.g., `my-server__query`)? Likely yes, since MCP tools go through the same dispatch pipeline.

8. **Blocking automations**: Current shell hooks are fire-and-forget for `on_tool_call`/`on_tool_result`. Should TypeScript automations have the option to block? For example, the tag-after-write case benefits from the tag being applied before the LLM sees the tool result — but this changes the dispatch pipeline's timing guarantees.
