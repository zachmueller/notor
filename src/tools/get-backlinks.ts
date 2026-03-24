/**
 * `get_backlinks` tool — returns all notes that link TO the given note.
 *
 * Iterates metadataCache.resolvedLinks (an in-memory map) to find all
 * source files that reference the target. O(n) over vault files but
 * purely in-memory — no disk I/O.
 */
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import { logger } from "../utils/logger";
import { resolveNote } from "../utils/resolve-note";

const log = logger("GetBacklinksTool");

export class GetBacklinksTool implements Tool {
	readonly name = "get_backlinks";
	readonly mode = "read" as const;

	readonly description =
		"Returns all notes in the vault that link TO the specified note. " +
		"Searches Obsidian's in-memory link index. " +
		"Returns a newline-separated list of vault-relative paths.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description:
					"Path to the note relative to vault root. The '.md' extension " +
					"is optional. A bare note name is also accepted.",
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

		const file = resolveNote(path, this.app.vault, this.app.metadataCache);
		if (!file) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Note not found: ${path}`,
			};
		}

		// Reverse-lookup: find all source files whose resolvedLinks include target.
		// Self-links are filtered out — a note linking to itself is not a useful backlink.
		const targetPath = file.path;
		const backlinks: string[] = [];
		for (const [sourcePath, links] of Object.entries(
			this.app.metadataCache.resolvedLinks
		)) {
			if (sourcePath !== targetPath && targetPath in links) {
				backlinks.push(sourcePath);
			}
		}

		log.debug("Got backlinks", { path: file.path, count: backlinks.length });

		return {
			tool_name: this.name,
			success: true,
			result: backlinks.length > 0 ? backlinks.join("\n") : "(none)",
		};
	}
}
