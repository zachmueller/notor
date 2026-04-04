# Design: PDF & Image Handling in Notor

**Status:** Draft  
**Date:** 2026-04-05

---

## 1. Motivation

Notor currently supports only text-based content (notes, `.docx`, plain files). PDFs and images — two of the most common file types in Obsidian vaults — are explicitly rejected:

- External file attachment validation rejects binary files ([`src/context/attachment.ts:381`](../src/context/attachment.ts))
- `read_file` rejects binary content at line 137 ([`src/tools/read-file.ts:137`](../src/tools/read-file.ts))
- `fetch_webpage` states "Binary content types (PDF, images, etc.) are not supported"
- Word document images are replaced with `[image]` placeholders ([`src/tools/read-docx.ts`](../src/tools/read-docx.ts))
- MCP tool results omit images with `"[1 image omitted]"`

Adding PDF and image support enables:
- Attaching reference PDFs to conversations (research papers, contracts, manuals)
- Including diagrams, screenshots, and photos as context for the LLM
- Leveraging vision capabilities of modern models (Claude, GPT-4o, Gemini)
- Processing PDFs in tool-based workflows (read, summarize, extract)

---

## 2. Reference Implementations

### 2.1 Cline

**PDF:** Uses `pdf-parse` (`^1.1.1`) for text extraction. Simple pipeline: `fs.readFile()` → Buffer → `pdf(buffer).text`. Content truncated to 400KB. No page-level control, no native API document blocks. Key file: `src/integrations/misc/extract-text.ts`.

**Images:** Uses `image-size` for dimension validation (max 7500×7500). Base64 encodes buffer directly — no resizing or compression. Formats as Anthropic `ImageBlockParam` (`{ type: "image", source: { type: "base64", media_type, data } }`). Model-aware: checks `supportsImages` before processing. Deduplication cache per file path. Key file: `src/integrations/misc/extract-images.ts`.

**Content construction:** Mixed content blocks (text + images) in single messages via `ContentBlock[]` arrays on `TaskState.userMessageContent`. Unified extraction function (`extractFileContent()`) routes by file type.

### 2.2 Claude Code

**PDF (two-tier):**
1. *Small PDFs (<3MB):* Native Anthropic API document blocks — `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`. Preserves structure/layout. Magic byte validation (`%PDF-` header).
2. *Large PDFs / unsupported models:* Poppler utilities (`pdfinfo` for page count, `pdftoppm` for page-to-JPEG at 100 DPI). Each page as image block.
- Page range support (1-indexed), max 20 pages per read, 100 per API request, 20MB max file size
- Key files: `src/utils/pdf.ts`, `src/utils/pdfUtils.ts`, `src/tools/FileReadTool/FileReadTool.ts`

**Images:** Uses `sharp` for resizing/compression. Magic byte format detection. Progressive compression: try JPEG at quality [80, 60, 40, 20]. Max 2000px dimensions. Token budget awareness (640KB base64 ≈ 512 tokens). Key files: `src/utils/imageResizer.ts`, `src/tools/FileReadTool/imageProcessor.ts`.

**Content construction:** Images as `{ type: "image", source: { type: "base64", media_type, data } }`. PDFs as native document blocks OR extracted page images. Media limit tracking (100 items max).

### 2.3 Key Takeaways

| Aspect | Cline | Claude Code | Notor Recommendation |
|--------|-------|-------------|---------------------|
| PDF library | pdf-parse | None (native API + poppler) | Evaluate candidates (§3) |
| Image resize | None (raw base64) | sharp (native binary) | Electron Canvas API (zero deps) |
| Content model | `ContentBlock[]` | `ContentBlock[]` | Same — extend `ChatMessage.content` |
| Native PDF blocks | No | Yes (Anthropic) | Yes (Anthropic + Bedrock) |
| Provider abstraction | Anthropic-centric | Anthropic-only | Multi-provider formatter |

---

## 3. PDF Library Evaluation

### 3.1 Candidates

| Library | npm | Approach | Bundle impact | Node/Browser | Status |
|---------|-----|----------|---------------|-------------|--------|
| **pdf-parse** | `pdf-parse` | Node wrapper around bundled pdf.js | ~120KB + old pdf.js | Node | Abandoned (last publish 2019) |
| **pdf-parse-new** | `pdf-parse-new` | Maintained fork of pdf-parse | ~120KB + pdf.js | Node | Active fork |
| **unpdf** | `unpdf` | Modern wrapper over pdfjs-dist | ~50KB (wrapper) + pdfjs-dist peer | Both | Active, modern |
| **pdfjs-dist** | `pdfjs-dist` | Mozilla's full PDF renderer | ~2-3MB | Both | Canonical, very active |

### 3.2 Evaluation Criteria (priority order)

1. **Electron/esbuild compatibility** — Obsidian uses esbuild with `platform: "node"`, `format: "cjs"`, `target: "es2018"`. Libraries that require a separate worker thread (pdfjs-dist) need special bundling. Test that the library works within this build chain.

2. **Bundle impact** — Notor's current bundle is ~3.3MB. Adding 2-3MB from pdfjs-dist would double it. Target: <500KB additional. Consider lazy loading via dynamic `import()` if the library is large.

3. **Text extraction quality** — Test against representative PDFs: plain text, tables, multi-column layouts, embedded fonts, scanned (no text layer). Compare extracted text quality.

4. **Page-level extraction** — Can extract text from specific page ranges? Essential for large PDFs where full text exceeds context limits.

5. **Error resilience** — Handling of: encrypted/password-protected PDFs, corrupt files, image-only PDFs (no text layer), zero-page PDFs.

6. **Maintenance / ecosystem** — Last publish date, open issues, GitHub activity.

### 3.3 Evaluation Plan

Create a test script (`e2e/scripts/pdf-library-eval.ts`) that:
1. Installs all four libraries as dev dependencies
2. Reads a set of 5+ test PDFs through each library
3. Reports: extraction time, character count, page-level support, errors
4. Tests esbuild bundling compatibility

**Test PDFs** (to be placed in `e2e/fixtures/pdf/`):
- Plain text document (baseline)
- Table-heavy document (financial report, etc.)
- Mixed content (text + images + charts)
- Large document (100+ pages)
- Scanned document (image-only, no text layer)

### 3.4 Preliminary Assessment

**`unpdf`** is the strongest candidate for Notor's use case:
- Modern API, ESM-first, actively maintained
- Small wrapper size (~50KB) — the question is whether pdfjs-dist peer dep can be lazy-loaded or split
- Works in both Node and browser contexts (important for Electron)

**`pdf-parse-new`** is the safe fallback:
- Drop-in replacement for pdf-parse (Cline's proven approach)
- Bundles its own pdf.js (simpler, no peer deps)
- Smaller total bundle than raw pdfjs-dist
- Less modern API, no page-level access without extra work

**Important:** For providers that support native PDF document blocks (Anthropic, Bedrock), no PDF parsing library is needed at all — just base64-encode the raw file. The library is only required for text extraction fallback (OpenAI, Local providers) and for very large PDFs that exceed API size limits.

---

## 4. Architecture

### 4.1 Content Block System

The core change: extend `ChatMessage.content` from `string` to `string | ContentBlock[]`.

```typescript
// src/media/types.ts (new file)

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; media_type: ImageMediaType; data: string }   // base64
  | { type: "document"; media_type: "application/pdf"; data: string }; // base64
```

```typescript
// src/providers/provider.ts — ChatMessage change (backward-compatible)

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string | ContentBlock[];  // ← was: string
  // ... existing tool_calls, tool_results fields unchanged ...
}
```

This is backward-compatible: all existing code passes strings, which remain valid. Only new image/PDF code paths produce `ContentBlock[]`.

### 4.2 New Module: `src/media/`

| File | Purpose |
|------|---------|
| `src/media/types.ts` | `ContentBlock`, `ImageMediaType`, media limit constants |
| `src/media/format-detector.ts` | Magic byte detection (PDF, PNG, JPEG, GIF, WebP) |
| `src/media/image-processor.ts` | Image validation, resize, compression, base64 encoding |
| `src/media/pdf-processor.ts` | PDF text extraction, native doc block creation, page ranges |
| `src/media/provider-formatter.ts` | Provider-specific content block formatting |
| `src/media/capabilities.ts` | Provider media capability detection |

### 4.3 Image Processing Pipeline (`src/media/image-processor.ts`)

```
Image file → Read buffer → Magic byte detection → Validate dimensions
  → Resize if needed (Canvas API) → Compress (JPEG quality cascade)
  → Base64 encode → ContentBlock { type: "image" }
```

**Key decision: Electron Canvas API instead of `sharp`.**

`sharp` uses native bindings (libvips, 40-80MB installed) and requires platform-specific binaries. This is unacceptable for an Obsidian plugin. Instead, use the `<canvas>` and `Image` APIs available in Electron's renderer process (zero additional dependencies):

```typescript
// Dimension detection — zero deps
const img = new Image();
img.src = `data:${mediaType};base64,${base64}`;
await new Promise(resolve => { img.onload = resolve; });
// img.naturalWidth, img.naturalHeight available

// Resize + compress — zero deps
const canvas = document.createElement("canvas");
canvas.width = targetWidth;
canvas.height = targetHeight;
const ctx = canvas.getContext("2d")!;
ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
const dataUrl = canvas.toDataURL("image/jpeg", quality);
```

**Processing rules:**
- Max dimensions: 2000×2000px (scale down proportionally if exceeded)
- Max base64 output: 5MB (Anthropic API limit)
- Compression cascade: JPEG quality 80 → 60 → 40 → 20 if still over 5MB
- Supported formats: PNG, JPEG, GIF, WebP (detected via magic bytes)
- PNGs with transparency: keep as PNG (canvas `toDataURL("image/png")`) unless too large

### 4.4 PDF Processing Pipeline (`src/media/pdf-processor.ts`)

```
PDF file → Read buffer → Magic byte check (%PDF-) → Size check
  → Branch by provider capability:
    ├─ Native support (Anthropic/Bedrock): Base64 encode → ContentBlock { type: "document" }
    └─ No native support (OpenAI/Local): Extract text → ContentBlock { type: "text" }
```

**Text extraction path:**
1. Load PDF via chosen library
2. Extract text (full document or page range)
3. Clean extracted text (normalize whitespace, remove control chars)
4. Truncate to configurable limit (default: 400K chars ≈ 100K tokens)
5. Return as `{ type: "text", text: "..." }`

**Native document block path:**
1. Base64-encode the raw PDF buffer
2. Check size (max 10MB for Anthropic, 5MB for Bedrock)
3. Return as `{ type: "document", media_type: "application/pdf", data: "..." }`

**Page range support:**
- Syntax: `"1-5"`, `"3"`, `"10-20"` (1-indexed)
- When specified, forces text extraction path (can't send partial PDF as native doc)
- Library must support per-page access (criterion in §3.2)

### 4.5 Provider-Specific Formatting (`src/media/provider-formatter.ts`)

Each provider maps `ContentBlock[]` to its native API format:

**Anthropic:**
- Text → `{ type: "text", text }` (unchanged)
- Image → `{ type: "image", source: { type: "base64", media_type, data } }`
- Document → `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`

**OpenAI:**
- Text → `{ type: "text", text }`
- Image → `{ type: "image_url", image_url: { url: "data:{media_type};base64,{data}" } }`
- Document → pre-converted to text (PDF processor handles this before it reaches OpenAI)

**Bedrock (Converse API):**
- Text → `{ text: "..." }` (existing Bedrock ContentBlock format)
- Image → `{ image: { format: "png"|"jpeg"|..., source: { bytes: Buffer.from(data, "base64") } } }`
- Document → `{ document: { format: "pdf", name: "document.pdf", source: { bytes: Buffer.from(data, "base64") } } }`

**Local (OpenAI-compatible):**
- Same as OpenAI format; vision support varies by model

### 4.6 Provider Media Capabilities (`src/media/capabilities.ts`)

```typescript
export interface MediaCapabilities {
  supportsImages: boolean;
  supportsNativePdf: boolean;
  maxImageSizeBytes: number;
  maxDocumentSizeBytes: number;
  maxMediaItems: number;
}
```

| Provider | Images | Native PDF | Max image | Max doc | Max items |
|----------|--------|-----------|-----------|---------|-----------|
| Anthropic | Yes | Yes | 5 MB (base64) | 32 MB (base64) | 100 |
| OpenAI | Yes | No | 20 MB | N/A | 50 |
| Bedrock | Yes | Yes | 3.75 MB | 4.5 MB | 20 |
| Local | Attempt | No | 5 MB | N/A | 10 |

The PDF processor consults these capabilities to decide whether to send native document blocks or extract text.

---

## 5. Integration Points

### 5.1 Attachment System (`src/context/attachment.ts`)

**New attachment types:**

```typescript
export type AttachmentType =
  | "vault_note" | "vault_note_section" | "external_file"  // existing
  | "vault_image" | "vault_pdf"                             // new: vault files
  | "external_image" | "external_pdf";                      // new: filesystem files
```

**Extended Attachment interface:**

```typescript
export interface Attachment {
  // ... existing fields (id, type, path, section, display_name, content, content_length, status, error_message) ...
  /** Base64-encoded binary content for images/PDFs. Null for text attachments. */
  binary_content: string | null;
  /** Detected media type for binary attachments (e.g., "image/png", "application/pdf"). */
  media_type: string | null;
}
```

**New factory functions:**
- `createVaultImageAttachment(path: string): Attachment`
- `createVaultPdfAttachment(path: string): Attachment`
- `createExternalBinaryAttachment(absolutePath: string, filename: string, base64: string, mediaType: string): Attachment`

**Resolution changes:** For vault image/PDF types, `resolveAttachment()` reads binary via `app.vault.readBinary(file)`, processes through the image/PDF pipeline, and stores base64 in `binary_content`.

**Serialization changes:** `buildAttachmentsBlock()` return type changes:

```typescript
export function buildAttachmentsBlock(
  attachments: Attachment[]
): { text: string | null; contentBlocks: ContentBlock[] };
```

Text attachments continue as XML `<attachments>` block. Binary attachments produce `ContentBlock` entries. The orchestrator combines both into the user message.

### 5.2 Message Assembly (`src/context/message-assembler.ts`)

`assembleUserMessage()` currently returns `string`. It evolves to return `string | ContentBlock[]`:

- If there are no media content blocks, behavior is unchanged (returns string)
- If there are content blocks, returns `ContentBlock[]` with the text message as the first `{ type: "text" }` block, followed by image/document blocks

### 5.3 Orchestrator (`src/chat/orchestrator.ts`)

In the `sendMessage` flow (~line 1220-1260):

1. `buildAttachmentsBlock()` now returns `{ text, contentBlocks }`
2. Text parts assembled via `assembleUserMessage()` as before
3. If `contentBlocks.length > 0`, the user `ChatMessage.content` becomes a `ContentBlock[]` array instead of a plain string
4. Providers handle both formats in their `toXxxMessages()` functions

**History persistence:** Binary content is NOT persisted in the JSONL history file (would balloon file sizes). When replaying from history, images/PDFs are omitted — the text description remains. This matches current behavior for MCP image results (`"[1 image omitted]"`). Future enhancement could add optional persistence.

### 5.4 Tool Results (`src/types.ts`)

Extend `ToolResult` with optional content blocks:

```typescript
export interface ToolResult {
  // ... existing fields ...
  /** Optional multimodal content blocks (images, documents) from tool execution. */
  content_blocks?: ContentBlock[];
}
```

The dispatcher and providers format tool results with content blocks per the provider's wire format (e.g., Anthropic tool_result content arrays can include image blocks alongside text).

### 5.5 Enhanced `read_file` Tool (`src/tools/read-file.ts`)

Rather than creating separate `read_pdf` and `read_image` tools, extend the existing `read_file` tool to handle all three content types. This avoids tool proliferation and keeps the LLM's tool list lean.

**Schema changes:**

```typescript
readonly input_schema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Path to the file. Vault-relative or absolute.",
    },
    encoding: {
      type: "string",
      description: "File encoding for text files. Default: utf-8.",
      default: "utf-8",
    },
    pages: {
      type: "string",
      description: "Page range for PDF files (e.g. '1-5', '3', '10-20'). Ignored for non-PDF files.",
    },
  },
  required: ["path"],
};
```

**Description update:**

```
"Read a file from the filesystem and return its contents. Supports text files, PDFs,
and images (PNG, JPEG, GIF, WebP). For PDFs, returns extracted text or a native
document block depending on provider support. For images, returns the image for
visual analysis. Use the optional `pages` parameter to read specific PDF page
ranges. Binary files other than PDFs and images are rejected."
```

**Execution flow change** — at [line 137](../src/tools/read-file.ts) (binary detection), insert format detection before rejection:

```
1. Read buffer (existing)
2. Detect format via magic bytes (NEW)
3. If image → process via image pipeline → return content_blocks
4. If PDF → process via PDF pipeline (native or text extraction) → return content_blocks and/or text
5. If other binary → reject as before
6. If text → existing text path (unchanged)
```

This is the only tool change needed. The `read_docx` tool remains separate (it has fundamentally different parsing logic via mammoth).

### 5.6 UI Changes

**Attachment picker** (`src/ui/attachment-picker.ts`):
- `openExternalFileDialog()` expands accepted extensions: `.pdf,.png,.jpg,.jpeg,.gif,.webp`
- New `readExternalBinaryFile()` function for binary file reading
- `VaultNoteSuggest` extended to show PDF and image vault files (not just `.md`)

**Attachment chips** (`src/ui/attachment-chips.ts`):
- Image attachments: image icon or small thumbnail preview
- PDF attachments: PDF icon

---

## 6. Settings

New settings in `NotorSettings` (`src/settings/types.ts`):

| Setting | Type | Default | Purpose |
|---------|------|---------|---------|
| `image_max_dimension` | `number` | `2000` | Max px (width or height) before resize |
| `image_compression_quality` | `number` | `80` | JPEG quality (0-100) for resized images |
| `pdf_native_max_size_mb` | `number` | `10` | Max MB for native PDF document blocks |
| `pdf_text_max_chars` | `number` | `400000` | Max chars for PDF text extraction |
| `pdf_prefer_native` | `boolean` | `true` | Use native PDF blocks when provider supports them |

New settings section: "Images & PDFs" (`src/settings/sections/media.ts`).

---

## 7. Phased Implementation

### Phase 1: Foundation — Content Block System

**Goal:** Introduce `ContentBlock` type and make all four providers handle it. No user-facing changes.

**Files to create:**
- `src/media/types.ts` — `ContentBlock`, `ImageMediaType`, constants
- `src/media/format-detector.ts` — magic byte detection

**Files to modify:**
- `src/providers/provider.ts` — `ChatMessage.content: string | ContentBlock[]`
- `src/providers/anthropic-provider.ts` — `toAnthropicMessages()` handles `ContentBlock[]`
- `src/providers/openai-provider.ts` — `toOpenAIMessages()` handles `ContentBlock[]`
- `src/providers/bedrock-provider.ts` — `toBedrockMessages()` handles `ContentBlock[]`
- `src/providers/local-provider.ts` — `toOpenAIMessages()` handles `ContentBlock[]`

**Verification:** Existing conversations work identically (all content remains strings). Unit tests for format detection.

### Phase 2: Image Handling

**Goal:** Full image support via `read_file` tool and attachments.

**Files to create:**
- `src/media/image-processor.ts` — Canvas-based resize/compress pipeline
- `src/media/capabilities.ts` — provider media capability detection
- `src/settings/sections/media.ts` — settings UI

**Files to modify:**
- `src/types.ts` — `ToolResult.content_blocks`
- `src/tools/read-file.ts` — add format detection before binary rejection; route images to image processor
- `src/context/attachment.ts` — new types, `binary_content`, new factories, updated `buildAttachmentsBlock()`
- `src/context/message-assembler.ts` — return `string | ContentBlock[]`
- `src/chat/orchestrator.ts` — multi-part message assembly
- `src/chat/dispatcher.ts` — propagate `content_blocks` from tool results
- `src/ui/attachment-picker.ts` — accept image files, binary read
- `src/ui/attachment-chips.ts` — image chip display
- `src/settings/types.ts` — image settings
- `src/settings/defaults.ts` — default values

**Verification:** Attach an image via picker → confirm it appears in the LLM's context (model describes the image). Use `read_file` on an image → LLM describes the image content. Test with Anthropic and OpenAI providers.

### Phase 3: PDF Handling

**Goal:** Full PDF support via `read_file` tool and attachments.

**Prerequisite:** Run PDF library evaluation (§3.3), pick winner, install dependency.

**Files to create:**
- `src/media/pdf-processor.ts` — text extraction + native document blocks

**Files to modify:**
- `src/tools/read-file.ts` — add `pages` parameter to schema; route PDFs to PDF processor
- `src/context/attachment.ts` — PDF attachment types and factories
- `src/ui/attachment-picker.ts` — accept PDF files
- `src/ui/attachment-chips.ts` — PDF chip display
- `src/settings/types.ts` — PDF settings
- `src/settings/defaults.ts` — default values
- `package.json` — new PDF library dependency

**Verification:** Attach a PDF → Anthropic receives native document block, OpenAI receives extracted text. Use `read_file` on a PDF with `pages` param → correct pages extracted. Test with corrupt/encrypted PDFs → graceful errors.

### Phase 2.5: DOCX Image Handling

**Goal:** Full image support in `read_docx` (extraction to vault) and `write_docx` (embedding from vault). Independent of the Content Block System — can begin immediately.

**Files to create:**
- `src/tools/docx-image-utils.ts` — `resolveImageForDocx()`, image dimension parsing, format mapping

**Files to modify:**
- `src/mammoth.d.ts` — expand type declarations (§10.3)
- `src/tools/read-docx.ts` — mammoth `convertImage` handler, Turndown rule rewrite, vault image persistence via `app.vault.createBinary()`
- `src/tools/write-docx.ts` — add `ImageRun` import, `image` case in `buildDocxChildren()`, make functions async, fix template grafting for media/relationship/content-type merging

**Verification:** `read_docx` on a docx with images → images saved to attachment folder with MD5 filenames → markdown contains `![alt](path)` → images render in Obsidian preview. `write_docx` with image markdown → open output in Word → images render. Template grafting with images → styles preserved AND images present. Duplicate images across multiple calls → same MD5 filename, no overwrites. Mixed formats (PNG + EMF + JPEG) → supported work, unsupported get text placeholders.

See §10 for full implementation details.

### Phase 4: Polish & Edge Cases

- Handle MCP tool results with images (currently omitted)
- Drag-and-drop support for images/PDFs on chat input
- Image thumbnail preview in attachment chips
- Context compaction awareness for binary content
- E2E test coverage

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| PDF library too large for plugin bundle | Build size doubles, slow Obsidian startup | Evaluate bundle impact early (§3.3). Fall back to lighter library. Consider lazy loading via dynamic `import()`. |
| Canvas API resize quality poor | Blurry images sent to API | Test at various scales during Phase 2. JPEG at quality 80 on canvas is generally good. Keep PNG path for screenshots/diagrams. |
| Provider rejects image/document format | Errors during conversation | Capability detection (§4.6) prevents sending unsupported formats. Graceful fallback to text extraction. |
| `ChatMessage.content` type change regressions | Broken conversations | Phase 1 is exclusively this change with full backward compatibility. All existing paths produce strings unchanged. |
| Large images/PDFs cause memory pressure | Plugin crashes or OOM | Enforce size limits (20MB max file, 5MB max base64). Process one attachment at a time. |
| Canvas not available in all Obsidian contexts | Image processing fails | All processing runs in renderer process where Canvas is available. Verify in Phase 2. |
| Binary content bloats conversation history | Large JSONL files | Binary content not persisted. Omitted on replay with `[image/PDF omitted]` marker. |

---

## 9. Dependency Impact

| Dependency | Purpose | Install? | Rationale |
|-----------|---------|----------|-----------|
| `sharp` | Image resize/compress | **No** | Native bindings (40-80MB). Use Electron Canvas API instead — zero deps. |
| `image-size` | Dimension detection | **No** | Use `Image` DOM API in Electron — zero deps. |
| `unpdf` or `pdf-parse-new` | PDF text extraction | **Yes (one)** | Only new production dependency. Decision after evaluation in §3.3. |
| `pdfjs-dist` | PDF rendering engine | **Maybe** | Peer dep of unpdf. Large (~2-3MB). May need lazy loading. |

Goal: exactly **one** new production dependency (the PDF library). Image handling requires **zero** new dependencies thanks to Electron's DOM APIs.

---

## 10. DOCX Image Handling

The three docx tools (`read_docx`, `write_docx`, `extract_docx_comments`) currently have no image support. `read_docx` replaces all images with `[image]` placeholders; `write_docx` silently drops image tokens; `extract_docx_comments` is text-only and out of scope for images.

This section details how to add full image support to `read_docx` and `write_docx`. Both changes are **independent of the Content Block System** (Phases 1–3) — they are pure filesystem I/O and can be implemented immediately as Phase 2.5.

### 10.1 `read_docx` — Image Extraction & Vault Persistence

**Strategy:** Extract images from docx via mammoth's `convertImage` API, save each to the vault's configured attachment folder with MD5-based filenames, and reference them in the output markdown via standard `![alt](path)` embedding.

This approach means:
- Images become first-class vault files the user can browse, reuse, and reference
- The markdown output is self-contained and renderable in Obsidian's preview
- No dependency on the Content Block System (Phases 1–2)
- MD5 filenames prevent overwrites: if the same image appears in multiple documents, it resolves to the same file without collision with user-named files

**Obsidian attachment folder API:**

```typescript
// Respects user's Settings → Files & Links → Default location for new attachments
const vaultPath = await app.fileManager.getAvailablePathForAttachment(
  filename,    // e.g., "a1b2c3d4e5f6.png"
  sourcePath   // optional: vault-relative note path for "same folder" mode
);
// Returns vault-relative path, e.g., "Attachments/a1b2c3d4e5f6.png"

// Save binary to vault
await app.vault.createBinary(vaultPath, arrayBuffer);
```

**Implementation:**

**Step 1 — mammoth `convertImage` handler** ([`src/tools/read-docx.ts`](../src/tools/read-docx.ts)):

```typescript
import { createHash } from "crypto";

interface ExtractedImage {
  vaultPath: string;      // where the image was saved in the vault
  contentType: string;
  altText: string;
}

const extractedImages: ExtractedImage[] = [];

const options = {
  convertImage: mammoth.images.imgElement(async (image) => {
    const contentType = image.contentType;

    // Skip unsupported formats (EMF, WMF, TIFF, SVG)
    const supported = ["image/png", "image/jpeg", "image/gif", "image/webp"];
    if (!supported.includes(contentType)) {
      return {
        src: `__notor_skip__`,
        alt: `[Unsupported image format: ${contentType}]`,
      };
    }

    try {
      const buffer = await image.readAsBuffer();

      // MD5-based filename prevents accidental overwrites
      const hash = createHash("md5").update(buffer).digest("hex");
      const ext = contentType.split("/")[1] === "jpeg" ? "jpg" : contentType.split("/")[1];
      const filename = `${hash}.${ext}`;

      // Resolve against user's attachment folder setting
      const targetPath = await this.app.fileManager.getAvailablePathForAttachment(filename);
      const existingFile = this.app.vault.getFileByPath(targetPath);

      if (!existingFile) {
        await this.app.vault.createBinary(targetPath, buffer.buffer);
      }

      const index = extractedImages.length;
      extractedImages.push({ vaultPath: targetPath, contentType, altText: "" });

      return { src: `__notor_img_${index}__`, alt: "" };
    } catch (e) {
      log.warn("Failed to extract image from docx", { error: e });
      return { src: `__notor_skip__`, alt: "[Image: extraction failed]" };
    }
  }),
};

const { value: html } = await mammoth.convertToHtml({ buffer: buf }, options);
```

**Step 2 — Turndown rule rewrite** — replace the current blanket `[image]` rule with vault-path markdown embeds:

```typescript
td.addRule("replaceImages", {
  filter: (node) => node.nodeName === "IMG",
  replacement: (_content, node) => {
    const src = (node as HTMLElement).getAttribute("src") || "";
    const alt = (node as HTMLElement).getAttribute("alt") || "";

    // Unsupported format — render alt text
    if (src === "__notor_skip__") return alt;

    // Extracted image — standard markdown embed
    const match = src.match(/__notor_img_(\d+)__/);
    if (match) {
      const img = extractedImages[parseInt(match[1])];
      if (img) return `![${img.altText || "image"}](${img.vaultPath})`;
    }

    return "[image]"; // fallback
  },
});
```

**Step 3 — Result** — the tool returns standard markdown with embedded image references:

```markdown
# Document Title

Some text above the image.

![image](Attachments/a1b2c3d4e5f6.png)

More text below the image.
```

The LLM receives this markdown and can see the image paths. If the broader image handling system (Phase 2) is also active, the LLM could use `read_file` to actually view the images. Without Phase 2, the LLM at least knows the images exist and where they are.

**MD5 deduplication behavior:**
- Same image in the same document (e.g., repeated logo): saved once, referenced multiple times
- Same image across different documents: reuses the existing vault file
- Different images: guaranteed different filenames (MD5 collision probability is negligible)
- User's existing files are never overwritten: MD5 hashes won't collide with human-named files

**Edge cases:**

| Scenario | Behavior |
|----------|----------|
| EMF/WMF (Windows metafiles) | Skip — `[Unsupported image format: image/x-emf]` in markdown |
| SVG | Skip — not supported by vision APIs |
| TIFF | Skip — not web-renderable |
| Corrupt/unreadable image | Skip with `[Image: extraction failed]` + warning log |
| Very large image (>20MB buffer) | Still save — vault handles large files fine |
| Attachment folder doesn't exist | Obsidian's `getAvailablePathForAttachment` creates it |
| No images in document | No files saved, markdown identical to current output |
| `read_docx` called on mobile | Already blocked by platform guard |

**Dependencies:** None on the Content Block System. Requires the `mammoth.d.ts` type update (§10.3) and access to `this.app` for vault operations. The `ReadDocxTool` constructor already receives `app: App`.

### 10.2 `write_docx` — Image Embedding

**Strategy:** Handle `image` tokens from marked's lexer using the `docx` library's `ImageRun` class. Independent of the Content Block System — purely filesystem I/O.

**Image token format from marked:**

```typescript
{ type: "image", href: string, title: string | null, text: string /* alt text */ }
```

**Implementation changes to [`src/tools/write-docx.ts`](../src/tools/write-docx.ts):**

**Step 1 — Add `ImageRun` to imports:**

```typescript
import { Document, Packer, Paragraph, TextRun, ImageRun, /* ... */ } from "docx";
```

**Step 2 — Make `buildDocxChildren()` and `generateDocx()` async.** Image reading requires async I/O. The sole caller already `await`s `generateDocx()`.

**Step 3 — Add image case to `buildDocxChildren()`:**

```typescript
case "image": {
  const img = token as Tokens.Image;
  const imageData = await resolveImageForDocx(img.href, vaultRoot, allowedPaths);
  if (imageData) {
    result.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: imageData.type,
            data: imageData.buffer,
            transformation: { width: imageData.width, height: imageData.height },
            altText: {
              title: img.title || "",
              description: img.text || "",
              name: img.text || "image",
            },
          }),
        ],
      })
    );
  } else {
    // Fallback: render as text placeholder
    result.push(new Paragraph({
      children: [new TextRun({ text: `[Image: ${img.href}]` })],
    }));
  }
  break;
}
```

**Step 4 — New utility `resolveImageForDocx()`** (in new file `src/tools/docx-image-utils.ts`):

```typescript
export interface DocxImageData {
  type: "jpg" | "png" | "gif" | "bmp";
  buffer: Buffer;
  width: number;   // pixels
  height: number;  // pixels
}

export async function resolveImageForDocx(
  href: string,
  vaultRoot: string,
  allowedPaths: string[]
): Promise<DocxImageData | null>
```

**Image source resolution:**
- **Vault-relative paths** (e.g., `Attachments/abc123.png`): resolve from vault root
- **Absolute paths**: validate against `allowedPaths` via `resolveAndValidatePath()`
- **Data URIs** (`data:image/png;base64,...`): decode directly to buffer
- **HTTP URLs**: reject — no network I/O from tools (security)

**Format mapping:** `image/png` → `"png"`, `image/jpeg` → `"jpg"`, `image/gif` → `"gif"`, `image/bmp` → `"bmp"`. WebP is not supported by the `docx` library's `ImageRun` — convert to PNG via Electron Canvas API if encountered.

**Dimension detection** — parse image buffer headers (zero dependencies, ~50 lines):
- **PNG**: bytes 16–23 of IHDR chunk (width: 16–19, height: 20–23, big-endian uint32)
- **JPEG**: scan for SOF0/SOF2 marker (`0xFF 0xC0` / `0xFF 0xC2`), height at offset+5, width at offset+7
- **GIF**: bytes 6–9 (width: 6–7, height: 8–9, little-endian uint16)
- **BMP**: bytes 18–25 (width: 18–21, height: 22–25, little-endian int32)

**Step 5 — Template grafting fix** — critical issue with current implementation:

The current template grafting logic ([`write-docx.ts` lines 286–338](../src/tools/write-docx.ts)) only copies `word/document.xml` from the generated docx into the template ZIP. But `ImageRun` images are stored across three locations in the docx ZIP:

1. `word/media/*` — the actual image binary files
2. `word/_rels/document.xml.rels` — relationship entries mapping rId references to media paths
3. `[Content_Types].xml` — content type declarations for image formats

**Fix:** When grafting, also merge from the generated ZIP into the template ZIP:
- All `word/media/*` files (copy each entry)
- Image relationship entries from generated `word/_rels/document.xml.rels` into template's (parse XML, append `<Relationship>` elements with image type)
- Image content type entries from generated `[Content_Types].xml` into template's (append `<Default>` or `<Override>` elements for image extensions)

Use `@xmldom/xmldom` (already a transitive dependency via mammoth) to parse and merge the relationship and content type XML.

**`ImageRun` API** (from `docx ^9.6.1`):

```typescript
new ImageRun({
  type: "jpg" | "png" | "gif" | "bmp",         // RegularImageOptions
  data: Buffer | string | Uint8Array,            // image binary data
  transformation: { width: number, height: number },  // required, in pixels
  altText?: { title: string, description: string, name: string },
})
```

**Size limits:**
- Max input image: 20MB (reject larger with error)
- No resize/compression needed — docx stores the original binary
- Max dimensions: no limit (Word handles display scaling)

### 10.3 `mammoth.d.ts` Type Declaration Update

The current 6-line declaration at [`src/mammoth.d.ts`](../src/mammoth.d.ts) must be expanded to enable type-safe usage of mammoth's image extraction API:

```typescript
declare module "mammoth" {
  interface Options {
    styleMap?: string | string[];
    includeEmbeddedStyleMap?: boolean;
    includeDefaultStyleMap?: boolean;
    convertImage?: ImageConverter;
    ignoreEmptyParagraphs?: boolean;
    idPrefix?: string;
    externalFileAccess?: boolean;
    transformDocument?: (element: any) => any;
  }

  interface ImageConverter {
    __mammothBrand: "ImageConverter";
  }

  interface Image {
    contentType: string;
    readAsArrayBuffer(): Promise<ArrayBuffer>;
    readAsBase64String(): Promise<string>;
    readAsBuffer(): Promise<Buffer>;
  }

  interface ImageAttributes {
    src: string;
    alt?: string;
    [key: string]: string | undefined;
  }

  interface Images {
    dataUri: ImageConverter;
    imgElement(f: (image: Image) => Promise<ImageAttributes>): ImageConverter;
  }

  interface Result {
    value: string;
    messages: Array<{ type: string; message: string }>;
  }

  export function convertToHtml(input: { buffer: Buffer }, options?: Options): Promise<Result>;
  export function extractRawText(input: { buffer: Buffer }): Promise<Result>;
  export const images: Images;
}
```

### 10.4 Error Handling

All image errors are **non-fatal** — a document with 10 images where 2 fail still returns the text + the 8 successful images:

| Error | `read_docx` behavior | `write_docx` behavior |
|-------|---------------------|----------------------|
| Unsupported format (EMF/WMF/SVG/TIFF) | `[Unsupported image format: ...]` in markdown | Text placeholder paragraph |
| Corrupt/unreadable image | `[Image: extraction failed]` + warning log | `[Image: path]` text + warning log |
| Image too large (>20MB) | Still save (vault handles it) | Reject with text placeholder |
| Image file not found | N/A (embedded in docx) | `[Image: path]` text + warning |
| Vault write fails | `[Image: save failed]` + warning log | N/A |
| Attachment folder config missing | Obsidian defaults to vault root | N/A |
