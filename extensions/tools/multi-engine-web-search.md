---
notor-type: tool
notor-tool-name: multi_engine_web_search
notor-description: "Search the web using multiple engines (Tavily, Brave, SerpApi, Kagi, DuckDuckGo) with automatic fallback and optional round-robin."
notor-mode: read
tested-notor-version: "0.8.0"
author: Notor
---

# Multi-Engine Web Search

Provides web search across multiple providers with automatic fallback. When one provider is rate-limited or fails, the next in the priority chain is tried automatically.

This is useful when you need higher reliability or want to leverage paid search APIs (Tavily, Brave, SerpApi) for better result quality while keeping DuckDuckGo as a free fallback.

### Providers

| Provider | API Key Required | Notes |
|----------|-----------------|-------|
| DuckDuckGo | No | Free, HTML scraping, 1500ms default delay |
| Tavily | Yes | AI-optimized search API |
| Brave Search | Yes | Privacy-focused search API |
| SerpApi | Yes | Google results via API |
| Kagi | Yes | Premium ad-free search API |

### Fallback behavior

Providers are tried in priority order. If a provider returns a rate-limit signal or errors out, the next enabled provider is tried — up to the configured maximum attempts.

With **round-robin** enabled, the starting position rotates across searches so load is distributed evenly.

```yaml
params:
  query:
    type: string
    description: "Search query string."
  num_results:
    type: number
    description: "Number of results to return. Maximum 10."
    default: 5
settings:
  web_search_timeout:
    name: "Request Timeout"
    type: number
    description: "Maximum time per provider in seconds. Worst-case total latency is this value × max providers to try."
    default: 10
    min: 1
    max: 120
  web_search_default_num_results:
    name: "Default Number of Results"
    type: number
    description: "Number of search results returned when the LLM does not specify a count (1–10)."
    default: 5
    min: 1
    max: 10
  web_search_round_robin:
    name: "Round-robin across providers"
    type: boolean
    description: "Distribute search requests across all enabled providers instead of always using the highest-priority one."
    default: false
  web_search_provider_priority:
    name: "Provider priority order"
    type: "string[]"
    description: "Order in which search providers are tried. Valid values: duckduckgo, tavily, brave, serpapi, kagi."
    default: ["duckduckgo", "tavily", "brave", "serpapi", "kagi"]
  web_search_max_fallback_providers:
    name: "Max providers to try"
    type: number
    description: "Maximum number of search providers to try before giving up."
    default: 2
    min: 1
    max: 5
  web_search_duckduckgo_enabled:
    name: "DuckDuckGo — Enabled"
    type: boolean
    default: true
  web_search_duckduckgo_delay_ms:
    name: "DuckDuckGo — Delay (ms)"
    type: number
    description: "Minimum delay between DuckDuckGo requests to avoid rate-limiting."
    default: 1500
    min: 0
    max: 10000
  web_search_tavily_enabled:
    name: "Tavily — Enabled"
    type: boolean
    default: false
    requiresSecret: web_search_tavily_api_key
  web_search_tavily_api_key:
    name: "Tavily — API Key"
    type: string
    secret: true
    default: ""
  web_search_tavily_delay_ms:
    name: "Tavily — Delay (ms)"
    type: number
    default: 0
    min: 0
    max: 10000
    requiresSecret: web_search_tavily_api_key
  web_search_brave_enabled:
    name: "Brave Search — Enabled"
    type: boolean
    default: false
    requiresSecret: web_search_brave_api_key
  web_search_brave_api_key:
    name: "Brave Search — API Key"
    type: string
    secret: true
    default: ""
  web_search_brave_delay_ms:
    name: "Brave Search — Delay (ms)"
    type: number
    default: 0
    min: 0
    max: 10000
    requiresSecret: web_search_brave_api_key
  web_search_serpapi_enabled:
    name: "SerpApi — Enabled"
    type: boolean
    default: false
    requiresSecret: web_search_serpapi_api_key
  web_search_serpapi_api_key:
    name: "SerpApi — API Key"
    type: string
    secret: true
    default: ""
  web_search_serpapi_delay_ms:
    name: "SerpApi — Delay (ms)"
    type: number
    default: 0
    min: 0
    max: 10000
    requiresSecret: web_search_serpapi_api_key
  web_search_kagi_enabled:
    name: "Kagi — Enabled"
    type: boolean
    default: false
    requiresSecret: web_search_kagi_api_key
  web_search_kagi_api_key:
    name: "Kagi — API Key"
    type: string
    secret: true
    default: ""
  web_search_kagi_delay_ms:
    name: "Kagi — Delay (ms)"
    type: number
    default: 0
    min: 0
    max: 10000
    requiresSecret: web_search_kagi_api_key
```

```ts
const log = utils.logger("multi_engine_web_search");

const query = params.query as string;
if (!query || typeof query !== "string") {
  throw new Error("Missing required parameter: query");
}

const rawNum = typeof params.num_results === "number"
  ? params.num_results
  : (settings.web_search_default_num_results as number);
const numResults = Math.max(1, Math.min(10, Math.round(rawNum)));
const timeoutMs = (settings.web_search_timeout as number) * 1000;

const config = utils.webSearch.buildConfig(settings);

log.info("Multi-engine search initiated", { query, numResults, timeoutMs, providers: config.providerPriority });

const searchResult = await utils.webSearch.searchWithConfig(query, numResults, timeoutMs, config, utils.abortSignal);

if (searchResult.error) {
  throw new Error(searchResult.error);
}

if (searchResult.failures.length > 0) {
  log.warn("Some providers failed before success", { failures: searchResult.failures });
}

log.debug("Search fulfilled", { provider: searchResult.provider, rawCount: searchResult.results.length });

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

const lines: string[] = [
  `Web search results for "${query}" (${results.length} result${results.length === 1 ? "" : "s"}, via ${searchResult.provider}):`,
  "",
];

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  lines.push(`${i + 1}. **[${r.title}](${r.url})**`);
  if (r.snippet) lines.push(`   ${r.snippet}`);
  lines.push("");
}

const output = lines.join("\n").trimEnd();
log.info("Multi-engine search completed", { query, resultCount: results.length, provider: searchResult.provider });
return output;
```
