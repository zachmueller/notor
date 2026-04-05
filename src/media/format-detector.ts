/**
 * Detect media format from magic bytes in a buffer.
 * Returns the format string or null if unrecognized.
 */
export function detectMediaFormat(
	buffer: Buffer,
): "png" | "jpeg" | "gif" | "webp" | "pdf" | null {
	if (buffer.length < 12) {
		return null;
	}

	// PNG: 89 50 4E 47
	if (
		buffer[0] === 0x89 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x4e &&
		buffer[3] === 0x47
	) {
		return "png";
	}

	// JPEG: FF D8 FF
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return "jpeg";
	}

	// GIF: 47 49 46
	if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
		return "gif";
	}

	// WebP: bytes 0-3 = RIFF, bytes 8-11 = WEBP
	if (
		buffer[0] === 0x52 &&
		buffer[1] === 0x49 &&
		buffer[2] === 0x46 &&
		buffer[3] === 0x46 &&
		buffer[8] === 0x57 &&
		buffer[9] === 0x45 &&
		buffer[10] === 0x42 &&
		buffer[11] === 0x50
	) {
		return "webp";
	}

	// PDF: 25 50 44 46 (%PDF)
	if (
		buffer[0] === 0x25 &&
		buffer[1] === 0x50 &&
		buffer[2] === 0x44 &&
		buffer[3] === 0x46
	) {
		return "pdf";
	}

	return null;
}
