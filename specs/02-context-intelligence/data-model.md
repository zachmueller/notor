# Data Model: Phase 3 — Context & Intelligence

**Created:** 2026-07-03
**Plan:** [specs/02-context-intelligence/plan.md](plan.md)
**Specification:** [specs/02-context-intelligence/spec.md](spec.md)

This document defines the new data entities, extensions to existing entities, and state transitions introduced in Phase 3. It extends the MVP data model defined in [specs/01-mvp/data-model.md](../01-mvp/data-model.md).

---

## Entity Relationship Overview

```
┌─────────────┐       1:N       ┌─────────────┐       0:N       ┌─────────────┐
│ Conversation │───────────────▶│   Message    │───────────────▶│ Attachment  │
└──────┬──────┘                 └──────┬──────┘                 └─────────────┘
       │                               │
       │ 0:N                           │ 0..1:1
       ▼                               ▼
┌──────────────┐               ┌─────────────┐
│ Compaction   │               │  ToolCall   │
│   Record     │               └─────────────┘
└──────────────┘

┌──────────────────┐
│ AutoContextSource│  (enum, evaluated at send time)
└──────────────────┘

┌─────────────┐       1:N       ┌─────────────┐
│  HookEvent  │───────────────▶│    Hook     │
│  (enum)     │                 │  (config)   │
└─────────────┘                 └─────────────┘

┌───────────────────┐
│DomainDenylistEntry│  (settings list)
└───────────────────┘
```

---

## New Entities

### Attachment

A note, note section, or external file attached by the user to a chat message. Attachments provide explicit context to the LLM without requiring tool calls.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier (UUID v4) |
| `type` | enum | yes | One of: `vault_note`, `vault_note_section`, `external_file` |
| `path` | string | yes | For vault notes: vault-relative path (e.g., `Research/Climate.md`). For external files: original absolute file path at attach time. |
| `section` | string \| null | no | Section heading reference (e.g., `Key Findings`). Only for `vault_note_section` type. |
| `display_name` | string | yes | Human-readable label shown in the attachment chip (note filename, section reference, or external filename) |
| `content` | string \| null | no | For external files: file content read at attach time. For vault notes/sections: `null` (content is resolved at send time). |
| `content_length` | number \| null | no | Length of the resolved content in characters (populated at send time) |
| `status` | enum | yes | One of: `pending`, `resolved`, `error` |
| `error_message` | string \| null | no | Error description if the attachment could not be resolved (e.g., note deleted before send) |

**Lifecycle:**
1. User adds an attachment via the picker or `[[` shortcut → attachment created with `status: pending`
2. User can remove the attachment before sending → attachment discarded
3. At send time:
   - Vault notes/sections: content read from vault via `vault.read()`. If successful → `status: resolved`, `content_length` populated. If file not found → `status: error`, `error_message` set, inline warning surfaced.
   - External files: content already populated at attach time → `status: resolved`
4. Resolved attachment content is embedded in the `<attachments>` XML block in the user message

**Validation rules:**
- `type` must be one of the defined enum values
- `path` must be non-empty
- `section` is required when `type` is `vault_note_section`, null otherwise
- `content` is required when `type` is `external_file`, null for vault types until resolution
- Duplicate detection: same `path` + `section` combination on the same message is silently deduplicated

**Section extraction logic:**
When `type` is `vault_note_section`, the plugin extracts content from the heading matching `section` to the next heading of equal or higher level (or end of file). Heading lookup uses `metadataCache.getFileCache(file)?.headings` and takes the first match if multiple headings share the same text.

**XML serialization format:**
```xml
<attachments>
  <vault-note path="Research/Climate.md">...full note content...</vault-note>
  <vault-note path="Research/Climate.md" section="Key Findings">...section content...</vault-note>
  <external-file name="data.csv">...file content...</external-file>
</attachments>
```

---

### AutoContextSource

An enumeration of ambient context sources that are automatically injected with every user message. Each source is individually toggleable in settings.

| Source ID | Description | Output Format | Default |
|---|---|---|---|
| `open_notes` | File paths of all notes open in the Obsidian workspace (all leaf/tab views, pinned tabs, split panes) | Newline-separated list of vault-relative paths | Enabled |
| `vault_structure` | Top-level folder names at the vault root (folders only, no files, no recursion) | Comma-separated list of folder names | Enabled |
| `os` | User's operating system platform | One of: `macOS`, `Windows`, `Linux` | Enabled |

**Not persisted as structured data.** The source enumeration is defined in code. The enabled/disabled state for each source is persisted in plugin settings as individual boolean fields.

**Evaluation:** Sources are evaluated immediately before each message dispatch. Only enabled sources contribute to the `<auto-context>` block. If all sources are disabled, no `<auto-context>` block is included in the message.

**XML serialization format:**
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

---

### CompactionRecord

An event logged in the JSONL conversation file when auto-compaction occurs. This is a special message type that records the compaction event for history and UI display.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique event identifier (UUID v4) |
| `conversation_id` | string | yes | Parent conversation ID |
| `type` | string | yes | Always `"compaction"` (distinguishes from regular messages) |
| `timestamp` | string (ISO 8601) | yes | When the compaction occurred |
| `token_count_at_compaction` | number | yes | Cumulative token count at the time compaction was triggered |
| `context_window_limit` | number | yes | The model's context window limit used for threshold calculation |
| `threshold` | number | yes | The compaction threshold fraction that was configured (e.g., 0.8) |
| `summary` | string | yes | The LLM-generated conversation summary |
| `summary_tokens` | number \| null | no | Estimated token count of the generated summary |
| `trigger` | enum | yes | One of: `automatic`, `manual` |

**Persistence:** Stored as a line in the conversation JSONL file, interleaved with regular messages at the position where compaction occurred.

**UI display:** Rendered as a "Context compacted" marker in the chat timeline. On hover/expand, shows `timestamp` and `token_count_at_compaction`. The `summary` text is **not** displayed in the UI — it is retained in the JSONL log only.

**JSONL format:**
```jsonc
{"id":"evt-uuid","conversation_id":"conv-uuid","type":"compaction","timestamp":"2026-07-03T10:30:00Z","token_count_at_compaction":95000,"context_window_limit":128000,"threshold":0.8,"summary":"The user has been researching climate change impacts...","summary_tokens":450,"trigger":"automatic"}
```

---

### Hook

A configured callback tied to a specific LLM lifecycle event. Hooks execute shell commands with conversation metadata injected as environment variables.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique hook identifier (UUID v4) |
| `event` | enum | yes | One of: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion` |
| `command` | string | yes | Shell command to execute |
| `label` | string | no | Optional user-friendly description of the hook's purpose |
| `enabled` | boolean | yes | Whether the hook is active (default: true) |

**Persistence:** Stored in plugin settings as an ordered list grouped by event type.

**Settings structure:**
```typescript
interface HookConfig {
  pre_send: Hook[];
  on_tool_call: Hook[];
  on_tool_result: Hook[];
  after_completion: Hook[];
}
```

**Execution semantics by event:**

| Event | Timing | Blocking | Stdout Captured | Environment Variables |
|---|---|---|---|---|
| `pre_send` | After user submits, before LLM dispatch | Yes (awaited sequentially) | Yes — appended to message context | `NOTOR_CONVERSATION_ID`, `NOTOR_HOOK_EVENT`, `NOTOR_WORKFLOW_NAME`, `NOTOR_TIMESTAMP` |
| `on_tool_call` | After approval, before tool execution | No (fire-and-forget) | No | Above + `NOTOR_TOOL_NAME`, `NOTOR_TOOL_PARAMS` |
| `on_tool_result` | After tool execution, before result to LLM | No (fire-and-forget) | No | Above + `NOTOR_TOOL_NAME`, `NOTOR_TOOL_PARAMS`, `NOTOR_TOOL_RESULT`, `NOTOR_TOOL_STATUS` |
| `after_completion` | After full LLM response turn completes | No (fire-and-forget) | No | `NOTOR_CONVERSATION_ID`, `NOTOR_HOOK_EVENT`, `NOTOR_WORKFLOW_NAME`, `NOTOR_TIMESTAMP` |

**Environment variable details:**

| Variable | Type | Present For | Description |
|---|---|---|---|
| `NOTOR_CONVERSATION_ID` | string | All events | UUID of the current conversation |
| `NOTOR_HOOK_EVENT` | string | All events | Event name: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion` |
| `NOTOR_WORKFLOW_NAME` | string | All events | Active workflow name (empty string if none; populated in Phase 4) |
| `NOTOR_TIMESTAMP` | string (ISO 8601) | All events | UTC timestamp of the event |
| `NOTOR_TOOL_NAME` | string | `on_tool_call`, `on_tool_result` | Name of the tool being invoked |
| `NOTOR_TOOL_PARAMS` | string (JSON) | `on_tool_call`, `on_tool_result` | Serialized tool parameters; truncated at configurable cap |
| `NOTOR_TOOL_RESULT` | string | `on_tool_result` | Tool result output; truncated at configurable cap |
| `NOTOR_TOOL_STATUS` | string | `on_tool_result` | `success` or `error` |

**Truncation:** Environment variable values exceeding the configured cap (default: 10,000 characters) are truncated with a marker: `[truncated at 10,000 chars; full length: 48,231 chars]`. Full data remains in the JSONL log.

**Timeout:** All hooks share a single global timeout (default: 10 seconds). When exceeded, the shell process is terminated (`SIGTERM` → `SIGKILL` after grace period). A non-blocking notice is surfaced.

**Failure handling:** Hook failures are independent — a failed or timed-out hook does not prevent subsequent hooks in the sequence from executing. Failures are surfaced as non-blocking notices.

---

### DomainDenylistEntry

A domain pattern in the user-configured denylist for `fetch_webpage`.

| Field | Type | Required | Description |
|---|---|---|---|
| `pattern` | string | yes | Domain string or wildcard pattern |

**Matching rules:**
- **Exact domain:** `example.com` matches only `example.com` requests (not sub-domains)
- **Wildcard:** `*.example.com` matches all sub-domains of `example.com` (e.g., `www.example.com`, `api.example.com`) but not `example.com` itself

**Persistence:** Stored in plugin settings as `string[]` (`domain_denylist` setting field).

**Evaluation:** Before every `fetch_webpage` execution, the requested URL's domain is checked against all denylist entries. If any entry matches, the tool returns an error without making a network request.

---

## Extensions to Existing Entities

### Message (extended)

The Message entity from the MVP data model is extended with the following fields for Phase 3:

| Field | Type | Required | Description |
|---|---|---|---|
| `attachments` | Attachment[] \| null | no | Attachments included with this message (for `user` role messages only) |
| `auto_context` | object \| null | no | Auto-context data included with this message (for `user` role messages only) |
| `hook_injections` | string[] \| null | no | Captured stdout from `pre-send` hooks (for `user` role messages only) |

**`auto_context` structure:**
```typescript
interface AutoContext {
  open_notes?: string[];      // Vault-relative paths of open notes
  vault_structure?: string[]; // Top-level folder names
  os?: string;                // Platform name
}
```

These fields are persisted in the JSONL log alongside existing message fields, providing a complete record of what context was sent with each message.

### Conversation (extended)

The Conversation entity is extended with:

| Field | Type | Required | Description |
|---|---|---|---|
| `compaction_count` | number | yes | Number of auto-compaction events in this conversation (default: 0) |
| `last_compaction_at` | string (ISO 8601) \| null | no | Timestamp of the most recent compaction event |

### Plugin Settings (extended)

New settings fields for Phase 3 (extends the settings model from [specs/01-mvp/data-model.md](../01-mvp/data-model.md)):

| Setting | Type | Default | Description |
|---|---|---|---|
| `auto_context_open_notes` | boolean | `true` | Enable open note paths auto-context |
| `auto_context_vault_structure` | boolean | `true` | Enable vault structure auto-context |
| `auto_context_os` | boolean | `true` | Enable OS platform auto-context |
| `compaction_threshold` | number | `0.8` | Fraction of context window that triggers auto-compaction (0.0–1.0) |
| `compaction_prompt_override` | string | `""` | Custom compaction system prompt (empty = use built-in default) |
| `fetch_webpage_timeout` | number | `15` | HTTP request timeout in seconds |
| `fetch_webpage_max_download_mb` | number | `5` | Maximum raw download size in MB |
| `fetch_webpage_max_output_chars` | number | `50000` | Maximum output character count after conversion |
| `domain_denylist` | string[] | `[]` | Blocked domains/patterns for `fetch_webpage` |
| `execute_command_timeout` | number | `30` | Per-command timeout in seconds |
| `execute_command_max_output_chars` | number | `50000` | Maximum command output character count |
| `execute_command_allowed_paths` | string[] | `[]` | Additional allowed working directory absolute paths (vault root always included) |
| `execute_command_shell` | string | `""` | Custom shell executable (empty = platform default: `$SHELL` on macOS/Linux, PowerShell on Windows) |
| `execute_command_shell_args` | string[] | `[]` | Custom shell launch arguments (empty = platform default: `["-l"]` on macOS/Linux, `[]` on Windows) |
| `external_file_size_threshold_mb` | number | `1` | File size threshold in MB that triggers a confirmation dialog for external file attachment |
| `hooks` | HookConfig | `{ pre_send: [], on_tool_call: [], on_tool_result: [], after_completion: [] }` | Hook configurations grouped by lifecycle event |
| `hook_timeout` | number | `10` | Global hook timeout in seconds (applies to all hook events) |
| `hook_env_truncation_chars` | number | `10000` | Maximum character length for environment variable values passed to hook shell commands |

**Auto-approve additions:**

| Tool | Default Auto-Approve |
|---|---|
| `fetch_webpage` | `true` (read-only) |
| `execute_command` | `false` (write) |

---

## Token Estimation Model

Auto-compaction requires tracking cumulative token usage across a conversation. Phase 3 uses a lightweight local estimation rather than provider tokenization APIs.

**Estimation approach:** `estimated_tokens = character_count / 4`

This heuristic approximates the average token-to-character ratio for English text across common BPE tokenizers (GPT-4: ~3.5–4 chars/token, Claude: ~3.5–4 chars/token). It deliberately underestimates slightly to provide a conservative trigger (compaction fires a bit early rather than risking context overflow).

**What is counted:**
- System prompt content (including vault rules)
- User message content (including auto-context block, attachments block, hook injections, and user text)
- Assistant response content
- Tool call parameters (serialized)
- Tool result content
- Compaction summary content (in the post-compaction context window)

**What is not counted:**
- Message metadata (timestamps, IDs) — negligible contribution
- Provider-specific framing tokens (e.g., `<|im_start|>`) — varies by provider, absorbed by the safety margin

**Per-model context window limits** are sourced from the model metadata table established in Phase 0 (see [specs/01-mvp/data-model.md](../01-mvp/data-model.md) § ModelInfo). For models where `context_window` is null, auto-compaction falls back to the existing truncation behavior (no compaction threshold can be computed).

---

## User Message Assembly

Phase 3 introduces a defined structure for user messages sent to the LLM. The assembled message follows a fixed ordering from least to most salient:

```
┌─────────────────────────────────────┐
│ 1. <auto-context> block             │  ← Ambient workspace signals
│    (if any sources enabled)         │
├─────────────────────────────────────┤
│ 2. <attachments> block              │  ← User-attached notes/files
│    (if any attachments present)     │
├─────────────────────────────────────┤
│ 3. pre-send hook stdout             │  ← Programmatic injections
│    (if any hooks configured)        │
├─────────────────────────────────────┤
│ 4. User's typed message text        │  ← The actual instruction
└─────────────────────────────────────┘
```

Each section is omitted if empty (no auto-context sources enabled, no attachments, no hooks, etc.). The user's typed text is always last to ensure it has maximum salience to the LLM.

**Example assembled message:**
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
Summarize the key findings and suggest three follow-up research questions.
```

---

## JSONL Schema Extensions

### Compaction record

```jsonc
{"id":"evt-uuid","conversation_id":"conv-uuid","type":"compaction","timestamp":"2026-07-03T10:30:00Z","token_count_at_compaction":95000,"context_window_limit":128000,"threshold":0.8,"summary":"The user has been researching climate change...","summary_tokens":450,"trigger":"automatic"}
```

### User message with attachments and auto-context

```jsonc
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"user","content":"Summarize the key findings...","timestamp":"2026-07-03T10:00:00Z","attachments":[{"id":"att-uuid","type":"vault_note_section","path":"Research/Climate.md","section":"Key Findings","display_name":"Climate.md § Key Findings","content_length":1247,"status":"resolved"}],"auto_context":{"open_notes":["Research/Climate.md","Daily/2026-07-03.md"],"vault_structure":["Daily","Projects","Research","Templates"],"os":"macOS"},"hook_injections":["Additional context from pre-send hook..."]}
```

### Tool call for `fetch_webpage`

```jsonc
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"tool_call","content":"","timestamp":"2026-07-03T10:01:00Z","tool_call":{"tool_name":"fetch_webpage","parameters":{"url":"https://en.wikipedia.org/wiki/Information_theory"},"status":"success"}}
```

### Tool result for `execute_command`

```jsonc
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"tool_result","content":"","timestamp":"2026-07-03T10:02:00Z","tool_result":{"tool_name":"execute_command","success":true,"result":"total 48\n-rw-r--r--  1 user  staff  1234 Jul  3 10:00 Climate.md\n...","duration_ms":234}}