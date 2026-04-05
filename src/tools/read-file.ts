/**
 * `read_file` tool — reads a text file from the filesystem and returns its
 * contents as a string.
 *
 * Validates path against vault root and user-configured allowed paths.
 * Rejects binary files (detected via null-byte scan of first 8 KB).
 *
 * Read-only tool available in both Plan and Act modes.
 * Auto-approve default: false.
 * Desktop-only: returns error if `Platform.isDesktopApp` is false.
 *
 * @see specs/04c-docx/spec.md — FR-70, NFR-19, NFR-21
 */

import { Platform } from "obsidian";
import type { App } from "obsidian";
import * as fs from "fs";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { resolveAndValidatePath } from "../utils/path-validation";
import { detectMediaFormat } from "../media/format-detector";
import { processImage } from "../media/image-processor";
import type { ImageMediaType } from "../media/types";
import { logger } from "../utils/logger";

const log = logger("ReadFileTool");

// ---------------------------------------------------------------------------
// Tool implementation (DOCX-008)
// ---------------------------------------------------------------------------

/**
 * Implements the `read_file` tool.
 *
 * Reads a text file from the filesystem, enforcing path boundary checks
 * and rejecting binary files.
 */
export class ReadFileTool implements Tool {
	readonly name = "read_file";
	readonly mode = "read" as const;

	readonly description =
		"Read a text file or image from the filesystem and return its contents. " +
		"Supported image formats: PNG, JPEG, GIF, WebP — images are resized and " +
		"compressed automatically. " +
		"The path must be within the vault or a user-configured allow-list of paths. " +
		"Other binary files are rejected — use read_docx for Word documents. " +
		"Supports an optional encoding parameter for text files (default: utf-8). " +
		"Desktop-only tool.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the file. Vault-relative or absolute.",
			},
			encoding: {
				type: "string",
				description: "File encoding. Default: utf-8.",
				default: "utf-8",
			},
		},
		required: ["path"],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const path = params["path"] as string | undefined;
		const encoding = params["encoding"] as string | undefined;

		if (!path || typeof path !== "string" || path.trim() === "") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: path",
			};
		}

		if (!Platform.isDesktopApp) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "read_file is only available on desktop.",
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
				// Check if this is a known media format before rejecting
				const format = detectMediaFormat(buf);

				if (format === "png" || format === "jpeg" || format === "gif" || format === "webp") {
					// Raw size limit: 50 MB
					if (buf.length > 50 * 1024 * 1024) {
						return {
							tool_name: this.name,
							success: false,
							result: "",
							error: `Image file is too large (${(buf.length / (1024 * 1024)).toFixed(1)} MB). Maximum raw input size is 50 MB.`,
						};
					}

					try {
						const mediaType = `image/${format}` as ImageMediaType;
						const block = await processImage(buf, mediaType, {
							maxDimension: this.settings.image_max_dimension,
							compressionQuality: this.settings.image_compression_quality,
						});
						const filename = resolvedPath.split("/").pop() ?? resolvedPath;
						const w = block.type === "image" ? block.width : undefined;
						const h = block.type === "image" ? block.height : undefined;

						log.info("Read image file", { path: resolvedPath, format, width: w, height: h });

						return {
							tool_name: this.name,
							success: true,
							result: `Read image: ${filename} (${w}x${h}, image/${format})`,
							content_blocks: [block],
						};
					} catch (e) {
						const message = e instanceof Error ? e.message : String(e);
						return {
							tool_name: this.name,
							success: false,
							result: "",
							error: `Failed to process image: ${message}`,
						};
					}
				}

				if (format === "pdf") {
					// Phase 3: PDF support
					return {
						tool_name: this.name,
						success: false,
						result: "",
						error: "PDF support is not yet implemented. Use read_docx for Word documents.",
					};
				}

				return {
					tool_name: this.name,
					success: false,
					result: "",
					error:
						"read_file only supports text-based files and images (PNG, JPEG, GIF, WebP). For Word documents, use read_docx instead.",
				};
			}

			const content = buf.toString((encoding as BufferEncoding) ?? "utf-8");

			log.info("Read file", { path: resolvedPath, bytes: buf.length });

			return {
				tool_name: this.name,
				success: true,
				result: content,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: message,
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
