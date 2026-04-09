# Multi-Provider Web Search with Plugin-Wide Request Queuing

**Status:** Draft — revised to align with extension scaffold architecture
**Author:** Design spike
**Date:** 2026-04-05 (revised 2026-04-09)

---

## 1. Motivation

The `web_search` tool (built-in extension scaffold in [`src/extensions/builtin-tool-scaffolds.ts:1217-1384`](../../src/extensions/builtin-tool-scaffolds.ts)) uses DuckDuckGo's HTML endpoint as its sole search backend. This works well for serial use, but breaks down under concurrent load.

**The problem:** When `use_subagent` spawns multiple sub-agents (defaults to 3 concurrent via `settings.sub_agent_concurrency_cap`, but user-configurable higher — see [`src/sub-agents/semaphore.ts`](../../src/sub-agents/semaphore.ts)), each sub-agent runs its own tool dispatch loop with a concurrency cap of 5 ([`src/chat/tool-orchestration.ts:104`](../../src/chat/tool-orchestration.ts)). In a research-heavy workflow, this can produce 6+ (or more at higher concurrency settings) simultaneous `web_search` calls — all hitting DuckDuckGo. DDG responds with HTTP 202 (throttled), and the searches fail silently or return no results.

**Two complementary solutions:**

1. **Multi-provider support** — Spread search requests across multiple web search services (Tavily, Brave Search, SerpApi) in addition to DDG. Each service has its own rate limits, so distributing load reduces the chance of hitting any single provider's ceiling.

2. **Plugin-wide request queuing** — A centralized queue that all `web_search` calls pass through, regardless of which conversation, sub-agent, or workflow triggered them. The queue enforces per-provider delays and optionally round-robins across providers to maximize aggregate throughput.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Provider abstraction | Interface + concrete classes | Mirrors the LLM provider pattern (`src/providers/`). Each search provider is a standalone class in `src/web-search/providers/`. |
| Queue location | Plugin-level singleton | Must span all conversations/sub-agents. Created in `main.ts`, exposed to scaffold via `utils.webSearch`. Same lazy-init pattern as `_mcpHub`, `_toolRegistry`. |
| Provider selection | Queue selects, not the scaffold | The scaffold calls `utils.webSearch.search()`; the queue picks the provider based on priority, availability, and round-robin state. The scaffold never knows which provider was used. |
| Tool architecture | Built-in extension scaffold | `web_search` is a scaffold in `builtin-tool-scaffolds.ts`, consistent with all tools except `use_subagent`. The scaffold is a thin shim that delegates to `utils.webSearch` for provider orchestration. Users can override by creating `notor/tools/web_search.md`. |
| Credential storage | Extension-level SecretStorage | API keys use `secret: true` on scaffold settings fields, stored via the extension settings system's `slugifySecretId("notor-ext", "web_search", field.key)` convention. No changes to `SECRET_IDS` in `src/utils/secrets.ts`. |
| Settings model | Flat extension settings fields | All configuration (provider enable/disable, API keys, delays, priority, round-robin) defined in the scaffold's YAML settings fence using supported types (`string`, `number`, `boolean`, `string[]`). Rendered by the generic extension settings UI. |
| Provider ordering UI | `string[]` add/remove (v1) | Priority ordering uses a `string[]` field. Generic renderer supports add/remove. Reordering by up/down buttons deferred to a future `reorderable` enhancement on `SettingsFieldSchema`. |
| Delay enforcement | Per-provider serialization with timed gaps | Each provider has its own independent delay lane. Within a lane, requests are FIFO-serialized with a configurable minimum gap. Across lanes, requests are concurrent. |
| Fallback behavior | Synchronous retry within same `search()` call | Failed provider → try next in priority order. No queue re-entry (avoids FIFO fairness issues). |
| Round-robin scope | Per-queue (not per-conversation) | A single `roundRobinIndex` counter shared across all callers maximizes load distribution. |
| DDG remains default | Yes, no API key required | New users get working web search out of the box. API-based providers are opt-in. |

---

## 3. Architecture Overview

Four layers sit between callers and the HTTP transport. The built-in scaffold and user-defined extensions share the same queue infrastructure via `utils.webSearch` and `utils.queue`:

```
web_search scaffold              User Extension (via utils.queue.enqueue
(builtin-tool-scaffolds.ts)       or utils.webSearch.search)
  │                                │
  │  validate input,               │  direct lane access
  │  call utils.webSearch.search() │  or full search API
  │                                │
  ▼                                │
WebSearchQueue  (src/web-search/queue.ts)
  │                                │
  │  select provider (priority /   │
  │  round-robin), handle fallback │
  │                                │
  ▼                                ▼
TaskLaneQueue  (plugin-level singleton, shared)
  │
  │  per-lane FIFO serialization + delay enforcement
  │
  ▼
SearchProvider  (interface)
  │
  │  DuckDuckGoProvider  │  TavilyProvider  │  BraveSearchProvider  │  SerpApiProvider
  │
  ▼
requestUrl()  (Obsidian HTTP transport)
```

The `web_search` scaffold remains a thin coordinator: validate input → call `utils.webSearch.search()` → filter results (domain denylist) → format output. Provider selection, round-robin, and fallback logic lives in `WebSearchQueue`. Per-lane serialization and delay enforcement lives in the generic `TaskLaneQueue`, which is also exposed to user extensions via `utils.queue` (see [Section 17](#17-extension-system-interaction)).

---

## 4. Search Provider Abstraction

### 4.1 Interface

**File:** `src/web-search/providers/provider.ts`

```typescript
import type { WebSearchResult } from "../../web-search";

/** Supported web search provider identifiers. */
export type WebSearchProviderType = "duckduckgo" | "tavily" | "brave" | "serpapi";

/** Static metadata for a search provider. */
export interface SearchProviderMeta {
  type: WebSearchProviderType;
  displayName: string;
  requiresApiKey: boolean;
  /** Recommended minimum delay between requests (ms). */
  defaultDelayMs: number;
}

/** Resolved configuration for a single provider (from extension settings). */
export interface ProviderConfig {
  enabled: boolean;
  delayMs: number;
  apiKey: string | null;
}

/** Result from a single provider search attempt. */
export interface SearchProviderResult {
  results: WebSearchResult[];
  /** True if the provider signalled rate-limiting (HTTP 429, 202, etc.). */
  rateLimited?: boolean;
  /** Human-readable error string, if any. */
  error?: string;
}

/** A web search provider implementation. */
export interface SearchProvider {
  readonly meta: SearchProviderMeta;

  /**
   * Execute a web search via this provider's API.
   *
   * @param query      - Search query string.
   * @param numResults - Maximum number of results to return.
   * @param timeoutMs  - Request timeout in milliseconds.
   */
  search(
    query: string,
    numResults: number,
    timeoutMs: number,
  ): Promise<SearchProviderResult>;

  /**
   * Whether this provider is currently usable given its resolved config.
   * Checks enabled state and API key presence (for key-requiring providers).
   * Receives already-resolved config — no direct SecretStorage access needed.
   */
  isConfigured(config: ProviderConfig): boolean;
}
```

### 4.2 Concrete Providers

All providers use Obsidian's `requestUrl()` for HTTP transport (imported directly from `obsidian`, not via the extension runtime context). This is consistent with the current scaffold's usage at [`builtin-tool-scaffolds.ts:1315`](../../src/extensions/builtin-tool-scaffolds.ts).

| File | Class | API | Auth | Default Delay | Notes |
|------|-------|-----|------|---------------|-------|
| `duckduckgo.ts` | `DuckDuckGoProvider` | POST `https://html.duckduckgo.com/html/` | None | 1500ms | Extracts existing logic from the `web_search` scaffold (`builtin-tool-scaffolds.ts:1248-1341`). `cleanDDGUrl()` and `parseDDGResults()` become internal helpers. HTML parsing via global `DOMParser`. |
| `tavily.ts` | `TavilyProvider` | POST `https://api.tavily.com/search` | Bearer token | 0ms | JSON request/response. Returns structured results (title, url, content). Free tier: 1000 searches/month. |
| `brave.ts` | `BraveSearchProvider` | GET `https://api.search.brave.com/res/v1/web/search` | `X-Subscription-Token` header | 0ms | JSON response. Free tier: 2000 queries/month. |
| `serpapi.ts` | `SerpApiProvider` | GET `https://serpapi.com/search` | `api_key` query param | 0ms | JSON response. Wraps Google results. Free tier: 100 searches/month. |

**All providers normalize output to `WebSearchResult[]`:**

```typescript
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}
```

**Rate-limit detection per provider:**

| Provider | Signal | Maps to `rateLimited: true` |
|----------|--------|-----------------------------|
| DDG | HTTP 202 or 0 parsed results from non-empty response | Yes |
| Tavily | HTTP 429 | Yes |
| Brave | HTTP 429 | Yes |
| SerpApi | HTTP 429 or JSON `error` field containing "rate" | Yes |

### 4.3 DuckDuckGo Provider — Extraction Details

The current `web_search` scaffold in [`builtin-tool-scaffolds.ts:1244-1341`](../../src/extensions/builtin-tool-scaffolds.ts) contains ~100 lines of HTTP + parsing logic in a TypeScript string template. The extraction moves this logic to a proper TypeScript module:

- `cleanDDGUrl()` (scaffold lines 1248-1260) → `duckduckgo.ts` (private helper, still exported for tests)
- `parseDDGResults()` (scaffold lines 1262-1287) → `duckduckgo.ts` (private helper, still exported for tests)
- HTTP request logic (scaffold lines 1305-1341) → `DuckDuckGoProvider.search()`
- Selector drift warning (scaffold lines 1345-1352) → `DuckDuckGoProvider.search()`

What stays in the scaffold (thin shim):
- Input validation (scaffold lines 1291-1295)
- `isDomainBlocked` filtering via `utils.isDomainBlocked()` (scaffold lines 1354-1362)
- Output formatting (scaffold lines 1368-1382)

---

## 5. Plugin-Wide Request Queue

The queue system has two layers: a generic `TaskLaneQueue` primitive (reusable by any component, including user extensions) and a web-search-specific `WebSearchQueue` that delegates to it.

### 5.1 TaskLaneQueue — Generic Lane Primitive

> **Dependency:** The full `TaskLaneQueue` design is in [`task-lane-queue-design.md`](./task-lane-queue-design.md). That spec must be implemented first. This section describes how the web search queue consumes it.

`TaskLaneQueue` is a general-purpose, per-lane serialization queue with configurable inter-completion delays. It is a shared plugin-level singleton (`src/queue/task-lane-queue.ts`) also used by MCP server dispatch and exposed to user extensions. See the standalone spec for API, internal structure, and implementation details.

**Key behaviors relevant to web search:**
- Each provider gets its own lane (keyed by provider type string: `"duckduckgo"`, `"tavily"`, etc.)
- The built-in `WebSearchQueue` passes `delayMs = 1500` for DDG tasks and `delayMs = 0` for API provider tasks on each `enqueue()` call
- Delay is per-task, not per-lane — each `enqueue()` call specifies how long to wait after the previous completion before *this* task starts
- Across lanes, tasks are fully concurrent — a DDG delay does not block Tavily
- Lanes persist for the plugin session (no self-cleaning). Idle lanes consume negligible memory

### 5.2 WebSearchQueue — Search-Specific Layer

**File:** `src/web-search/queue.ts`

The `WebSearchQueue` is a thin domain-specific layer on top of `TaskLaneQueue`. It handles provider selection, round-robin, and fallback — but delegates all per-lane serialization and delay enforcement to the shared `TaskLaneQueue`.

```typescript
export class WebSearchQueue {
  constructor(
    private readonly getSettings: () => Record<string, unknown>,
    private readonly providerRegistry: SearchProviderRegistry,
    private readonly laneQueue: TaskLaneQueue,
  ) {}

  /**
   * Execute a web search. The queue selects the provider based on
   * priority order, availability, and round-robin state.
   */
  async search(
    query: string,
    numResults: number,
    timeoutMs: number,
  ): Promise<QueuedSearchResult> {
    const providers = this.resolveProviderChain();
    const failures: Array<{ provider: WebSearchProviderType; error: string }> = [];

    for (const provider of providers) {
      try {
        const result = await this.laneQueue.enqueue(
          provider.meta.type,           // lane key = "duckduckgo", "tavily", etc.
          () => provider.search(query, numResults, timeoutMs),
          this.getProviderDelay(provider),
        );
        if (!result.rateLimited) {
          return { results: result.results, provider: provider.meta.type, failures };
        }
        failures.push({ provider: provider.meta.type, error: "Rate limited" });
      } catch (err) {
        failures.push({ provider: provider.meta.type, error: String(err) });
      }
    }

    // All providers exhausted — return aggregated error
    // ...
  }
}

export interface QueuedSearchResult {
  results: WebSearchResult[];
  /** Which provider fulfilled the request (for logging). */
  provider: WebSearchProviderType;
  /** Providers that were tried and failed, with reasons. */
  failures: Array<{ provider: WebSearchProviderType; error: string }>;
}
```

The `WebSearchQueue` no longer contains any lane management, delay enforcement, or FIFO wait queue logic — all of that lives in `TaskLaneQueue`. Lane keys are the provider type strings (`"duckduckgo"`, `"tavily"`, etc.), which are also the well-known lane names that user extensions can opt into (see [Section 17](#17-extension-system-interaction)).

### 5.3 Request Flow

```
1. WebSearchTool.execute() calls queue.search(query, numResults, timeoutMs)

2. WebSearchQueue resolves the ordered fallback chain:
   - If round-robin OFF: available providers in user's priority order
   - If round-robin ON:  rotate starting provider via roundRobinIndex,
     then continue through priority order cyclically

3. For the selected provider:
   a. Call laneQueue.enqueue(providerType, searchFn, delayMs)
   b. TaskLaneQueue serializes the request within the provider's lane
   c. When the lane is ready, searchFn executes provider.search()

4. On success: return results with provider metadata
   On failure: record the failure, try next provider in fallback chain (step 3)
   On all providers exhausted: return error with aggregated failure reasons

5. WebSearchTool receives results → isDomainBlocked filtering → markdown formatting
```

### 5.4 Round-Robin Mode

When `web_search_round_robin` is `true` and multiple providers are available, a shared `roundRobinIndex` counter (incremented on each `search()` call) determines the starting provider:

```
Available providers (priority order): [tavily, duckduckgo, brave]

Request 1: index 0 % 3 = 0 → starts with tavily,  fallback: duckduckgo → brave
Request 2: index 1 % 3 = 1 → starts with duckduckgo, fallback: brave → tavily
Request 3: index 2 % 3 = 2 → starts with brave,    fallback: tavily → duckduckgo
Request 4: index 3 % 3 = 0 → starts with tavily     (cycles back)
```

Round-robin only determines which provider to try **first**. The delay enforcement per lane is orthogonal. Under load, fast providers (0ms delay) naturally process more requests than slow ones (1500ms delay).

**When round-robin is OFF:** Every request starts with the highest-priority provider. Fallback providers are only used when the primary fails. This is simpler and appropriate when the user has a clear preferred provider.

### 5.5 Concurrent Burst Example

Settings: DDG (delay 1500ms) + Tavily (delay 0ms) enabled, round-robin ON.

```
t=0ms   SubAgent-1: web_search("A") → queue picks Tavily  (idx 0) → fires immediately
t=0ms   SubAgent-2: web_search("B") → queue picks DDG     (idx 1) → fires immediately
t=0ms   SubAgent-3: web_search("C") → queue picks Tavily  (idx 2) → fires immediately
t=1ms   SubAgent-1: web_search("D") → queue picks DDG     (idx 3) → DDG lane busy → enqueued
t=1ms   SubAgent-2: web_search("E") → queue picks Tavily  (idx 4) → fires immediately
t=1ms   SubAgent-3: web_search("F") → queue picks DDG     (idx 5) → DDG lane busy → enqueued

Result: Tavily fires 3 requests immediately.
        DDG fires 1 immediately, then 2 more spaced 1.5s apart.
        All 6 complete in ~3s vs ~9s with DDG-only sequential.
```

---

## 6. Provider Registry

**File:** `src/web-search/provider-registry.ts`

A simple map from `WebSearchProviderType` to `SearchProvider` instance. **This is distinct from the LLM `ProviderRegistry`** in `src/providers/index.ts` — it's search-specific with a much smaller scope.

```typescript
export class SearchProviderRegistry {
  private providers = new Map<WebSearchProviderType, SearchProvider>();

  register(provider: SearchProvider): void;
  get(type: WebSearchProviderType): SearchProvider | undefined;
  getAll(): SearchProvider[];

  /**
   * Providers that are both enabled AND have valid credentials.
   * Receives the resolved config (from WebSearchResolvedConfig.providers)
   * and delegates to each provider's isConfigured() with its config.
   */
  getAvailable(providerConfigs: Record<string, ProviderConfig>): SearchProvider[];

  /**
   * Available providers sorted by user's priority order.
   * @param providerConfigs - Resolved per-provider config (enabled, delayMs, apiKey)
   * @param priorityOrder   - Ordered array of provider type strings
   */
  getAvailableByPriority(
    providerConfigs: Record<string, ProviderConfig>,
    priorityOrder: string[],
  ): SearchProvider[];
}
```

`getAvailableByPriority()` filters to providers where `isConfigured(providerConfigs[type])` returns `true`, and returns them in the specified priority order. Provider config is already resolved (including API keys from SecretStorage) by the extension settings system — no direct SecretStorage access needed inside the registry or providers.

---

## 7. Updated web_search Scaffold

**File:** `src/extensions/builtin-tool-scaffolds.ts` (modified in place)

The scaffold becomes a thin coordinator that delegates to `utils.webSearch.search()`. The description changes from "Search the web using DuckDuckGo" to "Search the web and return results" since the provider is now an implementation detail.

The YAML settings fence expands to include provider configuration (see [Section 8](#8-settings-data-model)). The TypeScript code block simplifies:

```typescript
const log = utils.logger("web_search");

const query = params.query as string;

if (!query || typeof query !== "string") {
  throw new Error("Missing required parameter: query");
}

const rawNum = typeof params.num_results === "number"
  ? params.num_results
  : (settings.web_search_default_num_results as number);
const numResults = Math.max(1, Math.min(10, Math.round(rawNum)));
const timeoutMs = (settings.web_search_timeout as number) * 1000;

log.info("Web search initiated", { query, numResults, timeoutMs });

// Delegate to multi-provider queue infrastructure
const searchResult = await utils.webSearch.search(query, numResults, timeoutMs);

if (searchResult.failures.length > 0) {
  log.warn("Some providers failed before success", { failures: searchResult.failures });
}

log.debug("Search fulfilled", { provider: searchResult.provider, rawCount: searchResult.results.length });

// Filter out blocked domains
const denylist = shared.domain_denylist ?? [];
const results = searchResult.results.filter((r: any) => {
  const check = utils.isDomainBlocked(r.url, denylist);
  if (check.blocked) {
    log.debug("Filtered blocked domain", { url: r.url, pattern: check.pattern });
  }
  return !check.blocked;
});

if (results.length === 0) {
  return `No results found for query: ${query}`;
}

// Format output as numbered markdown list
const lines: string[] = [
  `Web search results for "${query}" (${results.length} result${results.length === 1 ? "" : "s"}):`,
  "",
];

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  lines.push(`${i + 1}. **[${r.title}](${r.url})**`);
  if (r.snippet) lines.push(`   ${r.snippet}`);
  lines.push("");
}

const output = lines.join("\n").trimEnd();
log.info("Web search completed", { query, resultCount: results.length, provider: searchResult.provider });
return output;
```

This reduces scaffold code from ~140 lines (inline DDG logic) to ~50 lines (delegation + formatting). The DDG HTTP logic, HTML parsing, timeout races, and selector drift warnings all move to `DuckDuckGoProvider` in `src/web-search/providers/duckduckgo.ts`.

**`utils.webSearch` API** (added to `ExtensionUtils` in [`src/extensions/runtime-context.ts`](../../src/extensions/runtime-context.ts)):

```typescript
webSearch: {
  search(query: string, numResults: number, timeoutMs: number): Promise<WebSearchApiResult>;
};
```

Where `WebSearchApiResult` is:

```typescript
interface WebSearchApiResult {
  results: Array<{ title: string; url: string; snippet: string }>;
  /** Which provider fulfilled the request (for logging). */
  provider: string;
  /** Providers that were tried and failed before success. */
  failures: Array<{ provider: string; error: string }>;
}
```

---

## 8. Settings Data Model

### 8.1 Extension Settings (Scaffold YAML Fence)

All configuration uses the extension settings system. Settings are defined in the `web_search` scaffold's YAML settings fence in [`builtin-tool-scaffolds.ts`](../../src/extensions/builtin-tool-scaffolds.ts) using flat fields of supported types (`string`, `number`, `boolean`, `string[]`). The legacy `web_search_timeout` and `web_search_default_num_results` fields in `src/settings/types.ts` and `src/settings/defaults.ts` are removed as part of this spec (see [Section 8.4](#84-backward-compatibility)).

**Existing fields (unchanged):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `web_search_timeout` | `number` | 10 | Request timeout in seconds |
| `web_search_default_num_results` | `number` | 5 | Default result count (1-10) |

**New global fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `web_search_round_robin` | `boolean` | false | Distribute requests across providers |
| `web_search_provider_priority` | `string[]` | `["duckduckgo", "tavily", "brave", "serpapi"]` | Provider priority order (index 0 = highest) |

**New per-provider fields** (repeated for `duckduckgo`, `tavily`, `brave`, `serpapi`):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `web_search_{provider}_enabled` | `boolean` | `true` for DDG, `false` for others | Whether provider is active |
| `web_search_{provider}_api_key` | `string` (`secret: true`) | — | API key (not shown for DDG) |
| `web_search_{provider}_delay_ms` | `number` | 1500 for DDG, 0 for API providers | Min ms between requests |

### 8.2 Resolved Config Type

The `WebSearchQueue` receives already-resolved flat settings from the extension settings resolver (see [Section 11.4](#114-settings-resolution)) and maps them into a typed `WebSearchResolvedConfig` internally via `buildConfig()`:

```typescript
/** Resolved web search configuration — built from flat extension settings. */
export interface WebSearchResolvedConfig {
  roundRobin: boolean;
  providerPriority: string[];
  providers: Record<string, {
    enabled: boolean;
    delayMs: number;
    apiKey: string | null;
  }>;
}
```

### 8.3 Storage and Resolution

Settings are stored in `plugin.settings.user_extension_settings["web_search"]` (non-secret fields) and Obsidian SecretStorage (API key fields with `secret: true`). The extension settings resolver ([`settings-schema.ts:130-171`](../../src/extensions/settings-schema.ts)) handles this automatically:
- Non-secret fields: read from `user_extension_settings["web_search"][field.key]`
- Secret fields: read from SecretStorage via `getSecret(app, slugifySecretId("notor-ext", "web_search", field.key))`
- Fallback to schema defaults when no persisted value exists

### 8.4 Backward Compatibility

The existing `web_search_timeout` and `web_search_default_num_results` fields were already migrated from `NotorSettings` to `user_extension_settings["web_search"]` by [`main.ts:604-614`](../../src/main.ts). Since the migration copies these values into extension settings on first load, the original fields in `NotorSettings` are now redundant. As part of this spec's implementation:

1. **Remove** `web_search_timeout` and `web_search_default_num_results` from `src/settings/types.ts` (L155-158) and `src/settings/defaults.ts` (L136-137).
2. **Remove** these fields from the `legacyKeys` array in `main.ts` (~L690-693) that references them for the migration check.
3. **Keep** the migration block at `main.ts:604-614` — it still needs to run for users upgrading from versions before the migration was added.

New provider fields get their defaults from the scaffold YAML fence automatically — no additional migration needed. DDG remains the only enabled provider by default; new users get working web search out of the box.

---

## 9. Secrets

**No changes to `src/utils/secrets.ts`.**

API keys use the extension settings system's `secret: true` field type, not well-known `SECRET_IDS` constants. When a settings field has `secret: true`, the extension settings resolver ([`settings-schema.ts:142-148`](../../src/extensions/settings-schema.ts)) reads the value from SecretStorage via `getSecret(app, slugifySecretId("notor-ext", "web_search", field.key))`.

| Settings field | Secret ID (auto-generated) |
|---------------|---------------------------|
| `web_search_tavily_api_key` | `notor-ext-web-search-web-search-tavily-api-key` |
| `web_search_brave_api_key` | `notor-ext-web-search-web-search-brave-api-key` |
| `web_search_serpapi_api_key` | `notor-ext-web-search-web-search-serpapi-api-key` |

Keys are stored and retrieved via `setSecret()` / `getSecret()` ([`src/utils/secrets.ts:44-82`](../../src/utils/secrets.ts)) and rendered in the generic extension settings UI via `SecretComponent` ([`src/settings/sections/extensions.ts:397-416`](../../src/settings/sections/extensions.ts)).

---

## 10. Settings UI

**No dedicated settings section file.** All web search settings are rendered by the generic extension settings UI in [`src/settings/sections/extensions.ts`](../../src/settings/sections/extensions.ts).

### 10.1 Rendered Layout

The extension settings renderer iterates the scaffold's YAML settings fields and renders each using the appropriate widget:

```
web_search (built-in tool)
├── Request Timeout                     [number: 10]
├── Default Number of Results           [number: 5]
├── Round-robin across providers        [toggle: off]
├── Provider priority order             [string[]: duckduckgo, tavily, brave, serpapi]
│                                        (add/remove UI; reorder by remove + re-add)
├── DuckDuckGo — Enabled                [toggle: on]
├── DuckDuckGo — Delay (ms)             [number: 1500]
├── Tavily — Enabled                    [toggle: off]
├── Tavily — API Key                    [SecretComponent: ••••••••]
├── Tavily — Delay (ms)                 [number: 0]
├── Brave Search — Enabled              [toggle: off]
├── Brave Search — API Key              [SecretComponent: ••••••••]
├── Brave Search — Delay (ms)           [number: 0]
├── SerpApi — Enabled                   [toggle: off]
├── SerpApi — API Key                   [SecretComponent: ••••••••]
└── SerpApi — Delay (ms)                [number: 0]
```

### 10.2 Provider Ordering

The `web_search_provider_priority` field is a `string[]` rendered with the generic add/remove UI ([`extensions.ts:488-536`](../../src/settings/sections/extensions.ts)). Users manage priority by adding/removing entries. Reordering requires removing and re-adding in the desired position — functional but not ideal for a list of 4 items.

**Future enhancement:** Add `reorderable?: boolean` to `SettingsFieldSchema` to enable up/down arrow buttons on `string[]` fields. This is deferred — the add/remove workflow is sufficient for the initial implementation.

### 10.3 UI Behavior Notes

- Toggling a provider off does NOT remove its API key from SecretStorage.
- API key fields are only shown for providers that require them (Tavily, Brave, SerpApi). DuckDuckGo has no API key field.
- The generic renderer shows field `name` as the label and `description` as the help text.
- Settings changes take effect immediately — the `WebSearchQueue` reads settings fresh on each `search()` call.

---

## 11. Registration and Wiring

### 11.1 Plugin Singletons

**File:** `src/main.ts`

Two lazy-initialized singletons on the `NotorPlugin` class (note: `_taskLaneQueue` and `getTaskLaneQueue()` are provided by the [TaskLaneQueue spec](./task-lane-queue-design.md) — see [Section 17.6](#176-cross-spec-coordination)):

```typescript
private _searchProviderRegistry?: SearchProviderRegistry;
private _webSearchQueue?: WebSearchQueue;
```

### 11.2 Public Getters (accessed by `buildUtils()`)

```typescript
/** Public — accessed by buildUtils() for utils.webSearch */
getWebSearchQueue(): WebSearchQueue {
  if (!this._webSearchQueue) {
    this._webSearchQueue = new WebSearchQueue(
      () => this.getResolvedWebSearchSettings(),
      this.getSearchProviderRegistry(),
      this.getTaskLaneQueue(),
    );
  }
  return this._webSearchQueue;
}
```

### 11.3 Private Getters

```typescript
private getSearchProviderRegistry(): SearchProviderRegistry {
  if (!this._searchProviderRegistry) {
    this._searchProviderRegistry = new SearchProviderRegistry();
    this._searchProviderRegistry.register(new DuckDuckGoProvider());
    this._searchProviderRegistry.register(new TavilyProvider());
    this._searchProviderRegistry.register(new BraveSearchProvider());
    this._searchProviderRegistry.register(new SerpApiProvider());
  }
  return this._searchProviderRegistry;
}
```

### 11.4 Settings Resolution

The `WebSearchQueue` receives a `getSettings` closure that returns the already-resolved extension settings for the `web_search` scaffold. This reuses the existing `resolveSettings()` infrastructure in [`settings-schema.ts:130-171`](../../src/extensions/settings-schema.ts), which already handles both non-secret fields (from `user_extension_settings`) and secret fields (from SecretStorage via `getSecret()` + `slugifySecretId()`). Settings are resolved fresh on each `search()` call — not cached at construction time.

```typescript
/**
 * Returns resolved web_search extension settings using the existing
 * settings resolution infrastructure. Secrets are resolved by
 * resolveSettings() — no manual getSecret()/slugifySecretId() calls needed.
 *
 * Note: getSecret() is synchronous today (secrets.ts:44-63, calls Obsidian's
 * sync SecretStorage API). If Obsidian changes to an async API, this method
 * and the resolveSettings() infrastructure would need to become async.
 */
private getResolvedWebSearchSettings(): Record<string, unknown> {
  const extensionManager = this.getExtensionManager();
  const scaffold = extensionManager.getCompiledTool("web_search");
  if (!scaffold?.settingsSchema) return {};

  const persisted = this.settings.user_extension_settings["web_search"] ?? {};
  const { values } = resolveSettings(
    scaffold.settingsSchema,
    "web_search",
    persisted,
    this.app,
  );
  return values;
}
```

The `WebSearchQueue` then maps the flat resolved settings into a typed `WebSearchResolvedConfig`:

```typescript
/** Resolved web search configuration — built from resolved extension settings. */
export interface WebSearchResolvedConfig {
  roundRobin: boolean;
  providerPriority: string[];
  providers: Record<string, {
    enabled: boolean;
    delayMs: number;
    apiKey: string | null;
  }>;
}

// Inside WebSearchQueue — converts flat resolved settings to typed config:
private buildConfig(settings: Record<string, unknown>): WebSearchResolvedConfig {
  return {
    roundRobin: (settings.web_search_round_robin as boolean) ?? false,
    providerPriority: (settings.web_search_provider_priority as string[]) ?? ["duckduckgo"],
    providers: {
      duckduckgo: {
        enabled: (settings.web_search_duckduckgo_enabled as boolean) ?? true,
        delayMs: (settings.web_search_duckduckgo_delay_ms as number) ?? 1500,
        apiKey: null,
      },
      tavily: {
        enabled: (settings.web_search_tavily_enabled as boolean) ?? false,
        delayMs: (settings.web_search_tavily_delay_ms as number) ?? 0,
        apiKey: (settings.web_search_tavily_api_key as string) ?? null,
      },
      brave: {
        enabled: (settings.web_search_brave_enabled as boolean) ?? false,
        delayMs: (settings.web_search_brave_delay_ms as number) ?? 0,
        apiKey: (settings.web_search_brave_api_key as string) ?? null,
      },
      serpapi: {
        enabled: (settings.web_search_serpapi_enabled as boolean) ?? false,
        delayMs: (settings.web_search_serpapi_delay_ms as number) ?? 0,
        apiKey: (settings.web_search_serpapi_api_key as string) ?? null,
      },
    },
  };
}
```

This eliminates the need for duplicated `getSecret()` + `slugifySecretId()` calls in the web search layer. The extension settings resolver handles secret resolution centrally — the `WebSearchQueue` receives already-resolved values including API keys.

### 11.5 Extension Runtime Wiring

**File:** `src/extensions/runtime-context.ts`

Add `webSearch` to `ExtensionUtils` interface and `buildUtils()`:

```typescript
// In ExtensionUtils interface (utils.queue is added by the TaskLaneQueue spec):
webSearch: {
  search: (query: string, numResults: number, timeoutMs: number) => Promise<WebSearchApiResult>;
};

// In buildUtils(plugin):
webSearch: {
  search: (query, numResults, timeoutMs) =>
    plugin.getWebSearchQueue().search(query, numResults, timeoutMs),
},
```

> **Note:** `utils.queue` is defined in [`task-lane-queue-design.md`](./task-lane-queue-design.md) Section 5.2 and must be implemented as part of that spec. Both `utils.queue` and `utils.webSearch` are available to all extensions — including user overrides of `web_search`. See [Section 17.6](#176-cross-spec-coordination) for implementation ordering.

### 11.6 No Registration Changes

The `web_search` tool continues to be registered via the `ExtensionManager` scaffold injection flow ([`manager.ts:215-242`](../../src/extensions/manager.ts)). No `new WebSearchTool(...)` call in `main.ts`. The queue singleton is shared by all invocations — including those from sub-agent dispatch loops — because `buildUtils(plugin)` always returns the same plugin's queue.

---

## 12. New File Structure

```
src/queue/
  task-lane-queue.ts           Generic TaskLaneQueue class (no web search dependency)
  task-lane-queue.test.ts      Unit tests for the queue primitive

src/web-search/
  providers/
    provider.ts              SearchProvider interface, types, SearchProviderMeta
    duckduckgo.ts            DuckDuckGoProvider (extracted from scaffold code)
    duckduckgo.test.ts       DDG parsing and HTTP tests
    tavily.ts                TavilyProvider
    tavily.test.ts           Tavily provider tests
    brave.ts                 BraveSearchProvider
    brave.test.ts            Brave provider tests
    serpapi.ts               SerpApiProvider
    serpapi.test.ts          SerpApi provider tests
  provider-registry.ts       SearchProviderRegistry
  provider-registry.test.ts  Registry tests
  queue.ts                   WebSearchQueue + WebSearchResolvedConfig + WebSearchApiResult
  queue.test.ts              Queue unit tests (fallback, round-robin, lane delegation)
```

Note: `src/web-search/` rather than `src/tools/web-search/` — these are provider infrastructure modules consumed by the scaffold via `utils.webSearch`, not tool implementations. The scaffold itself stays in `src/extensions/builtin-tool-scaffolds.ts`.

---

## 13. Edge Cases and Risks

### 13.1 All Providers Fail

If every provider in the fallback chain fails (timeouts, rate limits, errors), the queue returns an aggregated error:

```
All search providers failed:
- Tavily: HTTP 429 rate limited
- DuckDuckGo: HTTP 202 rate limited
- Brave Search: Request timed out after 10 seconds
```

The error message lists each provider and its failure reason so the user can diagnose the issue.

### 13.2 No Providers Configured

If all providers are disabled (or API-requiring providers lack keys while DDG is disabled), `getAvailableByPriority()` returns empty. The queue returns immediately:

```
No web search providers are configured and enabled.
Configure at least one in Settings > Tool configuration > Web search.
```

### 13.3 API Key Revocation / Expiry

A provider that was configured may start failing if its API key is revoked or its free tier is exhausted. The fallback mechanism handles this gracefully — the provider fails, the next one is tried. No special handling needed beyond logging the error.

### 13.4 Delay Set to 0 for DDG

Users can set DDG's delay to 0ms, effectively telling the plugin to not self-throttle. This risks DDG throttling (202s), but the fallback mechanism mitigates: if DDG returns 202, the next provider is tried. Power users who want maximum speed from DDG accept this tradeoff.

### 13.5 Queue Starvation Under Heavy Load

If DDG has a 1500ms delay and 10 requests are queued in its lane, the last request waits ~15 seconds. Mitigations:
- Round-robin distributes load across providers, keeping per-lane depth shallow.
- The per-request timeout (default 10s) ensures no single request blocks forever. If a queued request's total wait + execution time exceeds the timeout, it fails and falls back to the next provider.

### 13.6 Settings Changes at Runtime

If the user reorders providers or toggles enabled state while searches are in-flight, the queue reads `settings.web_search_providers` on each `search()` call (not cached at construction time). In-flight requests in provider lanes complete normally; only new requests see the updated configuration. This is the same pattern used throughout Notor — settings are read live from the shared `settings` object.

### 13.7 Concurrent Lane Access

Multiple concurrent callers may enter the same provider lane simultaneously. The lane's FIFO wait queue ensures correctness: only one request executes at a time per lane, with each task's specified delay enforced before it starts. No external locking needed — JavaScript's single-threaded event loop guarantees the queue operations are atomic.

### 13.8 Extension Override Disables WebSearchQueue

When a user extension overrides `web_search` (by creating `notor/tools/web_search.md` in the vault), all LLM-initiated web searches bypass the `WebSearchQueue` and its provider selection/fallback logic. Sub-agent burst protection is lost for the built-in flow.

**Mitigation:** The `ExtensionManager` already detects and reports built-in overrides via a Notice ([`manager.ts:291-297`](../../src/extensions/manager.ts) (detection), [`L333`](../../src/extensions/manager.ts) (Notice)). The user's extension has access to both:
- `utils.webSearch.search()` — delegates to the full multi-provider queue infrastructure, getting the same provider selection, fallback, and rate limiting as the built-in scaffold.
- `utils.queue.enqueue("duckduckgo", ...)` — opts into per-lane rate limiting directly, sharing the same lane as the built-in tool would use.

This is documented but not enforced — users who override `web_search` accept responsibility for rate limiting. The `utils.webSearch` API gives them the tools to do it correctly with zero effort.

### 13.9 Shared Lane Contention Between Extensions and Built-in

An extension and the built-in web search tool sharing the same lane (e.g., both calling `enqueue("duckduckgo", ...)`) are properly serialized — the `TaskLaneQueue` enforces FIFO ordering. Each caller controls its own delay: the built-in tool passes `delayMs=1500` to respect DDG's rate limits, while an extension might pass a different value. An extension creating heavy load on the `"duckduckgo"` lane will slow down built-in web search results (and vice versa).

This is an accepted tradeoff and is in fact the desired behavior — the whole point of shared lanes is serializing requests to the same resource. If an extension needs isolated throughput to DDG, it can use a different lane name (e.g., `"my-ext:duckduckgo"`), accepting that DDG may throttle if both lanes fire concurrently.

### 13.10 Lane Lifecycle

Lanes in `TaskLaneQueue` are in-memory only — they persist for the plugin session and reset on plugin restart. This is explicitly desired (no persistent state needed). Idle lanes consume negligible memory (~100 bytes each). On plugin unload, `TaskLaneQueue.destroy()` rejects all pending waiters and marks the queue as destroyed (see [`task-lane-queue-design.md`](./task-lane-queue-design.md) Section 6.2).

---

## 14. Open Questions

1. **Should per-provider delay apply before the first request or only between consecutive requests?**
   Current design: delay only between consecutive requests (first request fires immediately). This seems right for API providers. For DDG, the first request in a burst should also fire immediately.

2. **Should the queue track provider health across requests?**
   A provider that has failed 3 times in a row could be temporarily deprioritized (circuit breaker). This adds complexity and can be deferred — the per-request fallback mechanism already handles transient failures.

3. **Should the fallback chain skip a provider whose lane has a long queue?**
   If DDG's lane has 5 pending requests, it might be faster to go to Tavily even if DDG is higher priority. This is an optimization that can be measured and added later.

4. **Should round-robin state persist across plugin restarts?**
   Current design: `roundRobinIndex` is in-memory only, resets to 0 on plugin load. This is fine — the index is a throughput optimization, not a correctness requirement.

5. **Should the tool description mention that multiple providers may be used?**
   Current design says no — the provider is an implementation detail. But sub-agents might benefit from knowing that search is more reliable when multiple providers are configured. Leaning toward keeping it hidden; the LLM doesn't need to change its behavior based on provider count.

6. **Should we expose per-provider usage statistics (request count, error rate) in settings?**
   Useful for users tuning their provider configuration. Could be a simple counter display in the settings UI. Deferred to a follow-up.

7. **Should `TaskLaneQueue` lanes support configurable concurrency?**
   Current design is strictly serial per lane (concurrency = 1). A future enhancement could allow `enqueue(lane, fn, { delayMs, concurrency: 3 })` for lanes where parallel requests are safe but a rate cap is still needed. Not needed for the initial implementation — API rate limiting is the primary concern, and serial execution is the safest approach. The internal structure could support this later without changing the extension-facing API.

8. **Should well-known lane names be documented for extension authors?**
   The built-in web search providers use lane names matching their type strings (`"duckduckgo"`, `"tavily"`, `"brave"`, `"serpapi"`). Documenting these lets extension authors opt into shared rate limiting. Leaning toward yes — include a table of well-known lanes in the extension authoring guide (see Section 17.2).

---

## 15. Files to Create / Modify

### Files to Create

| File | Purpose |
|------|---------|
| `src/queue/task-lane-queue.ts` | **Dependency** — `TaskLaneQueue` class. See [`task-lane-queue-design.md`](./task-lane-queue-design.md). Must be implemented first. |
| `src/queue/task-lane-queue.test.ts` | **Dependency** — TaskLaneQueue unit tests. See [`task-lane-queue-design.md`](./task-lane-queue-design.md). |
| `src/web-search/providers/provider.ts` | **Create** — `SearchProvider` interface, `SearchProviderMeta`, `SearchProviderResult`, `WebSearchProviderType` |
| `src/web-search/providers/duckduckgo.ts` | **Create** — `DuckDuckGoProvider` (extracted from scaffold code in `builtin-tool-scaffolds.ts:1248-1341`) |
| `src/web-search/providers/tavily.ts` | **Create** — `TavilyProvider` |
| `src/web-search/providers/brave.ts` | **Create** — `BraveSearchProvider` |
| `src/web-search/providers/serpapi.ts` | **Create** — `SerpApiProvider` |
| `src/web-search/provider-registry.ts` | **Create** — `SearchProviderRegistry` |
| `src/web-search/queue.ts` | **Create** — `WebSearchQueue`, `WebSearchResolvedConfig`, `WebSearchApiResult` |
| `src/web-search/providers/duckduckgo.test.ts` | **Create** — DDG parsing tests (`cleanDDGUrl`, `parseDDGResults`, HTTP error handling, rate-limit detection) |
| `src/web-search/providers/tavily.test.ts` | **Create** — Tavily provider tests |
| `src/web-search/providers/brave.test.ts` | **Create** — Brave provider tests |
| `src/web-search/providers/serpapi.test.ts` | **Create** — SerpApi provider tests |
| `src/web-search/provider-registry.test.ts` | **Create** — Registry priority, filtering, availability tests |
| `src/web-search/queue.test.ts` | **Create** — Queue fallback, round-robin, lane delegation, all-fail aggregation tests |

### Files to Modify

| File | Change |
|------|--------|
| `src/extensions/builtin-tool-scaffolds.ts` | **Modify** — Replace `WEB_SEARCH` scaffold: expand YAML settings fence with provider fields, simplify TypeScript code to delegate to `utils.webSearch.search()` |
| `src/extensions/runtime-context.ts` | **Modify** — Add `webSearch` to `ExtensionUtils` interface and `buildUtils()`. Note: `queue` is added by the TaskLaneQueue spec — see [Section 17.6](#176-cross-spec-coordination). |
| `src/main.ts` | **Modify** — Add `_searchProviderRegistry`, `_webSearchQueue` lazy singletons with getters. Note: `_taskLaneQueue` and `getTaskLaneQueue()` are added by the TaskLaneQueue spec — see [Section 17.6](#176-cross-spec-coordination). |
| `src/settings/types.ts` | **Modify** — Remove legacy `web_search_timeout` and `web_search_default_num_results` fields from `NotorSettings` (see [Section 8.4](#84-backward-compatibility)) |
| `src/settings/defaults.ts` | **Modify** — Remove legacy `web_search_timeout` and `web_search_default_num_results` defaults from `DEFAULT_SETTINGS` (see [Section 8.4](#84-backward-compatibility)) |

### Files NOT Modified (correcting earlier version of this spec)

| File | Why |
|------|-----|
| `src/tools/web-search.ts` | Does not exist. Tool is a scaffold in `builtin-tool-scaffolds.ts`. |
| `src/settings/sections/web-search.ts` | Does not exist, not needed. Generic extension settings UI renders all fields. |
| `src/utils/secrets.ts` | No changes to `SECRET_IDS`. API keys use extension-level SecretStorage via `secret: true`. |

---

## 16. Verification Plan

### Unit Tests

| Component | Test File | What it verifies |
|-----------|-----------|-----------------|
| `TaskLaneQueue` | `src/queue/task-lane-queue.test.ts` | See [`task-lane-queue-design.md`](./task-lane-queue-design.md) Section 8. |
| `DuckDuckGoProvider` | `src/web-search/providers/duckduckgo.test.ts` | `cleanDDGUrl` parsing, `parseDDGResults` DOM parsing, HTTP error handling, rate-limit detection (202 → `rateLimited: true`), selector drift warning. |
| `TavilyProvider` | `src/web-search/providers/tavily.test.ts` | JSON response parsing. Auth header presence. Rate-limit detection (429). Timeout handling. |
| `BraveSearchProvider` | `src/web-search/providers/brave.test.ts` | JSON response parsing. `X-Subscription-Token` header. Rate-limit detection. |
| `SerpApiProvider` | `src/web-search/providers/serpapi.test.ts` | JSON response parsing. `api_key` query param. Rate-limit detection. |
| `SearchProviderRegistry` | `src/web-search/provider-registry.test.ts` | `getAvailableByPriority()` respects enabled state, API key presence, and priority order from `WebSearchResolvedConfig`. |
| `WebSearchQueue` | `src/web-search/queue.test.ts` | Delegates to `TaskLaneQueue` with correct lane keys. Round-robin: 3 providers, 6 requests, verify distribution. Fallback: first provider fails → second provider used. All fail → aggregated error. No available providers → immediate descriptive error. |

### Integration / E2E Tests

1. **Single provider, no queue contention** — One `web_search` call with only DDG enabled. Verify results returned, domain denylist applied, output formatted correctly. (Extends existing E2E coverage in `e2e/scripts/web-search-test.ts`.)
2. **Multi-provider fallback** — DDG disabled, Tavily enabled with valid key. Verify Tavily is used.
3. **Round-robin distribution** — DDG + Tavily enabled, round-robin ON. Fire 4 searches. Verify both providers receive requests (check logs or mock both providers).
4. **Concurrent burst from sub-agents** — 3 sub-agents each fire 2 `web_search` calls. Verify all 6 complete without DDG 202 errors (with round-robin + Tavily as second provider).
5. **Settings change mid-session** — Disable a provider while searches are active. Verify in-flight requests complete, new requests use remaining providers.
6. **Delay enforcement** — DDG with 1500ms delay. Fire 3 DDG-only requests. Verify timestamps are spaced ≥1500ms apart.

### Extension Integration Tests

7. **Extension `utils.queue.enqueue()`** — A user tool calling `utils.queue.enqueue("test-lane", fn, 100)` works end-to-end. Verify task executes and returns result.
8. **Extension `utils.webSearch.search()`** — A user tool calling `utils.webSearch.search(query, 5, 10000)` gets multi-provider results with fallback.
9. **Shared lane serialization** — Two extensions sharing a lane name are properly serialized (second task waits for first + delay).
10. **Extension and built-in sharing a lane** — A user extension calling `utils.queue.enqueue("duckduckgo", fn, 1500)` is serialized with the built-in web search scaffold's DDG requests.

### Manual Testing

- Verify extension settings UI renders all provider fields (toggle, secret, number) under the `web_search` tool in Settings > Extensions.
- Verify API key entry via `SecretComponent` persists across plugin reload.
- Verify disabling a provider (toggle off) does not clear its API key.
- Verify `web_search_provider_priority` `string[]` field allows adding/removing providers.
- Verify the scaffold's tool description no longer mentions DuckDuckGo specifically.

---

## 17. Extension System Interaction

The user-defined extensions system ([Phase 5](../../specs/05-user-tools/plan.md)) allows users to write custom tools and automations. This section describes how extensions interact with the web search queue infrastructure.

### 17.1 `utils.queue` API

The generic `TaskLaneQueue` is exposed to user extensions via `utils.queue` in the extension runtime context ([`src/extensions/runtime-context.ts`](../../src/extensions/runtime-context.ts)). Extensions use `utils.queue.enqueue(lane, fn, delayMs)` for any rate-limited async work — web search, API calls, translations, etc.

```typescript
// Extension-facing API (added to ExtensionUtils):
utils.queue.enqueue(lane: string, fn: () => Promise<T>, delayMs?: number): Promise<T>
utils.queue.pending(lane: string): number
```

### 17.1a `utils.webSearch` API

The multi-provider web search infrastructure is also exposed via `utils.webSearch`:

```typescript
utils.webSearch.search(query: string, numResults: number, timeoutMs: number): Promise<WebSearchApiResult>
```

This gives extensions access to the full provider selection, fallback, round-robin, and rate-limiting infrastructure without needing to understand the queue system. The built-in `web_search` scaffold uses this API internally.

**Example — extension using multi-provider search:**

```typescript
const result = await utils.webSearch.search(params.query, 5, 10000);
// result.results: Array<{ title, url, snippet }>
// result.provider: which provider fulfilled the request
// result.failures: providers that failed before success
```

**Example — rate-limited translation tool:**

```typescript
const translated = await utils.queue.enqueue("deepl-api", async () => {
  const resp = await obsidian.requestUrl({
    url: "https://api-free.deepl.com/v2/translate",
    method: "POST",
    headers: { "Authorization": `DeepL-Auth-Key ${settings.api_key}` },
    body: JSON.stringify({ text: [params.text], target_lang: params.lang }),
  });
  return JSON.parse(resp.text).translations[0].text;
}, 100);  // 100ms between requests
return translated;
```

**Example — extension sharing the built-in DDG lane:**

```typescript
const html = await utils.queue.enqueue("duckduckgo", async () => {
  const resp = await obsidian.requestUrl({
    url: "https://html.duckduckgo.com/html/",
    method: "POST",
    body: `q=${encodeURIComponent(params.query)}`,
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  return resp.text;
}, 1500);
// Parse html...
```

This call shares the built-in scaffold's DDG lane, so the extension's requests are properly interleaved and rate-limited alongside the built-in web search scaffold's requests.

### 17.2 Well-Known Lane Names

The full lane naming convention is defined in [`task-lane-queue-design.md`](./task-lane-queue-design.md) Section 4. The web-search-specific lanes are:

| Lane Key | Typical `delayMs` | Used By |
|----------|-------------------|---------|
| `"duckduckgo"` | 1500ms | Built-in `web_search` tool |
| `"tavily"` | 0ms | Built-in `web_search` (when Tavily is configured) |
| `"brave"` | 0ms | Built-in `web_search` (when Brave is configured) |
| `"serpapi"` | 0ms | Built-in `web_search` (when SerpApi is configured) |
| `"mcp:{serverName}"` | 0ms | MCP server dispatch (see [`thread-safe-streaming-multi-panel-design.md`](./thread-safe-streaming-multi-panel-design.md) Phase 4) |

**Lane scoping:** Lanes are global (not namespaced per-extension). This is intentional — two extensions hitting the same API should share rate limiting. Extensions wanting isolation can prefix their lane name (e.g., `"my-ext:duckduckgo"`), accepting that the API may throttle if both lanes fire concurrently.

**Per-task delay:** Each `enqueue()` call specifies its own `delayMs` — the minimum time to wait after the previous task's completion before this task starts. The built-in web search passes `delayMs=1500` for DDG tasks on every call. Extensions sharing the lane can use a different delay appropriate for their use case. See [`task-lane-queue-design.md`](./task-lane-queue-design.md) Section 6.3 for details.

### 17.3 User Tool Override of `web_search`

A user extension file at `notor/tools/web_search.md` replaces the built-in scaffold entirely via `ExtensionManager`'s vault-file-wins semantics ([`manager.ts:218`](../../src/extensions/manager.ts)). When this happens:

- The user's implementation does **not** automatically use `WebSearchQueue` or its provider selection/fallback logic.
- The queue's per-provider rate limiting is bypassed for all LLM-initiated `web_search` calls.
- The `ExtensionManager` already detects and reports built-in overrides via a Notice ([`manager.ts:291-297`](../../src/extensions/manager.ts) (detection), [`L333`](../../src/extensions/manager.ts) (Notice)).
- The user's extension **can** opt into the full multi-provider infrastructure by calling `utils.webSearch.search()` — getting the same provider selection, fallback, and rate limiting as the built-in scaffold.
- Alternatively, the user can opt into per-lane rate limiting only by calling `utils.queue.enqueue("duckduckgo", ...)`, sharing the same lane as the built-in scaffold would use.

This is an accepted tradeoff: users who override `web_search` take responsibility for rate limiting. The `utils.webSearch` and `utils.queue` APIs give them the tools to do it correctly.

### 17.4 Extension-Defined Search Providers (Deferred)

User-defined search providers (e.g., a Kagi or Perplexity extension registering itself in `SearchProviderRegistry`) are **out of scope**. The `SearchProviderRegistry` is not exposed in the extension context. Reasons:

- Exposing it would require extending `ExtensionUtils` with a `registerSearchProvider()` function, creating a lifecycle management problem (unregister on extension reload).
- The `utils.queue` API covers the common case. If a user wants to use an unsupported search provider, they write a custom tool that calls the API via `obsidian.requestUrl` with `utils.queue.enqueue()` for rate limiting.
- A user tool named `web_search` that delegates to a custom provider effectively replaces the built-in search entirely — this is already supported via the override mechanism (Section 17.3).

### 17.5 Unqueued `requestUrl` Bypass

Extensions calling `obsidian.requestUrl` directly (without `utils.queue.enqueue()`) bypass all rate limiting. This is an accepted limitation:

- Restricting `requestUrl` would break extensions that need HTTP access for non-search purposes (API calls, webhooks, etc.).
- The queue's primary purpose is protecting the built-in `web_search` tool from concurrent sub-agent bursts. Extensions making their own HTTP calls are a niche case.
- `utils.queue` is the carrot — it provides per-lane serialization with zero effort. Extensions that want rate limiting should use it.

### 17.6 Cross-Spec Coordination

This spec depends on [`task-lane-queue-design.md`](./task-lane-queue-design.md) (TLQ) and shares infrastructure with [`thread-safe-streaming-multi-panel-design.md`](./thread-safe-streaming-multi-panel-design.md) (TSS). The following coordination rules apply:

**Implementation order:** TLQ must land first — it provides `src/queue/task-lane-queue.ts`, the `_taskLaneQueue` singleton + `getTaskLaneQueue()` getter in `main.ts`, and `utils.queue` on `ExtensionUtils` in `runtime-context.ts`. This spec builds on top of those additions.

**Shared file changes in `main.ts`:**
- `_taskLaneQueue` field and `getTaskLaneQueue()` getter — provided by TLQ spec, **not** re-added by this spec
- `_searchProviderRegistry`, `_webSearchQueue`, and their getters — added by this spec
- `this._taskLaneQueue?.destroy()` in `onunload()` — provided by TLQ spec. When TSS is also implemented, `orchestrator.destroy()` must run before `taskLaneQueue.destroy()` (see TSS Step 1h)

**Shared file changes in `runtime-context.ts`:**
- `utils.queue` (enqueue, pending) on `ExtensionUtils` — provided by TLQ spec, **not** re-added by this spec
- `utils.webSearch` (search) on `ExtensionUtils` — added by this spec
- Both additions modify the `buildUtils()` function — merge coherently in a single `ExtensionUtils` interface
