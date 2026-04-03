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
- Each sub-agent gets its own `AbortController` (not shared with parent) — the parent's Stop button triggers abort on all active sub-agent controllers

**Completion signal:** A text response with no tool calls signals completion (following Claude Code's pattern). No dedicated `attempt_completion` tool is needed — the iteration cap provides a safety net for sub-agents that fail to converge.

**No context window management:** Sub-agents do not need truncation or compaction. The 10-turn iteration cap keeps conversations short, and each turn's content is bounded by tool output limits. If a sub-agent hits the context window limit (unlikely with a 10-turn cap), it should fail with a clear error rather than silently truncating.

### 2.3 Sub-Agent System Prompt Preamble

Every sub-agent's system prompt is prepended with a standard `SUB_AGENT_PREAMBLE` that ensures focused, concise behavior. Both Claude Code and Cline use this pattern. The preamble instructs the sub-agent to:

- Complete the specific request and return a concise summary of findings
- Not ask clarifying questions — work with the information provided
- Provide the final answer directly when the task is complete

The preamble is followed by the sub-agent profile's custom system prompt body. This keeps sub-agent responses compact and prevents the sub-agent from attempting open-ended conversation.

### 2.4 Sub-Agent Profiles

Sub-agent profiles follow the Personas directory convention:

```
{notor_dir}/sub-agents/{agent-name}/system-prompt.md
```

Each profile's `system-prompt.md` contains:
- YAML frontmatter for configuration
- A system prompt body describing the sub-agent's purpose and behavior
- Optional `<notor_tool_config>` blocks for tool access

Over time, each sub-agent's subdirectory may expand to house additional configuration files.

### 2.5 Frontmatter Properties

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
- `effective.auto_approve`: read tools (`mode === "read"`) are force-approved (per Section 9.7); write tools inherit the parent's auto_approve settings

This requires a new merge function separate from the existing precedence-based `mergeToolConfigs()`. The existing merger (in `src/tool-config/merger.ts`, ~114 lines) uses sparse override semantics with source precedence; sub-agents need AND/intersection semantics.

**Implementation:** A new `intersectToolConfig(parentEffective: EffectiveToolConfig, subAgentConfig: ParsedToolConfig): EffectiveToolConfig` function in `merger.ts`:
- For each tool: `enabled = parent.enabled AND subagent.enabled`
- `allowed_paths = intersection(parent.allowed_paths, subagent.allowed_paths)`
- `blocked_paths = union(parent.blocked_paths, subagent.blocked_paths)`
- `auto_approve`: force `true` for tools with `mode === "read"` (per Section 9.7); use parent's value for write tools
- This is a new function, not a modification of existing `mergeToolConfigs()` — current behavior is untouched

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

### 4.3 Provider Sharing Strategy

Verified against the codebase: provider instances in `ProviderRegistry` (`src/providers/index.ts`) are stateless between `sendMessage()` calls — they hold configuration but no per-request state. `BedrockProvider`'s `activeToolBlockIndices` was the one exception (mutable instance state used during streaming); this has been moved to local scope within `sendMessage()` to match the pattern used by OpenAI and Local providers. Sub-agents can safely share the parent's provider instance.

**Implementation:**
- Sub-agent receives the provider instance directly (not the `ProviderRegistry`)
- Each sub-agent creates its own `AbortController` for independent cancellation of in-flight LLM requests
- If the sub-agent profile specifies a different provider/model via `notor-preferred-provider` / `notor-preferred-model`, the `use_subagent` tool resolves it via `ProviderRegistry.getProvider(type)` before constructing the `SubAgentRunner`
- If the specified provider is not configured or the model is not available, fail with a clear error message in the tool result (no silent fallback — consistent with Section 4.1)

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

## 9. Resolved Design Questions

_These were originally open questions. Resolutions informed by Claude Code and Cline research (Section 10) and verified against Notor's codebase._

### 9.1 Mini-Orchestrator Design

**Decision: Separate `SubAgentRunner` class.**

Notor's `ChatOrchestrator` (~2370 lines) is deeply coupled to features sub-agents don't need: compaction, hooks, persona switching, workflow assembly, and view rendering (callbacks like `this.view?.renderToolCall`). Notor already has precedent for this pattern — `_backgroundResponseLoop` (lines 810–1048 of `orchestrator.ts`) is a stripped-down copy of `responseLoop` for background workflows. Cline's separate `SubagentRunner` class validates this approach.

**Implementation:**
- New class `SubAgentRunner` in `src/chat/sub-agent-runner.ts`
- Constructor accepts: provider instance, system prompt, tool definitions, `ToolDispatcher` (with pre-clamped config), `AbortController` (fresh per sub-agent), iteration cap (default 10), `ConversationMode`, optional `onProgress` callback
- Single public method: `run(taskPrompt: string): Promise<SubAgentResult>`
- `SubAgentResult`: `{ text: string; messages: Message[]; tokenUsage: { input: number; output: number }; iterationCount: number; wasCapReached: boolean }`
- Internal loop: `provider.sendMessage()` → process stream → dispatch tools → repeat until text-only response or iteration cap
- Does NOT use `ConversationManager` (plain `Message[]` array) or `ContextManager` (short-lived conversations)
- Extract `processStream()` core logic (chunk accumulation, tool call JSON parsing — orchestrator lines 1886–1960) into shared utility `src/chat/stream-utils.ts`. **Note:** The current `processStream()` (lines 1874–2009) has direct view-layer coupling (`this.view?.createAssistantMessagePlaceholder()`, `this.view?.appendStreamChunk()`, `this.view?.finalizeAssistantMessage()`). The shared utility must accept optional rendering callbacks so the orchestrator can pass view methods while the `SubAgentRunner` passes either `onProgress` or nothing.

### 9.2 Token & Cost Tracking

**Decision: Option C — roll up to parent total AND expose per-sub-agent breakdown.**

Both Claude Code and Cline track per-agent stats and aggregate them. Notor's `ConversationManager` already accumulates `total_input_tokens` / `total_output_tokens`, and `HistoryManager` uses per-file write queues (`writeQueues = new Map<string, Promise<void>>()`) for concurrent safety.

**Implementation:**
- `SubAgentResult.tokenUsage` flows into the parent's `tool_result` message metadata
- Parent's `ConversationManager.addMessage()` for the tool_result rolls sub-agent tokens into `Conversation.total_input_tokens` / `total_output_tokens`
- Per-agent breakdown available via the sub-agent's separate JSONL file (Section 5.1)
- Token footer in chat view shows the rolled-up total (no v1 UI changes needed)

### 9.3 Maximum Concurrent Sub-Agents

**Decision: Cap at 3, using a dedicated semaphore.**

Sub-agents are much heavier than regular tool calls (full multi-turn LLM loops vs. single operations). Cline allows up to 5 but with a lighter tool set. Claude Code has no cap but runs in a CLI. 3 is appropriate for an Obsidian plugin in Electron.

**Implementation:**
- `SUB_AGENT_CONCURRENCY_CAP = 3` constant (separate from the tool execution semaphore's cap of 5)
- `use_subagent` tool's `execute()` acquires a semaphore slot before spawning `SubAgentRunner`
- Reuse the existing semaphore pattern from `tool-orchestration.ts` (lines 194–215)
- Configurable in advanced settings for power users

### 9.4 Sub-Agent Tool Config Tag Extension

**Decision: Defer to post-v1.**

Neither Claude Code nor Cline implements per-context sub-agent profile control. The visibility toggle (Section 7.2) plus default-deny tool access (Section 3.1) provides sufficient control for v1. Workflow-scoped sub-agent restrictions can be added later using a `<notor_subagent_config>` tag when there is user demand.

### 9.5 Streaming vs. Blocking Tool Interface

**Decision: Keep `Tool.execute()` as `Promise<ToolResult>`. Add optional `onProgress` callback parameter.**

Both Claude Code and Cline use `onProgress` callbacks, not streaming iterables. Changing the `Tool` interface to return `AsyncIterable` would be a breaking change to all existing tools. An `onProgress` callback is additive and non-breaking.

**Implementation:**
- Extend `Tool.execute()` signature: `execute(params: Record<string, unknown>, options?: { onProgress?: (status: string) => void }): Promise<ToolResult>`
- `AbortSignal` stays at the dispatcher level (already handled there via `Promise.race` at dispatcher lines 475–491)
- `use_subagent` is the first (and for now, only) tool using `onProgress`
- `SubAgentRunner` calls `onProgress` after each iteration (e.g., "Searching vault... (turn 3/10)")
- The dispatcher passes the callback through when available
- The view renders progress updates as status text below the spinner in the tool call UI element

### 9.6 Plan/Act Mode Behavior

**Decision: Sub-agents always inherit the parent's mode. This is a hard rule.**

Both reference implementations cascade permissions from parent. Allowing Act mode in a Plan-mode parent would be privilege escalation. The dispatcher already checks mode at line 312 to block write tools in Plan mode, and `ConversationMode` is already isolated per-conversation with no global state.

**Implementation:**
- `SubAgentRunner` constructor receives parent's `ConversationMode`
- Passed to its `ToolDispatcher` instance for enforcement
- Not configurable — sub-agent profile cannot override the parent's mode

### 9.7 Auto-Approve for Sub-Agent Tool Calls

**Decision: Read tools are auto-approved. Write tools follow the parent's effective auto-approve settings.**

Claude Code auto-denies prompts for async agents and "bubbles" prompts to the parent for fork agents. Cline inherits the "Read project files" permission. Approving `use_subagent` implies consent for read operations. The built-in profiles (`search-vault`, `search-web`) only have read tools, so v1 sub-agents are fully auto-approved in practice.

**Implementation:**
- When building the sub-agent's `effectiveToolConfig`, force `auto_approve = true` for all tools with `mode === "read"`
- Write tools: use the intersected `auto_approve` value from the parent's config
- If a write tool is not auto-approved, the approval prompt surfaces in the main chat view (Claude Code's "bubble" pattern)
- Optional setting `sub_agent_auto_approve_reads` (default: true) for cautious users who want to review every sub-agent tool call

### 9.8 Error Handling & Partial Results

**Decision: Return partial results on iteration cap. Fail fast on provider errors.**

Claude Code returns partial results when the iteration cap is reached (no error thrown, just breaks the loop). This is more useful than hard failure. Cline retries transient errors with exponential backoff — we adopt that for stream-level errors only.

**Implementation:**
- **Iteration cap reached**: Return `SubAgentResult` with `wasCapReached: true`. Format the result with a marker: `[Sub-agent reached iteration limit (N turns). Results may be incomplete.]`
- **Provider errors** (auth, rate limit): Fail immediately with error in `ToolResult`. No retry — the parent LLM can decide to retry the `use_subagent` call
- **Tool execution errors** within the sub-agent: Fed back to the sub-agent LLM for retry within the same run (same pattern as the parent's response loop)
- **Abort signal**: Return partial results with cancelled marker (matching `processStream()` "cancelled" result type)

---

## 10. Reference Implementation Research

Research into Claude Code and Cline's sub-agent implementations informed the resolutions below. Key architectural patterns compared:

| Topic | Claude Code | Cline |
|-------|-------------|-------|
| **Orchestrator** | Reuses main `query()` loop with isolated `ToolUseContext` per agent | Separate `SubagentRunner` class (~879 lines) with own `TaskState` and `ContextManager` |
| **Tool control** | Default-deny with 3 disallow lists; `Agent` tool blocked for non-internal users | Default-deny whitelist of 7 read-only tools + `attempt_completion` |
| **Recursion prevention** | `Agent` tool filtered from child tool set; `isInForkChild()` message-scan fallback | `contextRequirements` check: `!context.isSubagentRun` prevents nesting |
| **Concurrency** | No hard cap; sync agents block parent, async run in parallel; auto-background after 120s | True parallel via `Promise.allSettled()`; up to 5 prompts per `use_subagents` call |
| **Token tracking** | Unified `ProgressTracker` (input/output/cache tokens); logged in telemetry events | Per-agent stats aggregated and reported as `subagent_usage` message to parent |
| **History** | Sidechain JSONL transcripts in separate files per agent | In-memory only (ephemeral); parent receives only final result string |
| **Error handling** | Iteration cap → partial results returned (no error thrown, just breaks loop) | Max 3 empty responses → fail; max 3 stream retries with exponential backoff |
| **Permissions** | Async agents auto-deny prompts; sync agents can prompt; fork agents "bubble" to parent | Inherits "Read project files" permission; YOLO mode always auto-approves |
| **Progress** | `onProgress` callback for sync agents; `AppState` task tracking for async | `onProgress` callback with queued UI updates to prevent flooding |
| **Completion signal** | Text response with no tool calls = done | Dedicated `attempt_completion` tool must be called |
| **Model override** | `sonnet`/`opus`/`haiku`/`inherit`; Bedrock region-aware inheritance | Per-agent `modelId` in YAML config; falls back to parent's model |
| **Agent config** | Agent definitions in code with frontmatter; `tools: ['*']` or allowlist | YAML files in `~/Documents/Cline/Agents/` directory |

### 10.1 Key Takeaways

1. **Both use default-deny tool access** — confirming our Section 3.1 design.
2. **Both prevent recursive sub-agents** — confirming our Section 3.3 design.
3. **Orchestrator isolation vs. reuse**: Claude Code reuses its query loop (simpler codebase, ~400 line query function). Cline uses a separate class (their main task loop is more complex). Notor's `ChatOrchestrator` (~2370 lines) is closer to Cline's complexity, favoring the separate-class approach.
4. **History**: Claude Code's sidechain JSONL approach avoids race conditions and keeps the parent conversation clean. Cline's ephemeral approach sacrifices debuggability. Our Section 5 design (separate JSONL files) aligns with Claude Code.
5. **Permissions**: Claude Code's "bubble" pattern (surface prompts to parent) for fork agents is a good model for how Notor should handle write-tool approvals in sub-agents.
6. **Completion signal**: Claude Code's "text with no tool calls" approach is simpler and avoids adding a dedicated tool. Adopted for Notor.
