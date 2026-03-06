/**
 * `write_note` tool — creates or overwrites notes via Obsidian vault API.
 *
 * Write tool available in Act mode only. Implements frontmatter preservation
 * (read-before-write merge), stale content checking, and creates intermediate
 * directories as needed.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — write_note schema
 * @see specs/01-mvp/spec.md — FR-8
 * @see design/research/obsidian-vault-api-frontmatter.md — frontmatter preservation strategy
 */

import { TFile, TFolder, getFrontMatterInfo } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { StaleContentTracker } from "../chat/stale-tracker";
import type { NoteOpener } from "./note-opener";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { logger } from "../utils/logger";

const log = logger("WriteNoteTool");

/**
 * Implements the `write_note` tool.
 *
 * Creates a new note or overwrites an existing note's entire content.
 * Frontmatter preservation strategy: if existing note has frontmatter but
 * new content does not, prepend the existing frontmatter block.
 *
 * Stale content check is performed before writing when the AI previously
 * read the note in this conversation.
 */
export class WriteNoteTool implements Tool {
	readonly name = "write_note";
	readonly mode = "write" as const;

	readonly description =
		"Create a new note or overwrite an existing note's entire content. " +
		"Creates intermediate directories if they don't exist. A checkpoint of the " +
		"existing note is created before writing. Requires user approval unless auto-approved.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Path to the note relative to vault root (e.g., 'Projects/Website Redesign.md')",
			},
			content: {
				type: "string",
				description:
					"Complete content to write to the note. This will replace the entire file content.",
			},
		},
		required: ["path", "content"],
	};

	constructor(
		private readonly app: App,
		private readonly staleTracker: StaleContentTracker,
		private readonly noteOpener?: NoteOpener,
		private readonly checkpointManager?: CheckpointManager
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string;
		const content = params["content"] as string;

		if (!path || typeof path !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		if (content === undefined || content === null || typeof content !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: content",
			};
		}

		log.debug("Writing note", { path, contentLength: content.length });

		const existingFile = this.app.vault.getFileByPath(path);

		try {
			if (!existingFile) {
				// ---------------------------------------------------------------
				// New file: create with intermediate directories
				// ---------------------------------------------------------------
				await this.ensureDirectoryExists(path);
				await this.app.vault.create(path, content);

				log.info("Created new note", { path, chars: content.length });

				// Open in editor
				await this.noteOpener?.openNote(path);

				return {
					tool_name: this.name,
					success: true,
					result: `Note created: ${path} (${content.length} characters)`,
				};
			}

			// ---------------------------------------------------------------
			// Existing file: stale content check then frontmatter-safe write
			// ---------------------------------------------------------------
			if (!(existingFile instanceof TFile)) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Path is not a file: ${path}`,
				};
			}

			// Read current content for stale check and frontmatter merge
			const currentContent = await this.app.vault.read(existingFile);

			// Stale content check (before checkpoint — no point snapshotting if stale)
			const staleResult = this.staleTracker.check(path, currentContent);
			if (staleResult.isStale) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error:
						"Note content has changed since last read. " +
						"Re-read the note with read_note before retrying.",
				};
			}

			// Checkpoint: snapshot existing content before overwriting
			await this.checkpointManager?.createCheckpoint(path, this.name, "");

			// Frontmatter preservation: if existing note has frontmatter but
			// new content doesn't, prepend the existing frontmatter block.
			const existingFm = getFrontMatterInfo(currentContent);
			const newFm = getFrontMatterInfo(content);

			let finalContent: string;

			if (existingFm.exists && !newFm.exists) {
				// Preserve existing frontmatter
				const frontmatterBlock = currentContent.slice(0, existingFm.contentStart);
				finalContent = frontmatterBlock + content;
				log.debug("Preserved existing frontmatter", { path });
			} else {
				// All other cases: use new content as-is
				finalContent = content;
			}

			await this.app.vault.modify(existingFile, finalContent);

			// Update stale tracker so subsequent writes don't falsely detect staleness
			this.staleTracker.updateAfterWrite(path, finalContent);

			log.info("Modified existing note", { path, chars: finalContent.length });

			// Open in editor
			await this.noteOpener?.openNote(path);

			return {
				tool_name: this.name,
				success: true,
				result: `Note updated: ${path} (${finalContent.length} characters)`,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to write note", { path, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to write note: ${message}`,
			};
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Ensure all intermediate directories in a path exist.
	 * Creates each missing directory in sequence.
	 */
	private async ensureDirectoryExists(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		// Remove the filename (last part)
		parts.pop();

		if (parts.length === 0) return;

		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
				log.debug("Created directory", { path: current });
			} else if (!(existing instanceof TFolder)) {
				throw new Error(
					`Cannot create directory: "${current}" already exists as a file`
				);
			}
		}
	}
}