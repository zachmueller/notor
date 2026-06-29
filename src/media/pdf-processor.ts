/**
 * PDF processing pipeline — text extraction and native document block creation.
 *
 * Two processing paths based on provider capabilities:
 *   1. **Native document block** (Anthropic, Bedrock): base64-encode the raw PDF
 *      and return a `ContentBlock` of type `"document"`. The provider receives
 *      the full PDF for its own parsing.
 *   2. **Text extraction** (OpenAI, Local, or when page ranges are requested):
 *      extract text via `unpdf` (PDF.js wrapper) and return a text `ContentBlock`.
 *
 * @see specs/ZZ-misc/pdf-and-image-handling-tasks.md — Task 3.2
 */

import type { ContentBlock } from "./types";
import { getMediaCapabilities } from "./capabilities";
import { logger } from "../utils/logger";

const log = logger("PdfProcessor");

// ---------------------------------------------------------------------------
// Page range parsing
// ---------------------------------------------------------------------------

/**
 * Parse a page range string into start/end page numbers (1-indexed).
 *
 * Supports: `"3"` (single page), `"1-5"` (contiguous range).
 * Does NOT support comma-separated or multiple ranges.
 *
 * @returns `{ start, end }` (both inclusive, 1-indexed) or an error string.
 */
export function parsePageRange(pages: string): { start: number; end: number } | string {
	const trimmed = pages.trim();

	if (trimmed.includes(",")) {
		return "Comma-separated page ranges are not supported. Use a single contiguous range (e.g., \"1-5\").";
	}

	if (trimmed.includes("-")) {
		const parts = trimmed.split("-");
		if (parts.length !== 2) {
			return `Invalid page range: "${trimmed}". Use format "start-end" (e.g., "1-5").`;
		}
		const start = parseInt(parts[0]!, 10);
		const end = parseInt(parts[1]!, 10);
		if (isNaN(start) || isNaN(end) || start < 1 || end < 1) {
			return `Invalid page numbers in range: "${trimmed}". Pages must be positive integers.`;
		}
		if (start > end) {
			return `Invalid page range: start (${start}) is greater than end (${end}).`;
		}
		return { start, end };
	}

	const page = parseInt(trimmed, 10);
	if (isNaN(page) || page < 1) {
		return `Invalid page number: "${trimmed}". Must be a positive integer.`;
	}
	return { start: page, end: page };
}

// ---------------------------------------------------------------------------
// Text extraction via unpdf
// ---------------------------------------------------------------------------

/**
 * Extract text from a PDF buffer, optionally for a specific page range.
 *
 * Uses `unpdf` (PDF.js wrapper) with lazy dynamic import so PDF.js is only
 * loaded when PDF features are actually used.
 */
async function extractPdfText(
	buffer: Buffer,
	pageRange?: { start: number; end: number },
	maxChars = 400000,
): Promise<{ text: string; totalPages: number }> {
	const { getDocumentProxy } = await import("unpdf");

	const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	const pdf = await getDocumentProxy(uint8, { isEvalSupported: false });
	const totalPages = pdf.numPages;

	const startPage = pageRange ? pageRange.start : 1;
	const endPage = pageRange ? Math.min(pageRange.end, totalPages) : totalPages;

	const pageTexts: string[] = [];
	let charCount = 0;

	for (let i = startPage; i <= endPage; i++) {
		const page = await pdf.getPage(i);
		const content = await page.getTextContent();

		// Join text items, preserving rough line structure
		const pageText = content.items
			.filter((item) => "str" in item)
			.map((item) => {
				const textItem = item as { str: string; hasEOL?: boolean };
				return textItem.str + (textItem.hasEOL ? "\n" : "");
			})
			.join("");

		const cleaned = cleanText(pageText);
		charCount += cleaned.length;
		pageTexts.push(cleaned);

		if (charCount >= maxChars) {
			break;
		}
	}

	let text = pageTexts.join("\n\n");
	if (text.length > maxChars) {
		text = text.slice(0, maxChars) + "\n\n[Text truncated at " + maxChars.toLocaleString() + " characters]";
	}

	// Clean up
	await pdf.cleanup();

	return { text, totalPages };
}

/**
 * Normalize whitespace and strip control characters from extracted PDF text.
 */
// Control characters to strip from extracted PDF text (everything in the C0
// range plus DEL, except the whitespace we keep: \n \r \t). Built at runtime so
// the source contains no control-char literals in a regex (no-control-regex).
const CONTROL_CHARS_TO_STRIP = (() => {
	const keep = new Set([0x09, 0x0a, 0x0d]); // \t \n \r
	let chars = "";
	for (let code = 0x00; code <= 0x1f; code++) {
		if (!keep.has(code)) chars += String.fromCharCode(code);
	}
	chars += String.fromCharCode(0x7f); // DEL
	return chars;
})();
const CONTROL_CHAR_REGEX = new RegExp(`[${CONTROL_CHARS_TO_STRIP}]`, "g");

function cleanText(raw: string): string {
	return raw
		// Strip control chars except \n \r \t
		.replace(CONTROL_CHAR_REGEX, "")
		// Normalize multiple blank lines to at most two newlines
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export interface PdfProcessorOptions {
	/** Page range string (e.g., "1-5", "3"). Forces text extraction path. */
	pages?: string;
	/** Provider type — determines native vs text extraction path. */
	providerType: string;
	/** Maximum characters for text extraction (default: 400000). */
	maxTextChars?: number;
	/** Whether to prefer native PDF blocks when the provider supports them (default: true). */
	preferNative?: boolean;
	/** Maximum native document size in bytes (overrides provider default). */
	maxNativeSizeBytes?: number;
}

/**
 * Process a PDF buffer into content blocks suitable for the active provider.
 *
 * @returns Content blocks (single-element array) and a text summary for fallback.
 * @throws On corrupt/encrypted PDFs or unrecoverable errors.
 */
export async function processPdf(
	buffer: Buffer,
	options: PdfProcessorOptions,
): Promise<{ contentBlocks: ContentBlock[]; textSummary: string }> {
	const capabilities = getMediaCapabilities(options.providerType);
	const maxTextChars = options.maxTextChars ?? 400000;
	const preferNative = options.preferNative ?? true;

	// Parse page range if provided
	let pageRange: { start: number; end: number } | undefined;
	if (options.pages) {
		const parsed = parsePageRange(options.pages);
		if (typeof parsed === "string") {
			throw new Error(parsed);
		}
		pageRange = parsed;
	}

	// Determine processing path:
	// - Page range requested → always text extraction (native requires full PDF)
	// - Provider supports native PDF + preference enabled → native document block
	// - Otherwise → text extraction
	const useNative = !pageRange && preferNative && capabilities.supportsNativePdf;

	if (useNative) {
		return processNative(buffer, capabilities.maxDocumentSizeBytes, options.maxNativeSizeBytes);
	}

	return processTextExtraction(buffer, pageRange, maxTextChars);
}

/**
 * Native document block path — base64-encode the raw PDF.
 */
async function processNative(
	buffer: Buffer,
	providerMaxBytes: number,
	overrideMaxBytes?: number,
): Promise<{ contentBlocks: ContentBlock[]; textSummary: string }> {
	const maxBytes = overrideMaxBytes ?? providerMaxBytes;

	// Size check: base64 encoding increases size by ~33%
	const base64Size = Math.ceil(buffer.length * 4 / 3);
	if (base64Size > maxBytes) {
		const sizeMb = (base64Size / (1024 * 1024)).toFixed(1);
		const limitMb = (maxBytes / (1024 * 1024)).toFixed(1);
		throw new Error(
			`PDF is too large for native document block (${sizeMb} MB base64, limit: ${limitMb} MB). ` +
			`Try using a page range to extract specific pages as text instead.`,
		);
	}

	// Get page count via unpdf for metadata
	let pageCount: number | undefined;
	try {
		const { getDocumentProxy } = await import("unpdf");
		const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		const pdf = await getDocumentProxy(uint8, { isEvalSupported: false });
		pageCount = pdf.numPages;
		await pdf.cleanup();
	} catch {
		// Non-fatal — page count is metadata only
		log.debug("Could not read page count for native PDF block");
	}

	const data = buffer.toString("base64");
	const sizeMb = (buffer.length / (1024 * 1024)).toFixed(1);
	const textSummary = `PDF document (${pageCount ?? "unknown"} pages, ${sizeMb} MB)`;

	log.info("Processed PDF as native document block", { pageCount, sizeMb });

	return {
		contentBlocks: [
			{
				type: "document",
				media_type: "application/pdf",
				data,
				page_count: pageCount,
			},
		],
		textSummary,
	};
}

/**
 * Text extraction path — extract text via unpdf and return as text block.
 */
async function processTextExtraction(
	buffer: Buffer,
	pageRange?: { start: number; end: number },
	maxChars = 400000,
): Promise<{ contentBlocks: ContentBlock[]; textSummary: string }> {
	const { text, totalPages } = await extractPdfText(buffer, pageRange, maxChars);

	if (!text.trim()) {
		log.info("PDF text extraction returned empty text (possibly image-only PDF)", { totalPages });
		const textSummary = `PDF document (${totalPages} pages) — no extractable text. This may be a scanned/image-only PDF.`;
		return {
			contentBlocks: [{ type: "text", text: textSummary }],
			textSummary,
		};
	}

	const rangeDesc = pageRange
		? `pages ${pageRange.start}-${pageRange.end} of ${totalPages}`
		: `${totalPages} pages`;

	const textSummary = `Extracted text from PDF (${rangeDesc}, ${text.length.toLocaleString()} chars)`;

	log.info("Extracted PDF text", { totalPages, rangeDesc, chars: text.length });

	return {
		contentBlocks: [{ type: "text", text }],
		textSummary,
	};
}
