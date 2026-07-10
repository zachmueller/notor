import { scaffold } from "./_scaffold-helper";

export const READ_XLSX = scaffold(
	"read_xlsx",
	"Read an .xlsx file and return its content as Markdown tables or structured JSON.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the .xlsx file. Vault-relative or absolute."
    path_namespace: filesystem
  sheet:
    type: string
    description: "Which sheet(s) to read. Accepts a sheet name, a 1-based index, or a comma-separated list of names/indices. Defaults to the first sheet."
    default: ""
  format:
    type: string
    description: "Output format: 'markdown' (default, one GFM table per sheet) or 'json' (array-of-arrays rows per sheet)."
    enum:
      - markdown
      - json
    default: "markdown"
settings:
  read_xlsx_max_bytes:
    name: "Max Read Size (bytes)"
    type: number
    description: "Reject reading .xlsx files larger than this many bytes (protects memory and token budget). Applies to read_xlsx and import_xlsx."
    default: 52428800`,
	`const log = utils.logger("read_xlsx");

const filePath = params.path as string;
const sheetParam = (params.sheet as string) ?? "";
const format = (params.format as string) === "json" ? "json" : "markdown";
const maxBytes = typeof settings.read_xlsx_max_bytes === "number" ? settings.read_xlsx_max_bytes : 52428800;

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("read_xlsx is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".xlsx") {
  throw new Error("read_xlsx only supports .xlsx files.");
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

// --- Cell value mapping ---
// Convert an ExcelJS cell to a JS scalar suitable for JSON/Markdown:
// dates -> ISO strings; formulas -> cached result (or the formula string when
// uncached); rich text -> concatenated text; hyperlinks -> display text.
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

function scalarToCellString(scalar: any): string {
  if (scalar === null || scalar === undefined) return "";
  return String(scalar);
}

function escapeGfm(s: string): string {
  return s.replace(/\\|/g, "\\\\|").replace(/\\r?\\n/g, "<br>");
}

// --- Sheet selection ---
const ExcelJS = (await libs.exceljs()).default;
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(resolvedPath);

const allSheets: any[] = workbook.worksheets;
if (allSheets.length === 0) {
  throw new Error("The workbook contains no worksheets.");
}

function resolveSheet(token: string): any {
  const t = token.trim();
  if (t === "") return null;
  // 1-based index?
  if (/^[0-9]+$/.test(t)) {
    const idx = parseInt(t, 10);
    const byPos = allSheets[idx - 1];
    if (byPos) return byPos;
  }
  // by name
  const byName = workbook.getWorksheet(t);
  if (byName) return byName;
  return null;
}

let selected: any[];
if (sheetParam.trim() === "") {
  selected = [allSheets[0]];
} else {
  selected = [];
  const seen = new Set();
  for (const token of sheetParam.split(",")) {
    const ws = resolveSheet(token);
    if (!ws) throw new Error(\`Sheet not found: "\${token.trim()}". Available: \${allSheets.map((s: any) => s.name).join(", ")}\`);
    if (!seen.has(ws.name)) { seen.add(ws.name); selected.push(ws); }
  }
}

// --- Row extraction (ragged rows padded to max width) ---
function extractRows(ws: any): any[][] {
  const rows: any[][] = [];
  let maxWidth = 0;
  ws.eachRow({ includeEmpty: true }, (row: any) => {
    const cells: any[] = [];
    row.eachCell({ includeEmpty: true }, (cell: any) => {
      cells.push(cellToScalar(cell));
    });
    if (cells.length > maxWidth) maxWidth = cells.length;
    rows.push(cells);
  });
  for (const r of rows) {
    while (r.length < maxWidth) r.push(null);
  }
  return rows;
}

// --- Output ---
if (format === "json") {
  const out = selected.map((ws: any) => ({ sheet: ws.name, rows: extractRows(ws) }));
  log.info("Read xlsx (json)", { path: resolvedPath, bytes: stat.size, sheets: out.length });
  return JSON.stringify(out.length === 1 ? out[0] : out, null, 2);
}

const parts: string[] = [];
for (const ws of selected) {
  const rows = extractRows(ws);
  parts.push(\`## \${ws.name}\`);
  if (rows.length === 0) {
    parts.push("_(empty sheet)_");
    continue;
  }
  const width = rows[0].length;
  const header = rows[0].map((c: any) => escapeGfm(scalarToCellString(c)));
  const sep = header.map(() => "---");
  const body = rows.slice(1).map((r: any[]) => r.map((c: any) => escapeGfm(scalarToCellString(c))));
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + sep.join(" | ") + " |",
    ...body.map((r: string[]) => "| " + r.join(" | ") + " |"),
  ];
  void width;
  parts.push(lines.join("\\n"));
}

log.info("Read xlsx (markdown)", { path: resolvedPath, bytes: stat.size, sheets: selected.length });
return parts.join("\\n\\n");`,
);
