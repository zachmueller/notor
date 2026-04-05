/**
 * Image processor — resize, compress, and encode images for LLM consumption.
 *
 * Uses Electron Canvas API (zero new dependencies) for resize + compress.
 * Pipeline: buffer → Image() load → validate → resize if needed → compress → base64.
 *
 * Format-aware compression cascade:
 *   - PNG: try PNG first → if >5MB, cascade JPEG 80 → 60 → 40
 *   - JPEG: try quality 80 → 60 → 40 → 20
 *   - GIF/WebP: convert to PNG first, then PNG cascade
 *
 * @see specs/ZZ-misc/pdf-and-image-handling-design.md — Section 3.1
 */

import type { ContentBlock, ImageMediaType } from "./types";
import { MAX_IMAGE_BASE64_BYTES } from "./types";

/**
 * Process an image buffer into a ContentBlock suitable for LLM consumption.
 *
 * Callers must detect the media type before calling (via `detectMediaFormat()`).
 * Throws on unrecoverable errors (corrupt image, Canvas load failure, exceeding
 * size limit after maximum compression, zero-dimension images).
 *
 * @param buffer - Raw image buffer.
 * @param mediaType - Detected MIME type of the image.
 * @param options - Optional processing configuration.
 * @returns A ContentBlock of type "image" with data, media_type, width, height.
 */
export async function processImage(
	buffer: Buffer,
	mediaType: ImageMediaType,
	options?: { maxDimension?: number; compressionQuality?: number },
): Promise<ContentBlock> {
	const maxDim = options?.maxDimension ?? 2000;
	const quality = options?.compressionQuality ?? 80;

	// Load image to get dimensions
	const img = await loadImage(buffer, mediaType);
	const origW = img.naturalWidth;
	const origH = img.naturalHeight;

	if (origW === 0 || origH === 0) {
		throw new Error("Failed to decode image: zero dimensions");
	}

	// Check if we can skip processing entirely
	const needsResize = origW > maxDim || origH > maxDim;
	const estimatedBase64Size = Math.ceil(buffer.length * 4 / 3);
	const needsCompression = estimatedBase64Size > MAX_IMAGE_BASE64_BYTES;

	if (!needsResize && !needsCompression) {
		// Return original buffer as base64 — no quality loss
		const data = buffer.toString("base64");
		return {
			type: "image",
			media_type: mediaType,
			data,
			width: origW,
			height: origH,
		};
	}

	// Calculate target dimensions
	let targetW = origW;
	let targetH = origH;
	if (needsResize) {
		const scale = maxDim / Math.max(origW, origH);
		targetW = Math.round(origW * scale);
		targetH = Math.round(origH * scale);
	}

	// Draw to canvas at target dimensions
	const canvas = document.createElement("canvas");
	canvas.width = targetW;
	canvas.height = targetH;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		throw new Error("Failed to create canvas 2D context");
	}
	ctx.drawImage(img, 0, 0, targetW, targetH);

	// Compression cascade based on format
	const result = await compressCascade(canvas, mediaType, quality);

	return {
		type: "image",
		media_type: result.mediaType,
		data: result.data,
		width: targetW,
		height: targetH,
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface CompressionResult {
	data: string;
	mediaType: ImageMediaType;
}

/**
 * Load a buffer into an HTMLImageElement and wait for it to decode.
 */
async function loadImage(buffer: Buffer, mediaType: ImageMediaType): Promise<HTMLImageElement> {
	const blob = new Blob([buffer], { type: mediaType });
	const url = URL.createObjectURL(blob);

	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("Failed to decode image"));
			img.src = url;
		});
		return img;
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Try encoding at progressively lower quality until the result fits
 * within MAX_IMAGE_BASE64_BYTES.
 */
async function compressCascade(
	canvas: HTMLCanvasElement,
	originalType: ImageMediaType,
	initialQuality: number,
): Promise<CompressionResult> {
	// GIF/WebP → treat as PNG (GIF: first frame only via canvas, WebP: may grow)
	const effectiveType: "image/png" | "image/jpeg" =
		originalType === "image/jpeg" ? "image/jpeg" : "image/png";

	if (effectiveType === "image/png") {
		// Try PNG first
		const pngData = canvasToBase64(canvas, "image/png");
		if (pngData.length <= MAX_IMAGE_BASE64_BYTES) {
			return { data: pngData, mediaType: "image/png" };
		}
		// PNG too large — cascade to JPEG
		for (const q of [80, 60, 40]) {
			const jpegData = canvasToBase64(canvas, "image/jpeg", q / 100);
			if (jpegData.length <= MAX_IMAGE_BASE64_BYTES) {
				return { data: jpegData, mediaType: "image/jpeg" };
			}
		}
	} else {
		// JPEG: cascade quality
		const qualities = [initialQuality, 60, 40, 20].filter(
			(q, i, arr) => arr.indexOf(q) === i && q <= initialQuality,
		);
		// Ensure we always try these specific levels
		for (const q of [initialQuality, 60, 40, 20]) {
			if (!qualities.includes(q)) qualities.push(q);
		}
		// Sort descending
		const sorted = [...new Set(qualities)].sort((a, b) => b - a);
		for (const q of sorted) {
			const jpegData = canvasToBase64(canvas, "image/jpeg", q / 100);
			if (jpegData.length <= MAX_IMAGE_BASE64_BYTES) {
				return { data: jpegData, mediaType: "image/jpeg" };
			}
		}
	}

	// All cascade steps exceeded the limit
	const finalData = canvasToBase64(canvas, "image/jpeg", 0.2);
	throw new Error(
		`Image exceeds 5MB after maximum compression (final size: ${finalData.length} bytes)`,
	);
}

/**
 * Convert a canvas to a base64 string (without the data URI prefix).
 */
function canvasToBase64(
	canvas: HTMLCanvasElement,
	mimeType: string,
	quality?: number,
): string {
	const dataUrl = canvas.toDataURL(mimeType, quality);
	if (!dataUrl || dataUrl === "data:,") {
		throw new Error("Canvas toDataURL returned empty string");
	}
	// Strip "data:<mime>;base64," prefix
	const commaIdx = dataUrl.indexOf(",");
	return dataUrl.slice(commaIdx + 1);
}
