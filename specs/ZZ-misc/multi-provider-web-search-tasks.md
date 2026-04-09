# Multi-Provider Web Search — Implementation Tasks

**Design spec:** [multi-provider-web-search-design.md](./multi-provider-web-search-design.md)
**Dependency spec:** [task-lane-queue-design.md](./task-lane-queue-design.md)
**Date:** 2026-04-09

---

## Prerequisite: TaskLaneQueue (DONE)

The `TaskLaneQueue` dependency from [`task-lane-queue-design.md`](./task-lane-queue-design.md) is fully implemented:
- `src/queue/task-lane-queue.ts` — class with `enqueue()`, `pending()`, `destroy()`
- `src/queue/__tests__/task-lane-queue.test.ts` — 18 passing unit tests
- `src/main.ts:173` — `_taskLaneQueue` field + `getTaskLaneQueue()` getter at L1463
- `src/extensions/runtime-context.ts:102-106` — `utils.queue` exposed to extensions
- `src/main.ts:601-603` — `destroy()` in `onunload()`

No work needed here. All phases below build on this foundation.

---

## Phase 1: Provider Interface & DuckDuckGo Extraction

> Foundation layer. Creates the provider abstraction and extracts DDG logic from the scaffold into a proper module, **enhancing it with rate-limit detection** for the fallback chain in Phase 3. The scaffold continues to work identically after this phase (it is not modified).

### 1.1 Create provider interface and types

**File to create:** `src/web-search/providers/provider.ts`

- [x] Define `WebSearchProviderType` union: `"duckduckgo" | "tavily" | "brave" | "serpapi"`
- [x] Define `WebSearchResult` interface: `{ title: string; url: string; snippet: string }`
- [x] Define `SearchProviderMeta` interface: `{ type, displayName, requiresApiKey, defaultDelayMs }`
- [x] Define `ProviderConfig` interface: `{ enabled: boolean; delayMs: number; apiKey: string | null }`
- [x] Define `SearchProviderResult` interface: `{ results: WebSearchResult[]; rateLimited?: boolean; error?: string; warnings?: string[] }`
- [x] Define `SearchProvider` interface with `meta`, `search(query, numResults, timeoutMs, apiKey, signal?)`, and `isConfigured(config)` methods
  - `search()` receives only `apiKey: string | null` (not the full `ProviderConfig`) — `enabled` and `delayMs` are consumed upstream by the queue/lane-queue
  - `signal?: AbortSignal` allows the caller to cancel in-flight requests (threaded from `ExtensionUtils.abortSignal`)
  - `isConfigured()` receives `config: ProviderConfig` — providers are stateless singletons, config flows in from outside at every call site
- [x] Export all types

### 1.2 Extract DuckDuckGo provider from scaffold

**File to create:** `src/web-search/providers/duckduckgo.ts`

Source code lives in `src/extensions/builtin-tool-scaffolds.ts:1248-1341` as string-template TypeScript inside the `WEB_SEARCH` scaffold constant.

- [x] Create `DuckDuckGoProvider` class implementing `SearchProvider`
- [x] Set `meta`: `{ type: "duckduckgo", displayName: "DuckDuckGo", requiresApiKey: false, defaultDelayMs: 1500 }`
- [x] Extract `cleanDDGUrl()` from scaffold L1248-1260 — make it a private method (export for tests)
- [x] Extract `parseDDGResults()` from scaffold L1262-1287 — make it a private method (export for tests)
  - Uses browser-native `DOMParser` (not `@xmldom/xmldom`)
  - Selectors: `.result` container, `.result__title a` for title+link, `.result__snippet` for snippet
- [x] Implement `search()` method **based on** scaffold HTTP logic (L1305-1341), **adding rate-limit detection not present in the scaffold**:
  - POST to `https://html.duckduckgo.com/html/` with form-encoded body
  - User-Agent: Chrome/120 on Macintosh (matching current scaffold)
  - Timeout race via `Promise.race()` with `setTimeout` reject
  - Import `requestUrl` from `obsidian` directly (note: the current scaffold uses `obsidian.requestUrl` via runtime injection — the extracted module uses a proper ES import instead)
  - Pass `throw: false` in the `requestUrl` options — without it Obsidian throws on non-2xx status codes, making HTTP 202 uninspectable
  - Rate-limit detection: HTTP 202 OR 0 parsed results from non-empty response → `rateLimited: true`
    - **Delta from scaffold:** The scaffold throws on any non-200 status (including 202) and returns empty results on selector drift. The provider instead signals `rateLimited` for both cases, enabling fallback in the Phase 3 chain.
  - Selector drift warning: when 0 results parsed from non-empty body, push a warning string into `result.warnings[]` (replaces direct logging — providers have no logger; the `WebSearchQueue` in Phase 3.3 logs these)
  - If `signal` is provided, include it in the `Promise.race()` pattern (abort listener that rejects on `signal.abort`)
- [x] Implement `isConfigured()`: return `config.enabled` (no API key needed)

### 1.3 DuckDuckGo provider tests

**File to create:** `src/web-search/providers/__tests__/duckduckgo.test.ts`

Follow existing test patterns: Vitest, `vi.mock("obsidian")` for `requestUrl`, `beforeEach(() => vi.clearAllMocks())`.

- [x] Add `// @vitest-environment jsdom` directive at top of file (DOMParser is not available in Vitest's default Node.js environment)
- [x] Test `cleanDDGUrl()`:
  - DDG redirect URL (`//duckduckgo.com/l/?uddg=...`) → decoded actual URL
  - Protocol-relative URL (`//example.com`) → `https://example.com`
  - Absolute HTTP/HTTPS URLs → passthrough
  - Invalid/empty input → `null`
- [x] Test `parseDDGResults()`:
  - Valid HTML with multiple `.result` containers → correct extraction
  - `maxResults` cap honored
  - Missing title or URL → result skipped
  - Empty HTML → empty array
- [x] Test `search()` — HTTP success:
  - Mock `requestUrl` returning status 200 with HTML → parsed results
- [x] Test `search()` — rate-limit detection:
  - HTTP 202 → `rateLimited: true`
  - HTTP 200 but 0 parsed results from non-empty body → `rateLimited: true`, `warnings[]` populated with selector drift message
- [x] Test `search()` — error handling:
  - Non-200/202 status → error thrown
  - Network error → error propagated
  - Timeout → error with timeout message
- [x] Test `isConfigured()`: returns `true` when `enabled: true`, `false` otherwise

---

## Phase 2: API Search Providers

> Three independent providers. Can be implemented in parallel. Each follows the same pattern: implement `SearchProvider`, handle JSON request/response, detect rate limits.

### 2.1 Tavily provider

**File to create:** `src/web-search/providers/tavily.ts`

- [x] Create `TavilyProvider` class implementing `SearchProvider`
- [x] Set `meta`: `{ type: "tavily", displayName: "Tavily", requiresApiKey: true, defaultDelayMs: 0 }`
- [x] Implement `search()`:
  - POST to `https://api.tavily.com/search`
  - Auth: Bearer token in `Authorization` header (from `apiKey` parameter)
  - JSON body: `{ query, max_results: numResults }`
  - Pass `throw: false` in the `requestUrl` options — without it Obsidian throws on non-2xx status codes, making HTTP 429 uninspectable
  - Parse JSON response: map `results[]` to `WebSearchResult[]` (fields: `title`, `url`, `content` → `snippet`)
  - Rate-limit detection: HTTP 429 → `rateLimited: true`
  - Timeout via `Promise.race()` pattern
  - If `signal` is provided, include an abort listener in the `Promise.race()`
- [x] Implement `isConfigured()`: `config.enabled && !!config.apiKey`

**Note:** The provider receives `apiKey` as a parameter to `search()` at call time. The `WebSearchQueue` passes the resolved API key from settings. Providers are stateless singletons — config is external.

### 2.2 Tavily provider tests

**File to create:** `src/web-search/providers/__tests__/tavily.test.ts`

- [x] Test `search()` — success: mock `requestUrl` returning JSON with results → `WebSearchResult[]`
- [x] Test `search()` — verify `Authorization: Bearer <key>` header sent
- [x] Test `search()` — rate-limit: HTTP 429 → `rateLimited: true`
- [x] Test `search()` — timeout handling
- [x] Test `search()` — non-429 error status
- [x] Test `isConfigured()`: enabled + key → true; enabled + no key → false; disabled → false

### 2.3 Brave Search provider

**File to create:** `src/web-search/providers/brave.ts`

- [x] Create `BraveSearchProvider` class implementing `SearchProvider`
- [x] Set `meta`: `{ type: "brave", displayName: "Brave Search", requiresApiKey: true, defaultDelayMs: 0 }`
- [x] Implement `search()`:
  - GET to `https://api.search.brave.com/res/v1/web/search?q={query}&count={numResults}`
  - Auth: `X-Subscription-Token` header
  - Pass `throw: false` in the `requestUrl` options — without it Obsidian throws on non-2xx status codes, making HTTP 429 uninspectable
  - Parse JSON response: map `web.results[]` to `WebSearchResult[]` (fields: `title`, `url`, `description` → `snippet`)
  - Rate-limit detection: HTTP 429 → `rateLimited: true`
  - Timeout via `Promise.race()` pattern; if `signal` is provided, include an abort listener
- [x] Implement `isConfigured()`: `config.enabled && !!config.apiKey`

### 2.4 Brave Search provider tests

**File to create:** `src/web-search/providers/__tests__/brave.test.ts`

- [x] Test `search()` — success: JSON response → `WebSearchResult[]`
- [x] Test `search()` — verify `X-Subscription-Token` header
- [x] Test `search()` — rate-limit: HTTP 429 → `rateLimited: true`
- [x] Test `search()` — timeout and error handling
- [x] Test `isConfigured()`

### 2.5 SerpApi provider

**File to create:** `src/web-search/providers/serpapi.ts`

- [x] Create `SerpApiProvider` class implementing `SearchProvider`
- [x] Set `meta`: `{ type: "serpapi", displayName: "SerpApi", requiresApiKey: true, defaultDelayMs: 0 }`
- [x] Implement `search()`:
  - GET to `https://serpapi.com/search?q={query}&num={numResults}&api_key={key}&engine=google`
  - Auth: `api_key` query parameter
  - Pass `throw: false` in the `requestUrl` options — without it Obsidian throws on non-2xx status codes, making HTTP 429 uninspectable
  - Parse JSON response: map `organic_results[]` to `WebSearchResult[]` (fields: `title`, `link` → `url`, `snippet`)
  - Rate-limit detection: HTTP 429 OR JSON `error` field containing `"rate"` → `rateLimited: true`
  - Timeout via `Promise.race()` pattern; if `signal` is provided, include an abort listener
- [x] Implement `isConfigured()`: `config.enabled && !!config.apiKey`

### 2.6 SerpApi provider tests

**File to create:** `src/web-search/providers/__tests__/serpapi.test.ts`

- [x] Test `search()` — success: JSON response → `WebSearchResult[]`
- [x] Test `search()` — verify `api_key` in query params
- [x] Test `search()` — rate-limit: HTTP 429 → `rateLimited: true`
- [x] Test `search()` — rate-limit: JSON error containing "rate" → `rateLimited: true`
- [x] Test `search()` — timeout and error handling
- [x] Test `isConfigured()`

---

## Phase 3: Provider Registry & Web Search Queue

> Core orchestration. Builds on Phase 1-2 providers and the existing TaskLaneQueue.

### 3.1 Provider registry

**File to create:** `src/web-search/provider-registry.ts`

- [ ] Create `SearchProviderRegistry` class with internal `Map<WebSearchProviderType, SearchProvider>`
- [ ] Implement `register(provider)`: stores by `provider.meta.type`
- [ ] Implement `get(type)`: returns provider or `undefined`
- [ ] Implement `getAll()`: returns all registered providers
- [ ] Implement `getAvailable(providerConfigs)`: filters to providers where `isConfigured(config)` returns `true`
- [ ] Implement `getAvailableByPriority(providerConfigs, priorityOrder)`:
  - Filter by `isConfigured()` → sort by position in `priorityOrder` array
  - Providers not in `priorityOrder` are excluded (not appended)

### 3.2 Provider registry tests

**File to create:** `src/web-search/__tests__/provider-registry.test.ts`

- [ ] Test `register()` and `get()` basic operations
- [ ] Test `getAll()` returns all registered providers
- [ ] Test `getAvailable()`:
  - Provider enabled + key present → included
  - Provider enabled + key missing (for key-requiring) → excluded
  - Provider disabled → excluded
- [ ] Test `getAvailableByPriority()`:
  - Respects priority order
  - Excludes providers not in priority list
  - Excludes unconfigured providers even if in priority list

### 3.3 Web search queue

**File to create:** `src/web-search/queue.ts`

- [ ] Define `WebSearchResolvedConfig` interface (design spec Section 8.2):
  ```
  { roundRobin, providerPriority, maxFallbackProviders, providers: Record<string, { enabled, delayMs, apiKey }> }
  ```
- [ ] Define `WebSearchApiResult` interface (design spec Section 7):
  ```
  { results: WebSearchResult[], provider: string, failures: Array<{ provider, error }>, error?: string }
  ```
  - `error` is set when the queue itself cannot proceed (e.g. "No web search providers are configured") — distinct from per-provider `failures`
- [ ] Create `WebSearchQueue` class:
  - Constructor: `(getSettings: () => Record<string, unknown>, providerRegistry: SearchProviderRegistry, laneQueue: TaskLaneQueue)`
  - Private `roundRobinIndex: number = 0`
- [ ] Implement `buildConfig(settings)`: maps flat extension settings → `WebSearchResolvedConfig`
  - Reads `web_search_round_robin`, `web_search_provider_priority`, `web_search_max_fallback_providers`
  - Reads per-provider `web_search_{provider}_enabled`, `_delay_ms`, `_api_key`
  - Falls back to sensible defaults (DDG enabled, others disabled, `maxFallbackProviders: 2`)
  - **Implementation note:** Define setting key names as constants shared between `buildConfig()` and the YAML fence (or at minimum, add a comment cross-referencing the YAML keys) to prevent silent mismatches from typos.
- [ ] Implement `resolveProviderChain(config, startIndex)` — **pure function, no side effects**:
  - Takes `startIndex: number` as a parameter (passed from `search()`)
  - Uses `providerRegistry.getAvailableByPriority(config.providers, config.providerPriority)`
  - If round-robin ON: rotate starting position via `startIndex % available.length`, wrap cyclically so all providers are included (e.g. with [A,B,C] and startIndex=1 → chain is [B,C,A])
  - If round-robin OFF: return as-is (highest priority first), ignoring `startIndex`
  - In both modes, the returned chain always contains ALL available providers — fallback iterates the full chain before giving up
- [ ] Implement `search(query, numResults, timeoutMs, signal?)`:
  - `signal?: AbortSignal` — if provided, check `signal.aborted` before each provider attempt and pass `signal` through to `provider.search()`
  - Call `getSettings()` → `buildConfig()` → `resolveProviderChain(config, this.roundRobinIndex)`
  - Increment `roundRobinIndex` **after** chain resolution: `this.roundRobinIndex++` (unbounded; post-hoc modulo in `resolveProviderChain` handles wrapping — overflow is impossible in practice at 2^53)
  - Iterate provider chain: `laneQueue.enqueue(provider.meta.type, () => provider.search(query, numResults, timeoutMs, apiKey, signal), delayMs)`
  - After each provider call, log any `result.warnings[]` entries via the queue's logger
  - On success (no `rateLimited`): return `{ results, provider, failures }`
  - On `rateLimited` or error: record in `failures[]`, try next provider
  - Track attempt count. After `config.maxFallbackProviders` attempts, stop iterating even if providers remain in the chain. Return accumulated `failures`.
  - All exhausted (or max attempts reached): return `{ results: [], provider: "", failures, error: "All search providers failed" }`
  - No providers configured: return immediately with `{ results: [], provider: "", failures: [], error: "No web search providers are configured" }`
  - **Note:** `timeoutMs` applies per-provider, not to the entire chain. Worst-case latency is `timeoutMs × maxFallbackProviders`. Document this in a JSDoc comment on the method.

### 3.4 Web search queue tests

**File to create:** `src/web-search/__tests__/queue.test.ts`

Use mock providers and a real `TaskLaneQueue` instance (lightweight, no HTTP).

- [ ] Test single provider success: DDG only → result returned with `provider: "duckduckgo"`
- [ ] Test fallback: first provider rate-limited → second provider used
- [ ] Test fallback: first provider throws → second provider used
- [ ] Test all-providers-fail: aggregated error with all failure reasons
- [ ] Test no providers configured: immediate descriptive error
- [ ] Test round-robin OFF: always starts with highest-priority provider
- [ ] Test round-robin ON with 3 providers: 6 requests distribute cyclically (verify starting provider)
- [ ] Test `buildConfig()`: flat settings → typed config mapping
- [ ] Test lane delegation: verify `laneQueue.enqueue()` called with correct lane key and delay
- [ ] Test settings read fresh: changing `getSettings()` return value between calls → different behavior
- [ ] Test `maxFallbackProviders`: with 4 available providers and `maxFallbackProviders: 2`, only first 2 are tried even if both fail

---

## Phase 4: Scaffold Settings Expansion

> Adds new YAML settings fields to the scaffold for provider configuration. No code logic changes yet — the scaffold still uses inline DDG logic. This phase can land independently.

### 4.1 Expand scaffold YAML settings fence

**File to modify:** `src/extensions/builtin-tool-scaffolds.ts` (WEB_SEARCH constant, L1221-1243)

Add new settings fields after the existing `web_search_default_num_results`:

- [ ] Add `web_search_round_robin` field:
  - `type: boolean`, `default: false`
  - Name: "Round-robin across providers"
  - Description: "Distribute search requests across all enabled providers instead of always using the highest-priority one."
- [ ] Add `web_search_provider_priority` field:
  - `type: string[]`, `default: ["duckduckgo", "tavily", "brave", "serpapi"]`
  - `options: ["duckduckgo", "tavily", "brave", "serpapi"]` (constrains "Add" input to known providers — see 4.2)
  - Name: "Provider priority order"
  - Description: "Order in which search providers are tried. First entry is highest priority."
- [ ] Add `web_search_max_fallback_providers` field:
  - `type: number`, `default: 2`, `min: 1`, `max: 4`
  - Name: "Max providers to try"
  - Description: "Maximum number of search providers to try before giving up. Limits worst-case latency when multiple providers are configured."
- [ ] Update existing `web_search_timeout` description to: "Maximum time **per provider** in seconds to wait for search results before aborting. With max-fallback-providers set to N, worst-case total wait is this value × N."
- [ ] Add DuckDuckGo provider fields:
  - `web_search_duckduckgo_enabled`: `boolean`, default `true`, name "DuckDuckGo — Enabled"
  - `web_search_duckduckgo_delay_ms`: `number`, default `1500`, min `0`, max `10000`, name "DuckDuckGo — Delay (ms)"
- [ ] Add Tavily provider fields:
  - `web_search_tavily_enabled`: `boolean`, default `false`, name "Tavily — Enabled"
  - `web_search_tavily_api_key`: `string`, `secret: true`, name "Tavily — API Key"
  - `web_search_tavily_delay_ms`: `number`, default `0`, min `0`, max `10000`, name "Tavily — Delay (ms)"
- [ ] Add Brave Search provider fields:
  - `web_search_brave_enabled`: `boolean`, default `false`, name "Brave Search — Enabled"
  - `web_search_brave_api_key`: `string`, `secret: true`, name "Brave Search — API Key"
  - `web_search_brave_delay_ms`: `number`, default `0`, min `0`, max `10000`, name "Brave Search — Delay (ms)"
- [ ] Add SerpApi provider fields:
  - `web_search_serpapi_enabled`: `boolean`, default `false`, name "SerpApi — Enabled"
  - `web_search_serpapi_api_key`: `string`, `secret: true`, name "SerpApi — API Key"
  - `web_search_serpapi_delay_ms`: `number`, default `0`, min `0`, max `10000`, name "SerpApi — Delay (ms)"

**Verify:** Settings render correctly in the generic extension settings UI (`src/settings/sections/extensions.ts`). No UI code changes needed for most fields — the existing renderer handles `boolean`, `number`, `string` (with `secret`), and `string[]` field types.

### 4.2 Add `options` support to `string[]` settings renderer

**File to modify:** `src/settings/sections/extensions.ts` (L488-536, `string[]` branch)

The current `string[]` renderer uses a free-text input for adding entries. For `web_search_provider_priority`, entries must be valid provider names.

- [ ] Add up/down reorder buttons to each `string[]` entry (before the existing "Remove" button):
  - "▲" button: swaps entry with the one above (hidden for the first entry)
  - "▼" button: swaps entry with the one below (hidden for the last entry)
  - On click: splice + re-insert, `saveFieldValue()`, `ctx.redisplay()`
- [ ] In the `string[]` branch of `renderField()`, check if `field.options` is present
- [ ] When `field.options` exists: render a dropdown (`addDropdown`) instead of a text input (`addText`) for the "Add" action, populated with `field.options` values that aren't already in the list
- [ ] When all options are already in the list: hide the Add row (dropdown + button) entirely
- [ ] When `field.options` is absent: keep current free-text behavior (backward-compatible)
- [ ] Update JSDoc on `SettingsFieldSchema.options` in `src/extensions/types.ts:69` — change from `"Enum constraint (string type only) — renders as dropdown."` to `"Constrains valid values — renders as dropdown for \`string\`, constrains Add input for \`string[]\`."`
- [ ] ~~Verify `parseSettingsSchema()`~~ — No changes needed: `parseSettingsSchema()` in `settings-schema.ts` L104-106 (within the function at L51-112) already passes `options` through for all field types (the check is type-agnostic)

### 4.3 String array renderer tests

**File to create:** `src/settings/sections/__tests__/extensions-string-array.test.ts`

- [ ] Test reorder up: swaps entry with previous, persists new order
- [ ] Test reorder down: swaps entry with next, persists new order
- [ ] Test reorder boundaries: up button hidden on first entry, down button hidden on last
- [ ] Test dropdown mode: when `field.options` present, Add row renders dropdown with unused options only
- [ ] Test dropdown exhaustion: when all options in list, Add row is hidden
- [ ] Test free-text fallback: when `field.options` absent, Add row renders text input (existing behavior preserved)

---

## Phase 5: Plugin Wiring & Scaffold Refactor

> Wires everything together. The scaffold transitions from inline DDG logic to delegating to `utils.webSearch.search()`.

### 5.1 Add singletons to main.ts

**File to modify:** `src/main.ts`

- [ ] Add imports for `SearchProviderRegistry`, `WebSearchQueue`, and all four provider classes
- [ ] Add private fields (near existing singletons at L124-173, add after `_taskLaneQueue` at L173):
  ```typescript
  private _searchProviderRegistry?: SearchProviderRegistry;
  private _webSearchQueue?: WebSearchQueue;
  ```
- [ ] Add private getter `getSearchProviderRegistry()` (lazy init):
  - Creates registry, registers all four providers (`DuckDuckGoProvider`, `TavilyProvider`, `BraveSearchProvider`, `SerpApiProvider`)
- [ ] Add public getter `getWebSearchQueue()` (lazy init):
  - Creates `WebSearchQueue` with:
    - `getSettings` closure → delegates to `this.getExtensionManager().getResolvedSettings("web_search").values`
      - **Note:** Use `getResolvedSettings()` (L466-488 of manager.ts) — NOT the spec's `getCompiledTool()` which doesn't exist on `ExtensionManager`. The existing `getResolvedSettings()` already resolves both non-secret fields (from `user_extension_settings`) and secret fields (from SecretStorage via `slugifySecretId`).
    - `this.getSearchProviderRegistry()`
    - `this.getTaskLaneQueue()`

### 5.2 Wire `utils.webSearch` in runtime-context.ts

**File to modify:** `src/extensions/runtime-context.ts`

- [ ] Add `WebSearchApiResult` import (from `src/web-search/queue.ts`)
- [ ] Add `webSearch` to `ExtensionUtils` interface (after `queue` at L106):
  ```typescript
  webSearch: {
    search: (query: string, numResults: number, timeoutMs: number, signal?: AbortSignal) => Promise<WebSearchApiResult>;
  };
  ```
- [ ] Add `webSearch` to `buildUtils()` return object (after `queue` closure at L203):
  ```typescript
  webSearch: {
    search: (query, numResults, timeoutMs, signal?) =>
      plugin.getWebSearchQueue().search(query, numResults, timeoutMs, signal),
  },
  ```

**Note:** `abortSignal` is NOT part of `buildUtils()` — it is injected per-invocation by `UserToolAdapter.execute()` (see `runtime-context.ts:114-115`). The scaffold code accesses it as `utils.abortSignal` at call time, after injection has occurred. The `webSearch.search` closure receives it as the `signal` parameter.

### 5.3 Refactor scaffold code to delegate

**File to modify:** `src/extensions/builtin-tool-scaffolds.ts` (WEB_SEARCH constant)

- [ ] Update tool description from `"Search the web using DuckDuckGo..."` to `"Search the web and return results with titles, URLs, and snippets."` (L1219)
- [ ] Replace the TypeScript code block (L1244-1383) with the simplified delegation code:
  - Keep: input validation (`query` param check)
  - Keep: `numResults` and `timeoutMs` computation from settings
  - **Replace**: all DDG-specific code (`cleanDDGUrl`, `parseDDGResults`, HTTP request, timeout race) with single call: `const searchResult = await utils.webSearch.search(query, numResults, timeoutMs, utils.abortSignal)`
  - Keep: `isDomainBlocked` filtering (reads `shared.domain_denylist`)
  - Keep: markdown output formatting
  - **Add** (new behavior): pass `utils.abortSignal` to `webSearch.search()` — the current scaffold does not use `abortSignal` at all; this is a new cancellation path
  - **Add**: check `searchResult.error` and return it as the tool error message if set
  - **Add**: log `searchResult.failures` as warnings if non-empty
  - **Add**: log `searchResult.provider` in completion message
- [ ] Remove `cleanDDGUrl()` and `parseDDGResults()` helper functions from the scaffold string
  - These now live in `src/web-search/providers/duckduckgo.ts`

**Expected reduction:** ~140 lines of scaffold TypeScript code → ~50 lines.

---

## Phase 6: Legacy Settings Cleanup

> Removes redundant settings fields from the core settings system. Safe to do because the migration at `main.ts:680-690` already copies values to `user_extension_settings["web_search"]` on first load.

### 6.1 Remove legacy settings fields

- [ ] **`src/settings/types.ts`** — Remove `web_search_timeout` (L155) and `web_search_default_num_results` (L158) from `NotorSettings` interface, including their comments (L150-158 section)
- [ ] **`src/settings/defaults.ts`** — Remove `web_search_timeout: 10` (L136) and `web_search_default_num_results: 5` (L137) from `createDefaultSettings()`, including the `// web_search` comment (L135)

### 6.2 Fix migration block for removed types

- [ ] **`src/main.ts:680-690`** — The migration block references `this.settings.web_search_timeout` and `this.settings.web_search_default_num_results`, which will fail TypeScript compilation after 6.1 removes them from `NotorSettings`. Fix by casting through the raw data:
  ```typescript
  const raw = this.settings as Record<string, unknown>;
  if (
    this.settings.user_extension_settings["web_search"] === undefined &&
    raw.web_search_timeout !== undefined
  ) {
    this.settings.user_extension_settings["web_search"] = {
      web_search_timeout: raw.web_search_timeout,
      web_search_default_num_results: raw.web_search_default_num_results,
    };
    migrated = true;
  }
  ```
- [ ] **Keep** `"web_search_timeout"` and `"web_search_default_num_results"` in the `oldFields` array (starting L763) — specifically the entries at L768-769 — that array strips legacy keys from `data.json` on disk for upgrading users, which is still needed regardless of the TS type change

### 6.3 Verify no remaining references

- [ ] Grep for `web_search_timeout` and `web_search_default_num_results` across the codebase (excluding specs/docs)
  - Should only appear in: scaffold YAML settings fence, migration block, and test files
  - Any other references → update or remove

---

## Phase 7: Unit Test Sweep & Verification

> Final validation. Ensures all components work together.

### 7.1 Run full test suite

- [ ] Run `npm test` — all existing tests must continue to pass
- [ ] Run new test files specifically:
  - `src/web-search/providers/__tests__/duckduckgo.test.ts`
  - `src/web-search/providers/__tests__/tavily.test.ts`
  - `src/web-search/providers/__tests__/brave.test.ts`
  - `src/web-search/providers/__tests__/serpapi.test.ts`
  - `src/web-search/__tests__/provider-registry.test.ts`
  - `src/web-search/__tests__/queue.test.ts`

### 7.2 Build verification

- [ ] Run `npm run build` — no TypeScript compilation errors
- [ ] Verify no circular imports between `src/web-search/`, `src/queue/`, `src/extensions/`, and `src/main.ts`

### 7.3 Manual smoke test checklist

- [ ] Load plugin in Obsidian — no console errors on startup
- [ ] Open Settings > Extensions > web_search — verify all new provider fields render:
  - Round-robin toggle, provider priority list, per-provider enabled/delay/API-key fields
- [ ] Run a basic `web_search` query with only DDG enabled — results returned correctly
- [ ] Enter a Tavily API key, enable Tavily, disable DDG — search uses Tavily
- [ ] Enable both DDG + Tavily with round-robin ON — verify both providers used (check logs)
- [ ] Disable all providers — verify descriptive error returned
- [ ] Test domain denylist filtering still works with new providers

---

## Implementation Notes

### API Key Passing Design Decision

The design spec has providers as stateless singletons registered once at plugin init. However, API keys are resolved per-call via the settings system. The `SearchProvider.search()` method needs access to the API key at call time.

**Decision:** Pass only `apiKey: string | null` and an optional `signal?: AbortSignal` as extra parameters to `search()`. The full `ProviderConfig` (`enabled`, `delayMs`, `apiKey`) is NOT passed — `enabled` is already consumed during provider chain resolution, and `delayMs` is consumed by the lane queue. Only `apiKey` and `signal` cross the boundary into the provider. Interface: `search(query, numResults, timeoutMs, apiKey: string | null, signal?: AbortSignal)`.

### Spec Discrepancy: `getCompiledTool()`

The design spec (Section 11.4) references `extensionManager.getCompiledTool("web_search")` — this method does not exist on `ExtensionManager`. Use the existing `getResolvedSettings("web_search")` (manager.ts:466-488) instead, which already resolves both persisted and secret settings. The `getSettings` closure in the `WebSearchQueue` constructor should be:

```typescript
() => this.getExtensionManager().getResolvedSettings("web_search").values
```

### File Placement

Tests use the `__tests__/` subdirectory pattern (matching `src/queue/__tests__/`), not co-located `.test.ts` files. This keeps the provider directory clean.

### DOMParser Availability

The DDG provider uses `DOMParser` which is available in Obsidian's Electron runtime (browser API). This is the same as the current scaffold — no polyfill needed. Tests will need to mock or provide a `DOMParser` (jsdom or similar via Vitest's `environment: 'jsdom'` config).
