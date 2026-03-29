# Design: `web_search` Built-in Tool

**Status:** Draft
**Author:** Design spike
**Date:** 2026-03-28

---

## 1. Motivation

The `web-search-mcp` repository (`../web-search-mcp/`) implements multi-engine web search as an external MCP server. Users who want web search today must install and run that Node.js server separately, then configure it in Notor's MCP settings. A built-in `web_search` tool would:

- Require zero user setup (no external process, no npm install)
- Eliminate the ~200 MB Playwright dependency
- Work in any Obsidian environment (mobile included — though content will vary)
- Integrate naturally with the existing approval, denylist, and tool-config systems

---

## 2. Feasibility

### 2.1 What can't be ported

**Playwright browser automation is not viable in Obsidian.** Obsidian plugins run in Electron's renderer process and cannot install browser binaries or spawn subprocesses. This rules out the entire browser-automation layer in `web-search-mcp`:

- `tryBrowserBingSearch()` — [`web-search-mcp/src/search-engine.ts:216`](../web-search-mcp/src/search-engine.ts) — launches Chromium
- `tryBrowserBraveSearch()` — [`web-search-mcp/src/search-engine.ts:120`](../web-search-mcp/src/search-engine.ts) — launches Firefox
- `BrowserPool` — [`web-search-mcp/src/browser-pool.ts`](../web-search-mcp/src/browser-pool.ts) — manages browser instances
- `RateLimiter` / `p-limit` concurrency — overkill for a single in-process tool

The consequence: **Bing and Brave search are not feasible** as primary engines (both require JS rendering in web-search-mcp; it's unknown whether their HTML endpoints work without JS for all queries).

**Axios and Cheerio are not needed.** Obsidian's `requestUrl()` API (already used in [`src/tools/fetch-webpage.ts:18`](../src/tools/fetch-webpage.ts)) performs HTTP GET in the main Electron process, bypassing CORS. `DOMParser` (available in the Electron renderer context) replaces Cheerio for HTML parsing.

### 2.2 What works cleanly

**DuckDuckGo HTML endpoint is fully viable:**

- Endpoint: `https://html.duckduckgo.com/html/?q={query}` (POST with `q` body, or GET with `?q=`)
- Serves complete server-rendered HTML — no JavaScript required
- The web-search-mcp implementation is at [`web-search-mcp/src/search-engine.ts:502–532`](../web-search-mcp/src/search-engine.ts) — it uses Axios for this, but the same request works with `requestUrl()`
- No API key, no authentication, no rate limit (for reasonable use)
- HTML selectors for parsing are stable and documented (see §4 below)

**The `requestUrl()` + timeout pattern** from [`src/tools/fetch-webpage.ts:332–387`](../src/tools/fetch-webpage.ts) is the correct HTTP transport. `requestUrl()` buffers the full response, so there's no streaming; this is fine for a search results page (~50–100 KB).

**The domain denylist** from `fetch_webpage` should apply to search result URLs before returning them (so the LLM can't use `web_search` to surface blocked domains). The exported `isDomainBlocked()` function at [`src/tools/fetch-webpage.ts:86`](../src/tools/fetch-webpage.ts) handles this.

---

## 3. Architecture

### 3.1 New file

**`src/tools/web-search.ts`** — self-contained tool implementation, following the same structure as [`src/tools/fetch-webpage.ts`](../src/tools/fetch-webpage.ts).

### 3.2 Tool interface compliance

Implements [`src/tools/tool.ts:53`](../src/tools/tool.ts) — the `Tool` interface:

```typescript
export class WebSearchTool implements Tool {
  readonly name = "web_search";
  readonly mode = "read" as const;  // Safe in Plan mode
  // ...
}
```

**Constructor** receives `App` and `NotorSettings` (same signature as `FetchWebpageTool` at [`src/tools/fetch-webpage.ts:166`](../src/tools/fetch-webpage.ts)).

### 3.3 Input schema

```typescript
readonly input_schema = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string.",
    },
    num_results: {
      type: "number",
      description: "Number of results to return. Defaults to 5. Maximum 10.",
      default: 5,
    },
  },
  required: ["query"],
};
```

### 3.4 Registration

Add to `getToolRegistry()` in [`src/main.ts:980–990`](../src/main.ts) alongside `FetchWebpageTool`:

```typescript
// Phase 3: New tools
this._toolRegistry.register(
  new FetchWebpageTool(this.app, this.settings)
);
this._toolRegistry.register(
  new WebSearchTool(this.app, this.settings)   // ← ADD HERE
);
// ...
```

---

## 4. Implementation Details

### 4.1 HTTP Request

Use `requestUrl()` from `obsidian`, mirroring the approach in [`src/tools/fetch-webpage.ts:332–387`](../src/tools/fetch-webpage.ts). DuckDuckGo's HTML endpoint accepts either a GET with `?q=` or a POST with form-encoded body. The POST approach (used by some clients) may be more reliable for avoiding bot detection:

```typescript
import { requestUrl } from "obsidian";

const response = await Promise.race([
  requestUrl({
    url: "https://html.duckduckgo.com/html/",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "DNT": "1",
    },
    body: `q=${encodeURIComponent(query)}&kl=us-en`,
    throw: false,
  }),
  timeoutPromise,
]);
```

The User-Agent and headers come directly from `tryDuckDuckGoSearch()` in [`web-search-mcp/src/search-engine.ts:506–521`](../web-search-mcp/src/search-engine.ts). The timeout pattern (race against a manual timer) is from [`src/tools/fetch-webpage.ts:342–362`](../src/tools/fetch-webpage.ts).

### 4.2 HTML Parsing

Web-search-mcp uses Cheerio for parsing ([`web-search-mcp/src/search-engine.ts:894–932`](../web-search-mcp/src/search-engine.ts)). In Obsidian (Electron renderer), we use `DOMParser` instead — no new dependency:

```typescript
const parser = new DOMParser();
const doc = parser.parseFromString(response.text, "text/html");
```

**DuckDuckGo result selectors** (from [`web-search-mcp/src/search-engine.ts:902–928`](../web-search-mcp/src/search-engine.ts)):

| Element | Selector | Notes |
|---------|----------|-------|
| Result container | `.result` | Each organic result |
| Title + link | `.result__title a` | `href` is the redirect URL, text is title |
| Snippet | `.result__snippet` | Plain text description |

The DDG HTML structure is stable and well-documented. The selectors above have been used reliably by web-search-mcp.

**Full parsing loop:**

```typescript
function parseDDGResults(html: string, maxResults: number): WebSearchResult[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const results: WebSearchResult[] = [];

  const containers = doc.querySelectorAll(".result");
  for (const el of containers) {
    if (results.length >= maxResults) break;

    const titleEl = el.querySelector(".result__title a");
    const snippetEl = el.querySelector(".result__snippet");

    const title = titleEl?.textContent?.trim() ?? "";
    const rawUrl = titleEl?.getAttribute("href") ?? "";
    const snippet = snippetEl?.textContent?.trim() ?? "";

    if (!title || !rawUrl) continue;

    const url = cleanDDGUrl(rawUrl);
    if (!url) continue;

    results.push({ title, url, snippet });
  }

  return results;
}
```

### 4.3 URL Decoding

DuckDuckGo wraps all result URLs in a redirect: `//duckduckgo.com/l/?uddg={encoded_url}&...`

The decoding logic is at [`web-search-mcp/src/search-engine.ts:996–1020`](../web-search-mcp/src/search-engine.ts):

```typescript
function cleanDDGUrl(raw: string): string | null {
  // Handle redirect: //duckduckgo.com/l/?uddg=...
  if (raw.startsWith("//duckduckgo.com/l/")) {
    const qIndex = raw.indexOf("?");
    if (qIndex === -1) return null;
    const params = new URLSearchParams(raw.substring(qIndex + 1));
    const actual = params.get("uddg");
    if (!actual) return null;
    return decodeURIComponent(actual);
  }
  // Handle protocol-relative
  if (raw.startsWith("//")) return "https:" + raw;
  // Already absolute
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return null;
}
```

### 4.4 Domain Denylist

After decoding each URL, check it against the user's domain denylist by importing `isDomainBlocked` from [`src/tools/fetch-webpage.ts:86`](../src/tools/fetch-webpage.ts):

```typescript
import { isDomainBlocked } from "./fetch-webpage";

// Inside result loop:
const check = isDomainBlocked(url, this.settings.domain_denylist);
if (check.blocked) continue;  // Skip this result silently
```

### 4.5 Output Format

Return results as a markdown list, matching the text-heavy format the LLM can easily read. Example output:

```
Web search results for "obsidian plugin development guide" (4 results):

1. **[Obsidian Plugin Developer Docs](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)**
   The official guide to building Obsidian plugins using the TypeScript API...

2. **[Marcus Olsson's Plugin Developer Guide](https://marcus.se.net/obsidian-plugin-docs/)**
   A community-maintained guide covering plugin development patterns...

...
```

This is preferable to JSON because:
- Easier for the LLM to read and cite inline
- Consistent with how `fetch_webpage` returns markdown
- Naturally truncates — if a snippet is long it just flows

---

## 5. Settings

### 5.1 New settings fields

Following the pattern in [`src/settings/types.ts:132–145`](../src/settings/types.ts):

```typescript
// In NotorSettings (src/settings/types.ts)

/** Timeout in seconds for web_search requests. */
web_search_timeout: number;

/** Maximum number of results web_search returns by default. */
web_search_default_num_results: number;
```

Defaults in [`src/settings/defaults.ts:117–121`](../src/settings/defaults.ts):
```typescript
web_search_timeout: 10,
web_search_default_num_results: 5,
```

**Note:** The domain denylist (`domain_denylist`) is already shared with `fetch_webpage` and applies to both tools — no new field needed.

### 5.2 Settings UI

Add a new section renderer `renderWebSearchSection()` in a new file `src/settings/sections/web-search.ts`, following [`src/settings/sections/fetch-webpage.ts`](../src/settings/sections/fetch-webpage.ts) as the exact template. It would expose:

- Timeout (seconds)
- Default result count

The domain denylist is already rendered in the `fetch_webpage` section and shared — no duplication needed.

---

## 6. What NOT to Port from web-search-mcp

The following parts of web-search-mcp are intentionally excluded:

| Component | Reason to exclude |
|-----------|-------------------|
| `BrowserPool` ([`browser-pool.ts`](../web-search-mcp/src/browser-pool.ts)) | Playwright can't run in Obsidian |
| `tryBrowserBingSearch()` ([`search-engine.ts:216`](../web-search-mcp/src/search-engine.ts)) | Requires Chromium |
| `tryBrowserBraveSearch()` ([`search-engine.ts:120`](../web-search-mcp/src/search-engine.ts)) | Requires Firefox |
| `RateLimiter` ([`rate-limiter.ts`](../web-search-mcp/src/rate-limiter.ts)) | Plugin is single-user; a simple timeout suffices |
| `assessResultQuality()` ([`search-engine.ts:1022`](../web-search-mcp/src/search-engine.ts)) | Over-engineered for single-engine use |
| `EnhancedContentExtractor` ([`enhanced-content-extractor.ts`](../web-search-mcp/src/enhanced-content-extractor.ts)) | Out of scope — snippets only; user can invoke `fetch_webpage` on a specific result |
| `FORCE_MULTI_ENGINE_SEARCH` env var | Single engine; no env var config |
| All Axios/Cheerio imports | Replaced by `requestUrl()` + `DOMParser` |

---

## 7. Edge Cases and Risks

### 7.1 DuckDuckGo bot detection

DuckDuckGo may return a CAPTCHA or empty results page if it detects automated traffic. The POST approach with realistic headers (per §4.1) mitigates this. If detected, the tool should return a descriptive error rather than empty results.

**Detection heuristic:** After parsing, if `results.length === 0` but the response was 200 OK, check if the HTML contains `"robot"` or `"captcha"` and return a specific error message.

### 7.2 DuckDuckGo HTML structure changes

Selectors may break if DDG updates their HTML. The fix would be a plugin update. Risk is low — these selectors have been stable for years and are used in many open source projects.

### 7.3 Selector drift

If `.result__title a` stops working, fallback selectors to try:
- `[data-result] a`
- `h2 a`
- `.result-title a`

Consider logging a warning if 0 results are returned for a non-empty response body.

### 7.4 Timeout under slow network

The default 10-second timeout is generous but finite. DDG's HTML endpoint typically responds in under 2 seconds. If it consistently times out, the user can increase the timeout in settings.

---

## 8. Open Questions

1. **Should `web_search` share the same domain denylist as `fetch_webpage`?**
   Current design says yes — blocked domains are filtered from results. This is the safe default, but a power user might want different lists. For now, sharing is simpler.

2. **Should Brave Search be attempted as a second engine?**
   `https://search.brave.com/search?q={query}` may return server-rendered HTML for some queries. If so, it would be a free fallback. Needs a quick feasibility test — outside scope of this design doc but worth a spike.

3. **Should the LLM be able to request more than 10 results?**
   DDG's HTML page returns ~10–15 organic results. Capping `num_results` at 10 matches what the MCP server allows and what DDG reliably provides.

4. **Should the tool be auto-approved by default?**
   `fetch_webpage` is auto-approved by default (per [`src/settings/constants.ts:78`](../src/settings/constants.ts)). `web_search` should follow the same default since it's a read-only, non-destructive operation. This can be overridden per-persona or per-tool-config.

---

## 9. Files to Create / Modify

| File | Change |
|------|--------|
| `src/tools/web-search.ts` | **Create** — new tool class (~150–200 lines) |
| `src/main.ts` | **Modify** — register `WebSearchTool` at line ~984 |
| `src/settings/types.ts` | **Modify** — add `web_search_timeout`, `web_search_default_num_results` fields |
| `src/settings/defaults.ts` | **Modify** — add default values for new settings |
| `src/settings/constants.ts` | **Modify** — add `web_search: { auto_approve: true }` to `DEFAULT_TOOL_SETTINGS` |
| `src/settings/sections/web-search.ts` | **Create** — settings UI section renderer |
| `src/settings/tab.ts` | **Modify** — call `renderWebSearchSection()` in settings tab |

---

## 10. Verification Plan

1. **Unit-level:** Test `parseDDGResults()` and `cleanDDGUrl()` with saved HTML snapshots from DDG (no network required)
2. **Integration:** Make a live search request and confirm titles/URLs/snippets are returned correctly for 2–3 representative queries
3. **Denylist:** Add a domain to `domain_denylist`, run a search that would include it, confirm that result is filtered
4. **Timeout:** Set timeout to 1ms, verify the tool returns a timeout error rather than hanging
5. **Zero results:** Test with a nonsense query and verify graceful handling (empty list vs. error)
6. **LLM invocation:** In the Notor chat, ask the AI to search for something and verify the tool call appears in the UI with the correct tool name and result rendering
