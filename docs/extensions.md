# Extensions

Extensions let you create custom tools and automations as Markdown files in your vault — no external processes or MCP servers required. Tools are called by the AI alongside built-in tools; automations fire automatically at lifecycle or vault events.

## Overview

There are three extension types:

- **Tools** (`notor/tools/*.md`) — invoked by the AI via tool calls, return a result to the conversation.
- **Automations** (`notor/automations/*.md`) — fire at LLM lifecycle events or vault events, run as side effects.
- **Shared settings** (`notor/settings.md`) — declares global settings accessible to all tools and automations.

## File format

Each extension file is a Markdown note with up to three sections:

1. **Frontmatter** — flat scalar fields (`notor-type`, `notor-tool-name`, etc.) in standard YAML frontmatter.
2. **YAML code fence** — the first `` ```yaml `` fence contains nested configuration (`params` and/or `settings` blocks) that exceed frontmatter's depth limitations. Optional — omit if the extension has no params or settings.
3. **Code fence** — the first `` ```ts ``, `` ```typescript ``, `` ```js ``, or `` ```javascript `` fence contains the executable logic. Required for tools and automations.

Everything outside the fences (prose, headings, etc.) is ignored by the runtime but visible when you open the note in Obsidian — use it to document what the extension does.

---

## Defining a tool

### Frontmatter

| Property | Required | Description |
|---|---|---|
| `notor-type` | yes | Must be `tool`. |
| `notor-tool-name` | yes | Unique tool identifier. If it matches a built-in tool name, overrides the built-in. |
| `notor-description` | yes | Human-readable description sent to the AI. |
| `notor-mode` | yes | `"read"` or `"write"`. Determines [Plan/Act mode](safety.md) behavior. |

### Parameter schema

Define tool parameters in the `params` block of the YAML code fence:

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

Each parameter supports:

| Property | Type | Description |
|---|---|---|
| `type` | string | `"string"`, `"number"`, `"boolean"`, or `"string[]"` |
| `description` | string | Sent to the AI to explain the parameter. |
| `default` | matches type | Makes the parameter optional. Params without a default are required. |
| `enum` | string[] | Constrains to listed values (string type only). |
| `path_namespace` | string | `"vault"` or `"filesystem"` — enables automatic [path enforcement](vault-tools.md#per-context-tool-configuration). |

### Return value

Tool code should return a result object:

```typescript
// Success
return { success: true, result: "The note content..." };

// Error (reported to the AI so it can react)
return { success: false, error: "Note not found — try a different path" };

// With content blocks (for structured output)
return { success: true, result: "Summary text", content_blocks: [...] };
```

If the code throws an exception, the error is caught and returned as `{ success: false, error: "<message>" }` automatically.

### Example

````markdown
---
notor-type: tool
notor-tool-name: read_note_clean
notor-description: "Read a vault note with HTML comments stripped"
notor-mode: read
---

# Read Note (Clean)

Customized read tool that strips HTML comments from note content.

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

// Strip HTML comments
content = content.replace(/<!--[\s\S]*?-->/g, "");

return { success: true, result: content };
```
````

---

## Defining an automation

### Frontmatter

| Property | Required | Description |
|---|---|---|
| `notor-type` | yes | Must be `automation`. |
| `notor-trigger` | yes | Event to fire on (see table below). |
| `notor-schedule` | conditional | Cron expression — required when trigger is `on_schedule`. |
| `notor-tools` | no | Array of tool names to filter on (`on_tool_call`/`on_tool_result` only). If omitted, fires for all tools. Supports MCP tool names using `server__tool` naming. |
| `notor-display-name` | no | Human-readable label for settings UI and logging. |
| `notor-automation-order` | no | Numeric execution priority. Lower values fire first. Default: `0`. Ties broken alphabetically by filename. |

**Trigger values:**

| Trigger | Category | When it fires |
|---|---|---|
| `pre_send` | LLM lifecycle | After user submits a message, before it is sent to the AI. **Blocking** — returned string is injected into the conversation. |
| `on_tool_call` | LLM lifecycle | After tool approval, before tool execution. |
| `on_tool_result` | LLM lifecycle | After tool execution, before result is returned to the AI. |
| `after_completion` | LLM lifecycle | After the AI's full response turn completes. |
| `on_note_open` | Vault event | A note is opened in the editor. |
| `on_note_create` | Vault event | A new Markdown file is created. |
| `on_save` | Vault event | A note is saved (manual or auto-save). |
| `on_manual_save` | Vault event | A note is saved by explicit user action (Cmd+S / Ctrl+S). |
| `on_tag_change` | Vault event | Tags are added to or removed from a note's frontmatter. |
| `on_schedule` | Scheduled | A cron schedule fires (while Obsidian is running). |
| `on_conversation_start` | LLM lifecycle | After the first user message in a new conversation, before the LLM call. **Non-blocking.** Fires once per conversation. Not available as a shell hook — automation-only. |

### Context object

Automation code receives a `context` object with event-specific data.

**Common fields (all events):**

| Field | Type | Description |
|---|---|---|
| `context.hookEvent` | `string` | The event name (e.g., `"on_tool_result"`) |
| `context.timestamp` | `string` | ISO 8601 event timestamp |

**LLM lifecycle fields:**

| Field | Available on | Type | Description |
|---|---|---|---|
| `context.conversationId` | all LLM events, `on_conversation_start` | `string` | Current conversation UUID |
| `context.toolName` | `on_tool_call`, `on_tool_result` | `string` | Tool that was called |
| `context.params` | `on_tool_call`, `on_tool_result` | `Record<string, unknown>` | Tool parameters |
| `context.result` | `on_tool_result` | `string` | Tool result output |
| `context.status` | `on_tool_result` | `"success" \| "error"` | Whether the tool succeeded |

**Vault event fields:**

| Field | Available on | Type | Description |
|---|---|---|---|
| `context.notePath` | `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change` | `string` | Vault-relative path of the affected note |
| `context.tagsAdded` | `on_tag_change` | `string[]` | Tags added |
| `context.tagsRemoved` | `on_tag_change` | `string[]` | Tags removed |

### Return semantics

All automations are fire-and-forget — they execute asynchronously without blocking the pipeline. The only exception is `pre_send`: it is inherently blocking, and a returned string is injected into the conversation as additional context.

### Example

````markdown
---
notor-type: automation
notor-trigger: on_tool_result
notor-tools: [write_note, replace_in_note]
notor-display-name: "Tag AI-modified notes"
notor-automation-order: 10
---

# Tag AI-Modified Notes

Adds a configurable tag to any note written or modified by the AI.

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

---

## Shared settings

Create `notor/settings.md` to define global settings shared across all extensions:

````markdown
---
notor-type: settings
---

# Shared Extension Settings

```yaml
settings:
  shared_api_key:
    name: "Shared API Key"
    type: string
    description: "API key used by multiple tools"
    secret: true
  custom_domain_denylist:
    name: "Custom Domain Denylist"
    type: string[]
    description: "Domains blocked from custom tools"
    default: []
```
````

All extensions receive the shared settings as a `shared` object. If no `notor/settings.md` exists, `shared` is an empty `{}`.

---

## Extension settings

### Settings schema

Declare user-configurable fields in the `settings` block of the YAML code fence. These appear automatically in the plugin's settings UI.

| Property | Required | Type | Description |
|---|---|---|---|
| `name` | yes | `string` | Human-readable label displayed in the settings UI. |
| `type` | yes | `string` | Value type: `"string"`, `"number"`, `"boolean"`, or `"string[]"`. |
| `description` | no | `string` | Sub-text displayed below the setting name. |
| `default` | no | matches type | Default value. Settings without a default are required — the extension will error if not configured. |
| `secret` | no | `boolean` | If `true`, stored in OS-level encrypted storage (Keychain/DPAPI/libsecret) and rendered as a password field. |
| `min` | no | `number` | Minimum value (number type only). |
| `max` | no | `number` | Maximum value (number type only). |
| `options` | no | `string[]` | Enum constraint — renders as a dropdown (string type only). |

### Settings UI

The plugin auto-generates a settings section under **Settings -> Notor -> Extensions**:

- **Shared settings** sub-section (from `notor/settings.md`) at the top
- **Per-extension** sub-sections for each tool or automation that declares a `settings` block
- **"Reset to defaults"** button per extension
- **"Reload extensions"** button at the bottom

Extensions with no `settings` block don't appear. If no extensions have settings, the group is hidden entirely.

---

## Runtime context

All extension code executes with these variables in scope:

### Obsidian APIs

| Variable | Type | Description |
|---|---|---|
| `app` | `App` | Full Obsidian App instance — access `app.vault`, `app.metadataCache`, `app.fileManager`, `app.workspace`, etc. |
| `obsidian.requestUrl` | function | Make HTTP requests |
| `obsidian.Notice` | class | Display toast notifications — `new obsidian.Notice("message")` |
| `obsidian.TFile` | class | Vault file type |
| `obsidian.TFolder` | class | Vault folder type |
| `obsidian.getFrontMatterInfo` | function | Parse frontmatter boundaries from file content |
| `obsidian.normalizePath` | function | Normalize vault-relative paths |
| `obsidian.MarkdownView` | class | Active Markdown editor view |

### Notor utilities

| Variable | Description |
|---|---|
| `utils.resolveNote(path)` | Resolve a note path (handles bare names, missing `.md`, wikilinks). Returns `TFile \| null`. |
| `utils.staleTracker` | Record reads and check for concurrent edits before writes. |
| `utils.checkpointManager` | Create snapshots before destructive operations for rollback. |
| `utils.noteOpener` | Open notes programmatically in the editor. |
| `utils.logger(name)` | Create a scoped logger (prefixed with `ext:`). |
| `utils.resolveAndValidatePath(path, allowedPaths?)` | Validate and resolve filesystem paths against allowed paths. |
| `utils.executeShellCommand(cmd, opts?)` | Run a shell command. |
| `utils.pathEnforcer.enforcePathConstraints(toolName, params, entry)` | Apply path enforcement rules. |
| `utils.pathEnforcer.isPathWithin(target, base)` | Check if a path is within a base directory. |
| `utils.abortSignal` | `AbortSignal` for the current tool call (tools only, not automations). |

### Bundled libraries

| Variable | Library | Use case |
|---|---|---|
| `libs.mammoth` | mammoth | DOCX to HTML conversion |
| `libs.Turndown` | turndown | HTML to Markdown conversion |
| `libs.turndownGfm` | turndown-plugin-gfm | GFM plugin for Turndown — `new libs.Turndown().use(libs.turndownGfm.gfm)` |
| `libs.unpdf` | unpdf | PDF text extraction (lazy) — `const { getDocumentProxy } = await libs.unpdf()` |
| `libs.docx` | docx | Programmatic DOCX generation |
| `libs.PizZip` | pizzip | ZIP/DOCX archive manipulation |
| `libs.marked` | marked | Markdown parsing and rendering |
| `libs.xmldom` | @xmldom/xmldom | XML DOM parsing |
| `libs.croner` | croner | Cron expression parsing — `new libs.croner.Cron("0 9 * * 1")` |

### Extension settings

| Variable | Description |
|---|---|
| `settings` | Per-extension settings from this extension's `settings` block, resolved from defaults + user-configured values. |
| `shared` | Global shared settings from `notor/settings.md`. Empty `{}` if no shared settings exist. |

### Tool vs. automation arguments

- **Tools** receive: `app`, `obsidian`, `utils`, `libs`, `settings`, `shared`, `params`
- **Automations** receive: `app`, `obsidian`, `utils`, `libs`, `settings`, `shared`, `context`

---

## Reloading extensions

Extensions are automatically loaded on plugin startup. After editing extension files, reload manually:

- **Settings UI** — click the "Reload extensions" button in **Settings -> Notor -> Extensions**.
- **Command palette** — run **Notor: Reload user extensions**.
- **File watcher** — when extension files change, a persistent Notice appears. Click it to reload.

In-flight tool calls continue using the version compiled at dispatch time; reloaded versions apply to subsequent calls.

---

## Integration with existing systems

| System | How it works |
|---|---|
| **Plan/Act mode** | Enforced via `notor-mode` — identical to built-in tools. See [safety.md](safety.md). |
| **Auto-approve** | Participates in the standard resolution chain (global, persona, workflow, rule overrides). |
| **`<notor_tool_config>`** | User tools can be toggled and configured by name in persona, workflow, and rule YAML blocks. See [per-context tool configuration](vault-tools.md#per-context-tool-configuration). |
| **Tool config inspector** | User tools appear alongside built-in and MCP tools. |
| **Built-in override** | If a user tool's name matches a built-in, the user tool replaces it. Delete the file and reload to restore the built-in. |

---

## Security

User extensions run with full `app` access — the same trust level as the plugin itself. This is consistent with Obsidian's security model: community plugins already have unrestricted access, and Notor workflows can execute arbitrary shell commands via hooks. Treat extension code with the same caution as any plugin code.

## Notes

- Extensions are regular Obsidian notes — visible, searchable, and editable.
- Code fences support TypeScript (types are stripped at compile time via Sucrase) or plain JavaScript.
- The code body runs as `async` — `await` works directly without wrapping.
- `use_subagent` cannot be overridden by a user tool.
- Automations coexist with shell [hooks](hooks.md) — shell hooks fire first, then workflow hooks, then vault-defined automations (sorted by `notor-automation-order`).
- TypeScript `enum` and `namespace` declarations are not supported (Sucrase limitation). All other TS syntax works: type annotations, interfaces, generics, `as` casts, type-only imports.
