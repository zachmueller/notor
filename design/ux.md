# UX Design

User experience design for Notor's interface within Obsidian.

---

## Chat panel

The chat panel is the primary interaction surface for Notor.

### Layout and positioning

- Implemented as an Obsidian side panel (leaf view). Users can drag it to any side of the workspace.
- Chat input box at the bottom with a send button.
- **Enter** to send, **Shift+Enter** for new line.
- Chat settings button (gear icon) in the panel header for quick access to provider/model/persona selection.

### Message display

- **Streaming**: responses render token-by-token as the LLM generates them, not as a single block after completion.
- **Markdown rendering**: AI responses render as formatted Markdown within the chat panel.
- **Tool call transparency**: every tool invocation appears inline in the chat thread, showing:
  - Tool name and parameters (collapsible for space)
  - Tool result or output (collapsible)
  - Status indicator (pending / success / error)
- **User messages** display as-is, with any attached notes/files shown as labeled references.

### Chat settings (quick access)

Available from the gear icon or inline typable syntax:

- **LLM provider**: swap between configured providers (Bedrock, Anthropic, OpenAI, etc.)
- **Model**: swap between model variants within the selected provider
- **Persona**: select active persona (changes system prompt, model preference, auto-approve settings)

### Plan vs Act mode

- Toggle in the chat panel header.
- **Plan mode**: AI can use read-only tools (`read_note`, `search_vault`, `list_vault`) but cannot use write tools (`write_note`, `replace_in_note`, shell commands). Enforced at the tool dispatch level.
- **Act mode**: all tools available, subject to auto-approve settings.
- The toggle state is visible and clearly labeled so the user always knows which mode is active.
- Plan/Act restrictions can be extended with user-configurable per-tool overrides (e.g., block specific shell commands in Plan mode).

### Auto-approve

- Per-tool auto-approve settings managed in **Settings → Notor**.
- **Global defaults**: set auto-approve on/off for each tool.
- **Persona overrides** (Phase 4): per-persona auto-approve settings that override global defaults when a persona is active. Falls back to global default for any tool not explicitly configured on the persona.
- When auto-approve is off for a tool, the chat panel shows an inline approval prompt (approve / reject) before executing the tool call.

### File/note attachment (Phase 3)

- Button in the chat input area (and inline typable syntax) for attaching context.
- **Vault notes**: file picker with Obsidian-style `[[wikilink]]` auto-completion. Supports section header references (e.g., `[[Note#Section]]`) to attach only a subset of a note's content.
- **External files**: file picker that can access files outside the vault.
- Attached items appear as labeled chips/tags in the input area before sending.

---

## Editor behavior

### Note opening

- **Default on** (configurable): when Notor reads or modifies a note, it opens the note in the Obsidian editor so the user can follow along in real time.
- If the note is already open, Notor should navigate to / highlight the relevant section being read or modified.

### Diff preview and change approval

- When the AI proposes changes via `write_note` or `replace_in_note`, display a diff view before applying.
- The diff should show:
  - Before/after content for each change
  - Clearly highlighted additions and deletions
  - Per-change accept/reject controls (for `replace_in_note` with multiple SEARCH/REPLACE blocks)
  - An "accept all" / "reject all" option for bulk approval
- When auto-approve is on for the relevant tool, diffs are applied immediately but still shown in the chat thread (collapsed by default) so the user can review after the fact.

### Checkpoints (Phase 2)

- Before applying any write operation, automatically snapshot the affected note(s).
- Checkpoint data stored in the plugin directory (`.obsidian/plugins/notor/checkpoints/` by default). The storage location is configurable via settings.
- Checkpoints are accessible from the chat panel — each conversation has a timeline of checkpoints.
- Users can preview a checkpoint (see the note state at that point) and restore to it.
- Custom-built mechanism (not git-dependent), details to be specified in a dedicated spec.

---

## Transparency and observability

### Tool call display

Every tool call in the conversation is rendered inline with:

- **Tool name** and **parameters** (e.g., `read_note: Daily/2026-03-01.md, frontmatter: exclude`)
- **Result summary** (e.g., "Read 847 characters" or "3 matches found")
- **Full result** available via expand/collapse
- **Error states** clearly surfaced with the error message

### Token and cost tracking (Phase 2)

- Per-message token count (input + output).
- Per-conversation cumulative token count and estimated cost.
- Displayed in the chat panel (e.g., footer or per-message annotation).
- Cost estimation based on configurable per-model pricing.

### Chat history logging (Phase 2)

- Full conversation history persisted in JSONL format.
- Defaults to `.obsidian/plugins/notor/history/` (inside the plugin directory).
- Configurable via settings to any vault-relative path. The path is always relative to the vault root.
- JSONL files are not recognized by Obsidian as notes, so they do not appear in the file explorer or search results regardless of storage location.
- Configurable retention limits: cap by total size (MB) or age (days).

---

## System prompt

### Global system prompt

- A built-in default system prompt ships with Notor internally (in plugin code), designed to shape core behaviors for note editing assistance.
- In **Settings → Notor**, a "Customize system prompt" action writes the default system prompt to `{notor_dir}/system-prompt.md`, where users can edit it directly in Obsidian's editor.
- **Resolution order**: if `{notor_dir}/system-prompt.md` exists, the plugin uses its body content (stripping frontmatter if present) as the base system prompt. Otherwise, the internal default is used.
- This file is a regular Markdown note — not hidden — so it appears in the file explorer and is fully editable like any vault note.

### Vault-level instruction files (Phase 2)

Centrally stored Markdown files under `{notor_dir}/rules/` that are conditionally injected into context based on frontmatter trigger properties.

- **Location**: all rule files live under `{notor_dir}/rules/` (not scattered across vault folders).
- **Trigger properties** (in each rule file's frontmatter):
  | Property | Example | Behavior |
  |---|---|---|
  | `notor-always-include` | `true` | Always inject this file's content into context |
  | `notor-directory-include` | `Research/` | Inject when any note in the context window has a path under the specified directory |
  | `notor-tag-include` | `llm` | Inject when any note in the context window has the specified tag |
- Multiple trigger properties can coexist on the same file (OR logic — any matching trigger causes inclusion).
- Additional trigger types may be added over time.
- The file body (after stripping frontmatter) is the instruction content injected into the system prompt / context.
- Rule file bodies support `<include_notes>` tags for dynamically injecting note contents (inline mode only — see [Architecture — `<include_notes>` tag](architecture.md#include_notes-tag)).

### Persona system prompts (Phase 4)

- Each persona is defined by a `system-prompt.md` file under `{notor_dir}/personas/{persona_name}/`.
- The file body (stripping frontmatter) is the persona's system prompt.
- Both global and persona system prompts support `<include_notes>` tags for dynamically injecting note contents (inline mode only — see [Architecture — `<include_notes>` tag](architecture.md#include_notes-tag)).
- Frontmatter properties configure persona behavior:
  ```yaml
  ---
  notor-skip-global-prompt: false   # If true, the global system prompt is NOT included; only this persona's prompt is used. Default: false (global prompt is prepended).
  notor-preferred-provider: ""      # Optional: override default LLM provider
  notor-preferred-model: ""         # Optional: override default model
  ---
  ```
- When `notor-skip-global-prompt` is `false` (default), the global system prompt is included first, followed by the persona's system prompt.
- Persona files are regular Markdown notes, fully editable in Obsidian's editor.
- The persona directory may be expanded over time to hold additional configuration files (e.g., tool access rules).

---

## Auto-context injection (Phase 3)

Automatically included context with each message (no manual attachment required):

- **Open note paths**: file paths of all notes currently open in the Obsidian workspace (all leaf/tab views, including pinned tabs and split panes). Only paths are included — full note contents are NOT automatically injected.
- **Vault structure**: top-level directory listing only (folder names at the vault root). Does NOT include individual file names in the root directory or recursive subdirectory contents, since many Obsidian users store most notes directly in the root.
- **Operating system**: the user's OS platform (macOS, Windows, Linux) so the LLM can generate platform-appropriate shell commands and tailor OS-specific guidance.
- Users can configure which auto-context sources are active.

---

## Workflows (Phase 4)

Workflows are reusable, structured AI interactions defined as notes in the vault. See [Architecture — Workflows](architecture.md#workflows-phase-4) for the data model and frontmatter schema.

### Workflow execution

- Workflows are triggered manually (from a command palette action, or a future UI affordance) or automatically via hooks (on-note-open, on-save, on-schedule, etc.).
- When a workflow is triggered, its body content is assembled as the prompt — with any `<include_notes>` tags resolved to inject note contents — and sent to the LLM.
- The workflow execution appears as a conversation in the main Notor chat panel, with full transparency (tool calls, results, streaming responses).

### Automatic persona switching via `notor-workflow-persona`

- Workflow notes support a `notor-workflow-persona` frontmatter property that specifies which persona to automatically activate when the workflow runs.
- When present, the plugin switches to the named persona before executing the workflow prompt. This means the persona's system prompt, model preferences, and auto-approve settings all take effect for the duration of the workflow.
- This is **optional** — if `notor-workflow-persona` is omitted, the workflow runs with whatever persona is currently active (or no persona / global defaults).
- Use case: a "Daily review" workflow can specify `notor-workflow-persona: "organizer"` so that it always runs with the organizer persona's system prompt and model, regardless of which persona the user had selected in the chat panel.
- After the workflow completes, the persona selection reverts to whatever was active before the workflow was triggered (the switch is scoped to the workflow execution, not persistent).

### Workflow frontmatter properties

All Notor-specific frontmatter properties use the `notor-` prefix to avoid conflicts with other plugins:

| Property | Type | Required | Description |
|---|---|---|---|
| `notor-workflow` | boolean | yes | Must be `true` to identify the note as a workflow |
| `notor-trigger` | string | yes | Trigger type: `manual`, `on-note-open`, `on-save`, `scheduled` |
| `notor-schedule` | string | no | Cron expression (required if `notor-trigger` is `scheduled`) |
| `notor-workflow-persona` | string | no | Persona name to automatically switch to when running this workflow |

---

## Agent monitor panel (Phase 5)

A dedicated Obsidian panel (separate leaf view) for monitoring all running agents at a glance. This panel is distinct from the main Notor chat panel, allowing users to position them independently for concurrent visibility.

### Layout

- The monitor panel displays a **list of all active agents**, each as a card or row showing:
  - **Agent name / task description**: brief label identifying what the agent is doing
  - **Status badge**: running, paused, completed, errored
  - **Progress indicator**: current activity or last action taken (e.g., "Reading Research/Topic A.md", "Waiting for approval")
  - **Resource usage**: token count consumed, elapsed time
- Agents are sorted by status (running first, then paused, then completed/errored).

### Interaction

- **Click an agent** to open its full conversation in the main Notor chat panel. This navigates the chat panel to that agent's context with all standard capabilities: view the conversation history, send messages, stop the agent, redirect its work, approve/reject tool calls, etc.
- **Quick actions** available directly from the monitor panel (without opening the full conversation):
  - **Pause / Resume**: temporarily halt an agent's execution
  - **Stop**: terminate the agent
- The monitor panel updates in real time as agents progress (new tool calls, status changes, completions).

### Opening the monitor panel

- Accessible via the Obsidian command palette (e.g., "Notor: Open agent monitor") and optionally from a button in the main chat panel header.
- The panel is an Obsidian leaf view, so users can drag it to any position in the workspace (sidebar, bottom panel, split pane, etc.).

---

## Notifications and feedback

- Use Obsidian's native `Notice` system for transient feedback (e.g., "Note saved", "Checkpoint created").
- Errors and warnings surface both as notices and inline in the chat thread.
- Avoid spammy notifications — prefer inline chat feedback for tool results.