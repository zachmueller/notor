# Feasibility Assessment: Straightforward Tools

Tools with moderate logic, some helpers to inline, but no complex external dependencies or settings beyond what's already exposed. Direct ports with minor adaptation.

**Tools covered:** `replace_in_file`, `execute_command`, `replace_in_note`, `write_note`, `list_vault`, `move_note`

---

## `replace_in_file` — Feasibility: Straightforward ✅

**Source:** `src/tools/replace-in-file.ts` (271 lines total, ~170 lines of logic)

**What the built-in class does:**
1. Validates `path` param (exists, is string, not empty)
2. Validates `changes` param (array, non-empty, each block has non-empty `search` string and a `replace` string)
3. Desktop-only guard via `Platform.isDesktopApp`
4. Resolves vault root via `app.vault.adapter.basePath`
5. Validates path against vault root and `settings.read_file_allowed_paths` via `resolveAndValidatePath()`
6. Checks file existence via `fs.promises.stat()` (ENOENT → specific error)
7. Reads raw buffer via `fs.promises.readFile()`
8. Binary detection: scans first 8 KB for null bytes (`buf.subarray(0, 8192).includes(0)`)
9. Applies SEARCH/REPLACE blocks sequentially in memory — each block replaces only the first occurrence via `indexOf()` + slice-concat
10. Atomic semantics: if any search block fails to match, no changes are written; returns error with preview of the failing search text
11. Writes modified content back via `fs.promises.writeFile()`

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` from `"obsidian"` | `obsidian.Platform` | ⚠️ Not yet — must be added to `buildObsidianExports()` (spec already calls for this in runtime-context.ts changes) |
| `import * as fs from "fs"` | `libs.fs` | ⚠️ Not yet — must be added to `buildLibs()` (spec already calls for this in D-3) |
| `resolveAndValidatePath(path, vaultRoot, allowedPaths)` | `utils.resolveAndValidatePath(path)` | ✅ — runtime-context.ts:85-90 already injects `vaultRootPath` and defaults `allowedPaths` to `plugin.settings.read_file_allowed_paths` |
| `logger("ReplaceInFileTool")` | `utils.logger("replace_in_file")` | ✅ |
| `this.settings.read_file_allowed_paths` | `shared.read_file_allowed_paths` | ✅ (shared setting — see D-2/D-8). However, the scaffold does NOT need to pass this explicitly — `utils.resolveAndValidatePath(path)` reads it internally as the default. Only tools with custom allowed paths (like `execute_command`) pass a second argument. |

**Settings:** None per-extension. The only setting referenced (`read_file_allowed_paths`) is a cross-tool shared setting consumed internally by `utils.resolveAndValidatePath()`. No `settings:` section needed in the YAML fence.

**Helper functions (1 trivial inline):**

1. **`getVaultRootPath()`** (4 lines) — Extracts `basePath` from `app.vault.adapter`. Not needed in the scaffold because `utils.resolveAndValidatePath()` already knows the vault root (injected at build time in runtime-context.ts:86-88). The scaffold simply calls `utils.resolveAndValidatePath(path)` without needing the vault root at all.

**Return value mapping:**
- Success → return string message like `"Applied 3 replacements to /path/to/file"` (adapter wraps in `{ success: true, result: string }`)
- Validation/match failures → throw (adapter wraps in `{ success: false, error }`)
- The class has many early-return error paths (param validation, desktop guard, path validation, file not found, binary detection, search block mismatch). All convert to `throw new Error(message)` in the scaffold.

**Scaffold code (estimated ~100 lines):**
```ts
const log = utils.logger("replace_in_file");

if (!params.path || typeof params.path !== "string" || params.path.trim() === "") {
  throw new Error("Missing required parameter: path");
}
if (!Array.isArray(params.changes) || params.changes.length === 0) {
  throw new Error("Missing or empty required parameter: changes");
}

// Validate change blocks
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (typeof block?.search !== "string" || typeof block?.replace !== "string") {
    throw new Error(`Change block ${i + 1} is missing required 'search' or 'replace' property`);
  }
  if (block.search === "") {
    throw new Error(`Change block ${i + 1} has an empty search string. Search text must be non-empty.`);
  }
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("replace_in_file is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(params.path);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e) {
  if (e.code === "ENOENT") throw new Error(`File not found: ${resolvedPath}`);
  throw e;
}

// Read raw buffer for binary detection
const buf = await libs.fs.promises.readFile(resolvedPath);

if (buf.subarray(0, 8192).includes(0)) {
  throw new Error(
    "replace_in_file only supports text-based files. Binary files cannot be edited with SEARCH/REPLACE blocks."
  );
}

let content = buf.toString("utf-8");

// Apply SEARCH/REPLACE blocks sequentially in memory (atomic: all must match)
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (!block) continue;
  const idx = content.indexOf(block.search);
  if (idx === -1) {
    const preview = block.search.length > 80
      ? block.search.slice(0, 80) + "..."
      : block.search;
    throw new Error(
      `Search block ${i + 1} did not match any text in ${params.path}. ` +
      `No changes were applied. The search text was: "${preview}"`
    );
  }
  content = content.slice(0, idx) + block.replace + content.slice(idx + block.search.length);
}

// All blocks matched — write
await libs.fs.promises.writeFile(resolvedPath, content, "utf-8");

log.info("Applied replacements", { path: resolvedPath, count: params.changes.length });
return `Applied ${params.changes.length} replacement${params.changes.length > 1 ? "s" : ""} to ${resolvedPath}`;
```

**No new `utils` expansions needed.** `resolveAndValidatePath` already handles vault root and allowed paths internally.

**Required runtime expansions (already planned in spec):**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes)
- `libs.fs` — add to `buildLibs()` (spec D-3)

**YAML fence schema — resolved:** The `ParamSchema` type system was extended with `object[]` support so the scaffold can express the `changes` param as a proper array of `{search, replace}` objects:

```yaml
  changes:
    type: "object[]"
    description: "Array of search/replace blocks to apply in sequence."
    properties:
      search:
        type: string
        description: "Exact text to find in the file."
      replace:
        type: string
        description: "Text to replace the matched search text with."
    required_items:
      - search
      - replace
```

**Risk:** Low. This is a direct 1:1 port with no complex helpers, no external library dependencies beyond `fs`, no settings beyond what `utils.resolveAndValidatePath` already handles, and no tricky patterns. The atomic all-or-nothing semantics are purely in-memory sequential logic that translates directly. The only prerequisites are the `Platform` and `libs.fs` runtime expansions that are already planned for other tools (`execute_command` needs `Platform`, `read_file`/`write_file` need `libs.fs`).

---

## `execute_command` — Feasibility: Straightforward ✅

**Source:** `src/tools/execute-command.ts` (223 lines total, ~140 lines of logic)

**What the built-in class does:**
1. Validates `command` param (exists, is string)
2. Desktop-only guard via `Platform.isDesktopApp`
3. Resolves vault root via `app.vault.adapter.basePath`
4. Validates `working_directory` against vault root and `settings.execute_command_allowed_paths` via `resolveAndValidatePath()`
5. Executes command via `executeShellCommand(command, settings, { cwd, timeoutSeconds, maxOutputChars })`
6. Handles three result cases: timeout (partial output + error), non-zero exit code (output + error), success (output)
7. Catches spawn failures with special handling for "Shell not found" errors
8. Appends truncation notice if output was capped at `max_output_chars`

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` from `"obsidian"` | `obsidian.Platform` | ⚠️ Planned (spec runtime-context.ts changes) |
| `resolveAndValidatePath(path, vaultRoot, allowedPaths)` | `utils.resolveAndValidatePath(path, allowedPaths)` | ✅ — runtime-context.ts:85-90 accepts optional `allowedPaths` override |
| `executeShellCommand(cmd, settings, opts)` | `utils.executeShellCommand(cmd, opts)` | ✅ — runtime-context.ts:92-93 injects `plugin.settings` internally |
| `logger("ExecuteCommandTool")` | `utils.logger("execute_command")` | ✅ |

**Settings:** Three per-extension `settings` fields:
- `execute_command_allowed_paths` (string[], default `[]`) — passed as explicit override to `utils.resolveAndValidatePath(path, settings.execute_command_allowed_paths)`
- `execute_command_timeout` (number, default `30`) — passed as `opts.timeoutSeconds` to `utils.executeShellCommand()`
- `execute_command_max_output_chars` (number, default `50000`) — passed as `opts.maxOutputChars` to `utils.executeShellCommand()`

**Note on `execute_command_shell` and `execute_command_shell_args`:** These two settings are intentionally NOT migrated to per-extension settings. They are consumed internally by `resolveShell()` (called within `executeShellCommand()`) via the `plugin.settings` object that `utils.executeShellCommand` injects. The shell/shell_args settings are shared infrastructure — they also apply to hook execution via the hook engine (`src/hooks/hook-engine.ts:149-153`). They stay in `NotorSettings` and continue to be configured via the existing settings UI section. The scaffold never reads them directly.

**Return value mapping:**
- Success → return string (adapter wraps in `{ success: true, result: string }`)
- Timeout → throw with partial output embedded in message (adapter wraps in `{ success: false, error }`)
- Non-zero exit → throw with output in message
- Spawn failures → throw (adapter wraps in `{ success: false, error }`)

**Decision: Combine partial output into error message.** The built-in class returns `{ success: false, result: partialOutput, error: message }` for timeout and non-zero exit, setting both `result` and `error`. In the scaffold, throwing an error only populates the `error` field (adapter sets `result: ""`). The scaffold embeds partial output in the error message string (e.g., `throw new Error(\`Command timed out after ${timeout}s. Partial output:\n${output}\`)`). The LLM reads both fields as text context, so the information is equivalent.

**Scaffold code (estimated ~75 lines):**
```ts
const log = utils.logger("execute_command");

if (!params.command || typeof params.command !== "string") {
  throw new Error("Missing required parameter: command");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error(
    "execute_command is only available on desktop. " +
    "Shell execution is not supported on mobile."
  );
}

const workingDirectory = (params.working_directory as string) || "";

// Validate working directory against vault root and allowed paths
const cwdResult = utils.resolveAndValidatePath(
  workingDirectory,
  settings.execute_command_allowed_paths,
);
if (!cwdResult.valid) {
  throw new Error(
    `Working directory '${workingDirectory}' is outside the allowed paths. ` +
    `Allowed: vault root and configured paths.`
  );
}

log.info("Executing command", {
  command: (params.command as string).substring(0, 200),
  cwd: cwdResult.resolvedPath,
  timeout: `${settings.execute_command_timeout}s`,
});

try {
  const result = await utils.executeShellCommand(params.command as string, {
    cwd: cwdResult.resolvedPath,
    timeoutSeconds: settings.execute_command_timeout,
    maxOutputChars: settings.execute_command_max_output_chars,
  });

  let output = result.stdout;

  if (result.truncated) {
    output +=
      `\n\nNote: command output was truncated at ` +
      `${settings.execute_command_max_output_chars.toLocaleString()} characters.`;
  }

  if (result.timedOut) {
    const msg = `Command timed out after ${settings.execute_command_timeout} seconds.`;
    throw new Error(output ? `${msg} Partial output:\n${output}` : msg);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `Command exited with code ${result.exitCode}` +
      (output ? `\n${output}` : "")
    );
  }

  return output;
} catch (e) {
  // Re-throw errors already created above
  if (e instanceof Error && (
    e.message.includes("timed out") ||
    e.message.includes("exited with code")
  )) {
    throw e;
  }

  const message = e instanceof Error ? e.message : String(e);
  log.error("Command execution failed", {
    command: (params.command as string).substring(0, 200),
    error: message,
  });

  if (message.includes("Shell not found")) {
    throw new Error(`${message}. Check your shell configuration in Settings → Notor.`);
  }

  throw new Error(`Failed to execute command: ${message}`);
}
```

**No new `utils` expansions needed.** All dependencies are already exposed or planned.

**Required runtime expansions (already planned in spec):**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes, shared with `replace_in_file` and other desktop-only tools)

**YAML fence:**
```yaml
params:
  command:
    type: string
    description: "Shell command to execute."
  working_directory:
    type: string
    description: "Working directory for the command, relative to vault root or absolute."
    default: ""
    path_namespace: filesystem
settings:
  execute_command_allowed_paths:
    name: "Allowed Working Directories"
    type: string[]
    description: "Additional filesystem paths allowed as working directories. The vault root is always allowed."
    default: []
  execute_command_timeout:
    name: "Command Timeout"
    type: number
    description: "Maximum execution time in seconds before the command is killed."
    default: 30
    min: 1
    max: 600
  execute_command_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters of command output returned. Longer output is truncated."
    default: 50000
    min: 1000
    max: 500000
```

**Dispatcher pre-validation concern (`dispatcher.ts:366-390`):**

The dispatcher has a pre-execution validation for `execute_command` at lines 366-390 that reads `this.settings.execute_command_allowed_paths` directly from `NotorSettings`. After migration, this setting moves to `user_extension_settings["execute_command"]`.

**Analysis:** This pre-check is *redundant* with the tool's own path validation — the tool itself calls `resolveAndValidatePath()` and returns an error if the path is rejected.

**Decision: Remove the dispatcher pre-check.** Remove `dispatcher.ts:366-390` as part of the migration. The scaffold's own validation produces the same error. This eliminates the coupling between the dispatcher and tool-specific settings.

**Accepted tradeoff:** Removing the pre-check means the path rejection happens inside the tool execution instead of before it. The user sees the approval prompt before the error, which is a minor UX regression.

**Risk: Partial output in error messages (low).** The behavioral change from separate `result`+`error` fields to combined error message string is acceptable. The LLM reads both fields as text.

**Comparison with spec's complexity estimate:** The spec classifies `execute_command` as "Medium" at 80-280 lines and estimates ~80 lines. The scaffold is ~75 lines — at the low end. This tool is one of the cleanest migrations because `utils.executeShellCommand()` already encapsulates the complex shell infrastructure.

---

## `replace_in_note` — Feasibility: Straightforward ✅

**Source:** `src/tools/replace-in-note.ts` (261 lines total, ~170 lines of logic)

**What the built-in class does:**
1. Validates `path` param (exists, is string)
2. Validates `changes` param (array, non-empty, each block has non-empty `search` string and a `replace` string)
3. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)`
4. Reads current content via `app.vault.read(file)` for stale check
5. Checks stale content via `this.staleTracker.check(file.path, currentContent)` — uses canonical `file.path` for consistency with `recordRead()`
6. Creates checkpoint via `this.checkpointManager?.createCheckpoint(file.path, this.name, "")`
7. Applies all SEARCH/REPLACE blocks atomically via `app.vault.process(file, callback)`:
   - Iterates blocks sequentially; each replaces only the first occurrence via `indexOf()` + slice-concat
   - If any block's search text is not found, throws inside the callback — `vault.process` guarantees no changes are written
   - Records which block failed (1-indexed) and a preview of the search text (truncated at 80 chars) for the error message
8. Updates stale tracker with new content via `this.staleTracker.updateAfterWrite(file.path, newContent)` — re-reads file after `vault.process` to get the written content. Falls back to `invalidate()` on read failure.
9. Opens note in editor via `this.noteOpener?.openNote(file.path)`
10. Returns success message with replacement count

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.vault` | `app.vault` | ✅ |
| `this.app.metadataCache` | `app.metadataCache` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `this.staleTracker` | `utils.staleTracker` | ✅ |
| `this.checkpointManager` | `utils.checkpointManager` | ✅ |
| `this.noteOpener` | `utils.noteOpener` | ✅ |
| `logger("ReplaceInNoteTool")` | `utils.logger("replace_in_note")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed.

**Key patterns and their scaffold translations:**

1. **Atomic `vault.process()` with throw-on-mismatch** — The class applies all search/replace blocks inside a single `vault.process()` callback. If any block's search text isn't found, the callback throws, and `vault.process` guarantees no changes are written. This is the tool's defining behavior.

2. **Stale tracker canonical path** — The class uses `file.path` (Obsidian's canonical resolved path) rather than the user-supplied `path` param for all stale tracker calls.

3. **Two-phase stale tracker update** — After `vault.process()`, the class re-reads the file (`app.vault.read(file)`) and calls `staleTracker.updateAfterWrite(file.path, newContent)`. If the re-read fails, it falls back to `staleTracker.invalidate(file.path)` (non-fatal).

**Scaffold code (estimated ~90 lines):**
```ts
const log = utils.logger("replace_in_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}
if (!Array.isArray(params.changes) || params.changes.length === 0) {
  throw new Error("Missing or empty required parameter: changes");
}

// Validate change blocks
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (typeof block?.search !== "string" || typeof block?.replace !== "string") {
    throw new Error(`Change block ${i + 1} is missing required 'search' or 'replace' property`);
  }
  if (block.search === "") {
    throw new Error(`Change block ${i + 1} has an empty search string. Search text must be non-empty.`);
  }
}

log.debug("Replacing in note", { path: params.path, changeCount: params.changes.length });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

// Stale content check
let currentContent;
try {
  currentContent = await app.vault.read(file);
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  throw new Error(`Failed to read note for stale check: ${message}`);
}

const staleResult = utils.staleTracker.check(file.path, currentContent);
if (staleResult.isStale) {
  throw new Error(
    "Note content has changed since last read. " +
    "Re-read the note with read_note before retrying."
  );
}

// Checkpoint before write
await utils.checkpointManager.createCheckpoint(file.path, "replace_in_note", "");

// Apply changes atomically via vault.process
let failedBlockIndex = -1;
let failedSearchText = "";

try {
  await app.vault.process(file, (data) => {
    let modified = data;
    for (let i = 0; i < params.changes.length; i++) {
      const block = params.changes[i];
      if (!block) continue;
      const idx = modified.indexOf(block.search);
      if (idx === -1) {
        failedBlockIndex = i + 1;
        failedSearchText = block.search;
        throw new Error(`Search block ${i + 1} did not match`);
      }
      modified =
        modified.slice(0, idx) +
        block.replace +
        modified.slice(idx + block.search.length);
    }
    return modified;
  });
} catch (e) {
  if (failedBlockIndex !== -1) {
    const preview = failedSearchText.length > 80
      ? failedSearchText.slice(0, 80) + "..."
      : failedSearchText;
    throw new Error(
      `Search block ${failedBlockIndex} did not match any text in ${params.path}. ` +
      `No changes were applied. The search text was: "${preview}"`
    );
  }
  throw e;
}

// Update stale tracker with new content
try {
  const newContent = await app.vault.read(file);
  utils.staleTracker.updateAfterWrite(file.path, newContent);
} catch {
  utils.staleTracker.invalidate(file.path);
}

log.info("Applied replacements", { path: params.path, count: params.changes.length });

// Open in editor
await utils.noteOpener.openNote(file.path);

return `Applied ${params.changes.length} replacement${params.changes.length > 1 ? "s" : ""} to ${params.path}`;
```

**No new `utils` expansions needed.** All dependencies are already exposed.

**No `libs` or `obsidian` imports needed.** Pure `app` + `utils` usage.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  changes:
    type: "object[]"
    description: "Array of search/replace blocks to apply in sequence. Each block replaces only the first occurrence of the search text."
    properties:
      search:
        type: string
        description: "Exact text to find in the note (character-for-character match including whitespace)."
      replace:
        type: string
        description: "Text to replace the matched search text with. Use empty string to delete the matched text."
    required_items:
      - search
      - replace
```

**Risk: `vault.process()` throw-and-catch pattern (low).** The scaffold re-throws a new `Error` from the outer catch block rather than returning a structured `ToolResult`. The `UserToolAdapter` catch handler wraps this identically.

**Comparison with spec's complexity estimate:** The spec classifies `replace_in_note` as "Medium" at 80-280 lines and estimates ~130 lines. The scaffold is ~90 lines — below the estimate.

---

## `write_note` — Feasibility: Straightforward ✅

**Source:** `src/tools/write-note.ts` (213 lines total, ~150 lines of logic)

**What the built-in class does:**
1. Validates `path` param (exists, is string)
2. Validates `content` param (exists, is string, not null/undefined)
3. Resolves note via `resolveNote(path, this.app.vault, this.app.metadataCache)` — returns `null` for new files, `TFile` for existing
4. **New file path:** auto-appends `.md` if missing, creates intermediate directories via `ensureDirectoryExists()`, creates file via `app.vault.create(createPath, content)`, opens in editor, returns success with character count
5. **Existing file path:** reads current content via `app.vault.read(existingFile)`, performs stale content check via `staleTracker.check(file.path, currentContent)` using canonical path, creates checkpoint via `checkpointManager.createCheckpoint()`, applies frontmatter preservation (if existing note has frontmatter but new content doesn't, prepends the existing frontmatter block), writes via `app.vault.process(existingFile, () => finalContent)`, updates stale tracker with `updateAfterWrite()`, opens in editor

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.vault` | `app.vault` | ✅ |
| `this.app.metadataCache` | `app.metadataCache` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `this.staleTracker` | `utils.staleTracker` | ✅ |
| `this.checkpointManager` | `utils.checkpointManager` | ✅ |
| `this.noteOpener` | `utils.noteOpener` | ✅ |
| `logger("WriteNoteTool")` | `utils.logger("write_note")` | ✅ |
| `getFrontMatterInfo` | `obsidian.getFrontMatterInfo` | ✅ |
| `TFolder` | `obsidian.TFolder` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. Listed in the spec's "settings-free tools" group (D-2).

**Helper functions (1 to inline):**

1. **`ensureDirectoryExists()`** (~20 lines) — Creates intermediate vault directories. Duplicated in `write-note.ts`, `move-note.ts`, and `extract-docx-comments.ts`. Inlining in each scaffold is acceptable (~15 lines).

**Key patterns:**

1. **Create-vs-update branching** — New files go through `vault.create()`, existing files through `vault.process()`.
2. **Frontmatter preservation** — When overwriting, prepends existing frontmatter if new content lacks it.
3. **Stale tracker canonical path** — Uses `existingFile.path` for all stale tracker calls.

**Scaffold code (estimated ~80 lines):**
```ts
const log = utils.logger("write_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}
if (params.content === undefined || params.content === null || typeof params.content !== "string") {
  throw new Error("Missing required parameter: content");
}

log.debug("Writing note", { path: params.path, contentLength: params.content.length });

// Helper: create intermediate directories
async function ensureDirectoryExists(filePath: string) {
  const parts = filePath.split("/");
  parts.pop(); // remove filename
  if (parts.length === 0) return;

  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current);
      log.debug("Created directory", { path: current });
    } else if (!(existing instanceof obsidian.TFolder)) {
      throw new Error(`Cannot create directory: "${current}" already exists as a file`);
    }
  }
}

const existingFile = utils.resolveNote(params.path);

if (!existingFile) {
  // ---- New file: create with intermediate directories ----
  const createPath = params.path.endsWith(".md") ? params.path : params.path + ".md";
  await ensureDirectoryExists(createPath);
  await app.vault.create(createPath, params.content);

  log.info("Created new note", { path: createPath, chars: params.content.length });
  await utils.noteOpener.openNote(createPath);

  return `Note created: ${createPath} (${params.content.length} characters)`;
}

// ---- Existing file: stale check → checkpoint → frontmatter-safe write ----
const currentContent = await app.vault.read(existingFile);

const staleResult = utils.staleTracker.check(existingFile.path, currentContent);
if (staleResult.isStale) {
  throw new Error(
    "Note content has changed since last read. " +
    "Re-read the note with read_note before retrying."
  );
}

await utils.checkpointManager.createCheckpoint(existingFile.path, "write_note", "");

const existingFm = obsidian.getFrontMatterInfo(currentContent);
const newFm = obsidian.getFrontMatterInfo(params.content);

let finalContent: string;

if (existingFm.exists && !newFm.exists) {
  const frontmatterBlock = currentContent.slice(0, existingFm.contentStart);
  finalContent = frontmatterBlock + params.content;
  log.debug("Preserved existing frontmatter", { path: params.path });
} else {
  finalContent = params.content;
}

await app.vault.process(existingFile, () => finalContent);

utils.staleTracker.updateAfterWrite(existingFile.path, finalContent);

log.info("Modified existing note", { path: existingFile.path, chars: finalContent.length });
await utils.noteOpener.openNote(existingFile.path);

return `Note updated: ${existingFile.path} (${finalContent.length} characters)`;
```

**No new `utils` expansions needed.**

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
  content:
    type: string
    description: "Complete content to write to the note."
```

**`ensureDirectoryExists` extraction:** This helper is needed by 3 scaffolds (`write_note`, `move_note`, `extract_docx_comments`). **Decision: Extract to `utils.ensureDirectoryExists`.** This avoids triplicating ~15 lines and provides a single implementation. The scaffold calls `await utils.ensureDirectoryExists(filePath)` instead of inlining the helper.

**Comparison with spec's complexity estimate:** The spec classifies `write_note` as "Medium" at 80-280 lines and estimates ~120 lines. The scaffold is ~80 lines — at the low end.

---

## `list_vault` — Feasibility: Straightforward ✅

**Source:** `src/tools/list-vault.ts` (273 lines total, ~180 lines of logic)

**What the built-in class does:**
1. Parses params: `path`, `recursive`, `limit` (clamped 1–500), `offset`, `sort_by`
2. Collects items from the target directory via `collectItems(path, recursive)` — non-recursive uses folder children, recursive walks all folders + files
3. Classifies each file as `"note"` (`.md`), `"image"` (known extensions), or `"attachment"`
4. Sorts items (alphabetical with folders first, or last_modified descending)
5. Applies pagination via `slice(offset, offset + limit)`
6. Returns structured `{ path, total_count, items }`

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `TFile` / `TFolder` | `obsidian.TFile` / `obsidian.TFolder` | ✅ |
| `logger("ListVaultTool")` | `utils.logger("list_vault")` | ✅ |

**Settings:** None.

**Helper functions (5 to inline):** `collectItems`, `getAllFolders`, `toListItem`, `classifyFile`, `sortItems` — all pure Obsidian API usage with no external dependencies.

**Scaffold code (estimated ~100 lines):**
```ts
const log = utils.logger("list_vault");

const listPath = ((params.path as string) ?? "").trim();
const recursive = (params.recursive as boolean) ?? false;
const limit = Math.max(1, Math.min(500, Math.floor((params.limit as number) ?? 50)));
const offset = Math.max(0, Math.floor((params.offset as number) ?? 0));
const sortBy = ((params.sort_by as string) ?? "last_modified") as "last_modified" | "alphabetical";

log.debug("Listing vault", { listPath, recursive, limit, offset, sortBy });

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico", "avif",
]);

function classifyFile(file: any): "note" | "image" | "attachment" {
  const ext = file.extension.toLowerCase();
  if (ext === "md") return "note";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "attachment";
}

function toListItem(abstractFile: any): any {
  if (abstractFile instanceof obsidian.TFolder) {
    return { name: abstractFile.name, path: abstractFile.path, type: "folder" };
  }
  return {
    name: abstractFile.name,
    path: abstractFile.path,
    type: classifyFile(abstractFile),
    size: abstractFile.stat.size,
    modified: new Date(abstractFile.stat.mtime).toISOString(),
  };
}

function getAllFolders(): any[] {
  const folders: any[] = [];
  const walk = (folder: any) => {
    for (const child of folder.children) {
      if (child instanceof obsidian.TFolder) {
        folders.push(child);
        walk(child);
      }
    }
  };
  walk(app.vault.getRoot());
  return folders;
}

function collectItems(targetPath: string, isRecursive: boolean): any[] {
  const items: any[] = [];

  if (!isRecursive) {
    const folder = targetPath
      ? app.vault.getAbstractFileByPath(targetPath)
      : app.vault.getRoot();
    if (!folder || !(folder instanceof obsidian.TFolder)) return [];
    for (const child of folder.children) {
      if (child instanceof obsidian.TFile || child instanceof obsidian.TFolder) {
        items.push(toListItem(child));
      }
    }
  } else {
    const normalizedTarget = targetPath
      ? (targetPath.endsWith("/") ? targetPath : targetPath + "/")
      : "";
    for (const folder of getAllFolders()) {
      if (folder.path === "/" || folder.path === "") continue;
      if (normalizedTarget === "" || folder.path.startsWith(normalizedTarget) || folder.path === targetPath) {
        items.push(toListItem(folder));
      }
    }
    for (const file of app.vault.getFiles()) {
      if (normalizedTarget === "" || file.path.startsWith(normalizedTarget) || file.path === targetPath) {
        items.push(toListItem(file));
      }
    }
  }

  return items;
}

// Collect, sort, paginate
const allItems = collectItems(listPath, recursive);

const sorted = [...allItems].sort((a: any, b: any) => {
  if (sortBy === "alphabetical") {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    return a.path.localeCompare(b.path);
  }
  const aTime = a.modified ? new Date(a.modified).getTime() : 0;
  const bTime = b.modified ? new Date(b.modified).getTime() : 0;
  return bTime - aTime;
});

const totalCount = sorted.length;
const paginated = sorted.slice(offset, offset + limit);

log.debug("List complete", { path: listPath, totalCount, returned: paginated.length });

return { path: listPath || "/", total_count: totalCount, items: paginated };
```

**No new `utils` expansions needed.** No `libs` needed. No settings migration needed.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Directory to list, relative to vault root."
    default: ""
    path_namespace: vault
  recursive:
    type: boolean
    description: "Whether to list contents recursively."
    default: false
  limit:
    type: number
    description: "Maximum number of items to return."
    default: 50
  offset:
    type: number
    description: "Number of items to skip for pagination."
    default: 0
  sort_by:
    type: string
    description: "Sort order: 'last_modified' or 'alphabetical'."
    enum:
      - last_modified
      - alphabetical
    default: "last_modified"
```

**Risk: `instanceof` across execution contexts (none).** The scaffold code runs in the same JavaScript realm as the plugin — `instanceof` checks work correctly.

**Comparison with spec's complexity estimate:** The spec classifies `list_vault` as "Medium" at 80-280 lines and estimates ~160 lines. The scaffold is ~100 lines — below estimate. Structurally simple: no file I/O, no writes, no stale tracking, no checkpoints, no external libraries.

---

## `move_note` — Feasibility: Straightforward ✅

**Source:** `src/tools/move-note.ts` (208 lines total, ~120 lines of logic)

**What the built-in class does:**
1. Validates `path` and `new_path` params
2. Resolves source note, validates it's markdown
3. Normalizes destination path (auto-appends `.md`)
4. Guards: same path, destination exists
5. Creates checkpoint
6. Ensures destination directory exists
7. Performs move via `app.fileManager.renameFile(file, normalizedNewPath)` — auto-updates all internal links
8. If `add_alias` is `true` and filename changed, appends old basename to frontmatter `aliases`

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.fileManager` | `app.fileManager` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `this.checkpointManager` | `utils.checkpointManager` | ✅ |
| `logger("MoveNoteTool")` | `utils.logger("move_note")` | ✅ |
| `TFolder` | `obsidian.TFolder` | ✅ |

**Settings:** None.

**Helper functions (2 to inline):**
1. **`ensureDirectoryExists()`** (~15 lines) — Same pattern as `write_note` and `extract_docx_comments`.
2. **`normaliseAliases()`** (~10 lines) — Normalizes raw `aliases` frontmatter value to `string[]`.

**Key patterns:**
1. **`fileManager.renameFile()` for auto link-updating** — TFile reference remains valid after rename (Obsidian mutates in place).
2. **Post-rename `processFrontMatter`** — Uses the same `file` reference.
3. **Basename comparison for alias guard** — Only adds alias when filename actually changes.

**Scaffold code (estimated ~75 lines):**
```ts
const log = utils.logger("move_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}
if (!params.new_path || typeof params.new_path !== "string") {
  throw new Error("Missing required parameter: new_path");
}

log.debug("Moving note", { path: params.path, newPath: params.new_path, addAlias: params.add_alias });

// Helper: create intermediate directories
async function ensureDirectoryExists(filePath: string) {
  const parts = filePath.split("/");
  parts.pop();
  if (parts.length === 0) return;

  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current);
    } else if (!(existing instanceof obsidian.TFolder)) {
      throw new Error(`Cannot create directory: "${current}" already exists as a file`);
    }
  }
}

// Helper: normalize aliases frontmatter value to string[]
function normaliseAliases(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === "string") return [raw.trim()];
  if (Array.isArray(raw)) {
    return raw.filter((a: unknown) => a != null && a !== "").map((a: unknown) => String(a).trim());
  }
  return [];
}

const file = utils.resolveNote(params.path);
if (!file) throw new Error(`Note not found: ${params.path}`);

if (file.extension !== "md") {
  throw new Error(`Path is not a Markdown note: ${file.path}`);
}

const normalizedNewPath = params.new_path.endsWith(".md") ? params.new_path : params.new_path + ".md";

if (file.path === normalizedNewPath) {
  throw new Error("Source and destination are the same path");
}

const existing = app.vault.getAbstractFileByPath(normalizedNewPath);
if (existing) {
  throw new Error(`A note already exists at: ${normalizedNewPath}`);
}

await utils.checkpointManager.createCheckpoint(file.path, "move_note", "");

await ensureDirectoryExists(normalizedNewPath);

const oldBasename = file.basename;

await app.fileManager.renameFile(file, normalizedNewPath);

const newBasename = normalizedNewPath.split("/").pop()!.replace(/\.md$/, "");
if (params.add_alias && oldBasename !== newBasename) {
  await app.fileManager.processFrontMatter(file, (fm: any) => {
    const aliases = normaliseAliases(fm["aliases"]);
    if (!aliases.includes(oldBasename)) {
      aliases.push(oldBasename);
    }
    fm["aliases"] = aliases;
  });
}

log.info("Note moved", { from: params.path, to: normalizedNewPath });

return `Note moved: ${params.path} → ${normalizedNewPath}`;
```

**No new `utils` expansions needed.** No `libs` needed. No settings migration needed.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Current path of the note relative to vault root."
    path_namespace: vault
  new_path:
    type: string
    description: "New path for the note relative to vault root."
    path_namespace: vault
  add_alias:
    type: boolean
    description: "If true, append the old name to the note's frontmatter aliases."
    default: false
```

**Risk: TFile mutation after `renameFile()` (none).** Obsidian's `renameFile` mutates the TFile in place — the `file` object remains valid for the subsequent `processFrontMatter()` call.

**`ensureDirectoryExists`:** Uses `utils.ensureDirectoryExists(normalizedNewPath)` — shared helper extracted to `utils` (see `write_note` notes).

**Notable: no stale tracker / no noteOpener.** Unlike `write_note` and `replace_in_note`, `move_note` does not use the stale content tracker or open the note after the operation. This is correct — `move_note` doesn't modify note content.

**Comparison with spec's complexity estimate:** The spec classifies `move_note` as "Medium" at 80-280 lines and estimates ~120 lines. The scaffold is ~75 lines — below estimate.
