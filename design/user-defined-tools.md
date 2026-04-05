# Design: User-Defined Tools (Vault-Authored TypeScript)

**Created:** 2026-04-05
**Status:** Exploration

## Problem

Notor's tool system is currently closed to user authoring. Users can extend the tool surface through MCP servers, but MCP requires running an external process and writing a protocol-compliant server — a high bar for most users. Meanwhile, personas, workflows, rules, and sub-agent profiles are all defined as Markdown files in the vault, making them accessible to anyone comfortable editing notes. Tools are the only major primitive that lacks this file-based extensibility.

Beyond new tools, users have no way to customize existing built-in tool behavior. A user who wants `read_note` to strip HTML comments, or `write_note` to auto-tag created notes, must request a feature or write an MCP server.

## Core Idea

Allow users to define tools as TypeScript files in `notor/tools/`. Each file contains YAML frontmatter (name, description, parameter schema, mode) and a TypeScript function body. At plugin load, Notor discovers these files, strips types, compiles them via `new Function()`, injects Obsidian APIs and bundled libraries as arguments, and registers them in the `ToolRegistry` alongside built-in and MCP tools.

If a user-defined tool shares a name with a built-in tool, the user-defined version overrides it. This means every built-in tool could ship a default `.ts` reference implementation that users can copy into their vault and customize.

## Tool File Format

```typescript
// notor/tools/read_note.ts
---
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

### Frontmatter Schema

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Tool name (unique identifier). If it matches a built-in tool name, overrides it. |
| `description` | yes | Human-readable description sent to the LLM. |
| `mode` | yes | `"read"` or `"write"`. Determines Plan/Act mode behavior. |
| `params` | yes | Parameter schema (simplified YAML that maps to JSON Schema). |

## Injected Context

User tool code executes with these variables in scope:

### Obsidian APIs

| Variable | Type | Description |
|----------|------|-------------|
| `app` | `App` | Full Obsidian App instance |
| `vault` | `Vault` | Shorthand for `app.vault` |
| `metadataCache` | `MetadataCache` | Shorthand for `app.metadataCache` |
| `fileManager` | `FileManager` | Shorthand for `app.fileManager` |
| `workspace` | `Workspace` | Shorthand for `app.workspace` |
| `obsidian` | module | Obsidian module exports (`requestUrl`, `Notice`, `TFile`, `getFrontMatterInfo`, etc.) |

### Tool Parameters

| Variable | Type | Description |
|----------|------|-------------|
| `params` | `Record<string, unknown>` | Parameters passed by the LLM, validated against the frontmatter schema |

### Notor Utilities

| Variable | Type | Description |
|----------|------|-------------|
| `utils.resolveNote(path)` | function | Resolve a note path (handles bare names, missing `.md`, wikilinks) |
| `utils.staleTracker` | `StaleContentTracker` | Record reads and check for concurrent edits before writes |
| `utils.checkpointManager` | `CheckpointManager` | Create snapshots before destructive operations |
| `utils.noteOpener` | `NoteOpener` | Open notes in the editor |
| `utils.logger(name)` | function | Create a scoped logger |
| `utils.resolveAndValidatePath(path)` | function | Validate and resolve filesystem paths |
| `utils.executeShellCommand(cmd, opts)` | function | Run a shell command |

### Bundled Libraries

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

## Execution Model

### Discovery

Same pattern as personas, workflows, and sub-agents: scan `notor/tools/` recursively on plugin load and on file changes. Files must have `.ts` extension and valid frontmatter with `name` field.

### Compilation

1. Parse frontmatter (YAML) and extract the TypeScript body
2. Strip type annotations from body (lightweight type stripping via `sucrase` or regex — most tool code will use simple types)
3. Compile to a function via `new Function('app', 'vault', 'metadataCache', 'fileManager', 'workspace', 'obsidian', 'params', 'utils', 'libs', body)`
4. Cache the compiled function — recompile only when the file changes

### Execution

1. On tool call, invoke the compiled function with injected arguments
2. Wrap in try/catch — return `ToolResult` with error details on failure
3. The function body is expected to return a `ToolResult` object (`{ success, result, error? }`)
4. Execution timeout enforced (configurable, default 30s)

### Registration

1. User-defined tools register in `ToolRegistry` via the same `register()` method as built-in tools
2. If a user tool's `name` matches a built-in tool, it replaces the built-in (last-write-wins; user tools load after built-ins)
3. User tools participate fully in the existing dispatch pipeline: Plan/Act enforcement, auto-approve resolution, `<notor_tool_config>` overrides, checkpoint creation, approval UI

## Type Stripping Strategy

User code is TypeScript but the runtime needs JavaScript. Options:

| Approach | Size | Coverage | Tradeoffs |
|----------|------|----------|-----------|
| **Sucrase** | ~50KB | Full TS syntax minus `enum`, `namespace` | Battle-tested, fast, minimal bundle impact |
| **Regex-based** | ~0KB | Simple type annotations only | Fragile on complex types, but tools are short |
| **Accept JS only** | 0KB | N/A | Worse DX; users expect `.ts` in a TS project |

Recommendation: **Sucrase**. It's small, fast, and handles everything users would realistically write in a tool body. The `.ts` extension signals to editors to provide full TypeScript language support (autocomplete, type checking) for tool authoring.

## Built-in Tool Migration Path

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

### Migration Strategy

Phase 1 (initial release): User-defined tools work alongside built-ins. Built-ins remain as TypeScript classes in `src/tools/`.

Phase 2 (optional future): Ship built-in tool reference implementations as default `.ts` files that the plugin writes to `notor/tools/` on first load (or via a "Reset to defaults" action). The `src/tools/` classes become fallbacks — used only if no vault-defined tool with the same name exists.

This is a non-breaking, incremental path. Users who never touch `notor/tools/` get the same experience as today.

## Scope Exclusion

`use_subagent` remains a built-in-only tool. It orchestrates Notor's internal agent infrastructure (SubAgentManager, SubAgentRunner, isolated conversations) and is not meaningfully customizable via a tool body.

## API Stability Considerations

The injected context (`app`, `vault`, `utils`, `libs`) becomes a public API contract. Changes to the `utils` surface (e.g., renaming `staleTracker` methods, changing `CheckpointManager` interface) become breaking changes for user tools.

Mitigations:
- Keep `utils` as a stable facade with documented methods, not raw internal objects
- Version the injected API shape (e.g., `notor-tool-api: 1` in frontmatter) so the plugin can warn on breaking changes
- Obsidian's own API (`app`, `vault`, `metadataCache`) is already stable — that's the majority of what tools use

## Integration with Existing Systems

| System | Integration |
|--------|-------------|
| **Plan/Act mode** | Enforced via `mode` field in frontmatter — identical to built-in tools |
| **Auto-approve** | Participates in the same resolution chain (global, persona, workflow, rule overrides) |
| **`<notor_tool_config>`** | User tools can be toggled/configured in persona/workflow/rule YAML blocks by name |
| **Effective Config Inspector** | User tools appear alongside built-in and MCP tools |
| **Tool call UI** | Rendered identically — name, parameters, result |
| **Diff view** | If a user tool calls `vault.process()`, diffs work the same way |
| **Checkpoints** | User tools can call `utils.checkpointManager.createCheckpoint()` directly |

## Open Questions

1. **Editor support**: Should the plugin provide a TypeScript declaration file (`notor-tool-api.d.ts`) that users can reference for autocomplete? This would describe the shapes of `app`, `params`, `utils`, `libs`, etc.

2. **Hot reload**: Should editing a tool file immediately update the registered tool, or require a plugin reload? Hot reload is better UX but adds complexity (need to handle in-flight tool calls).

3. **Error UX**: When a user tool throws at runtime, how is the error surfaced? Options: Notice, chat message, log only. Probably all three — Notice for visibility, error returned to LLM as ToolResult, and detailed stack trace in the log.

4. **Async support**: Tool bodies should support `await` (most vault operations are async). The compiled function needs to be wrapped as `async`.

5. **Security model**: User tools run with full `app` access — same trust level as the plugin itself. This is consistent with how workflows can already execute arbitrary shell commands via hooks. Worth a clear note in documentation.
