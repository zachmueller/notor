# Implementation Plan: Sub-Agents for Notor

Based on [sub-agents-design.md](sub-agents-design.md). Tasks are ordered by dependency — each phase builds on the prior one.

---

## Phase 1: Stream Processing Extraction & Foundation

Extract the shared stream parsing logic that both `ChatOrchestrator` and `SubAgentRunner` will consume. This is prerequisite work that de-risks the core loop implementation.

### 1.1 Create `parseStreamEvents()` async generator

The design doc (Section 9.1) calls for a shared event transform stream in `src/chat/stream-utils.ts`. Currently, `processStream()` (orchestrator.ts ~L1874-2009) interleaves stream parsing with view-layer calls (`this.view?.appendStreamChunk()`, `this.view?.createAssistantMessagePlaceholder()`, etc.). The background response loop (`_backgroundResponseLoop` ~L810-1048) duplicates much of this parsing logic without the view calls.

- [x] Create `src/chat/stream-utils.ts` with `parseStreamEvents()` async generator
  - [x] Define `ParsedStreamEvent` union type:
    - `{ type: "text_delta"; text: string; delta: string }` — accumulated text + new delta
    - `{ type: "tool_call"; id: string; name: string; parameters: Record<string, unknown> }` — fully parsed tool call
    - `{ type: "message_end"; inputTokens: number; outputTokens: number }`
    - `{ type: "error"; message: string }`
    - `{ type: "cancelled"; text: string }`
  - [x] Signature: `parseStreamEvents(stream: AsyncIterable<StreamChunk>, abortSignal: AbortSignal): AsyncIterable<ParsedStreamEvent>`
  - [x] Port chunk accumulation logic from `processStream()`:
    - `text_delta` → accumulate text, yield `text_delta` event with both accumulated and delta
    - `tool_call_start` / `tool_call_delta` / `tool_call_end` → accumulate JSON fragments, yield fully-parsed `tool_call` on end
    - `message_end` → yield token counts
    - `error` → yield error event
  - [x] Handle abort signal: check before each chunk, yield `cancelled` event on abort
  - [x] Export types and function

### 1.2 Migrate `processStream()` to consume `parseStreamEvents()`

- [x] Refactor `ChatOrchestrator.processStream()` to be a thin consumer of `parseStreamEvents()`
  - [x] Replace inline chunk handling with event consumption loop
  - [x] Preserve all view-layer calls (`appendStreamChunk`, `createAssistantMessagePlaceholder`, `finalizeAssistantMessage`) as reactions to events
  - [x] Preserve the `StreamResult` return type and all existing behavior
  - [x] Preserve eager content element handling
- [x] Verify all existing orchestrator tests pass without modification
- [ ] Verify manual testing: normal chat, tool calls, cancellation all work identically

### 1.3 Migrate `_backgroundResponseLoop` stream processing

- [x] Refactor the background loop's inline stream parsing to consume `parseStreamEvents()`
  - [x] The background loop (orchestrator.ts ~L810-1048) has its own stream consumption that skips view calls — replace with `parseStreamEvents()` + silent consumption
- [ ] Verify background workflow execution still works

---

## Phase 2: Tool Config Intersection & Security

Implement the security model before any sub-agent can execute tools. This is the gate that prevents privilege escalation.

### 2.1 Implement `intersectToolConfig()`

The design doc (Section 3.2) requires AND/intersection semantics — distinct from the existing precedence-based `mergeToolConfigs()` in `src/tool-config/merger.ts`.

- [ ] Add `intersectToolConfig()` function to `src/tool-config/merger.ts`
  - [ ] Signature: `intersectToolConfig(parentEffective: EffectiveToolConfig, subAgentConfig: ParsedToolConfig, toolModes: Record<string, "read" | "write">): EffectiveToolConfig`
  - [ ] Per-tool logic:
    - `enabled = parent.enabled AND subagent.enabled` (tool must be enabled in both)
    - `allowed_paths = intersection(parent.allowed_paths, subagent.allowed_paths)` — paths must appear in both (empty = no restriction, so empty ∩ X = X)
    - `blocked_paths = union(parent.blocked_paths, subagent.blocked_paths)` — either block applies
    - `auto_approve`: force `true` for tools with `mode === "read"`; use parent's value for write tools
  - [ ] Tools not mentioned in the sub-agent config are disabled (default-deny per Section 3.1)
  - [ ] Do NOT modify existing `mergeToolConfigs()` — this is a new function
- [ ] Write unit tests for `intersectToolConfig()`
  - [ ] Test: sub-agent enables tool that parent disabled → tool is disabled
  - [ ] Test: sub-agent enables tool that parent enabled → tool is enabled
  - [ ] Test: tool not mentioned in sub-agent config → disabled
  - [ ] Test: path intersection logic (both have paths, one empty, both empty)
  - [ ] Test: blocked paths union
  - [ ] Test: read tools get auto_approve=true regardless of parent config
  - [ ] Test: write tools inherit parent's auto_approve

### 2.2 Filter `use_subagent` from sub-agent tool lists

Section 3.3 requires defense-in-depth against recursive sub-agents.

- [ ] When building the sub-agent's tool list, always exclude `use_subagent` by name
- [ ] Add a guard in the `use_subagent` tool's `execute()`: if called from within a sub-agent context, return an error result immediately

---

## Phase 3: Sub-Agent Profile Discovery & Loading

Mirror the Personas directory convention for sub-agent profiles.

### 3.1 Define sub-agent profile types

- [ ] Create `src/sub-agents/types.ts` with:
  ```typescript
  interface SubAgentProfile {
    name: string;
    directory_path: string;
    system_prompt_path: string;
    prompt_content: string;
    description: string | null;
    preferred_provider: string | null;
    preferred_model: string | null;
    tool_configs: ParsedToolConfig[];
    is_builtin: boolean;
  }
  ```

### 3.2 Implement sub-agent profile discovery

Follow the pattern from `src/personas/persona-discovery.ts` — stateless discovery function, not a manager class.

- [ ] Create `src/sub-agents/discovery.ts`
  - [ ] Discovery path: `{notor_dir}/sub-agents/{agent-name}/system-prompt.md`
  - [ ] Parse YAML frontmatter for: `notor-preferred-provider`, `notor-preferred-model`, `notor-description`
  - [ ] Extract `<notor_tool_config>` blocks using existing `extractToolConfigs()` from `src/tool-config/parser.ts`
  - [ ] Strip frontmatter from prompt content (same regex pattern as persona discovery)
  - [ ] Return `SubAgentProfile[]`
- [ ] Write unit tests for discovery
  - [ ] Test: discovers profiles in correct directory
  - [ ] Test: parses frontmatter properties correctly
  - [ ] Test: extracts tool config blocks
  - [ ] Test: handles missing optional fields gracefully
  - [ ] Test: ignores directories without `system-prompt.md`

### 3.3 Implement built-in profile constants

Section 7.3: default system prompts stored as constants, vault files created on first "Open" click.

- [ ] Create `src/sub-agents/builtin-profiles.ts`
  - [ ] Define `BUILTIN_SUBAGENT_PROFILES` map with entries for `search-vault` and `search-web`
  - [ ] Each entry: `{ name, description, systemPrompt, toolConfig }` — the full content that would go in `system-prompt.md`
- [ ] Write `search-vault` system prompt and tool config
  - [ ] System prompt: focused vault search behavior, concise result formatting
  - [ ] Tool config: enable `search_vault`, `read_note`, `list_vault` (read-only tools)
- [ ] Write `search-web` system prompt and tool config
  - [ ] System prompt: focused web search behavior, source attribution
  - [ ] Tool config: enable `fetch_webpage` and any web search tools available

### 3.4 Implement sub-agent profile manager

- [ ] Create `src/sub-agents/manager.ts` with `SubAgentManager` class
  - [ ] `discoverProfiles(): Promise<SubAgentProfile[]>` — combines built-in + user-created profiles
  - [ ] `getVisibleProfiles(): SubAgentProfile[]` — filters by visibility toggle setting
  - [ ] `getProfile(name: string): SubAgentProfile | null`
  - [ ] `ensureBuiltinVaultFile(name: string): Promise<string>` — creates vault file from constant on first access, returns path
  - [ ] `resetToDefault(name: string): Promise<void>` — overwrites vault file with built-in constant
  - [ ] Visibility state stored in `NotorSettings` (e.g., `sub_agent_visibility: Record<string, boolean>`)

---

## Phase 4: SubAgentRunner Core

The mini-orchestrator that runs isolated sub-agent conversations.

### 4.1 Define the SUB_AGENT_PREAMBLE

Section 2.3: standard preamble prepended to every sub-agent's system prompt.

- [ ] Create `src/sub-agents/preamble.ts` with `SUB_AGENT_PREAMBLE` constant
  - [ ] Instructions: complete the specific request, return concise summary, don't ask clarifying questions, provide final answer directly
  - [ ] Keep it short — this consumes tokens on every sub-agent invocation

### 4.2 Implement `SubAgentRunner`

Section 9.1: separate class, not reuse of `ChatOrchestrator`.

- [ ] Create `src/chat/sub-agent-runner.ts`
  - [ ] Constructor parameters:
    - `provider: LLMProvider` — resolved provider instance
    - `model: string` — model ID
    - `systemPrompt: string` — preamble + profile prompt body
    - `toolDefinitions: ToolDefinition[]` — filtered by intersection config
    - `dispatcher: ToolDispatcher` — with pre-clamped effective config
    - `abortController: AbortController` — fresh per sub-agent, linked to parent
    - `iterationCap: number` — default 10
    - `mode: ConversationMode` — inherited from parent (Section 9.6)
    - `onProgress?: (status: string) => void` — optional progress callback
  - [ ] Define `SubAgentResult` type:
    ```typescript
    {
      text: string;
      messages: Message[];
      tokenUsage: { input: number; output: number };
      iterationCount: number;
      wasCapReached: boolean;
    }
    ```
  - [ ] Implement `run(taskPrompt: string): Promise<SubAgentResult>`
    - [ ] Initialize messages array with system message (preamble + profile prompt) and user message (task prompt)
    - [ ] Loop (up to iteration cap):
      1. Call `provider.sendMessage()` with current messages, tool definitions, options (model, abort_signal)
      2. Consume stream via `parseStreamEvents()` from Phase 1
      3. On text-only response (no tool calls) → break loop, return result
      4. On tool calls → dispatch via `dispatcher.dispatch()`, add tool_call and tool_result messages, call `onProgress`, continue loop
      5. On error → fail with error in result
      6. On abort → return partial result with cancelled marker
    - [ ] If iteration cap reached: return with `wasCapReached: true` and marker text per Section 9.8
    - [ ] Track cumulative token usage across all iterations
    - [ ] NO compaction, NO hooks, NO view rendering, NO ConversationManager/ContextManager

### 4.3 Implement abort propagation

Section 6.2: parent's Stop button must cancel all active sub-agents.

- [ ] Each `SubAgentRunner` gets its own `AbortController`
- [ ] The `use_subagent` tool links the parent's `AbortSignal` to the sub-agent's controller:
  - Listen to parent signal's `abort` event → call sub-agent controller's `abort()`
  - Clean up listener when sub-agent completes
- [ ] Sub-agent checks abort signal before each LLM call and tool execution

### 4.4 Write unit tests for `SubAgentRunner`

- [ ] Test: text-only response on first turn → returns immediately
- [ ] Test: tool call → tool result → text response → returns after 2 iterations
- [ ] Test: iteration cap reached → returns with `wasCapReached: true` and marker
- [ ] Test: provider error → fails with error
- [ ] Test: abort signal → returns partial result
- [ ] Test: `onProgress` called after each iteration with status string
- [ ] Test: token usage accumulated across iterations
- [ ] Test: write tool blocked in Plan mode

---

## Phase 5: The `use_subagent` Tool

Wire the runner into the tool system so the LLM can invoke sub-agents.

### 5.1 Implement the `use_subagent` tool

- [ ] Create `src/tools/use-subagent.ts` implementing `Tool` interface
  - [ ] `name`: `"use_subagent"`
  - [ ] `mode`: `"read"` — the tool itself is read-mode; sub-agent tools are independently gated
  - [ ] `description`: dynamically generated from visible sub-agent profiles (Section 8) — includes each profile's name and `notor-description`
  - [ ] `input_schema`: `{ profile: string (enum of visible names), task: string }`
  - [ ] `execute()` implementation:
    1. Validate profile name against visible profiles; reject if disabled (Section 7.2 defense-in-depth)
    2. Reject if called from within a sub-agent context (Section 3.3 defense-in-depth)
    3. Acquire semaphore slot (Section 9.3, cap of 3)
    4. Resolve provider: use profile's `preferred_provider`/`preferred_model` if set, else parent's. Fail with clear error if provider not configured (Section 4.1)
    5. Build effective tool config via `intersectToolConfig()` (Phase 2)
    6. Construct `SubAgentRunner` with resolved provider, assembled system prompt, clamped tools, fresh `AbortController`
    7. Call `runner.run(task)` and return result as `ToolResult`
    8. Release semaphore slot in `finally` block
  - [ ] Pass `onProgress` callback through to runner (Section 9.5)

### 5.2 Implement the concurrency semaphore

Section 9.3: dedicated semaphore, cap of 3, separate from the tool execution semaphore (cap of 5).

- [ ] Add `SUB_AGENT_CONCURRENCY_CAP = 3` constant
- [ ] Implement semaphore using the same `acquire()/release()` pattern from `tool-orchestration.ts` (L194-215)
- [ ] Semaphore lives in the `use_subagent` tool instance (or a shared module if needed)
- [ ] Write test: 4th concurrent sub-agent waits until one of the first 3 completes

### 5.3 Extend `Tool.execute()` signature for `onProgress`

Section 9.5: additive, non-breaking change.

- [ ] Update `Tool` interface in `src/tools/tool.ts`:
  - `execute(params: Record<string, unknown>, options?: { onProgress?: (status: string) => void }): Promise<ToolResult>`
- [ ] Update `ToolDispatcher.dispatch()` to accept and pass through `onProgress` when available
- [ ] No changes needed for existing tools — `options` parameter is optional

### 5.4 Register the tool

- [ ] Register `use_subagent` in `ToolRegistry` via `main.ts` initialization
  - [ ] Inject dependencies: `SubAgentManager`, `ProviderRegistry`, `ToolDispatcher` reference, parent `AbortSignal` access
- [ ] Implement dynamic description update: when visible profiles change (settings toggle), update the tool's description/schema
- [ ] Write integration test: end-to-end flow from tool call to sub-agent result

### 5.5 Configuration gap notices

Section 3.4: surface notices when sub-agent profile enables a tool that the parent has disabled.

- [ ] After computing `intersectToolConfig()`, compare sub-agent's requested tools vs. effective tools
- [ ] If any tool was enabled in the profile but disabled by parent context, surface a `Notice` with the tool name and an action to open the sub-agent's config file

---

## Phase 6: Conversation History & Token Tracking

### 6.1 Sub-agent JSONL file creation

Section 5.1: separate file per sub-agent invocation.

- [ ] Generate sub-agent history filename: `{parent_timestamp}_{parent_id}_subagent_{invocation_id}.jsonl`
  - [ ] `invocation_id`: UUID generated per `use_subagent` call
- [ ] Write sub-agent conversation to its own JSONL file using `HistoryManager`
  - [ ] Header line: conversation metadata (sub-agent name, parent reference, provider/model used)
  - [ ] Message lines: all messages from `SubAgentResult.messages`
- [ ] Store JSONL file path reference in parent's `tool_result` message metadata

### 6.2 Token roll-up

Section 9.2: aggregate sub-agent tokens into parent totals.

- [ ] When adding the `tool_result` message for `use_subagent` to the parent conversation:
  - [ ] Include `SubAgentResult.tokenUsage` in message metadata
  - [ ] Roll `input` and `output` tokens into `Conversation.total_input_tokens` / `total_output_tokens`
- [ ] Token footer in chat view shows rolled-up total (no UI changes needed — existing footer reads from conversation totals)

### 6.3 Export handling

Section 5.3: markdown export gets summary only, HTML export gets expandable detail.

- [ ] Markdown export: include only the sub-agent's summary text in the `tool_result` block
- [ ] HTML export: render an expandable `<details>` section containing the full sub-agent conversation
  - [ ] Load sub-agent JSONL from the referenced file path
  - [ ] Format messages in the same style as the parent conversation

---

## Phase 7: Settings UI

### 7.1 Create the "Sub-agents" settings section

Section 7.1: follows the Personas settings pattern in `src/settings/sections/personas.ts`.

- [ ] Create `src/settings/sections/sub-agents.ts`
  - [ ] Section heading: "Sub-agents"
  - [ ] Description text explaining sub-agent purpose
  - [ ] "Create new sub-agent" button:
    - [ ] Prompt for name via `promptForName()` helper (from `shared.ts`)
    - [ ] Create directory `{notor_dir}/sub-agents/{name}/`
    - [ ] Create skeleton `system-prompt.md` with frontmatter template:
      ```yaml
      ---
      notor-description: ""
      # notor-preferred-provider: anthropic
      # notor-preferred-model: claude-sonnet-4-20250514
      ---
      ```
    - [ ] Include placeholder `<notor_tool_config>` block
    - [ ] Open the new file in a leaf for immediate editing
  - [ ] List of discovered sub-agent profiles, each with:
    - [ ] Name label (+ "Built-in" badge for built-in profiles)
    - [ ] Visibility toggle (whether the profile is available to the LLM)
    - [ ] Open button (using `square-arrow-out-up-right` Lucide icon) to open profile in a new leaf
      - [ ] For built-in profiles: creates vault file from constant on first click, then opens it
    - [ ] "Reset to default" action for built-in profiles (visible only if vault file exists and differs from constant)

### 7.2 Wire settings section into settings tab

- [ ] Import and call `renderSubAgentsSection()` from `settings-tab.ts`
- [ ] Add `sub_agent_visibility` to `NotorSettings` interface (default: all visible)
- [ ] Add `sub_agent_auto_approve_reads` to `NotorSettings` (default: `true`, per Section 9.7)
- [ ] Add `sub_agent_concurrency_cap` to `NotorSettings` for advanced users (default: 3, per Section 9.3)

---

## Phase 8: UX & Progress Visibility

### 8.1 Progress display in chat view

Section 6.1: show sub-agent activity in the tool call UI element.

- [ ] When `use_subagent` tool call is rendered, show a spinner/status indicator
- [ ] Wire `onProgress` callback from `SubAgentRunner` through `use_subagent.execute()` to the view layer
  - [ ] `ToolDispatcher` passes `onProgress` through to tool `execute()`
  - [ ] View renders progress updates as status text below the spinner (e.g., "Searching vault... (turn 3/10)")
- [ ] On completion: replace spinner with the sub-agent's final response text in the tool result area

### 8.2 Cancellation UX

Section 6.2: Stop button propagates to sub-agents.

- [ ] Verify the abort propagation from Phase 4.3 correctly stops in-flight sub-agents
- [ ] When a sub-agent is cancelled, show partial results (if any) with a "[Cancelled]" marker
- [ ] The parent LLM receives the partial result and can decide how to proceed

---

## Phase 9: Polish & Edge Cases

### 9.1 Error handling refinement

Section 9.8: return partial results on cap, fail fast on provider errors.

- [ ] Verify iteration cap behavior: result includes marker text and `wasCapReached: true`
- [ ] Verify provider errors (auth, rate limit) fail immediately with clear error in `ToolResult`
- [ ] Verify tool execution errors within sub-agent are fed back to the sub-agent LLM for retry
- [ ] Verify abort returns partial results with cancelled marker

### 9.2 Plan/Act mode enforcement

Section 9.6: sub-agents always inherit parent's mode.

- [ ] Verify write tools are blocked when parent is in Plan mode
- [ ] Verify mode cannot be overridden by sub-agent profile configuration
- [ ] Write test: sub-agent in Plan mode parent cannot execute write tools

### 9.3 Concurrent sub-agent safety

Section 4.2 & 4.3: providers must be safe for concurrent use.

- [ ] Verify all providers have per-request-local mutable state (already confirmed in design doc research, but validate with integration test)
- [ ] Write test: 3 concurrent sub-agents with same provider complete without interference
- [ ] Write test: concurrent sub-agents with different providers work correctly

### 9.4 Edge case: empty profile description

- [ ] If a profile has no `notor-description`, omit it from the `use_subagent` tool description (don't show "undefined" or empty string)
- [ ] Log a warning encouraging the user to add a description

### 9.5 Edge case: profile hot-reload

- [ ] When user edits a sub-agent profile's `system-prompt.md` while the plugin is running, the next `use_subagent` call should pick up the changes
- [ ] Discovery is called fresh for each tool invocation (or cached with short TTL)
