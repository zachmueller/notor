# Architecture

High-level architecture for Notor's internal systems: LLM integration, context management, personas, workflows, agents, hooks, and checkpoints.

---

## LLM provider layer

### Provider abstraction

A provider-agnostic interface that all LLM integrations implement. This allows the chat system to work identically regardless of which provider is active.

```
LLMProvider interface:
  - sendMessage(messages, tools, options) → AsyncIterable<StreamChunk>
  - listModels() → Model[]
  - getTokenCount(text) → number
  - supportsStreaming() → boolean
```

### Supported providers (Phase 0)

| Provider | Transport | Auth | Notes |
|---|---|---|---|
| **Local LLM (OpenAI-compatible)** | HTTP API | None (or optional API key) | **Default provider.** Connects to locally-hosted LLMs via OpenAI-compatible API (Ollama, LM Studio, etc.). The LLM is hosted by a separate application on the user's machine; Notor connects via HTTP, not by hosting the model itself. Default endpoint: `http://localhost:11434/v1` (Ollama). |
| **AWS Bedrock** | AWS SDK / HTTP | AWS profile (SDK credential chain) | Cloud provider. Supports named profiles from `~/.aws/config` and `~/.aws/credentials`, including SSO sessions, assumed roles, and static IAM keys. |
| **Anthropic** | HTTP API | API key | Direct Claude API access |
| **OpenAI** | HTTP API | API key | GPT models + compatible endpoints |

The interface should be extensible so additional providers (Azure OpenAI, Google Vertex, etc.) can be added later without changing the core chat system.

### Configuration

- Per-provider settings: endpoint URL (if customizable), authentication credentials, region (for Bedrock), AWS profile name (for Bedrock — defaults to the `default` profile if not specified, following the same convention as the `aws` CLI).
- **Credential storage**: credentials (API keys, access tokens) stored via **Obsidian's built-in secrets manager API** — not in plain-text plugin data. The secrets manager provides secure, OS-level encrypted storage. See [Roadmap — Research: Obsidian secrets manager API](roadmap.md#pre-phase-0-blocking-foundation) for the pre-implementation research task.
- Model selection: each provider exposes available models. Users select the active model from the chat panel or settings.
- Per-model cost configuration: optional token pricing (input/output per 1K tokens) for cost tracking.

### Streaming

- All providers must support streaming responses (token-by-token).
- The provider interface returns an async iterable of chunks, which the chat UI consumes for real-time rendering.
- For providers that don't natively support streaming, implement a polling/buffering adapter that simulates the streaming interface.

---

## Message and context management

### Conversation structure

A conversation consists of an ordered sequence of messages:

```
Message:
  - role: "system" | "user" | "assistant" | "tool_call" | "tool_result"
  - content: string
  - metadata: { timestamp, token_count, cost_estimate, tool_name?, tool_params?, tool_status? }
```

- **System message**: system prompt + injected context (vault rules, auto-context). Always first.
- **User message**: user input + any attached note/file contents.
- **Assistant message**: LLM response text.
- **Tool call**: LLM requests to invoke a tool (name + parameters).
- **Tool result**: output returned from tool execution.

### Context window management

- Track cumulative token count against the active model's context window limit.
- **Auto-compaction** (Phase 3): when the conversation approaches the context limit, trigger a deterministic compaction step:
  1. Plugin sends a summarization request to the LLM with the current conversation.
  2. LLM returns a condensed summary.
  3. Plugin starts a new context window with the summary as the opening system/context message.
  4. The transition is visible in the chat UI (a "context compacted" marker).
- The compaction trigger threshold is configurable (e.g., compact at 80% of context limit).

### System prompt assembly

Before every LLM API call (including tool-result round-trips within a single turn), the plugin assembles the system prompt from multiple sources:

1. **Global system prompt**: if `{notor_dir}/prompts/core-system-prompt.md` exists, use its body content (stripping frontmatter). Otherwise, use the built-in default system prompt from plugin code.
2. **Persona system prompt** (Phase 4): if a persona is active, append (or replace, if `notor-persona-prompt-mode: replace`) the persona's `system-prompt.md` from `{notor_dir}/personas/{persona_name}/`. The default mode (`append`, also used when the property is omitted) appends the persona prompt after the global prompt. The `replace` mode excludes the global prompt entirely.
3. **Vault-level instruction files** (Phase 2): scan `{notor_dir}/rules/` and inject any rule files whose frontmatter triggers match current context conditions (see trigger properties below).
4. **Workspace context** (Phase 3): the dynamic `<auto-context>` XML block (see Auto-context injection below) is appended as a `## Workspace context` section. This is rebuilt from scratch before every LLM API call so it always reflects the latest workspace state — open tabs, vault structure, and OS are never stale.

Steps 1–3 each support `<include_notes>` tags (see below) to dynamically inject note contents. In system prompt and rule file contexts, only `mode="inline"` is supported (the `mode` attribute is ignored; content is always inlined directly into the prompt text).

#### Vault-level rule trigger evaluation (Phase 2)

For each Markdown file under `{notor_dir}/rules/`, the plugin evaluates frontmatter trigger properties:

| Property | Match condition |
|---|---|
| `notor-always-include: true` | Always included |
| `notor-directory-include: <path>` | Included when any note in the context window has a path under the specified directory |
| `notor-tag-include: <tag>` | Included when any note in the context window has the specified tag |

- Multiple trigger properties on the same file use OR logic (any match causes inclusion).
- The file body (after stripping frontmatter) is the injected instruction content.
- Additional trigger types may be added over time.
- Rule file bodies support `<include_notes>` tags to dynamically inject note contents (inline mode only — see system prompt assembly above).

### Auto-context injection (Phase 3)

The plugin automatically injects contextual information into the **system prompt** (not the user message) before every LLM API call. This keeps the user's chat bubble clean and avoids accumulating duplicate context blocks in the conversation history.

The auto-context is assembled into an `<auto-context>` XML block and appended to the system prompt as a `## Workspace context` section. Three sources are supported:

1. **Open note paths**: file paths of all notes currently open in the Obsidian workspace. All tabs are enumerated via `workspace.iterateAllLeaves()` (which covers pinned tabs, split panes, stacked tabs, and lazily-initialised tabs that have never been clicked). For each leaf, `leaf.view.getState().file` is used as a fallback for unactivated tabs where `view.file` is not yet populated. The currently active note is annotated with ` (active)` — e.g., `Research/Climate.md (active)`. Active note detection uses a two-stage approach: `getActiveViewOfType(MarkdownView)` first (when a markdown tab is focused), then a cached `_lastActiveMarkdownPath` updated by an `active-leaf-change` event listener (handles the case where the chat panel has focus). Full note contents are NOT automatically injected — only paths.
2. **Vault structure**: top-level folder names at the vault root. Each folder is listed on its own line with a trailing `/` (e.g., `Research/`, `Daily/`). Individual file names at the root level and recursive subdirectory contents are not included.
3. **Operating system**: the user's OS platform (macOS, Windows, Linux) so the LLM can generate platform-appropriate commands for `execute_command` and tailor any OS-specific guidance.

Each source can be individually enabled/disabled in settings. If all sources are disabled, no `<auto-context>` block or `## Workspace context` section is added to the system prompt. The block is **ephemeral** — it is not stored per-message in the JSONL conversation log.

---

## Tool dispatch

### Architecture

The tool dispatch layer sits between the LLM response parser and the tool implementations:

```
LLM Response → Parse tool calls → Tool Dispatcher → [Auto-approve check] → [User approval UI] → Tool execution → Result back to LLM
```

### Dispatch logic

1. Parse the LLM's response for tool call requests.
2. Look up the tool in the registry (built-in + custom MCP tools).
3. Check **Plan/Act mode**: if in Plan mode and the tool is classified as write, reject with an error message returned to the LLM. This applies equally to built-in tools and custom MCP tools that have been classified as write in their configuration (see [Tools — MCP tool classification](tools.md#mcp-tool-classification-and-planact-awareness)).
4. For MCP tool invocations, include the current Plan/Act mode state in the tool call so the MCP server can make its own decisions about write-type actions (see [Tools — Plan/Act state signaling](tools.md#mcp-tool-classification-and-planact-awareness)).
5. Check **tool-specific restrictions**: for `fetch_webpage`, check the domain denylist before executing. For `execute_command`, check configured command restrictions.
6. Check **auto-approve** settings (global → persona override): if auto-approved, execute immediately. If not, present the approval UI in the chat panel and wait for user response.
7. Execute the tool and return the result to the LLM for the next response turn.

### Tool registry

- Built-in tools are registered at plugin load time.
- Custom MCP tools (Phase 5) are registered from configuration, with schema discovery via MCP protocol. Each MCP tool can optionally be classified as read-only or write for Plan/Act enforcement.
- All tools share a uniform interface: `{ name, description, inputSchema, execute(params) → result }`.

### Domain denylist (Phase 3)

A user-configurable list of domains that the `fetch_webpage` tool is blocked from accessing. When the tool is invoked with a URL matching a denylisted entry, the request is rejected and an error is returned to the LLM indicating the domain is blocked by the user.

- Configured in **Settings → Notor** (see [UX — Settings](ux.md)).
- Matching is exact-domain only: denylisting `example.com` blocks only `example.com` itself, not its sub-domains. To block sub-domains, users must add separate wildcard entries (e.g., `*.example.com`).
- The denylist is intended for users to mark sources they consider untrustworthy. It is not a security mechanism — it is a user preference control.

---

## Personas (Phase 4)

A persona is a named configuration bundle that shapes the AI's behavior.

### Storage and structure

- Each persona is a directory under `{notor_dir}/personas/{persona_name}/`.
- The persona is defined by a `system-prompt.md` file in that directory:
  - **Body content** (after stripping frontmatter) is the persona's system prompt.
  - **Frontmatter properties** configure persona behavior:
    ```yaml
    ---
    notor-persona-prompt-mode: "append"  # "append" (default) or "replace". Append adds persona prompt after global prompt; replace excludes global prompt entirely.
    notor-preferred-provider: ""         # Optional: override default LLM provider
    notor-preferred-model: ""            # Optional: override default model
    ---
    ```
- Persona files are regular Markdown notes, fully editable in Obsidian's editor.
- The plugin discovers personas by scanning `{notor_dir}/personas/` for subdirectories containing `system-prompt.md`.

### Behavior

- Personas are selectable from the chat panel.
- When a persona is active, its settings take precedence over global defaults.
- Settings not explicitly defined on the persona fall back to global defaults.
- When `notor-persona-prompt-mode` is `"append"` (default, also used when omitted), the global system prompt is included first, followed by the persona's system prompt.
- When `notor-persona-prompt-mode` is `"replace"`, only the persona's system prompt is used; the global prompt is excluded. Vault-level rule injections still apply regardless.
- Per-persona auto-approve overrides are managed in **Settings → Notor → Persona auto-approve** (stored in plugin settings data, not in frontmatter). Each tool has a three-state selector: "Global default" (inherit), "Auto-approve", or "Require approval".

### Extended persona (Phase 5)

- **Tool access restrictions**: approve-list or block-list specific tools for the persona.
- **Vault scope**: restrict the persona to operate only within certain vault folders.
- The persona directory may be expanded over time to hold additional configuration files (e.g., tool access rules).

---

## Workflows (Phase 4)

Workflows are reusable, structured prompting sequences stored as notes in the vault.

### Structure

- Stored under `{notor_dir}/workflows/` as regular Obsidian notes.
- **Frontmatter properties** drive workflow behavior:
  ```yaml
  ---
  notor-workflow: true
  notor-trigger: manual           # manual | on-note-open | on-save | scheduled
  notor-schedule: "0 9 * * *"    # cron expression (if notor-trigger is scheduled)
  notor-workflow-persona: "researcher"  # optional: automatically switch to this persona when running the workflow
  ---
  ```
- **Body content** is the prompt template, which can include:
  - Static prompt text.
  - `<include_notes>` tags for dynamic note injection.

### `<include_notes>` tag

Inject note contents dynamically at execution time. Used in workflow note bodies, system prompts (global and persona), and vault-level rule files.

```markdown
<include_notes path="Research/Topic A.md" section="Summary" mode="inline" />
<include_notes path="Templates/analysis-framework.md" mode="attached" />
```

| Attribute | Required | Description |
|---|---|---|
| `path` | yes | Vault path to the note (supports `[[wikilink]]` syntax) |
| `section` | no | Specific section header to extract (omit for full note) |
| `mode` | no | `inline` (paste content directly into prompt) or `attached` (include as a separate attached file in context). Default: `inline` |

**Context-specific behavior:**
- **Workflow notes**: both `inline` and `attached` modes are supported.
- **System prompts** (global and persona) **and vault-level rule files**: only `inline` mode is supported. The `mode` attribute is ignored; content is always inlined directly into the prompt text.

---

## Hooks

Hooks allow automated actions to be triggered by events in the LLM interaction lifecycle or in the vault.

### LLM interaction hooks (Phase 3)

| Hook | Trigger | Use case examples |
|---|---|---|
| `pre-send` | Before a user message is sent to the LLM | Inject additional context, validate input |
| `on-tool-call` | After tool approval, immediately before tool execution | Logging, auditing AI actions |
| `on-tool-result` | After tool execution, before result is returned to the LLM | Logging tool outputs, auditing tool behavior |
| `after-completion` | After the LLM finishes its full response turn (including all tool cycles) | Auto-save conversation, trigger follow-up actions |

### Vault event hooks (Phase 4)

| Hook | Trigger | Use case examples |
|---|---|---|
| `on-note-open` | A note is opened in the editor | Auto-summarize, check for stale content |
| `on-save` | A note is saved | Auto-tag, update indexes, lint content |
| `on-tag-change` | Tags are added/removed from a note | Trigger categorization workflows |
| `on-schedule` | Cron-based schedule | Daily digests, periodic vault maintenance |

### Hook implementation

- In Phase 3, hooks are registered via **Settings → Notor** only. Hook configuration via workflow frontmatter is deferred to Phase 4.
- The sole Phase 3 hook action is **execute a shell command**. "Run a workflow" and other action types are deferred to Phase 4.
- Hook shell commands are **approved at configuration time** — configuring the hook in Settings constitutes implicit user approval. No per-execution approval prompt is shown when a hook fires.
- **`pre-send` hooks** are fully awaited (sequentially, in configuration order) before the message is dispatched to the LLM. If a hook produces stdout, that output is sent as a **separate `user` message** in the conversation (distinct from the user's typed message, marked `is_hook_injection: true` in the JSONL log). In the chat UI, hook output is rendered as a collapsible element (`.notor-hook-injection`) — it is never merged into the user's typed message bubble.
- **`on-tool-call`, `on-tool-result`, and `after-completion` hooks** are non-blocking fire-and-forget: they execute sequentially but do not stall the conversation pipeline. The `on-tool-call` hook fires only for tool calls that will actually run (rejected tool calls do not trigger it).
- All hook events share a single global timeout (default: 10 seconds, configurable in **Settings → Notor**). When any hook exceeds the timeout, the shell process is terminated and a non-blocking notice is surfaced.
- Failures for any hook event are non-blocking: a notice is surfaced but the conversation continues. Individual hook failures do not prevent subsequent hooks in the same event from executing.
- Hook shell commands run with `cwd` set to the vault root and are subject to the same working directory allow-list as the `execute_command` tool.

---

## Checkpoints (Phase 2)

Custom-built checkpoint system for rollback safety.

### Behavior

- **Automatic**: before any write tool (`write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`) is applied, the affected note's current state is snapshotted.
- **Per-conversation**: checkpoints are scoped to the conversation that created them.
- **Timeline UI**: accessible from the chat panel — each conversation shows a timeline of checkpoints with timestamps and brief descriptions (e.g., "Before replace_in_note on Daily/2026-03-01.md").

### Operations

- **Preview**: view the note content at a checkpoint without restoring.
- **Restore**: revert a note to its checkpoint state.
- **Compare**: diff the current note state against a checkpoint.

### Storage

- Checkpoint data stored in the plugin directory (`.obsidian/plugins/notor/checkpoints/` by default), not in the vault as visible notes.
- The storage location is configurable via settings, but defaults to the plugin directory.
- Retention policy: configurable max checkpoint age or count to prevent unbounded growth.
- Implementation details (storage format, indexing, efficient diffing) to be specified in a dedicated spec.

---

## Agents (Phase 5)

### Multi-agent conversations

- Multiple AI conversations can run in parallel, each with its own context window.
- The chat panel provides a tab or switcher to move between active agent workstreams.
- Each agent's context is stored as a separate conversation file (building on the chat history persistence from Phase 2).

### Agent monitor panel

- A **dedicated Obsidian panel** (separate leaf view from the main Notor chat panel) providing an at-a-glance dashboard of all running agents.
- Displays per-agent: status (running / paused / completed / errored), current task description, and progress indicators.
- Users can position the monitor panel independently — e.g., alongside the chat panel for concurrent visibility.
- **Clicking on an agent** in the monitor panel opens that agent's full conversation in the main Notor chat panel, with all standard chat capabilities (stop the agent, send messages to redirect, review history, etc.).
- The monitor panel updates in real time as agents progress.
- See [UX — Agent monitor panel](ux.md#agent-monitor-panel-phase-5) for UI details.

### Background agents

- Persistent agents that operate within Obsidian without active user interaction.
- Defined via configuration (or as a special workflow type) with a goal, scope, and resource limits.
- Example use cases:
  - Continuously research a topic and append findings to a note.
  - Monitor the vault for notes matching certain patterns and suggest connections.
  - Periodically review and organize notes based on defined criteria.
- Background agents respect all safety mechanisms (auto-approve, checkpoints, vault scope restrictions).

### Resource limits

- Configurable caps on: chat history retention (by size in MB or age in days), maximum concurrent agents, token budget per agent per time period.
- These limits prevent runaway cost or resource consumption from long-lived or parallel agents.

---

## Chat history persistence (Phase 2)

### Format

- Conversations are serialized as JSONL (one JSON object per message/event).
- Each conversation is a separate file, named with a timestamp and/or conversation ID.

### Storage location

- Defaults to `.obsidian/plugins/notor/history/` (inside the plugin directory).
- Configurable via settings to any vault-relative path (e.g., `notor-history/`). The path is always relative to the vault root.
- JSONL files are not recognized by Obsidian as notes, so they do not appear in the file explorer or search results regardless of storage location.

### Retention

- Configurable limits: max total size (MB) and/or max age (days).
- Oldest conversations are pruned when limits are exceeded.