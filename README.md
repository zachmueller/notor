# Notor

**A transparent, extensible AI assistant for note-taking and knowledge management in Obsidian.**

Notor brings AI-powered assistance directly into your Obsidian workflow. It gives you a full AI chat panel with the ability to read, search, create, and surgically edit notes in your vault — with full transparency into every AI action, a safety-first approval model, diff previews for proposed changes, and rollback via checkpoints.

> **Status:** Phases 0–4 of the roadmap implemented.

---

## What Notor can do today

### Chat with an AI inside Obsidian

- **Side panel chat UI** with streaming token-by-token responses
- **Multiple LLM providers**: local OpenAI-compatible APIs (Ollama, LM Studio, etc. — the default), Anthropic, OpenAI, and AWS Bedrock
- **Secure credential storage** via Obsidian's built-in secrets manager — API keys are never stored in plain text
- **Dynamic model selection** — query the provider's model list API and switch models without restarting
- **Customizable system prompt** — override the built-in default by editing `notor/prompts/core-system-prompt.md` in your vault
- **Conversation history** — all conversations are persisted to JSONL files and browsable from the chat panel
- **Token and cost tracking** — per-message and per-conversation token counts with optional cost estimates

### Read, write, and edit notes

Notor exposes a set of vault tools the AI can invoke during a conversation:

| Tool | What it does | Mode |
|---|---|---|
| `read_note` | Read a note's content (optionally including frontmatter) | Plan & Act |
| `write_note` | Create a new note or overwrite an existing one | Act only |
| `replace_in_note` | Surgical SEARCH/REPLACE edits within a note | Act only |
| `search_vault` | Regex/text search across notes with context lines | Plan & Act |
| `list_vault` | List vault folder structure and file metadata | Plan & Act |
| `read_frontmatter` | Read a note's YAML frontmatter as structured data | Plan & Act |
| `update_frontmatter` | Add, modify, or remove specific frontmatter keys | Act only |
| `manage_tags` | Add or remove tags via the frontmatter `tags` property | Act only |
| `fetch_webpage` | Fetch a URL and return its content as Markdown | Plan & Act |
| `execute_command` | Run a shell command and return its output | Act only |

Every tool call is displayed inline in the chat thread — name, parameters, result, and status — so you always see exactly what the AI is doing.

### Safety-first by design

- **Plan mode / Act mode** — a visible toggle in the chat input area. Plan mode restricts the AI to read-only tools; write tools are blocked at the dispatch level. Plan mode is the default for new users.
- **Diff preview** — every proposed write shows a before/after diff before being applied. Per-change accept/reject controls are available for multi-block edits.
- **Approval required** — write tools require explicit approval by default. Read-only tools default to auto-approved. Per-tool auto-approve settings are configurable in **Settings → Notor**.
- **Checkpoints** — before any write operation, the affected note is automatically snapshotted. You can preview, compare (diff), or restore any checkpoint from the conversation timeline. Checkpoint data is stored in `.obsidian/plugins/notor/checkpoints/` and is not visible as vault notes.
- **Stale-content protection** — if you edit a note while the AI has it queued for modification, Notor detects the conflict and fails the write, prompting the AI to re-read the current content before retrying.

### Vault-level instruction files

Store Markdown rule files under `notor/rules/` in your vault. Use frontmatter trigger properties to inject instructions automatically when relevant notes are in context:

- `notor-always-include: true` — always injected
- `notor-directory-include: <path>` — injected when the AI accesses a note under the given directory
- `notor-tag-include: <tag>` — injected when the AI accesses a note with the given tag

Rule files are regular Markdown notes — fully visible and editable in Obsidian. Rule file bodies support `<include_note>` tags for dynamic content injection.

### Attach notes and files to your messages

You can provide the AI with specific content directly — no `read_note` tool call required:

- **Vault note attachment** — click the attachment button or type `[[` in the chat input to open the file picker with fuzzy autocomplete. Supports section-level references (`[[Note#Section]]`) that include only the content of that heading.
- **External file attachment** — attach text files from outside your vault via the OS-native file dialog.
- **Attachment chips** — attached items appear as labeled chips in the input area before sending. Each chip can be individually removed. Attachments are deduplicated silently.
- **Graceful failures** — if an attached note is deleted or renamed after the chip is added, the message still sends without that attachment and an inline warning is shown.
- Attachment contents are embedded in the message context sent to the LLM but are not rendered in full in the chat thread (chips only).

### Ambient workspace context (auto-context)

Every message automatically includes a snapshot of your current workspace state in the system prompt — no manual effort required:

- **Open note paths** — the vault-relative paths of all notes currently open in any tab, including pinned tabs and split panes. The currently active note is marked `(active)`.
- **Vault structure** — top-level folder names at the vault root (no recursive listing, no individual file names).
- **Operating system** — your OS platform (macOS, Windows, or Linux), so the AI generates platform-appropriate shell commands without asking.

Each source can be individually enabled or disabled in **Settings → Notor**. All three are on by default.

### Web fetching

The `fetch_webpage` tool lets the AI retrieve external content:

- Fetches any `http://` or `https://` URL and converts HTML to Markdown using the Turndown library.
- Plain text and JSON responses are returned as-is. Binary and unsupported content types return a structured error.
- Configurable domain denylist — add entries in **Settings → Notor** to prevent the AI from fetching specific domains.
- Configurable size limits: raw download cap (default: 5 MB) and output character cap (default: 50,000 characters). Pages exceeding the output cap are truncated with a notice to the AI.
- Defaults to auto-approved (read-only tool, available in Plan and Act modes).

### Shell command execution

The `execute_command` tool lets the AI run commands on your system:

- Runs in your login shell on macOS/Linux (inheriting your full `PATH` via the `-l` flag) or PowerShell on Windows.
- Shell executable and arguments are user-configurable in **Settings → Notor**.
- Working directory defaults to vault root and must remain within the vault or a user-configured allow-list of absolute paths.
- Combined stdout and stderr are returned to the AI. Non-zero exit codes and timeouts are surfaced as structured errors.
- Configurable per-command timeout (default: 30 seconds) and output cap (default: 50,000 characters).
- Write tool — available in Act mode only by default; requires explicit approval unless auto-approved.

### Auto-compaction for long sessions

When a conversation approaches the active model's context window limit, Notor automatically summarizes it and continues in a new context window:

- The compaction threshold is configurable (default: 80% of the model's context window). Token usage is estimated locally — no provider API call is made.
- While summarization is in progress, a "Compacting context…" indicator appears inline in the chat thread. Chat input remains enabled.
- Once complete, the indicator is replaced by a permanent **Context compacted** marker showing the timestamp and token count at compaction.
- The AI continues seamlessly. The full conversation history is always retained in the JSONL log; compaction only affects what is sent to the LLM.
- The compaction system prompt has a built-in default and can be overridden in **Settings → Notor**.
- Manual compaction is available via the command palette (**Notor: Compact context**).

### LLM interaction hooks

Configure shell commands to fire automatically at key points in the conversation lifecycle:

| Event | When it fires | Blocking? |
|---|---|---|
| `pre-send` | After user submits a message, before it is sent to the LLM | Yes — awaited before dispatch |
| `on-tool-call` | After tool approval, immediately before tool execution | No |
| `on-tool-result` | After tool execution, before result is returned to the LLM | No |
| `after-completion` | After the LLM's full response turn completes | No |

- Hook stdout from `pre-send` hooks is sent to the LLM as a separate context message and displayed as a collapsible **Hook output** element in the chat panel (not inline in the user's message bubble).
- All hooks receive conversation metadata as environment variables: conversation UUID, hook event name, tool name/parameters/result (where applicable), and a UTC timestamp.
- Multiple hooks can be configured per event, executed sequentially in order.
- Hook failures are non-blocking — the conversation continues and a notice is surfaced.
- Configured in **Settings → Notor** under a dedicated hooks section grouped by lifecycle event (each subsection is collapsible).
- A single global hook timeout (default: 10 seconds) applies to all hook events; timed-out processes are terminated without stalling the conversation.
- Each hook action can either **execute a shell command** or **run a workflow** (see Workflows below).

### Personas

Define specialized AI personalities as notes in your vault — each persona shapes the AI's system prompt, model preferences, and approval behavior:

- **File-based persona definitions** — personas are stored as directories under `notor/personas/{persona-name}/`, each containing a `system-prompt.md` file. The note body is the persona's system prompt; frontmatter properties configure behavior.
- **System prompt modes** — set `notor-persona-prompt-mode: "append"` (default) to append the persona's prompt after the global system prompt, or `"replace"` to use only the persona's prompt as the base. Vault-level rule injections always apply regardless of this setting.
- **Provider and model overrides** — set `notor-preferred-provider` and `notor-preferred-model` in a persona's frontmatter to automatically switch the AI to a specific provider and model when that persona is active.
- **Persona picker in the chat panel** — access the persona picker from the gear icon in the chat panel header. Selecting a persona immediately updates the active system prompt and model preferences for subsequent messages. The active persona name is shown as a badge near the chat input area.
- **Provider & model identifier reference** — a reference section in **Settings → Notor** lists all configured providers and their available models with their exact identifier strings and one-click copy buttons, making it easy to fill in persona frontmatter without guessing.
- **Per-persona auto-approve overrides** — configure per-tool approval behavior per persona in **Settings → Notor → Persona auto-approve**. Each tool offers three states: *Global default* (inherit global setting), *Auto-approve*, or *Require approval*. Unconfigured tools fall back to global defaults. Configuration is stored in plugin settings data, not in persona frontmatter.
- Personas are regular Obsidian notes — fully visible in the file explorer, searchable, and editable. The plugin rescans the personas directory when Settings is opened or the persona picker is activated; no plugin reload is needed when personas are created or deleted.

### Workflows

Define reusable instruction sets as Obsidian notes that guide the AI through structured, step-by-step processes:

- **Workflow notes** — stored as Markdown notes under `notor/workflows/`, identified by `notor-workflow: true` in frontmatter. Workflow bodies are written as step-by-step instructions that shape *how the AI approaches a task*, not as conversational prompts.
- **Run manually from the command palette** — the **Notor: Run workflow** command opens a quick-pick list of all discovered workflows. Selecting one assembles the workflow prompt, resolves any `<include_note>` tags, and sends it to the LLM as a new conversation in the chat panel with full transparency: streaming responses, inline tool calls, diff previews, and approval prompts all work as normal.
- **Slash-command workflow attachment** — type `/` at the start of the Notor chat input to open a fuzzy-search autocomplete list of workflows. Selecting one inserts a chip in the input area (like a note attachment). You can type additional context alongside the chip. At most one workflow can be attached per message.
- **Workflow instructions rendering** — the `<workflow_instructions>` block injected into the conversation is rendered as a collapsed `<details>` element in the chat panel (labeled "Workflow: {name}") so it doesn't dominate the view. Click to expand and inspect the full instructions.
- **Automatic persona switching** — set `notor-workflow-persona: "{persona-name}"` in a workflow's frontmatter to automatically activate a persona when the workflow runs. The persona persists for the entire workflow conversation and reverts when the user switches to a different conversation or starts a new one.
- **Event-triggered workflows** — set `notor-trigger` in the frontmatter to one of the vault event types (see Vault event hooks below) to run the workflow automatically in response to vault events. Event-triggered workflows run in the background without interrupting the current conversation.
- **Workflow activity indicator** — a persistent indicator in the chat panel header shows the status of background workflow executions. It displays an animated state when workflows are running, a numeric badge for the count of active executions, and a dropdown listing currently running and recently completed workflows with their status (running, waiting for approval, succeeded, errored). Click any entry to open that workflow's conversation. A configurable number of recent entries are shown (default: 5, configurable in **Settings → Notor**).
- **Concurrency limit** — a configurable cap (default: 3) limits simultaneous background workflow executions. Additional triggered workflows are queued FIFO and execute as slots become available. Manually triggered workflows are not counted against this limit.
- **Per-workflow hook overrides** — define a `notor-hooks` YAML mapping in a workflow's frontmatter to override global LLM lifecycle hooks for that workflow's duration. Overridden events use the workflow-scoped hooks; non-overridden events continue using global hooks. Reverts to global hooks when the workflow ends.
- **Loop prevention** — if a hook-triggered workflow would re-trigger the same hook (e.g., an `on-tag-change` hook runs a workflow that adds tags), the cycle is detected and the re-trigger is skipped with a notice.
- Workflows are regular Obsidian notes — visible, searchable, and editable. Subdirectories under `notor/workflows/` are supported. The plugin rescans workflows on plugin load and when the workflow list is opened.

### `<include_note>` tag

Dynamically inject the contents of any vault note (or a specific section) into workflow bodies, system prompts, and vault-level rule files:

```markdown
<!-- Vault-relative path -->
<include_note path="Research/Climate.md" section="Key Findings" />

<!-- Obsidian wikilink (rename-safe, recommended) -->
<include_note path="[[Climate Research]]" section="Key Findings" />
```

- **Supported attributes:**
  - `path` (required) — vault-relative file path or `[[wikilink]]`. Wikilinks are resolved via Obsidian's standard link resolution and are automatically updated when the referenced note is renamed — the recommended form.
  - `section` (optional) — heading text to extract. Only the content from that heading to the next heading of equal or higher level is included. Omit for the full note body.
  - `mode` (optional) — `inline` (paste directly into surrounding text) or `attached` (add as a separate attachment in context). Default: `inline`. In system prompts and rule files, `inline` is always used regardless of this attribute.
  - `strip_frontmatter` (optional) — `true` (default) strips YAML frontmatter before injection; `false` includes frontmatter as-is (useful when the AI needs the note's metadata).
- **Resolution at execution time** — tags are resolved when the workflow is run or when the system prompt is assembled before each LLM API call.
- **Error markers** — if the referenced note or section is not found, the tag is replaced with an inline error marker (e.g., `[include_note error: note 'Research/Deleted.md' not found]`) that is visible to both the user and the LLM. Prompt assembly continues normally.
- **Multiple tags per document** — any number of `<include_note />` tags may appear in a single document; each resolves independently.
- **No nested resolution** — if an included note itself contains `<include_note>` tags, those tags are passed through as literal text (no recursive includes), preventing circular reference loops.

### Vault event hooks

Configure hooks that fire automatically in response to vault lifecycle events:

| Event | When it fires |
|---|---|
| `on-note-open` | A note is opened (activated) in the editor |
| `on-note-create` | A new Markdown file is created in the vault |
| `on-save` | A note is saved (manual or auto-save) |
| `on-manual-save` | A note is saved by an explicit user action (Cmd+S / Ctrl+S) — not auto-save |
| `on-tag-change` | Tags are added to or removed from a note's frontmatter |
| `on-schedule` | A configured cron schedule fires (while Obsidian is running) |

- Each hook action can either **execute a shell command** or **run a workflow**. For shell commands, event context is available as environment variables (`NOTOR_NOTE_PATH`, `NOTOR_TAGS_ADDED`, `NOTOR_TAGS_REMOVED`).
- **Debounce** — `on-note-open`, `on-save`, and `on-manual-save` hooks include a configurable cooldown (default: 5 seconds) to prevent rapid-fire execution from auto-save or tab switching.
- **Cron scheduling** — `on-schedule` hooks use cron expressions (e.g., `0 9 * * 1` for 9 AM every Monday). Scheduling is in-process (powered by the `croner` library) — no OS-level cron daemon is required. Missed executions while Obsidian is closed are skipped; no catch-up occurs.
- **Lazy listener activation** — Obsidian event listeners are only registered for event types that have at least one configured hook or workflow trigger. Removing the last hook for an event type dynamically unregisters its listener, adding zero overhead for unused event types.
- **Loop prevention** — tag changes and note creations caused by hook-triggered workflow executions do not re-trigger their corresponding hooks, preventing infinite loops.
- **Non-blocking** — hook failures surface a non-blocking notice without interrupting the triggering vault operation or preventing subsequent hooks from executing.
- Vault event hooks are configured in **Settings → Notor** under a dedicated section grouped by event type, using the same collapsible UI pattern as LLM interaction hooks.

---

## Getting started

### Requirements

- Obsidian **1.11.4** or later (desktop only)
- Node.js 18+ (for building from source)
- A running LLM provider (local or cloud)

### Install and build

```bash
git clone https://github.com/zachmueller/notor.git
cd notor
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` to your vault:

```
<Vault>/.obsidian/plugins/notor/
```

Reload Obsidian and enable **Notor** in **Settings → Community plugins**.

### Development (watch mode)

```bash
npm run dev
```

### Configure a provider

1. Open **Settings → Notor**
2. Choose a provider (defaults to local OpenAI-compatible at `http://localhost:11434/v1`)
3. Enter credentials if required (stored securely via Obsidian's secrets manager)
4. Select a model from the dropdown (or type a model ID if the list is unavailable)
5. Open the Notor chat panel from the sidebar ribbon and start a conversation

### Create your first persona

1. Create the directory `notor/personas/my-persona/` in your vault
2. Create `system-prompt.md` inside it — the body content is the persona's system prompt
3. Optionally add frontmatter:
   ```yaml
   ---
   notor-persona-prompt-mode: "append"
   notor-preferred-provider: "anthropic"
   notor-preferred-model: "claude-opus-4-5"
   ---
   ```
4. Open the Notor chat panel → click the gear icon → select your persona

### Create your first workflow

1. Create `notor/workflows/my-workflow.md` in your vault
2. Add frontmatter and write the instructions:
   ```markdown
   ---
   notor-workflow: true
   notor-trigger: manual
   notor-workflow-persona: "my-persona"
   ---
   # My workflow

   ## Step 1
   Search the vault for notes tagged #todo.

   ## Step 2
   Summarize the action items found across all matching notes.
   ```
3. Open the command palette → **Notor: Run workflow** → select your workflow

---

## Project structure

```
src/
  main.ts              # Plugin entry point and lifecycle
  types.ts             # Shared TypeScript types
  chat/                # Conversation orchestration, history, context management, system prompt
  providers/           # LLM provider integrations (Anthropic, OpenAI, Bedrock, local)
  tools/               # Vault tool implementations (including fetch_webpage, execute_command)
  checkpoints/         # Checkpoint storage and management
  context/             # Auto-context injection, attachment handling, message assembly, compaction
  hooks/               # LLM lifecycle hook configuration, execution engine, event dispatch
  personas/            # Persona discovery, activation/switching, per-persona auto-approve resolution
  workflows/           # Workflow discovery, prompt assembly, executor, concurrency management, hook parsing
  include-note/        # <include_note> tag parser and resolver (vault-relative paths and wikilinks)
  rules/               # Vault-level instruction file evaluation
  shell/               # Shell executor, shell resolver, output buffer (shared by execute_command and hooks)
  mcp/                 # MCP server hub, tool adapter, and type definitions
  settings/            # Settings interface, defaults, tab UI, per-section UI components
  ui/                  # Chat panel, diff view, approval UI, tool call display, attachment chips,
                       #   compaction markers, persona picker, workflow activity indicator,
                       #   workflow slash-command suggest
  utils/               # Logging, token utilities, secret helpers
specs/                 # Detailed specifications for each development phase
design/                # Architecture, UX, tool design, and roadmap documents
e2e/                   # End-to-end test scripts and Playwright configuration
```

---

## Design documentation

The `design/` directory contains the full medium-term vision for Notor, written to inform architectural decisions across phases. Not everything described there is implemented yet — see the roadmap for phased delivery.

| Document | Contents |
|---|---|
| [`design/README.md`](design/README.md) | Overview, design principles, and document index |
| [`design/roadmap.md`](design/roadmap.md) | Phased implementation plan (Phases 0–5) |
| [`design/architecture.md`](design/architecture.md) | LLM provider layer, context management, personas, workflows, agents, hooks, checkpoints |
| [`design/ux.md`](design/ux.md) | Chat panel, editor behavior, diff preview, transparency, and UI patterns |
| [`design/tools.md`](design/tools.md) | Built-in tool definitions, web fetching, shell access, and custom MCP tool extensibility |
| [`design/research/`](design/research/) | Pre-implementation research findings (secrets manager, vault API, system prompt design, LLM model APIs) |

### Roadmap summary

| Phase | Description | Status |
|---|---|---|
| **Phase 0** | Foundation: LLM providers, chat panel, streaming, system prompt, credentials | ✅ Complete |
| **Phase 1** | Core note operations: read/write/search/list tools, diff preview, Plan/Act mode, auto-approve | ✅ Complete |
| **Phase 2** | Trust & observability: checkpoints/rollback, token tracking, chat history, frontmatter & tag tools, vault rules | ✅ Complete |
| **Phase 3** | Context & intelligence: note/file attachment, auto-context injection, auto-compaction, web fetching, shell execution, LLM interaction hooks | ✅ Complete |
| **Phase 4** | Workflows & personas: file-based personas, reusable workflow notes, `<include_note>` tag, vault event hooks | ✅ Complete |
| **Phase 5** | Advanced & multi-agent: parallel agents, agent monitor panel, background agents, custom MCP tools, browser capabilities | 🔜 Planned |

---

## Design principles

1. **Notes first.** Every feature serves the goal of helping users write, organize, and connect their notes.
2. **Transparency.** Every tool call and its result is surfaced inline in the chat thread.
3. **Safety by default.** Destructive operations require approval unless explicitly auto-approved. Checkpoints enable rollback. Plan mode prevents accidental edits.
4. **Local and private.** No telemetry. Network calls only to user-configured LLM provider endpoints (and user-initiated `fetch_webpage` requests).
5. **Composable.** Personas, workflows, hooks, and tools are modular building blocks.
6. **Progressive disclosure.** Core features work out of the box. Advanced features are available but not required.

---

## Releasing

1. Update `version` in `manifest.json` (SemVer, no `v` prefix).
2. Update `versions.json` to map the new plugin version to the minimum Obsidian version.
3. Run `npm run build` to produce `main.js`.
4. Create a GitHub release with the version number as the tag.
5. Attach `manifest.json`, `main.js`, and `styles.css` as release assets.

> You can automate the version bump with `npm version patch|minor|major` after manually updating `minAppVersion` in `manifest.json`.

---

## References

- [Obsidian API documentation](https://docs.obsidian.md)
- [Developer policies](https://docs.obsidian.md/Developer+policies)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
- [Obsidian sample plugin](https://github.com/obsidianmd/obsidian-sample-plugin)
