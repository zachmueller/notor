/**
 * Utilities for resolving and preparing images for embedding in DOCX files.
 *
 * Handles vault-relative paths, absolute paths, data URIs, format detection,
 * dimension parsing from buffer headers, and WebP→PNG conversion.
 *
 * @see specs/ZZ-misc/pdf-and-image-handling-tasks.md — Task 2.5.3
 */

import * as fs from "fs";
import { resolve, normalize } from "path";
import { resolveAndValidatePath } from "../utils/path-validation";
import { logger } from "../utils/logger";

const log = logger("DocxImageUtils");

/** Maximum input image size: 20MB. */
const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;

/** Supported docx image format identifiers. */
export type DocxImageFormat = "jpg" | "png" | "gif" | "bmp";

/** Resolved image data ready for embedding in a DOCX via ImageRun. */
export interface DocxImageData {
	type: DocxImageFormat;
	buffer: Buffer;
	width: number;
	height: number;
}

// ---------------------------------------------------------------------------
// Format detection & MIME → docx format mapping
// ---------------------------------------------------------------------------

/**
 * Detect image format from magic bytes. Returns the MIME type or null.
 */
function detectImageMime(buffer: Buffer): string | null {
	if (buffer.length < 12) return null;

	// PNG
	if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
		return "image/png";
	}
	// JPEG
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "image/jpeg";
	}
	// GIF
	if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
		return "image/gif";
	}
	// BMP
	if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
		return "image/bmp";
	}
	// WebP: RIFF....WEBP
	if (
		buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
		buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
	) {
		return "image/webp";
	}

	return null;
}

const MIME_TO_FORMAT: Record<string, DocxImageFormat> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/bmp": "bmp",
};

// ---------------------------------------------------------------------------
// Dimension parsing from buffer headers (zero deps)
// ---------------------------------------------------------------------------

/** Parse PNG dimensions from the IHDR chunk (bytes 16-23). */
function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
	if (buffer.length < 24) return null;
	const width = buffer.readUInt32BE(16);
	const height = buffer.readUInt32BE(20);
	return width > 0 && height > 0 ? { width, height } : null;
}

/** Parse JPEG dimensions by scanning for SOF0 (0xFFC0) or SOF2 (0xFFC2) markers. */
function parseJpegDimensions(buffer: Buffer): { width: number; height: number } | null {
	let offset = 2; // skip SOI marker
	while (offset < buffer.length - 1) {
		if (buffer[offset] !== 0xff) return null;
		const marker = buffer[offset + 1];
		// SOF0 or SOF2
		if (marker === 0xc0 || marker === 0xc2) {
			if (offset + 9 > buffer.length) return null;
			const height = buffer.readUInt16BE(offset + 5);
			const width = buffer.readUInt16BE(offset + 7);
			return width > 0 && height > 0 ? { width, height } : null;
		}
		// Skip this segment
		if (offset + 3 >= buffer.length) return null;
		const segLength = buffer.readUInt16BE(offset + 2);
		offset += 2 + segLength;
	}
	return null;
}

/** Parse GIF dimensions from bytes 6-9. */
function parseGifDimensions(buffer: Buffer): { width: number; height: number } | null {
	if (buffer.length < 10) return null;
	const width = buffer.readUInt16LE(6);
	const height = buffer.readUInt16LE(8);
	return width > 0 && height > 0 ? { width, height } : null;
}

/** Parse BMP dimensions from bytes 18-25. */
function parseBmpDimensions(buffer: Buffer): { width: number; height: number } | null {
	if (buffer.length < 26) return null;
	const width = buffer.readInt32LE(18);
	const height = Math.abs(buffer.readInt32LE(22)); // height can be negative (top-down)
	return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * Parse image dimensions from a buffer based on its MIME type.
 * Returns null if dimensions cannot be determined.
 */
export function parseImageDimensions(
	buffer: Buffer,
	mime: string,
): { width: number; height: number } | null {
	switch (mime) {
		case "image/png": return parsePngDimensions(buffer);
		case "image/jpeg": return parseJpegDimensions(buffer);
		case "image/gif": return parseGifDimensions(buffer);
		case "image/bmp": return parseBmpDimensions(buffer);
		default: return null;
	}
}

// ---------------------------------------------------------------------------
// WebP → PNG conversion via Electron Canvas API
// ---------------------------------------------------------------------------

async function convertWebpToPng(buffer: Buffer): Promise<{ buffer: Buffer; width: number; height: number }> {
	const blob = new Blob([buffer], { type: "image/webp" });
	const url = URL.createObjectURL(blob);

	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("Failed to decode WebP image for conversion"));
			img.src = url;
		});

		const width = img.naturalWidth;
		const height = img.naturalHeight;
		if (width === 0 || height === 0) {
			throw new Error("WebP image has zero dimensions");
		}

		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("Failed to create canvas 2D context for WebP conversion");
		ctx.drawImage(img, 0, 0, width, height);

		const dataUrl = canvas.toDataURL("image/png");
		if (!dataUrl || dataUrl === "data:,") {
			throw new Error("Canvas toDataURL returned empty during WebP conversion");
		}
		const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
		const pngBuffer = Buffer.from(base64, "base64");
		return { buffer: pngBuffer, width, height };
	} finally {
		URL.revokeObjectURL(url);
	}
}

// ---------------------------------------------------------------------------
// Main resolver
// ---------------------------------------------------------------------------

/**
 * Resolve an image href (from markdown `![alt](href)`) to a `DocxImageData`
 * suitable for embedding via `ImageRun`.
 *
 * Supported href types:
 *   - Vault-relative path: resolved from `vaultRoot`
 *   - Absolute path: validated against `allowedPaths`
 *   - Data URI: decoded inline (e.g., `data:image/png;base64,...`)
 *   - HTTP URLs: rejected (no network I/O from tools)
 *
 * Returns `null` when the image cannot be resolved (unsupported format,
 * file not found, oversized, HTTP URL, etc.).
 */
export async function resolveImageForDocx(
	href: string,
	vaultRoot: string,
	allowedPaths: string[],
): Promise<DocxImageData | null> {
	// Reject HTTP URLs
	if (href.startsWith("http://") || href.startsWith("https://")) {
		log.warn("HTTP image URLs not supported in write_docx", { href });
		return null;
	}

	let buffer: Buffer;
	let detectedMime: string | null;

	if (href.startsWith("data:")) {
		// Data URI
		const match = href.match(/^data:([^;]+);base64,(.+)$/);
		if (!match) {
			log.warn("Malformed data URI", { href: href.substring(0, 50) });
			return null;
		}
		const mimeFromUri = match[1]!;
		buffer = Buffer.from(match[2]!, "base64");
		detectedMime = detectImageMime(buffer) ?? mimeFromUri;
	} else {
		// File path: vault-relative or absolute
		const pathResult = resolveAndValidatePath(href, vaultRoot, allowedPaths);
		if (!pathResult.valid) {
			// Try resolving as vault-relative explicitly
			const vaultResolved = normalize(resolve(vaultRoot, href));
			const retryResult = resolveAndValidatePath(vaultResolved, vaultRoot, allowedPaths);
			if (!retryResult.valid) {
				log.warn("Image path outside allowed boundaries", { href });
				return null;
			}
			try {
				buffer = await fs.promises.readFile(retryResult.resolvedPath);
			} catch {
				log.warn("Image file not found", { href, resolved: retryResult.resolvedPath });
				return null;
			}
		} else {
			try {
				buffer = await fs.promises.readFile(pathResult.resolvedPath);
			} catch {
				log.warn("Image file not found", { href, resolved: pathResult.resolvedPath });
				return null;
			}
		}
		detectedMime = detectImageMime(buffer);
	}

	if (buffer.length > MAX_IMAGE_INPUT_BYTES) {
		log.warn("Image exceeds 20MB limit", { href, size: buffer.length });
		return null;
	}

	// WebP: convert to PNG via Canvas
	if (detectedMime === "image/webp") {
		try {
			const converted = await convertWebpToPng(buffer);
			return {
				type: "png",
				buffer: converted.buffer,
				width: converted.width,
				height: converted.height,
			};
		} catch (err) {
			log.warn("WebP conversion failed", { href, error: err instanceof Error ? err.message : String(err) });
			return null;
		}
	}

	// Map to docx format
	const format = detectedMime ? MIME_TO_FORMAT[detectedMime] : null;
	if (!format) {
		log.warn("Unsupported image format for DOCX embedding", { href, mime: detectedMime });
		return null;
	}

	// Parse dimensions
	const dims = parseImageDimensions(buffer, detectedMime!);
	const width = dims?.width ?? 400;
	const height = dims?.height ?? 300;

	return { type: format, buffer, width, height };
}
