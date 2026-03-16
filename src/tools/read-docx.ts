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
import type { App } from "obsidian";
import * as fs from "fs";
import { extname } from "path";
import mammoth from "mammoth";
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
		"Images are replaced with [image] placeholders. " +
		"Desktop-only tool.";

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

			// Convert DOCX → HTML via mammoth
			const { value: html } = await mammoth.convertToHtml({ buffer: buf });

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
				replacement: () => "[image]",
			});

			const markdown = td.turndown(html);

			log.info("Read docx", { path: resolvedPath, bytes: buf.length });

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
