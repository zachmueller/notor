# Notor

**A transparent, extensible AI assistant for note-taking and knowledge management in Obsidian.**

Notor brings AI-powered assistance directly into your Obsidian workflow. It gives you a full AI chat panel with the ability to read, search, create, and surgically edit notes in your vault — with full transparency into every AI action, a safety-first approval model, diff previews for proposed changes, and rollback via checkpoints.

> **Status:** Phases 0–4.1 of the roadmap implemented.

---

## What Notor can do

- **Chat with an AI inside Obsidian** — side panel chat with streaming responses, multiple LLM providers (local, Anthropic, OpenAI, AWS Bedrock), dynamic model selection, and conversation history
- **[Read, write, and edit notes](docs/vault-tools.md)** — 13 built-in tools including vault note operations, web fetching, shell command execution, and filesystem read/write with Word (`.docx`) support
- **[Safety-first approval model](docs/safety.md)** — Plan/Act mode, diff previews with per-hunk accept/reject, approval gates for write operations, and automatic checkpoints for rollback
- **[Note and file attachments](docs/context.md)** — attach vault notes (with section-level references) or external files directly to messages; ambient workspace context injected automatically
- **[Vault-level instruction files](docs/rules.md)** — store Markdown rule files under `notor/rules/` that inject instructions automatically based on note directory or tag
- **[Personas](docs/personas.md)** — file-based AI personalities with custom system prompts, model preferences, and per-persona approval overrides
- **[Workflows](docs/workflows.md)** — reusable step-by-step instruction sets stored as vault notes; run manually or triggered by vault events
- **[`<include_note>` tag](docs/include-note.md)** — dynamically inject vault note content into workflow bodies, system prompts, and rule files
- **[LLM interaction hooks](docs/hooks.md)** — shell commands or workflows that fire at key conversation lifecycle events (pre-send, on-tool-call, after-completion, etc.)
- **[Vault event hooks](docs/hooks.md#vault-event-hooks)** — hooks triggered by vault events: note open/save/create, tag changes, and cron schedules
- **[Custom MCP tool servers](docs/mcp-servers.md)** — connect stdio or HTTP MCP servers to extend the AI's tool set; uniform dispatch with Plan/Act enforcement and approval UI
- **Auto-compaction** — automatic context summarization when conversations approach the model's context window limit

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

### Configure a provider

1. Open **Settings → Notor**
2. Choose a provider (defaults to local OpenAI-compatible at `http://localhost:11434/v1`)
3. Enter credentials if required (stored securely via Obsidian's secrets manager)
4. Select a model from the dropdown (or type a model ID if the list is unavailable)
5. Open the Notor chat panel from the sidebar ribbon and start a conversation

For full setup walkthroughs — including creating your first persona, workflow, and MCP server connection — see **[docs/getting-started.md](docs/getting-started.md)**.

---

## Design principles

1. **Notes first.** Every feature serves the goal of helping users write, organize, and connect their notes.
2. **Transparency.** Every tool call and its result is surfaced inline in the chat thread.
3. **Safety by default.** Destructive operations require approval unless explicitly auto-approved. Checkpoints enable rollback. Plan mode prevents accidental edits.
4. **Local and private.** No telemetry. Network calls only to user-configured LLM provider endpoints (and user-initiated `fetch_webpage` requests).
5. **Composable.** Personas, workflows, hooks, and tools are modular building blocks.
6. **Progressive disclosure.** Core features work out of the box. Advanced features are available but not required.

---

## Roadmap

| Phase | Description | Status |
|---|---|---|
| **Phase 0** | Foundation: LLM providers, chat panel, streaming, system prompt, credentials | ✅ Complete |
| **Phase 1** | Core note operations: read/write/search/list tools, diff preview, Plan/Act mode, auto-approve | ✅ Complete |
| **Phase 2** | Trust & observability: checkpoints/rollback, token tracking, chat history, frontmatter & tag tools, vault rules | ✅ Complete |
| **Phase 3** | Context & intelligence: note/file attachment, auto-context injection, auto-compaction, web fetching, shell execution, LLM interaction hooks | ✅ Complete |
| **Phase 4** | Workflows & personas: file-based personas, reusable workflow notes, `<include_note>` tag, vault event hooks | ✅ Complete |
| **Phase 4.1** | Custom MCP servers: stdio/SSE/Streamable HTTP transports, tool discovery, uniform dispatch, read/write classification, Plan/Act signaling, auto-approve, chat panel status indicator | ✅ Complete |
| **Phase 4c** | Word & file tools: `read_file`, `read_docx`, `write_docx` with optional template grafting; shared path-validation utility; settings UI | ✅ Complete |
| **Phase 5** | Advanced & multi-agent: parallel agents, agent monitor panel, background agents, browser capabilities | 🔜 Planned |

---

## Project structure

```
src/
  main.ts              # Plugin entry point and lifecycle
  types.ts             # Shared TypeScript types
  chat/                # Conversation orchestration, history, context management, system prompt
  providers/           # LLM provider integrations (Anthropic, OpenAI, Bedrock, local)
  tools/               # Vault tool implementations (including fetch_webpage, execute_command, read_file, read_docx, write_docx)
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
  utils/               # Logging, token utilities, secret helpers, shared path-validation
specs/                 # Detailed specifications for each development phase
design/                # Architecture, UX, tool design, and roadmap documents
e2e/                   # End-to-end test scripts and Playwright configuration
```

---

## Design documentation

The `design/` directory contains the full medium-term vision for Notor, written to inform architectural decisions across phases. Not everything described there is implemented yet — see the roadmap above for phased delivery.

| Document | Contents |
|---|---|
| [`design/README.md`](design/README.md) | Overview, design principles, and document index |
| [`design/roadmap.md`](design/roadmap.md) | Phased implementation plan (Phases 0–5) |
| [`design/architecture.md`](design/architecture.md) | LLM provider layer, context management, personas, workflows, agents, hooks, checkpoints |
| [`design/ux.md`](design/ux.md) | Chat panel, editor behavior, diff preview, transparency, and UI patterns |
| [`design/tools.md`](design/tools.md) | Built-in tool definitions, web fetching, shell access, and custom MCP tool extensibility |
| [`design/research/`](design/research/) | Pre-implementation research findings (secrets manager, vault API, system prompt design, LLM model APIs) |

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
