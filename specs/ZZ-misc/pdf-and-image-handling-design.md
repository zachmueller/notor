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
| Content model | `ContentBlock[]` | `ContentBlock[]` | Same — extend `Message.content` + `ChatMessage.content` |
| Native PDF blocks | No | Yes (Anthropic) | Yes (Anthropic + Bedrock) |
| Provider abstraction | Anthropic-centric | Anthropic-only | Extend each provider's `toXxxMessages()` |

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

The core change: extend both `Message.content` and `ChatMessage.content` from `string` to `string | ContentBlock[]`.

```typescript
// src/media/types.ts (new file)

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; media_type: ImageMediaType; data: string; width?: number; height?: number }
  | { type: "document"; media_type: "application/pdf"; data: string; page_count?: number };
```

The optional `width`, `height`, and `page_count` fields carry processing metadata for token estimation (see §7 Phase 1). The image pipeline (§4.3) always knows post-processing dimensions from the Electron Canvas API; the PDF processor knows page count from the PDF library. These fields are optional for backward compatibility with blocks created before the metadata was captured, and for edge cases where dimensions cannot be determined. The metadata overhead is negligible (~30 bytes per block in serialized JSONL).

**Helper function** — to reduce type-narrowing boilerplate at 30+ read sites, `src/media/types.ts` also exports a `getTextContent()` utility:

```typescript
/** Extract the text portion from content that may be a string or ContentBlock[]. */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}
```

This is used by exporters, compaction, history search, and any other consumer that needs the text representation without media. It does NOT replace provider-specific formatting — providers map `ContentBlock[]` to their native content block formats directly.

**Two types must change in concert:**

Notor has two separate message types. `Message` (`src/types.ts:99`) is the internal type used by the conversation manager, JSONL history, token estimation, UI, and sub-agents. `ChatMessage` (`src/providers/provider.ts:23`) is the provider-facing type constructed from `Message` via `toChatMessages()`. Both have `content: string` today, and both must change.

```typescript
// src/types.ts — Message change
export interface Message {
  // ... existing fields ...
  content: string | ContentBlock[];  // ← was: string
}
```

```typescript
// src/providers/provider.ts — ChatMessage change
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string | ContentBlock[];  // ← was: string
  // ... existing tool_calls, tool_results fields unchanged ...
}
```

Media content (base64 image/document blocks) persists everywhere `Message` is used, including JSONL chat history. This means history files will grow for image-heavy conversations (a single 2000×2000 JPEG at quality 80 is ~200–500KB in base64). The existing `history_max_size_mb` (500MB) and `history_max_age_days` (90 days) settings provide sufficient guardrails.

The **write side** is backward-compatible: all existing code that creates messages with `content: "some string"` remains valid. The **read side** is not — 10+ callsites consume `content` as a plain string and will surface as TypeScript compile errors. These are enumerated exhaustively in Phase 1 (§7).

### 4.2 New Module: `src/media/`

| File | Purpose |
|------|---------|
| `src/media/types.ts` | `ContentBlock`, `ImageMediaType`, media limit constants |
| `src/media/format-detector.ts` | Magic byte detection (PDF, PNG, JPEG, GIF, WebP) |
| `src/media/image-processor.ts` | Image validation, resize, compression, base64 encoding |
| `src/media/pdf-processor.ts` | PDF text extraction, native doc block creation, page ranges |
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
- Supported formats: PNG, JPEG, GIF, WebP (detected via magic bytes)

**Format-aware compression cascade:**

JPEG compression introduces artifacts around high-contrast edges, making text in screenshots and diagrams unreadable at lower quality levels. To preserve quality, the compression strategy depends on the source format:

- **PNG images:** Resize if needed → try PNG first (`canvas.toDataURL("image/png")`) → if over 5MB, cascade to JPEG quality 80 → 60 → 40
- **JPEG images:** Resize if needed → try JPEG at original quality (or 80) → cascade to 60 → 40 → 20
- **GIF/WebP:** Convert to PNG first (to preserve quality), then follow the PNG cascade

This ensures screenshots and diagrams with text stay as PNG when possible (typically <5MB after resize), while photographs that need aggressive compression use JPEG.

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
2. Check size against provider's API-documented limit (see §4.6 capabilities table)
3. Return as `{ type: "document", media_type: "application/pdf", data: "..." }`

**Page range support:**
- Syntax: `"1-5"`, `"3"`, `"10-20"` (1-indexed)
- When specified, forces text extraction path (can't send partial PDF as native doc)
- Library must support per-page access (criterion in §3.2)

### 4.5 Provider-Specific Formatting (in each provider's `toXxxMessages()`)

Rather than introducing a separate `provider-formatter.ts` module, each provider's existing `toXxxMessages()` function is extended to handle `ContentBlock[]` in `msg.content`. This keeps all provider-specific logic co-located in the provider file, matching the existing architecture. The media module (`src/media/`) handles content block *creation* (image processing, PDF processing, format detection) but not provider-specific *formatting*.

Each provider maps `ContentBlock[]` to its native API format:

**Anthropic** (`toAnthropicMessages()` in `src/providers/anthropic-provider.ts`):
- Text → `{ type: "text", text }` (unchanged)
- Image → `{ type: "image", source: { type: "base64", media_type, data } }`
- Document → `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`

**OpenAI** (`toOpenAIMessages()` in `src/providers/openai-provider.ts`):
- Text → `{ type: "text", text }`
- Image → `{ type: "image_url", image_url: { url: "data:{media_type};base64,{data}" } }`
- Document → pre-converted to text (PDF processor handles this before it reaches OpenAI)

**Bedrock** (`toBedrockMessages()` in `src/providers/bedrock-provider.ts`):
- Text → `{ text: "..." }` (existing Bedrock ContentBlock format)
- Image → `{ image: { format: "png"|"jpeg"|..., source: { bytes: Buffer.from(data, "base64") } } }`
- Document → `{ document: { format: "pdf", name: "document.pdf", source: { bytes: Buffer.from(data, "base64") } } }`

**Local** (`toOpenAIMessages()` in `src/providers/local-provider.ts`):
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

`assembleUserMessage()` remains unchanged — it continues to return `string` (the text portion of the user message).

A **new function** `assembleUserContent()` is added to merge the text message with media content blocks:

```typescript
export function assembleUserContent(
  text: string,
  mediaBlocks: ContentBlock[]
): string | ContentBlock[] {
  if (mediaBlocks.length === 0) return text;
  return [{ type: "text", text }, ...mediaBlocks];
}
```

- When there are no media blocks, returns the plain string (existing behavior preserved)
- When there are media blocks, returns `ContentBlock[]` with the text message as the first `{ type: "text" }` block, followed by image/document blocks

This keeps `assembleUserMessage()` simple (text-only assembly) and introduces a clear composition point that the orchestrator calls after both text and media are ready.

### 5.3 Orchestrator (`src/chat/orchestrator.ts`)

In `handleUserMessage()` (~lines 1206-1225):

1. `buildAttachmentsBlock()` now returns `{ text, contentBlocks }`
2. Text parts assembled via `assembleUserMessage()` as before (returns `string`)
3. `assembleUserContent(text, contentBlocks)` merges text and media → returns `string | ContentBlock[]`
4. Result stored as `Message.content` (persisted to JSONL history including any base64 media)
5. `toChatMessages()` passes `Message.content` through to `ChatMessage.content`
6. Providers handle both formats in their `toXxxMessages()` functions

**History persistence:** Media content (base64 image/document blocks) IS persisted in the JSONL history file as part of `Message.content`. This means image-heavy conversations will produce larger history files (a single image adds ~200–500KB). The existing `history_max_size_mb` (500MB) and `history_max_age_days` (90 days) settings provide sufficient guardrails. On replay, the full `ContentBlock[]` is restored from JSON, so images/PDFs are available when resuming a conversation.

**Preview extraction** (`history.ts:496`): already checks `typeof msg.content === "string"` before calling `.substring(0, 120)`. When `content` is `ContentBlock[]`, extract text from the first text block for the preview.

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

**Contract:** `content_blocks` is present ONLY when a tool produces media output (e.g., `read_file` on an image or PDF with native provider support). When `content_blocks` is present, `result` MUST still contain a text summary (e.g., `"Read image: photo.png (1200×800, image/png)"`). This ensures consumers that cannot handle media (sub-agents on text-only providers, export modules, search indexing) always have a meaningful fallback via the existing `result` field. When both are populated, providers that support media use `content_blocks`; all others fall back to `result`.

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

New settings subsection: "Images & PDFs" (`src/settings/sections/media.ts`), registered under the existing "Tool configuration" group in `src/settings/settings-tab.ts` (line 168) alongside the existing `renderDocxToolsSection` call.

---

## 7. Phased Implementation

### Phase 1: Foundation — Content Block System

**Goal:** Introduce `ContentBlock` type, update both `Message` and `ChatMessage` content types, make all four providers handle the union, and ensure all existing consumers compile and work correctly. No user-facing changes.

**Files to create:**
- `src/media/types.ts` — `ContentBlock`, `ImageMediaType`, `getTextContent()`, constants
- `src/media/format-detector.ts` — magic byte detection

**Files to modify:**
- `src/types.ts` — `Message.content: string | ContentBlock[]`
- `src/providers/provider.ts` — `ChatMessage.content: string | ContentBlock[]`
- `src/providers/anthropic-provider.ts` — `toAnthropicMessages()` handles `ContentBlock[]`
- `src/providers/openai-provider.ts` — `toOpenAIMessages()` handles `ContentBlock[]`
- `src/providers/bedrock-provider.ts` — `toBedrockMessages()` handles `ContentBlock[]`
- `src/providers/local-provider.ts` — `toOpenAIMessages()` handles `ContentBlock[]`
- `src/export/markdown-exporter.ts` — use `getTextContent()` at all `msg.content` read sites
- `src/export/html-exporter.ts` — use `getTextContent()` at all `msg.content` read sites
- `src/ui/chat-view.ts` — use `getTextContent()` at user message rendering sites
- `src/chat/sub-agent-history.ts` — pass-through (no changes needed, but verify union propagates)
- All other callsites that consume `content` as string (see table below)

**Callsite enumeration — all locations that read `content` as a plain string:**

*Provider layer:*

| File | Line(s) | Current code | Required change |
|------|---------|-------------|-----------------|
| `src/providers/anthropic-provider.ts` | 59 | `` `${system}\n\n${msg.content}` `` (system prompt concatenation) | Type-narrow: system messages are always string, add assertion or guard |
| `src/providers/anthropic-provider.ts` | 68 | `{ type: "text", text: msg.content }` | If `ContentBlock[]`, map to Anthropic content blocks directly |
| `src/providers/anthropic-provider.ts` | 97 | `content: msg.content` (assistant messages) | Pass through — assistant messages are always string (LLM output is text) |
| `src/providers/openai-provider.ts` | 60 | `content: msg.content \|\| null` | If `ContentBlock[]`, map to OpenAI content parts |
| `src/providers/openai-provider.ts` | 89 | `content: msg.content` | Same — map to OpenAI content parts when array |
| `src/providers/bedrock-provider.ts` | 83 | `system.push({ text: msg.content })` | Type-narrow: system messages always string |
| `src/providers/bedrock-provider.ts` | 91 | `content.push({ text: msg.content })` | If `ContentBlock[]`, map to Bedrock content blocks |
| `src/providers/bedrock-provider.ts` | 128 | `content: [{ text: msg.content }]` | If `ContentBlock[]`, map to Bedrock content blocks |
| `src/providers/local-provider.ts` | 88, 117 | Same as OpenAI patterns | Same fixes as OpenAI |

*Context & token estimation:*

| File | Line(s) | Current code | Required change |
|------|---------|-------------|-----------------|
| `src/chat/context.ts` | 89 | `let text = message.content` then string concat | Extract text: if `ContentBlock[]`, join text blocks; estimate media token cost separately |
| `src/chat/sub-agent-runner.ts` | 453 | `estimateTokenCount(msg.content)` | Handle union — extract text for estimation, add media token cost |
| `src/context/compaction.ts` | 80 | `estimateTokens(msg.content)` | `estimateContentTokens(msg.content)` |
| `src/context/compaction.ts` | 241 | `if (!msg.content?.trim()) continue;` | Use `getTextContent()` helper — `.trim()` doesn't exist on arrays |
| `src/context/compaction.ts` | 244 | `content: msg.content` (builds ChatMessage for summarization) | Pass through — both types accept the union. But note: media blocks in this message reach the summarization provider and should be stripped (see compaction safety below) |

*Orchestrator & history:*

| File | Line(s) | Current code | Required change |
|------|---------|-------------|-----------------|
| `src/chat/orchestrator.ts` | 2043, 2057 | `content: msg.content` (Message → ChatMessage) | Pass-through works — both types now accept the union |
| `src/chat/orchestrator.ts` | 2051 | `msg.content?.trim()` (empty assistant check) | Type-narrow: assistant content is always string |
| `src/chat/orchestrator.ts` | 2194 | `preToolCallText = prev.content` (absorbs pre-tool-call assistant text) | Type-narrow: `prev` is an assistant ChatMessage, content is always string. Add assertion or guard |
| `src/chat/orchestrator.ts` | 2103-2176 | Repair phase: injects synthetic `tool_result` with `content: ""` for orphaned tool calls | No change needed — all `content` fields are string literals (`""`). Verify compilation passes |
| `src/chat/orchestrator.ts` | 2178-2231 | Coalescing phase: merges consecutive tool_call/result messages. `content: preToolCallText` (string from assistant) and `content: ""` | No change needed — only constructs messages with string content, never propagates user `ContentBlock[]`. Verify compilation passes |
| `src/chat/sub-agent-history.ts` | 58, 78, 96 | `content: cm.content` (ChatMessage → Message conversion) | Pass-through works — both types now accept the union. No type-narrowing needed since the content is propagated as-is |
| `src/chat/history.ts` | 442 | `JSON.parse(message.content)` (compaction record detection) | Add type guard: only parse when `typeof message.content === "string"`. Only runs on system messages (always string), but guard prevents future regressions |
| `src/chat/history.ts` | 496 | `typeof msg.content === "string"` then `.substring(0, 120)` | Already guards! Add `ContentBlock[]` branch: extract first text block for preview |
| `src/chat/history.ts` | 587 | `typeof msg.content === "string"` then `.substring(0, 120)` | Same pattern as line 496 — duplicate preview logic in `searchConversations()`. Same fix: add `ContentBlock[]` branch |
| `src/chat/history.ts` | 590 | `typeof msg.content === "string"` then `.toLowerCase().includes(needle)` | Already type-guarded! For `ContentBlock[]`, search text blocks for the needle |

*Export modules:*

| File | Line(s) | Current code | Required change |
|------|---------|-------------|-----------------|
| `src/export/markdown-exporter.ts` | 95 | `msg.content` passed to `wrapCallout()` (hook injection) | Use `getTextContent()` — hook injections are always string, but add guard |
| `src/export/markdown-exporter.ts` | 99 | `let content = msg.content` then regex/slice | Use `getTextContent()` — user messages with media: extract text, append `[N image(s) attached]` marker |
| `src/export/markdown-exporter.ts` | 139 | `parts.push(msg.content)` (assistant messages) | Pass through — assistant messages are always string |
| `src/export/html-exporter.ts` | 394 | `escapeHtml(msg.content)` (hook injection) | Use `getTextContent()` |
| `src/export/html-exporter.ts` | 398 | `let content = msg.content` then regex/slice | Use `getTextContent()`. For HTML export, image blocks could optionally render as `<img src="data:...">` tags (Phase 4 enhancement) |
| `src/export/html-exporter.ts` | 438 | `marked.parse(msg.content)` (assistant messages) | Pass through — assistant messages are always string |
| `src/export/html-exporter.ts` | 556 | `msg.content.substring(0, 200)` (sub-agent system) | Use `getTextContent()` — system messages are always string, but add guard |
| `src/export/html-exporter.ts` | 558 | `escapeHtml(msg.content)` (sub-agent user) | Use `getTextContent()` |
| `src/export/html-exporter.ts` | 560 | `marked.parse(msg.content)` (sub-agent assistant) | Pass through — assistant messages are always string |

*UI (chat view):*

| File | Line(s) | Current code | Required change |
|------|---------|-------------|-----------------|
| `src/ui/chat-view.ts` | 1159 | `extractAttachmentsBlock(message.content)` (user message rendering) | Use `getTextContent()` — user messages with media are `ContentBlock[]`, but attachment XML extraction operates on the text portion only |
| `src/ui/chat-view.ts` | 1163 | `textToRender = ... remainder : message.content` (fallback text) | Use `getTextContent()` as fallback when no attachments XML found |
| `src/ui/chat-view.ts` | 1241 | `pre.createEl("code", { text: message.content })` (hook injection display) | Use `getTextContent()` — hook injections are always string, but add guard |
| `src/ui/chat-view.ts` | 1289 | `message.content` passed to `MarkdownRenderer.render()` (assistant finalization) | Pass through — assistant messages are always string (LLM output is text). Add assertion for safety |

**Export module strategy:** For Phase 1, all export callsites use `getTextContent()` to extract the text portion. Media blocks are silently omitted — the exported text still makes sense because the LLM's responses reference the images by description. In Phase 4, HTML export can optionally embed images as `<img src="data:...">` inline tags for rich exports.

**Context compaction safety:**

When compaction triggers on a conversation containing `ContentBlock[]` messages, media blocks must be stripped before summarization. The compaction logic in `src/chat/context.ts` should:
1. Extract only text blocks from `ContentBlock[]` content
2. Drop image/document blocks (they cannot be meaningfully summarized)
3. Append a `[N image(s)/document(s) omitted during compaction]` text marker

This prevents: (a) sending large base64 blobs to the summarization call, (b) type errors in compaction logic that assumes string content, (c) wasted tokens on image blocks during summarization.

**Media token estimation:**

Images and PDF documents consume significant tokens (e.g., ~1333 tokens for a 1000×1000 image on Anthropic, ~1500–3000 tokens per PDF page). The current character-based estimator (`text.length / 4` in `src/utils/tokens.ts:39`) cannot account for this — and critically, must NOT be applied to base64 `data` strings in media blocks. A 1MB PDF encoded as base64 produces ~1.33M characters, which the text formula would estimate at ~333K tokens, when the actual API cost is ~2000 tokens per page.

**Reference implementation research:**

- **Cline** does not estimate media tokens locally at all — it relies entirely on API-reported `usage.prompt_tokens` after the request completes. PDFs are text-extracted via `pdf-parse`, then estimated with the standard `text.length / 4` formula. Images are sent as base64 blocks with no local token cost estimate.
- **Claude Code** uses a flat **2000 tokens** per image or document block (`tokenEstimation.ts:400-411`, `microCompact.ts:38`). Anthropic's documented formula `(width * height) / 750` is referenced in a code comment but intentionally not used — the flat constant is simpler and avoids needing dimensions at estimation time. The same 2000 constant is used for both rough estimation and micro-compaction. A critical design insight: the base64 string of a PDF document block must NOT reach the text estimator — a 1MB PDF is ~1.33M base64 chars → ~333K estimated tokens via the text formula, vs the ~2000 tokens the API actually charges.

**Notor's advantage:** Unlike Claude Code, Notor processes all images through an Electron Canvas pipeline (§4.3) BEFORE they reach the estimation layer. This means the exact post-processing dimensions are known at `ContentBlock` creation time and can be stored on the block (§4.1). Similarly, the PDF processor will have page count available from the PDF library. This enables a dimension-aware formula instead of a flat constant.

**New function** — add `estimateContentTokens` to `src/utils/tokens.ts`:

```typescript
/**
 * Estimate tokens for message content that may be a plain string or
 * a ContentBlock array (text + image + document blocks).
 *
 * Uses Anthropic's documented image formula (width * height / 750) when
 * dimensions are available, with a flat 2000-token fallback per media
 * block when metadata is absent. This matches Claude Code's proven
 * conservative estimate while being more accurate when Notor's image
 * pipeline provides dimensions.
 *
 * For native PDF document blocks, estimates 2000 tokens per page (a
 * conservative midpoint between text-heavy ~1500 and complex ~3000
 * pages). Text-extracted PDFs appear as text blocks and are handled
 * by the standard text estimator — this function only estimates native
 * document blocks.
 */
export function estimateContentTokens(content: string | ContentBlock[]): number {
    if (typeof content === "string") return estimateTokenCount(content);
    let total = 0;
    for (const block of content) {
        switch (block.type) {
            case "text":
                total += estimateTokenCount(block.text);
                break;
            case "image":
                total += estimateImageTokens(block.width, block.height);
                break;
            case "document":
                total += estimateDocumentTokens(block.page_count);
                break;
        }
    }
    return total;
}

function estimateImageTokens(width?: number, height?: number): number {
    if (width && height) return Math.ceil((width * height) / 750);
    return 2000; // fallback: Claude Code's proven flat estimate
}

function estimateDocumentTokens(pageCount?: number): number {
    if (pageCount) return pageCount * 2000;
    return 2000; // fallback: single-block estimate for unknown page count
}
```

**Formula rationale:**

| Approach | Pros | Cons | Decision |
|----------|------|------|----------|
| Flat 2000 per block (Claude Code) | Simple, proven | Underestimates large images (2000×2000 = 5333 actual), overestimates small (200×200 = 53 actual) | **Fallback only** |
| Anthropic formula `(w×h)/750` | Accurate for Anthropic/Bedrock; Notor has dimensions available | Overestimates for OpenAI by ~1.7× typical, up to ~7× for max-size images | **Primary for images** |
| Provider-specific formulas | Most accurate per provider | Requires plumbing provider identity into utility layer; three formulas to maintain | **Deferred to Phase 4** |
| Base64 size heuristic | No metadata needed | Wildly inaccurate — base64 size bears no relation to API token cost | **Rejected** |
| No estimation / API-only (Cline) | Zero estimation error | Cannot track context usage until after API call; compaction cannot trigger preemptively | **Rejected** |

Using Anthropic's formula as the universal default is acceptable. The worst-case overestimation occurs for OpenAI with a max-size 2000×2000 image: 5333 estimated vs ~765 actual (~7×). For typical images (1000×1000): 1333 estimated vs ~765 actual (~1.7×). Overestimation causes compaction to trigger marginally earlier — a benign outcome that wastes a small amount of context space but never risks context overflow. The alternative (underestimation) risks context overflow before compaction activates, which is a user-visible failure.

**Callsite updates** — replace `estimateTokenCount(msg.content)` / `estimateTokens(msg.content)` with `estimateContentTokens(msg.content)` at all three estimation callsites:

| File | Line(s) | Current | Updated |
|------|---------|---------|---------|
| `src/chat/context.ts` | 89–100 | `let text = message.content; text += ...; return estimateTokenCount(text)` | Restructure: `let total = estimateContentTokens(message.content);` then `total += estimateTokenCount(JSON.stringify(...))` for tool call/result portions (see note below) |
| `src/context/compaction.ts` | 80 | `estimateTokens(msg.content)` | `estimateContentTokens(msg.content)` |
| `src/chat/sub-agent-runner.ts` | 453 | `estimateTokenCount(msg.content)` | `estimateContentTokens(msg.content)` |

**`context.ts` restructuring note:** The current code at line 89 assigns `message.content` to `let text`, then concatenates tool call JSON via `+=` at lines 93–97, then calls `estimateTokenCount(text)`. When `content` is `ContentBlock[]`, the `+=` concatenation would produce nonsense (`"[object Object],[object Object]{...}"`). The fix splits estimation into a content portion (via `estimateContentTokens`) and a tool metadata portion (via `estimateTokenCount` on the JSON-stringified parameters), then sums them.

**ToolResult media estimation (Phase 2):** When `ToolResult.content_blocks` is added (§5.4), the tool result estimation paths in `context.ts:92–98` and `compaction.ts:88–93` must also account for media blocks in tool results. The `estimateContentTokens` function can be reused: `estimateContentTokens(msg.tool_result.content_blocks)` when the field is present.

**Future Phase 4 refinement:** When provider-specific accuracy matters (e.g., a user on OpenAI hits compaction too early due to image overestimation), add a `provider?: string` parameter to `estimateImageTokens` and implement OpenAI's tile-based formula: `170 × ceil(w/512) × ceil(h/512) + 85` (high detail). This is deferred because: (a) overestimation is benign, (b) the provider identity is not currently available in the token estimation utility layer, and (c) it only matters for image-heavy conversations on non-Anthropic providers.

**Sub-agent media propagation:**

With the union type on `Message.content`, media naturally flows to sub-agents via the existing message passing in `src/chat/sub-agent-runner.ts`. The token estimator fix (callsite table above) ensures sub-agent token budgets account for media. Provider capability checks at send time handle format compatibility — if a sub-agent's provider doesn't support images, the provider's `toXxxMessages()` should strip unsupported media blocks and include a text placeholder.

**Verification:** Existing conversations work identically (all content remains strings). Unit tests for format detection. TypeScript compilation succeeds with zero type errors at all callsites listed above.

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
- `src/context/message-assembler.ts` — add `assembleUserContent()` function (§5.2)
- `src/chat/orchestrator.ts` — call `assembleUserContent()` to merge text + media blocks
- `src/ui/attachment-picker.ts` — accept image files, binary read
- `src/ui/attachment-chips.ts` — image chip display
- `src/settings/types.ts` — image settings
- `src/settings/defaults.ts` — default values
- `src/settings/settings-tab.ts` — register new "Images & PDFs" section

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

- Handle MCP tool results with images (currently omitted with `[N image(s) omitted]`)
- Drag-and-drop support for images/PDFs on chat input
- Image thumbnail preview in attachment chips
- Provider-specific image token formulas (OpenAI tile-based, Gemini per-token) to reduce overestimation for non-Anthropic providers in image-heavy conversations
- E2E test coverage

---

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| PDF library too large for plugin bundle | Build size doubles, slow Obsidian startup | Evaluate bundle impact early (§3.3). Fall back to lighter library. Consider lazy loading via dynamic `import()`. |
| Canvas API resize quality poor | Blurry images sent to API | Test at various scales during Phase 2. JPEG at quality 80 on canvas is generally good. Keep PNG path for screenshots/diagrams. |
| Provider rejects image/document format | Errors during conversation | Capability detection (§4.6) prevents sending unsupported formats. Graceful fallback to text extraction. |
| `Message.content` / `ChatMessage.content` type change regressions | Broken conversations, compile errors | Phase 1 enumerates all ~39 callsites that consume content as string (§7), including providers, context/estimation, orchestrator/history, UI, and export modules. TypeScript compiler catches any missed sites. |
| Large images/PDFs cause memory pressure | Plugin crashes or OOM | Enforce size limits (20MB max file, 5MB max base64). Process one attachment at a time. |
| Canvas not available in all Obsidian contexts | Image processing fails | All processing runs in renderer process where Canvas is available. Verify in Phase 2. |
| Binary content increases history file sizes | Larger JSONL files on disk, expensive line parsing | Media IS persisted inline as base64. Existing `history_max_size_mb` (500MB) and `history_max_age_days` (90 days) provide guardrails. A conversation with 10 images adds ~2–5MB. **Known scaling concern:** image-heavy users could hit the 500MB limit much faster than text-only users, and individual JSONL lines of 500KB+ are expensive to parse for sidebar previews. If this becomes a problem in practice, a Phase 4+ optimization could store media as separate files (`history/media/{hash}.{ext}`) referenced by hash in ContentBlocks, keeping JSONL lean and enabling cross-conversation deduplication. |
| Context compaction encounters media blocks | Wasted tokens, type errors, API failures | Phase 1 adds compaction safety: strip media blocks before summarization, append `[omitted]` marker. **Known limitation:** after compaction, images/documents are permanently lost from the conversation context. If the user discussed an image ("describe this diagram") and compaction triggers, the summary retains the LLM's text description but the original image is gone. This matches Claude Code's behavior and is acceptable — the LLM's summary of "the user asked about a diagram showing X and I described Y" preserves the semantic content even without the raw image. |
| Media token estimation inaccuracy | Context overflow or premature compaction | Dimension-aware formula `(w×h)/750` for images with known dimensions; flat 2000-token fallback otherwise. Per-page estimate for PDFs. Overestimates for OpenAI (benign: compaction triggers earlier, not later). Provider-specific formulas deferred to Phase 4. |

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

**Step 2 — Add async image pre-resolution pass in `generateDocx()`.** Both `buildDocxChildren()` (line 108) and `renderInline()` (line 53) are synchronous. The `docx` library's constructors (`Paragraph`, `Table`, `ImageRun`) expect synchronous children arrays. Making either function async would require restructuring all constructor call sites. Instead, resolve all images before the synchronous rendering pass:

```typescript
// In generateDocx(), after marked.lexer() but before buildDocxChildren():

function collectImageHrefs(tokens: Token[]): string[] {
  const hrefs: string[] = [];
  for (const token of tokens) {
    // Image tokens are inline, nested inside paragraphs, blockquotes, list items, etc.
    if (token.type === "image") {
      hrefs.push((token as Tokens.Image).href);
    }
    // Recurse into child tokens (paragraphs, blockquotes, table cells)
    if ("tokens" in token && Array.isArray(token.tokens)) {
      hrefs.push(...collectImageHrefs(token.tokens));
    }
    // Recurse into list items
    if ("items" in token && Array.isArray(token.items)) {
      for (const item of token.items) {
        if (item.tokens) hrefs.push(...collectImageHrefs(item.tokens));
      }
    }
  }
  return hrefs;
}

const imageHrefs = collectImageHrefs(tokens);
const resolvedEntries = await Promise.all(
  imageHrefs.map(async (h) => [h, await resolveImageForDocx(h, vaultRoot, allowedPaths)] as const)
);
const resolvedImages = new Map(resolvedEntries);
// Pass resolvedImages into buildDocxChildren() as a parameter
```

**Step 3 — Handle images in the `paragraph` case of `buildDocxChildren()`.**

In marked v17 (`^17.0.4`), standalone images are parsed as inline `image` tokens wrapped in a `paragraph` token — NOT as top-level `image` block tokens. For example, `![alt](url)` is lexed as:

```json
{ "type": "paragraph", "tokens": [{ "type": "image", "href": "url", "text": "alt" }] }
```

Detect single-image paragraphs in the existing `paragraph` case (line 125-130) and render them as dedicated image paragraphs:

```typescript
case "paragraph": {
  const p = token as Tokens.Paragraph;
  // Standalone image: paragraph with exactly one image child token
  if (p.tokens?.length === 1 && p.tokens[0].type === "image") {
    const img = p.tokens[0] as Tokens.Image;
    const imageData = resolvedImages.get(img.href); // synchronous lookup
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
      result.push(new Paragraph({
        children: [new TextRun({ text: `[Image: ${img.href}]` })],
      }));
    }
  } else {
    // Normal paragraph (no image, or mixed image+text) — existing path
    result.push(new Paragraph({ children: renderInline(p.tokens ?? []) }));
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

**Fix — including rId conflict resolution:**

Both the template and generated document independently assign relationship IDs (`rId1`, `rId2`, etc.). Naively merging relationships would cause collisions — e.g., the template's `rId2 → settings.xml` could be overwritten by the generated doc's `rId2 → media/image1.png`. The fix requires remapping generated rIds to avoid conflicts.

Use `@xmldom/xmldom` (`^0.8.11`, already a direct dependency) to parse and merge the XML.

**Algorithm:**

```
1. Parse template's word/_rels/document.xml.rels
2. Find the highest rId number in the template (e.g., rId5 → maxId = 5)
3. Parse generated doc's word/_rels/document.xml.rels
4. Collect ALL relationships from the generated doc (not just image/media —
   also hyperlinks, headers, footers, etc. that may have been generated)
5. Build a remap table: for each generated relationship rIdN,
   assign a new ID rId(maxId + offset) where offset increments from 1
   Example: generated rId2 → rId6, generated rId3 → rId7
6. Update the generated word/document.xml body content:
   replace all rId references using the remap table
   (regex on both r:embed="rIdN" AND r:id="rIdN" attributes)
7. Append remapped <Relationship> elements to the template's .rels XML
8. Copy all word/media/* files from generated ZIP into template ZIP
9. Parse both [Content_Types].xml files:
   - For each image extension in the generated doc (png, jpg, gif, bmp),
     add a <Default Extension="png" ContentType="image/png"/> entry
     to the template's [Content_Types].xml if not already present
10. Write updated .rels and [Content_Types].xml back to template ZIP
```

**Edge cases:**
- Template has no existing images: maxId is determined from non-image relationships (styles, settings, etc.)
- Generated doc has no images: skip the entire merge (no media to copy)
- Duplicate media filenames: the `docx` library generates unique filenames (`image1.png`, `image2.png`), so collisions with template media are unlikely but should be checked — if a filename exists, rename with a numeric suffix

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
