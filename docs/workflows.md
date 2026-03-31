# Workflows

Workflows are reusable instruction sets stored as Obsidian notes that guide the AI through structured, step-by-step processes.

## Defining a workflow

Workflow notes are stored under `notor/workflows/` and identified by `notor-workflow: true` in their frontmatter. Workflow bodies are written as step-by-step instructions that shape *how the AI approaches a task* — not as conversational prompts.

**Frontmatter properties:**

| Property | Values | Description |
|---|---|---|
| `notor-workflow` | `true` (required) | Marks this note as a workflow. |
| `notor-trigger` | `manual` or a vault event type | How the workflow is triggered. See [Vault event hooks](hooks.md#vault-event-hooks) for event types. |
| `notor-workflow-persona` | `"{persona-name}"` | Automatically activates a persona when the workflow runs. Persists for the entire workflow conversation. |
| `notor-hooks` | YAML mapping | Per-workflow hook overrides. Overrides global LLM lifecycle hooks for this workflow's duration. Non-overridden events continue using global hooks. |

Subdirectories under `notor/workflows/` are supported. The plugin rescans workflows on plugin load and when the workflow list is opened.

Workflows can also be created from **Settings → Notor → Rules & Workflows** using the **Create** button, which prompts for a name and trigger type and generates a skeleton file with the appropriate frontmatter.

## Running a workflow manually

**From the command palette:** The **Notor: Run workflow** command opens a quick-pick list of all discovered workflows. Selecting one assembles the workflow prompt, resolves any [`<include_note>`](include-note.md) tags, and sends it to the LLM as a new conversation in the chat panel with full transparency: streaming responses, inline tool calls, diff previews, and approval prompts all work as normal.

**Via slash-command attachment:** Type `/` at the start of the Notor chat input to open a fuzzy-search autocomplete list of workflows. Selecting one inserts a chip in the input area (like a note attachment). You can type additional context alongside the chip. At most one workflow can be attached per message.

## Workflow aliases

Workflows support the standard Obsidian `aliases` frontmatter property (a single string or a YAML array). When using the `/` slash-command in chat, fuzzy search matches against both the workflow's display name and its aliases. When matched via an alias, the suggestion displays the alias in parentheses — e.g., `Daily Review (dr)`.

This lets you invoke workflows with short abbreviations:

```yaml
---
notor-workflow: true
notor-trigger: manual
aliases: [dr, review]
---
```

## Workflow instructions rendering

The `<workflow_instructions>` block injected into the conversation is rendered as a collapsed `<details>` element in the chat panel (labeled "Workflow: {name}") so it doesn't dominate the view. Click to expand and inspect the full instructions.

## Event-triggered workflows

Set `notor-trigger` in the frontmatter to one of the vault event types (see [Vault event hooks](hooks.md#vault-event-hooks)) to run the workflow automatically in response to vault events. Event-triggered workflows run in the background without interrupting the current conversation.

## Workflow activity indicator

A persistent indicator in the chat panel header shows the status of background workflow executions:

- Displays an animated state when workflows are running
- Shows a numeric badge for the count of active executions
- A dropdown lists currently running and recently completed workflows with their status (running, waiting for approval, succeeded, errored)
- Click any entry to open that workflow's conversation
- A configurable number of recent entries are shown (default: 5, configurable in **Settings → Notor**)

## Concurrency limit

A configurable cap (default: 3) limits simultaneous background workflow executions. Additional triggered workflows are queued FIFO and execute as slots become available. Manually triggered workflows are not counted against this limit.

## Loop prevention

If a hook-triggered workflow would re-trigger the same hook (e.g., an `on-tag-change` hook runs a workflow that adds tags), the cycle is detected and the re-trigger is skipped with a notice.

## Notes

- Workflows are regular Obsidian notes — visible, searchable, and editable.
- Use [`<include_note>`](include-note.md) tags in workflow bodies to dynamically inject vault content at execution time.
- Tool availability can be customized per-workflow using `<notor_tool_config>` blocks. See [Per-context tool configuration](vault-tools.md#per-context-tool-configuration) for syntax and precedence.
