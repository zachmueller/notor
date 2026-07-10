import { scaffold } from "./_scaffold-helper";

export const IMPORT_XLSX = scaffold(
	"import_xlsx",
	"Parse an .xlsx file and save its content as a Markdown note in the vault (one GFM table per sheet).",
	"write",
	`params:
  path:
    type: string
    description: "Path to the .xlsx file. Vault-relative or absolute."
    path_namespace: filesystem
  note_path:
    type: string
    description: "Vault-relative path for the output note (e.g. \\"folder/My Sheet\\"). The .md extension is added automatically if omitted."
    path_namespace: vault
settings:
  read_xlsx_max_bytes:
    name: "Max Read Size (bytes)"
    type: number
    description: "Reject reading .xlsx files larger than this many bytes (protects memory and token budget). Applies to read_xlsx and import_xlsx."
    default: 52428800`,
	`const log = utils.logger("import_xlsx");

const filePath = params.path as string;
const notePath = params.note_path as string;
const maxBytes = typeof settings.read_xlsx_max_bytes === "number" ? settings.read_xlsx_max_bytes : 52428800;

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}
if (!notePath || typeof notePath !== "string" || notePath.trim() === "") {
  throw new Error("Missing required parameter: note_path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("import_xlsx is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".xlsx") {
  throw new Error("import_xlsx only supports .xlsx files.");
}

let stat: any;
try {
  stat = await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}
if (stat.size > maxBytes) {
  throw new Error(\`File is \${stat.size} bytes, exceeding the read_xlsx_max_bytes limit of \${maxBytes}. Increase the limit in Settings if this is intentional.\`);
}

// --- Cell value mapping (dates -> ISO, formulas -> result/formula, rich text -> text) ---
function cellToScalar(cell: any): any {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object") {
    if ("formula" in v || "sharedFormula" in v) {
      const r = (v as any).result;
      if (r === null || r === undefined) return "=" + ((v as any).formula ?? (v as any).sharedFormula ?? "");
      if (r instanceof Date) return r.toISOString();
      if (typeof r === "object" && r !== null && "error" in r) return String((r as any).error);
      return r;
    }
    if ("richText" in v && Array.isArray((v as any).richText)) {
      return (v as any).richText.map((rt: any) => rt.text ?? "").join("");
    }
    if ("hyperlink" in v) return (v as any).text ?? (v as any).hyperlink ?? "";
    if ("error" in v) return String((v as any).error);
    return cell.text;
  }
  return v;
}

function escapeGfm(s: any): string {
  if (s === null || s === undefined) return "";
  return String(s).replace(/\\|/g, "\\\\|").replace(/\\r?\\n/g, "<br>");
}

function extractRows(ws: any): any[][] {
  const rows: any[][] = [];
  let maxWidth = 0;
  ws.eachRow({ includeEmpty: true }, (row: any) => {
    const cells: any[] = [];
    row.eachCell({ includeEmpty: true }, (cell: any) => cells.push(cellToScalar(cell)));
    if (cells.length > maxWidth) maxWidth = cells.length;
    rows.push(cells);
  });
  for (const r of rows) {
    while (r.length < maxWidth) r.push(null);
  }
  return rows;
}

// --- Read workbook and build Markdown ---
const ExcelJS = (await libs.exceljs()).default;
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(resolvedPath);

const parts: string[] = [];
let sheetCount = 0;
workbook.eachSheet((ws: any) => {
  sheetCount++;
  parts.push(\`## \${ws.name}\`);
  const rows = extractRows(ws);
  if (rows.length === 0) {
    parts.push("_(empty sheet)_");
    return;
  }
  const header = rows[0].map((c: any) => escapeGfm(c));
  const sep = header.map(() => "---");
  const body = rows.slice(1).map((r: any[]) => r.map((c: any) => escapeGfm(c)));
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + sep.join(" | ") + " |",
    ...body.map((r: string[]) => "| " + r.join(" | ") + " |"),
  ];
  parts.push(lines.join("\\n"));
});

if (sheetCount === 0) {
  throw new Error("The workbook contains no worksheets.");
}

const markdown = parts.join("\\n\\n") + "\\n";

const finalNotePath = notePath.endsWith(".md") ? notePath : notePath + ".md";
const existingFile = utils.resolveNote(notePath);

if (!existingFile) {
  await utils.ensureDirectoryExists(finalNotePath);
  await app.vault.create(finalNotePath, markdown);
  log.info("Imported xlsx as new note", { source: resolvedPath, dest: finalNotePath, chars: markdown.length, sheets: sheetCount });
  await utils.notes.open(finalNotePath);
  return \`Note created: \${finalNotePath} (\${markdown.length} characters, \${sheetCount} sheet(s))\`;
}

try {
  await utils.checkpoints.create(existingFile.path, "import_xlsx", "");
} catch { /* non-fatal */ }

await app.vault.process(existingFile, () => markdown);
utils.staleContent.updateAfterWrite(existingFile.path, markdown);
log.info("Imported xlsx over existing note", { source: resolvedPath, dest: existingFile.path, chars: markdown.length, sheets: sheetCount });
await utils.notes.open(existingFile.path);
return \`Note updated: \${existingFile.path} (\${markdown.length} characters, \${sheetCount} sheet(s))\`;`,
);
