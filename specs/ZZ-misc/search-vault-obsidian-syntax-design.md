# search_vault Obsidian Search Syntax — Design Doc

## Motivation

Notor's `search_vault` tool currently supports regex/text content search across vault notes with filtering by path and file glob pattern. However, it has no ability to filter notes by **frontmatter properties** or **tags** — two of the most common ways users organize their vaults.

Rather than adding separate parameters (`tags`, `frontmatter_filters`), we adopt **Obsidian's native search syntax** within the existing `query` parameter. This:

- Aligns with a syntax users already know from Obsidian's built-in Search plugin
- Keeps the tool interface simple (no new parameters)
- Enables composable queries: `tag:#work [status:active] meeting notes`
- Gives the LLM a well-documented query language to reference

**Key constraint:** Obsidian's search API does NOT expose its query parser publicly. The available APIs (`prepareFuzzySearch`, `prepareSimpleSearch`) only do simple text matching. We must implement our own parser for the operator syntax.

---

## Supported Operators (Phase 1)

From [Obsidian's search syntax](https://help.obsidian.md/Plugins/Search), implement the operators most useful for LLM-driven vault queries:

| Operator | Example | Behavior |
|----------|---------|----------|
| `tag:` | `tag:#work`, `tag:blog` | Match notes with this tag (frontmatter + inline). `#` prefix optional. |
| `[property]` | `[status]` | Match notes that have this frontmatter property |
| `[property:value]` | `[status:draft]` | Match notes where property equals value (case-insensitive) |
| `[property:null]` | `[status:null]` | Match notes where property exists but has no value |
| `-` (negation) | `-tag:#archive`, `-[status:done]` | Exclude notes matching the operator |
| `OR` | `tag:#work OR tag:#personal` | Match either side (disjunction) |

Content text (anything not matching an operator) is passed to the existing regex search engine unchanged.

### Not implementing in Phase 1

These can be added later if needed:

| Operator | Reason to defer |
|----------|----------------|
| `file:`, `path:` | Already covered by existing `path` and `file_pattern` params |
| `line:`, `block:`, `section:` | Complex positional matching, lower priority |
| `task:`, `task-todo:`, `task-done:` | Niche use case |
| `content:` | Redundant — bare text already does content search |
| `match-case:`, `ignore-case:` | Niche |
| `[duration:<5]` (comparison operators) | Complex value parsing |

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Parser location | Inline in scaffold code body | Scaffold already has ~5 helper functions. Avoids touching runtime-context.ts. Downside: not independently unit-testable, but covered by E2E. |
| Query parameter | Keep existing, make optional with `default: null` | When only operators are provided (no content text), skip regex search. Error if query is entirely empty. |
| Operator extraction | Token-based parser | Scan query string, extract `tag:X` and `[...]` tokens, collect remaining text as content query. |
| Tag matching | Frontmatter `tags`/`tag` + inline `TagCache[]` | Covers both tag sources. Normalize: strip `#`, lowercase. |
| Property matching | `metadataCache.getFileCache(file).frontmatter` | Fast — no file I/O. Already used by `read_frontmatter` tool. |
| Value comparison | Case-insensitive string | `String(value).toLowerCase()`. Array frontmatter values: check if any element matches. |
| Filter composition | AND between filters, OR within OR-groups | Matches Obsidian's semantics: `tag:#a tag:#b` = AND; `tag:#a OR tag:#b` = OR. |
| Metadata filter timing | Pre-filter in `getCandidateFiles()` | Applied before content read, avoiding unnecessary I/O for non-matching notes. |
| Sort default | `modified` when no content query | `match_count` is meaningless when all matches have count 0. |

---

## Query Parser Design

### Input/Output

```
Input:  "tag:#work [status:active] meeting notes"
Output: {
  contentQuery: "meeting notes",
  filters: [
    { type: "tag", value: "work", negated: false },
    { type: "property_value", key: "status", value: "active", negated: false }
  ]
}
```

### Token types

```typescript
interface TagFilter {
  type: "tag";
  value: string;     // normalized: no #, lowercase
  negated: boolean;
}

interface PropertyExistsFilter {
  type: "property_exists";
  key: string;
  negated: boolean;
}

interface PropertyValueFilter {
  type: "property_value";
  key: string;
  value: string;     // "null" for null checks
  negated: boolean;
}

type QueryFilter = TagFilter | PropertyExistsFilter | PropertyValueFilter;

interface ParsedQuery {
  contentQuery: string | null;  // null = pure metadata search
  filterGroups: QueryFilter[][]; // OR within group, AND between groups
}
```

### Tokenization algorithm

```
1. Initialize: tokens = [], current_text = ""
2. Scan character by character:
   a. If inside quotes → accumulate until closing quote
   b. If "-" followed by "tag:" or "[" → set negated flag, continue
   c. If "tag:" prefix → read value (until whitespace or quote-delimited) → emit TagFilter
   d. If "[" → read until "]", parse key:value or key-only → emit PropertyFilter
   e. If "OR" (case-sensitive, surrounded by whitespace) → mark next filter as OR-chained with previous
   f. Otherwise → accumulate as content text
3. Trim accumulated content text → contentQuery (or null if empty)
4. Group OR-connected filters together into filterGroups
```

### OR grouping logic

Filters connected by `OR` form a group where at least one must match. Separate groups are AND-ed.

```
Example: "tag:#work OR tag:#personal [status:active]"
→ filterGroups: [
    [tag:work, tag:personal],   // OR group — at least one must match
    [property:status=active]    // AND group — must match
  ]
```

A file matches if ALL groups pass, where a group passes if ANY filter in it matches (accounting for negation).

### Edge cases

| Input | Parsing |
|-------|---------|
| `tag:#work` | 1 TagFilter, no content |
| `tag:work` | Same (# optional) |
| `"tag:#work"` | Content text `tag:#work` (quoted = literal) |
| `[status]` | PropertyExistsFilter |
| `[status:draft]` | PropertyValueFilter |
| `[status:null]` | PropertyValueFilter with null semantics |
| `[status:"in progress"]` | PropertyValueFilter, value = `in progress` |
| `-tag:#archive` | Negated TagFilter |
| `-[status:done]` | Negated PropertyValueFilter |
| `tag:#a OR tag:#b OR tag:#c` | Single OR group with 3 tags |
| `tag:#a OR tag:#b tag:#c` | OR group [a, b] AND tag:c |
| `just plain text` | No filters, contentQuery = `just plain text` |
| `tag:#work meeting notes` | 1 TagFilter + contentQuery `meeting notes` |
| Empty string | Error: at least one operator or content term required |
| `[nested[bracket]]` | Best-effort: find first `]`, key = `nested[bracket` (or error) |

---

## Metadata Matching

### Tag collection

Collect all tags from a file using `metadataCache.getFileCache(file)`:

1. **Frontmatter tags:** `cache.frontmatter.tags` (array or string) and `cache.frontmatter.tag` (singular alias)
2. **Inline tags:** `cache.tags` (array of `TagCache` objects with `.tag` property)
3. Normalize all: strip leading `#`, trim, lowercase
4. Store in a `Set<string>` for O(1) lookup

### Property matching

Using `cache.frontmatter`:

- **`[key]`** (exists): `key in frontmatter` (excluding the `position` metadata key)
- **`[key:value]`**: Compare `String(frontmatter[key]).toLowerCase() === value.toLowerCase()`. For array values, check if any element matches.
- **`[key:null]`**: Key exists AND value is `null`, `undefined`, or empty string `""`

### Filter evaluation

```
function matchesFilterGroups(file, filterGroups):
  for each group in filterGroups:
    groupPasses = false
    for each filter in group:
      result = evaluateFilter(file, filter)
      if filter.negated: result = !result
      if result: groupPasses = true; break
    if !groupPasses: return false
  return true
```

---

## Scaffold Changes

### Tool description update

```
"Search across notes in the vault. Supports Obsidian search operators in the query:
tag:#name (filter by tag), [property] (has property), [property:value] (match value),
[property:null] (empty property), -operator (negate), OR (disjunction between operators).
Text not matching an operator is used as a regex content search. Operators and content
can be combined: 'tag:#work [status:active] meeting notes' finds notes tagged #work
with status=active containing 'meeting notes'."
```

### Query param update

Change `query` from required to optional (`default: null`). Update description:

```
"Search query supporting Obsidian search syntax: tag:#name, [property],
[property:value], [property:null], -operator (negate), OR. Text not matching
an operator is searched as regex against note content. At least one operator
or content term required."
```

### Code body changes

1. Parse query at the top → `ParsedQuery`
2. Validate: at least one filter or content query
3. Move regex compilation inside content-query branch
4. Update `getCandidateFiles` to accept and apply metadata pre-filters
5. In main loop: skip content search when `contentQuery` is null; emit files with `match_count: 0`
6. Default sort to `modified` when no content query

### Helper functions to add

- `parseQuery(raw)` — tokenizer + parser → `ParsedQuery`
- `matchesFilterGroups(file, filterGroups)` — evaluate all filter groups against a file
- `getFileTags(file)` — collect + normalize all tags from a file
- `checkProperty(file, key, value)` — evaluate a single property filter

---

## Example Queries

| Query | Behavior |
|-------|----------|
| `meeting notes` | Content regex for "meeting notes" (backward-compatible) |
| `tag:#work` | All notes tagged `#work`, no content search |
| `tag:#work meeting` | Notes tagged `#work` containing "meeting" |
| `[status:draft]` | Notes with frontmatter `status: draft` |
| `[status:draft] tag:#blog` | Notes with `status: draft` AND tag `#blog` |
| `-tag:#archive [status]` | Notes with a `status` property, NOT tagged `#archive` |
| `tag:#work OR tag:#personal` | Notes tagged `#work` OR `#personal` |
| `[priority:high] important` | Notes with `priority: high` containing "important" |
| `[due:null]` | Notes where `due` property exists but has no value |
| `tag:#project [status:active] OR [status:review]` | Notes tagged `#project` with status `active` or `review` |

---

## Testing

### E2E test (`e2e/scripts/search-vault-metadata-test.ts`)

Set up vault notes with known frontmatter/tags:

```markdown
# Notes/Draft Post.md
---
status: draft
tags: [blog, tech]
priority: high
---
Content about programming.

# Notes/Published Post.md
---
status: published
tags: [blog, travel]
priority: low
---
Content about travel.

# Notes/No Frontmatter.md
Just plain content with #inline-tag.
```

**Test cases:**
1. `tag:blog` → returns Draft + Published
2. `tag:blog tag:tech` → returns only Draft (AND)
3. `tag:blog OR tag:travel` → returns Draft + Published
4. `[status:draft]` → returns Draft only
5. `tag:blog [priority:high]` → returns Draft only
6. `-tag:blog [status]` → returns nothing (both have blog tag)
7. `tag:#blog programming` → returns Draft only (tag + content)
8. `tag:nonexistent` → empty results
9. Empty query → error
10. `"tag:#blog"` (quoted) → content search for literal `tag:#blog`
11. `#inline-tag` treated as content search (no `tag:` prefix)

---

## Migration / Backward Compatibility

All existing queries remain backward-compatible:

- Plain text queries → no operators detected → behaves exactly as before
- Regex queries → no operators detected → behaves exactly as before
- The only breaking edge case: a query like `tag:something` that was previously treated as a regex pattern `tag:something` will now be parsed as a tag operator. This is unlikely to be a real-world issue since `tag:` is not meaningful as a content regex.

---

## Future Extensions

- **`file:` / `path:`** — supplement existing params with in-query filtering
- **Comparison operators** — `[priority:>3]`, `[due:<2024-01-01]`
- **Nested tags** — `tag:#work/projects` matching `#work/projects` and descendants
- **`section:` / `block:`** — positional matching within document structure
- **`task:` / `task-todo:` / `task-done:`** — task-specific search
