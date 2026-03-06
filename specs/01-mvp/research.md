# Research Plan: Notor MVP

**Created:** 2026-06-03
**Plan:** [specs/01-mvp/plan.md](plan.md)
**Status:** Complete

This document consolidates all research tasks that must be completed before their respective implementation phases can begin. Each task should produce findings documented in the specified output file under `design/research/`.

---

## R-1: Obsidian Secrets Manager API ✅

**Status:** Complete (2026-06-03)
**Blocks:** Phase 0 (credential management — FR-2)
**Priority:** Critical
**Output:** [`design/research/obsidian-secrets-manager.md`](../../design/research/obsidian-secrets-manager.md)

### Context

Notor stores LLM provider credentials (API keys, access tokens) using Obsidian's built-in secrets manager API rather than plain-text plugin data files (NFR-2). This API was added in recent Obsidian releases and its capabilities and limitations must be understood before implementation.

### Questions to Answer

1. **API surface:** What methods does Obsidian expose for secret storage? (`app.loadLocalStorage`/`app.saveLocalStorage`, or a dedicated secrets API?) What are the method signatures and return types?
2. **Storage mechanism:** How are secrets stored per platform (macOS Keychain, Windows Credential Manager, Linux libsecret/GNOME Keyring)? Are there platform-specific differences in behavior?
3. **Secret lifecycle:** Can secrets be created, read, updated, and deleted independently? Is there a namespace per plugin, or is it shared?
4. **Size and format limitations:** Are there limits on secret value size? Can secrets store structured data (JSON), or only strings?
5. **Plugin lifecycle integration:** When are secrets available — during `onload`, or only after some initialization step? What happens on plugin uninstall?
6. **Minimum Obsidian version:** What is the minimum Obsidian version that supports the secrets manager? Does our current `minAppVersion` (0.15.0) need to be bumped?
7. **Mobile support:** Does the secrets manager work on iOS and Android? Any differences?
8. **Fallback strategy:** If the secrets manager is unavailable or insufficient, what is the best alternative for secure credential storage within the Obsidian plugin model?

### Success Criteria

- [x] Complete API documentation with method signatures and usage examples
- [x] Platform behavior matrix (macOS, Windows, Linux, iOS, Android)
- [x] Confirmed minimum Obsidian version requirement
- [x] Clear recommendation on whether to proceed with secrets manager or adopt an alternative

### Key Findings

- **API:** `SecretStorage` class with `setSecret(id, secret)`, `getSecret(id)`, `listSecrets()` — all synchronous, string-only
- **No delete method** — use `setSecret(id, "")` as workaround
- **Shared namespace** — secrets are global across plugins; settings store secret *names*, not values
- **`minAppVersion` must be bumped** from `0.15.0` to `1.11.4`
- **Recommendation:** Proceed with `SecretStorage`; no fallback needed
- **UI:** Use `SecretComponent` via `Setting.addComponent()` in settings tab

---

## R-2: System Prompt Design — Learning from Cline ✅

**Status:** Complete (2026-06-03)
**Blocks:** Phase 0 (system prompt — FR-6)
**Priority:** Critical
**Output:** [`design/research/system-prompt-design.md`](../../design/research/system-prompt-design.md)

### Context

Notor needs a well-crafted default system prompt that shapes AI behavior for note writing and knowledge management. Cline (an AI coding assistant for VS Code) has a mature system prompt architecture that can inform our design, though the context is different (software development vs. knowledge work).

### Questions to Answer

1. **Cline's system prompt structure:** What are the major sections/components of Cline's system prompt? (role definition, tool instructions, behavioral constraints, output formatting, context injection patterns, safety guardrails)
2. **Transferable patterns:** Which architectural patterns from Cline apply to a note writing context? (e.g., tool usage instructions, step-by-step reasoning, output formatting)
3. **Non-transferable patterns:** What is specific to software development and should not be carried over? (e.g., code-specific formatting, compiler error handling)
4. **Note writing requirements:** What should a note writing system prompt emphasize? Consider:
   - Markdown formatting conventions and Obsidian-specific syntax (wikilinks, callouts, frontmatter)
   - Note editing safety (prefer surgical edits, preserve structure, don't rewrite unnecessarily)
   - Vault-aware behaviors (understanding file paths, folder organization, tags, frontmatter)
   - Search and research patterns (citing sources, cross-referencing notes)
   - User interaction style (concise, helpful, non-destructive)
5. **Tool usage instructions:** How should the system prompt instruct the AI to use Notor's tools? (when to read vs. search, when to use `replace_in_note` vs. `write_note`, how to handle errors)
6. **Safety guardrails:** What behavioral constraints should be built into the prompt? (ask before large changes, confirm destructive operations, report failures clearly)
7. **Prompt size considerations:** What is an appropriate size for the system prompt given context window constraints? How to balance comprehensiveness with token efficiency?

### Success Criteria

- [x] Analysis of Cline's system prompt with transferable/non-transferable classification
- [x] Draft structure for Notor's default system prompt (section outline with descriptions)
- [x] Specific recommended prompt text for tool usage instructions
- [x] Size estimate and token budget recommendation

### Key Findings

- **Cline's prompt is ~8,000–10,000 tokens**, organized into 9 major sections; ~60% is tool documentation
- **8 patterns transfer directly** to Notor: structured tool docs, strategic editing guidance, mode-aware behavior, step-by-step reasoning, safety/confirmation rules, context injection, error handling, communication style
- **6 patterns are non-transferable** (code-specific): code formatting, project scaffolding, terminal strategy, browser protocol, IDE context, git workflow
- **Notor-specific additions needed:** Obsidian syntax reference (wikilinks, callouts, frontmatter), note editing safety principles (surgical edits, read-before-write, frontmatter awareness), vault-aware behavior
- **Recommended base prompt: ~3,000 tokens** (9 sections), max ~5,100 with vault-level rules; hard ceiling 8,000 tokens
- **Three core safety principles:** read before write, surgical over wholesale, transparent failures
- **Tool definitions should be generated from the tool registry** (single source of truth), not hardcoded in prompt text
- **Recommendation:** Proceed with Cline's structured architecture, adapted for note writing domain

---

## R-3: Obsidian Vault API and Frontmatter Handling ✅

**Status:** Complete (2026-06-03)
**Blocks:** Phase 1 (`write_note` — FR-8, `replace_in_note` — FR-9)
**Priority:** High
**Output:** [`design/research/obsidian-vault-api-frontmatter.md`](../../design/research/obsidian-vault-api-frontmatter.md)

### Context

Obsidian notes are plain Markdown files where YAML frontmatter is stored at the top. The `write_note` tool accepts complete content to write, but the LLM may not have read the frontmatter (if `include_frontmatter` was `false` on `read_note`). A full-file write could silently destroy existing frontmatter. We need to understand Obsidian's vault API behavior before finalizing the tool implementations.

### Questions to Answer

1. **`vault.create` behavior:** Does `vault.create` write the entire file content (including frontmatter)? What happens if the file already exists?
2. **`vault.modify` behavior:** Does `vault.modify` overwrite the entire file content? Is there any frontmatter-aware mode?
3. **`vault.read` behavior:** Does `vault.read` return the full file including frontmatter? Can frontmatter be excluded via the API?
4. **Metadata cache:** Does Obsidian's metadata cache (`app.metadataCache`) provide parsed frontmatter separately? Can it be used to read frontmatter without reading the full file?
5. **`processFrontMatter` API:** Does Obsidian provide a `processFrontMatter` method or similar for safe frontmatter updates? What is its API surface?
6. **Frontmatter preservation strategy:** What is the safest approach for `write_note` to avoid destroying frontmatter? Options:
   - Always read existing frontmatter before writing, merge with new content
   - Require the LLM to include frontmatter in write content
   - Use `processFrontMatter` for frontmatter-only operations (Phase 2 tools)
   - Separate frontmatter from body content in the tool parameter design
7. **Atomic writes:** Does `vault.modify` provide atomic writes, or can partial writes occur on failure?
8. **File events:** What events does Obsidian fire on file creation/modification? How do they affect the metadata cache?

### Success Criteria

- [x] Complete documentation of vault API write behavior with frontmatter
- [x] Recommended implementation strategy for `write_note` and `replace_in_note`
- [x] Confirmed approach for Phase 2 frontmatter tools (`update_frontmatter`, `manage_tags`)
- [x] Code examples demonstrating safe write patterns

### Key Findings

- **`vault.create`/`vault.modify`/`vault.read` are not frontmatter-aware** — they operate on raw file strings. Frontmatter is just the beginning of the string.
- **`vault.process(file, fn)` (since 1.1.0)** provides atomic read-modify-write — ideal for `replace_in_note` (callback throws → no changes written)
- **`fileManager.processFrontMatter(file, fn)` (since 1.4.4)** provides atomic frontmatter-only editing with body preservation — ideal for Phase 2 tools (`update_frontmatter`, `manage_tags`)
- **`getFrontMatterInfo(content)`** utility parses frontmatter boundaries from a string — used to implement `include_frontmatter` stripping and frontmatter preservation
- **`metadataCache.getFileCache(file)?.frontmatter`** provides parsed frontmatter as a JS object without disk I/O — ideal for `read_frontmatter`
- **Frontmatter preservation strategy for `write_note`:** Read-before-write with merge — if existing file has frontmatter but LLM content doesn't, prepend existing frontmatter block. `replace_in_note` inherently preserves frontmatter (unmatched content untouched).
- **No `minAppVersion` bump needed** — all required APIs available well below 1.11.4 (already set by R-1)
- **Recommendation:** Proceed with `vault.process` for `replace_in_note`, `vault.create`/`vault.modify` with frontmatter merge for `write_note`, `processFrontMatter` for Phase 2 tools

---

## R-4: LLM Provider Model List APIs ✅

**Status:** Complete (2026-06-03)
**Blocks:** Phase 0 (model selection — FR-3)
**Priority:** High
**Output:** [`design/research/llm-model-list-apis.md`](../../design/research/llm-model-list-apis.md)

### Context

FR-3 requires that the model selection dropdown be populated by dynamically querying each provider's model list API. If the API is unavailable or returns an error, the UI falls back to a free-text input field. This research must determine the actual APIs, authentication requirements, response formats, and practical considerations for each of the four supported providers.

### Questions to Answer

#### OpenAI API

1. **Endpoint:** What is the exact endpoint for listing models? (`GET /v1/models`)
2. **Authentication:** Does the models endpoint require an API key? What scopes/permissions?
3. **Response format:** What does the response look like? What fields are available per model (id, name, capabilities, context window, pricing)?
4. **Filtering:** How to filter to only chat-capable models? Are there model capability flags?
5. **Rate limits:** Are there rate limits on the models endpoint? Caching recommendations?

#### Anthropic API

1. **Endpoint:** Does Anthropic provide a model list API? What is the endpoint?
2. **Authentication:** What authentication is required?
3. **Response format:** What model metadata is available (id, name, context window, pricing)?
4. **Known models:** If no list API exists, what is the current set of Anthropic models and their IDs? How often are new models released?
5. **Alternative approaches:** If no list API, should we maintain a hardcoded list with manual refresh? Or use a different discovery mechanism?

#### AWS Bedrock

1. **Endpoint:** What AWS SDK call lists available foundation models? (`ListFoundationModels` from `@aws-sdk/client-bedrock`)
2. **Authentication:** What IAM permissions are required to list models? Is it different from invoking models?
3. **Response format:** What metadata is available per model (model ID, provider, capabilities, context window)?
4. **Filtering:** How to filter to only text/chat models (exclude image generation, embeddings, etc.)? Filter by provider (Anthropic on Bedrock, etc.)?
5. **Region dependency:** Does the model list vary by AWS region? Must we query per-region?
6. **Model access:** Does the list include models the user hasn't enabled/subscribed to? How to distinguish available vs. enabled models?
7. **Cross-region inference:** How does cross-region inference affect model IDs and availability?

#### Local OpenAI-Compatible (Ollama, LM Studio, etc.)

1. **Endpoint:** Is `/v1/models` universally supported across local providers?
2. **Authentication:** Is authentication typically required or optional?
3. **Response format:** How consistent is the response format across Ollama, LM Studio, and other OpenAI-compatible servers?
4. **Ollama specifics:** Does Ollama's `/v1/models` endpoint return the same format as OpenAI? Are there Ollama-specific quirks?
5. **LM Studio specifics:** Same questions for LM Studio.
6. **Error handling:** What errors are common when the local server isn't running?

#### Cross-Provider Considerations

1. **Unified model representation:** What common fields can we extract across all providers for display in the dropdown? (id, display name, context window, provider label)
2. **Caching strategy:** How long should model lists be cached? When should they be invalidated?
3. **Fallback behavior:** When the model list fetch fails, what information should the free-text fallback provide (placeholder text, last-known models)?
4. **Model switching:** Can the model be changed mid-conversation without issues?

### Success Criteria

- [x] Documented API endpoint, authentication, and response format for each provider
- [x] Sample response payloads for each provider
- [x] Recommended unified model representation for the UI dropdown
- [x] Caching and refresh strategy
- [x] Fallback behavior specification
- [x] Identification of any provider-specific quirks or limitations

### Key Findings

- **All four providers expose model list APIs** — OpenAI (`GET /v1/models`), Anthropic (`GET /v1/models`), Bedrock (`ListInferenceProfiles`), Local (`GET {base_url}/v1/models`)
- **No provider returns context window or pricing** in their list endpoint — a supplementary static metadata table is required, keyed by model ID
- **Cline codebase analysis confirms this is the industry-standard approach** — Cline uses hardcoded static metadata tables (`Record<string, ModelInfo>` keyed by model ID) for all direct API providers (Anthropic, OpenAI, Bedrock). Context window sizes and pricing are never fetched dynamically from these providers. See Section 5 of the output document for the full analysis.
- **Cline's three-tier strategy for model metadata:**
  1. **Hardcoded static tables** for direct API providers (Anthropic, OpenAI, Bedrock) — one `Record<string, ModelInfo>` per provider containing `contextWindow`, `maxTokens`, `inputPrice`, `outputPrice`, etc.
  2. **Dynamic API fetching** for aggregator providers (OpenRouter returns `context_length` and `pricing` in its `/api/v1/models` response)
  3. **User-provided settings** for local providers (Ollama defaults to 32k, LM Studio defaults to 128k; both allow user override via settings)
- **Graceful degradation for unknown models:** Cline falls back to sane defaults (`contextWindow: 128_000`) when a model ID is not found in the static table. The system continues to work — context management just uses the default value.
- **Anthropic provides `display_name`**; Bedrock provides `inferenceProfileName`; OpenAI and local return only `id`
- **OpenAI requires client-side filtering** (returns 100+ models including embeddings, images, etc.); Bedrock requires client-side filtering to exclude non-chat models (image generation, embeddings)
- **Anthropic requires cursor-based pagination** (`after_id` / `has_more`); other providers return all results in one response
- **Bedrock `ListInferenceProfiles` (SYSTEM_DEFINED) supersedes `ListFoundationModels`** — newer models (Claude 4.x, Llama 4, Nova Premier, DeepSeek R1) appear only in inference profiles; profile IDs (e.g., `us.anthropic.claude-sonnet-4-20250514-v1:0`) are the correct `modelId` values for Converse API calls and provide automatic cross-region failover. IAM policy must be updated from `bedrock:ListFoundationModels` to `bedrock:ListInferenceProfiles`. Geographic prefixes (`us.`, `eu.`, `apac.`, `global.`) indicate the routing region group; the API returns only the profiles relevant to the client's configured region.
- **Local providers may not be running** — must handle `ECONNREFUSED` gracefully with free-text fallback
- **Recommendation:** Cache model lists in memory (5-min TTL, stale-while-revalidate), fall back to free-text input on failure, maintain a static metadata table for context window/pricing following Cline's proven pattern. For Bedrock, use `ListInferenceProfiles` with `typeEquals: "SYSTEM_DEFINED"` and key the metadata table by inference profile ID. For local providers, add a "Context window" setting with a sensible default (128k).

---

## Research Coordination

### Execution Order

Research tasks should be executed in this order based on dependency chains:

1. **R-1 (Secrets manager)** and **R-4 (Model list APIs)** — can run in parallel; both block Phase 0
2. **R-2 (System prompt design)** — can run in parallel with R-1/R-4; blocks Phase 0
3. **R-3 (Vault API frontmatter)** — blocks Phase 1; can start after Phase 0 research is underway

### Definition of Done

Each research task is complete when:

- [x] All questions answered with evidence (code examples, API documentation, or experimental results)
- [x] Output document written to the specified path under `design/research/`
- [x] Clear recommendation provided for implementation approach
- [x] Any risks or limitations identified and documented
- [x] Minimum Obsidian version requirements confirmed (if applicable)
