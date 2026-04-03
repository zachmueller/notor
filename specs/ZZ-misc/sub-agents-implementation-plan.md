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

- [x] Add `intersectToolConfig()` function to `src/tool-config/merger.ts`
  - [x] Signature: `intersectToolConfig(parentEffective: EffectiveToolConfig, subAgentConfig: ParsedToolConfig, toolModes: Record<string, "read" | "write">): EffectiveToolConfig`
  - [x] Per-tool logic:
    - `enabled = parent.enabled AND subagent.enabled` (tool must be enabled in both)
    - `allowed_paths = intersection(parent.allowed_paths, subagent.allowed_paths)` — paths must appear in both (empty = no restriction, so empty ∩ X = X)
    - `blocked_paths = union(parent.blocked_paths, subagent.blocked_paths)` — either block applies
    - `auto_approve`: force `true` for tools with `mode === "read"`; use parent's value for write tools
  - [x] Tools not mentioned in the sub-agent config are disabled (default-deny per Section 3.1)
  - [x] Do NOT modify existing `mergeToolConfigs()` — this is a new function
- [x] Write unit tests for `intersectToolConfig()`
  - [x] Test: sub-agent enables tool that parent disabled → tool is disabled
  - [x] Test: sub-agent enables tool that parent enabled → tool is enabled
  - [x] Test: tool not mentioned in sub-agent config → disabled
  - [x] Test: path intersection logic (both have paths, one empty, both empty)
  - [x] Test: blocked paths union
  - [x] Test: read tools get auto_approve=true regardless of parent config
  - [x] Test: write tools inherit parent's auto_approve

### 2.2 Filter `use_subagent` from sub-agent tool lists

Section 3.3 requires defense-in-depth against recursive sub-agents.

- [x] When building the sub-agent's tool list, always exclude `use_subagent` by name
- [x] Add a guard in the `use_subagent` tool's `execute()`: if called from within a sub-agent context, return an error result immediately _(implemented in Phase 5.3d Step 2 via `_isSubAgentContext` flag)_

---

## Phase 3: Sub-Agent Profile Discovery & Loading

Mirror the Personas directory convention for sub-agent profiles.

### 3.1 Define sub-agent profile types

- [x] Create `src/sub-agents/types.ts` with:
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

- [x] Create `src/sub-agents/discovery.ts`
  - [x] Discovery path: `{notor_dir}/sub-agents/{agent-name}/system-prompt.md`
  - [x] Parse YAML frontmatter for: `notor-preferred-provider`, `notor-preferred-model`, `notor-description`
  - [x] Extract `<notor_tool_config>` blocks using existing `extractToolConfigs()` from `src/tool-config/parser.ts`
  - [x] Strip frontmatter from prompt content (same regex pattern as persona discovery)
  - [x] Return `SubAgentProfile[]`
- [x] Write unit tests for discovery
  - [x] Test: discovers profiles in correct directory
  - [x] Test: parses frontmatter properties correctly
  - [x] Test: extracts tool config blocks
  - [x] Test: handles missing optional fields gracefully
  - [x] Test: ignores directories without `system-prompt.md`

### 3.3 Implement built-in profile constants

Section 7.3: default system prompts stored as constants, vault files created on first "Open" click.

- [x] Create `src/sub-agents/builtin-profiles.ts`
  - [x] Define `BUILTIN_SUBAGENT_PROFILES` map with entries for `search-vault` and `search-web`
  - [x] Each entry: `{ name, description, systemPrompt, toolConfig }` — the full content that would go in `system-prompt.md`
- [x] Write `search-vault` system prompt and tool config
  - [x] System prompt: focused vault search behavior, concise result formatting
  - [x] Tool config: enable `search_vault`, `read_note`, `list_vault` (read-only tools)
- [x] Write `search-web` system prompt and tool config
  - [x] System prompt: focused web search behavior, source attribution
  - [x] Tool config: enable `fetch_webpage` and any web search tools available

### 3.4 Implement sub-agent profile manager

- [x] Create `src/sub-agents/manager.ts` with `SubAgentManager` class
  - [x] `discoverProfiles(): Promise<SubAgentProfile[]>` — combines built-in + user-created profiles
  - [x] `getVisibleProfiles(): SubAgentProfile[]` — filters by visibility toggle setting
  - [x] `getProfile(name: string): SubAgentProfile | null`
  - [x] `ensureBuiltinVaultFile(name: string): Promise<string>` — creates vault file from constant on first access, returns path
  - [x] `resetToDefault(name: string): Promise<void>` — overwrites vault file with built-in constant
  - [x] Visibility state stored in `NotorSettings` (e.g., `sub_agent_visibility: Record<string, boolean>`)

---

## Phase 4: SubAgentRunner Core

The mini-orchestrator that runs isolated sub-agent conversations.

### 4.1 Define the SUB_AGENT_PREAMBLE

Section 2.3: standard preamble prepended to every sub-agent's system prompt.

- [x] Create `src/sub-agents/preamble.ts` with `SUB_AGENT_PREAMBLE` constant
  - [x] Instructions: complete the specific request, return concise summary, don't ask clarifying questions, provide final answer directly
  - [x] Keep it short — this consumes tokens on every sub-agent invocation

### 4.2 Implement `SubAgentRunner`

Section 9.1: separate class, not reuse of `ChatOrchestrator`.

- [x] Create `src/chat/sub-agent-runner.ts`
  - [x] Constructor parameters:
    - `provider: LLMProvider` — resolved provider instance
    - `model: string` — model ID
    - `systemPrompt: string` — preamble + profile prompt body
    - `toolDefinitions: ToolDefinition[]` — filtered by intersection config
    - `dispatcher: ToolDispatcher` — with pre-clamped effective config
    - `abortController: AbortController` — fresh per sub-agent, linked to parent
    - `iterationCap: number` — default 10
    - `mode: ConversationMode` — inherited from parent (Section 9.6)
    - `onProgress?: (status: string) => void` — optional progress callback
  - [x] Define `SubAgentResult` type:
    ```typescript
    {
      text: string;
      messages: Message[];
      tokenUsage: { input: number; output: number };
      iterationCount: number;
      wasCapReached: boolean;
    }
    ```
  - [x] Implement `run(taskPrompt: string): Promise<SubAgentResult>`
    - [x] Initialize messages array with system message (preamble + profile prompt) and user message (task prompt)
    - [x] Loop (up to iteration cap):
      1. Call `provider.sendMessage()` with current messages, tool definitions, options (model, abort_signal)
      2. Consume stream via `parseStreamEvents()` from Phase 1
      3. On text-only response (no tool calls) → break loop, return result
      4. On tool calls → dispatch via `dispatcher.dispatch()`, add tool_call and tool_result messages, call `onProgress`, continue loop
      5. On error → fail with error in result
      6. On abort → return partial result with cancelled marker
    - [x] If iteration cap reached: return with `wasCapReached: true` and marker text per Section 9.8
    - [x] Track cumulative token usage across all iterations
    - [x] NO compaction, NO hooks, NO view rendering, NO ConversationManager/ContextManager

### 4.3 Implement abort propagation

Section 6.2: parent's Stop button must cancel all active sub-agents.

- [x] Each `SubAgentRunner` gets its own `AbortController`
- [x] The `use_subagent` tool links the parent's `AbortSignal` to the sub-agent's controller:
  - Listen to parent signal's `abort` event → call sub-agent controller's `abort()`
  - Clean up listener when sub-agent completes
- [x] Sub-agent checks abort signal before each LLM call and tool execution

### 4.4 Write unit tests for `SubAgentRunner`

- [x] Test: text-only response on first turn → returns immediately
- [x] Test: tool call → tool result → text response → returns after 2 iterations
- [x] Test: iteration cap reached → returns with `wasCapReached: true` and marker
- [x] Test: provider error → fails with error
- [x] Test: abort signal → returns partial result
- [x] Test: `onProgress` called after each iteration with status string
- [x] Test: token usage accumulated across iterations
- [x] Test: write tool blocked in Plan mode

---

## Phase 5: The `use_subagent` Tool

Wire the runner into the tool system so the LLM can invoke sub-agents.

**Task order**: 5.1 and 5.2 are independent prerequisites. 5.3 depends on both. 5.4 depends on 5.3. 5.5 is part of 5.3 (embedded in `execute()`).

### 5.1 Extend `Tool.execute()` signature for `onProgress`

Section 9.5: additive, non-breaking change. This is a prerequisite for 5.3 so that `use_subagent` can receive progress callbacks through the standard tool interface.

The `onProgress` callback flows: orchestrator → `executeToolBatches()` → `safeDispatch()` → `dispatcher.dispatch()` → `tool.execute()` → `SubAgentRunner`. For Phase 5, only the plumbing is wired; the orchestrator passes `undefined` until Phase 8 adds view-layer integration.

- [x] Define `ToolExecuteOptions` type in `src/tools/tool.ts`
  ```typescript
  export interface ToolExecuteOptions {
    /** Progress callback for long-running tools (Section 9.5). */
    onProgress?: (status: string) => void;
    /** Current conversation mode — tools like use_subagent need this to propagate to child contexts. */
    mode?: ConversationMode;
    /** Abort signal — currently handled via Promise.race at the dispatcher level (L475-491), but tools like use_subagent need it inside execute() to pass to SubAgentRunner. */
    abortSignal?: AbortSignal;
  }
  ```
  - Adding `mode` and `abortSignal` eliminates the need for `getParentMode` and `getParentAbortSignal` callbacks on `UseSubagentTool`'s constructor (see 5.3a). Currently, the dispatcher handles abort via `Promise.race` externally (L475-491) and mode is checked before `execute()` (L312). By also passing them through options, tools that need these values (like `use_subagent`) can access them without constructor-injected callbacks. Existing tools ignore them.
- [x] Update `Tool` interface in `src/tools/tool.ts` (L53-72):
  - Change `execute` signature to: `execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult>`
  - Existing tools don't need changes — `options` is optional and they ignore it
- [x] Update `DispatchableTool` interface in `src/chat/dispatcher.ts` (L58-62):
  - Change `execute` signature to match: `execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult>`
  - Import `ToolExecuteOptions` from `../tools/tool`
- [x] Update `ToolDispatcher.dispatch()` in `src/chat/dispatcher.ts` (L262-268):
  - Add `onProgress?: (status: string) => void` parameter to `dispatch()` signature
  - At the `tool.execute()` call site (L472), pass options: `tool.execute(parameters, { onProgress, mode, abortSignal })`
  - The dispatcher already has `mode` and `abortSignal` in scope at this point — just thread them through
- [x] Thread `onProgress` through tool orchestration in `src/chat/tool-orchestration.ts`:
  - Add optional `onProgress?: Map<string, (status: string) => void>` parameter to `executeToolBatches()` (L112) — keyed by tool call ID, since multiple tools execute in a batch
  - Thread through `runConcurrentBatch()` (L184) and `safeDispatch()` (L246) to `dispatcher.dispatch()`
  - For Phase 5, all callers pass `undefined` — the orchestrator/SubAgentRunner don't provide progress callbacks yet (Phase 8 wires the view-layer)
- [x] Verify all existing tests pass — the new parameter is optional everywhere

### 5.2 Implement the concurrency semaphore

Section 9.3: dedicated semaphore, cap of 3, separate from tool-orchestration's cap of 5.

`SUB_AGENT_CONCURRENCY_CAP` already exists in `src/sub-agents/constants.ts` (L42). The semaphore implementation is new.

- [x] Create `src/sub-agents/semaphore.ts` with a reusable `Semaphore` class
  - Follow the inline pattern from `tool-orchestration.ts` (L194-215) but as a standalone class:
    ```typescript
    export class Semaphore {
      private activeCount = 0;
      private waitQueue: Array<() => void> = [];
      constructor(private readonly cap: number) {}
      async acquire(): Promise<void> { /* ... */ }
      release(): void { /* ... */ }
      get pending(): number { return this.waitQueue.length; }
      get active(): number { return this.activeCount; }
    }
    ```
  - `acquire()`: if `activeCount < cap`, increment and return; otherwise push a resolve callback to `waitQueue` and return a Promise
  - `release()`: decrement `activeCount`, shift next waiter from queue and call it
  - `pending` and `active` getters for diagnostics/testing
- [x] Write unit tests in `src/sub-agents/semaphore.test.ts`
  - [x] Test: acquire up to cap succeeds immediately
  - [x] Test: acquire beyond cap blocks until release
  - [x] Test: 4th concurrent acquire waits until one of the first 3 releases
  - [x] Test: release order matches FIFO queue order
  - [x] Test: `active` and `pending` getters report correct counts

### 5.3 Implement the `use_subagent` tool

This is the main task. Create `src/tools/use-subagent.ts` implementing the `Tool` interface. The tool needs several dependencies injected via its constructor.

#### 5.3a Constructor & dependencies

- [x] Create `src/tools/use-subagent.ts` with `UseSubagentTool implements Tool`
  - `name`: `USE_SUBAGENT_TOOL_NAME` (from `src/sub-agents/constants.ts`)
  - `mode`: `"read"` — the tool itself is read-mode; sub-agent tools are independently gated
  - Constructor dependencies:
    ```typescript
    constructor(
      private readonly subAgentManager: SubAgentManager,
      private readonly providerRegistry: ProviderRegistry,
      private readonly toolRegistry: ToolRegistry,
      private readonly settings: NotorSettings,
      private readonly getParentEffectiveConfig: () => EffectiveToolConfig | null,
    )
    ```
  - **`getParentEffectiveConfig`**: a callback returning the orchestrator's current `effectiveToolConfig`. At execution time, the parent's effective config may have changed since the tool was registered. The orchestrator exposes `getEffectiveToolConfig()` (orchestrator.ts L221) — the callback wraps it.
  - **`mode` and `abortSignal`**: received at execution time via `ToolExecuteOptions` (defined in 5.1), not as constructor callbacks. The dispatcher threads these through `tool.execute(params, { mode, abortSignal, onProgress })`. This is cleaner than constructor injection because these values change per-invocation.
  - A `Semaphore` instance created in the constructor with cap from `settings.sub_agent_concurrency_cap`
  - A `_isSubAgentContext` boolean flag, defaulting to `false` (for defense-in-depth, Section 3.3)
  - A `vaultRootPath?: string` field set via a public setter (called from `main.ts` after construction, same pattern as `ToolDispatcher.setVaultRootPath()`)
  - A `parentApprovalCallback?: ApprovalCallback` field set via a public setter (for the "bubble" pattern — write tool approvals surface in the parent chat)

#### 5.3b Dynamic `description` and `input_schema`

Section 8: profile list is embedded in the tool description, not a separate system prompt section.

- [x] Implement `description` as a TypeScript getter that rebuilds dynamically:
  ```typescript
  get description(): string {
    // Returns base description + profile list with descriptions
  }
  ```
  - `ToolRegistry.getToolDefinitions()` (index.ts L108-114) reads `tool.description` directly — a getter satisfies the interface property requirement
  - Base description: "Spawn a focused sub-agent to perform a specific task. Available profiles:\n"
  - For each visible profile from `this.cachedVisibleProfiles`: append `- {name}: {description}` (skip profiles with `null` description, per Phase 9 edge case 9.4)
  - Call `refreshVisibleProfiles()` to update `this.cachedVisibleProfiles` lazily (see 5.3c)
- [x] Implement `input_schema` as a getter:
  ```typescript
  get input_schema(): JSONSchema {
    return {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description: "Name of the sub-agent profile to use.",
          enum: this.cachedVisibleProfiles.map(p => p.name),
        },
        task: {
          type: "string",
          description: "The specific task or question for the sub-agent to complete.",
        },
      },
      required: ["profile", "task"],
    };
  }
  ```
  - The `enum` constraint keeps the LLM from hallucinating profile names

#### 5.3c Profile caching & refresh

`SubAgentManager.getVisibleProfiles()` does async disk I/O. Tool property getters (`description`, `input_schema`) must be synchronous. Solution: cache the profile list and refresh it periodically.

- [x] Add `private cachedVisibleProfiles: SubAgentProfile[] = []` instance field
- [x] Add `async refreshVisibleProfiles(): Promise<void>` method:
  - Calls `this.subAgentManager.getVisibleProfiles(this.toolRegistry.getNames())`
  - Updates `this.cachedVisibleProfiles`
  - Called once at registration time (from `main.ts` after constructing the tool)
  - Called at the start of each `execute()` invocation (ensures hot-reload, Phase 9 edge case 9.5)
  - Called when settings change (visibility toggle) — wired in Phase 7

#### 5.3d `execute()` implementation — step by step

- [x] `execute(params, options?)` method:

  **Step 1: Refresh profiles & validate**
  - `await this.refreshVisibleProfiles()`
  - Extract `profile` and `task` from `params`
  - Look up profile by name in `cachedVisibleProfiles`; if not found, return error `ToolResult`: `"Sub-agent profile '{name}' not found or is disabled."`
  - Check `this.subAgentManager.isVisible(profile.name)` as defense-in-depth (Section 7.2)

  **Step 2: Defense-in-depth — reject if in sub-agent context**
  - If `this._isSubAgentContext` is true, return error `ToolResult`: `"use_subagent cannot be called from within a sub-agent."`
  - This flag is only set when the tool instance is used inside a sub-agent's dispatcher (which shouldn't happen since `filterSubAgentTools` removes it — this is the belt to that suspender)

  **Step 3: Acquire semaphore slot**
  - `await this.semaphore.acquire()`
  - Wrap the entire remaining logic in `try/finally` with `this.semaphore.release()` in `finally`

  **Step 4: Resolve provider and model**
  - If `profile.preferred_provider` is set:
    - Call `this.providerRegistry.getProvider(profile.preferred_provider as LLMProviderType)`
    - Wrap in try/catch — if `ProviderError` is thrown, return error `ToolResult`: `"Provider '{type}' is not configured for sub-agent '{name}'."`
  - Else: use `this.providerRegistry.getActiveProvider()`
  - Model resolution: `profile.preferred_model` if set, else fall back to the parent's model. The parent's model is stored in `LLMProviderConfig.model_id` (types.ts L242). Resolve via:
    ```typescript
    const providerType = profile.preferred_provider as LLMProviderType
      ?? this.providerRegistry.getActiveType();
    const providerConfig = this.providerRegistry.getConfig(providerType);
    const model = profile.preferred_model ?? providerConfig?.model_id ?? "";
    ```
    - If `model` is empty after resolution, return error `ToolResult` — a model ID is required for `SubAgentRunner`

  **Step 5: Build sub-agent's effective tool config**
  - Get the parent's effective config: `const parentConfig = this.getParentEffectiveConfig()`
  - If `parentConfig` is null, build a permissive default: all tools enabled with default settings (same as when no `<notor_tool_config>` is active)
  - Merge the profile's `tool_configs` array (multiple `ParsedToolConfig` entries) into a single `ParsedToolConfig`:
    ```typescript
    const mergedSubAgentConfig: ParsedToolConfig = {
      source: "subagent",
      sourceFile: profile.system_prompt_path,
      documentPosition: 0,
      tools: {},
    };
    for (const config of profile.tool_configs) {
      Object.assign(mergedSubAgentConfig.tools, config.tools);
    }
    ```
    - Last-writer-wins for duplicate tool names within the same profile (consistent with document-order semantics)
  - Build `toolModes` map from `ToolRegistry`:
    ```typescript
    const toolModes: Record<string, "read" | "write"> = {};
    for (const tool of this.toolRegistry.getAll()) {
      toolModes[tool.name] = tool.mode;
    }
    ```
  - Call `intersectToolConfig(parentConfig, mergedSubAgentConfig, toolModes)` from `src/tool-config/merger.ts`

  **Step 6: Configuration gap detection (5.5)**
  - Compare the profile's requested tools (keys in `mergedSubAgentConfig.tools` where `enabled !== false`) against the intersected result
  - For each tool that the profile enabled but the intersection disabled (because the parent had it disabled): collect the tool name
  - If any gaps found, emit an Obsidian `Notice`: `"Sub-agent '{name}': tools [{gaps}] are enabled in the profile but disabled in the current context."`
  - Log the gap at `warn` level for diagnostics

  **Step 7: Build sub-agent tool definitions and dispatcher**
  - Get enabled tool names from the intersected config:
    ```typescript
    const enabledToolNames = Object.entries(intersectedConfig.tools)
      .filter(([_, entry]) => entry.enabled)
      .map(([name]) => name);
    ```
  - Build `ToolDefinition[]` for the LLM — map `enabledToolNames` through `toolRegistry.get(name)`:
    ```typescript
    const toolDefs: ToolDefinition[] = enabledToolNames
      .map(name => this.toolRegistry.get(name))
      .filter((t): t is Tool => t !== undefined)
      .map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
    ```
    - This naturally excludes `use_subagent` because it's not in the intersected config (default-deny: `intersectToolConfig` only includes tools from the sub-agent's config, and no profile includes `use_subagent`)
  - Create a new `ToolDispatcher` instance for this sub-agent:
    ```typescript
    const subDispatcher = new ToolDispatcher();
    for (const name of enabledToolNames) {
      const tool = this.toolRegistry.get(name);
      if (tool) subDispatcher.registerTool(tool);
    }
    subDispatcher.setEffectiveToolConfig(intersectedConfig);
    subDispatcher.setSettings(this.settings);
    // Copy vault root path for path enforcement
    if (this.vaultRootPath) subDispatcher.setVaultRootPath(this.vaultRootPath);
    ```
  - **Approval callback**: For read tools, `auto_approve` is forced `true` in the intersected config, so no approval prompt fires. For write tools, the parent's `auto_approve` is inherited. If a write tool needs manual approval, the sub-agent dispatcher needs the parent's `approvalCallback`:
    - Pass the parent's approval callback to the sub-dispatcher: `subDispatcher.setApprovalCallback(this.parentApprovalCallback)`
    - Add `parentApprovalCallback` as a constructor dependency (or a setter called after registration)
    - This implements the "bubble" pattern from Claude Code (design doc Section 9.7)

  **Step 8: Assemble system prompt**
  - `const systemPrompt = SUB_AGENT_PREAMBLE + "\n" + profile.prompt_content`
  - `SUB_AGENT_PREAMBLE` is from `src/sub-agents/preamble.ts`

  **Step 9: Construct and run SubAgentRunner**
  - Extract `abortSignal` and `mode` from `options` (these flow through `ToolExecuteOptions` from the dispatcher):
    ```typescript
    const abortSignal = options?.abortSignal;
    const mode = options?.mode ?? "act";  // defensive default
    ```
  - If no abort signal is available, create a standalone `AbortController` (shouldn't happen in normal flow, but defensive):
    ```typescript
    const parentSignal = abortSignal ?? new AbortController().signal;
    ```
  - Construct the runner:
    ```typescript
    const runner = new SubAgentRunner({
      provider,
      model,
      systemPrompt,
      toolDefinitions: toolDefs,
      dispatcher: subDispatcher,
      parentAbortSignal: parentSignal,
      iterationCap: SUB_AGENT_ITERATION_CAP,
      mode,
      onProgress: options?.onProgress,
    });
    ```
  - Call `const result = await runner.run(task)`

  **Step 10: Format and return ToolResult**
  - On success:
    ```typescript
    return {
      tool_name: USE_SUBAGENT_TOOL_NAME,
      success: true,
      result: result.text,
    };
    ```
  - The `result.tokenUsage`, `result.messages`, `result.wasCapReached`, and `result.iterationCount` are needed for Phase 6 (history/token tracking) — store them on the instance or return as structured metadata. For Phase 5, only `result.text` goes into the `ToolResult`. Phase 6 will extend this.

#### 5.3e Unit tests

- [x] Create `src/tools/use-subagent.test.ts`
  - [x] Test: valid profile + task → SubAgentRunner is constructed and run, result returned as ToolResult
  - [x] Test: unknown profile name → error ToolResult
  - [x] Test: disabled profile (visibility toggle off) → error ToolResult
  - [x] Test: `_isSubAgentContext` flag set → error ToolResult (defense-in-depth)
  - [x] Test: provider not configured for profile's preferred_provider → error ToolResult
  - [x] Test: semaphore limits concurrent executions to cap
  - [x] Test: configuration gap detection emits Notice for disabled-by-parent tools
  - [x] Test: `onProgress` callback is threaded through to SubAgentRunner
  - [x] Test: dynamic `description` getter includes visible profile names and descriptions
  - [x] Test: dynamic `input_schema` getter has `enum` matching visible profile names
  - [x] Test: profile with no description is excluded from description text
  - [x] Test: profile's multiple tool_config blocks are merged (last-writer-wins)
  - [x] Test: intersected config correctly restricts sub-agent tools to parent ∩ profile

### 5.4 Register the tool

Wire `UseSubagentTool` into the plugin initialization and dispatch pipeline.

- [x] Add `SubAgentManager` instantiation to `main.ts` if not already present:
  - Check if `getSubAgentManager()` getter exists; if not, add it following the existing lazy-init pattern (like `getToolRegistry()` at L1001)
  - Dependencies: `this.app.vault`, `this.app.metadataCache`, `this.settings`, `() => this.saveData()`, `parseYaml` from obsidian
- [x] Register `UseSubagentTool` in `getToolRegistry()` (main.ts ~L1001-1056):
  ```typescript
  // Sub-agent tool
  const useSubagentTool = new UseSubagentTool(
    this.getSubAgentManager(),
    this.getProviderRegistry(),
    this._toolRegistry,  // self-reference — see note below
    this.settings,
    () => this.getOrchestrator()?.getEffectiveToolConfig() ?? null,
  );
  // Set vault root path for sub-agent dispatcher path enforcement
  const adapter = this.app.vault.adapter as { basePath?: string };
  if (adapter.basePath) {
    useSubagentTool.setVaultRootPath(adapter.basePath);
  }
  this._toolRegistry.register(useSubagentTool);
  ```
  - **Circular dependency note**: The tool needs `ToolRegistry` to enumerate tools, and the registry holds the tool. This is fine because the tool only reads from the registry at `execute()` time (not at construction time). The `this._toolRegistry` reference is valid since it's being populated in the same method.
  - **Orchestrator access**: The `getParentEffectiveConfig` callback needs the orchestrator instance. Since the orchestrator is created lazily (after the registry), use a closure: `() => this.getOrchestrator()?.getEffectiveToolConfig()`. Verify that a `getOrchestrator()` getter exists or add one.
  - **Approval callback**: Set after the dispatcher is created in `getToolDispatcher()`, since the dispatcher holds the approval callback. Add a line after dispatcher setup: `useSubagentTool.setApprovalCallback(this._toolDispatcher.getApprovalCallback())` — or store a reference to the callback separately. Alternatively, `UseSubagentTool` could receive a `getApprovalCallback` closure.
- [x] Call `useSubagentTool.refreshVisibleProfiles()` after registration to populate the initial profile cache:
  ```typescript
  useSubagentTool.refreshVisibleProfiles().catch(e =>
    log.warn("Failed to load initial sub-agent profiles", { error: String(e) })
  );
  ```
  - This is fire-and-forget — if it fails, profiles will be loaded on first `execute()` call
- [ ] Verify that the tool appears in `getToolDefinitions()` output and that its dynamic description/schema are correct _(deferred to manual testing / Phase 8)_
- [ ] Write integration test: mock SubAgentManager with test profiles → call dispatcher.dispatch("use_subagent", ...) → verify SubAgentRunner is invoked with correct parameters and result flows back _(deferred to Phase 8 integration)_

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
- [x] Add `sub_agent_visibility` to `NotorSettings` interface (default: all visible) — already exists in `settings/types.ts` L290 and `settings/defaults.ts` L160
- [x] Add `sub_agent_auto_approve_reads` to `NotorSettings` (default: `true`, per Section 9.7) — already exists in `settings/types.ts` L298 and `settings/defaults.ts` L161
- [x] Add `sub_agent_concurrency_cap` to `NotorSettings` for advanced users (default: 3, per Section 9.3) — already exists in `settings/types.ts` L306 and `settings/defaults.ts` L162

---

## Phase 8: UX & Progress Visibility

### 8.1 Progress display in chat view

Section 6.1: show sub-agent activity in the tool call UI element. Phase 5.1 added the `onProgress` plumbing through the dispatch chain (ToolExecuteOptions → dispatcher → tool). This phase wires the view layer to produce and consume those callbacks.

- [ ] When `use_subagent` tool call is rendered, show a spinner/status indicator
- [ ] Wire the orchestrator to supply `onProgress` callbacks when dispatching tool calls:
  - [ ] In `ChatOrchestrator`, when calling `executeToolBatches()`, build an `onProgress` map for `use_subagent` tool calls that routes status text to the view's tool call UI element
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
