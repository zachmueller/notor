# Hooks

Notor supports two categories of hooks: **LLM interaction hooks** that fire at key points in the conversation lifecycle, and **vault event hooks** that fire in response to vault file events.

Both types of hooks can either **execute a shell command** or **run a workflow**.

---

## LLM interaction hooks

Configure shell commands to fire automatically at key points in the conversation lifecycle:

| Event | When it fires | Blocking? |
|---|---|---|
| `pre-send` | After user submits a message, before it is sent to the LLM | Yes — awaited before dispatch |
| `on-tool-call` | After tool approval, immediately before tool execution | No |
| `on-tool-result` | After tool execution, before result is returned to the LLM | No |
| `after-completion` | After the LLM's full response turn completes | No |
| `on_approval_required` | Before tool execution, when a tool call needs approval | Yes — sequential, short-circuits on first decision |

> **Note:** An additional trigger, `on_conversation_start`, is available for [user-defined automations](extensions.md) (not shell hooks). It fires once per conversation when the first user message is submitted.

**Behavior:**

- Hook stdout from `pre-send` hooks is sent to the LLM as a separate context message and displayed as a collapsible **Hook output** element in the chat panel (not inline in the user's message bubble).
- All hooks receive conversation metadata as environment variables: conversation UUID, hook event name, tool name/parameters/result (where applicable), and a UTC timestamp.
- Multiple hooks can be configured per event, executed sequentially in order.
- Hook failures are non-blocking — the conversation continues and a notice is surfaced.
- A single global hook timeout (default: 10 seconds) applies to all hook events; timed-out processes are terminated without stalling the conversation.

**Configuration:** **Settings → Notor** under a dedicated hooks section grouped by lifecycle event. Each subsection is collapsible.

### Approval resolution via hooks

The `on_approval_required` event enables programmatic pre-approval or rejection of tool calls. Hooks for this event execute sequentially; the first hook to output `approved` or `rejected` on stdout short-circuits the remaining hooks and resolves the approval without showing a prompt to the user. Any other output (empty, error, or timeout) is treated as `pass`, deferring to the next hook or ultimately to the interactive approval prompt.

**Constraints:**

- Only `execute_command` hooks are supported — `run_workflow` hooks are skipped (workflow hooks cannot return a decision).
- Not overridable by per-workflow hook overrides (prevents workflows from self-approving their own tools).
- Context environment variables: `NOTOR_CONVERSATION_ID`, `NOTOR_TOOL_NAME`, `NOTOR_TOOL_PARAMS` (JSON-encoded parameters), `NOTOR_MODE` (`plan` or `act`).

---

## Vault event hooks

Configure hooks that fire automatically in response to vault lifecycle events:

| Event | When it fires |
|---|---|
| `on-note-open` | A note is opened (activated) in the editor |
| `on-note-create` | A new Markdown file is created in the vault |
| `on-save` | A note is saved (manual or auto-save) |
| `on-manual-save` | A note is saved by an explicit user action (Cmd+S / Ctrl+S) — not auto-save |
| `on-tag-change` | Tags are added to or removed from a note's frontmatter |
| `on-schedule` | A configured cron schedule fires (while Obsidian is running) |

**Behavior:**

- For shell commands, event context is available as environment variables (`NOTOR_NOTE_PATH`, `NOTOR_TAGS_ADDED`, `NOTOR_TAGS_REMOVED`).
- **Debounce** — `on-note-open`, `on-save`, and `on-manual-save` hooks include a configurable cooldown (default: 5 seconds) to prevent rapid-fire execution from auto-save or tab switching.
- **Cron scheduling** — `on-schedule` hooks use cron expressions (e.g., `0 9 * * 1` for 9 AM every Monday). Scheduling is in-process — no OS-level cron daemon is required. Missed executions while Obsidian is closed are skipped; no catch-up occurs.
- **Lazy listener activation** — Obsidian event listeners are only registered for event types that have at least one configured hook or workflow trigger. Removing the last hook for an event type dynamically unregisters its listener, adding zero overhead for unused event types.
- **Loop prevention** — tag changes and note creations caused by hook-triggered workflow executions do not re-trigger their corresponding hooks, preventing infinite loops.
- **Non-blocking** — hook failures surface a non-blocking notice without interrupting the triggering vault operation or preventing subsequent hooks from executing.

**Configuration:** **Settings → Notor** under a dedicated section grouped by event type, using the same collapsible UI pattern as LLM interaction hooks.

---

## User-defined automations

In addition to shell command hooks and workflow triggers, you can define vault-authored automations that fire at the same LLM lifecycle and vault events listed above. Automations are TypeScript/JavaScript code in Markdown files under `notor/automations/`, with direct access to Obsidian APIs and Notor utilities.

Automations coexist with shell hooks — shell hooks fire first, then workflow hooks, then vault-defined automations (sorted by `notor-automation-order`).

See [extensions.md](extensions.md) for the full reference on defining automations, available triggers, and the runtime context.

---

## Per-workflow hook overrides

Define a `notor-hooks` YAML mapping in a workflow's frontmatter to override global LLM lifecycle hooks for that workflow's duration. Overridden events use the workflow-scoped hooks; non-overridden events continue using global hooks. Reverts to global hooks when the workflow ends. See [workflows.md](workflows.md) for details.
