# Design: `replace_in_docx` Built-in Tool

**Status:** Draft  
**Author:** Design spike  
**Date:** 2026-04-02

---

## 1. Motivation

The existing `replace_in_note` tool ([`src/tools/replace-in-note.ts`](../src/tools/replace-in-note.ts)) provides atomic SEARCH/REPLACE editing for Obsidian vault notes. Users working with `.docx` files currently have `read_docx` and `write_docx`, but no way to make **targeted edits** to an existing `.docx` without a destructive roundtrip that loses formatting. A `replace_in_docx` tool would:

- Enable surgical text replacements while preserving all formatting, styles, images, comments, headers/footers
- Match the robustness contract of `replace_in_note`: exact-match search, first-occurrence replacement, all-or-nothing atomicity
- Require zero new dependencies (PizZip and @xmldom/xmldom are already in the project)
- Fit naturally into the existing docx tool family alongside `read_docx`, `write_docx`, and `extract_docx_comments`

---

## 2. Feasibility

### 2.1 Approaches Evaluated

#### Approach A: Roundtrip via Markdown — **Ruled out**

Use the existing `read_docx` pipeline (mammoth -> turndown -> markdown), perform string replacement on the markdown, then use the `write_docx` pipeline (marked -> docx lib) to regenerate the file.

**Why this fails:**
- The mammoth -> turndown pipeline in [`src/tools/read-docx.ts:142-159`](../src/tools/read-docx.ts) converts to HTML then markdown, discarding: custom styles, tracked changes, comments, footnotes, images (replaced with `[image]` at line 156), headers/footers, page breaks, section properties, bookmarks, fields (TOC, page numbers), embedded objects.
- The `write_docx` pipeline in [`src/tools/write-docx.ts:107-244`](../src/tools/write-docx.ts) builds a fresh OOXML document from markdown tokens. Even with template grafting (lines 284-337), only `<w:sectPr>` page layout is preserved — all body content is regenerated.
- This is a "rewrite" tool, not a "replace" tool. It destroys the document identity.

#### Approach B: Dedicated JS library — **Ruled out**

Surveyed JS/TS ecosystem for in-place `.docx` editing:
- **docxtemplater** (free core): Only supports `{tag}` placeholder substitution, not arbitrary find-and-replace. The HTML module is paid/commercial.
- **officegen**: Generates new docx files from scratch. No read/modify capability.
- **docx** (already a dependency, `^9.6.1`): Generation-only, cannot read or modify existing documents.
- **docx4js**: Not maintained (last publish 2019).

No suitable free library exists for this use case.

#### Approach C: Direct XML manipulation via PizZip + xmldom — **Recommended**

Unzip the `.docx` with PizZip, parse `word/document.xml` with xmldom's DOMParser, locate and replace text within `<w:t>` elements across `<w:r>` runs, serialize back to XML, update the zip, write to disk.

**Why this works:**
- **Perfect formatting preservation.** Every `<w:r>` retains its `<w:rPr>` (run properties). Every other XML file in the zip (styles.xml, comments.xml, header*.xml, footer*.xml, media/, relationships) is untouched.
- **Zero new dependencies.** PizZip (`^3.2.0`) and @xmldom/xmldom (`^0.8.11`) are already in `package.json` (lines 40-56).
- **Proven patterns in the codebase.** The `extract_docx_comments` tool already uses exactly this approach: PizZip to unzip ([`src/tools/extract-docx-comments.ts:179`](../src/tools/extract-docx-comments.ts)), xmldom to parse document.xml, and DOM walking to extract `<w:t>` text content. The `collectText()` function in [`src/tools/docx-comment-parser.ts:64-72`](../src/tools/docx-comment-parser.ts) demonstrates the text extraction pattern.

### 2.2 The Core Engineering Challenge: Run Splitting

In OOXML, text is stored in `<w:r>` (run) elements within `<w:p>` (paragraph) elements. Each run has optional `<w:rPr>` formatting properties and one or more `<w:t>` text elements.

**The problem:** A single visible word can be split across multiple `<w:r>` elements due to:
- Formatting changes mid-word (e.g., partial bold)
- Spell-check / grammar annotations (`<w:proofErr>` elements)
- Revision tracking (`<w:ins>`, `<w:del>` elements)
- Language or style change boundaries
- Arbitrary serialization decisions by Microsoft Word

Example — "Hello World" split across three runs:
```xml
<w:p>
  <w:r><w:t>Hel</w:t></w:r>
  <w:r><w:rPr><w:b/></w:rPr><w:t>lo</w:t></w:r>
  <w:r><w:t xml:space="preserve"> World</w:t></w:r>
</w:p>
```

The algorithm must concatenate text across runs within a paragraph, find the match in the concatenated string, then surgically edit only the affected run elements. This is the central complexity.

---

## 3. Design

### 3.1 Tool Interface

Follows the same interface as all existing tools ([`src/tools/tool.ts:53-72`](../src/tools/tool.ts)):

```typescript
class ReplaceInDocxTool implements Tool {
  readonly name = "replace_in_docx";
  readonly mode = "write" as const;
  // constructor(app: App, settings: NotorSettings)
}
```

**Input schema** — mirrors `replace_in_note` ([`src/tools/replace-in-note.ts:50-84`](../src/tools/replace-in-note.ts)):

```typescript
{
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the .docx file. Vault-relative or absolute."
    },
    changes: {
      type: "array",
      description: "Array of search/replace blocks applied in sequence. Each replaces only the first occurrence. Search must be within a single paragraph.",
      items: {
        type: "object",
        properties: {
          search: { type: "string", description: "Exact text to find (character-for-character match)" },
          replace: { type: "string", description: "Replacement text. Empty string deletes the match." }
        },
        required: ["search", "replace"]
      },
      minItems: 1
    }
  },
  required: ["path", "changes"]
}
```

### 3.2 Execution Flow

Modeled after `replace_in_note` ([`src/tools/replace-in-note.ts:93-260`](../src/tools/replace-in-note.ts)) and `extract_docx_comments` ([`src/tools/extract-docx-comments.ts:79-334`](../src/tools/extract-docx-comments.ts)):

```
execute(params):
  1. Validate params: path (non-empty string), changes (non-empty array, each block has non-empty search + string replace)
     — mirrors replace_in_note.ts:94-134
  2. Platform guard: Platform.isDesktopApp check
     — mirrors read-docx.ts:77-84
  3. Resolve vault root: this.app.vault.adapter.basePath
     — mirrors read-docx.ts:86-94
  4. Path validation: resolveAndValidatePath(path, vaultRoot, settings.read_file_allowed_paths)
     — reuses src/utils/path-validation.ts (same as read-docx.ts:96-109)
  5. Extension check: must be .docx
     — mirrors read-docx.ts:113-120
  6. File existence check: fs.promises.stat()
     — mirrors read-docx.ts:124-137
  7. Read file buffer: fs.promises.readFile(resolvedPath)
  8. Unzip: new PizZip(buffer)
     — mirrors extract-docx-comments.ts:179
  9. Extract document XML: zip.files["word/document.xml"]?.asText()
     — mirrors extract-docx-comments.ts:184-185
  10. Apply replacements: replaceInDocumentXml(xml, changes)
      — pure function from docx-text-replacer.ts (see Section 3.3)
  11. If any block failed: return error with block index + search preview
      — mirrors replace-in-note.ts:214-226 error format
  12. Update zip: zip.file("word/document.xml", modifiedXml)
  13. Generate buffer: zip.generate({ type: "nodebuffer" })
  14. Write to disk: fs.promises.writeFile(resolvedPath, buffer)
  15. Return success with replacement count
```

### 3.3 Core Algorithm: `docx-text-replacer.ts`

A **pure logic module** with no Obsidian/fs dependencies, following the pattern established by [`src/tools/docx-comment-parser.ts`](../src/tools/docx-comment-parser.ts) (pure functions, xmldom-only, comprehensive unit tests).

#### OOXML Namespace Constants

Reuse the same constants from `docx-comment-parser.ts:19-21`:
```typescript
const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
```

#### Data Structures

```typescript
interface RunMapping {
  run: Element;        // the <w:r> element
  tElement: Element;   // the <w:t> element within the run
  text: string;        // text content of <w:t>
  startOffset: number; // character offset in concatenated paragraph text
  endOffset: number;   // exclusive end offset
}

interface MatchResult {
  startRunIndex: number;     // index in RunMapping[] where match begins
  startCharOffset: number;   // char offset within start run
  endRunIndex: number;       // index in RunMapping[] where match ends
  endCharOffset: number;     // char offset within end run (exclusive)
}

interface ChangeBlock {
  search: string;
  replace: string;
}
```

#### Key Functions

**`buildRunMap(paragraph: Element): RunMapping[]`**

Iterates `<w:r>` children of a `<w:p>` element. For each run, finds the first `<w:t>` child element and records its text content and character offsets. Runs without `<w:t>` (e.g., image runs with `<w:drawing>`, field code runs with `<w:fldChar>`) are skipped.

Reference pattern: [`docx-comment-parser.ts:64-72`](../src/tools/docx-comment-parser.ts) — the `collectText()` function iterates `<w:t>` elements via `getElementsByTagNameNS(W_NS, "t")`. The run map adds offset tracking on top of this.

**`findMatchInParagraph(runMap: RunMapping[], searchText: string): MatchResult | null`**

1. Concatenates all `runMap[i].text` to produce the paragraph's plain text
2. Uses `indexOf(searchText)` on the concatenated text — same approach as [`replace-in-note.ts:194`](../src/tools/replace-in-note.ts)
3. Maps the match's start/end character offsets back to run indices using the offset ranges in the run map

**`applyReplacementToRuns(runMap: RunMapping[], match: MatchResult, replacementText: string): void`**

Handles two cases:

**Case 1 — Single-run match** (match starts and ends in the same run):
```
originalText = run.tElement.textContent
newText = originalText[0..startChar] + replacementText + originalText[endChar..]
run.tElement.textContent = newText
```

**Case 2 — Multi-run match** (spans runs A through N):
- **Run A** (first matched run): Truncate to prefix, append replacement text
  ```
  runA.tElement.textContent = originalText[0..startCharOffset] + replacementText
  ```
- **Runs B..N-1** (fully consumed middle runs): Set `tElement.textContent = ""`
- **Run N** (last matched run): Truncate to keep only the suffix
  ```
  runN.tElement.textContent = originalText[endCharOffset..]
  ```

**Formatting rule:** Replacement text inherits the formatting (`<w:rPr>`) of Run A. This is the most intuitive behavior — replacing "Hello" with "Goodbye" in a bold run keeps the replacement bold.

**`xml:space="preserve"` handling:** When the modified `<w:t>` has leading or trailing whitespace, ensure the attribute `xml:space="preserve"` is set on the `<w:t>` element. Without this, Word strips the whitespace on open.

**`replaceInDocumentXml(xmlString: string, changes: ChangeBlock[]): { xml: string; appliedCount: number; error?: { index: number; search: string } }`**

Orchestrator function:
1. Parse `xmlString` via `new DOMParser().parseFromString(xmlString, "text/xml")`
2. Get all `<w:p>` elements: `doc.getElementsByTagNameNS(W_NS, "p")`
3. For each change block (in sequence):
   a. Iterate paragraphs, build run map, search for match
   b. On first match: apply replacement, break paragraph loop, continue to next block
   c. If no paragraph matched: return early with `error: { index, search }` — **no XML serialized** (atomicity)
4. On full success: serialize via `new XMLSerializer().serializeToString(doc)`
5. Return `{ xml: serializedXml, appliedCount: changes.length }`

**Atomicity guarantee:** Since we only serialize the DOM to a string after all blocks succeed, a failure at any point means the original `xmlString` is effectively unmodified. The tool class (Step 10 in Section 3.2) checks for the `error` field and returns without writing to disk.

### 3.4 Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Replacement scope | **Intra-paragraph only** | Cross-paragraph replacement requires structural OOXML surgery (merging/splitting `<w:p>` elements with their own `<w:pPr>` properties). The LLM can issue multiple single-paragraph calls. |
| Search text with newlines | **Reject with error** | Newlines imply cross-paragraph intent, which is out of scope. Clear error avoids ambiguity. |
| Replacement formatting | **Inherits first matched run's `<w:rPr>`** | Most intuitive — "Hello" -> "Goodbye" keeps the same bold/italic/font. |
| Cleared middle runs | **Set `<w:t>` to empty, keep `<w:r>` element** | Removing `<w:r>` elements could break relationship IDs, bookmark ranges, comment anchors, or other cross-references. |
| Atomicity model | **All-or-nothing per invocation** | Same as `replace_in_note` ([`replace-in-note.ts:186-237`](../src/tools/replace-in-note.ts)). DOM manipulation only serialized on full success. |
| Constructor dependencies | **`(app: App, settings: NotorSettings)`** | Matches docx tool pattern ([`read-docx.ts:60-63`](../src/tools/read-docx.ts)), not the note tool pattern which takes staleTracker/noteOpener/checkpointManager. |
| Stale tracking | **Skip for v1** | No existing docx tool uses `StaleContentTracker`. It's string-based ([`src/chat/stale-tracker.ts:67-92`](../src/chat/stale-tracker.ts)) and doesn't support binary files. Mtime-based tracking can be added later. |
| Checkpoint/backup | **Skip for v1** | `CheckpointManager` ([`src/checkpoints/checkpoint.ts`](../src/checkpoints/checkpoint.ts)) is vault-note-scoped. Binary file backup requires a separate mechanism. Atomicity provides the safety net. |
| New dependencies | **None** | PizZip and @xmldom/xmldom already in package.json. |

---

## 4. Implementation Plan

### 4.1 Files to Create

#### `src/tools/docx-text-replacer.ts` (~150-200 lines)

Pure logic module. Exports:
- `buildRunMap(paragraph: Element): RunMapping[]`
- `findMatchInParagraph(runMap: RunMapping[], searchText: string): MatchResult | null`
- `applyReplacementToRuns(runMap: RunMapping[], match: MatchResult, replacementText: string): void`
- `replaceInDocumentXml(xmlString: string, changes: ChangeBlock[]): ReplaceResult`
- Type exports: `RunMapping`, `MatchResult`, `ChangeBlock`, `ReplaceResult`

**Pattern to follow:** [`src/tools/docx-comment-parser.ts`](../src/tools/docx-comment-parser.ts) — pure functions, `@xmldom/xmldom` only, no Obsidian or fs dependencies. Reuse the same `W_NS` constant pattern (line 19), `DOMParser` import (line 12), and `getElementsByTagNameNS` DOM traversal (lines 64-72).

#### `src/tools/docx-text-replacer.test.ts` (~200-300 lines)

Unit tests with inline XML strings. **Pattern to follow:** [`src/tools/docx-comment-parser.test.ts`](../src/tools/docx-comment-parser.test.ts).

**Test cases:**
1. Simple single-run replacement — text fully within one `<w:r>`
2. Multi-run replacement — text spans 2-3 `<w:r>` elements with different formatting
3. Formatting preservation — replacement inherits first run's `<w:rPr>` (bold, italic, font)
4. Empty replacement (deletion) — search text removed, no residual content
5. Search text not found — returns error with correct block index
6. Multiple change blocks applied in sequence — second block finds text modified by first
7. Atomicity — second block fails to match, verify no changes from first block are present
8. Whitespace handling — replacement introduces leading/trailing spaces, `xml:space="preserve"` set
9. Runs without `<w:t>` — image runs (`<w:drawing>`), field codes (`<w:fldChar>`) skipped without error
10. XML-special characters — search/replace containing `<`, `>`, `&` handled correctly (xmldom manages escaping)
11. Search text with newlines — rejected with clear error message

#### `src/tools/replace-in-docx.ts` (~150 lines)

Tool class. **Pattern to follow:** [`src/tools/read-docx.ts`](../src/tools/read-docx.ts) for boilerplate (platform guard, path validation, vault root resolution, extension check, fs I/O) combined with [`src/tools/replace-in-note.ts`](../src/tools/replace-in-note.ts) for the change-block validation and error reporting patterns.

### 4.2 Files to Modify

#### `src/main.ts` (~3 lines changed)

**At line ~78** (imports section): Add import for `ReplaceInDocxTool`.

**At line ~1044** (after `ExtractDocxCommentsTool` registration): Add:
```typescript
this._toolRegistry.register(new ReplaceInDocxTool(this.app, this.settings));
```

This follows the exact registration pattern at [`src/main.ts:1042-1044`](../src/main.ts).

#### `src/settings/constants.ts` (tool display name)

Add `replace_in_docx` entry to the tool display names map, following the existing entries for `read_docx`, `write_docx`, and `extract_docx_comments`.

#### `src/settings/defaults.ts` (auto-approve default)

Add `replace_in_docx: false` to the auto-approve defaults, consistent with all other docx tools.

### 4.3 Implementation Sequence

1. **`src/tools/docx-text-replacer.ts`** — core algorithm, pure functions
2. **`src/tools/docx-text-replacer.test.ts`** — comprehensive unit tests, validate algorithm
3. **`src/tools/replace-in-docx.ts`** — tool class wiring
4. **`src/main.ts`** + settings files — registration and config
5. **Manual E2E testing** in Obsidian (see Section 5)

---

## 5. Verification

### Unit Tests
Run `docx-text-replacer.test.ts` — covers all replacement logic, edge cases, and atomicity guarantees.

### Manual E2E Testing
1. Create a `.docx` in Word/LibreOffice with varied formatting: bold words, italic phrases, mixed styles within a sentence, bullet lists, headings
2. Place the `.docx` in the vault or an allowed path
3. Use `read_docx` to see the content as markdown
4. Use `replace_in_docx` to make a targeted replacement (e.g., replace a bold word)
5. Use `read_docx` again to verify the replacement applied
6. Open the `.docx` in Word/LibreOffice to verify:
   - The replacement text is present
   - Surrounding formatting is preserved
   - Other document elements (images, headers, comments) are intact

### Edge Case Testing
- Open a Word-generated `.docx` (which produces heavily split runs due to spell-check and revision tracking) and verify replacements work across split runs
- Test with a `.docx` containing tracked changes, comments with anchors, and bookmarks to verify non-text elements survive the replacement

---

## 6. Scope Limitations (v1)

- **Intra-paragraph only** — search text must exist within a single `<w:p>`. Cross-paragraph replacement deferred.
- **No stale tracking** — consistent with existing docx tools. Mtime-based tracking is a follow-up.
- **No binary checkpoint** — existing `CheckpointManager` is vault-note-scoped. File backup is a separate concern.
- **Only `word/document.xml` searched** — headers (`word/header*.xml`), footers (`word/footer*.xml`), textboxes, and shapes not searched. Can extend later.
- **First occurrence only** — each change block replaces only the first match, same as `replace_in_note`.

---

## 7. Future Enhancements

- **Mtime-based stale tracking**: Record file mtime after `read_docx`, check before `replace_in_docx`
- **Binary checkpoint**: Copy original file bytes before modification for rollback
- **Header/footer search**: Extend to search `word/header*.xml` and `word/footer*.xml`
- **Cross-paragraph replacement**: Requires `<w:p>` merge/split logic
- **Regex search**: Optional regex mode for pattern-based replacements
