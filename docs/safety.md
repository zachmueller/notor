# Safety and approval

Notor is designed to be safety-first: every write operation is visible, controllable, and reversible.

## Plan mode and Act mode

A visible **Plan / Act** toggle sits in the chat input area.

- **Plan mode** (default for new users) restricts the AI to read-only tools. Write tools are blocked at the dispatch level — the AI simply cannot invoke them, even if it tries.
- **Act mode** enables write tools. Write operations still require approval by default (see below).

Switching modes takes effect immediately for subsequent messages.

## Diff preview

Every proposed write shows a before/after diff before being applied. For edits that touch multiple blocks in a note, per-change accept/reject controls let you approve or reject individual hunks without accepting the entire change.

## Approval model

- **Write tools** require explicit approval by default before execution.
- **Read-only tools** default to auto-approved.
- Per-tool auto-approve settings are configurable in **Settings → Notor** — you can promote any tool to auto-approve or demote it to require approval.
- [Per-persona auto-approve overrides](personas.md) let you configure different approval behavior per persona.

## Checkpoints

Before any write operation, the affected note is automatically snapshotted as a checkpoint.

- You can preview, compare (diff), or restore any checkpoint from the conversation timeline.
- Checkpoint data is stored in `.obsidian/plugins/notor/checkpoints/` and is not visible as vault notes.

## Stale-content protection

If you edit a note directly in Obsidian while the AI has it queued for modification, Notor detects the conflict and fails the write. The AI is prompted to re-read the current content before retrying, preventing it from overwriting your changes with a stale version.
