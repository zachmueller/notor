# Migration: Built-in Tools to Extension System

**Created:** 2026-04-06
**Status:** Draft
**Depends on:** Phase 5 (User-Defined Extensions) — complete

---

## Goal

Migrate all 20 built-in tools (everything except `use_subagent`) from TypeScript classes in `src/tools/` into the user-defined extension runtime. After this migration:

1. **Single tool runtime** — every non-subagent tool runs through `UserToolAdapter`, eliminating the dual code paths (class-based built-in vs. extension-based user tool)
2. **True customizability** — clicking "Customize" produces a note with the full working implementation, ready to edit; no placeholder stub
3. **Simpler boot** — `getToolRegistry()` registers only `use_subagent`; all other tools are loaded by `ExtensionManager` from pre-compiled scaffold defaults
4. **Consistency** — tool behavior, error handling, and settings resolution follow one model

## Current Architecture

```
onload()
  → getToolRegistry()
      → new ReadNoteTool(app, staleTracker, noteOpener)   ← class instance
      → new SearchVaultTool(app)                           ← class instance
      → ... (20 built-in class registrations)
      → new UseSubagentTool(subAgentMgr, providerReg, ...) ← stays as class
  → onLayoutReady()
      → ExtensionManager.reload(isInitialLoad=true)
          → discoverExtensions() scans notor/tools/ and notor/automations/
          → compiles user vault files into UserToolAdapter
          → registers in ToolRegistry (overrides built-in if same name)
```

Tools live in two places:
- **20 TypeScript classes** in `src/tools/*.ts` — registered directly, instantiated with constructor dependencies
- **User extension vault files** in `notor/tools/*.md` — discovered, parsed, compiled, wrapped in `UserToolAdapter`

The "Customize" button creates a vault file from `builtin-tool-scaffolds.ts`, but the scaffold contains only placeholder code (`return "Not yet customized..."`). The user must rewrite the implementation from scratch.

## Target Architecture

```
onload()
  → getToolRegistry()
      → new UseSubagentTool(subAgentMgr, providerReg, ...) ← only remaining class
  → onLayoutReady()
      → ExtensionManager.reload(isInitialLoad=true)
          → discoverExtensions() scans notor/tools/ and notor/automations/
          → for each of 20 built-in tools NOT found in vault:
              → load pre-compiled scaffold from BUILTIN_TOOL_SCAFFOLDS
              → wrap in UserToolAdapter
          → for user vault files: parse and compile (existing behavior)
          → user vault files override scaffold defaults (same-name last-write-wins)
          → register all in ToolRegistry
```

All 20 tools run through the same `UserToolAdapter.execute()` pipeline: settings resolution → context injection → compiled function call → ToolResult mapping.

**Boot-timing note:** Between `getToolRegistry()` (registers only `use_subagent`) and `ExtensionManager.reload()` (registers remaining 20 tools), the registry is incomplete. This is safe because `reload()` runs inside `onLayoutReady()` and no chat session can start before layout is ready. The ToolDispatcher is also lazily created after this point.

## Design Decisions

### D-1: Scaffold fallback (no auto-created vault files)

When `ExtensionManager.reload()` discovers that a built-in tool has no corresponding vault file in `notor/tools/`, it loads the pre-compiled scaffold from the in-memory `BUILTIN_TOOL_SCAFFOLDS` map. No vault file is created automatically.

**Why:** Auto-creating 20 `.md` files in the vault on first boot would be surprising and clutter the user's notor directory. The scaffold-as-fallback approach is invisible — tools work out of the box. Vault files only appear when the user explicitly clicks "Customize".

**How it works:**
1. `discoverExtensions()` returns vault-discovered tools (existing behavior, unchanged)
2. After discovery, `reload()` iterates `BUILTIN_TOOL_SCAFFOLDS` and checks which names are missing from the discovered set
3. For each missing scaffold, it constructs a frontmatter object directly from the scaffold metadata (name, description, mode) and passes it to `parseExtensionFile()` along with the scaffold content — no re-parsing of YAML frontmatter needed since the metadata is already structured
4. Scaffold tools are marked with `isScaffold: true` on the `UserToolDefinition` and wrapped in `UserToolAdapter` using the pre-compiled function (no runtime Sucrase transform — see D-7)
5. If a vault file exists with the same name as a scaffold, the vault file wins (discovered tools take precedence over scaffold fallbacks)

### D-2: Migrate tool settings into the extension settings system (hybrid)

Several built-in tools directly reference `NotorSettings` fields. These settings are migrated into the extension settings system using both channels defined in `design/user-defined-tools.md`: per-extension `settings` for single-tool fields, and global `shared` for cross-tool fields.

**Per-extension `settings`** (declared in each scaffold's YAML fence):

| Tool | Settings fields |
|---|---|
| `fetch_webpage` | `fetch_webpage_timeout`, `fetch_webpage_max_download_mb`, `fetch_webpage_max_output_chars` |
| `web_search` | `web_search_timeout`, `web_search_default_num_results` |
| `execute_command` | `execute_command_allowed_paths`, `execute_command_timeout`, `execute_command_max_output_chars` |
| `read_file` | `image_max_dimension`, `image_compression_quality`, `pdf_prefer_native`, `pdf_text_max_chars`, `pdf_native_max_size_mb` |
| `write_docx` | `write_docx_default_output_dir`, `write_docx_default_template_path` |

**`shared` settings** (cross-tool, declared via built-in shared settings scaffold — see D-8):

| Setting | Used by |
|---|---|
| `domain_denylist` | fetch_webpage, web_search |
| `read_file_allowed_paths` | read_file, write_file, replace_in_file, read_docx, write_docx, extract_docx_comments |

**Settings-free tools:** read_note, write_note, replace_in_note, search_vault, list_vault, read_frontmatter, update_frontmatter, manage_tags, move_note, get_backlinks, get_outlinks — these reference zero `NotorSettings` fields and migrate without any settings plumbing.

**Why hybrid:** The design doc defines two settings channels — per-extension `settings` and global `shared` settings. Using per-extension for single-tool fields keeps settings co-located with the tool that owns them. Using `shared` for cross-tool fields (`domain_denylist` shared by 2 tools, `read_file_allowed_paths` shared by 6 tools) avoids duplication. An alternative of exposing `utils.pluginSettings` was considered but rejected — it would introduce a read-only third channel outside the extension settings model.

**Data migration:** On first boot after update, detect old `NotorSettings` fields, copy values to new extension settings storage (`user_extension_settings` / `user_shared_settings`), clear old fields, and show an Obsidian Notice: "Tool settings have moved to the Extensions section in Settings." The old plugin settings UI sections for these fields are removed — they now render in the extension settings UI via each scaffold's `settingsSchema`.

**Note on `active_provider`:** The `read_file` tool passes `this.settings.active_provider` to `processPdf()` for provider-dependent PDF handling. Rather than exposing this as a setting, `utils.processPdf` reads `active_provider` internally from the plugin instance (see runtime-context.ts changes). Scaffold code calls `utils.processPdf(buffer, { pages, maxTextChars, preferNative })` without needing to know the active provider.

### D-3: Node.js modules via `libs` object

Tools that access the filesystem (`read_file`, `write_file`, `replace_in_file`, `read_docx`, `write_docx`, `extract_docx_comments`) import `fs` and `crypto` from Node.js. These are exposed through the `libs` object alongside other bundled libraries:

```ts
libs.fs      // Node.js fs module
libs.crypto  // Node.js crypto module
libs.path    // Node.js path module
```

**Why `libs` over `require()`:** Using `require()` would work in Electron today but is fragile — if Obsidian moves toward ESM-only or renderer sandboxing, `require()` calls break. Exposing via `libs` makes the dependency explicit and controllable. The `ExtensionLibs` type grows by 3 entries, which is a small API surface change for better forward-compatibility.

### D-4: Error handling pattern in extension code

Built-in tool classes return `{ success: false, error: message }` as `ToolResult` for validation failures. In extension code, `UserToolAdapter.execute()` wraps the compiled function in try/catch and produces a failure `ToolResult` from any thrown error.

**Extension pattern:**
```ts
// Validation errors → throw (adapter converts to { success: false, error })
if (!params.path) throw new Error("Missing required parameter: path");

// Success → return value (adapter wraps in { success: true, result: value })
return content;
```

This is cleaner than constructing `ToolResult` objects manually and matches how user-authored extensions work.

### D-5: `use_subagent` stays as a built-in class

`UseSubagentTool` has 7 constructor dependencies (`SubAgentManager`, `ProviderRegistry`, `ToolRegistry`, `NotorSettings`, `getParentEffectiveConfig`, `HistoryManager`, `getParentConversation`) and dynamic properties (`description` and `input_schema` built on-the-fly from cached profiles). Migrating it would require exposing the sub-agent manager, provider registry, and conversation internals through the extension API — too much internal surface for a tool that users should not customize.

### D-6: ~~Open customized files in new leaf~~ (already applied)

This fix was applied in commit `a968826`. Both `openLinkText` calls in `src/settings/sections/extensions.ts` (lines 124 and 155) already pass the third `true` argument. No changes needed.

### ~~D-7: Pre-compile scaffold code at build time~~ (removed)

Scaffold code blocks use runtime Sucrase compilation, the same path as user vault files. Sucrase transforms ~1M lines/sec; all 20 scaffolds together add <5ms to boot. A custom esbuild plugin for pre-compilation was considered but rejected — the complexity (build plugin, `preCompiledCode` field, fallback logic) is not justified by the negligible performance gain. If profiling later shows boot time is a problem, pre-compilation can be added as a follow-up.

### D-8: Built-in shared settings scaffold

For the two `shared` settings (`domain_denylist`, `read_file_allowed_paths`), the extension manager provides a default shared settings schema when no `notor/settings.md` exists in the vault. This parallels how scaffold tools are provided when no vault tool files exist.

**How it works:**
1. `ExtensionManager.reload()` checks if `discoverExtensions()` found a shared settings file
2. If not, it loads a built-in shared settings schema from a constant (analogous to `BUILTIN_TOOL_SCAFFOLDS`)
3. The built-in schema declares `domain_denylist` (type: `string[]`) and `read_file_allowed_paths` (type: `string[]`) with appropriate defaults
4. If a user-authored `notor/settings.md` exists, it takes precedence (same "vault file wins" semantics as tool scaffolds)

This ensures the two cross-tool settings are always available in the `shared` object, even without a user-created settings file.

---

## Changes by File

### `src/extensions/builtin-tool-scaffolds.ts` — Full tool implementations

**Scope:** Rewrite all 20 scaffold code blocks with working implementations adapted to the extension runtime.

**`scaffold()` helper signature change:**
```ts
function scaffold(
  name: string,
  description: string,
  mode: "read" | "write",
  paramsYaml: string,
  code: string,       // NEW: actual implementation code
): BuiltinToolScaffold
```

The template changes from generic placeholder to per-tool code:
```
\`\`\`ts
${code}
\`\`\`
```

**`BuiltinToolScaffold` type** (unchanged from current, no `preCompiledCode` — runtime Sucrase handles compilation):
```ts
export interface BuiltinToolScaffold {
  name: string;
  description: string;
  mode: "read" | "write";
  scaffoldContent: string;
}
```

**Conversion patterns applied to all 20 tools:**

| Built-in class pattern | Extension code equivalent |
|---|---|
| `this.app` / `this.app.vault` | `app` / `app.vault` |
| `this.app.metadataCache` | `app.metadataCache` |
| `this.app.fileManager` | `app.fileManager` |
| `this.staleTracker` | `utils.staleTracker` |
| `this.noteOpener` | `utils.noteOpener` |
| `this.checkpointManager` | `utils.checkpointManager` |
| `this.settings.{field}` (single-tool) | `settings.{field}` (per-extension settings — see D-2) |
| `this.settings.{field}` (cross-tool) | `shared.{field}` (shared settings — see D-2) |
| `resolveNote(p, vault, mc)` | `utils.resolveNote(p)` |
| `resolveAndValidatePath(p, root, allowed)` | `utils.resolveAndValidatePath(p)` (default allowed paths) or `utils.resolveAndValidatePath(p, settings.allowed_paths)` (per-extension paths, e.g. execute_command) |
| `executeShellCommand(cmd, settings, opts)` | `utils.executeShellCommand(cmd, opts)` |
| `logger("ToolName")` | `utils.logger("tool_name")` |
| `getFrontMatterInfo` | `obsidian.getFrontMatterInfo` |
| `requestUrl` | `obsidian.requestUrl` |
| `Notice` / `TFile` / `TFolder` | `obsidian.Notice` / `obsidian.TFile` / `obsidian.TFolder` |
| `normalizePath` | `obsidian.normalizePath` |
| `mammoth` / `PizZip` / `docx` / etc. | `libs.mammoth` / `libs.PizZip` / `libs.docx` / etc. |
| `TurndownService` / `gfm` | `libs.Turndown` / `libs.turndownGfm.gfm` |
| `marked` / `xmldom` | `libs.marked` / `libs.xmldom` |
| `import * as fs from "fs"` | `libs.fs` |
| `import * as crypto from "crypto"` | `libs.crypto` |
| `import * as path from "path"` | `libs.path` |
| `return { success: false, error }` | `throw new Error(message)` |
| `return { success: true, result: val }` | `return val` |
| Private helper methods | Local `function` declarations in code block |

**Complexity tiers:**

| Tier | Tools | Est. lines per scaffold |
|---|---|---|
| Simple | `read_frontmatter`, `get_backlinks`, `get_outlinks`, `update_frontmatter`, `write_file` | 30-80 |
| Medium | `read_note`, `write_note`, `replace_in_note`, `manage_tags`, `move_note`, `list_vault`, `execute_command`, `replace_in_file` | 80-200 |
| Complex | `search_vault`, `fetch_webpage`, `web_search`, `read_file`, `read_docx`, `write_docx`, `extract_docx_comments` | 200-600 |

### `src/extensions/runtime-context.ts` — Add media utilities, Node.js modules, and `Platform`

```ts
// In ExtensionUtils interface:
/** Detect media format from buffer magic bytes. */
detectMediaFormat: (buffer: Buffer) => "png" | "jpeg" | "gif" | "webp" | "pdf" | null;
/** Process an image buffer for LLM consumption (resize, compress). */
processImage: (buffer: Buffer, mediaType: ImageMediaType, options?: { maxDimension?: number; compressionQuality?: number }) => Promise<ContentBlock>;
/** Process a PDF buffer for LLM consumption. Reads active_provider internally. */
processPdf: (buffer: Buffer, options: { pages?: string; maxTextChars?: number; preferNative?: boolean }) => Promise<{ contentBlocks: ContentBlock[]; textSummary: string }>;

// In buildUtils():
detectMediaFormat,
processImage,
processPdf: (buffer, options) => processPdf(buffer, { ...options, providerType: plugin.settings.active_provider }),
```

Note: `utils.processPdf` wraps the underlying `processPdf` function, injecting `active_provider` from the plugin instance. Scaffold code does not need to know about the active provider — it calls `utils.processPdf(buffer, { pages, maxTextChars, preferNative })`.

Add `Platform` to `buildObsidianExports()` (needed by `execute_command` scaffold for desktop-only guard):
```ts
// In buildObsidianExports():
Platform,
```

Add Node.js modules to `buildLibs()` (see D-3):
```ts
// In ExtensionLibs interface and buildLibs():
fs: typeof import("fs");
crypto: typeof import("crypto");
path: typeof import("path");
```

~25 lines changed.

### `src/extensions/manager.ts` — Scaffold fallback in reload pipeline

After step 1 (discovery) and before step 2 (compilation), add a new step that injects scaffold defaults for missing built-in tools:

```ts
// 1b. Inject scaffold fallbacks for missing built-in tools
for (const [name, scaffold] of BUILTIN_TOOL_SCAFFOLDS) {
    // Skip if vault file was discovered with this name
    if (discovered.tools.some(t => t.name === name)) continue;

    // Construct frontmatter directly from scaffold metadata (no re-parsing)
    const frontmatter: Record<string, unknown> = {
        "notor-type": "tool",
        "notor-tool-name": scaffold.name,
        "notor-description": scaffold.description,
        "notor-mode": scaffold.mode,
    };
    const parsed = parseExtensionFile(
        scaffold.scaffoldContent,
        frontmatter,
        `(built-in scaffold: ${name})`,
        this.parseYAML,
    );
    if ("message" in parsed) {
        errors.push({ filePath: `(built-in scaffold: ${name})`, message: parsed.message });
        continue;
    }
    if ("name" in parsed && "mode" in parsed) {
        const toolDef = parsed as UserToolDefinition;
        toolDef.isScaffold = true;
        // Compiled via runtime Sucrase in the same pipeline as user vault files
        discovered.tools.push(toolDef);
    }
}
```

Scaffold-origin tools are marked with `isScaffold: true` on `UserToolDefinition` for programmatic detection. The `filePath` is descriptive for logging only.

**Refactor:** Extract the manual YAML parsing logic from `discovery.ts:parseOneExtensionFile()` (lines 190-206) into a standalone `extractFrontmatter(content, parseYAML)` helper. This cleans up `parseOneExtensionFile()` and provides a reusable utility for future code that needs to parse frontmatter from raw markdown content (e.g., template imports, clipboard paste). Note: the scaffold injection above does NOT use this helper — it constructs frontmatter directly from structured metadata.

### `src/main.ts` — Remove built-in class registrations

In `getToolRegistry()` (lines 1105-1182):
- **Remove** all 20 tool class registrations (lines 1115-1156)
- **Remove** associated imports for tool classes (lines 66-86)
- **Keep** `UseSubagentTool` registration (lines 1159-1175)
- **Remove** dependency acquisition for `staleTracker`, `noteOpener`, `checkpointManager` — `UseSubagentTool` doesn't use them

After change:
```ts
getToolRegistry(): ToolRegistry {
    if (!this._toolRegistry) {
        this._toolRegistry = new ToolRegistry();

        // use_subagent — the only remaining class-based built-in tool (D-5)
        const useSubagentTool = new UseSubagentTool(
            this.getSubAgentManager(),
            this.getProviderRegistry(),
            this._toolRegistry,
            this.settings,
            () => this.getOrchestrator()?.getEffectiveToolConfig() ?? null,
            this.getHistoryManager(),
            () => this.getOrchestrator()?.getConversationManager()?.getActiveConversation() ?? null,
        );
        if (this.vaultRootPath) {
            useSubagentTool.setVaultRootPath(this.vaultRootPath);
        }
        this._toolRegistry.register(useSubagentTool);
        useSubagentTool.refreshVisibleProfiles().catch((e) =>
            log.warn("Failed to load initial sub-agent profiles", { error: String(e) })
        );

        log.debug("Tool registry initialized", { tools: this._toolRegistry.getNames() });
    }
    return this._toolRegistry;
}
```

**Boot sequence change:** The comment at `main.ts:474-476` ("Must run after workflow discovery so the tool registry is populated with built-in tools first") is no longer accurate — remove or update it. The extension manager now provides ALL tools (both scaffold defaults and vault overrides). The ordering is:
1. `getToolRegistry()` — registers `use_subagent` only
2. `ExtensionManager.reload(true)` — discovers vault files, injects scaffold fallbacks, loads pre-compiled functions, registers all 20 tools

### `src/settings/sections/extensions.ts` — ~~Fix leaf opening~~ (already applied)

Both `openLinkText` calls (lines 124 and 155) already pass `true` as the third argument (commit `a968826`). No changes needed.

### `src/extensions/manager.ts` — Override detection update

The current override detection (lines 250-256) checks if a compiled user tool name exists in the registry AND is not in `registeredToolNames`. After migration, scaffold-provided tools ARE in `registeredToolNames` (they're registered by the extension manager). So "override" detection should change to: a compiled vault-discovered tool that replaces a scaffold-provided tool.

```ts
// Detect user vault overrides of scaffold defaults (iterate compiledTools, not discovered)
for (const [name, tool] of compiledTools) {
    if (BUILTIN_TOOL_SCAFFOLDS.has(name) && !tool.isScaffold) {
        builtinOverrides.push(name);
    }
}
```

**Important:** This iterates `compiledTools` (successfully compiled only), not `discovered.tools` (which includes tools that failed compilation). This preserves the current behavior where only tools that actually compiled successfully are counted as overrides.

### Test file updates

**Unit tests** (`src/extensions/__tests__/manager.test.ts`):
- Update "detects built-in tool overrides" test — built-ins are now scaffolds with `isScaffold: true`, not class instances
- Add test: scaffold fallback registers tools when no vault files exist
- Add test: vault file overrides scaffold default (vault `isScaffold: false` wins)
- Add test: `reload()` with empty vault produces 20 scaffold tools

**E2E test** (`e2e/scripts/user-extensions-test.ts`):
- Scenario 3 ("User tool is registered in ToolRegistry") needs updating — all 20 scaffold tools + `use_subagent` should be registered (21 total)
- Scenario 12 ("Built-in tool scaffolds API returns all 20 built-in tools") — `BUILTIN_TOOL_SCAFFOLDS` has 20 entries (all non-subagent tools); `use_subagent` was never in the map. No change needed.
- Scenario 13 ("ensureBuiltinToolVaultFile creates scaffold") — should still work but now the scaffold contains real implementation code

---

## Per-Tool Conversion Notes

### Simple tools

| Tool | Key adaptation notes |
|---|---|
| `read_frontmatter` | Pure cache read via `app.metadataCache.getFileCache()`. Strip `position` key from frontmatter. ~40 lines. |
| `get_backlinks` | Iterate `app.metadataCache.resolvedLinks` reverse-lookup. ~35 lines. |
| `get_outlinks` | Read `resolvedLinks[path]` + `unresolvedLinks[path]`. Two-section markdown output. ~40 lines. |
| `update_frontmatter` | Uses `app.fileManager.processFrontMatter()`. Checkpoint creation. ~60 lines. |
| `write_file` | Uses `libs.fs.promises.writeFile()`. Path validation via `utils.resolveAndValidatePath()`. ~50 lines. |

### Medium tools

| Tool | Key adaptation notes |
|---|---|
| `read_note` | `utils.resolveNote()`, `obsidian.getFrontMatterInfo()`, `utils.staleTracker.recordRead()`, `utils.noteOpener.openNote()`. ~60 lines. |
| `write_note` | `utils.staleTracker.check()`, `utils.checkpointManager.createCheckpoint()`, `app.vault.process()`, frontmatter preservation. Helper: `ensureDirectoryExists()`. ~120 lines. |
| `replace_in_note` | JSON-parsed change blocks, atomic all-or-nothing via `app.vault.process()`. Stale check + checkpoint. ~130 lines. |
| `manage_tags` | `app.fileManager.processFrontMatter()` with tag normalization helpers (`normaliseTags`, `normaliseTag`). ~100 lines. |
| `move_note` | `app.fileManager.renameFile()` for auto link-updating. Optional alias insertion. Helper: `ensureDirectoryExists()`, `normaliseAliases()`. ~120 lines. |
| `list_vault` | Enumerate via `app.vault.getFiles()` / `getAbstractFileByPath()`. Helpers: `collectItems`, `classifyFile`, `sortItems`. Pagination. ~160 lines. |
| `execute_command` | `utils.executeShellCommand()` already wraps settings. Path validation for working dir. Platform guard via `Platform.isDesktopApp`. ~80 lines. Need to import `Platform` from obsidian — add to `buildObsidianExports()`. |
| `replace_in_file` | `libs.fs` for read/write. Binary detection (null-byte scan). Atomic in-memory search/replace. ~120 lines. |

### Complex tools

| Tool | Key adaptation notes |
|---|---|
| `search_vault` | Three helpers: `getCandidateFiles()`, `searchFile()`, `sortFileResults()` + `matchesGlob()`, `getBacklinkCounts()`. Regex with `/gm` flag, `lastIndex` reset between files. ~250 lines. |
| `fetch_webpage` | `obsidian.requestUrl()`. Turndown instance with GFM plugin + custom rules (strip nav/footer). `settings` for timeout/size caps, `shared` for denylist. Helpers: `isDomainBlocked()`, `getNetErrorHint()`. ~300 lines. |
| `web_search` | DuckDuckGo HTML scraping via `DOMParser`. `obsidian.requestUrl()` POST. Helpers: `cleanDDGUrl()`, `parseDDGResults()`. `settings` for timeout/num_results, `shared` for denylist. ~200 lines. |
| `read_file` | Binary detection, media format detection (magic bytes), image processing pipeline, PDF processing. `libs.fs`. `settings` for image/PDF options. ~200 lines. |
| `read_docx` | `libs.mammoth` conversion with image extraction callback. `libs.crypto` for MD5 dedup. Custom Turndown rule for images. ~200 lines. |
| `write_docx` | `libs.marked.lexer()` tokenization → `libs.docx` block generation. Template grafting via `libs.PizZip` + `libs.xmldom`. Helpers: `renderInline()`, `buildDocxChildren()`, `graftIntoTemplate()`, image resolution. ~600 lines. |
| `extract_docx_comments` | `libs.PizZip` for XML extraction. Comment threading, resolved filtering, `@mention` resolution. Idempotent append. ~300 lines. |

### Missing from `obsidian` exports

The `execute_command` tool checks `Platform.isDesktopApp`. Add `Platform` to `buildObsidianExports()` (small addition, useful for any extension that needs platform detection).

### Media utilities for `read_file` scaffold

The `read_file` tool references image/PDF processing utilities from `src/media/`. Expose these via `utils` (see runtime-context.ts changes above):

```ts
utils.detectMediaFormat: (buffer: Buffer) => "png" | "jpeg" | "gif" | "webp" | "pdf" | null
utils.processImage: (buffer: Buffer, mediaType: ImageMediaType, options?: { maxDimension?: number; compressionQuality?: number }) => Promise<ContentBlock>
utils.processPdf: (buffer: Buffer, options: { pages?: string; maxTextChars?: number; preferNative?: boolean }) => Promise<{ contentBlocks: ContentBlock[]; textSummary: string }>
```

Note: `utils.processPdf` wraps the underlying `processPdf` function and injects `active_provider` from the plugin instance internally. Scaffold code does not need to pass the provider type. `processPdf` returns `{ contentBlocks, textSummary }`, not a single `ContentBlock` — the `read_file` scaffold must handle the real return shape.

This avoids duplicating ~200 lines of media processing code in the scaffold and keeps it maintainable. The `read_file` scaffold would then be ~100 lines instead of ~300.

---

## Risk Assessment

### R-1: Compilation performance on boot

**Risk:** Compiling 20 tools via Sucrase + AsyncFunction on every plugin load adds latency.
**Mitigation:** Sucrase transforms ~1M lines/sec. All 20 scaffolds together are <5ms. Log the timing during implementation to verify. If profiling later shows this is a bottleneck, build-time pre-compilation can be added as a follow-up.

### R-2: Scaffold code correctness

**Risk:** Converting 20 tool implementations to extension code may introduce subtle bugs (different `this` context, missing error paths, etc.).
**Mitigation:** Each tool's scaffold should be tested by:
1. Creating the vault file via `ensureBuiltinToolVaultFile()`
2. Reloading extensions
3. Invoking the tool via LLM and comparing output to the class-based version
4. Automated e2e test for at least 3-4 representative tools (simple, medium, complex)

### R-3: Stale tracker and checkpoint dependencies

**Risk:** `utils.staleTracker` and `utils.checkpointManager` are lazy singletons on the plugin. Extension code accessing them during boot (before first chat) should work since they're created on first access.
**Mitigation:** Verify lazy accessor pattern. Both `getStaleTracker()` and `getCheckpointManager()` create on first call — same as `getExtensionManager()`.

### R-4: `DOMParser` availability in extension code

**Risk:** `web_search` tool uses `new DOMParser()` for HTML parsing. This is a browser/Electron global, not a Node.js API.
**Mitigation:** Electron's renderer process provides `DOMParser` globally. `libs.xmldom` is also available as a fallback. The scaffold code can use the native `DOMParser` directly — it's available in the same execution context.

### R-5: Backward compatibility — tool config references

**Risk:** Personas, workflows, and rules may reference built-in tool names in `<notor_tool_config>` blocks. These references must continue to work.
**Mitigation:** No change — tool names remain the same (e.g., `read_note`, `search_vault`). The tools register under the same names; only the implementation mechanism changes.

### R-6: `TOOL_PATH_PARAMS` population timing

**Risk:** Path enforcement relies on `TOOL_PATH_PARAMS` being populated before dispatch. With scaffolds loaded during `ExtensionManager.reload()`, this happens in `onLayoutReady()` — same timing as before but via a different code path.
**Mitigation:** `reload()` already registers `TOOL_PATH_PARAMS` entries (line 278-280 in manager.ts). Scaffold-compiled tools include `pathParams` from the YAML fence. No timing change.

---

## Testing Strategy

### Unit tests

- `src/extensions/__tests__/manager.test.ts`:
  - New: `reload()` with empty vault produces 20 scaffold tools + correct names
  - New: vault file overrides scaffold default (vault file wins, `isScaffold: false`)
  - Updated: override detection uses `tool.isScaffold` check (not string prefix)
  - New: scaffold-compiled tool executes correctly (invoke `read_note` scaffold, verify return value)

### E2E tests

- Update `user-extensions-test.ts`:
  - Scenario 3: verify all 20 scaffold tools + `use_subagent` registered (21 total)
  - New scenario: invoke a scaffold-provided tool (e.g., `read_note` via LLM) without any vault files
  - Scenario 13: after `ensureBuiltinToolVaultFile("read_note")` + reload, tool still works (now runs vault code, not scaffold)

### Manual verification

1. Fresh vault (no `notor/tools/` directory) → all 20 tools available and functional
2. Click "Customize" on `read_note` → note opens in new leaf with full implementation
3. Edit the customized note (e.g., add logging) → reload → verify modified behavior
4. Click "Reset to default" → reload → back to scaffold behavior
5. Complex tool test: `write_docx` scaffold generates a valid `.docx` file
