# Vault tools

Notor exposes a set of tools the AI can invoke during a conversation to read, write, and interact with your vault and system.

## Built-in tool reference

| Tool | What it does | Mode |
|---|---|---|
| `read_note` | Read a note's content (optionally including frontmatter) | Plan & Act |
| `write_note` | Create a new note or overwrite an existing one | Act only |
| `replace_in_note` | Surgical SEARCH/REPLACE edits within a note | Act only |
| `search_vault` | Regex/text search across notes with context lines | Plan & Act |
| `list_vault` | List vault folder structure and file metadata | Plan & Act |
| `read_frontmatter` | Read a note's YAML frontmatter as structured data | Plan & Act |
| `update_frontmatter` | Add, modify, or remove specific frontmatter keys | Act only |
| `manage_tags` | Add or remove tags via the frontmatter `tags` property | Act only |
| `fetch_webpage` | Fetch a URL and return its content as Markdown | Plan & Act |
| `execute_command` | Run a shell command and return its output | Act only |
| `read_file` | Read a text file from the filesystem (desktop only) | Plan & Act |
| `read_docx` | Read a `.docx` file and return its content as Markdown (desktop only) | Plan & Act |
| `write_docx` | Convert Markdown to a `.docx` file on the filesystem (desktop only) | Act only |

Every tool call is displayed inline in the chat thread — name, parameters, result, and status — so you always see exactly what the AI is doing.

Tools marked **Act only** are blocked in Plan mode. See [safety.md](safety.md) for details on Plan/Act mode and the approval workflow.

Tools marked **desktop only** are unavailable on mobile and return an error if invoked there.

## Web fetching

The `fetch_webpage` tool lets the AI retrieve external content:

- Fetches any `http://` or `https://` URL and converts HTML to Markdown using the Turndown library.
- Plain text and JSON responses are returned as-is. Binary and unsupported content types return a structured error.
- Configurable domain denylist — add entries in **Settings → Notor** to prevent the AI from fetching specific domains.
- Configurable size limits: raw download cap (default: 5 MB) and output character cap (default: 50,000 characters). Pages exceeding the output cap are truncated with a notice to the AI.
- Defaults to auto-approved (read-only tool, available in Plan and Act modes).

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

### Settings

Configure Word & file tools under **Settings → Notor → Word & file tools**:

| Setting | Description |
|---------|-------------|
| **Allowed read/write paths** | Additional filesystem directories accessible to all three tools. Vault root is always implicitly included. |
| **Default output directory** | Default output directory for `write_docx`. Accepts vault-relative or absolute path. Leave empty to require `output_path` per call. |
| **Default template path** | Default `.docx` template applied by `write_docx`. Accepts vault-relative or absolute path. Leave empty to use no template. Validated on blur — an inline error appears if the path does not exist or is not a `.docx` file. |
