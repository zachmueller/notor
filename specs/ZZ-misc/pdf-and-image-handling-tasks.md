# Implementation Tasks: PDF & Image Handling

**Source:** [pdf-and-image-handling-design.md](pdf-and-image-handling-design.md)
**Created:** 2026-04-05

---

## Phase 1: Foundation — Content Block System

**Goal:** Introduce `ContentBlock` type, update `Message` and `ChatMessage` content types from `string` to `string | ContentBlock[]`, make all providers handle the union, fix all read-side callsites, and add media-aware token estimation. No user-facing changes — existing conversations remain string-only.

### 1.1 New Files

- [ ] **Create `src/media/types.ts`**
  - Define `ImageMediaType` union (`"image/png" | "image/jpeg" | "image/gif" | "image/webp"`)
  - Define `ContentBlock` discriminated union (text, image, document)
    - `text`: `{ type: "text"; text: string }`
    - `image`: `{ type: "image"; media_type: ImageMediaType; data: string; width?: number; height?: number }`
    - `document`: `{ type: "document"; media_type: "application/pdf"; data: string; page_count?: number }`
  - Export `getTextContent(content: string | ContentBlock[]): string` helper
  - Export media limit constants (e.g., `MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024`)

- [ ] **Create `src/media/format-detector.ts`**
  - Implement magic byte detection for: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), GIF (`47 49 46`), WebP (`52 49 46 46...57 45 42 50`), PDF (`25 50 44 46`)
  - Export `detectMediaFormat(buffer: Buffer): "png" | "jpeg" | "gif" | "webp" | "pdf" | null`
  - Unit tests for each format + unknown binary

### 1.2 Core Type Changes

- [ ] **Update `src/types.ts:107`** — Change `Message.content` from `string` to `string | ContentBlock[]`
  - Import `ContentBlock` from `../media/types`

- [ ] **Update `src/providers/provider.ts:25`** — Change `ChatMessage.content` from `string` to `string | ContentBlock[]`
  - Import `ContentBlock` from `../media/types`

### 1.3 Provider Layer — Handle `ContentBlock[]` in `toXxxMessages()`

Each provider's message conversion function must handle the case where `msg.content` is `ContentBlock[]` instead of `string`. System and assistant messages are always strings (system prompts are text, LLM output is text). User messages may be `ContentBlock[]` when media is attached.

- [ ] **`src/providers/anthropic-provider.ts` — `toAnthropicMessages()`**
  - Line 59: System message concatenation — add assertion/guard that system content is string
  - Lines 67-68: User content `{ type: "text", text: msg.content }` — when `ContentBlock[]`, map to Anthropic native blocks:
    - text → `{ type: "text", text }`
    - image → `{ type: "image", source: { type: "base64", media_type, data } }`
    - document → `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`
  - Line 97: Assistant `content: msg.content` — assert string (LLM output is always text)

- [ ] **`src/providers/openai-provider.ts` — `toOpenAIMessages()`**
  - Line 60: `content: msg.content || null` — when `ContentBlock[]`, map to OpenAI content parts:
    - text → `{ type: "text", text }`
    - image → `{ type: "image_url", image_url: { url: "data:{media_type};base64,{data}" } }`
    - document → extract text block only (PDFs pre-converted to text for OpenAI)
  - Line 89: Assistant `content: msg.content` — assert string

- [ ] **`src/providers/bedrock-provider.ts` — `toBedrockMessages()`**
  - Line 83: System `{ text: msg.content }` — assert string
  - Lines 90-91: User content `{ text: msg.content }` — when `ContentBlock[]`, map to Bedrock blocks:
    - text → `{ text }`
    - image → `{ image: { format, source: { bytes: Buffer.from(data, "base64") } } }`
    - document → `{ document: { format: "pdf", name: "document.pdf", source: { bytes: Buffer.from(data, "base64") } } }`
  - Line 128: `content: [{ text: msg.content }]` — same mapping

- [ ] **`src/providers/local-provider.ts` — `toOpenAIMessages()`**
  - Line 88: `content: msg.content || null` — same fix as OpenAI provider
  - Line 117: `content: msg.content` — assert string for assistant

### 1.4 Token Estimation — Media-Aware

- [ ] **Add `estimateContentTokens()` to `src/utils/tokens.ts`**
  - Import `ContentBlock` from `../media/types`
  - Implement `estimateContentTokens(content: string | ContentBlock[]): number`
    - String input: delegate to existing `estimateTokenCount()`
    - `ContentBlock[]`: sum per-block estimates:
      - text: `estimateTokenCount(block.text)`
      - image: `(width * height) / 750` when dimensions known, else flat `2000`
      - document: `pageCount * 2000` when known, else flat `2000`
  - Private helpers: `estimateImageTokens(w?, h?)`, `estimateDocumentTokens(pageCount?)`
  - Unit tests covering: string input, text-only blocks, image with/without dimensions, document with/without page count, mixed content

- [ ] **Update `src/chat/context.ts:89-100`** — `estimateMessageTokens()`
  - Replace `let text = message.content; text += ...; return estimateTokenCount(text)` with:
    - `let total = estimateContentTokens(message.content);`
    - `total += estimateTokenCount(JSON.stringify(message.tool_call?.parameters))` (when present)
    - `total += estimateTokenCount(typeof result === "string" ? result : JSON.stringify(result))` (when present)
    - `return total;`

- [ ] **Update `src/context/compaction.ts:80`** — `estimateConversationTokens()`
  - Replace `estimateTokens(msg.content)` with `estimateContentTokens(msg.content)`

- [ ] **Update `src/chat/sub-agent-runner.ts:453`** — `estimateConversationTokens()`
  - Replace `estimateTokenCount(msg.content)` with `estimateContentTokens(msg.content)`

### 1.5 Context Compaction — Strip Media Before Summarization

- [ ] **Update `src/context/compaction.ts:241`** — Empty content check
  - Replace `if (!msg.content?.trim()) continue;` with `getTextContent()` usage:
    - `const text = getTextContent(msg.content); if (!text.trim()) continue;`

- [ ] **Update `src/context/compaction.ts:244`** — Compaction message building
  - When `msg.content` is `ContentBlock[]`:
    - Extract only text blocks via `getTextContent()`
    - Count omitted media blocks
    - Append `[N image(s)/document(s) omitted during compaction]` text marker
    - Assign the text-only content to the `ChatMessage` to prevent base64 blobs reaching the summarization call

### 1.6 Orchestrator & History — Handle Union Type

- [ ] **`src/chat/orchestrator.ts:2051`** — Empty assistant content check
  - `msg.content?.trim()` — assert string (assistant content is always string from LLM)

- [ ] **`src/chat/orchestrator.ts:2194`** — `preToolCallText = prev.content`
  - Assert string (prev is assistant message, always string)

- [ ] **`src/chat/orchestrator.ts:2043, 2057`** — `content: msg.content` pass-through
  - No change needed (both types accept the union), but add comments noting user content may be `ContentBlock[]`

- [ ] **`src/chat/orchestrator.ts:2103-2176, 2178-2231`** — `toChatMessages()` repair & coalescing phases
  - **Repair phase** (lines 2103-2176): Injects synthetic `tool_result` messages for orphaned tool calls. All `content` fields are string literals (`""`) — no change needed, but verify compilation
  - **Coalescing phase** (lines 2178-2231): Merges consecutive tool_call/tool_result messages. Line 2194 is covered above. Coalesced messages use `content: preToolCallText` (string, from assistant) and `content: ""` (string literal) — no change needed, but verify compilation
  - Both phases are safe because they only construct messages with string content, never propagate user `ContentBlock[]`

- [ ] **`src/chat/history.ts:442`** — `JSON.parse(message.content)`
  - Add type guard: `if (typeof message.content !== "string") return null;` before JSON parse
  - System messages are always string, but guard prevents future regressions

- [ ] **`src/chat/history.ts:496-497`** — Preview generation
  - Current: `typeof msg.content === "string"` guard exists, then `.substring(0, 120)`
  - Add `ContentBlock[]` branch: extract first text block via `getTextContent()`, then `.substring(0, 120)`

- [ ] **`src/chat/history.ts:587-590`** — Search conversations
  - Line 587: Same preview fix as line 496
  - Line 590: For `ContentBlock[]`, search text blocks: `getTextContent(msg.content).toLowerCase().includes(needle)`

- [ ] **`src/chat/conversation.ts:348`** — `generateTitle(params.content)` **(compile error)**
  - `generateTitle()` is declared as `private generateTitle(content: string)` at line 478 and immediately calls `.replace()` on its argument — passing `ContentBlock[]` produces `"[object Object]..."` as the title
  - This is a **TypeScript compile error site** after the type change, not just a pass-through
  - Wrap: `this.generateTitle(typeof params.content === "string" ? params.content : getTextContent(params.content))`

- [ ] **`src/chat/sub-agent-history.ts:58, 78, 96`** — `content: cm.content` pass-through
  - No change needed (both `ChatMessage` and `Message` accept the union)
  - Verify TypeScript compilation passes

### 1.7 Export Modules — Use `getTextContent()`

- [ ] **`src/export/markdown-exporter.ts`**
  - Line 95: `wrapCallout("info", "Hook output", msg.content, true)` — wrap with `getTextContent()` (hook injections are always string, but guard for type safety)
  - Line 99: `let content = msg.content` then regex/slice operations — use `getTextContent(msg.content)` for the text portion
  - Line 139: `parts.push(msg.content)` — assert string (assistant messages always string)

- [ ] **`src/export/html-exporter.ts`**
  - Line 394: `escapeHtml(msg.content)` — wrap with `getTextContent()`
  - Line 398: `let content = msg.content` then regex/slice — use `getTextContent(msg.content)`
  - Line 438: `marked.parse(msg.content)` — assert string (assistant always string)
  - Line 556: `msg.content.substring(0, 200)` + `.length` — use `getTextContent()`
  - Line 558: `escapeHtml(msg.content)` — use `getTextContent()`
  - Line 560: `marked.parse(msg.content)` — assert string (assistant always string)

### 1.8 UI — Handle Union in Chat View

- [ ] **`src/ui/chat-view.ts`**
  - Line 1159: `extractAttachmentsBlock(message.content)` — pass `getTextContent(message.content)` (attachment XML is in the text portion)
  - Line 1163: `textToRender = ... : message.content` — use `getTextContent(message.content)` as fallback
  - Line 1241: `pre.createEl("code", { text: message.content })` — use `getTextContent()` (hook injections are string, but guard)
  - Line 1289: `MarkdownRenderer.render(..., message.content, ...)` — assert string (assistant messages always string)

### 1.9 Verification

- [ ] **TypeScript compilation** — `npm run build` succeeds with zero type errors across all modified files
- [ ] **Unit tests pass** — `npm test` for existing tests (no regressions)
- [ ] **Unit tests for new code** — `src/media/types.test.ts` (getTextContent), `src/media/format-detector.test.ts`, token estimation tests
- [ ] **Manual smoke test** — Open existing conversation, send a message, verify content flows through correctly as plain string

---

## Phase 2: Image Handling

**Goal:** Full image support via the `read_file` tool and the attachment system. Users can attach images from vault or filesystem; the LLM receives them as vision content.

### 2.1 New Files

- [ ] **Create `src/media/image-processor.ts`**
  - Use Electron Canvas API (zero new dependencies) for resize + compress
  - Implement pipeline: buffer → magic byte detect → Image() load → validate dimensions → resize if >2000px → compress → base64
  - Format-aware compression cascade:
    - PNG: try PNG first → if >5MB, cascade JPEG 80 → 60 → 40
    - JPEG: try quality 80 → 60 → 40 → 20
    - GIF/WebP: convert to PNG first, then PNG cascade
  - Export `processImage(buffer: Buffer, mediaType: ImageMediaType): Promise<ContentBlock>`
  - Return `ContentBlock` with `width`/`height` metadata populated from Canvas
  - Unit tests for: dimension validation, resize logic, compression cascade, format detection

- [ ] **Create `src/media/capabilities.ts`**
  - Define `MediaCapabilities` interface: `supportsImages`, `supportsNativePdf`, `maxImageSizeBytes`, `maxDocumentSizeBytes`, `maxMediaItems`
  - Export `getMediaCapabilities(providerType: string): MediaCapabilities`
  - Provider capability table:
    - Anthropic: images yes, native PDF yes, 5MB image, 32MB doc, 100 items
    - OpenAI: images yes, native PDF no, 20MB image, N/A doc, 50 items
    - Bedrock: images yes, native PDF yes, 3.75MB image, 4.5MB doc, 20 items
    - Local: images attempt, native PDF no, 5MB image, N/A doc, 10 items

- [ ] **Create `src/settings/sections/media.ts`** — "Images & PDFs" settings section
  - Setting: `image_max_dimension` (number, default 2000)
  - Setting: `image_compression_quality` (number, default 80)
  - Register in `src/settings/settings-tab.ts` under the existing "Tool configuration" group (line 168: `const toolConfigGroup = createSettingsGroup(...)`) — add `renderMediaSection(toolConfigGroup, ctx);` alongside the existing `renderDocxToolsSection` call

### 2.2 Type Extensions

- [ ] **Update `src/types.ts`** — Add `content_blocks` to `ToolResult`
  - `content_blocks?: ContentBlock[]` — optional media output from tool execution
  - Contract: when present, `result` field still contains a text summary for fallback

### 2.3 Tool Changes — Extend `read_file`

- [ ] **Update `src/tools/read-file.ts`**
  - Update `description` to mention image support (PNG, JPEG, GIF, WebP)
  - At line 137 (binary detection via null bytes), insert format detection before rejection:
    1. Read buffer (existing)
    2. Call `detectMediaFormat(buffer)` from `format-detector.ts`
    3. If image format detected → process via `processImage()` → return `ToolResult` with `content_blocks` containing the image block + text summary in `result` (e.g., `"Read image: photo.png (1200x800, image/png)"`)
    4. If PDF → skip for now (Phase 3)
    5. If other binary → reject as before (existing behavior)
    6. If text → existing text path unchanged

### 2.4 Attachment System — Image Support

- [ ] **Update `src/context/attachment.ts`**
  - Add attachment types: `"vault_image"`, `"external_image"` to `AttachmentType` union
  - Add fields to `Attachment` interface:
    - `binary_content: string | null` — base64-encoded binary for images/PDFs
    - `media_type: string | null` — detected MIME type (e.g., `"image/png"`)
  - Add factory: `createVaultImageAttachment(path: string): Attachment`
  - Add factory: `createExternalBinaryAttachment(absolutePath: string, filename: string, base64: string, mediaType: string): Attachment`
  - Update `resolveAttachment()`:
    - For `vault_image`: read binary via `app.vault.readBinary(file)`, process through image pipeline, store base64 in `binary_content`
  - Update `buildAttachmentsBlock()` return type:
    - From: `string | null`
    - To: `{ text: string | null; contentBlocks: ContentBlock[] }`
    - Text attachments continue as XML string; image attachments produce `ContentBlock` entries

### 2.5 Message Assembly — Merge Text + Media

- [ ] **Update `src/context/message-assembler.ts`**
  - Add `assembleUserContent(text: string, mediaBlocks: ContentBlock[]): string | ContentBlock[]`
    - If no media blocks → return plain string (existing behavior preserved)
    - If media blocks → return `[{ type: "text", text }, ...mediaBlocks]`
  - **Note:** The existing `MessageParts` interface keeps `attachments?: string` unchanged — it receives only the text portion from the destructured `buildAttachmentsBlock()` return value. The `contentBlocks` are handled separately via `assembleUserContent()`.

- [ ] **Update `src/chat/orchestrator.ts` (~lines 1206-1225)**
  - `buildAttachmentsBlock()` (called at line 1224) now returns `{ text, contentBlocks }`
  - Destructure: `const { text: attachmentsText, contentBlocks } = buildAttachmentsBlock(resolvedAttachments);`
  - Pass `attachmentsText` (not the full return value) to `assembleUserMessage({ attachments: attachmentsText ?? undefined, ... })` — the `MessageParts.attachments` field remains `string`
  - Call `assembleUserContent(assembledText, contentBlocks)` to merge
  - Store result as `Message.content` (persisted to JSONL including base64)

### 2.6 Tool Result Media Propagation

The dispatcher (`src/chat/dispatcher.ts`) does **not** need changes — it already passes `ToolResult` objects through intact via `onToolCallResult`. The real gap is the `ChatMessage.tool_results` type and the `toChatMessages()` mapping in the orchestrator.

**Current flow:** `ToolResult` (with new `content_blocks`) → stored on `Message.tool_result` → `toChatMessages()` at orchestrator.ts:2081 maps it to `ChatMessage.tool_results[]` entry → providers read `tr.result` (string only). The `content_blocks` field is lost in the `toChatMessages()` mapping because `ChatMessage.tool_results[]` has no `content_blocks` field.

- [ ] **Update `src/providers/provider.ts:30-35`** — Extend `ChatMessage.tool_results[]` entry type
  - Add `content_blocks?: ContentBlock[]` to the tool result entry interface
  - Current interface: `{ tool_call_id: string; tool_name: string; result: string; is_error: boolean }`
  - Add: `content_blocks?: ContentBlock[]`

- [ ] **Update `src/chat/orchestrator.ts:2081-2093`** — `toChatMessages()` tool result mapping
  - Current: maps `msg.tool_result` → `{ tool_call_id, tool_name, result: resultStr, is_error }`
  - Add: copy `content_blocks` from `msg.tool_result.content_blocks` when present

- [ ] **Update provider `toXxxMessages()` functions** — Format `content_blocks` in tool results
  - Anthropic (line 88): `content: tr.result` → when `tr.content_blocks` present, map to array: `[{ type: "text", text: tr.result }, ...mappedMediaBlocks]`; Anthropic `tool_result` content arrays natively support image blocks alongside text
  - OpenAI (line 79): `content: tr.result` → when `tr.content_blocks` present, map to multipart content array with `image_url` entries
  - Bedrock (line 115): `content: [{ text: tr.result }]` → when `tr.content_blocks` present, append image/document blocks to the content array
  - Local (line 107): same as OpenAI

### 2.7 UI Changes

- [ ] **Update `src/ui/attachment-picker.ts`**
  - Expand `openExternalFileDialog()` accepted extensions (line 584-586):
    - Add: `.png,.jpg,.jpeg,.gif,.webp`
  - Add `readExternalBinaryFile()` function for binary file reading (base64 encode)
  - Route image files to binary read path instead of UTF-8 text read
  - Update `VaultNoteSuggest` to show image files from vault (not just `.md`)

- [ ] **Update `src/ui/attachment-chips.ts`**
  - Add image-specific chip rendering (image icon instead of paper clip)
  - Consider small thumbnail preview for image chips (or defer to Phase 4)

### 2.8 Settings

- [ ] **Update `src/settings/types.ts`** — Add to `NotorSettings`:
  - `image_max_dimension: number` (default: 2000)
  - `image_compression_quality: number` (default: 80)

- [ ] **Update `src/settings/defaults.ts`** — Add defaults for new settings

### 2.9 Verification

- [ ] **Manual test: Attachment picker** — Attach image via file dialog → chip appears with image icon → send message → model describes image content
- [ ] **Manual test: read_file tool** — LLM calls `read_file` on a `.png` → receives image block → describes image
- [ ] **Manual test: Provider compatibility** — Test with Anthropic and OpenAI providers
- [ ] **Unit tests** — image-processor pipeline, capabilities lookup, attachment factory functions
- [ ] **Build check** — `npm run build` succeeds, bundle size increase is acceptable (<100KB for new code, no new deps)

---

## Phase 3: PDF Handling

**Goal:** Full PDF support via `read_file` tool and attachments. Native document blocks for Anthropic/Bedrock; text extraction fallback for OpenAI/Local.

### 3.1 PDF Library Evaluation

- [ ] **Run library evaluation** (per design spec section 3.3)
  - Create `e2e/scripts/pdf-library-eval.ts`
  - Install candidates as dev deps: `unpdf`, `pdf-parse-new`
  - Test against representative PDFs: plain text, tables, multi-column, large (100+ pages), scanned
  - Measure: extraction time, character count, page-level support, errors
  - Test esbuild bundling compatibility (platform: node, format: cjs, target: es2018)
  - Measure bundle size impact (current: 3.2MB, target: <500KB additional)
  - **Decision gate:** Pick winning library before proceeding

### 3.2 New Files

- [ ] **Create `src/media/pdf-processor.ts`**
  - Install chosen PDF library as production dependency in `package.json`
  - Implement text extraction path:
    - Load PDF via library → extract text (full or page range) → clean (normalize whitespace, remove control chars) → truncate to configurable limit (default 400K chars)
  - Implement native document block path:
    - Magic byte check (`%PDF-`) → base64 encode raw buffer → size check against provider limits → return `ContentBlock { type: "document" }`
  - Page range support: parse `"1-5"`, `"3"`, `"10-20"` syntax (1-indexed)
  - Consult `getMediaCapabilities()` to decide native vs text path
  - Export `processPdf(buffer: Buffer, options: { pages?: string; providerType: string }): Promise<{ contentBlocks: ContentBlock[]; textSummary: string }>`

### 3.3 Tool Changes — Extend `read_file` for PDFs

- [ ] **Update `src/tools/read-file.ts`**
  - Add `pages` parameter to `input_schema`: `{ type: "string", description: "Page range for PDF files (e.g. '1-5', '3', '10-20'). Ignored for non-PDF files." }`
  - Update `description` to mention PDF support
  - In the format detection branch (added in Phase 2):
    - If PDF detected → process via `processPdf()` → return `ToolResult` with `content_blocks` (native doc block or text) + text summary in `result`
    - When `pages` param provided, force text extraction path

### 3.4 Attachment System — PDF Support

- [ ] **Update `src/context/attachment.ts`**
  - Add attachment types: `"vault_pdf"`, `"external_pdf"` to `AttachmentType`
  - Add factory: `createVaultPdfAttachment(path: string): Attachment`
  - Update `resolveAttachment()` for PDF types:
    - Read binary via `app.vault.readBinary(file)` or `fs.promises.readFile()`
    - Process through PDF pipeline (native or text extraction based on active provider)
    - Store base64 in `binary_content`
  - Update `buildAttachmentsBlock()` to produce PDF `ContentBlock` entries

### 3.5 UI Changes

- [ ] **Update `src/ui/attachment-picker.ts`**
  - Add `.pdf` to accepted extensions in `openExternalFileDialog()`
  - Route PDF files to binary read path

- [ ] **Update `src/ui/attachment-chips.ts`**
  - Add PDF-specific chip rendering (PDF icon)

### 3.6 Settings

- [ ] **Update `src/settings/types.ts`** — Add to `NotorSettings`:
  - `pdf_native_max_size_mb: number` (default: 10)
  - `pdf_text_max_chars: number` (default: 400000)
  - `pdf_prefer_native: boolean` (default: true)

- [ ] **Update `src/settings/defaults.ts`** — Add defaults for PDF settings

- [ ] **Update `src/settings/sections/media.ts`** — Add PDF settings to the "Images & PDFs" subsection (under "Tool configuration" group)

### 3.7 Verification

- [ ] **Manual test: Anthropic** — Attach PDF → provider receives native document block → model summarizes PDF
- [ ] **Manual test: OpenAI** — Attach PDF → provider receives extracted text → model summarizes PDF
- [ ] **Manual test: read_file with pages** — `read_file` on PDF with `pages: "1-5"` → correct pages extracted
- [ ] **Manual test: Edge cases** — Encrypted PDF (graceful error), image-only PDF (no text layer → empty text warning), corrupt PDF (graceful error)
- [ ] **Unit tests** — PDF processor, page range parsing, provider capability routing
- [ ] **Build check** — Bundle size acceptable with new PDF dependency

---

## Phase 2.5: DOCX Image Handling

**Goal:** Add image extraction in `read_docx` (save to vault) and image embedding in `write_docx` (read from vault). Independent of the Content Block System — pure filesystem I/O.

### 2.5.1 Type Declarations

- [ ] **Expand `src/mammoth.d.ts`** (currently 6 lines)
  - Add `Options` interface with `convertImage?: ImageConverter`
  - Add `ImageConverter` branded type
  - Add `Image` interface: `contentType: string`, `readAsBuffer(): Promise<Buffer>`, `readAsArrayBuffer(): Promise<ArrayBuffer>`, `readAsBase64String(): Promise<string>`
  - Add `ImageAttributes` interface: `src: string`, `alt?: string`
  - Add `Images` namespace: `dataUri: ImageConverter`, `imgElement(f): ImageConverter`
  - Update `convertToHtml` signature to use typed `Options`
  - Add `extractRawText` export
  - Add `images` export

### 2.5.2 `read_docx` — Image Extraction

- [ ] **Update `src/tools/read-docx.ts`**
  - Add `import { createHash } from "crypto"`
  - Implement mammoth `convertImage` handler (before `convertToHtml` call at line 142):
    - Check format against supported list (`image/png`, `image/jpeg`, `image/gif`, `image/webp`)
    - Skip unsupported formats (EMF, WMF, SVG, TIFF) with descriptive alt text
    - Read image as buffer via `image.readAsBuffer()` — returns a Node.js `Buffer` (Electron's polyfill in the renderer process)
    - Generate MD5 hash filename: `${hash}.${ext}`
    - Resolve vault path via `this.app.fileManager.getAvailablePathForAttachment(filename)`
    - Check if file already exists (`this.app.vault.getFileByPath()`)
    - If not exists: save via `this.app.vault.createBinary(targetPath, buffer.buffer)` — note: `buffer.buffer` converts `Buffer` → `ArrayBuffer` as required by Obsidian's vault API
    - Track extracted images with index for Turndown rule replacement
  - Replace existing Turndown image rule (lines 154-157: `filter: ["img"], replacement: () => "[image]"`) with vault-path-aware rule:
    - Match `__notor_img_N__` src pattern → emit `![alt](vaultPath)` markdown
    - Match `__notor_skip__` src → emit descriptive alt text
    - Fallback → `[image]`
  - Error handling: all image errors non-fatal — document with 10 images where 2 fail still returns text + 8 successful images

### 2.5.3 `write_docx` — Image Embedding

- [ ] **Create `src/tools/docx-image-utils.ts`**
  - Define `DocxImageData` interface: `type: "jpg" | "png" | "gif" | "bmp"`, `buffer: Buffer`, `width: number`, `height: number`
  - Implement `resolveImageForDocx(href, vaultRoot, allowedPaths): Promise<DocxImageData | null>`
    - Vault-relative paths: resolve from vault root
    - Absolute paths: validate against `allowedPaths` via `resolveAndValidatePath()`
    - Data URIs: decode base64 directly to buffer
    - HTTP URLs: reject (no network I/O from tools)
  - Format mapping: `image/png` → `"png"`, `image/jpeg` → `"jpg"`, `image/gif` → `"gif"`, `image/bmp` → `"bmp"`
  - WebP handling: if encountered, convert to PNG via Electron Canvas API
  - Dimension detection via buffer header parsing (zero deps):
    - PNG: bytes 16-23 of IHDR chunk
    - JPEG: scan for SOF0/SOF2 marker
    - GIF: bytes 6-9
    - BMP: bytes 18-25
  - Max input image size: 20MB (reject larger with error)

- [ ] **Update `src/tools/write-docx.ts`**
  - Add `ImageRun` to imports from `docx` (line 24-37)
  - **Image pre-resolution pass** — Both `buildDocxChildren()` (line 108) and `renderInline()` (line 53) are synchronous. The `docx` library's `Document`, `Paragraph`, `Table`, and `ImageRun` constructors all expect synchronous children arrays. Making either function async would require restructuring all constructor call sites.
    - **Strategy:** Add an async pre-pass in `generateDocx()` before calling `buildDocxChildren()`:
      1. **Recursively** walk all tokens from `marked.lexer()` output — image tokens are inline tokens nested inside `paragraph`, `blockquote`, `list` item, and `table` cell tokens (in marked v17, `![alt](url)` is parsed as `{ type: "paragraph", tokens: [{ type: "image", href: "url" }] }`). The walk must descend into each block token's `.tokens` and `.items[].tokens` arrays to find all `image` entries.
      2. Collect all `image` token `href` values from the recursive walk
      3. Resolve all images in parallel: `await Promise.all(hrefs.map(h => resolveImageForDocx(h, vaultRoot, allowedPaths)))`
      4. Build a `Map<string, DocxImageData>` lookup from href → resolved image data
      5. Pass the map into `buildDocxChildren()` as a parameter
    - `buildDocxChildren()` stays synchronous — image lookup is a synchronous `map.get(href)` call
  - **Handle images in the `paragraph` case** of `buildDocxChildren()` (line 125-130) — in marked v17, standalone images are parsed as inline `image` tokens wrapped in a `paragraph` token, NOT as top-level `image` block tokens. Handle this by detecting single-image paragraphs:
    - When a `paragraph` token contains exactly one child token of `type: "image"`, render it as a dedicated `new Paragraph({ children: [new ImageRun({ type, data, transformation: { width, height }, altText })] })` using the pre-resolved map
    - If the image href is not in the resolved map, render fallback: `new Paragraph({ children: [new TextRun({ text: "[Image: href]" })] })`
    - When a `paragraph` token contains an image mixed with other inline tokens (e.g., `text ![alt](url) more text`), render via `renderInline()` as today — the image token falls through to the default `raw` text rendering (acceptable: mixed image+text paragraphs are rare in practice)
    - Paragraphs with no image tokens continue through the existing `renderInline()` path unchanged
  - **Refactor template grafting (lines 286-338) to use DOM parsing + handle images:**
    - The current grafting uses regex-based XML string manipulation (regex to extract `<w:body>`, regex to strip `<w:sectPr>`). Introducing DOM-based merging for relationships alongside regex-based body grafting creates an inconsistent, fragile mix. Migrate the entire grafting routine to `@xmldom/xmldom` (`^0.8.11`, already a direct dependency in package.json).
    - **Step 1 — Migrate existing body grafting to DOM parsing:**
      1. Parse generated `word/document.xml` with `DOMParser` → extract `<w:body>` child nodes
      2. Parse template `word/document.xml` with `DOMParser` → locate `<w:body>` element
      3. Remove all non-`<w:sectPr>` children from template body
      4. Import and append generated body children (excluding `<w:sectPr>`) into template body
      5. Serialize back with `XMLSerializer` → write to template zip
      - This replaces the current regex approach with equivalent DOM operations, reducing fragility
    - **Step 2 — Add image support to grafting:**
      - Must also merge:
        1. `word/media/*` — copy image binary files from generated zip
        2. `word/_rels/document.xml.rels` — merge relationship entries with rId conflict resolution
        3. `[Content_Types].xml` — add image format content type declarations
    - **rId conflict resolution algorithm:**
      1. Parse template's `word/_rels/document.xml.rels` with `DOMParser`
      2. Find highest rId number in template
      3. Parse generated doc's `word/_rels/document.xml.rels` with `DOMParser`
      4. Remap all generated rIds to `rId(maxId + offset)`
      5. Update generated `word/document.xml` body: replace `r:embed="rIdN"` and `r:id="rIdN"` references (can use DOM `getAttribute`/`setAttribute` on the already-parsed body nodes)
      6. Append remapped `<Relationship>` elements to template `.rels` DOM
      7. Copy `word/media/*` files from generated zip into template zip
      8. Parse both `[Content_Types].xml` with `DOMParser` → add `<Default Extension="png" .../>` etc. if not already present → serialize back

### 2.5.4 Verification

- [ ] **Manual test: read_docx** — Read a `.docx` with images → images saved to vault attachment folder → markdown output contains `![alt](path)` → images render in Obsidian preview
- [ ] **Manual test: write_docx** — Write markdown with `![alt](path)` image references → open output in Word → images render
- [ ] **Manual test: Template grafting** — Write with template + images → styles preserved AND images present
- [ ] **Manual test: Edge cases** — Duplicate images (same MD5 → same file), mixed formats (PNG + JPEG + unsupported EMF), document with no images (output identical to current)
- [ ] **Unit tests** — `docx-image-utils.ts` (dimension parsing, format mapping, path resolution), mammoth convertImage handler

---

## Phase 4: Polish & Edge Cases

**Goal:** Handle remaining integration points, improve UX, add comprehensive test coverage.

### 4.1 MCP Tool Results with Images

- [ ] **Handle MCP image results** — Currently omitted with `[N image(s) omitted]`
  - When MCP tools return image content, convert to `ContentBlock` and include in tool result
  - Respect provider media capabilities

### 4.2 Drag-and-Drop Support

- [ ] **Add drag-and-drop for images/PDFs on chat input area**
  - Listen for `drop` events on the chat input container
  - Detect file type via extension/magic bytes
  - Route to appropriate attachment creation flow
  - Show attachment chip on successful drop

### 4.3 Image Thumbnail Preview

- [ ] **Render small thumbnail preview in attachment chips** for image attachments
  - Use `<img src="data:...">` with small dimensions (e.g., 32x32) in the chip element
  - Only for images, not PDFs

### 4.4 Provider-Specific Token Formulas

- [ ] **Implement OpenAI tile-based image token formula**
  - `170 * ceil(w/512) * ceil(h/512) + 85` (high detail mode)
  - Add `provider?: string` parameter to `estimateImageTokens`
  - Reduces overestimation for image-heavy conversations on OpenAI

### 4.5 HTML Export — Inline Images

- [ ] **Optionally embed images in HTML export**
  - When exporting to HTML, image blocks render as `<img src="data:{mediaType};base64,{data}">` inline
  - PDF blocks render as `[PDF document attached]` text

### 4.6 E2E Test Coverage

- [ ] **E2E test: Image attachment flow** — Attach image → send → model responds with image description
- [ ] **E2E test: PDF attachment flow** — Attach PDF → send → model summarizes content
- [ ] **E2E test: read_file on image** — Tool call returns image block
- [ ] **E2E test: read_file on PDF** — Tool call returns document block or text
- [ ] **E2E test: read_docx with images** — Images saved to vault, markdown contains paths
- [ ] **E2E test: write_docx with images** — Output contains embedded images
- [ ] **E2E test: History persistence** — Send image → close/reopen conversation → image still present in history

---

## Dependency Summary

| Phase | New Production Dependencies | New Dev Dependencies |
|-------|---------------------------|---------------------|
| Phase 1 | None | None |
| Phase 2 | None (Electron Canvas API) | None |
| Phase 3 | 1 PDF library (unpdf or pdf-parse-new) | Test PDFs in `e2e/fixtures/pdf/` |
| Phase 2.5 | None (mammoth + docx already installed) | None |
| Phase 4 | None | E2E test fixtures |

**Total new production dependencies: 1** (the PDF library, added in Phase 3)

---

## Implementation Order

Phases can be partially parallelized:

```
Phase 1 (Foundation) ─────────────────────────┐
                                                ├─→ Phase 2 (Images) ──→ Phase 4 (Polish)
                                                │
Phase 2.5 (DOCX Images) ─── [independent] ─────┤
                                                │
                                                └─→ Phase 3 (PDFs)
```

- **Phase 1** must complete first (all other phases depend on `ContentBlock` types)
- **Phase 2.5** is fully independent and can start immediately / run in parallel with Phase 1
- **Phase 2** requires Phase 1
- **Phase 3** requires Phase 1 + Phase 2 (shares attachment/UI patterns)
- **Phase 4** requires all prior phases
