/**
 * `write_file` tool — writes text content to a file on the filesystem.
 *
 * Validates path against vault root and user-configured allowed paths.
 * Creates intermediate directories as needed. Overwrites existing files.
 *
 * Write tool available in Act mode only.
 * Auto-approve default: false.
 * Desktop-only: returns error if `Platform.isDesktopApp` is false.
 */

import { Platform } from "obsidian";
import type { App } from "obsidian";
import * as fs from "fs";
import { dirname } from "path";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { resolveAndValidatePath } from "../utils/path-validation";
import { logger } from "../utils/logger";

const log = logger("WriteFileTool");

/** Maximum content size: 5 MB. */
const MAX_CONTENT_BYTES = 5 * 1024 * 1024;

/**
 * Implements the `write_file` tool.
 *
 * Writes text content to a file on the filesystem, enforcing path boundary
 * checks. Creates intermediate directories and overwrites existing files.
 */
export class WriteFileTool implements Tool {
	readonly name = "write_file";
	readonly mode = "write" as const;

	readonly description =
		"Write text content to a file on the filesystem. Creates the file if it does not exist, " +
		"or overwrites it if it does. Creates intermediate directories as needed. " +
		"The path must be within the vault or a user-configured allow-list of paths. " +
		"Supports an optional encoding parameter (default: utf-8). " +
		"Desktop-only tool.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the file. Vault-relative or absolute.",
			},
			content: {
				type: "string",
				description:
					"Complete text content to write to the file. This will replace the entire file if it already exists.",
			},
			encoding: {
				type: "string",
				description: "File encoding. Default: utf-8.",
				default: "utf-8",
			},
		},
		required: ["path", "content"],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string | undefined;
		const content = params["content"] as string | undefined;
		const encoding = params["encoding"] as string | undefined;

		if (!path || typeof path !== "string" || path.trim() === "") {
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

		if (!Platform.isDesktopApp) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "write_file is only available on desktop.",
			};
		}

		const vaultRoot = this.getVaultRootPath();
		if (!vaultRoot) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Could not determine vault root path.",
			};
		}

		const pathResult = resolveAndValidatePath(
			path,
			vaultRoot,
			this.settings.read_file_allowed_paths
		);

		if (!pathResult.valid) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: pathResult.error,
			};
		}

		const resolvedPath = pathResult.resolvedPath;

		if (content.length > MAX_CONTENT_BYTES) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Content exceeds maximum size of 5 MB.",
			};
		}

		try {
			// Create intermediate directories if they don't exist
			await fs.promises.mkdir(dirname(resolvedPath), { recursive: true });

			// Write the file
			await fs.promises.writeFile(resolvedPath, content, {
				encoding: (encoding as BufferEncoding) ?? "utf-8",
			});

			log.info("Wrote file", { path: resolvedPath, chars: content.length });

			return {
				tool_name: this.name,
				success: true,
				result: `Successfully wrote file: ${resolvedPath} (${content.length} characters)`,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to write file", { path: resolvedPath, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to write file: ${message}`,
			};
		}
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	private getVaultRootPath(): string | null {
		const adapter = this.app.vault.adapter as { basePath?: string };
		return adapter.basePath ?? null;
	}
}
