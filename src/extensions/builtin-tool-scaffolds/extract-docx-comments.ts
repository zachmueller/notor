import { scaffold } from "./_scaffold-helper";

export const EXTRACT_DOCX_COMMENTS = scaffold(
	"extract_docx_comments",
	"Extract review comments from a .docx file and write them as a structured note.",
	"write",
	`params:
  docx_path:
    type: string
    description: "Path to the .docx file."
    path_namespace: filesystem
  output_path:
    type: string
    description: "Vault-relative path for the output note."
    path_namespace: vault
  include_resolved:
    type: boolean
    description: "Include resolved/done comments."
    default: false`,
	`const log = utils.logger("extract_docx_comments");

const docxPath = params.docx_path as string;
const outputPath = params.output_path as string;
const includeResolved = (params.include_resolved as boolean) ?? false;

if (!docxPath || typeof docxPath !== "string" || docxPath.trim() === "") {
  throw new Error("Missing required parameter: docx_path");
}

if (!outputPath || typeof outputPath !== "string" || outputPath.trim() === "") {
  throw new Error("Missing required parameter: output_path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("extract_docx_comments is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(docxPath);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".docx") {
  throw new Error("extract_docx_comments only supports .docx files.");
}

// Check file exists
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

// Extract XML blobs via PizZip
const buf = await libs.fs.promises.readFile(resolvedPath);
const zip = new libs.PizZip(buf);
const commentsXml = zip.files["word/comments.xml"]?.asText() ?? null;
const commentsExtXml = zip.files["word/commentsExtended.xml"]?.asText() ?? null;
const documentXml = zip.files["word/document.xml"]?.asText() ?? null;
const peopleXmlStr = zip.files["word/people.xml"]?.asText() ?? null;

// Early exit: no comments
if (!commentsXml) {
  return "No comments found in the document.";
}

// Parse all XML
const rawComments = utils.docxComments.parseCommentsXml(commentsXml);
if (rawComments.length === 0) {
  return "No comments found in the document.";
}

const { resolvedIds, threadingMap } = commentsExtXml
  ? utils.docxComments.parseCommentsExtendedXml(commentsExtXml)
  : { resolvedIds: new Set<string>(), threadingMap: new Map<string, string>() };

// Extract quoted text for each comment
if (documentXml) {
  for (const raw of rawComments) {
    raw.quotedText = utils.docxComments.extractQuotedText(documentXml, raw.commentId);
  }
}

// Parse people for @mention resolution
const peopleMap = peopleXmlStr
  ? utils.docxComments.parsePeopleXml(peopleXmlStr)
  : new Map<string, string>();

// Build threaded comments
const comments = utils.docxComments.buildCommentThreads(
  rawComments,
  threadingMap,
  resolvedIds,
  includeResolved,
  peopleMap,
);

if (comments.length === 0) {
  return "All comments are resolved. Use include_resolved=true to include them.";
}

// Check for existing note (for dedup/append)
const normalizedOutput = outputPath.endsWith(".md") ? outputPath : outputPath + ".md";
const existingFile = app.vault.getAbstractFileByPath(normalizedOutput);

let startNumber = 1;
let existingIds = new Set<string>();

if (existingFile && existingFile instanceof obsidian.TFile) {
  const existingContent = await app.vault.read(existingFile);
  const existing = utils.docxComments.extractExistingCommentIds(existingContent);
  existingIds = existing.ids;
  startNumber = existing.maxNumber + 1;
}

// Filter out already-written comments
const newComments = comments.filter((c: any) => !existingIds.has(c.uniqueId));
if (newComments.length === 0) {
  return \`All \${comments.length} comments already exist in \${normalizedOutput}.\`;
}

// Format as Markdown
const filename = resolvedPath.split("/").pop() ?? "document.docx";
const formatted = utils.docxComments.formatCommentsAsMarkdown(newComments, filename, startNumber);

// Write to vault
if (existingFile && existingFile instanceof obsidian.TFile) {
  await app.vault.process(existingFile, (data: string) => {
    return data.trimEnd() + "\\n\\n" + formatted;
  });
} else {
  await utils.ensureDirectoryExists(normalizedOutput);
  await app.vault.create(normalizedOutput, formatted);
}

// Return summary
const skipped = comments.length - newComments.length;
const summary =
  \`Extracted \${newComments.length} comment(s) to \${normalizedOutput}\` +
  (skipped > 0 ? \` (\${skipped} duplicate(s) skipped)\` : "") +
  (resolvedIds.size > 0 && !includeResolved ? \` (\${resolvedIds.size} resolved comment(s) excluded)\` : "");

log.info("Extracted docx comments", {
  path: resolvedPath,
  output: normalizedOutput,
  total: rawComments.length,
  written: newComments.length,
  skipped,
});

return summary;`,
);
