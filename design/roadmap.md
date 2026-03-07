# Roadmap

Phased implementation plan for Notor. Phases 0–1 form the MVP. Later phases add power features, each building on the foundations laid before it.

---

## Phase 0 — Foundation & infrastructure

*Get the plumbing working before any AI features.*

- **Plugin architecture**: settings framework, lifecycle management, logging (partially complete)
- **LLM provider integration**: abstraction layer supporting multiple providers
  - Local LLM via OpenAI-compatible API (Ollama, LM Studio, etc.) — **default provider**. Expects the LLM is hosted by a separate application on the user's machine; Notor connects to it via HTTP API, not by hosting the model itself.
  - AWS Bedrock (with named AWS profile support for SSO, assumed roles, and credential chain resolution)
  - Anthropic API (direct)
  - OpenAI API (direct)
  - Provider-agnostic interface so additional providers can be added later
- **Credential and secret management**: credentials stored via Obsidian's built-in secrets manager API (added in recent Obsidian releases), with per-provider configuration for API keys, endpoints, regions, and AWS profile names
- **Model selection**: choose model variant within a given provider
- **Basic chat panel UI**: side panel with message input, send button, streaming response display
- **System prompt configuration**: built-in default system prompt, with "Customize system prompt" action that writes the default to `{notor_dir}/prompts/core-system-prompt.md` for user editing. Plugin uses the file if present, otherwise falls back to the internal default. The default system prompt should be purpose-built for note writing and knowledge management contexts.
- **Streaming responses**: token-by-token display as LLM generates output

## Phase 1 — Core note operations (MVP)

*The minimum to be useful as an AI note editor.*

- **`read_note`**: read note contents via Obsidian API, with option to include/exclude frontmatter
- **`write_note`**: create new notes or overwrite existing notes via Obsidian API
- **`replace_in_note`**: targeted SEARCH/REPLACE edits within a note (surgical editing without rewriting the whole note)
- **`search_vault`**: regex/text search across notes with surrounding context lines
- **`list_vault`**: list folder structure and notes within the vault
- **Diff preview UI**: show proposed changes as a diff, with accept/reject per change
- **Open notes in editor**: when the AI reads or modifies a note, open it in the Obsidian editor so the user can follow along
- **Plan vs Act mode**: toggle that restricts tool access — Plan mode can read but not write/modify
- **Basic auto-approve settings**: global per-tool auto-approve configuration
- **Tool use transparency**: display each tool call (name, parameters, results) inline in the chat thread

## Phase 2 — Trust, safety & observability

*Build user confidence before adding power features.*

- **Checkpoints / rollback**: custom-built checkpoint system allowing users to snapshot and restore note state at any point during a conversation. Stored in the plugin directory (`.obsidian/plugins/notor/checkpoints/`) by default, with configurable storage location.
- **Token and cost tracking**: display token consumption and estimated cost per message and per conversation
- **Chat history logging**: persist full conversation history in JSONL format. Defaults to `.obsidian/plugins/notor/history/`, configurable to any vault-relative path. JSONL files are not recognized by Obsidian as notes, so they don't appear in the file explorer.
- **Note metadata operations**: dedicated support for frontmatter read/write, tag management, alias operations — beyond raw text manipulation
- **Vault-level instruction files**: centrally stored Markdown files under `{notor_dir}/rules/` with frontmatter trigger properties (`notor-always-include`, `notor-directory-include`, `notor-tag-include`) that conditionally inject instruction content into context

## Phase 3 — Context & intelligence

*Make the AI smarter about what's in the vault.*

- **File/note attachment in chat**: file picker supporting vault notes (with `[[wikilink]]` auto-completion and section header references to attach partial content) and files outside the vault
- **Auto-context injection**: automatically provide open note paths (all leaf/tab views) and top-level vault directory listing with each message (no full note contents or file listings auto-injected)
- **Auto-compaction**: configurable, deterministic context window management — trigger summarization at the plugin level, pass summary as new conversation starting point
- **Web-to-Markdown fetching (`fetch_webpage`)**: built-in tool that fetches a webpage by URL and converts its HTML to Markdown using Turndown (bundled into the plugin) for token-efficient consumption in the LLM context window. Includes a user-configurable domain denylist for blocking untrusted sources. Returns converted Markdown content in the tool result (does not write to notes directly). Read-only tool, available in both Plan and Act modes.
- **Shell command execution**: cross-platform command execution tool with configurable restrictions in Plan vs Act mode
- **Hooks — LLM interaction hooks**: event-driven callbacks tied to four points in the LLM chat lifecycle — `pre-send` (before message dispatch), `on-tool-call` (after approval, before execution), `on-tool-result` (after execution, before result returned to LLM), and `after-completion` (after the full response turn). The sole Phase 3 hook action is **execute a shell command**; hook shell commands are approved at configuration time (no per-execution prompt). `pre-send` hook stdout is sent to the LLM as a separate collapsible message, not merged into the user's message bubble. Hook configuration via workflow frontmatter is deferred to Phase 4.

## Phase 4 — Workflows & personas

*Structured, reusable AI interactions.*

- **Notor root directory**: user-configured directory within the vault (`{notor_dir}/`) serving as the central location for workflows, personas, and configuration
- **Workflow notes**: workflow definitions stored as notes under `{notor_dir}/workflows/`, with frontmatter properties driving behavior (triggers, scheduling, conditions, persona assignment via `notor-workflow-persona`)
- **`<include_notes>` tag**: dynamically inject note contents (or note sections) into context. Supported in workflow notes (inline and attached modes), system prompts (global and persona), and vault-level rule files (inline mode only).
- **Basic persona system**: file-based personas stored under `{notor_dir}/personas/{persona_name}/system-prompt.md`, with frontmatter for config (model preference, prompt mode — append or replace global prompt), selectable from the chat panel. A "Provider & model identifiers" reference in Settings provides copyable identifier strings for configuring `notor-preferred-provider` and `notor-preferred-model`.
- **Per-persona auto-approve overrides**: persona-level auto-approve settings managed via a dedicated Settings UI sub-page (**Settings → Notor → Persona auto-approve**) that override global defaults when a persona is active, with three-state per-tool selectors and stale tool name warnings
- **Hooks — vault event hooks**: hooks tied to vault events (on-note-open, on-save, on-tag-change, on-schedule) for triggering workflows or LLM interactions

## Phase 5 — Advanced & multi-agent

*Power features for advanced users.*

- **Multi-agent parallel execution**: multiple concurrent AI context windows, with UI to switch between active agent workstreams
- **Agent monitor panel**: a dedicated Obsidian panel (separate from the main chat panel) providing an at-a-glance dashboard of all running agents — status, current task, progress. Clicking on an agent opens its conversation in the main Notor chat panel with full chat capabilities (stop, redirect, review history, etc.). Users can position the monitor panel alongside the chat panel for concurrent visibility.
- **Background agents**: persistent agents operating within Obsidian on user-defined tasks (e.g., continuous research, finding connections between notes, monitoring for patterns)
- **Extended persona capabilities**: per-persona tool access restrictions and vault scope limitations
- **Browser capabilities**: web browsing for AI research, ideally integrated with Obsidian Web Viewer so browsing is visible in the editor
- **External file access**: ability to read/attach files outside the vault
- **Custom MCP tool support**: user-defined MCP tools beyond the built-in set (exploring both externally-run and Obsidian-native execution). Includes optional read/write classification per MCP tool for Plan/Act enforcement, and Plan/Act state signaling to MCP servers.
- **Agent resource limits**: configurable caps on chat history retention (by size or age), concurrency limits for parallel agents

---

## Research tasks

The following research items must be completed before their respective implementation phases can begin. Each item should produce findings documented under `design/research/`.

### Pre-Phase 0 (blocking foundation)

- **Obsidian secrets manager API**: deep dive into Obsidian's built-in secrets manager functionality (added in recent Obsidian releases). Determine the API surface — how plugins store, retrieve, and delete secrets; any per-platform behavior differences; limitations on secret size or format; and how this integrates with the plugin settings lifecycle. This directly affects how Notor manages LLM provider credentials (API keys, access tokens, endpoints). Output: `design/research/obsidian-secrets-manager.md`.

- **System prompt design — learning from Cline**: review Cline's system prompt architecture and components (role definition, tool instructions, behavioral constraints, output formatting, context injection patterns). Analyze which patterns are transferable to a note writing and knowledge management context vs. a software development context. Identify what a well-crafted default system prompt for Notor should include (e.g., note editing conventions, vault-aware behaviors, Markdown formatting standards, safety guardrails). Output: `design/research/system-prompt-design.md`.

### Pre-Phase 1 (blocking MVP)

- **Obsidian vault API and frontmatter handling**: investigate how Obsidian's vault API (`vault.create`, `vault.modify`, `vault.read`) handles file writes — specifically whether writes overwrite the entire file including frontmatter, or whether the API provides any frontmatter-aware methods. Determine the safest approach for `write_note` to avoid silently destroying frontmatter when the LLM hasn't read it. This directly affects the parameter design of `write_note` and `replace_in_note`. See [Tools — write_note](tools.md#write_note). Output: `design/research/obsidian-vault-api-frontmatter.md`.

### Pre-Phase 5 (blocking custom MCP tools)

- **MCP server integration from Obsidian plugins**: research how an Obsidian plugin (running in Electron) can discover and communicate with locally-running MCP servers. Key areas: supported transport mechanisms (stdio, HTTP/SSE, WebSocket), spawning/managing local MCP server processes from within the plugin sandbox, Electron/Node.js API constraints, and existing community patterns or libraries for MCP in Electron apps. This determines the technical approach for the custom MCP tools settings UI and runtime. See [Tools — Custom MCP tools](tools.md#custom-mcp-tools-phase-5). Output: `design/research/mcp-server-integration.md`.

- **Plan/Act state signaling mechanism for MCP tools**: research how to communicate Notor's current Plan/Act mode state to MCP tool servers so they can make cooperative decisions about write-type actions. Potential approaches include: passing mode as an extra parameter or metadata field in each tool invocation, providing it as part of MCP server initialization/configuration context, or defining a custom MCP protocol extension (e.g., a capability or queryable resource). The right approach may depend on MCP protocol conventions and what MCP server implementations can realistically consume. Findings should be incorporated into the MCP integration research output. See [Tools — MCP tool classification and Plan/Act awareness](tools.md#mcp-tool-classification-and-planact-awareness). Output: findings incorporated into `design/research/mcp-server-integration.md`.

---

## Dependency notes

- Phase 1 depends on Phase 0 (needs LLM integration and chat UI to test tools).
- Phase 2's checkpoints should ideally ship before or alongside any feature that enables bulk/automated edits.
- Phase 3's auto-context and auto-compaction build on the tool and chat infrastructure from Phases 0–1.
- Phase 4's personas and workflows build on the hooks and auto-approve systems from earlier phases.
- Phase 5's multi-agent work requires the chat history persistence from Phase 2 (separate context windows stored as separate files).