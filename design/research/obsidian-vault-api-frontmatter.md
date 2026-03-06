# Research: Obsidian Vault API and Frontmatter Handling

**Research ID:** R-3
**Created:** 2026-06-03
**Status:** Complete
**Blocks:** Phase 1 (`write_note` — FR-8, `replace_in_note` — FR-9)
**Source:** [obsidian.d.ts (master)](https://raw.githubusercontent.com/obsidianmd/obsidian-api/refs/heads/master/obsidian.d.ts)

---

## Table of Contents

1. [Vault Write API Surface](#1-vault-write-api-surface)
2. [Vault Read API Surface](#2-vault-read-api-surface)
3. [Metadata Cache and Frontmatter](#3-metadata-cache-and-frontmatter)
4. [processFrontMatter API](#4-processfrontmatter-api)
5. [Atomic Operations (vault.process)](#5-atomic-operations-vaultprocess)
6. [File Events](#6-file-events)
7. [Frontmatter Utility Functions](#7-frontmatter-utility-functions)
8. [Frontmatter Preservation Strategy](#8-frontmatter-preservation-strategy)
9. [Implementation Recommendations](#9-implementation-recommendations)
10. [Minimum Version Requirements](#10-minimum-version-requirements)
11. [Risks and Limitations](#11-risks-and-limitations)

---

## 1. Vault Write API Surface

### `vault.create(path, data, options?): Promise<TFile>`

- **Since:** 0.9.7
- **Behavior:** Creates a new plaintext file at the given path with the provided string content. The `data` parameter is the _entire file content_, including any frontmatter.
- **If file already exists:** The type definition does not include an `@throws` annotation for `create` on existing files (unlike `createBinary` which explicitly says "throws Error if file already exists"). However, `createBinary` _does_ throw on conflict, so `create` likely does too or silently overwrites. **Safest assumption:** check existence before calling `create`; use `modify` for existing files.
- **Frontmatter awareness:** None. The `data` string is written verbatim — there is no special frontmatter handling.

### `vault.modify(file, data, options?): Promise<void>`

- **Since:** 0.9.7
- **Behavior:** Overwrites the _entire_ content of an existing plaintext file. The `data` string replaces everything in the file, including frontmatter.
- **Frontmatter awareness:** None. If frontmatter exists and `data` does not include it, the frontmatter is destroyed.
- **Atomic:** Not explicitly documented as atomic. A partial write on failure is theoretically possible at the filesystem level, though Obsidian's `DataAdapter` layer likely mitigates this.

### `vault.append(file, data, options?): Promise<void>`

- **Since:** 0.13.0
- **Behavior:** Appends text to the end of a file. Does not affect frontmatter (appends after all existing content).
- **Relevant for:** Not directly useful for `write_note` or `replace_in_note`, but useful for logging or append-only operations.

### `DataWriteOptions`

```typescript
interface DataWriteOptions {
  ctime?: number;  // Creation time (unix ms)
  mtime?: number;  // Modification time (unix ms)
}
```

Optional metadata to set custom timestamps. Omitting preserves default behavior.

---

## 2. Vault Read API Surface

### `vault.read(file): Promise<string>`

- **Since:** 0.9.7
- **Behavior:** Reads the full plaintext content of a file directly from disk. Returns the **entire file including frontmatter**.
- **Use when:** You intend to modify the file afterward (ensures you have the latest disk content, not a cached version).
- **No frontmatter exclusion:** There is no parameter or mode to exclude frontmatter. The full file string is always returned.

### `vault.cachedRead(file): Promise<string>`

- **Since:** 0.9.7
- **Behavior:** Returns the file content from Obsidian's internal cache. Faster than `vault.read` but may return slightly stale content.
- **Use when:** Display-only purposes where you don't plan to modify the file.
- **Returns:** Full file content including frontmatter, same as `vault.read`.

### Frontmatter Exclusion at Read Time

The Obsidian vault API does **not** support reading a file without frontmatter. Our `read_note` tool's `include_frontmatter` parameter must be implemented in our code by:

1. Reading the full file content via `vault.read(file)`
2. Using `getFrontMatterInfo(content)` to locate the frontmatter boundaries
3. Stripping the frontmatter block from the returned string when `include_frontmatter` is `false`

---

## 3. Metadata Cache and Frontmatter

### `MetadataCache` (class, since 0.9.7+)

Obsidian maintains a metadata cache that indexes all files in the vault. It provides **parsed** frontmatter without requiring a full file read.

#### Key methods:

| Method | Since | Description |
|--------|-------|-------------|
| `getFileCache(file: TFile): CachedMetadata \| null` | 0.9.21 | Returns cached metadata for a file |
| `getCache(path: string): CachedMetadata \| null` | 0.14.5 | Same, by path string |

#### `CachedMetadata` interface:

```typescript
interface CachedMetadata {
  links?: LinkCache[];
  embeds?: EmbedCache[];
  tags?: TagCache[];
  headings?: HeadingCache[];
  sections?: SectionCache[];
  listItems?: ListItemCache[];
  frontmatter?: FrontMatterCache;        // Parsed frontmatter as key-value
  frontmatterPosition?: Pos;             // Exact position in the file (since 1.4.0)
  frontmatterLinks?: FrontmatterLinkCache[];  // Links found in frontmatter (since 1.4.0)
  blocks?: Record<string, BlockCache>;
  footnotes?: FootnoteCache[];           // since 1.6.6
  footnoteRefs?: FootnoteRefCache[];     // since 1.8.7
  referenceLinks?: ReferenceLinkCache[]; // since 1.8.7
}
```

#### `FrontMatterCache` interface:

```typescript
interface FrontMatterCache {
  [key: string]: any;  // Arbitrary key-value pairs
}
```

This is the parsed YAML frontmatter as a JS object. The metadata cache provides this **without** requiring a full file read.

**Important:** The metadata cache is read-only. You cannot write frontmatter through it — it's only an index. Changes to frontmatter must be made through `vault.modify`, `vault.process`, or `fileManager.processFrontMatter`.

### Cache Events:

| Event | Description |
|-------|-------------|
| `'changed'` | Fired when a file's cache is updated after modification. Callback: `(file, data, cache)` |
| `'deleted'` | Fired when a file is deleted. Callback: `(file, prevCache)` |
| `'resolve'` | Fired when a file's links have been resolved |
| `'resolved'` | Fired when all files have been resolved (after initial load and after each modification) |

**Note:** The `'changed'` event is _not_ fired on file rename (for performance). Use `vault.on('rename', ...)` for that.

---

## 4. `processFrontMatter` API

### `fileManager.processFrontMatter(file, fn, options?): Promise<void>`

- **Since:** 1.4.4
- **Location:** `app.fileManager.processFrontMatter(...)`
- **Behavior:** Atomically reads, modifies, and saves the frontmatter of a Markdown note. The body content of the note is **preserved untouched**. Only the YAML frontmatter block is affected.

#### Signature:

```typescript
processFrontMatter(
  file: TFile,
  fn: (frontmatter: any) => void,  // Mutate the object directly
  options?: DataWriteOptions
): Promise<void>;
```

#### Usage Example:

```typescript
app.fileManager.processFrontMatter(file, (frontmatter) => {
  frontmatter['key1'] = value;        // Add or update
  delete frontmatter['key2'];         // Remove
});
```

#### Key characteristics:

| Property | Detail |
|----------|--------|
| **Atomic** | Reads, modifies, and writes in one operation |
| **Body-safe** | Note body content is never touched |
| **Creates frontmatter** | If the note has no frontmatter block, one is created |
| **Parsed YAML** | The callback receives a JS object, not raw YAML text |
| **Throws on YAML error** | Throws `YAMLParseError` if existing frontmatter is malformed |
| **Throws callback errors** | Propagates any errors thrown in the callback |
| **Synchronous callback** | The `fn` callback must be synchronous (no async) |
| **Minimum version** | 1.4.4 |

#### Relevance to Notor tools:

| Tool | Recommended API |
|------|----------------|
| `update_frontmatter` (Phase 2) | Use `processFrontMatter` directly — perfect fit |
| `manage_tags` (Phase 2) | Use `processFrontMatter` to manipulate `frontmatter.tags` array |
| `read_frontmatter` (Phase 2) | Use `metadataCache.getFileCache(file)?.frontmatter` for reads (faster, no disk I/O) |

---

## 5. Atomic Operations (`vault.process`)

### `vault.process(file, fn, options?): Promise<string>`

- **Since:** 1.1.0
- **Behavior:** Atomically reads, transforms, and saves the entire file content. The callback receives the full file content (including frontmatter) and must return the new content synchronously.

#### Signature:

```typescript
process(
  file: TFile,
  fn: (data: string) => string,  // Return new content
  options?: DataWriteOptions
): Promise<string>;
```

#### Usage Example:

```typescript
app.vault.process(file, (data) => {
  return data.replace('Hello', 'World');
});
```

#### Key characteristics:

| Property | Detail |
|----------|--------|
| **Atomic** | Read + transform + write in one operation; prevents race conditions |
| **Full content** | Operates on the entire file string, including frontmatter |
| **Returns written content** | The promise resolves with the string that was written |
| **Synchronous callback** | The `fn` callback must be synchronous |
| **Minimum version** | 1.1.0 |

#### Relevance to Notor tools:

| Tool | Recommended use of `vault.process` |
|------|-------------------------------------|
| `replace_in_note` | **Primary implementation path** — read content, apply search/replace blocks, return modified content. Atomicity prevents race conditions with concurrent edits. |
| `write_note` | Not ideal (vault.process requires existing file). Use `vault.create` for new files, `vault.modify` for existing files. |

---

## 6. File Events

### Vault Events

| Event | Callback Signature | Trigger |
|-------|-------------------|---------|
| `'create'` | `(file: TAbstractFile) => any` | File created. Also fired for each file on vault first load (use `workspace.onLayoutReady` to skip). |
| `'modify'` | `(file: TAbstractFile) => any` | File content modified |
| `'delete'` | `(file: TAbstractFile) => any` | File deleted |
| `'rename'` | `(file: TAbstractFile, oldPath: string) => any` | File renamed or moved |

### Metadata Cache Events

| Event | Callback Signature | Trigger |
|-------|-------------------|---------|
| `'changed'` | `(file: TFile, data: string, cache: CachedMetadata) => any` | File indexed and cache updated (not fired on rename) |
| `'deleted'` | `(file: TFile, prevCache: CachedMetadata \| null) => any` | File deleted from cache |
| `'resolve'` | `(file: TFile) => any` | File's links resolved |
| `'resolved'` | `() => any` | All files resolved |

### Event sequence for a file modification:

1. `vault.on('modify')` — fires immediately when file is written
2. `metadataCache.on('changed')` — fires after Obsidian re-indexes the file (may be asynchronous/debounced)
3. `metadataCache.on('resolve')` — fires after links in the file are resolved
4. `metadataCache.on('resolved')` — fires after all files' links are resolved

**Implication for stale-content checks:** After a `vault.modify` call, the metadata cache update is _not_ synchronous. If our tool dispatch needs to validate cache state immediately after a write, there may be a brief window where the cache is stale. For most cases this is not a problem because our stale-content check compares raw file content (via `vault.read`), not cached metadata.

---

## 7. Frontmatter Utility Functions

The Obsidian API provides several utility functions for working with frontmatter:

### `getFrontMatterInfo(content: string): FrontMatterInfo`

Parses a file content string and returns positional information about the frontmatter block:

```typescript
interface FrontMatterInfo {
  exists: boolean;       // Whether frontmatter exists
  frontmatter: string;   // Raw frontmatter string
  from: number;          // Start of frontmatter contents (excluding ---)
  to: number;            // End of frontmatter contents (excluding ---)
  contentStart: number;  // Offset where body content begins (after closing ---)
}
```

**Use case:** Implementing `read_note` with `include_frontmatter: false` — use `contentStart` to strip frontmatter from the returned content.

### Frontmatter Parsing Helpers

| Function | Returns | Description |
|----------|---------|-------------|
| `parseFrontMatterTags(frontmatter)` | `string[] \| null` | Extract tags array from frontmatter object |
| `parseFrontMatterAliases(frontmatter)` | `string[] \| null` | Extract aliases array |
| `parseFrontMatterEntry(frontmatter, key)` | `any \| null` | Get a specific key (supports regex) |
| `parseFrontMatterStringArray(frontmatter, key)` | `string[] \| null` | Get a string array by key (supports regex) |
| `getAllTags(cache: CachedMetadata)` | `string[] \| null` | Get all tags (frontmatter + inline) from cache |

These accept the `frontmatter` object from `CachedMetadata.frontmatter` (i.e., `FrontMatterCache`), not raw YAML strings.

---

## 8. Frontmatter Preservation Strategy

### The Problem

The `write_note` tool replaces entire file content. If the LLM previously read the note with `include_frontmatter: false`, the LLM does not have the frontmatter text. A naive `vault.modify(file, llmContent)` would destroy existing frontmatter.

### Recommended Strategy: Read-Before-Write with Frontmatter Merge

When `write_note` is called on an existing file:

1. **Read the current file content** via `vault.read(file)`
2. **Parse frontmatter boundaries** using `getFrontMatterInfo(currentContent)`
3. **Parse frontmatter boundaries in new content** using `getFrontMatterInfo(newContent)`
4. **Apply merge logic:**

| Existing Frontmatter? | New Content Has Frontmatter? | Action |
|------------------------|------------------------------|--------|
| No | No | Write `newContent` directly |
| No | Yes | Write `newContent` directly (LLM is adding frontmatter) |
| Yes | Yes | Write `newContent` directly (LLM is intentionally replacing frontmatter) |
| **Yes** | **No** | **Prepend existing frontmatter block to `newContent`** |

5. **Write the merged content** via `vault.modify(file, mergedContent)`

This is the safest approach because:
- It preserves frontmatter when the LLM did not intend to modify it
- It allows the LLM to explicitly modify frontmatter if it includes it
- It handles the common case of `read_note(include_frontmatter=false)` → edit → `write_note` without data loss

### For `replace_in_note`:

No special handling needed. `replace_in_note` operates on substring matches, so:
- If the LLM read without frontmatter, the search/replace blocks won't reference frontmatter text
- The `vault.process` callback operates on the full file (including frontmatter), and only the matched portions are replaced
- Frontmatter is inherently preserved because unmatched content is untouched

### For Phase 2 Frontmatter Tools:

- `update_frontmatter` → Use `processFrontMatter` directly (purpose-built for this)
- `manage_tags` → Use `processFrontMatter` and manipulate `frontmatter.tags`
- `read_frontmatter` → Use `metadataCache.getFileCache(file)?.frontmatter` (no disk I/O)

---

## 9. Implementation Recommendations

### `read_note` Implementation

```typescript
async function readNote(path: string, includeFrontmatter: boolean): Promise<string> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`Note not found: ${path}`);
  if (!(file instanceof TFile)) throw new Error(`Path is not a file: ${path}`);

  const content = await app.vault.read(file);

  if (includeFrontmatter) {
    return content;
  }

  const fmInfo = getFrontMatterInfo(content);
  if (!fmInfo.exists) {
    return content;
  }

  // Strip frontmatter, return body only (trim leading newline)
  return content.slice(fmInfo.contentStart).replace(/^\n/, '');
}
```

### `write_note` Implementation

```typescript
async function writeNote(path: string, newContent: string): Promise<void> {
  const existingFile = app.vault.getFileByPath(path);

  if (!existingFile) {
    // Create new file (with intermediate directories)
    await app.vault.create(path, newContent);
    return;
  }

  // Read existing content for frontmatter preservation
  const existingContent = await app.vault.read(existingFile);
  const existingFm = getFrontMatterInfo(existingContent);
  const newFm = getFrontMatterInfo(newContent);

  let finalContent: string;

  if (existingFm.exists && !newFm.exists) {
    // Preserve existing frontmatter: prepend it to new content
    const frontmatterBlock = existingContent.slice(0, existingFm.contentStart);
    finalContent = frontmatterBlock + newContent;
  } else {
    // All other cases: use new content as-is
    finalContent = newContent;
  }

  await app.vault.modify(existingFile, finalContent);
}
```

### `replace_in_note` Implementation

```typescript
async function replaceInNote(
  path: string,
  changes: Array<{ search: string; replace: string }>
): Promise<number> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`Note not found: ${path}`);

  const result = await app.vault.process(file, (data) => {
    let modified = data;
    for (const change of changes) {
      const idx = modified.indexOf(change.search);
      if (idx === -1) {
        throw new Error(`Search block did not match: "${change.search.slice(0, 80)}..."`);
      }
      modified =
        modified.slice(0, idx) +
        change.replace +
        modified.slice(idx + change.search.length);
    }
    return modified;
  });

  return changes.length;
}
```

**Note:** `vault.process` is atomic — if the callback throws (e.g., search block not found), no changes are written to disk. This provides the "all-or-nothing" atomicity required by the `replace_in_note` contract.

### Phase 2: `update_frontmatter` Implementation

```typescript
async function updateFrontmatter(
  path: string,
  set?: Record<string, unknown>,
  remove?: string[]
): Promise<void> {
  const file = app.vault.getFileByPath(path);
  if (!file) throw new Error(`Note not found: ${path}`);

  await app.fileManager.processFrontMatter(file, (frontmatter) => {
    if (set) {
      for (const [key, value] of Object.entries(set)) {
        frontmatter[key] = value;
      }
    }
    if (remove) {
      for (const key of remove) {
        delete frontmatter[key];
      }
    }
  });
}
```

### Phase 2: `read_frontmatter` Implementation

```typescript
function readFrontmatter(path: string): Record<string, any> {
  const cache = app.metadataCache.getCache(path);
  if (!cache?.frontmatter) return {};

  // Clone to avoid exposing cache internals
  const { position, ...frontmatter } = cache.frontmatter;
  return frontmatter;
}
```

**Note:** `FrontMatterCache` includes a `position` property (inherited from `CacheItem`) that should be stripped before returning to the LLM.

---

## 10. Minimum Version Requirements

| API | Minimum Version | Currently Required |
|-----|----------------|--------------------|
| `vault.create`, `vault.modify`, `vault.read` | 0.9.7 | — |
| `vault.append` | 0.13.0 | — |
| `vault.process` | 1.1.0 | ← Required for atomic `replace_in_note` |
| `metadataCache.getCache(path)` | 0.14.5 | — |
| `CachedMetadata.frontmatterPosition` | 1.4.0 | — |
| `fileManager.processFrontMatter` | 1.4.4 | ← Required for Phase 2 frontmatter tools |
| `vault.getFileByPath` | 1.5.7 | — |
| `getFrontMatterInfo` | Not version-annotated | — |

**Recommendation:** Our `minAppVersion` is already being bumped to **1.11.4** (per R-1 findings for `SecretStorage`). All vault and frontmatter APIs needed are available well below this threshold. No additional version bump is needed for R-3.

---

## 11. Risks and Limitations

### Risk: Race condition between read and write

If another process (user, sync, or another plugin) modifies a file between our `vault.read` and `vault.modify`, we could overwrite their changes.

**Mitigation:** Use `vault.process` for `replace_in_note` (atomic). For `write_note`, our stale-content check (comparing current content against last-read content) provides protection.

### Risk: Frontmatter merge edge cases

The frontmatter preservation logic (prepend existing frontmatter when LLM content lacks it) could produce unexpected results if:
- The LLM intentionally deleted all frontmatter (we'd restore it)
- The frontmatter YAML is malformed

**Mitigation:** This is an acceptable trade-off. Accidental frontmatter destruction (common) is far more damaging than accidental frontmatter preservation (rare). The LLM can explicitly clear frontmatter by including an empty `---\n---\n` block.

### Risk: `vault.process` callback errors

If the callback throws inside `vault.process`, no changes are written. This is actually desirable behavior for `replace_in_note` (atomic all-or-nothing), but errors must be caught and reported cleanly.

**Mitigation:** Wrap `vault.process` in try/catch and map errors to user-friendly tool result messages.

### Limitation: No native frontmatter exclusion on read

The vault API always returns full file content. Frontmatter stripping must be done in our code.

**Impact:** Minimal — `getFrontMatterInfo` is available and efficient.

### Limitation: `processFrontMatter` callback is synchronous

The callback passed to `processFrontMatter` cannot be async. All frontmatter modifications must be synchronous.

**Impact:** Minimal for our use cases. Frontmatter updates are simple key/value operations.

### Limitation: `DataAdapter.write` overwrites or creates

At the adapter level, `write` explicitly states: "If the file exists its content will be overwritten, otherwise the file will be created." The higher-level `vault.create` and `vault.modify` provide better semantics (create-only vs. modify-existing), and should be preferred.

---

## Summary of Answers to Research Questions

| # | Question | Answer |
|---|----------|--------|
| 1 | `vault.create` behavior | Writes entire file content as provided. Likely throws if file already exists (based on `createBinary` behavior). No frontmatter awareness. |
| 2 | `vault.modify` behavior | Overwrites entire file content. No frontmatter-aware mode. |
| 3 | `vault.read` behavior | Returns full file including frontmatter. No exclusion option. |
| 4 | Metadata cache frontmatter | `metadataCache.getFileCache(file)?.frontmatter` provides parsed frontmatter as a JS object. Read-only; cannot write through cache. |
| 5 | `processFrontMatter` API | `app.fileManager.processFrontMatter(file, fn)` — atomic read/modify/write of frontmatter only. Body content preserved. Since 1.4.4. |
| 6 | Frontmatter preservation | **Read-before-write with merge:** If existing file has frontmatter and new content doesn't, prepend existing frontmatter. For `replace_in_note`, frontmatter is inherently preserved by `vault.process`. |
| 7 | Atomic writes | `vault.process` provides atomic read-modify-write. `vault.modify` is not explicitly atomic. |
| 8 | File events | `vault.on('create'\|'modify'\|'delete'\|'rename')` and `metadataCache.on('changed'\|'deleted'\|'resolve'\|'resolved')`. Cache update is asynchronous after write. |