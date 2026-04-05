/**
 * `read_docx` tool — reads a `.docx` file and returns its content as Markdown.
 *
 * Converts the Word document to HTML via mammoth, then converts HTML to
 * Markdown via Turndown with GFM support. Images are replaced with a
 * `[image]` placeholder.
 *
 * Read-only tool available in both Plan and Act modes.
 * Auto-approve default: false.
 * Desktop-only: returns error if `Platform.isDesktopApp` is false.
 *
 * @see specs/04c-docx/spec.md — FR-71, NFR-19
 */

import { Platform } from "obsidian";
import type { App, TFile } from "obsidian";
import * as fs from "fs";
import { extname } from "path";
import { createHash } from "crypto";
import mammoth from "mammoth";
import { images as mammothImages } from "mammoth";
import type { Image as MammothImage } from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { resolveAndValidatePath } from "../utils/path-validation";
import { logger } from "../utils/logger";

const log = logger("ReadDocxTool");

// ---------------------------------------------------------------------------
// Tool implementation (DOCX-009)
// ---------------------------------------------------------------------------

/**
 * Implements the `read_docx` tool.
 *
 * Reads a `.docx` file and returns its content as Markdown, using mammoth
 * for DOCX→HTML conversion and Turndown for HTML→Markdown conversion.
 */
export class ReadDocxTool implements Tool {
	readonly name = "read_docx";
	readonly mode = "read" as const;

	readonly description =
		"Read a .docx file and return its content as Markdown. " +
		"The path must be within the vault or a user-configured allow-list of paths. " +
		"Embedded images (PNG, JPEG, GIF, WebP) are extracted to the vault attachment folder " +
		"and referenced as ![alt](path) in the output. Unsupported formats (EMF, WMF, SVG, TIFF) " +
		"are replaced with descriptive text. Desktop-only tool.";

	readonly input_schema = {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: "Path to the .docx file. Vault-relative or absolute.",
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
				error: "read_docx is only available on desktop.",
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

		if (extname(resolvedPath).toLowerCase() !== ".docx") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "read_docx only supports .docx files.",
			};
		}

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

			const buf = await fs.promises.readFile(resolvedPath);

			// Build image extraction handler
			const extractedImages: Array<{ index: number; vaultPath: string | null; alt: string }> = [];
			let imageIndex = 0;

			// Determine if the input path is vault-relative (for attachment folder resolution)
			const vaultFile: TFile | null = this.app.vault.getFileByPath(path);
			const sourcePath: string | undefined = vaultFile ? vaultFile.path : undefined;

			const supportedImageTypes = new Set([
				"image/png", "image/jpeg", "image/gif", "image/webp",
			]);

			const convertImage = mammothImages.imgElement(
				async (image: MammothImage) => {
					const idx = imageIndex++;
					const contentType = image.contentType;

					// Skip unsupported formats
					if (!supportedImageTypes.has(contentType)) {
						const formatName = contentType.replace("image/", "").toUpperCase();
						const alt = `[Unsupported image format: ${formatName}]`;
						extractedImages.push({ index: idx, vaultPath: null, alt });
						return { src: `__notor_skip_${idx}__`, alt };
					}

					try {
						const imgBuffer = await image.readAsBuffer();
						const ext = (contentType.split("/")[1] ?? "bin").replace("jpeg", "jpg");
						const hash = createHash("md5").update(imgBuffer).digest("hex");
						const filename = `${hash}.${ext}`;

						// Resolve target path via Obsidian's attachment folder logic
						const targetPath = await this.app.fileManager.getAvailablePathForAttachment(
							filename,
							sourcePath,
						);

						// Check if the file already exists at the resolved path
						const existing = this.app.vault.getFileByPath(targetPath);
						if (!existing) {
							// Save the image binary — use .slice() to extract the relevant portion
							const arrayBuf = imgBuffer.buffer.slice(
								imgBuffer.byteOffset,
								imgBuffer.byteOffset + imgBuffer.byteLength,
							);
							await this.app.vault.createBinary(targetPath, arrayBuf);
						}

						extractedImages.push({ index: idx, vaultPath: targetPath, alt: filename });
						return { src: `__notor_img_${idx}__`, alt: filename };
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.warn("Image extraction failed", { index: idx, error: errMsg });
						extractedImages.push({ index: idx, vaultPath: null, alt: `[Image extraction failed]` });
						return { src: `__notor_skip_${idx}__`, alt: `[Image extraction failed]` };
					}
				},
			);

			// Convert DOCX → HTML via mammoth (with image handler)
			const { value: html } = await mammoth.convertToHtml(
				{ buffer: buf },
				{ convertImage },
			);

			// Build a lookup from src marker → extracted image info
			const imageMap = new Map<string, { vaultPath: string | null; alt: string }>();
			for (const img of extractedImages) {
				imageMap.set(`__notor_img_${img.index}__`, img);
				imageMap.set(`__notor_skip_${img.index}__`, img);
			}

			// Convert HTML → Markdown via Turndown (local instance, not shared singleton)
			const td = new TurndownService({
				headingStyle: "atx",
				codeBlockStyle: "fenced",
				bulletListMarker: "-",
				emDelimiter: "*",
				strongDelimiter: "**",
				linkStyle: "inlined",
			});
			td.use(gfm);
			td.addRule("replaceImages", {
				filter: ["img"],
				replacement: (_content: string, node: HTMLElement) => {
					const src = node.getAttribute("src") ?? "";
					const alt = node.getAttribute("alt") ?? "";

					// Vault-path-aware image replacement
					if (src.startsWith("__notor_img_")) {
						const info = imageMap.get(src);
						if (info?.vaultPath) {
							return `![${alt}](${info.vaultPath})`;
						}
					}

					// Skipped / failed images
					if (src.startsWith("__notor_skip_")) {
						return alt || "[image]";
					}

					// Fallback
					return "[image]";
				},
			});

			const markdown = td.turndown(html);

			const extractedCount = extractedImages.filter(i => i.vaultPath !== null).length;
			const skippedCount = extractedImages.filter(i => i.vaultPath === null).length;
			log.info("Read docx", {
				path: resolvedPath,
				bytes: buf.length,
				imagesExtracted: extractedCount,
				imagesSkipped: skippedCount,
			});

			return {
				tool_name: this.name,
				success: true,
				result: markdown,
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
