/**
 * `manage_tags` tool — add or remove tags via frontmatter `tags` property.
 *
 * Uses `fileManager.processFrontMatter` for atomic, body-safe updates.
 * Does not duplicate existing tags. Gracefully ignores removals that
 * don't exist. Creates a checkpoint before modifying.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — manage_tags schema
 * @see specs/01-mvp/spec.md — FR-22
 * @see design/research/obsidian-vault-api-frontmatter.md — processFrontMatter API
 */

import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { logger } from "../utils/logger";

const log = logger("ManageTagsTool");

/**
 * Implements the `manage_tags` tool.
 *
 * Adds or removes tags on a note by operating on the frontmatter `tags`
 * property. Uses `processFrontMatter` for atomic, body-safe updates.
 */
export class ManageTagsTool implements Tool {
	readonly name = "manage_tags";
	readonly mode = "write" as const;

	readonly description =
		"Add or remove tags on a note by operating on the frontmatter 'tags' property. " +
		"Does not duplicate existing tags when adding. Gracefully handles removal of tags " +
		"that don't exist. Triggers a checkpoint snapshot before modifying. " +
		"Requires user approval unless auto-approved.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the note relative to vault root",
			},
			add: {
				type: "array",
				description: "Tags to add to the note",
				items: {
					type: "string",
				},
			},
			remove: {
				type: "array",
				description: "Tags to remove from the note",
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
		const add = params["add"] as string[] | undefined;
		const remove = params["remove"] as string[] | undefined;

		if (!path || typeof path !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		// At least one of add or remove must be provided
		if ((!add || add.length === 0) && (!remove || remove.length === 0)) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "At least one of 'add' or 'remove' must be provided with at least one tag",
			};
		}

		log.debug("Managing tags", { path, add: add ?? [], remove: remove ?? [] });

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

		let actualAdded: string[] = [];
		let actualRemoved: string[] = [];

		try {
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				// Normalise the tags array (may be undefined, null, string, or array)
				let tags: string[] = this.normaliseTags(frontmatter["tags"]);

				// Add tags (no duplicates)
				if (add && add.length > 0) {
					for (const tag of add) {
						const normalised = this.normaliseTag(tag);
						if (!tags.includes(normalised)) {
							tags.push(normalised);
							actualAdded.push(normalised);
						}
					}
				}

				// Remove tags (gracefully skip non-existent)
				if (remove && remove.length > 0) {
					for (const tag of remove) {
						const normalised = this.normaliseTag(tag);
						const idx = tags.indexOf(normalised);
						if (idx !== -1) {
							tags.splice(idx, 1);
							actualRemoved.push(normalised);
						}
					}
				}

				// Write back — keep as array, or remove key if empty
				if (tags.length > 0) {
					frontmatter["tags"] = tags;
				} else {
					delete frontmatter["tags"];
				}
			});

			const parts: string[] = [];
			if (actualAdded.length > 0) {
				parts.push(`added [${actualAdded.map((t) => `"${t}"`).join(", ")}]`);
			}
			if (actualRemoved.length > 0) {
				parts.push(`removed [${actualRemoved.map((t) => `"${t}"`).join(", ")}]`);
			}

			const summary =
				parts.length > 0
					? `Tags updated on ${path}: ${parts.join(", ")}`
					: `Tags unchanged on ${path} (requested tags already in desired state)`;

			log.info("Tags managed", {
				path,
				added: actualAdded,
				removed: actualRemoved,
			});

			return {
				tool_name: this.name,
				success: true,
				result: summary,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to manage tags", { path, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to manage tags: ${message}`,
			};
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Normalise a frontmatter `tags` value to a string array.
	 *
	 * Handles: undefined, null, string (single tag), string[] (normal case),
	 * and mixed arrays.
	 */
	private normaliseTags(raw: unknown): string[] {
		if (!raw) return [];
		if (typeof raw === "string") return [this.normaliseTag(raw)];
		if (Array.isArray(raw)) {
			return raw
				.filter((t) => t != null && t !== "")
				.map((t) => this.normaliseTag(String(t)));
		}
		return [];
	}

	/**
	 * Normalise a single tag string.
	 * Strips leading `#` and trims whitespace.
	 */
	private normaliseTag(tag: string): string {
		return tag.trim().replace(/^#/, "");
	}
}