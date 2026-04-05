# Migration: Built-in Tools to Extension System

**Created:** 2026-04-06
**Status:** Draft
**Depends on:** Phase 5 (User-Defined Extensions) — complete

---

## Goal

Migrate all 19 built-in tools (everything except `use_subagent`) from TypeScript classes in `src/tools/` into the user-defined extension runtime. After this migration:

1. **Single tool runtime** — every non-subagent tool runs through `UserToolAdapter`, eliminating the dual code paths (class-based built-in vs. extension-based user tool)
2. **True customizability** — clicking "Customize" produces a note with the full working implementation, ready to edit; no placeholder stub
3. **Simpler boot** — `getToolRegistry()` registers only `use_subagent`; all other tools are discovered/compiled by `ExtensionManager`
4. **Consistency** — tool behavior, error handling, and settings resolution follow one model

## Current Architecture

```
onload()
  → getToolRegistry()
      → new ReadNoteTool(app, staleTracker, noteOpener)   ← class instance
      → new SearchVaultTool(app)                           ← class instance
      → ... (19 built-in class registrations)
      → new UseSubagentTool(subAgentMgr, providerReg, ...) ← stays as class
  → onLayoutReady()
      → ExtensionManager.reload(isInitialLoad=true)
          → discoverExtensions() scans notor/tools/ and notor/automations/
          → compiles user vault files into UserToolAdapter
          → registers in ToolRegistry (overrides built-in if same name)
```

Tools live in two places:
- **19 TypeScript classes** in `src/tools/*.ts` — registered directly, instantiated with constructor dependencies
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
          → for each of 19 built-in tools NOT found in vault:
              → parse scaffold content from BUILTIN_TOOL_SCAFFOLDS
              → compile into UserToolAdapter
          → for user vault files: parse and compile (existing behavior)
          → user vault files override scaffold defaults (same-name last-write-wins)
          → register all in ToolRegistry
```

All 19 tools run through the same `UserToolAdapter.execute()` pipeline: settings resolution → context injection → compiled function call → ToolResult mapping.

## Design Decisions

### D-1: Scaffold fallback (no auto-created vault files)

When `ExtensionManager.reload()` discovers that a built-in tool has no corresponding vault file in `notor/tools/`, it parses and compiles the scaffold content directly from the in-memory `BUILTIN_TOOL_SCAFFOLDS` map. No vault file is created automatically.

**Why:** Auto-creating 19 `.md` files in the vault on first boot would be surprising and clutter the user's notor directory. The scaffold-as-fallback approach is invisible — tools work out of the box. Vault files only appear when the user explicitly clicks "Customize".

**How it works:**
1. `discoverExtensions()` returns vault-discovered tools (existing behavior, unchanged)
2. After discovery, `reload()` iterates `BUILTIN_TOOL_SCAFFOLDS` and checks which names are missing from the discovered set
3. For each missing scaffold, it calls `parseExtensionFile()` on the scaffold content (synthetic frontmatter + YAML fence + code fence) and `compileExtension()` on the result
4. Scaffold-compiled tools are registered alongside vault-discovered tools
5. If a vault file exists with the same name as a scaffold, the vault file wins (discovered tools take precedence over scaffold fallbacks)

### D-2: Expose `pluginSettings` in extension utils

Several built-in tools directly reference `NotorSettings` fields: fetch timeouts, domain denylist, image processing options, docx output directory, PDF settings, allowed paths, etc. These settings are not available through the current `ExtensionUtils` interface.

Add a `pluginSettings` field to `ExtensionUtils` — a read-only reference to `plugin.settings`.

**Why this is safe:** Extensions already have access to the full `app` object, which can reach plugin settings via `app.plugins.plugins['notor'].settings`. Exposing it via `utils.pluginSettings` is a convenience, not a new security surface.

**Type:** `Record<string, unknown>` in the public interface (avoids importing `NotorSettings` into the extension API surface). TypeScript-level documentation via JSDoc comments for commonly used fields.

### D-3: Node.js modules via `require()` in extension code

Tools that access the filesystem (`read_file`, `write_file`, `replace_in_file`, `read_docx`, `write_docx`, `extract_docx_comments`) import `fs` and `crypto` from Node.js. In the extension runtime (compiled via `AsyncFunction`), these are accessed via `require()`:

```ts
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
```

**Why not add to `libs`:** Adding `fs`/`crypto`/`path` to `buildLibs()` would change the public API surface and require updating `ExtensionLibs` type. Using `require()` is standard in Electron and matches how any user-authored extension would access Node.js APIs. No runtime-context changes needed.

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

### D-6: Open customized files in new leaf

The "Customize" and "Open" buttons in the Extensions settings section currently open files in the active leaf via `openLinkText(path, "")`. Changed to `openLinkText(path, "", true)` to open in a new leaf, matching the `NoteOpener` pattern used by tool execution.

---

## Changes by File

### `src/extensions/builtin-tool-scaffolds.ts` — Full tool implementations

**Scope:** Rewrite all 19 scaffold code blocks with working implementations adapted to the extension runtime.

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

**Conversion patterns applied to all 19 tools:**

| Built-in class pattern | Extension code equivalent |
|---|---|
| `this.app` / `this.app.vault` | `app` / `app.vault` |
| `this.app.metadataCache` | `app.metadataCache` |
| `this.app.fileManager` | `app.fileManager` |
| `this.staleTracker` | `utils.staleTracker` |
| `this.noteOpener` | `utils.noteOpener` |
| `this.checkpointManager` | `utils.checkpointManager` |
| `this.settings` | `utils.pluginSettings` |
| `resolveNote(p, vault, mc)` | `utils.resolveNote(p)` |
| `resolveAndValidatePath(p, root, allowed)` | `utils.resolveAndValidatePath(p)` |
| `executeShellCommand(cmd, settings, opts)` | `utils.executeShellCommand(cmd, opts)` |
| `logger("ToolName")` | `utils.logger("tool_name")` |
| `getFrontMatterInfo` | `obsidian.getFrontMatterInfo` |
| `requestUrl` | `obsidian.requestUrl` |
| `Notice` / `TFile` / `TFolder` | `obsidian.Notice` / `obsidian.TFile` / `obsidian.TFolder` |
| `normalizePath` | `obsidian.normalizePath` |
| `mammoth` / `PizZip` / `docx` / etc. | `libs.mammoth` / `libs.PizZip` / `libs.docx` / etc. |
| `TurndownService` / `gfm` | `libs.Turndown` / `libs.turndownGfm.gfm` |
| `marked` / `xmldom` | `libs.marked` / `libs.xmldom` |
| `import * as fs from "fs"` | `const fs = require("fs")` |
| `import * as crypto from "crypto"` | `const crypto = require("crypto")` |
| `return { success: false, error }` | `throw new Error(message)` |
| `return { success: true, result: val }` | `return val` |
| Private helper methods | Local `function` declarations in code block |

**Complexity tiers:**

| Tier | Tools | Est. lines per scaffold |
|---|---|---|
| Simple | `read_frontmatter`, `get_backlinks`, `get_outlinks`, `update_frontmatter`, `write_file` | 30-80 |
| Medium | `read_note`, `write_note`, `replace_in_note`, `manage_tags`, `move_note`, `list_vault`, `execute_command`, `replace_in_file` | 80-200 |
| Complex | `search_vault`, `fetch_webpage`, `web_search`, `read_file`, `read_docx`, `write_docx`, `extract_docx_comments` | 200-600 |

### `src/extensions/runtime-context.ts` — Add `pluginSettings`

```ts
// In ExtensionUtils interface:
/** Read-only reference to plugin settings for built-in tool scaffolds. */
pluginSettings: Record<string, unknown>;

// In buildUtils():
pluginSettings: plugin.settings as unknown as Record<string, unknown>,
```

~5 lines changed.

### `src/extensions/manager.ts` — Scaffold fallback in reload pipeline

After step 1 (discovery) and before step 2 (compilation), add a new step that injects scaffold defaults for missing built-in tools:

```ts
// 1b. Inject scaffold fallbacks for missing built-in tools
for (const [name, scaffold] of BUILTIN_TOOL_SCAFFOLDS) {
    // Skip if vault file was discovered with this name
    if (discovered.tools.some(t => t.name === name)) continue;

    // Parse scaffold content as if it were a vault file
    const parsed = parseExtensionFile(
        scaffold.scaffoldContent,
        extractFrontmatter(scaffold.scaffoldContent, this.parseYAML),
        `builtin:${name}`,
        this.parseYAML,
    );
    if ("message" in parsed) {
        errors.push({ filePath: `builtin:${name}`, message: parsed.message });
        continue;
    }
    if ("name" in parsed && "mode" in parsed) {
        discovered.tools.push(parsed as UserToolDefinition);
    }
}
```

This uses a synthetic `filePath` of `builtin:{name}` so scaffold-origin tools are distinguishable from vault-origin tools in logs and error messages.

**Helper needed:** `extractFrontmatter(content, parseYAML)` — a small function that parses frontmatter from raw Markdown content. This already exists as internal logic in `discovery.ts:parseOneExtensionFile()` lines 190-206. Extract it as a shared helper.

### `src/main.ts` — Remove built-in class registrations

In `getToolRegistry()` (lines 1105-1182):
- **Remove** all 19 tool class registrations (lines 1115-1156)
- **Remove** associated imports for tool classes
- **Keep** `UseSubagentTool` registration (lines 1159-1175)
- **Keep** dependency acquisition for `staleTracker`, `noteOpener`, `checkpointManager` only if still needed by `UseSubagentTool` (it doesn't use them — so remove those lines too)

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
2. `ExtensionManager.reload(true)` — discovers vault files, injects scaffold fallbacks, compiles, registers all 19 tools

### `src/settings/sections/extensions.ts` — Fix leaf opening

Two lines:
- Line 165: `openLinkText(vaultFilePath, "")` → `openLinkText(vaultFilePath, "", true)`
- Line 196: `openLinkText(path, "")` → `openLinkText(path, "", true)`

### `src/extensions/manager.ts` — Override detection update

The current override detection (lines 250-256) checks if a compiled user tool name exists in the registry AND is not in `registeredToolNames`. After migration, scaffold-provided tools ARE in `registeredToolNames` (they're registered by the extension manager). So "override" detection should change to: a vault-discovered tool that replaces a scaffold-provided tool.

```ts
// Detect user vault overrides of scaffold defaults
for (const tool of discovered.tools) {
    if (BUILTIN_TOOL_SCAFFOLDS.has(tool.name) && !tool.filePath.startsWith("builtin:")) {
        builtinOverrides.push(tool.name);
    }
}
```

### Test file updates

**Unit tests** (`src/extensions/__tests__/manager.test.ts`):
- Update "user tool with same name as built-in overwrites it" test — built-ins are now scaffolds, not class instances
- Add test: scaffold fallback registers tools when no vault files exist
- Add test: vault file overrides scaffold default
- Add test: `reload()` with empty vault produces 19 scaffold tools

**E2E test** (`e2e/scripts/user-extensions-test.ts`):
- Scenario 3 ("User tool is registered in ToolRegistry") needs updating — all 19 scaffold tools + `use_subagent` should be registered
- Scenario 12 ("Built-in tool scaffolds API returns all 20 built-in tools") — the scaffold map still has 19 entries (was 20 including read_note which is now 19 excluding use_subagent... actually `BUILTIN_TOOL_SCAFFOLDS` currently has all 20. After migration it has 19 — remove the `use_subagent` scaffold since it's not migrated)
- Scenario 13 ("ensureBuiltinToolVaultFile creates scaffold") — should still work but now the scaffold contains real code

---

## Per-Tool Conversion Notes

### Simple tools

| Tool | Key adaptation notes |
|---|---|
| `read_frontmatter` | Pure cache read via `app.metadataCache.getFileCache()`. Strip `position` key from frontmatter. ~40 lines. |
| `get_backlinks` | Iterate `app.metadataCache.resolvedLinks` reverse-lookup. ~35 lines. |
| `get_outlinks` | Read `resolvedLinks[path]` + `unresolvedLinks[path]`. Two-section markdown output. ~40 lines. |
| `update_frontmatter` | Uses `app.fileManager.processFrontMatter()`. Checkpoint creation. ~60 lines. |
| `write_file` | Uses `require("fs").promises.writeFile()`. Path validation via `utils.resolveAndValidatePath()`. ~50 lines. |

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
| `replace_in_file` | `require("fs")` for read/write. Binary detection (null-byte scan). Atomic in-memory search/replace. ~120 lines. |

### Complex tools

| Tool | Key adaptation notes |
|---|---|
| `search_vault` | Three helpers: `getCandidateFiles()`, `searchFile()`, `sortFileResults()` + `matchesGlob()`, `getBacklinkCounts()`. Regex with `/gm` flag, `lastIndex` reset between files. ~250 lines. |
| `fetch_webpage` | `obsidian.requestUrl()`. Turndown instance with GFM plugin + custom rules (strip nav/footer). `utils.pluginSettings` for timeout, size caps, denylist. Helpers: `isDomainBlocked()`, `getNetErrorHint()`. ~300 lines. |
| `web_search` | DuckDuckGo HTML scraping via `DOMParser`. `obsidian.requestUrl()` POST. Helpers: `cleanDDGUrl()`, `parseDDGResults()`. Domain denylist filtering. ~200 lines. |
| `read_file` | Binary detection, media format detection (magic bytes), image processing pipeline, PDF processing. `require("fs")`. `utils.pluginSettings` for image/PDF settings. ~200 lines. |
| `read_docx` | `libs.mammoth` conversion with image extraction callback. `require("crypto")` for MD5 dedup. Custom Turndown rule for images. ~200 lines. |
| `write_docx` | `libs.marked.lexer()` tokenization → `libs.docx` block generation. Template grafting via `libs.PizZip` + `libs.xmldom`. Helpers: `renderInline()`, `buildDocxChildren()`, `graftIntoTemplate()`, image resolution. ~600 lines. |
| `extract_docx_comments` | `libs.PizZip` for XML extraction. Comment threading, resolved filtering, `@mention` resolution. Idempotent append. ~300 lines. |

### Missing from `obsidian` exports

The `execute_command` tool checks `Platform.isDesktopApp`. This is not currently in `buildObsidianExports()`. Options:
- Add `Platform` to `buildObsidianExports()` (preferred — small addition, useful for any extension)
- OR hardcode the check as `true` in the scaffold (since the plugin is desktop-only). Less robust.

The `read_file` tool references image/PDF processing utilities from `src/media/`. These would need to either:
- Be inlined in the scaffold code (increases scaffold size significantly)
- Be exposed via a new `utils.media` namespace
- Be simplified (e.g., skip image resizing in the extension version, just return raw content)

**Recommendation:** Expose key media utilities via `utils`:
```ts
utils.detectMediaFormat: (buffer: Buffer) => MediaFormat | null
utils.processImage: (buffer: Buffer, mediaType: string, options: ImageOptions) => Promise<ContentBlock>
utils.processPdf: (buffer: Buffer, options: PdfOptions) => Promise<ContentBlock>
```

This avoids duplicating ~200 lines of media processing code in the scaffold and keeps it maintainable. The `read_file` scaffold would then be ~100 lines instead of ~300.

---

## Risk Assessment

### R-1: Compilation performance on boot

**Risk:** Compiling 19 tools via Sucrase + AsyncFunction on every plugin load adds latency.
**Estimate:** Sucrase `transform()` is fast (~1ms per tool). AsyncFunction construction is also fast. 19 tools should add < 50ms total.
**Mitigation:** Measure in e2e test. If problematic, consider caching compiled functions keyed by scaffold content hash.

### R-2: Scaffold code correctness

**Risk:** Converting 19 tool implementations to extension code may introduce subtle bugs (different `this` context, missing error paths, etc.).
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
  - New: `reload()` with empty vault produces 19 scaffold tools + correct names
  - New: vault file overrides scaffold default (vault file wins)
  - Updated: override detection uses `filePath.startsWith("builtin:")` check
  - New: scaffold-compiled tool executes correctly (invoke `read_note` scaffold, verify return value)

### E2E tests

- Update `user-extensions-test.ts`:
  - Scenario 3: verify all 19 scaffold tools + `use_subagent` registered (20 total)
  - New scenario: invoke a scaffold-provided tool (e.g., `read_note` via LLM) without any vault files
  - Scenario 13: after `ensureBuiltinToolVaultFile("read_note")` + reload, tool still works (now runs vault code, not scaffold)

### Manual verification

1. Fresh vault (no `notor/tools/` directory) → all tools available and functional
2. Click "Customize" on `read_note` → note opens in new tab with full implementation
3. Edit the customized note (e.g., add logging) → reload → verify modified behavior
4. Click "Reset to default" → reload → back to scaffold behavior
5. Complex tool test: `write_docx` scaffold generates a valid `.docx` file
