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

Add the four new production dependencies to `package.json` and install them.

**Files modified:** `package.json`, `package-lock.json`

- [x] Add `"mammoth": "^1.8.0"` to `dependencies` in `package.json`
- [x] Add `"docx": "^9.6.1"` to `dependencies` in `package.json`
- [x] Add `"pizzip": "^3.1.7"` to `dependencies` in `package.json`
- [x] Add `"marked": "^17.0.0"` to `dependencies` in `package.json`
- [x] Run `npm install` and confirm all four packages appear in `node_modules`
- [x] Run `npm run build` (or equivalent esbuild command) and confirm the bundle compiles without errors
- [x] If any package causes an ESM-only resolution error, add it to the esbuild `external` list or switch to the CJS-compatible import path, then re-verify the build passes

---

### DOCX-002 — Add type declarations for `mammoth`

Ensure TypeScript can type-check `mammoth` imports.

**Files created/modified:** `src/mammoth.d.ts` (if no `@types/mammoth`) or `package.json` dev dependency (if `@types/mammoth` exists)

- [x] Check npm for `@types/mammoth`: run `npm info @types/mammoth` (or check [npmjs.com](https://www.npmjs.com/package/@types/mammoth))
- [x] **If `@types/mammoth` exists:** add it as a dev dependency (`npm install --save-dev @types/mammoth`) and confirm TypeScript picks it up; skip remaining items
- [x] **If `@types/mammoth` does not exist:** create `src/mammoth.d.ts` with a `declare module "mammoth"` block
- [x] In that declaration, export at minimum:
  ```typescript
  export function convertToHtml(
      input: { buffer: Buffer },
      options?: Record<string, unknown>
  ): Promise<{ value: string; messages: unknown[] }>;
  ```
- [x] Confirm `import mammoth from "mammoth"` (or named import) resolves without TypeScript errors after the declaration is in place

---

## Phase 2 — Shared Path-Validation Utility

*Unblocks all three tool implementations and cleans up `execute-command.ts`.*

### DOCX-003 — Create `src/utils/path-validation.ts`

Extract the path resolution and validation logic from `execute-command.ts` into a reusable shared utility.

**Files created:** `src/utils/path-validation.ts`

- [x] Create the file `src/utils/path-validation.ts` with a file-level JSDoc referencing FR-74
- [x] Add imports: `normalize`, `resolve`, `isAbsolute` from `"path"`
- [x] Implement and export `isPathWithin(target: string, base: string): boolean`:
  - [x] Normalize both `target` and `base` with `normalize()`
  - [x] Return `true` if they are equal after normalization
  - [x] Ensure `base` ends with a path separator before doing a `startsWith` prefix check (to prevent `/foo/bar` matching `/foo/baz`)
  - [x] Return `true` if `normalTarget.startsWith(baseWithSep)`; otherwise `false`
- [x] Implement and export `resolveAndValidatePath(inputPath, vaultRoot, allowedPaths)` returning the discriminated union `{ valid: true; resolvedPath: string } | { valid: false; error: string }`:
  - [x] If `inputPath` is empty/undefined/whitespace-only, set `resolved = vaultRoot`
  - [x] Else if `isAbsolute(inputPath)`, set `resolved = normalize(inputPath)`
  - [x] Else (relative path), set `resolved = resolve(vaultRoot, inputPath)` then `normalize()`
  - [x] Normalize `vaultRoot` and check `isPathWithin(resolved, normalizedVaultRoot)` → return `{ valid: true, resolvedPath: resolved }` if true
  - [x] Loop over `allowedPaths`: skip empty/whitespace entries; normalize each; if `isPathWithin(resolved, normalizedAllowed)` → return `{ valid: true, resolvedPath: resolved }`
  - [x] If no match found, return `{ valid: false, error: "Path '${inputPath}' is outside the allowed paths." }`
- [x] Add JSDoc comments on both exported functions matching the signatures in the spec (FR-74)
- [x] Confirm the file compiles without TypeScript errors

---

### DOCX-004 — Refactor `execute-command.ts` to use the shared utility

Remove the now-duplicated path logic from `execute-command.ts` and delegate to the shared utility.

**Files modified:** `src/tools/execute-command.ts`

- [x] Add import of `resolveAndValidatePath` from `"../utils/path-validation"` at the top of the file
- [x] Delete the local `resolveAndValidateWorkingDir` function (lines ~44–84)
- [x] Delete the local `isPathWithin` function (lines ~90–102)
- [x] In `execute()`, replace the `resolveAndValidateWorkingDir(...)` call with `resolveAndValidatePath(workingDirectory, vaultRoot, this.settings.execute_command_allowed_paths)`
- [x] After the call, if the result is `{ valid: false }`, replace the generic error string with the original working-directory-specific wording before returning: `"Working directory '${workingDirectory}' is outside the allowed paths. Allowed: vault root and configured paths."` — this preserves the existing user-facing message unchanged
- [x] Confirm `npm run build` passes and the external behavior of `execute_command` is unchanged

---

## Phase 3 — Settings Data Layer

*Unblocks tool implementations (Phase 4) and the settings UI (Phase 5).*

### DOCX-005 — Add new settings fields to `src/settings/types.ts`

**Files modified:** `src/settings/types.ts`

- [x] Locate the end of the `NotorSettings` interface (after the `mcp_servers` and `log_level` fields)
- [x] Add a `// Phase 4c: docx & file tools` comment block
- [x] Add field `read_file_allowed_paths: string[]` with a JSDoc comment: "Additional filesystem paths allowed for `read_file`, `read_docx`, and `write_docx`. Vault root is always implicitly allowed."
- [x] Add field `write_docx_default_output_dir: string` with a JSDoc comment: "Default output directory for `write_docx`. Vault-relative or absolute."
- [x] Add field `write_docx_default_template_path: string` with a JSDoc comment: "Default template `.docx` path for `write_docx`. Vault-relative or absolute."
- [x] Confirm the file compiles without TypeScript errors

---

### DOCX-006 — Add defaults to `src/settings/defaults.ts`

**Files modified:** `src/settings/defaults.ts`

- [x] In `DEFAULT_AUTO_APPROVE`, add three new entries after `execute_command: false`:
  - [x] `read_file: false`
  - [x] `read_docx: false`
  - [x] `write_docx: false`
- [x] In `createDefaultSettings()`, add a `// Phase 4c: docx & file tools` comment block and three new fields:
  - [x] `read_file_allowed_paths: []`
  - [x] `write_docx_default_output_dir: ""`
  - [x] `write_docx_default_template_path: ""`
- [x] Confirm the file compiles and the `NotorSettings` type is fully satisfied (no missing fields)

---

### DOCX-007 — Add `TOOL_DISPLAY_NAMES` entries to `src/settings/constants.ts`

**Files modified:** `src/settings/constants.ts`

- [x] Add the `read_file` entry to `TOOL_DISPLAY_NAMES` after `execute_command`:
  ```typescript
  read_file: {
      name: "Read file",
      desc: "Read a text file from the filesystem (desktop only).",
      isWrite: false,
  },
  ```
- [x] Add the `read_docx` entry:
  ```typescript
  read_docx: {
      name: "Read Word doc",
      desc: "Read a .docx file and return its content as Markdown (desktop only).",
      isWrite: false,
  },
  ```
- [x] Add the `write_docx` entry:
  ```typescript
  write_docx: {
      name: "Write Word doc",
      desc: "Convert Markdown to a .docx file on the filesystem (desktop only).",
      isWrite: true,
  },
  ```
- [x] Confirm the file compiles without TypeScript errors

---

## Phase 4 — Tool Implementations

*All three tools depend on Phases 1–3. The three tools are independent of each other and can be implemented in any order (or in parallel).*

### DOCX-008 — Implement `ReadFileTool` (`src/tools/read-file.ts`)

**Files created:** `src/tools/read-file.ts`

**File scaffold & metadata:**
- [x] Add a file-level JSDoc comment referencing FR-70, NFR-19, NFR-21
- [x] Import `Platform` and `App` from `"obsidian"`
- [x] Import `fs` from `"fs"` (use `fs.promises` for all I/O)
- [x] Import `Tool` and `ToolResult` from `"./tool"`
- [x] Import `NotorSettings` from `"../settings"`
- [x] Import `resolveAndValidatePath` from `"../utils/path-validation"`
- [x] Import `logger` from `"../utils/logger"` and create `const log = logger("ReadFileTool")`

**Class declaration:**
- [x] Export class `ReadFileTool implements Tool`
- [x] Set `readonly name = "read_file"`
- [x] Set `readonly mode = "read" as const`
- [x] Write `readonly description` string describing the tool (mirrors the pattern in `execute-command.ts`)
- [x] Define `readonly input_schema` with:
  - [x] `path`: required string, description "Path to the file. Vault-relative or absolute."
  - [x] `encoding`: optional string, description "File encoding. Default: utf-8.", default `"utf-8"`
- [x] Constructor: `(private readonly app: App, private readonly settings: NotorSettings)`

**`execute()` method — guard checks:**
- [x] Extract `path` and `encoding` from `params` (cast to `string | undefined`)
- [x] Return `{ success: false, error: "Missing required parameter: path" }` if `path` is empty/missing
- [x] Check `Platform.isDesktopApp`; return `{ success: false, error: "read_file is only available on desktop." }` if false
- [x] Resolve vault root via `(this.app.vault.adapter as { basePath?: string }).basePath`; return `{ success: false, error: "Could not determine vault root path." }` if null

**`execute()` method — path validation:**
- [x] Call `resolveAndValidatePath(path, vaultRoot, this.settings.read_file_allowed_paths)`
- [x] If `!result.valid`, return `{ success: false, error: result.error }`
- [x] Assign `resolvedPath = result.resolvedPath`

**`execute()` method — file read & binary detection:**
- [x] Wrap all I/O in a `try/catch`; in the catch block return `{ success: false, error: e.message }` (verbatim)
- [x] Check file existence: `await fs.promises.stat(resolvedPath)` — if `ENOENT`, return `{ success: false, error: "File not found: ${resolvedPath}" }`
- [x] Read file as raw Buffer: `const buf = await fs.promises.readFile(resolvedPath)` (no encoding argument)
- [x] Inspect first 8 KB for null bytes: `buf.slice(0, 8192).includes(0)` (or equivalent loop)
- [x] If null bytes found, return `{ success: false, error: "read_file only supports text-based files. For Word documents, use read_docx instead." }`
- [x] Decode buffer: `buf.toString((encoding as BufferEncoding) ?? "utf-8")`
- [x] Return `{ success: true, result: decodedString }`

**Helpers:**
- [x] Extract `getVaultRootPath()` private method returning `string | null`, using `(this.app.vault.adapter as { basePath?: string }).basePath ?? null` (mirrors `execute-command.ts`)

**Verification:**
- [x] All `ToolResult` objects include `tool_name: this.name`
- [x] Confirm the file compiles without TypeScript errors

---

### DOCX-009 — Implement `ReadDocxTool` (`src/tools/read-docx.ts`)

**Files created:** `src/tools/read-docx.ts`

**File scaffold & metadata:**
- [x] Add a file-level JSDoc comment referencing FR-71, NFR-19
- [x] Import `Platform` and `App` from `"obsidian"`
- [x] Import `fs` from `"fs"` and `{ extname }` from `"path"`
- [x] Import `mammoth` from `"mammoth"`
- [x] Import `TurndownService` from `"turndown"` and `{ gfm }` from `"turndown-plugin-gfm"`
- [x] Import `Tool` and `ToolResult` from `"./tool"`
- [x] Import `NotorSettings` from `"../settings"`
- [x] Import `resolveAndValidatePath` from `"../utils/path-validation"`
- [x] Import `logger` and create `const log = logger("ReadDocxTool")`

**Class declaration:**
- [x] Export class `ReadDocxTool implements Tool`
- [x] Set `readonly name = "read_docx"`, `readonly mode = "read" as const`
- [x] Write `readonly description`
- [x] Define `readonly input_schema` with `path`: required string
- [x] Constructor: `(private readonly app: App, private readonly settings: NotorSettings)`

**`execute()` method — guard checks:**
- [x] Extract `path` from `params`; return missing-param error if absent
- [x] Check `Platform.isDesktopApp`; return `"read_docx is only available on desktop."` if false
- [x] Resolve and check vault root; return error if null

**`execute()` method — path validation:**
- [x] Call `resolveAndValidatePath(path, vaultRoot, this.settings.read_file_allowed_paths)`; return error if invalid
- [x] Check `extname(resolvedPath).toLowerCase() !== ".docx"`; return `"read_docx only supports .docx files."` if true

**`execute()` method — file existence & conversion:**
- [x] Wrap all I/O and conversion in a `try/catch`; return `{ success: false, error: e.message }` on any exception
- [x] Check file existence via `fs.promises.stat`; return `"File not found: ${resolvedPath}"` on `ENOENT`
- [x] Read file: `const buf = await fs.promises.readFile(resolvedPath)`
- [x] Convert to HTML: `const { value: html } = await mammoth.convertToHtml({ buffer: buf })`
- [x] Instantiate a local `TurndownService` (do **not** import or call the singleton from `fetch-webpage.ts`):
  - [x] Use the same constructor options as `fetch-webpage.ts`: `headingStyle: "atx"`, `codeBlockStyle: "fenced"`, `bulletListMarker: "-"`, `emDelimiter: "*"`, `strongDelimiter: "**"`, `linkStyle: "inlined"`
  - [x] Call `.use(gfm)` to enable GFM tables/strikethrough
  - [x] Do **not** add the `stripNav`/`stripForms` rules (those are webpage-specific)
  - [x] Add an `img` replacement rule: `filter: ["img"], replacement: () => "[image]"`
- [x] Convert HTML to Markdown: `const markdown = td.turndown(html)`
- [x] Return `{ success: true, result: markdown }`

**Verification:**
- [x] All `ToolResult` objects include `tool_name: this.name`
- [x] Confirm the file compiles without TypeScript errors

---

### DOCX-010 — Implement `WriteDocxTool` — path resolution & validation (`src/tools/write-docx.ts`, part 1)

After this task the tool correctly validates all inputs and returns appropriate errors. The `generateDocx` function called at the end can be a stub (`throw new Error("not implemented")`) until DOCX-011.

**Files created:** `src/tools/write-docx.ts` (partial)

**File scaffold & metadata:**
- [x] Add a file-level JSDoc comment referencing FR-72, FR-73, NFR-19
- [x] Import `Platform` and `App` from `"obsidian"`
- [x] Import `fs` from `"fs"` and `{ join, dirname, extname }` from `"path"`
- [x] Import `Tool` and `ToolResult` from `"./tool"`
- [x] Import `NotorSettings` from `"../settings"`
- [x] Import `resolveAndValidatePath` from `"../utils/path-validation"`
- [x] Import `logger` and create `const log = logger("WriteDocxTool")`

**Class declaration:**
- [x] Export class `WriteDocxTool implements Tool`
- [x] Set `readonly name = "write_docx"`, `readonly mode = "write" as const`
- [x] Write `readonly description`
- [x] Define `readonly input_schema`:
  - [x] `content`: required string — "Markdown content to convert to `.docx`."
  - [x] `output_path`: optional string — "Full output path including `.docx` extension. Vault-relative or absolute."
  - [x] `filename`: optional string — "Output filename without `.docx` extension. Used with the default output directory setting."
  - [x] `template_path`: optional string — "Path to a `.docx` template. Overrides the default template setting."
- [x] Constructor: `(private readonly app: App, private readonly settings: NotorSettings)`

**`execute()` method — guard checks:**
- [x] Extract `content`, `output_path`, `filename`, `template_path` from `params` (all `string | undefined`)
- [x] Return missing-param error if `content` is absent or empty
- [x] Check `Platform.isDesktopApp`; return `"write_docx is only available on desktop."` if false
- [x] Resolve and check vault root; return error if null

**`execute()` method — `filename` validation:**
- [x] If `filename` is provided and contains `/` or `\`, return `{ success: false, error: "filename must not contain path separators." }`

**`execute()` method — output path resolution (three-step):**
- [x] Track whether `filename` was ignored (for warning): set `filenameIgnored = false`
- [x] **Step 1:** If `output_path` is provided:
  - [x] If `filename` is also provided, set `filenameIgnored = true`
  - [x] Use `output_path` as the raw path to resolve
- [x] **Step 2:** Else if `filename` is provided and `this.settings.write_docx_default_output_dir` is non-empty:
  - [x] Resolve the default output dir: `resolveAndValidatePath(defaultOutputDir, vaultRoot, allowedPaths)` — return its error if invalid
  - [x] Combine: `rawOutputPath = join(resolvedDefaultDir, filename + ".docx")`
- [x] **Step 3:** Else return `{ success: false, error: "No output path provided. Pass output_path, or provide a filename and configure write_docx_default_output_dir in Settings." }`

**`execute()` method — output path boundary & parent-dir validation:**
- [x] Call `resolveAndValidatePath(rawOutputPath, vaultRoot, this.settings.read_file_allowed_paths)`; return error if invalid
- [x] Assign `resolvedOutputPath = result.resolvedPath`
- [x] Check parent directory: `await fs.promises.stat(dirname(resolvedOutputPath))` — if `ENOENT` return `{ success: false, error: "Output directory '${dirname(resolvedOutputPath)}' does not exist." }`

**`execute()` method — template path resolution:**
- [x] Determine `rawTemplatePath`: `template_path` param → `this.settings.write_docx_default_template_path` (if non-empty) → `null` (no template)
- [x] If `rawTemplatePath` is non-null:
  - [x] Validate with `resolveAndValidatePath`; return error if outside allowed paths
  - [x] Assign `resolvedTemplatePath`
  - [x] Check existence: `await fs.promises.stat(resolvedTemplatePath)` — return `"Template file not found: ${resolvedTemplatePath}"` on `ENOENT`
  - [x] Check extension: `extname(resolvedTemplatePath).toLowerCase() !== ".docx"` → return `"Template must be a .docx file."`
- [x] Set `resolvedTemplatePath = null` if no template was configured

**`execute()` method — generation & write:**
- [x] Call `const buffer = await generateDocx(content, resolvedTemplatePath)` (stub or fully implemented after DOCX-011)
- [x] `await fs.promises.writeFile(resolvedOutputPath, buffer)`
- [x] Build success message: `"Successfully wrote .docx file to ${resolvedOutputPath}"`
- [x] If `filenameIgnored`, prepend: `"Warning: filename was ignored because output_path was provided.\n\n"` before the success message
- [x] Return `{ success: true, result: successMessage }`
- [x] Wrap the generation+write step in `try/catch`; return `{ success: false, error: e.message }` on failure

**Helpers:**
- [x] Add `private getVaultRootPath(): string | null` (same pattern as other tools)

**Verification:**
- [x] All `ToolResult` objects include `tool_name: this.name`
- [x] All validations occur before any call to `generateDocx` (per FR-72)
- [x] Confirm the file compiles without TypeScript errors

---

### DOCX-011 — Implement `WriteDocxTool` — Markdown-to-docx pipeline (`src/tools/write-docx.ts`, part 2)

Fills in the `generateDocx(content, templatePath)` function stubbed in DOCX-010.

**Files modified:** `src/tools/write-docx.ts`

**Additional imports:**
- [x] Import `{ Lexer, marked }` (or `marked.lexer`) from `"marked"`
- [x] Import `{ Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, ExternalHyperlink, AlignmentType, WidthType, BorderStyle, AbstractNumbering, Numbering, LevelFormat }` (and any other needed) from `"docx"`
- [x] Import `PizZip` from `"pizzip"`

**Inline token renderer — `renderInline(tokens)`:**
- [x] Create a helper `renderInline(tokens: marked.Token[]): (TextRun | ExternalHyperlink)[]` that iterates inline tokens and returns `docx` inline objects:
  - [x] `text` token → `new TextRun({ text: token.text })`
  - [x] `strong` token → `new TextRun({ text: token.text, bold: true })`
  - [x] `em` token → `new TextRun({ text: token.text, italics: true })`
  - [x] `codespan` token → `new TextRun({ text: token.text, style: "Verbatim Char" })` — if style may not exist in the template, also set `font: { name: "Courier New" }` as fallback
  - [x] `link` token → `new ExternalHyperlink({ link: token.href, children: [new TextRun({ text: token.text })] })`
  - [x] Any other token type → `new TextRun({ text: token.raw ?? "" })` as a safe fallback

**Block token renderer — `buildDocxChildren(tokens)`:**
- [x] Create `buildDocxChildren(tokens: marked.Token[]): (Paragraph | Table)[]` that maps each top-level token:
  - [x] `heading` → `new Paragraph({ heading: HeadingLevel["HEADING_" + token.depth], children: renderInline(token.tokens ?? []) })`
  - [x] `paragraph` → `new Paragraph({ children: renderInline(token.tokens ?? []) })`
  - [x] `code` (fenced) → `new Paragraph({ style: "Source Code", children: [new TextRun({ text: token.text, font: { name: "Courier New" } })] })` — style `"Source Code"` renders with the template style if present, falls back to `Normal` + font if absent
  - [x] `hr` → `new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: "auto" } } })`
  - [x] `blockquote` → `new Paragraph({ indent: { left: 720 }, children: renderInline(token.tokens ?? []) })`
  - [x] `list` (unordered) → one `new Paragraph({ bullet: { level: 0 } , children: renderInline(item.tokens ?? []) })` per list item (recurse for nested items, incrementing level)
  - [x] `list` (ordered) → one `new Paragraph({ numbering: { reference: "default-numbering", level: 0 }, children: renderInline(item.tokens ?? []) })` per item; define one `AbstractNumbering` on the `Document` with `reference: "default-numbering"`
  - [x] `table` → build a `new Table(...)`:
    - [x] Header row: `new TableRow({ children: token.header.map(cell => new TableCell({ children: [new Paragraph({ children: renderInline(cell.tokens ?? []) })] })) })`
    - [x] Body rows: same pattern for each `token.rows` entry
    - [x] Set `width: { size: 100, type: WidthType.PERCENTAGE }` on the table
  - [x] `space` → skip (no output)
  - [x] Unknown token types → `new Paragraph({ children: [new TextRun({ text: token.raw ?? "" })] })` as a safe fallback

**`generateDocx(content, templatePath)` function:**
- [x] Call `const tokens = marked.lexer(content)` to produce the token tree
- [x] Call `const children = buildDocxChildren(tokens)` to get the array of `docx` block objects
- [x] Define a `numbering` object with one `AbstractNumbering` for ordered lists (only if any ordered list was encountered, or always define it defensively)
- [x] Construct `new Document({ numbering: { config: [...] }, sections: [{ children }] })`
- [x] Produce the temp buffer: `const tempBuffer = await Packer.toBuffer(doc)`

**No-template path:**
- [x] If `templatePath` is `null`, return `tempBuffer` directly from `generateDocx`

**With-template path (pizzip graft):**
- [x] Unzip the generated buffer: `const generatedZip = new PizZip(tempBuffer)`
- [x] Read generated `word/document.xml`: `const generatedXml: string = generatedZip.files["word/document.xml"].asText()`
- [x] Extract generated body content between `<w:body>` and `</w:body>` using: `/<w:body>([\s\S]*?)<\/w:body>/`; if no match return error `"Generated document.xml is malformed — could not locate <w:body>."`
- [x] Assign the captured group as `generatedBodyContent`
- [x] Strip any `<w:sectPr>` from `generatedBodyContent`: remove the block matching `/<w:sectPr[\s\S]*?<\/w:sectPr>/g`
- [x] Read template file: `const templateBuf = await fs.promises.readFile(templatePath)`
- [x] Unzip template: `const templateZip = new PizZip(templateBuf)`
- [x] Read template `word/document.xml`: `const templateXml: string = templateZip.files["word/document.xml"].asText()`
- [x] Extract template `<w:sectPr>` block: match `/<w:sectPr[\s\S]*?<\/w:sectPr>/` against `templateXml`; if not found, `sectPr = ""`
- [x] Replace the template's `<w:body>…</w:body>` with the new body:
  - [x] Build replacement: `` `<w:body>${generatedBodyContent}${sectPr}</w:body>` ``
  - [x] Apply: `templateXml.replace(/<w:body>[\s\S]*?<\/w:body>/, replacement)`
  - [x] If the regex does not match `<w:body>` in the template XML, return error `"Template document.xml is malformed — could not locate <w:body>."`
- [x] Update the template ZIP: `templateZip.file("word/document.xml", newTemplateXml)`
- [x] Generate final buffer: `templateZip.generate({ type: "nodebuffer" })`
- [x] Return the final buffer from `generateDocx`

**Verification:**
- [ ] No-template path: open output in LibreOffice/Word and confirm headings, paragraphs, bold, italic, lists, tables, code blocks, and horizontal rules all render correctly
- [ ] Template path: confirm output inherits template fonts, margins, headers, footers, and that `<w:sectPr>` is preserved
- [x] Confirm the file compiles without TypeScript errors

---

## Phase 5 — Settings UI

*Depends on Phase 3 (settings types). Can be done in parallel with Phase 4.*

### DOCX-012 — Create `src/settings/sections/docx-tools.ts`

**Files created:** `src/settings/sections/docx-tools.ts`

**File scaffold:**
- [x] Add a file-level JSDoc comment referencing FR-76
- [x] Import `Notice`, `Setting` from `"obsidian"`
- [x] Import `fs` from `"fs"` and `{ extname }` from `"path"` (for template path validation on blur)
- [x] Import `SettingsContext` from `"./context"`
- [x] Export function `renderDocxToolsSection(containerEl: HTMLElement, ctx: SettingsContext): void`

**Section heading & description:**
- [x] Render `new Setting(containerEl).setHeading().setName("Word & file tools")`
- [x] Render a `<p class="setting-item-description">` noting tools are desktop-only and `write_docx` requires Act mode

**Allowed paths sub-section:**
- [x] Render `new Setting(containerEl).setHeading().setName("Allowed read/write paths")`
- [x] Render a `<p class="setting-item-description">` explaining the paths are shared by `read_file`, `read_docx`, and `write_docx`, and that vault root is always implicitly allowed
- [x] Iterate `ctx.settings.read_file_allowed_paths`: for each entry render a `Setting` row with the path as the name and a "Remove" button that:
  - [x] Calls `ctx.settings.read_file_allowed_paths.splice(i, 1)`
  - [x] Calls `await ctx.saveSettings()`
  - [x] Calls `ctx.redisplay()`
- [x] Render an "Add allowed path" row with a text input and "Add" button:
  - [x] Text input: `setPlaceholder("/path/to/directory")`, captures value into a local `let newPath = ""`
  - [x] Button onClick: if `newPath` is empty show `new Notice("Enter a path to add.")`; otherwise push to `read_file_allowed_paths`, save, and `ctx.redisplay()`

**Default output directory setting:**
- [x] Render a `Setting` with name "Default output directory" and description "Default output directory for `write_docx`. Leave empty to require `output_path` per call."
- [x] Add a text input:
  - [x] `setPlaceholder("(none — output_path required per call)")`
  - [x] `setValue(ctx.settings.write_docx_default_output_dir)`
  - [x] `onChange`: update `ctx.settings.write_docx_default_output_dir = value.trim()` and `await ctx.saveSettings()`

**Default template path setting:**
- [x] Render a `Setting` with name "Default template path" and description "Default `.docx` template applied by `write_docx`. Leave empty to use no template."
- [x] Add a text input:
  - [x] `setPlaceholder("(none — no template applied by default)")`
  - [x] `setValue(ctx.settings.write_docx_default_template_path)`
  - [x] `onChange`: update setting value and `await ctx.saveSettings()`; clear any existing inline error element
  - [x] `onBlur` (attach via `inputEl.addEventListener("blur", ...)`): if field is non-empty, check:
    - [x] File exists: `await fs.promises.stat(resolvedPath)` — catch `ENOENT`
    - [x] Extension is `.docx`: `extname(value).toLowerCase() !== ".docx"`
    - [x] If either check fails, create (or update) an inline `<p>` error element beneath the input with the failure reason
    - [x] If both checks pass (or field is empty), remove the inline error element if present
- [x] Confirm all saves go through `ctx.saveSettings()`

---

### DOCX-013 — Wire the new section into the settings tab

**Files modified:** `src/settings/settings-tab.ts`

- [x] Add import: `import { renderDocxToolsSection } from "./sections/docx-tools"` alongside the other section imports at the top
- [x] In the `display()` method, locate the `renderExecuteCommandSection(toolConfigGroup, ctx)` call (currently line ~130)
- [x] Add `renderDocxToolsSection(toolConfigGroup, ctx)` on the next line, immediately after `renderExecuteCommandSection`
- [ ] Confirm the settings tab renders in Obsidian without errors (open Settings → Notor and verify "Word & file tools" section appears after "Shell commands")

---

## Phase 6 — Tool Registration

*Depends on Phase 4 (tool classes must exist before they can be imported).*

### DOCX-014 — Register the three new tools in `src/main.ts`

**Files modified:** `src/main.ts`

- [ ] Add three import statements in the `// Tools` import block alongside existing tool imports (after `ExecuteCommandTool`):
  ```typescript
  import { ReadFileTool } from "./tools/read-file";
  import { ReadDocxTool } from "./tools/read-docx";
  import { WriteDocxTool } from "./tools/write-docx";
  ```
- [ ] In `getToolRegistry()`, locate the `this._toolRegistry.register(new ExecuteCommandTool(this.app, this.settings))` call (around line 924)
- [ ] Add three `register` calls immediately after it:
  ```typescript
  this._toolRegistry.register(new ReadFileTool(this.app, this.settings));
  this._toolRegistry.register(new ReadDocxTool(this.app, this.settings));
  this._toolRegistry.register(new WriteDocxTool(this.app, this.settings));
  ```
- [ ] Run `npm run build` and confirm the full plugin bundles without errors
- [ ] Open Obsidian with the plugin loaded and verify:
  - [ ] All three tools appear in Settings → Notor → Auto-approve
  - [ ] `read_file` and `read_docx` display as read tools (no "Write" badge)
  - [ ] `write_docx` displays as a write tool
  - [ ] Auto-approve defaults for all three are `false`

---

## Dependency Map

```
DOCX-001 (npm deps)
DOCX-002 (mammoth types)
    └─ DOCX-003 (path-validation util)
         └─ DOCX-004 (refactor execute-command)
         └─ DOCX-005 (settings types)
              └─ DOCX-006 (settings defaults)
              └─ DOCX-007 (TOOL_DISPLAY_NAMES)
              └─ DOCX-012 (settings UI section)
                   └─ DOCX-013 (wire settings tab)
         └─ DOCX-008 (ReadFileTool)              ─┐
         └─ DOCX-009 (ReadDocxTool)               ├─ DOCX-014 (register in main.ts)
         └─ DOCX-010 → DOCX-011 (WriteDocxTool)  ─┘
```

> DOCX-008, DOCX-009, DOCX-010/011, and DOCX-012 all depend on DOCX-003 + DOCX-005/006 but are independent of each other.

---

## File Summary

| Task | New file | Modified file |
|------|----------|---------------|
| DOCX-001 | — | `package.json`, `package-lock.json` |
| DOCX-002 | `src/mammoth.d.ts` (if needed) | `package.json` (if `@types/mammoth` available) |
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
