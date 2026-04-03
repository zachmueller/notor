# Vault tools

Notor exposes a set of tools the AI can invoke during a conversation to read, write, and interact with your vault and system.

## Built-in tool reference

| Tool | What it does | Mode |
|---|---|---|
| `read_note` | Read a note's content (optionally including frontmatter) | Plan & Act |
| `write_note` | Create a new note or overwrite an existing one | Act only |
| `replace_in_note` | Surgical SEARCH/REPLACE edits within a note | Act only |
| `move_note` | Move and/or rename a note within the vault (auto-updates all internal links) | Act only |
| `search_vault` | Regex/text search across notes with context lines | Plan & Act |
| `list_vault` | List vault folder structure and file metadata | Plan & Act |
| `read_frontmatter` | Read a note's YAML frontmatter as structured data | Plan & Act |
| `update_frontmatter` | Add, modify, or remove specific frontmatter keys | Act only |
| `manage_tags` | Add or remove tags via the frontmatter `tags` property | Act only |
| `get_backlinks` | List all notes that link TO a given note | Plan & Act |
| `get_outlinks` | List all notes that a given note links TO (resolved and unresolved) | Plan & Act |
| `web_search` | Search the web via DuckDuckGo and return titles, URLs, and snippets | Plan & Act |
| `fetch_webpage` | Fetch a URL and return its content as Markdown | Plan & Act |
| `execute_command` | Run a shell command and return its output | Act only |
| `read_file` | Read a text file from the filesystem (desktop only) | Plan & Act |
| `read_docx` | Read a `.docx` file and return its content as Markdown (desktop only) | Plan & Act |
| `write_docx` | Convert Markdown to a `.docx` file on the filesystem (desktop only) | Act only |
| `write_to_file` | Write text content to a file on the filesystem (desktop only) | Act only |
| `extract_docx_comments` | Extract review comments from a `.docx` file and write them as a structured note (desktop only) | Act only |
| `use_subagent` | Spawn a focused [sub-agent](sub-agents.md) child conversation for a specific task | Plan & Act |

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

## Web fetching

The `fetch_webpage` tool lets the AI retrieve external content:

- Fetches any `http://` or `https://` URL and converts HTML to Markdown using the Turndown library.
- Plain text and JSON responses are returned as-is. Binary and unsupported content types return a structured error.
- Configurable domain denylist — add entries in **Settings → Notor** to prevent the AI from fetching specific domains.
- Configurable size limits: raw download cap (default: 5 MB) and output character cap (default: 50,000 characters). Pages exceeding the output cap are truncated with a notice to the AI.
- Defaults to auto-approved (read-only tool, available in Plan and Act modes).
- When a fetch fails, actionable error hints are shown for common Chromium `net::ERR_*` codes (DNS resolution failure, connection refused, timeout, SSL/TLS errors, and others). If the primary `requestUrl` method fails, an automatic diagnostic probe using native `fetch` runs to help distinguish Obsidian-specific issues from network-level problems.

## Web search

The `web_search` tool lets the AI search the web via DuckDuckGo and return structured results:

- Returns a numbered markdown list with titles, clickable URLs, and text snippets.
- Results are snippets only — use `fetch_webpage` on a result URL to retrieve full page content.
- The domain denylist (configured in **Settings → Notor**) applies to search result URLs; blocked domains are filtered out before results are returned.
- Configurable timeout (default: 10 seconds) and result count (default: 5, maximum: 10) in **Settings → Notor**.
- Read-only tool — available in Plan and Act modes. Auto-approved by default.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `query` | Yes | Search query string. |
| `num_results` | No | Number of results to return. Default: 5. Maximum: 10. |

## Shell command execution

The `execute_command` tool lets the AI run commands on your system:

- Runs in your login shell on macOS/Linux (inheriting your full `PATH` via the `-l` flag) or PowerShell on Windows.
- Shell executable and arguments are user-configurable in **Settings → Notor**.
- Working directory defaults to vault root and must remain within the vault or a user-configured allow-list of absolute paths.
- Combined stdout and stderr are returned to the AI. Non-zero exit codes and timeouts are surfaced as structured errors.
- Configurable per-command timeout (default: 30 seconds) and output cap (default: 50,000 characters).
- Write tool — available in Act mode only by default; requires explicit approval unless auto-approved.

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

### `write_docx`

Converts Markdown content to a `.docx` file and writes it to the filesystem. Supports headings (H1–H6), paragraphs, bold, italic, inline code, fenced code blocks, bullet lists, numbered lists, tables, blockquotes, horizontal rules, and links.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `content` | Yes | Markdown content to convert to `.docx`. |
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

### `write_to_file`

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
