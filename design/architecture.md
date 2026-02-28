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
| **AWS Bedrock** | AWS SDK / HTTP | IAM credentials or access keys | Priority for initial development |
| **Anthropic** | HTTP API | API key | Direct Claude API access |
| **OpenAI** | HTTP API | API key | GPT models + compatible endpoints |

The interface should be extensible so additional providers (Azure OpenAI, Google Vertex, local models via Ollama/LM Studio, etc.) can be added later without changing the core chat system.

### Configuration

- Per-provider settings: endpoint URL (if customizable), authentication credentials, region (for Bedrock).
- Credentials stored via Obsidian's plugin data storage (encrypted at rest by the OS).
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

Before sending each user message to the LLM, the plugin assembles the system prompt from multiple sources:

1. **Global system prompt**: if `{notor_dir}/system-prompt.md` exists, use its body content (stripping frontmatter). Otherwise, use the built-in default system prompt from plugin code.
2. **Persona system prompt** (Phase 4): if a persona is active, append (or replace, if `notor-skip-global-prompt: true`) the persona's `system-prompt.md` from `{notor_dir}/personas/{persona_name}/`.
3. **Vault-level instruction files** (Phase 2): scan `{notor_dir}/rules/` and inject any rule files whose frontmatter triggers match current context conditions (see trigger properties below).

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

### Auto-context injection (Phase 3)

In addition to the system prompt, the plugin automatically injects contextual information with each message:

1. **Open note paths**: file paths of all notes currently open in the Obsidian workspace (all leaf/tab views, including pinned tabs and split panes). Only paths are included — full note contents are NOT automatically injected.
2. **Vault structure**: top-level directory listing only (folder names at the vault root). Does NOT include individual file names in the root directory or recursive subdirectory contents.

Each source can be individually enabled/disabled in settings.

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
3. Check **Plan/Act mode**: if in Plan mode and the tool is classified as write, reject with an error message returned to the LLM.
4. Check **auto-approve** settings (global → persona override): if auto-approved, execute immediately. If not, present the approval UI in the chat panel and wait for user response.
5. Execute the tool and return the result to the LLM for the next response turn.

### Tool registry

- Built-in tools are registered at plugin load time.
- Custom MCP tools (Phase 5) are registered from configuration, with schema discovery via MCP protocol.
- All tools share a uniform interface: `{ name, description, inputSchema, execute(params) → result }`.

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
    notor-skip-global-prompt: false   # If true, only this persona's prompt is used (global prompt excluded). Default: false.
    notor-preferred-provider: ""      # Optional: override default LLM provider
    notor-preferred-model: ""         # Optional: override default model
    ---
    ```
- Persona files are regular Markdown notes, fully editable in Obsidian's editor.
- The plugin discovers personas by scanning `{notor_dir}/personas/` for subdirectories containing `system-prompt.md`.

### Behavior

- Personas are selectable from the chat panel.
- When a persona is active, its settings take precedence over global defaults.
- Settings not explicitly defined on the persona fall back to global defaults.
- When `notor-skip-global-prompt` is `false` (default), the global system prompt is included first, followed by the persona's system prompt.

### Extended persona (Phase 5)

- **Tool access restrictions**: whitelist or blacklist specific tools for the persona.
- **Vault scope**: restrict the persona to operate only within certain vault folders.
- The persona directory may be expanded over time to hold additional configuration files (e.g., tool access rules, auto-approve overrides).

---

## Workflows (Phase 4)

Workflows are reusable, structured prompting sequences stored as notes in the vault.

### Structure

- Stored under `{notor_dir}/workflows/` as regular Obsidian notes.
- **Frontmatter properties** drive workflow behavior:
  ```yaml
  ---
  notor_workflow: true
  trigger: manual           # manual | on-note-open | on-save | scheduled
  schedule: "0 9 * * *"    # cron expression (if trigger is scheduled)
  persona: "researcher"     # optional: use a specific persona
  ---
  ```
- **Body content** is the prompt template, which can include:
  - Static prompt text.
  - `<include_notes>` tags for dynamic note injection.

### `<include_notes>` tag

Inject note contents into the workflow prompt at execution time:

```markdown
<include_notes path="Research/Topic A.md" section="Summary" mode="inline" />
<include_notes path="Templates/analysis-framework.md" mode="attached" />
```

| Attribute | Required | Description |
|---|---|---|
| `path` | yes | Vault path to the note (supports `[[wikilink]]` syntax) |
| `section` | no | Specific section header to extract (omit for full note) |
| `mode` | no | `inline` (paste content directly into prompt) or `attached` (include as a separate attached file in context). Default: `inline` |

---

## Hooks

Hooks allow automated actions to be triggered by events in the LLM interaction lifecycle or in the vault.

### LLM interaction hooks (Phase 3)

| Hook | Trigger | Use case examples |
|---|---|---|
| `pre-send` | Before a user message is sent to the LLM | Inject additional context, validate input |
| `on-tool-call` | When the LLM requests a tool invocation | Logging, custom approval logic |
| `after-completion` | After the LLM finishes its response turn | Auto-save conversation, trigger follow-up actions, chain workflows |

### Vault event hooks (Phase 4)

| Hook | Trigger | Use case examples |
|---|---|---|
| `on-note-open` | A note is opened in the editor | Auto-summarize, check for stale content |
| `on-save` | A note is saved | Auto-tag, update indexes, lint content |
| `on-tag-change` | Tags are added/removed from a note | Trigger categorization workflows |
| `on-schedule` | Cron-based schedule | Daily digests, periodic vault maintenance |

### Hook implementation

- Hooks are registered via plugin settings or within workflow frontmatter.
- Each hook specifies an action: run a workflow, send a prompt to the LLM, or invoke a specific tool.
- Hooks respect auto-approve settings — a hook that triggers a write operation still requires approval unless auto-approved.

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

- Checkpoint data stored in plugin data (not in the vault as visible notes).
- Retention policy: configurable max checkpoint age or count to prevent unbounded growth.
- Implementation details (storage format, indexing, efficient diffing) to be specified in a dedicated spec.

---

## Agents (Phase 5)

### Multi-agent conversations

- Multiple AI conversations can run in parallel, each with its own context window.
- The chat panel provides a tab or switcher to move between active agent workstreams.
- Each agent's context is stored as a separate conversation file (building on the chat history persistence from Phase 2).

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

- Defaults to `{notor_dir}/history/` within the vault (or a configurable path outside the vault).
- If stored within the vault, the directory should be excluded from Obsidian's search and file explorer (via `.obsidian` configuration or a similar mechanism).

### Retention

- Configurable limits: max total size (MB) and/or max age (days).
- Oldest conversations are pruned when limits are exceeded.