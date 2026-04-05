# Implementation Tasks: PDF & Image Handling

**Source:** [pdf-and-image-handling-design.md](pdf-and-image-handling-design.md)
**Created:** 2026-04-05

---

## Phase 1: Foundation — Content Block System

**Goal:** Introduce `ContentBlock` type, update `Message` and `ChatMessage` content types from `string` to `string | ContentBlock[]`, make all providers handle the union, fix all read-side callsites, and add media-aware token estimation. No user-facing changes — existing conversations remain string-only.

**Convention — "assert string":** When a task in this phase says "assert string" or "add assertion/guard", use a runtime type guard that throws on violation: `const text = typeof msg.content === "string" ? msg.content : (() => { throw new Error("Expected string content for {role} message"); })();`. This catches future regressions while being explicit about the invariant. Apply this pattern consistently across all files in this phase.

### 1.1 New Files

- [x] **Create `src/media/types.ts`**
  - Define `ImageMediaType` union (`"image/png" | "image/jpeg" | "image/gif" | "image/webp"`)
  - Define `ContentBlock` discriminated union (text, image, document)
    - `text`: `{ type: "text"; text: string }`
    - `image`: `{ type: "image"; media_type: ImageMediaType; data: string; width?: number; height?: number }`
    - `document`: `{ type: "document"; media_type: "application/pdf"; data: string; page_count?: number }`
  - Export `getTextContent(content: string | ContentBlock[]): string` helper — when input is `ContentBlock[]`, filters to text blocks and joins with `"\n"`; when input is `string`, returns it as-is. When input is an empty `ContentBlock[]` or contains no text blocks, returns `""` (empty string)
  - Export media limit constant: `MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024` (the image processor pipeline's maximum output size, used as the target in the compression cascade). This is the only constant needed in Phase 1. Additional constants (`MAX_RAW_INPUT_BYTES` for the 50MB raw file limit) are defined inline at their usage sites in Phase 2 since they are single-use values. **Note:** Per-provider limits in `capabilities.ts` (Phase 2) are checked separately at message assembly time

- [x] **Create `src/media/format-detector.ts`**
  - Implement magic byte detection for: PNG (`89 50 4E 47`), JPEG (`FF D8 FF`), GIF (`47 49 46`), WebP (bytes 0-3: `52 49 46 46` (RIFF) AND bytes 8-11: `57 45 42 50` (WEBP); bytes 4-7 are file size and ignored during detection), PDF (`25 50 44 46`)
  - Export `detectMediaFormat(buffer: Buffer): "png" | "jpeg" | "gif" | "webp" | "pdf" | null`
  - Unit tests for each format + unknown binary

### 1.2 Core Type Changes

- [x] **Update `src/types.ts:107`** — Change `Message.content` from `string` to `string | ContentBlock[]`
  - Import `ContentBlock` from `./media/types` (same level — `src/types.ts` and `src/media/` are siblings)
  - **JSONL compatibility:** No migration needed. `JSON.parse` of existing JSONL lines produces `string` for the `content` field, which is a valid member of `string | ContentBlock[]`. New messages with `ContentBlock[]` serialize as JSON arrays and parse back correctly

- [x] **Update `src/providers/provider.ts:25`** — Change `ChatMessage.content` from `string` to `string | ContentBlock[]`
  - Import `ContentBlock` from `../media/types`

### 1.3 Provider Layer — Handle `ContentBlock[]` in `toXxxMessages()`

Each provider's message conversion function must handle the case where `msg.content` is `ContentBlock[]` instead of `string`. System and assistant messages are always strings (system prompts are text, LLM output is text). User messages may be `ContentBlock[]` when media is attached.

- [x] **`src/providers/anthropic-provider.ts` — `toAnthropicMessages()`**
  - Line 59: System message concatenation — add assertion/guard that system content is string
  - Lines 66-68: Tool call branch `content.push({ type: "text", text: msg.content })` — this is pre-tool-call assistant text, always a string. No change needed, but add assertion for safety (see Phase 1 "assert string" convention above)
  - Lines 95-98: Catch-all handles **both** user and assistant messages (`role: msg.role === "user" ? "user" : "assistant"`, `content: msg.content`). Replace the single `anthropicMessages.push()` call with an `if (msg.role === "user") { ... } else { ... }` block, each branch pushing with its own content format:
    - When `msg.role === "user"` and `msg.content` is `ContentBlock[]`, map to Anthropic native blocks:
      - text → `{ type: "text", text }`
      - image → `{ type: "image", source: { type: "base64", media_type, data } }`
      - document → `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }` (Anthropic document blocks do not require a `name` field, unlike Bedrock)
    - When `msg.role === "user"` and `msg.content` is `string`, wrap as `[{ type: "text", text: msg.content }]` (wire format changes from string to array — Anthropic accepts both forms and treats them identically for billing, token counting, and generation. This normalizes to array for consistency with the `ContentBlock[]` branch). **Edge case:** When `msg.content` is an empty string `""`, do NOT wrap — pass as string `""` directly. Anthropic rejects empty text content blocks in arrays (`[{ type: "text", text: "" }]` → 400 error) but accepts empty string content
    - When assistant, assert string (see Phase 1 "assert string" convention) and pass through unchanged: `content: msg.content`

- [x] **`src/providers/openai-provider.ts` — `toOpenAIMessages()`**
  - Lines 57-69: Tool call branch `content: msg.content || null` — pre-tool-call assistant text, always a string. No change needed
  - Lines 85-90: Catch-all handles **both** user and assistant messages (`role: msg.role === "tool_call" || ... ? "user" : msg.role`, `content: msg.content`). Split:
    - When user and `ContentBlock[]`, map to OpenAI content parts:
      - text → `{ type: "text", text }`
      - image → `{ type: "image_url", image_url: { url: "data:{media_type};base64,{data}" } }`
      - document → **skip** with text placeholder `"[PDF document — not supported by this provider]"`. This placeholder remains permanently as a safety net — in normal operation, OpenAI/Local providers never receive document blocks because `processPdf()` (Phase 3) converts PDFs to text blocks before they reach the provider. The placeholder only triggers if a code path incorrectly sends a raw document block to a non-native provider
    - When `msg.role === "user"` and `msg.content` is `string`, keep existing behavior: `content: msg.content` (the `Array.isArray` check in the preceding branch implicitly narrows the type to `string`; if TypeScript still infers the union, add an explicit `as string` cast). OpenAI accepts both string and array content for user messages; no normalization to array needed here unlike Anthropic
    - When assistant, assert string (see Phase 1 "assert string" convention) and pass through unchanged: `content: msg.content`

- [x] **`src/providers/bedrock-provider.ts` — `toBedrockMessages()`**
  - **Import note:** `ContentBlock` is already imported from `@aws-sdk/client-bedrock-runtime` at line 44. Use an import alias: `import { ContentBlock as MediaContentBlock } from "../media/types"` to avoid the name collision. Within this file, use `MediaContentBlock` for all references to the Notor content block type (in type annotations, mapping functions, etc.)
  - Line 83: System `{ text: msg.content }` — assert string (see Phase 1 "assert string" convention above)
  - Lines 88-92: Tool call branch `content.push({ text: msg.content })` — pre-tool-call assistant text, always a string. No change needed
  - Lines 123-129: Catch-all handles **both** user and assistant messages (`role: msg.role === "user" ? "user" : "assistant"`, `content: [{ text: msg.content }]`). Split:
    - When user and `ContentBlock[]`, map to Bedrock blocks:
      - text → `{ text }`
      - image → `{ image: { format, source: { bytes: Buffer.from(data, "base64") } } }` — map `block.media_type` to Bedrock format by stripping the `image/` prefix: `block.media_type.split("/")[1]` (e.g., `"image/png"` → `"png"`)
      - document → `{ document: { format: "pdf", name: "document.pdf", source: { bytes: Buffer.from(data, "base64") } } }` (the `name` field is required by Bedrock's API schema but not used for processing — a static default is sufficient; threading the original filename is a future enhancement)
    - When `msg.role === "user"` and `msg.content` is `string`, keep existing behavior: `content: [{ text: msg.content }]` (Bedrock already wraps strings in content block arrays)
    - When assistant, assert string (see Phase 1 "assert string" convention) and keep existing: `content: [{ text: msg.content }]`

- [x] **`src/providers/local-provider.ts` — `toOpenAIMessages()`**
  - Lines 85-97: Tool call branch `content: msg.content || null` — pre-tool-call assistant text, always a string. No change needed
  - Lines 113-118: Catch-all handles **both** user and assistant messages. Same fix as OpenAI provider (including permanent document block safety-net placeholder, user-string pass-through, and assistant assertion). Apply the same three branches: user+`ContentBlock[]` (map to content parts), user+string (keep existing `content: msg.content`), assistant (assert string and pass through)
  - **Note:** The local provider's `toOpenAIMessages()` is structurally identical to the OpenAI provider's. Apply the same changes at the corresponding lines. The only semantic difference is in `capabilities.ts` (Phase 2): local sets `supportsImages: true` optimistically
  - **Note:** Document block mapping in all providers is dead code until Phase 3 adds PDF processing. It cannot be meaningfully tested until then. Consider marking with `// Phase 3: PDF support` comments

### 1.4 Token Estimation — Media-Aware

- [x] **Add `estimateContentTokens()` to `src/utils/tokens.ts`**
  - Import `ContentBlock` from `../media/types` at the top of the file
  - Place `estimateContentTokens` and its private helpers after the existing `estimateTokenCount` function (line ~52) and before the `estimateTokens` alias (line 54)
  - Implement `estimateContentTokens(content: string | ContentBlock[]): number`
    - String input: delegate to existing `estimateTokenCount()`
    - `ContentBlock[]`: sum per-block estimates:
      - text: `estimateTokenCount(block.text)`
      - image: `(width * height) / 750` when dimensions known, else flat `2000`
      - document: `pageCount * 2000` when known, else flat `2000`
  - Private helpers: `estimateImageTokens(w?, h?)`, `estimateDocumentTokens(pageCount?)`
  - Unit tests in `src/utils/tokens.test.ts` covering: string input, text-only blocks, image with/without dimensions, document with/without page count, mixed content, empty `ContentBlock[]` returns 0

- [x] **Update `src/chat/context.ts:77-101`** — `estimateMessageTokens()`
  - Full function spans lines 77-101; lines 79-86 contain early returns for `output_tokens`/`input_tokens` that must be preserved
  - Replace the core logic at lines 89-100 (`let text = message.content; text += ...; return estimateTokenCount(text)`) with:
    ```ts
    let total = estimateContentTokens(message.content);
    if (message.tool_call) {
        total += estimateTokenCount(JSON.stringify(message.tool_call.parameters));
    }
    if (message.tool_result) {
        const result = message.tool_result.result;
        total += estimateTokenCount(typeof result === "string" ? result : JSON.stringify(result));
    }
    return total;
    ```
  - The conditionals match the existing guards at lines 93-97; the key change is splitting content estimation (via `estimateContentTokens`) from tool metadata estimation (via `estimateTokenCount`)

- [x] **Update `src/context/compaction.ts:80`** — `estimateConversationTokens()`
  - Replace `estimateTokens(msg.content)` with `estimateContentTokens(msg.content)` (note: `estimateTokens` is an alias of `estimateTokenCount` defined at `tokens.ts:54`). Only this call changes — the `estimateTokens(JSON.stringify(...))` calls for tool_call/tool_result at lines 84 and 90 remain unchanged since their arguments are always strings

- [x] **Update `src/chat/sub-agent-runner.ts:453`** — `estimateConversationTokens()`
  - Replace `estimateTokenCount(msg.content)` with `estimateContentTokens(msg.content)`

### 1.5 Context Compaction — Strip Media Before Summarization

- [x] **Update `src/context/compaction.ts:241-245`** — Empty content check and compaction message building
  - Replace lines 241-245 (the `if (!msg.content?.trim()) continue;` guard through the entire `chatMessages.push()` call including its closing `});`). Full replacement:
    ```ts
    const text = getTextContent(msg.content);
    if (!text.trim()) continue;
    let compactionContent = text;
    if (Array.isArray(msg.content)) {
        const mediaCount = msg.content.filter(b => b.type !== "text").length;
        if (mediaCount > 0) {
            compactionContent += `\n[${mediaCount} media block${mediaCount === 1 ? "" : "s"} omitted during compaction]`;
        }
    }
    chatMessages.push({
        role: msg.role,
        content: compactionContent,
    });
    ```
  - **Assign `compactionContent` (plain `string`)** to the `ChatMessage.content` field — this ensures the summarization call receives only text, not base64 blobs. The type union allows this (string is a valid `string | ContentBlock[]` value)
  - **Note:** `getTextContent()` handles both cases transparently — for string content (assistant messages), it returns the string unchanged. The `Array.isArray()` check and media marker logic only triggers for `ContentBlock[]` content, which only occurs for user messages. No separate role-based branching is needed here.

### 1.6 Orchestrator & History — Handle Union Type

- [x] **`src/chat/orchestrator.ts:2051`** — Empty assistant content check
  - `msg.content?.trim()` — assert string before the trim check (`.trim()` does not exist on arrays): `const text = typeof msg.content === "string" ? msg.content : (() => { throw new Error("Expected string content for assistant message"); })(); if (!text.trim()) { ... }`

- [x] **`src/chat/orchestrator.ts:2194`** — `preToolCallText = prev.content`
  - Assert string using the Phase 1 convention (prev is assistant message, always string): `preToolCallText = typeof prev.content === "string" ? prev.content : (() => { throw new Error("Expected string content for assistant message"); })();`

- [x] **`src/chat/orchestrator.ts:2043, 2057`** — `content: msg.content` pass-through
  - No change needed (both types accept the union). No comments required — the type annotation on `ChatMessage.content` already documents that it can be `ContentBlock[]`

- [x] **`src/chat/orchestrator.ts:2103-2176, 2178-2231`** — `toChatMessages()` repair & coalescing phases
  - **Repair phase** (lines 2103-2176): Injects synthetic `tool_result` messages for orphaned tool calls. All `content` fields are string literals (`""`) — no code changes required
  - **Coalescing phase** (lines 2178-2231): Merges consecutive tool_call/tool_result messages. Line 2194 is covered above. Coalesced messages use `content: preToolCallText` (string, from assistant) and `content: ""` (string literal) — no code changes required
  - Both phases are safe because they only construct messages with string content, never propagate user `ContentBlock[]`. After all Phase 1 changes, confirm these phases compile without errors. TypeScript may report errors on string operations because `ChatMessage.content` is now a union type — if so, add `as string` casts at the specific sites (all content values in these phases are string literals or assistant text, so the casts are safe). Likely cast sites: any line where `content` is assigned from a string literal (`""`) or from `preToolCallText` (known string) but TypeScript infers the broader union type. Expected: 0-3 sites

- [x] **`src/chat/history.ts:442`** — `JSON.parse(message.content)`
  - Add type guard: `if (typeof message.content !== "string") return null;` before JSON parse
  - System messages are always string, but guard prevents future regressions

- [x] **`src/chat/history.ts:496-497`** — Preview generation
  - Current: `typeof msg.content === "string"` guard exists, then `.substring(0, 120)`
  - Add `ContentBlock[]` branch: `else if (Array.isArray(msg.content)) preview = getTextContent(msg.content as ContentBlock[]).substring(0, 120);`
  - **Type note:** Messages are parsed as `Record<string, unknown>` from JSONL. The parsed `msg.content` is `unknown[]` at runtime, not a typed `ContentBlock[]`. Cast to `ContentBlock[]` after verifying `Array.isArray(msg.content)` — `getTextContent()` only reads `.type` and `.text` fields, so the cast is safe for well-formed history data

- [x] **`src/chat/history.ts:587-590`** — Search conversations
  - Line 587: Same preview fix as line 496 (with same `Array.isArray` + cast pattern)
  - Line 590: For `ContentBlock[]`, search text blocks: `getTextContent(msg.content as ContentBlock[]).toLowerCase().includes(needle)`

- [x] **`src/chat/conversation.ts:348`** — `generateTitle(params.content)` **(compile error)**
  - `generateTitle()` is declared as `private generateTitle(content: string)` at line 478 and immediately calls `.replace()` on its argument — passing `ContentBlock[]` produces `"[object Object]..."` as the title
  - This is a **TypeScript compile error site** after the type change, not just a pass-through
  - Wrap: `this.generateTitle(getTextContent(params.content))` — `getTextContent()` already handles string input (returns it as-is), so no separate `typeof` check is needed. **Note:** If `getTextContent()` returns `""` (e.g., image-only message), `generateTitle()` produces an empty string after cleaning. This is acceptable for Phase 1 (no media is created yet). Phase 2 adds an image-only fallback — see Task 2.10

- [x] **`src/chat/sub-agent-history.ts:58, 78, 96`** — `content: cm.content` pass-through
  - No change needed (both `ChatMessage` and `Message` accept the union)
  - **Note:** These lines flow `ChatMessage → Message` (the reverse of the typical `toChatMessages()` direction). The union type is valid in both directions
  - Verify TypeScript compilation passes

### 1.7 Export Modules — Use `getTextContent()`

- [x] **`src/export/markdown-exporter.ts`**
  - Line 95: `wrapCallout("info", "Hook output", msg.content, true)` — wrap with `getTextContent()` (hook injections are always string, but guard for type safety)
  - Line 99: `let content = msg.content` then regex/slice operations — use `getTextContent(msg.content)` for the text portion. The `<attachments>` XML block is embedded in text content, so `getTextContent()` preserves it and the existing regex extraction continues to work unchanged
  - Line 139: `parts.push(msg.content)` — assert string (assistant messages always string)

- [x] **`src/export/html-exporter.ts`**
  - Line 394: `escapeHtml(msg.content)` — wrap with `getTextContent()`
  - Line 398: `let content = msg.content` then regex/slice — use `getTextContent(msg.content)`
  - Line 438: `marked.parse(msg.content)` — assert string (assistant always string)
  - Line 556: `msg.content.substring(0, 200)` + `.length` — use `getTextContent()`
  - Line 558: `escapeHtml(msg.content)` — use `getTextContent()`
  - Line 560: `marked.parse(msg.content)` — assert string (assistant always string)

### 1.8 UI — Handle Union in Chat View

- [x] **`src/ui/chat-view.ts`**
  - Line 1159: `extractAttachmentsBlock(message.content)` — pass `getTextContent(message.content)` (attachment XML is in the text portion)
  - Line 1163: `textToRender = ... : message.content` — use `getTextContent(message.content)` as fallback
  - Line 1241: `pre.createEl("code", { text: message.content })` — use `getTextContent()` (hook injections are string, but guard)
  - Line 1289: `MarkdownRenderer.render(..., message.content, ...)` — assert string (assistant messages always string)
  - **Note:** Phase 2 will add image block rendering to the user message display. The `getTextContent()` usage here serves as a safe fallback until then — image/document blocks are silently dropped from the display text

### 1.9 Verification

- [x] **TypeScript compilation** — `npm run build` succeeds with zero type errors across all modified files
- [x] **Unit tests pass** — `npm test` for existing tests (no regressions)
- [x] **Unit tests for new code** — `src/media/types.test.ts` (getTextContent), `src/media/format-detector.test.ts`, token estimation tests
- [x] **Manual smoke test** — Open existing conversation, send a message, verify content flows through correctly as plain string (covered by `e2e/scripts/image-handling-test.ts` test 1)

---

## Phase 2: Image Handling

**Goal:** Full image support via the `read_file` tool and the attachment system. Users can attach images from vault or filesystem; the LLM receives them as vision content.

### 2.1 New Files

- [x] **Create `src/media/image-processor.ts`**
  - Use Electron Canvas API (zero new dependencies) for resize + compress. Use `document.createElement("canvas")` and `new Image()` from the DOM (available in Electron's renderer process). For unit tests, mock `document.createElement("canvas")` and `new Image()` using Vitest's mocking APIs (`vi.fn()`, `vi.stubGlobal()`). See `src/__mocks__/obsidian.ts` for the project's existing mock pattern
  - Implement pipeline: buffer → magic byte detect → Image() load → validate dimensions → resize if >2000px → compress → base64
  - Format-aware compression cascade:
    - PNG: try PNG first → if >5MB, cascade JPEG 80 → 60 → 40
    - JPEG: try quality 80 → 60 → 40 → 20
    - GIF/WebP: convert to PNG first, then PNG cascade. GIF conversion extracts the first frame only (animation is lost) — this happens implicitly: `new Image()` loads the GIF and Canvas `drawImage()` captures whatever frame is currently displayed (always the first frame for a just-loaded GIF), so no explicit frame extraction code is needed. WebP conversion may increase size; apply PNG cascade compression after conversion
  - If the final compression step still exceeds `MAX_IMAGE_BASE64_BYTES`, throw an error: `"Image exceeds 5MB after maximum compression (final size: ${size} bytes)"`. This is an unrecoverable error — the caller converts it to a `ToolResult` with `success: false` or an `Attachment` with `status: "error"`
  - **Already-within-limits optimization:** The `Image()` load (for dimension reading) always runs. After loading, if the input image is (a) already ≤ max dimension on both axes AND (b) the base64-encoded size of the original buffer is ≤ `MAX_IMAGE_BASE64_BYTES` (check via `Math.ceil(buffer.length * 4 / 3)` to avoid encoding the full buffer just for a size check), skip the Canvas resize/compress steps (Canvas `createElement`, `drawImage`, `toDataURL`, compression cascade) and return the original buffer as base64 with dimensions from `img.naturalWidth`/`img.naturalHeight`. This avoids unnecessary quality loss from re-encoding. The Canvas steps only run when resize or compression is actually needed
  - Export `processImage(buffer: Buffer, mediaType: ImageMediaType, options?: { maxDimension?: number; compressionQuality?: number }): Promise<ContentBlock>` — always returns a `ContentBlock` of type `"image"` with `media_type`, `data`, `width`, and `height` populated. Defaults to `maxDimension: 2000` and `compressionQuality: 80`. Callers (`read_file`, `resolveAttachment`, `readExternalBinaryFile`) pass `this.settings.image_max_dimension` and `this.settings.image_compression_quality` from the plugin settings
  - `processImage()` throws on unrecoverable errors (corrupt image, Canvas/Image load failure, exceeding size limit after maximum compression, zero-dimension images, Canvas `toDataURL` returning empty string). Callers (`read_file`, `resolveAttachment`) are responsible for catching and converting to appropriate error responses (e.g., `ToolResult` with `success: false`, or `Attachment` with `status: "error"`)
  - **Image load pattern:** Use both `onload` (resolve) and `onerror` (reject) handlers when loading the Image element. Example: `await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error("Failed to decode image")); img.src = dataUrl; })`. Also guard against zero-dimension results after load (`img.naturalWidth === 0 || img.naturalHeight === 0` indicates a decode failure on some platforms)
  - Callers must detect the media type before calling `processImage()` (via `detectMediaFormat()`). The function does not re-detect, since callers need the format for routing decisions (image vs PDF vs unknown binary) before processing.
  - Return `ContentBlock` with `width`/`height` metadata populated from Canvas
  - Unit tests for: dimension validation, resize logic, compression cascade, format detection

- [x] **Create `src/media/capabilities.ts`**
  - Define `MediaCapabilities` interface: `supportsImages`, `supportsNativePdf`, `maxImageSizeBytes`, `maxDocumentSizeBytes`, `maxMediaItems`
  - Export `getMediaCapabilities(providerType: string): MediaCapabilities`
  - Provider capability table:
    - Anthropic: images yes, native PDF yes, 5MB image, 32MB doc, 100 items
    - OpenAI: images yes, native PDF no, 20MB image, N/A doc, 50 items
    - Bedrock: images yes, native PDF yes, 3.75MB image, 4.5MB doc, 20 items
    - Local: `supportsImages: true`, native PDF no, 5MB image, N/A doc, 10 items. Add a comment noting that actual image support depends on the backend model — `true` means "send images, but do not error if the model ignores them"

- [x] **Create `src/settings/sections/media.ts`** — "Images & PDFs" settings section
  - Setting: `image_max_dimension` (number, default 2000)
  - Setting: `image_compression_quality` (number, default 80)
  - Register in `src/settings/settings-tab.ts` under the existing "Tool configuration" group (line 168: `const toolConfigGroup = createSettingsGroup(...)`) — add `renderMediaSection(toolConfigGroup, ctx);` alongside the existing `renderDocxToolsSection` call

### 2.2 Type Extensions

- [x] **Update `src/types.ts`** — Add `content_blocks` to `ToolResult`
  - `content_blocks?: ContentBlock[]` — optional media output from tool execution
  - Contract: when present, `result` field still contains a text summary for fallback

### 2.3 Tool Changes — Extend `read_file`

- [x] **Update `src/tools/read-file.ts`**
  - Update `description` to mention image support (PNG, JPEG, GIF, WebP)
  - At line 137 (binary detection via null bytes), insert format detection before rejection:
    1. Read buffer (existing)
    2. Call `detectMediaFormat(buffer)` from `format-detector.ts`
    3. If image format detected → check `buffer.length` against a raw size limit of 50MB (`50 * 1024 * 1024` bytes) and reject oversized files with a descriptive error → process via `processImage()` → return `ToolResult` with `success: true`, `content_blocks` containing the image block, and text summary in `result` (e.g., `"Read image: photo.png (1200x800, image/png)"`). If `processImage()` throws, return `ToolResult` with `success: false` and the error message
    4. If PDF → skip for now (Phase 3)
    5. If other binary → reject as before (existing behavior)
    6. If text → existing text path unchanged

### 2.4 Attachment System — Image Support

- [x] **Update `src/context/attachment.ts`**
  - Add attachment types: `"vault_image"`, `"external_image"` to `AttachmentType` union
  - Add fields to `Attachment` interface:
    - `binary_content: string | null` — base64-encoded binary for images/PDFs (post-processing: resized/compressed for images)
    - `media_type: string | null` — detected MIME type (e.g., `"image/png"`)
    - `width: number | null` — image width in pixels after processing (null for non-image attachments). Populated by `processImage()` result during `resolveAttachment()`
    - `height: number | null` — image height in pixels after processing (null for non-image attachments). Used by `buildAttachmentsBlock()` to set `ContentBlock` dimensions for accurate token estimation
  - **Update existing factory functions** (`createVaultNoteAttachment`, `createVaultNoteSectionAttachment`, `createExternalFileAttachment`) to include `binary_content: null`, `media_type: null`, `width: null`, and `height: null` in their return objects — required for TypeScript compilation after the interface change
  - Add factory: `createVaultImageAttachment(path: string): Attachment` — returns Attachment with `type: "vault_image"`, `binary_content: null`, `media_type: null`, `width: null`, `height: null`, `status: "pending"`. Binary content and dimensions are populated during `resolveAttachment()`
  - Add factory: `createExternalBinaryAttachment(absolutePath: string, filename: string, base64: string, mediaType: string, width?: number, height?: number): Attachment` (extended from design doc §5.1 to include dimension metadata for token estimation) — sets `binary_content: base64`, `media_type: mediaType`, `width: width ?? null`, `height: height ?? null`, `status: "resolved"` (already processed by caller). Note: unlike `createVaultImageAttachment` (which starts as "pending"), external binary attachments arrive fully processed
  - Update `resolveAttachment()`:
    - For `vault_image`: look up the file via `app.vault.getFileByPath(attachment.path)` (matching the existing pattern at line 205); return error status if not found. Read binary via `app.vault.readBinary(file)`, convert to `Buffer` via `Buffer.from(arrayBuffer)`, detect format via `detectMediaFormat()`. If `detectMediaFormat()` returns `null` (unknown binary format) or returns a non-image format (e.g., `"pdf"`), set `status: "error"` and `error_message: "Unsupported image format"` — do not attempt to process through `processImage()`. Otherwise, process through `processImage(buffer, mediaType)`. The returned `ContentBlock` contains `data` (base64), `media_type`, `width`, and `height` — extract these fields and store on the Attachment: `binary_content = block.data`, `media_type = block.media_type`, `width = block.width`, `height = block.height`
    - If image processing fails (corrupt file, canvas error, exceeds size after compression), set `status: "error"` and `error_message` with a descriptive message. Do not throw — follow the existing error handling pattern at lines 261-266
  - Update `buildAttachmentsBlock()` return type:
    - From: `string | null`
    - To: `{ text: string | null; contentBlocks: ContentBlock[] }`
    - Text attachments continue as XML string; image attachments produce `ContentBlock` entries
    - **Image ContentBlock construction:** For each resolved image attachment, create `{ type: "image", media_type: attachment.media_type!, data: attachment.binary_content!, width: attachment.width ?? undefined, height: attachment.height ?? undefined }`. The `!` assertions are safe because `resolveAttachment()` populates these fields before status becomes `"resolved"`. **null-to-undefined mapping:** Attachment uses `null` for absent dimensions; ContentBlock uses `undefined`. The `?? undefined` coercion handles this (e.g., `attachment.width ?? undefined` converts `null` → `undefined`)
    - **Implementation structure:** The existing loop over resolved attachments (lines 435-466) should be split: text attachments (`vault_note`, `vault_note_section`, `external_file`) continue through the existing XML `<attachments>` block construction unchanged (producing the `text` field). Binary attachments (`vault_image`, `external_image`, and later PDF types) are collected into the `contentBlocks` array using the ContentBlock construction described above. A single pass with type-based branching is sufficient
    - **Edge cases:** When no text attachments are resolved, `text` is `null`. When no binary attachments are resolved, `contentBlocks` is `[]` (empty array). When no attachments at all are resolved, return `{ text: null, contentBlocks: [] }`
  - **Atomicity note:** Task 2.4 and 2.5 must be applied together — `orchestrator.ts:1224` is the **only** caller of `buildAttachmentsBlock()`. If implementing incrementally, update the return type and the caller destructuring in the same commit. The minimal adapter at the caller: `const { text: attachmentsText, contentBlocks } = buildAttachmentsBlock(resolvedAttachments);` followed by `attachmentsBlock = attachmentsText;` (replacing the current direct assignment). Task 2.5 finalizes the caller with the full `assembleUserContent()` integration

### 2.5 Message Assembly — Merge Text + Media

- [x] **Update `src/context/message-assembler.ts`**
  - Add `assembleUserContent(text: string, mediaBlocks: ContentBlock[]): string | ContentBlock[]` — this requires importing `ContentBlock` from `../media/types` into the existing string-only module. This is acceptable; `message-assembler.ts` is the composition point for user message content
    - If no media blocks → return plain string (existing behavior preserved)
    - If media blocks and `text` is non-empty → return `[{ type: "text", text }, ...mediaBlocks]`
    - If media blocks and `text.trim()` is empty → return `[...mediaBlocks]` directly (no empty or whitespace-only text block — providers like Anthropic reject empty text content blocks, and whitespace-only blocks are equally problematic)
  - **Note:** The existing `MessageParts` interface keeps `attachments?: string` unchanged — it receives only the text portion from the destructured `buildAttachmentsBlock()` return value. The `contentBlocks` are handled separately via `assembleUserContent()`.

- [x] **Update `src/chat/orchestrator.ts` (~lines 1206-1225)**
  - `buildAttachmentsBlock()` (called at line 1224) now returns `{ text, contentBlocks }`
  - Destructure: `const { text: attachmentsText, contentBlocks } = buildAttachmentsBlock(resolvedAttachments);`
  - Pass `attachmentsText` (not the full return value) to `assembleUserMessage({ attachments: attachmentsText ?? undefined, ... })` — the `MessageParts.attachments` field remains `string`
  - After `const assembledContent = assembleUserMessage({...})` (existing variable at line ~1253), call `const finalContent = assembleUserContent(assembledContent, contentBlocks)` to merge
  - Store `finalContent` as `Message.content` (persisted to JSONL including base64)

### 2.6 Tool Result Media Propagation

The dispatcher (`src/chat/dispatcher.ts`) does **not** need changes — it already passes `ToolResult` objects through intact via `onToolCallResult`. The real gap is the `ChatMessage.tool_results` type and the `toChatMessages()` mapping in the orchestrator.

**Current flow:** `ToolResult` (with new `content_blocks`) → stored on `Message.tool_result` → `toChatMessages()` at orchestrator.ts:2081 maps it to `ChatMessage.tool_results[]` entry → providers read `tr.result` (string only). The `content_blocks` field is lost in the `toChatMessages()` mapping because `ChatMessage.tool_results[]` has no `content_blocks` field.

- [x] **Update `src/providers/provider.ts:31-36`** — Extend `ChatMessage.tool_results[]` entry type
  - Add `content_blocks?: ContentBlock[]` to the tool result entry interface
  - Current interface: `{ tool_call_id: string; tool_name: string; result: string; is_error: boolean }`
  - Add: `content_blocks?: ContentBlock[]`

- [x] **Update `src/chat/orchestrator.ts:2081-2093`** — `toChatMessages()` tool result mapping
  - Current: maps `msg.tool_result` → `{ tool_call_id, tool_name, result: resultStr, is_error }`
  - Add `content_blocks: msg.tool_result.content_blocks` to this object literal when `msg.tool_result.content_blocks` is present — this matches the type extension from the `provider.ts` update above

- [x] **Update provider `toXxxMessages()` functions** — Format `content_blocks` in tool results
  - Refactor the inline `ContentBlock` mapping logic added in Task 1.3 into a named helper function within each provider file, then reuse that helper for both user messages (updating the Task 1.3 call sites) and tool results. Do not create a cross-provider shared module. The helper's shape is provider-specific — reuse the exact mapping logic defined in Task 1.3 for each provider (e.g., Bedrock: `function mapContentBlock(block: MediaContentBlock): BedrockContentBlock` returning `{ image: { format, source: { bytes } } }` etc.; Anthropic: returns `{ type: "image", source: { type: "base64", ... } }` etc.). The return type is the provider's native content block type
  - **Anthropic** (line 88): `content: tr.result` (currently a string) → when `tr.content_blocks` present, switch to array format: `content: [{ type: "text", text: tr.result }, ...blocks.map(b => mapBlock(b))]`. Anthropic's `tool_result` content field accepts either a string or an array — when `content_blocks` is absent, keep the existing string format for backward compatibility. When `tr.result` is an empty string (`""`) and `content_blocks` is present, omit the text block from the array
  - **OpenAI** (line 79): `content: tr.result` → when `tr.content_blocks` present: as of early 2026, OpenAI does not support multipart content arrays in tool result messages (`role: "tool"`) — only string content is accepted. Use only the text summary from `tr.result` and log a `log.warn()` when image blocks are dropped. Verify this is still the case at implementation time, as the API may have changed. If OpenAI has added multipart tool result support by implementation time, follow the Anthropic pattern: `content: [{ type: "text", text: tr.result }, ...mappedBlocks]`
  - **Bedrock** (lines 112-118): `content: [{ text: tr.result }]` is inside a `{ toolResult: { toolUseId, content: [...], status } }` structure (the `content` field is specifically at line 115). Append mapped image/document blocks **inside the `toolResult.content` array**, using the same Bedrock-native format as user messages: `{ image: { format, source: { bytes: Buffer.from(data, "base64") } } }`. **Note:** Verify via the AWS SDK types that `toolResult.content[]` accepts the same `{ image: { format, source: { bytes } } }` structure as `converseMessage.content[]`
  - **Local** (line 107): same as OpenAI (text summary only for tool results, drop image blocks with `log.warn()`)
  - **Sub-agent note:** The sub-agent system (`sub-agent-runner.ts`) shares the same `toChatMessages()` in the orchestrator, so tool result `content_blocks` propagation applies to sub-agents automatically. No separate update needed

### 2.7 UI Changes

- [x] **Update `src/ui/attachment-picker.ts`**
  - Expand `openExternalFileDialog()` accepted extensions (line 584-586):
    - Add: `.png,.jpg,.jpeg,.gif,.webp`
  - Add `readExternalBinaryFile(absolutePath: string, maxSizeMb?: number): Promise<{ base64: string; mediaType: string; width?: number; height?: number } | null>` for binary file reading. Returns `null` if the file exceeds size limit, cannot be read, or `detectMediaFormat()` returns a non-image format (including `null` for unknown binaries and `"pdf"` — PDFs are handled separately in Phase 3, Task 3.5). Default `maxSizeMb`: 50 (matching the `read_file` raw size limit from Task 2.3). Detect media type via `detectMediaFormat()` on the first bytes of the buffer. **For image files:** process through `processImage()` (resize/compress) before returning — extract `data`, `media_type`, `width`, `height` from the returned `ContentBlock`. Image processing settings (`maxDimension`, `compressionQuality`) are read from `this.settings.image_max_dimension` and `this.settings.image_compression_quality` within the method body — they are not function parameters (the attachment picker class has access to `this.settings`). This ensures external images go through the same compression cascade as vault images
  - Route image files to binary read path instead of UTF-8 text read. **ContentBlock extraction:** Extract fields from the returned `ContentBlock` for the return object: `block.data` → `base64`, `block.media_type` → `mediaType`, `block.width` → `width`, `block.height` → `height`
  - Update `VaultNoteSuggest` (lines 173-389) to show image files from vault (not just `.md`):
    - **API change required:** Replace `this.app.vault.getMarkdownFiles()` (line 270) with `this.app.vault.getFiles()` and filter manually by extension (`.md`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`). `getMarkdownFiles()` is an Obsidian API that only returns `.md` files and cannot be configured to include other types. (PDF files are added separately in Phase 3, Task 3.5)
    - Update suggestion rendering to show a distinct icon for image files (vs. the existing note icon)
    - Update `selectSuggestion()` (line 373) to check the file extension: for `.md` files, continue calling `createVaultNoteAttachment()` (line 386); for image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), call `createVaultImageAttachment(file.path)` (from Task 2.4) instead. The binary reading happens inside `resolveAttachment()`, not at selection time — do not use `readExternalBinaryFile()` for vault files.

- [x] **Update `src/ui/attachment-chips.ts`**
  - Add image-specific chip rendering (image icon instead of paper clip)
  - Consider small thumbnail preview for image chips (or defer to Phase 4)

### 2.8 Settings

- [x] **Update `src/settings/types.ts`** — Add to `NotorSettings`:
  - `image_max_dimension: number` (default: 2000)
  - `image_compression_quality: number` (default: 80)

- [x] **Update `src/settings/defaults.ts`** — Add defaults for new settings

### 2.10 Image-Only Title Fallback

- [x] **Update `src/chat/conversation.ts:348`** — Image-only title fallback
  - In Phase 1 (Task 1.6), `generateTitle` was wrapped with `getTextContent()`. Now that image-only user messages are possible, add an empty-content fallback:
    `const text = getTextContent(params.content); this.activeConversation.title = this.generateTitle(text || "Image conversation");`

### 2.9 Verification

- [x] **Manual test: Attachment picker** — Attach image via file dialog → chip appears with image icon → send message → model describes image content (covered by `e2e/scripts/image-handling-test.ts` test 7)
- [x] **Manual test: read_file tool** — LLM calls `read_file` on a `.png` → receives image block → describes image (covered by `e2e/scripts/image-handling-test.ts` tests 4-5)
- [ ] **Manual test: Provider compatibility** — Test with Anthropic and OpenAI providers
- [ ] **Unit tests** — image-processor pipeline, capabilities lookup, attachment factory functions
- [x] **Build check** — `npm run build` succeeds, bundle size increase is acceptable (<100KB for new code, no new deps)

---

## Phase 3: PDF Handling

**Goal:** Full PDF support via `read_file` tool and attachments. Native document blocks for Anthropic/Bedrock; text extraction fallback for OpenAI/Local.

### 3.1 PDF Library Evaluation

- [x] **Run library evaluation** (per design spec section 3.3)
  - Evaluated `unpdf` (v1.4.0) and `pdf-parse-new` (v2.0.0)
  - **Decision: `unpdf`** — selected as the PDF text extraction library
  - **Rationale:**
    - `pdf-parse-new` disqualified: ~3.1MB raw bundle (would nearly double the plugin), Node >= 20.11 engine requirement (risky for older Obsidian/Electron), poor maintenance (22 stars, questionable packaging with test fixtures in published package)
    - `unpdf` is the clear winner: ~1.4MB raw bundle (smaller by 2x+), well-maintained (unjs ecosystem, 1.1K stars), zero runtime dependencies, CJS entry point available
    - Neither meets strict 500KB target — mitigate with lazy loading via dynamic `import()` so PDF.js is only loaded when PDF features are used
  - **Implementation notes for Task 3.2:**
    - Page-level extraction: use `getDocumentProxy()` from unpdf to get the pdf object, then `pdf.getPage(n)` + `getTextContent()` for specific pages (the convenience `extractText()` wrapper does not support page ranges)
    - Text extraction quality is basic (raw PDF.js `getTextContent()`) — adequate for plain text, limited for complex tables/multi-column layouts
    - `isEvalSupported: false` is set by default (good for Electron CSP)
    - Consider marking `unpdf/pdfjs` as external in esbuild and loading separately to reduce main bundle impact

### 3.2 New Files

- [x] **Create `src/media/pdf-processor.ts`**
  - Install `unpdf` as production dependency in `package.json`
  - Implement text extraction path:
    - Load PDF via library → extract text (full or page range) → clean (normalize whitespace, remove control chars) → truncate to configurable limit (default 400K chars)
  - Implement native document block path:
    - Magic byte check (`%PDF-`) → base64 encode raw buffer → size check against provider limits → return `ContentBlock { type: "document" }`
  - Page range support: parse `"1-5"`, `"3"`, `"10-20"` syntax (1-indexed). Supports a single contiguous range only. Comma-separated or multiple ranges (e.g., `"1-3,7-9"`, `"1,3,5"`) are not supported — return an error with a descriptive message if commas are detected
  - Consult `getMediaCapabilities()` to decide native vs text path
  - Export `processPdf(buffer: Buffer, options: { pages?: string; providerType: string }): Promise<{ contentBlocks: ContentBlock[]; textSummary: string }>` — returns a single-element array in current implementation (one document or one text block), but callers must handle arrays of any length. Array type aligns with `ToolResult.content_blocks` and allows future page-splitting if needed
  - **`textSummary` content:** For the text extraction path, `textSummary` is the extracted text (truncated to the configured limit). For the native document block path, `textSummary` is a short descriptor: `"PDF document (N pages, M.M MB)"` — full text extraction is skipped since the native block carries the raw PDF. This summary is used as the `ToolResult.result` fallback for providers that don't support native PDF

### 3.3 Tool Changes — Extend `read_file` for PDFs

- [x] **Update `src/tools/read-file.ts`**
  - Add `pages` parameter to `input_schema`: `{ type: "string", description: "Page range for PDF files (e.g. '1-5', '3', '10-20'). Ignored for non-PDF files." }`
  - **Out-of-range pages:** When the requested range extends beyond the document's page count (e.g., `pages: "1-100"` on a 5-page PDF), return all available pages within the range without error. When the entire range is out of bounds (e.g., `pages: "50-60"` on a 5-page PDF), return an error: `"Requested pages 50-60 but document has only 5 pages"`
  - Update `description` to mention PDF support
  - In the format detection branch (added in Phase 2):
    - If PDF detected → process via `processPdf()` → return `ToolResult` with `content_blocks` (native doc block or text) + text summary in `result`
    - When `pages` param provided, force text extraction path (native document blocks require the full PDF binary — creating a partial PDF for native blocks would require a PDF manipulation library, which is out of scope)
    - **Provider type threading:** Read the active provider from `this.settings.active_provider` (defined at `src/settings/types.ts:73`, a string matching `"anthropic" | "openai" | "bedrock" | "local"`) and pass it as `providerType` to `processPdf()`. This determines whether the PDF is sent as a native document block (Anthropic/Bedrock) or extracted to text (OpenAI/Local).

### 3.4 Attachment System — PDF Support

- [x] **Update `src/context/attachment.ts`**
  - Add attachment types: `"vault_pdf"`, `"external_pdf"` to `AttachmentType`
  - Add factory: `createVaultPdfAttachment(path: string): Attachment`
  - Update `resolveAttachment()` for PDF types:
    - Add `providerType?: string` optional parameter to `resolveAttachment()`, threaded from the orchestrator which passes `this.settings.active_provider`. Full signature after change: `resolveAttachment(app: App, attachment: Attachment, providerType?: string): Promise<Attachment>`. At the orchestrator call site (line 1211), update to: `resolveAttachment(this.app, att, this.settings.active_provider)`. Only used when `attachment.type` is `"vault_pdf"` or `"external_pdf"` — image attachments (Phase 2) do not need it. Making it optional avoids breaking existing Phase 2 callers. When `providerType` is omitted for a PDF attachment, default to the text extraction path (the universal fallback — all providers support text)
    - Read binary via `app.vault.readBinary(file)` or `fs.promises.readFile()`
    - Process through PDF pipeline (native or text extraction based on `providerType`)
    - Store base64 in `binary_content`
  - Update `buildAttachmentsBlock()` to produce PDF `ContentBlock` entries

### 3.5 UI Changes

- [x] **Update `src/ui/attachment-picker.ts`**
  - Add `.pdf` to accepted extensions in `openExternalFileDialog()`
  - Route PDF files to binary read path
  - Update `VaultNoteSuggest.getSuggestions()` (from Task 2.7's `getFiles()` filter) to add `.pdf` to the allowed extensions list
  - Update `selectSuggestion()` to route `.pdf` files to `createVaultPdfAttachment(file.path)` (from Task 3.4)

- [x] **Update `src/ui/attachment-chips.ts`**
  - Add PDF-specific chip rendering (PDF icon)

### 3.6 Settings

- [x] **Update `src/settings/types.ts`** — Add to `NotorSettings`:
  - `pdf_native_max_size_mb: number` (default: 10)
  - `pdf_text_max_chars: number` (default: 400000)
  - `pdf_prefer_native: boolean` (default: true)

- [x] **Update `src/settings/defaults.ts`** — Add defaults for PDF settings

- [x] **Update `src/settings/sections/media.ts`** — Add PDF settings to the "Images & PDFs" subsection (under "Tool configuration" group)

### 3.7 Verification

- [ ] **Manual test: Anthropic** — Attach PDF → provider receives native document block → model summarizes PDF
- [ ] **Manual test: OpenAI** — Attach PDF → provider receives extracted text → model summarizes PDF
- [ ] **Manual test: read_file with pages** — `read_file` on PDF with `pages: "1-5"` → correct pages extracted
- [ ] **Manual test: Edge cases** — Encrypted PDF (graceful error), image-only PDF (no text layer → empty text warning), corrupt PDF (graceful error)
- [x] **Unit tests** — PDF processor, page range parsing, provider capability routing
- [x] **Build check** — Bundle size acceptable with new PDF dependency

---

## Phase 2.5: DOCX Image Handling

**Goal:** Add image extraction in `read_docx` (save to vault) and image embedding in `write_docx` (read from vault). Independent of the Content Block System — pure filesystem I/O.

> **Scheduling note:** This phase is fully independent of Phases 1–3 and can be implemented in parallel with any of them. It is numbered "2.5" for thematic grouping, not to indicate a dependency on Phase 2.

### 2.5.1 Type Declarations

- [x] **Expand `src/mammoth.d.ts`** (currently 6 lines)
  - Add `Options` interface with `convertImage?: ImageConverter`
  - Add `ImageConverter` branded type
  - Add `Image` interface: `contentType: string`, `readAsBuffer(): Promise<Buffer>`, `readAsArrayBuffer(): Promise<ArrayBuffer>`, `readAsBase64String(): Promise<string>`
  - Add `ImageAttributes` interface: `src: string`, `alt?: string`
  - Add `Images` namespace: `dataUri: ImageConverter`, `imgElement(f: (image: Image) => Promise<ImageAttributes>): ImageConverter`
  - Update `convertToHtml` signature to use typed `Options`
  - Add `extractRawText` export
  - Add `images` export

### 2.5.2 `read_docx` — Image Extraction

- [x] **Update `src/tools/read-docx.ts`**
  - Add `import { createHash } from "crypto"`
  - Implement mammoth `convertImage` handler (before `convertToHtml` call at line 142). **`this` binding:** use an arrow function for the callback passed to `mammoth.images.imgElement()` to preserve lexical `this` access to `this.app` for vault operations.
    - Check format against supported list (`image/png`, `image/jpeg`, `image/gif`, `image/webp`)
    - Skip unsupported formats (EMF, WMF, SVG, TIFF) with descriptive alt text
    - Read image as buffer via `image.readAsBuffer()` — returns a Node.js `Buffer` (Electron's polyfill in the renderer process)
    - Generate MD5 hash filename: `${hash}.${ext}`
    - Resolve vault path via `this.app.fileManager.getAvailablePathForAttachment(filename, sourcePath)` where `sourcePath` is the vault-relative path of the source DOCX file (for "same folder as current file" attachment settings). When the DOCX path is vault-relative, pass it directly as `sourcePath`. When the DOCX path is absolute (outside the vault), omit `sourcePath` — Obsidian falls back to the default attachment folder. **Detection:** check if `this.app.vault.getFileByPath(inputPath)` returns a `TFile`. If yes, `inputPath` is vault-relative — pass it as `sourcePath`. If no (returns null), the path is absolute — omit `sourcePath`
    - Check if file already exists (`this.app.vault.getFileByPath()`)
    - If not exists: save via `this.app.vault.createBinary(targetPath, buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))` — note: bare `buffer.buffer` is unsafe because a `Buffer` may be a view of a larger `ArrayBuffer`; the `.slice()` extracts only the relevant portion as required by Obsidian's vault API
    - Track extracted images with index for Turndown rule replacement
  - Replace existing Turndown image rule (lines 154-157: `filter: ["img"], replacement: () => "[image]"`) with vault-path-aware rule:
    - Match `__notor_img_N__` src pattern → emit `![alt](vaultPath)` markdown
    - Match `__notor_skip__` src → emit descriptive alt text
    - Fallback → `[image]`
  - Error handling: all image errors non-fatal — document with 10 images where 2 fail still returns text + 8 successful images

### 2.5.3 `write_docx` — Image Embedding

- [x] **Create `src/tools/docx-image-utils.ts`**
  - Define `DocxImageData` interface: `type: "jpg" | "png" | "gif" | "bmp"`, `buffer: Buffer`, `width: number`, `height: number`
  - Implement `resolveImageForDocx(href, vaultRoot, allowedPaths): Promise<DocxImageData | null>`
    - Vault-relative paths: resolve from vault root
    - Absolute paths: validate against `allowedPaths` via `resolveAndValidatePath()`
    - Data URIs: decode base64 directly to buffer
    - HTTP URLs: reject (no network I/O from tools)
    - **Not supported:** Obsidian wiki-link image references (`![[image.png]]`) are not parsed by marked's lexer. Only standard markdown `![alt](path)` syntax is processed
  - Format mapping: `image/png` → `"png"`, `image/jpeg` → `"jpg"`, `image/gif` → `"gif"`, `image/bmp` → `"bmp"`
  - WebP handling: if encountered, convert to PNG via Electron Canvas API. This requires DOM `Canvas` access — available because Obsidian tools execute in Electron's renderer process. If this assumption changes, conversion must be moved to a caller with DOM access.
  - Dimension detection via buffer header parsing (zero deps):
    - PNG: bytes 16-23 of IHDR chunk
    - JPEG: scan for SOF0/SOF2 marker
    - GIF: bytes 6-9
    - BMP: bytes 18-25
  - Max input image size: 20MB (reject larger with error)

- [x] **Update `src/tools/write-docx.ts`**
  - Add `ImageRun` to imports from `docx` (line 24-37)
  - **Signature change:** Update `generateDocx` from `(content: string, templatePath: string | null)` (current at write-docx.ts:251) to `(content: string, templatePath: string | null, vaultRoot: string, allowedPaths: string[])`. Note: `outputPath` is NOT a parameter of `generateDocx()` — file writing is handled in the tool's `execute()` method. In `execute()`, thread `vaultRoot` from `this.app.vault.adapter.basePath` and `allowedPaths` from `this.settings.read_file_allowed_paths` into the `generateDocx()` call. `generateDocx()` is a standalone function (not a class method), so it cannot access `this.settings` directly — these parameters are the only way to pass the values in.
  - **Image pre-resolution pass** — Both `buildDocxChildren()` (line 108) and `renderInline()` (line 53) are synchronous. The `docx` library's `Document`, `Paragraph`, `Table`, and `ImageRun` constructors all expect synchronous children arrays. Making either function async would require restructuring all constructor call sites.
    - **Strategy:** Add an async pre-pass in `generateDocx()` before calling `buildDocxChildren()`:
      1. **Recursively** walk all tokens from `marked.lexer()` output — image tokens are inline tokens nested inside `paragraph`, `blockquote`, `list` item, and `table` cell tokens (in marked v17, `![alt](url)` is parsed as `{ type: "paragraph", tokens: [{ type: "image", href: "url" }] }`). The walk must descend into each block token's `.tokens` and `.items[].tokens` arrays to find all `image` entries.
      2. Collect all `image` token `href` values from the recursive walk
      3. Resolve all images in parallel: `await Promise.all(hrefs.map(h => resolveImageForDocx(h, vaultRoot, allowedPaths)))` (both parameters are already available from the signature change above)
      4. Build a `Map<string, DocxImageData>` lookup from href → resolved image data
      5. Pass the map into `buildDocxChildren()` as a parameter
    - `buildDocxChildren()` stays synchronous — image lookup is a synchronous `map.get(href)` call
    - **Signature change cascade:** `buildDocxChildren(tokens, resolvedImages)` — note that `buildDocxChildren` does not currently call itself recursively (blockquote at line 167 and list at line 179 both delegate to `renderInline()`). However, if future changes add recursive calls, they must forward the `resolvedImages` map. The only call site to update is `generateDocx()` at line 256: `buildDocxChildren(tokens, resolvedImages)`
  - **Handle images in the `paragraph` case** of `buildDocxChildren()` (line 125-130) — in marked v17, standalone images are parsed as inline `image` tokens wrapped in a `paragraph` token, NOT as top-level `image` block tokens. Handle this by detecting single-image paragraphs:
    - When a `paragraph` token contains exactly one child token of `type: "image"`, render it as a dedicated `new Paragraph({ children: [new ImageRun({ type, data, transformation: { width, height }, altText })] })` using the pre-resolved map. **Scaling:** the `width`/`height` from buffer header parsing are raw pixel dimensions; scale proportionally to fit within page content area (~600px wide, ~800px tall at 96 DPI for standard A4/Letter with 1-inch margins). Apply the more restrictive of width and height constraints: `const wScale = width > 600 ? 600 / width : 1; const hScale = height > 800 ? 800 / height : 1; const scale = Math.min(wScale, hScale); if (scale < 1) { width = Math.round(width * scale); height = Math.round(height * scale); }`. If dimensions cannot be determined from the buffer, use a fallback of 400×300.
    - If the image href is not in the resolved map, render fallback: `new Paragraph({ children: [new TextRun({ text: "[Image: href]" })] })`
    - When a `paragraph` token contains an image mixed with other inline tokens (e.g., `text ![alt](url) more text`), render via `renderInline()` as today — the image token falls through to the default `raw` text rendering, which renders the image token's `.raw` property (the original markdown syntax, e.g., `![alt](url)`) as literal text in the Word document. This is acceptable: mixed image+text paragraphs are rare in practice, and the raw syntax preserves the reference. The `InlineChild` type union returned by `renderInline()` remains unchanged (`TextRun | ExternalHyperlink`) — `ImageRun` is used only in standalone image paragraphs constructed directly in `buildDocxChildren()`, not through `renderInline()`
    - **Known limitation:** Standalone images inside blockquotes, list items, and table cells are rendered as text placeholders (`![alt](url)` literal text), not as `ImageRun` elements. This is because `buildDocxChildren()` delegates these block types directly to `renderInline()` (blockquote line 167, list line 179, table cells line 201), which has no image handling. Fixing this would require refactoring these cases to detect nested image paragraphs, which is deferred — top-level standalone images cover the vast majority of real-world usage
    - Paragraphs with no image tokens continue through the existing `renderInline()` path unchanged
- [x] **Refactor template grafting — Step 1: Parse body DOMs (lines 286-338) — append deferred to Step 3**
  - The current grafting uses regex-based XML string manipulation (regex to extract `<w:body>`, regex to strip `<w:sectPr>`). Introducing DOM-based merging for relationships alongside regex-based body grafting creates an inconsistent, fragile mix. Migrate the entire grafting routine to `@xmldom/xmldom` (`^0.8.11`, already a direct dependency in package.json).
  - **Namespace handling for element lookup:** Use `getElementsByTagName("w:body")` — xmldom 0.8.x resolves prefixed tag names when the `w:` prefix is declared in the document (always true for OOXML). Use this as the primary approach. If at implementation time it returns an empty NodeList, fall back to `getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "body")`. Add an assertion after the call: `if (!bodyElements.length) throw new Error("Could not locate <w:body> in document.xml")`. **Note:** This `getElementsByTagNameNS()` fallback applies only to element lookup here in Step 1. Attribute access in Step 3 uses the prefixed form (`getAttribute("r:embed")`) exclusively — see Step 3 for rationale
  - Implementation:
    1. Parse generated `word/document.xml` with `DOMParser` → extract `<w:body>` child nodes
    2. Parse template `word/document.xml` with `DOMParser` → locate `<w:body>` element
    3. Remove all non-`<w:sectPr>` children from template body
    4. **Do NOT append generated body children yet** — rId remapping (Step 3) must happen first. Store the extracted generated body nodes for later
    5. After Steps 2 and 3 complete: import and append the remapped generated body children (excluding `<w:sectPr>`) into template body
    6. Serialize back with `XMLSerializer` → write to template zip
  - This replaces the current regex approach with equivalent DOM operations, reducing fragility
  - **Verify:** Generate a DOCX with template using both the old regex and new DOM approaches. Compare the output `word/document.xml` for semantic XML equivalence (attribute order and whitespace may differ — `DOMParser`/`XMLSerializer` may normalize these). Add a unit test that round-trips a known template and asserts the generated body content matches

- [x] **Refactor template grafting — Step 2: Copy `word/media/*` image files**
  - When the generated doc contains images (from `ImageRun`), copy all `word/media/*` binary files from the generated zip into the template zip
  - When the generated doc has no images, skip (no media to copy)
  - Handle duplicate media filenames: the `docx` library generates unique names (`image1.png`, `image2.png`), but if a filename already exists in the template, rename with a numeric suffix

- [x] **Refactor template grafting — Step 3: Merge `word/_rels/document.xml.rels` with rId conflict resolution**
  - Both the template and generated doc independently assign relationship IDs (`rId1`, `rId2`, etc.). Naively merging relationships causes collisions.
  - rId conflict resolution algorithm:
    1. Parse template's `word/_rels/document.xml.rels` with `DOMParser`
    2. Find highest rId number in template
    3. Parse generated doc's `word/_rels/document.xml.rels` with `DOMParser`
    4. Remap all generated rIds to `rId(maxId + offset)`
    5. Update the **generated body DOM nodes only** (from Step 1, not yet appended to template): walk all elements and, for each element with an `r:embed`, `r:id`, or `r:link` attribute, remap the value using the remap table. **Traversal method:** Use a recursive depth-first walk of the generated body DOM nodes. For each element node, check for `r:embed`, `r:id`, and `r:link` attributes via `getAttribute()`. A helper like `function walkElements(node: Node, fn: (el: Element) => void)` that recurses through `childNodes` filtering for `ELEMENT_NODE` is sufficient. **Attribute access:** Use `getAttribute("r:embed")` (prefixed form) — xmldom 0.8.x resolves prefixed attribute names when the `r:` namespace prefix is declared on an ancestor element, which is always the case in well-formed OOXML. Do NOT use `getAttributeNS()` here — the namespace URI for `r:` varies between relationship types, and the prefixed form is simpler and reliable for OOXML documents. These three attributes cover all relationship references used by `ImageRun`-generated content; other rId attributes (e.g., in headers/footers) are not present in generated body content. Do NOT walk template-originated nodes
    6. **Now** append the remapped generated body children into the template body (completing Step 1, sub-step 5)
    7. Append remapped `<Relationship>` elements to template `.rels` DOM
    8. Serialize updated `.rels` back to template zip

- [x] **Refactor template grafting — Step 4: Merge `[Content_Types].xml`**
  - Parse both `[Content_Types].xml` with `DOMParser`
  - **Extension source (primary approach):** Scan `word/media/*` filenames in the generated zip and extract their file extensions (e.g., `image1.jpeg` → `"jpeg"`, `image2.png` → `"png"`). This is more reliable than using the pre-resolved `DocxImageData` map, since the `docx` library may normalize extensions (e.g., `.jpg` → `.jpeg`). **Important:** the `docx` library writes JPEG media files as `imageN.jpeg`, so the Content_Types entry must use `Extension="jpeg"` — using `"jpg"` produces a corrupt DOCX that Word cannot open. The zip filename scan naturally captures this normalization
  - For each image extension found, add a `<Default Extension="..." ContentType="..."/>` entry to the template's `[Content_Types].xml` if not already present. Content type mapping: `"png"` → `"image/png"`, `"jpeg"` → `"image/jpeg"`, `"gif"` → `"image/gif"`, `"bmp"` → `"image/bmp"`. Check for duplicates by iterating existing `<Default>` child elements of the `<Types>` root and comparing `getAttribute("Extension")` against the target extension string.
  - Serialize back to template zip

  **Execution order summary for Steps 1-4 (critical — getting this wrong produces corrupt DOCX files):**
  1. Parse both DOMs (Step 1 sub-steps 1-4) — do NOT append generated body yet
  2. Copy `word/media/*` files (Step 2)
  3. Compute rId remapping and update generated body DOM nodes (Step 3 sub-steps 1-5)
  4. Append remapped body nodes into template (Step 3 sub-step 6, completing Step 1 sub-step 5)
  5. Merge relationships XML (Step 3 sub-steps 7-8)
  6. Merge Content_Types (Step 4)
  7. Serialize everything back to template zip

  **Code organization:** Implement Steps 1-4 as a single `async function graftIntoTemplate(generatedZip: PizZip, templateZip: PizZip): Promise<void>` that replaces the current regex-based grafting block (lines 286-338). Internal helper functions for readability are fine (e.g., `remapRelationshipIds()`, `mergeContentTypes()`), but keep them scoped within or adjacent to the grafting function — they are not reusable outside this context

### 2.5.4 Verification

- [x] **Manual test: read_docx** — Read a `.docx` with images → images saved to vault attachment folder → markdown output contains `![alt](path)` → images render in Obsidian preview
- [x] **Manual test: write_docx** — Write markdown with `![alt](path)` image references → open output in Word → images render
- [ ] **Manual test: Template grafting** — Write with template + images → styles preserved AND images present
- [x] **Manual test: Edge cases** — Duplicate images (same MD5 → same file), mixed formats (PNG + JPEG + unsupported EMF), document with no images (output identical to current)
- [x] **Unit tests** — `docx-image-utils.ts` (dimension parsing, format mapping, path resolution), mammoth convertImage handler

---

## Phase 4: Polish & Edge Cases

**Goal:** Handle remaining integration points, improve UX, add comprehensive test coverage.

### 4.1 MCP Tool Results with Images

- [x] **Handle MCP image results** — Currently omitted with `[N image(s) omitted]`
  - When MCP tools return image content, convert to `ContentBlock` and include in tool result
  - Respect provider media capabilities

### 4.2 Drag-and-Drop Support

- [x] **Add drag-and-drop for images/PDFs on chat input area**
  - Listen for `drop` events on the chat input container
  - Detect file type via extension/magic bytes
  - Route to appropriate attachment creation flow
  - Show attachment chip on successful drop

### 4.3 Image Thumbnail Preview

- [x] **Render small thumbnail preview in attachment chips** for image attachments
  - Use `<img src="data:...">` with small dimensions (e.g., 32x32) in the chip element
  - Only for images, not PDFs

### 4.4 Provider-Specific Token Formulas

- [x] **Implement OpenAI tile-based image token formula**
  - `170 * ceil(w/512) * ceil(h/512) + 85` (high detail mode)
  - Add `provider?: string` parameter to `estimateImageTokens`
  - Reduces overestimation for image-heavy conversations on OpenAI

### 4.5 HTML Export — Inline Images

- [x] **Optionally embed images in HTML export**
  - When exporting to HTML, image blocks render as `<img src="data:{mediaType};base64,{data}">` inline
  - PDF blocks render as `[PDF document attached]` text

### 4.6 E2E Test Coverage

- [x] **E2E test: Image attachment flow** — Attach image → send → model responds with image description
- [x] **E2E test: PDF attachment flow** — Attach PDF → send → model summarizes content
- [x] **E2E test: read_file on image** — Tool call returns image block
- [x] **E2E test: read_file on PDF** — Tool call returns document block or text
- [ ] **E2E test: read_docx with images** — Images saved to vault, markdown contains paths
- [ ] **E2E test: write_docx with images** — Output contains embedded images
- [x] **E2E test: History persistence** — Send image → close/reopen conversation → image still present in history

---

## Dependency Summary

| Phase | New Production Dependencies | New Dev Dependencies |
|-------|---------------------------|---------------------|
| Phase 1 | None | None |
| Phase 2 | None (Electron Canvas API) | None |
| Phase 3 | `unpdf` | Test PDFs in `e2e/fixtures/pdf/` |
| Phase 2.5 | None (mammoth + docx already installed) | None |
| Phase 4 | None | E2E test fixtures |

**Total new production dependencies: 1** (`unpdf`, added in Phase 3)

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
