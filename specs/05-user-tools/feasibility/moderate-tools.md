# Feasibility Assessment: Moderate Tools

Tools with external library dependencies, settings migration, or helper functions requiring careful porting. All viable with current or planned runtime expansions.

**Tools covered:** `fetch_webpage`, `web_search`, `read_file`, `search_vault`, `read_docx`

---

## `fetch_webpage` — Feasibility: Moderate ✅

**Source:** `src/tools/fetch-webpage.ts` (469 lines total, ~445 lines of logic)

**What the built-in class does:**
1. Validates `url` param (existence, string type, parseable URL, http/https protocol only)
2. Checks URL against domain denylist via `isDomainBlocked(url, settings.domain_denylist)`
3. Reads settings: `fetch_webpage_timeout` (seconds → ms), `fetch_webpage_max_download_mb` (MB → bytes), `fetch_webpage_max_output_chars`
4. Fetches URL via `requestUrl()` with manual timeout race (`Promise.race` against `setTimeout`)
5. On fetch failure: probes with native `fetch()` HEAD to isolate Obsidian vs. Electron network issues; maps Chromium `net::ERR_*` codes to human-readable hints via `getNetErrorHint()`
6. Checks response status (non-2xx → error)
7. Checks response body byte length against download cap (via `TextEncoder`)
8. Extracts MIME type from `content-type` header
9. HTML/XHTML → Turndown conversion (GFM plugin, custom rules stripping nav/footer/forms); text/JSON → pass-through; other → error
10. Truncates output at `max_output_chars` with a note about truncation

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `requestUrl` | `obsidian.requestUrl` | ✅ |
| `TurndownService` | `libs.Turndown` | ✅ |
| `gfm` plugin | `libs.turndownGfm.gfm` | ✅ |
| `logger("FetchWebpageTool")` | `utils.logger("fetch_webpage")` | ✅ |
| `this.settings.domain_denylist` | `shared.domain_denylist` | ✅ (shared setting — see D-2/D-8) |
| `this.settings.fetch_webpage_timeout` | `settings.fetch_webpage_timeout` | ✅ (per-extension setting — see D-2) |
| `this.settings.fetch_webpage_max_download_mb` | `settings.fetch_webpage_max_download_mb` | ✅ (per-extension setting) |
| `this.settings.fetch_webpage_max_output_chars` | `settings.fetch_webpage_max_output_chars` | ✅ (per-extension setting) |
| `isDomainBlocked()` (exported) | Inline local function in scaffold | ⚠️ See note below |
| `getNetErrorHint()` (private) | Inline local function in scaffold | ✅ (no external deps) |
| `getTurndown()` (private singleton) | Inline local function in scaffold | ✅ (no external deps) |

**Settings:** Per-extension `settings` for `fetch_webpage_timeout`, `fetch_webpage_max_download_mb`, `fetch_webpage_max_output_chars`. Shared `shared` for `domain_denylist`.

**Helper functions (3 local functions to inline):**

1. **`getTurndown()`** (~27 lines) — Lazy-initialized Turndown singleton with ATX headings, fenced code, GFM plugin, and custom rules. Singleton pattern translates to accepting re-creation per invocation (<1ms, negligible).

2. **`isDomainBlocked()`** (~36 lines) — Parses URL hostname, checks against denylist patterns. **Exported** and consumed by `web-search.ts` and `dispatcher.ts`. **Resolution:** Recommended to add `utils.isDomainBlocked` to `ExtensionUtils` — avoids duplicating ~36 lines in both scaffolds and keeps the `dispatcher.ts` import clean. **This is the only migration blocker** — the dispatcher dependency must be resolved before the class file can be deleted.

3. **`getNetErrorHint()`** (~60 lines including the `CHROMIUM_NET_ERROR_HINTS` map) — Maps Chromium `net::ERR_*` error codes to human-readable strings. Private, no external consumers.

**Tricky patterns:**

1. **Timeout via `Promise.race`** — `requestUrl()` has no native timeout. Straightforward to replicate.
2. **Diagnostic fetch probe** — On `requestUrl` failure, probes with native `fetch()` HEAD. Both globals are available in scaffold context.
3. **Body byte-length check** — Uses `new TextEncoder().encode(response.text).length`. `TextEncoder` is a browser global.
4. **Turndown singleton recreation** — Accept re-creation per invocation. <1ms, negligible.

**Scaffold code (estimated ~200 lines):**
```ts
const log = utils.logger("fetch_webpage");
// --- helpers (inlined) ---
// initTurndown() — ~20 lines
// CHROMIUM_NET_ERROR_HINTS map + getNetErrorHint() — ~50 lines
// isDomainBlocked() — ~35 lines (or use utils.isDomainBlocked if added)
// --- main logic ---
// URL validation, denylist check, fetch with timeout race,
// error diagnostics, MIME handling, Turndown conversion,
// output truncation — ~95 lines
```

**YAML fence:**
```yaml
params:
  url:
    type: string
    description: "URL of the webpage to fetch."
settings:
  fetch_webpage_timeout:
    name: "Request Timeout"
    type: number
    description: "Timeout in seconds for HTTP requests."
    default: 15
    min: 1
    max: 120
  fetch_webpage_max_download_mb:
    name: "Max Download Size (MB)"
    type: number
    description: "Maximum response body size in megabytes."
    default: 5
    min: 1
    max: 50
  fetch_webpage_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters returned to the LLM. Longer content is truncated."
    default: 50000
    min: 1000
    max: 500000
```

**Decision: Add `utils.isDomainBlocked`.**
- `utils.isDomainBlocked(url: string, denylist: string[]): { blocked: true; pattern: string } | { blocked: false }` — avoids duplicating ~36 lines in both `fetch_webpage` and `web_search` scaffolds, and keeps the `dispatcher.ts` import clean. The function is extracted from `src/tools/fetch-webpage.ts` into a standalone utility and wired through `buildUtils()` in `runtime-context.ts`. The `dispatcher.ts:16` import is updated to use the extracted utility.

**Risk: Turndown singleton recreation (low).** <1ms per invocation. Acceptable.

---

## `web_search` — Feasibility: Moderate ✅

**Source:** `src/tools/web-search.ts` (303 lines total, ~280 lines of logic)

**What the built-in class does:**
1. Validates `query` param
2. Clamps `num_results` to 1–10, defaulting to `settings.web_search_default_num_results`
3. POSTs to DuckDuckGo HTML endpoint via `obsidian.requestUrl()`
4. Implements timeout via `Promise.race`
5. Parses HTML via browser-native `DOMParser`
6. Decodes DuckDuckGo redirect URLs via `cleanDDGUrl()`
7. Filters parsed results against domain denylist
8. Formats output as numbered markdown list

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `requestUrl` | `obsidian.requestUrl` | ✅ |
| `logger("WebSearchTool")` | `utils.logger("web_search")` | ✅ |
| `this.settings.web_search_timeout` | `settings.web_search_timeout` | ✅ (per-extension setting) |
| `this.settings.web_search_default_num_results` | `settings.web_search_default_num_results` | ✅ (per-extension setting) |
| `this.settings.domain_denylist` | `shared.domain_denylist` | ✅ (shared setting) |
| `isDomainBlocked()` (imported from fetch-webpage.ts) | `utils.isDomainBlocked` (recommended expansion) | ⚠️ Same expansion as fetch_webpage |
| `DOMParser` (browser global) | `DOMParser` (global in Electron renderer) | ✅ (see R-5) |

**Settings:** Per-extension `settings` for `web_search_timeout` (default 10), `web_search_default_num_results` (default 5). Shared `shared` for `domain_denylist`.

**Helper functions (2 local functions to inline):**

1. **`cleanDDGUrl()`** (~16 lines) — Decodes DuckDuckGo redirect URLs. Pure function.
2. **`parseDDGResults()`** (~28 lines) — DOMParser-based HTML parsing with CSS selectors.

**`isDomainBlocked` dependency:** Same cross-cutting concern as `fetch_webpage`. Resolved by the same `utils.isDomainBlocked` addition. Unlike `fetch_webpage`, the dispatcher does **not** have a pre-dispatch denylist check for `web_search`.

**Tricky patterns:**

1. **`DOMParser` availability** — Uses browser-native `new DOMParser()` with `text/html` mime type. Available in Electron's renderer process. NOT the same as `libs.xmldom`.
2. **CSS selector fragility** — Relies on DDG-specific CSS classes. Existing code already has a selector drift warning.

**Scaffold code (estimated ~130 lines):**
```ts
const log = utils.logger("web_search");
// --- helpers (inlined) ---
// cleanDDGUrl(raw) — ~16 lines
// parseDDGResults(html, maxResults) — ~28 lines
// --- main logic ---
// num_results clamping, timeout race, requestUrl POST to DDG,
// HTTP status check, parse, selector drift warning,
// domain denylist filter via utils.isDomainBlocked,
// markdown formatting — ~65 lines
```

**YAML fence:**
```yaml
params:
  query:
    type: string
    description: "Search query string."
  num_results:
    type: number
    description: "Number of results to return. Defaults to 5. Maximum 10."
    default: 5
settings:
  web_search_timeout:
    name: "Request Timeout"
    type: number
    description: "Maximum time in seconds to wait for search results before aborting."
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
```

**Comparison with spec's complexity estimate:** The spec classifies `web_search` as "Complex" at 200-400 lines. The scaffold is ~130 lines — below estimate. Simpler than `fetch_webpage` (no Turndown, no diagnostic probe, no error hint map).

---

## `read_file` — Feasibility: Moderate ✅

**Source:** `src/tools/read-file.ts` (272 lines total, ~182 lines of execute logic)

**What the built-in class does:**
1. Validates `path` param, desktop-only guard, path validation
2. Reads raw buffer, binary detection (null bytes in first 8 KB)
3. **Image branch** (PNG/JPEG/GIF/WebP): 50 MB limit, `processImage()`, returns `content_blocks`
4. **PDF branch**: 50 MB limit, `processPdf()`, returns `content_blocks`
5. **Other binary**: rejects (directs to `read_docx` for Word docs)
6. **Text files**: decodes with specified encoding

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` | `obsidian.Platform` | ⚠️ Planned |
| `libs.fs` | `libs.fs` | ⚠️ Planned (D-3) |
| `resolveAndValidatePath` | `utils.resolveAndValidatePath(path)` | ✅ |
| `detectMediaFormat` | `utils.detectMediaFormat(buf)` | ⚠️ Planned (runtime-context.ts) |
| `processImage` | `utils.processImage(buf, mediaType, opts)` | ⚠️ Planned |
| `processPdf` | `utils.processPdf(buf, opts)` | ⚠️ Planned (injects `active_provider` and `pdf_native_max_size_mb` internally) |

**Settings:** Per-extension `settings` for `image_max_dimension`, `image_compression_quality`, `pdf_prefer_native`, `pdf_text_max_chars`, `pdf_native_max_size_mb`. Shared `shared` for `read_file_allowed_paths` (consumed implicitly by `utils.resolveAndValidatePath()`).

**Key pattern: `content_blocks` return shape.** This tool is one of the few that returns `content_blocks` (multi-modal content blocks for images and PDFs) alongside a `result` string. The scaffold must return an object with both `result` and `content_blocks` keys. **Must verify** that `UserToolAdapter.execute()` correctly forwards `content_blocks` from the returned object to the final `ToolResult`.

**Scaffold code (estimated ~100 lines):**
```ts
const log = utils.logger("read_file");
// Param validation, path validation, file existence check
// Read buffer, binary detection
// Image branch: utils.detectMediaFormat → utils.processImage → return { result, content_blocks }
// PDF branch: utils.processPdf → return { result, content_blocks }
// Other binary: throw error
// Text: return buf.toString(encoding)
```

**YAML fence:**
```yaml
params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  encoding:
    type: string
    description: "File encoding. Default: utf-8."
    default: "utf-8"
  pages:
    type: string
    description: "Page range for PDF files (e.g. '1-5', '3', '10-20'). Ignored for non-PDF files."
settings:
  image_max_dimension:
    name: "Image Max Dimension"
    type: number
    description: "Maximum width or height in pixels. Images larger than this are resized proportionally."
    default: 2000
    min: 100
    max: 8000
  image_compression_quality:
    name: "Image Compression Quality"
    type: number
    description: "JPEG compression quality (1-100)."
    default: 80
    min: 1
    max: 100
  pdf_prefer_native:
    name: "Prefer Native PDF"
    type: boolean
    description: "Send PDFs as native document blocks when supported by the provider."
    default: true
  pdf_text_max_chars:
    name: "PDF Max Text Characters"
    type: number
    description: "Maximum characters to extract from PDF text content."
    default: 100000
    min: 1000
    max: 1000000
  pdf_native_max_size_mb:
    name: "PDF Native Max Size (MB)"
    type: number
    description: "Maximum PDF file size in MB for native document block processing."
    default: 10
    min: 1
    max: 100
```

**No new `utils` expansions needed beyond what's already planned.** All three media utilities are specified in the runtime-context.ts changes section.

**Risk: `content_blocks` passthrough in `UserToolAdapter` (medium).** Must verify the adapter handles this correctly during implementation.

**Risk: `pdf_native_max_size_mb` behavior change (medium, documented as R-2).** This migration wires the setting through for the first time, fixing an existing bug.

**Comparison with spec's complexity estimate:** The scaffold is ~100 lines — well below the 200-400 line estimate, because all media processing is delegated to `utils`.

---

## `search_vault` — Feasibility: Moderate ✅

**Source:** `src/tools/search-vault.ts` (355 lines total, ~250 lines of logic)

**What the built-in class does:**
1. Validates `query` param, parses/clamps defaults
2. Compiles `query` as RegExp with `/gm` flags
3. Collects candidate files via glob filtering
4. Builds backlink count map from `metadataCache.resolvedLinks`
5. Iterates candidates, reads via `cachedRead()`, searches line-by-line
6. Caps matches per file at 10, exposes `total_match_count`
7. Resets `regex.lastIndex` between files
8. Sorts by `match_count`, `backlinks`, or `modified`
9. Applies file-level pagination
10. Returns structured `SearchResult` object

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `app.vault.getFiles()` | `app.vault.getFiles()` | ✅ |
| `app.vault.cachedRead(file)` | `app.vault.cachedRead(file)` | ✅ |
| `app.metadataCache.resolvedLinks` | `app.metadataCache.resolvedLinks` | ✅ |
| `TFile` | `obsidian.TFile` | ✅ |
| `logger("SearchVaultTool")` | `utils.logger("search_vault")` | ✅ |

**Settings:** None.

**Helper functions (5 to inline):**

1. **`getCandidateFiles(searchPath, filePattern)`** (~25 lines) — Filters `app.vault.getFiles()` by path prefix and glob.
2. **`matchesGlob(filename, pattern)`** (~12 lines) — Simple glob-to-regex conversion.
3. **`getBacklinkCounts()`** (~13 lines) — Single O(n) pass over `resolvedLinks`.
4. **`sortFileResults(results, sortBy)`** (~16 lines) — Comparison logic.
5. **`searchFile(content, regex, contextLines)`** (~35 lines) — Line-by-line search with context windows.

**Total inlined helper size:** ~100 lines. Combined with main orchestration (~50 lines), the scaffold is ~150 lines.

**Scaffold code (estimated ~150 lines):**
```ts
const log = utils.logger("search_vault");
const MAX_MATCHES_PER_FILE = 10;
// Param parsing and regex compilation
// Helper functions (matchesGlob, searchFile, etc.)
// Main search loop with cachedRead
// Sort and paginate
// Return { total_matches, total_files, files }
```

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  query:
    type: string
    description: "Regex pattern or text string to search for"
  path:
    type: string
    description: "Directory to search within, relative to vault root."
    default: ""
    path_namespace: vault
  context_lines:
    type: number
    description: "Number of surrounding lines to include with each match."
    default: 3
  file_pattern:
    type: string
    description: "Glob pattern to filter which files to search."
    default: "*.md"
  sort_by:
    type: string
    description: "Sort order for results: 'match_count', 'backlinks', or 'modified'."
    enum:
      - match_count
      - backlinks
      - modified
    default: "match_count"
  limit:
    type: number
    description: "Maximum number of files to return."
    default: 20
  offset:
    type: number
    description: "Number of files to skip for pagination."
    default: 0
```

**No new `utils` expansions needed.** No `libs` or `obsidian` imports needed beyond `TFile`.

**Risk: Regex `lastIndex` statefulness (low).** The `/g` flag makes RegExp stateful — scaffold preserves both resets (per-line and per-file).

**Comparison with spec's complexity estimate:** The spec classifies `search_vault` as "Complex" at 200-400 lines. The actual scaffold is ~150 lines — lower than estimated because all helpers are pure procedural code with zero dependencies.

---

## `read_docx` — Feasibility: Moderate ✅

**Source:** `src/tools/read-docx.ts` (286 lines total, ~210 lines of logic)

**What the built-in class does:**
1. Validates `path`, desktop-only guard, path validation, `.docx` extension check
2. Reads file buffer
3. Builds a mammoth image extraction handler (`mammothImages.imgElement()`) that:
   - Skips unsupported formats (EMF, WMF, SVG, TIFF)
   - For supported formats: reads buffer, MD5 hash for dedup, resolves attachment path, saves to vault
   - Tags each image with marker src for post-processing
4. Converts DOCX → HTML via `mammoth.convertToHtml()`
5. Builds Turndown instance with custom `replaceImages` rule mapping markers back to vault paths
6. Converts HTML → Markdown

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` | `obsidian.Platform` | ⚠️ Planned |
| `libs.fs` | `libs.fs` | ⚠️ Planned (D-3) |
| `libs.path` | `libs.path` | ⚠️ Planned (D-3) |
| `libs.crypto` | `libs.crypto` | ⚠️ Planned (D-3) |
| `mammoth` (default + `images`) | `libs.mammoth` | ✅ — `libs.mammoth.images.imgElement()` works |
| `TurndownService` | `libs.Turndown` | ✅ |
| `gfm` plugin | `libs.turndownGfm.gfm` | ✅ |
| `resolveAndValidatePath` | `utils.resolveAndValidatePath(path)` | ✅ |

**Settings:** None per-extension. Uses `shared.read_file_allowed_paths` implicitly via `utils.resolveAndValidatePath()`.

**Key patterns:**

1. **`mammoth.images.imgElement()` callback** — Async callback using `app.fileManager.getAvailablePathForAttachment()` and `app.vault.createBinary()`. Standard Obsidian APIs. ~45 lines of callback logic — the most complex part.

2. **`mammoth` named export access** — `libs.mammoth.images.imgElement()` via default export (confirmed in `src/mammoth.d.ts:26`).

3. **Turndown with custom rule** — Fresh instance per invocation with image map closure.

**Scaffold code (estimated ~160 lines):**
The full scaffold is provided in the assessment — it's a direct 1:1 port with mammoth image extraction callback, Turndown conversion, and marker-based image replacement.

**No new `utils` expansions needed.** Unlike `write_docx`, this tool does NOT use `docx-image-utils.ts` — image extraction is handled by mammoth's callback API.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute."
    path_namespace: filesystem
```

**Risk: `mammoth.images` access via default export (low).** Confirmed interchangeable with named export.

**Risk: `HTMLElement` type in Turndown rule (low).** Standard DOM API available in Electron.

**Comparison with spec's complexity estimate:** The spec classifies `read_docx` as "Complex" at 200-400 lines. The scaffold is ~160 lines — more accurately "Medium-Complex".
