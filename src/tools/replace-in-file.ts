/**
 * `replace_in_file` tool — atomic SEARCH/REPLACE editing on filesystem files.
 *
 * Validates path against vault root and user-configured allowed paths.
 * Rejects binary files (detected via null-byte scan of first 8 KB).
 * All search blocks must match before any change is written to disk.
 *
 * Write tool available in Act mode only.
 * Auto-approve default: false.
 * Desktop-only: returns error if `Platform.isDesktopApp` is false.
 */

import { Platform } from "obsidian";
import type { App } from "obsidian";
import * as fs from "fs";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { resolveAndValidatePath } from "../utils/path-validation";
import { logger } from "../utils/logger";

const log = logger("ReplaceInFileTool");

/** A single SEARCH/REPLACE block. */
interface ChangeBlock {
	search: string;
	replace: string;
}

/**
 * Implements the `replace_in_file` tool.
 *
 * Makes targeted edits to a text file using SEARCH/REPLACE blocks. The
 * operation is atomic in memory: if any search block fails to match, no
 * changes are written to disk.
 *
 * Multiple blocks are applied in sequence (order matters). Each block
 * replaces only the first occurrence of the search text. An empty replace
 * string deletes the matched text.
 */
export class ReplaceInFileTool implements Tool {
	readonly name = "replace_in_file";
	readonly mode = "write" as const;

	readonly description =
		"Make targeted edits within a text file on the filesystem using SEARCH/REPLACE blocks " +
		"for surgical editing without rewriting the entire file. Each search string must match " +
		"exactly (character-for-character including whitespace). The operation is atomic: if any " +
		"search block fails to match, no changes are applied. " +
		"The path must be within the vault or a user-configured allow-list of paths. " +
		"Desktop-only tool.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the file. Vault-relative or absolute.",
			},
			changes: {
				type: "array",
				description:
					"Array of search/replace blocks to apply in sequence. Each block " +
					"replaces only the first occurrence of the search text.",
				items: {
					type: "object",
					properties: {
						search: {
							type: "string",
							description:
								"Exact text to find in the file (character-for-character " +
								"match including whitespace)",
						},
						replace: {
							type: "string",
							description:
								"Text to replace the matched search text with. " +
								"Use empty string to delete the matched text.",
						},
					},
					required: ["search", "replace"],
				},
				minItems: 1,
			},
		},
		required: ["path", "changes"],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string | undefined;
		const changes = params["changes"] as ChangeBlock[] | undefined;

		if (!path || typeof path !== "string" || path.trim() === "") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		if (!Array.isArray(changes) || changes.length === 0) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing or empty required parameter: changes",
			};
		}

		// Validate change blocks
		for (let i = 0; i < changes.length; i++) {
			const block = changes[i];
			if (typeof block?.search !== "string" || typeof block?.replace !== "string") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Change block ${i + 1} is missing required 'search' or 'replace' property`,
				};
			}
			if (block.search === "") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Change block ${i + 1} has an empty search string. Search text must be non-empty.`,
				};
			}
		}

		if (!Platform.isDesktopApp) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "replace_in_file is only available on desktop.",
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

		try {
			// Check file existence
			try {
				await fs.promises.stat(resolvedPath);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code === "ENOENT") {
					return {
						tool_name: this.name,
						success: false,
						result: "",
						error: `File not found: ${resolvedPath}`,
					};
				}
				throw e;
			}

			// Read raw buffer for binary detection
			const buf = await fs.promises.readFile(resolvedPath);

			// Detect binary via null bytes in first 8 KB
			if (buf.subarray(0, 8192).includes(0)) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error:
						"replace_in_file only supports text-based files. Binary files cannot be edited with SEARCH/REPLACE blocks.",
				};
			}

			let content = buf.toString("utf-8");

			// Apply SEARCH/REPLACE blocks sequentially in memory
			for (let i = 0; i < changes.length; i++) {
				const block = changes[i];
				if (!block) continue;

				const idx = content.indexOf(block.search);

				if (idx === -1) {
					const preview =
						block.search.length > 80
							? block.search.slice(0, 80) + "..."
							: block.search;
					return {
						tool_name: this.name,
						success: false,
						result: "",
						error:
							`Search block ${i + 1} did not match any text in ${path}. ` +
							`No changes were applied. The search text was: "${preview}"`,
					};
				}

				// Replace only the first occurrence
				content =
					content.slice(0, idx) +
					block.replace +
					content.slice(idx + block.search.length);
			}

			// All blocks matched — write modified content back
			await fs.promises.writeFile(resolvedPath, content, "utf-8");

			log.info("Applied replacements", {
				path: resolvedPath,
				count: changes.length,
			});

			return {
				tool_name: this.name,
				success: true,
				result: `Applied ${changes.length} replacement${changes.length > 1 ? "s" : ""} to ${resolvedPath}`,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to apply replacements", {
				path: resolvedPath,
				error: message,
			});
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to apply replacements: ${message}`,
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
