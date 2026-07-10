import { scaffold } from "./_scaffold-helper";

export const LIST_XLSX_SHEETS = scaffold(
	"list_xlsx_sheets",
	"List the worksheet names in an .xlsx file, with row and column counts.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the .xlsx file. Vault-relative or absolute."
    path_namespace: filesystem
  format:
    type: string
    description: "Output format: 'markdown' (default) or 'json'."
    enum:
      - markdown
      - json
    default: "markdown"`,
	`const log = utils.logger("list_xlsx_sheets");

const filePath = params.path as string;
const format = (params.format as string) === "json" ? "json" : "markdown";

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("list_xlsx_sheets is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".xlsx") {
  throw new Error("list_xlsx_sheets only supports .xlsx files.");
}

let stat: any;
try {
  stat = await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

const ExcelJS = (await libs.exceljs()).default;
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(resolvedPath);

const sheets: Array<{ name: string; rows: number; columns: number }> = [];
workbook.eachSheet((ws: any) => {
  sheets.push({ name: ws.name, rows: ws.rowCount, columns: ws.columnCount });
});

log.info("Listed xlsx sheets", { path: resolvedPath, bytes: stat.size, sheets: sheets.length });

if (format === "json") {
  return JSON.stringify({ path: resolvedPath, sheets }, null, 2);
}

if (sheets.length === 0) {
  return "The workbook contains no worksheets.";
}

const lines = ["| Sheet | Rows | Columns |", "| --- | --- | --- |"];
for (const s of sheets) {
  const name = s.name.replace(/\\|/g, "\\\\|").replace(/\\r?\\n/g, " ");
  lines.push(\`| \${name} | \${s.rows} | \${s.columns} |\`);
}
return lines.join("\\n");`,
);
