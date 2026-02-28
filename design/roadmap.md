# Roadmap

Phased implementation plan for Notor. Phases 0–1 form the MVP. Later phases add power features, each building on the foundations laid before it.

---

## Phase 0 — Foundation & infrastructure

*Get the plumbing working before any AI features.*

- **Plugin architecture**: settings framework, lifecycle management, logging (partially complete)
- **LLM provider integration**: abstraction layer supporting multiple providers
  - AWS Bedrock (priority for initial development)
  - Anthropic API (direct)
  - OpenAI API (direct)
  - Provider-agnostic interface so additional providers can be added later
- **API key and endpoint management**: secure storage of credentials, per-provider configuration
- **Model selection**: choose model variant within a given provider
- **Basic chat panel UI**: side panel with message input, send button, streaming response display
- **System prompt configuration**: built-in default system prompt, with "Customize system prompt" action that writes the default to `{notor_dir}/system-prompt.md` for user editing. Plugin uses the file if present, otherwise falls back to the internal default.
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

- **Checkpoints / rollback**: custom-built checkpoint system allowing users to snapshot and restore note state at any point during a conversation
- **Token and cost tracking**: display token consumption and estimated cost per message and per conversation
- **Chat history logging**: persist full conversation history in JSONL format to a configurable location (within or outside the vault, but structured to not clutter the file explorer)
- **Note metadata operations**: dedicated support for frontmatter read/write, tag management, alias operations — beyond raw text manipulation
- **Vault-level instruction files**: centrally stored Markdown files under `{notor_dir}/rules/` with frontmatter trigger properties (`notor-always-include`, `notor-directory-include`, `notor-tag-include`) that conditionally inject instruction content into context

## Phase 3 — Context & intelligence

*Make the AI smarter about what's in the vault.*

- **File/note attachment in chat**: file picker supporting vault notes (with `[[wikilink]]` auto-completion and section header references to attach partial content) and files outside the vault
- **Auto-context injection**: automatically provide open note paths (all leaf/tab views) and top-level vault directory listing with each message (no full note contents or file listings auto-injected)
- **Auto-compaction**: configurable, deterministic context window management — trigger summarization at the plugin level, pass summary as new conversation starting point
- **Shell command execution**: cross-platform command execution tool with configurable restrictions in Plan vs Act mode
- **Hooks — LLM interaction hooks**: hooks tied to the LLM chat lifecycle (e.g., after-completion, pre-send, on-tool-call) for automating follow-up actions

## Phase 4 — Workflows & personas

*Structured, reusable AI interactions.*

- **Notor root directory**: user-configured directory within the vault (`{notor_dir}/`) serving as the central location for workflows, personas, and configuration
- **Workflow notes**: workflow definitions stored as notes under `{notor_dir}/workflows/`, with frontmatter properties driving behavior (triggers, scheduling, conditions)
- **`<include_notes>` tag**: within workflow notes, dynamically inject note contents (or note sections) into the context window, with control over inline vs attached presentation
- **Basic persona system**: file-based personas stored under `{notor_dir}/personas/{persona_name}/system-prompt.md`, with frontmatter for config (model preference, skip-global-prompt flag), selectable from the chat panel
- **Per-persona auto-approve overrides**: persona-level auto-approve settings that override global defaults when a persona is active
- **Hooks — vault event hooks**: hooks tied to vault events (on-note-open, on-save, on-tag-change, on-schedule) for triggering workflows or LLM interactions

## Phase 5 — Advanced & multi-agent

*Power features for advanced users.*

- **Multi-agent parallel execution**: multiple concurrent AI context windows, with UI to switch between active agent workstreams
- **Background agents**: persistent agents operating within Obsidian on user-defined tasks (e.g., continuous research, finding connections between notes, monitoring for patterns)
- **Extended persona capabilities**: per-persona tool access restrictions and vault scope limitations
- **Browser capabilities**: web browsing for AI research, ideally integrated with Obsidian Web Viewer so browsing is visible in the editor
- **External file access**: ability to read/attach files outside the vault
- **Custom MCP tool support**: user-defined MCP tools beyond the built-in set (exploring both externally-run and Obsidian-native execution)
- **Agent resource limits**: configurable caps on chat history retention (by size or age), concurrency limits for parallel agents

---

## Dependency notes

- Phase 1 depends on Phase 0 (needs LLM integration and chat UI to test tools).
- Phase 2's checkpoints should ideally ship before or alongside any feature that enables bulk/automated edits.
- Phase 3's auto-context and auto-compaction build on the tool and chat infrastructure from Phases 0–1.
- Phase 4's personas and workflows build on the hooks and auto-approve systems from earlier phases.
- Phase 5's multi-agent work requires the chat history persistence from Phase 2 (separate context windows stored as separate files).