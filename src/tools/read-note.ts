/**
 * `read_note` tool — reads note contents via Obsidian vault API.
 *
 * Read-only tool available in both Plan and Act modes. Updates the stale
 * content tracker after each read so write tools can detect concurrent edits.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — read_note schema
 * @see specs/01-mvp/spec.md — FR-7
 * @see design/research/obsidian-vault-api-frontmatter.md — vault.read, getFrontMatterInfo
 */

import { TFile, getFrontMatterInfo } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { StaleContentTracker } from "../chat/stale-tracker";
import type { NoteOpener } from "./note-opener";
import { logger } from "../utils/logger";

const log = logger("ReadNoteTool");

/**
 * Implements the `read_note` tool.
 *
 * Reads a note's contents using `app.vault.read()`. By default strips
 * frontmatter using `getFrontMatterInfo`; includes it when
 * `include_frontmatter` is true.
 */
export class ReadNoteTool implements Tool {
	readonly name = "read_note";
	readonly mode = "read" as const;

	readonly description =
		"Read the contents of a note in the vault. Returns the note content as a string. " +
		"Uses Obsidian's vault API. Defaults to excluding YAML frontmatter unless " +
		"include_frontmatter is set to true.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Path to the note relative to vault root (e.g., 'Research/Climate.md')",
			},
			include_frontmatter: {
				type: "boolean",
				description:
					"Whether to include YAML frontmatter in the returned content. Defaults to false.",
				default: false,
			},
		},
		required: ["path"],
	};

	constructor(
		private readonly app: App,
		private readonly staleTracker: StaleContentTracker,
		private readonly noteOpener?: NoteOpener
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string;
		const includeFrontmatter = (params["include_frontmatter"] as boolean | undefined) ?? false;

		if (!path || typeof path !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		log.debug("Reading note", { path, includeFrontmatter });

		// Resolve file
		const file = this.app.vault.getFileByPath(path);

		if (!file) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Note not found: ${path}`,
			};
		}

		if (!(file instanceof TFile)) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Path is not a Markdown note: ${path}`,
			};
		}

		// Only allow markdown files
		if (file.extension !== "md") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Path is not a Markdown note: ${path}`,
			};
		}

		try {
			// Use vault.read (not cachedRead) since we'll track for write operations
			const fullContent = await this.app.vault.read(file);

			let returnContent: string;

			if (includeFrontmatter) {
				returnContent = fullContent;
			} else {
				const fmInfo = getFrontMatterInfo(fullContent);
				if (fmInfo.exists) {
					// Strip frontmatter — trim the leading newline after the closing ---
					returnContent = fullContent.slice(fmInfo.contentStart).replace(/^\n/, "");
				} else {
					returnContent = fullContent;
				}
			}

			// Update stale content tracker with full content (not stripped)
			// so write tools can compare against the actual file state
			this.staleTracker.recordRead(path, fullContent);

			// Open the note in the editor if configured
			await this.noteOpener?.openNote(path);

			log.debug("Read note successfully", {
				path,
				contentLength: returnContent.length,
				includeFrontmatter,
			});

			return {
				tool_name: this.name,
				success: true,
				result: returnContent,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to read note", { path, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to read note: ${message}`,
			};
		}
	}
}