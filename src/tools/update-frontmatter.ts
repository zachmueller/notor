/**
 * `update_frontmatter` tool — add, modify, or remove frontmatter properties.
 *
 * Uses `fileManager.processFrontMatter` for atomic, body-safe updates.
 * Creates a checkpoint before modifying.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — update_frontmatter schema
 * @see specs/01-mvp/spec.md — FR-21
 * @see design/research/obsidian-vault-api-frontmatter.md — processFrontMatter API
 */

import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { logger } from "../utils/logger";

const log = logger("UpdateFrontmatterTool");

/**
 * Implements the `update_frontmatter` tool.
 *
 * Adds, modifies, or removes specific frontmatter properties without
 * touching the note body. Uses `processFrontMatter` for atomicity.
 * Creates a checkpoint before any modification.
 */
export class UpdateFrontmatterTool implements Tool {
	readonly name = "update_frontmatter";
	readonly mode = "write" as const;

	readonly description =
		"Add, modify, or remove specific frontmatter properties without touching the note body " +
		"content. Uses Obsidian's frontmatter APIs for safe structured updates. " +
		"Creates a frontmatter section if the note has none and 'set' is provided. " +
		"Triggers a checkpoint snapshot before modifying. Requires user approval unless auto-approved.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the note relative to vault root",
			},
			set: {
				type: "object",
				description: "Key-value pairs to add or update in the frontmatter",
				additionalProperties: true,
			},
			remove: {
				type: "array",
				description: "List of frontmatter keys to remove",
				items: {
					type: "string",
				},
			},
		},
		required: ["path"],
	};

	constructor(
		private readonly app: App,
		private readonly checkpointManager?: CheckpointManager
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string;
		const set = params["set"] as Record<string, unknown> | undefined;
		const remove = params["remove"] as string[] | undefined;

		if (!path || typeof path !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		// At least one of set or remove must be provided
		if (!set && !remove) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "At least one of 'set' or 'remove' must be provided",
			};
		}

		log.debug("Updating frontmatter", {
			path,
			setKeys: set ? Object.keys(set) : [],
			removeKeys: remove ?? [],
		});

		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Note not found: ${path}`,
			};
		}

		// Create checkpoint before modifying (non-fatal if it fails)
		await this.checkpointManager?.createCheckpoint(path, this.name, "");

		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				// Apply set operations
				if (set) {
					for (const [key, value] of Object.entries(set)) {
						frontmatter[key] = value;
					}
				}
				// Apply remove operations
				if (remove) {
					for (const key of remove) {
						delete frontmatter[key];
					}
				}
			});

			const setCount = set ? Object.keys(set).length : 0;
			const removeCount = remove ? remove.length : 0;

			const parts: string[] = [];
			if (setCount > 0) parts.push(`set ${setCount} propert${setCount === 1 ? "y" : "ies"}`);
			if (removeCount > 0) parts.push(`removed ${removeCount} propert${removeCount === 1 ? "y" : "ies"}`);

			log.info("Updated frontmatter", { path, setCount, removeCount });

			return {
				tool_name: this.name,
				success: true,
				result: `Updated frontmatter on ${path}: ${parts.join(", ")}`,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to update frontmatter", { path, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to update frontmatter: ${message}`,
			};
		}
	}
}