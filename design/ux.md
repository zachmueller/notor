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
- Configurable storage location (defaults to `{notor_dir}/history/` or a path outside the vault).
- Structured to not appear in Obsidian's file explorer (either stored outside the vault, or in a hidden/ignored location).
- Configurable retention limits: cap by total size (MB) or age (days).

---

## System prompt

- A built-in default system prompt ships with Notor, designed to shape core behaviors for note editing assistance.
- Users have complete control to view, modify, or replace the system prompt via settings.
- **Vault-level instruction files** (Phase 2): `.notor-rules.md` files placed in vault folders are automatically discovered and injected into context when operating on notes in that folder tree. Similar to Cline's `AGENTS.md` convention.
- **Persona system prompts** (Phase 4): each persona carries its own system prompt that replaces or extends the default.

---

## Auto-context injection (Phase 3)

Automatically included context with each message (no manual attachment required):

- **Active note**: path and content of the currently open note in the editor
- **Vault structure**: summary of folder/note hierarchy
- **Current selection**: any text currently selected in the editor
- **Recently opened notes**: list of recently accessed notes for recency context
- Users can configure which auto-context sources are active.

---

## Notifications and feedback

- Use Obsidian's native `Notice` system for transient feedback (e.g., "Note saved", "Checkpoint created").
- Errors and warnings surface both as notices and inline in the chat thread.
- Avoid spammy notifications — prefer inline chat feedback for tool results.