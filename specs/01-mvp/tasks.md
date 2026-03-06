# Task Breakdown: Notor MVP

**Created:** 2026-06-03
**Implementation Plan:** [plan.md](plan.md)
**Specification:** [spec.md](spec.md)
**Status:** Planning

> **⚠️ MANDATORY: Before starting implementation work on any phase, you MUST read ALL reference files listed for that phase into context.** These reference files contain critical design decisions, API contracts, data models, and research findings that directly inform the implementation. Skipping this step risks building against outdated assumptions or missing key requirements. Each phase section below lists its required reference files — load every one of them before writing any code for that phase.

## Task Summary

**Total Tasks:** 49
**Phases:** 7 (Setup → Foundation → Providers → Chat UI → Tools → Trust & Safety → Polish)
**Estimated Complexity:** High
**Parallel Execution Opportunities:** 12 task groups

---

## Phase 0: Setup & Environment

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/spec.md` — full MVP specification, NFRs, settings defaults
- `specs/01-mvp/data-model.md` — entity definitions, Plugin Settings table, JSONL schema, all type interfaces
- `specs/01-mvp/plan.md` — architecture decisions, technology stack rationale
- `specs/01-mvp/quickstart.md` — project structure, planned source structure, code conventions
- `design/architecture.md` — LLM provider layer, credential storage, message structure
- `design/research/obsidian-secrets-manager.md` — SecretStorage API surface, minAppVersion requirements

### ENV-001: Project restructure and settings foundation ✅
**Description:** Replace sample plugin scaffolding with Notor's settings interface, types, and module structure. Remove sample modal, ribbon icon, status bar, and placeholder commands from `main.ts`. Create the settings interface from the data model with all MVP settings fields and defaults.
**Files:**
- `src/main.ts` — strip to minimal lifecycle shell
- `src/settings.ts` — replace `MyPluginSettings` with `NotorSettings`, `DEFAULT_SETTINGS`, and `NotorSettingTab`
- `src/types.ts` — shared TypeScript interfaces (Conversation, Message, ToolCall, ToolResult, Checkpoint, ModelInfo, etc.)
**Dependencies:** None
**Acceptance Criteria:**
- [x] `main.ts` contains only `onload`/`onunload` with settings loading and setting tab registration
- [x] All sample code (SampleModal, ribbon icon, status bar, sample commands, click listener, interval) removed
- [x] `NotorSettings` interface matches data model (all fields from Plugin Settings table in data-model.md)
- [x] `DEFAULT_SETTINGS` matches specified defaults (plan mode, local provider, auto-approve read tools, etc.)
- [x] `src/types.ts` contains all shared entity interfaces from data-model.md
- [x] Plugin class renamed from `MyPlugin` to `NotorPlugin`
- [x] Plugin builds without errors (`npm run build`)

### ENV-002: Install AWS SDK dependencies ✅
**Description:** Add AWS SDK v3 packages for Bedrock provider support. These are the only external runtime dependencies beyond Obsidian types.
**Files:**
- `package.json` — add dependencies
- `package-lock.json` — updated via npm install
- `esbuild.config.mjs` — verify AWS SDK packages are bundled correctly
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock`, `@aws-sdk/credential-providers` installed
- [x] esbuild bundles AWS SDK without errors
- [x] Built `main.js` size is reasonable (check tree-shaking effectiveness)
- [ ] Plugin still loads in Obsidian after adding dependencies

### ENV-003: Secrets manager utility ✅
**Description:** Create a wrapper around Obsidian's `SecretStorage` API (`app.secretStorage`) for credential management. Implements get/set/clear operations with consistent key naming.
**Files:**
- `src/utils/secrets.ts` — SecretStorage wrapper
- `src/obsidian-augments.d.ts` — type augmentations for SecretStorage API (not yet in published type definitions)
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `getSecret(id)` retrieves a secret by name
- [x] `setSecret(id, value)` stores a secret
- [x] `clearSecret(id)` uses `setSecret(id, "")` workaround (no delete API)
- [x] Key naming convention established (e.g., `notor-openai-api-key`, `notor-anthropic-api-key`)
- [x] Wrapper handles missing secrets gracefully (returns null/undefined, no throw)

### ENV-004: Token counting utility ✅
**Description:** Implement token estimation for context window tracking and cost calculation. Use a lightweight approach suitable for bundling (character-based estimation or bundled tiktoken-lite).
**Files:**
- `src/utils/tokens.ts` — token counting functions
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `estimateTokenCount(text): number` provides a reasonable token estimate
- [x] Works without external API calls (client-side only)
- [x] Accuracy is sufficient for context window tracking (within ~10% of actual)
- [x] Minimal bundle size impact

---

## Phase 1: LLM Provider Layer

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/contracts/llm-provider.md` — LLMProvider interface, StreamChunk types, ChatMessage, ProviderError, provider-specific mapping, error handling contract, buffering adapter
- `specs/01-mvp/plan.md` — provider architecture decisions, integration points, AWS SDK rationale
- `specs/01-mvp/data-model.md` — LLMProviderConfig entity, ModelInfo entity, default provider configurations
- `design/architecture.md` — provider abstraction, supported providers, streaming, configuration
- `design/research/llm-model-list-apis.md` — model list API endpoints, response formats, caching strategy, static metadata table pattern (Cline analysis)
- `design/research/obsidian-secrets-manager.md` — SecretStorage API for credential retrieval

### PROV-001: LLM provider interface and registry ✅
**Description:** Define the `LLMProvider` interface and create a provider registry that manages provider instances. The registry is the single point of access for the active provider throughout the plugin.
**Files:**
- `src/providers/provider.ts` — `LLMProvider` interface, `StreamChunk` type, `ProviderError` class, `SendMessageOptions`, `ChatMessage`
- `src/providers/index.ts` — `ProviderRegistry` class (create, get, switch active provider)
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `LLMProvider` interface matches contract in `contracts/llm-provider.md`
- [x] `StreamChunk` union type covers all chunk types (text_delta, tool_call_start/delta/end, message_end, error)
- [x] `ProviderError` class with error codes (AUTH_FAILED, CONNECTION_FAILED, etc.)
- [x] `ProviderRegistry` can register, retrieve, and switch between providers
- [x] Registry initializes providers lazily (not at plugin load time)
- [x] All types exported for use by provider implementations

### PROV-002: Local OpenAI-compatible provider ✅
**Description:** Implement the default LLM provider connecting to local OpenAI-compatible APIs (Ollama, LM Studio). Uses standard `fetch` API for HTTP requests.
**Files:**
- `src/providers/local-provider.ts`
**Dependencies:** PROV-001, ENV-003
**Acceptance Criteria:**
- [x] `sendMessage` streams via `POST {endpoint}/v1/chat/completions` with `stream: true`
- [x] SSE stream parsed correctly, yielding `StreamChunk` events
- [x] `listModels` fetches `GET {endpoint}/v1/models` and returns `ModelInfo[]`
- [x] `validateConnection` tests connectivity via models endpoint
- [x] `getTokenCount` delegates to token utility
- [x] Default endpoint is `http://localhost:11434/v1`
- [x] Optional API key sent as `Authorization: Bearer {key}` when configured
- [x] `ECONNREFUSED` and network errors produce clear `ProviderError` with `CONNECTION_FAILED`
- [x] Abort signal respected for user cancellation
- [x] Tool calling format follows OpenAI function calling convention

### PROV-003: Anthropic provider ✅
**Description:** Implement the Anthropic API provider with its specific message format and streaming protocol.
**Files:**
- `src/providers/anthropic-provider.ts`
**Dependencies:** PROV-001, ENV-003
**Acceptance Criteria:**
- [x] `sendMessage` streams via `POST https://api.anthropic.com/v1/messages` with `stream: true`
- [x] Anthropic SSE event types parsed correctly (`message_start`, `content_block_delta`, `message_delta`, `message_stop`)
- [x] Tool calling format translated between Notor's `ToolDefinition` and Anthropic's format
- [x] `listModels` fetches via `GET /v1/models` with cursor-based pagination (`after_id`/`has_more`)
- [x] API key sent via `x-api-key` header; `anthropic-version` header included
- [x] `validateConnection` tests credentials
- [x] Auth failures produce `ProviderError` with `AUTH_FAILED`
- [x] Rate limiting detected and reported with `RATE_LIMITED`

### PROV-004: OpenAI provider ✅
**Description:** Implement the OpenAI API provider. Shares the same wire format as the local provider but with OpenAI-specific endpoint and auth.
**Files:**
- `src/providers/openai-provider.ts`
**Dependencies:** PROV-001, ENV-003
**Acceptance Criteria:**
- [x] `sendMessage` streams via `POST https://api.openai.com/v1/chat/completions`
- [x] `listModels` fetches from `/v1/models` with client-side filtering (exclude embeddings, image, audio models)
- [x] API key sent via `Authorization: Bearer {key}`
- [x] Custom endpoint URL supported (for Azure OpenAI or compatible services)
- [x] All `ProviderError` codes handled consistently

### PROV-005: AWS Bedrock provider ✅
**Description:** Implement the AWS Bedrock provider using AWS SDK v3. Supports both named profile auth and direct access keys.
**Files:**
- `src/providers/bedrock-provider.ts`
**Dependencies:** PROV-001, ENV-002, ENV-003
**Acceptance Criteria:**
- [x] `sendMessage` uses `ConverseStreamCommand` via `@aws-sdk/client-bedrock-runtime`
- [x] Bedrock Converse API request format handled (translate from Notor message format)
- [x] Streaming response parsed and yielded as `StreamChunk` events
- [x] ~~`listModels` uses `ListFoundationModels` with `byOutputModality: "TEXT"` filter~~ ⚠️ **Implemented with deprecated approach** — `ListFoundationModels` was used but must be replaced by `ListInferenceProfilesCommand` with `typeEquals: "SYSTEM_DEFINED"` (see PROV-008)
- [x] Two auth methods: `fromIni({ profile })` for named profile, direct keys from secrets manager
- [x] Region configurable; credentials lazy-loaded
- [x] Provider lazy-loaded (not imported until selected) to minimize startup bundle impact
- [x] SDK bundle size validated (tree-shaking effective)

### PROV-006: Static model metadata table ✅
**Description:** Create a static metadata table mapping known model IDs to context window sizes and pricing. Follows Cline's proven pattern since no provider returns this data dynamically.
**Files:**
- `src/providers/model-metadata.ts` — `Record<string, ModelInfo>` keyed by model ID
**Dependencies:** PROV-001
**Acceptance Criteria:**
- [x] Metadata entries for major Anthropic models (Claude 3.5 Sonnet, Claude 3 Opus, Claude 3 Haiku, Claude 4 Sonnet, etc.)
- [x] Metadata entries for major OpenAI models (GPT-4o, GPT-4o-mini, o3, o4-mini, etc.)
- [x] ~~Metadata entries for common Bedrock models~~ ⚠️ **Needs update** — existing Bedrock entries use bare foundation model IDs (e.g., `anthropic.claude-sonnet-4-20250514-v1:0`); must be re-keyed to inference profile IDs (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`, `global.anthropic.claude-sonnet-4-20250514-v1:0`) covering `us.`, `eu.`, `apac.`, and `global.` prefixes for popular models (see PROV-008)
- [x] Each entry includes `context_window`, `input_price_per_1k`, `output_price_per_1k`
- [x] Graceful fallback for unknown model IDs (default context window of 128,000)
- [x] Model list lookup function: `getModelMetadata(modelId): ModelInfo | null`

### PROV-007 [P]: Model list caching ✅
**Description:** Implement in-memory caching for provider model lists with 5-minute TTL and stale-while-revalidate strategy.
**Files:**
- `src/providers/index.ts` — extend registry with cache logic
**Dependencies:** PROV-001
**Acceptance Criteria:**
- [x] Model lists cached in memory per provider
- [x] Cache expires after 5 minutes
- [x] Stale cache served while background refresh in progress
- [x] Manual refresh via explicit `refreshModels()` call
- [x] Cache cleared on provider switch or credential change

### PROV-008: Bedrock inference profiles migration ✅
**Description:** Replace the existing `ListFoundationModels` implementation in the Bedrock provider with `ListInferenceProfilesCommand`, and update the static metadata table to use inference profile IDs. This is a targeted bug-fix/upgrade — the `sendMessage` path and all auth logic remain unchanged; only model listing and metadata lookup are affected.

**Context:** The original PROV-005 implementation used `ListFoundationModelsCommand` with `byOutputModality: "TEXT"`. Per updated research (R-4, 2026-07-03), newer models (Claude Sonnet 4.6, Opus 4.6, Llama 4, Nova Premier, DeepSeek R1) appear only in inference profiles, not in `ListFoundationModels`. Additionally, inference profile IDs (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) are the correct `modelId` values for Converse API calls — passing bare foundation model IDs still works but bypasses cross-region routing.

**Files:**
- `src/providers/bedrock-provider.ts` — replace `ListFoundationModelsCommand` with `ListInferenceProfilesCommand`
- `src/providers/model-metadata.ts` — replace bare Bedrock foundation model ID entries with inference profile ID entries

**Dependencies:** PROV-005, PROV-006
**Reference files:** `design/research/llm-model-list-apis.md` — Section 3a (ListInferenceProfiles), Section 3b (deprecated ListFoundationModels), Section 6a (field mapping), Section 6b (metadata table with inference profile IDs)

**Acceptance Criteria:**
- [x] `listModels` uses `ListInferenceProfilesCommand({ typeEquals: "SYSTEM_DEFINED" })` from `@aws-sdk/client-bedrock`
- [x] Returns `inferenceProfileId` as the model `id` field (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) — this value is passed directly to the Converse API as `modelId`
- [x] Returns `inferenceProfileName` as the model `display_name` field (e.g., `"US Claude Sonnet 4"`)
- [x] Client-side filtering excludes non-chat profiles: filter out `stability.*`, `twelvelabs.*`, `cohere.embed*` provider prefixes; include only profiles with `status === "ACTIVE"`
- [x] Handles `AccessDeniedException` (403) with a clear error message noting `bedrock:ListInferenceProfiles` IAM permission is required
- [x] Handles pagination via `nextToken` (in practice a single page suffices for SYSTEM_DEFINED profiles)
- [x] Static metadata table in `model-metadata.ts` re-keyed to inference profile IDs — entries for `us.*`, `eu.*`, `apac.*`, and `global.*` prefixes for all popular models referenced in the research doc's metadata table (Section 6b)
- [x] Old bare foundation model ID entries for Bedrock (e.g., `anthropic.claude-sonnet-4-20250514-v1:0`) removed from metadata table
- [x] `getModelMetadata` lookup continues to work correctly for inference profile IDs
- [x] IAM note added to Bedrock settings section in `src/settings.ts` or README: policy must include `bedrock:ListInferenceProfiles` (not just `bedrock:ListFoundationModels`)
- [x] Existing `sendMessage` / `ConverseStreamCommand` path unchanged — inference profile IDs already work as `modelId` values in Converse API

---

## Phase 2: Chat System & UI

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/spec.md` — FR-4 (chat panel), FR-5 (streaming), FR-6 (system prompt), FR-14 (Plan/Act), FR-15 (auto-approve), FR-16 (tool transparency), FR-19 (chat history)
- `specs/01-mvp/data-model.md` — Conversation entity, Message entity, ToolCall/ToolResult, JSONL schema, Stale Content Check, Plugin Settings
- `specs/01-mvp/contracts/tool-schemas.md` — tool dispatch contract, dispatch flow, diff preview flow
- `design/ux.md` — chat panel layout, message display, streaming, Plan/Act mode, auto-approve, editor behavior
- `design/architecture.md` — conversation structure, context window management, system prompt assembly, tool dispatch
- `design/research/system-prompt-design.md` — prompt structure, transferable patterns, token budget, safety principles

### CHAT-001: Conversation manager ✅
**Description:** Implement the core conversation management logic — creating, loading, switching, and persisting conversations. Manages the in-memory conversation state and message history.
**Files:**
- `src/chat/conversation.ts` — `ConversationManager` class
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] Create new conversation with UUID, timestamps, provider/model info
- [x] Add messages to conversation (user, assistant, tool_call, tool_result)
- [x] Track cumulative input/output tokens and estimated cost
- [x] Track conversation mode (plan/act)
- [x] Auto-generate conversation title from first user message
- [x] Provide ordered message list for sending to LLM
- [x] In-memory state management for active conversation

### CHAT-002: JSONL history persistence ✅
**Description:** Implement JSONL-based conversation persistence — writing messages as they occur (append-only) and loading full conversations from disk.
**Files:**
- `src/chat/history.ts` — `HistoryManager` class
**Dependencies:** CHAT-001
**Acceptance Criteria:**
- [x] Each conversation stored as `{timestamp}_{id}.jsonl` in history directory
- [x] Messages appended line-by-line as they occur (not batched)
- [x] Load conversation by reading and parsing all lines from JSONL file
- [x] List conversations with metadata (id, title, updated_at, first message preview)
- [x] Conversations ordered by most recent activity
- [x] Configurable storage path (default: `.obsidian/plugins/notor/history/`)
- [x] Retention policy enforced: prune by max size (500 MB default) and max age (90 days default)
- [x] JSONL files not recognized as Obsidian notes (correct file extension handling)

### CHAT-003: Context window management ✅
**Description:** Implement context window tracking and truncation. Monitor cumulative tokens against the active model's context limit; truncate oldest messages when approaching the limit while preserving the system prompt and recent messages.
**Files:**
- `src/chat/context.ts` — `ContextManager` class
**Dependencies:** CHAT-001, ENV-004, PROV-006
**Acceptance Criteria:**
- [x] Track cumulative token count across all messages in a conversation
- [x] Look up context window limit from static model metadata
- [x] When approaching limit (configurable threshold, e.g., 90%), mark oldest non-system messages as `truncated: true`
- [x] Truncated messages excluded from the array sent to the LLM but retained in JSONL log and UI
- [x] System prompt always preserved (never truncated)
- [x] Visible warning displayed when truncation occurs
- [x] Messages are assembled in correct order for LLM: system → (non-truncated) user/assistant/tool messages

### CHAT-004: System prompt assembly ✅
**Description:** Build the system prompt from the built-in default, user customization file, and (Phase 2) vault-level rules. Tool definitions are generated from the tool registry.
**Files:**
- `src/chat/system-prompt.ts` — `SystemPromptBuilder` class
**Dependencies:** CHAT-001
**Acceptance Criteria:**
- [x] Built-in default system prompt (~3,000 tokens, 9 sections as per R-2 findings) embedded in plugin code
- [x] If `{notor_dir}/prompts/core-system-prompt.md` exists, use its body (strip frontmatter) instead
- [x] "Customize system prompt" action writes default to the file for editing
- [x] Tool definitions section auto-generated from the tool registry (single source of truth)
- [x] Hard ceiling of 8,000 tokens for total system prompt
- [x] System prompt includes mode-aware instructions (Plan vs Act)

### CHAT-005: Tool dispatcher ✅
**Description:** Central dispatcher that sits between LLM response parsing and tool execution. Enforces Plan/Act mode, auto-approve settings, and routes to the correct tool implementation.
**Files:**
- `src/chat/dispatcher.ts` — `ToolDispatcher` class
**Dependencies:** CHAT-001, PROV-001
**Acceptance Criteria:**
- [x] Parse tool call requests from LLM `StreamChunk` events (tool_call_start/delta/end)
- [x] Look up tool in registry by name
- [x] Return error to LLM if tool not found
- [x] Block write tools in Plan mode with descriptive error message
- [x] Check auto-approve settings; if not auto-approved, delegate to approval UI and await response
- [x] Handle rejection: return rejection message to LLM
- [x] Execute tool and return result to LLM for next turn
- [x] Emit events for UI rendering (tool call started, result received, status changes)

### CHAT-006: Stale content tracker ✅
**Description:** Track the last-read content for each note path within a conversation to detect concurrent edits before write operations.
**Files:**
- `src/chat/stale-tracker.ts` — `StaleContentTracker` class
**Dependencies:** CHAT-001
**Acceptance Criteria:**
- [x] After each `read_note` call, store `{ note_path, last_read_content, last_read_timestamp }` in memory
- [x] Before any write tool executes, compare note's current content against last-read content
- [x] If content differs, fail with stale-content error and instruct AI to re-read
- [x] Tracker is scoped per conversation (cleared on new conversation)
- [x] Handles notes that were never read (no stale check for new notes)

### CHAT-007: Chat panel view (basic) ✅
**Description:** Implement the Obsidian `ItemView` for the chat panel — the primary UI surface. This task covers the panel shell, message display, input area, send/stop buttons, and conversation switching.
**Files:**
- `src/ui/chat-view.ts` — `NotorChatView` extends `ItemView`
- `styles.css` — chat panel styles
**Dependencies:** CHAT-001, CHAT-002
**Acceptance Criteria:**
- [x] Registered as an Obsidian leaf view, positionable on any side
- [x] Text input area at the bottom with send button
- [x] Enter sends message; Shift+Enter inserts newline
- [x] Send button disabled while AI is responding; Stop button shown instead
- [x] Stop button aborts the current LLM request via AbortController
- [x] User and assistant messages visually distinct
- [x] Assistant messages render as Markdown
- [x] Streaming responses render token-by-token as chunks arrive
- [x] Loading/typing indicator while response in progress
- [x] "New conversation" button creates a fresh conversation
- [x] Conversation list/selector shows past conversations ordered by recent activity
- [x] Settings gear button in panel header

### CHAT-008: Chat settings quick-access ✅
**Description:** Implement the quick-access settings accessible from the chat panel header gear icon — provider selection, model selection, and mode toggle.
**Files:**
- `src/ui/chat-view.ts` — extend with settings popover/dropdown
**Dependencies:** CHAT-007, PROV-001
**Acceptance Criteria:**
- [x] Provider dropdown populated from configured providers
- [x] Model dropdown populated from cached model list (with refresh button)
- [x] Falls back to free-text model ID input when model list unavailable
- [x] Switching provider/model takes effect immediately (no restart needed)
- [x] Selected provider and model persisted across plugin reloads

### CHAT-009: Plan/Act mode toggle ✅
**Description:** Implement the Plan/Act mode toggle in the chat input area with visual state indication.
**Files:**
- `src/ui/chat-view.ts` — mode toggle component
- `styles.css` — mode toggle styles
**Dependencies:** CHAT-007
**Acceptance Criteria:**
- [x] Toggle located next to the send button
- [x] Current mode clearly labeled and visually distinct (Plan = blue/read-only feel, Act = orange/active feel)
- [x] Default mode is Plan (safety-first per NFR-5)
- [x] Mode persists within session
- [x] Mode change updates the conversation state and dispatcher behavior

### CHAT-010: LLM message send/receive loop ✅
**Description:** Wire together the conversation manager, context manager, system prompt builder, provider, and dispatcher into the complete send/receive loop. This is the core orchestration that makes the chat functional.
**Files:**
- `src/chat/orchestrator.ts` — `ChatOrchestrator` class
**Dependencies:** CHAT-001, CHAT-003, CHAT-004, CHAT-005, PROV-001
**Acceptance Criteria:**
- [x] On user message: assemble system prompt, append user message, build context window, send to active provider
- [x] Stream response chunks to UI in real time
- [x] Parse tool calls from stream; route through dispatcher
- [x] After tool execution, send tool result back to LLM for next turn
- [x] Loop continues until LLM produces a final text response (no more tool calls)
- [x] Track input/output tokens from `message_end` chunks
- [x] Update conversation cost estimate based on model pricing
- [x] Handle errors gracefully: display in chat, don't crash
- [x] Support cancellation via abort signal (Stop button)

---

## Phase 3: Settings UI

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/spec.md` — FR-1 (provider integration), FR-2 (credential management), FR-3 (model selection), FR-15 (auto-approve)
- `specs/01-mvp/data-model.md` — LLMProviderConfig entity, Plugin Settings table, auto-approve defaults
- `design/ux.md` — settings layout, auto-approve configuration
- `design/architecture.md` — provider configuration, credential storage
- `design/research/obsidian-secrets-manager.md` — SecretComponent UI via `Setting.addComponent()`, key naming

### SET-001: Provider configuration settings ✅
**Description:** Build the full Settings → Notor tab with provider configuration — endpoint, credentials, region, auth method for each provider type.
**Files:**
- `src/settings.ts` — `NotorSettingTab` implementation
- `src/providers/registry-factory.ts` — provider registry factory for connection testing
- `src/obsidian-augments.d.ts` — added `SecretComponent` and `Setting.addComponent` type augmentations
**Dependencies:** ENV-001, ENV-003, PROV-001
**Acceptance Criteria:**
- [x] Section per provider type (Local, Anthropic, OpenAI, AWS Bedrock)
- [x] Local: endpoint URL text field (default `http://localhost:11434/v1`), optional API key via `SecretComponent`
- [x] Anthropic: API key via `SecretComponent`
- [x] OpenAI: API key via `SecretComponent`, optional custom endpoint
- [x] Bedrock: region dropdown, auth method toggle (profile name text field OR access key ID + secret access key via `SecretComponent`), profile defaults to `default`
- [x] Active provider selection
- [x] "Test connection" button per provider that calls `validateConnection()` (Bedrock shows informational note instead — AWS SDK is Node.js-only and cannot be bundled in the settings test helper)
- [x] Success/error feedback displayed inline

### SET-002: General settings ✅
**Description:** Implement remaining settings: notor directory, auto-approve toggles, open-notes-on-access toggle, history/checkpoint paths and retention.
**Files:**
- `src/settings.ts` — extend `NotorSettingTab`
- `styles.css` — connection status styles
**Dependencies:** SET-001
**Acceptance Criteria:**
- [x] `notor_dir` path setting (default `notor/`)
- [x] Per-tool auto-approve toggles with sensible defaults (read=on, write=off)
- [x] Open notes on access toggle (default on)
- [x] History storage path, max size, max age settings
- [x] Checkpoint storage path, max per conversation, max age settings
- [x] Model pricing configuration (per-model input/output per 1K tokens)
- [x] All settings save immediately via `saveSettings()`

---

## Phase 4: Tool Implementations

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/contracts/tool-schemas.md` — JSON Schema definitions for all tools, result formats, error cases, pre-execution checks
- `specs/01-mvp/spec.md` — FR-7 through FR-13 (tool FRs), FR-16 (tool transparency), NFR-3 (reliability/data safety)
- `specs/01-mvp/data-model.md` — ToolCall/ToolResult entities, Stale Content Check
- `design/tools.md` — tool design principles, built-in tool specs, tool classification table
- `design/ux.md` — tool call display, diff preview, editor behavior, approval UI
- `design/research/obsidian-vault-api-frontmatter.md` — vault.read, vault.create, vault.modify, vault.process, getFrontMatterInfo, frontmatter preservation strategy

### TOOL-001: Tool interface and registry ✅
**Description:** Define the tool interface and create the tool registry that manages all built-in tools. The registry provides tool lookup, schema generation for LLM context, and mode classification.
**Files:**
- `src/tools/tool.ts` — `Tool` interface
- `src/tools/index.ts` — `ToolRegistry` class
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `Tool` interface matches contract: `{ name, description, input_schema, mode, execute(params) }`
- [x] Registry supports register, lookup by name, list all tools
- [x] `getToolDefinitions()` returns `ToolDefinition[]` for LLM system prompt / function calling
- [x] `isWriteTool(name)` returns boolean for Plan/Act enforcement
- [x] Registry populated at plugin load time

### TOOL-002: `read_note` tool ✅
**Description:** Implement the `read_note` tool — reads note contents via Obsidian vault API with optional frontmatter inclusion.
**Files:**
- `src/tools/read-note.ts`
**Dependencies:** TOOL-001
**Acceptance Criteria:**
- [x] Accepts `path` and optional `include_frontmatter` (default false)
- [x] Uses `app.vault.read(file)` to get content
- [x] Strips frontmatter using `getFrontMatterInfo(content).contentStart` when `include_frontmatter` is false
- [x] Returns note content as string
- [x] Error if file not found: "Note not found: {path}"
- [x] Error if not a markdown file: "Path is not a Markdown note: {path}"
- [x] Mode: read (Plan + Act)
- [x] Updates stale content tracker with read content

### TOOL-003: `write_note` tool ✅
**Description:** Implement the `write_note` tool — creates new notes or overwrites existing ones with frontmatter merge protection.
**Files:**
- `src/tools/write-note.ts`
**Dependencies:** TOOL-001, CHAT-006
**Acceptance Criteria:**
- [x] Accepts `path` and `content`
- [x] Uses `vault.create` for new files, `vault.modify` for existing
- [x] Creates intermediate directories if needed
- [x] Read-before-write frontmatter merge: if existing note has frontmatter but new content doesn't, prepend existing frontmatter
- [x] Stale content check before writing (via `StaleContentTracker`)
- [x] Returns success message with path and character count
- [x] Mode: write (Act only)
- [x] Descriptive Plan mode error message (handled by dispatcher)

### TOOL-004: `replace_in_note` tool ✅
**Description:** Implement the `replace_in_note` tool — atomic SEARCH/REPLACE editing via `vault.process`.
**Files:**
- `src/tools/replace-in-note.ts`
**Dependencies:** TOOL-001, CHAT-006
**Acceptance Criteria:**
- [x] Accepts `path` and `changes` array of `{ search, replace }` blocks
- [x] Uses `vault.process(file, fn)` for atomic read-modify-write
- [x] Validates ALL search blocks match before applying any (pre-scan in callback)
- [x] If any search fails to match, callback throws → no changes written
- [x] Each block replaces only first occurrence
- [x] Empty replace string deletes matched text
- [x] Multiple blocks applied in sequence (order matters)
- [x] Stale content check before applying
- [x] Returns success message with replacement count
- [x] Mode: write (Act only)

### TOOL-005: `search_vault` tool ✅
**Description:** Implement the `search_vault` tool — regex/text search across vault notes with context lines.
**Files:**
- `src/tools/search-vault.ts`
**Dependencies:** TOOL-001
**Acceptance Criteria:**
- [x] Accepts `query`, optional `path`, `context_lines` (default 3), `file_pattern` (default `*.md`)
- [x] Enumerates vault files using Obsidian API, filtered by path prefix and glob pattern
- [x] Searches file contents line-by-line with regex or literal text matching
- [x] Returns matches grouped by file with line numbers and surrounding context
- [x] Invalid regex produces clear error
- [x] Zero matches returns success with empty results (not an error)
- [x] Mode: read (Plan + Act)
- [x] Performance: reasonable for vaults up to 10,000 notes

### TOOL-006: `list_vault` tool ✅
**Description:** Implement the `list_vault` tool — directory listing with pagination, sorting, and metadata.
**Files:**
- `src/tools/list-vault.ts`
**Dependencies:** TOOL-001
**Acceptance Criteria:**
- [x] Accepts optional `path`, `recursive`, `limit` (default 50), `offset` (default 0), `sort_by` (default `last_modified`)
- [x] Lists files and folders using Obsidian vault API
- [x] Returns structured items with name, path, type (note/folder/image/attachment), size, modified date
- [x] Includes `total_count` for pagination
- [x] Supports `last_modified` (newest first) and `alphabetical` sort
- [x] Mode: read (Plan + Act)

### TOOL-007: Tool transparency UI ✅
**Description:** Render tool calls inline in the chat thread with name, parameters, result, status, and expand/collapse behavior.
**Files:**
- `src/ui/tool-call-ui.ts` — tool call rendering component
- `styles.css` — tool call styles (already present from CHAT-007)
**Dependencies:** CHAT-007, TOOL-001
**Acceptance Criteria:**
- [x] Each tool call renders inline in conversation flow
- [x] Shows: tool name, status indicator (pending/success/error)
- [x] Parameters shown (collapsed by default, expandable)
- [x] Result summary shown; full result expandable
- [x] Error states clearly surfaced with error message
- [x] Pending state shown while tool is executing or awaiting approval

### TOOL-008: Approval UI ✅
**Description:** Implement the inline approval prompt for tool calls that are not auto-approved. Shows approve/reject buttons in the chat thread.
**Files:**
- `src/ui/approval-ui.ts` — approval prompt component
- `styles.css` — approval styles (already present from CHAT-007)
**Dependencies:** CHAT-007, CHAT-005
**Acceptance Criteria:**
- [x] Inline approve/reject buttons rendered in chat when manual approval required
- [x] Approve triggers tool execution
- [x] Reject returns rejection message to LLM
- [x] Send button disabled while approval is pending (handled by chat-view responding state)
- [x] Approval state reflected in tool call status (pending → approved/rejected)

### TOOL-009: Open notes in editor ✅
**Description:** When tools read or modify a note, open the note in the Obsidian editor. Navigate to relevant section if the note is already open.
**Files:**
- `src/tools/note-opener.ts` — utility for opening/navigating to notes
**Dependencies:** TOOL-001
**Acceptance Criteria:**
- [x] After `read_note`, `write_note`, `replace_in_note`: open the note in an editor leaf
- [x] If note is already open, navigate to it (activate the leaf)
- [x] Configurable via `open_notes_on_access` setting (default on)
- [x] Does not open duplicate tabs for the same note
- [x] Handles non-existent files gracefully (skip for new files before creation)

---

## Phase 5: Diff Preview & Change Approval

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/spec.md` — FR-12 (diff preview and change approval)
- `specs/01-mvp/contracts/tool-schemas.md` — diff preview flow (section at end of document)
- `design/ux.md` — diff preview and change approval UI patterns, per-change accept/reject, auto-approve collapsed diff behavior

### DIFF-001: Diff generation ✅
**Description:** Generate before/after diffs for write tool operations. Compute the diff data structure used by the diff preview UI.
**Files:**
- `src/ui/diff-engine.ts` — diff computation utility
**Dependencies:** TOOL-003, TOOL-004
**Acceptance Criteria:**
- [x] Generate line-by-line diff between before/after content
- [x] Support diff for `write_note` (old content vs new content; empty "before" for new files)
- [x] Support diff for `replace_in_note` (per-change diffs for each SEARCH/REPLACE block)
- [x] Identify additions, deletions, and unchanged lines
- [x] Output structured diff data for rendering

### DIFF-002: Diff preview UI ✅
**Description:** Render diff previews in the chat panel for write tool operations. Support per-change accept/reject and bulk actions.
**Files:**
- `src/ui/diff-view.ts` — diff preview component
- `styles.css` — diff styles
**Dependencies:** DIFF-001, CHAT-007
**Acceptance Criteria:**
- [x] Before/after content displayed with highlighted additions (green) and deletions (red)
- [x] For `replace_in_note` with multiple blocks: per-change accept/reject controls
- [x] "Accept all" / "Reject all" buttons for bulk approval
- [x] When auto-approve is on: changes applied immediately, collapsed diff shown in chat thread
- [x] When manual approval: diff shown expanded, tool execution blocked until user decides
- [x] Partial accept: only accepted changes applied; result reflects what was actually applied

---

## Phase 6: Trust, Safety & Observability (Phase 2 FRs)

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/spec.md` — FR-17 (checkpoints), FR-18 (token/cost tracking), FR-19 (chat history), FR-20 (read_frontmatter), FR-21 (update_frontmatter), FR-22 (manage_tags), FR-23 (vault-level rules)
- `specs/01-mvp/data-model.md` — Checkpoint entity (fields, persistence, retention), VaultRule entity (triggers, evaluation), Message token/cost fields
- `specs/01-mvp/contracts/tool-schemas.md` — Phase 2 tool schemas (read_frontmatter, update_frontmatter, manage_tags)
- `design/architecture.md` — checkpoints behavior/storage/operations, vault-level rule trigger evaluation, system prompt assembly with rules
- `design/ux.md` — checkpoints UI, token/cost tracking display, vault-level instruction files, system prompt with rules
- `design/tools.md` — note metadata tools (read_frontmatter, update_frontmatter, manage_tags)
- `design/research/obsidian-vault-api-frontmatter.md` — fileManager.processFrontMatter API, metadataCache.getFileCache for frontmatter reads

### CP-001: Checkpoint creation ✅
**Description:** Implement automatic checkpoint creation before write operations. Snapshot the affected note's current content.
**Files:**
- `src/checkpoints/checkpoint.ts` — `CheckpointManager` class
**Dependencies:** CHAT-001, TOOL-003, TOOL-004
**Acceptance Criteria:**
- [x] Before `write_note`, `replace_in_note`, `update_frontmatter`, `manage_tags`: snapshot note content
- [x] Checkpoint includes: id (UUID), conversation_id, note_path, content, timestamp, description, tool_name, message_id
- [x] Description auto-generated (e.g., "Before replace_in_note on Daily/2026-03-01.md")
- [x] Checkpoints scoped to conversation
- [x] Checkpoint creation does not noticeably delay the write operation

### CP-002: Checkpoint storage ✅
**Description:** Persist checkpoints as JSON files organized by conversation. Implement retention policy enforcement.
**Files:**
- `src/checkpoints/storage.ts` — `CheckpointStorage` class
**Dependencies:** CP-001
**Acceptance Criteria:**
- [x] Checkpoints stored as `{conversation_id}/{checkpoint_id}.json`
- [x] Default path: `.obsidian/plugins/notor/checkpoints/`; configurable
- [x] Load checkpoints for a conversation (list with metadata)
- [x] Retention policy: max 100 per conversation, 30-day max age (both configurable)
- [x] Oldest checkpoints pruned when limits exceeded
- [x] Pruning runs lazily (on checkpoint creation, not on a timer)

### CP-003: Checkpoint UI ✅
**Description:** Add checkpoint timeline to the chat panel (via the settings gear popover) with preview, restore, and compare operations.
**Files:**
- `src/ui/chat-view.ts` — checkpoint section in settings popover + `CheckpointModal` class
- `styles.css` — checkpoint timeline and modal styles
**Dependencies:** CP-002, CHAT-007
**Acceptance Criteria:**
- [x] Timeline accessible from chat panel per conversation (via gear icon → Checkpoints section)
- [x] Each checkpoint shows timestamp, description, and affected note path
- [x] Preview: view checkpoint content in a modal without restoring
- [x] Restore: replace note's current content with checkpoint content (creates a new checkpoint of current state first)
- [x] Compare: show diff between checkpoint content and note's current content
- [x] Timeline ordered chronologically (newest first)

### TOKEN-001: Token and cost tracking ✅
**Description:** Display token consumption and estimated cost per message and per conversation in the chat panel.
**Files:**
- `src/ui/chat-view.ts` — token/cost annotations on assistant messages and conversation footer
- `styles.css` — token display styles
**Dependencies:** CHAT-007, CHAT-010, PROV-006
**Acceptance Criteria:**
- [x] Each assistant message displays input + output token count
- [x] Conversation footer shows cumulative token count and estimated cost
- [x] Cost estimated from model pricing in settings (per 1K input/output tokens)
- [x] If no pricing configured, token counts shown but cost omitted
- [x] Token info is subtle/non-intrusive (small font, muted color)

### META-001: `read_frontmatter` tool ✅
**Description:** Implement the `read_frontmatter` tool — reads parsed YAML frontmatter as structured key-value data using Obsidian's metadata cache.
**Files:**
- `src/tools/read-frontmatter.ts`
**Dependencies:** TOOL-001
**Acceptance Criteria:**
- [x] Accepts `path` parameter
- [x] Uses `metadataCache.getFileCache(file)?.frontmatter` for parsed data (no disk I/O)
- [x] Strips internal `position` property before returning
- [x] Returns empty object `{}` if note has no frontmatter (not an error)
- [x] Error if file not found
- [x] Mode: read (Plan + Act)

### META-002: `update_frontmatter` tool ✅
**Description:** Implement the `update_frontmatter` tool — add, modify, or remove specific frontmatter properties using `fileManager.processFrontMatter`.
**Files:**
- `src/tools/update-frontmatter.ts`
**Dependencies:** TOOL-001, CP-001
**Acceptance Criteria:**
- [x] Accepts `path`, optional `set` (key-value pairs), optional `remove` (array of keys)
- [x] Uses `fileManager.processFrontMatter(file, fn)` for atomic frontmatter-only edits
- [x] Body content preserved — only frontmatter modified
- [x] Creates frontmatter section if note has none and `set` is provided
- [x] Checkpoint created before modifying
- [x] Mode: write (Act only)

### META-003: `manage_tags` tool ✅
**Description:** Implement the `manage_tags` tool — add or remove tags via the frontmatter `tags` property.
**Files:**
- `src/tools/manage-tags.ts`
**Dependencies:** TOOL-001, CP-001
**Acceptance Criteria:**
- [x] Accepts `path`, optional `add` (array), optional `remove` (array)
- [x] Uses `fileManager.processFrontMatter(file, fn)` to manipulate `frontmatter.tags`
- [x] Does not duplicate tags that already exist when adding
- [x] Gracefully handles removal of tags that don't exist (no error)
- [x] Checkpoint created before modifying
- [x] Mode: write (Act only)

### RULES-001: Vault-level instruction files ✅
**Description:** Implement vault-level rule file scanning, trigger evaluation, and dynamic injection into the system prompt.
**Files:**
- `src/rules/vault-rules.ts` — `VaultRuleManager` class
**Dependencies:** CHAT-004
**Acceptance Criteria:**
- [x] Scan `{notor_dir}/rules/` for Markdown files at plugin load and on file changes
- [x] Parse frontmatter trigger properties: `notor-always-include`, `notor-directory-include`, `notor-tag-include`
- [x] Multiple triggers on same file use OR logic
- [x] Track notes accessed by tools in current conversation
- [x] Re-evaluate rules after each tool call that accesses a note
- [x] Inject matching rule body content (stripped frontmatter) into system prompt
- [x] Rule files are regular vault notes (visible, editable)

---

## Phase 7: Integration & Polish

**Reference files (read ALL before starting this phase):**
- `specs/01-mvp/spec.md` — all FRs and NFRs (final validation), success criteria, user scenarios and edge cases
- `specs/01-mvp/plan.md` — full implementation plan, risk assessment, performance requirements
- `specs/01-mvp/quickstart.md` — planned source structure, manual testing checklist, code conventions
- `design/architecture.md` — full architecture reference for lifecycle wiring
- `design/ux.md` — notifications and feedback, complete UI reference
- `design/research/system-prompt-design.md` — default system prompt structure, 9 sections, token budget, safety principles

### INT-001: Plugin lifecycle wiring ✅
**Description:** Wire all components together in `main.ts` — register the chat view, commands, settings tab, and initialize all managers. Ensure clean unload.
**Files:**
- `src/main.ts` — full lifecycle wiring
**Dependencies:** All previous phases
**Acceptance Criteria:**
- [x] `onload`: initialize settings, provider registry, tool registry, conversation manager, history manager, checkpoint manager, vault rules manager
- [x] Register chat panel view type
- [x] `addCommand` for "Open chat panel"
- [x] `addCommand` for "New conversation"
- [x] Register settings tab
- [x] Lazy initialization: heavy components deferred until first use
- [x] `onunload`: all listeners, intervals, DOM elements cleaned up via `register*` helpers
- [x] No resource leaks on disable/re-enable

### INT-002: Manifest and version update ✅
**Description:** Update `manifest.json` to reflect Notor's identity and minimum Obsidian version requirement.
**Files:**
- `manifest.json` — update fields
- `versions.json` — update version mapping
**Dependencies:** ENV-001
**Acceptance Criteria:**
- [x] `id` set to `notor`
- [x] `name` set to `Notor`
- [x] `minAppVersion` set to `1.11.4` (required for SecretStorage)
- [x] `description` accurately describes the plugin
- [x] `isDesktopOnly` set based on API usage analysis
- [x] `versions.json` updated with version → minAppVersion mapping

### INT-003: Default system prompt authoring ✅
**Description:** Write the built-in default system prompt for Notor, following the structure and recommendations from R-2 research. This is the prompt that ships with the plugin.
**Files:**
- `src/chat/default-system-prompt.ts` — default prompt content as a string constant
**Dependencies:** CHAT-004
**Acceptance Criteria:**
- [x] ~3,000 tokens, structured in 9 sections per R-2 findings
- [x] Role definition: AI assistant for note writing and knowledge management in Obsidian
- [x] Tool usage instructions: when to use each tool, read-before-write principle, surgical edits preferred
- [x] Obsidian-specific context: Markdown formatting, wikilinks, frontmatter, callouts, tags
- [x] Safety rules: confirm large changes, prefer `replace_in_note` over `write_note`, report failures clearly
- [x] Mode-aware behavior: describe Plan vs Act mode constraints
- [x] Communication style: concise, helpful, non-destructive
- [x] Error handling: describe what to do on tool failures, stale content, no matches

### INT-004: Error handling and edge cases ✅
**Description:** Ensure all error paths are handled gracefully across the plugin — provider errors, tool errors, file system errors, and UI edge cases.
**Files:**
- `src/providers/local-provider.ts` — added connection timeout (10s) with descriptive timeout error
- `src/chat/orchestrator.ts` — comprehensive ProviderError handling with per-code suggestions
- Various files across `src/` — error handling improvements
**Dependencies:** All previous phases
**Acceptance Criteria:**
- [x] Provider connection failure shows clear error in chat with suggested corrective action
- [x] Invalid credentials show specific error per provider
- [x] Tool errors display in chat thread with useful context
- [x] Stale content errors instruct the AI to re-read
- [x] File not found errors include the attempted path
- [x] Network timeouts handled with retry suggestion
- [x] Plugin does not crash on any error — errors contained and reported

### INT-005: Performance validation ✅
**Description:** Validate performance requirements — startup speed, tool execution speed, streaming latency.
**Files:**
- `src/main.ts` — all heavy components are lazily initialized (only settings + settings tab + view registration + command registration + vault rule watcher on onload)
- `src/main.ts` — Bedrock provider dynamically imported via `import()` (non-blocking, deferred after onload)
**Dependencies:** All previous phases
**Acceptance Criteria:**
- [x] Plugin `onload` does not block Obsidian UI (heavy init deferred)
- [x] `read_note`, `search_vault`, `list_vault` complete within seconds for 10,000-note vaults
- [x] Streaming begins rendering within 1s of LLM output start
- [x] Checkpoint creation adds negligible delay to write operations
- [x] No unnecessary vault scans; expensive operations debounced/throttled
- [x] AWS SDK lazy-loaded (not imported until Bedrock provider selected)

---

## Dependency Graph

```
ENV-001 ──┬── ENV-002 ──── PROV-005
           ├── ENV-003 ──┬─ PROV-002
           │             ├─ PROV-003
           │             ├─ PROV-004
           │             ├─ PROV-005
           │             └─ SET-001
           ├── ENV-004 ──── CHAT-003
           ├── PROV-001 ─┬─ PROV-002
           │             ├─ PROV-003
           │             ├─ PROV-004
           │             ├─ PROV-005
           │             ├─ PROV-006 ─── CHAT-003
           │             ├─ PROV-007
           │             ├─ CHAT-005
           │             ├─ CHAT-008
           │             └─ CHAT-010
           ├── CHAT-001 ─┬─ CHAT-002 ─── CHAT-007
           │             ├─ CHAT-003
           │             ├─ CHAT-004 ─┬─ RULES-001
           │             │            └─ INT-003
           │             ├─ CHAT-005 ─── TOOL-008
           │             ├─ CHAT-006 ─┬─ TOOL-003
           │             │            └─ TOOL-004
           │             └─ CHAT-010
           └── TOOL-001 ─┬─ TOOL-002
                         ├─ TOOL-003 ─── DIFF-001
                         ├─ TOOL-004 ─── DIFF-001
                         ├─ TOOL-005
                         ├─ TOOL-006
                         ├─ TOOL-007
                         ├─ TOOL-009
                         ├─ META-001
                         ├─ META-002
                         └─ META-003

CP-001 ──── CP-002 ──── CP-003
DIFF-001 ── DIFF-002
CHAT-007 ─┬─ CHAT-008
           ├─ CHAT-009
           ├─ TOOL-007
           ├─ TOOL-008
           ├─ DIFF-002
           ├─ CP-003
           └─ TOKEN-001
```

## Parallel Execution Opportunities

The following task groups can be executed in parallel:

| Group | Tasks | Rationale |
|---|---|---|
| 1 | ENV-002, ENV-003, ENV-004 | Independent utilities, all depend only on ENV-001 |
| 2 | PROV-002, PROV-003, PROV-004, PROV-005 | Independent provider implementations, all depend on PROV-001 |
| 3 | PROV-006, PROV-007 | Independent provider metadata tasks |
| 4 | CHAT-001, TOOL-001 | Independent foundational components |
| 5 | CHAT-004, CHAT-005, CHAT-006 | Independent chat subsystems after CHAT-001 |
| 6 | TOOL-002, TOOL-005, TOOL-006 | Read-only tools with no cross-dependencies |
| 7 | TOOL-003, TOOL-004 | Write tools (both need CHAT-006 but are independent of each other) |
| 8 | TOOL-007, TOOL-008, TOOL-009 | Independent UI/utility tasks for tools |
| 9 | META-001, META-002, META-003 | Independent frontmatter tools |
| 10 | CP-001, TOKEN-001, RULES-001 | Independent Phase 2 features |
| 11 | DIFF-001, CP-002 | Independent after their prerequisites |
| 12 | INT-002, INT-003 | Independent polish tasks |

## Critical Path

The longest dependency chain (critical path) determines the minimum implementation time:

```
ENV-001 → PROV-001 → PROV-002 → CHAT-010 → INT-001
ENV-001 → CHAT-001 → CHAT-002 → CHAT-007 → DIFF-002 → INT-001
ENV-001 → TOOL-001 → TOOL-003 → DIFF-001 → DIFF-002 → INT-001
ENV-001 → CHAT-001 → CHAT-006 → TOOL-003 → CP-001 → CP-002 → CP-003
```

**Bottleneck tasks:**
- **ENV-001** (Project restructure) — gates everything
- **CHAT-007** (Chat panel view) — gates all UI-dependent tasks
- **CHAT-010** (Send/receive loop) — gates end-to-end functionality
- **DIFF-002** (Diff preview UI) — gates the complete write tool approval flow

## Implementation Order Recommendation

**Wave 1 — Foundation (do first):**
ENV-001, then ENV-002 + ENV-003 + ENV-004 in parallel

**Wave 2 — Provider layer (parallel):**
PROV-001 + TOOL-001 + CHAT-001 in parallel, then PROV-002–005 + PROV-006 + PROV-007 in parallel

**Wave 3 — Chat system:**
CHAT-002 → CHAT-003, CHAT-004, CHAT-005, CHAT-006 in parallel → CHAT-007 → CHAT-008, CHAT-009 in parallel → CHAT-010

**Wave 4 — Tools (parallel with Wave 3 chat UI):**
TOOL-002–006 in parallel → TOOL-007, TOOL-008, TOOL-009 in parallel

**Wave 5 — Settings:**
SET-001, SET-002

**Wave 6 — Diff & Checkpoints:**
DIFF-001, CP-001 in parallel → DIFF-002, CP-002 in parallel → CP-003

**Wave 7 — Phase 2 features (parallel):**
TOKEN-001, META-001–003, RULES-001 in parallel

**Wave 8 — Integration & polish:**
INT-001, INT-002, INT-003 → INT-004, INT-005
