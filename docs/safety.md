# Safety and approval

Notor is designed to be safety-first: every write operation is visible, controllable, and reversible.

## Plan mode and Act mode

A visible **Plan / Act** toggle sits in the chat input area.

- **Plan mode** (default for new users) restricts the AI to read-only tools. Write tools are blocked at the dispatch level — the AI simply cannot invoke them, even if it tries. In the system prompt, write tools are annotated with an `[Act mode only]` suffix so the AI understands which tools are unavailable.
- **Act mode** enables write tools. Write operations still require approval by default (see below).

Switching modes takes effect immediately for subsequent messages.

## Diff preview

Every proposed write shows a before/after diff before being applied. For edits that touch multiple blocks in a note, per-change accept/reject controls let you approve or reject individual hunks without accepting the entire change.

## Approval model

- **Write tools** require explicit approval by default before execution.
- **Read-only tools** default to auto-approved.
- Per-tool **Enabled** and **Auto-approve** settings are configurable in the unified **Settings → Notor → Tools** section — you can enable/disable any tool or promote it to auto-approve. See [Enabling and disabling tools](vault-tools.md#enabling-and-disabling-tools) for details.
- [Per-persona auto-approve overrides](personas.md) let you configure different approval behavior per persona.

## Cancellation

Clicking **Stop** in the chat panel immediately returns control to the user. Any in-flight tool executions complete in the background, but their results are not appended to the conversation. There is no orphaned tool-call state — subsequent messages work normally.

## Checkpoints

Before any write operation, the affected note is automatically snapshotted as a checkpoint.

- You can preview, compare (diff), or restore any checkpoint from the conversation timeline.
- Checkpoint data is stored in `.obsidian/plugins/notor/checkpoints/` and is not visible as vault notes.

### History and checkpoint storage settings

Conversation history (JSONL files) and checkpoint snapshots are stored in your vault's plugin data directory. These settings are configurable in **Settings → Notor**:

| Setting | Default | Description |
|---------|---------|-------------|
| History path | `.obsidian/plugins/notor/history/` | Storage directory for conversation JSONL files |
| History max size | 500 MB | Maximum total history storage size; oldest conversations are cleaned up first |
| History max age | 90 days | Conversations older than this are eligible for cleanup |
| Checkpoint path | `.obsidian/plugins/notor/checkpoints/` | Storage directory for checkpoint files |
| Checkpoints per conversation | 100 | Maximum checkpoints retained per conversation |
| Checkpoint max age | 30 days | Checkpoints older than this are eligible for cleanup |

## Sub-agent security

[Sub-agents](sub-agents.md) operate under a stricter security model than the main conversation:

- **Default-deny tool access** — a sub-agent has NO tools unless explicitly enabled in its profile.
- **Intersection enforcement** — the effective tool set is the intersection of the parent's enabled tools and the sub-agent's profile config. A sub-agent can never access a tool the parent doesn't have.
- **Plan/Act inheritance** — sub-agents always inherit the parent's mode. A sub-agent cannot escalate to Act mode when the parent is in Plan mode.
- **No nesting** — sub-agents cannot spawn other sub-agents.
- **Read tools auto-approved** — read-only tool calls within sub-agents are auto-approved by default (configurable). Write tools surface approval prompts in the main chat.

## Stale-content protection

If you edit a note directly in Obsidian while the AI has it queued for modification, Notor detects the conflict and fails the write. The AI is prompted to re-read the current content before retrying, preventing it from overwriting your changes with a stale version.

### Frontmatter-aware detection

The stale check uses a two-tier comparison: first an exact full-content match (fast path), then an MD5 body-hash fallback. This means frontmatter-only changes — such as those made by `update_frontmatter` or `manage_tags` — do not trigger false stale errors for subsequent body edits via `replace_in_note`. The AI can update metadata and body content in the same turn without needing to re-read between operations.

Stale tracking state is persisted in the conversation's JSONL file and survives plugin reloads. When you resume a conversation, the tracker is restored so the AI can continue editing notes it previously read without re-reading them.

## Output spillover

When a tool produces output exceeding the configured threshold (default: 50,000 characters), the excess is written to a temporary file and the truncated result includes a pointer to the spillover file path. This prevents excessively large tool results from overwhelming the LLM's context window.

- **Configurable** — toggle with `output_spillover_enabled` (default: on) and adjust the character threshold with `output_spillover_threshold` in **Settings → Notor**.
- **Desktop only** — spillover requires filesystem access; on mobile, large outputs are truncated without a spillover file.
- **Auto-cleanup** — stale spillover files (older than 1 hour) are removed automatically on plugin load.
- **Applies broadly** — MCP tools, extension tools, and `execute_command` all route through the spillover mechanism. Built-in tools that already manage their own truncation (e.g., `fetch_webpage`) return short results and are unaffected.
- Spillover does not affect the approval workflow — the tool still executes normally; only the result returned to the AI is truncated.
