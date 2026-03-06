# Notor MVP

**Created:** 2026-04-03
**Status:** Draft
**Branch:** feature/mvp

## Overview

Notor is an Obsidian community plugin that brings AI-powered assistance directly into the note editing workflow. The MVP delivers a functional AI chat panel integrated into Obsidian with the ability to read, search, create, and surgically edit notes in the user's vault — with full transparency into every AI action, a safety-first approval model, diff previews for proposed changes, and rollback capabilities via checkpoints. The MVP establishes the complete foundation (LLM provider integration, chat UI, streaming, system prompt) and layers on the core note editing tools, trust mechanisms, and observability features needed to make Notor genuinely useful and trustworthy for day-to-day knowledge work.

This specification covers three roadmap phases that together form the MVP:

- **Phase 0 — Foundation & infrastructure**: LLM provider integration, chat panel, streaming, system prompt, credential management.
- **Phase 1 — Core note operations**: vault tools (read, write, search, list), diff preview, Plan/Act mode, auto-approve, tool transparency.
- **Phase 2 — Trust, safety & observability**: checkpoints/rollback, token and cost tracking, chat history persistence, note metadata tools, vault-level instruction files.

## User stories

### Foundation & chat (Phase 0)

- As a note writer, I want to chat with an AI assistant inside Obsidian so that I can get help with my notes without leaving the app.
- As a user with a local LLM, I want to connect Notor to my locally-hosted model (Ollama, LM Studio, etc.) so that my notes never leave my machine.
- As a user with cloud LLM access, I want to connect Notor to Anthropic, OpenAI, or AWS Bedrock so that I can use the model of my choice.
- As a privacy-conscious user, I want my API keys and credentials stored securely so that they are not exposed in plain-text configuration.
- As a user, I want to see AI responses stream in token-by-token so that I get immediate feedback rather than waiting for a complete response.
- As a power user, I want to customize the AI's system prompt so that I can shape its behavior for my specific note-writing workflow.

### Core note operations (Phase 1)

- As a note writer, I want the AI to read my notes so that it can understand my existing content and give contextual advice.
- As a note writer, I want the AI to create new notes so that it can help me draft content from scratch.
- As a note writer, I want the AI to make targeted edits to specific sections of a note so that it can improve my writing without rewriting the entire note.
- As a researcher, I want the AI to search across my vault so that it can find relevant information scattered across many notes.
- As a user, I want to see exactly what the AI is reading, searching, and modifying so that I always know what's happening in my vault.
- As a user, I want to preview proposed changes as a diff before they're applied so that I can accept or reject each change.
- As a cautious user, I want a Plan mode that restricts the AI to read-only operations so that I can explore ideas without risk of unintended edits.
- As a user who trusts certain operations, I want to auto-approve specific tools so that I'm not prompted for every operation.

### Trust, safety & observability (Phase 2)

- As a user, I want automatic snapshots before any note is modified so that I can roll back to a previous state if something goes wrong.
- As a user, I want to preview and restore any checkpoint so that I have full control over reverting changes.
- As a cost-conscious user, I want to see token consumption and estimated cost per message and per conversation so that I can monitor my usage.
- As a user, I want my conversation history persisted so that I can review past interactions.
- As a user, I want the AI to read and modify note frontmatter and tags as structured data so that metadata operations are safe and precise.
- As a power user, I want to create instruction files that automatically inject context into the AI based on which notes I'm working with so that the AI follows my conventions without me repeating them.

## Functional requirements

### FR-1: LLM provider integration

**Description:** A provider-agnostic integration layer that allows Notor to communicate with multiple LLM services through a uniform interface.

**Acceptance criteria:**
- Users can configure and switch between at least four provider types: local OpenAI-compatible API (default), AWS Bedrock, Anthropic API, and OpenAI API.
- Each provider has its own configuration surface: endpoint URL (for local), API key (for Anthropic/OpenAI), AWS region and credential method for Bedrock (see FR-2).
- The active provider and model can be changed from the chat panel without navigating to settings.
- If a provider is unreachable or credentials are invalid, the user receives a clear error message in the chat panel.
- The provider interface is extensible so that additional providers can be added in the future without changing the core chat system.

### FR-2: Credential and secret management

**Description:** Secure storage of LLM provider credentials using Obsidian's built-in secrets manager API.

**Acceptance criteria:**
- API keys, access tokens, and other sensitive credentials are stored via Obsidian's secrets manager — not in plain-text plugin data files.
- Per-provider credential configuration is available in settings (API keys for Anthropic/OpenAI, optional API key for local provider).
- AWS Bedrock supports two credential methods (user chooses one): (a) AWS profile name — delegates to the AWS SDK credential chain (`~/.aws/credentials`, environment variables, SSO, etc.); (b) direct access key ID + secret access key stored in Obsidian's secrets manager. The selected region is stored as a non-secret setting.
- Credentials can be updated or removed from settings at any time.

### FR-3: Model selection

**Description:** Users can choose which model variant to use within a given provider.

**Acceptance criteria:**
- The settings and chat panel expose available models for the active provider via a dropdown populated by querying the provider's model list API (e.g., `/v1/models` for OpenAI-compatible and local providers; `GET /v1/models` with cursor-based pagination for Anthropic; `ListInferenceProfilesCommand` with `typeEquals: "SYSTEM_DEFINED"` for AWS Bedrock).
- If the model list API is unavailable or returns an error, the dropdown falls back to a free-text input field where the user can type or paste any model ID.
- A refresh button allows re-fetching the model list on demand.
- The user can switch models without restarting the plugin or starting a new conversation.
- The selected model is persisted across plugin reloads.

### FR-4: Chat panel

**Description:** A side panel within Obsidian that serves as the primary interaction surface for conversing with the AI.

**Acceptance criteria:**
- The chat panel is an Obsidian leaf view that can be positioned on any side of the workspace.
- A text input area at the bottom accepts user messages, with a send button.
- Enter sends the message; Shift+Enter inserts a new line.
- While the AI is responding (streaming or awaiting tool approval), the send button is disabled and a "Stop" button is displayed to cancel the current response.
- After the response completes or is cancelled, the send button is re-enabled.
- A settings button (gear icon) in the panel header provides quick access to provider, model, and (in future) persona selection.
- The panel displays the full conversation history for the current conversation.
- User messages and AI responses are visually distinct.
- A "New conversation" button is available to start a fresh conversation.
- A conversation list/selector allows browsing and switching between existing conversations.
- The conversation list shows conversations ordered by most recent activity.
- When the conversation approaches the active model's context window limit, a visible warning is displayed and the oldest messages are truncated (keeping the system prompt and most recent messages) to fit within the limit. The full conversation history is still retained in the persisted JSONL log; only the context sent to the LLM is trimmed.

### FR-5: Streaming responses

**Description:** AI responses are displayed token-by-token as they are generated, providing immediate feedback.

**Acceptance criteria:**
- Responses render incrementally in the chat panel as tokens arrive from the provider.
- The streaming display supports Markdown formatting (rendered progressively or on completion).
- If the provider does not natively support streaming, a buffering adapter simulates the streaming interface so the UI behavior is consistent.
- The user can see that a response is in progress (e.g., a loading/typing indicator).

### FR-6: System prompt configuration

**Description:** A built-in default system prompt with user-customizable override via a Markdown file in the vault.

**Acceptance criteria:**
- Notor ships with an internal default system prompt tailored for note writing and knowledge management assistance.
- A "Customize system prompt" action in settings writes the default prompt to `{notor_dir}/prompts/core-system-prompt.md` for user editing.
- If `{notor_dir}/prompts/core-system-prompt.md` exists, the plugin uses its body content (stripping any frontmatter) as the system prompt. Otherwise, the internal default is used.
- The system prompt file is a regular Markdown note visible in the vault's file explorer and editable like any other note.

### FR-7: `read_note` tool

**Description:** Read the contents of a note in the vault.

**Acceptance criteria:**
- Accepts a vault-relative path and an optional flag to include/exclude YAML frontmatter.
- Returns the note content as a string.
- Defaults to excluding frontmatter when the flag is not specified.
- Uses Obsidian's vault API (not raw filesystem access).
- Classified as read-only — available in both Plan and Act modes.

### FR-8: `write_note` tool

**Description:** Create a new note or overwrite an existing note's entire content.

**Acceptance criteria:**
- Accepts a vault-relative path and the complete content to write.
- Creates intermediate directories if they don't exist.
- Uses Obsidian's vault API.
- Triggers a checkpoint snapshot of the existing note before writing (when checkpoints are available in Phase 2).
- Classified as write — available in Act mode only, blocked in Plan mode.
- Requires user approval unless auto-approved.

### FR-9: `replace_in_note` tool

**Description:** Make targeted edits within a note using SEARCH/REPLACE blocks for surgical editing without rewriting the entire note.

**Acceptance criteria:**
- Accepts a vault-relative path and an array of `{ search, replace }` blocks.
- Each search string matches a contiguous block of text exactly (character-for-character including whitespace).
- Each block replaces only the first occurrence of the search text.
- Multiple blocks are applied in sequence (order matters).
- An empty replace string deletes the matched text.
- If any search block fails to match, the entire operation fails and no changes are applied (atomic operation).
- Triggers a checkpoint snapshot before applying (when checkpoints are available in Phase 2).
- Classified as write — available in Act mode only, blocked in Plan mode.

### FR-10: `search_vault` tool

**Description:** Search across notes in the vault using regex or text patterns, returning matches with surrounding context.

**Acceptance criteria:**
- Accepts a query pattern, optional directory scope, optional context line count (default 3), and optional file glob pattern (default `*.md`).
- Returns matches grouped by file, with line numbers and surrounding context lines.
- Uses Obsidian's vault API to enumerate and read files.
- Classified as read-only — available in both Plan and Act modes.

### FR-11: `list_vault` tool

**Description:** List the folder and note structure of the vault or a subdirectory.

**Acceptance criteria:**
- Accepts an optional path (defaults to vault root), optional recursive flag (defaults to non-recursive), optional limit (default 50), optional offset for pagination (default 0), and optional sort order (default `last_modified`, also supports `alphabetical`).
- Returns a structured list of files and folders with file type (note, image, attachment, etc.) and basic metadata (size, modified date).
- Includes `total_count` in the response so the caller can paginate through large directories.
- Classified as read-only — available in both Plan and Act modes.

### FR-12: Diff preview and change approval

**Description:** When the AI proposes changes via write tools, display a visual diff for user review before applying.

**Acceptance criteria:**
- Changes proposed by `write_note` or `replace_in_note` are shown as a before/after diff before being applied.
- Additions and deletions are clearly highlighted.
- For `replace_in_note` with multiple SEARCH/REPLACE blocks, per-change accept/reject controls are available.
- An "accept all" / "reject all" option is provided for bulk approval.
- When auto-approve is on for the relevant tool, changes are applied immediately but the diff is still shown in the chat thread (collapsed by default) for after-the-fact review.

### FR-13: Open notes in editor

**Description:** When Notor reads or modifies a note, the note is opened in the Obsidian editor so the user can follow along.

**Acceptance criteria:**
- Enabled by default, configurable in settings.
- When Notor reads or modifies a note, it opens the note in an Obsidian editor tab.
- If the note is already open, Notor navigates to or highlights the relevant section.

### FR-14: Plan vs Act mode

**Description:** A mode toggle that restricts tool access — Plan mode allows read-only operations; Act mode allows all operations.

**Acceptance criteria:**
- A visible toggle located next to the send button in the chat input area clearly displays the current mode.
- In Plan mode, the AI can use read-only tools (`read_note`, `search_vault`, `list_vault`, and later `read_frontmatter`) but write tools (`write_note`, `replace_in_note`, and later `update_frontmatter`, `manage_tags`) are blocked at the tool dispatch level.
- In Act mode, all tools are available subject to auto-approve settings.
- When a write tool is invoked in Plan mode, the tool dispatch returns an error message to the AI indicating the tool is unavailable in Plan mode.
- The mode state persists within a session and is clearly labeled so the user always knows which mode is active.

### FR-15: Auto-approve settings

**Description:** Per-tool configuration that allows certain tool calls to execute without manual approval.

**Acceptance criteria:**
- Each tool has an auto-approve on/off setting in **Settings → Notor**.
- When auto-approve is off for a tool, the chat panel shows an inline approval prompt (approve/reject) before executing the tool call.
- When auto-approve is on, the tool executes immediately and the call is still logged in the chat thread.
- Default auto-approve settings: read-only tools default to auto-approved; write tools default to requiring approval.

### FR-16: Tool call transparency

**Description:** Every tool invocation is displayed inline in the chat thread with full details.

**Acceptance criteria:**
- Each tool call in the conversation renders inline showing: tool name, parameters, result summary, and status indicator (pending/success/error).
- Parameters and full results are available via expand/collapse (collapsed by default for space efficiency).
- Error states are clearly surfaced with the error message visible.
- Tool calls appear in chronological order within the conversation flow.

### FR-17: Checkpoints and rollback

**Description:** An automatic snapshot system that captures note state before any write operation, enabling preview and rollback.

**Acceptance criteria:**
- Before any write tool (`write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`) is applied, the affected note's current state is automatically snapshotted.
- Checkpoints are scoped to the conversation that created them.
- A timeline of checkpoints is accessible from the chat panel for each conversation, showing timestamps and brief descriptions (e.g., "Before replace_in_note on Daily/2026-03-01.md").
- Users can preview a checkpoint (view the note content at that point) without restoring.
- Users can restore a note to a checkpoint state.
- Users can compare (diff) the current note state against a checkpoint.
- Checkpoint data is stored in the plugin directory (`.obsidian/plugins/notor/checkpoints/` by default), not as visible vault notes.
- The storage location is configurable via settings.
- A retention policy (configurable max age or count) prevents unbounded checkpoint growth. Defaults: max 100 checkpoints per conversation, 30-day retention.
- The checkpoint system is custom-built (not git-dependent).

### FR-18: Token and cost tracking

**Description:** Display token consumption and estimated cost per message and per conversation.

**Acceptance criteria:**
- Each message displays its token count (input + output tokens).
- The conversation displays a cumulative token count and estimated cost.
- Token and cost information is visible in the chat panel (e.g., footer or per-message annotation).
- Cost estimation uses configurable per-model pricing (input/output per 1K tokens).
- If no pricing is configured for a model, token counts are still displayed but cost is omitted or shown as unavailable.

### FR-19: Chat history logging

**Description:** Full conversation history persisted to disk for later review.

**Acceptance criteria:**
- Conversations are serialized in JSONL format (one JSON object per message/event).
- Each conversation is stored as a separate file, named with a timestamp and/or conversation ID.
- Default storage location is `.obsidian/plugins/notor/history/` (inside the plugin directory).
- The storage path is configurable to any vault-relative path.
- JSONL files do not appear in Obsidian's file explorer or search results (they are not recognized as notes).
- Configurable retention limits: maximum total size (MB) and/or maximum age (days). Oldest conversations are pruned when limits are exceeded. Defaults: 500 MB total size, 90-day retention.
- Users can start new conversations via the chat panel's "New conversation" button.
- Users can switch between past conversations via a conversation list in the chat panel.
- The conversation list displays conversations ordered by most recent activity with a timestamp and preview (e.g., first user message).
- Conversation rename, search, delete, and pin features are deferred beyond MVP.

### FR-20: `read_frontmatter` tool

**Description:** Read the parsed YAML frontmatter of a note as structured key-value data.

**Acceptance criteria:**
- Accepts a vault-relative path.
- Returns the frontmatter as structured data (key-value pairs), not as raw YAML text.
- If the note has no frontmatter, returns an empty result (not an error).
- Classified as read-only — available in both Plan and Act modes.

### FR-21: `update_frontmatter` tool

**Description:** Add, modify, or remove specific frontmatter properties without touching the note body content.

**Acceptance criteria:**
- Accepts a vault-relative path, an optional set of key-value pairs to add/update, and an optional list of keys to remove.
- Modifies only the specified frontmatter properties; leaves all other frontmatter keys and the note body unchanged.
- Uses Obsidian's vault API and metadata/frontmatter APIs to perform updates (not raw text manipulation).
- Triggers a checkpoint snapshot before applying.
- If the note has no frontmatter and `set` is provided, creates a frontmatter section.
- Classified as write — available in Act mode only.

### FR-22: `manage_tags` tool

**Description:** Add or remove tags on a note by operating on the frontmatter `tags` property.

**Acceptance criteria:**
- Accepts a vault-relative path, an optional list of tags to add, and an optional list of tags to remove.
- Operates on the `tags` frontmatter property specifically.
- Uses Obsidian's vault API and metadata/frontmatter APIs to perform tag updates (not raw text manipulation).
- Does not duplicate tags that already exist when adding.
- Gracefully handles removal of tags that don't exist (no error).
- Triggers a checkpoint snapshot before applying.
- Classified as write — available in Act mode only.

### FR-23: Vault-level instruction files

**Description:** Markdown files stored centrally under `{notor_dir}/rules/` that are conditionally injected into the AI's context based on frontmatter trigger properties.

**Acceptance criteria:**
- Rule files are stored under `{notor_dir}/rules/` as regular Markdown notes.
- Each rule file uses frontmatter trigger properties to control when its content is injected:
  - `notor-always-include: true` — always injected.
  - `notor-directory-include: <path>` — injected when any note accessed by tools in the current conversation has a path under the specified directory.
  - `notor-tag-include: <tag>` — injected when any note accessed by tools in the current conversation has the specified tag.
- Multiple trigger properties on the same file use OR logic (any match causes inclusion).
- "In context" is defined as notes the AI has read or modified via tools during the current conversation. Rule triggers are re-evaluated after each tool call that accesses a note.
- The file body (after stripping frontmatter) is the injected instruction content, appended to the system prompt.
- Rule files are regular Markdown notes — visible in the file explorer and editable like any vault note.

## Non-functional requirements

### NFR-1: Performance

**Description:** The plugin must be responsive and not degrade the Obsidian editing experience.

**Acceptance criteria:**
- Plugin startup (onload) completes without blocking the Obsidian UI. Heavy initialization is deferred.
- Tool execution (read, search, list) for typical vault sizes (up to 10,000 notes) completes within a few seconds.
- Streaming responses begin rendering within 1 second of the LLM starting to generate output.
- Checkpoint creation does not noticeably delay the write operation from the user's perspective.
- Vault searches and listings are not performed more frequently than necessary; expensive operations are debounced or throttled.

### NFR-2: Security and privacy

**Description:** User data stays local; credentials are stored securely; no hidden network calls or telemetry.

**Acceptance criteria:**
- No telemetry, analytics, or data collection of any kind.
- Network requests are made only to user-configured LLM provider endpoints — no other external calls.
- API keys and credentials are stored via Obsidian's secrets manager API — never in plain-text data files.
- The plugin does not access files outside the vault (except for LLM API communication).
- No remote code execution, no fetching and evaluating external scripts.

### NFR-3: Reliability and data safety

**Description:** The plugin must not corrupt or silently lose note data.

**Acceptance criteria:**
- Write operations that fail partway through do not leave notes in a corrupted state (atomic writes where possible).
- Before applying any write tool, the note's current content is compared against the content the AI last read via `read_note`. If the note has been modified since the AI's last read (by the user or another process), the write operation fails with a stale-content error, and the AI is informed to re-read the note before retrying. This prevents silently overwriting user edits.
- `replace_in_note` is fully atomic: if any search block fails to match, no changes are applied.
- Checkpoints ensure every write operation can be rolled back.
- Plugin unload cleanly removes all registered listeners, intervals, and DOM elements — no resource leaks.

### NFR-4: Compatibility

**Description:** The plugin works across Obsidian's supported platforms.

**Acceptance criteria:**
- The plugin works on macOS, Windows, and Linux desktop.
- Mobile compatibility (iOS/Android) is a goal but not a hard requirement for MVP; the plugin does not use desktop-only APIs unless necessary.
- The `isDesktopOnly` manifest flag is set accurately based on the APIs used.

### NFR-5: Usability

**Description:** The plugin is usable out of the box with sensible defaults.

**Acceptance criteria:**
- Read-only tools default to auto-approved; write tools default to requiring approval.
- Plan mode is the default mode for new users (safety-first).
- The default system prompt provides useful note-writing assistance without configuration.
- The local OpenAI-compatible provider is the default provider (no cloud account required).
- Error messages are user-friendly and suggest corrective actions where possible.
- UI text follows Obsidian's style guide: sentence case for headings, buttons, and titles.

## User scenarios & testing

### Primary flow: Ask the AI to edit a note

1. User opens the Notor chat panel from the Obsidian sidebar.
2. User switches to Act mode (or is already in Act mode).
3. User types: "Rewrite the introduction of my note Research/Climate.md to be more concise."
4. The AI invokes `read_note` on `Research/Climate.md`. The tool call appears inline in the chat. The note opens in the editor.
5. The AI generates a rewritten introduction and invokes `replace_in_note` with the original and replacement text.
6. A diff preview appears in the chat showing the before/after. The user reviews and clicks "Accept."
7. The change is applied. A checkpoint was automatically created before the edit.
8. The user can see the checkpoint in the conversation timeline and could restore the original if needed.

### Primary flow: Search and synthesize information

1. User asks: "What notes in my vault mention 'quarterly review'?"
2. The AI invokes `search_vault` with the query. Results appear inline showing matches with context.
3. The AI summarizes findings in its response, citing specific notes and line numbers.
4. User asks a follow-up question about a specific match; the AI invokes `read_note` to get the full note content.

### Primary flow: Create a new note from a conversation

1. User asks: "Create a new note at Projects/Website Redesign.md with an outline for a website redesign project."
2. The AI invokes `write_note` with the path and generated content.
3. A diff preview appears showing the new content (since the note doesn't exist, the "before" is empty).
4. User approves. The note is created and opened in the editor.

### Alternative flow: Plan mode prevents writes

1. User is in Plan mode and asks: "Update the tags on Research/Climate.md to include 'review-needed'."
2. The AI attempts to invoke `manage_tags`.
3. The tool dispatch blocks the call and returns an error to the AI indicating write tools are unavailable in Plan mode.
4. The AI informs the user that it cannot modify notes in Plan mode and suggests switching to Act mode.

### Alternative flow: Diff rejection

1. The AI proposes a `replace_in_note` change with multiple SEARCH/REPLACE blocks.
2. The user reviews the diff and rejects one of the changes while accepting the others.
3. Only the accepted changes are applied. A checkpoint covers the pre-edit state.

### Alternative flow: Checkpoint rollback

1. The AI makes a write operation that the user later decides was incorrect.
2. The user opens the checkpoint timeline for the conversation.
3. The user previews the checkpoint to see the note's prior state.
4. The user compares the checkpoint with the current state via diff.
5. The user restores the checkpoint, reverting the note.

### Edge case: Search with no results

1. User asks the AI to find notes about a topic.
2. `search_vault` returns zero matches.
3. The AI reports that no matching notes were found and suggests alternative search terms or offers to create a new note on the topic.

### Edge case: Concurrent user edit (stale content)

1. The user is editing `Research/Climate.md` in the Obsidian editor.
2. The AI, having previously read the note, proposes a `replace_in_note` change.
3. When the user approves (or auto-approve triggers), Notor detects the note content has changed since the AI's last read.
4. The write operation fails with a stale-content error. The AI is informed and re-reads the note to get the updated content.
5. The AI proposes a new change based on the current content.

### Edge case: Replace with no match

1. The AI invokes `replace_in_note` with a search string that doesn't match any text in the note.
2. The entire operation fails with no changes applied.
3. An error is returned to the AI, which reports the mismatch to the user.

### Edge case: Context window overflow

1. User has a long conversation that approaches the model's context window limit.
2. The chat panel displays a warning indicating that older messages will be trimmed from the AI's context.
3. The oldest messages are dropped from the context sent to the LLM, while the system prompt and recent messages are preserved.
4. The full conversation remains visible in the chat panel and persisted in the JSONL log — only the LLM context is trimmed.
5. The user can start a new conversation for a clean context if preferred.

### Edge case: Provider connection failure

1. User sends a message but the configured LLM provider is unreachable.
2. A clear error message appears in the chat panel indicating the connection failed.
3. The user can switch providers or check their configuration.

### Edge case: Vault-level rule injection

1. A rule file under `{notor_dir}/rules/` has `notor-directory-include: Research/`.
2. The user asks the AI about a note in `Research/Climate.md`.
3. The AI reads the note, which triggers the rule's directory condition.
4. The rule file's content is injected into the system prompt for subsequent messages in this context.

## Success criteria

1. **Users can have a productive AI conversation within Obsidian** — from opening the chat panel to receiving a streaming response — within 60 seconds of first enabling the plugin (assuming a provider is already running).
2. **Users can read, create, search, list, and surgically edit notes** through the AI chat without manually copying content between the chat and editor.
3. **Every AI action on the vault is visible** — users can see every tool call, its parameters, and its results inline in the conversation thread.
4. **No note modification happens without user awareness** — write operations require explicit approval (unless auto-approved) and always produce a visible diff.
5. **Users can undo any AI-made change** — every write operation is checkpointed and restorable, with preview and diff comparison.
6. **Users can monitor their LLM usage** — token counts and estimated costs are displayed per message and per conversation.
7. **Conversation history is retained** — past conversations are persisted and subject to user-configurable retention limits.
8. **Frontmatter and tags can be managed safely** — dedicated metadata tools operate on structured data without risking body content corruption.
9. **Users can inject context-aware instructions** — vault-level rule files automatically shape AI behavior based on which notes are in context.
10. **The plugin does not degrade Obsidian performance** — startup is fast, tool operations complete promptly for typical vault sizes, and the plugin unloads cleanly.

## Key entities

### Conversation
- Ordered sequence of messages (user, assistant, tool call, tool result).
- Has an associated set of checkpoints.
- Persisted as a JSONL file.
- Tracks cumulative token count and estimated cost.

### Message
- Belongs to a conversation.
- Has a role (system, user, assistant, tool_call, tool_result).
- Has content (text), timestamp, token count, and optional cost estimate.
- Tool messages include tool name, parameters, result, and status.

### Checkpoint
- Snapshot of a single note's content at a point in time.
- Scoped to a conversation.
- Has a timestamp and description.
- Supports preview, restore, and diff comparison.

### LLM Provider
- Configured connection to an LLM service.
- Has provider type, endpoint, credentials, and available models.
- One provider is active at a time.

### Tool
- Named capability the AI can invoke.
- Classified as read or write.
- Has a defined parameter schema and returns a result.
- Subject to Plan/Act mode restrictions and auto-approve settings.

### Vault-level rule
- Markdown file under `{notor_dir}/rules/`.
- Has frontmatter trigger properties controlling when it is injected.
- Body content is injected into the system prompt when conditions are met.

## Clarifications

### Session 2026-06-03

- Q: What should the default `{notor_dir}` path be? → A: `notor/` — a visible top-level vault folder (no dot prefix), so users can easily find and edit plugin-managed files like system prompts and rules.
- Q: What is the conversation lifecycle in the MVP — can users manage multiple conversations? → A: New conversation button + simple conversation list in chat panel. Users can start a new conversation, switch between existing ones, and browse past conversations. No rename, search, or pin features in MVP.
- Q: How should AWS Bedrock credentials work — AWS profile delegation, direct keys in secrets manager, or both? → A: Support both. Users can either specify an AWS profile name (delegating to the AWS SDK credential chain: `~/.aws/credentials`, env vars, SSO, etc.) or store AWS access key ID + secret access key directly in Obsidian's secrets manager. User chooses which approach per their setup.
- Q: What constitutes a note being "in context" for vault-level rule trigger evaluation? → A: Notes the AI has read or modified via tools during the current conversation. Rule triggers are evaluated against tool-accessed notes, not open editor tabs.
- Q: What happens when the user sends a message while the AI is still responding or a tool approval is pending? → A: Block input + cancel button. The send button is disabled while the AI is active (streaming or awaiting tool approval). A "Stop" button allows the user to cancel the current response. Input is re-enabled after the response completes or is cancelled.
- Q: What should happen when the conversation approaches or exceeds the model's context window limit (auto-compaction is deferred to Phase 3)? → A: Warn + truncate oldest. Show a visible warning that context is being trimmed, then drop the oldest messages (keeping system prompt and recent messages) to fit within the context window. The user can start a new conversation if they prefer a clean slate.
- Q: What should the default retention limits be for checkpoints and chat history? → A: Moderate defaults. Checkpoints: max 100 per conversation, 30-day retention. Chat history: 500 MB total size, 90-day retention. All limits are user-configurable in settings.
- Q: How should the model list be populated for each provider? → A: Dynamic fetch. Query each provider's model list API (e.g., `/v1/models` for OpenAI-compatible, Anthropic, and local providers; `ListInferenceProfiles` with `typeEquals: "SYSTEM_DEFINED"` for Bedrock) and populate a dropdown. Fall back to a free-text model ID field if the fetch fails or returns empty.
- Q: What happens if the user edits a note in the Obsidian editor while the AI proposes or applies changes to the same note? → A: Stale-content check. Before applying any write operation, compare the note's current content against what the AI last read. If the note has changed since the AI's last read, fail the operation and return an error to the AI indicating the note was modified externally, prompting it to re-read before retrying.

## Assumptions

- Users have a working LLM provider available (local or cloud) before using Notor. The plugin does not host or download models.
- The Obsidian secrets manager API is available and functional in the minimum supported Obsidian version. (Pre-implementation research required — see roadmap.)
- Obsidian's vault API provides reliable file read/write operations. The behavior of vault API writes with respect to frontmatter must be researched before finalizing `write_note` implementation. (Pre-implementation research required — see roadmap.)
- The default local provider endpoint is `http://localhost:11434/v1` (Ollama convention). Users with different setups must configure the endpoint manually.
- JSONL files stored in the plugin directory or vault are not indexed by Obsidian as notes.
- The `{notor_dir}` path defaults to `notor/` at the vault root (a visible, non-dot-prefixed folder). It is user-configurable and serves as the root for system prompt, rules, and future persona/workflow storage.

## Out of scope

The following are explicitly excluded from the MVP and deferred to later phases:

- **File/note attachment in chat** (Phase 3): attaching vault notes or external files to a message via a file picker.
- **Auto-context injection** (Phase 3): automatically injecting open note paths, vault structure, and OS info with each message.
- **Auto-compaction** (Phase 3): automatic context window summarization when approaching the token limit.
- **Web fetching (`fetch_webpage`)** (Phase 3): fetching and converting webpages to Markdown.
- **Shell command execution (`execute_command`)** (Phase 3): running shell commands from the AI.
- **LLM interaction hooks** (Phase 3): pre-send, on-tool-call, and after-completion hooks.
- **Personas** (Phase 4): named AI behavior profiles with custom system prompts and model preferences.
- **Workflows** (Phase 4): reusable structured prompting sequences stored as vault notes.
- **`<include_notes>` tag** (Phase 4): dynamic note content injection in prompts and workflows.
- **Vault event hooks** (Phase 4): on-note-open, on-save, on-tag-change, on-schedule triggers.
- **Multi-agent and background agents** (Phase 5): parallel AI conversations and persistent background tasks.
- **Agent monitor panel** (Phase 5): dashboard for monitoring running agents.
- **Custom MCP tools** (Phase 5): user-defined tools via Model Context Protocol.
- **Browser capabilities** (Phase 5): web browsing for AI research.
- **External file access** (Phase 5): reading files outside the vault.