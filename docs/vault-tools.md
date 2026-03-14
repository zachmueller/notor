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

Every tool call is displayed inline in the chat thread — name, parameters, result, and status — so you always see exactly what the AI is doing.

Tools marked **Act only** are blocked in Plan mode. See [safety.md](safety.md) for details on Plan/Act mode and the approval workflow.

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
