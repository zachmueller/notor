# Multi-Provider Web Search with Plugin-Wide Request Queuing

**Status:** Draft
**Author:** Design spike
**Date:** 2026-04-05

---

## 1. Motivation

The `web_search` tool ([`src/tools/web-search.ts`](../../src/tools/web-search.ts)) uses DuckDuckGo's HTML endpoint as its sole search backend. This works well for serial use, but breaks down under concurrent load.

**The problem:** When `use_subagent` spawns multiple sub-agents (up to 3 concurrent, per [`src/sub-agents/semaphore.ts`](../../src/sub-agents/semaphore.ts)), each sub-agent runs its own tool dispatch loop with a concurrency cap of 5 ([`src/chat/tool-orchestration.ts:104`](../../src/chat/tool-orchestration.ts)). In a research-heavy workflow, this can produce 6+ simultaneous `web_search` calls — all hitting DuckDuckGo. DDG responds with HTTP 202 (throttled), and the searches fail silently or return no results.

**Two complementary solutions:**

1. **Multi-provider support** — Spread search requests across multiple web search services (Tavily, Brave Search, SerpApi) in addition to DDG. Each service has its own rate limits, so distributing load reduces the chance of hitting any single provider's ceiling.

2. **Plugin-wide request queuing** — A centralized queue that all `web_search` calls pass through, regardless of which conversation, sub-agent, or workflow triggered them. The queue enforces per-provider delays and optionally round-robins across providers to maximize aggregate throughput.

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Provider abstraction | Interface + concrete classes | Mirrors the LLM provider pattern (`src/providers/`). Each search provider is a standalone class. |
| Queue location | Plugin-level singleton | Must span all conversations/sub-agents. Created in `main.ts`, injected into `WebSearchTool`. Same pattern as `_mcpHub`, `_toolRegistry`. |
| Provider selection | Queue selects, not the tool | `WebSearchTool` calls the queue; the queue picks the provider based on priority, availability, and round-robin state. The tool never knows which provider was used. |
| Credential storage | Obsidian SecretStorage | Same pattern as existing API keys (`src/utils/secrets.ts`). API key IDs follow `notor-{provider}-{credential-type}` convention. |
| Provider ordering UI | Up/down buttons, not drag-and-drop | Matches the existing hooks reordering pattern in [`src/settings/sections/hooks.ts`](../../src/settings/sections/hooks.ts). Simpler to implement; drag-and-drop can be added later. |
| Delay enforcement | Per-provider serialization with timed gaps | Each provider has its own independent delay lane. Within a lane, requests are FIFO-serialized with a configurable minimum gap. Across lanes, requests are concurrent. |
| Fallback behavior | Synchronous retry within same `search()` call | Failed provider → try next in priority order. No queue re-entry (avoids FIFO fairness issues). |
| Round-robin scope | Per-queue (not per-conversation) | A single `roundRobinIndex` counter shared across all callers maximizes load distribution. |
| DDG remains default | Yes, no API key required | New users get working web search out of the box. API-based providers are opt-in. |

---

## 3. Architecture Overview

Four layers sit between callers and the HTTP transport. Both the built-in `WebSearchTool` and user-defined extensions share the same queue infrastructure:

```
WebSearchTool.execute()          User Extension (via utils.queue.enqueue)
  │                                │
  │  validate input, call queue    │  direct lane access
  │                                │
  ▼                                │
WebSearchQueue                     │
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
SearchProvider  (interface)      / requestUrl()  (Obsidian HTTP transport)
  │
  │  DuckDuckGoProvider  │  TavilyProvider  │  BraveSearchProvider  │  SerpApiProvider
  │
  ▼
requestUrl()  (Obsidian HTTP transport)
```

`WebSearchTool` remains a thin coordinator: validate input → call queue → filter results (domain denylist) → format output. Provider selection, round-robin, and fallback logic lives in `WebSearchQueue`. Per-lane serialization and delay enforcement lives in the generic `TaskLaneQueue`, which is also exposed to user extensions via `utils.queue` (see [Section 17](#17-extension-system-interaction)).

---

## 4. Search Provider Abstraction

### 4.1 Interface

**File:** `src/tools/web-search/providers/provider.ts`

```typescript
import type { App } from "obsidian";
import type { NotorSettings } from "../../../settings";
import type { WebSearchResult } from "../../web-search";

/** Supported web search provider identifiers. */
export type WebSearchProviderType = "duckduckgo" | "tavily" | "brave" | "serpapi";

/** Static metadata for a search provider. */
export interface SearchProviderMeta {
  type: WebSearchProviderType;
  displayName: string;
  requiresApiKey: boolean;
  /** Secret ID in Obsidian's SecretStorage (null for DDG). */
  secretId: string | null;
  /** Recommended minimum delay between requests (ms). */
  defaultDelayMs: number;
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
   * Whether this provider is currently usable: enabled in settings AND
   * has a valid API key (for key-requiring providers).
   */
  isConfigured(app: App, settings: NotorSettings): boolean;
}
```

### 4.2 Concrete Providers

All providers use Obsidian's `requestUrl()` for HTTP transport, consistent with [`src/tools/fetch-webpage.ts:332-387`](../../src/tools/fetch-webpage.ts) and the current [`src/tools/web-search.ts:193-209`](../../src/tools/web-search.ts).

| File | Class | API | Auth | Default Delay | Notes |
|------|-------|-----|------|---------------|-------|
| `duckduckgo.ts` | `DuckDuckGoProvider` | POST `https://html.duckduckgo.com/html/` | None | 1500ms | Extracts existing logic from `web-search.ts`. `cleanDDGUrl()` and `parseDDGResults()` become internal helpers. HTML parsing via global `DOMParser`. |
| `tavily.ts` | `TavilyProvider` | POST `https://api.tavily.com/search` | Bearer token | 0ms | JSON request/response. Returns structured results (title, url, content). Free tier: 1000 searches/month. |
| `brave.ts` | `BraveSearchProvider` | GET `https://api.search.brave.com/res/v1/web/search` | `X-Subscription-Token` header | 0ms | JSON response. Free tier: 2000 queries/month. |
| `serpapi.ts` | `SerpApiProvider` | GET `https://serpapi.com/search` | `api_key` query param | 0ms | JSON response. Wraps Google results. Free tier: 100 searches/month. |

**All providers normalize output to `WebSearchResult[]`** (the existing type at [`src/tools/web-search.ts:27-31`](../../src/tools/web-search.ts)):

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

The current `web-search.ts` contains ~200 lines of HTTP + parsing logic. The extraction moves:

- `cleanDDGUrl()` (lines 47-62) → `duckduckgo.ts` (private helper, still exported for tests)
- `parseDDGResults()` (lines 78-106) → `duckduckgo.ts` (private helper, still exported for tests)
- HTTP request logic (lines 180-234) → `DuckDuckGoProvider.search()`
- Selector drift warning (lines 244-250) → `DuckDuckGoProvider.search()`

What stays in `web-search.ts`:
- Input validation (lines 152-162)
- `isDomainBlocked` filtering (lines 253-262)
- Output formatting (lines 276-301)

---

## 5. Plugin-Wide Request Queue

The queue system has two layers: a generic `TaskLaneQueue` primitive (reusable by any component, including user extensions) and a web-search-specific `WebSearchQueue` that delegates to it.

### 5.1 TaskLaneQueue — Generic Lane Primitive

**File:** `src/queue/task-lane-queue.ts`

A general-purpose, per-lane serialization queue with configurable inter-completion delays. Has no knowledge of web search, providers, or extensions — it is a pure concurrency primitive.

```typescript
export class TaskLaneQueue {
  private lanes = new Map<string, Lane>();

  /**
   * Enqueue an async task on the named lane. The task executes when the
   * lane is available (previous task completed + delay elapsed).
   *
   * @param laneKey - Lane identifier (e.g., "duckduckgo", "deepl-api")
   * @param fn      - Async function to execute when the lane is ready
   * @param delayMs - Minimum ms between consecutive completions on this lane.
   *                  Only used when the lane is first created (first-writer-wins).
   *                  Default: 0 (no delay, but still serialized).
   */
  async enqueue<T>(laneKey: string, fn: () => Promise<T>, delayMs = 0): Promise<T>;

  /** Number of tasks waiting in a lane's queue. 0 for non-existent lanes. */
  pending(laneKey: string): number;

  /** Remove a lane (used for cleanup/testing). */
  removeLane(laneKey: string): void;
}

interface Lane {
  /** Minimum delay between consecutive task completions (ms). */
  delayMs: number;
  /** Timestamp (ms) of the last completed task in this lane. */
  lastCompletionTime: number;
  /** FIFO queue of pending tasks awaiting this lane's delay window. */
  waitQueue: Array<{ resolve: () => void }>;
  /** Whether a drain loop is currently running for this lane. */
  draining: boolean;
}
```

**Delay enforcement within a lane:**

1. Caller enters the lane via `enqueue(laneKey, fn, delayMs)`.
2. If `Date.now() - lane.lastCompletionTime >= delayMs`, the task executes immediately.
3. Otherwise, the caller is enqueued and a Promise resolves after the remaining delay.
4. After the task completes (success or failure), `lane.lastCompletionTime` is updated and the next waiter (if any) is scheduled.
5. The return value of `fn` is returned to the caller. If `fn` throws, the error propagates to the caller and the lane is still released for the next waiter.

This is similar in spirit to the `Semaphore` in [`src/sub-agents/semaphore.ts`](../../src/sub-agents/semaphore.ts) but with a timed inter-release gap rather than a simple concurrency cap.

**Across lanes, tasks are fully concurrent.** A DDG lane task waiting through its 1500ms delay does not block a Tavily lane task from firing immediately.

**First-writer-wins for delay configuration:** The `delayMs` is set when a lane is first created and cannot be changed by subsequent callers. This prevents user extensions from inadvertently (or intentionally) lowering the delay on shared lanes. The `delayMs` parameter on subsequent `enqueue` calls to an existing lane is silently ignored.

**Why `enqueue(lane, fn, delayMs)` over `acquire/release`:** The `fn` callback pattern eliminates the risk of forgetting `release()` in error paths. The queue automatically updates `lastCompletionTime` after `fn` completes or throws. This is a better fit for extension authors writing code in Markdown fences.

### 5.2 WebSearchQueue — Search-Specific Layer

**File:** `src/tools/web-search/queue.ts`

The `WebSearchQueue` is a thin domain-specific layer on top of `TaskLaneQueue`. It handles provider selection, round-robin, and fallback — but delegates all per-lane serialization and delay enforcement to the shared `TaskLaneQueue`.

```typescript
export class WebSearchQueue {
  constructor(
    private readonly app: App,
    private readonly settings: NotorSettings,
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

**File:** `src/tools/web-search/provider-registry.ts`

A simple map from `WebSearchProviderType` to `SearchProvider` instance. **This is distinct from the LLM `ProviderRegistry`** in `src/providers/index.ts` — it's search-specific with a much smaller scope.

```typescript
export class SearchProviderRegistry {
  private providers = new Map<WebSearchProviderType, SearchProvider>();

  register(provider: SearchProvider): void;
  get(type: WebSearchProviderType): SearchProvider | undefined;
  getAll(): SearchProvider[];

  /** Providers that are both enabled in settings AND have valid credentials. */
  getAvailable(app: App, settings: NotorSettings): SearchProvider[];

  /** Available providers sorted by user's priority order from settings. */
  getAvailableByPriority(app: App, settings: NotorSettings): SearchProvider[];
}
```

`getAvailableByPriority()` reads `settings.web_search_providers` (the ordered array), filters to providers where `isConfigured()` returns `true`, and returns them in priority order.

---

## 7. Updated WebSearchTool

**File:** `src/tools/web-search.ts` (modified in place)

The class becomes a thin coordinator:

```typescript
export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly mode = "read" as const;

  constructor(
    private readonly app: App,
    private readonly settings: NotorSettings,
    private readonly searchQueue: WebSearchQueue,  // NEW: injected from main.ts
  ) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    // 1. Validate & clamp params (same as today — lines 152-171)
    // 2. Call this.searchQueue.search(query, numResults, timeoutMs)
    // 3. Filter results through isDomainBlocked (same as today — lines 253-262)
    // 4. Format output as numbered markdown list (same as today — lines 276-301)
  }
}
```

The tool description changes from "Search the web using DuckDuckGo" to remove the DDG reference, since the provider is now an implementation detail.

---

## 8. Settings Data Model

### 8.1 New Types

**File:** `src/settings/types.ts`

```typescript
/** Web search provider identifiers. */
export type WebSearchProviderType = "duckduckgo" | "tavily" | "brave" | "serpapi";

/** Per-provider web search configuration (persisted in settings). */
export interface WebSearchProviderSettings {
  /** Provider identifier. */
  type: WebSearchProviderType;
  /** Whether this provider is active. Independent of API key presence. */
  enabled: boolean;
  /**
   * Inter-request delay in ms. When undefined, the provider's built-in
   * default is used (e.g. 1500ms for DDG, 0ms for API providers).
   */
  delay_ms?: number;
}
```

### 8.2 New Fields on NotorSettings

```typescript
// In NotorSettings (src/settings/types.ts)

// -------------------------------------------------------------------
// web_search provider settings
// -------------------------------------------------------------------

/** Ordered list of web search providers. Array order = priority for fallback. */
web_search_providers: WebSearchProviderSettings[];

/** Round-robin across available providers to maximize throughput. */
web_search_round_robin: boolean;
```

The existing `web_search_timeout` and `web_search_default_num_results` fields are unchanged — they apply regardless of which provider fulfills the request.

### 8.3 Defaults

**File:** `src/settings/defaults.ts`

```typescript
/** Default web search provider configuration. DDG enabled by default. */
export const DEFAULT_WEB_SEARCH_PROVIDERS: WebSearchProviderSettings[] = [
  { type: "duckduckgo", enabled: true },
  { type: "tavily", enabled: false },
  { type: "brave", enabled: false },
  { type: "serpapi", enabled: false },
];
```

Within `createDefaultSettings()`:

```typescript
web_search_providers: DEFAULT_WEB_SEARCH_PROVIDERS,
web_search_round_robin: false,
```

### 8.4 Backward Compatibility

Users upgrading from the current single-provider `web_search` get the default provider list with DDG enabled. The standard settings merge pattern in `loadSettings()` (`{ ...defaults, ...loadedData }`) provides the new fields automatically. Existing `web_search_timeout` and `web_search_default_num_results` carry forward unchanged.

---

## 9. Secrets

**File:** `src/utils/secrets.ts`

Three new entries in `SECRET_IDS`:

```typescript
export const SECRET_IDS = {
  // ... existing ...
  TAVILY_API_KEY: "notor-tavily-api-key",
  BRAVE_SEARCH_API_KEY: "notor-brave-api-key",
  SERPAPI_API_KEY: "notor-serpapi-api-key",
} as const;
```

Follows the established `notor-{provider}-{credential-type}` convention. Each key is stored and retrieved via `setSecret()` / `getSecret()` ([`src/utils/secrets.ts:44-82`](../../src/utils/secrets.ts)) and rendered in the settings UI via Obsidian's `SecretComponent`.

---

## 10. Settings UI

**File:** `src/settings/sections/web-search.ts` (significant expansion)

The current section ([`src/settings/sections/web-search.ts`](../../src/settings/sections/web-search.ts)) has two settings: timeout and default result count. It expands to include:

### 10.1 Section Layout

```
Web search
├── Request timeout (seconds)           [existing]
├── Default number of results           [existing]
├── Round-robin across providers        [new toggle]
│
├── Search providers                    [new subsection heading]
│   ├── ┌─────────────────────────────────────────────────────┐
│   │   │ [▲] [▼]  DuckDuckGo        [enabled ●]             │
│   │   │          Delay: [1500] ms                           │
│   │   ├─────────────────────────────────────────────────────┤
│   │   │ [▲] [▼]  Tavily            [enabled ○]             │
│   │   │          Delay: [0] ms     API key: [••••••••]      │
│   │   ├─────────────────────────────────────────────────────┤
│   │   │ [▲] [▼]  Brave Search      [enabled ○]             │
│   │   │          Delay: [0] ms     API key: [••••••••]      │
│   │   ├─────────────────────────────────────────────────────┤
│   │   │ [▲] [▼]  SerpApi           [enabled ○]             │
│   │   │          Delay: [0] ms     API key: [••••••••]      │
│   │   └─────────────────────────────────────────────────────┘
```

### 10.2 Provider Row Components

Each provider row includes:
- **Up/down arrows** — Splice the `web_search_providers` array and `ctx.redisplay()`. Same pattern as [`src/settings/sections/hooks.ts`](../../src/settings/sections/hooks.ts). First provider's up button and last provider's down button are disabled.
- **Display name** — Static text from provider metadata.
- **Enabled toggle** — Maps to `WebSearchProviderSettings.enabled`. Independent of API key. Toggling off does NOT remove the API key from SecretStorage.
- **Delay override** — Text field. Placeholder shows provider's default delay (e.g. "1500" for DDG, "0" for API providers). Empty means "use default". Persisted as `WebSearchProviderSettings.delay_ms`.
- **API key** — `SecretComponent` for providers that require one (Tavily, Brave, SerpApi). Not shown for DDG. Uses `SECRET_IDS.TAVILY_API_KEY` etc.

### 10.3 Round-Robin Toggle

```typescript
new Setting(containerEl)
  .setName("Round-robin across providers")
  .setDesc(
    "Distribute search requests across all enabled providers instead of " +
    "always starting with the highest-priority one. Maximizes throughput " +
    "when multiple providers are configured."
  )
  .addToggle((toggle) =>
    toggle
      .setValue(ctx.settings.web_search_round_robin)
      .onChange(async (value) => {
        ctx.settings.web_search_round_robin = value;
        await ctx.saveSettings();
      })
  );
```

---

## 11. Registration and Wiring

**File:** `src/main.ts`

### 11.1 New Singleton Fields

```typescript
// On NotorPlugin class:
private _taskLaneQueue?: TaskLaneQueue;
private _searchProviderRegistry?: SearchProviderRegistry;
private _webSearchQueue?: WebSearchQueue;
```

### 11.2 Lazy Initialization

```typescript
getTaskLaneQueue(): TaskLaneQueue {
  if (!this._taskLaneQueue) {
    this._taskLaneQueue = new TaskLaneQueue();
  }
  return this._taskLaneQueue;
}

private getSearchProviderRegistry(): SearchProviderRegistry {
  if (!this._searchProviderRegistry) {
    this._searchProviderRegistry = new SearchProviderRegistry();
    this._searchProviderRegistry.register(new DuckDuckGoProvider(this.app, this.settings));
    this._searchProviderRegistry.register(new TavilyProvider(this.app, this.settings));
    this._searchProviderRegistry.register(new BraveSearchProvider(this.app, this.settings));
    this._searchProviderRegistry.register(new SerpApiProvider(this.app, this.settings));
  }
  return this._searchProviderRegistry;
}

private getWebSearchQueue(): WebSearchQueue {
  if (!this._webSearchQueue) {
    this._webSearchQueue = new WebSearchQueue(
      this.app,
      this.settings,
      this.getSearchProviderRegistry(),
      this.getTaskLaneQueue(),
    );
  }
  return this._webSearchQueue;
}
```

Note: `getTaskLaneQueue()` is public (not private) because it is accessed by `buildUtils()` in `src/extensions/runtime-context.ts` for extension wiring. The other queue-related getters remain private.

### 11.3 Updated WebSearchTool Registration

Current (line ~1052):
```typescript
this._toolRegistry.register(new WebSearchTool(this.app, this.settings));
```

New:
```typescript
this._toolRegistry.register(
  new WebSearchTool(this.app, this.settings, this.getWebSearchQueue()),
);
```

The queue singleton is created once and shared by all `WebSearchTool` invocations — including those triggered from sub-agent dispatch loops via [`SubAgentRunner`](../../src/chat/sub-agent-runner.ts), since sub-agents use the same tool registry.

### 11.4 Extension Runtime Wiring

**File:** `src/extensions/runtime-context.ts`

The `ExtensionUtils` interface and `buildUtils()` are extended to expose the `TaskLaneQueue` to user extensions:

```typescript
// Added to ExtensionUtils interface:
queue: {
  enqueue: <T>(lane: string, fn: () => Promise<T>, delayMs?: number) => Promise<T>;
  pending: (lane: string) => number;
};
```

```typescript
// In buildUtils():
export function buildUtils(plugin: NotorPlugin): ExtensionUtils {
  const queue = plugin.getTaskLaneQueue();
  return {
    // ... existing utils ...
    queue: {
      enqueue: (lane, fn, delayMs) => queue.enqueue(lane, fn, delayMs),
      pending: (lane) => queue.pending(lane),
    },
  };
}
```

This gives user extensions access to the same lane infrastructure used by the built-in web search tool. See [Section 17](#17-extension-system-interaction) for details on how extensions interact with the queue.

---

## 12. New File Structure

```
src/queue/
  task-lane-queue.ts           Generic TaskLaneQueue class (no web search dependency)
  task-lane-queue.test.ts      Unit tests for the queue primitive

src/tools/web-search/
  providers/
    provider.ts              SearchProvider interface, types, SearchProviderMeta
    duckduckgo.ts            DuckDuckGoProvider (extracted from web-search.ts)
    tavily.ts                TavilyProvider
    brave.ts                 BraveSearchProvider
    serpapi.ts               SerpApiProvider
  provider-registry.ts       SearchProviderRegistry
  queue.ts                   WebSearchQueue — delegates to TaskLaneQueue
  types.ts                   WebSearchProviderType, WebSearchProviderSettings, QueuedSearchResult
```

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

Multiple concurrent callers may enter the same provider lane simultaneously. The lane's FIFO wait queue (Promise-based, same pattern as [`Semaphore`](../../src/sub-agents/semaphore.ts)) ensures correctness: only one request executes at a time per lane, with the configured delay between completions. No external locking needed — JavaScript's single-threaded event loop guarantees the queue operations are atomic.

### 13.8 Extension Override Disables WebSearchQueue

When a user extension overrides `web_search` (via `notor-tool-name: web_search` in frontmatter), all LLM-initiated web searches bypass the `WebSearchQueue` and its provider selection/fallback logic. Sub-agent burst protection is lost for the built-in flow.

**Mitigation:** The `ExtensionManager` already detects and reports built-in overrides via a Notice (`manager.ts:292-295`). The user's extension CAN still opt into per-lane rate limiting by calling `utils.queue.enqueue("duckduckgo", ...)` directly, sharing the same lane as the built-in tool would use. This is documented but not enforced — users who override `web_search` accept responsibility for rate limiting.

### 13.9 Shared Lane Contention Between Extensions and Built-in

An extension and the built-in web search tool sharing the same lane (e.g., both calling `enqueue("duckduckgo", ...)`) are properly serialized — the `TaskLaneQueue` enforces FIFO ordering with the configured delay. However, an extension creating heavy load on the `"duckduckgo"` lane will slow down built-in web search results (and vice versa).

This is an accepted tradeoff and is in fact the desired behavior — the whole point of shared lanes is preventing aggregate request rates from exceeding provider limits. If an extension needs isolated throughput to DDG, it can use a different lane name (e.g., `"my-ext:duckduckgo"`), accepting that DDG may throttle if both lanes fire concurrently.

### 13.10 Lane Lifecycle

Lanes in `TaskLaneQueue` are in-memory only — they reset on plugin restart. This is explicitly desired (no persistent state needed). Idle lanes consume negligible memory (a few fields of state). There is no auto-cleanup for unused lanes. If the plugin unloads while tasks are enqueued, pending promises never resolve — same behavior as any async work interrupted by plugin unload.

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

| File | Change |
|------|--------|
| `src/queue/task-lane-queue.ts` | **Create** — Generic `TaskLaneQueue` class (no web search dependency) |
| `src/queue/task-lane-queue.test.ts` | **Create** — Unit tests for the queue primitive |
| `src/tools/web-search/providers/provider.ts` | **Create** — `SearchProvider` interface, `SearchProviderMeta`, `SearchProviderResult` |
| `src/tools/web-search/providers/duckduckgo.ts` | **Create** — `DuckDuckGoProvider` (extracted from `web-search.ts`) |
| `src/tools/web-search/providers/tavily.ts` | **Create** — `TavilyProvider` |
| `src/tools/web-search/providers/brave.ts` | **Create** — `BraveSearchProvider` |
| `src/tools/web-search/providers/serpapi.ts` | **Create** — `SerpApiProvider` |
| `src/tools/web-search/provider-registry.ts` | **Create** — `SearchProviderRegistry` |
| `src/tools/web-search/queue.ts` | **Create** — `WebSearchQueue` — delegates to `TaskLaneQueue` |
| `src/tools/web-search/types.ts` | **Create** — `WebSearchProviderType`, `WebSearchProviderSettings`, `QueuedSearchResult` |
| `src/tools/web-search.ts` | **Modify** — Simplify to delegate to queue; accept `WebSearchQueue` in constructor; update tool description |
| `src/settings/types.ts` | **Modify** — Add `WebSearchProviderSettings` type, `web_search_providers` and `web_search_round_robin` fields to `NotorSettings` |
| `src/settings/defaults.ts` | **Modify** — Add `DEFAULT_WEB_SEARCH_PROVIDERS`, new fields in `createDefaultSettings()` |
| `src/utils/secrets.ts` | **Modify** — Add `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `SERPAPI_API_KEY` to `SECRET_IDS` |
| `src/settings/sections/web-search.ts` | **Modify** — Expand with provider priority list, per-provider config, round-robin toggle |
| `src/main.ts` | **Modify** — Add `_taskLaneQueue`, `_searchProviderRegistry`, and `_webSearchQueue` singletons; update `WebSearchTool` registration |
| `src/extensions/runtime-context.ts` | **Modify** — Add `queue` to `ExtensionUtils` interface and `buildUtils()` |
| `src/tools/web-search.test.ts` | **Modify** — Update tests to mock `WebSearchQueue` instead of `requestUrl`; move DDG parsing tests to provider-specific test file |

---

## 16. Verification Plan

### Unit Tests

| Component | Test |
|-----------|------|
| `TaskLaneQueue` | Two tasks on same lane execute serially. Delay enforcement: completions spaced by at least `delayMs`. Different lanes execute concurrently. `pending()` returns correct count. First-writer-wins: second `enqueue` with different `delayMs` uses original delay. Error in `fn` still releases lane for next waiter. Lane removal via `removeLane()`. |
| `DuckDuckGoProvider` | Existing `cleanDDGUrl` and `parseDDGResults` tests (migrated from `web-search.test.ts`). New: HTTP error handling, rate-limit detection (202 → `rateLimited: true`). |
| `TavilyProvider` | JSON response parsing. Auth header presence. Rate-limit detection (429). Timeout handling. |
| `BraveSearchProvider` | JSON response parsing. `X-Subscription-Token` header. Rate-limit detection. |
| `SerpApiProvider` | JSON response parsing. `api_key` query param. Rate-limit detection. |
| `SearchProviderRegistry` | `getAvailableByPriority()` respects enabled state, API key presence, and priority order. |
| `WebSearchQueue` | Delegates to `TaskLaneQueue` with correct lane keys. Round-robin: 3 providers, 6 requests, verify distribution. Fallback: first provider fails → second provider used. All fail → aggregated error. No available providers → immediate descriptive error. |
| `WebSearchTool` | Delegates to queue. Domain denylist filtering still applied to results. Output format unchanged. |

### Integration / E2E Tests

1. **Single provider, no queue contention** — One `web_search` call with only DDG enabled. Verify results returned, domain denylist applied, output formatted correctly.
2. **Multi-provider fallback** — DDG disabled, Tavily enabled with valid key. Verify Tavily is used.
3. **Round-robin distribution** — DDG + Tavily enabled, round-robin ON. Fire 4 searches. Verify both providers receive requests (check logs or mock both providers).
4. **Concurrent burst from sub-agents** — 3 sub-agents each fire 2 `web_search` calls. Verify all 6 complete without DDG 202 errors (with round-robin + Tavily as second provider).
5. **Settings change mid-session** — Disable a provider while searches are active. Verify in-flight requests complete, new requests use remaining providers.
6. **Delay enforcement** — DDG with 1500ms delay. Fire 3 DDG-only requests. Verify timestamps are spaced ≥1500ms apart.

### Extension Integration Tests

7. **Extension `utils.queue.enqueue()`** — A user tool calling `utils.queue.enqueue("test-lane", fn, 100)` works end-to-end. Verify task executes and returns result.
8. **Shared lane serialization** — Two extensions sharing a lane name are properly serialized (second task waits for first + delay).
9. **Extension and built-in sharing a lane** — A user extension calling `utils.queue.enqueue("duckduckgo", fn, 1500)` is serialized with the built-in web search tool's DDG requests.

### Manual Testing

- Verify settings UI renders provider rows with up/down/toggle/delay/key controls.
- Verify API key entry via `SecretComponent` persists across plugin reload.
- Verify disabling a provider (toggle off) does not clear its API key.
- Verify reordering providers updates the priority and persists.

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

This call shares the built-in tool's DDG lane, so the extension's requests are properly interleaved and rate-limited alongside the built-in web search tool's requests.

### 17.2 Well-Known Lane Names

The built-in web search providers use these lane names. Extension authors can opt into shared rate limiting by using the same names:

| Lane Key | Default Delay | Used By |
|----------|--------------|---------|
| `"duckduckgo"` | 1500ms | Built-in `web_search` tool |
| `"tavily"` | 0ms | Built-in `web_search` (when Tavily is configured) |
| `"brave"` | 0ms | Built-in `web_search` (when Brave is configured) |
| `"serpapi"` | 0ms | Built-in `web_search` (when SerpApi is configured) |

**Lane scoping:** Lanes are global (not namespaced per-extension). This is intentional — two extensions hitting the same API should share rate limiting. Extensions wanting isolation can prefix their lane name (e.g., `"my-ext:duckduckgo"`), accepting that the API may throttle if both lanes fire concurrently.

**First-writer-wins:** The delay is set when a lane is first created and cannot be changed by subsequent callers. This prevents extensions from lowering delays on shared lanes. See Section 5.1 for details.

### 17.3 User Tool Override of `web_search`

A user extension with `notor-tool-name: web_search` in its frontmatter replaces the built-in `WebSearchTool` entirely via `ToolRegistry`'s last-write-wins semantics. When this happens:

- The user's implementation does **not** automatically use `WebSearchQueue` or its provider selection/fallback logic.
- The queue's per-provider rate limiting is bypassed for all LLM-initiated `web_search` calls.
- The `ExtensionManager` already detects and reports built-in overrides via a Notice ([`manager.ts:292-295`](../../src/extensions/manager.ts)).
- The user's extension **can** opt into per-lane rate limiting by calling `utils.queue.enqueue("duckduckgo", ...)`, sharing the same lane as the built-in tool would use.

This is an accepted tradeoff: users who override `web_search` take responsibility for rate limiting. The `utils.queue` API gives them the tools to do it correctly.

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
