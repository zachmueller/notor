# search_vault Obsidian Search Syntax — Implementation Tasks

Companion to: [search-vault-obsidian-syntax-design.md](search-vault-obsidian-syntax-design.md)

**Target file:** `src/extensions/builtin-tool-scaffolds.ts` — the `SEARCH_VAULT` scaffold (lines 131–322)

All new code lives inline in the scaffold code body (the 5th argument to `scaffold()`). No changes to `runtime-context.ts` or other files outside the scaffold definition. Type annotations (`interface`, `type`) are stripped by Sucrase at compile time.

---

## Phase 1 — Query Parser

Build the tokenizer/parser that converts a raw query string into a `ParsedQuery` structure. This is pure string processing with no Obsidian API calls, so it can be written and mentally verified in isolation.

- [ ] **1.1 Define filter type annotations**
  - Add `TagFilter`, `PropertyExistsFilter`, `PropertyValueFilter` interfaces and the `QueryFilter` union type inside the code body (Sucrase strips these at compile time — no runtime cost)
  - Add `ParsedQuery` interface with `contentQuery: string | null` and `filterGroups: QueryFilter[][]`

- [ ] **1.2 Implement `escapeRegex(str)` helper**
  - Single-line function: `str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`
  - Used to convert quoted phrase content into regex-safe literals
  - Place near the top of the helpers section alongside existing `matchesGlob()`

- [ ] **1.3 Implement `parseQuery(raw)` tokenizer**
  - Character-by-character scanner following the algorithm in the design doc (section "Tokenization algorithm")
  - State tracking: `tokens` array, `currentText` accumulator, `inQuotes` flag, `quoteBuffer`
  - Sub-tasks:
    - [ ] **1.3a — Quoted string handling**: On `"`, toggle `inQuotes`. When closing a quote, regex-escape `quoteBuffer` via `escapeRegex()` and append to `currentText`. Unmatched quote at end-of-input: treat opening `"` as literal, append `quoteBuffer` un-escaped
    - [ ] **1.3b — `tag:` operator extraction**: Detect `tag:` prefix (optionally preceded by `-` for negation). Read value until whitespace. Strip leading `#` and lowercase the value. Emit `TagFilter`
    - [ ] **1.3c — `[property]` / `[property:value]` extraction**: Detect `[` (optionally preceded by `-`). Read until `]`. Split on first `:` to get key and optional value. Handle `[prop:"quoted value"]` by stripping inner quotes. Emit `PropertyExistsFilter` or `PropertyValueFilter`
    - [ ] **1.3d — `OR` keyword handling**: Detect uppercase `OR` surrounded by whitespace. Mark the next filter as OR-chained with the previous one. Lowercase `or`/`Or`/`oR` fall through as content text
    - [ ] **1.3e — Content text accumulation**: Anything not matching an operator accumulates into `currentText`. Trim at the end; `null` if empty
    - [ ] **1.3f — OR grouping logic**: After all tokens are collected, group OR-connected filters into sub-arrays within `filterGroups`. Non-OR filters each get their own single-element group (AND semantics between groups)

- [ ] **1.4 Validate parsed query**
  - After parsing, check that at least one filter or non-empty `contentQuery` exists
  - Throw descriptive error if query is entirely empty (matches current behavior for missing `query`)

- [ ] **1.5 Edge case handling**
  - Empty quotes `""` produce no content text
  - `"nested "quotes" here"` — first `"` opens, second closes, then `quotes` is content, `"here"` is another quoted phrase
  - `[status:"in progress"]` — inner quotes stripped, value = `in progress`
  - `[nested[bracket]]` — find first `]`, best-effort parse

---

## Phase 2 — Metadata Matching

Build the functions that evaluate parsed filters against Obsidian's metadata cache. These use `app.metadataCache.getFileCache(file)` — the same API used by the existing `read_frontmatter` scaffold (line ~459 in builtin-tool-scaffolds.ts).

- [ ] **2.1 Implement `getFileTags(file)` helper**
  - Call `app.metadataCache.getFileCache(file)` to get `CachedMetadata`
  - Collect frontmatter tags: `cache.frontmatter?.tags` (array or CSV string) and `cache.frontmatter?.tag` (singular alias)
  - Collect inline tags: `cache.tags` array of `TagCache` objects (each has `.tag` property like `#work`)
  - Normalize all: strip leading `#`, trim, lowercase
  - Return `Set<string>` for O(1) lookup

- [ ] **2.2 Implement `checkProperty(file, key, value?)` helper**
  - Get frontmatter via `app.metadataCache.getFileCache(file)?.frontmatter`
  - **Exists check** (`[key]`): return `key in frontmatter` (but exclude `position` key)
  - **Value check** (`[key:value]`): compare `String(frontmatter[key]).toLowerCase() === value.toLowerCase()`. For array values (e.g., `tags: [a, b]`), check if any element matches
  - **Null check** (`[key:null]`): key exists AND value is `null`, `undefined`, or empty string `""`
  - Return `boolean`

- [ ] **2.3 Implement `matchesFilterGroups(file, filterGroups)` function**
  - For each group in `filterGroups`: at least one filter in the group must match (OR within group)
  - All groups must pass (AND between groups)
  - For each filter, evaluate based on type:
    - `tag` → check `getFileTags(file).has(filter.value)`
    - `property_exists` → `checkProperty(file, filter.key)`
    - `property_value` → `checkProperty(file, filter.key, filter.value)`
  - Apply negation: if `filter.negated`, invert the result
  - Return `boolean`

---

## Phase 3 — Scaffold Integration

Wire the parser and metadata matching into the existing `search_vault` scaffold flow. This phase modifies the scaffold definition (description, YAML params, and code body).

### 3.1 — Tool description and parameter updates

- [ ] **3.1a Update scaffold description string** (line 133)
  - Change from `"Search across notes in the vault using regex or text patterns."` to the expanded description from the design doc that documents the supported operators

- [ ] **3.1b Update `query` parameter**: make optional with `default: null`
  - In the YAML params block: add `default: null` under `query`
  - Update `query` description to reference Obsidian search syntax, operators, and exact-phrase matching

- [ ] **3.1c Rename `file_pattern` → `file`** in YAML params block
  - Change the param name from `file_pattern:` to `file:`
  - Keep description, type, and default (`"*.md"`) the same

### 3.2 — Code body changes

- [ ] **3.2a Update parameter extraction**
  - Change `const query = params.query as string;` → `const rawQuery = (params.query as string | null) ?? null;`
  - Change `const filePattern = ((params.file_pattern as string) ?? "*.md").trim();` → `const filePattern = ((params.file as string) ?? "*.md").trim();`
  - Remove the existing `if (!query || typeof query !== "string")` guard — validation now handled by `parseQuery()`

- [ ] **3.2b Call `parseQuery()` at the top of main logic**
  - Parse `rawQuery` into `ParsedQuery` with `contentQuery` and `filterGroups`
  - Validate: if `rawQuery` is null/empty and no operators found, throw error

- [ ] **3.2c Move regex compilation inside content-query branch**
  - Only compile `new RegExp(contentQuery, "gm")` when `contentQuery` is not null
  - Quoted content is already regex-escaped by the parser, so it compiles safely
  - Unquoted content remains raw regex (backward-compatible); keep the existing try/catch for invalid regex

- [ ] **3.2d Update `getCandidateFiles()` to apply metadata pre-filters**
  - Add `filterGroups` parameter to `getCandidateFiles()`
  - After existing path/glob filtering, apply `matchesFilterGroups(file, filterGroups)` to each candidate
  - This filters out non-matching files before any content I/O — performance optimization

- [ ] **3.2e Update main search loop for metadata-only queries**
  - When `contentQuery` is null: skip `cachedRead()` and `searchFile()` entirely
  - Emit each candidate file with `match_count: 0`, `total_match_count: 0`, `matches: []`
  - Still include `backlink_count` and `modified` metadata in results

- [ ] **3.2f Update default sort behavior**
  - When `contentQuery` is null and `sortBy` is `"match_count"` (the default), override to `"modified"`
  - Rationale: `match_count` sorting is meaningless when all files have 0 matches

- [ ] **3.2g Update log statements**
  - Update the initial `log.debug("Searching vault", ...)` to include filter information
  - Update the completion `log.debug("Search complete", ...)` to reflect metadata-filtered counts

---

## Phase 4 — E2E Testing

Write a dedicated E2E test script that validates the new search operators end-to-end inside Obsidian. Follows the pattern of existing test scripts in `e2e/scripts/`.

### 4.1 — Test vault setup

- [ ] **4.1a Add test notes with controlled frontmatter/tags to `VAULT_NOTES`**
  - Extend the existing vault notes in `e2e/scripts/tool-interaction-test.ts` (or the dedicated new test script's setup)
  - Notes needed (from design doc testing section):
    - `Notes/Draft Post.md` — `status: draft`, `tags: [blog, tech]`, `priority: high`, content about programming
    - `Notes/Published Post.md` — `status: published`, `tags: [blog, travel]`, `priority: low`, content about travel
    - `Notes/No Frontmatter.md` — plain content with `#inline-tag`, no frontmatter
  - Ensure notes have enough distinct properties to test AND/OR/negation combinations

### 4.2 — Write E2E test script

- [ ] **4.2a Create `e2e/scripts/search-vault-metadata-test.ts`**
  - Follow the existing test harness pattern (import from `e2e/lib/test-harness.ts`)
  - Set up vault with the test notes from 4.1a
  - Use `sendMessage()` to issue search queries via the LLM and verify tool calls + results

- [ ] **4.2b Tag filter tests**
  - `tag:blog` → returns Draft + Published (both have `blog` tag)
  - `tag:blog tag:tech` → returns only Draft (AND semantics)
  - `tag:blog OR tag:travel` → returns Draft + Published (OR semantics)
  - `tag:nonexistent` → empty results
  - `tag:#blog` → same as `tag:blog` (# prefix optional)

- [ ] **4.2c Property filter tests**
  - `[status:draft]` → returns Draft only
  - `[status]` → returns Draft + Published (both have status property)
  - `[status:null]` → returns nothing (both have non-null status values)
  - `tag:blog [priority:high]` → returns Draft only (AND: tag + property)

- [ ] **4.2d Negation tests**
  - `-tag:blog [status]` → returns nothing (both matching-status notes have blog tag)
  - `-[status:done]` → returns all notes with status (none are "done")

- [ ] **4.2e Exact phrase matching tests**
  - `"meeting notes"` → exact phrase match in content
  - `"foo.*bar"` → matches literal `foo.*bar`, not regex
  - `tag:#work "exact phrase"` → tag filter + exact phrase content match

- [ ] **4.2f Edge case tests**
  - `"tag:#blog"` (quoted) → content search for literal text `tag:#blog`, not a tag filter
  - `tag:#work or tag:#personal` → lowercase `or` is content text, not OR operator
  - `AND tag:#work` → `AND` is content text + tag filter
  - Empty query → error
  - `""` (empty quotes) → error (no operator or content)
  - `"unclosed quote` → unmatched quote treated as literal content

- [ ] **4.2g Parameter rename test**
  - Verify `file` param (renamed from `file_pattern`) correctly filters by glob pattern

---

## Phase 5 — Polish and Documentation

Final cleanup after all functionality is implemented and tested.

- [ ] **5.1 Review code body size and readability**
  - The code body grows from ~150 to ~300+ lines — ensure it remains well-organized
  - Group helpers logically: parser functions, metadata functions, existing search functions
  - Verify all inline type annotations are Sucrase-compatible (no `enum`, no `namespace`)

- [ ] **5.2 Verify backward compatibility**
  - Plain text queries behave exactly as before (no operators detected → pure regex search)
  - Regex queries with special characters still work (e.g., `\d+`, `foo|bar`)
  - Existing `path` and `sort_by` parameters still function correctly
  - `file` param works identically to old `file_pattern`

- [ ] **5.3 Move design doc to `specs/ZZ-misc/done/`**
  - After implementation is fully verified, move `search-vault-obsidian-syntax-design.md` to `specs/ZZ-misc/done/`
