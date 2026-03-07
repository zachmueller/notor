# Tool Schemas Contract: Phase 3

**Created:** 2026-07-03
**Plan:** [specs/02-context-intelligence/plan.md](../plan.md)
**Specification:** [specs/02-context-intelligence/spec.md](../spec.md)

JSON Schema definitions for the two new built-in tools introduced in Phase 3. These schemas extend the tool registry established in [specs/01-mvp/contracts/tool-schemas.md](../../01-mvp/contracts/tool-schemas.md).

---

## Phase 3 Tools

### `fetch_webpage`

Fetch a webpage by URL and return its content as Markdown for use in the conversation.

```json
{
  "name": "fetch_webpage",
  "description": "Fetch a webpage by URL and return its content converted to Markdown. For HTML pages, the content is converted using Turndown. For plain text and JSON responses, the content is returned as-is. Binary content types (PDF, images, etc.) are not supported. A domain denylist may block certain URLs. The returned content may be truncated if it exceeds the configured output size limit.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "URL of the webpage to fetch. Both http:// and https:// URLs are accepted."
      }
    },
    "required": ["url"]
  }
}
```

**Mode:** read (Plan + Act)
**Auto-approve default:** true

**Execution flow:**

1. Parse the URL and extract the domain.
2. Check the domain against the configured denylist. If blocked → return error immediately.
3. Execute HTTP GET with:
   - `User-Agent: Notor/1.0`
   - Redirect following: up to 5 hops (error if exceeded)
   - Request timeout: configurable (default: 15 seconds)
4. Stream the response body and enforce the raw download size cap (default: 5 MB). If exceeded → abort and return error.
5. Inspect the `Content-Type` header:
   - `text/html` → convert to Markdown via Turndown
   - `text/*` (e.g., `text/plain`) → return as-is
   - `application/json` → return as-is
   - All other types → return error (content type not supported)
6. Apply the output character cap (default: 50,000 chars). If exceeded → truncate and append notice.
7. Return the content as the tool result.

**Result format (success):**
```json
{
  "success": true,
  "result": "# Information Theory\n\nInformation theory is the mathematical study of..."
}
```

**Result format (success, truncated):**
```json
{
  "success": true,
  "result": "# Information Theory\n\n...[content]...\n\nNote: page was truncated at 50,000 characters; total fetched length was 87,342 characters."
}
```

**Error cases:**

| Condition | Error Message |
|---|---|
| Domain blocked | `"Domain example-tracker.com is blocked by your denylist."` |
| Network error | `"Failed to fetch URL: <error description>"` |
| Request timeout | `"Request timed out after 15 seconds."` |
| Non-200 HTTP status | `"HTTP request failed with status <code>: <status text>"` |
| Redirect limit exceeded | `"Too many redirects (exceeded 5 hops)."` |
| Download size exceeded | `"Response body too large: download aborted at 5 MB."` |
| Unsupported content type | `"Content type '<type>' is not supported. Only text/html, text/*, and application/json are supported."` |

---

### `execute_command`

Execute a shell command on the user's system and return the output.

```json
{
  "name": "execute_command",
  "description": "Execute a shell command on the user's system and return the combined stdout and stderr output. The command runs in the user's default login shell. The working directory must be within the vault or a user-configured allow-list of paths. Commands have a configurable timeout. Output may be truncated if it exceeds the configured size limit. This tool requires user approval unless auto-approved.",
  "input_schema": {
    "type": "object",
    "properties": {
      "command": {
        "type": "string",
        "description": "Shell command to execute"
      },
      "working_directory": {
        "type": "string",
        "description": "Working directory for the command, relative to vault root or as an absolute path. Defaults to vault root. Must be within the vault or a user-configured allowed path.",
        "default": ""
      }
    },
    "required": ["command"]
  }
}
```

**Mode:** write (Act only)
**Auto-approve default:** false

**Execution flow:**

1. Resolve the working directory:
   - If empty or not provided → use vault root
   - If relative → resolve relative to vault root
   - If absolute → use as-is
2. Validate the working directory is within the vault root or the user-configured allowed paths list. If not → return error.
3. Determine the shell to use:
   - If custom shell is configured in settings → use it with configured args
   - macOS/Linux default: `process.env.SHELL` (typically `/bin/zsh`) with `["-l", "-c", command]`
   - Windows default: `powershell.exe` with `["-Command", command]`
   - If the configured/resolved shell is not found → return error
4. Spawn the shell process with:
   - `cwd`: validated working directory
   - `env`: inherited from `process.env`
   - Combined stdout + stderr capture into a single buffer
5. Enforce the per-command timeout (default: 30 seconds). If exceeded → `SIGTERM` the process, wait a brief grace period, then `SIGKILL` if still running. Return timeout error with any partial output.
6. Apply the output character cap (default: 50,000 chars). If exceeded → truncate and append notice.
7. Return the output and exit code.

**Result format (success):**
```json
{
  "success": true,
  "result": "total 48\n-rw-r--r--  1 user  staff  1234 Jul  3 10:00 Climate.md\n-rw-r--r--  1 user  staff  5678 Jul  2 14:22 Weather.md\n"
}
```

**Result format (success, truncated):**
```json
{
  "success": true,
  "result": "...command output...\n\nNote: command output was truncated at 50,000 characters; total output length was 123,456 characters."
}
```

**Result format (non-zero exit code):**
```json
{
  "success": false,
  "result": "ls: cannot access '/nonexistent': No such file or directory\n",
  "error": "Command exited with code 2"
}
```

**Error cases:**

| Condition | Error Message |
|---|---|
| Plan mode | `"execute_command is not available in Plan mode. Switch to Act mode to run commands."` |
| Working directory outside allowed paths | `"Working directory '/etc' is outside the allowed paths. Allowed: vault root and configured paths."` |
| Shell not found | `"Shell '/bin/custom-shell' not found. Check your shell configuration in Settings → Notor."` |
| Timeout | `"Command timed out after 30 seconds. Partial output:\n<partial output>"` |
| Spawn error | `"Failed to execute command: <error description>"` |

---

## Context Assembly Contracts

### Auto-Context Format

The auto-context block is an XML-tagged structure prepended to the user message content. Each enabled source is wrapped in its own tag within the `<auto-context>` container.

**Schema:**
```xml
<auto-context>
  <!-- Present if auto_context_open_notes is enabled -->
  <open-notes>
{newline-separated list of vault-relative file paths}
  </open-notes>

  <!-- Present if auto_context_vault_structure is enabled -->
  <vault-structure>{comma-separated list of top-level folder names}</vault-structure>

  <!-- Present if auto_context_os is enabled -->
  <os>{platform name: macOS | Windows | Linux}</os>
</auto-context>
```

**Rules:**
- If all three sources are disabled, the entire `<auto-context>` block is omitted
- If a source is enabled but returns no data (e.g., no notes are open), the tag is included with empty content
- Tags for disabled sources are omitted entirely
- The `<open-notes>` tag uses newline-separated paths (one per line) for readability
- The `<vault-structure>` tag uses comma-separated folder names on a single line
- The `<os>` tag contains a single human-readable platform name

**Example (all sources enabled):**
```xml
<auto-context>
  <open-notes>
Research/Climate.md
Daily/2026-07-03.md
Projects/Website Redesign.md
  </open-notes>
  <vault-structure>Daily, Projects, Research, Templates, Archive</vault-structure>
  <os>macOS</os>
</auto-context>
```

**Example (only OS enabled):**
```xml
<auto-context>
  <os>macOS</os>
</auto-context>
```

---

### Attachment Format

The attachment block is an XML-tagged structure containing the content of user-attached notes and files. It is positioned after `<auto-context>` and before any hook injections in the assembled message.

**Schema:**
```xml
<attachments>
  <!-- Vault note (full content) -->
  <vault-note path="{vault-relative-path}">
{note content}
  </vault-note>

  <!-- Vault note section -->
  <vault-note path="{vault-relative-path}" section="{heading text}">
{section content}
  </vault-note>

  <!-- External file -->
  <external-file name="{filename}">
{file content}
  </external-file>
</attachments>
```

**Rules:**
- If no attachments are present, the entire `<attachments>` block is omitted
- Multiple attachments are listed within a single `<attachments>` container
- The `path` attribute for vault notes uses vault-relative paths
- The `name` attribute for external files uses the filename only (not the full absolute path), for privacy
- Attachment content is included as-is (no escaping of XML-like characters within the content body)
- Attachments that failed to resolve (status: `error`) are omitted from the block; an inline warning is shown in the chat UI instead

**Example:**
```xml
<attachments>
  <vault-note path="Research/Climate.md" section="Key Findings">
## Key Findings

Global temperatures have risen by 1.2°C since pre-industrial levels...
  </vault-note>
  <external-file name="temperature-data.csv">
Year,Global_Temp_Anomaly
2020,1.29
2021,1.11
2022,1.15
  </external-file>
</attachments>
```

---

### Hook Injection Format

`pre-send` hook stdout output is placed between the `<attachments>` block and the user's typed text. Each hook's stdout is a plain string (no XML wrapping).

**Rules:**
- Multiple `pre-send` hooks produce multiple injection strings, concatenated with newlines
- Empty stdout (hook produced no output) is omitted
- Hook failures do not inject any content (failure is surfaced as a notice only)

**Example (single hook with output):**
```
<auto-context>...</auto-context>
<attachments>...</attachments>
Current local time: 2026-07-03T10:00:00+12:00
Active project context: Website Redesign (deadline: 2026-07-15)
Summarize the key findings and suggest follow-up research.
```

---

### Complete Message Assembly

**Full assembled user message (all sections present):**
```
<auto-context>
  <open-notes>
Research/Climate.md
Daily/2026-07-03.md
  </open-notes>
  <vault-structure>Daily, Projects, Research, Templates</vault-structure>
  <os>macOS</os>
</auto-context>
<attachments>
  <vault-note path="Research/Climate.md" section="Key Findings">
## Key Findings

Global temperatures have risen by 1.2°C since pre-industrial levels...
  </vault-note>
</attachments>
Current local time: 2026-07-03T10:00:00+12:00
Summarize the key findings and suggest three follow-up research questions.
```

**Minimal assembled user message (no context, no attachments, no hooks):**
```
What time zone conventions does Obsidian use for timestamps?
```

---

## Hook Execution Contract

### Environment Variables

All hook shell commands receive conversation metadata as environment variables. The variable set depends on the hook event type.

**Universal variables (all events):**

| Variable | Format | Example |
|---|---|---|
| `NOTOR_CONVERSATION_ID` | UUID v4 | `550e8400-e29b-41d4-a716-446655440000` |
| `NOTOR_HOOK_EVENT` | Event name string | `pre_send` |
| `NOTOR_WORKFLOW_NAME` | Workflow name or empty | `""` (Phase 4 will populate) |
| `NOTOR_TIMESTAMP` | ISO 8601 UTC | `2026-07-03T10:00:00.000Z` |

**Tool-specific variables (`on_tool_call`, `on_tool_result`):**

| Variable | Format | Example |
|---|---|---|
| `NOTOR_TOOL_NAME` | Tool name string | `read_note` |
| `NOTOR_TOOL_PARAMS` | JSON string (may be truncated) | `{"path":"Research/Climate.md"}` |

**Result-specific variables (`on_tool_result` only):**

| Variable | Format | Example |
|---|---|---|
| `NOTOR_TOOL_RESULT` | Tool output string (may be truncated) | `# Climate Research\n\nThe introduction...` |
| `NOTOR_TOOL_STATUS` | `success` or `error` | `success` |

### Truncation

Environment variable values that exceed the configured cap (default: 10,000 characters) are truncated:

```
{first 10,000 characters of content}[truncated at 10,000 chars; full length: 48,231 chars]
```

### Execution Model

```
Hook triggered
  ├── Resolve shell (user config or platform default)
  ├── Build environment variables (inherited env + NOTOR_* vars)
  ├── Spawn child process
  │     ├── cwd: vault root
  │     ├── shell: resolved shell with args
  │     └── env: built environment
  ├── Start timeout timer (global hook timeout)
  │
  ├── [pre_send only] Capture stdout → message context injection
  │
  ├── Wait for process exit or timeout
  │     ├── Normal exit → log result, surface notice if non-zero exit
  │     └── Timeout → SIGTERM → grace period → SIGKILL → surface notice
  │
  └── [pre_send only] Return captured stdout for message assembly
```

### Shell Command Construction

The hook command string is passed to the shell as a single argument:

| Platform | Shell | Invocation |
|---|---|---|
| macOS | `$SHELL` (default: `/bin/zsh`) | `spawn($SHELL, ["-l", "-c", hookCommand])` |
| Linux | `$SHELL` (default: `/bin/bash`) | `spawn($SHELL, ["-l", "-c", hookCommand])` |
| Windows | PowerShell | `spawn("powershell.exe", ["-Command", hookCommand])` |

Custom shell configuration (from settings) overrides these defaults.

---

## Tool Dispatch Updates

### Updated Tool Classification Table

Extends the table from [specs/01-mvp/contracts/tool-schemas.md](../../01-mvp/contracts/tool-schemas.md):

| Tool | Read/Write | Plan mode | Act mode | Phase | Auto-approve |
|---|---|---|---|---|---|
| `read_note` | read | ✓ | ✓ | 1 | true |
| `write_note` | write | ✗ | ✓ | 1 | false |
| `replace_in_note` | write | ✗ | ✓ | 1 | false |
| `search_vault` | read | ✓ | ✓ | 1 | true |
| `list_vault` | read | ✓ | ✓ | 1 | true |
| `read_frontmatter` | read | ✓ | ✓ | 2 | true |
| `update_frontmatter` | write | ✗ | ✓ | 2 | false |
| `manage_tags` | write | ✗ | ✓ | 2 | false |
| **`fetch_webpage`** | **read** | **✓** | **✓** | **3** | **true** |
| **`execute_command`** | **write** | **✗** | **✓** | **3** | **false** |

### Updated Dispatch Flow

The dispatch flow from the MVP is extended with the following additions for Phase 3:

```
1. Parse tool call from LLM response
2. Look up tool in registry by name
3. IF tool not found → return error to LLM
4. IF mode is "plan" AND tool.mode is "write" → return Plan mode error to LLM
5. IF tool is "fetch_webpage" → check domain denylist
   5a. IF domain blocked → return denylist error to LLM
6. IF tool is "execute_command" → validate working directory
   6a. IF outside allowed paths → return path restriction error to LLM
7. IF auto_approve is false for tool → show approval UI, wait for user response
   7a. IF rejected → return rejection message to LLM
8. Fire on_tool_call hooks (non-blocking)
9. IF tool is write AND note was previously read → perform stale content check
   9a. IF stale → return stale content error to LLM
10. IF tool is write → create checkpoint (Phase 2)
11. Execute tool
12. Fire on_tool_result hooks (non-blocking)
13. IF tool is read AND accesses a note → update last-read cache, re-evaluate vault rules
14. Check compaction threshold before returning result to LLM
    14a. IF threshold crossed → trigger auto-compaction
15. Return result to LLM
16. Display tool call inline in chat thread (name, params, result, status)