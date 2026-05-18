# Sub-agents

Sub-agents let the AI spawn focused, isolated child conversations to handle specific tasks — vault searches, web lookups, documentation questions — without flooding the main chat with intermediate detail. Each sub-agent runs with its own system prompt, tool set, and (optionally) provider/model, then returns a compact summary to the parent conversation.

## How it works

When the AI determines that a task benefits from a focused investigation, it invokes the `use_subagent` tool with a profile name and a task description. Notor spins up an independent LLM conversation that runs to completion (up to 10 turns) and returns the final response as a tool result. The main conversation stays lean while the sub-agent does the deep dive.

- Each sub-agent gets its own context window — no shared message history with the parent.
- A sub-agent may use tools (vault search, web fetch, etc.) as configured in its profile.
- Sub-agents cannot spawn other sub-agents (no recursive nesting).
- Up to 3 sub-agents can run concurrently (configurable in advanced settings).

## Built-in profiles

Notor ships with eight ready-to-use sub-agent profiles:

| Profile | Description | Tools | Preset |
|---------|-------------|-------|--------|
| `search-vault` | Search the vault for notes, content, and connections | `search_vault`, `read_note`, `read_frontmatter`, `list_vault`, `get_backlinks`, `get_outlinks` | Parent's preset |
| `search-web` | Search the web for information, documentation, and references | `web_search`, `fetch_webpage` | Parent's preset |
| `notor-help` | Answer questions about Notor features and configuration by looking up official docs | `web_search`, `fetch_webpage` | Parent's preset |
| `memory-search` | Search memory notes for context relevant to the current conversation | `read_note`, `search_vault` (scoped to memory folder) | `tiny` |
| `memory-resolver` | Decide whether to create a new note or update an existing one for a given insight | `read_note`, `search_vault` (scoped to memory folder) | `tiny` |
| `memory-capture` | Extract durable insights from a conversation turn | `read_note`, `search_vault`, `list_vault`, `read_frontmatter`, `get_backlinks`, `get_outlinks` | `tiny` |
| `memory-dream` | Consolidate and refine memory notes across sessions | `read_note`, `search_vault`, `list_vault`, `read_frontmatter`, `get_backlinks`, `get_outlinks` | `large` |
| `memory-evaluator` | Evaluate which recalled memory notes were actually useful in the conversation | _(none)_ | `tiny` |

The five `memory-*` profiles are part of the [knowledge memory](memory.md) feature and are only active when memory is enabled.

Built-in profiles appear in **Settings → Notor → Sub-agents** with a "Built-in" badge. You can customize them by clicking the Open button — Notor creates a vault file from the default on first click, preserving your edits afterward. A "Reset to default" action is available if you want to restore the original.

## Creating a custom sub-agent

Sub-agent profiles live in your vault under `notor/sub-agents/`:

```
notor/sub-agents/
  search-vault/
    system-prompt.md
  my-custom-agent/
    system-prompt.md
```

Each profile is a directory containing a `system-prompt.md` file with YAML frontmatter and the agent's system prompt body.

### Quick start via Settings

1. Open **Settings → Notor → Sub-agents**
2. Click **Create new sub-agent**
3. Enter a name — Notor creates the directory and a skeleton `system-prompt.md`
4. The file opens in a new editor tab for immediate customization

### Manual creation

Create `notor/sub-agents/{agent-name}/system-prompt.md`:

```markdown
---
notor-description: Summarize meeting notes and extract action items.
notor-preferred-preset: small
# notor-preferred-provider: anthropic
# notor-preferred-model: claude-sonnet-4-20250514
# notor-iteration-cap: 15
---

You are a meeting notes assistant. Given a meeting note or set of notes,
extract key decisions, action items, and follow-ups.

## Behavior

- Focus on actionable outcomes, not general discussion.
- Format action items as a checklist with assignees when mentioned.
- Be concise — the parent conversation only needs the summary.

<notor_tool_config>
search_vault:
  enabled: true
read_note:
  enabled: true
read_frontmatter:
  enabled: true
</notor_tool_config>
```

### Frontmatter properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `notor-description` | string | _(none)_ | Short description of what the sub-agent does. Shown to the AI so it knows when to use this profile. Strongly encouraged. |
| `notor-preferred-preset` | string | _(none)_ | Named model preset to use (e.g., `tiny`, `small`, `large`). Takes precedence over `notor-preferred-provider`/`notor-preferred-model`. See [model-presets.md](model-presets.md). |
| `notor-preferred-provider` | string | Parent's provider | LLM provider override (e.g., `anthropic`, `openai`, `bedrock`, `local`) |
| `notor-preferred-model` | string | Parent's model | Model ID override |
| `notor-iteration-cap` | number | `10` | Maximum number of turns before the sub-agent is forced to stop. Overrides the global default (configurable in advanced settings). |

### Tool access

Sub-agents operate on a **default-deny** basis — a sub-agent has access to NO tools unless explicitly enabled via a `<notor_tool_config>` block in its profile. This is stricter than personas because sub-agents operate with less direct user oversight.

The effective tool set is the **intersection** of the parent conversation's enabled tools and the sub-agent profile's `<notor_tool_config>`:

- A tool must be enabled in **both** the parent context and the sub-agent profile to be available.
- `allowed_paths` are intersected (path must appear in both).
- `blocked_paths` are unioned (either block applies).
- Read-only tools are auto-approved by default (configurable via `sub_agent_auto_approve_reads` in settings).
- Write tools inherit the parent's auto-approve settings — if manual approval is needed, the prompt surfaces in the main chat.

If a sub-agent profile enables a tool that the parent context has disabled, a Notice alerts you to the configuration gap.

See [Per-context tool configuration](vault-tools.md#per-context-tool-configuration) for the `<notor_tool_config>` format.

## Settings

Configure sub-agents under **Settings → Notor → Sub-agents**:

- **Visibility toggle** — controls whether a profile is available to the AI. Disabled profiles are completely hidden from the `use_subagent` tool, even if the AI somehow references them.
- **Concurrency cap** — maximum number of sub-agents that can run simultaneously (default: 3). Available in advanced settings.
- **Auto-approve reads** — whether sub-agent read-only tool calls are automatically approved (default: on).

## Plan/Act mode

Sub-agents always inherit the parent conversation's Plan/Act mode. If the parent is in Plan mode, the sub-agent's write tools are blocked — there is no way for a sub-agent to escalate beyond the parent's permission level.

## Conversation history

Each sub-agent invocation is saved to its own JSONL file alongside the parent conversation's history. The parent's tool result includes a reference to this file.

- **Markdown export** includes only the sub-agent's summary response.
- **HTML export** includes an expandable section with the full sub-agent conversation.

## Progress and cancellation

While a sub-agent is running, the chat panel shows a spinner with status updates (e.g., "Searching vault... (turn 3/10)"). Clicking **Stop** cancels all active sub-agents — partial results (if any) are returned to the parent with a "[Cancelled]" marker.

## Provider and model

Sub-agents can use a different provider or model than the parent conversation. The recommended approach is `notor-preferred-preset`, which resolves to a provider and model via the named preset system. Alternatively, use `notor-preferred-provider` and `notor-preferred-model` for direct control. If not specified, they inherit the parent's provider and model.

Preset resolution takes precedence: if `notor-preferred-preset` is set and the preset is configured, its provider and model are used regardless of `notor-preferred-provider`/`notor-preferred-model`. If the preset is not configured, resolution falls through to the legacy provider/model fields.

If the specified provider is not configured, the sub-agent fails with a clear error rather than silently falling back.
