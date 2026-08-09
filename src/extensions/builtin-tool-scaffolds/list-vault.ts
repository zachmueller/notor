import { scaffold } from "./_scaffold-helper";

export const LIST_VAULT = scaffold(
	"list_vault",
	"List the folder and note structure of the vault or a subdirectory.",
	"read",
	`params:
  path:
    type: string
    description: "Directory to list, relative to vault root."
    default: ""
    path_namespace: vault
  recursive:
    type: boolean
    description: "Whether to list contents recursively."
    default: false
  limit:
    type: number
    description: "Maximum number of items to return."
    default: 50
  offset:
    type: number
    description: "Number of items to skip for pagination."
    default: 0
  sort_by:
    type: string
    description: "Sort order: 'last_modified' or 'alphabetical'."
    enum:
      - last_modified
      - alphabetical
    default: "last_modified"
  modified_after:
    type: string
    description: "Only include files modified after this time. Accepts ISO 8601 (e.g. '2026-05-01T00:00:00Z') or relative duration (e.g. '7d', '24h', '2h30m')."
    default: ""
  modified_before:
    type: string
    description: "Only include files modified before this time. Accepts ISO 8601 or relative duration (e.g. '30d', '12h')."
    default: ""`,
	`const log = utils.logger("list_vault");

const listPath = ((params.path as string) ?? "").trim();
const recursive = (params.recursive as boolean) ?? false;
const limit = Math.max(1, Math.min(500, Math.floor((params.limit as number) ?? 50)));
const offset = Math.max(0, Math.floor((params.offset as number) ?? 0));
const sortBy = ((params.sort_by as string) ?? "last_modified") as "last_modified" | "alphabetical";
const modifiedAfterRaw = ((params.modified_after as string) ?? "").trim();
const modifiedBeforeRaw = ((params.modified_before as string) ?? "").trim();

function parseTimeBound(value: string, now: number): number | null {
  if (!value) return null;
  const durationMatch = value.match(/^(\\d+d)?(\\d+h)?(\\d+m)?$/i);
  if (durationMatch && value.length > 0 && (durationMatch[1] || durationMatch[2] || durationMatch[3])) {
    const days = parseInt(durationMatch[1] ?? "0", 10) || 0;
    const hours = parseInt(durationMatch[2] ?? "0", 10) || 0;
    const minutes = parseInt(durationMatch[3] ?? "0", 10) || 0;
    const totalMs = ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
    if (totalMs <= 0) return null;
    return now - totalMs;
  }
  const parsed = Date.parse(value);
  if (!isNaN(parsed)) return parsed;
  throw new Error(\`Invalid time filter value: "\${value}". Expected ISO 8601 (e.g. '2026-05-01T00:00:00Z') or relative duration (e.g. '7d', '24h', '2h30m').\`);
}

const now = Date.now();
const modifiedAfterMs = parseTimeBound(modifiedAfterRaw, now);
const modifiedBeforeMs = parseTimeBound(modifiedBeforeRaw, now);

log.debug("Listing vault", { listPath, recursive, limit, offset, sortBy, modifiedAfter: modifiedAfterRaw || undefined, modifiedBefore: modifiedBeforeRaw || undefined });

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "tif", "ico", "avif",
]);

type ItemType = "note" | "folder" | "image" | "attachment";

function classifyFile(file: any): ItemType {
  const ext = file.extension.toLowerCase();
  if (ext === "md") return "note";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "attachment";
}

function toListItem(abstractFile: any): any {
  if (abstractFile instanceof obsidian.TFolder) {
    return { name: abstractFile.name, path: abstractFile.path, type: "folder" };
  }
  return {
    name: abstractFile.name,
    path: abstractFile.path,
    type: classifyFile(abstractFile),
    size: abstractFile.stat.size,
    modified: new Date(abstractFile.stat.mtime).toISOString(),
  };
}

function getAllFolders(): any[] {
  const folders: any[] = [];
  const walk = (folder: any) => {
    for (const child of folder.children) {
      if (child instanceof obsidian.TFolder) {
        folders.push(child);
        walk(child);
      }
    }
  };
  walk(app.vault.getRoot());
  return folders;
}

// Count of entries withheld by vault-read path restrictions, reported in the
// result so the model never concludes the hidden entries simply don't exist.
let hiddenByPathRestrictions = 0;

function collectItems(targetPath: string, isRecursive: boolean): any[] {
  const items: any[] = [];

  if (!isRecursive) {
    const folder = targetPath
      ? app.vault.getAbstractFileByPath(targetPath)
      : app.vault.getRoot();
    if (!folder || !(folder instanceof obsidian.TFolder)) return [];
    for (const child of (folder as any).children) {
      if (child instanceof obsidian.TFile || child instanceof obsidian.TFolder) {
        items.push(toListItem(child));
      }
    }
  } else {
    const normalizedTarget = targetPath
      ? (targetPath.endsWith("/") ? targetPath : targetPath + "/")
      : "";
    for (const folder of getAllFolders()) {
      if (folder.path === "/" || folder.path === "") continue;
      if (normalizedTarget === "" || folder.path.startsWith(normalizedTarget) || folder.path === targetPath) {
        items.push(toListItem(folder));
      }
    }
    for (const file of app.vault.getFiles()) {
      if (normalizedTarget === "" || file.path.startsWith(normalizedTarget) || file.path === targetPath) {
        items.push(toListItem(file));
      }
    }
  }

  if (!utils.pathFilter) return items;
  const visible = items.filter((item: any) => utils.pathFilter(item.path));
  hiddenByPathRestrictions += items.length - visible.length;
  return visible;
}

// Collect, filter, sort, paginate
const allItems = collectItems(listPath, recursive);

const filteredItems = (modifiedAfterMs !== null || modifiedBeforeMs !== null)
  ? allItems.filter((item: any) => {
      if (!item.modified) return true;
      const mtime = new Date(item.modified).getTime();
      if (modifiedAfterMs !== null && mtime < modifiedAfterMs) return false;
      if (modifiedBeforeMs !== null && mtime > modifiedBeforeMs) return false;
      return true;
    })
  : allItems;

const sorted = [...filteredItems].sort((a: any, b: any) => {
  if (sortBy === "alphabetical") {
    if (a.type === "folder" && b.type !== "folder") return -1;
    if (a.type !== "folder" && b.type === "folder") return 1;
    return a.path.localeCompare(b.path);
  }
  // last_modified: newest first, folders (no modified) sort to end
  const aTime = a.modified ? new Date(a.modified).getTime() : 0;
  const bTime = b.modified ? new Date(b.modified).getTime() : 0;
  return bTime - aTime;
});

const totalCount = sorted.length;
const paginated = sorted.slice(offset, offset + limit);

log.debug("List complete", { path: listPath, totalCount, returned: paginated.length });

const result: any = { path: listPath || "/", total_count: totalCount, items: paginated };
if (hiddenByPathRestrictions > 0) {
  result.notice = hiddenByPathRestrictions + " entries hidden by path restrictions";
}
return result;`,
);
