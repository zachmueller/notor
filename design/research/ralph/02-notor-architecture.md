# Notor Plugin: Current Architecture

> Research compiled from direct source analysis of `src/`.

## What Notor Is Today

Notor is an Obsidian plugin that provides an **AI chat interface** deeply integrated with the
vault. It supports:
- Multi-turn LLM conversations (Anthropic, OpenAI, AWS Bedrock, local endpoints)
- Vault-aware tools (read/write/search notes, manage frontmatter, etc.)
- Workflow notes — Markdown files that serve as reusable AI instruction templates
- Personas — named system-prompt profiles with optional provider/model overrides
- Hook system — shell commands or workflow invocations fired on LLM lifecycle events
- Vault event hooks — automatic triggers when vault events occur (save, open, tag change, etc.)

---

## Core Modules

### Chat System (`src/chat/`)

**`orchestrator.ts`** — The main message dispatch loop:
- `sendMessage(text, attachments, options)` — assembles user message, sends to LLM provider
- Handles tool call cycles: LLM requests tool → user approves → tool executes → result sent back
- Manages streaming output to the chat view
- Fires pre-send and after-completion hooks
- Tracks token counts and cost estimates

**`dispatcher.ts`** (ToolDispatcher) — Sits between LLM response parsing and tool execution:
- Enforces Plan/Act mode (Plan mode requires approval; Act mode can auto-approve)
- Applies per-persona and per-tool auto-approve settings
- Routes tool calls to the correct tool implementation (built-in or MCP)
- Emits events for UI rendering (approval dialogs, tool call chips)

**`stale-tracker.ts`** (StaleContentTracker) — Safe write guard:
- Tracks the last-read content hash for each note per conversation
- Before any write tool executes, compares current vault content against what the LLM last read
- Prevents silent overwrites when notes are edited concurrently

**`conversation.ts`** (ConversationManager) — CRUD for conversations and messages in SQLite

**`context.ts`** (ContextManager) — Manages conversation context:
- Token window tracking
- Context compaction (summarization when approaching limits)

**`system-prompt.ts`** (SystemPromptBuilder) — Assembles the system prompt from:
- Global system prompt (from settings)
- Active persona prompt (append or replace mode)
- Vault rules (always-include or trigger-based)
- Current date

**`history.ts`** (HistoryManager) — Conversation list and navigation

**`default-system-prompt.ts`** — Default system prompt template

### Provider System (`src/providers/`)

**`provider.ts`** — Abstract interface:
```typescript
interface Provider {
  sendMessage(messages, tools, options, onChunk): Promise<ProviderResponse>;
}
interface StreamChunk { type: "text" | "tool_call" | "tool_result" | "usage"; ... }
```

**Concrete implementations:**
- `anthropic-provider.ts` — Direct Anthropic API via SDK
- `openai-provider.ts` — OpenAI-compatible API
- `bedrock-provider.ts` — AWS Bedrock (Anthropic models via Bedrock)
- `local-provider.ts` — Local endpoints (Ollama, etc.)
- `registry-factory.ts` — Factory that builds ProviderRegistry
- `sse.ts` — SSE streaming utility

### Tool System (`src/tools/`)

Available tools (called via function calling / tool use):
- `read-note.ts` — Read vault note content
- `write-note.ts` — Write/create notes
- `replace-in-note.ts` — Find-and-replace in notes
- `search-vault.ts` — Full-text and semantic search
- `list-vault.ts` — List notes/files
- `read-frontmatter.ts` — Read YAML frontmatter
- `update-frontmatter.ts` — Update YAML frontmatter
- `manage-tags.ts` — Add/remove tags
- `note-opener.ts` — Open notes in Obsidian
- `execute-command.ts` — Run shell commands (guarded by approval)
- `fetch-webpage.ts` — Fetch web content

**`tool.ts`** — Tool base class / registry interface

### Workflow System (`src/workflows/`)

**`workflow-discovery.ts`** — Scans `{notor_dir}/workflows/**/*.md` for workflow notes.
A workflow note has YAML frontmatter:
```yaml
---
notor-trigger: manual           # or on-note-open, on-save, on-tag-change, scheduled, etc.
notor-schedule: "0 8 * * *"    # for scheduled workflows
notor-workflow-persona: researcher  # optional persona override
notor-hooks:                    # per-workflow LLM lifecycle hooks
  pre_send:
    - action_type: execute_command
      command: "my-script.sh"
---

Your workflow instructions here...
You can reference notes with <include_note path="some/note.md" />
```

**`workflow-executor.ts`** — Prompt assembly pipeline:
1. Read workflow note body (strip frontmatter)
2. Resolve `<include_note>` tags (inline or attached mode)
3. Validate non-empty content
4. Wrap in `<workflow_instructions type="filename.md">...</workflow_instructions>`
5. Build `<trigger_context>` for event-triggered workflows
6. Build `<attachments>` block from attached-mode includes
7. Compose final message via `assembleUserMessage()`

**`workflow-activity-tracker.ts`** — Tracks in-flight background workflow executions

**`workflow-concurrency.ts`** — Prevents duplicate executions of the same workflow

**`workflow-hook-parser.ts`** — Parses `notor-hooks` frontmatter

### Persona System (`src/personas/`)

**`persona-discovery.ts`** — Scans `{notor_dir}/personas/*/system-prompt.md`
Each persona directory:
```
notor/personas/researcher/
  system-prompt.md    # frontmatter: notor-prompt-mode, notor-provider, notor-model
```

**`persona-manager.ts`** — Manages active persona state:
- `activatePersona(name)` — switch to persona, apply provider/model overrides
- `deactivatePersona()` — revert to global defaults
- `savePersonaState() / restorePersonaState()` — for workflow persona switching

**`auto-approve-resolver.ts`** — Per-persona auto-approve overrides for tools

### Hook System (`src/hooks/`)

**LLM Lifecycle Hooks (`hook-config.ts`, `hook-engine.ts`):**
Hooks fire at specific points in the LLM message cycle:
- `pre_send` — before sending to LLM (can inject context)
- `on_tool_call` — when a tool call is requested
- `on_tool_result` — after a tool executes
- `after_completion` — after the assistant completes

Actions: `execute_command` (shell command, output injected) or `run_workflow` (execute a workflow).

**Vault Event Hooks (`vault-event-*`):**
Hooks fired by vault events:
- `on_note_open`, `on_note_create`, `on_save`, `on_manual_save`, `on_tag_change`, `on_schedule`

**`execution-chain.ts`** — Loop detection for nested hook executions

**`workflow-hook-override.ts`** — Per-workflow hook overrides (from `notor-hooks` frontmatter)

### Context System (`src/context/`)

**`auto-context.ts`** — Automatically injects relevant notes based on current vault state
(configurable: recently opened, current note, linked notes)

**`attachment.ts`** — File/note attachments added to messages

**`compaction.ts`** — Context window management: summarizes old messages

**`message-assembler.ts`** — Assembles the final user message from all parts:
trigger context, attachments, workflow instructions, user text

### Rules System (`src/rules/`)

**`vault-rules.ts`** (VaultRuleManager) — Manages vault-level instruction files:
```
notor/rules/
  global-rules.md       # frontmatter: notor-always-include: true
  coding-rules.md       # frontmatter: notor-directory-include: src/
  research-rules.md     # frontmatter: notor-tag-include: research
```
Rules are injected into the system prompt when their trigger conditions match.

### UI System (`src/ui/`)

- `chat-view.ts` — Main chat interface (ItemView)
- `approval-ui.ts` — Tool call approval dialog
- `tool-call-ui.ts` — Tool call rendering in the chat stream
- `diff-view.ts` / `diff-engine.ts` — Side-by-side diff for write operations
- `attachment-chips.ts` / `attachment-picker.ts` — Attachment management
- `persona-picker.ts` — Persona selection UI
- `workflow-activity-indicator.ts` / `workflow-activity-dropdown.ts` — Background workflow status
- `workflow-suggest.ts` — Slash-command workflow picker
- `compaction-marker.ts` — Visual marker for compacted context
- `mcp-status-indicator.ts` — MCP server connection status in the UI

### MCP System (`src/mcp/`)

Notor has full [Model Context Protocol](https://modelcontextprotocol.io) support, enabling
connections to external tool servers:

**`mcp-hub.ts`** (McpHub) — Connection manager for all MCP servers:
- Connects to MCP servers via **stdio** (subprocess), **SSE**, or **Streamable HTTP** transports
- Manages connection lifecycle: connect, disconnect, reconnect
- Credential injection from secrets manager (env vars, headers)
- Tool discovery via `tools/list` after handshake
- `callTool()` delegates to the active connection

**`mcp-tool-adapter.ts`** (McpRegisteredTool) — Adapts discovered MCP tools as Notor `Tool` instances:
- Namespaced naming: `{serverName}__{toolName}`
- Read/write classification (user override → `readOnlyHint` → default write)
- Uniform registration in `ToolRegistry` alongside built-in tools
- `isMcpTool()` / `parseMcpToolName()` helpers

**`mcp-types.ts`** — Shared types: `McpServerConfig`, `McpConnection`, `McpDiscoveredTool`, etc.

**For orchestration:** Ralph hats can specify per-hat `mcp_servers` in their config.
Notor already has the MCP plumbing; per-hat MCP tool sets would require teaching
`HatTurnExecutor` to activate/deactivate MCP connections as the active hat changes.

### Shell System (`src/shell/`)

- `shell-executor.ts` — Executes shell commands with timeout/signal support
- `shell-resolver.ts` — Determines the user's default shell
- `output-buffer.ts` — Buffers command output

### Settings (`src/settings/`)

Rich settings system with sections for:
- Provider configuration (Anthropic, OpenAI, Bedrock, local)
- Active provider selection
- Context management (auto-context, compaction)
- Tool permissions (execute-command, fetch-webpage)
- Hook configuration
- History, checkpoints
- Model pricing
- Auto-approve settings

---

## Data Model (Key Types from `src/types.ts`)

### Conversation
```typescript
interface Conversation {
  id: string;
  provider_id: string; model_id: string;
  mode: "plan" | "act";
  workflow_path?: string | null;      // which workflow note triggered this
  workflow_name?: string | null;
  persona_name?: string | null;
  is_background?: boolean;            // event-triggered vs manual
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_cost: number | null;
}
```

### Workflow
```typescript
interface Workflow {
  file_path: string;
  file_name: string;
  display_name: string;
  trigger: WorkflowTrigger;           // manual | on-note-open | on-save | scheduled | ...
  schedule: string | null;            // cron expression for "scheduled"
  persona_name: string | null;        // persona override
  hooks: WorkflowHookConfig | null;   // per-workflow LLM lifecycle hooks
  body_content: string;
}
```

### WorkflowExecution
```typescript
interface WorkflowExecution {
  id: string;
  workflow_path: string;
  conversation_id: string;
  trigger_event: string;
  trigger_source: string | null;
  status: "queued" | "running" | "waiting_approval" | "completed" | "errored" | "stopped";
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
}
```

---

## Current Workflow Execution Model

**Manual workflow (command palette / slash command):**
1. User selects a workflow
2. `assembleWorkflowPrompt()` builds the user message
3. `sendMessage()` sends it to the LLM as a single turn
4. Tools may be called (multi-turn within one "workflow session")
5. LLM completes and the conversation is done

**Background workflow (event-triggered):**
1. Vault event fires (note save, open, tag change, schedule)
2. Matching workflow is found
3. New background conversation created
4. Same `sendMessage()` pipeline runs
5. If approval needed for a tool: execution pauses, user approves in UI

**Limitation:** Every workflow is a single LLM "session" — there's no multi-step
orchestration between multiple LLM roles. The LLM can use tools iteratively within
a single session, but there's no concept of hats/roles handoff, event routing,
or loop completion signals.

---

## Include Note System (`src/include-note/`)

The include-note system has its own module (`src/include-note/parser.ts` and `resolver.ts`).
Workflow notes can reference vault content via `<include_note>` tags:
```xml
<include_note path="Projects/current.md" />
<include_note path="[[My Note]]" section="Summary" />
<include_note path="daily/today.md" mode="attached" />
```

Modes:
- `inline` (default) — content replaces the tag in place
- `attached` — content collected into `<attachments>` block at end of message

---

## Checkpoint System (`src/checkpoints/`)

- Before any write-note or replace-in-note tool call: snapshot the note's current content
- Snapshots stored in SQLite with conversation_id, note_path, content, timestamp
- UI allows reverting to any checkpoint

---

## Key Architectural Constraints

1. **Obsidian plugin environment** — no Node.js `child_process`, no native file system beyond the vault
   (well, technically possible via `require('child_process')` in Obsidian plugins, but not standard)
2. **No HTTP server** — can't run a backend server inside Obsidian
3. **WebSocket limitations** — can connect to external WebSocket, can't easily host one
4. **SQLite via `better-sqlite3`** — works fine in Obsidian plugins
5. **Single-process** — Obsidian plugins run in the Electron renderer process

**Actually:** Obsidian plugins run in an Electron context and DO have access to Node.js APIs
including `child_process`, `fs`, `net`, etc. Notor already uses `child_process` for
`execute-command.ts` and `shell-executor.ts`. So spawning subprocesses is viable.
