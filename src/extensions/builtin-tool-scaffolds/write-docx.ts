import { scaffold } from "./_scaffold-helper";

export const WRITE_DOCX = scaffold(
	"write_docx",
	"Convert Markdown to a .docx file on the filesystem.",
	"write",
	`params:
  note_name:
    type: string
    description: "Path to an existing vault note to convert. Mutually exclusive with content."
    path_namespace: vault
    path_resolve_as: note
    path_access: read
  content:
    type: string
    description: "Markdown content to convert. Mutually exclusive with note_name."
  output_path:
    type: string
    description: "Full output path including .docx extension."
    path_namespace: filesystem
  filename:
    type: string
    description: "Output filename without .docx extension."
  template_path:
    type: string
    description: "Path to a .docx template."
    path_namespace: filesystem
    path_access: read
settings:
  write_docx_default_output_dir:
    name: "Default Output Directory"
    type: string
    description: "Default output directory when only filename is provided."
    default: ""
  write_docx_default_template_path:
    name: "Default Template Path"
    type: string
    description: "Default .docx template path."
    default: ""`,
	`const log = utils.logger("write_docx");

const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel,
        Table, TableRow, TableCell, ExternalHyperlink,
        AlignmentType, WidthType, BorderStyle } = libs.docx;

// --- Inline token renderer ---

type InlineChild = any;
interface InlineStyle { bold?: boolean; italics?: boolean; strike?: boolean }

function renderInline(tokens: any[], style: InlineStyle = {}): InlineChild[] {
  const result: InlineChild[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text":
        result.push(new TextRun({ text: token.text, ...style }));
        break;
      case "strong":
        result.push(...renderInline(token.tokens ?? [], { ...style, bold: true }));
        break;
      case "em":
        result.push(...renderInline(token.tokens ?? [], { ...style, italics: true }));
        break;
      case "del":
        result.push(...renderInline(token.tokens ?? [], { ...style, strike: true }));
        break;
      case "codespan":
        result.push(new TextRun({ text: token.text, ...style, font: { name: "Courier New" } }));
        break;
      case "link":
        result.push(new ExternalHyperlink({
          link: token.href,
          children: renderInline(token.tokens ?? [{ type: "text", text: token.text }], style),
        }));
        break;
      case "image":
        result.push(new TextRun({ text: \`[Image: \${token.href}]\`, ...style }));
        break;
      default:
        result.push(new TextRun({ text: token.raw ?? "", ...style }));
    }
  }
  return result;
}

// --- Image token collection ---

function collectImageHrefs(tokens: any[]): string[] {
  const hrefs: string[] = [];

  function walk(tokenList: any[]): void {
    for (const token of tokenList) {
      if (token.type === "image") hrefs.push(token.href);
      if (token.tokens && Array.isArray(token.tokens)) walk(token.tokens);
      if (token.items && Array.isArray(token.items)) {
        for (const item of token.items) {
          if (item.tokens) walk(item.tokens);
        }
      }
      if (token.type === "table") {
        for (const cell of token.header) {
          if (cell.tokens) walk(cell.tokens);
        }
        for (const row of token.rows) {
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

function scaleImageDimensions(width: number, height: number): { width: number; height: number } {
  const maxW = 600;
  const maxH = 800;
  const wScale = width > maxW ? maxW / width : 1;
  const hScale = height > maxH ? maxH / height : 1;
  const scale = Math.min(wScale, hScale);
  if (scale < 1) {
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }
  return { width, height };
}

// --- Block token renderer ---

interface BlockContext { listLevel: number; indentLeft: number }

function buildDocxChildren(tokens: any[], resolvedImages: Map<string, any>, ctx: BlockContext = { listLevel: 0, indentLeft: 0 }): any[] {
  const result: any[] = [];
  const indent = ctx.indentLeft > 0 ? { indent: { left: ctx.indentLeft } } : {};

  for (const token of tokens) {
    switch (token.type) {
      case "heading": {
        const level = HeadingLevel[\`HEADING_\${token.depth}\` as keyof typeof HeadingLevel];
        result.push(new Paragraph({ heading: level, ...indent, children: renderInline(token.tokens ?? []) }));
        break;
      }
      case "paragraph": {
        const pTokens = token.tokens ?? [];
        const firstToken = pTokens[0];

        // Detect standalone image paragraph
        if (pTokens.length === 1 && firstToken && firstToken.type === "image") {
          const imageData = resolvedImages.get(firstToken.href);
          if (imageData) {
            const scaled = scaleImageDimensions(imageData.width, imageData.height);
            result.push(new Paragraph({
              ...indent,
              children: [new ImageRun({
                type: imageData.type,
                data: imageData.buffer,
                transformation: { width: scaled.width, height: scaled.height },
                altText: { title: firstToken.text || "Image", description: firstToken.text || "", name: firstToken.href },
              })],
            }));
          } else {
            result.push(new Paragraph({ ...indent, children: [new TextRun({ text: \`[Image: \${firstToken.href}]\` })] }));
          }
          break;
        }

        result.push(new Paragraph({ ...indent, children: renderInline(pTokens) }));
        break;
      }
      case "code": {
        const lines = (token.text as string).split("\\n");
        for (const line of lines) {
          result.push(new Paragraph({
            style: "Source Code",
            ...indent,
            children: [new TextRun({ text: line, font: { name: "Courier New" } })],
          }));
        }
        break;
      }
      case "hr": {
        result.push(new Paragraph({
          ...indent,
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: "auto" } },
        }));
        break;
      }
      case "blockquote": {
        result.push(...buildDocxChildren(token.tokens ?? [], resolvedImages, {
          ...ctx,
          indentLeft: ctx.indentLeft + 720,
        }));
        break;
      }
      case "list": {
        for (const item of token.items) {
          const inlineTokens = (item.tokens ?? []).filter((t: any) => t.type !== "list");
          const nestedLists = (item.tokens ?? []).filter((t: any) => t.type === "list");
          if (token.ordered) {
            result.push(new Paragraph({
              numbering: { reference: "default-numbering", level: ctx.listLevel },
              ...indent,
              children: renderInline(inlineTokens),
            }));
          } else {
            result.push(new Paragraph({ bullet: { level: ctx.listLevel }, ...indent, children: renderInline(inlineTokens) }));
          }
          for (const nested of nestedLists) {
            result.push(...buildDocxChildren([nested], resolvedImages, { ...ctx, listLevel: ctx.listLevel + 1 }));
          }
        }
        break;
      }
      case "table": {
        const headerRow = new TableRow({
          children: token.header.map((cell: any) =>
            new TableCell({ children: [new Paragraph({ children: renderInline(cell.tokens ?? []) })] })
          ),
        });
        const bodyRows = token.rows.map((row: any[]) =>
          new TableRow({
            children: row.map((cell: any) =>
              new TableCell({ children: [new Paragraph({ children: renderInline(cell.tokens ?? []) })] })
            ),
          })
        );
        result.push(new Table({ rows: [headerRow, ...bodyRows], width: { size: 100, type: WidthType.PERCENTAGE } }));
        break;
      }
      case "space":
        break;
      default:
        result.push(new Paragraph({ children: [new TextRun({ text: token.raw ?? "" })] }));
    }
  }

  return result;
}

// --- generateDocx ---

async function generateDocx(mdContent: string, templatePath: string | null): Promise<Buffer> {
  const tokens = libs.marked.lexer(mdContent);

  // Image pre-resolution pass
  const imageHrefs = collectImageHrefs(tokens);
  const resolvedImages = new Map<string, any>();
  if (imageHrefs.length > 0) {
    const uniqueHrefs = [...new Set(imageHrefs)];
    const results = await Promise.all(uniqueHrefs.map((href: string) => utils.resolveImageForDocx(href)));
    for (let i = 0; i < uniqueHrefs.length; i++) {
      const r = results[i];
      const href = uniqueHrefs[i];
      if (r !== null && r !== undefined && href !== undefined) {
        resolvedImages.set(href, r);
      }
    }
  }

  const children = buildDocxChildren(tokens, resolvedImages);

  const doc = new Document({
    numbering: {
      config: [{
        reference: "default-numbering",
        levels: [{
          level: 0,
          format: "decimal",
          text: "%1.",
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{ children }],
  });

  const tempBuffer = await Packer.toBuffer(doc);

  if (templatePath === null) return tempBuffer;

  // Graft generated body into template
  const generatedZip = new libs.PizZip(tempBuffer);
  const templateBuf = await libs.fs.promises.readFile(templatePath);
  const templateZip = new libs.PizZip(templateBuf);

  await utils.graftDocxIntoTemplate(generatedZip, templateZip);

  return templateZip.generate({ type: "nodebuffer" });
}

// --- Main logic ---

const rawContent = params.content as string | undefined;
const noteName = params.note_name as string | undefined;
const output_path = params.output_path as string | undefined;
const filename = params.filename as string | undefined;
const template_path = params.template_path as string | undefined;

// Content source validation
const hasContent = rawContent !== undefined && typeof rawContent === "string" && rawContent.trim() !== "";
const hasNoteName = noteName !== undefined && typeof noteName === "string" && noteName.trim() !== "";

if (hasContent && hasNoteName) throw new Error("Provide either content or note_name, not both.");
if (!hasContent && !hasNoteName) throw new Error("Either content or note_name must be provided.");

if (!obsidian.Platform.isDesktopApp) throw new Error("write_docx is only available on desktop.");

// Content source resolution
let mdContent: string;

if (hasNoteName) {
  const file = utils.resolveNote(noteName!);
  if (!file) throw new Error(\`Note not found: \${noteName}\`);
  if (file.extension !== "md") throw new Error(\`Path is not a Markdown note: \${noteName}\`);

  const fullContent = await app.vault.read(file);
  const fmInfo = obsidian.getFrontMatterInfo(fullContent);
  mdContent = fmInfo.exists
    ? fullContent.slice(fmInfo.contentStart).replace(/^\\n/, "")
    : fullContent;

  if (mdContent.trim() === "") throw new Error(\`Note is empty (after stripping frontmatter): \${noteName}\`);
} else {
  mdContent = rawContent!;
}

// Validate filename has no path separators
if (filename && (filename.includes("/") || filename.includes("\\\\"))) {
  throw new Error("filename must not contain path separators.");
}

// Output path resolution (three-step)
let rawOutputPath: string;
let filenameIgnored = false;

if (output_path) {
  if (filename) filenameIgnored = true;
  rawOutputPath = output_path;
} else if (filename && settings.write_docx_default_output_dir) {
  const defaultDirResult = utils.resolveAndValidatePath(settings.write_docx_default_output_dir as string);
  if (!defaultDirResult.valid) throw new Error(defaultDirResult.error);
  rawOutputPath = libs.path.join(defaultDirResult.resolvedPath, filename + ".docx");
} else {
  throw new Error("No output path provided. Pass output_path, or provide a filename and configure write_docx_default_output_dir in Settings.");
}

// Validate final output path boundary
const outputResult = utils.resolveAndValidatePath(rawOutputPath);
if (!outputResult.valid) throw new Error(outputResult.error);
const resolvedOutputPath = outputResult.resolvedPath;

// Validate parent directory exists
try {
  await libs.fs.promises.stat(libs.path.dirname(resolvedOutputPath));
} catch (e: any) {
  if (e.code === "ENOENT") {
    throw new Error(\`Output directory '\${libs.path.dirname(resolvedOutputPath)}' does not exist.\`);
  }
  throw e;
}

// Template path resolution
const rawTemplatePath = template_path || (settings.write_docx_default_template_path as string) || null;
let resolvedTemplatePath: string | null = null;

if (rawTemplatePath) {
  const templateResult = utils.resolveAndValidatePath(rawTemplatePath);
  if (!templateResult.valid) throw new Error(templateResult.error);
  resolvedTemplatePath = templateResult.resolvedPath;

  try {
    await libs.fs.promises.stat(resolvedTemplatePath);
  } catch (e: any) {
    if (e.code === "ENOENT") throw new Error(\`Template file not found: \${resolvedTemplatePath}\`);
    throw e;
  }

  if (libs.path.extname(resolvedTemplatePath).toLowerCase() !== ".docx") {
    throw new Error("Template must be a .docx file.");
  }
}

// Generate and write
const buffer = await generateDocx(mdContent, resolvedTemplatePath);
await libs.fs.promises.writeFile(resolvedOutputPath, buffer);

log.info("Wrote docx", {
  path: resolvedOutputPath,
  template: resolvedTemplatePath ?? "(none)",
  bytes: buffer.length,
});

const sourceInfo = hasNoteName ? \` from note "\${noteName}"\` : "";
const successMessage = \`Successfully wrote .docx file\${sourceInfo} to \${resolvedOutputPath}\`;
const result = filenameIgnored
  ? \`Warning: filename was ignored because output_path was provided.\\n\\n\${successMessage}\`
  : successMessage;

return result;`,
);
