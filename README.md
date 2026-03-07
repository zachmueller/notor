# Notor

**A transparent, extensible AI assistant for note-taking and knowledge management in Obsidian.**

Notor brings AI-powered assistance directly into your Obsidian workflow. It gives you a full AI chat panel with the ability to read, search, create, and surgically edit notes in your vault — with full transparency into every AI action, a safety-first approval model, diff previews for proposed changes, and rollback via checkpoints.

> **Status:** Phases 0–3 of the roadmap implemented.

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

Rule files are regular Markdown notes — fully visible and editable in Obsidian.

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

---

## Project structure

```
src/
  main.ts              # Plugin entry point and lifecycle
  settings.ts          # Settings interface and defaults
  types.ts             # Shared TypeScript types
  chat/                # Conversation orchestration, history, context management, system prompt
  providers/           # LLM provider integrations (Anthropic, OpenAI, Bedrock, local)
  tools/               # Vault tool implementations (including fetch_webpage, execute_command)
  checkpoints/         # Checkpoint storage and management
  context/             # Auto-context injection, attachment handling, message assembly, compaction
  hooks/               # LLM lifecycle hook configuration, execution engine, event dispatch
  rules/               # Vault-level instruction file evaluation
  shell/               # Shell executor, shell resolver, output buffer (shared by execute_command and hooks)
  ui/                  # Chat panel, diff view, approval UI, tool call display, attachment chips, compaction markers
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
| **Phase 4** | Workflows & personas: file-based personas, reusable workflow notes, `<include_notes>` tag, vault event hooks | 🔜 Planned |
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