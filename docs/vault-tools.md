# Vault tools

Notor exposes a set of tools the AI can invoke during a conversation to read, write, and interact with your vault and system.

## Built-in tool reference

| Tool | What it does | Mode |
|---|---|---|
| `read_note` | Read a note's content (optionally including frontmatter and backlinks) | Plan & Act |
| `write_note` | Create a new note or overwrite an existing one | Act only |
| `replace_in_note` | Surgical find/replace edits within a note | Act only |
| `move_note` | Move and/or rename a note within the vault (auto-updates all internal links) | Act only |
| `delete_note` | Delete a note from the vault (moves to trash; disabled by default) | Act only |
| `search_vault` | Regex/text search across notes with context lines | Plan & Act |
| `list_vault` | List vault folder structure and file metadata | Plan & Act |
| `read_frontmatter` | Read a note's YAML frontmatter as structured data | Plan & Act |
| `update_frontmatter` | Add, modify, or remove specific frontmatter keys | Act only |
| `manage_tags` | Add or remove tags via the frontmatter `tags` property | Act only |
| `get_backlinks` | List all notes that link TO a given note | Plan & Act |
| `get_outlinks` | List all notes that a given note links TO (resolved and unresolved) | Plan & Act |
| `web_search` | Search the web (DuckDuckGo by default; Tavily, Brave, SerpAPI, Kagi available with API keys) and return titles, URLs, and snippets | Plan & Act |
| `fetch_webpage` | Fetch a URL and return its content as Markdown | Plan & Act |
| `execute_command` | Run a shell command and return its output | Act only |
| `read_file` | Read a text file from the filesystem (desktop only) | Plan & Act |
| `read_docx` | Read a `.docx` file and return its content as Markdown (desktop only) | Plan & Act |
| `import_docx` | Parse a `.docx` file and save its content as a Markdown note in the vault, extracting embedded images as vault attachments (desktop only) | Act only |
| `write_docx` | Convert Markdown to a `.docx` file on the filesystem (desktop only) | Act only |
| `write_file` | Write text content to a file on the filesystem (desktop only) | Act only |
| `replace_in_file` | Make targeted find/replace edits in a text file (desktop only) | Act only |
| `extract_docx_comments` | Extract review comments from a `.docx` file and write them as a structured note (desktop only) | Act only |
| `list_xlsx_sheets` | List the worksheet names in an `.xlsx` file with row and column counts (desktop only) | Plan & Act |
| `read_xlsx` | Read an `.xlsx` file and return its content as Markdown tables or JSON (desktop only) | Plan & Act |
| `write_xlsx` | Create an `.xlsx` file from Markdown tables or JSON data (desktop only) | Act only |
| `import_xlsx` | Parse an `.xlsx` file and save its content as a Markdown note in the vault (desktop only) | Act only |
| `use_subagent` | Spawn a focused [sub-agent](sub-agents.md) child conversation for a specific task | Plan & Act |
| `sleep` | Pause execution for a specified duration (useful in workflows and automations) | Plan & Act |
| `search_chat_history` | Search past Notor conversations by keyword and return matching conversation metadata | Plan & Act |
| `read_chat_history` | Read the full message history of a past conversation by ID | Plan & Act |
| `capture_memory` | Save an insight to long-term [memory](memory.md) as an Evergreen note | Act only |
| `list_templates` | List available templates and detect Templater prompts/suggesters | Plan & Act |
| `apply_template` | Create a note by applying a template with auto-answered prompts | Act only |
| `webview` | Interact with Obsidian's Web Viewer tab (read, navigate, click) | Act only |
| `ask_user` | Pause and ask the user a question mid-conversation, with optional suggested-answer options | Plan & Act |
| `read_notor_settings` | Read the current Notor plugin settings as JSON | Plan & Act |
| `edit_notor_settings` | Change a single Notor plugin setting by key path | Act only |

### User-defined tools

In addition to the built-in tools above, you can create custom tools as Markdown files in `notor/tools/`. User-defined tools appear alongside built-in tools in the AI's tool set, the **Settings -> Tools** section, and the tool config inspector. If a user tool's name matches a built-in tool, the user tool replaces it. See [extensions.md](extensions.md) for the full reference.

Every tool call is displayed inline in the chat thread — name, parameters, result, and status — so you always see exactly what the AI is doing.

Tools marked **Act only** are blocked in Plan mode. See [safety.md](safety.md) for details on Plan/Act mode and the approval workflow.

Tools marked **desktop only** are unavailable on mobile and return an error if invoked there.

By default, when the AI reads or modifies a note, the note is automatically opened in the editor so you can see what the AI is working with. You can disable this behavior in **Settings → Notor** via the **Open notes on access** toggle.

## Enabling and disabling tools

The unified **Settings → Notor → Tools** section gives you per-tool control over all built-in and MCP tools in one place. Each tool has two toggles:

- **Enabled** — whether the tool is available to the AI at all. Disabling a tool removes it from the AI's tool set entirely; it will not appear in tool listings or be invocable.
- **Auto-approve** — whether the tool executes without manual approval (same behavior as before, now co-located).

Tools are grouped into **Read-only tools** and **Write tools** subsections with column headers repeated per section. MCP tools appear alongside built-in tools, each showing:

- A status dot indicating server health (green = connected, yellow = connecting, grey = disconnected, red = error)
- The originating server name

All tools are enabled by default. The **Copy tool config YAML** button at the bottom of the section generates a `<notor_tool_config>` snippet reflecting your current global settings — useful as a starting point for per-context overrides (see below).

## Per-context tool configuration

You can override global tool settings on a per-context basis by embedding a `<notor_tool_config>` block in a persona's `system-prompt.md`, a workflow note, or a rule file. This lets you, for example, disable `execute_command` in a research-only persona or auto-approve `search_vault` in a specific workflow.

**Format:**

```xml
<notor_tool_config>
search_vault:
  enabled: true
  auto_approve: true
execute_command:
  enabled: false
filesystem__read_file:
  enabled: true
  allowed_paths:
    - reports/
  blocked_paths:
    - private/
</notor_tool_config>
```

**Available fields per tool:**

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Whether the tool is available |
| `auto_approve` | boolean | Whether the tool auto-approves |
| `allowed_paths` | string[] | Allowed filesystem paths (file tools only) |
| `blocked_paths` | string[] | Blocked filesystem paths (file tools only) |

**Key behaviors:**

- **Sparse merge** — omitted fields inherit from the next lower priority level. You only need to specify overrides.
- **Precedence** (highest first): workflow → persona → rule → global defaults.
- **MCP tools** use `server__tool` naming (e.g., `filesystem__read_file`).
- **`allowed_paths` / `blocked_paths`** use replace semantics: the highest-priority config that sets the field completely replaces lower-level values.
- [`<include_note>`](include-note.md) tags are resolved before tool config blocks are extracted.

Use the **Copy tool config YAML** button in **Settings → Notor → Tools** to generate a starting snippet with your current settings.

### Debugging effective configuration

Open the command palette and run **Notor: Open tool config inspector** to see the effective tool configuration for the current conversation. This view shows the merged result of all active config layers (global, rule, persona, workflow) and is useful for diagnosing unexpected tool availability or approval behavior.

## Memory capture

The `capture_memory` tool lets the AI save a specific piece of knowledge to long-term memory when you explicitly ask it to remember something. It is part of the [knowledge memory](memory.md) feature and is only available when memory is enabled.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `content` | Yes | The insight or piece of knowledge to save. |

- Routes through the same dedup and concept resolver pipeline as automatic memory capture.
- Write tool — available in Act mode only. Auto-approved by default.
- Only available when memory is enabled in **Settings → Notor → Memory**.

## Sleep

The `sleep` tool pauses execution for a specified duration. Useful in workflows and automations that need to wait between steps (e.g., polling an external service).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `duration` | Yes | Duration to sleep in seconds. Supports fractional values for sub-second waits. |
| `reason` | No | Description of why the sleep is needed (shown in progress UI). |

- Configurable maximum duration (default: 300 seconds). Requests exceeding the cap are clamped.
- Cancellable — clicking **Stop** in the chat panel interrupts the sleep immediately.
- Available in Plan and Act modes.

## Chat history

Two read-only tools let the AI search and read past Notor conversations.

### `search_chat_history`

Search past conversations by keyword. Returns matching conversation metadata with IDs that can be used with `read_chat_history`.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search text to match against conversation messages. |

### `read_chat_history`

Read the full message history of a past conversation by its ID. Use `search_chat_history` first to find the conversation ID.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `conversation_id` | Yes | The UUID of the conversation to read. |

Both tools are read-only — available in Plan and Act modes.

## Templates

Two tools integrate with Templater and Obsidian's core Templates plugin to discover and apply templates programmatically. Both require **Settings → Notor → Templates → Enable templates integration** to be on.

### `list_templates`

Lists available templates from the configured template folder. Detects the active template engine (Templater or core Templates) and, for Templater templates, scans for `tp.system.prompt()` and `tp.system.suggester()` calls so the AI knows what answers to supply when applying them.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `detect_prompts` | No | Scan templates for prompt/suggester calls and report their sequential order. Default: `true`. |

- Read-only tool — available in Plan and Act modes.
- Returns JSON with `engine`, `template_folder`, and `templates[]` (each with `name`, `path`, and optionally `prompts[]`).
- Requires a template folder configured in either Templater or core Templates settings.

### `apply_template`

Creates a new note by applying a template. For Templater templates, automatically answers `tp.system.prompt()` and `tp.system.suggester()` calls from ordered arrays — no interactive modals appear.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `template_path` | Yes | Path to the template file relative to vault root. |
| `output_folder` | No | Target folder for the new note. If omitted, uses vault root or Templater's configured location. |
| `output_filename` | No | Filename for the new note (without `.md` extension). If omitted, Templater decides or uses the template name. |
| `prompt_answers` | No | Ordered array of answers for `tp.system.prompt()` calls. The Nth element answers the Nth prompt encountered during expansion. |
| `suggester_answers` | No | Ordered array of selected values for `tp.system.suggester()` calls. Matched against display labels or raw values. |

- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Configurable execution timeout (default: 30 seconds, range: 5–120s) in **Settings → Notor → Templates**.
- Use `list_templates` first to discover available templates and the prompts/suggesters they expect.
- Desktop only.

## Web Viewer

The `webview` tool interacts with Obsidian's built-in Web Viewer tab — reading page content, navigating to URLs, or clicking links by visible text.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `action` | Yes | The action to perform: `read`, `navigate`, or `click`. |
| `scope` | No | Which Web Viewer to use. `conversation` (default) uses a dedicated tab for this conversation. `active` targets the user's currently focused Web Viewer tab. |
| `url` | Conditional | URL to load. Required for `navigate` action. |
| `text` | Conditional | Visible link text to click (case-insensitive partial match). Required for `click` action. |

**Actions:**

- **`read`** — Extracts the current page as Markdown (via Turndown), a list of clickable links (up to 50), and page metadata (URL, title). Content exceeding the max output cap is truncated.
- **`navigate`** — Loads the specified URL. Validates protocol (http/https only) and checks the domain denylist. In `conversation` scope, the URL is persisted for the session.
- **`click`** — Finds a link whose visible text contains the `text` parameter (case-insensitive) and clicks it. Returns the new URL and title after navigation, or a list of available links if no match is found.

Behavioral notes:
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Desktop only (requires Electron's webview APIs).
- Requires Obsidian's **Web Viewer** core plugin to be enabled.
- The domain denylist (same one used by `fetch_webpage`) applies to `navigate` actions.
- Configurable max output characters (default: 50,000) in **Settings → Notor → Tools → webview**.

## Settings tools

Two built-in tools let the AI read and modify Notor plugin settings. They are primarily used with the `notor-help` built-in persona, which can guide you through configuring the plugin via conversation.

### `read_notor_settings`

Returns the current Notor plugin settings as a JSON object. No parameters.

- Read-only tool — available in Plan and Act modes.
- Auto-approve default: off.

### `edit_notor_settings`

Changes a single Notor plugin setting by key path.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `key_path` | Yes | Dot-separated path into the settings object (e.g. `compaction_threshold`, `auto_approve.write_note`, `providers.0.model_id`). |
| `value` | Yes | The new value as a JSON literal (e.g. `0.9`, `true`, `"hello"`). Parsed as JSON; falls back to a raw string if parsing fails. |

- One setting per call — enforces per-change approval.
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Auto-approve default: off.

## Moving notes

The `move_note` tool moves and/or renames a note within the vault. Obsidian automatically updates all internal wikilinks and markdown links that point to the moved file.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Current path of the note relative to vault root. The `.md` extension is optional; a bare note name is also accepted. |
| `new_path` | Yes | New path for the note relative to vault root. The `.md` extension is optional and will be added automatically. Intermediate directories are created if needed. |
| `add_alias` | No | If `true` and the note's filename is changing, the old filename is appended to the note's frontmatter `aliases` list to preserve discoverability. Default: `false`. |

- A checkpoint is created before the operation for rollback.
- Rejects the operation if a note already exists at the destination path.
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.

## Deleting notes

The `delete_note` tool removes a note from the vault. It ships **disabled by default** — you must opt in via **Settings → Notor → Tools → Write tools** before the AI can call it.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path of the note to delete relative to vault root. The `.md` extension is optional; a bare note name is also accepted. |

- Deletion is recoverable: the note is moved to your configured Obsidian trash location (system trash, the vault's `.trash` folder, or permanent — see **Settings → Files and links → Deleted files**), and a checkpoint is created beforehand for rollback.
- Only Markdown (`.md`) notes can be deleted; attachments and other files are rejected.
- If other notes still link to the deleted note, the result reports how many links are now broken.
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.

## Reading notes

### `read_note`

Reads a note's Markdown content. Optionally strips frontmatter and/or appends a **Backlinks** section so the AI gains link-graph awareness without a separate `get_backlinks` call.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the note relative to vault root. The `.md` extension is optional. |
| `include_frontmatter` | No | Whether to include YAML frontmatter in the returned content. Defaults to `false`. |
| `backlinks` | No | Append a Backlinks section: `"list"` (linking note paths) or `"context"` (paths plus snippet windows around each incoming link). Use `"none"` to suppress. If omitted, uses the configured default. |

When the `backlinks` parameter is omitted, the behavior is governed by the tool's settings (Settings → Tools → `read_note` → gear icon), which also cap the output to prevent context bloat:

| Setting | Default | Description |
|---------|---------|-------------|
| Default backlinks mode | `list` | What `read_note` appends when the AI does not specify a mode (`none`, `list`, or `context`). |
| Backlinks context lines | `2` | Lines of surrounding context around each backlink in `context` mode (`0` = link line only). |
| Max backlinks per source note | `5` | Maximum link snippets shown from a single source note in `context` mode. |
| Max backlink source notes | `25` | Maximum number of source notes listed in the Backlinks section. |

The Backlinks section is omitted entirely when the note has no incoming links. Self-links are excluded. See [Backlinks and outlinks](#backlinks-and-outlinks) for the standalone `get_backlinks` tool.

## Backlinks and outlinks

Two read-only tools query Obsidian's in-memory link index — no disk I/O is involved.

### `get_backlinks`

Returns all notes in the vault that link **to** the specified note (incoming links). Self-links are filtered out. Output is a newline-separated list of vault-relative paths, or `(none)` if no backlinks exist.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the note relative to vault root. The `.md` extension is optional; a bare note name is also accepted. |

### `get_outlinks`

Returns all notes that the specified note links **to** (outgoing links). Self-links are filtered out. Output is divided into two sections: **Resolved** (links whose target notes exist in the vault) and **Unresolved** (links whose targets do not exist).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the note relative to vault root. The `.md` extension is optional; a bare note name is also accepted. |

Both tools are read-only — available in Plan and Act modes.

## Vault search

The `search_vault` tool supports an optional `sort_by` parameter to control result ordering:

| Value | Description |
|-------|-------------|
| `"match_count"` | Sort by number of matches per file, descending (default) |
| `"backlinks"` | Sort by backlink count — useful for finding hub or authoritative notes |
| `"modified"` | Sort by last modification time, most recent first |

Each result includes metadata fields: `match_count`, `backlink_count`, and `modified` (ISO 8601 timestamp).

### Timestamp filtering

Both `search_vault` and `list_vault` support `modified_after` and `modified_before` parameters to restrict results by modification time:

| Parameter | Description |
|-----------|-------------|
| `modified_after` | Only include files modified after this time. |
| `modified_before` | Only include files modified before this time. |

Accepted formats:
- **ISO 8601** — e.g., `2026-05-01T00:00:00Z`
- **Relative duration** — e.g., `7d`, `24h`, `2h30m`

Both parameters are optional and can be combined (e.g., files modified in the last week: `modified_after: "7d"`).

## Web fetching

The `fetch_webpage` tool lets the AI retrieve external content:

- Fetches any `http://` or `https://` URL and converts HTML to Markdown using the Turndown library.
- Plain text and JSON responses are returned as-is. Binary and unsupported content types return a structured error.
- Configurable domain denylist — add entries in **Settings → Notor** to prevent the AI from fetching specific domains.
- Configurable size limits: raw download cap (default: 5 MB) and output character cap (default: 50,000 characters). Pages exceeding the output cap are truncated with a notice to the AI.
- Defaults to auto-approved (read-only tool, available in Plan and Act modes).
- When a fetch fails, actionable error hints are shown for common Chromium `net::ERR_*` codes (DNS resolution failure, connection refused, timeout, SSL/TLS errors, and others). If the primary `requestUrl` method fails, an automatic diagnostic probe using native `fetch` runs to help distinguish Obsidian-specific issues from network-level problems.

## Web search

The `web_search` tool searches the web using a multi-provider queue with automatic fallback. DuckDuckGo is the default provider and requires no API key. If you configure API keys for Tavily, Brave Search, SerpAPI, or Kagi, those providers become available as fallbacks when DuckDuckGo fails or is rate-limited.

- Returns a numbered markdown list with titles, clickable URLs, and text snippets.
- Results are snippets only — use `fetch_webpage` on a result URL to retrieve full page content.
- The domain denylist (configured in **Settings → Notor**) applies to search result URLs; blocked domains are filtered out before results are returned.
- Configurable timeout (default: 10 seconds) and result count (default: 5, maximum: 10) in the tool's settings.
- Read-only tool — available in Plan and Act modes. Auto-approved by default.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search query string. |
| `num_results` | No | Number of results to return. Default: 5. Maximum: 10. |

For additional control over provider ordering and round-robin rotation, install the [multi-engine-web-search](extensions.md#community-extensions-gallery) community extension. It exposes per-provider enable toggles, priority ordering, and round-robin settings as a dedicated settings UI.

## Shell command execution

The `execute_command` tool lets the AI run commands on your system:

- Runs in your login shell on macOS/Linux (inheriting your full `PATH` via the `-l` flag) or PowerShell on Windows.
- Shell executable and arguments are user-configurable in **Settings → Notor**.
- Working directory defaults to vault root and must remain within the vault or a user-configured allow-list of absolute paths.
- Combined stdout and stderr are returned to the AI. Non-zero exit codes and timeouts are surfaced as structured errors.
- Configurable per-command timeout (default: 30 seconds) and output cap (default: 50,000 characters).
- Write tool — available in Act mode only by default; requires explicit approval unless auto-approved.

### Command-pattern auto-approve

You can configure glob patterns for commands that should be auto-approved (skipping the approval prompt) in **Settings → Notor → Tools → execute_command**:

- **Auto-Approve Command Patterns** — e.g., `git *`, `ls`, `npm test`. Commands matching any pattern execute without approval.
- **Never Auto-Approve Command Patterns** — e.g., `rm *`, `sudo *`. Commands matching these always require approval, even when `execute_command` is globally auto-approved.

Blocked patterns take precedence over allowed patterns. Patterns use glob syntax (via picomatch).

Command patterns can also be set via `<notor_tool_config>` blocks using `allowed_command_patterns` and `blocked_command_patterns` fields.

## Task tracking

The AI uses an internal `update_tasks` tool to maintain a structured task checklist during multi-step operations. Tasks appear in a collapsible panel below the chat input with status indicators (pending, in progress, completed).

- Fully automatic — the AI creates, updates, and completes tasks without user intervention.
- Not user-invokable; always auto-approved.
- Available in both Plan and Act modes.

## Word & file tools

The three file-system tools let the AI read and write files outside the vault, with first-class support for Word (`.docx`) documents. All three are **desktop only** and share a single configurable allowed-paths list.

### Allowed paths

All three tools validate the resolved path against the vault root and the **Allowed read/write paths** list configured in **Settings → Notor → Word & file tools**. The vault root is always implicitly allowed. Paths outside that set are rejected with a `"Path '...' is outside the allowed paths."` error.

Vault-relative paths (e.g. `reports/Q1.docx`) are resolved from the vault root. Absolute paths are used as-is.

### `read_file`

Reads any text-based file from the filesystem and returns its raw content.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the file. Vault-relative or absolute. |
| `encoding` | No | File encoding. Default: `utf-8`. |

- Binary files (detected by null bytes in the first 8 KB) are rejected: `"read_file only supports text-based files. For Word documents, use read_docx instead."`.
- Read-only tool — available in Plan and Act modes.
- Auto-approve default: off.

### `read_docx`

Reads a `.docx` file from the filesystem and returns its content converted to Markdown. Headings, bold, italic, tables, and links are all preserved. Embedded images are rendered as `[image]` placeholders.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the `.docx` file. Vault-relative or absolute. |

- Rejects files whose extension is not `.docx`.
- Read-only tool — available in Plan and Act modes.
- Auto-approve default: off.

### `import_docx`

Parses a `.docx` file from the filesystem and saves its content as a Markdown vault note. Embedded images are extracted and saved as vault attachments using Obsidian's configured attachment folder. Supported image formats: PNG, JPEG, GIF, WebP. Unsupported formats become inline placeholders (`[Unsupported image format: FORMAT]`).

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the `.docx` file. Vault-relative or absolute. Must be within the vault or an allowed path. |
| `note_path` | Yes | Vault-relative path for the output note (e.g. `Inbox/My Doc`). The `.md` extension is added automatically if omitted. |

- If the output note does not exist, it is created.
- If the output note already exists, a checkpoint is created before overwriting and the note content is replaced.
- The resulting note is opened in the editor after the operation.
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Auto-approve default: off.
- Desktop only.

### `write_docx`

Converts Markdown to a `.docx` file and writes it to the filesystem. Provide either `note_name` (to convert an existing vault note directly) or `content` (to convert new Markdown the assistant has composed). When the source already exists as a vault note, prefer `note_name` to avoid regenerating content. Supports headings (H1–H6), paragraphs, bold, italic, inline code, fenced code blocks, bullet lists, numbered lists, tables, blockquotes, horizontal rules, and links.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `note_name` | Conditional | Path to an existing vault note whose Markdown content will be the docx source. Accepts vault-relative path, bare note name, or path without `.md` extension. Frontmatter is automatically stripped. Mutually exclusive with `content`. |
| `content` | Conditional | Markdown content to convert to `.docx`. Use for new or custom content that does not exist as a vault note. Mutually exclusive with `note_name`. |
| `output_path` | Conditional | Full output path including `.docx` extension. Required if `write_docx_default_output_dir` is not configured and `filename` is not provided. |
| `filename` | No | Output filename without `.docx` extension. Combined with the default output directory setting to form the output path. |
| `template_path` | No | Path to a `.docx` template. Vault-relative or absolute. Overrides the default template setting. |

**Output path resolution (in order):**

1. `output_path` parameter, if provided.
2. `filename` + `write_docx_default_output_dir` setting, if both are available.
3. Error: `"No output path provided. Pass output_path, or provide a filename and configure write_docx_default_output_dir in Settings."`.

If both `output_path` and `filename` are provided, `output_path` takes precedence and a warning is prepended to the success message.

**Template support:**

When a template `.docx` is provided (via `template_path` parameter or the `write_docx_default_template_path` setting), the generated document body is grafted into the template's ZIP archive. The output inherits the template's fonts, margins, page orientation, headers, and footers. The template's `<w:sectPr>` (page layout block) is always preserved.

If no template is configured, the tool produces a plain `.docx` using Word's standard built-in styles.

- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Auto-approve default: off.

### `write_file`

Writes text content to a file on the filesystem. Creates the file if it does not exist, or overwrites it entirely if it does. Intermediate directories are created automatically.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the file. Vault-relative or absolute. |
| `content` | Yes | Complete text content to write. Replaces the entire file if it already exists. |
| `encoding` | No | File encoding. Default: `utf-8`. |

- Content is limited to 5 MB.
- Existing files are overwritten without backup. Use version control for safety.
- Path must be within the vault or a user-configured allowed path (see **Settings → Notor → Word & file tools → Allowed read/write paths**).
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Auto-approve default: off.
- Desktop only.

### `replace_in_file`

Makes targeted find/replace edits within a text file on the filesystem — the filesystem counterpart to `replace_in_note`. The operation is atomic: if any edit fails to match, no changes are applied.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `path` | Yes | Path to the file. Vault-relative or absolute. |
| `changes` | Yes | Array of `{old_text, new_text}` edits to apply in sequence. Each edit's `old_text` must match a unique location (see [Match resilience](#match-resilience)). |

- Multiple edits are applied in order — earlier replacements affect the text seen by later edits.
- An empty `new_text` deletes the matched text.
- Binary files (detected by null bytes in the first 8 KB) are rejected.
- Path must be within the vault or a user-configured allowed path (see **Settings → Notor → Word & file tools → Allowed read/write paths**).
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Auto-approve default: off.
- Desktop only.

### Match resilience

Both `replace_in_note` and `replace_in_file` match the `old_text` using a tiered, drift-tolerant matcher rather than a strict byte-for-byte comparison. Tiers are tried in order, and the **first tier that finds any candidate decides the result**:

1. **Exact (Unicode-normalized).** Typographic variants are treated as equivalent to their ASCII counterparts:
   - Curly quotes (`'` `'` `"` `"`) match straight quotes (`'` `"`)
   - Em-dashes (`—`), en-dashes (`–`) match hyphens (`-`)
   - Non-breaking spaces, thin spaces match regular spaces
   - Horizontal ellipsis (`…`) matches three dots (`...`)
2. **Line-trimmed.** For multi-line edits, each line is compared ignoring its leading and trailing whitespace, so indentation drift and trailing-whitespace differences don't break the match. The matched whole lines are replaced, so your `new_text` controls the resulting indentation.
3. **Whitespace-flexible.** Runs of spaces and tabs *within* a line are collapsed before comparison (newlines remain significant), so "single vs. multiple spaces" and "tabs vs. spaces" differences match.

Together these make it easier to match text pasted from word processors or web pages, and to edit notes whose whitespace has drifted since you last read them.

**Uniqueness rule.** Within whichever tier first finds candidates, the `old_text` must match **exactly one** location. If it matches more than one place, the edit fails with an ambiguous-match error asking you to add surrounding context — it does *not* silently edit the first occurrence. The current content is returned in the error so the `old_text` can be corrected and retried without re-reading.

### `extract_docx_comments`

Extracts review comments from a `.docx` file and writes them as a structured Obsidian vault note. Supports threaded replies, @mention resolution, and resolved-comment filtering.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `docx_path` | Yes | Path to the `.docx` file. Vault-relative or absolute. Must be within the vault or an allowed path. |
| `output_path` | Yes | Vault-relative path for the output note (e.g. `Reviews/feedback.md`). The `.md` extension is optional. |
| `include_resolved` | No | Include resolved/done comments. Default: `false`. |

- Resolved (done) comments are excluded by default. Pass `include_resolved: true` to include them.
- **Idempotent append** — when the output note already exists, only new comments are appended; previously extracted comments are skipped based on their unique IDs.
- Each comment includes: reviewer name, timestamp, quoted document text (the passage the comment was attached to), comment body, and any reply thread.
- Write tool — available in Act mode only; requires explicit approval unless auto-approved.
- Auto-approve default: off.
- Desktop only.

### Settings

Configure Word & file tools under **Settings → Notor → Word & file tools**:

| Setting | Description |
|---------|-------------|
| **Allowed read/write paths** | Additional filesystem directories accessible to all three tools. Vault root is always implicitly included. |
| **Default output directory** | Default output directory for `write_docx`. Accepts vault-relative or absolute path. Leave empty to require `output_path` per call. |
| **Default template path** | Default `.docx` template applied by `write_docx`. Accepts vault-relative or absolute path. Leave empty to use no template. Validated on blur — an inline error appears if the path does not exist or is not a `.docx` file. |
