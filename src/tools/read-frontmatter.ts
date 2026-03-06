/**
 * `read_frontmatter` tool — reads parsed YAML frontmatter as structured data.
 *
 * Uses Obsidian's metadata cache for efficient reads (no disk I/O).
 * Returns an empty object if the note has no frontmatter.
 *
 * @see specs/01-mvp/contracts/tool-schemas.md — read_frontmatter schema
 * @see specs/01-mvp/spec.md — FR-20
 * @see design/research/obsidian-vault-api-frontmatter.md — metadataCache.getFileCache
 */

import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import { logger } from "../utils/logger";

const log = logger("ReadFrontmatterTool");

/**
 * Implements the `read_frontmatter` tool.
 *
 * Reads parsed YAML frontmatter from Obsidian's metadata cache.
 * Strips the internal `position` property before returning.
 */
export class ReadFrontmatterTool implements Tool {
	readonly name = "read_frontmatter";
	readonly mode = "read" as const;

	readonly description =
		"Read the parsed YAML frontmatter of a note as structured key-value data. " +
		"Returns an empty object if the note has no frontmatter. " +
		"Uses Obsidian's metadata cache — no disk I/O required.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the note relative to vault root",
			},
		},
		required: ["path"],
	};

	constructor(private readonly app: App) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string;

		if (!path || typeof path !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		log.debug("Reading frontmatter", { path });

		// Verify the file exists
		const file = this.app.vault.getFileByPath(path);
		if (!file) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Note not found: ${path}`,
			};
		}

		// Use metadata cache — no disk read needed
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) {
			// No frontmatter — return empty object (not an error per spec)
			log.debug("No frontmatter found", { path });
			return {
				tool_name: this.name,
				success: true,
				result: {},
			};
		}

		// Clone and strip the internal `position` property from FrontMatterCache
		const { position: _position, ...frontmatter } = cache.frontmatter;

		log.info("Read frontmatter", { path, keyCount: Object.keys(frontmatter).length });

		return {
			tool_name: this.name,
			success: true,
			result: frontmatter,
		};
	}
}