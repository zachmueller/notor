# Feasibility Assessment: Complex Tools

Tools requiring significant `utils` expansions to keep scaffold size manageable. Both are viable with the recommended expansions.

**Tools covered:** `write_docx`, `extract_docx_comments`

---

## `write_docx` — Feasibility: High complexity, viable with `utils` expansion ✅

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
9. **Markdown→DOCX rendering** (`renderInline()` + `buildDocxChildren()`, ~230 lines) — Block tokens → `docx.Paragraph`/`Table`; inline tokens → `TextRun`/`ExternalHyperlink`; standalone image paragraphs → `ImageRun` with scaling

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` from `"obsidian"` | `obsidian.Platform` | ⚠️ Planned |
| `getFrontMatterInfo` from `"obsidian"` | `obsidian.getFrontMatterInfo` | ✅ |
| `import * as fs from "fs"` | `libs.fs` | ⚠️ Planned (D-3) |
| `import { join, dirname, extname } from "path"` | `libs.path` | ⚠️ Planned (D-3) |
| `import { marked } from "marked"` | `libs.marked` | ✅ |
| `import { Document, Packer, ... } from "docx"` | `libs.docx` | ✅ |
| `import PizZip from "pizzip"` | `libs.PizZip` | ✅ |
| `import { DOMParser, XMLSerializer } from "@xmldom/xmldom"` | `libs.xmldom` | ✅ |
| `resolveAndValidatePath` | `utils.resolveAndValidatePath(path)` | ✅ |
| `resolveNote` | `utils.resolveNote(path)` | ✅ |
| `resolveImageForDocx(href, vaultRoot, allowedPaths)` | **Not exposed** | ❌ See analysis below |

**Settings:** Per-extension `settings` for `write_docx_default_output_dir` and `write_docx_default_template_path`. Shared `shared` for `read_file_allowed_paths` (consumed implicitly by `utils.resolveAndValidatePath()`).

**The core question: inline vs. `utils` expansion**

A fully-inlined scaffold would be ~900-1,050 lines. The spec flags this as "Complex+" and calls for evaluating `utils` expansion.

**Analysis of inlining candidates:**

| Component | Lines | Inline? | Rationale |
|---|---|---|---|
| `renderInline()` | ~47 | Yes | Core customization point — users may want to adjust inline rendering |
| `buildDocxChildren()` | ~183 | Yes | Core customization point — the heart of "customizing write_docx" |
| `collectImageHrefs()` | ~35 | Yes | Small, tightly coupled to `buildDocxChildren` |
| `scaleImageDimensions()` | ~17 | Yes | Trivial helper |
| `generateDocx()` | ~65 | Yes | Orchestrator |
| `graftIntoTemplate()` | ~255 | **No → `utils`** | Complex XML manipulation. Not a customization target. |
| `resolveImageForDocx()` + helpers | ~285 | **No → `utils`** | Infrastructure, not customizable. Only consumed by `write-docx.ts`. |

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

graftDocxIntoTemplate: graftIntoTemplate,  // direct passthrough
```

**With these expansions, scaffold size drops to ~450-550 lines** — still the largest scaffold but manageable. The scaffold retains all customizable logic while delegating infrastructure to `utils`.

**Helper functions (5 local functions to inline in scaffold):**

1. **`renderInline(tokens)`** (~47 lines) — Inline tokens to `libs.docx.TextRun`/`ExternalHyperlink`
2. **`collectImageHrefs(tokens)`** (~35 lines) — Recursive walk collecting image hrefs
3. **`scaleImageDimensions(w, h)`** (~17 lines) — Scale to fit ~600×800px
4. **`buildDocxChildren(tokens, resolvedImages)`** (~183 lines) — Block token → docx element conversion
5. **`generateDocx(content, templatePath)`** (~50 lines, simplified) — Orchestrates the pipeline

**Tricky patterns:**

1. **Destructured `docx` imports** — 12 named exports become `libs.docx.*`. Use destructuring shortcut at top:
   ```ts
   const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
           Table, TableRow, TableCell, ExternalHyperlink,
           AlignmentType, WidthType, BorderStyle } = libs.docx;
   ```

2. **`marked` types** — After Sucrase strips types, these become plain property accesses. No runtime impact.

3. **`PizZip` instances for template grafting:**
   ```ts
   const generatedZip = new libs.PizZip(tempBuffer);
   const templateBuf = await libs.fs.promises.readFile(resolvedTemplatePath);
   const templateZip = new libs.PizZip(templateBuf);
   await utils.graftDocxIntoTemplate(generatedZip, templateZip);
   return templateZip.generate({ type: "nodebuffer" });
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
    description: "Default output directory when only filename is provided."
    default: ""
  write_docx_default_template_path:
    name: "Default Template Path"
    type: string
    description: "Default .docx template path."
    default: ""
```

**Source file refactoring required:** Before the class file can be deleted:
1. Extract `graftIntoTemplate()` (lines 448-702) to a standalone utility file
2. `resolveImageForDocx()` already in `src/tools/docx-image-utils.ts` — import from there

**Required runtime expansions (planned + 2 new):**
- `obsidian.Platform`, `libs.fs`, `libs.path` — already planned
- **NEW:** `utils.resolveImageForDocx` — wraps `resolveImageForDocx()`, injecting `vaultRootPath`
- **NEW:** `utils.graftDocxIntoTemplate` — direct passthrough

**Risk: Scaffold size (medium).** At ~500 lines, still the largest scaffold. Logic is straightforward token-walking and docx library calls.

**Risk: `libs.docx` API surface (low).** 12 stable public API exports.

**Risk: `marked` token shape changes (low).** Pinned to bundled version.

**Risk: Template grafting correctness after extraction (low).** Pure function, existing E2E tests validate.

---

## `extract_docx_comments` — Feasibility: High complexity, viable with `utils` expansion ✅

**Source:** `src/tools/extract-docx-comments.ts` (370 lines total, ~300 lines of logic) + `src/tools/docx-comment-parser.ts` (467 lines total, ~400 lines of pure parsing logic)

**What the built-in class does:**
1. Validates params, desktop-only guard, path validation, `.docx` extension check
2. Reads file buffer, opens ZIP via `PizZip`
3. Extracts 4 XML blobs: `word/comments.xml`, `word/commentsExtended.xml`, `word/document.xml`, `word/people.xml`
4. Parses comments XML → raw comment objects
5. Parses commentsExtended XML → resolved IDs + threading map
6. Extracts quoted text per comment from document XML (DOM walk for `commentRangeStart`/`commentRangeEnd` markers)
7. Parses people XML → author → userId map for @mention resolution
8. Builds threaded comments (separates top-level from replies, filters resolved, resolves @mentions, computes deterministic unique IDs via MD5)
9. Checks for existing output note (idempotent append)
10. Filters new comments, formats as Markdown, writes to vault

**Dependencies:**

| Dependency | Extension equivalent | Available today? |
|---|---|---|
| `this.app` | `app` (injected) | ✅ |
| `Platform` | `obsidian.Platform` | ⚠️ Planned |
| `TFile`, `TFolder` | `obsidian.TFile`, `obsidian.TFolder` | ✅ |
| `libs.fs` | `libs.fs` | ⚠️ Planned (D-3) |
| `libs.path` | `libs.path` | ⚠️ Planned (D-3) |
| `PizZip` | `libs.PizZip` | ✅ |
| `DOMParser` | `libs.xmldom.DOMParser` | ✅ |
| `createHash` | `libs.crypto.createHash` | ⚠️ Planned (D-3) |
| `resolveAndValidatePath` | `utils.resolveAndValidatePath(path)` | ✅ |
| Parser functions (9 exported) | ⚠️ See analysis below | ⚠️ |

**Settings:** None per-extension.

**The central question: inline ~400 lines of parsing logic or expose via `utils`?**

**Option A — Inline everything (~500-550 lines scaffold):** Technically viable but produces an unmanageable scaffold.

**Option B — Expose parser functions via `utils` (~200 lines scaffold): ✅ Recommended**

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

Note: `resolveAtMentions` and `computeUniqueId` are called internally by `buildCommentThreads` — no direct exposure needed.

**Why this is the right approach:** The parser module is a well-separated, pure-function layer with comprehensive unit tests (558 lines, 34 test cases). Exposing via `utils.docxComments` preserves this boundary. Users who customize the tool can swap the I/O orchestration without reimplementing XML parsing. Zero external consumers beyond this tool (verified via grep).

**Implementation cost:** ~10 lines to wire in `runtime-context.ts`. Module already exports everything needed. Existing unit tests continue to cover parser logic independently.

**Helper functions (1 to inline):**

1. **`ensureDirectoryExists()`** (~15 lines) — Same pattern as `write_note` and `move_note`. Inlined.

**Scaffold code (estimated ~200 lines with `utils.docxComments`):**
The full scaffold handles I/O orchestration (ZIP extraction, vault reads/writes, directory creation) and delegates all XML parsing, threading, formatting, and dedup to `utils.docxComments.*`.

**YAML fence (unchanged from current scaffold):**
```yaml
params:
  docx_path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute."
    path_namespace: filesystem
  output_path:
    type: string
    description: "Vault-relative path for the output note."
    path_namespace: vault
  include_resolved:
    type: boolean
    description: "Include resolved/done comments. Defaults to false."
    default: false
```

**Required runtime expansions (planned + 1 new):**
- `obsidian.Platform`, `libs.fs`, `libs.path`, `libs.crypto` — already planned
- **NEW:** `utils.docxComments` — namespace exposing 7 functions (~10 lines to wire)

**Risk: `utils.docxComments` API surface growth (low).** Pure functions with stable interfaces. Module has been stable since implementation.

**Risk: `RawComment.quotedText` mutation pattern (low).** Same in-place mutation as built-in class. `RawComment` initializes `quotedText: ""` as mutable.

**Risk: `Set`/`Map` type stripping (low).** Runtime constructors work identically after Sucrase strips types.

**Comparison with spec's complexity estimate:** With `utils.docxComments`, the scaffold is ~200 lines (low end of the 200-400 estimate). Without, it would be ~550 lines — significantly exceeding the estimate. The `utils` expansion is clearly the right call.
