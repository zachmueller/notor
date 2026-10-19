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

> **Note:** Two additional triggers are available for [user-defined automations](extensions.md) only (not shell hooks): `on_conversation_start` fires once per conversation when the first user message is submitted, and `on_voice_command` fires for every utterance recognized while [voice mode](voice.md) is on.

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
| `on-daily-start` | The first time you use Obsidian each day, after the day reset time |

**Behavior:**

- For shell commands, event context is available as environment variables (`NOTOR_NOTE_PATH`, `NOTOR_TAGS_ADDED`, `NOTOR_TAGS_REMOVED`).
- **Debounce** — `on-note-open`, `on-save`, and `on-manual-save` hooks include a configurable cooldown (default: 5 seconds) to prevent rapid-fire execution from auto-save or tab switching.
- **Cron scheduling** — `on-schedule` hooks use cron expressions (e.g., `0 9 * * 1` for 9 AM every Monday). Scheduling is in-process — no OS-level cron daemon is required. Missed executions while Obsidian is closed are skipped; no catch-up occurs.
- **Daily start** — `on-daily-start` hooks run once per day, the first time you use Obsidian after the **Day reset time** (default 04:00). Opening Obsidian counts, and so does coming back to an Obsidian that stayed open overnight: waking the computer, focusing the window, typing, or switching notes. See [Daily start](#daily-start) below.
- **Lazy listener activation** — Obsidian event listeners are only registered for event types that have at least one configured hook or workflow trigger. Removing the last hook for an event type dynamically unregisters its listener, adding zero overhead for unused event types.
- **Loop prevention** — tag changes and note creations caused by hook-triggered workflow executions do not re-trigger their corresponding hooks, preventing infinite loops.
- **Non-blocking** — hook failures surface a non-blocking notice without interrupting the triggering vault operation or preventing subsequent hooks from executing.

**Configuration:** **Settings → Notor** under a dedicated section grouped by event type, using the same collapsible UI pattern as LLM interaction hooks.

### Daily start

Use `on-daily-start` for a start-of-day routine that runs without you having to remember to start it. You can attach any kind of target:

- a hook in **Settings → Notor → Vault event hooks → On daily start** (shell command, workflow, or circuit)
- a workflow with `notor-trigger: on-daily-start`
- an automation with `notor-trigger: on_daily_start`
- a circuit with `notor-daily-start: true`

**When it runs.** The day starts at the **Day reset time** (local, 24-hour). With the default of 04:00, using Obsidian at 02:00 still counts as the previous day. The first activity after the reset time runs every daily start target once. Workflows and circuits run in the background, like other event-triggered runs.

**Per device.** Whether today's run has happened is stored on each device and isn't synced. Each computer gets its own morning run. If a daily circuit writes to a shared note, two devices may both write to it on the same day, so make the circuit safe to run twice. **Last run on this device** shows the day of the last run. Select **Reset** to run it again on your next activity.

**When the model can't be reached.** Before starting a workflow or circuit, Notor checks that its provider is reachable. Expired credentials (for example an AWS SSO session) and having no network are the common causes. If the check fails, a Notice says what went wrong and when it will try again. Select **Retry now** after you fix the problem. Retries use exponential backoff: by default 5 retries starting at 3 minutes and capped at 30 minutes, about 75 minutes in total. Coming back online also triggers a retry. You can change these limits under **On daily start**. Set the retry count to 0 to turn retries off. Shell command hooks and automations run right away and skip this check. Once a run has started, a failure partway through is not retried.

**Getting back to the run.** Each started run shows a Notice with an **Open** button that opens its conversation. For a circuit, it opens the entry step's conversation, or the run tree if the conversation isn't available yet. The command **Open most recent daily start run** opens the latest day's run, or a picker if there were several. **Run daily start now** runs every daily start target immediately. Both commands only appear when at least one daily start target is configured.

---

## User-defined automations

In addition to shell command hooks and workflow triggers, you can define vault-authored automations that fire at the same LLM lifecycle and vault events listed above. Automations are TypeScript/JavaScript code in Markdown files under `notor/automations/`, with direct access to Obsidian APIs and Notor utilities.

Automations coexist with shell hooks — shell hooks fire first, then workflow hooks, then vault-defined automations (sorted by `notor-automation-order`).

See [extensions.md](extensions.md) for the full reference on defining automations, available triggers, and the runtime context.

---

## Per-workflow hook overrides

Define a `notor-hooks` YAML mapping in a workflow's frontmatter to override global LLM lifecycle hooks for that workflow's duration. Overridden events use the workflow-scoped hooks; non-overridden events continue using global hooks. Reverts to global hooks when the workflow ends. See [workflows.md](workflows.md) for details.
