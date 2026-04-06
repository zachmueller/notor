# Built-in Tool Migration: Implementation Tasks

**Spec:** [builtin-tool-migration.md](builtin-tool-migration.md)
**Design:** [user-defined-tools.md](../../design/user-defined-tools.md)

---

## Phase 1: Type System & Extension Infrastructure

Foundation changes that all subsequent phases depend on. No behavioral changes yet — existing tools continue running as class-based built-ins.

### 1.1 Add `isScaffold` flag to `UserToolDefinition`

- [x] Add `isScaffold?: boolean` to `UserToolDefinition` in `src/extensions/types.ts:85-104`

### 1.2 Expand runtime context — Node.js modules

Adds `fs`, `crypto`, `path` to the extension runtime (D-3). Required by `read_file`, `write_file`, `replace_in_file`, `read_docx`, `write_docx`, `extract_docx_comments`, `execute_command`.

- [x] Add `fs`, `crypto`, `path` to `ExtensionLibs` interface in `src/extensions/runtime-context.ts:113-123`
- [x] Add `fs`, `crypto`, `path` to `buildLibs()` in `src/extensions/runtime-context.ts:131-143`

### 1.3 Expand runtime context — `Platform` export

Required by `execute_command` and `write_file` scaffolds for the `Platform.isDesktopApp` guard.

- [x] Add `Platform` to `ExtensionObsidianExports` interface in `src/extensions/runtime-context.ts:150-158`
- [x] Add `Platform` to `buildObsidianExports()` in `src/extensions/runtime-context.ts:163-173`

### 1.4 Expand runtime context — shared helpers

Utilities consumed by multiple scaffold tools. Must be added to `ExtensionUtils` interface and `buildUtils()`.

- [x] Add `ensureDirectoryExists(filePath: string)` to `ExtensionUtils` and `buildUtils()` — used by `write_note`, `move_note`, `extract_docx_comments` (~15 lines, inlined in `buildUtils`)
- [x] Add `isDomainBlocked(url, denylist)` to `ExtensionUtils` and `buildUtils()` — used by `fetch_webpage`, `web_search`
  - [x] Extract `isDomainBlocked()` from `src/tools/fetch-webpage.ts:86-122` into a standalone utility file (e.g., `src/utils/domain-denylist.ts`)
  - [x] Update import in `src/chat/dispatcher.ts:16` to use the extracted utility

### 1.5 Expand runtime context — media utilities

Required by the `read_file` scaffold for image/PDF processing.

- [x] Add `detectMediaFormat`, `processImage`, `processPdf` to `ExtensionUtils` interface
- [x] Implement in `buildUtils()` — `processPdf` wraps the underlying function, injecting `active_provider` and `pdf_native_max_size_mb` from plugin settings

### 1.6 Expand runtime context — DOCX utilities

Required by `write_docx` and `extract_docx_comments` scaffolds. Without these, scaffold code would exceed 900 lines.

- [x] Add `resolveImageForDocx(href, allowedPaths?)` to `ExtensionUtils` and `buildUtils()` — wraps `src/tools/docx-image-utils.ts:resolveImageForDocx`, injecting `vaultRootPath` and default `allowedPaths`
- [x] Add `graftDocxIntoTemplate(generatedZip, templateZip)` to `ExtensionUtils` and `buildUtils()`
  - [x] Extract `graftIntoTemplate()` from `src/tools/write-docx.ts:448-702` into a standalone utility file
- [x] Add `docxComments` namespace to `ExtensionUtils` and `buildUtils()` — passthrough of 7 functions from `src/tools/docx-comment-parser.ts` (`parseCommentsXml`, `parseCommentsExtendedXml`, `extractQuotedText`, `parsePeopleXml`, `buildCommentThreads`, `formatCommentsAsMarkdown`, `extractExistingCommentIds`)

### 1.7 Update `scaffold()` helper signature

Changes the scaffold helper in `src/extensions/builtin-tool-scaffolds.ts:34-66` to accept actual implementation code.

- [x] Rename `paramsYaml` to `yamlFenceContent` (now holds `params:` + `settings:` sections)
- [x] Add 5th parameter `code: string` for the implementation body
- [x] Update template to emit the `code` parameter instead of the placeholder `return "Not yet customized..."`
- [x] Update `${trimmedParams}` references to `${trimmedYaml}`

---

## Phase 2: Scaffold Fallback Pipeline

Wire `ExtensionManager.reload()` to inject scaffold defaults for missing built-in tools (D-1). After this phase, tools can be loaded from scaffolds — but the scaffolds still contain placeholder code until Phase 3.

### 2.1 Scaffold injection in `reload()`

Add scaffold fallback step between discovery (step 1) and compilation (step 2) in `src/extensions/manager.ts:203-300`.

- [x] After `discoverExtensions()`, iterate `BUILTIN_TOOL_SCAFFOLDS` and check which names are missing from `discovered.tools`
- [x] For each missing scaffold, construct frontmatter from scaffold metadata and call `parseExtensionFile()` with scaffold content
- [x] Mark injected tools with `isScaffold = true`
- [x] Push scaffold tools into `discovered.tools` so they flow through the existing compilation pipeline

### 2.2 Update override detection

Current logic in `src/extensions/manager.ts:250-256` checks `registry.has(name) && !registeredToolNames.has(name)`. After migration, scaffold tools ARE in `registeredToolNames`, so override detection must change.

- [x] Change override detection to: iterate `compiledTools`, check `BUILTIN_TOOL_SCAFFOLDS.has(name) && !tool.isScaffold`
- [x] This correctly identifies vault-discovered tools that replace scaffold defaults

### 2.3 Scaffold compilation failure handling

Scaffold failure is more critical than user extension failure (no class-based fallback).

- [x] In the compilation step (step 2), detect `tool.isScaffold === true` on failure
- [x] Show a distinct critical-level Notice: `"CRITICAL: Built-in tool '${name}' failed to load. The plugin may not function correctly."`

### 2.4 Refactor: extract `extractFrontmatter()` helper

Extract manual YAML parsing logic from `src/extensions/discovery.ts:parseOneExtensionFile()` (lines 190-206) into a standalone helper.

- [x] Create `extractFrontmatter(content, parseYAML)` helper function
- [x] Update `parseOneExtensionFile()` to use the extracted helper
- [x] Note: scaffold injection does NOT use this helper — it constructs frontmatter directly

---

## Phase 3: Scaffold Implementations (Trivial + Straightforward Tools)

Write actual tool implementations in the scaffold code blocks. Grouped by complexity tier so simpler tools are validated first.

### 3.1 Trivial tools — zero settings, minimal dependencies

These tools have no per-extension settings, no external library deps, and are pure Obsidian API usage. ~20-65 lines each. See [feasibility/trivial-tools.md](feasibility/trivial-tools.md) for detailed dependency tables, gotchas, and scaffold outlines.

- [x] `read_frontmatter` — cache read via `app.metadataCache.getFileCache()`, strip `position` key. ~20 lines. ([feasibility](feasibility/trivial-tools.md#read_frontmatter--feasibility-trivial-))
- [x] `get_backlinks` — reverse-lookup of `app.metadataCache.resolvedLinks`. ~20 lines. ([feasibility](feasibility/trivial-tools.md#get_backlinks--feasibility-trivial-))
- [x] `get_outlinks` — read `resolvedLinks[path]` + `unresolvedLinks[path]`. ~35 lines. ([feasibility](feasibility/trivial-tools.md#get_outlinks--feasibility-trivial-))
- [x] `update_frontmatter` — `app.fileManager.processFrontMatter()`, checkpoint creation. ~60 lines. Note: correct YAML schema `set` param from `type: string` to `type: object`. ([feasibility](feasibility/trivial-tools.md#update_frontmatter--feasibility-trivial-))
- [x] `read_note` — `utils.resolveNote()`, `obsidian.getFrontMatterInfo()`, stale tracker read, note opener. ~60 lines. ([feasibility](feasibility/trivial-tools.md#read_note--feasibility-trivial-))
- [x] `manage_tags` — `app.fileManager.processFrontMatter()`, tag normalization helpers. ~65 lines. Handle diverse input shapes (string vs array), delete empty tags key. ([feasibility](feasibility/trivial-tools.md#manage_tags--feasibility-trivial-))

### 3.2 Straightforward tools — small inlined helpers, standard deps

~75-120 lines each. Require `libs.fs`/`libs.path`/`obsidian.Platform` (from Phase 1.2-1.3) and `utils.ensureDirectoryExists` (from Phase 1.4). See [feasibility/straightforward-tools.md](feasibility/straightforward-tools.md) for detailed dependency tables, gotchas, and scaffold outlines. `write_file` is assessed in [feasibility/trivial-tools.md](feasibility/trivial-tools.md#write_file--feasibility-trivial-).

- [x] `write_file` — `libs.fs.promises.writeFile()`, path validation via `utils.resolveAndValidatePath()`, `Platform.isDesktopApp` guard. ~50 lines. ([feasibility](feasibility/trivial-tools.md#write_file--feasibility-trivial-))
- [x] `replace_in_file` — `libs.fs` read/write, binary detection (null-byte scan on first 8KB), atomic in-memory search/replace. ~120 lines. ([feasibility](feasibility/straightforward-tools.md#replace_in_file--feasibility-straightforward-))
- [x] `execute_command` — `utils.executeShellCommand()`, path validation for working dir, `Platform.isDesktopApp` guard, partial output on timeout/non-zero exit. ~80 lines. ([feasibility](feasibility/straightforward-tools.md#execute_command--feasibility-straightforward-))
- [x] `write_note` — stale check, checkpoint, `app.vault.process()`, frontmatter preservation (prepend old frontmatter when new content lacks it), `utils.ensureDirectoryExists()`. ~120 lines. ([feasibility](feasibility/straightforward-tools.md#write_note--feasibility-straightforward-))
- [x] `replace_in_note` — JSON-parsed change blocks, atomic `vault.process()`, stale check + checkpoint, regex `lastIndex` reset. ~130 lines. ([feasibility](feasibility/straightforward-tools.md#replace_in_note--feasibility-straightforward-))
- [x] `move_note` — `app.fileManager.renameFile()`, optional alias insertion, `utils.ensureDirectoryExists()`. ~120 lines. ([feasibility](feasibility/straightforward-tools.md#move_note--feasibility-straightforward-))
- [x] `list_vault` — `app.vault.getFiles()` / `getAbstractFileByPath()`, helpers (`collectItems`, `classifyFile`, `sortItems`), pagination. ~160 lines. ([feasibility](feasibility/straightforward-tools.md#list_vault--feasibility-straightforward-))

---

## Phase 4: Scaffold Implementations (Moderate + Complex Tools)

### 4.1 Moderate tools — external library deps and/or settings

~100-250 lines each. Require library access (`Turndown`, `mammoth`, etc.) and some require per-extension or shared settings. See [feasibility/moderate-tools.md](feasibility/moderate-tools.md) for detailed dependency tables, gotchas, and scaffold outlines.

- [x] `search_vault` — helpers (`getCandidateFiles`, `searchFile`, `sortFileResults`, `matchesGlob`, `getBacklinkCounts`), regex `/gm` with `lastIndex` reset. No settings. ~250 lines. ([feasibility](feasibility/moderate-tools.md#search_vault--feasibility-moderate-))
- [x] `fetch_webpage` — `obsidian.requestUrl()`, `libs.Turndown` with GFM plugin + custom rules (strip nav/footer), `utils.isDomainBlocked()`, error diagnostic probing, `getNetErrorHint()` helper. Per-extension settings: `fetch_webpage_timeout`, `fetch_webpage_max_download_mb`, `fetch_webpage_max_output_chars`. Shared settings: `domain_denylist`. ~300 lines. ([feasibility](feasibility/moderate-tools.md#fetch_webpage--feasibility-moderate-))
- [x] `web_search` — DuckDuckGo HTML scraping via native `DOMParser`, `obsidian.requestUrl()` POST, `utils.isDomainBlocked()`, helpers (`cleanDDGUrl`, `parseDDGResults`). Per-extension settings: `web_search_timeout`, `web_search_default_num_results`. Shared settings: `domain_denylist`. ~200 lines. ([feasibility](feasibility/moderate-tools.md#web_search--feasibility-moderate-))
- [x] `read_file` — binary detection, `utils.detectMediaFormat()`, `utils.processImage()`, `utils.processPdf()`, `libs.fs`. Per-extension settings: `image_max_dimension`, `image_compression_quality`, `pdf_prefer_native`, `pdf_text_max_chars`, `pdf_native_max_size_mb`. Verify `UserToolAdapter` correctly forwards `content_blocks` in return value. ~200 lines. ([feasibility](feasibility/moderate-tools.md#read_file--feasibility-moderate-))
- [x] `read_docx` — `libs.mammoth` with image extraction callback (~45 lines callback), `libs.crypto` for MD5 dedup, `libs.Turndown` with custom image rule. ~200 lines. ([feasibility](feasibility/moderate-tools.md#read_docx--feasibility-moderate-))

### 4.2 Complex tools — large scaffolds with utility delegation

These are the largest scaffolds. Feasible only because infrastructure logic was extracted to `utils` in Phase 1.6. See [feasibility/complex-tools.md](feasibility/complex-tools.md) for detailed dependency tables, pipeline breakdowns, and scaffold outlines.

- [x] `extract_docx_comments` — `libs.PizZip` for ZIP extraction, `utils.docxComments` for all parsing/threading/formatting, `utils.ensureDirectoryExists()`. Scaffold handles I/O orchestration only. ~200 lines. ([feasibility](feasibility/complex-tools.md#extract_docx_comments--feasibility-high-complexity-viable-with-utils-expansion-))
- [x] `write_docx` — `libs.marked.lexer()` tokenization, `libs.docx` block generation, `utils.resolveImageForDocx()` and `utils.graftDocxIntoTemplate()` for infrastructure. Inlines `renderInline()`, `buildDocxChildren()`, `collectImageHrefs()`, `scaleImageDimensions()` as local functions (customization points). Per-extension settings: `write_docx_default_output_dir`, `write_docx_default_template_path`. ~500-550 lines — largest scaffold. ([feasibility](feasibility/complex-tools.md#write_docx--feasibility-high-complexity-viable-with-utils-expansion-))

---

## Phase 5: Built-in Shared Settings Scaffold (D-8)

Provides default shared settings (`domain_denylist`, `read_file_allowed_paths`) when no `notor/settings.md` exists.

- [ ] Create a built-in shared settings schema constant (analogous to `BUILTIN_TOOL_SCAFFOLDS`)
- [ ] In `ExtensionManager.reload()`, after checking `discovered.sharedSettings`, fall back to the built-in schema if no user-authored `notor/settings.md` was found
- [ ] Schema declares `domain_denylist` (type: `string[]`, default: `[]`) and `read_file_allowed_paths` (type: `string[]`, default: `[]`)
- [ ] Vault file wins if present (same precedence as tool scaffolds)

---

## Phase 6: Settings Migration (D-2)

One-time migration of old `NotorSettings` tool fields into the extension settings system. Must run after Phase 5 (shared settings scaffold) so the target settings infrastructure exists.

### 6.1 Implement `migrateToolSettingsToExtensions()`

Private method on the plugin class, called inside `loadSettings()` after `Object.assign()` merge.

- [ ] Implement per-tool-group detection: check `user_extension_settings[toolName]` is `undefined` AND old field exists in settings
- [ ] Migrate `fetch_webpage` group: `fetch_webpage_timeout`, `fetch_webpage_max_download_mb`, `fetch_webpage_max_output_chars`
- [ ] Migrate `web_search` group: `web_search_timeout`, `web_search_default_num_results`
- [ ] Migrate `execute_command` group: `execute_command_allowed_paths`, `execute_command_timeout`, `execute_command_max_output_chars`
- [ ] Migrate `read_file` group: `image_max_dimension`, `image_compression_quality`, `pdf_prefer_native`, `pdf_text_max_chars`, `pdf_native_max_size_mb`
- [ ] Migrate `write_docx` group: `write_docx_default_output_dir`, `write_docx_default_template_path`
- [ ] Migrate shared settings: `domain_denylist` and `read_file_allowed_paths` into `user_shared_settings`
- [ ] Two-phase write: (1) copy values + `saveSettings()`, (2) delete old fields + `saveSettings()`
- [ ] Show `new Notice("Tool settings have been migrated to Extensions in Settings.")` on success

### 6.2 Remove old settings UI sections

These settings now render through the extension settings UI via each scaffold's `settingsSchema`.

- [ ] Remove or gut the tool-specific settings sections: `src/settings/sections/fetch-webpage.ts`, `src/settings/sections/web-search.ts`, `src/settings/sections/execute-command.ts`, `src/settings/sections/docx-tools.ts`
- [ ] Remove image/PDF settings from `src/settings/sections/media.ts` that are now per-extension settings on `read_file` (keep non-tool media settings if any)
- [ ] Remove the old field declarations from `NotorSettings` in `src/settings/types.ts` (lines 138-177 for fetch/search/command, lines 268-295 for image/PDF/docx)
- [ ] Remove old defaults from `src/settings/defaults.ts`

---

## Phase 7: Remove Class-Based Built-in Registrations

Flip the switch: built-in tools now load exclusively through the scaffold pipeline.

### 7.1 Strip `getToolRegistry()` in `src/main.ts`

- [ ] Remove all 20 tool class registrations from `getToolRegistry()` (lines 1115-1156) — keep only `UseSubagentTool` (lines 1159-1175)
- [ ] Remove tool class imports (lines 66-85). Keep `ToolRegistry` (line 65) and `NoteOpener` (line 86, still used by `runtime-context.ts` and `getNoteOpener()`)
- [ ] Remove lines passing `staleTracker`, `noteOpener`, `checkpointManager` into tool constructors (the getter methods remain — used elsewhere)
- [ ] Update or remove the comment at `main.ts:474-476` about boot ordering

### 7.2 Remove `execute_command` pre-validation from dispatcher

- [ ] Remove the working directory pre-check block at `src/chat/dispatcher.ts:366-392` — after migration, the scaffold's own `resolveAndValidatePath()` produces the same error

### 7.3 Clear static `TOOL_PATH_PARAMS`

- [ ] Replace the static entries in `src/tool-config/path-enforcer.ts:27-48` with an empty object: `export const TOOL_PATH_PARAMS: Record<string, ToolPathParam[]> = {};`
- [ ] Dynamic registration in `manager.ts:278-280` becomes the single source of truth

### 7.4 Delete tool class files (optional cleanup)

After confirming all scaffolds work correctly, the class files in `src/tools/` can be removed. Keep files that are still imported as utilities.

- [ ] Identify which `src/tools/*.ts` files are still imported by extracted utilities or other non-tool code (e.g., `docx-comment-parser.ts` is imported by `runtime-context.ts`, `docx-image-utils.ts` is imported by `runtime-context.ts`)
- [ ] Delete class files that are no longer imported anywhere: `read-note.ts`, `search-vault.ts`, `list-vault.ts`, `read-frontmatter.ts`, `get-backlinks.ts`, `get-outlinks.ts`, `write-note.ts`, `replace-in-note.ts`, `update-frontmatter.ts`, `manage-tags.ts`, `move-note.ts`, `fetch-webpage.ts` (after `isDomainBlocked` extraction), `web-search.ts`, `execute-command.ts`, `read-file.ts`, `read-docx.ts`, `write-docx.ts` (after `graftIntoTemplate` extraction), `write-file.ts`, `replace-in-file.ts`, `extract-docx-comments.ts`
- [ ] Keep: `tool.ts` (Tool interface), `index.ts` (ToolRegistry class), `use-subagent.ts`, `note-opener.ts`, `docx-comment-parser.ts`, `docx-image-utils.ts`, and any newly extracted utility files
- [ ] Update `src/tools/index.ts` to remove re-exports of deleted classes

---

## Phase 8: Tests

### 8.1 Unit tests — `src/extensions/__tests__/manager.test.ts`

- [ ] Add test: `reload()` with empty vault produces 20 scaffold tools with correct names
- [ ] Add test: scaffold tools have `isScaffold: true`
- [ ] Add test: vault file overrides scaffold default (vault file wins, `isScaffold: false`)
- [ ] Update "detects built-in tool overrides" test — built-ins are now scaffolds, not class instances
- [ ] Add test: scaffold compilation failure shows critical Notice (distinct from user extension error)
- [ ] Add test: scaffold-compiled tool executes correctly (invoke a simple scaffold like `read_frontmatter`, verify return)

### 8.2 E2E tests — `e2e/scripts/user-extensions-test.ts`

- [ ] Update Scenario 3 ("User tool is registered in ToolRegistry") — verify scaffold-provided tools (e.g., `read_note`, `search_vault`) coexist with user-created test tools. Assert presence of representative scaffolds, not a hard total count.
- [ ] Add scenario: invoke a scaffold-provided tool (e.g., `read_note`) without any vault files — verify it works end-to-end
- [ ] Update Scenario 13 ("ensureBuiltinToolVaultFile creates scaffold") — scaffold now contains real implementation code, not placeholder
- [ ] Verify Scenario 12 ("Built-in tool scaffolds API returns all 20 built-in tools") still passes — no changes expected

### 8.3 Settings migration tests

- [ ] Add unit test: migration copies old `NotorSettings` fields into `user_extension_settings` and `user_shared_settings`
- [ ] Add unit test: migration deletes old fields after successful copy
- [ ] Add unit test: migration skips groups where `user_extension_settings[toolName]` already exists
- [ ] Add unit test: crash between phase 1 and phase 2 does not cause re-migration on next boot

### 8.4 Manual verification checklist

- [ ] Fresh vault (no `notor/tools/`) — all 20 tools available and functional
- [ ] Click "Customize" on `read_note` — note opens in new leaf with full implementation (not placeholder)
- [ ] Edit customized note (e.g., add logging) — reload — verify modified behavior
- [ ] Click "Reset to default" — reload — back to scaffold behavior
- [ ] Complex tool: `write_docx` scaffold generates a valid `.docx` file
- [ ] Complex tool: `extract_docx_comments` correctly parses a DOCX with review comments
- [ ] Settings migration: upgrade from pre-migration plugin version — verify old settings appear in extension settings UI
- [ ] `pdf_native_max_size_mb` behavior change: test with >10 MB PDF — verify limit is now respected (R-2)

---

## Phase Dependency Graph

```
Phase 1 (Infrastructure)
  ├── Phase 2 (Scaffold Pipeline)  ─── depends on 1.1, 1.7
  │     └── Phase 3 (Trivial + Straightforward Scaffolds)  ─── depends on 1.2, 1.3, 1.4
  │           └── Phase 4 (Moderate + Complex Scaffolds)  ─── depends on 1.5, 1.6
  │                 └── Phase 7 (Remove Class Registrations)  ─── depends on all scaffolds working
  ├── Phase 5 (Shared Settings Scaffold)  ─── depends on 2.1
  │     └── Phase 6 (Settings Migration)  ─── depends on Phase 5 + Phase 4
  └── Phase 8 (Tests)  ─── runs alongside each phase; final verification after Phase 7
```

**Critical path:** Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 7

**Parallel work:** Phase 5 can start as soon as Phase 2 is done. Phase 6 can start as soon as Phases 4+5 are done. Tests (Phase 8) should be written incrementally as each phase completes.
