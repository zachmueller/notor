/**
 * `write_docx` tool — converts Markdown content to a `.docx` file on the
 * filesystem, with optional template support.
 *
 * Validates all path inputs before any I/O. Generates a `.docx` from the
 * Markdown token tree using the `docx` library. When a template path is
 * provided, grafts the generated body content into the template's
 * `word/document.xml` via PizZip, preserving the template's styles,
 * margins, headers, and footers.
 *
 * Write tool available in Act mode only.
 * Auto-approve default: false.
 * Desktop-only: returns error if `Platform.isDesktopApp` is false.
 *
 * @see specs/04c-docx/spec.md — FR-72, FR-73, NFR-19
 */

import { Platform, getFrontMatterInfo } from "obsidian";
import type { App } from "obsidian";
import * as fs from "fs";
import { join, dirname, extname } from "path";
import { marked } from "marked";
import type { Token, Tokens } from "marked";
import {
	Document,
	Packer,
	Paragraph,
	TextRun,
	HeadingLevel,
	Table,
	TableRow,
	TableCell,
	ExternalHyperlink,
	AlignmentType,
	WidthType,
	BorderStyle,
} from "docx";
import PizZip from "pizzip";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { resolveAndValidatePath } from "../utils/path-validation";
import { logger } from "../utils/logger";
import { resolveNote } from "../utils/resolve-note";

const log = logger("WriteDocxTool");

// ---------------------------------------------------------------------------
// Inline token renderer
// ---------------------------------------------------------------------------

type InlineChild = TextRun | ExternalHyperlink;

function renderInline(tokens: Token[]): InlineChild[] {
	const result: InlineChild[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case "text":
				result.push(new TextRun({ text: (token as Tokens.Text).text }));
				break;
			case "strong":
				result.push(
					new TextRun({
						text: (token as Tokens.Strong).text,
						bold: true,
					})
				);
				break;
			case "em":
				result.push(
					new TextRun({
						text: (token as Tokens.Em).text,
						italics: true,
					})
				);
				break;
			case "codespan":
				result.push(
					new TextRun({
						text: (token as Tokens.Codespan).text,
						style: "Verbatim Char",
						font: { name: "Courier New" },
					})
				);
				break;
			case "link": {
				const linkToken = token as Tokens.Link;
				result.push(
					new ExternalHyperlink({
						link: linkToken.href,
						children: [new TextRun({ text: linkToken.text })],
					})
				);
				break;
			}
			default:
				result.push(new TextRun({ text: (token as Tokens.Generic).raw ?? "" }));
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Block token renderer
// ---------------------------------------------------------------------------

type BlockChild = Paragraph | Table;

function buildDocxChildren(tokens: Token[]): BlockChild[] {
	const result: BlockChild[] = [];

	for (const token of tokens) {
		switch (token.type) {
			case "heading": {
				const h = token as Tokens.Heading;
				const level =
					HeadingLevel[`HEADING_${h.depth}` as keyof typeof HeadingLevel];
				result.push(
					new Paragraph({
						heading: level,
						children: renderInline(h.tokens ?? []),
					})
				);
				break;
			}
			case "paragraph": {
				const p = token as Tokens.Paragraph;
				result.push(
					new Paragraph({ children: renderInline(p.tokens ?? []) })
				);
				break;
			}
			case "code": {
				const c = token as Tokens.Code;
				result.push(
					new Paragraph({
						style: "Source Code",
						children: [
							new TextRun({
								text: c.text,
								font: { name: "Courier New" },
							}),
						],
					})
				);
				break;
			}
			case "hr": {
				result.push(
					new Paragraph({
						border: {
							bottom: {
								style: BorderStyle.SINGLE,
								size: 6,
								space: 1,
								color: "auto",
							},
						},
					})
				);
				break;
			}
			case "blockquote": {
				const bq = token as Tokens.Blockquote;
				result.push(
					new Paragraph({
						indent: { left: 720 },
						children: renderInline(bq.tokens ?? []),
					})
				);
				break;
			}
			case "list": {
				const list = token as Tokens.List;
				for (const item of list.items) {
					if (list.ordered) {
						result.push(
							new Paragraph({
								numbering: { reference: "default-numbering", level: 0 },
								children: renderInline(item.tokens ?? []),
							})
						);
					} else {
						result.push(
							new Paragraph({
								bullet: { level: 0 },
								children: renderInline(item.tokens ?? []),
							})
						);
					}
				}
				break;
			}
			case "table": {
				const tbl = token as Tokens.Table;
				const headerRow = new TableRow({
					children: tbl.header.map(
						(cell: Tokens.TableCell) =>
							new TableCell({
								children: [
									new Paragraph({
										children: renderInline(cell.tokens ?? []),
									}),
								],
							})
					),
				});
				const bodyRows = tbl.rows.map(
					(row: Tokens.TableCell[]) =>
						new TableRow({
							children: row.map(
								(cell: Tokens.TableCell) =>
									new TableCell({
										children: [
											new Paragraph({
												children: renderInline(cell.tokens ?? []),
											}),
										],
									})
							),
						})
				);
				result.push(
					new Table({
						rows: [headerRow, ...bodyRows],
						width: { size: 100, type: WidthType.PERCENTAGE },
					})
				);
				break;
			}
			case "space":
				// Skip blank lines
				break;
			default:
				result.push(
					new Paragraph({
						children: [
							new TextRun({ text: (token as Tokens.Generic).raw ?? "" }),
						],
					})
				);
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// generateDocx
// ---------------------------------------------------------------------------

async function generateDocx(
	content: string,
	templatePath: string | null
): Promise<Buffer> {
	const tokens = marked.lexer(content);
	const children = buildDocxChildren(tokens);

	const doc = new Document({
		numbering: {
			config: [
				{
					reference: "default-numbering",
					levels: [
						{
							level: 0,
							format: "decimal",
							text: "%1.",
							alignment: AlignmentType.LEFT,
							style: {
								paragraph: { indent: { left: 720, hanging: 360 } },
							},
						},
					],
				},
			],
		},
		sections: [{ children }],
	});

	const tempBuffer = await Packer.toBuffer(doc);

	if (templatePath === null) {
		return tempBuffer;
	}

	// Graft generated body into template via PizZip
	const generatedZip = new PizZip(tempBuffer);
	const generatedDocXml = generatedZip.files["word/document.xml"];
	if (!generatedDocXml) {
		throw new Error(
			"Generated document.xml is malformed — could not locate <w:body>."
		);
	}
	const generatedXml: string = generatedDocXml.asText();

	const bodyMatch = generatedXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
	const capturedBody = bodyMatch?.[1];
	if (capturedBody === undefined) {
		throw new Error(
			"Generated document.xml is malformed — could not locate <w:body>."
		);
	}

	// Strip any <w:sectPr> from the generated body (we'll use the template's)
	const generatedBodyContent = capturedBody.replace(
		/<w:sectPr[\s\S]*?<\/w:sectPr>/g,
		""
	);

	const templateBuf = await fs.promises.readFile(templatePath);
	const templateZip = new PizZip(templateBuf);
	const templateDocXml = templateZip.files["word/document.xml"];
	if (!templateDocXml) {
		throw new Error(
			"Template document.xml is malformed — could not locate <w:body>."
		);
	}
	const templateXml: string = templateDocXml.asText();

	// Extract template's <w:sectPr> to preserve page layout
	const sectPrMatch = templateXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
	const sectPr = sectPrMatch ? sectPrMatch[0] : "";

	if (!/<w:body>[\s\S]*?<\/w:body>/.test(templateXml)) {
		throw new Error(
			"Template document.xml is malformed — could not locate <w:body>."
		);
	}

	const replacement = `<w:body>${generatedBodyContent}${sectPr}</w:body>`;
	const newTemplateXml = templateXml.replace(
		/<w:body>[\s\S]*?<\/w:body>/,
		replacement
	);

	templateZip.file("word/document.xml", newTemplateXml);

	return templateZip.generate({ type: "nodebuffer" });
}

// ---------------------------------------------------------------------------
// Tool implementation (DOCX-010 + DOCX-011)
// ---------------------------------------------------------------------------

/**
 * Implements the `write_docx` tool.
 *
 * Converts Markdown to a `.docx` file. Validates all inputs before any I/O.
 * Supports optional template grafting for custom styles.
 */
export class WriteDocxTool implements Tool {
	readonly name = "write_docx";
	readonly mode = "write" as const;

	readonly description =
		"Convert Markdown to a .docx file on the filesystem. " +
		"Provide either note_name (to convert an existing vault note directly) " +
		"or content (to convert new Markdown the assistant has composed). " +
		"When the source already exists as a vault note, prefer note_name to " +
		"avoid regenerating content. " +
		"Specify output_path for a full path, or filename + a configured default " +
		"output directory. Optionally provide a template_path to inherit styles, " +
		"margins, headers, and footers from an existing .docx file. " +
		"The output path must be within the vault or a user-configured allow-list. " +
		"Desktop-only tool. Requires Act mode.";

	readonly input_schema = {
		type: "object",
		properties: {
			note_name: {
				type: "string",
				description:
					"Path to an existing vault note whose Markdown content will be the docx source. " +
					"Accepts vault-relative path, bare note name, or path without .md extension. " +
					"Frontmatter is automatically stripped. " +
					"Use this instead of content when converting a note that already exists in the vault.",
			},
			content: {
				type: "string",
				description:
					"Markdown content to convert to .docx. " +
					"Use this for new or custom content that does not exist as a vault note. " +
					"Mutually exclusive with note_name.",
			},
			output_path: {
				type: "string",
				description:
					"Full output path including .docx extension. Vault-relative or absolute.",
			},
			filename: {
				type: "string",
				description:
					"Output filename without .docx extension. Used with the default output directory setting.",
			},
			template_path: {
				type: "string",
				description:
					"Path to a .docx template. Overrides the default template setting.",
			},
		},
		required: [],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const rawContent = params["content"] as string | undefined;
		const noteName = params["note_name"] as string | undefined;
		const output_path = params["output_path"] as string | undefined;
		const filename = params["filename"] as string | undefined;
		const template_path = params["template_path"] as string | undefined;

		// --- Content source validation ---
		const hasContent = rawContent !== undefined && typeof rawContent === "string" && rawContent.trim() !== "";
		const hasNoteName = noteName !== undefined && typeof noteName === "string" && noteName.trim() !== "";

		if (hasContent && hasNoteName) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Provide either content or note_name, not both.",
			};
		}

		if (!hasContent && !hasNoteName) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Either content or note_name must be provided.",
			};
		}

		if (!Platform.isDesktopApp) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "write_docx is only available on desktop.",
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

		// ---------------------------------------------------------------------------
		// Content source resolution
		// ---------------------------------------------------------------------------

		let content: string;

		if (hasNoteName) {
			const file = resolveNote(noteName!, this.app.vault, this.app.metadataCache);
			if (!file) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Note not found: ${noteName}`,
				};
			}
			if (file.extension !== "md") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Path is not a Markdown note: ${noteName}`,
				};
			}

			const fullContent = await this.app.vault.read(file);
			const fmInfo = getFrontMatterInfo(fullContent);
			content = fmInfo.exists
				? fullContent.slice(fmInfo.contentStart).replace(/^\n/, "")
				: fullContent;

			if (content.trim() === "") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Note is empty (after stripping frontmatter): ${noteName}`,
				};
			}
		} else {
			content = rawContent!;
		}

		// Validate filename has no path separators
		if (filename && (filename.includes("/") || filename.includes("\\"))) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "filename must not contain path separators.",
			};
		}

		// ---------------------------------------------------------------------------
		// Output path resolution (three-step)
		// ---------------------------------------------------------------------------

		let rawOutputPath: string;
		let filenameIgnored = false;

		const allowedPaths = this.settings.read_file_allowed_paths;

		if (output_path) {
			// Step 1: output_path provided
			if (filename) {
				filenameIgnored = true;
			}
			rawOutputPath = output_path;
		} else if (filename && this.settings.write_docx_default_output_dir) {
			// Step 2: filename + default output dir
			const defaultDirResult = resolveAndValidatePath(
				this.settings.write_docx_default_output_dir,
				vaultRoot,
				allowedPaths
			);
			if (!defaultDirResult.valid) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: defaultDirResult.error,
				};
			}
			rawOutputPath = join(defaultDirResult.resolvedPath, filename + ".docx");
		} else {
			// Step 3: no viable output path
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error:
					"No output path provided. Pass output_path, or provide a filename and configure write_docx_default_output_dir in Settings.",
			};
		}

		// ---------------------------------------------------------------------------
		// Validate final output path boundary
		// ---------------------------------------------------------------------------

		const outputResult = resolveAndValidatePath(rawOutputPath, vaultRoot, allowedPaths);
		if (!outputResult.valid) {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: outputResult.error,
			};
		}
		const resolvedOutputPath = outputResult.resolvedPath;

		// Validate parent directory exists
		try {
			await fs.promises.stat(dirname(resolvedOutputPath));
		} catch (e) {
			const err = e as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Output directory '${dirname(resolvedOutputPath)}' does not exist.`,
				};
			}
			throw e;
		}

		// ---------------------------------------------------------------------------
		// Template path resolution
		// ---------------------------------------------------------------------------

		const rawTemplatePath =
			template_path ||
			(this.settings.write_docx_default_template_path || null);

		let resolvedTemplatePath: string | null = null;

		if (rawTemplatePath) {
			const templateResult = resolveAndValidatePath(
				rawTemplatePath,
				vaultRoot,
				allowedPaths
			);
			if (!templateResult.valid) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: templateResult.error,
				};
			}
			resolvedTemplatePath = templateResult.resolvedPath;

			try {
				await fs.promises.stat(resolvedTemplatePath);
			} catch (e) {
				const err = e as NodeJS.ErrnoException;
				if (err.code === "ENOENT") {
					return {
						tool_name: this.name,
						success: false,
						result: "",
						error: `Template file not found: ${resolvedTemplatePath}`,
					};
				}
				throw e;
			}

			if (extname(resolvedTemplatePath).toLowerCase() !== ".docx") {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: "Template must be a .docx file.",
				};
			}
		}

		// ---------------------------------------------------------------------------
		// Generate and write
		// ---------------------------------------------------------------------------

		try {
			const buffer = await generateDocx(content, resolvedTemplatePath);
			await fs.promises.writeFile(resolvedOutputPath, buffer);

			log.info("Wrote docx", {
				path: resolvedOutputPath,
				template: resolvedTemplatePath ?? "(none)",
				bytes: buffer.length,
			});

			const sourceInfo = hasNoteName ? ` from note "${noteName}"` : "";
			const successMessage = `Successfully wrote .docx file${sourceInfo} to ${resolvedOutputPath}`;
			const result = filenameIgnored
				? `Warning: filename was ignored because output_path was provided.\n\n${successMessage}`
				: successMessage;

			return {
				tool_name: this.name,
				success: true,
				result,
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
