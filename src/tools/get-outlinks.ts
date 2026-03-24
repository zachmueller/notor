/**
 * `get_outlinks` tool — returns all notes that the given note links TO.
 *
 * Uses metadataCache.resolvedLinks and unresolvedLinks for the given file.
 * Both are in-memory maps maintained by Obsidian — no disk I/O or manual
 * link resolution needed.
 */
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import { logger } from "../utils/logger";
import { resolveNote } from "../utils/resolve-note";

const log = logger("GetOutlinksTool");

export class GetOutlinksTool implements Tool {
	readonly name = "get_outlinks";
	readonly mode = "read" as const;

	readonly description =
		"Returns all notes that the specified note links TO. " +
		"Output is plain text with two sections: Resolved (links whose target notes exist) " +
		"and Unresolved (links whose target notes do not exist in the vault).";

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

		const resolvedMap = this.app.metadataCache.resolvedLinks[file.path] ?? {};
		const unresolvedMap = this.app.metadataCache.unresolvedLinks[file.path] ?? {};

		// Filter out self-links
		const resolvedPaths = Object.keys(resolvedMap).filter((p) => p !== file.path);
		const unresolvedLinkNames = Object.keys(unresolvedMap);

		log.debug("Got outlinks", {
			path: file.path,
			resolved: resolvedPaths.length,
			unresolved: unresolvedLinkNames.length,
		});

		const resolvedSection = resolvedPaths.length > 0 ? resolvedPaths.join("\n") : "(none)";
		const unresolvedSection = unresolvedLinkNames.length > 0 ? unresolvedLinkNames.join("\n") : "(none)";
		const result = `Resolved:\n${resolvedSection}\n\nUnresolved:\n${unresolvedSection}`;

		return {
			tool_name: this.name,
			success: true,
			result,
		};
	}
}
