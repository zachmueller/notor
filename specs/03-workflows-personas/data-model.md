# Data Model: Phase 4 — Workflows & Personas

**Created:** 2026-08-03
**Plan:** [specs/03-workflows-personas/plan.md](plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](spec.md)

This document defines the new data entities, extensions to existing entities, and state transitions introduced in Phase 4. It extends the data models defined in [specs/01-mvp/data-model.md](../01-mvp/data-model.md) and [specs/02-context-intelligence/data-model.md](../02-context-intelligence/data-model.md).

---

## Entity Relationship Overview

```
┌─────────────┐       1:N       ┌─────────────┐
│   Persona   │───────────────▶│PersonaAuto  │
│             │                 │ApproveConfig│
└──────┬──────┘                 └─────────────┘
       │ 0..1:N
       ▼
┌─────────────┐       0..1:1    ┌─────────────┐
│ Conversation│◀────────────────│  Workflow   │
└──────┬──────┘                 └──────┬──────┘
       │                               │ 0:N
       │                               ▼
       │                        ┌──────────────┐
       │                        │WorkflowScoped│
       │                        │    Hook      │
       │                        └──────────────┘
       │
       │ 0:N
       ▼
┌──────────────┐
│  Workflow    │
│  Execution   │
└──────────────┘

┌──────────────────┐       1:N       ┌──────────────┐
│VaultEventHookType│───────────────▶│VaultEventHook│
│    (enum)        │                 │  (config)    │
└──────────────────┘                 └──────────────┘

┌──────────────┐
│IncludeNoteTag│  (parsed at resolution time, not persisted)
└──────────────┘

┌──────────────┐
│TriggerContext│  (ephemeral, assembled at execution time)
└──────────────┘
```

---

## New Entities

<!-- SECTION: Persona -->

### Persona

An in-memory representation of a discovered persona, loaded from a directory under `{notor_dir}/personas/`.

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Persona name, derived from subdirectory name (e.g., `researcher`) |
| `directory_path` | string | yes | Vault-relative path to the persona directory (e.g., `notor/personas/researcher/`) |
| `system_prompt_path` | string | yes | Vault-relative path to `system-prompt.md` (e.g., `notor/personas/researcher/system-prompt.md`) |
| `prompt_content` | string | yes | Body content of `system-prompt.md` after stripping frontmatter — the persona's system prompt text |
| `prompt_mode` | `"append"` \| `"replace"` | yes | How the persona prompt relates to the global system prompt. Default: `"append"` |
| `preferred_provider` | string \| null | no | Override LLM provider identifier (empty/null = use global default) |
| `preferred_model` | string \| null | no | Override model identifier (empty/null = use global default) |

**Not persisted as structured data.** Personas are discovered at runtime by scanning the persona directory. The structured representation above describes the in-memory model.

**Discovery rules:**
- Scan `{notor_dir}/personas/` for subdirectories containing a `system-prompt.md` file.
- Subdirectories without `system-prompt.md` are silently ignored.
- Persona name is the subdirectory name (e.g., `{notor_dir}/personas/researcher/` → name: `"researcher"`).
- Frontmatter properties are read from `system-prompt.md` via `metadataCache.getFileCache()?.frontmatter`.
- If `notor-persona-prompt-mode` contains an unrecognized value, treat as `"append"` and log a warning.
- If `notor-preferred-provider` or `notor-preferred-model` are empty strings or omitted, the fields are null (fall back to global defaults).
- Rescan triggers: settings panel opened, persona picker activated in chat panel.

**Frontmatter schema:**
```yaml
---
notor-persona-prompt-mode: "append"    # "append" (default) or "replace"
notor-preferred-provider: ""           # Provider identifier string
notor-preferred-model: ""              # Model identifier string
---
```

**Validation rules:**
- `name` must be non-empty and match the subdirectory name.
- `system_prompt_path` must point to an existing file.
- `prompt_mode` must be `"append"` or `"replace"`; invalid values default to `"append"`.
- `prompt_content` may be empty (persona has no custom system prompt text).

---

<!-- SECTION: PersonaAutoApproveConfig -->

### PersonaAutoApproveConfig

Per-persona per-tool auto-approve override settings. Stored in plugin settings data, not in persona frontmatter.

| Field | Type | Required | Description |
|---|---|---|---|
| `persona_name` | string | yes | Name of the persona these overrides apply to |
| `overrides` | Record<string, AutoApproveState> | yes | Map of tool name → override state |

**AutoApproveState enum:** `"global"` | `"approve"` | `"deny"`

| State | Behavior |
|---|---|
| `"global"` | No override; the global auto-approve setting for this tool applies. This is the default. |
| `"approve"` | Tool is auto-approved when this persona is active. |
| `"deny"` | Tool requires manual approval when this persona is active. |

**Persistence:** Stored in plugin settings as `persona_auto_approve: Record<string, Record<string, string>>`, keyed by persona name then tool name.

**Settings structure:**
```typescript
// In NotorSettings
persona_auto_approve: {
  "researcher": {
    "write_note": "deny",
    "search_vault": "approve"
    // Tools not listed default to "global"
  },
  "organizer": {
    "write_note": "approve",
    "replace_in_note": "approve",
    "manage_tags": "approve"
  }
}
```

**Resolution logic:**
1. If no persona is active → use global auto-approve settings only.
2. If a persona is active → check `persona_auto_approve[persona_name][tool_name]`:
   - `"approve"` → auto-approve the tool call.
   - `"deny"` → require manual approval.
   - `"global"` or not present → fall back to global `auto_approve[tool_name]`.
3. Regardless of persona overrides, write tools remain blocked in Plan mode.

**Stale tool handling:** If a stored override references a tool name that no longer exists in the tool registry, the settings UI displays a warning indicator. The stale entry is ignored at runtime.

---

<!-- SECTION: Workflow -->

### Workflow

An in-memory representation of a discovered workflow note.

| Field | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Vault-relative path to the workflow note (e.g., `notor/workflows/daily/review.md`) |
| `file_name` | string | yes | File name of the workflow note (e.g., `review.md`) |
| `display_name` | string | yes | Human-readable name derived from the file name without extension (e.g., `review`), or subdirectory-qualified (e.g., `daily/review`) |
| `trigger` | WorkflowTrigger | yes | Trigger type from `notor-trigger` frontmatter |
| `schedule` | string \| null | no | Cron expression from `notor-schedule` (required if trigger is `scheduled`) |
| `persona_name` | string \| null | no | Persona to activate from `notor-workflow-persona` (null = use current persona) |
| `hooks` | WorkflowHookConfig \| null | no | Per-workflow LLM lifecycle hook overrides from `notor-hooks` |
| `body_content` | string | yes | Body content of the workflow note after stripping frontmatter — the workflow instructions |

**WorkflowTrigger enum:** `"manual"` | `"on-note-open"` | `"on-note-create"` | `"on-save"` | `"on-manual-save"` | `"on-tag-change"` | `"scheduled"`

**Not persisted as structured data.** Workflows are discovered at runtime by scanning the workflows directory. The structured representation describes the in-memory model.

**Discovery rules:**
- Scan `{notor_dir}/workflows/` recursively for Markdown notes.
- A note is a workflow if its frontmatter contains `notor-workflow: true`.
- Notes without `notor-workflow: true` are silently ignored.
- If `notor-workflow: true` is present but `notor-trigger` is missing → log warning, exclude from workflow list.
- If `notor-trigger` contains an unrecognized value → log warning, exclude from workflow list.
- If trigger is `"scheduled"` and `notor-schedule` is missing or invalid → log warning, exclude from scheduled execution (but may still be triggered manually).
- Rescan triggers: plugin load, command palette workflow list opened.

**Frontmatter schema:**
```yaml
---
notor-workflow: true
notor-trigger: manual
notor-schedule: "0 9 * * *"
notor-workflow-persona: "researcher"
notor-hooks:
  pre-send:
    - action: execute_command
      command: "echo 'Starting'"
  after-completion:
    - action: run_workflow
      path: "cleanup/post-review.md"
---
```

**Validation rules:**
- `notor-workflow` must be `true` (boolean).
- `notor-trigger` must be one of the valid WorkflowTrigger values.
- `notor-schedule` must be a valid cron expression when trigger is `"scheduled"`.
- `notor-workflow-persona` must be a non-empty string or omitted.
- `notor-hooks` must be a valid YAML mapping if present (see WorkflowScopedHook below).

---

<!-- SECTION: IncludeNoteTag -->

### IncludeNoteTag

A parsed representation of a single `<include_note ... />` tag, extracted from workflow bodies, system prompts, or vault rule files at resolution time.

| Field | Type | Required | Description |
|---|---|---|---|
| `raw_tag` | string | yes | The full original tag text as found in the source (for replacement) |
| `path` | string | yes | The `path` attribute value — vault-relative path or wikilink |
| `path_type` | `"vault_relative"` \| `"wikilink"` | yes | Whether the path is a vault-relative path or a wikilink |
| `section` | string \| null | no | The `section` attribute value — heading to extract (null = full note) |
| `mode` | `"inline"` \| `"attached"` | yes | Injection mode. Default: `"inline"` |
| `strip_frontmatter` | boolean | yes | Whether to strip YAML frontmatter before injection. Default: `true` |

**Not persisted.** Tags are parsed and resolved at execution time. The structured representation describes the intermediate parsed form before resolution.

**Tag syntax:**
```xml
<!-- Vault-relative path -->
<include_note path="Research/Topic A.md" section="Summary" mode="inline" strip_frontmatter="true" />

<!-- Wikilink (recommended) -->
<include_note path="[[Topic A]]" section="Summary" mode="inline" />
```

**Parsing rules:**
- Regex pattern: `<include_note\s+([^>]*?)\s*\/>`
- Extract attributes from the captured group using attribute regex: `(\w+)\s*=\s*"([^"]*)"`
- `path` is required; missing `path` → tag is left as-is (not resolved).
- `section` defaults to null (include full note).
- `mode` defaults to `"inline"`. Unrecognized values default to `"inline"`.
- `strip_frontmatter` defaults to `true`. Must be string `"true"` or `"false"`.
- Attributes not in the supported set (`path`, `section`, `mode`, `strip_frontmatter`) are silently ignored.

**Path resolution:**
- **Vault-relative:** Path does not contain `[[` → resolve via `vault.getAbstractFileByPath(path)`.
- **Wikilink:** Path contains `[[` → strip brackets, resolve via `metadataCache.getFirstLinkpathDest(linkPath, sourceFilePath)`.
- If resolution fails → replace tag with error marker: `[include_note error: note '{path}' not found]`.

**Section extraction:**
- If `section` is specified → find heading in `metadataCache.getFileCache(file)?.headings` matching `section` text.
- Extract content from that heading to the next heading of equal or higher level (or end of file).
- If heading not found → replace tag with error marker: `[include_note error: section '{section}' not found in '{path}']`.

**Context-specific behavior:**
- **Workflow notes:** Both `inline` and `attached` modes supported.
- **System prompts and vault rule files:** Always `inline` mode regardless of `mode` attribute.

**Nested resolution:** Not supported. If included content itself contains `<include_note>` tags, they are passed through as literal text.

---

<!-- SECTION: VaultEventHook -->

### VaultEventHook

A configured callback tied to a vault lifecycle event. Extends the Phase 3 Hook entity with vault-specific event types and the "run a workflow" action type.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique hook identifier (UUID v4) |
| `event` | VaultEventHookType | yes | Vault event this hook fires on |
| `action_type` | `"execute_command"` \| `"run_workflow"` | yes | Action to perform when the hook fires |
| `command` | string \| null | no | Shell command to execute (required when `action_type` is `"execute_command"`) |
| `workflow_path` | string \| null | no | Vault-relative path to workflow under `{notor_dir}/workflows/` (required when `action_type` is `"run_workflow"`) |
| `label` | string | no | Optional user-friendly description |
| `enabled` | boolean | yes | Whether this hook is active (default: true) |
| `schedule` | string \| null | no | Cron expression (required when `event` is `on_schedule`) |

**VaultEventHookType enum:** `"on_note_open"` | `"on_note_create"` | `"on_save"` | `"on_manual_save"` | `"on_tag_change"` | `"on_schedule"`

**Persistence:** Stored in plugin settings as ordered lists grouped by event type.

**Settings structure:**
```typescript
interface VaultEventHookConfig {
  on_note_open: VaultEventHook[];
  on_note_create: VaultEventHook[];
  on_save: VaultEventHook[];
  on_manual_save: VaultEventHook[];
  on_tag_change: VaultEventHook[];
  on_schedule: VaultEventHook[];
}
```

**Environment variables for shell command actions:**

| Variable | Present For | Description |
|---|---|---|
| `NOTOR_HOOK_EVENT` | All events | Event name (e.g., `on_note_open`, `on_save`) |
| `NOTOR_TIMESTAMP` | All events | UTC timestamp (ISO 8601) |
| `NOTOR_NOTE_PATH` | Note-related events | Vault-relative path of the affected note |
| `NOTOR_TAGS_ADDED` | `on_tag_change` | Comma-separated list of added tags |
| `NOTOR_TAGS_REMOVED` | `on_tag_change` | Comma-separated list of removed tags |

**Timeout behavior:**
- `"execute_command"` actions: subject to global hook timeout (default: 10 seconds).
- `"run_workflow"` actions: exempt from hook timeout — workflow completes when the LLM conversation finishes, fails, or is stopped by the user.

---

<!-- SECTION: WorkflowScopedHook -->

### WorkflowScopedHook

A per-workflow LLM lifecycle hook override defined in a workflow note's `notor-hooks` frontmatter property. Overrides global hooks for the corresponding lifecycle event during the workflow's execution.

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | LLMHookEvent | yes | Lifecycle event: `pre_send`, `on_tool_call`, `on_tool_result`, `after_completion` |
| `action_type` | `"execute_command"` \| `"run_workflow"` | yes | Action to perform |
| `command` | string \| null | no | Shell command (for `execute_command` action) |
| `workflow_path` | string \| null | no | Workflow path (for `run_workflow` action) |

**LLMHookEvent enum:** `"pre_send"` | `"on_tool_call"` | `"on_tool_result"` | `"after_completion"`

**Not persisted as a separate entity.** Parsed from workflow frontmatter at discovery time and stored as part of the Workflow entity.

**WorkflowHookConfig structure:**
```typescript
interface WorkflowHookConfig {
  pre_send?: WorkflowScopedHook[];
  on_tool_call?: WorkflowScopedHook[];
  on_tool_result?: WorkflowScopedHook[];
  after_completion?: WorkflowScopedHook[];
}
```

**Override semantics:**
- When a workflow with `notor-hooks` is executing, the workflow-scoped hooks **replace** global hooks for the specified lifecycle events.
- Global hooks for events not overridden by the workflow continue to apply.
- When the workflow ends, hook configuration reverts to global settings.

**Validation rules:**
- `action_type` must be `"execute_command"` or `"run_workflow"`.
- `command` is required when `action_type` is `"execute_command"`.
- `workflow_path` is required when `action_type` is `"run_workflow"`.
- Invalid hook definitions are logged as warnings and skipped; valid hooks in the same configuration still apply.

---

<!-- SECTION: TriggerContext -->

### TriggerContext

Structured event metadata automatically prepended to event-triggered workflow prompts. Provides the AI with information about the triggering event.

| Field | Type | Required | Description |
|---|---|---|---|
| `event` | string | yes | Event type that triggered the workflow (e.g., `on-save`, `on-note-open`) |
| `note_path` | string \| null | no | Vault-relative path of the affected note (null for `scheduled` events) |
| `tags_added` | string[] \| null | no | Tags added (only for `on-tag-change` events) |
| `tags_removed` | string[] \| null | no | Tags removed (only for `on-tag-change` events) |

**Not persisted.** Assembled at execution time and injected into the user message.

**XML format:**
```xml
<trigger_context>
event: on-save
note_path: Research/Climate.md
</trigger_context>
```

For `on-tag-change`:
```xml
<trigger_context>
event: on-tag-change
note_path: Research/Climate.md
tags_added: review-needed, important
tags_removed: draft
</trigger_context>
```

For `scheduled`:
```xml
<trigger_context>
event: scheduled
</trigger_context>
```

**Injection rules:**
- Prepended before `<workflow_instructions>` in the assembled user message.
- Only present for event-triggered workflows. Manually triggered workflows have no `<trigger_context>` block.

---

<!-- SECTION: WorkflowExecution -->

### WorkflowExecution

Tracks the state of a background workflow execution (event-triggered). Used by the concurrency manager and the workflow activity indicator.

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique execution identifier (UUID v4) |
| `workflow_path` | string | yes | Vault-relative path of the executing workflow |
| `workflow_name` | string | yes | Display name of the workflow |
| `conversation_id` | string | yes | ID of the conversation created for this execution |
| `trigger_event` | string | yes | Event type that triggered this execution (e.g., `on-save`) |
| `trigger_source` | string | no | Human-readable trigger description (e.g., `on-save: Research/Climate.md`) |
| `status` | WorkflowExecutionStatus | yes | Current execution status |
| `started_at` | string (ISO 8601) | yes | When the execution started |
| `completed_at` | string (ISO 8601) \| null | no | When the execution completed (null while running) |
| `error_message` | string \| null | no | Error description if execution failed |

**WorkflowExecutionStatus enum:** `"queued"` | `"running"` | `"waiting_approval"` | `"completed"` | `"errored"` | `"stopped"`

**Not persisted.** Held in memory by the workflow execution manager. State is lost on plugin reload (running workflows terminate on unload).

**State transitions:**
```
queued → running → completed
queued → running → errored
queued → running → stopped
queued → running → waiting_approval → running → completed
queued → running → waiting_approval → running → errored
queued → running → waiting_approval → stopped
```

**Concurrency rules:**
- Maximum `workflow_concurrency_limit` (default: 3) executions can be in `running` or `waiting_approval` status simultaneously.
- Additional triggered workflows enter `queued` status and execute FIFO as slots become available.
- Manually triggered workflows (command palette, slash-command) are not counted against this limit.
- Only one instance of a given workflow can execute at a time. Duplicate invocations are skipped with a notice.

---

## Extensions to Existing Entities

### Conversation (extended)

The Conversation entity from the MVP and Phase 3 data models is extended with:

| Field | Type | Required | Description |
|---|---|---|---|
| `workflow_path` | string \| null | no | Vault-relative path of the workflow that created this conversation (null for ad-hoc conversations) |
| `workflow_name` | string \| null | no | Display name of the workflow (for UI labeling, e.g., "Workflow: Daily review") |
| `persona_name` | string \| null | no | Name of the persona active when this conversation was created (null if no persona) |
| `is_background` | boolean | no | Whether this conversation was created by a background (event-triggered) workflow execution (default: false) |

### Message (extended)

The Message entity is extended with:

| Field | Type | Required | Description |
|---|---|---|---|
| `is_workflow_message` | boolean | no | Whether this message contains `<workflow_instructions>` content (default: false) |

### Hook (extended)

The existing Phase 3 Hook entity (LLM lifecycle hooks) is extended with the "run a workflow" action type:

| Field | Type | Required | Description |
|---|---|---|---|
| `action_type` | `"execute_command"` \| `"run_workflow"` | yes | Action to perform. Default: `"execute_command"` (backward-compatible) |
| `workflow_path` | string \| null | no | Workflow path for `run_workflow` action type |

The existing `command` field continues to hold the shell command for `execute_command` actions.

### Plugin Settings (extended)

New settings fields for Phase 4 (extends the settings model from Phases 1–3):

| Setting | Type | Default | Description |
|---|---|---|---|
| `persona_auto_approve` | Record<string, Record<string, string>> | `{}` | Per-persona per-tool auto-approve overrides. Outer key: persona name. Inner key: tool name. Value: `"global"`, `"approve"`, or `"deny"`. |
| `vault_event_hooks` | VaultEventHookConfig | `{ on_note_open: [], on_note_create: [], on_save: [], on_manual_save: [], on_tag_change: [], on_schedule: [] }` | Vault event hook configurations grouped by event type |
| `vault_event_debounce_seconds` | number | `5` | Debounce cooldown in seconds for vault event hooks (`on-note-open`, `on-save`, `on-manual-save`) |
| `workflow_concurrency_limit` | number | `3` | Maximum simultaneous background workflow executions |
| `workflow_activity_indicator_count` | number | `5` | Number of recent workflow executions shown in the activity indicator |

---

## User Message Assembly (Phase 4 Extensions)

Phase 4 extends the Phase 3 user message assembly with workflow-specific blocks. The updated ordering for a workflow-triggered message:

```
┌─────────────────────────────────────┐
│ 1. <trigger_context> block          │  ← Event metadata (event-triggered only)
│    (if event-triggered workflow)    │
├─────────────────────────────────────┤
│ 2. <auto-context> block             │  ← Ambient workspace signals
│    (if any sources enabled)         │
├─────────────────────────────────────┤
│ 3. <workflow_instructions> block    │  ← Resolved workflow body content
│    (wrapped in XML tag)             │
├─────────────────────────────────────┤
│ 4. User's typed message text        │  ← Supplementary context (if any)
└─────────────────────────────────────┘
```

For non-workflow messages, the existing Phase 3 ordering applies unchanged:
```
<auto-context> → <attachments> → pre-send hook stdout → user text
```

**Example assembled message (event-triggered workflow):**
```xml
<trigger_context>
event: on-save
note_path: Research/Climate.md
</trigger_context>
<auto-context>
  <open-notes>
Research/Climate.md (active)
Daily/2026-08-03.md
  </open-notes>
  <vault-structure>Daily, Projects, Research, Templates</vault-structure>
  <os>macOS</os>
</auto-context>
<workflow_instructions type="auto-tag.md">
# Auto-tag workflow

Read the note that triggered this workflow and suggest appropriate tags.

## Step 1: Read the note
Read the note at the path provided in the trigger context.

## Step 2: Analyze content
Identify key themes, topics, and categories in the note content.

## Step 3: Suggest and apply tags
Add relevant tags to the note's frontmatter using the manage_tags tool.
</workflow_instructions>
```

**Example assembled message (manual workflow with user text):**
```xml
<auto-context>
  <open-notes>
Research/Climate.md (active)
  </open-notes>
  <os>macOS</os>
</auto-context>
<workflow_instructions type="daily-review.md">
# Daily note review

Review today's daily notes and create a summary.

## Step 1: Find today's notes
Search for notes created or modified today in the Daily/ folder.

## Step 2: Create summary
Write a summary note with key themes and action items.
</workflow_instructions>
Focus on notes related to the climate research project.
```

---

## System Prompt Assembly (Phase 4 Extensions)

Phase 4 extends the system prompt assembly pipeline with persona support and `<include_note>` resolution:

```
1. Global system prompt
   ├── If {notor_dir}/prompts/core-system-prompt.md exists → use its body
   └── Otherwise → use built-in default
   └── Resolve <include_note> tags in the prompt content

2. Persona system prompt (if persona active)
   ├── If prompt_mode is "append" → append persona prompt after global prompt
   └── If prompt_mode is "replace" → use persona prompt only (skip global)
   └── Resolve <include_note> tags in the persona prompt content

3. Vault-level rule files (always applied, regardless of prompt_mode)
   └── Resolve <include_note> tags in each rule file body

4. Workspace context (<auto-context> section)
   └── Rebuilt from scratch before every LLM API call
```

---

## JSONL Schema Extensions

### Workflow conversation metadata

```jsonc
{"id":"conv-uuid","created_at":"2026-08-03T10:00:00Z","updated_at":"2026-08-03T10:05:00Z","title":"Workflow: Daily review","provider_id":"anthropic","model_id":"claude-sonnet-4-20250514","total_input_tokens":5200,"total_output_tokens":1800,"estimated_cost":0.012,"mode":"act","workflow_path":"notor/workflows/daily/review.md","workflow_name":"daily/review","persona_name":"organizer","is_background":false}
```

### Workflow message with `<workflow_instructions>`

```jsonc
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"user","content":"<workflow_instructions type=\"daily-review.md\">\n# Daily note review\n...\n</workflow_instructions>","timestamp":"2026-08-03T10:00:01Z","is_workflow_message":true}
```

### Event-triggered workflow message with `<trigger_context>`

```jsonc
{"id":"msg-uuid","conversation_id":"conv-uuid","role":"user","content":"<trigger_context>\nevent: on-save\nnote_path: Research/Climate.md\n</trigger_context>\n<workflow_instructions type=\"auto-tag.md\">\n...\n</workflow_instructions>","timestamp":"2026-08-03T10:00:01Z","is_workflow_message":true}
```
