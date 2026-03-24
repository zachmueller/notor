/**
 * `extract_docx_comments` tool — extracts review comments from a `.docx` file
 * and writes them as a structured Obsidian vault note.
 *
 * Write tool available in Act mode only. Desktop-only.
 * Reads the `.docx` via `fs` + `PizZip`, parses XML with `@xmldom/xmldom`
 * (via docx-comment-parser), and writes the output note via Obsidian vault API.
 *
 * @see private/extract_docx_comments-plan.md — requirements
 * @see private/extract_docx_comments-impl-plan.md — implementation plan
 */

import { Platform, TFile, TFolder } from "obsidian";
import type { App } from "obsidian";
import * as fs from "fs";
import { extname } from "path";
import PizZip from "pizzip";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { resolveAndValidatePath } from "../utils/path-validation";
import { logger } from "../utils/logger";
import {
	parseCommentsXml,
	parseCommentsExtendedXml,
	extractQuotedText,
	parsePeopleXml,
	buildCommentThreads,
	formatCommentsAsMarkdown,
	extractExistingCommentIds,
} from "./docx-comment-parser";

const log = logger("ExtractDocxCommentsTool");

/**
 * Implements the `extract_docx_comments` tool.
 *
 * Extracts review comments from a `.docx` file and writes them as a
 * structured note into the vault. Supports threading, resolved-comment
 * filtering, @mention resolution, and idempotent append.
 */
export class ExtractDocxCommentsTool implements Tool {
	readonly name = "extract_docx_comments";
	readonly mode = "write" as const;

	readonly description =
		"Extract review comments from a .docx file and write them as a structured note. " +
		"Extracts comment text, reviewer name, timestamp, quoted document text, and reply threads. " +
		"Resolved comments are excluded by default (use include_resolved to include them). " +
		"Appends only new comments when the output note already exists (idempotent). " +
		"Desktop-only tool.";

	readonly input_schema = {
		type: "object",
		properties: {
			docx_path: {
				type: "string",
				description:
					"Path to the .docx file. Vault-relative or absolute. Must be within the vault or an allowed path.",
			},
			output_path: {
				type: "string",
				description:
					"Vault-relative path for the output note (e.g. 'Reviews/feedback.md'). The .md extension is optional.",
			},
			include_resolved: {
				type: "boolean",
				description:
					"Include resolved/done comments. Defaults to false.",
			},
		},
		required: ["docx_path", "output_path"],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const docxPath = params["docx_path"] as string | undefined;
		const outputPath = params["output_path"] as string | undefined;
		const includeResolved =
			(params["include_resolved"] as boolean) ?? false;

		// 1. Validate required params
		if (
			!docxPath ||
			typeof docxPath !== "string" ||
			docxPath.trim() === ""
		) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: docx_path",
			};
		}

		if (
			!outputPath ||
			typeof outputPath !== "string" ||
			outputPath.trim() === ""
		) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: output_path",
			};
		}

		// 2. Platform guard
		if (!Platform.isDesktopApp) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "extract_docx_comments is only available on desktop.",
			};
		}

		// 3. Resolve vault root
		const vaultRoot = this.getVaultRootPath();
		if (!vaultRoot) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Could not determine vault root path.",
			};
		}

		// 4. Validate + resolve docx path
		const pathResult = resolveAndValidatePath(
			docxPath,
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
				error: "extract_docx_comments only supports .docx files.",
			};
		}

		try {
			// 5. Check file exists
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

			// 6. Extract XML blobs via PizZip
			const buf = await fs.promises.readFile(resolvedPath);
			const zip = new PizZip(buf);
			const commentsXml =
				zip.files["word/comments.xml"]?.asText() ?? null;
			const commentsExtXml =
				zip.files["word/commentsExtended.xml"]?.asText() ?? null;
			const documentXml =
				zip.files["word/document.xml"]?.asText() ?? null;
			const peopleXmlStr =
				zip.files["word/people.xml"]?.asText() ?? null;

			// 7. Early exit: no comments
			if (!commentsXml) {
				return {
					tool_name: this.name,
					success: true,
					result: "No comments found in the document.",
				};
			}

			// 8. Parse all XML
			const rawComments = parseCommentsXml(commentsXml);
			if (rawComments.length === 0) {
				return {
					tool_name: this.name,
					success: true,
					result: "No comments found in the document.",
				};
			}

			const { resolvedIds, threadingMap } = commentsExtXml
				? parseCommentsExtendedXml(commentsExtXml)
				: {
						resolvedIds: new Set<string>(),
						threadingMap: new Map<string, string>(),
					};

			// 9. Extract quoted text for each comment
			if (documentXml) {
				for (const raw of rawComments) {
					raw.quotedText = extractQuotedText(
						documentXml,
						raw.commentId
					);
				}
			}

			// 10. Parse people for @mention resolution
			const peopleMap = peopleXmlStr
				? parsePeopleXml(peopleXmlStr)
				: new Map<string, string>();

			// 11. Build threaded comments
			const comments = buildCommentThreads(
				rawComments,
				threadingMap,
				resolvedIds,
				includeResolved,
				peopleMap
			);

			if (comments.length === 0) {
				return {
					tool_name: this.name,
					success: true,
					result: "All comments are resolved. Use include_resolved=true to include them.",
				};
			}

			// 12. Check for existing note (for dedup/append)
			const normalizedOutput = outputPath.endsWith(".md")
				? outputPath
				: outputPath + ".md";
			const existingFile =
				this.app.vault.getAbstractFileByPath(normalizedOutput);

			let startNumber = 1;
			let existingIds = new Set<string>();

			if (existingFile && existingFile instanceof TFile) {
				const existingContent =
					await this.app.vault.read(existingFile);
				const existing =
					extractExistingCommentIds(existingContent);
				existingIds = existing.ids;
				startNumber = existing.maxNumber + 1;
			}

			// 13. Filter out already-written comments
			const newComments = comments.filter(
				(c) => !existingIds.has(c.uniqueId)
			);
			if (newComments.length === 0) {
				return {
					tool_name: this.name,
					success: true,
					result: `All ${comments.length} comments already exist in ${normalizedOutput}.`,
				};
			}

			// 14. Format as Markdown
			const filename =
				resolvedPath.split("/").pop() ?? "document.docx";
			const formatted = formatCommentsAsMarkdown(
				newComments,
				filename,
				startNumber
			);

			// 15. Write to vault
			if (existingFile && existingFile instanceof TFile) {
				await this.app.vault.process(existingFile, (data) => {
					return data.trimEnd() + "\n\n" + formatted;
				});
			} else {
				await this.ensureDirectoryExists(normalizedOutput);
				await this.app.vault.create(normalizedOutput, formatted);
			}

			// 16. Return summary
			const skipped = comments.length - newComments.length;
			const summary =
				`Extracted ${newComments.length} comment(s) to ${normalizedOutput}` +
				(skipped > 0
					? ` (${skipped} duplicate(s) skipped)`
					: "") +
				(resolvedIds.size > 0 && !includeResolved
					? ` (${resolvedIds.size} resolved comment(s) excluded)`
					: "");

			log.info("Extracted docx comments", {
				path: resolvedPath,
				output: normalizedOutput,
				total: rawComments.length,
				written: newComments.length,
				skipped,
			});

			return {
				tool_name: this.name,
				success: true,
				result: summary,
			};
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.error("Failed to extract docx comments", {
				path: resolvedPath,
				error: message,
			});
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Failed to extract comments: ${message}`,
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

	/**
	 * Ensure all intermediate directories in a vault-relative path exist.
	 * Pattern from write-note.ts.
	 */
	private async ensureDirectoryExists(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		parts.pop(); // remove filename
		if (parts.length === 0) return;

		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing =
				this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
				log.debug("Created directory", { path: current });
			} else if (!(existing instanceof TFolder)) {
				throw new Error(
					`Cannot create directory: "${current}" already exists as a file`
				);
			}
		}
	}
}
