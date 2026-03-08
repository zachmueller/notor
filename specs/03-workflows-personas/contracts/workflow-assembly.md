# Contract: Workflow Prompt Assembly

**Created:** 2026-08-03
**Plan:** [specs/03-workflows-personas/plan.md](../plan.md)
**Specification:** [specs/03-workflows-personas/spec.md](../spec.md) — FR-42, FR-43, FR-44, FR-45

This contract defines how workflow prompts are assembled, wrapped, and injected into conversations — including the `<workflow_instructions>` wrapping format, `<trigger_context>` block, persona switching, and message ordering.

---

## Workflow Prompt Assembly Pipeline

When a workflow is executed (manually or by event trigger), the following pipeline processes the workflow note into a complete user message:

```
1. Read workflow note body (strip frontmatter)
         │
         ▼
2. Resolve <include_note> tags (see include-note-tag.md contract)
         │
         ▼
3. Validate resolved content is non-empty
         │
         ▼
4. Wrap in <workflow_instructions> XML tag
         │
         ▼
5. Prepend <trigger_context> (event-triggered only)
         │
         ▼
6. Apply standard message assembly (auto-context, etc.)
         │
         ▼
7. Append user's supplementary text (if any)
         │
         ▼
8. Send as user message in new conversation
```

---

## Step 1: Read Workflow Note Body

```typescript
const rawContent = await app.vault.read(workflowFile);
const fmInfo = getFrontMatterInfo(rawContent);
const bodyContent = rawContent.slice(fmInfo.contentStart);
```

The body content is everything after the YAML frontmatter block. Frontmatter is always stripped from the workflow body — it contains configuration properties, not prompt content.

---

## Step 2: Resolve `<include_note>` Tags

Apply the `<include_note>` resolution algorithm defined in [include-note-tag.md](include-note-tag.md):

- All `<include_note ... />` tags in the body are resolved.
- `inline` mode: content replaces the tag in-place.
- `attached` mode: content is collected into a separate `<attachments>` block.
- Resolution errors produce inline error markers.
- Nested `<include_note>` tags in resolved content are not recursively resolved.

The `sourceFilePath` for wikilink resolution is the workflow note's own vault-relative path.

---

## Step 3: Validate Non-Empty Content

After resolution, check that the resolved body is non-empty (not just whitespace):

```typescript
const resolvedBody = resolveIncludeNoteTags(bodyContent, workflowFile.path);
if (resolvedBody.textContent.trim().length === 0) {
  // Abort execution
  new Notice("Workflow has no prompt content.");
  return;
}
```

If the workflow body is empty after stripping frontmatter and resolving tags, the workflow execution is aborted with a notice.

---

## Step 4: `<workflow_instructions>` Wrapping

The resolved body content is wrapped in a `<workflow_instructions>` XML tag:

```xml
<workflow_instructions type="{workflow-file-name}">
{resolved workflow body content}
</workflow_instructions>
```

**Format rules:**
- The `type` attribute contains the workflow note's **file name** (e.g., `daily-review.md`), not the full path. This is for identification and debugging.
- The opening tag, content, and closing tag are on separate lines.
- No additional whitespace is inserted around the content.
- The content is the resolved body as-is (including any inline error markers from `<include_note>` resolution).

**Example:**
```xml
<workflow_instructions type="daily-review.md">
# Daily note review

Review today's daily notes and create a summary.

## Step 1: Find today's notes
Search for notes created or modified today in the Daily/ folder.

## Step 2: Analyze themes
Identify recurring themes, key decisions, and action items across the notes.

## Step 3: Create summary
Write a summary note at Daily/summary.md with sections for:
- Key themes
- Decisions made
- Action items with owners
</workflow_instructions>
```

**Semantic purpose:** This wrapping signals to the AI that the enclosed content is authoritative step-by-step guidance it should follow methodically, rather than a casual user message to respond to conversationally. Modeled after Cline's `<explicit_instructions>` mechanism.

---

## Step 5: `<trigger_context>` Block (Event-Triggered Only)

For event-triggered workflows, a `<trigger_context>` XML block is prepended before the `<workflow_instructions>` tag. This provides structured event metadata so the AI can reference the triggering context.

**Format:**
```xml
<trigger_context>
event: {event-type}
note_path: {vault-relative-path}
</trigger_context>
```

**Per-event fields:**

| Event Type | Fields |
|---|---|
| `on-note-open` | `event`, `note_path` |
| `on-note-create` | `event`, `note_path` |
| `on-save` | `event`, `note_path` |
| `on-manual-save` | `event`, `note_path` |
| `on-tag-change` | `event`, `note_path`, `tags_added`, `tags_removed` |
| `scheduled` | `event` only (no note path) |
| Manual trigger | No `<trigger_context>` block |

**Examples:**

Note-related event:
```xml
<trigger_context>
event: on-save
note_path: Research/Climate.md
</trigger_context>
```

Tag change event:
```xml
<trigger_context>
event: on-tag-change
note_path: Research/Climate.md
tags_added: review-needed, important
tags_removed: draft
</trigger_context>
```

Scheduled event:
```xml
<trigger_context>
event: scheduled
</trigger_context>
```

**Injection rules:**
- The `<trigger_context>` block is placed before the `<workflow_instructions>` block.
- For manually triggered workflows, no `<trigger_context>` block is included.
- Fields use YAML-like `key: value` format (one per line) for readability.
- The `tags_added` and `tags_removed` fields use comma-separated values.

---

## Step 6: Standard Message Assembly

The workflow message follows the standard Phase 3 message assembly pipeline with the `<workflow_instructions>` block in place of the user's typed text:

```
┌─────────────────────────────────────┐
│ 1. <trigger_context>                │  ← Event-triggered only
├─────────────────────────────────────┤
│ 2. <auto-context>                   │  ← Ambient workspace signals (if enabled)
├─────────────────────────────────────┤
│ 3. <attachments>                    │  ← From <include_note mode="attached"> tags
│                                     │     (if any attached-mode includes resolved)
├─────────────────────────────────────┤
│ 4. <workflow_instructions>          │  ← Wrapped workflow body content
├─────────────────────────────────────┤
│ 5. User's supplementary text        │  ← After </workflow_instructions> (if any)
└─────────────────────────────────────┘
```

**Notes:**
- `<auto-context>` follows its existing rules (enabled sources only, omitted if all disabled).
- `<attachments>` appears only if `<include_note>` tags used `mode="attached"`.
- `pre-send` hook stdout is injected between `<attachments>` and `<workflow_instructions>` (following the standard hook injection point).

---

## Step 7: User Supplementary Text

When a workflow is triggered via the slash-command UX in the chat input, the user may type additional text alongside the workflow chip. This text is appended **after** the closing `</workflow_instructions>` tag:

```xml
<workflow_instructions type="daily-review.md">
...workflow steps...
</workflow_instructions>
Focus on notes related to the climate research project and ignore meeting notes.
```

This separation ensures the AI can distinguish between:
- **Workflow instructions** (inside the XML tags) — authoritative steps to follow
- **Supplementary context** (after the closing tag) — additional user guidance

For command-palette-triggered workflows, there is no supplementary text (the workflow instructions are the entire message).

---

## Persona Switching Contract

### Activation

When a workflow note includes `notor-workflow-persona` in frontmatter:

1. **Save current state:** Record the currently active persona name (or "none").
2. **Discover target persona:** Look up the named persona in `{notor_dir}/personas/`.
3. **If found:** Activate the persona — apply system prompt, provider, model preferences, and auto-approve overrides. Surface a notice: "Persona '{name}' activated for workflow."
4. **If not found:** Log a warning. Surface a notice: "Persona '{name}' not found; running with current settings." Continue execution with current persona (or global defaults).

### Persistence During Conversation

- The persona switch persists for the entire conversation started by the workflow.
- The user can continue sending follow-up messages under the workflow's persona.
- The persona does NOT revert after the first LLM response turn.

### Revert

The persona reverts to the saved state when:
- The user switches to a different conversation.
- The user starts a new conversation.
- The user explicitly changes the persona via the picker.

The persona revert occurs regardless of whether the workflow succeeded, failed, or was stopped by the user.

---

## Conversation Creation Contract

### Manual Workflow Execution (Command Palette / Slash-Command)

1. Create a new conversation with metadata:
   - `workflow_path`: vault-relative path to the workflow note
   - `workflow_name`: display name for UI labeling
   - `persona_name`: active persona name (after switching, if applicable)
   - `is_background`: `false`
   - `title`: "Workflow: {display_name}"
2. Open the chat panel (if not already open).
3. Send the assembled workflow message as the first user message.
4. Set `is_workflow_message: true` on the message record.

### Event-Triggered Workflow Execution

1. Create a new conversation with metadata:
   - `workflow_path`, `workflow_name`, `persona_name` (same as above)
   - `is_background`: `true`
   - `title`: "Workflow: {display_name}"
2. Do NOT open or focus the chat panel — execute in background.
3. Send the assembled workflow message as the first user message.
4. Register the execution with the workflow execution manager (for activity indicator).

### Chat UI Rendering

When `<workflow_instructions>` content is rendered in the chat panel:
- The block is displayed as a collapsed-by-default `<details>` element.
- Summary label: "Workflow: {workflow-name}"
- The user can expand it to inspect the full workflow instructions.
- Supplementary user text (after the closing tag) is rendered normally outside the `<details>` element.

---

## Tool Dispatch Updates

### Updated Dispatch Flow (Phase 4)

The dispatch flow from Phase 3 is extended with persona auto-approve resolution:

```
1. Parse tool call from LLM response
2. Look up tool in registry by name
3. IF tool not found → return error to LLM
4. IF mode is "plan" AND tool.mode is "write" → return Plan mode error to LLM
5. IF tool is "fetch_webpage" → check domain denylist
6. IF tool is "execute_command" → validate working directory
7. Resolve auto-approve:
   7a. IF persona is active AND persona has override for this tool:
       - "approve" → auto-approve
       - "deny" → require manual approval
   7b. ELSE → use global auto_approve[tool_name]
8. IF not auto-approved → show approval UI, wait for user response
   8a. IF rejected → return rejection message to LLM
9. Fire on_tool_call hooks (workflow-scoped if applicable)
10. IF tool is write AND note was previously read → stale content check
11. IF tool is write → create checkpoint
12. Execute tool
13. Fire on_tool_result hooks (workflow-scoped if applicable)
14. IF tool is read AND accesses a note → update last-read cache, re-evaluate vault rules
15. Check compaction threshold
16. Return result to LLM
17. Display tool call inline in chat thread
```
