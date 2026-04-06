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

**Boot-timing note:** Between `getToolRegistry()` (registers only `use_subagent`) and `ExtensionManager.reload()` (registers remaining 20 tools), the registry is incomplete. This is safe because `reload()` runs inside `onLayoutReady()` and no chat session can start before layout is ready. The ToolDispatcher is created on-demand when the chat orchestrator is first accessed, which in practice always happens after `reload()` completes (reload takes <5ms, and user interaction is required to trigger the orchestrator). This ordering is not architecturally guaranteed, but the race is negligible — we accept the risk of UX problems in rare edge cases rather than adding a guard. Explicitly out of scope to resolve.

## Design Decisions

### D-1: Scaffold fallback (no auto-created vault files)

When `ExtensionManager.reload()` discovers that a built-in tool has no corresponding vault file in `notor/tools/`, it loads the pre-compiled scaffold from the in-memory `BUILTIN_TOOL_SCAFFOLDS` map. No vault file is created automatically.

**Why:** Auto-creating 20 `.md` files in the vault on first boot would be surprising and clutter the user's notor directory. The scaffold-as-fallback approach is invisible — tools work out of the box. Vault files only appear when the user explicitly clicks "Customize".

**How it works:**
1. `discoverExtensions()` returns vault-discovered tools (existing behavior, unchanged)
2. After discovery, `reload()` iterates `BUILTIN_TOOL_SCAFFOLDS` and checks which names are missing from the discovered set
3. For each missing scaffold, it constructs a frontmatter object directly from the scaffold metadata (name, description, mode) and passes it to `parseExtensionFile()` along with the scaffold content — no re-parsing of YAML frontmatter needed since the metadata is already structured
4. Scaffold tools are marked with `isScaffold: true` on the `UserToolDefinition` (this field must be added to the interface — see `src/extensions/types.ts` changes below) and compiled via runtime Sucrase in the same pipeline as user vault files (D-7 pre-compilation was considered but rejected — see ~~D-7~~)
5. If a vault file exists with the same name as a scaffold, the vault file wins (discovered tools take precedence over scaffold fallbacks)

### D-2: Migrate tool settings into the extension settings system (hybrid)

Several built-in tools directly reference `NotorSettings` fields. These settings are migrated into the extension settings system using both channels defined in `design/user-defined-tools.md`: per-extension `settings` for single-tool fields, and global `shared` for cross-tool fields.

**Per-extension `settings`** (declared in each scaffold's YAML fence):

| Tool | Settings fields |
|---|---|
| `fetch_webpage` | `fetch_webpage_timeout`, `fetch_webpage_max_download_mb`, `fetch_webpage_max_output_chars` |
| `web_search` | `web_search_timeout`, `web_search_default_num_results` |
| `execute_command` | `execute_command_allowed_paths`, `execute_command_timeout`, `execute_command_max_output_chars` |
| `read_file` | `image_max_dimension`, `image_compression_quality`, `pdf_prefer_native`, `pdf_text_max_chars`, `pdf_native_max_size_mb` (**bug fix:** this setting exists in `NotorSettings` and has a UI but is currently never passed to `processPdf()` — this migration wires it through) |
| `write_docx` | `write_docx_default_output_dir`, `write_docx_default_template_path` |

**`shared` settings** (cross-tool, declared via built-in shared settings scaffold — see D-8):

| Setting | Used by |
|---|---|
| `domain_denylist` | fetch_webpage, web_search |
| `read_file_allowed_paths` | read_file, write_file, replace_in_file, read_docx, write_docx, extract_docx_comments |

**Settings-free tools:** read_note, write_note, replace_in_note, search_vault, list_vault, read_frontmatter, update_frontmatter, manage_tags, move_note, get_backlinks, get_outlinks — these reference zero `NotorSettings` fields and migrate without any settings plumbing.

**Why hybrid:** The design doc defines two settings channels — per-extension `settings` and global `shared` settings. Using per-extension for single-tool fields keeps settings co-located with the tool that owns them. Using `shared` for cross-tool fields (`domain_denylist` shared by 2 tools, `read_file_allowed_paths` shared by 6 tools) avoids duplication. An alternative of exposing `utils.pluginSettings` was considered but rejected — it would introduce a read-only third channel outside the extension settings model.

**Data migration:** A one-time migration moves old `NotorSettings` tool fields into the extension settings system. The old plugin settings UI sections for these fields are removed — they now render in the extension settings UI via each scaffold's `settingsSchema`.

**Detection:** Per-tool key check. For each built-in tool that has settings (fetch_webpage, web_search, execute_command, read_file, write_docx), check whether its key is absent from `user_extension_settings` (e.g., `user_extension_settings["fetch_webpage"]` is `undefined`) AND the corresponding old field exists in `NotorSettings` (e.g., `fetch_webpage_timeout` is present in the loaded data). For shared settings, check whether the key is absent from `user_shared_settings` (e.g., `user_shared_settings["domain_denylist"]` is `undefined`) AND the old field exists. Migration runs per-tool-group: each group migrates independently if its detection condition holds. No settings version field is needed.

**Edge case:** If a user has manually set `user_extension_settings["fetch_webpage"]` to `{}` (empty object), the `undefined` check would see it as defined and skip migration, silently losing old settings. This is an accepted risk — the scenario requires direct JSON editing of `data.json` and is unlikely in practice.

**Why per-key:** A whole-object emptiness check (`user_extension_settings === {}`) would fail for users who already have extension settings configured for user-defined tools — the migration would never trigger, silently losing their old built-in tool customizations when phase 2 deletes the old fields.

**Scope:** Unconditional within each group — copy all old field values (including those that match defaults) so every setting appears in the new extension settings UI from the start.

**Atomicity:** Two-phase write to prevent data loss:
1. Copy all old field values into `user_extension_settings` (per-tool) and `user_shared_settings` (cross-tool). Call `saveSettings()`.
2. Delete the old fields from `NotorSettings`. Call `saveSettings()` again.
If the plugin crashes between phase 1 and phase 2, the next boot sees old fields still present but `user_extension_settings` already populated — the per-key detection condition is false for already-migrated groups, so migration does not re-run those groups. The old fields become harmless dead data.

**Downgrade note:** Users who revert to a pre-migration plugin version will lose customized values (old fields are cleared in phase 2). The older version will apply its defaults. This is acceptable.

**Location:** Migration runs inside `loadSettings()` (main.ts) after the `Object.assign()` merge, before returning. Implemented as a private `migrateToolSettingsToExtensions()` method on the plugin class.

**Field mapping:**

| Old `NotorSettings` field | New location | New key |
|---|---|---|
| `fetch_webpage_timeout` | `user_extension_settings["fetch_webpage"]` | `fetch_webpage_timeout` |
| `fetch_webpage_max_download_mb` | `user_extension_settings["fetch_webpage"]` | `fetch_webpage_max_download_mb` |
| `fetch_webpage_max_output_chars` | `user_extension_settings["fetch_webpage"]` | `fetch_webpage_max_output_chars` |
| `web_search_timeout` | `user_extension_settings["web_search"]` | `web_search_timeout` |
| `web_search_default_num_results` | `user_extension_settings["web_search"]` | `web_search_default_num_results` |
| `execute_command_allowed_paths` | `user_extension_settings["execute_command"]` | `execute_command_allowed_paths` |
| `execute_command_timeout` | `user_extension_settings["execute_command"]` | `execute_command_timeout` |
| `execute_command_max_output_chars` | `user_extension_settings["execute_command"]` | `execute_command_max_output_chars` |
| `image_max_dimension` | `user_extension_settings["read_file"]` | `image_max_dimension` |
| `image_compression_quality` | `user_extension_settings["read_file"]` | `image_compression_quality` |
| `pdf_prefer_native` | `user_extension_settings["read_file"]` | `pdf_prefer_native` |
| `pdf_text_max_chars` | `user_extension_settings["read_file"]` | `pdf_text_max_chars` |
| `pdf_native_max_size_mb` | `user_extension_settings["read_file"]` | `pdf_native_max_size_mb` |
| `write_docx_default_output_dir` | `user_extension_settings["write_docx"]` | `write_docx_default_output_dir` |
| `write_docx_default_template_path` | `user_extension_settings["write_docx"]` | `write_docx_default_template_path` |
| `domain_denylist` | `user_shared_settings` | `domain_denylist` |
| `read_file_allowed_paths` | `user_shared_settings` | `read_file_allowed_paths` |

**Notice:** Show `new Notice("Tool settings have been migrated to Extensions in Settings.")` after successful migration.

**Note on `active_provider` and `pdf_native_max_size_mb`:** The `read_file` tool passes `this.settings.active_provider` to `processPdf()` for provider-dependent PDF handling. Rather than exposing these as settings, `utils.processPdf` reads `active_provider` and `pdf_native_max_size_mb` internally from the plugin instance (see runtime-context.ts changes), converting the latter to bytes as `maxNativeSizeBytes`. Scaffold code calls `utils.processPdf(buffer, { pages, maxTextChars, preferNative })` without needing to know the active provider or native size limit. Note: `pdf_native_max_size_mb` exists in `NotorSettings` today but is never actually passed to `processPdf()` — this migration fixes that bug.

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

**`scaffold()` helper signature change:** The current signature is `scaffold(name, description, mode, paramsYaml)` with 4 parameters. It generates placeholder code (`return "Not yet customized..."`). The new signature adds a 5th parameter `code` for the actual implementation, and renames `paramsYaml` to `yamlFenceContent` since the YAML fence now holds both `params:` and `settings:` sections:

```ts
function scaffold(
  name: string,
  description: string,
  mode: "read" | "write",
  yamlFenceContent: string,  // renamed from paramsYaml — now holds params + settings YAML
  code: string,              // NEW: actual implementation code (replaces placeholder)
): BuiltinToolScaffold
```

`yamlFenceContent` contains both `params:` and `settings:` sections for tools that declare per-extension settings (fetch_webpage, web_search, execute_command, read_file, write_docx). Tools without settings pass only the `params:` section as before.

The template changes from generic placeholder to per-tool code (and `${trimmedParams}` becomes `${trimmedYaml}` to match the renamed parameter):
```
\`\`\`yaml
${trimmedYaml}
\`\`\`

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
| `return { success: false, error }` | `throw new Error(message)` (adapter sets `tool_name`, `result: ""` automatically) |
| `return { success: true, result: val }` | `return val` (adapter wraps with `tool_name`, `success: true`) |
| Private helper methods | Local `function` declarations in code block |

**Complexity tiers:**

| Tier | Tools | Est. lines per scaffold |
|---|---|---|
| Simple | `read_frontmatter`, `get_backlinks`, `get_outlinks`, `update_frontmatter`, `write_file` | 40-100 |
| Medium | `read_note`, `write_note`, `replace_in_note`, `manage_tags`, `move_note`, `list_vault`, `execute_command`, `replace_in_file` | 80-280 |
| Complex | `search_vault`, `fetch_webpage`, `web_search`, `read_file`, `read_docx`, `extract_docx_comments` | 200-400 |
| Complex+ | `write_docx` | 600-1100 |

**Pre-plan research task:** Before writing scaffold implementations, deep-dive ALL 20 built-in tool source files and assess each tool's feasibility of migrating with the current plan. For tools with large or complex helper logic (especially `write_docx` at ~1,041 lines with template grafting, rId conflict resolution, and media merging), evaluate whether additional logic should be exposed via `utils` (or another mechanism) rather than inlined in the scaffold code block. Document findings and any recommended `utils` expansions before proceeding with implementation.

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
processPdf: (buffer, options) => processPdf(buffer, { ...options, providerType: plugin.settings.active_provider, maxNativeSizeBytes: plugin.settings.pdf_native_max_size_mb * 1024 * 1024 }),
```

Note: `utils.processPdf` wraps the underlying `processPdf` function, injecting `active_provider` and `pdf_native_max_size_mb` (converted to bytes as `maxNativeSizeBytes`) from plugin settings. Scaffold code does not need to know about the active provider or the native size limit — it calls `utils.processPdf(buffer, { pages, maxTextChars, preferNative })`.

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

**Scaffold compilation failure handling:** In step 2 (compilation), if a scaffold-marked tool fails to compile, show a prominent critical-level Notice distinct from user extension errors: `"CRITICAL: Built-in tool '${name}' failed to load. The plugin may not function correctly."` This is important because scaffold compilation failure means a core tool is unavailable with no class-based fallback — unlike user extension failures (which are expected and recoverable), a scaffold failure indicates a plugin bug.

**Refactor:** Extract the manual YAML parsing logic from `discovery.ts:parseOneExtensionFile()` (lines 190-206) into a standalone `extractFrontmatter(content, parseYAML)` helper. This cleans up `parseOneExtensionFile()` and provides a reusable utility for future code that needs to parse frontmatter from raw markdown content (e.g., template imports, clipboard paste). Note: the scaffold injection above does NOT use this helper — it constructs frontmatter directly from structured metadata.

### `src/tool-config/path-enforcer.ts` — Remove static `TOOL_PATH_PARAMS` entries

The static `TOOL_PATH_PARAMS` object (lines 27-48) hardcodes path param entries for 14 built-in tools. After migration, these are populated dynamically by `ExtensionManager.reload()` from each scaffold's YAML fence `path_namespace` declarations. Remove the static entries and replace with an empty initializer:

```ts
export const TOOL_PATH_PARAMS: Record<string, ToolPathParam[]> = {};
```

The dynamic registration in `manager.ts:278-280` becomes the single source of truth. See R-7 for rationale.

### `src/extensions/types.ts` — Add `isScaffold` flag

Add an optional `isScaffold` property to `UserToolDefinition`. This field does not exist today and must be created:

```ts
export interface UserToolDefinition {
    // ... existing fields ...
    /** True when this tool was loaded from a built-in scaffold (no vault file). */
    isScaffold?: boolean;
}
```

This is required for the `toolDef.isScaffold = true` assignment in manager.ts scaffold injection and the `!tool.isScaffold` check in override detection.

### `src/main.ts` — Remove built-in class registrations

In `getToolRegistry()` (lines 1105-1182):
- **Remove** all 20 tool class registrations (lines 1115-1156)
- **Remove** tool class imports (lines 66-85). Keep line 65 (`ToolRegistry`) and line 86 (`NoteOpener` — still needed by `runtime-context.ts:81` for `utils.noteOpener` and by `getNoteOpener()` in main.ts)
- **Keep** `UseSubagentTool` registration (lines 1159-1175)
- **Remove** the lines in `getToolRegistry()` that pass `staleTracker`, `noteOpener`, and `checkpointManager` into tool constructors. The getter methods themselves (`getStaleTracker()`, `getNoteOpener()`, `getCheckpointManager()`) remain — they are used elsewhere in main.ts (conversation lifecycle management, settings save, etc.)

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
- Scenario 3 ("User tool is registered in ToolRegistry") needs updating — verify that scaffold-provided tools (e.g., `read_note`, `search_vault`) coexist with user-created test tools in the registry. Assert presence of representative scaffold tools rather than a hard total count (a hard count would break whenever a tool is added or removed)
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
| `write_docx` | `libs.marked.lexer()` tokenization → `libs.docx` block generation. Template grafting via `libs.PizZip` + `libs.xmldom`. Helpers: `renderInline()`, `buildDocxChildren()`, `graftIntoTemplate()` (~250 lines alone, with rId conflict resolution and media file merging), image resolution. ~600-1100 lines — the largest scaffold by far. Feasibility of inlining vs. expanding `utils` should be assessed in the pre-plan research task. |
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

Note: `utils.processPdf` wraps the underlying `processPdf` function and injects `active_provider` and `pdf_native_max_size_mb` (as `maxNativeSizeBytes`, converted to bytes) from plugin settings internally. Scaffold code does not need to pass the provider type or native size limit. `processPdf` returns `{ contentBlocks, textSummary }`, not a single `ContentBlock` — the `read_file` scaffold must handle the real return shape.

This avoids duplicating ~200 lines of media processing code in the scaffold and keeps it maintainable. The `read_file` scaffold would then be ~100 lines instead of ~300.

---

## Risk Assessment

### R-1: Compilation performance on boot

**Risk:** Compiling 20 tools via Sucrase + AsyncFunction on every plugin load adds latency.
**Mitigation:** Sucrase transforms ~1M lines/sec. All 20 scaffolds together are <5ms. Additionally, `parseExtensionFile()` runs `extractCodeFence()` and `extractYamlFence()` regex scans over each scaffold's content (~3000 total lines across all 20 scaffolds) — this is also negligible. Log the timing during implementation to verify. If profiling later shows this is a bottleneck, build-time pre-compilation can be added as a follow-up.

### R-2: `pdf_native_max_size_mb` behavior change

**Risk:** The `read_file` scaffold wires `pdf_native_max_size_mb` through to `processPdf()` for the first time (fixing a bug where the setting was ignored). This changes observable behavior: users with PDFs larger than the configured limit (default 10 MB) will now get text extraction instead of native PDF document blocks. Previously the limit was never enforced.
**Mitigation:** Call out in release notes. Verify in manual testing with a >10 MB PDF that the limit is respected. Ensure the default (10 MB) is reasonable for common use.

### R-3: Scaffold code correctness

**Risk:** Converting 20 tool implementations to extension code may introduce subtle bugs (different `this` context, missing error paths, etc.).
**Mitigation:** Each tool's scaffold should be tested by:
1. Creating the vault file via `ensureBuiltinToolVaultFile()`
2. Reloading extensions
3. Invoking the tool via LLM and comparing output to the class-based version
4. Automated e2e test for at least 3-4 representative tools (simple, medium, complex)

### R-4: Stale tracker and checkpoint dependencies

**Risk:** `utils.staleTracker` and `utils.checkpointManager` are lazy singletons on the plugin. Extension code accessing them during boot (before first chat) should work since they're created on first access.
**Mitigation:** Verify lazy accessor pattern. Both `getStaleTracker()` and `getCheckpointManager()` create on first call — same as `getExtensionManager()`.

### R-5: `DOMParser` availability in extension code

**Risk:** `web_search` tool uses `new DOMParser()` for HTML parsing. This is a browser/Electron global, not a Node.js API.
**Mitigation:** Electron's renderer process provides `DOMParser` globally. `libs.xmldom` is also available as a fallback. The scaffold code can use the native `DOMParser` directly — it's available in the same execution context.

### R-6: Backward compatibility — tool config references

**Risk:** Personas, workflows, and rules may reference built-in tool names in `<notor_tool_config>` blocks. These references must continue to work.
**Mitigation:** No change — tool names remain the same (e.g., `read_note`, `search_vault`). The tools register under the same names; only the implementation mechanism changes.

### R-7: `TOOL_PATH_PARAMS` population timing

**Risk:** Path enforcement relies on `TOOL_PATH_PARAMS` being populated before dispatch. With scaffolds loaded during `ExtensionManager.reload()`, this happens in `onLayoutReady()` — same timing as before but via a different code path.
**Mitigation:** `reload()` already registers `TOOL_PATH_PARAMS` entries (line 278-280 in manager.ts). Scaffold-compiled tools include `pathParams` from the YAML fence. No timing change.

**Cleanup:** The static `TOOL_PATH_PARAMS` initializer in `src/tool-config/path-enforcer.ts` (lines 27-48) hardcodes path params for all 14 built-in tools that have them. After migration, these entries are populated dynamically by `ExtensionManager.reload()` from each scaffold's YAML fence `path_namespace` declarations. **Remove the static entries** from `path-enforcer.ts` — keep only the type export and an empty object initializer (`export const TOOL_PATH_PARAMS: Record<string, ToolPathParam[]> = {};`). The dynamic registration in `manager.ts` becomes the single source of truth.

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
  - Scenario 3: verify that scaffold-provided tools (e.g., `read_note`, `search_vault`) coexist with user-created test tools in the registry (assert presence of representative scaffolds, not a hard total count)
  - New scenario: invoke a scaffold-provided tool (e.g., `read_note` via LLM) without any vault files
  - Scenario 13: after `ensureBuiltinToolVaultFile("read_note")` + reload, tool still works (now runs vault code, not scaffold)

### Manual verification

1. Fresh vault (no `notor/tools/` directory) → all 20 tools available and functional
2. Click "Customize" on `read_note` → note opens in new leaf with full implementation
3. Edit the customized note (e.g., add logging) → reload → verify modified behavior
4. Click "Reset to default" → reload → back to scaffold behavior
5. Complex tool test: `write_docx` scaffold generates a valid `.docx` file

---

## Pre-Plan Research: Per-Tool Feasibility Assessment

### `read_frontmatter` — Feasibility: Trivial ✅

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

### `fetch_webpage` — Feasibility: Moderate ✅

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

**Settings:** Per-extension `settings` for `fetch_webpage_timeout`, `fetch_webpage_max_download_mb`, `fetch_webpage_max_output_chars`. Shared `shared` for `domain_denylist`. All four fields have existing defaults in `src/settings/defaults.ts:129-133`.

**Return value mapping:**
- Success → return string (adapter wraps in `{ success: true, result: string }`)
- Validation/fetch failures → throw (adapter wraps in `{ success: false, error }`)
- Truncation → return the truncated string with appended note

**Helper functions (3 local functions to inline):**

1. **`getTurndown()`** (~27 lines) — Lazy-initialized Turndown singleton with ATX headings, fenced code, GFM plugin, and custom rules stripping `nav`/`footer`/`aside`/`form`/`input`/`select`/`button`. Private to file, no external consumers. Straightforward to inline as a local `function` in the scaffold code block. The singleton pattern (module-level `let turndownInstance`) translates to a closure variable in the scaffold.

2. **`isDomainBlocked()`** (~36 lines) — Parses URL hostname, checks against denylist patterns (exact match and `*.domain.com` wildcard). **Exported** and consumed by three callers:
   - `src/tools/web-search.ts:17` — will also be migrated to a scaffold; both scaffolds can inline the same function
   - `src/chat/dispatcher.ts:16,341` — pre-execution denylist check in the tool dispatcher; this import **will break** when the class file is removed
   
   **Resolution:** The `dispatcher.ts` import is a migration-order concern. Either (a) extract `isDomainBlocked` to a standalone utility file (e.g., `src/utils/domain-denylist.ts`) before removing the class, or (b) move it to the shared runtime as `utils.isDomainBlocked(url, denylist)` so both scaffolds and the dispatcher can use it. Option (b) is preferred since it avoids duplication in both scaffold code blocks (~36 lines × 2) and keeps the dispatcher import clean. **Recommended: add `utils.isDomainBlocked` to `ExtensionUtils` in `runtime-context.ts`** and update the dispatcher import. If that feels like scope creep, option (a) is a minimal extract-to-utility refactor.

3. **`getNetErrorHint()`** (~60 lines including the `CHROMIUM_NET_ERROR_HINTS` map) — Maps Chromium `net::ERR_*` error codes to human-readable strings. Private, no external consumers. Can be inlined as a local function + const map. This is the largest helper block but is pure data + a simple loop.

**Tricky patterns:**

1. **Timeout via `Promise.race`** — `requestUrl()` has no native timeout. The class races it against a `setTimeout` reject. Straightforward to replicate in scaffold code; no special runtime support needed.

2. **Diagnostic fetch probe** — On `requestUrl` failure, the class probes with native `fetch()` HEAD to isolate whether the issue is Obsidian-specific or network-wide. This uses the global `fetch` (available in Electron renderer) and `AbortSignal.timeout(5000)`. Both are browser globals available in the scaffold execution context.

3. **Body byte-length check** — Uses `new TextEncoder().encode(response.text).length` to measure UTF-8 byte size (not string `.length`). `TextEncoder` is a browser global, available in scaffold context.

4. **Turndown singleton** — Module-level `let turndownInstance` becomes a closure variable. Since each scaffold is compiled as a new `AsyncFunction`, the singleton would be recreated per invocation unless hoisted. Two options: (a) accept re-creation (Turndown init is fast, <1ms), or (b) use a module-scoped pattern via a global stash. **Recommended: accept re-creation.** The performance cost is negligible and avoids complexity.

**Scaffold code (estimated ~200 lines):**
```ts
const log = utils.logger("fetch_webpage");

if (!params.url || typeof params.url !== "string") {
  throw new Error("Missing required parameter: url");
}

// --- helpers (inlined) ---

function initTurndown(): InstanceType<typeof libs.Turndown> { /* ~20 lines */ }
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

**New `utils` expansions recommended:**
- `utils.isDomainBlocked(url: string, denylist: string[]): { blocked: true; pattern: string } | { blocked: false }` — avoids duplicating ~36 lines in both `fetch_webpage` and `web_search` scaffolds, and keeps the `dispatcher.ts` import clean. Without this, the dispatcher import from `src/tools/fetch-webpage.ts` breaks when the class file is removed. **This is the only migration blocker** — the dispatcher dependency must be resolved before the class file can be deleted.

**No other `utils`, `libs`, or `obsidian` expansions needed.** All other dependencies are already available.

**Risk: `isDomainBlocked` dispatcher dependency (medium).** The `src/chat/dispatcher.ts:16` import of `isDomainBlocked` from `src/tools/fetch-webpage.ts` will break when the class file is removed. This affects `web_search` migration too (same import at `src/tools/web-search.ts:17`). Must be resolved as part of the migration — see recommended `utils.isDomainBlocked` expansion above.

**Risk: Turndown singleton recreation (low).** Each invocation reinitializes Turndown. Turndown constructor + `use(gfm)` + 2 `addRule` calls is <1ms. Acceptable.

**Risk: `getNetErrorHint` map size (low).** The 14-entry `CHROMIUM_NET_ERROR_HINTS` map is ~40 lines of string constants. Inlining in the scaffold is verbose but straightforward. If future tools also need it, could be promoted to `utils`, but currently only `fetch_webpage` uses it — not worth the API surface expansion for a single consumer.

### `get_outlinks` — Feasibility: Trivial ✅

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

### `replace_in_file` — Feasibility: Straightforward ✅

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

**YAML fence schema — resolved:** The `ParamSchema` type system was extended with `object[]` support (see `types.ts` and `param-schema.ts` changes below) so the scaffold can express the `changes` param as a proper array of `{search, replace}` objects. This matches the class-based `input_schema` exactly — the LLM sees `type: "array"` with `items: { type: "object", properties: { search, replace }, required: [...] }` rather than an opaque `type: "string"`. The scaffold YAML fence now uses:

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

### `write_docx` — Feasibility: High complexity, viable with `utils` expansion ✅

**Source:** `src/tools/write-docx.ts` (1,041 lines) + `src/tools/docx-image-utils.ts` (285 lines) = **1,326 lines total**

**What the built-in class does:**

The tool has a multi-stage pipeline:

1. **Input validation** (~80 lines) — Mutually exclusive `content`/`note_name`, desktop-only guard, vault root check
2. **Content source resolution** (~35 lines) — Resolve note via `resolveNote()`, read via `app.vault.read()`, strip frontmatter via `getFrontMatterInfo()`
3. **Output path resolution** (~55 lines) — Three-step precedence: `output_path` > (`filename` + `write_docx_default_output_dir`) > error. Path boundary validation. Parent directory existence check.
4. **Template path resolution** (~45 lines) — Optional `template_path` or settings default. File existence and `.docx` extension validation.
5. **DOCX generation** (`generateDocx()`, ~65 lines) — `marked.lexer()` tokenization → image pre-resolution in parallel → `buildDocxChildren()` → `new Document()` → `Packer.toBuffer()` → optional template grafting
6. **Template grafting** (`graftIntoTemplate()`, ~255 lines) — DOM-based XML manipulation via `@xmldom/xmldom`: body content replacement, media file copying with collision-avoidance renaming, `.rels` merging with rId conflict resolution, `[Content_Types].xml` merging
7. **Image resolution** (`resolveImageForDocx()` in `docx-image-utils.ts`, ~90 lines of core logic) — Vault-relative/absolute path resolution, data URI decoding, magic-byte format detection, dimension parsing from buffer headers, WebP→PNG conversion via Canvas
8. **Image dimension parsing** (~60 lines) — Format-specific parsers for PNG (IHDR), JPEG (SOF0/SOF2 marker scan), GIF, BMP buffer headers
9. **Markdown→DOCX rendering** (`renderInline()` + `buildDocxChildren()`, ~230 lines) — Block tokens (heading, paragraph, code, hr, blockquote, list, table) → `docx.Paragraph`/`Table`; inline tokens (text, strong, em, codespan, link) → `TextRun`/`ExternalHyperlink`; standalone image paragraphs → `ImageRun` with scaling

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` from `"obsidian"` | `obsidian.Platform` | ⚠️ Planned (spec runtime-context.ts changes) |
| `getFrontMatterInfo` from `"obsidian"` | `obsidian.getFrontMatterInfo` | ✅ |
| `import * as fs from "fs"` | `libs.fs` | ⚠️ Planned (spec D-3) |
| `import { join, dirname, extname } from "path"` | `libs.path` | ⚠️ Planned (spec D-3) |
| `import { marked } from "marked"` | `libs.marked` | ✅ |
| `import { Document, Packer, Paragraph, ... } from "docx"` | `libs.docx` | ✅ |
| `import PizZip from "pizzip"` | `libs.PizZip` | ✅ |
| `import { DOMParser, XMLSerializer } from "@xmldom/xmldom"` | `libs.xmldom` | ✅ |
| `resolveAndValidatePath(path, vaultRoot, allowedPaths)` | `utils.resolveAndValidatePath(path)` | ✅ |
| `resolveNote(path, vault, metadataCache)` | `utils.resolveNote(path)` | ✅ |
| `logger("WriteDocxTool")` | `utils.logger("write_docx")` | ✅ |
| `resolveImageForDocx(href, vaultRoot, allowedPaths)` | **Not exposed** | ❌ See analysis below |

**Settings:** Per-extension `settings` for `write_docx_default_output_dir` and `write_docx_default_template_path`. Shared `shared` for `read_file_allowed_paths` (consumed implicitly by `utils.resolveAndValidatePath()` as default). Defaults from `src/settings/defaults.ts:191-193`: both empty strings.

**The core question: inline vs. `utils` expansion**

A fully-inlined scaffold would be ~900-1,050 lines. This is significantly larger than any other scaffold (next largest is `extract_docx_comments` at ~300 lines). The spec already flags this as "Complex+" and explicitly calls for evaluating whether additional logic should be exposed via `utils`.

**Analysis of inlining candidates:**

| Component | Lines | Inline? | Rationale |
|---|---|---|---|
| `renderInline()` | ~47 | Yes | Core customization point — users may want to adjust inline rendering (e.g., add underline support, custom link handling). Uses `libs.docx` types directly. |
| `buildDocxChildren()` | ~183 | Yes | Core customization point — users may want to add block types, change code block styling, adjust image handling. This is the heart of what "customizing write_docx" means. |
| `collectImageHrefs()` | ~35 | Yes | Small, tightly coupled to `buildDocxChildren`. |
| `scaleImageDimensions()` | ~17 | Yes | Trivial helper. |
| `generateDocx()` | ~65 | Yes | Orchestrator that ties the pieces together. |
| `graftIntoTemplate()` | ~255 | **No → `utils`** | Complex DOM-based XML manipulation with rId conflict resolution. Not a customization target — users want to change *what content is generated*, not *how it's grafted into a template*. Exposing as `utils.graftDocxIntoTemplate()` saves ~255 lines and keeps the scaffold focused on the customizable parts. |
| `resolveImageForDocx()` + helpers | ~285 | **No → `utils`** | Image resolution, format detection, dimension parsing, WebP conversion. This is infrastructure, not a customization target. Only consumed by `write-docx.ts` (confirmed via grep — no other importers). Exposing as `utils.resolveImageForDocx()` saves ~285 lines and avoids duplicating battle-tested image handling code. |

**Recommended `utils` expansions (2 new entries):**

```ts
// In ExtensionUtils interface:

/** Resolve an image href to data suitable for embedding in a DOCX via ImageRun.
 *  Handles vault-relative paths, absolute paths, data URIs, format detection,
 *  dimension parsing, and WebP→PNG conversion. Returns null for unresolvable images. */
resolveImageForDocx: (href: string, allowedPaths?: string[]) => Promise<DocxImageData | null>;

/** Graft generated DOCX body content into a template, preserving template styles,
 *  margins, headers, footers, and section properties. Handles media file copying
 *  with collision avoidance, rId conflict resolution, and Content_Types merging. */
graftDocxIntoTemplate: (generatedZip: PizZip, templateZip: PizZip) => Promise<void>;
```

```ts
// In buildUtils():

resolveImageForDocx: (href: string, allowedPaths?: string[]) =>
    resolveImageForDocx(href, vaultRootPath, allowedPaths ?? plugin.settings.read_file_allowed_paths),

graftDocxIntoTemplate: graftIntoTemplate,  // direct passthrough — no settings injection needed
```

The `resolveImageForDocx` wrapper injects `vaultRootPath` and defaults `allowedPaths` to the plugin's `read_file_allowed_paths` — same pattern as `utils.resolveAndValidatePath()`. Scaffold code calls `utils.resolveImageForDocx(href)` without needing the vault root.

The `graftDocxIntoTemplate` is a direct passthrough — the function takes two `PizZip` instances and has no settings dependencies.

**With these expansions, scaffold size drops to ~450-550 lines** — still the largest scaffold but within a manageable range. The scaffold retains all the customizable logic (markdown→docx rendering, image embedding, validation) while delegating the infrastructure (image resolution, template grafting) to `utils`.

**DocxImageData type exposure:** The `DocxImageData` interface (`{ type: "jpg"|"png"|"gif"|"bmp", buffer: Buffer, width: number, height: number }`) is returned by `utils.resolveImageForDocx()` and consumed by scaffold code to construct `ImageRun` objects. Since extension code is untyped at runtime (Sucrase strips types), the scaffold works with the shape directly — no type import needed. However, the interface should be documented in the `ExtensionUtils` JSDoc so users customizing the scaffold know the return shape.

**Helper functions (5 local functions to inline in scaffold):**

1. **`renderInline(tokens)`** (~47 lines) — Converts marked inline tokens to `libs.docx.TextRun`/`ExternalHyperlink`. Straightforward port: `TextRun` → `libs.docx.TextRun`, etc.

2. **`collectImageHrefs(tokens)`** (~35 lines) — Recursive walk of marked token tree collecting image hrefs. Pure logic, no dependencies.

3. **`scaleImageDimensions(w, h)`** (~17 lines) — Scales to fit ~600×800px. Pure math.

4. **`buildDocxChildren(tokens, resolvedImages)`** (~183 lines) — Block token → docx element conversion. The largest inline function. All `docx` library types accessed via `libs.docx.*`.

5. **`generateDocx(content, templatePath)`** (~50 lines, simplified) — Orchestrates: tokenize → collect image hrefs → resolve images via `utils.resolveImageForDocx()` → `buildDocxChildren()` → `new libs.docx.Document()` → `libs.docx.Packer.toBuffer()` → optional `utils.graftDocxIntoTemplate()`. Shorter than the original because template grafting is delegated.

**Tricky patterns:**

1. **Destructured `docx` imports** — The class file imports 12 named exports from `docx` (`Document`, `Packer`, `Paragraph`, `TextRun`, `ImageRun`, `HeadingLevel`, `Table`, `TableRow`, `TableCell`, `ExternalHyperlink`, `AlignmentType`, `WidthType`, `BorderStyle`). In scaffold code, these become `libs.docx.Document`, `libs.docx.Paragraph`, etc. This is verbose but unambiguous. A destructuring shortcut at the top of the scaffold code block keeps it readable:
   ```ts
   const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
           Table, TableRow, TableCell, ExternalHyperlink,
           AlignmentType, WidthType, BorderStyle } = libs.docx;
   ```

2. **`marked` types** — The class uses `Token`, `Tokens.Heading`, `Tokens.Paragraph`, etc. from `marked` for type-safe token access. After Sucrase strips types, these become plain property accesses (`token.depth`, `token.tokens`, etc.) — no runtime impact. The scaffold code uses the same property access patterns without type annotations.

3. **`PizZip` + `xmldom` in template grafting** — Delegated to `utils.graftDocxIntoTemplate()`, so the scaffold doesn't need to use these directly for grafting. However, the scaffold *does* need `libs.PizZip` to create the `PizZip` instances passed to `utils.graftDocxIntoTemplate()`:
   ```ts
   const generatedZip = new libs.PizZip(tempBuffer);
   const templateBuf = await libs.fs.promises.readFile(resolvedTemplatePath);
   const templateZip = new libs.PizZip(templateBuf);
   await utils.graftDocxIntoTemplate(generatedZip, templateZip);
   return templateZip.generate({ type: "nodebuffer" });
   ```

4. **`getVaultRootPath()` private helper** — Not needed. `utils.resolveAndValidatePath()` and `utils.resolveImageForDocx()` both handle vault root internally.

**Return value mapping:**
- Success → return string message (adapter wraps in `{ success: true, result: string }`)
- Validation failures → throw (adapter wraps in `{ success: false, error }`)
- The `filenameIgnored` warning is prepended to the success message — same pattern works with `return`.

**Scaffold code (estimated ~500 lines):**
```ts
const log = utils.logger("write_docx");
const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
        Table, TableRow, TableCell, ExternalHyperlink,
        AlignmentType, WidthType, BorderStyle } = libs.docx;

// --- Param extraction ---
// ~20 lines: content/note_name/output_path/filename/template_path extraction and validation

// --- Local helpers (inlined) ---
// renderInline(tokens) — ~47 lines
// collectImageHrefs(tokens) — ~35 lines
// scaleImageDimensions(w, h) — ~17 lines
// buildDocxChildren(tokens, resolvedImages) — ~183 lines

// --- Content source resolution ---
// ~35 lines: note resolution, frontmatter stripping, empty check

// --- Output path resolution (three-step) ---
// ~55 lines: output_path > (filename + settings.write_docx_default_output_dir) > error

// --- Template path resolution ---
// ~30 lines: template_path or settings.write_docx_default_template_path

// --- Generate and write ---
// ~50 lines: tokenize → resolve images via utils.resolveImageForDocx() →
//            buildDocxChildren() → Document → Packer.toBuffer() →
//            optional utils.graftDocxIntoTemplate() → fs.promises.writeFile()

return successMessage;
```

**YAML fence:**
```yaml
params:
  note_name:
    type: string
    description: "Path to an existing vault note to convert. Mutually exclusive with content."
    path_namespace: vault
  content:
    type: string
    description: "Markdown content to convert. Mutually exclusive with note_name."
  output_path:
    type: string
    description: "Full output path including .docx extension."
    path_namespace: filesystem
  filename:
    type: string
    description: "Output filename without .docx extension."
  template_path:
    type: string
    description: "Path to a .docx template."
    path_namespace: filesystem
settings:
  write_docx_default_output_dir:
    name: "Default Output Directory"
    type: string
    description: "Default output directory when only filename is provided. Vault-relative or absolute."
    default: ""
  write_docx_default_template_path:
    name: "Default Template Path"
    type: string
    description: "Default .docx template path. Vault-relative or absolute."
    default: ""
```

**New `utils` expansions required (2):**
- `utils.resolveImageForDocx(href, allowedPaths?)` — wraps `resolveImageForDocx()` from `src/tools/docx-image-utils.ts`, injecting `vaultRootPath` and defaulting `allowedPaths` to `plugin.settings.read_file_allowed_paths`. Saves ~285 lines of image resolution, format detection, dimension parsing, and WebP conversion from the scaffold.
- `utils.graftDocxIntoTemplate(generatedZip, templateZip)` — direct passthrough to `graftIntoTemplate()` from `src/tools/write-docx.ts`. Saves ~255 lines of DOM-based XML manipulation, rId conflict resolution, and media file merging.

**Source file refactoring required:** Before the class file can be deleted:
1. Extract `graftIntoTemplate()` (lines 448-702 of `write-docx.ts`) to a standalone utility file (e.g., `src/docx/template-grafting.ts` or keep in `src/tools/docx-image-utils.ts` renamed to `src/tools/docx-utils.ts`). This function has no class dependencies — it takes two `PizZip` instances and uses only `@xmldom/xmldom`.
2. `resolveImageForDocx()` already lives in `src/tools/docx-image-utils.ts` — it can stay there, imported by `runtime-context.ts` for the `utils` wrapper.

**Required runtime expansions (already planned in spec + 2 new):**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes)
- `libs.fs` — add to `buildLibs()` (spec D-3)
- `libs.path` — add to `buildLibs()` (spec D-3)
- **NEW:** `utils.resolveImageForDocx` — add to `ExtensionUtils` and `buildUtils()`
- **NEW:** `utils.graftDocxIntoTemplate` — add to `ExtensionUtils` and `buildUtils()`

**Risk: Scaffold size (medium).** At ~500 lines, this is still the largest scaffold by a significant margin. However, the logic is straightforward token-walking and docx library calls — there's no clever branching or state management. The main risk is that a user customizing this scaffold faces a large code surface. Mitigated by clear section comments and the fact that most users will only modify `buildDocxChildren()` or `renderInline()`.

**Risk: `libs.docx` API surface (low).** The scaffold uses 12 named exports from the `docx` library. These are all part of `docx`'s stable public API. Since `libs.docx` exposes the entire module (`typeof import("docx")`), all named exports are accessible. The destructuring pattern at the top of the scaffold makes this clean.

**Risk: `marked` token shape changes (low).** The scaffold relies on `marked.lexer()` producing tokens with specific shapes (`Tokens.Heading.depth`, `Tokens.List.items`, etc.). The `marked` library's token shapes are stable across major versions. Since `libs.marked` is pinned to the bundled version, this is controlled.

**Risk: Template grafting correctness after extraction (low).** `graftIntoTemplate()` is a pure function (takes two `PizZip` instances, mutates the template zip in-place). Moving it to `utils` is a mechanical extract — no logic change. The existing E2E tests for template grafting validate correctness.

**Risk: `resolveImageForDocx` vault root injection (low).** Same pattern as `utils.resolveAndValidatePath()` — the wrapper injects `vaultRootPath` at build time. Well-established pattern.

### `read_docx` — Feasibility: Moderate ✅

**Source:** `src/tools/read-docx.ts` (286 lines total, ~210 lines of logic)

**What the built-in class does:**
1. Validates `path` param (existence, string type, non-empty)
2. Desktop-only guard via `Platform.isDesktopApp`
3. Resolves vault root via `app.vault.adapter.basePath`
4. Validates path against vault root and `settings.read_file_allowed_paths` via `resolveAndValidatePath()`
5. Checks `.docx` extension via `extname()`
6. Checks file existence via `fs.promises.stat()` (ENOENT → specific error)
7. Reads file buffer via `fs.promises.readFile()`
8. Builds a mammoth image extraction handler (`mammothImages.imgElement()`) that:
   - Skips unsupported image formats (EMF, WMF, SVG, TIFF) with descriptive alt text
   - For supported formats (PNG, JPEG, GIF, WebP): reads image buffer, computes MD5 hash for dedup filename, resolves attachment path via `app.fileManager.getAvailablePathForAttachment()`, saves to vault via `app.vault.createBinary()` if not already present
   - Tags each image with a marker src (`__notor_img_N__` or `__notor_skip_N__`) for post-processing
9. Converts DOCX → HTML via `mammoth.convertToHtml({ buffer }, { convertImage })`
10. Builds a Turndown instance with GFM plugin and a custom `replaceImages` rule that maps marker srcs back to vault paths (`![alt](vaultPath)`) or fallback text
11. Converts HTML → Markdown via `td.turndown(html)`
12. Returns the Markdown string

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` from `"obsidian"` | `obsidian.Platform` | ⚠️ Planned (spec runtime-context.ts changes) |
| `import * as fs from "fs"` | `libs.fs` | ⚠️ Planned (spec D-3) |
| `import { extname } from "path"` | `libs.path.extname` | ⚠️ Planned (spec D-3) |
| `import { createHash } from "crypto"` | `libs.crypto.createHash` | ⚠️ Planned (spec D-3) |
| `mammoth` (default + `images` named export) | `libs.mammoth` | ✅ — default export carries `images` property; `libs.mammoth.images.imgElement()` works |
| `TurndownService` | `libs.Turndown` | ✅ |
| `gfm` plugin | `libs.turndownGfm.gfm` | ✅ |
| `resolveAndValidatePath(path, vaultRoot, allowedPaths)` | `utils.resolveAndValidatePath(path)` | ✅ — runtime-context.ts:85-90 injects `vaultRootPath` and defaults `allowedPaths` to `plugin.settings.read_file_allowed_paths` |
| `logger("ReadDocxTool")` | `utils.logger("read_docx")` | ✅ |
| `this.settings.read_file_allowed_paths` | `shared.read_file_allowed_paths` | ✅ (shared setting — see D-2/D-8). Not needed explicitly — `utils.resolveAndValidatePath(path)` reads it internally as default. |

**Settings:** None per-extension. The only setting referenced (`read_file_allowed_paths`) is a cross-tool shared setting consumed internally by `utils.resolveAndValidatePath()`. No `settings:` section needed in the YAML fence.

**Helper functions (0 to extract, all inline):**

The class has one private helper `getVaultRootPath()` (4 lines) — not needed because `utils.resolveAndValidatePath()` already knows the vault root. All other logic is inline in the `execute()` method.

**Return value mapping:**
- Success → return Markdown string (adapter wraps in `{ success: true, result: string }`)
- Validation/read failures → throw (adapter wraps in `{ success: false, error }`)

**Key patterns and their scaffold translations:**

1. **`mammoth.images.imgElement()` callback** — The image extraction handler is an async callback passed to mammoth. It uses `app.fileManager.getAvailablePathForAttachment()` and `app.vault.createBinary()`. Both are standard Obsidian APIs available via the injected `app`. The callback also uses `libs.crypto.createHash("md5")` for dedup filenames. This is the most complex part of the scaffold — ~45 lines of callback logic — but it's a direct 1:1 port with no class dependencies.

2. **`mammoth` named export access** — The class imports `{ images as mammothImages }` as a named export. In the scaffold, access it as `libs.mammoth.images.imgElement()`. The mammoth default export object carries `images` as a property (confirmed via `src/mammoth.d.ts:26`). No runtime expansion needed.

3. **Turndown instance with custom rule** — The class creates a local Turndown instance (not a shared singleton) per invocation. This is correct for the scaffold since each invocation should get a fresh instance with the image map. The custom `replaceImages` rule uses an `HTMLElement` param — `HTMLElement` is a browser/Electron global available in the scaffold execution context.

4. **Vault-relative source path resolution** — The class resolves `app.vault.getFileByPath(path)` to determine if the input path is vault-relative (for attachment folder resolution). This is a standard vault API call, directly available as `app.vault.getFileByPath(path)`.

5. **`Buffer.from()` / `.slice()` / `.buffer`** — Buffer operations for image extraction (`imgBuffer.buffer.slice(byteOffset, byteOffset + byteLength)` → `ArrayBuffer` for `app.vault.createBinary()`). `Buffer` is a Node.js global available in Electron renderer. No special exposure needed.

**Scaffold code (estimated ~160 lines):**
```ts
const log = utils.logger("read_docx");

if (!params.path || typeof params.path !== "string" || params.path.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("read_docx is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(params.path);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".docx") {
  throw new Error("read_docx only supports .docx files.");
}

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e) {
  if (e.code === "ENOENT") throw new Error(`File not found: ${resolvedPath}`);
  throw e;
}

const buf = await libs.fs.promises.readFile(resolvedPath);

// --- Image extraction handler ---
const extractedImages = [];
let imageIndex = 0;

const vaultFile = app.vault.getFileByPath(params.path);
const sourcePath = vaultFile ? vaultFile.path : undefined;

const supportedImageTypes = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

const convertImage = libs.mammoth.images.imgElement(async (image) => {
  const idx = imageIndex++;
  const contentType = image.contentType;

  if (!supportedImageTypes.has(contentType)) {
    const formatName = contentType.replace("image/", "").toUpperCase();
    const alt = `[Unsupported image format: ${formatName}]`;
    extractedImages.push({ index: idx, vaultPath: null, alt });
    return { src: `__notor_skip_${idx}__`, alt };
  }

  try {
    const imgBuffer = await image.readAsBuffer();
    const ext = (contentType.split("/")[1] ?? "bin").replace("jpeg", "jpg");
    const hash = libs.crypto.createHash("md5").update(imgBuffer).digest("hex");
    const filename = `${hash}.${ext}`;

    const targetPath = await app.fileManager.getAvailablePathForAttachment(
      filename, sourcePath,
    );

    const existing = app.vault.getFileByPath(targetPath);
    if (!existing) {
      const arrayBuf = imgBuffer.buffer.slice(
        imgBuffer.byteOffset,
        imgBuffer.byteOffset + imgBuffer.byteLength,
      );
      await app.vault.createBinary(targetPath, arrayBuf);
    }

    extractedImages.push({ index: idx, vaultPath: targetPath, alt: filename });
    return { src: `__notor_img_${idx}__`, alt: filename };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.warn("Image extraction failed", { index: idx, error: errMsg });
    extractedImages.push({ index: idx, vaultPath: null, alt: "[Image extraction failed]" });
    return { src: `__notor_skip_${idx}__`, alt: "[Image extraction failed]" };
  }
});

// DOCX → HTML
const { value: html } = await libs.mammoth.convertToHtml(
  { buffer: buf }, { convertImage },
);

// Build marker → image info lookup
const imageMap = new Map();
for (const img of extractedImages) {
  imageMap.set(`__notor_img_${img.index}__`, img);
  imageMap.set(`__notor_skip_${img.index}__`, img);
}

// HTML → Markdown via Turndown (fresh instance per call)
const td = new libs.Turndown({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
td.use(libs.turndownGfm.gfm);
td.addRule("replaceImages", {
  filter: ["img"],
  replacement: (_content, node) => {
    const src = node.getAttribute("src") ?? "";
    const alt = node.getAttribute("alt") ?? "";

    if (src.startsWith("__notor_img_")) {
      const info = imageMap.get(src);
      if (info?.vaultPath) return `![${alt}](${info.vaultPath})`;
    }

    if (src.startsWith("__notor_skip_")) return alt || "[image]";

    return "[image]";
  },
});

const markdown = td.turndown(html);

const extractedCount = extractedImages.filter(i => i.vaultPath !== null).length;
const skippedCount = extractedImages.filter(i => i.vaultPath === null).length;
log.info("Read docx", {
  path: resolvedPath,
  bytes: buf.length,
  imagesExtracted: extractedCount,
  imagesSkipped: skippedCount,
});

return markdown;
```

**No new `utils` expansions needed.** All dependencies are already exposed or planned. Unlike `write_docx`, this tool does NOT use `docx-image-utils.ts` — image extraction is handled by mammoth's callback API, not by manual buffer parsing. The `docx-image-utils.ts` file is used exclusively by `write_docx` for *embedding* images in generated DOCX files. `read_docx` *extracts* images from existing DOCX files, which is a fundamentally different operation handled by mammoth internally.

**Required runtime expansions (already planned in spec):**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes)
- `libs.fs` — add to `buildLibs()` (spec D-3)
- `libs.path` — add to `buildLibs()` (spec D-3)
- `libs.crypto` — add to `buildLibs()` (spec D-3)

**No `libs` or `obsidian` expansions beyond what's already planned.**

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute."
    path_namespace: filesystem
```

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence.

**Risk: `mammoth.images` access via default export (low).** The scaffold accesses `libs.mammoth.images.imgElement()`. The `mammoth` module's default export carries `images` as a property (confirmed in `src/mammoth.d.ts:26-33`). The runtime-context imports mammoth as `import mammoth from "mammoth"` (default import) which includes `images`. Verified: the built-in class uses the named export `import { images as mammothImages }` but the default export object is the same module — they are interchangeable.

**Risk: `HTMLElement` type in Turndown rule (low).** The custom `replaceImages` rule's `replacement` callback receives a `node` parameter typed as `HTMLElement`. In the scaffold (Sucrase strips types), this is just a runtime object from the Turndown DOM. The `getAttribute()` method is standard DOM API available in Electron's renderer process. No special handling needed.

**Risk: Image extraction to vault (low).** The `app.fileManager.getAvailablePathForAttachment()` and `app.vault.createBinary()` calls are standard Obsidian APIs. The dedup logic (MD5 hash → check `getFileByPath()` → skip if exists) is simple and self-contained. No race conditions — mammoth processes images sequentially within a single conversion call.

**Risk: `Buffer` global availability (low).** The scaffold uses `Buffer.from()` for base64 decoding and `imgBuffer.buffer.slice()` for ArrayBuffer extraction. `Buffer` is available as a global in Electron's renderer process (Node.js integration enabled). Same pattern used by `replace_in_file` and `read_file` scaffolds.

**Comparison with spec's complexity estimate:** The spec classifies `read_docx` as "Complex" at 200-400 lines. The actual scaffold is ~160 lines — lower than estimated because the image extraction logic, while conceptually complex, is mostly mammoth's callback API handling. The Turndown conversion is identical to the `fetch_webpage` pattern. This tool is more accurately "Medium-Complex" — simpler than `search_vault` or `fetch_webpage` in total helper count, with the complexity concentrated in the single mammoth image callback.

### `extract_docx_comments` — Feasibility: High complexity, viable with `utils` expansion ✅

**Source:** `src/tools/extract-docx-comments.ts` (370 lines total, ~300 lines of logic) + `src/tools/docx-comment-parser.ts` (467 lines total, ~400 lines of pure parsing logic)

**What the built-in class does:**
1. Validates `docx_path`, `output_path` params (existence, string type, non-empty)
2. Desktop-only guard via `Platform.isDesktopApp`
3. Resolves vault root via `app.vault.adapter.basePath`
4. Validates docx path against vault root and `settings.read_file_allowed_paths` via `resolveAndValidatePath()`
5. Checks `.docx` extension via `extname()`
6. Checks file existence via `fs.promises.stat()` (ENOENT → specific error)
7. Reads file buffer via `fs.promises.readFile()`, opens ZIP via `PizZip`
8. Extracts 4 XML blobs: `word/comments.xml`, `word/commentsExtended.xml`, `word/document.xml`, `word/people.xml`
9. Parses comments XML → raw comment objects (author, date, text, paraId)
10. Parses commentsExtended XML → resolved IDs set + threading map (paraId → parent paraId)
11. Extracts quoted text per comment from document XML (walks DOM for `commentRangeStart`/`commentRangeEnd` markers, collects `<w:t>` text between them)
12. Parses people XML → author → userId map for @mention resolution
13. Builds threaded comments (separates top-level from replies, filters resolved, resolves @mentions, computes deterministic unique IDs via MD5)
14. Checks for existing output note and extracts already-written comment IDs (idempotent append)
15. Filters new comments, formats as Markdown, writes to vault (create or append)

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` from `"obsidian"` | `obsidian.Platform` | ⚠️ Planned (spec runtime-context.ts changes) |
| `TFile`, `TFolder` from `"obsidian"` | `obsidian.TFile`, `obsidian.TFolder` | ✅ |
| `import * as fs from "fs"` | `libs.fs` | ⚠️ Planned (spec D-3) |
| `import { extname } from "path"` | `libs.path.extname` | ⚠️ Planned (spec D-3) |
| `PizZip` | `libs.PizZip` | ✅ |
| `DOMParser` from `@xmldom/xmldom` | `libs.xmldom.DOMParser` | ✅ |
| `createHash` from `"crypto"` | `libs.crypto.createHash` | ⚠️ Planned (spec D-3) |
| `resolveAndValidatePath(path, vaultRoot, allowedPaths)` | `utils.resolveAndValidatePath(path)` | ✅ — runtime-context.ts injects `vaultRootPath` and defaults `allowedPaths` to `plugin.settings.read_file_allowed_paths` |
| `logger("ExtractDocxCommentsTool")` | `utils.logger("extract_docx_comments")` | ✅ |
| `this.settings.read_file_allowed_paths` | `shared.read_file_allowed_paths` | ✅ (shared setting — see D-2/D-8). Not needed explicitly — `utils.resolveAndValidatePath(path)` reads it internally as default. |
| `parseCommentsXml()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `parseCommentsExtendedXml()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `extractQuotedText()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `parsePeopleXml()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `buildCommentThreads()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `formatCommentsAsMarkdown()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `extractExistingCommentIds()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `resolveAtMentions()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |
| `computeUniqueId()` | Inline in scaffold or expose via `utils` | ⚠️ See analysis below |

**Settings:** None per-extension. The only setting referenced (`read_file_allowed_paths`) is a cross-tool shared setting consumed internally by `utils.resolveAndValidatePath()`. No `settings:` section needed in the YAML fence.

**The central question: inline ~400 lines of parsing logic or expose via `utils`?**

The `docx-comment-parser.ts` module contains 9 exported functions + 4 internal helpers + 3 namespace constants + 2 interface types — totaling ~400 lines of pure parsing logic. This is the dominant complexity. The tool class itself is ~300 lines, of which ~120 are parameter validation and vault I/O (straightforward 1:1 porting), and the rest is orchestration calls into the parser module.

**Option A — Inline everything (~500-550 lines scaffold):**
Inline all 9 parser functions + 4 helpers + 3 constants as local `function` declarations in the scaffold code block. Produces the second-largest scaffold after `write_docx`. The code is self-contained (only depends on `libs.xmldom.DOMParser` and `libs.crypto.createHash`), so inlining is technically viable. However, this significantly exceeds the spec's ~300-line estimate and creates a massive, hard-to-read scaffold that users would struggle to customize.

**Option B — Expose parser functions via `utils` (~200 lines scaffold): ✅ Recommended**
Add `utils.docxComments` as a namespace object exposing the 9 parser functions from `docx-comment-parser.ts`. The scaffold code handles only I/O orchestration (ZIP extraction, vault reads/writes, directory creation) and delegates all XML parsing, threading, formatting, and dedup to `utils.docxComments.*`. This mirrors the `write_docx` precedent where complex helper logic (`graftIntoTemplate`) is recommended for `utils` expansion rather than inlining.

**Recommended `utils` expansion:**
```ts
// In ExtensionUtils interface:
docxComments: {
  parseCommentsXml: (xml: string) => RawComment[];
  parseCommentsExtendedXml: (xml: string) => { resolvedIds: Set<string>; threadingMap: Map<string, string> };
  extractQuotedText: (documentXml: string, commentId: string) => string;
  parsePeopleXml: (xml: string) => Map<string, string>;
  buildCommentThreads: (raw: RawComment[], threadingMap: Map<string, string>, resolvedIds: Set<string>, includeResolved: boolean, peopleMap: Map<string, string>) => Comment[];
  formatCommentsAsMarkdown: (comments: Comment[], filename: string, startNumber: number) => string;
  extractExistingCommentIds: (existingContent: string) => { ids: Set<string>; maxNumber: number };
};
```

Note: `resolveAtMentions` and `computeUniqueId` don't need direct exposure — they're called internally by `buildCommentThreads`. The `RawComment` and `Comment` types would be exported from `docx-comment-parser.ts` (they already are).

**Why this is the right approach:** The parser module is a well-separated, pure-function layer with comprehensive unit tests (558 lines in `docx-comment-parser.test.ts` covering 34 test cases). Exposing it via `utils.docxComments` preserves this clean boundary. Users who customize the tool can swap the I/O orchestration (e.g., change output format, add custom filtering) without reimplementing XML parsing. The module has zero external consumers beyond this tool (verified via grep) — no import breakage concern.

**Implementation cost of `utils.docxComments` expansion:** Minimal. Add ~10 lines to `runtime-context.ts` to import and wire the 7 functions. The module already exports everything needed. No new library dependencies. The existing unit tests continue to cover the parser logic independently.

**Helper functions (1 to inline):**

1. **`ensureDirectoryExists()`** (~15 lines) — Creates intermediate directories for the output note path. Uses `app.vault.getAbstractFileByPath()`, `app.vault.createFolder()`, `TFolder` check. This is a common pattern also used by `write_note` — potentially worth extracting to `utils.ensureDirectoryExists()` for reuse across both scaffolds. However, since only 2 scaffolds need it and it's only ~15 lines, inlining in each is acceptable. Uses `obsidian.TFolder` which is already available.

2. **`getVaultRootPath()`** (4 lines) — Not needed because `utils.resolveAndValidatePath()` already knows the vault root.

**Return value mapping:**
- Success → return string summary like `"Extracted 5 comment(s) to Reviews/feedback.md (2 duplicate(s) skipped)"` (adapter wraps in `{ success: true, result: string }`)
- Validation/parsing/write failures → throw (adapter wraps in `{ success: false, error }`)
- Special success cases (no comments found, all resolved, all already exist) → return descriptive string

**Scaffold code (estimated ~200 lines with `utils.docxComments`):**
```ts
const log = utils.logger("extract_docx_comments");

if (!params.docx_path || typeof params.docx_path !== "string" || params.docx_path.trim() === "") {
  throw new Error("Missing required parameter: docx_path");
}
if (!params.output_path || typeof params.output_path !== "string" || params.output_path.trim() === "") {
  throw new Error("Missing required parameter: output_path");
}
const includeResolved = (params.include_resolved as boolean) ?? false;

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("extract_docx_comments is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(params.docx_path);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".docx") {
  throw new Error("extract_docx_comments only supports .docx files.");
}

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e) {
  if (e.code === "ENOENT") throw new Error(`File not found: ${resolvedPath}`);
  throw e;
}

// Extract XML blobs via PizZip
const buf = await libs.fs.promises.readFile(resolvedPath);
const zip = new libs.PizZip(buf);
const commentsXml = zip.files["word/comments.xml"]?.asText() ?? null;
const commentsExtXml = zip.files["word/commentsExtended.xml"]?.asText() ?? null;
const documentXml = zip.files["word/document.xml"]?.asText() ?? null;
const peopleXmlStr = zip.files["word/people.xml"]?.asText() ?? null;

// Early exit: no comments
if (!commentsXml) return "No comments found in the document.";

// Parse all XML via utils.docxComments
const rawComments = utils.docxComments.parseCommentsXml(commentsXml);
if (rawComments.length === 0) return "No comments found in the document.";

const { resolvedIds, threadingMap } = commentsExtXml
  ? utils.docxComments.parseCommentsExtendedXml(commentsExtXml)
  : { resolvedIds: new Set(), threadingMap: new Map() };

// Extract quoted text for each comment
if (documentXml) {
  for (const raw of rawComments) {
    raw.quotedText = utils.docxComments.extractQuotedText(documentXml, raw.commentId);
  }
}

// Parse people for @mention resolution
const peopleMap = peopleXmlStr
  ? utils.docxComments.parsePeopleXml(peopleXmlStr)
  : new Map();

// Build threaded comments
const comments = utils.docxComments.buildCommentThreads(
  rawComments, threadingMap, resolvedIds, includeResolved, peopleMap,
);

if (comments.length === 0) {
  return "All comments are resolved. Use include_resolved=true to include them.";
}

// Check for existing note (for dedup/append)
const normalizedOutput = params.output_path.endsWith(".md")
  ? params.output_path
  : params.output_path + ".md";
const existingFile = app.vault.getAbstractFileByPath(normalizedOutput);

let startNumber = 1;
let existingIds = new Set();

if (existingFile && existingFile instanceof obsidian.TFile) {
  const existingContent = await app.vault.read(existingFile);
  const existing = utils.docxComments.extractExistingCommentIds(existingContent);
  existingIds = existing.ids;
  startNumber = existing.maxNumber + 1;
}

// Filter out already-written comments
const newComments = comments.filter((c) => !existingIds.has(c.uniqueId));
if (newComments.length === 0) {
  return `All ${comments.length} comments already exist in ${normalizedOutput}.`;
}

// Format as Markdown
const filename = resolvedPath.split("/").pop() ?? "document.docx";
const formatted = utils.docxComments.formatCommentsAsMarkdown(newComments, filename, startNumber);

// Write to vault
if (existingFile && existingFile instanceof obsidian.TFile) {
  await app.vault.process(existingFile, (data) => data.trimEnd() + "\n\n" + formatted);
} else {
  // Ensure intermediate directories exist
  const parts = normalizedOutput.split("/");
  parts.pop();
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
  await app.vault.create(normalizedOutput, formatted);
}

// Return summary
const skipped = comments.length - newComments.length;
const summary =
  `Extracted ${newComments.length} comment(s) to ${normalizedOutput}` +
  (skipped > 0 ? ` (${skipped} duplicate(s) skipped)` : "") +
  (resolvedIds.size > 0 && !includeResolved
    ? ` (${resolvedIds.size} resolved comment(s) excluded)`
    : "");

log.info("Extracted docx comments", {
  path: resolvedPath,
  output: normalizedOutput,
  total: rawComments.length,
  written: newComments.length,
  skipped,
});

return summary;
```

**Required runtime expansions (already planned in spec):**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes)
- `libs.fs` — add to `buildLibs()` (spec D-3)
- `libs.path` — add to `buildLibs()` (spec D-3)
- `libs.crypto` — add to `buildLibs()` (spec D-3)

**New `utils` expansion required:**
- `utils.docxComments` — namespace exposing 7 functions from `docx-comment-parser.ts` (~10 lines to wire in `runtime-context.ts`). This is the **only new expansion** beyond what other tools already require. The module itself already exists and exports everything needed — zero new code to write.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  docx_path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute. Must be within the vault or an allowed path."
    path_namespace: filesystem
  output_path:
    type: string
    description: "Vault-relative path for the output note (e.g. 'Reviews/feedback.md'). The .md extension is optional."
    path_namespace: vault
  include_resolved:
    type: boolean
    description: "Include resolved/done comments. Defaults to false."
    default: false
```

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence.

**Risk: `utils.docxComments` API surface growth (low).** Adding 7 functions to `utils` increases the API surface. However, these are pure functions with stable interfaces (only dependency is `@xmldom/xmldom` which is already bundled). The `docx-comment-parser.ts` module has been stable since implementation (no changes in recent git history). The functions are narrowly scoped to DOCX comment parsing — unlikely to need breaking changes.

**Risk: `RawComment.quotedText` mutation pattern (low).** The orchestration code mutates `raw.quotedText` in-place after `parseCommentsXml()` returns. This is the same pattern used by the built-in class (line 217-222 of `extract-docx-comments.ts`). The `RawComment` interface already initializes `quotedText: ""` as a mutable field. Works identically in the scaffold since `utils.docxComments.parseCommentsXml()` returns the same mutable objects.

**Risk: `Set`/`Map` type stripping (low).** The parser functions return `Set<string>` and `Map<string, string>` typed returns. Sucrase strips the type annotations; the runtime `Set` and `Map` constructors work identically. The scaffold code uses these as untyped collections which is fine.

**Risk: No external consumers of `docx-comment-parser.ts` (verified).** Grep confirms the module is imported only by `extract-docx-comments.ts` (the tool class) and `docx-comment-parser.test.ts` (its unit tests). No dispatcher, no other tool, no settings code imports it. The class file can be removed cleanly after migration.

**Comparison with spec's complexity estimate:** The spec classifies `extract_docx_comments` as "Complex" at 200-400 lines. With the recommended `utils.docxComments` expansion, the scaffold is ~200 lines — at the low end of the estimate. Without the expansion (Option A, full inline), it would be ~550 lines — significantly exceeding the estimate and producing the second-largest scaffold after `write_docx`. The `utils` expansion is clearly the right call: it keeps the scaffold manageable, preserves the existing test coverage boundary, and follows the same pattern recommended for `write_docx`'s `graftIntoTemplate`.

### `execute_command` — Feasibility: Straightforward ✅

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

**Note on timeout/exit-code result handling:** The built-in class returns `{ success: false, result: partialOutput, error: message }` for timeout and non-zero exit, setting both `result` and `error`. In the scaffold, throwing an error only populates the `error` field (adapter sets `result: ""`). To preserve the partial output behavior, the scaffold should embed the output in the error message string (e.g., `throw new Error(\`Command timed out after ${timeout}s. Partial output:\n${output}\`)`) rather than trying to set both fields. This is a minor behavioral change — the LLM sees the output in the error message rather than in a separate result field. This is acceptable because the LLM reads both fields as text context anyway.

**Helper functions (1 trivial inline):**

1. **`getVaultRootPath()`** (4 lines) — Extracts `basePath` from `app.vault.adapter`. Not needed in the scaffold because `utils.resolveAndValidatePath()` already knows the vault root (injected at build time in runtime-context.ts:71). The scaffold only needs the vault root for logging purposes, which can be omitted or read from the same adapter cast.

**Dispatcher pre-validation concern (`dispatcher.ts:366-390`):**

The dispatcher has a pre-execution validation for `execute_command` at lines 366-390 that reads `this.settings.execute_command_allowed_paths` directly from `NotorSettings`. After migration, this setting moves to `user_extension_settings["execute_command"]`.

**Analysis:** This pre-check is *redundant* with the tool's own path validation — the tool itself calls `resolveAndValidatePath()` and returns an error if the path is rejected. The dispatcher pre-check exists as an early bail-out before the tool reaches execution (avoiding approval UI, checkpoint creation, etc. for a request that will definitely fail). Two resolution options:

1. **Remove the dispatcher pre-check (recommended).** The scaffold's own validation produces the same error. The only downside is that the user sees the approval prompt before the path is rejected, but this is a minor UX difference — the command itself is what needs approval, not the working directory. This is the simplest approach and eliminates the coupling between the dispatcher and tool-specific settings.

2. **Update the dispatcher to read from extension settings.** This requires the dispatcher to access `user_extension_settings["execute_command"].execute_command_allowed_paths`, which means either injecting the extension settings system into the dispatcher or reading from the resolved `settings` object. This adds coupling and complexity for a pre-check that provides marginal UX value.

Recommendation: option 1. Remove `dispatcher.ts:366-390` as part of the migration. The scaffold handles validation; the dispatcher doesn't need tool-specific pre-checks for settings that live in the extension system.

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

**No new `utils` expansions needed.** All dependencies are already exposed or planned:
- `utils.resolveAndValidatePath(path, allowedPaths?)` — exists, supports explicit allowed paths override
- `utils.executeShellCommand(cmd, opts)` — exists, injects `plugin.settings` for shell resolution internally

**Required runtime expansions (already planned in spec):**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes, shared with `replace_in_file` and other desktop-only tools)

**No `libs` expansions needed.** The tool uses no Node.js modules or bundled libraries directly — all filesystem and shell operations are handled through `utils.executeShellCommand()` which is a self-contained wrapper.

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

**Scaffold `scaffold()` call change:** Needs the new 5th `code` parameter and updated `yamlFenceContent` with the `settings:` section appended to the `params:` section.

**Risk: Dispatcher pre-validation removal (low).** Removing `dispatcher.ts:366-390` means the path rejection happens inside the tool execution instead of before it. The user sees the approval prompt before the error, which is a minor UX regression. However, this pre-check pattern is specific to `execute_command` — no other tool has dispatcher-level pre-validation for settings-dependent constraints. Removing it simplifies the dispatcher and eliminates the coupling to a settings field that is migrating. The tool's own validation produces an identical error message.

**Risk: `execute_command_shell`/`execute_command_shell_args` settings UI orphaning (none).** These settings remain in `NotorSettings` and their settings UI section (`src/settings/sections/execute-command.ts:63-98`) continues to function. The migration only moves the 3 tool-facing settings (`allowed_paths`, `timeout`, `max_output_chars`) to the extension settings UI. The shell configuration section stays where it is, serving both the execute_command tool and the hook engine. The settings UI section file will need its rendering logic split: the 3 migrated fields are removed (they now render via the extension settings UI from the scaffold's `settings:` schema), while the shell executable/args fields remain. If this partial removal makes the section too small, it could be folded into the main Notor settings section — but this is a cosmetic concern, not a blocker.

**Risk: Partial output in error messages (low).** The behavioral change from separate `result`+`error` fields to combined error message string is acceptable. The LLM reads both fields as text. The format `"Command exited with code 1\n<output>"` is clear and preserves the diagnostic value. This matches the error handling pattern specified in D-4.

**Comparison with spec's complexity estimate:** The spec classifies `execute_command` as "Medium" at 80-280 lines and estimates ~80 lines. The scaffold is ~75 lines — at the low end. This tool is one of the cleanest migrations because `utils.executeShellCommand()` already encapsulates the complex shell infrastructure (process spawning, shell resolution, timeout enforcement, output buffering). The scaffold is essentially param validation + a single `utils.executeShellCommand()` call + result formatting.

### `replace_in_note` — Feasibility: Straightforward ✅

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

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed. Listed in the spec's "settings-free tools" group (D-2).

**Helper functions:** None. The class has no private helpers — all logic is inline in `execute()`. The `ChangeBlock` interface (`{ search: string; replace: string }`) is a TypeScript-only type that disappears after Sucrase stripping; the scaffold works with the object shape directly via `params.changes[i].search` / `.replace`.

**Return value mapping:**
- Success → return string like `"Applied 3 replacements to path/to/note.md"` (adapter wraps in `{ success: true, result: string }`)
- Validation failures → throw (adapter wraps in `{ success: false, error }`)
- Stale content → throw (adapter wraps in `{ success: false, error }`)
- Search block mismatch → throw with descriptive message including block number and search text preview

**Key patterns and their scaffold translations:**

1. **Atomic `vault.process()` with throw-on-mismatch** — The class applies all search/replace blocks inside a single `vault.process()` callback. If any block's search text isn't found, the callback throws, and `vault.process` guarantees no changes are written. This is the tool's defining behavior. In the scaffold, the same pattern works identically — `app.vault.process(file, (data) => { ... throw ... })` behaves the same regardless of calling context. The only difference is that the class catches the thrown error and returns a structured `ToolResult` with the failed block number, while the scaffold re-throws a new `Error` with the same message (adapter catches and wraps).

2. **Stale tracker canonical path** — The class uses `file.path` (Obsidian's canonical resolved path) rather than the user-supplied `path` param for all stale tracker calls. This ensures that `"My Note"`, `"My Note.md"`, and `"folder/My Note.md"` all resolve to the same tracker entry. The scaffold does the same: `utils.resolveNote()` returns a `TFile` whose `.path` is canonical.

3. **Two-phase stale tracker update** — After `vault.process()`, the class re-reads the file (`app.vault.read(file)`) and calls `staleTracker.updateAfterWrite(file.path, newContent)`. If the re-read fails, it falls back to `staleTracker.invalidate(file.path)` (non-fatal). This try/catch pattern translates directly.

4. **Checkpoint before write** — `this.checkpointManager?.createCheckpoint(file.path, this.name, "")` uses optional chaining (checkpoint manager may be null in tests). In the scaffold, `utils.checkpointManager` is always defined (runtime-context.ts guarantees it), but `createCheckpoint()` is already non-fatal (logs warnings on failure, never throws). The scaffold calls `await utils.checkpointManager.createCheckpoint(file.path, "replace_in_note", "")` without optional chaining.

5. **Error message with search text preview** — On mismatch, the class truncates the failed search text at 80 chars with `"..."` suffix. This is a 3-line pattern that translates directly.

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

**No new `utils` expansions needed.** All dependencies are already exposed in the extension runtime: `resolveNote`, `staleTracker`, `checkpointManager`, `noteOpener`, `logger`.

**No `libs` or `obsidian` imports needed.** Pure `app` + `utils` usage. No external libraries, no Node.js modules, no Obsidian API exports beyond the base `app` object.

**No settings migration needed.** This tool references zero `NotorSettings` fields. No per-extension `settings:` section in the YAML fence, no shared settings.

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

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence. The existing YAML fence content is already correct (uses `object[]` type for the `changes` param — this was added in commit `ccc9809`).

**Risk: `vault.process()` throw-and-catch pattern (low).** The scaffold re-throws a new `Error` from the outer catch block rather than returning a structured `ToolResult`. The `UserToolAdapter` catch handler wraps this identically to a direct return of `{ success: false, error }`. The only behavioral difference: the class's error response includes `tool_name` explicitly, while the adapter sets `tool_name` from `this.name` — same value. No observable change.

**Risk: `noteOpener` optional chaining removal (none).** The class uses `this.noteOpener?.openNote()` because `noteOpener` is an optional constructor param (undefined in unit tests). In the scaffold, `utils.noteOpener` is always defined — `runtime-context.ts:81` creates it unconditionally. The `openNote()` method itself is a no-op when `open_notes_on_access` is disabled. Removing the `?.` is safe.

**Comparison with spec's complexity estimate:** The spec classifies `replace_in_note` as "Medium" at 80-280 lines and estimates ~130 lines. The scaffold is ~90 lines — below the estimate. This is because the tool has no helpers, no settings, and no external library dependencies. The logic is entirely self-contained: param validation → resolve → stale check → checkpoint → atomic vault.process → stale update → open → return. It's one of the cleanest medium-tier migrations — similar in structure to `write_note` but simpler (no frontmatter preservation, no directory creation, no create-vs-update branching).

### `web_search` — Feasibility: Moderate ✅

**Source:** `src/tools/web-search.ts` (303 lines total, ~280 lines of logic)

**What the built-in class does:**
1. Validates `query` param (existence, string type)
2. Clamps `num_results` to 1–10, defaulting to `settings.web_search_default_num_results`
3. POSTs to `https://html.duckduckgo.com/html/` with form body `q={query}&kl=us-en` via `obsidian.requestUrl()`
4. Implements timeout via `Promise.race` against `setTimeout` (uses `settings.web_search_timeout * 1000`)
5. Handles HTTP status checks and network errors with structured error returns
6. Parses HTML response via browser-native `DOMParser` (`text/html` mode) — selects `.result` containers, extracts `.result__title a` href/text and `.result__snippet` text
7. Decodes DuckDuckGo redirect URLs (`//duckduckgo.com/l/?uddg={encoded_url}&...`) via `cleanDDGUrl()` helper
8. Filters parsed results against domain denylist via `isDomainBlocked()` (imported from `fetch-webpage.ts`)
9. Logs warning on possible selector drift (non-empty response, zero parsed results)
10. Formats output as numbered markdown list: `1. **[Title](url)**\n   snippet`

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `requestUrl` | `obsidian.requestUrl` | ✅ |
| `logger("WebSearchTool")` | `utils.logger("web_search")` | ✅ |
| `this.settings.web_search_timeout` | `settings.web_search_timeout` | ✅ (per-extension setting — see D-2) |
| `this.settings.web_search_default_num_results` | `settings.web_search_default_num_results` | ✅ (per-extension setting — see D-2) |
| `this.settings.domain_denylist` | `shared.domain_denylist` | ✅ (shared setting — see D-2/D-8) |
| `isDomainBlocked()` (imported from fetch-webpage.ts) | `utils.isDomainBlocked` (recommended expansion) | ⚠️ See note below |
| `DOMParser` (browser global) | `DOMParser` (global in Electron renderer) | ✅ (see R-5) |

**Settings:** Per-extension `settings` for `web_search_timeout` (default 10), `web_search_default_num_results` (default 5). Shared `shared` for `domain_denylist`. All fields have existing defaults in `src/settings/defaults.ts:136-137`.

**Return value mapping:**
- Success → return formatted markdown string (adapter wraps in `{ success: true, result }`)
- No results → return `"No results found for query: {query}"` as success (not an error)
- Validation/network failures → return structured `{ success: false, error }` directly (not thrown)

**Helper functions (2 local functions to inline):**

1. **`cleanDDGUrl()`** (~16 lines) — Decodes DuckDuckGo redirect URLs. Handles three patterns: DDG `/l/?uddg=` redirects (extracts `uddg` query param, URL-decodes), protocol-relative `//` URLs (prepends `https:`), and already-absolute `http(s)://` URLs. Returns `null` for unrecognized formats. Pure function, no external dependencies. **Exported** from the current file but only consumed internally — no external callers. Straightforward to inline in scaffold.

2. **`parseDDGResults()`** (~28 lines) — Creates a `DOMParser`, parses HTML as `text/html`, iterates `.result` containers extracting title/URL/snippet via CSS selectors, calls `cleanDDGUrl()` on each href, respects `maxResults` cap. **Exported** but only consumed internally and in tests. Straightforward to inline in scaffold.

**`isDomainBlocked` dependency:** Same cross-cutting concern as `fetch_webpage`. The `web_search` tool imports `isDomainBlocked` from `src/tools/fetch-webpage.ts:17`. After migration, this import disappears — the scaffold uses `utils.isDomainBlocked()` (the same recommended `utils` expansion from the `fetch_webpage` assessment). **Not a new blocker** — resolved by the same `utils.isDomainBlocked` addition already identified in the `fetch_webpage` assessment. The `web_search` scaffold simply calls `utils.isDomainBlocked(r.url, shared.domain_denylist)` in the filter loop.

Note: unlike `fetch_webpage`, the dispatcher does **not** have a pre-dispatch denylist check for `web_search`. The denylist filtering happens entirely within the tool's execute body (post-parse, filtering individual result URLs). This means the `web_search` migration has no dispatcher import concern — only `fetch_webpage` creates the dispatcher.ts:16 import breakage.

**Tricky patterns:**

1. **Timeout via `Promise.race`** — identical pattern to `fetch_webpage`. `requestUrl()` has no native timeout; the class races it against a `setTimeout` reject promise. Straightforward to replicate in scaffold code. No special runtime support needed.

2. **`DOMParser` availability** — Uses browser-native `new DOMParser()` with `text/html` mime type (line 82). This is a global in Electron's renderer process — the same execution context where extension code runs. NOT the same as `libs.xmldom` (which is XML-only and doesn't support CSS selectors like `querySelectorAll`). See R-5 in the risk assessment — confirmed viable. Tests use `@vitest-environment jsdom` to polyfill this.

3. **CSS selector fragility** — The parser relies on DDG-specific CSS classes (`.result`, `.result__title a`, `.result__snippet`). The existing code already has a selector drift warning (lines 244-250). The scaffold preserves this exact behavior. This is inherent to the tool's design, not a migration concern.

4. **`requestUrl` POST with form encoding** — The tool POSTs to DDG with `Content-Type: application/x-www-form-urlencoded` and a custom User-Agent. No special handling needed — `obsidian.requestUrl` supports all of this directly.

**No `utils`, `libs`, or `obsidian` expansions needed beyond `utils.isDomainBlocked`** (already recommended for `fetch_webpage`). All other dependencies are browser globals or already-injected context.

**Scaffold code (estimated ~130 lines):**
```ts
const log = utils.logger("web_search");

if (!params.query || typeof params.query !== "string") {
  return { success: false, error: "Missing required parameter: query" };
}

// --- helpers (inlined) ---

function cleanDDGUrl(raw: string): string | null { /* ~16 lines */ }
function parseDDGResults(html: string, maxResults: number): Array<{title: string; url: string; snippet: string}> { /* ~28 lines */ }

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

**Scaffold `scaffold()` call change:** Needs the new 5th `code` parameter. The YAML fence includes both `params:` and `settings:` sections. The `settings` entries for `web_search_timeout` and `web_search_default_num_results` replace the current direct `NotorSettings` field references.

**Settings UI migration:** The existing `src/settings/sections/web-search.ts` (61 lines) renders timeout and default num_results fields. After migration, these are auto-generated from the extension settings schema. The manual settings section file can be removed. The domain denylist note ("shared with fetch_webpage") is handled by the shared settings UI from D-8.

**Comparison with spec's complexity estimate:** The spec classifies `web_search` as "Complex" at 200-400 lines and estimates ~200 lines. The scaffold is ~130 lines — below the estimate. This is because `isDomainBlocked` moves to `utils` (saving ~36 lines of inline code), and the tool has no Turndown conversion, no diagnostic fetch probe, and no error hint map (unlike `fetch_webpage`). The two inlined helpers (`cleanDDGUrl` + `parseDDGResults`) are compact pure functions. This is the simpler of the two web-facing tools — comparable to a mid-range "Straightforward" tool in actual scaffold complexity, elevated to "Moderate" only because of the `DOMParser` browser-global dependency and the shared `isDomainBlocked` migration coordination with `fetch_webpage`.

### `read_file` — Feasibility: Moderate ✅

**Source:** `src/tools/read-file.ts` (272 lines total, ~182 lines of execute logic)

**What the built-in class does:**
1. Validates `path` param (exists, is string, not empty)
2. Desktop-only guard via `Platform.isDesktopApp`
3. Resolves vault root via `app.vault.adapter.basePath`
4. Validates path against vault root and `settings.read_file_allowed_paths` via `resolveAndValidatePath()`
5. Checks file existence via `fs.promises.stat()` (ENOENT → specific error)
6. Reads raw buffer via `fs.promises.readFile()`
7. Binary detection: scans first 8 KB for null bytes (`buf.subarray(0, 8192).includes(0)`)
8. **Image branch** (PNG/JPEG/GIF/WebP): 50 MB size limit, `processImage(buf, mediaType, { maxDimension, compressionQuality })`, returns `content_blocks` with image block + metadata summary string
9. **PDF branch**: 50 MB size limit, `processPdf(buf, { pages, providerType, maxTextChars, preferNative })`, returns `content_blocks` with PDF content blocks + text summary string
10. **Other binary**: rejects with error directing user to `read_docx` for Word documents
11. **Text files**: decodes buffer via specified encoding (default `utf-8`), returns content string

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` from `"obsidian"` | `obsidian.Platform` | ⚠️ Planned (spec runtime-context.ts changes) |
| `import * as fs from "fs"` | `libs.fs` | ⚠️ Planned (spec D-3) |
| `resolveAndValidatePath(path, vaultRoot, allowedPaths)` | `utils.resolveAndValidatePath(path)` | ✅ — runtime-context.ts already injects `vaultRootPath` and defaults `allowedPaths` to `plugin.settings.read_file_allowed_paths` |
| `detectMediaFormat(buf)` | `utils.detectMediaFormat(buf)` | ⚠️ Planned (spec runtime-context.ts changes — media utilities section) |
| `processImage(buf, mediaType, opts)` | `utils.processImage(buf, mediaType, opts)` | ⚠️ Planned (spec runtime-context.ts changes — media utilities section) |
| `processPdf(buf, opts)` | `utils.processPdf(buf, opts)` | ⚠️ Planned (spec runtime-context.ts changes — media utilities section). Note: `utils.processPdf` injects `active_provider` and `pdf_native_max_size_mb` (as `maxNativeSizeBytes`) from plugin settings internally. Scaffold does NOT pass `providerType` or `maxNativeSizeBytes`. |
| `ImageMediaType` type | N/A (stripped by Sucrase) | ✅ (runtime irrelevant) |
| `logger("ReadFileTool")` | `utils.logger("read_file")` | ✅ |
| `this.settings.read_file_allowed_paths` | `shared.read_file_allowed_paths` | ✅ (shared setting — see D-2/D-8). Not needed explicitly — `utils.resolveAndValidatePath(path)` reads it internally as default. |
| `this.settings.image_max_dimension` | `settings.image_max_dimension` | ✅ (per-extension setting — see D-2) |
| `this.settings.image_compression_quality` | `settings.image_compression_quality` | ✅ (per-extension setting — see D-2) |
| `this.settings.pdf_text_max_chars` | `settings.pdf_text_max_chars` | ✅ (per-extension setting — see D-2) |
| `this.settings.pdf_prefer_native` | `settings.pdf_prefer_native` | ✅ (per-extension setting — see D-2) |
| `this.settings.active_provider` | N/A — injected internally by `utils.processPdf` | ✅ (scaffold never sees this) |
| `this.settings.pdf_native_max_size_mb` | N/A — injected internally by `utils.processPdf` as `maxNativeSizeBytes` | ✅ (scaffold never sees this; also fixes the bug where this setting was previously ignored) |

**Settings:** Per-extension `settings` for `image_max_dimension`, `image_compression_quality`, `pdf_prefer_native`, `pdf_text_max_chars`, `pdf_native_max_size_mb`. Shared `shared` for `read_file_allowed_paths` (consumed implicitly by `utils.resolveAndValidatePath()`). The `active_provider` and `pdf_native_max_size_mb` fields are NOT extension settings — they are injected internally by the `utils.processPdf` wrapper (see D-2 notes and runtime-context.ts changes).

**Helper functions (1 trivial, not needed):**

1. **`getVaultRootPath()`** (4 lines) — Extracts `basePath` from `app.vault.adapter`. Not needed in the scaffold because `utils.resolveAndValidatePath()` already knows the vault root (injected at build time in runtime-context.ts). The scaffold simply calls `utils.resolveAndValidatePath(path)`.

**Return value mapping:**
- Text success → return string content (adapter wraps in `{ success: true, result: string }`)
- Image success → **special case**: must return an object with `result` (summary string) and `content_blocks` (image block array). The `UserToolAdapter.execute()` return-value mapper handles objects — returning `{ result: "Read image: ...", content_blocks: [block] }` produces the correct `ToolResult`. This matches how the built-in class returns `{ success: true, result: "Read image: ...", content_blocks: [block] }`.
- PDF success → same pattern as images: return `{ result: "Read PDF: ...", content_blocks: result.contentBlocks }`
- Validation/read failures → throw (adapter wraps in `{ success: false, error }`)

**Key pattern: `content_blocks` return shape.** This tool is one of the few that returns `content_blocks` (multi-modal content blocks for images and PDFs) alongside a `result` string. The built-in class constructs a full `ToolResult` with `{ success: true, result: summaryString, content_blocks: [...] }`. In the scaffold, the code must return an object with both `result` and `content_blocks` keys so the adapter mapper preserves both. Verify that `UserToolAdapter.execute()` correctly forwards `content_blocks` from the returned object to the final `ToolResult` — if the mapper only looks at `typeof returnValue === "string"` vs `"object"`, returning `{ result, content_blocks }` should pass through as-is. This is the critical pattern to validate during implementation.

**Scaffold code (estimated ~100 lines):**
```ts
const log = utils.logger("read_file");

if (!params.path || typeof params.path !== "string" || params.path.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("read_file is only available on desktop.");
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

// Detect binary via null bytes in first 8 KB
if (buf.subarray(0, 8192).includes(0)) {
  const format = utils.detectMediaFormat(buf);

  if (format === "png" || format === "jpeg" || format === "gif" || format === "webp") {
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error(
        `Image file is too large (${(buf.length / (1024 * 1024)).toFixed(1)} MB). Maximum raw input size is 50 MB.`
      );
    }
    const mediaType = `image/${format}`;
    const block = await utils.processImage(buf, mediaType, {
      maxDimension: settings.image_max_dimension,
      compressionQuality: settings.image_compression_quality,
    });
    const filename = resolvedPath.split("/").pop() ?? resolvedPath;
    const w = block.type === "image" ? block.width : undefined;
    const h = block.type === "image" ? block.height : undefined;
    log.info("Read image file", { path: resolvedPath, format, width: w, height: h });
    return { result: `Read image: ${filename} (${w}x${h}, image/${format})`, content_blocks: [block] };
  }

  if (format === "pdf") {
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error(
        `PDF file is too large (${(buf.length / (1024 * 1024)).toFixed(1)} MB). Maximum raw input size is 50 MB.`
      );
    }
    const result = await utils.processPdf(buf, {
      pages: params.pages,
      maxTextChars: settings.pdf_text_max_chars,
      preferNative: settings.pdf_prefer_native,
    });
    const filename = resolvedPath.split("/").pop() ?? resolvedPath;
    log.info("Read PDF file", { path: resolvedPath, summary: result.textSummary });
    return { result: `Read PDF: ${filename} — ${result.textSummary}`, content_blocks: result.contentBlocks };
  }

  throw new Error(
    "read_file only supports text-based files, images (PNG, JPEG, GIF, WebP), and PDFs. For Word documents, use read_docx instead."
  );
}

const encoding = params.encoding ?? "utf-8";
const content = buf.toString(encoding);
log.info("Read file", { path: resolvedPath, bytes: buf.length });
return content;
```

**No new `utils` expansions needed beyond what's already planned.** The three media utilities (`detectMediaFormat`, `processImage`, `processPdf`) are already specified in the runtime-context.ts changes section. `resolveAndValidatePath` is already exposed. No local helper functions to inline — the media processing complexity is entirely delegated to `utils`.

**Required runtime expansions (all already planned in spec):**
- `obsidian.Platform` — add to `buildObsidianExports()` (spec runtime-context.ts changes)
- `libs.fs` — add to `buildLibs()` (spec D-3)
- `utils.detectMediaFormat` — add to `ExtensionUtils` and `buildUtils()` (spec runtime-context.ts changes)
- `utils.processImage` — add to `ExtensionUtils` and `buildUtils()` (spec runtime-context.ts changes)
- `utils.processPdf` — add to `ExtensionUtils` and `buildUtils()` (spec runtime-context.ts changes, with `active_provider` and `pdf_native_max_size_mb` injected internally)

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
    description: "JPEG compression quality (1-100). Lower values reduce size but decrease quality."
    default: 80
    min: 1
    max: 100
  pdf_prefer_native:
    name: "Prefer Native PDF"
    type: boolean
    description: "Send PDFs as native document blocks when supported by the provider. If false, always extract text."
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
    description: "Maximum PDF file size in MB for native document block processing. Larger PDFs fall back to text extraction."
    default: 10
    min: 1
    max: 100
```

**Scaffold `scaffold()` call change:** Needs the new 5th `code` parameter. The YAML fence includes both `params:` and `settings:` sections. The `settings` entries for image/PDF options replace the current direct `NotorSettings` field references.

**Settings UI migration:** The existing image and PDF settings are scattered across `src/settings/sections/` (specifically in the read-file or media sections). After migration, these are auto-generated from the extension settings schema. The manual settings section files for these fields can be removed.

**Comparison with spec's complexity estimate:** The spec classifies `read_file` as "Complex" at 200-400 lines and estimates ~200 lines. The scaffold is ~100 lines — well below the estimate. This is because all three media processing functions (`detectMediaFormat`, `processImage`, `processPdf`) are delegated to `utils`, saving ~200+ lines of image processing pipelines, PDF extraction, format detection magic bytes, and compression cascades. Without `utils`, the scaffold would need to inline the full `src/media/` stack (~400 lines across 3 files) — clearly impractical and the right call to expose via `utils`. The scaffold itself is structurally straightforward: param validation → path validation → binary detection → branch on format → delegate to `utils` → return. The main sophistication is the `content_blocks` return pattern for multi-modal responses.

**Risk: `content_blocks` passthrough in `UserToolAdapter` (medium).** The adapter's return-value mapper must forward `content_blocks` from the returned object to the final `ToolResult`. If the mapper only handles `string` returns (wrapped in `{ success: true, result: string }`) and `object` returns (passed through as-is), returning `{ result, content_blocks }` should work. However, this is a pattern unique to `read_file` among the scaffold tools — no other scaffold returns `content_blocks`. Must verify the adapter handles this correctly during implementation. If it doesn't, the mapper needs a small adjustment to check for `content_blocks` on the returned object.

**Risk: `pdf_native_max_size_mb` behavior change (medium, already documented as R-2).** This migration wires `pdf_native_max_size_mb` through to `processPdf()` for the first time via the `utils.processPdf` wrapper, fixing the existing bug where the setting was ignored. See R-2 in the Risk Assessment section for mitigation.

**Risk: `encoding` parameter edge cases (low).** The built-in class casts `encoding` to `BufferEncoding` for `buf.toString()`. Node.js `Buffer.toString()` accepts common encodings (`utf-8`, `ascii`, `latin1`, `base64`, `hex`, etc.) and throws on invalid ones. The scaffold passes `params.encoding ?? "utf-8"` directly — same behavior. No special handling needed.

**Risk: 50 MB size limit as magic number (low).** The 50 MB binary file size limit is hardcoded in the scaffold (matching the built-in class). Not exposed as a setting — this is a safety guard against OOM, not a user-tunable preference. Acceptable to hardcode.

### `search_vault` — Feasibility: Moderate ✅

**Source:** `src/tools/search-vault.ts` (355 lines total, ~250 lines of logic)

**What the built-in class does:**
1. Validates `query` param (exists, is string)
2. Parses and clamps parameter defaults: `context_lines` (0–10, default 3), `limit` (1–200, default 20), `offset` (≥0, default 0), `file_pattern` (default `*.md`), `sort_by` (default `match_count`)
3. Compiles `query` as a RegExp with `/gm` flags; returns error if invalid regex
4. Collects candidate files via `getCandidateFiles()` — filters `app.vault.getFiles()` by path prefix and glob pattern
5. Builds a backlink count map via `getBacklinkCounts()` — single O(n) pass over `app.metadataCache.resolvedLinks`
6. Iterates candidate files, reads each via `app.vault.cachedRead()`, searches line-by-line via `searchFile()`
7. Caps matches per file at `MAX_MATCHES_PER_FILE` (10), exposes `total_match_count` for the real count
8. Resets `regex.lastIndex` between files (stateful `/g` flag)
9. Sorts results via `sortFileResults()` by `match_count`, `backlinks`, or `modified` (descending)
10. Applies file-level pagination (`offset`/`limit` slice)
11. Returns structured `SearchResult` object: `{ total_matches, total_files, files: FileResult[] }`

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `this.app.vault.getFiles()` | `app.vault.getFiles()` | ✅ |
| `this.app.vault.cachedRead(file)` | `app.vault.cachedRead(file)` | ✅ |
| `this.app.metadataCache.resolvedLinks` | `app.metadataCache.resolvedLinks` | ✅ |
| `TFile` from `"obsidian"` | `obsidian.TFile` | ✅ |
| `logger("SearchVaultTool")` | `utils.logger("search_vault")` | ✅ |

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed.

**Return value mapping:**
- The built-in returns a structured `SearchResult` object (`{ total_matches, total_files, files }`) wrapped in `{ success: true, result: SearchResult }`. The `UserToolAdapter.execute()` return-value mapper (manager.ts:109-113) handles objects correctly — `typeof returnValue === "object"` passes through as-is. Returning the `SearchResult` object directly from the scaffold will produce `{ success: true, result: { total_matches, total_files, files } }`.
- For errors (missing query, invalid regex), the scaffold throws (adapter catches and wraps in `{ success: false, error }`).

**Helper functions (4 to inline):**

All helper logic is private methods on the class with no external consumers. They must be inlined as local functions in the scaffold:

1. **`getCandidateFiles(searchPath, filePattern)`** (~25 lines) — Filters `app.vault.getFiles()` by path prefix and glob pattern. Uses `matchesGlob()` internally. Pure filtering logic — straightforward to inline.

2. **`matchesGlob(filename, pattern)`** (~12 lines) — Converts a simple glob pattern (e.g., `*.md`) to regex by escaping special chars and replacing `*` with `.*`. Falls back to exact match on regex compilation failure. Used only by `getCandidateFiles()`.

3. **`getBacklinkCounts()`** (~13 lines) — Builds `Map<string, number>` by iterating `app.metadataCache.resolvedLinks`. Single O(n) pass, no disk I/O. Self-contained.

4. **`sortFileResults(results, sortBy)`** (~16 lines) — Sorts `FileResult[]` descending by `total_match_count`, `backlink_count`, or `modified` timestamp. Pure comparison logic.

5. **`searchFile(content, regex, contextLines)`** (~35 lines) — Core search logic: splits content into lines, tests each against regex, builds context windows with `>` prefix for the matching line. Tracks matched line numbers to avoid duplicate context. Resets `regex.lastIndex` per line (stateful `/g`). This is the most substantial helper but still straightforward procedural code.

**Total inlined helper size:** ~100 lines. Combined with main orchestration (~50 lines), the scaffold is ~150 lines.

**`MAX_MATCHES_PER_FILE` constant:** Hardcoded as `10` in the built-in class. Inline as a local `const` in the scaffold. Not worth exposing as a setting — it's a response-size guard, not a user preference.

**Scaffold code (estimated ~150 lines):**
```ts
const log = utils.logger("search_vault");

const MAX_MATCHES_PER_FILE = 10;

if (!params.query || typeof params.query !== "string") {
  throw new Error("Missing required parameter: query");
}

const query = params.query as string;
const searchPath = ((params.path as string | undefined) ?? "").trim();
const contextLines = Math.max(0, Math.min(10, Math.floor((params.context_lines as number | undefined) ?? 3)));
const filePattern = ((params.file_pattern as string | undefined) ?? "*.md").trim();
const sortBy = ((params.sort_by as string | undefined) ?? "match_count") as "match_count" | "backlinks" | "modified";
const limit = Math.max(1, Math.min(200, Math.floor((params.limit as number | undefined) ?? 20)));
const offset = Math.max(0, Math.floor((params.offset as number | undefined) ?? 0));

// Compile regex — treat as literal string if not valid regex
let regex: RegExp;
try {
  regex = new RegExp(query, "gm");
} catch (e: any) {
  throw new Error(`Invalid search pattern: ${e.message ?? String(e)}`);
}

log.debug("Searching vault", { query, searchPath, contextLines, filePattern });

// --- Helper: simple glob matcher ---
function matchesGlob(filename: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  try {
    return new RegExp(`^${regexStr}$`, "i").test(filename);
  } catch {
    return filename === pattern;
  }
}

// --- Helper: collect candidate files ---
const allFiles = app.vault.getFiles();
const candidates = allFiles.filter((file: any) => {
  if (searchPath) {
    const normalizedPath = searchPath.endsWith("/") ? searchPath : searchPath + "/";
    if (!file.path.startsWith(normalizedPath) && file.path !== searchPath) return false;
  }
  if (filePattern && filePattern !== "*") {
    if (!matchesGlob(file.name, filePattern)) return false;
  }
  return true;
});

// --- Helper: build backlink counts ---
const backlinkCounts = new Map<string, number>();
for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
  for (const targetPath of Object.keys(links as Record<string, number>)) {
    if (targetPath !== sourcePath) {
      backlinkCounts.set(targetPath, (backlinkCounts.get(targetPath) ?? 0) + 1);
    }
  }
}

// --- Helper: search a single file ---
function searchFile(content: string, re: RegExp, ctxLines: number) {
  const lines = content.split("\n");
  const matches: { line: number; match: string; context: string }[] = [];
  const matchedLineNumbers = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    re.lastIndex = 0;
    if (re.test(line)) {
      if (matchedLineNumbers.has(i)) continue;
      matchedLineNumbers.add(i);
      const ctxStart = Math.max(0, i - ctxLines);
      const ctxEnd = Math.min(lines.length - 1, i + ctxLines);
      const parts: string[] = [];
      for (let ci = ctxStart; ci <= ctxEnd; ci++) {
        const prefix = ci === i ? ">" : " ";
        parts.push(`${prefix} ${lines[ci] ?? ""}`);
      }
      matches.push({ line: i + 1, match: line.trim(), context: parts.join("\n") });
    }
  }
  return matches;
}

// --- Main search loop ---
const fileResults: any[] = [];
let totalMatches = 0;

for (const file of candidates) {
  try {
    const content = await app.vault.cachedRead(file);
    const matches = searchFile(content, regex, contextLines);
    if (matches.length > 0) {
      const totalMatchCount = matches.length;
      const cappedMatches = matches.slice(0, MAX_MATCHES_PER_FILE);
      fileResults.push({
        path: file.path,
        matches: cappedMatches,
        match_count: cappedMatches.length,
        total_match_count: totalMatchCount,
        backlink_count: backlinkCounts.get(file.path) ?? 0,
        modified: new Date(file.stat.mtime).toISOString(),
      });
      totalMatches += totalMatchCount;
    }
  } catch (e: any) {
    log.debug("Skipping unreadable file", { path: file.path, error: e.message ?? String(e) });
  }
  regex.lastIndex = 0;
}

// --- Sort ---
const sorted = [...fileResults].sort((a, b) => {
  switch (sortBy) {
    case "backlinks": return b.backlink_count - a.backlink_count;
    case "modified": return new Date(b.modified).getTime() - new Date(a.modified).getTime();
    default: return b.total_match_count - a.total_match_count;
  }
});

// --- Paginate and return ---
const totalFiles = sorted.length;
const paginated = sorted.slice(offset, offset + limit);

log.debug("Search complete", { query, totalMatches, filesSearched: candidates.length, filesWithMatches: totalFiles, returned: paginated.length });

return { total_matches: totalMatches, total_files: totalFiles, files: paginated };
```

**No new `utils` expansions needed.** All dependencies are already exposed. The tool uses only `app.vault`, `app.metadataCache`, and `utils.logger` — all part of the shared runtime since day one.

**No `libs` or `obsidian` imports needed beyond `TFile`.** The scaffold uses `app.vault.getFiles()` which returns `TFile[]` — but the scaffold treats these as opaque objects (accessing `.path`, `.name`, `.stat.mtime`), so no explicit `TFile` import is required. `obsidian.TFile` is available if needed for type assertions, but not necessary in the stripped JS output.

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

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence.

**Risk: Regex `lastIndex` statefulness (low).** The `/g` flag makes RegExp stateful — `lastIndex` must be reset between files and between lines. The scaffold preserves both resets (per-line in `searchFile()` and per-file in the main loop). This is a 1:1 port of the built-in behavior; no behavioral change.

**Risk: Large vault performance (low).** The scaffold reads each candidate file individually via `cachedRead()` — the same approach as the built-in class. `cachedRead()` uses Obsidian's in-memory file cache, so for already-cached files this is fast. For vaults with 10,000+ markdown notes, the main cost is the linear scan. This is unchanged from the built-in and acceptable per NFR-1.

**Risk: `matchesGlob` regex injection (low).** The glob-to-regex conversion escapes all special regex characters except `*`. This matches the built-in behavior. Malicious glob patterns from the LLM could theoretically produce pathological regexes (ReDoS), but the pattern is tested only against short filenames, making catastrophic backtracking effectively impossible.

**Comparison with spec's complexity estimate:** The spec classifies `search_vault` as "Complex" at 200-400 lines. The actual scaffold is ~150 lines — lower than the floor estimate. This is because `search_vault` has no external dependencies, no settings, no filesystem I/O beyond `cachedRead()`, and no library usage. All helpers are pure procedural code (filtering, sorting, line matching) that inline cleanly. The "Complex" classification was driven by the helper count (5 private methods), not by dependency complexity. In practice, this tool is closer to "Medium" — more code than `read_frontmatter` or `get_outlinks`, but structurally simpler than `fetch_webpage` or `read_file` because it has zero settings, zero library deps, and zero `utils` expansions.

### `write_note` — Feasibility: Straightforward ✅

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

**Settings:** None. Zero `NotorSettings` fields referenced. No per-extension or shared settings needed. Listed in the spec's "settings-free tools" group (D-2).

**Helper functions (1 to inline):**

1. **`ensureDirectoryExists()`** (~20 lines) — Creates intermediate vault directories for a file path. Splits path on `/`, iterates segments, checks each via `app.vault.getAbstractFileByPath()`, creates missing folders via `app.vault.createFolder()`, throws if a segment exists as a file (not a folder, checked via `instanceof TFolder`). This exact helper is duplicated in `write-note.ts`, `move-note.ts`, and `extract-docx-comments.ts` (3 copies). The `extract_docx_comments` assessment (already in this doc) notes this pattern and concludes that inlining in each scaffold is acceptable since it's only ~15 lines and only 2-3 scaffolds need it. No `utils` expansion needed — inline as a local function.

**Return value mapping:**
- New file → return string like `"Note created: path/to/note.md (123 characters)"` (adapter wraps in `{ success: true, result: string }`)
- Existing file → return string like `"Note updated: path/to/note.md (456 characters)"` (adapter wraps in `{ success: true, result: string }`)
- Validation failures → throw (adapter wraps in `{ success: false, error }`)
- Stale content → throw with stale error message
- File system failures → throw (adapter catches)

**Key patterns and their scaffold translations:**

1. **Create-vs-update branching** — The class has two distinct code paths based on whether `resolveNote()` returns a `TFile` or `null`. New files go through `vault.create()`, existing files through `vault.process()`. This translates directly — `utils.resolveNote()` returns the same `TFile | null`. The scaffold uses a simple `if (!existingFile)` branch.

2. **Frontmatter preservation** — When overwriting an existing note, the class compares `getFrontMatterInfo()` on both old and new content. If the existing note has frontmatter but the new content doesn't, the existing frontmatter block is prepended to the new content. This is a 10-line pattern using `obsidian.getFrontMatterInfo` which is already exposed. The `contentStart` offset from `getFrontMatterInfo` correctly handles the frontmatter delimiter and trailing newline.

3. **Stale tracker canonical path** — Same pattern as `replace_in_note`: uses `existingFile.path` (Obsidian's canonical resolved path) for all stale tracker calls, ensuring `"My Note"`, `"My Note.md"`, and `"folder/My Note"` all resolve to the same tracker entry.

4. **Stale tracker update after write** — After `vault.process()`, calls `staleTracker.updateAfterWrite(existingFile.path, finalContent)` with the content that was written (not re-reading from disk). This is simpler than `replace_in_note`'s approach (which re-reads after write) because `write_note` already has the final content in a local variable.

5. **Directory creation for new files** — `ensureDirectoryExists()` is called only on the new-file path (before `vault.create()`). It's not needed for existing files since their directory already exists. Uses `TFolder` from `obsidian` for the type check.

6. **Checkpoint before write (existing files only)** — `createCheckpoint()` is called only for existing files, before `vault.process()`. For new files, there's nothing to checkpoint. The class uses optional chaining (`this.checkpointManager?.createCheckpoint()`); the scaffold doesn't need it since `utils.checkpointManager` is always defined.

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

// Stale content check (before checkpoint — no point snapshotting if stale)
const staleResult = utils.staleTracker.check(existingFile.path, currentContent);
if (staleResult.isStale) {
  throw new Error(
    "Note content has changed since last read. " +
    "Re-read the note with read_note before retrying."
  );
}

// Checkpoint before overwriting
await utils.checkpointManager.createCheckpoint(existingFile.path, "write_note", "");

// Frontmatter preservation: if existing note has frontmatter but new content doesn't,
// prepend the existing frontmatter block
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

// Update stale tracker so subsequent writes don't falsely detect staleness
utils.staleTracker.updateAfterWrite(existingFile.path, finalContent);

log.info("Modified existing note", { path: existingFile.path, chars: finalContent.length });
await utils.noteOpener.openNote(existingFile.path);

return `Note updated: ${existingFile.path} (${finalContent.length} characters)`;
```

**No new `utils` expansions needed.** All dependencies are already exposed in the extension runtime: `resolveNote`, `staleTracker`, `checkpointManager`, `noteOpener`, `logger`. The `ensureDirectoryExists` helper is inlined as a local function (~15 lines) rather than added to `utils` — same decision as documented in the `extract_docx_comments` assessment.

**`obsidian` imports needed:** `getFrontMatterInfo` (frontmatter detection) and `TFolder` (directory type check in `ensureDirectoryExists`). Both are already exposed via `buildObsidianExports()`.

**No `libs` needed.** No external libraries, no Node.js modules.

**No settings migration needed.** This tool references zero `NotorSettings` fields. No per-extension `settings:` section in the YAML fence, no shared settings.

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

**Scaffold `scaffold()` call change:** Only needs the new 5th `code` parameter added. No `settings:` section in the YAML fence. The existing YAML fence content is already correct.

**Risk: `vault.process()` callback with closure variable (none).** The scaffold captures `finalContent` in a closure and passes `() => finalContent` to `vault.process()`. This is the exact same pattern as the built-in class — `vault.process` invokes the callback synchronously, so there's no timing issue. The `finalContent` variable is computed before the call and never mutated after.

**Risk: `noteOpener` optional chaining removal (none).** Same as `replace_in_note` — the class uses `this.noteOpener?.openNote()` because `noteOpener` is an optional constructor param (undefined in unit tests). In the scaffold, `utils.noteOpener` is always defined. The `openNote()` method itself is a no-op when `open_notes_on_access` is disabled. Removing the `?.` is safe.

**Risk: `ensureDirectoryExists` duplication (low).** The helper is duplicated across `write_note`, `move_note`, and `extract_docx_comments` scaffolds. At ~15 lines each, this is manageable. If a fourth tool needs it, extracting to `utils.ensureDirectoryExists()` becomes worthwhile. For now, inline duplication is preferred per the `extract_docx_comments` assessment precedent.

**Comparison with spec's complexity estimate:** The spec classifies `write_note` as "Medium" at 80-280 lines and estimates ~120 lines. The scaffold is ~80 lines — at the low end. This is because the tool's logic, while branching (new vs. existing), is procedurally straightforward: no loops, no complex data transformations, no external library calls. The frontmatter preservation is the only non-trivial pattern, and it's a self-contained 10-line block using `obsidian.getFrontMatterInfo`. Structurally similar to `replace_in_note` (stale check → checkpoint → vault write → stale update → open) but with the additional create-new-file path and frontmatter preservation logic.
