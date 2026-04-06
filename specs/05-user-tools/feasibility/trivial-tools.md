# Feasibility Assessment: Trivial Tools

Tools with minimal dependencies, no settings, and direct 1:1 ports from built-in classes. Good candidates for early implementation to validate the pipeline end-to-end.

**Tools covered:** `read_frontmatter`, `get_backlinks`, `get_outlinks`, `write_file`, `update_frontmatter`, `read_note`, `manage_tags`

---

## `read_frontmatter` — Feasibility: Trivial ✅

**Source:** `src/tools/read-frontmatter.ts` (95 lines total, ~50 lines of logic)

**What the built-in class does:**
1. Validates `path` param exists and is a string
2. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)`
3. Reads frontmatter from `this.app.metadataCache.getFileCache(file)`
4. If no frontmatter, returns `{ success: true, result: {} }` (empty object, not an error)
5. Clones frontmatter via destructuring, strips the internal `position` key
6. Returns the cleaned frontmatter object

**Dependencies:**
| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.metadataCache` | `app.metadataCache` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `logger("ReadFrontmatterTool")` | `utils.logger("read_frontmatter")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed.

**Return value mapping:**
- The built-in returns `result: {}` (empty object) when no frontmatter exists, and `result: frontmatter` (object) on success. The `UserToolAdapter.execute()` return-value mapper (manager.ts:106-113) handles objects correctly — `typeof returnValue === "object"` passes through as-is. Returning a plain object from the scaffold will produce `{ success: true, result: { ...frontmatter } }`.
- For errors, the scaffold throws (adapter catches and wraps in `{ success: false, error }`).

**Scaffold code (estimated ~20 lines):**
```ts
const log = utils.logger("read_frontmatter");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Reading frontmatter", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

const cache = app.metadataCache.getFileCache(file);
if (!cache?.frontmatter) {
  log.debug("No frontmatter found", { path: params.path });
  return {};
}

const { position: _, ...frontmatter } = cache.frontmatter;
log.info("Read frontmatter", { path: params.path, keyCount: Object.keys(frontmatter).length });
return frontmatter;
```

**No new `utils` expansions needed.** All dependencies are already exposed.

**No `libs` or `obsidian` imports needed.** Pure `app` + `utils` usage.

**Risk:** Effectively zero. This is the simplest possible migration — synchronous cache read, no settings, no file I/O, no external libraries. Good candidate for the first scaffold implementation to validate the pipeline end-to-end.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
```

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence.

---

## `get_backlinks` — Feasibility: Trivial ✅

**Source:** `src/tools/get-backlinks.ts` (82 lines total, ~40 lines of logic)

**What the built-in class does:**
1. Validates `path` param exists and is a string
2. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)`
3. Iterates `this.app.metadataCache.resolvedLinks` (reverse-lookup) to find all source files whose resolved links include the target path
4. Filters out self-links (source === target)
5. Returns a newline-separated list of backlink paths, or `"(none)"` if empty

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.metadataCache.resolvedLinks` | `app.metadataCache.resolvedLinks` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `logger("GetBacklinksTool")` | `utils.logger("get_backlinks")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed.

**Return value mapping:**
- The built-in returns a plain-text string as `result`. In the scaffold, returning a string directly is handled by `UserToolAdapter.execute()` — `typeof returnValue === "string"` passes through as-is into `{ success: true, result: string }`.
- For errors, the scaffold throws (adapter catches and wraps in `{ success: false, error }`).

**Scaffold code (estimated ~20 lines):**
```ts
const log = utils.logger("get_backlinks");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Getting backlinks", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

// Reverse-lookup: find all source files whose resolvedLinks include the target.
// Self-links are filtered out.
const targetPath = file.path;
const backlinks: string[] = [];
for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
  if (sourcePath !== targetPath && targetPath in links) {
    backlinks.push(sourcePath);
  }
}

log.debug("Got backlinks", { path: file.path, count: backlinks.length });

return backlinks.length > 0 ? backlinks.join("\n") : "(none)";
```

**No new `utils` expansions needed.** All dependencies are already exposed.

**No `libs` or `obsidian` imports needed.** Pure `app` + `utils` usage.

**Risk:** Effectively zero. Nearly identical structure to `get_outlinks` — synchronous in-memory cache iteration, no settings, no file I/O, no external libraries. The only difference is that `get_backlinks` does a reverse-lookup (iterates all entries in `resolvedLinks` looking for targets) while `get_outlinks` does a forward-lookup (reads `resolvedLinks[path]` directly). Both are O(n) over vault files but purely in-memory.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
```

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence.

**Comparison with spec's complexity estimate:** The spec classifies `get_backlinks` as "Simple" at 40-100 lines and estimates ~35 lines. The scaffold is ~20 lines — below estimate. The simplest of the trivial tools alongside `read_frontmatter`.

---

## `get_outlinks` — Feasibility: Trivial ✅

**Source:** `src/tools/get-outlinks.ts` (84 lines total, ~45 lines of logic)

**What the built-in class does:**
1. Validates `path` param exists and is a string
2. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)`
3. Reads `this.app.metadataCache.resolvedLinks[file.path]` — object mapping target paths to link counts for links whose targets exist in the vault
4. Reads `this.app.metadataCache.unresolvedLinks[file.path]` — object mapping link text to counts for links whose targets do NOT exist
5. Filters out self-links from resolved links
6. Formats two sections: `Resolved:` (newline-separated paths or `(none)`) and `Unresolved:` (newline-separated link names or `(none)`)
7. Returns the combined plain-text string

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.metadataCache.resolvedLinks` | `app.metadataCache.resolvedLinks` | ✅ |
| `this.app.metadataCache.unresolvedLinks` | `app.metadataCache.unresolvedLinks` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `logger("GetOutlinksTool")` | `utils.logger("get_outlinks")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed.

**Return value mapping:**
- The built-in returns a plain-text string as `result`. In the scaffold, returning a string directly is handled by `UserToolAdapter.execute()` — `typeof returnValue === "string"` passes through as-is into `{ success: true, result: string }`.
- For errors, the scaffold throws (adapter catches and wraps in `{ success: false, error }`).

**Scaffold code (estimated ~25 lines):**
```ts
const log = utils.logger("get_outlinks");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Getting outlinks", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

const resolvedMap = app.metadataCache.resolvedLinks[file.path] ?? {};
const unresolvedMap = app.metadataCache.unresolvedLinks[file.path] ?? {};

// Filter out self-links
const resolvedPaths = Object.keys(resolvedMap).filter((p) => p !== file.path);
const unresolvedLinkNames = Object.keys(unresolvedMap);

log.debug("Got outlinks", {
  path: file.path,
  resolved: resolvedPaths.length,
  unresolved: unresolvedLinkNames.length,
});

const resolvedSection = resolvedPaths.length > 0 ? resolvedPaths.join("\n") : "(none)";
const unresolvedSection = unresolvedLinkNames.length > 0 ? unresolvedLinkNames.join("\n") : "(none)";
return `Resolved:\n${resolvedSection}\n\nUnresolved:\n${unresolvedSection}`;
```

**No new `utils` expansions needed.** All dependencies are already exposed.

**No `libs` or `obsidian` imports needed.** Pure `app` + `utils` usage.

**Risk:** Effectively zero. Nearly identical structure to `read_frontmatter` — synchronous in-memory cache read, no settings, no file I/O, no external libraries. The only difference is two cache lookups (`resolvedLinks` + `unresolvedLinks`) instead of one, and a self-link filter. Direct 1:1 port of the class logic.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
```

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence.

---

## `write_file` — Feasibility: Trivial ✅

**Source:** `src/tools/write-file.ts` (173 lines total, ~95 lines of logic)

**What the built-in class does:**
1. Validates `path` and `content` params exist and are strings
2. Desktop-only guard via `Platform.isDesktopApp`
3. Gets vault root path from `app.vault.adapter.basePath`
4. Validates path via `resolveAndValidatePath(path, vaultRoot, settings.read_file_allowed_paths)`
5. Checks content size against 5 MB cap
6. Creates intermediate directories via `fs.promises.mkdir(dirname(resolvedPath), { recursive: true })`
7. Writes file via `fs.promises.writeFile(resolvedPath, content, { encoding })`
8. Returns success message with path and character count

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform.isDesktopApp` | `obsidian.Platform.isDesktopApp` | ⚠️ Planned (spec runtime-context.ts changes) |
| `import * as fs from "fs"` | `libs.fs` | ⚠️ Planned (spec D-3) |
| `import { dirname } from "path"` | `libs.path.dirname` | ⚠️ Planned (spec D-3) |
| `resolveAndValidatePath(path, vaultRoot, allowedPaths)` | `utils.resolveAndValidatePath(path)` | ✅ |
| `this.settings.read_file_allowed_paths` | `shared.read_file_allowed_paths` | ✅ (shared setting — see D-2/D-8) |
| `logger("WriteFileTool")` | `utils.logger("write_file")` | ✅ |

**Settings:** No per-extension settings. Uses `shared.read_file_allowed_paths` (cross-tool, declared via built-in shared settings scaffold — see D-8). The shared setting is passed implicitly through `utils.resolveAndValidatePath()` which defaults to `plugin.settings.read_file_allowed_paths` when no explicit `allowedPaths` argument is provided (see runtime-context.ts:85-89). The scaffold can simply call `utils.resolveAndValidatePath(path)` with no second argument.

**Return value mapping:**
- Success → return string (`"Successfully wrote file: {path} ({n} characters)"`) — adapter wraps in `{ success: true, result: string }`
- Validation/write failures → throw — adapter wraps in `{ success: false, error }`

**Helper functions:** One private method:
1. **`getVaultRootPath()`** (~4 lines) — Extracts `basePath` from `app.vault.adapter`. In the scaffold, this is a one-liner: `const vaultRoot = (app.vault.adapter as any).basePath`. No need for a function.

**Scaffold code (estimated ~40 lines):**
```ts
const log = utils.logger("write_file");

if (!params.path || typeof params.path !== "string" || params.path.trim() === "") {
  throw new Error("Missing required parameter: path");
}
if (params.content === undefined || params.content === null || typeof params.content !== "string") {
  throw new Error("Missing required parameter: content");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("write_file is only available on desktop.");
}

const vaultRoot = (app.vault.adapter as any).basePath;
if (!vaultRoot) throw new Error("Could not determine vault root path.");

const pathResult = utils.resolveAndValidatePath(params.path as string);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;
const content = params.content as string;
const encoding = (params.encoding as string) || "utf-8";

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
if (content.length > MAX_CONTENT_BYTES) {
  throw new Error("Content exceeds maximum size of 5 MB.");
}

// Create intermediate directories if they don't exist
await libs.fs.promises.mkdir(libs.path.dirname(resolvedPath), { recursive: true });

// Write the file
await libs.fs.promises.writeFile(resolvedPath, content, {
  encoding: encoding as BufferEncoding,
});

log.info("Wrote file", { path: resolvedPath, chars: content.length });
return `Successfully wrote file: ${resolvedPath} (${content.length} characters)`;
```

**No new `utils` expansions needed.** All dependencies are either already exposed (`utils.resolveAndValidatePath`, `utils.logger`) or are planned additions in the spec (`obsidian.Platform`, `libs.fs`, `libs.path`).

**Blocked on planned spec additions:**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes, shared with `execute_command`, `replace_in_file`, and other desktop-only tools)
- `libs.fs` — add to `buildLibs()` (spec D-3)
- `libs.path` — add to `buildLibs()` (spec D-3)

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  content:
    type: string
    description: "Complete text content to write to the file."
  encoding:
    type: string
    description: "File encoding."
    default: "utf-8"
```

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence.

**Risk: `vaultRoot` extraction (none).** The `(app.vault.adapter as any).basePath` pattern is used by multiple other filesystem tools (`read_file`, `replace_in_file`, `read_docx`, etc.). In the scaffold, `utils.resolveAndValidatePath(path)` already reads `vaultRoot` internally from the closure in `buildUtils()` (runtime-context.ts:71), so the scaffold only needs the explicit `vaultRoot` extraction for the null guard. This is a belt-and-suspenders check — if `basePath` is null, `resolveAndValidatePath` would also fail. However, keeping the explicit guard preserves the specific error message ("Could not determine vault root path") which is clearer than the generic path validation error.

**Risk: Content size check uses `string.length` not byte length (none — matches built-in).** The built-in class checks `content.length > MAX_CONTENT_BYTES` which compares character count against a byte limit. This is an approximation (multi-byte UTF-8 characters would exceed the byte limit at fewer characters), but the scaffold replicates the exact same behavior as the built-in. Not a regression.

**Risk: Encoding parameter (low).** The `encoding` parameter is cast to `BufferEncoding` and passed directly to `fs.promises.writeFile()`. Invalid encodings will throw at the Node.js level, which the adapter catches and wraps as `{ success: false, error }`. Same behavior as the built-in class.

**Comparison with spec's complexity estimate:** The spec classifies `write_file` as "Simple" at 40-100 lines and estimates ~50 lines. The scaffold is ~40 lines — within estimate. This is one of the simplest filesystem tools: no binary detection, no media processing, no stale tracking, no checkpoints. Linear flow: validate → resolve path → mkdir → write → return. Good candidate for early implementation alongside `read_frontmatter` to validate the filesystem tool pipeline (`libs.fs`, `libs.path`, `obsidian.Platform`).

---

## `update_frontmatter` — Feasibility: Trivial ✅

**Source:** `src/tools/update-frontmatter.ts` (150 lines total, ~85 lines of logic)

**What the built-in class does:**
1. Validates `path` param exists and is a string
2. Validates at least one of `set` or `remove` is provided
3. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)`
4. Creates a checkpoint before modifying via `this.checkpointManager?.createCheckpoint(file.path, this.name, "")`
5. Calls `this.app.fileManager.processFrontMatter(file, callback)` — atomic, body-safe update:
   - If `set` is provided: iterates entries and assigns `frontmatter[key] = value`
   - If `remove` is provided: iterates keys and `delete frontmatter[key]`
6. Builds a human-readable summary string ("set N properties, removed M properties")
7. Returns the summary as a success result

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.vault` | `app.vault` | ✅ |
| `this.app.metadataCache` | `app.metadataCache` | ✅ |
| `this.app.fileManager` | `app.fileManager` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `this.checkpointManager?.createCheckpoint()` | `utils.checkpointManager.createCheckpoint()` | ✅ |
| `logger("UpdateFrontmatterTool")` | `utils.logger("update_frontmatter")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed. Listed in the spec's "settings-free tools" group.

**Return value mapping:**
- Success → return string (e.g., `"Updated frontmatter on Research/Climate: set 2 properties, removed 1 property"`). The `UserToolAdapter.execute()` return-value mapper handles `typeof returnValue === "string"` by passing it through directly. Produces `{ success: true, result: "..." }`.
- Validation failures (missing path, no set/remove) → throw (adapter wraps in `{ success: false, error }`).
- `processFrontMatter` failure → throw (adapter wraps in `{ success: false, error }`). The built-in class has an explicit try/catch with `e instanceof Error ? e.message : String(e)` — the adapter's catch produces the same outcome.

**Scaffold code (estimated ~35 lines):**
```ts
const log = utils.logger("update_frontmatter");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

const set = params.set as Record<string, unknown> | undefined;
const remove = params.remove as string[] | undefined;

if (!set && !remove) {
  throw new Error("At least one of 'set' or 'remove' must be provided");
}

log.debug("Updating frontmatter", {
  path: params.path,
  setKeys: set ? Object.keys(set) : [],
  removeKeys: remove ?? [],
});

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

// Checkpoint before modifying
await utils.checkpointManager.createCheckpoint(file.path, "update_frontmatter", "");

await app.fileManager.processFrontMatter(file, (frontmatter: any) => {
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

const setCount = set ? Object.keys(set).length : 0;
const removeCount = remove ? remove.length : 0;
const parts: string[] = [];
if (setCount > 0) parts.push(`set ${setCount} propert${setCount === 1 ? "y" : "ies"}`);
if (removeCount > 0) parts.push(`removed ${removeCount} propert${removeCount === 1 ? "y" : "ies"}`);

log.info("Updated frontmatter", { path: params.path, setCount, removeCount });
return `Updated frontmatter on ${params.path}: ${parts.join(", ")}`;
```

**No new `utils` expansions needed.** All dependencies are already exposed in the extension runtime.

**No `libs` or `obsidian` imports needed.** Pure `app` + `utils` usage.

**YAML fence:**

The current scaffold declares `set` as `type: string` with description "JSON-encoded object of key-value pairs". However, the built-in tool's `input_schema` uses `type: "object"` with `additionalProperties: true`. This is a behavioral difference — the scaffold forces the LLM to JSON-encode the object as a string, while the built-in allows Claude to pass a native object.

The param schema mapper (`paramSchemaToJsonSchema()` in `param-schema.ts:52-53`) passes through arbitrary `type` values to JSON Schema, so `type: object` in YAML produces `{ type: "object" }` in the JSON Schema sent to the LLM. JSON Schema defaults `additionalProperties` to `true` when unspecified, so the LLM will be able to pass arbitrary key-value pairs. The `additionalProperties: true` in the built-in is technically redundant.

**Recommended YAML fence (updated from current scaffold to match built-in behavior):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  set:
    type: object
    description: "Key-value pairs to add or update in the frontmatter."
    default: null
  remove:
    type: "string[]"
    description: "List of frontmatter keys to remove."
    default: null
```

Note: `set` changes from `type: string` → `type: object` to match the built-in's schema. Both `set` and `remove` use `default: null` to keep them out of `required[]`, with the at-least-one-of validation in the tool body.

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. The `set` param type changes from `string` to `object` and both optional params get `default: null`. No `settings:` section in the YAML fence.

**Checkpoint handling:** The built-in class calls `this.checkpointManager?.createCheckpoint()` with optional chaining because the constructor accepts `CheckpointManager | undefined`. In the extension runtime, `utils.checkpointManager` is always defined (set in `buildUtils()` from `plugin.getCheckpointManager()` in `runtime-context.ts:79`), so no optional chaining is needed. The checkpoint call is non-fatal — if `createCheckpoint` itself throws, it should not block the frontmatter update. The scaffold should wrap the checkpoint call in a try/catch to preserve the non-fatal semantics:
```ts
try {
  await utils.checkpointManager.createCheckpoint(file.path, "update_frontmatter", "");
} catch { /* non-fatal */ }
```

**Risk:** Effectively zero. This is one of the simplest write tools — a single `processFrontMatter` call with straightforward set/delete logic. No settings, no external libraries, no filesystem I/O, no complex helpers. The only notable detail is the `set` param type correction and the optional-param-as-default-null pattern. Good candidate for early implementation alongside `read_frontmatter` and `manage_tags` (all three use `processFrontMatter` / `metadataCache.getFileCache`).

**Comparison with spec's complexity estimate:** The spec classifies `update_frontmatter` as "Simple" at 40-100 lines and estimates ~60 lines. The scaffold is ~35 lines — below estimate. The built-in class's 150 lines include the class boilerplate, `input_schema` declaration, explicit `ToolResult` construction, and verbose error handling — all absorbed by the adapter in the extension runtime.

---

## `read_note` — Feasibility: Trivial ✅

**Source:** `src/tools/read-note.ts` (147 lines total, ~85 lines of logic)

**What the built-in class does:**
1. Validates `path` param exists and is a string
2. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)`
3. Guards against non-markdown files (`file.extension !== "md"`)
4. Reads full content via `this.app.vault.read(file)` (not `cachedRead`, since the result feeds the stale tracker)
5. Strips YAML frontmatter by default using `getFrontMatterInfo(fullContent)` — trims the leading `\n` after the closing `---`
6. Records the **full** content (not stripped) to `this.staleTracker.recordRead(file.path, fullContent)` using the canonical `file.path` so write tools can detect concurrent edits regardless of input path spelling
7. Opens the note in the editor via `this.noteOpener?.openNote(file.path)` if configured (`open_notes_on_access` setting)
8. Returns the (possibly stripped) content string

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.vault.read(file)` | `app.vault.read(file)` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `getFrontMatterInfo(content)` | `obsidian.getFrontMatterInfo(content)` | ✅ |
| `this.staleTracker.recordRead(path, content)` | `utils.staleTracker.recordRead(path, content)` | ✅ |
| `this.noteOpener?.openNote(path)` | `utils.noteOpener.openNote(path)` | ✅ |
| `logger("ReadNoteTool")` | `utils.logger("read_note")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed. The `open_notes_on_access` setting controls the `NoteOpener` instance's `enabled` flag, which is already resolved when `utils.noteOpener` is constructed in `runtime-context.ts` — scaffold code does not need to read it.

**Return value mapping:**
- The built-in returns a plain-text string as `result`. In the scaffold, returning a string directly is handled by `UserToolAdapter.execute()` — `typeof returnValue === "string"` passes through as-is into `{ success: true, result: string }`.
- For errors, the scaffold throws (adapter catches and wraps in `{ success: false, error }`).

**Scaffold code (estimated ~35 lines):**
```ts
const log = utils.logger("read_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Reading note", { path: params.path, includeFrontmatter: params.include_frontmatter });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

// Only allow markdown files
if (file.extension !== "md") {
  throw new Error(`Path is not a Markdown note: ${params.path}`);
}

// Use vault.read (not cachedRead) since we'll track for write operations
const fullContent = await app.vault.read(file);

let returnContent: string;

if (params.include_frontmatter) {
  returnContent = fullContent;
} else {
  const fmInfo = obsidian.getFrontMatterInfo(fullContent);
  if (fmInfo.exists) {
    // Strip frontmatter — trim the leading newline after the closing ---
    returnContent = fullContent.slice(fmInfo.contentStart).replace(/^\n/, "");
  } else {
    returnContent = fullContent;
  }
}

// Record full content (not stripped) so write tools can compare against actual file state.
// Use file.path (canonical) so stale checks work regardless of input spelling.
utils.staleTracker.recordRead(file.path, fullContent);

// Open the note in the editor if configured
await utils.noteOpener.openNote(file.path);

log.debug("Read note successfully", { path: params.path, contentLength: returnContent.length });

return returnContent;
```

**No new `utils` expansions needed.** All dependencies are already exposed in the extension runtime: `resolveNote`, `staleTracker`, `noteOpener`, `logger`.

**`obsidian` imports needed:** `getFrontMatterInfo` — already exposed via `buildObsidianExports()` in `runtime-context.ts`.

**No `libs` needed.** No external libraries, no Node.js modules.

**No settings migration needed.** This tool references zero `NotorSettings` fields. No per-extension `settings:` section in the YAML fence, no shared settings.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root. The '.md' extension is optional."
    path_namespace: vault
  include_frontmatter:
    type: boolean
    description: "Whether to include YAML frontmatter in the returned content."
    default: false
```

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence. The existing YAML fence content is already correct.

**Risk:** Effectively zero. This is a direct 1:1 port of the class logic with no edge cases or ambiguity. Every dependency is already exposed.

**Notable: stale tracker records full content, not stripped.** The scaffold must record `fullContent` (before frontmatter stripping) to `utils.staleTracker.recordRead()`, not `returnContent`. This matches the built-in's behavior — write tools compare against the actual on-disk file state, which includes frontmatter. This is called out explicitly in the scaffold code comments to prevent users who customize the tool from accidentally recording the stripped content instead.

**Notable: `noteOpener` is not optional-chained.** The built-in class uses `this.noteOpener?.openNote()` because the constructor accepts `noteOpener?: NoteOpener` (optional — undefined in unit tests). In the extension runtime, `utils.noteOpener` is always defined (constructed in `runtime-context.ts:81`). The `openNote()` method internally checks its `enabled` flag and no-ops when `open_notes_on_access` is false. No optional chaining needed in the scaffold.

**Notable: `vault.read()` not `cachedRead()`.** The built-in explicitly uses `vault.read()` rather than `vault.cachedRead()`. The scaffold preserves this choice. The stale tracker needs the true on-disk content, not a potentially stale cache. The code comment in the scaffold calls this out to prevent users from "optimizing" to `cachedRead()`.

**Comparison with spec's complexity estimate:** The spec classifies `read_note` as "Medium" at 80-280 lines and estimates ~60 lines. The scaffold is ~40 lines of logic — below estimate and at the lower bound of the "Medium" tier. This is because `read_note` is procedurally linear with no helper functions, no loops, no create-vs-update branching, and no settings. Structurally simpler than other "Medium" tools (`write_note`, `replace_in_note`, `manage_tags`, `move_note`) and closer in complexity to the "Simple" tier (`read_frontmatter`, `get_outlinks`). The "Medium" classification likely reflects its importance to the system (most-used tool, stale tracker integration) rather than raw code complexity.

---

## `manage_tags` — Feasibility: Trivial ✅

**Source:** `src/tools/manage-tags.ts` (210 lines total, ~100 lines of logic)

**What the built-in class does:**
1. Validates `path` param exists and is a string
2. Validates at least one of `add` or `remove` is provided with at least one tag
3. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)`
4. Creates checkpoint via `this.checkpointManager?.createCheckpoint(file.path, this.name, "")`
5. Calls `this.app.fileManager.processFrontMatter(file, callback)` to atomically update frontmatter
6. Inside the callback: normalises existing `tags` value (handles undefined, null, string, array), adds new tags (deduplicating), removes requested tags (gracefully skipping non-existent)
7. If resulting tags array is empty, deletes the `tags` key from frontmatter entirely
8. Builds a human-readable summary string (`"Tags updated on {path}: added [...], removed [...]"` or `"Tags unchanged..."`)
9. Returns the summary string as the tool result

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.fileManager.processFrontMatter(file, cb)` | `app.fileManager.processFrontMatter(file, cb)` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `this.checkpointManager?.createCheckpoint()` | `utils.checkpointManager.createCheckpoint()` | ✅ |
| `logger("ManageTagsTool")` | `utils.logger("manage_tags")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed.

**Return value mapping:**
- The built-in returns a `ToolResult` object with `tool_name`, `success`, `result`, `error`. In the scaffold, returning a plain string is handled by `UserToolAdapter.execute()` — `typeof returnValue === "string"` passes through as-is into `{ success: true, result: string }`.
- For errors, the scaffold returns `{ success: false, error: "..." }` directly (the adapter recognizes object return values).

**Scaffold code (estimated ~60 lines):**
```ts
const log = utils.logger("manage_tags");

if (!params.path || typeof params.path !== "string") {
  return { success: false, error: "Missing required parameter: path" };
}

const add = params.add as string[] | undefined;
const remove = params.remove as string[] | undefined;

if ((!add || add.length === 0) && (!remove || remove.length === 0)) {
  return { success: false, error: "At least one of 'add' or 'remove' must be provided with at least one tag" };
}

log.debug("Managing tags", { path: params.path, add: add ?? [], remove: remove ?? [] });

const file = utils.resolveNote(params.path);
if (!file) return { success: false, error: `Note not found: ${params.path}` };

// Create checkpoint before modifying (non-fatal)
try {
  await utils.checkpointManager.createCheckpoint(file.path, "manage_tags", "");
} catch { /* non-fatal */ }

let actualAdded: string[] = [];
let actualRemoved: string[] = [];

// -- Helpers (inlined) --

function normaliseTag(tag: string): string {
  return tag.trim().replace(/^#/, "");
}

function normaliseTags(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") return [normaliseTag(raw)];
  if (Array.isArray(raw)) {
    return raw
      .filter((t: any) => t != null && t !== "")
      .map((t: any) => normaliseTag(String(t)));
  }
  return [];
}

await app.fileManager.processFrontMatter(file, (frontmatter: any) => {
  let tags: string[] = normaliseTags(frontmatter["tags"]);

  if (add && add.length > 0) {
    for (const tag of add) {
      const normalised = normaliseTag(tag);
      if (!tags.includes(normalised)) {
        tags.push(normalised);
        actualAdded.push(normalised);
      }
    }
  }

  if (remove && remove.length > 0) {
    for (const tag of remove) {
      const normalised = normaliseTag(tag);
      const idx = tags.indexOf(normalised);
      if (idx !== -1) {
        tags.splice(idx, 1);
        actualRemoved.push(normalised);
      }
    }
  }

  if (tags.length > 0) {
    frontmatter["tags"] = tags;
  } else {
    delete frontmatter["tags"];
  }
});

const parts: string[] = [];
if (actualAdded.length > 0) {
  parts.push(`added [${actualAdded.map((t: string) => `"${t}"`).join(", ")}]`);
}
if (actualRemoved.length > 0) {
  parts.push(`removed [${actualRemoved.map((t: string) => `"${t}"`).join(", ")}]`);
}

const summary = parts.length > 0
  ? `Tags updated on ${params.path}: ${parts.join(", ")}`
  : `Tags unchanged on ${params.path} (requested tags already in desired state)`;

log.info("Tags managed", { path: params.path, added: actualAdded, removed: actualRemoved });

return summary;
```

**No new `utils` expansions needed.** All dependencies are already exposed in the extension runtime: `resolveNote`, `checkpointManager`, `logger`.

**No `libs` or `obsidian` imports needed.** Pure `app` + `utils` usage.

**No settings migration needed.** This tool references zero `NotorSettings` fields. No per-extension `settings:` section in the YAML fence, no shared settings.

**YAML fence (current scaffold is correct):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  add:
    type: "string[]"
    description: "Tags to add to the note."
    default: null
  remove:
    type: "string[]"
    description: "Tags to remove from the note."
    default: null
```

The built-in's `input_schema` declares `add` and `remove` as `{ type: "array", items: { type: "string" } }` with neither in `required`. The scaffold's `type: "string[]"` maps correctly to this via `paramSchemaToJsonSchema()`. Both `add` and `remove` use `default: null` to keep them out of `required[]`, with the at-least-one-of validation in the tool body.

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. The `add` and `remove` params get `default: null`. No `settings:` section in the YAML fence.

**Checkpoint handling:** The built-in class calls `this.checkpointManager?.createCheckpoint()` with optional chaining (undefined in unit tests). In the extension runtime, `utils.checkpointManager` is always defined. The scaffold wraps the checkpoint call in a try/catch to preserve non-fatal semantics — identical to the `update_frontmatter` scaffold pattern.

**Notable: helpers are inlined.** The built-in class has two private methods — `normaliseTags(raw)` and `normaliseTag(tag)`. These are simple, short functions (5 lines and 1 line respectively) used only within this tool. They are inlined as local functions in the scaffold. No `utils` expansion warranted for single-tool helpers this small.

**Notable: `normaliseTags` handles diverse input shapes.** The `tags` frontmatter value can be `undefined`, `null`, a plain string (single tag), a mixed array, or a proper `string[]`. The `normaliseTags` helper handles all cases. This defensive normalization is important to preserve — Obsidian frontmatter parsing produces diverse shapes depending on how users write their YAML. The scaffold comments should note this to prevent users from "simplifying" the helper to only handle `string[]`.

**Notable: empty tags array deletes the key.** When all tags are removed, the built-in deletes `frontmatter["tags"]` rather than leaving an empty array. This is the correct Obsidian convention — `processFrontMatter` will omit the key entirely from the YAML output, keeping frontmatter clean. The scaffold preserves this behavior.

**Notable: `normaliseTag` strips leading `#`.** Users may pass tags with or without the `#` prefix (e.g., `"#project"` vs `"project"`). The normaliser strips the leading `#` so tags are stored consistently without the hash in frontmatter. This matches Obsidian's convention where frontmatter tags are stored without `#`.

**Risk:** Effectively zero. This is one of the simplest write tools — a single `processFrontMatter` call with straightforward add/remove logic. No settings, no external libraries, no filesystem I/O beyond the frontmatter update. The two inlined helpers are trivial. The only notable detail is the `default: null` pattern for optional array params (same as `update_frontmatter`). Good candidate for early implementation alongside `read_frontmatter` and `update_frontmatter` (all three use `processFrontMatter` / frontmatter operations).

**Comparison with spec's complexity estimate:** The spec classifies `manage_tags` as "Medium" at 80-280 lines and estimates ~100 lines. The scaffold is ~65 lines — below estimate. The built-in class's 210 lines include the class boilerplate, `input_schema` declaration, explicit `ToolResult` construction with `tool_name` fields, and verbose error handling with `result: ""` padding — all absorbed by the adapter in the extension runtime. The two helper methods add ~20 lines to the scaffold but are structurally trivial. Comparable in complexity to `update_frontmatter` (both are single-`processFrontMatter`-call tools) and simpler than `move_note` or `write_note`.
