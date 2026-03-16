# Phase 4c — `.docx` Read/Write Tools: Implementation Tasks

**Spec:** `specs/04c-docx/spec.md`
**Branch:** `04c-docx`

---

## Overview

Tasks are grouped into six phases. Each phase must be fully complete before the next begins, with the exception of Phase 4 tasks (the three tool implementations) which are independent of one another and can be worked in parallel.

```
Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6
                                 ↗ read-file
             ─────────────────── ─ read-docx   (parallel)
                                 ↘ write-docx
```

---

## Phase 1 — npm Dependencies & Type Declarations

*These tasks unblock everything that follows. Do them first.*

### DOCX-001 — Install npm dependencies

Add the four new production dependencies to `package.json` and install them:

- `mammoth` `^1.8.0`
- `docx` `^9.6.1`
- `pizzip` `^3.1.7`
- `marked` `^17.0.0`

Run `npm install` and verify the packages resolve without errors in the esbuild bundle (run `npm run build` or equivalent). Fix any ESM-only issues (e.g. add to esbuild `external` list or use a CJS-compatible import path) before proceeding.

**Files modified:** `package.json`, `package-lock.json`

### DOCX-002 — Add type declarations for `mammoth`

Check whether `@types/mammoth` is available on npm. If it is, install it as a dev dependency. If not, create a minimal local declaration file `src/mammoth.d.ts` that declares the module with at least the `convertToHtml(input: { buffer: Buffer }): Promise<{ value: string; messages: unknown[] }>` signature used by `read-docx`.

**Files created/modified:** `src/mammoth.d.ts` (if no `@types/mammoth`) or `package.json` (if `@types/mammoth` exists)

---

## Phase 2 — Shared Path-Validation Utility

*Unblocks all three tool implementations and cleans up `execute-command.ts`.*

### DOCX-003 — Create `src/utils/path-validation.ts`

Create the shared path resolution and validation utility as specified in FR-74.

Exported API (copy the JSDoc and signatures verbatim from the spec):

```typescript
export function resolveAndValidatePath(
    inputPath: string,
    vaultRoot: string,
    allowedPaths: string[]
): { valid: true; resolvedPath: string } | { valid: false; error: string }

export function isPathWithin(target: string, base: string): boolean
```

Implementation notes:
- Logic is identical to `resolveAndValidateWorkingDir` and the local `isPathWithin` in `src/tools/execute-command.ts` — copy and rename.
- Error message changes: use `"Path '...' is outside the allowed paths."` (not the working-directory-specific wording).
- `isPathWithin` becomes an exported function (it is currently private/local to `execute-command.ts`).

**Files created:** `src/utils/path-validation.ts`

### DOCX-004 — Refactor `execute-command.ts` to use the shared utility

Replace the local `resolveAndValidateWorkingDir` and `isPathWithin` in `src/tools/execute-command.ts` with imports from `src/utils/path-validation.ts`.

Adapter notes:
- `execute_command` still calls the function with `working_directory` semantics, but the underlying implementation is now `resolveAndValidatePath`. The working-directory-specific error message is produced by wrapping the call or adjusting the error string after the fact — ensure the external error message shown to users for `execute_command` is unchanged (see existing wording in `execute-command.ts` line 81-83).
- No change to `execute_command` behavior or output.

**Files modified:** `src/tools/execute-command.ts`

---

## Phase 3 — Settings Data Layer

*Unblocks tool implementations (Phase 4) and the settings UI (Phase 5).*

### DOCX-005 — Add new settings fields to `src/settings/types.ts`

Add the three new fields to the `NotorSettings` interface, under a `// Phase 4c: docx & file tools` comment block:

```typescript
// Phase 4c: docx & file tools
read_file_allowed_paths: string[];
write_docx_default_output_dir: string;
write_docx_default_template_path: string;
```

**Files modified:** `src/settings/types.ts`

### DOCX-006 — Add defaults to `src/settings/defaults.ts`

Two changes in `defaults.ts`:

1. Add the three new settings fields to `createDefaultSettings()`:
   ```typescript
   // Phase 4c: docx & file tools
   read_file_allowed_paths: [],
   write_docx_default_output_dir: "",
   write_docx_default_template_path: "",
   ```

2. Add three new auto-approve entries to `DEFAULT_AUTO_APPROVE`:
   ```typescript
   read_file: false,
   read_docx: false,
   write_docx: false,
   ```

**Files modified:** `src/settings/defaults.ts`

### DOCX-007 — Add `TOOL_DISPLAY_NAMES` entries to `src/settings/constants.ts`

Add three new entries to the `TOOL_DISPLAY_NAMES` record:

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

**Files modified:** `src/settings/constants.ts`

---

## Phase 4 — Tool Implementations

*All three tools depend on Phases 1–3. The three tools are independent of each other and can be implemented in any order (or in parallel).*

### DOCX-008 — Implement `ReadFileTool` (`src/tools/read-file.ts`)

Implement the `read_file` tool per FR-70 and NFR-19/NFR-21.

Key implementation details:
- Constructor: `(app: App, settings: NotorSettings)`.
- `name = "read_file"`, `mode = "read"`.
- `input_schema`: `path` (required string), `encoding` (optional string, default `"utf-8"`).
- Top of `execute()`: check `Platform.isDesktopApp`; if false return error `"read_file is only available on desktop."`.
- Resolve vault root via `(this.app.vault.adapter as { basePath?: string }).basePath`.
- Call `resolveAndValidatePath(path, vaultRoot, this.settings.read_file_allowed_paths)`.
- If the file does not exist, return error `"File not found: <resolvedPath>"`.
- Binary detection: read with `fs.promises.readFile(resolvedPath)` (no encoding arg → `Buffer`). Inspect first 8 KB (`buf.slice(0, 8192)`) for null bytes. If found, return error `"read_file only supports text-based files. For Word documents, use read_docx instead."`.
- Decode buffer: `buf.toString(encoding ?? "utf-8")`. Return decoded string as `result`.
- Catch all I/O errors and return the error message verbatim.

**Files created:** `src/tools/read-file.ts`

### DOCX-009 — Implement `ReadDocxTool` (`src/tools/read-docx.ts`)

Implement the `read_docx` tool per FR-71.

Key implementation details:
- Constructor: `(app: App, settings: NotorSettings)`.
- `name = "read_docx"`, `mode = "read"`.
- `input_schema`: `path` (required string).
- Top of `execute()`: check `Platform.isDesktopApp`; if false return error `"read_docx is only available on desktop."`.
- Resolve vault root and call `resolveAndValidatePath(path, vaultRoot, this.settings.read_file_allowed_paths)`.
- If the file does not exist, return error `"File not found: <resolvedPath>"`.
- Check file extension: `path.extname(resolvedPath).toLowerCase() !== ".docx"` → return error `"read_docx only supports .docx files."`.
- Read file as `Buffer` with `fs.promises.readFile(resolvedPath)`.
- Convert: `mammoth.convertToHtml({ buffer })` → HTML string.
- Instantiate a fresh `TurndownService` with GFM plugin, matching the options used in `fetch-webpage.ts` but not importing its module-level instance directly. Apply the same heading/code/fence options. Add a rule to map `<img>` elements to `[image]` placeholder text.
- Convert HTML to Markdown and return as result.
- Catch `mammoth` exceptions and return the error message verbatim.

**Files created:** `src/tools/read-docx.ts`

### DOCX-010 — Implement `WriteDocxTool` — path resolution & validation (`src/tools/write-docx.ts`, part 1)

Implement the `write_docx` tool's parameter handling and path validation per FR-72.

This task covers everything up to (but not including) the Markdown-to-docx pipeline. After this task, the tool should correctly validate all inputs and return appropriate errors, with a stub for the actual generation step.

Key implementation details:
- Constructor: `(app: App, settings: NotorSettings)`.
- `name = "write_docx"`, `mode = "write"`.
- `input_schema`: `content` (required string), `output_path` (optional string), `filename` (optional string), `template_path` (optional string).
- Top of `execute()`: check `Platform.isDesktopApp`; if false return error `"write_docx is only available on desktop."`.
- Validate `filename` does not contain `/` or `\`.
- Warn if both `output_path` and `filename` are provided (prepend warning to success message; `output_path` takes precedence).
- **Output path resolution** (three-step, per spec FR-72): if `output_path` provided use it; else if `filename` + `write_docx_default_output_dir` available combine them; else return no-output-path error.
- Validate output path with `resolveAndValidatePath` against `read_file_allowed_paths`.
- Check parent directory exists with `fs.promises.stat`; if not found return `"Output directory '...' does not exist."`.
- **Template path resolution**: `template_path` param → `write_docx_default_template_path` setting → no template.
- If a template path is resolved: validate with `resolveAndValidatePath`; check file exists; check `.docx` extension.
- All validations run before the pipeline (per spec FR-72 acceptance criteria).
- Stub out the generation step: after validation, call a (not yet implemented) `generateDocx(content, templatePath)` helper and write its result with `fs.promises.writeFile`.

**Files created:** `src/tools/write-docx.ts` (partial)

### DOCX-011 — Implement `WriteDocxTool` — Markdown-to-docx pipeline (`src/tools/write-docx.ts`, part 2)

Implement the `generateDocx` pipeline per FR-73. This task fills in the stub from DOCX-010.

**Markdown parsing with `marked`:**
- Call `marked.lexer(content)` to get the token tree.
- Traverse the top-level token array. Handle each token type: `heading`, `paragraph`, `list`, `table`, `blockquote`, `code`, `hr`, `space`. For inline content (paragraphs, headings, blockquotes), parse inline tokens (`bold`, `em`, `codespan`, `link`, `text`) and build `TextRun`/`ExternalHyperlink` objects.

**`docx` object mapping** (per the table in FR-73):

| Token | `docx` mapping |
|-------|---------------|
| `heading` (depth 1–6) | `new Paragraph({ heading: HeadingLevel.HEADING_N, children: [...] })` |
| `paragraph` | `new Paragraph({ children: [...] })` |
| `bold` inline | `new TextRun({ text, bold: true })` |
| `em` inline | `new TextRun({ text, italics: true })` |
| `codespan` inline | `new TextRun({ text, style: "Verbatim Char" })` (fallback: `font: { name: "Courier New" }`) |
| `code` block | `new Paragraph({ style: "Source Code", ... })` (fallback: `Normal` + `Courier New` font) |
| `list` (bullet) | `new Paragraph({ bullet: { level } })` per list item |
| `list` (ordered) | `new Paragraph({ numbering: { reference, level } })` using a defined `AbstractNumbering` |
| `table` | `new Table(...)` with `TableRow`/`TableCell` |
| `hr` | thematic break paragraph |
| `blockquote` | indented paragraph |
| `link` inline | `new ExternalHyperlink({ link, children: [new TextRun({ text })] })` |

**No-template path:**
1. `new Document({ sections: [{ children: [...paragraphs] }] })`
2. `Packer.toBuffer(doc)` → `Buffer`
3. `fs.promises.writeFile(outputPath, buffer)`

**With-template path (pizzip graft):**
1. Build and pack document to in-memory buffer as above.
2. `new PizZip(generatedBuffer)` → unzip generated doc; read `word/document.xml` as string.
3. Extract `<w:body>...</w:body>` content from generated XML using regex per spec.
4. `new PizZip(await fs.promises.readFile(templatePath))` → unzip template.
5. Read template's `word/document.xml`.
6. Extract template's `<w:sectPr>` block using `/<w:sectPr[\s\S]*?<\/w:sectPr>/`.
7. Strip any `<w:sectPr>` from the generated body content.
8. Replace template's `<w:body>...</w:body>` with: `<w:body>` + stripped generated content + template `<w:sectPr>` + `</w:body>`.
9. If `<w:body>` cannot be located in either document, return error `"Template document.xml is malformed — could not locate <w:body>."`.
10. Update template ZIP entry for `word/document.xml`.
11. `templateZip.generate({ type: "nodebuffer" })` → final buffer.
12. `fs.promises.writeFile(outputPath, finalBuffer)`.

**Files modified:** `src/tools/write-docx.ts` (completes the stub from DOCX-010)

---

## Phase 5 — Settings UI

*Depends on Phase 3 (settings types). Can be done in parallel with Phase 4.*

### DOCX-012 — Create `src/settings/sections/docx-tools.ts`

Implement `renderDocxToolsSection(containerEl, ctx)` per FR-76.

Structure:
1. Heading: **"Word & file tools"** with a description paragraph.
2. Sub-heading: **"Allowed read/write paths"** with description. Render list of current `read_file_allowed_paths` entries, each with a "Remove" button (follow the pattern in `renderExecuteCommandSection` exactly). Add path text field + "Add" button below.
3. Setting: **"Default output directory"** — text input bound to `write_docx_default_output_dir`, placeholder `(none — output_path required per call)`. Saves on `onChange`.
4. Setting: **"Default template path"** — text input bound to `write_docx_default_template_path`, placeholder `(none — no template applied by default)`. On blur:
   - If the field is non-empty, check `(a)` the path exists on the filesystem (`fs.promises.stat`) and `(b)` has a `.docx` extension.
   - If either check fails, display an inline error element beneath the field (create a `<p class="mod-warning">` or equivalent). Clear it when the field is empty or valid.
   - Save on any change (even if invalid — the validation is advisory, not blocking).
5. All saves via `ctx.saveSettings()`.

**Files created:** `src/settings/sections/docx-tools.ts`

### DOCX-013 — Wire the new section into the settings tab

In `src/settings/settings-tab.ts`:
1. Import `renderDocxToolsSection` from `./sections/docx-tools`.
2. Add a call to `renderDocxToolsSection(toolConfigGroup, ctx)` immediately after `renderExecuteCommandSection(toolConfigGroup, ctx)` (line 130).

**Files modified:** `src/settings/settings-tab.ts`

---

## Phase 6 — Tool Registration

*Depends on Phase 4 (tool classes must exist before they can be imported).*

### DOCX-014 — Register the three new tools in `src/main.ts`

In `main.ts`'s `getToolRegistry()` method:

1. Add imports for `ReadFileTool`, `ReadDocxTool`, `WriteDocxTool` at the top of the file alongside the existing tool imports.
2. In the registry builder block (after `ExecuteCommandTool` registration, around line 924), add:
   ```typescript
   this._toolRegistry.register(new ReadFileTool(this.app, this.settings));
   this._toolRegistry.register(new ReadDocxTool(this.app, this.settings));
   this._toolRegistry.register(new WriteDocxTool(this.app, this.settings));
   ```

All three tools appear in the auto-approve section automatically because they are in `DEFAULT_AUTO_APPROVE` (added in DOCX-006) and `TOOL_DISPLAY_NAMES` (added in DOCX-007).

**Files modified:** `src/main.ts`

---

## Dependency Map

```
DOCX-001 (npm deps)
DOCX-002 (types)
    └─ DOCX-003 (path-validation util)
         └─ DOCX-004 (refactor execute-command)
         └─ DOCX-005 (settings types)
              └─ DOCX-006 (settings defaults)
              └─ DOCX-007 (TOOL_DISPLAY_NAMES)
              └─ DOCX-012 (settings UI section)
                   └─ DOCX-013 (wire settings tab)
         └─ DOCX-008 (ReadFileTool)        ─┐
         └─ DOCX-009 (ReadDocxTool)         ├─ DOCX-014 (register in main.ts)
         └─ DOCX-010 + DOCX-011 (WriteDocxTool) ─┘
```

> Note: DOCX-008, DOCX-009, DOCX-010/011, and DOCX-012 all depend on DOCX-003 + DOCX-005/006, but are independent of each other.

---

## File Summary

| Task | New file | Modified file |
|------|----------|---------------|
| DOCX-001 | — | `package.json`, `package-lock.json` |
| DOCX-002 | `src/mammoth.d.ts` (if needed) | `package.json` (if `@types/mammoth`) |
| DOCX-003 | `src/utils/path-validation.ts` | — |
| DOCX-004 | — | `src/tools/execute-command.ts` |
| DOCX-005 | — | `src/settings/types.ts` |
| DOCX-006 | — | `src/settings/defaults.ts` |
| DOCX-007 | — | `src/settings/constants.ts` |
| DOCX-008 | `src/tools/read-file.ts` | — |
| DOCX-009 | `src/tools/read-docx.ts` | — |
| DOCX-010/011 | `src/tools/write-docx.ts` | — |
| DOCX-012 | `src/settings/sections/docx-tools.ts` | — |
| DOCX-013 | — | `src/settings/settings-tab.ts` |
| DOCX-014 | — | `src/main.ts` |
