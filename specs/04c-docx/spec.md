# Phase 4c — `.docx` Read/Write Tools

**Created:** 2026-03-16
**Status:** Draft
**Branch:** 04c-docx

## Overview

Phase 4c introduces three new built-in tools that let the AI read and write files on the native filesystem, with first-class support for Word (`.docx`) documents:

- **`read_file`** — reads any text-based file from the filesystem and returns its raw contents.
- **`read_docx`** — reads a `.docx` file and returns its content converted to Markdown.
- **`write_docx`** — converts Markdown content to a `.docx` file, optionally applying styles and layout from a user-supplied Word template.

All three tools are **desktop-only** (Obsidian's Electron environment). They are not supported on mobile.

All npm dependencies are MIT-licensed free packages. No external binaries or commercial modules are required.

This specification covers:

- Tool behavior, parameters, and error handling for all three tools.
- A shared path resolution and validation utility (extracted from `execute_command`) used by all three tools.
- New settings fields and UI section.
- Tool registration and auto-approve defaults.
- `write_docx`'s Markdown-to-docx pipeline and template grafting system.

---

## User stories

### `read_file`

- As a user, I want the AI to read a text file from my filesystem (e.g., a config file, a CSV, a script) so I can ask it to explain or transform it.
- As a user, I want to control which filesystem paths the AI can read from, so it cannot freely access files outside my vault or approved directories.

### `read_docx`

- As a user, I want the AI to read a `.docx` document from my filesystem and extract its content as Markdown, so I can ask the AI to summarize or transform it.
- As a user, I want the AI to import a `.docx` file's content into a vault note, bridging my Word documents with my Obsidian vault.

### `write_docx`

- As a user, I want the AI to take an outline or notes I've drafted in my vault and produce a polished `.docx` file, formatted correctly, ready to share.
- As a user with a corporate or personal Word template, I want the generated `.docx` to inherit my template's fonts, margins, headers, footers, and styles — without requiring me to post-process the file.
- As a user, I want to configure a default output directory and a default template so the AI can produce `.docx` files without me needing to specify paths every time.

---

## Functional requirements

### FR-70: `read_file` tool

**Description:** A new `read_file` tool reads any text-based file from the native filesystem and returns its raw content. The path is validated against the vault root and a configurable allowed-paths list. Binary files are rejected with a helpful error.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the file. Vault-relative or absolute. |
| `encoding` | string | No | File encoding. Default: `utf-8`. |

**Acceptance criteria:**

- `mode` is `"read"`. Available in both Plan and Act modes.
- Desktop-only: returns error `"read_file is only available on desktop."` if `Platform.isDesktopApp` is false.
- Path resolution follows the shared utility (FR-74): vault-relative paths are resolved from vault root; absolute paths are used as-is.
- The resolved path must be within the vault root or one of the `read_file_allowed_paths` entries; otherwise returns error `"Path '...' is outside the allowed paths. Allowed: vault root and configured paths."`.
- If the file does not exist, returns error `"File not found: ..."`.
- Binary file detection: after reading, check the first 8 KB of content for null bytes (`\0`). If found, return error `"read_file only supports text-based files. For Word documents, use read_docx instead."`.
- Returns the full file contents as the tool result string on success.
- Auto-approve default: `false`.

---

### FR-71: `read_docx` tool

**Description:** A new `read_docx` tool reads a `.docx` file from the native filesystem, converts it to Markdown using `mammoth` (`.docx` → HTML) and the already-bundled `turndown` (HTML → Markdown), and returns the Markdown as the tool result.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `path` | string | Yes | Path to the `.docx` file. Vault-relative or absolute. |

**Acceptance criteria:**

- `mode` is `"read"`. Available in both Plan and Act modes.
- Desktop-only: returns error `"read_docx is only available on desktop."` if `Platform.isDesktopApp` is false.
- Path validation uses the shared utility (FR-74) with `read_file_allowed_paths` (same whitelist as `read_file`).
- If the file does not exist, returns error `"File not found: ..."`.
- If the file extension is not `.docx` (case-insensitive), returns error `"read_docx only supports .docx files."`.
- Converts `.docx` → HTML using `mammoth.convertToHtml()` with its default style map.
- Converts HTML → Markdown using `turndown` with GFM plugin, consistent with how `fetch_webpage` uses it.
- Embedded images are represented as `[image]` placeholders (image extraction is out of scope for v1).
- Returns the Markdown string as the tool result on success.
- Auto-approve default: `false`.

---

### FR-72: `write_docx` tool — parameters and output path resolution

**Description:** A new `write_docx` tool converts Markdown content to a `.docx` file and writes it to the native filesystem. Output path is determined by a three-step resolution rule using tool parameters and settings.

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | Markdown content to convert to `.docx`. |
| `output_path` | string | Conditional | Vault-relative or absolute output file path (including `.docx` extension). Required if `write_docx_default_output_dir` is not configured and `filename` is not provided. |
| `filename` | string | No | Output filename without `.docx` extension. Combined with `write_docx_default_output_dir` to form the output path. |
| `template_path` | string | No | Path to a `.docx` template. Vault-relative or absolute. Overrides `write_docx_default_template_path`. |

**Output path resolution (in order):**

1. If `output_path` is provided, use it directly (resolve vault-relative paths from vault root).
2. Else if `filename` is provided and `write_docx_default_output_dir` is non-empty, combine them: `join(resolve(defaultOutputDir), filename + ".docx")`.
3. Otherwise, return error: `"No output path provided. Pass output_path, or provide a filename and configure write_docx_default_output_dir in Settings."`.

**Template path resolution (in order):**

1. If `template_path` parameter is provided, use it.
2. Else if `write_docx_default_template_path` is non-empty, use it.
3. Otherwise, use no template (no-template fallback, see FR-73).

**Acceptance criteria:**

- `mode` is `"write"`. Available in Act mode only; blocked in Plan mode.
- Desktop-only: returns error `"write_docx is only available on desktop."` if `Platform.isDesktopApp` is false.
- The resolved output path must be within the vault root or one of the `read_file_allowed_paths` entries; otherwise returns error `"Output path '...' is outside the allowed paths. Allowed: vault root and configured paths."`.
- If a resolved `template_path` does not exist, returns error `"Template file not found: ..."`.
- If the resolved `template_path` does not have a `.docx` extension (case-insensitive), returns error `"Template must be a .docx file."`.
- Overwriting an existing file is allowed without a confirmation prompt, consistent with how `write_note` overwrites existing vault notes. No checkpoint is created (see Assumptions).
- On success, returns `"Successfully wrote .docx file to <resolvedOutputPath>"`.
- Auto-approve default: `false`.

---

### FR-73: `write_docx` — Markdown-to-docx pipeline and template system

**Description:** `write_docx` converts Markdown to `.docx` using the `docx` npm package for content generation. When a template is provided, the generated document body is grafted into the template's ZIP archive using `pizzip`, preserving all template styles, margins, headers, and footers.

**Markdown parsing:**

- Uses `marked` in lexer mode to tokenize the Markdown input into a token tree (headings, paragraphs, lists, tables, blockquotes, code blocks, horizontal rules, inline bold/italic/code).
- The token tree is traversed to build a `docx` Document containing the appropriate `Paragraph`, `Table`, `TextRun`, and other `docx` npm objects.

**Supported Markdown elements:**

| Markdown element | `docx` mapping |
|-----------------|----------------|
| `# H1` – `###### H6` | `HeadingLevel.HEADING_1` – `HEADING_6` |
| Body paragraphs | `new Paragraph({ text })` |
| **Bold** | `TextRun({ bold: true })` |
| *Italic* | `TextRun({ italics: true })` |
| `inline code` | `TextRun` with `Courier New` font |
| Fenced code blocks | `Paragraph` with preserved line breaks, monospace font |
| Bullet lists | `Paragraph` with `bullet: { level }` |
| Numbered lists | `Paragraph` with `numbering` via `AbstractNumbering` |
| Tables | `Table`, `TableRow`, `TableCell` |
| Horizontal rules | Thematic break paragraph |
| Blockquotes | Indented paragraph |

**No-template path:**

1. Build `docx` `Document` from parsed Markdown.
2. Call `Packer.toBuffer()` to produce a binary buffer.
3. Write buffer to the output path via `fs.promises.writeFile`.

**With-template path (pizzip body-replacement hybrid):**

1. Build `docx` `Document` from parsed Markdown.
2. Call `Packer.toBuffer()` to produce a temporary in-memory buffer.
3. Use `pizzip` to unzip the temp buffer; locate `word/document.xml` and extract its `<w:body>` XML.
4. Use `pizzip` to unzip the template file; locate `word/document.xml`.
5. Extract the template's `<w:sectPr>` block from the template's `word/document.xml` (always the last child of `<w:body>` in a well-formed `.docx`).
6. Replace the `<w:body>` in the template's `word/document.xml` with the generated body, then restore the template's `<w:sectPr>` as the last child of `<w:body>` before `</w:body>`.
7. Repack the modified template ZIP using `pizzip.generate({ type: "nodebuffer" })`.
8. Write the final buffer to the output path via `fs.promises.writeFile`.

**`<w:sectPr>` preservation:** The template's `<w:sectPr>` block encodes page margins, page size/orientation, and header/footer relationship IDs. It must survive the body replacement so the output file inherits all of the template's page layout settings. Any `<w:sectPr>` carried over from the generated temp doc's body is discarded.

**Style name matching:** Content paragraphs reference Word's standard built-in style IDs (`Heading1`–`Heading6`, `Normal`, `ListParagraph`). Templates using these standard style names render correctly. Templates with fully custom heading/body style names will display the text with fallback styling; custom style name mapping is a future enhancement.

**Acceptance criteria:**

- All Markdown elements listed in the table above are converted correctly in both template and no-template modes.
- Template mode: the output `.docx` opens without errors and its page margins, fonts, headers, and footers match the template.
- No-template mode: the output `.docx` opens without errors in Microsoft Word and LibreOffice, with correct heading hierarchy.
- If the template's `word/document.xml` cannot be parsed (missing body tags, malformed XML), returns error: `"Template document.xml is malformed — could not locate <w:body>."`.

---

### FR-74: Shared path resolution and validation utility

**Description:** The path resolution and allowed-paths validation logic currently embedded in `execute_command.ts` is extracted into a shared utility module used by all three new tools and `execute_command`.

**New file:** `src/utils/path-validation.ts`

**Exported API:**

```typescript
/**
 * Resolve a filesystem path (vault-relative or absolute) to an absolute path,
 * then validate it is within the vault root or one of the allowed paths.
 *
 * Resolution rules:
 * - Empty/undefined → vault root
 * - Relative path → resolve from vault root
 * - Absolute path → use as-is, normalized
 */
export function resolveAndValidatePath(
    inputPath: string,
    vaultRoot: string,
    allowedPaths: string[]
): { valid: true; resolvedPath: string } | { valid: false; error: string }

/**
 * Check if `target` is within (or equal to) `base`.
 * Pure path comparison — does not stat the filesystem.
 */
export function isPathWithin(target: string, base: string): boolean
```

**Acceptance criteria:**

- `resolveAndValidatePath` implements the same logic as `resolveAndValidateWorkingDir` in `execute-command.ts`: empty/undefined → vault root; relative → resolve from vault root; absolute → use as-is; then boundary-check against vault root and all allowed paths.
- `execute-command.ts` is updated to import `resolveAndValidatePath` and `isPathWithin` from this shared utility, removing its local copies. External behavior of `execute_command` is unchanged.
- `read-file.ts`, `read-docx.ts`, and `write-docx.ts` each import and use `resolveAndValidatePath`.
- The function name changes from `resolveAndValidateWorkingDir` to `resolveAndValidatePath` to reflect broader use beyond working directories.

---

### FR-75: Settings additions

**Description:** Three new settings fields are added to `NotorSettings`.

| Setting key | Type | Default | Description |
|-------------|------|---------|-------------|
| `read_file_allowed_paths` | `string[]` | `[]` | Additional filesystem paths allowed for `read_file`, `read_docx`, and `write_docx`. Vault root is always implicitly allowed. Mirrors `execute_command_allowed_paths`. |
| `write_docx_default_output_dir` | `string` | `""` | Default output directory for `write_docx`. Accepts vault-relative or absolute path. |
| `write_docx_default_template_path` | `string` | `""` | Default template `.docx` path. Accepts vault-relative or absolute path. Overridable per `write_docx` call. |

**Acceptance criteria:**

- All three fields are added to `NotorSettings` in `src/settings/types.ts` under a `// Phase 4c` comment block.
- Defaults are added to `createDefaultSettings` in `src/settings/defaults.ts`.
- Plugin settings are loaded via `Object.assign({}, createDefaultSettings(), await loadData())`. Missing fields in existing `data.json` files automatically receive the above defaults. No explicit migration code is needed.
- Three new auto-approve defaults are added to `DEFAULT_AUTO_APPROVE` in `src/settings/defaults.ts`: `read_file: false`, `read_docx: false`, `write_docx: false`.
- Three new entries are added to `TOOL_DISPLAY_NAMES` in `src/settings/constants.ts` (see FR-77).

---

### FR-76: Settings UI section

**Description:** A new "Word & file tools" settings section is added to the Settings tab, providing UI controls for the three new settings fields.

**New file:** `src/settings/sections/docx-tools.ts`

**Acceptance criteria:**

- The section is headed **"Word & file tools"** with a brief paragraph description noting these tools are desktop-only and require the AI to be in Act mode for `write_docx`.
- An **"Allowed read/write paths"** sub-heading introduces a list of current `read_file_allowed_paths` entries, each showing the path and a "Remove" button. Below the list, a text field and "Add" button allow adding new paths. This pattern follows `renderExecuteCommandSection` exactly.
- A **"Default output directory"** text input for `write_docx_default_output_dir`, with placeholder `(none — output_path required per call)`.
- A **"Default template path"** text input for `write_docx_default_template_path`, with placeholder `(none — no template applied by default)`.
- All changes persist immediately via `ctx.saveSettings()`.
- The section is rendered in the main Settings tab immediately after the "Shell commands" section.

---

### FR-77: Tool registration and `TOOL_DISPLAY_NAMES`

**Description:** All three new tools are registered in the `ToolRegistry` at plugin load time, and their display metadata is added to `TOOL_DISPLAY_NAMES`.

**Acceptance criteria:**

- `ReadFileTool`, `ReadDocxTool`, and `WriteDocxTool` are imported and instantiated in `main.ts`'s `get toolRegistry()` getter alongside existing tools.
- All three tools receive `(app, settings)` as constructor arguments (for vault root resolution and allowed-paths access).
- Three new entries are added to `TOOL_DISPLAY_NAMES` in `src/settings/constants.ts`:

  ```typescript
  read_file: {
      name: "Read file",
      desc: "Read a text file from the filesystem (desktop only).",
      isWrite: false,
  },
  read_docx: {
      name: "Read Word doc",
      desc: "Read a .docx file and return its content as Markdown (desktop only).",
      isWrite: false,
  },
  write_docx: {
      name: "Write Word doc",
      desc: "Convert Markdown to a .docx file on the filesystem (desktop only).",
      isWrite: true,
  },
  ```

- All three tools appear in the auto-approve section of Settings.

---

## Non-functional requirements

### NFR-19: Desktop-only enforcement

**Description:** All three tools are desktop-only and fail gracefully on mobile.

**Acceptance criteria:**

- All three tools check `Platform.isDesktopApp` at the top of `execute()` and return a `ToolResult` with `success: false` and a descriptive error when not on desktop, consistent with `execute_command`.

---

### NFR-20: npm dependencies

**Description:** Four MIT-licensed npm packages are added as production dependencies.

| Package | Version constraint | License | Role |
|---------|--------------------|---------|------|
| `mammoth` | `^1.8.0` | MIT | `.docx` → HTML conversion for `read_docx` |
| `docx` | `^9.6.1` | MIT | Content generation (Markdown → OOXML) for `write_docx` |
| `pizzip` | `^3.1.7` | MIT | ZIP manipulation for template grafting in `write_docx` |
| `marked` | `^17.0.0` | MIT | Markdown tokenization for `write_docx` |

**Acceptance criteria:**

- All four packages are added to `dependencies` in `package.json`.
- `turndown` (already bundled for `fetch_webpage`) is reused by `read_docx` for HTML → Markdown conversion — no new dependency.
- Type declarations for `mammoth` are added (official `@types/mammoth` if available; otherwise a local `.d.ts` declaration in `src/`).
- The plugin bundles successfully via esbuild. All new packages resolve without ESM-only issues in Obsidian's Electron/esbuild environment.

---

### NFR-21: Binary file detection in `read_file`

**Description:** `read_file` must not return garbled binary content to the AI.

**Acceptance criteria:**

- After reading the file buffer, inspect the first 8 KB for null bytes (`\0`).
- If null bytes are detected, return error: `"read_file only supports text-based files. For Word documents, use read_docx instead."`.
- This null-byte heuristic is sufficient for v1. No MIME-type detection library is needed.

---

## User scenarios & testing

### Primary flow: Import a Word document into a vault note

1. User has a `.docx` research paper at `/Users/alice/Documents/paper.docx`.
2. User adds `/Users/alice/Documents` to the "Allowed read/write paths" in Settings → Word & file tools.
3. User asks the AI: "Read paper.docx and create a note summarizing the key points."
4. AI calls `read_docx` with `path: "/Users/alice/Documents/paper.docx"`.
5. Tool reads the file, converts to Markdown, returns it as the tool result.
6. AI summarizes the content and calls `write_note` with the summary.

### Primary flow: Export vault notes to a Word document with a template

1. User has a company template at `/Users/alice/Templates/report.docx`.
2. User configures `write_docx_default_template_path: "/Users/alice/Templates/report.docx"` and `write_docx_default_output_dir: "/Users/alice/Reports"` in Settings.
3. User asks the AI: "Turn my outline note 'Q1 Report Outline' into a polished Word document."
4. AI reads the note with `read_note`, then calls `write_docx` with `content: "<markdown outline>"` and `filename: "Q1 Report"`.
5. Tool resolves the output path to `/Users/alice/Reports/Q1 Report.docx` and applies the default template.
6. Tool grafts the generated body into the template ZIP, preserving margins, headers, and footers.
7. Tool returns `"Successfully wrote .docx file to /Users/alice/Reports/Q1 Report.docx"`.

### Primary flow: Read a plain text file from the filesystem

1. User asks: "Read my project's README at /Users/alice/projects/app/README.md and tell me what it does."
2. AI calls `read_file` with `path: "/Users/alice/projects/app/README.md"`.
3. `/Users/alice/projects/app` is in `read_file_allowed_paths` — file is read and returned.
4. AI summarizes the README content.

### Alternative flow: Path outside allowed paths

1. AI calls `read_file` with `path: "/etc/passwd"`.
2. `/etc` is not the vault root and not in `read_file_allowed_paths`.
3. Tool returns error: `"Path '/etc/passwd' is outside the allowed paths. Allowed: vault root and configured paths."`.

### Alternative flow: `write_docx` with no output path configured

1. AI calls `write_docx` with `content: "# My Doc\n..."` but no `output_path` or `filename`.
2. `write_docx_default_output_dir` is empty.
3. Tool returns error: `"No output path provided. Pass output_path, or provide a filename and configure write_docx_default_output_dir in Settings."`.

### Alternative flow: Mobile environment

1. User accesses Obsidian on iPad.
2. AI attempts to call `read_docx`.
3. Tool returns error: `"read_docx is only available on desktop."`.

### Alternative flow: Overwriting an existing `.docx` file

1. AI calls `write_docx` targeting an already-existing file.
2. The tool writes the new content directly, overwriting the existing file.
3. Tool returns `"Successfully wrote .docx file to <resolvedPath>"`.

### Alternative flow: Malformed template

1. User's template `.docx` has a corrupted `word/document.xml`.
2. `pizzip` opens the ZIP successfully, but the XML does not contain a `<w:body>` element.
3. Tool returns error: `"Template document.xml is malformed — could not locate <w:body>."`.

### Alternative flow: Binary file passed to `read_file`

1. AI calls `read_file` with `path: "/Users/alice/image.png"`.
2. Tool reads the file, detects null bytes in the first 8 KB.
3. Tool returns error: `"read_file only supports text-based files. For Word documents, use read_docx instead."`.

---

## Success criteria

1. **`read_file` works correctly** — reads text files within allowed paths, rejects binary files and out-of-bounds paths, fails gracefully on mobile.
2. **`read_docx` works correctly** — reads `.docx` files and returns readable Markdown with correct heading, bold, italic, and table structure. Rejects non-`.docx` files and out-of-bounds paths.
3. **`write_docx` (no template) works correctly** — generates a valid, well-formed `.docx` from Markdown with all supported elements rendered using standard Word styles. Opens without errors in Microsoft Word and LibreOffice.
4. **`write_docx` (with template) works correctly** — generated body is grafted into the template's ZIP; output inherits the template's fonts, margins, headers, and footers; `<w:sectPr>` is preserved.
5. **Shared path utility is correct** — `resolveAndValidatePath` handles vault-relative paths, absolute paths inside/outside the vault, and path traversal attempts consistently with the existing `execute_command` logic.
6. **Settings UI works** — all three new settings fields are configurable from Settings; changes persist immediately.
7. **Tool registration is complete** — all three tools appear in the auto-approve section.
8. **Backward compatibility** — existing installations upgrade without data migration; new settings default to empty/false.

---

## Key entities

### `ReadFileTool` (`src/tools/read-file.ts`)

Implements the `Tool` interface.

| Property | Value |
|----------|-------|
| `name` | `"read_file"` |
| `mode` | `"read"` |
| Constructor args | `(app: App, settings: NotorSettings)` |

### `ReadDocxTool` (`src/tools/read-docx.ts`)

Implements the `Tool` interface.

| Property | Value |
|----------|-------|
| `name` | `"read_docx"` |
| `mode` | `"read"` |
| Constructor args | `(app: App, settings: NotorSettings)` |

### `WriteDocxTool` (`src/tools/write-docx.ts`)

Implements the `Tool` interface.

| Property | Value |
|----------|-------|
| `name` | `"write_docx"` |
| `mode` | `"write"` |
| Constructor args | `(app: App, settings: NotorSettings)` |

### New settings fields (added to `NotorSettings`)

```typescript
// Phase 4c: docx & file tools
read_file_allowed_paths: string[];
write_docx_default_output_dir: string;
write_docx_default_template_path: string;
```

### New `DEFAULT_AUTO_APPROVE` entries

```typescript
read_file: false,
read_docx: false,
write_docx: false,
```

---

## New files

| File | Purpose |
|------|---------|
| `src/tools/read-file.ts` | `ReadFileTool` implementation |
| `src/tools/read-docx.ts` | `ReadDocxTool` implementation |
| `src/tools/write-docx.ts` | `WriteDocxTool` implementation |
| `src/utils/path-validation.ts` | Shared path resolution and validation utility |
| `src/settings/sections/docx-tools.ts` | Settings UI section for Word & file tools |

## Modified files

| File | Change |
|------|--------|
| `src/settings/types.ts` | Add three new settings fields |
| `src/settings/defaults.ts` | Add new defaults and auto-approve entries |
| `src/settings/constants.ts` | Add three `TOOL_DISPLAY_NAMES` entries |
| `src/settings/index.ts` | Render new settings section after "Shell commands" |
| `src/tools/execute-command.ts` | Replace local path utilities with imports from `src/utils/path-validation.ts` |
| `src/main.ts` | Register three new tools in `get toolRegistry()` |
| `package.json` | Add `mammoth`, `docx`, `pizzip`, `marked` dependencies |

---

## Assumptions

- `fs` (Node.js built-in) is available in Obsidian's Electron desktop environment. All file I/O uses `fs.promises.readFile` / `fs.promises.writeFile`. No bundling of `fs` is required.
- `app.vault.adapter.basePath` is the authoritative vault root path, consistent with how `execute_command` resolves it today.
- `turndown` and `turndown-plugin-gfm` are already in the bundle (used by `fetch_webpage`). `read_docx` imports them directly with no new dependency.
- `mammoth`, `docx`, `pizzip`, and `marked` work in Obsidian's Electron renderer process. Electron provides `Buffer` and other Node globals that these packages may rely on.
- Overwriting an existing `.docx` file with `write_docx` requires no confirmation prompt in v1, consistent with how `write_note` overwrites existing vault notes. The vault-based `CheckpointManager` is text-only and does not extend to binary filesystem files, so no checkpoint is created.
- `read_file_allowed_paths` is shared by all three tools (both read and write). This is intentional for simplicity — the same trusted directories cover both reading and writing. A dedicated `write_docx_allowed_paths` is deferred.
- `marked` is used in lexer/tokenizer mode to produce a token tree. The token tree drives `docx` API object construction directly; no HTML intermediate is produced during `write_docx` processing.

---

## Out of scope

- Mobile support for any of the three tools.
- Reading embedded images from `.docx` (image extraction).
- PDF read or write.
- XLSX or other Office formats.
- Custom style name mapping for templates with non-standard heading/body style names.
- DOCX-to-DOCX in-place editing (modifying an existing `.docx` without replacing it wholesale).
- Checkpoint or backup before `write_docx` overwrites an existing file. The vault-based checkpoint system is text-only; a `.bak` file fallback is a future enhancement.
- A general-purpose `write_file` tool (writing arbitrary text to the filesystem). Deferred — general filesystem writes carry higher security risk and `write_docx` covers the primary use case.
- Per-call output format options for `read_docx` (e.g., requesting plain text instead of Markdown).
- A dedicated `write_docx_allowed_paths` setting separate from `read_file_allowed_paths`. The shared list is sufficient for v1.
