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
	ImageRun,
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
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { resolveAndValidatePath } from "../utils/path-validation";
import { logger } from "../utils/logger";
import { resolveNote } from "../utils/resolve-note";
import { resolveImageForDocx } from "./docx-image-utils";
import type { DocxImageData } from "./docx-image-utils";

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
// Image token collection (recursive walk of marked token tree)
// ---------------------------------------------------------------------------

/**
 * Recursively collect all image token hrefs from marked's token tree.
 * Image tokens are inline tokens nested inside paragraph, blockquote,
 * list item, and table cell tokens.
 */
function collectImageHrefs(tokens: Token[]): string[] {
	const hrefs: string[] = [];

	function walk(tokenList: Token[]): void {
		for (const token of tokenList) {
			if (token.type === "image") {
				hrefs.push((token as Tokens.Image).href);
			}
			// Descend into inline tokens
			if ("tokens" in token && Array.isArray((token as { tokens?: Token[] }).tokens)) {
				walk((token as { tokens: Token[] }).tokens);
			}
			// Descend into list items
			if ("items" in token && Array.isArray((token as Tokens.List).items)) {
				for (const item of (token as Tokens.List).items) {
					if (item.tokens) walk(item.tokens);
				}
			}
			// Descend into table cells
			if (token.type === "table") {
				const tbl = token as Tokens.Table;
				for (const cell of tbl.header) {
					if (cell.tokens) walk(cell.tokens);
				}
				for (const row of tbl.rows) {
					for (const cell of row) {
						if (cell.tokens) walk(cell.tokens);
					}
				}
			}
		}
	}

	walk(tokens);
	return hrefs;
}

/**
 * Scale image dimensions to fit within page content area (~600px wide, ~800px tall).
 */
function scaleImageDimensions(
	width: number,
	height: number,
): { width: number; height: number } {
	const maxW = 600;
	const maxH = 800;
	const wScale = width > maxW ? maxW / width : 1;
	const hScale = height > maxH ? maxH / height : 1;
	const scale = Math.min(wScale, hScale);
	if (scale < 1) {
		return {
			width: Math.round(width * scale),
			height: Math.round(height * scale),
		};
	}
	return { width, height };
}

// ---------------------------------------------------------------------------
// Block token renderer
// ---------------------------------------------------------------------------

type BlockChild = Paragraph | Table;

function buildDocxChildren(
	tokens: Token[],
	resolvedImages: Map<string, DocxImageData>,
): BlockChild[] {
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
				const pTokens = p.tokens ?? [];

				// Detect standalone image paragraph: exactly one child of type "image"
				const firstToken = pTokens[0];
				if (
					pTokens.length === 1 &&
					firstToken &&
					firstToken.type === "image"
				) {
					const imgToken = firstToken as Tokens.Image;
					const imageData = resolvedImages.get(imgToken.href);
					if (imageData) {
						const scaled = scaleImageDimensions(imageData.width, imageData.height);
						result.push(
							new Paragraph({
								children: [
									new ImageRun({
										type: imageData.type,
										data: imageData.buffer,
										transformation: {
											width: scaled.width,
											height: scaled.height,
										},
										altText: {
											title: imgToken.text || "Image",
											description: imgToken.text || "",
											name: imgToken.href,
										},
									}),
								],
							}),
						);
					} else {
						// Image not resolved — render as text placeholder
						result.push(
							new Paragraph({
								children: [
									new TextRun({ text: `[Image: ${imgToken.href}]` }),
								],
							}),
						);
					}
					break;
				}

				// Normal paragraph (including mixed image+text) — render via renderInline
				result.push(
					new Paragraph({ children: renderInline(pTokens) })
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
	templatePath: string | null,
	vaultRoot: string,
	allowedPaths: string[],
): Promise<Buffer> {
	const tokens = marked.lexer(content);

	// Image pre-resolution pass: collect all image hrefs, resolve in parallel
	const imageHrefs = collectImageHrefs(tokens);
	const resolvedImages = new Map<string, DocxImageData>();
	if (imageHrefs.length > 0) {
		const uniqueHrefs = [...new Set(imageHrefs)];
		const results = await Promise.all(
			uniqueHrefs.map((href) => resolveImageForDocx(href, vaultRoot, allowedPaths)),
		);
		for (let i = 0; i < uniqueHrefs.length; i++) {
			const result = results[i];
			const href = uniqueHrefs[i];
			if (result !== null && result !== undefined && href !== undefined) {
				resolvedImages.set(href, result);
			}
		}
	}

	const children = buildDocxChildren(tokens, resolvedImages);

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

	// Graft generated body into template via DOM-based approach
	const generatedZip = new PizZip(tempBuffer);
	const templateBuf = await fs.promises.readFile(templatePath);
	const templateZip = new PizZip(templateBuf);

	await graftIntoTemplate(generatedZip, templateZip);

	return templateZip.generate({ type: "nodebuffer" });
}

// ---------------------------------------------------------------------------
// DOM-based template grafting (Steps 1–4)
// ---------------------------------------------------------------------------

/**
 * Graft generated DOCX body content into a template, preserving the
 * template's styles, margins, headers, footers, and section properties.
 *
 * Uses @xmldom/xmldom for XML manipulation (replacing the previous
 * regex-based approach). Handles image relationship merging with
 * rId conflict resolution.
 */
async function graftIntoTemplate(
	generatedZip: PizZip,
	templateZip: PizZip,
): Promise<void> {
	const parser = new DOMParser();
	const serializer = new XMLSerializer();

	// --- Step 1: Parse body DOMs ---

	const generatedDocXml = generatedZip.files["word/document.xml"];
	if (!generatedDocXml) {
		throw new Error("Generated document.xml is malformed — could not locate word/document.xml.");
	}
	const genDoc = parser.parseFromString(generatedDocXml.asText(), "text/xml");
	const genBodyList = genDoc.getElementsByTagName("w:body");
	const genBody = genBodyList.item(0);
	if (!genBody) {
		throw new Error("Generated document.xml is malformed — could not locate <w:body>.");
	}

	const templateDocXml = templateZip.files["word/document.xml"];
	if (!templateDocXml) {
		throw new Error("Template document.xml is malformed — could not locate word/document.xml.");
	}
	const tmplDoc = parser.parseFromString(templateDocXml.asText(), "text/xml");
	const tmplBodyList = tmplDoc.getElementsByTagName("w:body");
	const tmplBody = tmplBodyList.item(0);
	if (!tmplBody) {
		throw new Error("Template document.xml is malformed — could not locate <w:body>.");
	}

	// Collect generated body children (excluding <w:sectPr>)
	const generatedBodyNodes: Node[] = [];
	for (let i = 0; i < genBody.childNodes.length; i++) {
		const child = genBody.childNodes.item(i);
		if (!child) continue;
		if (child.nodeType === 1 && (child as Element).tagName === "w:sectPr") continue;
		generatedBodyNodes.push(child);
	}

	// Remove all non-<w:sectPr> children from template body
	const tmplNodesToRemove: Node[] = [];
	for (let i = 0; i < tmplBody.childNodes.length; i++) {
		const child = tmplBody.childNodes.item(i);
		if (!child) continue;
		if (child.nodeType === 1 && (child as Element).tagName === "w:sectPr") continue;
		tmplNodesToRemove.push(child);
	}
	for (const node of tmplNodesToRemove) {
		tmplBody.removeChild(node);
	}

	// Find template's <w:sectPr> (insert point for generated content)
	let tmplSectPr: Element | null = null;
	for (let i = 0; i < tmplBody.childNodes.length; i++) {
		const child = tmplBody.childNodes.item(i);
		if (!child) continue;
		if (child.nodeType === 1 && (child as Element).tagName === "w:sectPr") {
			tmplSectPr = child as Element;
			break;
		}
	}

	// Capture as const for use in nested functions (TypeScript narrows the non-null check)
	const tmplBodyEl: Element = tmplBody;

	// Helper: append body nodes into template body (before sectPr if present)
	function appendBodyNodesToTemplate(nodes: Node[]): void {
		for (const bodyNode of nodes) {
			const imported = tmplDoc.importNode(bodyNode, true);
			if (tmplSectPr) {
				tmplBodyEl.insertBefore(imported, tmplSectPr);
			} else {
				tmplBodyEl.appendChild(imported);
			}
		}
	}

	// --- Step 2: Copy word/media/* image files ---

	const genMediaFiles: string[] = [];
	for (const filename of Object.keys(generatedZip.files)) {
		const entry = generatedZip.files[filename];
		if (entry && filename.startsWith("word/media/") && !entry.dir) {
			genMediaFiles.push(filename);
		}
	}

	// Handle duplicate media filenames
	const mediaRenameMap = new Map<string, string>(); // old filename → new filename
	for (const genMediaPath of genMediaFiles) {
		let targetPath = genMediaPath;
		if (templateZip.files[targetPath]) {
			// Rename with numeric suffix to avoid collision
			const lastDot = genMediaPath.lastIndexOf(".");
			const baseName = lastDot > 0 ? genMediaPath.substring(0, lastDot) : genMediaPath;
			const ext = lastDot > 0 ? genMediaPath.substring(lastDot) : "";
			let counter = 1;
			while (templateZip.files[`${baseName}_${counter}${ext}`]) {
				counter++;
			}
			targetPath = `${baseName}_${counter}${ext}`;
		}
		mediaRenameMap.set(genMediaPath, targetPath);
		const mediaFile = generatedZip.files[genMediaPath];
		if (mediaFile) {
			templateZip.file(targetPath, mediaFile.asUint8Array());
		}
	}

	// --- Step 3: Merge word/_rels/document.xml.rels with rId conflict resolution ---

	const tmplRelsFile = templateZip.files["word/_rels/document.xml.rels"];
	const genRelsFile = generatedZip.files["word/_rels/document.xml.rels"];

	if (tmplRelsFile && genRelsFile) {
		const tmplRelsDoc = parser.parseFromString(tmplRelsFile.asText(), "text/xml");
		const genRelsDoc = parser.parseFromString(genRelsFile.asText(), "text/xml");

		// Find highest rId in template
		let maxRId = 0;
		const tmplRelElements = tmplRelsDoc.getElementsByTagName("Relationship");
		for (let i = 0; i < tmplRelElements.length; i++) {
			const el = tmplRelElements.item(i);
			if (!el) continue;
			const id = el.getAttribute("Id") ?? "";
			const match = id.match(/^rId(\d+)$/);
			if (match) {
				maxRId = Math.max(maxRId, parseInt(match[1]!, 10));
			}
		}

		// Build rId remap table for generated relationships
		const rIdRemapTable = new Map<string, string>();
		const genRelElements = genRelsDoc.getElementsByTagName("Relationship");
		for (let i = 0; i < genRelElements.length; i++) {
			const el = genRelElements.item(i);
			if (!el) continue;
			const oldId = el.getAttribute("Id") ?? "";
			const newId = `rId${maxRId + i + 1}`;
			rIdRemapTable.set(oldId, newId);
		}

		// Remap rId references in the generated body DOM nodes
		const rIdAttrs = ["r:embed", "r:id", "r:link"];
		function walkAndRemapElements(node: Node): void {
			if (node.nodeType === 1) {
				const el = node as Element;
				for (const attr of rIdAttrs) {
					const val = el.getAttribute(attr);
					if (val && rIdRemapTable.has(val)) {
						el.setAttribute(attr, rIdRemapTable.get(val)!);
					}
				}
			}
			for (let i = 0; i < node.childNodes.length; i++) {
				const child = node.childNodes.item(i);
				if (child) walkAndRemapElements(child);
			}
		}
		for (const bodyNode of generatedBodyNodes) {
			walkAndRemapElements(bodyNode);
		}

		// Append remapped generated body children into template body
		appendBodyNodesToTemplate(generatedBodyNodes);

		// Append remapped <Relationship> elements to template .rels DOM
		const tmplRelsRoot = tmplRelsDoc.documentElement;
		for (let i = 0; i < genRelElements.length; i++) {
			const genRel = genRelElements.item(i);
			if (!genRel) continue;
			const newRel = tmplRelsDoc.createElement("Relationship");
			newRel.setAttribute("Id", rIdRemapTable.get(genRel.getAttribute("Id") ?? "") ?? "");
			newRel.setAttribute("Type", genRel.getAttribute("Type") ?? "");

			// Remap Target if it references a renamed media file
			let target = genRel.getAttribute("Target") ?? "";
			// Generated rels use paths like "media/image1.png" (relative to word/)
			const fullMediaPath = target.startsWith("media/") ? `word/${target}` : null;
			if (fullMediaPath && mediaRenameMap.has(fullMediaPath)) {
				const renamedFull = mediaRenameMap.get(fullMediaPath)!;
				target = renamedFull.replace(/^word\//, "");
			}
			newRel.setAttribute("Target", target);

			const targetMode = genRel.getAttribute("TargetMode");
			if (targetMode) {
				newRel.setAttribute("TargetMode", targetMode);
			}
			tmplRelsRoot.appendChild(newRel);
		}

		// Serialize updated .rels back to template zip
		templateZip.file("word/_rels/document.xml.rels", serializer.serializeToString(tmplRelsDoc));
	} else {
		// No rels merging needed — just append body nodes
		appendBodyNodesToTemplate(generatedBodyNodes);
	}

	// --- Step 4: Merge [Content_Types].xml ---

	if (genMediaFiles.length > 0) {
		const tmplCtFile = templateZip.files["[Content_Types].xml"];
		if (tmplCtFile) {
			const tmplCtDoc = parser.parseFromString(tmplCtFile.asText(), "text/xml");
			const typesRoot = tmplCtDoc.documentElement;

			// Collect existing extension defaults
			const existingExtensions = new Set<string>();
			const defaultElements = tmplCtDoc.getElementsByTagName("Default");
			for (let i = 0; i < defaultElements.length; i++) {
				const el = defaultElements.item(i);
				if (!el) continue;
				const ext = el.getAttribute("Extension");
				if (ext) existingExtensions.add(ext.toLowerCase());
			}

			// Map of image extensions to content types
			const extContentTypes: Record<string, string> = {
				png: "image/png",
				jpeg: "image/jpeg",
				gif: "image/gif",
				bmp: "image/bmp",
			};

			// Scan generated media filenames for extensions
			const neededExtensions = new Set<string>();
			for (const genMediaPath of genMediaFiles) {
				const renamedPath = mediaRenameMap.get(genMediaPath) ?? genMediaPath;
				const lastDot = renamedPath.lastIndexOf(".");
				if (lastDot > 0) {
					const ext = renamedPath.substring(lastDot + 1).toLowerCase();
					neededExtensions.add(ext);
				}
			}

			// Add missing Default entries
			for (const ext of neededExtensions) {
				const contentType = extContentTypes[ext];
				if (!existingExtensions.has(ext) && contentType) {
					const defaultEl = tmplCtDoc.createElement("Default");
					defaultEl.setAttribute("Extension", ext);
					defaultEl.setAttribute("ContentType", contentType);
					typesRoot.appendChild(defaultEl);
				}
			}

			templateZip.file("[Content_Types].xml", serializer.serializeToString(tmplCtDoc));
		}
	}

	// Serialize updated document.xml back to template zip
	templateZip.file("word/document.xml", serializer.serializeToString(tmplDoc));
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
			const buffer = await generateDocx(content, resolvedTemplatePath, vaultRoot, allowedPaths);
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
