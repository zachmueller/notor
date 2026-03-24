/**
 * `move_note` tool — rename and/or relocate notes within the vault.
 *
 * Uses `fileManager.renameFile()` which automatically updates all internal
 * wikilinks/markdown links pointing to the renamed file. Supports optional
 * alias insertion to preserve discoverability after renames.
 */

import { TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { logger } from "../utils/logger";
import { resolveNote } from "../utils/resolve-note";

const log = logger("MoveNoteTool");

export class MoveNoteTool implements Tool {
	readonly name = "move_note";
	readonly mode = "write" as const;

	readonly description =
		"Move and/or rename a note within the vault. All internal links are automatically updated. " +
		"Creates intermediate directories if needed. A checkpoint is created before the operation. " +
		"Requires user approval unless auto-approved.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Current path of the note relative to vault root. The '.md' extension is optional (e.g., 'Research/Climate' or 'Research/Climate.md'). A bare note name is also accepted.",
			},
			new_path: {
				type: "string",
				description:
					"New path for the note relative to vault root. The '.md' extension is optional and will be added automatically. Creates intermediate directories if needed.",
			},
			add_alias: {
				type: "boolean",
				description:
					"If true and the note's filename is changing, append the old name (without .md) to the note's frontmatter 'aliases' list. Useful for preserving discoverability after renames. Defaults to false.",
				default: false,
			},
		},
		required: ["path", "new_path"],
	};

	constructor(
		private readonly app: App,
		private readonly checkpointManager?: CheckpointManager
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string;
		const newPath = params["new_path"] as string;
		const addAlias = (params["add_alias"] as boolean) ?? false;

		if (!path || typeof path !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		if (!newPath || typeof newPath !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: new_path",
			};
		}

		log.debug("Moving note", { path, newPath, addAlias });

		// Resolve source file
		const file = resolveNote(path, this.app.vault, this.app.metadataCache);
		if (!file) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Note not found: ${path}`,
			};
		}

		// Validate source is markdown
		if (file.extension !== "md") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Path is not a Markdown note: ${file.path}`,
			};
		}

		// Normalize destination: auto-append .md if missing
		const normalizedNewPath = newPath.endsWith(".md") ? newPath : newPath + ".md";

		// No-op guard: same path
		if (file.path === normalizedNewPath) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Source and destination are the same path",
			};
		}

		// Check destination doesn't already exist
		const existing = this.app.vault.getAbstractFileByPath(normalizedNewPath);
		if (existing) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `A note already exists at: ${normalizedNewPath}`,
			};
		}

		try {
			// Checkpoint before destructive operation
			await this.checkpointManager?.createCheckpoint(file.path, this.name, "");

			// Ensure destination directory exists
			await this.ensureDirectoryExists(normalizedNewPath);

			// Store old basename before rename (TFile.basename is name without extension)
			const oldBasename = file.basename;

			// Perform the move/rename — updates all internal links
			await this.app.fileManager.renameFile(file, normalizedNewPath);

			// Add alias if requested and filename actually changed
			const newBasename = normalizedNewPath.split("/").pop()!.replace(/\.md$/, "");
			if (addAlias && oldBasename !== newBasename) {
				await this.app.fileManager.processFrontMatter(file, (fm) => {
					const aliases: string[] = this.normaliseAliases(fm["aliases"]);
					if (!aliases.includes(oldBasename)) {
						aliases.push(oldBasename);
					}
					fm["aliases"] = aliases;
				});
			}

			log.info("Note moved", { from: path, to: normalizedNewPath, aliasAdded: addAlias && oldBasename !== newBasename });

			const summary = oldBasename !== newBasename
				? `Note moved: ${path} → ${normalizedNewPath}`
				: `Note moved: ${path} → ${normalizedNewPath}`;

			return {
				tool_name: this.name,
				success: true,
				result: summary,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to move note", { path, newPath, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to move note: ${message}`,
			};
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private async ensureDirectoryExists(filePath: string): Promise<void> {
		const parts = filePath.split("/");
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

	private normaliseAliases(raw: unknown): string[] {
		if (!raw) return [];
		if (typeof raw === "string") return [raw.trim()];
		if (Array.isArray(raw)) {
			return raw
				.filter((a) => a != null && a !== "")
				.map((a) => String(a).trim());
		}
		return [];
	}
}
