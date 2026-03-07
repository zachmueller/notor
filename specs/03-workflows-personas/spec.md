# Phase 4 — Workflows & personas

**Created:** 2026-08-03
**Status:** Draft
**Branch:** feature/03-workflows-personas

## Overview

Phase 4 introduces structured, reusable AI interactions and configurable AI personalities to Notor. Building on the chat infrastructure, tools, trust mechanisms, and context intelligence from Phases 0–3, this phase adds four interconnected capabilities: a file-based persona system that shapes the AI's behavior and model preferences per use case, a workflow definition system that turns Obsidian notes into reusable prompt templates with dynamic content injection, vault-event hooks that trigger automation in response to note lifecycle changes, and hook configuration via workflow frontmatter that ties Phase 3's LLM lifecycle hooks to specific workflows. Together these features transform Notor from a general-purpose AI chat assistant into a composable automation platform where users define specialized AI behaviors and chain them to vault events — all configured through familiar Obsidian notes and frontmatter.

This specification covers Phase 4 of the roadmap:

- **Basic persona system**: file-based personas stored as Obsidian notes under `{notor_dir}/personas/`, with system prompt customization (append or replace the global prompt), model preferences, and a provider/model identifier reference in Settings for easy configuration.
- **Per-persona auto-approve overrides**: persona-level auto-approve settings managed through a dedicated Settings UI sub-page that override global defaults when a persona is active.
- **Workflow notes**: workflow definitions stored as Obsidian notes under `{notor_dir}/workflows/`, with frontmatter-driven triggers and optional persona assignment.
- **`<include_note>` tag**: dynamic note content injection in workflow bodies, system prompts, and vault-level rule files. Each `<include_note ... />` tag is a self-closing XML-style tag that injects the contents of a single vault note; multiple tags may appear in the same document.
- **Vault event hooks**: hooks tied to vault lifecycle events (`on-note-open`, `on-save`, `on-tag-change`, `on-schedule`) for triggering workflows or shell commands.
- **Hook configuration via workflow frontmatter**: extending Phase 3's settings-only hook system to support per-workflow hook overrides defined in workflow note frontmatter.

## User stories

### Personas

- As a user, I want to create a persona with a custom system prompt so that the AI's behavior is tailored to my specific use case.
- As a user with multiple use cases, I want to switch between personas from the chat panel so that I can quickly adapt the AI's behavior to my current task.
- As a user, I want a persona to optionally override the default LLM provider and model so that I can use a more capable model for complex tasks and a faster model for simple ones.
- As a user, I want a persona to optionally replace the global system prompt entirely so that I can create a clean-slate AI experience for specific use cases without interference from general instructions.
- As a user, I want to edit persona files directly in Obsidian's editor so that I can iterate on the AI's behavior using familiar note-editing tools.
- As a user, I want to easily find the exact string values for providers and models so that I can configure `notor-preferred-provider` and `notor-preferred-model` in persona frontmatter without guessing.

### Per-persona auto-approve overrides

- As a power user, I want a persona to override global auto-approve settings so that my "organizer" persona can auto-approve write operations while my "researcher" persona requires manual approval.
- As a cautious user, I want per-persona auto-approve overrides to fall back to global defaults for tools not explicitly configured on the persona so that I only need to configure the exceptions.

### Workflows

- As a user, I want to define reusable prompt templates as notes in my vault so that I can run the same structured AI interaction repeatedly without retyping.
- As a user, I want a workflow to automatically switch to a specific persona when it runs so that the AI always uses the right behavior and model for that workflow.
- As a user, I want to trigger a workflow manually from the command palette so that I can run it on demand.
- As a user, I want to see workflow execution in the chat panel with full transparency so that I can follow the AI's actions and approve tool calls as usual.
- As a user, I want a workflow to automatically revert the persona selection after it finishes so that my previous persona is restored without manual switching.

### `<include_note>` tag

- As a workflow author, I want to embed the contents of another note into my workflow prompt so that I can compose prompts from reusable building blocks.
- As a workflow author, I want to include only a specific section of a note so that I can inject focused context without pulling in the entire note.
- As a workflow author, I want to reference included notes using `[[wikilink]]` syntax so that if I rename the referenced note, Obsidian automatically updates the link in my workflow just like any other internal link.
- As a user, I want to use `<include_note>` in my custom system prompt so that I can assemble my system prompt from multiple modular notes.
- As a user, I want to use `<include_note>` in vault-level rule files so that rule instructions can reference shared content without duplication.

### Vault event hooks

- As a user, I want a hook that fires when I open a note so that the AI can automatically summarize or check the note for stale content.
- As a user, I want a hook that fires when I save a note so that the AI can auto-tag, update indexes, or lint my content.
- As a user, I want a hook that fires when tags change on a note so that the AI can trigger categorization or organization workflows.
- As a user, I want scheduled hooks that run on a cron schedule so that the AI can perform periodic vault maintenance like daily digests or weekly reviews.
- As a power user, I want vault event hooks to be able to run a workflow so that complex automation chains can be triggered by vault events.

### Hook configuration via workflow frontmatter

- As a workflow author, I want to define LLM lifecycle hooks in my workflow's frontmatter so that hooks are scoped to a specific workflow rather than applying globally.
- As a power user, I want workflow-scoped hooks to override the global hook configuration for the duration of the workflow so that each workflow can customize its automation behavior.

## Functional requirements

### FR-37: Persona discovery and storage

**Description:** The plugin discovers personas by scanning a well-known directory for persona definition files, with each persona defined as an Obsidian note.

**Acceptance criteria:**
- Each persona is stored as a directory under `{notor_dir}/personas/{persona_name}/`.
- A persona is defined by a `system-prompt.md` file within its directory.
- The plugin discovers available personas by scanning `{notor_dir}/personas/` for subdirectories that contain a `system-prompt.md` file. Subdirectories without this file are ignored.
- Persona names are derived from the subdirectory name (e.g., `{notor_dir}/personas/researcher/system-prompt.md` yields the persona name "researcher").
- Persona files are regular Obsidian Markdown notes — fully visible in the file explorer, searchable, and editable in Obsidian's editor.
- The plugin rescans the persona directory when the Notor settings panel is opened and when the persona picker in the chat panel is activated, so newly created or deleted personas are reflected without a plugin reload.
- If `{notor_dir}/personas/` does not exist, the plugin treats the persona list as empty. No error is surfaced; the persona picker simply shows no options.

### FR-38: Persona system prompt and configuration

**Description:** A persona's `system-prompt.md` defines both the persona's system prompt (body content) and behavioral configuration (frontmatter properties).

**Acceptance criteria:**
- The body content of `system-prompt.md` (after stripping frontmatter) is the persona's system prompt text.
- Frontmatter properties configure persona behavior:
  | Property | Type | Default | Description |
  |---|---|---|---|
  | `notor-persona-prompt-mode` | string | `"append"` | Controls how the persona's system prompt relates to the global system prompt. `append`: persona prompt is appended to the global prompt. `replace`: persona prompt replaces the global prompt entirely. |
  | `notor-preferred-provider` | string | `""` | Override the default LLM provider when this persona is active |
  | `notor-preferred-model` | string | `""` | Override the default model when this persona is active |
- When `notor-persona-prompt-mode` is `"append"` (default, also used when the property is omitted), the system prompt is assembled as: global system prompt first, followed by the persona's system prompt appended as a clearly labeled section.
- When `notor-persona-prompt-mode` is `"replace"`, the global system prompt is excluded entirely and only the persona's system prompt is used as the base prompt. Vault-level rule injections (Phase 2) still apply regardless of this setting.
- If `notor-persona-prompt-mode` contains an unrecognized value, the plugin treats it as `"append"` (the default) and logs a warning.
- When `notor-preferred-provider` is set and non-empty, the plugin switches to that provider when the persona is activated. If the provider is not configured or not available, the plugin falls back to the current default provider and surfaces a non-blocking notice.
- When `notor-preferred-model` is set and non-empty, the plugin selects that model within the active provider. If the model is not available, the plugin falls back to the provider's current default model and surfaces a non-blocking notice.
- Settings not explicitly defined in the persona's frontmatter (empty string or omitted) fall back to global defaults.
- The persona's system prompt supports `<include_note>` tags for dynamic note injection (inline mode only — see FR-46).

### FR-39: Persona selection from the chat panel

**Description:** Users can select and switch between personas from the chat panel interface.

**Acceptance criteria:**
- The persona picker is accessible from the chat settings area (gear icon in the panel header), consistent with the existing provider and model selectors.
- The picker displays all discovered personas by name, plus a "None" option to deactivate any persona and revert to global defaults.
- Selecting a persona immediately updates the active system prompt, provider, and model preferences for subsequent messages in the conversation.
- The currently active persona is clearly indicated in the chat panel (e.g., a label or badge showing the persona name near the chat input area).
- Switching personas mid-conversation does not retroactively change earlier messages; it takes effect starting from the next message sent.
- When a persona is deactivated (switched to "None"), all settings revert to global defaults.

### FR-39a: Provider and model identifier reference

**Description:** Users can easily discover the exact string values for LLM providers and models to use in persona frontmatter properties.

**Acceptance criteria:**
- A "Provider & model identifiers" reference section is displayed in **Settings → Notor** (within the persona management area or as a standalone subsection).
- The reference lists each configured provider by its identifier string (the value to use in `notor-preferred-provider`), alongside the provider's display name.
- Under each provider, the reference lists available models by their identifier string (the value to use in `notor-preferred-model`), alongside the model's display name.
- Each identifier string has a "copy" action (e.g., a copy-to-clipboard button or icon) so users can copy it directly and paste it into their persona's frontmatter.
- The reference list updates dynamically: when providers are added/removed or models change, the list reflects the current state without a plugin reload.
- If no providers are configured, the section displays an informational message directing the user to configure providers first.

### FR-40: Per-persona auto-approve overrides

**Description:** Each persona can define per-tool auto-approve settings that override global defaults when the persona is active. Auto-approve overrides are managed through a dedicated Settings UI sub-page rather than frontmatter, due to Obsidian's frontmatter limitations with complex YAML structures.

**Acceptance criteria:**
- Per-persona auto-approve overrides are configured in **Settings → Notor** under a "Persona auto-approve" sub-page (not in persona frontmatter).
- The sub-page discovers all personas by scanning `{notor_dir}/personas/` (same discovery logic as FR-37) and lists them. Newly created or deleted personas are reflected when the settings page is opened or refreshed.
- For each discovered persona, the UI displays the full list of tools (built-in and, when available, custom MCP tools) with a three-state selector per tool:
  - **"Global default"** (inherit): no override; the global auto-approve setting for this tool applies. This is the default state for all tools on all personas.
  - **"Auto-approve"** (override to true): this tool is auto-approved when the persona is active.
  - **"Require approval"** (override to false): this tool requires manual approval when the persona is active.
- When a persona is active, the plugin checks the persona's auto-approve overrides first. If the tool has an explicit override ("Auto-approve" or "Require approval"), the override is used. If the tool is set to "Global default" (or has no entry), the global auto-approve setting applies.
- When no persona is active, only global auto-approve settings apply.
- The auto-approve override applies to all tools (built-in and future custom MCP tools).
- If a persona's stored configuration references a tool name that no longer exists (e.g., an MCP tool was removed), the Settings UI displays a non-blocking warning indicator next to that entry. The user can remove or update the stale entry. Stale entries do not cause errors at runtime — they are simply ignored during auto-approve checks.
- Per-persona auto-approve configuration is stored in Notor's plugin settings data (via `this.saveData()`), keyed by persona name. It does not live in the persona's `system-prompt.md` frontmatter.
- Changes to persona auto-approve settings take effect on the next message dispatch — no plugin reload required.

### FR-41: Workflow note definition and discovery

**Description:** Workflows are defined as Obsidian notes under a well-known directory, identified by frontmatter properties.

**Acceptance criteria:**
- Workflow notes are stored under `{notor_dir}/workflows/` as regular Obsidian Markdown notes.
- A note is recognized as a workflow if its frontmatter contains `notor-workflow: true`.
- Workflow frontmatter properties:
  | Property | Type | Required | Default | Description |
  |---|---|---|---|---|
  | `notor-workflow` | boolean | yes | — | Must be `true` to identify the note as a workflow |
  | `notor-trigger` | string | yes | — | Trigger type: `manual`, `on-note-open`, `on-save`, `on-tag-change`, `scheduled` |
  | `notor-schedule` | string | no | — | Cron expression (required if `notor-trigger` is `scheduled`) |
  | `notor-workflow-persona` | string | no | — | Persona name to automatically switch to when running this workflow |
- The plugin discovers workflows by scanning `{notor_dir}/workflows/` for Markdown notes with `notor-workflow: true` in their frontmatter. Notes without this property are ignored.
- Workflow notes are regular Obsidian notes — visible in the file explorer, searchable, and editable in Obsidian's editor.
- The plugin rescans the workflow directory on plugin load and when the command palette workflow list is opened, so newly created or deleted workflows are reflected without a full plugin reload.
- If `{notor_dir}/workflows/` does not exist, the plugin treats the workflow list as empty. No error is surfaced.
- Workflow notes may be organized in subdirectories under `{notor_dir}/workflows/` (e.g., `{notor_dir}/workflows/daily/review.md`). The plugin scans recursively.
- A workflow note with `notor-workflow: true` but missing a required `notor-trigger` property is treated as invalid; the plugin logs a warning and excludes it from the discovered workflow list.

### FR-42: Manual workflow execution

**Description:** Users can trigger workflows manually from the Obsidian command palette.

**Acceptance criteria:**
- Workflows with `notor-trigger: manual` (or any trigger type) are available for manual execution via the Obsidian command palette.
- A single Obsidian command, "Notor: Run workflow", opens a quick-pick list of all discovered workflows for the user to select from.
- When a workflow is selected, its body content (after stripping frontmatter) is assembled as the prompt — with any `<include_note>` tags resolved — and sent to the LLM.
- The workflow execution appears as a new conversation in the main Notor chat panel, with full transparency: the assembled prompt is shown as the first user message, and all subsequent LLM responses, tool calls, and results are displayed normally.
- If the chat panel is not open, it is opened automatically when a workflow is triggered.
- The user can interact with the workflow conversation normally — sending follow-up messages, approving/rejecting tool calls, stopping the response.
- Workflows with non-manual triggers (e.g., `on-save`, `scheduled`) can still be run manually via this command; the trigger type does not restrict manual execution.

### FR-43: Automatic persona switching via `notor-workflow-persona`

**Description:** Workflows can specify a persona to automatically activate for the duration of the workflow execution.

**Acceptance criteria:**
- When a workflow note includes a `notor-workflow-persona` frontmatter property, the plugin switches to the named persona before executing the workflow prompt.
- The persona switch applies the persona's system prompt, model preferences, and auto-approve settings for the duration of the workflow.
- After the workflow conversation completes (the LLM finishes its response turn, including all tool call cycles), the persona selection reverts to whatever was active before the workflow was triggered. The switch is scoped to the workflow execution, not persistent.
- If the named persona does not exist (the directory or `system-prompt.md` is not found), the workflow runs with the currently active persona (or global defaults) and a non-blocking notice is surfaced: "Persona '{name}' not found; running with current settings."
- If `notor-workflow-persona` is omitted or empty, the workflow runs with whatever persona is currently active (or no persona / global defaults).
- The persona revert occurs regardless of whether the workflow succeeds, fails, or is stopped by the user.
- The persona switch persists for the entire conversation that was started by the workflow. The user can continue sending follow-up messages in the workflow conversation under the workflow's persona. The persona reverts only when the user switches to a different conversation or starts a new one. This supports multi-turn workflows where the persona context matters throughout the full interaction.

### FR-44: Workflow prompt assembly

**Description:** The workflow's body content is assembled into a prompt by resolving dynamic content tags before being sent to the LLM.

**Acceptance criteria:**
- The body content of the workflow note (after stripping frontmatter) serves as the prompt template.
- Any `<include_note>` tags in the body are resolved at execution time (see FR-46).
- The assembled prompt is sent as the user message in a new conversation.
- Static text in the workflow body is included as-is.
- If the workflow body is empty (no text after stripping frontmatter and resolving tags), the workflow execution is aborted and a notice is surfaced: "Workflow has no prompt content."
- The assembled prompt follows the same message structure as a regular user message: auto-context block (if enabled), any resolved `<include_note>` content, then the workflow prompt text.

### FR-45: Event-triggered workflow execution

**Description:** Workflows with event-based triggers are automatically executed when the corresponding vault event fires.

**Acceptance criteria:**
- Workflows with `notor-trigger: on-note-open` execute when a note is opened in the Obsidian editor. The opened note's path is available to the workflow prompt via an environment variable or a built-in template variable.
- Workflows with `notor-trigger: on-save` execute when a note is saved. The saved note's path is available to the workflow prompt.
- Workflows with `notor-trigger: on-tag-change` execute when tags are added to or removed from a note's frontmatter. The affected note's path and the changed tags are available to the workflow prompt.
- Workflows with `notor-trigger: scheduled` execute on the cron schedule defined in `notor-schedule`. If `notor-schedule` is missing or invalid, the workflow is excluded from scheduled execution and a warning is logged.
- Event-triggered workflow execution follows the same prompt assembly and conversation creation flow as manual execution (FR-42, FR-44).
- Multiple workflows can be bound to the same trigger event. When multiple workflows match the same event, they execute sequentially in alphabetical order by workflow file path.
- Event-triggered workflows execute in the background without taking over the main chat panel. The user's current conversation is not interrupted. A workflow activity indicator in the chat panel (see FR-53) signals that background workflows are underway and provides access to their conversations.
- On completion, a non-blocking notice is surfaced (e.g., "Workflow 'daily-review' completed"). The full conversation is accessible via the workflow activity indicator.
- Event-triggered workflows that fail (e.g., LLM error, prompt assembly failure) surface a non-blocking notice. The failure does not prevent other workflows bound to the same event from executing.
- For `on-note-open` and `on-save` triggers, a debounce period (configurable, default: 5 seconds) prevents the same workflow from firing repeatedly for rapid successive events on the same note (e.g., auto-save triggering multiple rapid `on-save` events).

### FR-46: `<include_note>` tag

**Description:** A special self-closing XML-style tag (`<include_note ... />`) that dynamically injects the contents of a vault note (or a section of a note) into the surrounding text at resolution time. Each tag must be written in self-closing form — ending with `/>` — and may appear multiple times in a single document; each occurrence is resolved independently.

**Acceptance criteria:**
- The `<include_note>` tag syntax — two equivalent forms for the `path` attribute:
  ```markdown
  <!-- Vault-relative path (explicit) -->
  <include_note path="Research/Topic A.md" section="Summary" mode="inline" />

  <!-- Wikilink (Obsidian-native, rename-safe) -->
  <include_note path="[[Topic A]]" section="Summary" mode="inline" />
  ```
- Supported attributes (all other attributes are ignored):
  | Attribute | Required | Description |
  |---|---|---|
  | `path` | yes | Reference to the target note. Accepts either a vault-relative file path (e.g., `"Research/Topic A.md"`) or an Obsidian wikilink (e.g., `"[[Topic A]]"` or `"[[Research/Topic A]]"`). See path resolution rules below. |
  | `section` | no | Specific section heading to extract. When specified, only the content from that heading to the next heading of equal or higher level is included. Omit for the full note body. |
  | `mode` | no | `inline` (paste content directly into the surrounding text) or `attached` (include as a separate attached file in context). Default: `inline`. |
- **Path resolution rules:**
  - **Vault-relative path** (e.g., `path="Research/Topic A.md"`): the plugin reads the note at that exact path within the vault. If the note is renamed or moved, the path in the tag is not automatically updated and will break.
  - **Wikilink** (e.g., `path="[[Topic A]]"` or `path="[[Research/Topic A]]"`): the plugin resolves the link using Obsidian's `metadataCache.getFirstLinkpathDest()` API — the same resolution logic Obsidian uses for all internal wikilinks. This means the note is found by name/title without requiring the full path, and Obsidian's built-in link-update mechanism will automatically update the `path` attribute value when the referenced note is renamed or moved (because Obsidian treats the wikilink in the tag as an internal link). **Wikilink syntax is the recommended form** for notes that may be renamed.
  - The `[[wikilink]]` value (including the double brackets) must be the entire content of the `path` attribute string: `path="[[Note Title]]"`.
  - A wikilink may optionally include a subdirectory hint to disambiguate notes with the same name (e.g., `path="[[Research/Topic A]]"`), following standard Obsidian wikilink conventions.
  - If a wikilink resolves to multiple candidate notes (ambiguous note name), the plugin uses Obsidian's default resolution order (same as `getFirstLinkpathDest()`) and does not surface a warning. Authors should use a more specific path to disambiguate if needed.
- Context-specific behavior:
  - **Workflow notes**: both `inline` and `attached` modes are supported. In `attached` mode, the note content is added to the message as an attachment (same format as user-attached notes from FR-24: `<vault-note path="..." section="...">...content...</vault-note>` within an `<attachments>` block).
  - **System prompts** (global and persona) and **vault-level rule files**: only `inline` mode is supported. The `mode` attribute is ignored; content is always inlined directly into the prompt text.
- Tags are resolved at execution time (when the workflow is run, or when the system prompt is assembled before each LLM API call).
- If the referenced note does not exist (path not found or wikilink resolves to nothing), the tag is replaced with an inline error marker: `[include_note error: note 'Research/Topic A.md' not found]`. This error is visible to the LLM in the prompt text.
- If the referenced section heading does not exist within the note, the tag is replaced with an inline error marker: `[include_note error: section 'Summary' not found in 'Research/Topic A.md']`.
- Nested `<include_note>` tags are not supported. If an included note itself contains `<include_note>` tags, those tags are passed through as literal text without resolution. This prevents circular reference loops.
- Multiple `<include_note>` tags can appear in a single document; each occurrence is resolved independently.

### FR-47: Vault event hooks — `on-note-open`

**Description:** A hook that fires when a note is opened in the Obsidian editor.

**Acceptance criteria:**
- The `on-note-open` hook is triggered when a note is opened (activated in the editor — i.e., the user clicks on or switches to a tab).
- The hook receives the opened note's vault-relative file path as context.
- Hook actions available: execute a shell command (Phase 3 action) or run a workflow (Phase 4 action — see FR-51).
- When the action is a shell command, the note path is available as an environment variable (e.g., `NOTOR_NOTE_PATH`), alongside the standard hook metadata variables (conversation UUID if applicable, hook event name, UTC timestamp).
- When the action is "run a workflow", the specified workflow is executed with the triggering note's path available for use in the workflow prompt.
- Multiple hooks can be configured for the `on-note-open` event. They execute sequentially in configuration order.
- Hook execution is non-blocking: failures surface a notice but do not prevent the note from opening or subsequent hooks from executing.
- All vault event hooks share the same global hook timeout (default: 10 seconds, configurable in **Settings → Notor**) established in Phase 3 for LLM interaction hooks.
- Hooks are configured in **Settings → Notor** under a "Vault event hooks" section, grouped by event type (consistent with the Phase 3 LLM interaction hook UI pattern).
- Rapid repeated openings of the same note (e.g., switching tabs quickly) are debounced: a configurable cooldown (default: 5 seconds) prevents the same hook from firing again for the same note path within the cooldown window.

### FR-48: Vault event hooks — `on-save`

**Description:** A hook that fires when a note is saved.

**Acceptance criteria:**
- The `on-save` hook is triggered when a note is saved (either manually by the user or by auto-save).
- The hook receives the saved note's vault-relative file path as context.
- Hook actions available: execute a shell command or run a workflow (FR-51).
- When the action is a shell command, the note path is available as an environment variable (`NOTOR_NOTE_PATH`), alongside standard hook metadata variables.
- Multiple hooks can be configured for the `on-save` event. They execute sequentially in configuration order.
- Hook execution is non-blocking: failures surface a notice but do not block the save operation or prevent subsequent hooks from executing.
- A debounce cooldown (configurable, default: 5 seconds) prevents the same hook from firing repeatedly for rapid successive saves on the same note (e.g., auto-save triggering multiple times in quick succession).
- The `on-save` hook fires after the save operation is complete (the file has been written to disk), not before.

### FR-49: Vault event hooks — `on-tag-change`

**Description:** A hook that fires when tags are added to or removed from a note.

**Acceptance criteria:**
- The `on-tag-change` hook is triggered when the `tags` frontmatter property of a note changes (tags added or removed).
- The hook receives the affected note's vault-relative file path, the tags that were added, and the tags that were removed as context.
- When the action is a shell command, context is available as environment variables: `NOTOR_NOTE_PATH`, `NOTOR_TAGS_ADDED` (comma-separated list), `NOTOR_TAGS_REMOVED` (comma-separated list).
- Hook actions available: execute a shell command or run a workflow (FR-51).
- Multiple hooks can be configured for the `on-tag-change` event. They execute sequentially in configuration order.
- Hook execution is non-blocking: failures surface a notice but do not block the tag change or prevent subsequent hooks from executing.
- The hook fires after the tag change has been persisted to the note's frontmatter, not before.
- Tag changes made by Notor's own tools (`manage_tags`, `update_frontmatter`) also trigger this hook. To prevent infinite loops, hook-initiated tag changes (changes made within a hook's workflow execution) do not re-trigger `on-tag-change` hooks.

### FR-50: Vault event hooks — `on-schedule`

**Description:** A hook that fires on a user-defined cron schedule.

**Acceptance criteria:**
- The `on-schedule` hook fires at intervals defined by a cron expression configured in **Settings → Notor**.
- Each configured `on-schedule` hook has its own cron expression (e.g., `0 9 * * *` for 9 AM daily, `0 */4 * * *` for every 4 hours).
- Hook actions available: execute a shell command or run a workflow (FR-51).
- When the action is a shell command, standard hook metadata variables are available (hook event name, UTC timestamp). There is no note path context for scheduled hooks.
- The cron scheduler runs within the Obsidian process; it does not spawn external cron jobs. Scheduled hooks only fire while Obsidian is running.
- If Obsidian is not running at a scheduled time, the missed execution is skipped — no catch-up execution occurs when Obsidian next starts.
- Invalid cron expressions are caught at configuration time; the hook is saved but marked as inactive with a validation error displayed in the settings UI.
- Multiple hooks can use the same cron expression. They execute sequentially in configuration order when the schedule fires.
- Hook execution is non-blocking: failures surface a notice but do not prevent subsequent scheduled hooks from executing.

### FR-51: "Run a workflow" hook action

**Description:** In addition to the Phase 3 "execute shell command" action, hooks can trigger a named workflow as their action.

**Acceptance criteria:**
- A new hook action type, "run a workflow," is available for all hook events (both LLM interaction hooks from Phase 3 and vault event hooks from Phase 4).
- The action specifies the workflow by its vault-relative path under `{notor_dir}/workflows/` (e.g., `daily/review.md`).
- When the hook fires, the specified workflow is executed following the same flow as manual workflow execution (FR-42): the workflow prompt is assembled, `<include_note>` tags are resolved, and the prompt is sent to the LLM.
- If the specified workflow does not exist or is invalid (missing `notor-workflow: true`), the hook action fails and a non-blocking notice is surfaced.
- Vault event context (note path, changed tags, etc.) is available to the workflow prompt via template variables or environment variables, allowing the workflow to reference the triggering event's context.
- Hook-triggered workflow execution follows the same persona switching behavior as manual execution (FR-43): if the workflow specifies `notor-workflow-persona`, the persona is activated for the workflow's duration.
- To prevent infinite loops, a workflow triggered by a hook cannot re-trigger the same hook. The plugin tracks the execution chain and breaks cycles by skipping hook invocations that would create a loop. A non-blocking notice is surfaced when a loop is detected.

### FR-52: Hook configuration via workflow frontmatter

**Description:** Workflow notes can define LLM lifecycle hooks in their frontmatter that override or extend global hooks for the duration of the workflow execution.

**Acceptance criteria:**
- Workflow notes support a `notor-hooks` frontmatter property for defining per-workflow LLM lifecycle hook overrides.
- The `notor-hooks` property is a YAML mapping of lifecycle event name to an array of hook action definitions. Supported lifecycle events: `pre-send`, `on-tool-call`, `on-tool-result`, `after-completion`.
- Example frontmatter:
  ```yaml
  ---
  notor-workflow: true
  notor-trigger: manual
  notor-hooks:
    pre-send:
      - action: execute_command
        command: "echo 'Starting workflow'"
    after-completion:
      - action: run_workflow
        path: "cleanup/post-review.md"
  ---
  ```
- When a workflow with `notor-hooks` is executing, the workflow-scoped hooks replace the global hooks for the corresponding lifecycle events. Global hooks for events not overridden by the workflow continue to apply.
- Workflow-scoped hooks follow the same execution semantics as global hooks: `pre-send` hooks are fully awaited; `on-tool-call`, `on-tool-result`, and `after-completion` hooks are non-blocking fire-and-forget.
- Workflow-scoped hooks share the same global hook timeout setting.
- When the workflow execution ends (or is stopped), the hook configuration reverts to global settings.
- Invalid hook definitions in workflow frontmatter (e.g., unsupported action type, missing required fields) are logged as warnings. Invalid individual hooks are skipped; valid hooks in the same configuration still apply.
- Vault event hooks (`on-note-open`, `on-save`, `on-tag-change`, `on-schedule`) are not configurable via workflow frontmatter — only LLM lifecycle hooks are supported in this context.

### FR-53: Workflow activity indicator

**Description:** A UI element in the chat panel that signals when background workflows are running and provides quick access to their conversations.

**Acceptance criteria:**
- A workflow activity indicator is displayed in the Notor chat panel header area (e.g., an icon or badge) whenever one or more event-triggered workflows are executing in the background.
- The indicator is visible but unobtrusive — it does not interrupt the user's current conversation or take focus.
- When workflows are actively running, the indicator shows an animated or highlighted state (e.g., a spinning icon or pulsing badge) to signal activity.
- Clicking the indicator opens a dropdown or popover list showing:
  - **Currently running workflows**: workflow name, trigger source (e.g., "on-save: Research/Climate.md"), and a brief status (e.g., "Running…", "Waiting for approval").
  - **Recently completed workflows**: workflow name, trigger source, completion status (success or error), and timestamp. Recently completed workflows remain in the list for a configurable duration (default: 5 minutes) or until the user dismisses them.
- Clicking on a specific workflow entry in the list opens that workflow's conversation in the main Notor chat panel. The user can then review the full conversation, send follow-up messages, approve pending tool calls, or stop the workflow.
- When no workflows are running and no recent completions remain, the indicator is hidden or displayed in an inactive state (not pulsing/animated).
- The indicator reflects the count of active background workflows (e.g., a numeric badge showing "2" when two workflows are running).
- Manually triggered workflows (FR-42) that open directly in the chat panel do not appear in the activity indicator — it is exclusively for background event-triggered workflows.

## Non-functional requirements

### NFR-10: Performance

**Description:** Phase 4 features must not degrade the responsiveness of the chat panel, editor, or vault operations.

**Acceptance criteria:**
- Persona discovery (scanning `{notor_dir}/personas/`) completes in under 200 ms for up to 50 persona directories. The scan is triggered only on settings panel open and persona picker activation, not on every message.
- Workflow discovery (scanning `{notor_dir}/workflows/`) completes in under 500 ms for up to 200 workflow notes. The scan reads only frontmatter (not full note bodies) during discovery.
- `<include_note>` tag resolution for a single workflow prompt completes in under 200 ms for up to 20 tags, each referencing notes of typical size (under 50 KB).
- Vault event hooks (`on-note-open`, `on-save`, `on-tag-change`) add no perceptible delay to the vault operation that triggered them. Hook execution is non-blocking — the vault operation completes before hooks run.
- Cron-scheduled hooks are evaluated via a lightweight in-process timer, not by spawning external processes. The timer check adds negligible CPU overhead.
- Debounce logic for `on-note-open` and `on-save` events prevents unnecessary repeated execution without consuming significant memory (debounce state is per-note-path, pruned after the cooldown expires).

### NFR-11: Security and privacy

**Description:** Phase 4 features must maintain the same safety guarantees established in earlier phases.

**Acceptance criteria:**
- Persona files, workflow notes, and vault-level rule files are read via Obsidian's vault API — no raw filesystem access outside the vault.
- `<include_note>` tag resolution is limited to notes within the vault. Paths that resolve outside the vault (e.g., `../../etc/passwd`) are treated as "note not found" and replaced with an error marker.
- Hook-triggered workflows respect the same Plan/Act mode, auto-approve, and checkpoint mechanisms as manually triggered workflows. No safety bypass occurs because a workflow was triggered by a hook.
- Per-persona auto-approve overrides can only make tools more or less restrictive — they cannot bypass Plan/Act mode restrictions (write tools remain blocked in Plan mode regardless of persona settings).
- Workflow frontmatter hook configurations (`notor-hooks`) use the same shell command execution restrictions (working directory allow-list, timeout) as global hooks.
- Scheduled hooks and event-triggered workflows do not execute if the plugin is in a disabled state. Enabling the plugin reschedules any active cron hooks.

### NFR-12: Usability and transparency

**Description:** Phase 4 features are discoverable, clearly surfaced in the UI, and consistent with the patterns established in earlier phases.

**Acceptance criteria:**
- The active persona is always visible in the chat panel so the user knows which AI personality and settings are in effect.
- Workflow-initiated conversations are clearly labeled (e.g., "Workflow: Daily review") so the user can distinguish them from ad-hoc conversations.
- When a workflow triggers a persona switch, a notice or indicator in the chat panel confirms which persona was activated and when it reverts.
- `<include_note>` resolution errors are visible in the assembled prompt (as inline error markers), ensuring the user and LLM are both aware of missing content.
- Vault event hook configuration in Settings follows the same grouped, collapsible UI pattern established for LLM interaction hooks in Phase 3.
- Hook failures (both vault event and workflow-scoped) surface non-blocking notices consistent with Phase 3 behavior — failures are visible but do not interrupt the user's work.

### NFR-13: Reliability

**Description:** Failures in Phase 4 features are handled gracefully and do not disrupt core chat or vault operations.

**Acceptance criteria:**
- A malformed persona `system-prompt.md` (e.g., invalid YAML frontmatter) does not crash the plugin. The persona is excluded from the picker with a warning logged. Other personas remain available.
- A malformed workflow note (invalid frontmatter, missing required properties) is excluded from the workflow list with a warning logged. Other workflows remain available.
- `<include_note>` resolution failures (missing notes, missing sections) produce inline error markers rather than aborting the entire prompt assembly. The rest of the prompt is sent normally.
- Circular or deeply nested hook-to-workflow chains are detected and broken with a clear notice, preventing infinite loops or runaway resource consumption.
- If the cron scheduler encounters an error (e.g., invalid expression at runtime), the specific scheduled hook is disabled and an error is logged. Other scheduled hooks continue to function.
- Vault event hooks that fail do not prevent the triggering vault operation (save, open, tag change) from completing.

## User scenarios & testing

### Primary flow: Create and use a persona

1. User creates the directory `{notor_dir}/personas/researcher/` and a file `system-prompt.md` with a frontmatter block setting `notor-preferred-model: "claude-sonnet-4-20250514"` and body text describing a research-focused AI personality.
2. User opens the Notor chat panel and clicks the gear icon.
3. The persona picker shows "researcher" alongside "None".
4. User selects "researcher". The chat panel shows a "researcher" label near the input area. The model switches to Claude Sonnet.
5. User sends a message. The AI responds with the researcher persona's system prompt shaping its behavior.
6. User switches to "None". The model reverts to the global default; subsequent messages use the global system prompt.

### Primary flow: Run a manual workflow

1. User creates `{notor_dir}/workflows/daily-review.md` with frontmatter `notor-workflow: true`, `notor-trigger: manual`, `notor-workflow-persona: organizer`, and body text: "Review my daily notes from today and create a summary at Daily/{{date}}-summary.md. Include key themes and action items."
2. User opens the command palette and selects "Notor: Run workflow".
3. The quick-pick list shows "daily-review". User selects it.
4. The chat panel opens (if not already open), the persona switches to "organizer" (confirmed by a notice), and the workflow prompt appears as the first user message.
5. The AI reads today's daily notes, synthesizes them, and proposes writing a summary note. Tool calls appear inline with full transparency.
6. User approves the `write_note` tool call. The summary note is created and opened in the editor.
7. After the AI's response turn completes, the persona reverts to the user's previous selection.

### Primary flow: Workflow with `<include_note>` tags

1. User creates a workflow note with body: "Analyze the following research notes and identify connections:\n\n<include_note path=\"Research/Climate.md\" section=\"Key Findings\" />\n\n<include_note path=\"Research/Energy.md\" section=\"Conclusions\" />\n\nSuggest three new research questions that bridge these topics."
2. User runs the workflow via command palette.
3. The plugin resolves both `<include_note>` tags, replacing them with the respective section contents.
4. The assembled prompt (with injected note content) appears as the user message in the chat panel.
5. The AI responds with connections and research questions based on the injected content.

### Primary flow: Scheduled workflow via vault event hook

1. User configures an `on-schedule` hook in **Settings → Notor** with cron `0 9 * * 1` (9 AM every Monday) and action "run a workflow" pointing to `weekly/inbox-review.md`.
2. On Monday at 9 AM (while Obsidian is running), the hook fires automatically.
3. The `inbox-review.md` workflow prompt is assembled and sent to the LLM.
4. The AI processes the inbox notes, suggests categorization, and proposes tag additions.
5. A notice confirms the workflow completed. Results are visible in the conversation log.

### Primary flow: `on-save` hook triggers a shell command

1. User configures an `on-save` vault event hook with action "execute shell command": `echo "Saved: $NOTOR_NOTE_PATH at $(date)" >> /path/to/vault/notor/logs/save-log.txt`.
2. User edits and saves `Research/Climate.md`.
3. The hook fires after the save completes. The shell command appends a log entry with the note path and timestamp.
4. A brief success notice appears. The save operation was not delayed.

### Primary flow: Persona with auto-approve overrides

1. User creates a persona `organizer` and opens **Settings → Notor → Persona auto-approve**.
2. Under the "organizer" persona, the user sets `write_note`, `replace_in_note`, and `manage_tags` to "Auto-approve", leaving all other tools at "Global default".
3. User activates the "organizer" persona in the chat panel.
4. User asks: "Reorganize my inbox notes by adding appropriate tags."
5. The AI invokes `manage_tags` — the tool call is auto-approved (persona override) and executes without a confirmation prompt.
6. The AI invokes `execute_command` — this tool is set to "Global default" on the persona, so the global auto-approve setting applies (approval required by default). A confirmation prompt appears.

### Alternative flow: Missing persona in workflow

1. A workflow specifies `notor-workflow-persona: "editor"`, but no `editor` persona directory exists.
2. User runs the workflow via command palette.
3. A notice appears: "Persona 'editor' not found; running with current settings."
4. The workflow executes with the currently active persona (or global defaults). No crash or abort occurs.

### Alternative flow: `<include_note>` references a missing note

1. A workflow body contains `<include_note path="Research/Deleted.md" />`.
2. User runs the workflow.
3. The tag is replaced with `[include_note error: note 'Research/Deleted.md' not found]`.
4. The rest of the prompt assembles normally and is sent to the LLM.
5. The LLM sees the error marker in the prompt and may inform the user that the referenced note was not found.

### Alternative flow: Invalid workflow note excluded from discovery

1. User creates `{notor_dir}/workflows/broken.md` with `notor-workflow: true` but no `notor-trigger` property.
2. On plugin load, the plugin logs a warning: "Workflow 'broken.md' is missing required 'notor-trigger' property."
3. The workflow does not appear in the command palette workflow list.
4. Other valid workflows in the same directory are unaffected.

### Edge case: Infinite loop prevention in hook-to-workflow chains

1. An `on-tag-change` hook is configured to run workflow `auto-categorize.md`.
2. The `auto-categorize.md` workflow instructs the AI to add tags to notes, which would trigger `on-tag-change` again.
3. The plugin detects the cycle: the `on-tag-change` hook was already in the execution chain.
4. The re-trigger is skipped and a notice is surfaced: "Hook cycle detected; skipping 'on-tag-change' to prevent infinite loop."
5. The original workflow completes normally.

### Edge case: Rapid saves with debounce

1. An `on-save` hook is configured with a 5-second debounce.
2. User edits a note and saves three times in quick succession (within 2 seconds).
3. The hook fires once for the first save. The second and third saves are debounced — the hook does not re-fire until the 5-second cooldown expires.
4. If the user saves again after 5 seconds, the hook fires again.

### Edge case: Persona with invalid YAML frontmatter

1. User creates a persona `broken-persona` with malformed YAML in `system-prompt.md` (e.g., unbalanced quotes).
2. The plugin attempts to parse the frontmatter and fails.
3. A warning is logged: "Persona 'broken-persona' has invalid frontmatter; excluded from persona list."
4. The persona does not appear in the picker. Other personas are unaffected.

### Edge case: Workflow frontmatter hooks override global hooks

1. Global `after-completion` hook is configured to log a summary to `notor/logs/session.md`.
2. A workflow `analyze.md` defines `notor-hooks: { after-completion: [{ action: execute_command, command: "echo done" }] }`.
3. User runs the `analyze.md` workflow.
4. During the workflow execution, the workflow-scoped `after-completion` hook (`echo done`) fires instead of the global log hook.
5. Global hooks for other events (e.g., `pre-send`) still apply since the workflow didn't override them.
6. After the workflow completes, the global `after-completion` hook is restored for subsequent conversations.

### Edge case: Obsidian closed during scheduled hook time

1. A scheduled hook is configured for `0 9 * * *` (9 AM daily).
2. Obsidian is not running at 9 AM.
3. When Obsidian is next opened (e.g., at 10 AM), no catch-up execution occurs — the missed execution is simply skipped.
4. The hook fires normally at 9 AM the following day if Obsidian is running.

## Success criteria

1. **Users can create and switch between specialized AI personalities** — personas defined as vault notes shape the AI's system prompt, model, and provider preferences, with changes taking effect immediately and no plugin reload required.
2. **Personas customize the approval experience** — per-persona auto-approve overrides allow power users to streamline trusted workflows while maintaining strict approval for sensitive operations, with fallback to global defaults for unconfigured tools.
3. **Reusable prompt templates reduce repetitive work** — workflow notes stored in the vault can be run manually from the command palette, producing a full transparent conversation in the chat panel with tool calls, results, and streaming responses.
4. **Workflows compose dynamic prompts from vault content** — `<include_note>` tags resolve at execution time to inject note contents (full or section-level) into workflow prompts, system prompts, and rule files without manual copy-paste; multiple tags may appear in a single document and each resolves independently.
5. **Vault events drive automated AI workflows** — hooks tied to note open, save, tag change, and cron schedule events trigger shell commands or named workflows reliably, with debounce preventing redundant executions.
6. **Workflows can customize their hook behavior** — per-workflow LLM lifecycle hook overrides via frontmatter allow each workflow to define its own pre-send, on-tool-call, on-tool-result, and after-completion actions without affecting global configuration.
7. **Phase 4 features are safe and resilient** — infinite loop detection prevents runaway hook-to-workflow chains, malformed personas and workflows are gracefully excluded without crashing the plugin, and all safety mechanisms (Plan/Act mode, checkpoints, auto-approve) apply equally to manually and automatically triggered workflows.

## Key entities

### Persona
- Stored as a directory under `{notor_dir}/personas/{persona_name}/` containing a `system-prompt.md` file.
- The `system-prompt.md` body content is the persona's system prompt; frontmatter properties configure behavior (`notor-persona-prompt-mode`, `notor-preferred-provider`, `notor-preferred-model`).
- Per-persona auto-approve overrides are managed via **Settings → Notor → Persona auto-approve** (stored in plugin settings data, not in frontmatter).
- Discovered by scanning the personas directory for subdirectories containing `system-prompt.md`.
- Selectable from the chat panel; at most one persona is active at a time.
- When active, the persona's settings take precedence over global defaults; unconfigured settings fall back to global.

### Workflow
- Stored as a Markdown note under `{notor_dir}/workflows/` with `notor-workflow: true` in frontmatter.
- Frontmatter properties define trigger type (`notor-trigger`), optional schedule (`notor-schedule`), optional persona assignment (`notor-workflow-persona`), and optional per-workflow hooks (`notor-hooks`).
- Body content (after stripping frontmatter) is the prompt template, which may contain `<include_note>` tags and static text.
- Discovered by scanning the workflows directory recursively for notes with the `notor-workflow` property.
- Can be executed manually (command palette), triggered by vault events (via workflow-trigger frontmatter), or invoked by hooks (FR-51).

### IncludeNoteTag
- A self-closing XML-style tag (`<include_note ... />`) that appears in workflow bodies, system prompts, and vault-level rule files. Must be written in self-closing form ending with `/>`.
- Supported attributes: `path` (required), `section` (optional), `mode` (optional; `inline` or `attached`). All other attributes are silently ignored.
- The `path` attribute accepts either a vault-relative file path (`"Research/Topic A.md"`) or an Obsidian wikilink (`"[[Topic A]]"`). Wikilinks are resolved via `metadataCache.getFirstLinkpathDest()` and benefit from Obsidian's automatic link-update on note rename. Wikilink syntax is the recommended form for resilience to renames.
- Resolved at execution time by reading the referenced note content from the vault.
- In system prompt and rule file contexts, always resolves as inline regardless of `mode` attribute.
- Resolution failures produce inline error markers rather than aborting prompt assembly.
- Nested resolution is not supported (no recursive includes).
- Multiple tags may appear in the same document; each is resolved independently.

### VaultEventHook
- A configured callback tied to a vault lifecycle event: `on-note-open`, `on-save`, `on-tag-change`, or `on-schedule`.
- Configured in **Settings → Notor** under the vault event hooks section, grouped by event type.
- Each hook has an action type: "execute shell command" (from Phase 3) or "run a workflow" (Phase 4).
- For note-related events, context (note path, changed tags) is passed via environment variables.
- Shares the global hook timeout with LLM interaction hooks.
- Debounce logic prevents rapid re-triggering for `on-note-open` and `on-save` events.

### WorkflowScopedHook
- An LLM lifecycle hook defined in a workflow note's `notor-hooks` frontmatter property.
- Overrides the global hook configuration for the corresponding lifecycle event during the workflow's execution.
- Supports the same action types (execute shell command, run workflow) and execution semantics as global hooks.
- Reverts to global hooks when the workflow execution ends.

## Assumptions

- The Notor root directory (`{notor_dir}`) is already configured by the user as part of Phase 0/1 setup. Phase 4 features rely on this directory existing with the expected subdirectory structure (`personas/`, `workflows/`).
- Obsidian's vault API supports reading file frontmatter programmatically (via `app.metadataCache` or equivalent), enabling efficient workflow and persona discovery without parsing full note bodies.
- Section header extraction for `<include_note>` follows Obsidian's standard heading anchor format. Section boundaries are determined by heading level: content runs from the specified heading to the next heading of equal or higher level (or end of file).
- Wikilink resolution for `<include_note>` uses Obsidian's `metadataCache.getFirstLinkpathDest()` API. This is the same mechanism Obsidian uses internally for all wikilinks, ensuring consistent note-finding behaviour (fuzzy by note name, with optional subdirectory disambiguation). Obsidian's built-in link-updater treats wikilinks inside the `path` attribute as internal links and updates them automatically when the referenced note is renamed or moved.
- Cron expression parsing is handled by a lightweight JavaScript library bundled into the plugin (e.g., `cron-parser` or equivalent). No external cron daemon or OS-level scheduling is required.
- The Phase 3 hook infrastructure (shell command execution, timeout handling, environment variable injection, settings UI pattern) is in place and can be extended for vault event hooks and the "run a workflow" action type without architectural changes.
- Vault event detection uses Obsidian's built-in event system (`app.vault.on('modify', ...)`, `app.workspace.on('file-open', ...)`, `app.metadataCache.on('changed', ...)`). Tag change detection relies on comparing frontmatter `tags` before and after a metadata cache update.
- Workflow prompts that reference the triggering note's path (for event-triggered workflows) use a simple text substitution mechanism or environment variable; no full template engine is assumed.
- Only one instance of a given workflow can execute at a time. If a workflow is already running and the same trigger fires again (after debounce), the second invocation is queued or skipped.

## Out of scope

The following are explicitly excluded from Phase 4 and deferred to later phases or iterations:

- **Extended persona capabilities** (Phase 5): per-persona tool access restrictions (approve-list/block-list specific tools) and per-persona vault scope limitations (restricting a persona to operate only within certain folders).
- **Multi-agent and background agents** (Phase 5): parallel AI context windows, agent monitor panel, and persistent background agents.
- **Custom MCP tools** (Phase 5): user-defined tools via the Model Context Protocol.
- **Browser capabilities** (Phase 5): web browsing for AI research, Obsidian Web Viewer integration.
- **External file access beyond attachment** (Phase 5): AI autonomously reading external files via tool calls.
- **Template variables / expressions in workflow prompts**: a full template engine (e.g., `{{date}}`, `{{note.title}}`, conditionals) for workflow prompt bodies. Phase 4 supports only `<include_note>` tags for dynamic content; richer templating is deferred.
- **Workflow chaining / multi-step orchestration**: defining a sequence of workflows that execute in order, with data passed between steps. Phase 4 workflows are single-prompt interactions; multi-step orchestration is deferred.
- **Workflow input parameters**: prompting the user for input values when a workflow is triggered (e.g., "Which folder should I review?"). Phase 4 workflows use static prompts with `<include_note>` injection; user input parameterization is deferred.
- **Workflow versioning or history**: tracking changes to workflow definitions over time.
- **Persona creation UI**: a dedicated wizard or settings UI for creating personas. Phase 4 personas are created by manually creating directories and files in the vault.
- **Conditional workflow triggers**: filtering when event-triggered workflows fire based on note path patterns, tags, or other conditions (e.g., "only run this on-save workflow for notes in the Research/ folder"). Phase 4 event triggers fire for all matching events; path or tag filtering is deferred.
- **"Append to vault note" hook action**: as established in Phase 3, users can achieve vault note appending via shell commands. No dedicated hook action type is provided.

## Clarifications

### Session 2026-08-03

- Q: Should the automatic persona revert (via `notor-workflow-persona`) happen immediately after the first LLM response turn completes, or should it persist for the entire conversation started by the workflow? → A: Persist for the entire conversation. The persona switch stays active as long as the user is in the workflow conversation. The user can continue sending follow-up messages under the workflow's persona. The persona reverts only when the user switches to a different conversation or starts a new one. This supports multi-turn workflows where the persona context matters throughout the full interaction.
- Q: Should event-triggered workflows open a new conversation in the chat panel (potentially interrupting the user), or execute silently in the background? → A: Background execution with a workflow activity indicator. Event-triggered workflows run in the background without taking over the chat panel. A UI element (workflow activity indicator, FR-53) in the chat panel header signals when background workflows are underway, shows their status (running, completed, errored), and allows the user to click into any active or recently completed workflow conversation. On completion, a non-blocking notice is surfaced. This is non-disruptive while maintaining discoverability.
- `notor-skip-global-prompt` (boolean) was renamed to `notor-persona-prompt-mode` (string: `"append"` | `"replace"`) for future extensibility. The default behavior (`append`) is unchanged — persona prompts are appended to the global system prompt. Setting `"replace"` is equivalent to the old `notor-skip-global-prompt: true`. This design allows additional modes to be introduced in the future without breaking existing configurations.
- The spec does not provide built-in or pre-packaged personas. The focus is purely on creating the capability for end users to customize the AI with personas of their own choosing. User stories, scenarios, and examples that reference specific personas (e.g., "researcher", "organizer") are illustrative examples of what users might create, not built-in offerings.
- Per-persona auto-approve overrides were moved from frontmatter (`notor-auto-approve` YAML mapping) to a dedicated Settings UI sub-page (**Settings → Notor → Persona auto-approve**). This change was driven by Obsidian's frontmatter limitations with complex YAML structures (nested mappings). The Settings UI approach also enables the plugin to surface non-blocking warnings for invalid/stale tool names and provides a more user-friendly three-state selector per tool (Global default / Auto-approve / Require approval). Configuration is stored in plugin settings data, keyed by persona name.
- A "Provider & model identifiers" reference section was added to Settings (FR-39a) so users can easily discover and copy the exact string values needed for `notor-preferred-provider` and `notor-preferred-model` frontmatter properties.
- The dynamic content injection tag was renamed from `<include_notes>` (plural) to `<include_note>` (singular). The singular form is semantically accurate — each tag instance includes exactly one note — and follows the convention of self-closing tags that describe a single element (e.g., `<img />`). Users can include multiple notes by using multiple `<include_note ... />` tags. The tag is always written in self-closing form (ending with `/>`); the three supported attributes are `path` (required), `section` (optional), and `mode` (optional). All other attributes are silently ignored.
- The `path` attribute on `<include_note>` was extended to support Obsidian wikilink syntax in addition to vault-relative file paths. When `path="[[Note Title]]"` (or `path="[[Subfolder/Note Title]]"`) is used, the plugin resolves the note using Obsidian's `metadataCache.getFirstLinkpathDest()` — the same API Obsidian uses for all internal wikilinks — so the note is found by name without requiring the full path. Critically, Obsidian's built-in link-update mechanism treats the wikilink inside the `path` attribute as an internal link and will automatically rewrite it when the referenced note is renamed or moved, making wikilink syntax the recommended form. Vault-relative path syntax (`path="Research/Note.md"`) remains supported for cases where the full path is preferred or required.
