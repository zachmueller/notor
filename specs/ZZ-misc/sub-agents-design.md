# Design Doc: Sub-Agents for Notor

## 1. Context & Motivation

Notor's chat interface currently operates as a single LLM conversation. For tasks that benefit from focused, independent investigation — vault searches, web lookups, specialized analysis — the main context window accumulates large amounts of intermediate detail that dilutes the conversation.

Sub-agents address this by allowing the LLM to spawn isolated child conversations via a `use_subagent` built-in tool. Each sub-agent runs with its own system prompt, tool set, and (optionally) provider/model, then returns a compact result to the parent. This keeps the main context window lean while enabling deeper dives.

---

## 2. Core Architecture

### 2.1 The `use_subagent` Tool

A new built-in tool that the main LLM can invoke. Parameters include the sub-agent profile name and a task/prompt string. The tool spins up an independent LLM conversation, runs it to completion, and returns the final response as the tool result.

### 2.2 Sub-Agent Response Loop

A sub-agent with tools (e.g., `search-vault`) requires a **multi-turn response loop**: LLM call -> tool calls -> execute tools -> feed results back -> LLM call again -> repeat until a text response is produced.

This means `use_subagent`'s `execute()` cannot be a simple single-call function. It must run a **mini-orchestrator** — a stripped-down version of the main `ChatOrchestrator.responseLoop()`. Key constraints:
- Maximum iteration cap to prevent infinite tool loops (e.g., 10 LLM turns)
- No compaction (sub-agent conversations are short-lived)
- No hooks (sub-agents operate in a sandboxed context)
- The parent's `AbortSignal` must be threaded through to the sub-agent's LLM calls and tool executions so the Stop button works

### 2.3 Sub-Agent Profiles

Sub-agent profiles follow the Personas directory convention:

```
{notor_dir}/sub-agents/{agent-name}/system-prompt.md
```

Each profile's `system-prompt.md` contains:
- YAML frontmatter for configuration
- A system prompt body describing the sub-agent's purpose and behavior
- Optional `<notor_tool_config>` blocks for tool access

Over time, each sub-agent's subdirectory may expand to house additional configuration files.

### 2.4 Frontmatter Properties

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `notor-preferred-provider` | string | Parent's provider | LLM provider override |
| `notor-preferred-model` | string | Parent's model | Model ID override |
| `notor-description` | string | _(none)_ | Short description of what the sub-agent does. Injected into the `use_subagent` tool context so the main LLM knows when to use it. Strongly encouraged but optional. |

---

## 3. Tool Access & Security

### 3.1 Default-Deny Tool Access

Unlike Personas (which inherit global tool defaults), sub-agents operate on a **default-deny** basis. A sub-agent has access to NO tools unless explicitly enabled via `<notor_tool_config>` in its profile. This is because sub-agents operate with less direct user oversight.

### 3.2 Intersection Enforcement (Parent Context Clamping)

A sub-agent's effective tool access is the **intersection** of:
1. The parent conversation's effective tool config (what's currently enabled)
2. The sub-agent profile's `<notor_tool_config>` settings

Concretely:
- `effective.enabled = parent.enabled AND subagent.enabled`
- `effective.allowed_paths = intersection(parent.allowed_paths, subagent.allowed_paths)`
- `effective.blocked_paths = union(parent.blocked_paths, subagent.blocked_paths)`
- `effective.auto_approve`: sub-agent always inherits the parent's auto_approve settings (sub-agents cannot escalate approval)

This requires a new merge function (or post-merge clamping step) separate from the existing precedence-based `mergeToolConfigs()`. The existing merger uses override semantics; sub-agents need AND/intersection semantics.

### 3.3 No Cascading Sub-Agents

The `use_subagent` tool is **always filtered out** of the tool list provided to sub-agents. Additionally, the dispatcher should reject `use_subagent` calls from within a sub-agent context as defense-in-depth.

### 3.4 Configuration Gap Notices

If a sub-agent profile enables a tool that the parent context has disabled, the plugin should surface a Notice to the user highlighting the configuration gap, with an action to open the sub-agent's config in a new leaf.

---

## 4. Provider & Model Handling

### 4.1 Independent Provider Instantiation

Sub-agents must NOT mutate global provider/model state (as `PersonaManager.activatePersona()` currently does). Instead, the sub-agent's mini-orchestrator should instantiate or reuse a provider connection independently, parameterized by the profile's `notor-preferred-provider` and `notor-preferred-model`.

If no provider/model is specified in the profile, the sub-agent uses the same provider/model as the parent conversation.

If the specified provider is not configured or the model is not available, the sub-agent should fail with a clear error message in the tool result (not silently fall back).

### 4.2 Concurrent Provider Access

Multiple sub-agents may run concurrently, potentially with different providers. Provider implementations must be safe for concurrent use (stateless request handling). This should be verified for each provider (Bedrock, Anthropic, OpenAI).

---

## 5. Conversation History

### 5.1 Separate JSONL Files

Each sub-agent invocation gets its own JSONL file, stored alongside the parent conversation's history. Naming convention: `{parent_timestamp}_{parent_id}_subagent_{invocation_id}.jsonl`.

The parent conversation's `tool_result` message for `use_subagent` includes:
- The sub-agent's summary response (what gets fed back to the main LLM)
- A metadata reference to the sub-agent's JSONL file path

### 5.2 Rationale

- **No race conditions**: Concurrent sub-agents write to separate files
- **Clean export**: Parent conversation remains readable; sub-agent detail is drill-down content
- **No routing complexity**: No need to parse/filter interleaved messages from a shared file

### 5.3 Export Handling

- **Markdown export**: Include sub-agent summary only (skip full conversation detail)
- **HTML export**: Include expandable sections showing the full sub-agent conversation

---

## 6. UX & Progress Visibility

### 6.1 Sub-Agent Progress Display

Since sub-agents can run for multiple LLM turns, the UI should show progress:
- Tool call entry in the chat shows a spinner/status indicator while the sub-agent is working
- Status text updates with current activity (e.g., "Searching vault...", "Processing results...")
- On completion, the tool result area shows the sub-agent's final response

### 6.2 Cancellation

The Stop button must propagate through to sub-agent execution. The parent's `AbortSignal` is passed to the sub-agent's mini-orchestrator, which checks it before each LLM call and tool execution.

---

## 7. Settings UI

### 7.1 New "Sub-agents" Section

A new collapsible section in Settings, following the Personas pattern:
- "Create new sub-agent" button that prompts for a name and creates the skeleton directory/file
- List of discovered sub-agent profiles, each with:
  - A visibility toggle (whether the profile is available to the LLM)
  - An open button (using `square-arrow-out-up-right` icon) to navigate to the profile note

### 7.2 Visibility Toggle Enforcement

The toggle controls whether a sub-agent profile is included in the `use_subagent` tool's context. Defense-in-depth: even if the LLM somehow references a disabled profile, the dispatcher rejects the call.

### 7.3 Built-in Profiles

Two built-in sub-agent profiles ship with the plugin:
- **`search-vault`** — focused on searching for contents within the user's vault
- **`search-web`** — focused on searching the broader web

**Storage strategy**: Default system prompts are stored as constants in the codebase. Vault files are created on first "Open" click. If the user edits the vault file, their customizations are preserved. A "Reset to default" action is available in Settings.

Built-in profiles appear in the Settings list like user-created profiles but with a "Built-in" badge.

---

## 8. Sub-Agent Profile Injection

The list of available sub-agent profiles (name + description) is included in the `use_subagent` tool's description/schema, not as a separate system prompt section. This keeps the information co-located with the tool and avoids a dedicated system prompt section that consumes tokens even when sub-agents aren't being used.

If the profile list grows large, consider dynamically truncating or summarizing descriptions in the tool definition.

---

## 9. Open Questions

### 9.1 Mini-Orchestrator Design
Should the sub-agent response loop reuse `ChatOrchestrator` (with a "sub-agent mode" flag) or be a separate lightweight class? Reusing the orchestrator risks coupling to features sub-agents don't need (compaction, hooks, persona management). A separate class risks duplicating core logic. Need to evaluate the orchestrator's decomposability.

### 9.2 Token & Cost Tracking
Sub-agent LLM calls consume tokens. How should these roll up?
- Option A: Include in the parent conversation's totals (simpler UX, but hides sub-agent cost)
- Option B: Track separately and show breakdown (more transparent, more UI work)
- Option C: Both — roll up to parent total but also expose per-sub-agent breakdown in the conversation inspector

### 9.3 Maximum Concurrent Sub-Agents
Should there be a cap on how many sub-agents can run concurrently? The parallel tool execution system already has a semaphore (default cap: 5). Sub-agents are much heavier than regular tool calls. A lower cap (e.g., 2-3) may be appropriate.

### 9.4 Sub-Agent Tool Config Tag Extension
The design mentions a TODO about extending `<notor_tool_config>` (or a new tag) to control which sub-agent profiles are active per-context (e.g., per-persona or per-workflow). This would allow workflows to restrict which sub-agents are available. Is this needed for v1 or can it be deferred?

### 9.5 Streaming vs. Blocking Tool Interface
The current `Tool.execute()` returns `Promise<ToolResult>` — fully blocking. For sub-agent progress visibility, we may need a streaming or callback-based interface (e.g., `execute()` accepts an `onProgress` callback, or returns an `AsyncIterable`). This would be a change to the core `Tool` interface. Should this be a sub-agent-specific extension or a general tool interface evolution?

### 9.6 Plan/Act Mode Behavior
If the parent conversation is in Plan mode, should sub-agents also be restricted to Plan mode (read-only tools only)? Or should sub-agents always operate in Act mode since they're inherently scoped and the parent controls what tools they have access to?

### 9.7 Auto-Approve for Sub-Agent Tool Calls
Should sub-agent tool calls require user approval, or should they auto-approve since the user already approved the `use_subagent` invocation? If sub-agents require per-tool approval, it defeats the purpose of autonomous background work. But auto-approving write operations inside a sub-agent is a security consideration.

### 9.8 Error Handling & Partial Results
If a sub-agent hits an error mid-conversation (provider failure, tool error, iteration cap), should it return partial results gathered so far, or fail entirely? Partial results are more useful but add complexity to the response format.
