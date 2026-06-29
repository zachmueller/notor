# Notor

**A transparent, extensible AI assistant for note-taking and knowledge management in Obsidian.**

Notor gives you a full AI chat panel inside Obsidian with the ability to read, search, create, and surgically edit notes in your vault. Every AI action is visible inline, write operations require approval by default, and automatic checkpoints let you roll back any change. Bring your own LLM — local or cloud — and keep your data under your control.

---

## What Notor can do

### Chat and context

- **Side-panel AI chat** with streaming responses, conversation history, [model presets](docs/model-presets.md) for quick switching between providers/models, [conversation forking and favorites](docs/export-import.md), [export/import](docs/export-import.md) to HTML or Markdown, find-in-messages search (via command palette), and per-message copy and context menu actions
- **[Attach notes and files](docs/context.md)** directly to messages — vault notes (with section-level references like `[[Note#Section]]`), external files (including `.docx`), images, and PDFs. Ambient workspace context (open notes, vault structure, OS) is injected automatically.
- **Auto-compaction** — automatic context summarization when conversations approach the model's context window limit
- **Multiple LLM providers** — local OpenAI-compatible endpoints (Ollama, LM Studio), Anthropic, OpenAI, and AWS Bedrock

### Vault tools

- **[32 built-in tools](docs/vault-tools.md)** — read, write, search, and move notes; manage frontmatter and tags; follow backlinks and outlinks; apply templates (Templater and core Templates); interact with Obsidian's Web Viewer; search the web (DuckDuckGo by default; Tavily, Brave, SerpAPI, Kagi with API keys) and fetch pages; run shell commands; read, write, and import filesystem files and Word documents (`.docx`)
- **[Safety-first approval model](docs/safety.md)** — Plan/Act mode toggle, diff previews with per-hunk accept/reject, approval gates for write operations, and automatic checkpoints for rollback
- **[Sub-agents](docs/sub-agents.md)** — the AI can spawn focused child conversations for vault search, web research, or custom tasks with isolated context and default-deny tool access

### Customization and automation

- **[Personas](docs/personas.md)** — file-based AI personalities with custom system prompts, model preferences, and per-persona approval overrides
- **[Workflows](docs/workflows.md)** — reusable step-by-step instruction sets stored as vault notes; run manually, via slash-command, or triggered by vault events and cron schedules
- **[Orchestration](docs/orchestration.md)** — multi-step, event-driven flows that coordinate LLM "conversation steps" and deterministic "code steps" to a terminal event, with cascading guardrails (depth, iterations, cost, runtime), crash recovery, composition, and a unified run-tree view. Gated behind a feature toggle; off by default.
- **[Rules](docs/rules.md)** — vault-level instruction files that inject context automatically based on note directory or tag
- **[Hooks](docs/hooks.md)** — shell commands or workflows that fire at conversation lifecycle events (pre-send, on-tool-call, after-completion) and vault events (note open/save/create, tag changes, cron schedules)
- **[`<include_note>` tag](docs/include-note.md)** — dynamically inject vault note content into workflow bodies, system prompts, and rule files
- **[System prompt customization](docs/system-prompt.md)** — export and customize the base system prompt with template variables and dynamic section markers

### Knowledge memory

- **[Persistent memory](docs/memory.md)** — Notor automatically recalls relevant context at conversation start, captures durable insights after each turn, and consolidates memories on a schedule. Memory notes are stored as standard vault notes — fully visible, searchable, and editable.

### Extensibility

- **[MCP tool servers](docs/mcp-servers.md)** — connect local (stdio) or remote (SSE, Streamable HTTP) MCP servers to extend the AI's tool set with uniform Plan/Act enforcement and approval UI
- **[User-defined extensions](docs/extensions.md)** — create custom tools and automations as Markdown files in your vault with TypeScript/JavaScript code fences, per-extension settings with auto-generated UI, and full access to Obsidian APIs

---

## Getting started

### Requirements

- Obsidian **1.11.4** or later (desktop only)
- A running LLM provider (local or cloud)

### Install via BRAT (recommended)

[BRAT](https://tfthacker.com/BRAT) (Beta Reviewer's Auto-update Tool) is an Obsidian community plugin that installs and updates plugins directly from GitHub.

1. Install **BRAT** from **Settings → Community plugins → Browse** and enable it
2. Open the command palette (Ctrl/Cmd+P) and run **BRAT: Add a beta plugin for testing**
3. Paste the repository path `zachmueller/notor` and click **Add Plugin**
4. Go to **Settings → Community plugins**, refresh the list, and enable **Notor**

BRAT can also keep the plugin up to date automatically — enable auto-updates in **Settings → Obsidian42-BRAT**, or run **BRAT: Check for updates to all beta plugins and UPDATE** from the command palette at any time.

### Install from source

Requires Node.js 18+.

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
4. Configure model presets in **Settings → Notor → Models** — assign a provider and model to at least one preset (e.g., `medium`). See [docs/model-presets.md](docs/model-presets.md).
5. Open the Notor chat panel via the command palette (**Notor: Open chat panel**) and start a conversation

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
  presets/             # Model preset resolution and stale detection
  personas/            # Persona discovery, activation/switching, per-persona auto-approve resolution
  workflows/           # Workflow discovery, prompt assembly, executor, concurrency management, hook parsing
  include-note/        # <include_note> tag parser and resolver (vault-relative paths and wikilinks)
  rules/               # Vault-level instruction file evaluation
  shell/               # Shell executor, shell resolver, output buffer (shared by execute_command and hooks)
  mcp/                 # MCP server hub, tool adapter, and type definitions
  sub-agents/          # Sub-agent profile discovery, manager, built-in profiles, preamble, semaphore
  extensions/          # User-defined tool, automation, and chat block runtime: discovery, parsing,
                       #   compilation, settings, built-in scaffolds
examples/              # Community gallery: extension examples, workflow templates, orchestrations,
                       #   persona examples, rule examples
  memory/              # Evergreen memory note format, dedup cache, concept resolver
  settings/            # Settings interface, defaults, tab UI, per-section UI components
  template-vars/       # Template variable registry and built-in variable definitions
  ui/                  # Chat panel, chat blocks, diff view, approval UI, tool call display,
                       #   attachment chips, compaction markers, persona picker,
                       #   workflow activity indicator, workflow slash-command suggest
  utils/               # Logging, token utilities, secret helpers, shared path-validation
specs/                 # Detailed specifications for each development phase
design/                # Architecture, UX, tool design, and roadmap documents
e2e/                   # End-to-end test scripts and Playwright configuration
```

---

## Design documentation

The `design/` directory contains the full medium-term vision for Notor, written to inform architectural decisions. Not everything described there is implemented yet.

| Document | Contents |
|---|---|
| [`design/README.md`](design/README.md) | Overview, design principles, and document index |
| [`design/roadmap.md`](design/roadmap.md) | Phased implementation plan (Phases 0–5) |
| [`design/architecture.md`](design/architecture.md) | LLM provider layer, context management, personas, workflows, agents, hooks, checkpoints |
| [`design/ux.md`](design/ux.md) | Chat panel, editor behavior, diff preview, transparency, and UI patterns |
| [`design/tools.md`](design/tools.md) | Built-in tool definitions, web fetching, shell access, and custom MCP tool extensibility |
| [`design/user-defined-tools.md`](design/user-defined-tools.md) | User-defined extension system: vault-authored tools, automations, shared settings, runtime context, compilation pipeline |
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
