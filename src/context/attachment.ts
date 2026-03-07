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

// ---------------------------------------------------------------------------
// ATT-001: Attachment data model
// ---------------------------------------------------------------------------

/** Attachment content source type. */
export type AttachmentType = "vault_note" | "vault_note_section" | "external_file";

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
	attachment: Attachment
): Promise<Attachment> {
	// External files are already resolved at attach time
	if (attachment.type === "external_file") {
		return { ...attachment };
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
		const fullContent = await app.vault.read(file as TFile);

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
				file as TFile,
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
 * Uses `fs.readFileSync` with the Electron-specific `File.path` property
 * for absolute path access (per R-2 findings).
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
	// eslint-disable-next-line @typescript-eslint/no-require-imports
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
 * Serialize resolved attachments into the `<attachments>` XML block.
 *
 * Only includes attachments with status "resolved". Error-status
 * attachments are omitted.
 *
 * @param attachments - Array of attachments to serialize.
 * @returns The `<attachments>` XML string, or `null` if no resolved attachments.
 */
export function buildAttachmentsBlock(attachments: Attachment[]): string | null {
	const resolved = attachments.filter((a) => a.status === "resolved");
	if (resolved.length === 0) {
		return null;
	}

	const tags: string[] = [];

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
		}
	}

	return `<attachments>\n${tags.join("\n")}\n</attachments>`;
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