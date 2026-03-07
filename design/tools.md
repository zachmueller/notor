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

> **⚠️ Research required: frontmatter handling**
>
> Obsidian notes are plain Markdown files where frontmatter is stored as YAML at the top of the file. Before specifying the final parameter interface for `write_note`, we need to research how Obsidian's vault API handles writes — specifically whether it overwrites the entire file (including frontmatter) or only the body content. The key risk: if the LLM has not read the frontmatter of an existing note (e.g., `include_frontmatter` was `false` on `read_note`), a full-file write could silently destroy existing frontmatter. This research must be completed before creating implementation specifications. See [Roadmap — Research tasks](roadmap.md#research-tasks).

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
| `limit` | number | no | `50` | Maximum number of items to return |
| `offset` | number | no | `0` | Number of items to skip (for pagination) |
| `sort_by` | string | no | `last_modified` | Sort order: `last_modified` (newest first) or `alphabetical` |

- Returns a structured list of files and folders.
- Indicates file type (note, image, attachment, etc.) and basic metadata (size, modified date).
- Results are paginated to handle vaults where users keep large numbers of notes in a single directory (commonly the vault root). The response includes `total_count` so the caller knows how many items exist and can request additional pages via `offset`.
- **Mode**: read-only (available in Plan and Act).

### `fetch_webpage` (Phase 3)

Fetch a webpage and convert its HTML content to Markdown for efficient consumption in the LLM context window.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | string | yes | — | URL of the webpage to fetch |

- Fetches the page HTML via HTTP request, then converts to Markdown using [Turndown](https://github.com/mixmark-io/turndown) (bundled directly into the plugin).
- Returns the converted Markdown content in the tool result. Does **not** write to a note — the user can direct the LLM to save the content to a note if desired.
- No truncation or pagination of the returned content.
- **Domain denylist**: users can configure a denylist of domains in **Settings → Notor**. Requests to denylisted domains return an error indicating the domain is blocked by the user. This allows users to mark sources they consider untrustworthy. Matching is exact-domain only: denylisting `example.com` blocks only `example.com` itself, not its sub-domains. To block sub-domains, users must add separate wildcard entries (e.g., `*.example.com`).
- The initial implementation uses raw Turndown conversion. Content extraction quality (e.g., stripping navigation, ads, boilerplate via a readability library) may be improved in future iterations.
- **Mode**: read-only (available in Plan and Act).

> **Design note: Turndown bundling**
>
> Turndown (~14KB minified) is bundled directly into the Notor plugin as a JavaScript/TypeScript dependency. If future iterations require content extraction (e.g., Mozilla's Readability.js ~40KB), that can also be bundled without significant impact on plugin size.

### `execute_command` (Phase 3)

Execute a shell command on the user's system.

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `command` | string | yes | — | Shell command to execute |
| `working_directory` | string | no | vault root | Working directory for the command |

- Cross-platform compatible (must work on macOS, Windows, Linux).
- Output (stdout + stderr) returned to the AI.
- Configurable restrictions: users can block specific commands or patterns in Plan mode and/or Act mode.
- **OS context**: the user's operating system (macOS, Windows, Linux) is injected into the auto-context so the LLM can generate platform-appropriate commands. See [Architecture — Auto-context injection](architecture.md#auto-context-injection-phase-3).
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
| `fetch_webpage` | read | ✓ | ✓ | 3 |
| `execute_command` | write | ✗ | ✓ | 3 |

---

## Custom MCP tools (Phase 5)

Beyond the built-in tools, Notor should support user-defined tools via the Model Context Protocol (MCP).

### Resolved decisions

- **Execution model**: for now, all user-created tools are hosted externally as MCP servers. A future capability to enable user-created tools running directly within Obsidian (in-process) may be explored later, but is out of scope for the initial implementation.
- **Discovery and configuration**: users register and configure custom MCP servers within the Obsidian Settings UI for the Notor plugin (e.g., server URL or local process command).
- **Tool schema**: custom tools follow the standard MCP tool schema conventions (name, description, input JSON schema) so the AI can discover and use them the same way as built-in tools.
- **Trust**: custom tools bypass the built-in safety guarantees. Clear documentation and appropriate warnings are required in the settings UI and in user-facing docs.

### Design direction

- Built-in tools are implemented natively in the plugin (not as MCP servers).
- Custom tools connect via MCP protocol to external servers.
- The tool dispatch layer should be uniform — the AI sees both built-in and custom tools the same way, and auto-approve / Plan-Act restrictions apply equally.

### MCP tool classification and Plan/Act awareness

- **Read/write classification**: each custom MCP tool can optionally be classified as read-only or write in its Notor configuration. This classification is used to enforce Plan/Act restrictions the same way as built-in tools (write-classified MCP tools are blocked in Plan mode).
- **Plan/Act state signaling**: beyond Notor's own enforcement of read/write restrictions, the current Plan/Act mode state should be communicated to MCP tool servers so they can make their own decisions about whether to take write-type actions. The trust model is cooperative — MCP servers are trusted to respect the signal, and Notor does not attempt to externally verify compliance. Users are responsible for understanding the behavior of their configured MCP tools.
- The signal is a simple binary: `plan` or `act`. Additional context (auto-approve settings, active persona, etc.) is not included in the initial implementation.

> **⚠️ Research required: Plan/Act state signaling mechanism for MCP tools**
>
> The specific mechanism for communicating Plan/Act state to MCP servers needs research and experimentation. Potential approaches include: passing the mode as an extra parameter or metadata field in each tool invocation, providing it as part of MCP server initialization/configuration context, or defining a custom MCP protocol extension (e.g., a capability or queryable resource). The right approach may depend on MCP protocol conventions and what MCP server implementations can realistically consume. This research should be conducted alongside the broader MCP integration research. See [Roadmap — Research tasks](roadmap.md#research-tasks). Output: findings incorporated into `design/research/mcp-server-integration.md`.

> **⚠️ Research required: MCP integration in Obsidian**
>
> We need to research the practical options for how an Obsidian plugin can discover and communicate with locally-running MCP servers. Key questions include: transport mechanisms (stdio, HTTP/SSE, WebSocket), how to spawn/manage local MCP server processes from within the Obsidian plugin sandbox, and any Electron/Node.js API constraints that affect connectivity. This research should be completed before creating implementation specifications for Phase 5. See [Roadmap — Research tasks](roadmap.md#research-tasks).
