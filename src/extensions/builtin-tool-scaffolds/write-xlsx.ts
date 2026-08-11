import { scaffold } from "./_scaffold-helper";

export const WRITE_XLSX = scaffold(
	"write_xlsx",
	"Create an .xlsx file on the filesystem from Markdown tables or JSON data.",
	"write",
	`params:
  content:
    type: string
    description: "The spreadsheet data. Markdown GFM table(s) when format=markdown, or a JSON string when format=json."
  format:
    type: string
    description: "How to interpret content: 'markdown' (default) parses GFM tables; 'json' parses array-of-arrays, array-of-objects, or { sheets: { name: rows } }."
    enum:
      - markdown
      - json
    default: "markdown"
  output_path:
    type: string
    optional: true
    description: "Full output path including .xlsx extension. Provide this or filename."
    path_namespace: filesystem
  filename:
    type: string
    optional: true
    description: "Output filename without .xlsx extension. Combined with the default output directory setting. Provide this or output_path."
settings:
  write_xlsx_default_output_dir:
    name: "Default Output Directory"
    type: string
    description: "Default output directory when only filename is provided."
    default: ""`,
	`const log = utils.logger("write_xlsx");

const rawContent = params.content as string | undefined;
const format = (params.format as string) === "json" ? "json" : "markdown";
const output_path = params.output_path as string | undefined;
const filename = params.filename as string | undefined;

if (!rawContent || typeof rawContent !== "string" || rawContent.trim() === "") {
  throw new Error("Missing required parameter: content");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("write_xlsx is only available on desktop.");
}

// Validate filename has no path separators
if (filename && (filename.includes("/") || filename.includes("\\\\"))) {
  throw new Error("filename must not contain path separators.");
}

// --- Output path resolution (three-step, mirrors write_docx) ---
let rawOutputPath: string;
let filenameIgnored = false;

if (output_path) {
  if (filename) filenameIgnored = true;
  rawOutputPath = output_path;
} else if (filename && settings.write_xlsx_default_output_dir) {
  const defaultDirResult = utils.resolveAndValidatePath(settings.write_xlsx_default_output_dir as string);
  if (!defaultDirResult.valid) throw new Error(defaultDirResult.error);
  rawOutputPath = libs.path.join(defaultDirResult.resolvedPath, filename + ".xlsx");
} else {
  throw new Error("No output path provided. Pass output_path, or provide a filename and configure write_xlsx_default_output_dir in Settings.");
}

const outputResult = utils.resolveAndValidatePath(rawOutputPath);
if (!outputResult.valid) throw new Error(outputResult.error);
let resolvedOutputPath = outputResult.resolvedPath;
if (libs.path.extname(resolvedOutputPath).toLowerCase() !== ".xlsx") {
  resolvedOutputPath = resolvedOutputPath + ".xlsx";
}

// Validate parent directory exists
try {
  await libs.fs.promises.stat(libs.path.dirname(resolvedOutputPath));
} catch (e: any) {
  if (e.code === "ENOENT") {
    throw new Error(\`Output directory '\${libs.path.dirname(resolvedOutputPath)}' does not exist.\`);
  }
  throw e;
}

// --- Build sheet data: Array<{ name, rows: (string|number|null)[][] }> ---
const sheetData: Array<{ name: string; rows: any[][] }> = [];

if (format === "json") {
  let parsed: any;
  try {
    parsed = JSON.parse(rawContent);
  } catch (e: any) {
    throw new Error(\`content is not valid JSON: \${e.message}\`);
  }

  function objectsToRows(arr: any[]): any[][] {
    const keys: string[] = [];
    for (const obj of arr) {
      for (const k of Object.keys(obj ?? {})) {
        if (!keys.includes(k)) keys.push(k);
      }
    }
    const rows: any[][] = [keys];
    for (const obj of arr) {
      rows.push(keys.map((k) => (obj && k in obj ? obj[k] : null)));
    }
    return rows;
  }

  function normalizeRows(value: any): any[][] {
    if (!Array.isArray(value)) throw new Error("Expected an array of rows.");
    if (value.length === 0) return [];
    if (Array.isArray(value[0])) return value as any[][];
    if (typeof value[0] === "object" && value[0] !== null) return objectsToRows(value);
    // array of scalars -> single column
    return value.map((v: any) => [v]);
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.sheets && typeof parsed.sheets === "object") {
    for (const [name, rows] of Object.entries(parsed.sheets)) {
      sheetData.push({ name, rows: normalizeRows(rows) });
    }
  } else {
    sheetData.push({ name: "Sheet1", rows: normalizeRows(parsed) });
  }
} else {
  // Markdown: walk tokens; a heading names the next table's sheet.
  const tokens = libs.marked.lexer(rawContent);
  let pendingName: string | null = null;
  let autoIndex = 0;
  for (const token of tokens as any[]) {
    if (token.type === "heading") {
      pendingName = (token.text ?? "").trim() || null;
    } else if (token.type === "table") {
      autoIndex++;
      const name = pendingName || \`Sheet\${autoIndex}\`;
      pendingName = null;
      const header = token.header.map((c: any) => c.text ?? "");
      const rows = token.rows.map((row: any[]) => row.map((c: any) => c.text ?? ""));
      sheetData.push({ name, rows: [header, ...rows] });
    }
  }
  if (sheetData.length === 0) {
    throw new Error("No Markdown tables found in content. Provide at least one GFM table, or use format=json.");
  }
}

// --- Write workbook ---
const ExcelJS = (await libs.exceljs()).default;
const workbook = new ExcelJS.Workbook();

const usedNames = new Set<string>();
for (const sheet of sheetData) {
  // Excel sheet names: max 31 chars, cannot contain []:*?/\\ and must be unique.
  let base = (sheet.name || "Sheet").replace(/[\\[\\]:*?/\\\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  let n = 2;
  while (usedNames.has(name)) {
    const suffix = " (" + n + ")";
    name = base.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  usedNames.add(name);
  const ws = workbook.addWorksheet(name);
  for (const row of sheet.rows) {
    ws.addRow(row);
  }
}

await workbook.xlsx.writeFile(resolvedOutputPath);

const stat = await libs.fs.promises.stat(resolvedOutputPath);
log.info("Wrote xlsx", { path: resolvedOutputPath, sheets: sheetData.length, bytes: stat.size });

const successMessage = \`Successfully wrote .xlsx file to \${resolvedOutputPath} (\${sheetData.length} sheet(s)).\`;
return filenameIgnored
  ? \`Warning: filename was ignored because output_path was provided.\\n\\n\${successMessage}\`
  : successMessage;`,
);
