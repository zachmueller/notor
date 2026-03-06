# Implementation Plan: Notor MVP

**Created:** 2026-06-03
**Specification:** [specs/01-mvp/spec.md](spec.md)
**Status:** Planning

## Technical Context

### Architecture Decisions

- **Platform:** Obsidian community plugin (TypeScript → esbuild → `main.js`)
- **UI framework:** Obsidian native APIs — `ItemView` for chat panel, `PluginSettingTab` for settings, `Modal` for diffs/checkpoints
- **LLM integration:** Provider-agnostic abstraction layer (`LLMProvider` interface) with four initial implementations: local OpenAI-compatible (default), AWS Bedrock, Anthropic API, OpenAI API
- **Credential storage:** Obsidian's `SecretStorage` API (`app.secretStorage`) — synchronous, string-only secret store with `setSecret`/`getSecret`/`listSecrets`. Settings store secret *names*; actual credentials retrieved at runtime. Requires `minAppVersion` ≥ 1.11.4.
- **Data persistence:** JSONL for chat history, JSON for checkpoints, Obsidian `loadData`/`saveData` for settings
- **Bundler:** esbuild (already configured)
- **Package manager:** npm (already configured)
- **Streaming:** Async iterables over SSE/HTTP streams, with buffering adapter for non-streaming providers
- **Tool dispatch:** Central dispatcher with Plan/Act mode enforcement, auto-approve checks, and approval UI delegation

### Technology Stack Rationale

| Decision | Rationale | Alternatives Considered | Trade-offs |
|---|---|---|---|
| Obsidian native APIs for UI | Required by plugin model; no external UI frameworks allowed in Obsidian plugins | React (not viable without extra bundling complexity) | Limited to Obsidian's DOM-based API; no component model, but keeps bundle small |
| esbuild bundler | Already configured; fast, zero-config for TypeScript | Rollup, webpack | Less plugin ecosystem than webpack, but sufficient for this project |
| JSONL for chat history | Append-only format, one object per line; efficient for streaming writes; easy to parse line-by-line | SQLite, single JSON file | No random-access queries (acceptable for MVP); avoids native module dependency |
| Custom checkpoint system (not git) | Spec requires git-independence; simpler for users who don't use git | Git-based snapshots | Must implement our own storage/retention; but avoids git dependency and works on mobile |
| AWS SDK v3 for Bedrock | Required for credential chain resolution (SSO, assumed roles, named profiles) | Raw HTTP with SigV4 signing | Adds ~50-100KB to bundle; but handles credential complexity correctly |
| Obsidian secrets manager for credentials | Spec requirement (NFR-2); OS-level encrypted storage via `SecretStorage` class (since 1.11.4) | Plain-text in plugin data | Requires `minAppVersion` bump to 1.11.4; no delete API (use empty string); shared namespace across plugins |

### Integration Points

- **Obsidian vault API:** File read/write/create/modify, `vault.process` for atomic read-modify-write, metadata cache, `fileManager.processFrontMatter` for safe frontmatter editing, `getFrontMatterInfo` for frontmatter boundary parsing
- **Obsidian workspace API:** Leaf views, editor navigation, active file tracking
- **Obsidian secrets manager API:** `SecretStorage` — `setSecret(id, secret)`, `getSecret(id)`, `listSecrets()`; `SecretComponent` for settings UI via `Setting.addComponent()`
- **LLM provider HTTP APIs:** OpenAI-compatible `/v1/chat/completions`, `/v1/models`; Anthropic `/v1/messages`; AWS Bedrock `InvokeModelWithResponseStream`, `ListInferenceProfiles`
- **AWS SDK v3:** `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock`, `@aws-sdk/credential-providers`

---

## Phase 0: Research & Architecture

### Research Tasks ✅

All four research tasks are complete. Full details and questions are in [research.md](research.md); findings are in the output files linked below.

#### R-1: Obsidian secrets manager API ✅

`SecretStorage` class confirmed (since 1.11.4): synchronous `setSecret`/`getSecret`/`listSecrets`, string-only, shared namespace. No delete API (use empty string). Settings store secret *names*, not values. `SecretComponent` available for settings UI. No fallback needed — require `minAppVersion` ≥ 1.11.4.

**Output:** [`design/research/obsidian-secrets-manager.md`](../../design/research/obsidian-secrets-manager.md)

#### R-2: System prompt design ✅

Cline's ~8K–10K token prompt analyzed; 8 patterns transfer to Notor (structured tool docs, editing strategy, mode-aware behavior, step-by-step reasoning, safety rules, context injection, error handling, communication style). Recommended base prompt ~3,000 tokens (9 sections), hard ceiling 8,000 tokens. Tool definitions should be generated from the tool registry (single source of truth).

**Output:** [`design/research/system-prompt-design.md`](../../design/research/system-prompt-design.md)

#### R-3: Obsidian vault API and frontmatter handling ✅

`vault.create`/`vault.modify`/`vault.read` are not frontmatter-aware. `vault.process` (since 1.1.0) provides atomic read-modify-write for `replace_in_note`. `fileManager.processFrontMatter` (since 1.4.4) provides atomic frontmatter-only editing for Phase 2 tools. `write_note` uses read-before-write with frontmatter merge. All APIs available below 1.11.4.

**Output:** [`design/research/obsidian-vault-api-frontmatter.md`](../../design/research/obsidian-vault-api-frontmatter.md)

#### R-4: LLM provider model list APIs ✅

All four providers expose model list APIs. No provider returns context window or pricing — a static metadata table (keyed by model ID) is required, following Cline's proven pattern. OpenAI requires client-side filtering (100+ models); Anthropic uses cursor-based pagination; Bedrock uses `ListInferenceProfiles` with `typeEquals: "SYSTEM_DEFINED"` (returns cross-region inference profile IDs that are passed directly to the Converse API as `modelId`; newer models such as Claude Sonnet 4.6 and Llama 4 appear only in inference profiles, not in `ListFoundationModels`). Cache model lists in memory (5-min TTL, stale-while-revalidate); fall back to free-text input on failure.

**Output:** [`design/research/llm-model-list-apis.md`](../../design/research/llm-model-list-apis.md)

### Architecture Investigation

- **Performance requirements:** Plugin startup must not block Obsidian UI. Tool execution for vaults up to 10,000 notes should complete within seconds. Streaming should begin rendering within 1s of LLM output start.
- **Security analysis:** Zero telemetry. Network requests only to user-configured LLM endpoints. Credentials in secrets manager only. No remote code execution.
- **Deployment strategy:** `main.js` + `manifest.json` + `styles.css` copied to vault plugin directory. Dev mode via `npm run dev` (esbuild watch).

### Research Deliverables ✅

- [`design/research/obsidian-secrets-manager.md`](../../design/research/obsidian-secrets-manager.md) — Secrets manager API findings
- [`design/research/system-prompt-design.md`](../../design/research/system-prompt-design.md) — System prompt architecture analysis
- [`design/research/obsidian-vault-api-frontmatter.md`](../../design/research/obsidian-vault-api-frontmatter.md) — Vault API frontmatter behavior
- [`design/research/llm-model-list-apis.md`](../../design/research/llm-model-list-apis.md) — Model list API investigation across providers

---

## Phase 1: Design & Contracts

**Prerequisites:** All Phase 0 research complete (R-1 through R-4)

### Data Model Design

Full data model is documented in [data-model.md](data-model.md). Key entities:

- **Conversation** — ordered message sequence with metadata, token tracking, checkpoint references
- **Message** — individual message with role, content, timestamps, token counts
- **ToolCall / ToolResult** — structured records of tool invocations and their outcomes
- **Checkpoint** — note snapshot scoped to a conversation
- **LLMProvider configuration** — provider type, credentials reference, endpoint, model selection
- **VaultRule** — instruction file with trigger conditions for context injection

### API Contract Generation

Tool schemas and provider interface contracts are documented in [contracts/](contracts/). Key contracts:

- **LLMProvider interface** — `sendMessage`, `listModels`, `getTokenCount`, `supportsStreaming`
- **Tool schemas** — JSON Schema definitions for all 8 built-in tools (5 in Phase 1, 3 in Phase 2)
- **Message format** — JSONL serialization schema for chat history persistence
- **Checkpoint format** — Storage schema for note snapshots

### Development Environment Setup

Developer onboarding guide is in [quickstart.md](quickstart.md).

---

## Implementation Phases

### Phase 0 — Foundation & Infrastructure

**Prerequisites:** R-1 (secrets manager), R-2 (system prompt design), R-4 (model list APIs) complete

| Component | FRs Covered | Description |
|---|---|---|
| Plugin architecture | — | Settings framework, lifecycle management, logging (partially complete in `src/`) |
| LLM provider abstraction | FR-1 | `LLMProvider` interface + implementations for local, Bedrock, Anthropic, OpenAI |
| Credential management | FR-2 | `SecretStorage` integration via `app.secretStorage`; settings store secret *names* (e.g., `notor-openai-api-key`), actual values retrieved via `getSecret(name)` at runtime; `SecretComponent` UI for settings tab via `Setting.addComponent()` |
| Model selection | FR-3 | Dynamic fetch from provider list APIs (`/v1/models` for OpenAI/Anthropic/local, `ListInferenceProfiles` with `typeEquals: "SYSTEM_DEFINED"` for Bedrock); static metadata table for context window/pricing (keyed by inference profile ID for Bedrock, model ID for other providers); 5-min in-memory cache with stale-while-revalidate; free-text fallback on fetch failure; client-side filtering for OpenAI (chat models only), cursor pagination for Anthropic, client-side chat-model filtering for Bedrock |
| Chat panel UI | FR-4 | Side panel leaf view, message input, send/stop, conversation list, settings gear |
| Streaming responses | FR-5 | Token-by-token rendering, Markdown formatting, loading indicator |
| System prompt | FR-6 | Built-in default (~3,000 tokens, 9 sections) + customizable `{notor_dir}/prompts/core-system-prompt.md`; tool definitions generated from tool registry; vault-level rules (FR-23) appended dynamically; hard ceiling 8,000 tokens |

### Phase 1 — Core Note Operations

**Prerequisites:** Phase 0 complete, R-3 (vault API frontmatter) complete

| Component | FRs Covered | Description |
|---|---|---|
| `read_note` tool | FR-7 | Read via `vault.read(file)`; strip frontmatter using `getFrontMatterInfo(content).contentStart` when `include_frontmatter` is false |
| `write_note` tool | FR-8 | `vault.create` for new files, `vault.modify` for existing; read-before-write frontmatter merge (prepend existing frontmatter when LLM content lacks it) |
| `replace_in_note` tool | FR-9 | Implemented via `vault.process(file, fn)` for atomic all-or-nothing edits; callback throws on match failure → no changes written |
| `search_vault` tool | FR-10 | Regex/text search with context lines, file glob filtering |
| `list_vault` tool | FR-11 | Directory listing with pagination, sorting, metadata |
| Diff preview UI | FR-12 | Before/after diff display, per-change accept/reject, bulk actions |
| Open notes in editor | FR-13 | Auto-open and navigate to relevant sections |
| Plan vs Act mode | FR-14 | Toggle in chat input area, tool dispatch enforcement |
| Auto-approve settings | FR-15 | Per-tool auto-approve in settings, inline approval prompts |
| Tool transparency | FR-16 | Inline tool call display with expand/collapse |

### Phase 2 — Trust, Safety & Observability

**Prerequisites:** Phase 1 complete

| Component | FRs Covered | Description |
|---|---|---|
| Checkpoints/rollback | FR-17 | Auto-snapshot before writes, timeline UI, preview/restore/diff |
| Token & cost tracking | FR-18 | Per-message and per-conversation token counts, configurable pricing |
| Chat history logging | FR-19 | JSONL persistence, conversation list, retention policy |
| `read_frontmatter` tool | FR-20 | Read via `metadataCache.getFileCache(file)?.frontmatter` (parsed JS object, no disk I/O); strip `position` property before returning |
| `update_frontmatter` tool | FR-21 | Implemented via `fileManager.processFrontMatter(file, fn)` — atomic frontmatter-only editing with body preservation |
| `manage_tags` tool | FR-22 | Implemented via `fileManager.processFrontMatter(file, fn)` — manipulate `frontmatter.tags` array; handles deduplication and missing-tag removal |
| Vault-level rules | FR-23 | Rule files with trigger properties, conditional injection |

---

## Implementation Readiness Validation

### Technical Completeness Check

- [x] Technology choices made and documented (TypeScript, esbuild, Obsidian APIs, JSONL, custom checkpoints)
- [x] Secrets manager API researched and validated (R-1)
- [x] System prompt design patterns identified (R-2)
- [x] Vault API frontmatter behavior understood (R-3)
- [x] Model list API behavior across providers documented (R-4)
- [x] Data model covers all functional requirements (see data-model.md)
- [x] Tool schemas defined for all tools (see contracts/)
- [x] Security requirements addressed (NFR-2: no telemetry, secrets manager, no external calls)
- [x] Performance considerations documented (NFR-1: deferred init, debounced operations)
- [x] Integration points defined (vault API, workspace API, LLM HTTP APIs, AWS SDK)

### Quality Validation

- [x] Architecture supports scalability (provider-agnostic interface, extensible tool registry)
- [x] Security model matches threat analysis (credentials encrypted, no telemetry, vault-scoped access)
- [x] Data model supports all business rules (stale-content checks, atomic replace, checkpoint scoping)
- [x] API design follows established patterns (JSON Schema tool definitions, JSONL persistence)
- [x] All research deliverables complete

---

## Risk Assessment

### Technical Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| **~~Secrets manager API insufficient or platform-inconsistent~~** | ~~High~~ | ~~Medium~~ | **Resolved (R-1):** `SecretStorage` is sufficient. No fallback needed. Requires `minAppVersion` 1.11.4. Only limitation: no delete API (use empty string workaround). |
| **AWS SDK v3 bundle size too large** | Medium — could slow plugin load | Medium | Tree-shake aggressively; lazy-load Bedrock provider only when selected |
| **~~Vault API frontmatter handling destroys metadata~~** | ~~High~~ | ~~Medium~~ | **Resolved (R-3):** `vault.process` provides atomic operations for `replace_in_note`. `write_note` uses read-before-write frontmatter merge. `processFrontMatter` available for Phase 2 metadata tools. |
| **~~Model list APIs inconsistent across providers~~** | ~~Low~~ | ~~High~~ | **Resolved (R-4):** All four providers have list APIs. Differences are manageable (client-side filtering for OpenAI, pagination for Anthropic, `ListInferenceProfiles` with `typeEquals: "SYSTEM_DEFINED"` for Bedrock). Static metadata table needed for context window/pricing (no provider returns these). Bedrock metadata table keyed by inference profile ID (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`). |
| **Streaming incompatibility across providers** | Medium — degraded UX | Low | Buffering adapter for non-streaming providers |
| **Context window management complexity** | Medium — poor UX for long conversations | Medium | Simple truncation for MVP; auto-compaction deferred to Phase 3 |

### Dependencies and Assumptions

- **External dependencies:** `obsidian` types, AWS SDK v3 (for Bedrock), no other runtime dependencies
- **Technical assumptions:** `minAppVersion` set to `1.11.4` (required for `SecretStorage` — confirmed by R-1); JSONL files in plugin directory are not indexed as notes; `vault.process` provides atomic read-modify-write (confirmed by R-3); no provider returns context window or pricing in model list APIs (confirmed by R-4) — static metadata table required; Bedrock model listing uses `ListInferenceProfiles` (not `ListFoundationModels`) — inference profile IDs (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) are used directly as `modelId` in Converse API calls; IAM policy must include `bedrock:ListInferenceProfiles`
- **Business assumptions:** Users have a working LLM provider before using Notor; default local endpoint is `http://localhost:11434/v1` (Ollama)

---

## Next Phase Preparation

### Task Breakdown Readiness

- [x] Clear technology choices and architecture
- [x] Complete data model and tool specifications
- [x] Development environment and tooling defined
- [x] Quality standards and testing approach specified (e2e framework exists)
- [x] Integration requirements and dependencies clear
- [x] All research completed and documented

### Implementation Prerequisites

- [x] R-1: Obsidian secrets manager API research complete
- [x] R-2: System prompt design research complete
- [x] R-3: Obsidian vault API frontmatter research complete
- [x] R-4: LLM provider model list APIs research complete
- [x] Development environment requirements specified (see quickstart.md)
- [x] Third-party integrations planned (AWS SDK, LLM HTTP APIs)
- [x] Quality assurance approach defined (e2e tests with Playwright)