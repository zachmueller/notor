# Data Model: Notor MVP

**Created:** 2026-06-03
**Plan:** [specs/01-mvp/plan.md](plan.md)
**Specification:** [specs/01-mvp/spec.md](spec.md)

This document defines the data entities, their relationships, validation rules, and state transitions for the Notor MVP (Phases 0–2).

---

## Entity Relationship Overview

```
┌─────────────┐       1:N       ┌─────────────┐
│ Conversation │───────────────▶│   Message    │
└──────┬──────┘                 └──────┬──────┘
       │                               │
       │ 1:N                           │ 0..1:1 (tool_call/tool_result)
       ▼                               ▼
┌─────────────┐                ┌─────────────┐
│ Checkpoint  │                │  ToolCall   │
└─────────────┘                └─────────────┘

┌─────────────┐       1:1       ┌─────────────┐
│LLMProvider  │───────────────▶│ Credentials │
│  Config     │                 │  (secrets)  │
└─────────────┘                 └─────────────┘

┌─────────────┐
│ VaultRule   │  (independent, evaluated per conversation context)
└─────────────┘
```

---

## Entities

### Conversation

An ordered sequence of messages representing a single AI interaction session.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier (UUID v4) |
| `created_at` | string (ISO 8601) | yes | Conversation creation timestamp |
| `updated_at` | string (ISO 8601) | yes | Last activity timestamp |
| `title` | string | no | Display title (derived from first user message if not set) |
| `provider_id` | string | yes | Provider type active when conversation started |
| `model_id` | string | yes | Model ID active when conversation started |
| `total_input_tokens` | number | yes | Cumulative input tokens across all messages |
| `total_output_tokens` | number | yes | Cumulative output tokens across all messages |
| `estimated_cost` | number \| null | yes | Cumulative estimated cost (null if pricing unavailable) |
| `mode` | `"plan"` \| `"act"` | yes | Current Plan/Act mode state |

**Persistence:** Each conversation is stored as a separate JSONL file in the history directory (default: `.obsidian/plugins/notor/history/`). The filename format is `{timestamp}_{id}.jsonl`.

**Lifecycle:**
- Created when user clicks "New conversation" or sends the first message
- Updated on every message send/receive
- Pruned based on retention policy (default: 500 MB total, 90-day max age)

### Message

A single message within a conversation. Each line in the JSONL file represents one message or event.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique message identifier (UUID v4) |
| `conversation_id` | string | yes | Parent conversation ID |
| `role` | enum | yes | One of: `system`, `user`, `assistant`, `tool_call`, `tool_result` |
| `content` | string | yes | Message text content |
| `timestamp` | string (ISO 8601) | yes | When the message was created |
| `input_tokens` | number \| null | no | Input token count for this message (null for non-LLM messages) |
| `output_tokens` | number \| null | no | Output token count for this message (null for non-LLM messages) |
| `cost_estimate` | number \| null | no | Estimated cost for this message (null if pricing unavailable) |
| `tool_call` | ToolCall \| null | no | Tool call details (for `tool_call` role only) |
| `tool_result` | ToolResult \| null | no | Tool result details (for `tool_result` role only) |
| `truncated` | boolean | no | Whether this message was truncated from the LLM context window (default: false) |

**Role definitions:**
- `system` — System prompt and injected context. Always the first message(s).
- `user` — User-typed input.
- `assistant` — LLM-generated response text.
- `tool_call` — LLM request to invoke a tool.
- `tool_result` — Output returned from tool execution.

**Validation rules:**
- `role` must be one of the defined enum values
- `content` must be a non-empty string
- `tool_call` is required when `role` is `tool_call`, null otherwise
- `tool_result` is required when `role` is `tool_result`, null otherwise

### ToolCall

Structured record of a tool invocation requested by the LLM.

| Field | Type | Required | Description |
|---|---|---|---|
| `tool_name` | string | yes | Name of the tool being invoked |
| `parameters` | object | yes | Tool parameters as key-value pairs |
| `status` | enum | yes | One of: `pending`, `approved`, `rejected`, `success`, `error` |

**State transitions:**
```
pending → approved → success
pending → approved → error
pending → rejected
```

### ToolResult

Output from a completed tool execution.

| Field | Type | Required | Description |
|---|---|---|---|
| `tool_name` | string | yes | Name of the tool that was invoked |
| `success` | boolean | yes | Whether the tool execution succeeded |
| `result` | string \| object | yes | Tool output (string for most tools, structured for some) |
| `error` | string \| null | no | Error message if execution failed |
| `duration_ms` | number | no | Execution time in milliseconds |

### Checkpoint

A snapshot of a single note's content at a point in time, captured before a write operation.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique checkpoint identifier (UUID v4) |
| `conversation_id` | string | yes | Conversation that triggered the checkpoint |
| `note_path` | string | yes | Vault-relative path of the snapshotted note |
| `content` | string | yes | Full note content at snapshot time (including frontmatter) |
| `timestamp` | string (ISO 8601) | yes | When the snapshot was taken |
| `description` | string | yes | Human-readable description (e.g., "Before replace_in_note on Daily/2026-03-01.md") |
| `tool_name` | string | yes | The write tool that triggered this checkpoint |
| `message_id` | string | yes | The message ID of the tool call that triggered this checkpoint |

**Persistence:** Stored as JSON files in the checkpoints directory (default: `.obsidian/plugins/notor/checkpoints/`). Organized by conversation: `{conversation_id}/{checkpoint_id}.json`.

**Retention policy:**
- Default max: 100 checkpoints per conversation
- Default max age: 30 days
- Both limits are user-configurable in settings
- Oldest checkpoints are pruned first when limits are exceeded

**Operations:**
- **Preview:** Read checkpoint content without restoring
- **Restore:** Replace the note's current content with the checkpoint content (creating a new checkpoint of the current state first)
- **Compare:** Diff the checkpoint content against the note's current content

### LLMProviderConfig

Configuration for a single LLM provider connection.

| Field | Type | Required | Description |
|---|---|---|---|
| `type` | enum | yes | Provider type: `local`, `bedrock`, `anthropic`, `openai` |
| `enabled` | boolean | yes | Whether this provider is configured and available |
| `display_name` | string | yes | User-facing label |
| `endpoint` | string \| null | no | Custom endpoint URL (required for `local`, optional for `openai`) |
| `region` | string \| null | no | AWS region (for `bedrock` only) |
| `aws_profile` | string \| null | no | AWS profile name (for `bedrock` with profile auth) |
| `aws_auth_method` | `"profile"` \| `"keys"` \| null | no | AWS authentication method (for `bedrock` only) |
| `model_id` | string \| null | no | Currently selected model ID |
| `model_cache` | ModelInfo[] \| null | no | Cached model list from last fetch |
| `model_cache_timestamp` | string (ISO 8601) \| null | no | When the model list was last fetched |

**Note:** Credentials (API keys, AWS access keys) are stored in Obsidian's secrets manager, NOT in this config object. The config references credentials by provider type; the secrets manager holds the actual secret values.

**Default provider configurations:**

| Provider | Default Endpoint | Default Auth |
|---|---|---|
| `local` | `http://localhost:11434/v1` | None (optional API key) |
| `bedrock` | N/A (AWS SDK) | AWS profile (`default`) |
| `anthropic` | `https://api.anthropic.com` | API key (secrets manager) |
| `openai` | `https://api.openai.com` | API key (secrets manager) |

### ModelInfo

Cached information about a model available from a provider.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Model identifier (as used in API calls) |
| `display_name` | string | yes | Human-readable model name |
| `context_window` | number \| null | no | Maximum context window in tokens |
| `input_price_per_1k` | number \| null | no | Cost per 1K input tokens |
| `output_price_per_1k` | number \| null | no | Cost per 1K output tokens |
| `provider` | string \| null | no | Model provider name (useful for Bedrock which hosts multiple providers) |

### VaultRule

A Markdown file under `{notor_dir}/rules/` with trigger conditions for context injection.

| Field | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Vault-relative path to the rule file |
| `always_include` | boolean | no | If true, always inject this rule (from `notor-always-include` frontmatter) |
| `directory_include` | string \| null | no | Directory path trigger (from `notor-directory-include` frontmatter) |
| `tag_include` | string \| null | no | Tag trigger (from `notor-tag-include` frontmatter) |
| `content` | string | yes | Rule body content (frontmatter stripped) to inject into system prompt |

**Trigger evaluation:** After each tool call that accesses a note, the plugin re-evaluates all rules against the set of notes accessed in the current conversation. Multiple trigger properties on the same rule use OR logic — any matching trigger causes inclusion.

**Note:** VaultRule is not persisted as structured data. The rules are Markdown files read and parsed at runtime from `{notor_dir}/rules/`. The structured representation above describes the in-memory model.

---

## Plugin Settings

Settings are persisted via Obsidian's `loadData`/`saveData` mechanism.

| Setting | Type | Default | Description |
|---|---|---|---|
| `notor_dir` | string | `"notor/"` | Vault-relative path for Notor-managed files |
| `active_provider` | string | `"local"` | Currently active provider type |
| `providers` | LLMProviderConfig[] | (see defaults above) | Per-provider configurations |
| `auto_approve` | Record<string, boolean> | (see below) | Per-tool auto-approve settings |
| `mode` | `"plan"` \| `"act"` | `"plan"` | Current Plan/Act mode |
| `open_notes_on_access` | boolean | `true` | Open notes in editor when AI reads/modifies them |
| `history_path` | string | `".obsidian/plugins/notor/history/"` | Chat history storage path |
| `history_max_size_mb` | number | `500` | Max total history size in MB |
| `history_max_age_days` | number | `90` | Max history age in days |
| `checkpoint_path` | string | `".obsidian/plugins/notor/checkpoints/"` | Checkpoint storage path |
| `checkpoint_max_per_conversation` | number | `100` | Max checkpoints per conversation |
| `checkpoint_max_age_days` | number | `30` | Max checkpoint age in days |
| `model_pricing` | Record<string, { input: number, output: number }> | `{}` | Per-model pricing (per 1K tokens) |

**Auto-approve defaults:**

| Tool | Default Auto-Approve |
|---|---|
| `read_note` | `true` |
| `search_vault` | `true` |
| `list_vault` | `true` |
| `read_frontmatter` | `true` |
| `write_note` | `false` |
| `replace_in_note` | `false` |
| `update_frontmatter` | `false` |
| `manage_tags` | `false` |

---

## JSONL Message Schema

Each line in a conversation JSONL file is a JSON object with the following structure:

```jsonc
// System message
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"system","content":"You are a helpful...","timestamp":"2026-06-03T18:00:00Z"}

// User message
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"user","content":"Rewrite the intro of Research/Climate.md","timestamp":"2026-06-03T18:00:01Z"}

// Tool call
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"tool_call","content":"","timestamp":"2026-06-03T18:00:02Z","tool_call":{"tool_name":"read_note","parameters":{"path":"Research/Climate.md","include_frontmatter":false},"status":"success"}}

// Tool result
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"tool_result","content":"","timestamp":"2026-06-03T18:00:03Z","tool_result":{"tool_name":"read_note","success":true,"result":"# Climate Research\n\nThe introduction...","duration_ms":12}}

// Assistant message
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"assistant","content":"I've read the note. Here's a more concise introduction...","timestamp":"2026-06-03T18:00:05Z","input_tokens":1520,"output_tokens":340,"cost_estimate":0.0023}
```

---

## Stale Content Check

Before applying any write tool (`write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`), the plugin compares the note's current content against the content the AI last read via `read_note`. This requires tracking the last-read content per note path within a conversation.

| Field | Type | Description |
|---|---|---|
| `note_path` | string | Vault-relative path |
| `last_read_content` | string | Full content as returned by the last `read_note` call |
| `last_read_timestamp` | string (ISO 8601) | When the content was last read |

This data is held in memory per conversation (not persisted). If the note's current content differs from `last_read_content`, the write operation fails with a stale-content error and the AI is instructed to re-read the note.