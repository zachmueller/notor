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
