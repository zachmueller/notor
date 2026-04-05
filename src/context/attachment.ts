/**
 * Attachment system — data model, content resolution, validation,
 * and XML serialization for user-attached notes and files.
 *
 * Attachment lifecycle:
 *   1. User adds via picker or `[[` shortcut → status: pending
 *   2. User can remove before sending → discarded
 *   3. At send time:
 *      - Vault notes/sections: content read from vault → resolved or error
 *      - External files: content already populated → resolved
 *   4. Resolved attachments serialized into `<attachments>` XML block
 *
 * @see specs/02-context-intelligence/tasks.md — ATT-001..ATT-004
 * @see specs/02-context-intelligence/data-model.md — Attachment entity
 * @see specs/02-context-intelligence/contracts/tool-schemas.md — Attachment Format
 */

import type { App, TFile } from "obsidian";
import type { ContentBlock } from "../media/types";
import { detectMediaFormat } from "../media/format-detector";
import { processImage } from "../media/image-processor";
import { processPdf } from "../media/pdf-processor";
import type { ImageMediaType } from "../media/types";

// ---------------------------------------------------------------------------
// ATT-001: Attachment data model
// ---------------------------------------------------------------------------

/** Attachment content source type. */
export type AttachmentType = "vault_note" | "vault_note_section" | "external_file" | "vault_image" | "external_image" | "vault_pdf" | "external_pdf";

/** Attachment resolution lifecycle status. */
export type AttachmentStatus = "pending" | "resolved" | "error";

/** A note, note section, or external file attached to a chat message. */
export interface Attachment {
	/** Unique identifier (UUID v4). */
	id: string;
	/** Content source type. */
	type: AttachmentType;
	/**
	 * For vault notes: vault-relative path (e.g., `Research/Climate.md`).
	 * For external files: original absolute file path at attach time.
	 */
	path: string;
	/** Section heading reference. Only for `vault_note_section` type. */
	section: string | null;
	/** Human-readable label shown in the attachment chip. */
	display_name: string;
	/**
	 * For external files: file content read at attach time.
	 * For vault notes/sections: null until resolution at send time.
	 */
	content: string | null;
	/** Length of the resolved content in characters (populated at send time). */
	content_length: number | null;
	/** Base64-encoded binary for images/PDFs (post-processing: resized/compressed for images). */
	binary_content: string | null;
	/** Detected MIME type (e.g., "image/png"). */
	media_type: string | null;
	/** Image width in pixels after processing (null for non-image attachments). */
	width: number | null;
	/** Image height in pixels after processing (null for non-image attachments). */
	height: number | null;
	/** Resolution lifecycle status. */
	status: AttachmentStatus;
	/** Error description if resolution failed. */
	error_message: string | null;
}

// ---------------------------------------------------------------------------
// UUID generation
// ---------------------------------------------------------------------------

/** Generate a UUID v4 string. */
function generateUUID(): string {
	// Use crypto.randomUUID if available, otherwise fallback
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	// Fallback for environments without crypto.randomUUID
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create an attachment for a full vault note.
 *
 * @param path - Vault-relative path to the note.
 * @returns A pending Attachment ready for resolution at send time.
 */
export function createVaultNoteAttachment(path: string): Attachment {
	// Extract filename without extension for display
	const filename = path.split("/").pop() ?? path;
	return {
		id: generateUUID(),
		type: "vault_note",
		path,
		section: null,
		display_name: filename,
		content: null,
		content_length: null,
		binary_content: null,
		media_type: null,
		width: null,
		height: null,
		status: "pending",
		error_message: null,
	};
}

/**
 * Create an attachment for a specific section of a vault note.
 *
 * @param path - Vault-relative path to the note.
 * @param section - Heading text identifying the section.
 * @returns A pending Attachment ready for resolution at send time.
 */
export function createVaultNoteSectionAttachment(
	path: string,
	section: string
): Attachment {
	const filename = path.split("/").pop() ?? path;
	return {
		id: generateUUID(),
		type: "vault_note_section",
		path,
		section,
		display_name: `${filename} § ${section}`,
		content: null,
		content_length: null,
		binary_content: null,
		media_type: null,
		width: null,
		height: null,
		status: "pending",
		error_message: null,
	};
}

/**
 * Create an attachment for an external file.
 *
 * Content is read at attach time (not at send time) since external
 * files are outside the vault and may not be available later.
 *
 * @param absolutePath - Absolute filesystem path to the file.
 * @param filename - Original filename for display.
 * @param content - File content read at attach time.
 * @returns A resolved Attachment with content populated.
 */
export function createExternalFileAttachment(
	absolutePath: string,
	filename: string,
	content: string
): Attachment {
	return {
		id: generateUUID(),
		type: "external_file",
		path: absolutePath,
		section: null,
		display_name: filename,
		content,
		content_length: content.length,
		binary_content: null,
		media_type: null,
		width: null,
		height: null,
		status: "resolved",
		error_message: null,
	};
}

/**
 * Create an attachment for a vault image file.
 *
 * Binary content and dimensions are populated during `resolveAttachment()`.
 *
 * @param path - Vault-relative path to the image file.
 * @returns A pending Attachment ready for resolution at send time.
 */
export function createVaultImageAttachment(path: string): Attachment {
	const filename = path.split("/").pop() ?? path;
	return {
		id: generateUUID(),
		type: "vault_image",
		path,
		section: null,
		display_name: filename,
		content: null,
		content_length: null,
		binary_content: null,
		media_type: null,
		width: null,
		height: null,
		status: "pending",
		error_message: null,
	};
}

/**
 * Create an attachment for an external binary file (already processed).
 *
 * @param absolutePath - Absolute filesystem path to the file.
 * @param filename - Original filename for display.
 * @param base64 - Base64-encoded binary data (post-processing).
 * @param mediaType - MIME type (e.g., "image/png").
 * @param width - Image width in pixels (optional).
 * @param height - Image height in pixels (optional).
 * @returns A resolved Attachment with binary content populated.
 */
export function createExternalBinaryAttachment(
	absolutePath: string,
	filename: string,
	base64: string,
	mediaType: string,
	width?: number,
	height?: number,
): Attachment {
	return {
		id: generateUUID(),
		type: "external_image",
		path: absolutePath,
		section: null,
		display_name: filename,
		content: null,
		content_length: null,
		binary_content: base64,
		media_type: mediaType,
		width: width ?? null,
		height: height ?? null,
		status: "resolved",
		error_message: null,
	};
}

/**
 * Create an attachment for a vault PDF file.
 *
 * Binary content is populated during `resolveAttachment()`.
 *
 * @param path - Vault-relative path to the PDF file.
 * @returns A pending Attachment ready for resolution at send time.
 */
export function createVaultPdfAttachment(path: string): Attachment {
	const filename = path.split("/").pop() ?? path;
	return {
		id: generateUUID(),
		type: "vault_pdf",
		path,
		section: null,
		display_name: filename,
		content: null,
		content_length: null,
		binary_content: null,
		media_type: null,
		width: null,
		height: null,
		status: "pending",
		error_message: null,
	};
}

/**
 * Create an attachment for an external PDF file (already processed).
 *
 * @param absolutePath - Absolute filesystem path to the file.
 * @param filename - Original filename for display.
 * @param base64 - Base64-encoded binary data.
 * @param pageCount - Number of pages in the PDF (optional).
 * @returns A resolved Attachment with binary content populated.
 */
export function createExternalPdfAttachment(
	absolutePath: string,
	filename: string,
	base64: string,
	pageCount?: number,
): Attachment {
	return {
		id: generateUUID(),
		type: "external_pdf",
		path: absolutePath,
		section: null,
		display_name: filename,
		content: pageCount != null ? String(pageCount) : null,
		content_length: pageCount ?? null,
		binary_content: base64,
		media_type: "application/pdf",
		width: null,
		height: null,
		status: "resolved",
		error_message: null,
	};
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Check if a candidate attachment duplicates an existing one.
 *
 * Duplicates are identified by matching path + section combination.
 *
 * @param existing - Array of existing attachments.
 * @param candidate - Candidate path and section to check.
 * @returns True if a duplicate exists.
 */
export function isDuplicate(
	existing: Attachment[],
	candidate: { path: string; section?: string | null }
): boolean {
	const candidateSection = candidate.section ?? null;
	return existing.some(
		(att) => att.path === candidate.path && att.section === candidateSection
	);
}

// ---------------------------------------------------------------------------
// ATT-002: Vault note content resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a vault note or section attachment by reading its content.
 *
 * For `vault_note`: reads full content via `vault.read(file)`.
 * For `vault_note_section`: reads full content, then extracts the section
 * from the matching heading to the next heading of equal or higher level.
 * For `external_file`: content already populated at attach time; no-op.
 *
 * @param app - The Obsidian App instance.
 * @param attachment - The attachment to resolve.
 * @returns A new Attachment with updated status and content.
 */
export async function resolveAttachment(
	app: App,
	attachment: Attachment,
	imageSettings?: { maxDimension: number; compressionQuality: number },
	providerType?: string,
): Promise<Attachment> {
	// External files, external images, and external PDFs are already resolved at attach time
	if (attachment.type === "external_file" || attachment.type === "external_image" || attachment.type === "external_pdf") {
		return { ...attachment };
	}

	// Vault image: read binary, detect format, process through image pipeline
	if (attachment.type === "vault_image") {
		const file = app.vault.getFileByPath(attachment.path);
		if (!file) {
			return {
				...attachment,
				status: "error",
				error_message: `Image not found: ${attachment.path}`,
			};
		}

		try {
			const arrayBuffer = await app.vault.readBinary(file);
			const buffer = Buffer.from(arrayBuffer);
			const format = detectMediaFormat(buffer);

			if (!format || format === "pdf" || !["png", "jpeg", "gif", "webp"].includes(format)) {
				return {
					...attachment,
					status: "error",
					error_message: "Unsupported image format",
				};
			}

			const mediaType = `image/${format}` as ImageMediaType;
			const block = await processImage(buffer, mediaType, {
				maxDimension: imageSettings?.maxDimension,
				compressionQuality: imageSettings?.compressionQuality,
			});

			if (block.type !== "image") {
				return {
					...attachment,
					status: "error",
					error_message: "Unexpected processing result",
				};
			}

			return {
				...attachment,
				binary_content: block.data,
				media_type: block.media_type,
				width: block.width ?? null,
				height: block.height ?? null,
				status: "resolved",
				error_message: null,
			};
		} catch (e) {
			return {
				...attachment,
				status: "error",
				error_message: `Failed to process image: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	// Vault PDF: read binary, process through PDF pipeline
	if (attachment.type === "vault_pdf") {
		const file = app.vault.getFileByPath(attachment.path);
		if (!file) {
			return {
				...attachment,
				status: "error",
				error_message: `PDF not found: ${attachment.path}`,
			};
		}

		try {
			const arrayBuffer = await app.vault.readBinary(file);
			const buffer = Buffer.from(arrayBuffer);
			const format = detectMediaFormat(buffer);

			if (format !== "pdf") {
				return {
					...attachment,
					status: "error",
					error_message: "File is not a valid PDF",
				};
			}

			const result = await processPdf(buffer, {
				providerType: providerType ?? "local",
			});

			// For native document blocks, store the base64 data
			const docBlock = result.contentBlocks.find((b) => b.type === "document");
			if (docBlock && docBlock.type === "document") {
				return {
					...attachment,
					binary_content: docBlock.data,
					media_type: "application/pdf",
					content: result.textSummary,
					content_length: result.textSummary.length,
					status: "resolved",
					error_message: null,
				};
			}

			// For text extraction, store the text content
			const textBlock = result.contentBlocks.find((b) => b.type === "text");
			if (textBlock && textBlock.type === "text") {
				return {
					...attachment,
					content: textBlock.text,
					content_length: textBlock.text.length,
					media_type: "application/pdf",
					status: "resolved",
					error_message: null,
				};
			}

			return {
				...attachment,
				status: "error",
				error_message: "PDF processing returned no content",
			};
		} catch (e) {
			return {
				...attachment,
				status: "error",
				error_message: `Failed to process PDF: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	// Look up the file in the vault
	const file = app.vault.getFileByPath(attachment.path);
	if (!file) {
		return {
			...attachment,
			status: "error",
			error_message: `Note not found: ${attachment.path}`,
		};
	}

	try {
		const fullContent = await app.vault.read(file);

		if (attachment.type === "vault_note") {
			return {
				...attachment,
				content: fullContent,
				content_length: fullContent.length,
				status: "resolved",
				error_message: null,
			};
		}

		// vault_note_section: extract section content
		if (attachment.type === "vault_note_section" && attachment.section) {
			const sectionContent = extractSection(
				app,
				file,
				fullContent,
				attachment.section
			);

			if (sectionContent === null) {
				return {
					...attachment,
					status: "error",
					error_message: `Section not found: "${attachment.section}" in ${attachment.path}`,
				};
			}

			return {
				...attachment,
				content: sectionContent,
				content_length: sectionContent.length,
				status: "resolved",
				error_message: null,
			};
		}

		// Shouldn't reach here, but handle gracefully
		return {
			...attachment,
			content: fullContent,
			content_length: fullContent.length,
			status: "resolved",
			error_message: null,
		};
	} catch (e) {
		return {
			...attachment,
			status: "error",
			error_message: `Failed to read note: ${e instanceof Error ? e.message : String(e)}`,
		};
	}
}

/**
 * Extract content from a specific section of a note.
 *
 * Uses `metadataCache.getFileCache(file)?.headings` to find the section
 * boundaries. Extracts from the matching heading to the next heading of
 * equal or higher level (or end of file). Takes the first match for
 * ambiguous headings.
 *
 * @param app - The Obsidian App instance.
 * @param file - The TFile to read section from.
 * @param fullContent - The full note content.
 * @param sectionHeading - The heading text to find.
 * @returns The section content, or null if the heading is not found.
 */
function extractSection(
	app: App,
	file: TFile,
	fullContent: string,
	sectionHeading: string
): string | null {
	const cache = app.metadataCache.getFileCache(file);
	const headings = cache?.headings;

	if (!headings || headings.length === 0) {
		return null;
	}

	// Find the first heading matching the section text
	const matchIndex = headings.findIndex(
		(h) => h.heading === sectionHeading
	);

	if (matchIndex === -1) {
		return null;
	}

	const matchedHeading = headings[matchIndex]!;
	const matchedLevel = matchedHeading.level;

	// Start position: beginning of the heading line
	const startOffset = matchedHeading.position.start.offset;

	// End position: next heading of equal or higher level, or end of file
	let endOffset = fullContent.length;
	for (let i = matchIndex + 1; i < headings.length; i++) {
		const nextHeading = headings[i]!;
		if (nextHeading.level <= matchedLevel) {
			endOffset = nextHeading.position.start.offset;
			break;
		}
	}

	const sectionContent = fullContent.slice(startOffset, endOffset).trimEnd();
	return sectionContent;
}

// ---------------------------------------------------------------------------
// ATT-003: External file reading and validation
// ---------------------------------------------------------------------------

/** Result of reading an external file. */
export interface ExternalFileReadResult {
	/** Whether the read succeeded. */
	success: boolean;
	/** The file content (if successful). */
	content?: string;
	/** The original filename. */
	filename?: string;
	/** Error message (if failed). */
	error?: string;
	/** Whether the file exceeds the size threshold and needs confirmation. */
	needsConfirmation?: boolean;
	/** File size in bytes (for confirmation dialog). */
	fileSizeBytes?: number;
}

/**
 * Read and validate an external file for attachment.
 *
 * Uses `fs.readFileSync` with an absolute path obtained by the caller
 * via `webUtils.getPathForFile()` (Electron 28+) or the legacy `File.path`.
 *
 * Validates:
 * - UTF-8 encoding (rejects binary files)
 * - File size against configurable threshold
 *
 * Desktop-only: gated behind `Platform.isDesktopApp`.
 *
 * @param filePath - Absolute filesystem path to the file.
 * @param filename - Original filename for display.
 * @param thresholdMb - Size threshold in MB that triggers confirmation.
 * @returns Read result with content or error.
 */
export function readExternalFile(
	filePath: string,
	filename: string,
	thresholdMb: number
): ExternalFileReadResult {
	// eslint-disable-next-line @typescript-eslint/no-require-imports -- fs must be loaded via require(); static import is unavailable in Obsidian's plugin bundle
	const fs = require("fs") as typeof import("fs");

	try {
		// Check file size first
		const stats = fs.statSync(filePath);
		const fileSizeBytes = stats.size;
		const fileSizeMb = fileSizeBytes / (1024 * 1024);

		// Read as UTF-8
		const content = fs.readFileSync(filePath, "utf-8");

		// UTF-8 validation: check for null bytes which indicate binary content
		if (content.includes("\0")) {
			return {
				success: false,
				error: "Cannot attach binary file: only plain-text files are supported",
			};
		}

		// Check size threshold
		if (fileSizeMb > thresholdMb) {
			return {
				success: true,
				content,
				filename,
				needsConfirmation: true,
				fileSizeBytes,
			};
		}

		return {
			success: true,
			content,
			filename,
		};
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);

		// Check for encoding errors that suggest binary content
		if (message.includes("EISDIR")) {
			return {
				success: false,
				error: "Cannot attach a directory: please select a file",
			};
		}

		return {
			success: false,
			error: `Failed to read file: ${message}`,
		};
	}
}

// ---------------------------------------------------------------------------
// ATT-004: Attachment XML serialization
// ---------------------------------------------------------------------------

/**
 * Serialize resolved attachments into the `<attachments>` XML block for text
 * attachments and ContentBlock entries for binary (image) attachments.
 *
 * Only includes attachments with status "resolved". Error-status
 * attachments are omitted.
 *
 * @param attachments - Array of attachments to serialize.
 * @returns Object with `text` (XML string or null) and `contentBlocks` (image/document blocks).
 */
export function buildAttachmentsBlock(attachments: Attachment[]): { text: string | null; contentBlocks: ContentBlock[] } {
	const resolved = attachments.filter((a) => a.status === "resolved");
	if (resolved.length === 0) {
		return { text: null, contentBlocks: [] };
	}

	const tags: string[] = [];
	const contentBlocks: ContentBlock[] = [];

	for (const att of resolved) {
		switch (att.type) {
			case "vault_note":
				tags.push(
					`  <vault-note path="${escapeXmlAttr(att.path)}">\n${att.content ?? ""}\n  </vault-note>`
				);
				break;

			case "vault_note_section":
				tags.push(
					`  <vault-note path="${escapeXmlAttr(att.path)}" section="${escapeXmlAttr(att.section ?? "")}">\n${att.content ?? ""}\n  </vault-note>`
				);
				break;

			case "external_file":
				tags.push(
					`  <external-file name="${escapeXmlAttr(att.display_name)}">\n${att.content ?? ""}\n  </external-file>`
				);
				break;

			case "vault_image":
			case "external_image":
				if (att.binary_content && att.media_type) {
					contentBlocks.push({
						type: "image",
						media_type: att.media_type as ImageMediaType,
						data: att.binary_content,
						width: att.width ?? undefined,
						height: att.height ?? undefined,
					});
				}
				break;

			case "vault_pdf":
			case "external_pdf":
				if (att.binary_content && att.media_type === "application/pdf") {
					// Native document block path
					contentBlocks.push({
						type: "document",
						media_type: "application/pdf",
						data: att.binary_content,
						page_count: att.content_length ?? undefined,
					});
				} else if (att.content) {
					// Text extraction path — include extracted text as XML tag
					tags.push(
						`  <pdf-document name="${escapeXmlAttr(att.display_name)}">\n${att.content}\n  </pdf-document>`
					);
				}
				break;
		}
	}

	const text = tags.length > 0 ? `<attachments>\n${tags.join("\n")}\n</attachments>` : null;
	return { text, contentBlocks };
}

/**
 * Escape special characters in XML attribute values.
 * Content body is included as-is per the contract specification.
 */
function escapeXmlAttr(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}