# Implementation Plan: `web_search` Built-in Tool

**Design doc:** [web-search-tool-design.md](web-search-tool-design.md)
**Date:** 2026-04-03

---

## Phase 1: Core Tool Implementation

The foundational tool class, parsing logic, and registration — enough to make `web_search` callable by the LLM.

### 1.1 Create `src/tools/web-search.ts`

- [ ] Define `WebSearchResult` type: `{ title: string; url: string; snippet: string }`
- [ ] Implement `cleanDDGUrl(raw: string): string | null`
  - Handle `//duckduckgo.com/l/?uddg=...` redirect format
  - Handle protocol-relative URLs (`//...` → `https:...`)
  - Pass through absolute `http://` / `https://` URLs
  - Return `null` for anything else
- [ ] Implement `parseDDGResults(html: string, maxResults: number): WebSearchResult[]`
  - Use global `DOMParser` (NOT `@xmldom/xmldom` — that's XML-only)
  - Parse with `text/html` mime type
  - Select `.result` containers, extract `.result__title a` (href + text) and `.result__snippet` (text)
  - Call `cleanDDGUrl()` on each href
  - Cap at `maxResults`
- [ ] Implement `WebSearchTool` class implementing `Tool` interface from `src/tools/tool.ts`
  - Constructor: `(app: App, settings: NotorSettings)` — same as `FetchWebpageTool`
  - `name = "web_search"`
  - `mode = "read"` (safe in Plan mode)
  - `description` — concise LLM-facing description: searches the web via DuckDuckGo, returns titles/URLs/snippets
  - `input_schema` — `query` (string, required), `num_results` (number, optional, default 5, max 10)
- [ ] Implement `execute()` method
  - Clamp `num_results` to 1–10, default to `settings.web_search_default_num_results`
  - Build timeout via `Promise.race()` pattern (from `fetch-webpage.ts:410-440`) using `settings.web_search_timeout * 1000`
  - POST to `https://html.duckduckgo.com/html/` with form-encoded body `q={query}&kl=us-en`
  - Include headers: `User-Agent`, `Accept`, `Accept-Language`, `Content-Type`, `DNT` (per design doc §4.1)
  - Use `requestUrl()` from `obsidian` with `throw: false`
  - Check for non-200 status → return error `ToolResult`
  - Parse HTML via `parseDDGResults()`
  - Filter results through `isDomainBlocked()` (imported from `src/tools/fetch-webpage.ts`)
  - If 0 results after filtering → return `"No results found for query: {query}"`
  - Format output as numbered markdown list (per design doc §4.5)
  - Return success `ToolResult` with formatted string

### 1.2 Register the tool

- [ ] In `src/main.ts` `getToolRegistry()`, add `WebSearchTool` registration alongside `FetchWebpageTool`
  - Import `WebSearchTool` from `./tools/web-search`
  - `this._toolRegistry.register(new WebSearchTool(this.app, this.settings))`

### 1.3 Add auto-approve default

- [ ] In `src/settings/defaults.ts`, add `web_search: true` to `DEFAULT_AUTO_APPROVE` (read-only tool, same as `fetch_webpage`)

### Phase 1 verification

- [ ] Build succeeds (`npm run build`)
- [ ] Tool appears in `getToolRegistry().getNames()`
- [ ] Manual test: ask LLM to search for something → tool call appears in UI, results returned

---

## Phase 2: Settings

New settings fields, default values, and settings UI section.

### 2.1 Add settings fields to `NotorSettings`

- [ ] In `src/settings/types.ts`, add:
  - `web_search_timeout: number` — HTTP request timeout in seconds
  - `web_search_default_num_results: number` — default result count

### 2.2 Add default values

- [ ] In `src/settings/defaults.ts` `createDefaultSettings()`, add:
  - `web_search_timeout: 10`
  - `web_search_default_num_results: 5`

### 2.3 Create settings UI section

- [ ] Create `src/settings/sections/web-search.ts`
  - Export `renderWebSearchSection(containerEl: HTMLElement, ctx: SettingsContext): void`
  - Follow `src/settings/sections/fetch-webpage.ts` as template
  - Setting: "Request timeout (seconds)" — text input, numeric, bound to `web_search_timeout`
  - Setting: "Default number of results" — text input, numeric, bound to `web_search_default_num_results`
  - Note in heading or description: domain denylist is shared with `fetch_webpage`

### 2.4 Wire section into settings tab

- [ ] In `src/settings/settings-tab.ts`, import and call `renderWebSearchSection()` in the "Tool configuration" group, after `renderFetchWebpageSection()`

### Phase 2 verification

- [ ] Settings tab shows "Web search" section with two controls
- [ ] Changing values persists across plugin reload
- [ ] Tool respects configured timeout and result count

---

## Phase 3: System Prompt & LLM Guidance

Add behavioral guidance to the system prompt so the LLM knows when/how to use `web_search` vs `fetch_webpage`.

### 3.1 Add system prompt section

- [ ] In `src/chat/default-system-prompt.ts`, add a `## Web search` section (near the existing `## Web fetching` section). Content should cover:
  - When to use `web_search` (finding information, exploring topics) vs `fetch_webpage` (reading a known URL)
  - The search-then-fetch workflow: use `web_search` to find URLs, then `fetch_webpage` on specific results for full content
  - Results are snippets only — not full page content
  - Don't search repeatedly for the same query
  - Domain denylist applies — blocked domains are silently filtered from results
  - Prefer specific, well-formed search queries

### 3.2 Update `## Web fetching` section

- [ ] Add a cross-reference to `web_search` in the existing `## Web fetching` section
  - Mention: "To find URLs, use `web_search` first rather than guessing URLs"

### Phase 3 verification

- [ ] System prompt includes new section (inspect via debug/logging)
- [ ] LLM naturally chooses `web_search` when user says "search for..." or "find information about..."
- [ ] LLM uses search-then-fetch workflow when deeper content is needed

---

## Phase 4: Unit Tests

Targeted tests for the parsing and URL-cleaning logic that don't require network access.

### 4.1 Create `src/tools/web-search.test.ts`

- [ ] Test `cleanDDGUrl()`:
  - Decodes DDG redirect URL (`//duckduckgo.com/l/?uddg=...`) → actual URL
  - Handles protocol-relative URLs → `https:` prefix
  - Passes through absolute URLs unchanged
  - Returns `null` for relative paths, empty strings, malformed URLs
  - Handles double-encoded URLs correctly
- [ ] Test `parseDDGResults()`:
  - Parses a saved DDG HTML snapshot → correct titles, URLs, snippets
  - Respects `maxResults` cap
  - Skips results with missing title or URL
  - Handles empty/malformed HTML gracefully (returns `[]`)
- [ ] Test domain denylist filtering in `execute()`:
  - Results from blocked domains are excluded
  - Results from allowed domains pass through
  - Wildcard patterns work correctly

### Phase 4 verification

- [ ] All unit tests pass (`npm test`)

---

## Phase 5: E2E Test

End-to-end test validating the full tool lifecycle in a real Obsidian environment.

### 5.1 Create `e2e/scripts/web-search-test.ts`

- [ ] Scenario 1: Basic search returns results
  - Send a message asking the LLM to search for a well-known topic
  - Verify `web_search` tool call appears in the UI (`.notor-tool-call` with correct tool name)
  - Verify assistant response references search results
- [ ] Scenario 2: Domain denylist filtering
  - Configure `domain_denylist` in test settings with a likely result domain
  - Run a search that would normally include that domain
  - Verify blocked domain does not appear in results
- [ ] Scenario 3: Search-then-fetch workflow
  - Ask the LLM to search and then read a specific result
  - Verify both `web_search` and `fetch_webpage` tool calls appear
- [ ] Scenario 4: Error handling — timeout
  - Set `web_search_timeout` to an extremely low value (e.g., 0.001 seconds)
  - Verify the tool returns a timeout error gracefully

### Phase 5 verification

- [ ] All E2E scenarios pass
- [ ] Results written to `e2e/results/web-search-results.json`
- [ ] Screenshots captured at key verification points

---

## Phase 6: Polish & Edge Cases

Final hardening before considering the feature complete.

### 6.1 Edge case handling

- [ ] Log a warning when DDG returns a non-empty response body but 0 results are parsed (possible selector drift)
- [ ] Handle network errors gracefully (no internet, DNS failure) — return descriptive error, not stack trace
- [ ] Verify the tool works when `domain_denylist` is empty (default state)
- [ ] Verify the tool works when all results are filtered by denylist (returns "no results" message)

### 6.2 Open question resolutions

- [ ] Decide: shared vs separate domain denylist (design doc recommends shared — confirm or override)
- [ ] Decide: Brave Search as fallback engine (design doc marks as out-of-scope spike — confirm deferral)
- [ ] Decide: max result cap at 10 (design doc recommends this — confirm)

### Phase 6 verification

- [ ] Full regression: build, unit tests, E2E tests all pass
- [ ] Manual smoke test in Obsidian with various query types (factual, ambiguous, empty results)
