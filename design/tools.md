# Tools

Notor exposes a set of tools that the AI can invoke during conversations. Tools are the mechanism through which the AI interacts with the vault, the filesystem, and external systems.

---

## Design principles for tools

- **Minimal and purposeful**: each tool does one thing well. Avoid swiss-army-knife tools with too many modes.
- **Safe by default**: tools that modify state require approval unless explicitly auto-approved. Read-only tools can default to auto-approve.
- **Plan/Act aware**: each tool is classified as read-only or write, and Plan mode enforces the restriction at the dispatch level.
- **Transparent**: every tool call and its result is surfaced in the chat UI (see [UX — Tool call display](ux.md#tool-call-display)).

---

## Built-in tools

### `read_note`

Read the contents of a note in the vault.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes | — | Path to the note relative to vault root |
| `include_frontmatter` | boolean | no | `false` | Whether to include YAML frontmatter in the returned content |

- Uses Obsidian's vault API (not raw filesystem access).
- Returns the note content as a string.
- **Mode**: read-only (available in Plan and Act).

### `write_note`

Create a new note or overwrite an existing note's entire content.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes | — | Path to the note relative to vault root |
| `content` | string | yes | — | Complete content to write |

- Uses Obsidian's vault API.
- Creates intermediate directories if they don't exist.
- Triggers a checkpoint snapshot before writing (Phase 2).
- **Mode**: write (Act only).

### `replace_in_note`

Make targeted edits within a note using SEARCH/REPLACE blocks. This is the primary tool for surgical note editing — modifying specific sections without rewriting the entire note.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes | — | Path to the note relative to vault root |
| `changes` | array | yes | — | Array of `{ search: string, replace: string }` blocks |

- Each `search` string must match a contiguous block of text in the note exactly (character-for-character including whitespace).
- Each block replaces only the first occurrence of the search text.
- Multiple blocks are applied in sequence (order matters).
- An empty `replace` string deletes the matched text.
- Triggers a checkpoint snapshot before applying (Phase 2).
- If any search block fails to match, the entire operation fails and no changes are applied.
- **Mode**: write (Act only).

### `search_vault`

Search across notes in the vault using regex or text patterns, returning matches with surrounding context.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string | yes | — | Regex pattern or text to search for |
| `path` | string | no | vault root | Directory to search within (relative to vault root) |
| `context_lines` | number | no | `3` | Number of surrounding lines to include with each match |
| `file_pattern` | string | no | `*.md` | Glob pattern to filter which files to search |

- Returns matches grouped by file, with line numbers and surrounding context.
- Uses Obsidian's vault API to enumerate and read files.
- **Mode**: read-only (available in Plan and Act).

### `list_vault`

List the folder and note structure of the vault or a subdirectory.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | no | vault root | Directory to list (relative to vault root) |
| `recursive` | boolean | no | `false` | Whether to list contents recursively |

- Returns a structured list of files and folders.
- Indicates file type (note, image, attachment, etc.) and basic metadata (size, modified date).
- **Mode**: read-only (available in Plan and Act).

### `execute_command` (Phase 3)

Execute a shell command on the user's system.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `command` | string | yes | — | Shell command to execute |
| `working_directory` | string | no | vault root | Working directory for the command |

- Cross-platform compatible (must work on macOS, Windows, Linux).
- Output (stdout + stderr) returned to the AI.
- Configurable restrictions: users can block specific commands or patterns in Plan mode and/or Act mode.
- **Mode**: write (Act only by default, configurable).

---

## Note metadata tools (Phase 2)

Dedicated operations for note metadata, beyond raw text manipulation.

### `read_frontmatter`

Read the parsed frontmatter of a note as structured data (key-value pairs).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes | — | Path to the note |

### `update_frontmatter`

Add, modify, or remove specific frontmatter properties without touching note body content.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes | — | Path to the note |
| `set` | object | no | — | Key-value pairs to add or update |
| `remove` | array | no | — | Keys to remove |

### `manage_tags`

Add or remove tags on a note (operating on frontmatter `tags` property).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | string | yes | — | Path to the note |
| `add` | array | no | — | Tags to add |
| `remove` | array | no | — | Tags to remove |

---

## Tool classification

| Tool | Read/Write | Plan mode | Act mode | Phase |
|---|---|---|---|---|
| `read_note` | read | ✓ | ✓ | 1 |
| `write_note` | write | ✗ | ✓ | 1 |
| `replace_in_note` | write | ✗ | ✓ | 1 |
| `search_vault` | read | ✓ | ✓ | 1 |
| `list_vault` | read | ✓ | ✓ | 1 |
| `read_frontmatter` | read | ✓ | ✓ | 2 |
| `update_frontmatter` | write | ✗ | ✓ | 2 |
| `manage_tags` | write | ✗ | ✓ | 2 |
| `execute_command` | write | ✗ | ✓ | 3 |

---

## Custom MCP tools (Phase 5)

Beyond the built-in tools, Notor should support user-defined tools via the Model Context Protocol (MCP).

### Open questions

- **Execution model**: can some custom tools run directly within Obsidian (in-process), or must all custom tools be externally hosted MCP servers? Running in-process is simpler for users but has security and stability implications.
- **Discovery and configuration**: how do users register custom MCP servers? Likely via Notor settings, pointing to a server URL or local process.
- **Tool schema**: MCP defines a standard tool schema (name, description, input JSON schema). Custom tools should follow this convention so the AI can discover and use them the same way as built-in tools.
- **Trust**: custom tools bypass the built-in safety guarantees. Need clear documentation and appropriate warnings.

### Design direction

- Built-in tools are implemented natively in the plugin (not as MCP servers).
- Custom tools connect via MCP protocol to external servers.
- The tool dispatch layer should be uniform — the AI sees both built-in and custom tools the same way, and auto-approve / Plan-Act restrictions apply equally.