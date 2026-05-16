/**
 * Built-in tool scaffold definitions for the Extensions settings section.
 *
 * Each scaffold provides a complete `.md` file template that can be written
 * to `notor/tools/{name}.md` so the user can customize the built-in tool.
 * The vault file overrides the built-in implementation on next reload.
 *
 * Follows the same pattern as `src/sub-agents/builtin-profiles.ts`.
 */

import type { SettingsFieldSchema } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Definition of a built-in tool scaffold (code-side constant). */
export interface BuiltinToolScaffold {
	/** Tool name (matches the vault filename without `.md`). */
	name: string;
	/** Short description for the settings UI. */
	description: string;
	/** Tool mode. */
	mode: "read" | "write";
	/**
	 * Full content of the `.md` scaffold file including frontmatter,
	 * YAML params fence, and TS code fence.
	 */
	scaffoldContent: string;
	/** Feature group for gating (e.g. `"memory"` → gated by `memory_enabled`). */
	featureGroup?: string;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function scaffold(
	name: string,
	description: string,
	mode: "read" | "write",
	yamlFenceContent: string,
	code = '// Built-in tool override. Customize the code below.\n// The built-in implementation runs when this file doesn\'t exist.\nreturn "Not yet customized — remove this line and add your implementation.";',
	featureGroup?: string,
): BuiltinToolScaffold {
	const trimmedYaml = yamlFenceContent.trimEnd();
	const featureGroupLine = featureGroup ? `\nnotor-feature-group: ${featureGroup}` : "";
	return {
		name,
		description,
		mode,
		featureGroup,
		scaffoldContent:
`---
notor-type: tool
notor-tool-name: ${name}
notor-description: "${description}"
notor-mode: ${mode}${featureGroupLine}
---

Customizable override for the built-in \`${name}\` tool. Edit the code below and reload extensions to apply changes.

\`\`\`yaml
${trimmedYaml}
\`\`\`

\`\`\`ts
${code}
\`\`\`
`,
	};
}

// ---------------------------------------------------------------------------
// Scaffold definitions
// ---------------------------------------------------------------------------

const READ_NOTE = scaffold(
	"read_note",
	"Read the contents of a note in the vault.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root. The '.md' extension is optional."
    path_namespace: vault
    path_resolve_as: note
  include_frontmatter:
    type: boolean
    description: "Whether to include YAML frontmatter in the returned content."
    default: false`,
	`const log = utils.logger("read_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Reading note", { path: params.path, includeFrontmatter: params.include_frontmatter });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

// Only allow markdown files
if (file.extension !== "md") {
  throw new Error(\`Path is not a Markdown note: \${params.path}\`);
}

// Use vault.read (not cachedRead) since we'll track for write operations
const fullContent = await app.vault.read(file);

let returnContent: string;

if (params.include_frontmatter) {
  returnContent = fullContent;
} else {
  const fmInfo = obsidian.getFrontMatterInfo(fullContent);
  if (fmInfo.exists) {
    // Strip frontmatter — trim the leading newline after the closing ---
    returnContent = fullContent.slice(fmInfo.contentStart).replace(/^\\n/, "");
  } else {
    returnContent = fullContent;
  }
}

// Record full content (not stripped) so write tools can compare against actual file state.
// Use file.path (canonical) so stale checks work regardless of input spelling.
utils.staleTracker.recordRead(file.path, fullContent);

// Open the note in the editor if configured
await utils.noteOpener.openNote(file.path);

log.debug("Read note successfully", { path: params.path, contentLength: returnContent.length });

return returnContent;`,
);

const SEARCH_VAULT = scaffold(
	"search_vault",
	"Search across notes in the vault using regex or text patterns.",
	"read",
	`params:
  query:
    type: string
    description: "Regex pattern or text string to search for"
  path:
    type: string
    description: "Directory to search within, relative to vault root."
    default: ""
    path_namespace: vault
  context_lines:
    type: number
    description: "Number of surrounding lines to include with each match."
    default: 3
  file_pattern:
    type: string
    description: "Glob pattern to filter which files to search."
    default: "*.md"
  sort_by:
    type: string
    description: "Sort order for results: 'match_count', 'backlinks', or 'modified'."
    enum:
      - match_count
      - backlinks
      - modified
    default: "match_count"
  modified_after:
    type: string
    description: "Only include files modified after this time. Accepts ISO 8601 (e.g. '2026-05-01T00:00:00Z') or relative duration (e.g. '7d', '24h', '2h30m')."
    default: ""
  modified_before:
    type: string
    description: "Only include files modified before this time. Accepts ISO 8601 or relative duration (e.g. '30d', '12h')."
    default: ""
  limit:
    type: number
    description: "Maximum number of files to return."
    default: 20
  offset:
    type: number
    description: "Number of files to skip for pagination."
    default: 0`,
	`const log = utils.logger("search_vault");
const MAX_MATCHES_PER_FILE = 10;

const query = params.query as string;
const searchPath = ((params.path as string) ?? "").trim();
const contextLines = Math.max(0, Math.min(10, Math.floor((params.context_lines as number) ?? 3)));
const filePattern = ((params.file_pattern as string) ?? "*.md").trim();
const sortBy = ((params.sort_by as string) ?? "match_count") as "match_count" | "backlinks" | "modified";
const modifiedAfterRaw = ((params.modified_after as string) ?? "").trim();
const modifiedBeforeRaw = ((params.modified_before as string) ?? "").trim();
const limit = Math.max(1, Math.min(200, Math.floor((params.limit as number) ?? 20)));
const offset = Math.max(0, Math.floor((params.offset as number) ?? 0));

if (!query || typeof query !== "string") {
  throw new Error("Missing required parameter: query");
}

// Compile regex — treat as literal string if not valid regex
let regex: RegExp;
try {
  regex = new RegExp(query, "gm");
} catch (e: any) {
  throw new Error(\`Invalid search pattern: \${e instanceof Error ? e.message : String(e)}\`);
}

// --- Helpers ---

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

log.debug("Searching vault", { query, searchPath, contextLines, filePattern, modifiedAfter: modifiedAfterRaw || undefined, modifiedBefore: modifiedBeforeRaw || undefined });

function matchesGlob(filename: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^\${}()|[\\]\\\\]/g, "\\\\$&")
    .replace(/\\*/g, ".*");
  try {
    return new RegExp(\`^\${regexStr}$\`, "i").test(filename);
  } catch {
    return filename === pattern;
  }
}

function getCandidateFiles(sp: string, fp: string): any[] {
  const allFiles = app.vault.getFiles();
  return allFiles.filter((file: any) => {
    if (sp) {
      const normalizedPath = sp.endsWith("/") ? sp : sp + "/";
      if (!file.path.startsWith(normalizedPath) && file.path !== sp) return false;
    }
    if (fp && fp !== "*") {
      if (!matchesGlob(file.name, fp)) return false;
    }
    if (modifiedAfterMs !== null && file.stat.mtime < modifiedAfterMs) return false;
    if (modifiedBeforeMs !== null && file.stat.mtime > modifiedBeforeMs) return false;
    return true;
  });
}

function getBacklinkCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
    for (const targetPath of Object.keys(links as Record<string, number>)) {
      if (targetPath !== sourcePath) {
        counts.set(targetPath, (counts.get(targetPath) ?? 0) + 1);
      }
    }
  }
  return counts;
}

function searchFile(content: string, re: RegExp, ctxLines: number): any[] {
  const lines = content.split("\\n");
  const matches: any[] = [];
  const matchedLineNumbers = new Set<number>();

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex] ?? "";
    re.lastIndex = 0;
    if (re.test(line)) {
      if (matchedLineNumbers.has(lineIndex)) continue;
      matchedLineNumbers.add(lineIndex);

      const contextStart = Math.max(0, lineIndex - ctxLines);
      const contextEnd = Math.min(lines.length - 1, lineIndex + ctxLines);
      const contextParts: string[] = [];
      for (let ci = contextStart; ci <= contextEnd; ci++) {
        const prefix = ci === lineIndex ? ">" : " ";
        contextParts.push(\`\${prefix} \${lines[ci] ?? ""}\`);
      }

      matches.push({
        line: lineIndex + 1,
        match: line.trim(),
        context: contextParts.join("\\n"),
      });
    }
  }
  return matches;
}

function sortFileResults(results: any[], sb: string): any[] {
  return [...results].sort((a: any, b: any) => {
    switch (sb) {
      case "backlinks": return b.backlink_count - a.backlink_count;
      case "modified": return new Date(b.modified).getTime() - new Date(a.modified).getTime();
      case "match_count":
      default: return b.total_match_count - a.total_match_count;
    }
  });
}

// --- Main search ---

const candidates = getCandidateFiles(searchPath, filePattern);
const fileResults: any[] = [];
let totalMatches = 0;
const backlinkCounts = getBacklinkCounts();

for (const file of candidates) {
  try {
    const content = await app.vault.cachedRead(file);
    const matches = searchFile(content, regex, contextLines);

    if (matches.length > 0) {
      const totalMatchCount = matches.length;
      const cappedMatches = matches.slice(0, MAX_MATCHES_PER_FILE);
      fileResults.push({
        path: file.path,
        matches: cappedMatches,
        match_count: cappedMatches.length,
        total_match_count: totalMatchCount,
        backlink_count: backlinkCounts.get(file.path) ?? 0,
        modified: new Date(file.stat.mtime).toISOString(),
      });
      totalMatches += totalMatchCount;
    }
  } catch {
    // Skip unreadable files
  }

  regex.lastIndex = 0;
}

const sortedResults = sortFileResults(fileResults, sortBy);
const totalFiles = sortedResults.length;
const paginatedResults = sortedResults.slice(offset, offset + limit);

log.debug("Search complete", {
  query,
  totalMatches,
  filesSearched: candidates.length,
  filesWithMatches: totalFiles,
  returned: paginatedResults.length,
});

return {
  total_matches: totalMatches,
  total_files: totalFiles,
  files: paginatedResults,
};`,
);

const LIST_VAULT = scaffold(
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

  return items;
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

return { path: listPath || "/", total_count: totalCount, items: paginated };`,
);

const READ_FRONTMATTER = scaffold(
	"read_frontmatter",
	"Read the parsed YAML frontmatter of a note as structured key-value data.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note`,
	`const log = utils.logger("read_frontmatter");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Reading frontmatter", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

const cache = app.metadataCache.getFileCache(file);
if (!cache?.frontmatter) {
  log.debug("No frontmatter found", { path: params.path });
  return {};
}

const { position: _, ...frontmatter } = cache.frontmatter;
log.info("Read frontmatter", { path: params.path, keyCount: Object.keys(frontmatter).length });
return frontmatter;`,
);

const GET_BACKLINKS = scaffold(
	"get_backlinks",
	"Returns all notes in the vault that link TO the specified note.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note`,
	`const log = utils.logger("get_backlinks");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Getting backlinks", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

// Reverse-lookup: find all source files whose resolvedLinks include the target.
// Self-links are filtered out.
const targetPath = file.path;
const backlinks: string[] = [];
for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
  if (sourcePath !== targetPath && targetPath in links) {
    backlinks.push(sourcePath);
  }
}

log.debug("Got backlinks", { path: file.path, count: backlinks.length });

return backlinks.length > 0 ? backlinks.join("\\n") : "(none)";`,
);

const GET_OUTLINKS = scaffold(
	"get_outlinks",
	"Returns all notes that the specified note links TO.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note`,
	`const log = utils.logger("get_outlinks");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Getting outlinks", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

const resolvedMap = app.metadataCache.resolvedLinks[file.path] ?? {};
const unresolvedMap = app.metadataCache.unresolvedLinks[file.path] ?? {};

// Filter out self-links
const resolvedPaths = Object.keys(resolvedMap).filter((p) => p !== file.path);
const unresolvedLinkNames = Object.keys(unresolvedMap);

log.debug("Got outlinks", {
  path: file.path,
  resolved: resolvedPaths.length,
  unresolved: unresolvedLinkNames.length,
});

const resolvedSection = resolvedPaths.length > 0 ? resolvedPaths.join("\\n") : "(none)";
const unresolvedSection = unresolvedLinkNames.length > 0 ? unresolvedLinkNames.join("\\n") : "(none)";
return \`Resolved:\\n\${resolvedSection}\\n\\nUnresolved:\\n\${unresolvedSection}\`;`,
);

const WRITE_NOTE = scaffold(
	"write_note",
	"Create a new note or overwrite an existing note's entire content.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
  content:
    type: string
    description: "Complete content to write to the note."`,
	`const log = utils.logger("write_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}
if (params.content === undefined || params.content === null || typeof params.content !== "string") {
  throw new Error("Missing required parameter: content");
}

log.debug("Writing note", { path: params.path, contentLength: (params.content as string).length });

const existingFile = utils.resolveNote(params.path);

if (!existingFile) {
  // ---- New file: create with intermediate directories ----
  const createPath = (params.path as string).endsWith(".md") ? params.path as string : params.path + ".md";
  await utils.ensureDirectoryExists(createPath);
  await app.vault.create(createPath, params.content as string);

  log.info("Created new note", { path: createPath, chars: (params.content as string).length });
  await utils.noteOpener.openNote(createPath);

  return \`Note created: \${createPath} (\${(params.content as string).length} characters)\`;
}

// ---- Existing file: stale check → checkpoint → frontmatter-safe write ----
const currentContent = await app.vault.read(existingFile);

const staleResult = utils.staleTracker.check(existingFile.path, currentContent);
if (staleResult.isStale) {
  throw new Error(
    "Note content has changed since last read. " +
    "Re-read the note with read_note before retrying."
  );
}

// Checkpoint before overwriting (non-fatal)
try {
  await utils.checkpointManager.createCheckpoint(existingFile.path, "write_note", "");
} catch { /* non-fatal */ }

// Frontmatter preservation: if existing note has frontmatter but new content doesn't,
// prepend the existing frontmatter block.
const existingFm = obsidian.getFrontMatterInfo(currentContent);
const newFm = obsidian.getFrontMatterInfo(params.content as string);

let finalContent: string;

if (existingFm.exists && !newFm.exists) {
  const frontmatterBlock = currentContent.slice(0, existingFm.contentStart);
  finalContent = frontmatterBlock + params.content;
  log.debug("Preserved existing frontmatter", { path: params.path });
} else {
  finalContent = params.content as string;
}

await app.vault.process(existingFile, () => finalContent);

// Update stale tracker so subsequent writes don't falsely detect staleness
utils.staleTracker.updateAfterWrite(existingFile.path, finalContent);

log.info("Modified existing note", { path: existingFile.path, chars: finalContent.length });
await utils.noteOpener.openNote(existingFile.path);

return \`Note updated: \${existingFile.path} (\${finalContent.length} characters)\`;`,
);

const REPLACE_IN_NOTE = scaffold(
	"replace_in_note",
	"Make targeted edits within a note using SEARCH/REPLACE blocks.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
  changes:
    type: "object[]"
    description: "Array of search/replace blocks to apply in sequence. Each block replaces only the first occurrence of the search text."
    properties:
      search:
        type: string
        description: "Exact text to find in the note (character-for-character match including whitespace)."
      replace:
        type: string
        description: "Text to replace the matched search text with. Use empty string to delete the matched text."
    required_items:
      - search
      - replace`,
	`const log = utils.logger("replace_in_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}
if (!Array.isArray(params.changes) || params.changes.length === 0) {
  throw new Error("Missing or empty required parameter: changes");
}

// Validate change blocks
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (typeof block?.search !== "string" || typeof block?.replace !== "string") {
    throw new Error(\`Change block \${i + 1} is missing required 'search' or 'replace' property\`);
  }
  if (block.search === "") {
    throw new Error(\`Change block \${i + 1} has an empty search string. Search text must be non-empty.\`);
  }
}

log.debug("Replacing in note", { path: params.path, changeCount: params.changes.length });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

// Stale content check
const currentContent = await app.vault.read(file);

const staleResult = utils.staleTracker.check(file.path, currentContent);
if (staleResult.isStale) {
  throw new Error(
    "Note content has changed since last read. " +
    "Re-read the note with read_note before retrying."
  );
}

// Checkpoint before write (non-fatal)
try {
  await utils.checkpointManager.createCheckpoint(file.path, "replace_in_note", "");
} catch { /* non-fatal */ }

// Apply changes atomically via vault.process —
// if any search block doesn't match, the callback throws and vault.process writes nothing.
let failedBlockIndex = -1;
let failedSearchText = "";

try {
  await app.vault.process(file, (data: string) => {
    let modified = data;
    for (let i = 0; i < params.changes.length; i++) {
      const block = params.changes[i];
      if (!block) continue;
      const match = utils.normalizedIndexOf(modified, block.search);
      if (!match) {
        failedBlockIndex = i + 1;
        failedSearchText = block.search;
        throw new Error(\`Search block \${i + 1} did not match\`);
      }
      modified =
        modified.slice(0, match.index) +
        block.replace +
        modified.slice(match.index + match.length);
    }
    return modified;
  });
} catch (e: any) {
  if (failedBlockIndex !== -1) {
    const preview = failedSearchText.length > 80
      ? failedSearchText.slice(0, 80) + "..."
      : failedSearchText;
    throw new Error(
      \`Search block \${failedBlockIndex} did not match any text in \${params.path}. \` +
      \`No changes were applied. The search text was: "\${preview}"\`
    );
  }
  throw e;
}

// Update stale tracker with new content
try {
  const newContent = await app.vault.read(file);
  utils.staleTracker.updateAfterWrite(file.path, newContent);
} catch {
  utils.staleTracker.invalidate(file.path);
}

log.info("Applied replacements", { path: params.path, count: params.changes.length });

// Open in editor
await utils.noteOpener.openNote(file.path);

return \`Applied \${params.changes.length} replacement\${params.changes.length > 1 ? "s" : ""} to \${params.path}\`;`,
);

const UPDATE_FRONTMATTER = scaffold(
	"update_frontmatter",
	"Add, modify, or remove specific frontmatter properties.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
  set:
    type: object
    description: "Key-value pairs to add or update in the frontmatter."
    default: null
  remove:
    type: "string[]"
    description: "List of frontmatter keys to remove."
    default: null`,
	`const log = utils.logger("update_frontmatter");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

const set = params.set as Record<string, unknown> | undefined;
const remove = params.remove as string[] | undefined;

if (!set && !remove) {
  throw new Error("At least one of 'set' or 'remove' must be provided");
}

log.debug("Updating frontmatter", {
  path: params.path,
  setKeys: set ? Object.keys(set) : [],
  removeKeys: remove ?? [],
});

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

// Checkpoint before modifying (non-fatal)
try {
  await utils.checkpointManager.createCheckpoint(file.path, "update_frontmatter", "");
} catch { /* non-fatal */ }

await app.fileManager.processFrontMatter(file, (frontmatter: any) => {
  if (set) {
    for (const [key, value] of Object.entries(set)) {
      frontmatter[key] = value;
    }
  }
  if (remove) {
    for (const key of remove) {
      delete frontmatter[key];
    }
  }
});

const setCount = set ? Object.keys(set).length : 0;
const removeCount = remove ? remove.length : 0;
const parts: string[] = [];
if (setCount > 0) parts.push(\`set \${setCount} propert\${setCount === 1 ? "y" : "ies"}\`);
if (removeCount > 0) parts.push(\`removed \${removeCount} propert\${removeCount === 1 ? "y" : "ies"}\`);

log.info("Updated frontmatter", { path: params.path, setCount, removeCount });
return \`Updated frontmatter on \${params.path}: \${parts.join(", ")}\`;`,
);

const MANAGE_TAGS = scaffold(
	"manage_tags",
	"Add or remove tags on a note via the frontmatter 'tags' property.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
  add:
    type: "string[]"
    description: "Tags to add to the note."
    default: null
  remove:
    type: "string[]"
    description: "Tags to remove from the note."
    default: null`,
	`const log = utils.logger("manage_tags");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

const add = params.add as string[] | undefined;
const remove = params.remove as string[] | undefined;

if ((!add || add.length === 0) && (!remove || remove.length === 0)) {
  throw new Error("At least one of 'add' or 'remove' must be provided with at least one tag");
}

log.debug("Managing tags", { path: params.path, add: add ?? [], remove: remove ?? [] });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

// Create checkpoint before modifying (non-fatal)
try {
  await utils.checkpointManager.createCheckpoint(file.path, "manage_tags", "");
} catch { /* non-fatal */ }

// -- Helpers --
function normaliseTag(tag: string): string {
  return tag.trim().replace(/^#/, "");
}

function normaliseTags(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === "string") return [normaliseTag(raw)];
  if (Array.isArray(raw)) {
    return raw
      .filter((t: any) => t != null && t !== "")
      .map((t: any) => normaliseTag(String(t)));
  }
  return [];
}

const actualAdded: string[] = [];
const actualRemoved: string[] = [];

await app.fileManager.processFrontMatter(file, (frontmatter: any) => {
  let tags: string[] = normaliseTags(frontmatter["tags"]);

  if (add && add.length > 0) {
    for (const tag of add) {
      const normalised = normaliseTag(tag);
      if (!tags.includes(normalised)) {
        tags.push(normalised);
        actualAdded.push(normalised);
      }
    }
  }

  if (remove && remove.length > 0) {
    for (const tag of remove) {
      const normalised = normaliseTag(tag);
      const idx = tags.indexOf(normalised);
      if (idx !== -1) {
        tags.splice(idx, 1);
        actualRemoved.push(normalised);
      }
    }
  }

  if (tags.length > 0) {
    frontmatter["tags"] = tags;
  } else {
    delete frontmatter["tags"];
  }
});

const parts: string[] = [];
if (actualAdded.length > 0) {
  parts.push(\`added [\${actualAdded.map((t: string) => \`"\${t}"\`).join(", ")}]\`);
}
if (actualRemoved.length > 0) {
  parts.push(\`removed [\${actualRemoved.map((t: string) => \`"\${t}"\`).join(", ")}]\`);
}

const summary = parts.length > 0
  ? \`Tags updated on \${params.path}: \${parts.join(", ")}\`
  : \`Tags unchanged on \${params.path} (requested tags already in desired state)\`;

log.info("Tags managed", { path: params.path, added: actualAdded, removed: actualRemoved });

return summary;`,
);

const MOVE_NOTE = scaffold(
	"move_note",
	"Move and/or rename a note within the vault.",
	"write",
	`params:
  path:
    type: string
    description: "Current path of the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
  new_path:
    type: string
    description: "New path for the note relative to vault root."
    path_namespace: vault
  add_alias:
    type: boolean
    description: "If true, append the old name to the note's frontmatter aliases."
    default: false`,
	`const log = utils.logger("move_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}
if (!params.new_path || typeof params.new_path !== "string") {
  throw new Error("Missing required parameter: new_path");
}

log.debug("Moving note", { path: params.path, newPath: params.new_path, addAlias: params.add_alias });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

if (file.extension !== "md") {
  throw new Error(\`Path is not a Markdown note: \${file.path}\`);
}

const normalizedNewPath = (params.new_path as string).endsWith(".md")
  ? params.new_path as string
  : params.new_path + ".md";

if (file.path === normalizedNewPath) {
  throw new Error("Source and destination are the same path");
}

const existing = app.vault.getAbstractFileByPath(normalizedNewPath);
if (existing) {
  throw new Error(\`A note already exists at: \${normalizedNewPath}\`);
}

// Checkpoint before destructive operation (non-fatal)
try {
  await utils.checkpointManager.createCheckpoint(file.path, "move_note", "");
} catch { /* non-fatal */ }

// Ensure destination directory exists
await utils.ensureDirectoryExists(normalizedNewPath);

// Store old basename before rename (TFile.basename is name without extension)
const oldBasename = file.basename;

// Perform the move/rename — updates all internal links
await app.fileManager.renameFile(file, normalizedNewPath);

// Add alias if requested and filename actually changed
const newBasename = normalizedNewPath.split("/").pop()!.replace(/\\.md$/, "");
if (params.add_alias && oldBasename !== newBasename) {
  // Helper: normalize aliases frontmatter value to string[]
  function normaliseAliases(raw: unknown): string[] {
    if (!raw) return [];
    if (typeof raw === "string") return [raw.trim()];
    if (Array.isArray(raw)) {
      return raw.filter((a: unknown) => a != null && a !== "").map((a: unknown) => String(a).trim());
    }
    return [];
  }

  await app.fileManager.processFrontMatter(file, (fm: any) => {
    const aliases = normaliseAliases(fm["aliases"]);
    if (!aliases.includes(oldBasename)) {
      aliases.push(oldBasename);
    }
    fm["aliases"] = aliases;
  });
}

log.info("Note moved", { from: params.path, to: normalizedNewPath });

return \`Note moved: \${params.path} → \${normalizedNewPath}\`;`,
);

const FETCH_WEBPAGE = scaffold(
	"fetch_webpage",
	"Fetch a webpage by URL and return its content converted to Markdown.",
	"read",
	`params:
  url:
    type: string
    description: "URL of the webpage to fetch."
settings:
  fetch_webpage_timeout:
    name: "Request Timeout"
    type: number
    description: "Timeout in seconds for HTTP requests."
    default: 15
    min: 1
    max: 120
  fetch_webpage_max_download_mb:
    name: "Max Download Size (MB)"
    type: number
    description: "Maximum response body size in megabytes."
    default: 5
    min: 1
    max: 50
  fetch_webpage_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters returned to the LLM. Longer content is truncated."
    default: 50000
    min: 1000
    max: 500000`,
	`const log = utils.logger("fetch_webpage");

const USER_AGENT = "Notor/1.0";

// --- Chromium net error hints ---
const CHROMIUM_NET_ERROR_HINTS: Record<string, string> = {
  ERR_NAME_NOT_RESOLVED: "DNS lookup failed — check the hostname or your network connection",
  ERR_CONNECTION_REFUSED: "Connection refused — the server may be down or blocking requests",
  ERR_CONNECTION_TIMED_OUT: "Connection timed out — the server took too long to respond",
  ERR_CONNECTION_RESET: "Connection reset by the server — it may have dropped the connection",
  ERR_INTERNET_DISCONNECTED: "No internet connection detected",
  ERR_SSL_PROTOCOL_ERROR: "SSL/TLS handshake failed — the site may have a certificate issue",
  ERR_CERT_AUTHORITY_INVALID: "SSL certificate not trusted — the certificate may be self-signed or expired",
  ERR_CERT_DATE_INVALID: "SSL certificate has expired or is not yet valid",
  ERR_BLOCKED_BY_CLIENT: "Request blocked by a browser extension or content policy",
  ERR_TOO_MANY_REDIRECTS: "Too many redirects — the URL may be in a redirect loop",
  ERR_INVALID_URL: "The URL is malformed or not supported by the network stack",
  ERR_NETWORK_CHANGED: "Network changed during the request — try again",
  ERR_ADDRESS_UNREACHABLE: "The server address is unreachable — it may be on a private or unavailable network",
  ERR_EMPTY_RESPONSE: "The server returned an empty response",
  ERR_FAILED: "Generic network failure — check your internet connection, proxy settings, or try again",
};

function getNetErrorHint(errorMessage: string): string | null {
  for (const [code, hint] of Object.entries(CHROMIUM_NET_ERROR_HINTS)) {
    if (errorMessage.includes(code)) return hint;
  }
  return null;
}

function initTurndown(): any {
  const td = new libs.Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.use(libs.turndownGfm.gfm);
  td.addRule("stripNav", {
    filter: ["nav", "footer", "aside"],
    replacement: () => "",
  });
  td.addRule("stripForms", {
    filter: ["form", "input", "select", "button"],
    replacement: () => "",
  });
  return td;
}

// --- Main logic ---

const url = params.url as string;

if (!url || typeof url !== "string") {
  throw new Error("Missing required parameter: url");
}

let parsedUrl: URL;
try {
  parsedUrl = new URL(url);
} catch {
  throw new Error(\`Invalid URL: \${url}\`);
}

if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
  throw new Error(\`Unsupported protocol: \${parsedUrl.protocol}. Only http:// and https:// URLs are accepted.\`);
}

// Domain denylist check
const denyCheck = utils.isDomainBlocked(url, shared.domain_denylist ?? []);
if (denyCheck.blocked) {
  log.info("Domain blocked by denylist", { url, pattern: denyCheck.pattern });
  throw new Error(\`Domain \${parsedUrl.hostname} is blocked by your denylist.\`);
}

const timeoutMs = (settings.fetch_webpage_timeout as number) * 1000;
const maxDownloadBytes = (settings.fetch_webpage_max_download_mb as number) * 1024 * 1024;
const maxOutputChars = settings.fetch_webpage_max_output_chars as number;

log.info("Fetching webpage", {
  url,
  timeout: \`\${settings.fetch_webpage_timeout}s\`,
  maxDownloadMb: settings.fetch_webpage_max_download_mb,
});

let body: string;
let mimeType: string;
try {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(\`Request timed out after \${Math.round(timeoutMs / 1000)} seconds.\`)),
      timeoutMs,
    ),
  );

  const response = await Promise.race([
    obsidian.requestUrl({
      url,
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      throw: false,
    }),
    timeoutPromise,
  ]);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(\`HTTP request failed with status \${response.status}.\`);
  }

  const bodyBytes = new TextEncoder().encode(response.text).length;
  if (bodyBytes > maxDownloadBytes) {
    throw new Error(\`Response body too large: download aborted at \${settings.fetch_webpage_max_download_mb} MB.\`);
  }

  const contentType = response.headers["content-type"] ?? "";
  mimeType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  body = response.text;
} catch (e: any) {
  const message = e instanceof Error ? e.message : String(e);

  // Diagnostic probe with native fetch
  let nativeFetchResult: string;
  try {
    const probe = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    nativeFetchResult = \`native fetch OK (status \${probe.status})\`;
  } catch (probeErr: any) {
    nativeFetchResult = \`native fetch also failed: \${probeErr instanceof Error ? probeErr.message : String(probeErr)}\`;
  }

  const hint = getNetErrorHint(message);
  const enhanced = hint
    ? \`Failed to fetch URL: \${message} — \${hint}\`
    : message;

  log.warn("Fetch failed", { url, error: message, nativeFetchResult });
  throw new Error(\`\${enhanced} [diagnostic: \${nativeFetchResult}]\`);
}

let content: string;
if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
  try {
    content = initTurndown().turndown(body);
  } catch {
    content = body;
  }
} else if (mimeType.startsWith("text/") || mimeType === "application/json") {
  content = body;
} else {
  throw new Error(\`Content type '\${mimeType}' is not supported. Only text/html, text/*, and application/json are supported.\`);
}

// Output character cap
const totalLength = content.length;
if (totalLength > maxOutputChars) {
  const truncated = content.substring(0, maxOutputChars);
  log.info("Output truncated", { url, totalLength, maxOutputChars });
  if (utils.tempOutputSpiller) {
    return await utils.tempOutputSpiller.spillToFile("fetch_webpage", content, truncated, maxOutputChars);
  }
  return truncated +
    \`\\n\\nNote: page was truncated at \${maxOutputChars.toLocaleString()} characters; total fetched length was \${totalLength.toLocaleString()} characters.\`;
}

log.info("Fetch complete", { url, contentType: mimeType, contentLength: content.length });
return content;`,
);

const WEB_SEARCH = scaffold(
	"web_search",
	"Search the web via DuckDuckGo and return results with titles, URLs, and snippets.",
	"read",
	`params:
  query:
    type: string
    description: "Search query string."
  num_results:
    type: number
    description: "Number of results to return. Maximum 10."
    default: 5
settings:
  web_search_timeout:
    name: "Request Timeout"
    type: number
    description: "Maximum time in seconds to wait for search results before aborting."
    default: 10
    min: 1
    max: 120
  web_search_default_num_results:
    name: "Default Number of Results"
    type: number
    description: "Number of search results returned when the LLM does not specify a count (1–10)."
    default: 5
    min: 1
    max: 10
  web_search_duckduckgo_delay_ms:
    name: "Throttle Delay (ms)"
    type: number
    description: "Minimum delay between DuckDuckGo requests to avoid rate-limiting."
    default: 1500
    min: 0
    max: 10000`,
	`const log = utils.logger("web_search");

const query = params.query as string;

if (!query || typeof query !== "string") {
  throw new Error("Missing required parameter: query");
}

const rawNum = typeof params.num_results === "number"
  ? params.num_results
  : (settings.web_search_default_num_results as number);
const numResults = Math.max(1, Math.min(10, Math.round(rawNum)));
const timeoutMs = (settings.web_search_timeout as number) * 1000;

log.info("Web search initiated", { query, numResults, timeoutMs });

// Delegate to multi-provider queue infrastructure
const searchResult = await utils.webSearch.search(query, numResults, timeoutMs, utils.abortSignal);

if (searchResult.error) {
  throw new Error(searchResult.error);
}

if (searchResult.failures.length > 0) {
  log.warn("Some providers failed before success", { failures: searchResult.failures });
}

log.debug("Search fulfilled", { provider: searchResult.provider, rawCount: searchResult.results.length });

// Filter out blocked domains
const denylist = shared.domain_denylist ?? [];
const results = searchResult.results.filter((r: any) => {
  const check = utils.isDomainBlocked(r.url, denylist);
  if (check.blocked) {
    log.debug("Filtered blocked domain", { url: r.url, pattern: check.pattern });
  }
  return !check.blocked;
});

if (results.length === 0) {
  return \`No results found for query: \${query}\`;
}

// Format output as numbered markdown list
const lines: string[] = [
  \`Web search results for "\${query}" (\${results.length} result\${results.length === 1 ? "" : "s"}):\`,
  "",
];

for (let i = 0; i < results.length; i++) {
  const r = results[i];
  lines.push(\`\${i + 1}. **[\${r.title}](\${r.url})**\`);
  if (r.snippet) lines.push(\`   \${r.snippet}\`);
  lines.push("");
}

const output = lines.join("\\n").trimEnd();
log.info("Web search completed", { query, resultCount: results.length, provider: searchResult.provider });
return output;`,
);

const EXECUTE_COMMAND = scaffold(
	"execute_command",
	"Execute a shell command on the user's system and return the output.",
	"write",
	`params:
  command:
    type: string
    description: "Shell command to execute."
  working_directory:
    type: string
    description: "Working directory for the command, relative to vault root or absolute."
    default: ""
    path_namespace: filesystem
settings:
  execute_command_allowed_paths:
    name: "Allowed Working Directories"
    type: string[]
    description: "Additional filesystem paths allowed as working directories. The vault root is always allowed."
    default: []
  execute_command_timeout:
    name: "Command Timeout (seconds)"
    type: number
    description: "Maximum execution time in seconds before the command is killed."
    default: 30
    min: 1
    max: 600
  execute_command_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters of command output returned. Longer output is truncated."
    default: 50000
    min: 1000
    max: 500000
  execute_command_allowed_command_patterns:
    name: "Auto-Approve Command Patterns"
    type: string[]
    description: "Glob patterns for commands to auto-approve (e.g., 'git *', 'ls', 'npm test'). Matched commands skip the approval prompt."
    default: []
  execute_command_blocked_command_patterns:
    name: "Never Auto-Approve Command Patterns"
    type: string[]
    description: "Glob patterns for commands that ALWAYS require approval, even when execute_command is fully auto-approved (e.g., 'rm *', 'sudo *')."
    default: []`,
	`const log = utils.logger("execute_command");

if (!params.command || typeof params.command !== "string") {
  throw new Error("Missing required parameter: command");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error(
    "execute_command is only available on desktop. " +
    "Shell execution is not supported on mobile."
  );
}

const workingDirectory = (params.working_directory as string) || "";

// Validate working directory against vault root and allowed paths
const cwdResult = utils.resolveAndValidatePath(
  workingDirectory,
  settings.execute_command_allowed_paths as string[],
);
if (!cwdResult.valid) {
  throw new Error(
    \`Working directory '\${workingDirectory}' is outside the allowed paths. \` +
    \`Allowed: vault root and configured paths.\`
  );
}

log.info("Executing command", {
  command: (params.command as string).substring(0, 200),
  cwd: cwdResult.resolvedPath,
  timeout: \`\${settings.execute_command_timeout}s\`,
});

try {
  const result = await utils.executeShellCommand(params.command as string, {
    cwd: cwdResult.resolvedPath,
    timeoutSeconds: settings.execute_command_timeout as number,
    maxOutputChars: settings.execute_command_max_output_chars as number,
    spiller: utils.tempOutputSpiller,
  });

  let output = result.stdout;

  if (result.truncated && result.spillFilePath && result.totalOutputChars) {
    output = utils.tempOutputSpiller!.formatSpilloverMessage(
      result.stdout,
      result.spillFilePath,
      result.totalOutputChars,
      settings.execute_command_max_output_chars as number,
    );
  } else if (result.truncated) {
    output +=
      \`\\n\\nNote: command output was truncated at \` +
      \`\${(settings.execute_command_max_output_chars as number).toLocaleString()} characters.\`;
  }

  if (result.timedOut) {
    const msg = \`Command timed out after \${settings.execute_command_timeout} seconds.\`;
    throw new Error(output ? \`\${msg} Partial output:\\n\${output}\` : msg);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      \`Command exited with code \${result.exitCode}\` +
      (output ? \`\\n\${output}\` : "")
    );
  }

  return output;
} catch (e: any) {
  // Re-throw errors already created above
  if (e instanceof Error && (
    e.message.includes("timed out") ||
    e.message.includes("exited with code")
  )) {
    throw e;
  }

  const message = e instanceof Error ? e.message : String(e);
  log.error("Command execution failed", {
    command: (params.command as string).substring(0, 200),
    error: message,
  });

  if (message.includes("Shell not found")) {
    throw new Error(\`\${message}. Check your shell configuration in Settings → Notor.\`);
  }

  throw new Error(\`Failed to execute command: \${message}\`);
}`,
);

const READ_FILE = scaffold(
	"read_file",
	"Read a text file, image, or PDF from the filesystem.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  encoding:
    type: string
    description: "File encoding."
    default: "utf-8"
  pages:
    type: string
    description: "Page range for PDF files (e.g. '1-5')."
settings:
  image_max_dimension:
    name: "Image Max Dimension"
    type: number
    description: "Maximum width or height in pixels. Images larger than this are resized proportionally."
    default: 2000
    min: 100
    max: 8000
  image_compression_quality:
    name: "Image Compression Quality"
    type: number
    description: "JPEG compression quality (1-100)."
    default: 80
    min: 1
    max: 100
  pdf_prefer_native:
    name: "Prefer Native PDF"
    type: boolean
    description: "Send PDFs as native document blocks when supported by the provider."
    default: true
  pdf_text_max_chars:
    name: "PDF Max Text Characters"
    type: number
    description: "Maximum characters to extract from PDF text content."
    default: 100000
    min: 1000
    max: 1000000
  pdf_native_max_size_mb:
    name: "PDF Native Max Size (MB)"
    type: number
    description: "Maximum PDF file size in MB for native document block processing."
    default: 10
    min: 1
    max: 100`,
	`const log = utils.logger("read_file");

const filePath = params.path as string;
const encoding = params.encoding as string | undefined;
const pages = params.pages as string | undefined;

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("read_file is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

// Read raw buffer
const buf = await libs.fs.promises.readFile(resolvedPath);

// Detect binary via null bytes in first 8 KB
if (buf.subarray(0, 8192).includes(0)) {
  const format = utils.detectMediaFormat(buf);

  if (format === "png" || format === "jpeg" || format === "gif" || format === "webp") {
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error(\`Image file is too large (\${(buf.length / (1024 * 1024)).toFixed(1)} MB). Maximum raw input size is 50 MB.\`);
    }

    try {
      const mediaType = \`image/\${format}\` as any;
      const block = await utils.processImage(buf, mediaType, {
        maxDimension: settings.image_max_dimension as number,
        compressionQuality: settings.image_compression_quality as number,
      });
      const filename = resolvedPath.split("/").pop() ?? resolvedPath;
      const w = block.type === "image" ? block.width : undefined;
      const h = block.type === "image" ? block.height : undefined;

      log.info("Read image file", { path: resolvedPath, format, width: w, height: h });

      return {
        result: \`Read image: \${filename} (\${w}x\${h}, image/\${format})\`,
        content_blocks: [block],
      };
    } catch (e: any) {
      throw new Error(\`Failed to process image: \${e instanceof Error ? e.message : String(e)}\`);
    }
  }

  if (format === "pdf") {
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error(\`PDF file is too large (\${(buf.length / (1024 * 1024)).toFixed(1)} MB). Maximum raw input size is 50 MB.\`);
    }

    try {
      const result = await utils.processPdf(buf, {
        pages,
        maxTextChars: settings.pdf_text_max_chars as number,
        preferNative: settings.pdf_prefer_native as boolean,
      });
      const filename = resolvedPath.split("/").pop() ?? resolvedPath;

      log.info("Read PDF file", { path: resolvedPath, summary: result.textSummary });

      return {
        result: \`Read PDF: \${filename} — \${result.textSummary}\`,
        content_blocks: result.contentBlocks,
      };
    } catch (e: any) {
      throw new Error(\`Failed to process PDF: \${e instanceof Error ? e.message : String(e)}\`);
    }
  }

  throw new Error(
    "read_file only supports text-based files, images (PNG, JPEG, GIF, WebP), and PDFs. For Word documents, use read_docx instead."
  );
}

const content = buf.toString((encoding as BufferEncoding) ?? "utf-8");
log.info("Read file", { path: resolvedPath, bytes: buf.length });
return content;`,
);

const READ_DOCX = scaffold(
	"read_docx",
	"Read a .docx file and return its content as Markdown.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute."
    path_namespace: filesystem`,
	`const log = utils.logger("read_docx");

const filePath = params.path as string;

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("read_docx is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".docx") {
  throw new Error("read_docx only supports .docx files.");
}

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

const buf = await libs.fs.promises.readFile(resolvedPath);

// Build image extraction handler
const extractedImages: Array<{ index: number; vaultPath: string | null; alt: string }> = [];
let imageIndex = 0;
let duplicatesSkipped = 0;

// Determine if the input path is vault-relative (for attachment folder resolution)
const vaultFile = app.vault.getFileByPath(filePath);
const sourcePath: string | undefined = vaultFile ? vaultFile.path : undefined;

const supportedImageTypes = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

const convertImage = libs.mammoth.images.imgElement(
  async (image: any) => {
    const idx = imageIndex++;
    const contentType = image.contentType;

    // Skip unsupported formats
    if (!supportedImageTypes.has(contentType)) {
      const formatName = contentType.replace("image/", "").toUpperCase();
      const alt = \`[Unsupported image format: \${formatName}]\`;
      extractedImages.push({ index: idx, vaultPath: null, alt });
      return { src: \`__notor_skip_\${idx}__\`, alt };
    }

    try {
      const imgBuffer = await image.readAsBuffer();
      const ext = (contentType.split("/")[1] ?? "bin").replace("jpeg", "jpg");
      const hash = libs.crypto.createHash("md5").update(imgBuffer).digest("hex");
      const filename = \`\${hash}.\${ext}\`;

      // Resolve target path via Obsidian's attachment folder logic
      const targetPath = await app.fileManager.getAvailablePathForAttachment(
        filename,
        sourcePath,
      );

      // Check if the file already exists at the resolved path
      const existing = app.vault.getFileByPath(targetPath);
      if (existing) {
        duplicatesSkipped++;
      } else {
        const arrayBuf = imgBuffer.buffer.slice(
          imgBuffer.byteOffset,
          imgBuffer.byteOffset + imgBuffer.byteLength,
        );
        await app.vault.createBinary(targetPath, arrayBuf);
      }

      extractedImages.push({ index: idx, vaultPath: targetPath, alt: filename });
      return { src: \`__notor_img_\${idx}__\`, alt: filename };
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("Image extraction failed", { index: idx, error: errMsg });
      extractedImages.push({ index: idx, vaultPath: null, alt: "[Image extraction failed]" });
      return { src: \`__notor_skip_\${idx}__\`, alt: "[Image extraction failed]" };
    }
  },
);

// Convert DOCX → HTML via mammoth (with image handler)
const { value: html } = await libs.mammoth.convertToHtml(
  { buffer: buf },
  { convertImage },
);

// Build a lookup from src marker → extracted image info
const imageMap = new Map<string, { vaultPath: string | null; alt: string }>();
for (const img of extractedImages) {
  imageMap.set(\`__notor_img_\${img.index}__\`, img);
  imageMap.set(\`__notor_skip_\${img.index}__\`, img);
}

// Convert HTML → Markdown via Turndown (local instance)
const td = new libs.Turndown({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
td.use(libs.turndownGfm.gfm);
td.addRule("replaceImages", {
  filter: ["img"],
  replacement: (_content: string, node: any) => {
    const src = node.getAttribute("src") ?? "";
    const alt = node.getAttribute("alt") ?? "";

    if (src.startsWith("__notor_img_")) {
      const info = imageMap.get(src);
      if (info?.vaultPath) {
        return \`![\${alt}](\${info.vaultPath})\`;
      }
    }

    if (src.startsWith("__notor_skip_")) {
      return alt || "[image]";
    }

    return "[image]";
  },
});

const markdown = td.turndown(html);

const extractedCount = extractedImages.filter((i: any) => i.vaultPath !== null).length;
const skippedCount = extractedImages.filter((i: any) => i.vaultPath === null).length;
if (duplicatesSkipped > 0) {
  new obsidian.Notice(\`Skipped \${duplicatesSkipped} duplicate image(s) — already in vault\`);
}
log.info("Read docx", {
  path: resolvedPath,
  bytes: buf.length,
  imagesExtracted: extractedCount,
  imagesSkipped: skippedCount,
  duplicatesSkipped,
});

return markdown;`,
);

const IMPORT_DOCX = scaffold(
	"import_docx",
	"Parse a .docx file and save its content as a Markdown note in the vault.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute."
    path_namespace: filesystem
  note_path:
    type: string
    description: "Vault-relative path for the output note (e.g. \\"folder/My Doc\\"). The .md extension is added automatically if omitted."
    path_namespace: vault`,
	`const log = utils.logger("import_docx");

const filePath = params.path as string;
const notePath = params.note_path as string;

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}
if (!notePath || typeof notePath !== "string" || notePath.trim() === "") {
  throw new Error("Missing required parameter: note_path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("import_docx is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".docx") {
  throw new Error("import_docx only supports .docx files.");
}

try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

const buf = await libs.fs.promises.readFile(resolvedPath);

const extractedImages: Array<{ index: number; vaultPath: string | null; alt: string }> = [];
let imageIndex = 0;
let duplicatesSkipped = 0;
const vaultFile = app.vault.getFileByPath(filePath);
const sourcePath: string | undefined = vaultFile ? vaultFile.path : undefined;
const supportedImageTypes = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

const convertImage = libs.mammoth.images.imgElement(
  async (image: any) => {
    const idx = imageIndex++;
    const contentType = image.contentType;

    if (!supportedImageTypes.has(contentType)) {
      const formatName = contentType.replace("image/", "").toUpperCase();
      const alt = \`[Unsupported image format: \${formatName}]\`;
      extractedImages.push({ index: idx, vaultPath: null, alt });
      return { src: \`__notor_skip_\${idx}__\`, alt };
    }

    try {
      const imgBuffer = await image.readAsBuffer();
      const ext = (contentType.split("/")[1] ?? "bin").replace("jpeg", "jpg");
      const hash = libs.crypto.createHash("md5").update(imgBuffer).digest("hex");
      const filename = \`\${hash}.\${ext}\`;
      const targetPath = await app.fileManager.getAvailablePathForAttachment(filename, sourcePath);
      const existing = app.vault.getFileByPath(targetPath);
      if (existing) {
        duplicatesSkipped++;
      } else {
        const arrayBuf = imgBuffer.buffer.slice(imgBuffer.byteOffset, imgBuffer.byteOffset + imgBuffer.byteLength);
        await app.vault.createBinary(targetPath, arrayBuf);
      }
      extractedImages.push({ index: idx, vaultPath: targetPath, alt: filename });
      return { src: \`__notor_img_\${idx}__\`, alt: filename };
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("Image extraction failed", { index: idx, error: errMsg });
      extractedImages.push({ index: idx, vaultPath: null, alt: "[Image extraction failed]" });
      return { src: \`__notor_skip_\${idx}__\`, alt: "[Image extraction failed]" };
    }
  },
);

const { value: html } = await libs.mammoth.convertToHtml(
  { buffer: buf },
  { convertImage },
);

const imageMap = new Map<string, { vaultPath: string | null; alt: string }>();
for (const img of extractedImages) {
  imageMap.set(\`__notor_img_\${img.index}__\`, img);
  imageMap.set(\`__notor_skip_\${img.index}__\`, img);
}

const td = new libs.Turndown({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
td.use(libs.turndownGfm.gfm);
td.addRule("replaceImages", {
  filter: ["img"],
  replacement: (_content: string, node: any) => {
    const src = node.getAttribute("src") ?? "";
    const alt = node.getAttribute("alt") ?? "";
    if (src.startsWith("__notor_img_")) {
      const info = imageMap.get(src);
      if (info?.vaultPath) return \`![\${alt}](\${info.vaultPath})\`;
    }
    if (src.startsWith("__notor_skip_")) return alt || "[image]";
    return "[image]";
  },
});

const markdown = td.turndown(html);

const finalNotePath = notePath.endsWith(".md") ? notePath : notePath + ".md";
const existingFile = utils.resolveNote(notePath);

const extractedCount = extractedImages.filter((i: any) => i.vaultPath !== null).length;
const skippedCount = extractedImages.filter((i: any) => i.vaultPath === null).length;
if (duplicatesSkipped > 0) {
  new obsidian.Notice(\`Skipped \${duplicatesSkipped} duplicate image(s) — already in vault\`);
}

if (!existingFile) {
  await utils.ensureDirectoryExists(finalNotePath);
  await app.vault.create(finalNotePath, markdown);
  log.info("Imported docx as new note", {
    source: resolvedPath,
    dest: finalNotePath,
    chars: markdown.length,
    imagesExtracted: extractedCount,
    imagesSkipped: skippedCount,
    duplicatesSkipped,
  });
  await utils.noteOpener.openNote(finalNotePath);
  return \`Note created: \${finalNotePath} (\${markdown.length} characters, \${extractedCount} image(s) extracted, \${duplicatesSkipped} duplicate(s) skipped)\`;
}

try {
  await utils.checkpointManager.createCheckpoint(existingFile.path, "import_docx", "");
} catch { /* non-fatal */ }

await app.vault.process(existingFile, () => markdown);
utils.staleTracker.updateAfterWrite(existingFile.path, markdown);
log.info("Imported docx over existing note", {
  source: resolvedPath,
  dest: existingFile.path,
  chars: markdown.length,
  imagesExtracted: extractedCount,
  imagesSkipped: skippedCount,
  duplicatesSkipped,
});
await utils.noteOpener.openNote(existingFile.path);
return \`Note updated: \${existingFile.path} (\${markdown.length} characters, \${extractedCount} image(s) extracted, \${duplicatesSkipped} duplicate(s) skipped)\`;`,
);

const WRITE_DOCX = scaffold(
	"write_docx",
	"Convert Markdown to a .docx file on the filesystem.",
	"write",
	`params:
  note_name:
    type: string
    description: "Path to an existing vault note to convert. Mutually exclusive with content."
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

const WRITE_FILE = scaffold(
	"write_file",
	"Write text content to a file on the filesystem.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  content:
    type: string
    description: "Complete text content to write to the file."
  encoding:
    type: string
    description: "File encoding."
    default: "utf-8"`,
	`const log = utils.logger("write_file");

if (!params.path || typeof params.path !== "string" || params.path.trim() === "") {
  throw new Error("Missing required parameter: path");
}
if (params.content === undefined || params.content === null || typeof params.content !== "string") {
  throw new Error("Missing required parameter: content");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("write_file is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(params.path as string);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;
const content = params.content as string;
const encoding = (params.encoding as string) || "utf-8";

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
if (content.length > MAX_CONTENT_BYTES) {
  throw new Error("Content exceeds maximum size of 5 MB.");
}

// Create intermediate directories if they don't exist
await libs.fs.promises.mkdir(libs.path.dirname(resolvedPath), { recursive: true });

// Write the file
await libs.fs.promises.writeFile(resolvedPath, content, {
  encoding: encoding as BufferEncoding,
});

log.info("Wrote file", { path: resolvedPath, chars: content.length });
return \`Successfully wrote file: \${resolvedPath} (\${content.length} characters)\`;`,
);

const REPLACE_IN_FILE = scaffold(
	"replace_in_file",
	"Make targeted edits within a text file using SEARCH/REPLACE blocks.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  changes:
    type: "object[]"
    description: "Array of search/replace blocks to apply in sequence. Each block replaces only the first occurrence of the search text."
    properties:
      search:
        type: string
        description: "Exact text to find in the file (character-for-character match including whitespace)."
      replace:
        type: string
        description: "Text to replace the matched search text with. Use empty string to delete the matched text."
    required_items:
      - search
      - replace`,
	`const log = utils.logger("replace_in_file");

if (!params.path || typeof params.path !== "string" || params.path.trim() === "") {
  throw new Error("Missing required parameter: path");
}
if (!Array.isArray(params.changes) || params.changes.length === 0) {
  throw new Error("Missing or empty required parameter: changes");
}

// Validate change blocks
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (typeof block?.search !== "string" || typeof block?.replace !== "string") {
    throw new Error(\`Change block \${i + 1} is missing required 'search' or 'replace' property\`);
  }
  if (block.search === "") {
    throw new Error(\`Change block \${i + 1} has an empty search string. Search text must be non-empty.\`);
  }
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("replace_in_file is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(params.path as string);
if (!pathResult.valid) throw new Error(pathResult.error);
const resolvedPath = pathResult.resolvedPath;

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

// Read raw buffer for binary detection
const buf = await libs.fs.promises.readFile(resolvedPath);

// Detect binary via null bytes in first 8 KB
if (buf.subarray(0, 8192).includes(0)) {
  throw new Error(
    "replace_in_file only supports text-based files. Binary files cannot be edited with SEARCH/REPLACE blocks."
  );
}

let content = buf.toString("utf-8");

// Apply SEARCH/REPLACE blocks sequentially in memory (atomic: all must match before write)
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (!block) continue;
  const match = utils.normalizedIndexOf(content, block.search);
  if (!match) {
    const preview = block.search.length > 80
      ? block.search.slice(0, 80) + "..."
      : block.search;
    throw new Error(
      \`Search block \${i + 1} did not match any text in \${params.path}. \` +
      \`No changes were applied. The search text was: "\${preview}"\`
    );
  }
  content = content.slice(0, match.index) + block.replace + content.slice(match.index + match.length);
}

// All blocks matched — write
await libs.fs.promises.writeFile(resolvedPath, content, "utf-8");

log.info("Applied replacements", { path: resolvedPath, count: params.changes.length });
return \`Applied \${params.changes.length} replacement\${params.changes.length > 1 ? "s" : ""} to \${resolvedPath}\`;`,
);

const EXTRACT_DOCX_COMMENTS = scaffold(
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

// ---------------------------------------------------------------------------
// sleep — pause execution for a specified duration (cancellable)
// ---------------------------------------------------------------------------

const SLEEP = scaffold(
	"sleep",
	"Pause execution for a specified duration. Useful for waiting on long-running processes like backfills. The user can cancel at any time.",
	"read",
	`params:
  duration_seconds:
    type: number
    description: "Duration to sleep in seconds. Supports fractional values for sub-second waits."
  reason:
    type: string
    description: "Optional description of why the sleep is needed (shown in progress UI)."
    default: ""
settings:
  sleep_max_duration_seconds:
    name: "Max Sleep Duration (seconds)"
    type: number
    description: "Maximum allowed sleep duration in seconds. Requests exceeding this are clamped."
    default: 3600
    min: 1
    max: 86400
  sleep_poll_interval_seconds:
    name: "Poll Interval (seconds)"
    type: number
    description: "How often to check for cancellation during sleep. Lower values mean faster cancellation response."
    default: 5
    min: 1
    max: 60`,
	`const log = utils.logger("sleep");

// Validate and clamp duration
const rawDuration = params.duration_seconds as number;
if (typeof rawDuration !== "number" || isNaN(rawDuration) || rawDuration <= 0) {
  throw new Error("Missing or invalid required parameter: duration_seconds (must be a positive number)");
}
const maxDuration = settings.sleep_max_duration_seconds as number;
const durationSeconds = Math.min(rawDuration, maxDuration);
const reason = ((params.reason as string) || "").trim();
const pollIntervalSeconds = settings.sleep_poll_interval_seconds as number;

if (durationSeconds < rawDuration) {
  log.info("Duration clamped to max", { requested: rawDuration, clamped: durationSeconds, max: maxDuration });
}

log.info("Sleep started", { duration: durationSeconds, reason: reason || "(none)" });

const startTime = Date.now();
const endTime = startTime + durationSeconds * 1000;
const signal = utils.abortSignal;

function formatDuration(secs: number): string {
  if (secs < 60) return Math.round(secs) + "s";
  if (secs < 3600) return Math.floor(secs / 60) + "m " + Math.round(secs % 60) + "s";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h + "h " + m + "m";
}

const progressPrefix = reason ? "Sleeping (" + reason + ")" : "Sleeping";
utils.onProgress?.(progressPrefix + ": " + formatDuration(durationSeconds) + " remaining...");

while (Date.now() < endTime) {
  if (signal?.aborted) {
    const elapsed = (Date.now() - startTime) / 1000;
    log.info("Sleep cancelled", { elapsed: elapsed.toFixed(1), requested: durationSeconds });
    throw new Error("Sleep cancelled after " + elapsed.toFixed(1) + "s of " + durationSeconds + "s.");
  }

  const remaining = (endTime - Date.now()) / 1000;
  const tickMs = Math.min(pollIntervalSeconds * 1000, remaining * 1000);

  await new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(resolve, Math.max(tickMs, 0));
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

  const newRemaining = Math.max(0, (endTime - Date.now()) / 1000);
  if (newRemaining > 0) {
    utils.onProgress?.(progressPrefix + ": " + formatDuration(newRemaining) + " remaining...");
  }
}

const actualSeconds = (Date.now() - startTime) / 1000;
log.info("Sleep completed", { actual: actualSeconds.toFixed(1), requested: durationSeconds });

utils.onProgress?.(progressPrefix + ": done.");

const result: Record<string, unknown> = {
  status: "completed",
  requested_seconds: durationSeconds,
  actual_seconds: Math.round(actualSeconds * 10) / 10,
};
if (durationSeconds < rawDuration) {
  result.note = "Duration was clamped from " + rawDuration + "s to " + durationSeconds + "s (max: " + maxDuration + "s).";
}
if (reason) {
  result.reason = reason;
}
return result;`,
);

// ---------------------------------------------------------------------------
// search_chat_history — search past Notor conversations by keyword
// ---------------------------------------------------------------------------

const SEARCH_CHAT_HISTORY = scaffold(
	"search_chat_history",
	"Search past Notor conversations by keyword. Returns matching conversation metadata with IDs that can be used with read_chat_history.",
	"read",
	`params:
  query:
    type: string
    description: "Search query to match against conversation titles and message content. Case-insensitive. Leave empty to list recent conversations."
    default: ""
  limit:
    type: number
    description: "Maximum number of results to return (1–50)."
    default: 10`,
	`const log = utils.logger("search_chat_history");

if (!utils.chatHistory) {
  throw new Error("Chat history is not available.");
}

const query = ((params.query as string) || "").trim();
const limit = Math.min(Math.max(1, (params.limit as number) || 10), 50);

if (!query) {
  log.info("Listing recent conversations", { limit });
  const recent = await utils.chatHistory.listRecent(limit);
  return {
    conversations: recent,
    total: recent.length,
    note: "No query provided — showing most recent conversations. Each conversation includes a deep_link that can be used in markdown links.",
  };
}

log.info("Searching conversations", { query, limit });
const results = await utils.chatHistory.search(query);
const trimmed = results.slice(0, limit);

return {
  query,
  conversations: trimmed,
  total_matches: results.length,
  returned: trimmed.length,
};`,
);

// ---------------------------------------------------------------------------
// read_chat_history — read the message history of a past conversation
// ---------------------------------------------------------------------------

const READ_CHAT_HISTORY = scaffold(
	"read_chat_history",
	"Read the full message history of a past Notor conversation by its ID. Use search_chat_history first to find the conversation ID.",
	"read",
	`params:
  conversation_id:
    type: string
    description: "The UUID of the conversation to read. Obtain this from search_chat_history results."
  max_messages:
    type: number
    description: "Maximum number of messages to return (most recent first). Set to 0 for all messages."
    default: 50`,
	`const log = utils.logger("read_chat_history");

if (!utils.chatHistory) {
  throw new Error("Chat history is not available.");
}

const conversationId = ((params.conversation_id as string) || "").trim();
if (!conversationId) {
  throw new Error("Missing required parameter: conversation_id");
}

const maxMessages = Math.max(0, (params.max_messages as number) ?? 50);

log.info("Loading conversation", { conversationId, maxMessages });
const result = await utils.chatHistory.loadConversation(conversationId);

if (!result) {
  return {
    error: "not_found",
    message: "Conversation not found. It may have been deleted by the retention policy. Use search_chat_history to find valid conversation IDs.",
  };
}

let messages = result.messages;
if (maxMessages > 0 && messages.length > maxMessages) {
  const skipped = messages.length - maxMessages;
  messages = messages.slice(-maxMessages);
  return {
    conversation_id: result.id,
    title: result.title,
    created_at: result.created_at,
    updated_at: result.updated_at,
    messages,
    total_messages: result.messages.length,
    returned_messages: messages.length,
    note: skipped + " earlier messages omitted. Set max_messages to 0 for all.",
    deep_link: result.deep_link,
  };
}

return {
  conversation_id: result.id,
  title: result.title,
  created_at: result.created_at,
  updated_at: result.updated_at,
  messages,
  total_messages: messages.length,
  deep_link: result.deep_link,
};`,
);

const CAPTURE_MEMORY = scaffold(
	"capture_memory",
	"Save an insight into long-term memory as an Evergreen note",
	"write",
	`params:
  content:
    type: string
    description: "The insight or piece of knowledge to save into long-term memory."
settings:
  resolver_profile:
    name: "Resolver Profile"
    type: string
    description: "Sub-agent profile used to decide whether to create or update an existing memory note."
    default: "memory-resolver"
  dedup_window_hours:
    name: "Dedup Window (hours)"
    type: number
    description: "Hours within which identical insights are deduplicated."
    default: 24
    min: 1
    max: 168`,
	`const log = utils.logger("capture_memory");

if (!params.content || typeof params.content !== "string") {
  throw new Error("Missing required parameter: content");
}

if (!utils.memory) {
  return "Memory is disabled. Enable it in Notor settings to use this tool.";
}

const content = (params.content as string).trim();
if (content.length === 0) {
  throw new Error("Content must not be empty.");
}

const windowHours = (settings.dedup_window_hours as number) ?? 24;
const resolverProfile = (settings.resolver_profile as string) ?? "memory-resolver";
const memoryDir = utils.resolveNotorPath("memory");
const approvalMode = utils.memoryApprovalMode ?? "auto";
const pendingMode = approvalMode === "bulk" || approvalMode === "bulk_and_inline";
const pendingMemoryDir = pendingMode ? utils.resolveNotorPath("pending-memories") : "";

log.debug("Checking dedup", { windowHours });
const { isDuplicate } = await utils.memory.fingerprintAndDedup(content, windowHours);
if (isDuplicate) {
  log.debug("Duplicate insight, skipping");
  return "Skipped — this insight was already captured recently.";
}

if (pendingMode) {
  await utils.memory.pendingMemoryManager.ensurePendingDir();
}

log.debug("Resolving concept", { resolverProfile, memoryDir, pendingMode });
const result = await utils.memory.resolveConcept({
  insight: content,
  memoryDir,
  resolverProfile,
  pendingMode,
  pendingMemoryDir: pendingMode ? pendingMemoryDir : undefined,
});

if (result.action === "skipped") {
  return "The insight could not be resolved into a memory note. It may be too vague or the resolver could not determine how to file it.";
}

if (pendingMode) {
  const verb = result.action === "created" ? "Queued new" : "Queued update to";
  return \`\${verb} memory note (pending approval): \${result.path}\`;
}

const verb = result.action === "created" ? "Created" : "Updated";
return \`\${verb} memory note: \${result.path}\`;`,
	"memory",
);

// ---------------------------------------------------------------------------
// webview
// ---------------------------------------------------------------------------

const WEBVIEW = scaffold(
	"webview",
	"Interact with Obsidian's Web Viewer tab. Use 'read' to get page content as Markdown, 'click' to click a link by visible text, or 'navigate' to load a URL. Desktop only.",
	"write",
	`params:
  action:
    type: string
    description: "The action to perform: 'read' extracts page content, 'click' clicks a link by text, 'navigate' loads a URL."
    enum:
      - read
      - click
      - navigate
  scope:
    type: string
    description: "Which Web Viewer to use. 'conversation' uses a dedicated leaf for this conversation. 'active' reads the user's currently focused Web Viewer tab."
    enum:
      - conversation
      - active
    default: "conversation"
  text:
    type: string
    description: "For 'click' action: the visible text of the link to click (case-insensitive partial match)."
  url:
    type: string
    description: "For 'navigate' action: the URL to load."
settings:
  webview_max_output_chars:
    name: "Max Output Characters"
    type: number
    description: "Maximum characters returned to the LLM. Longer content is truncated."
    default: 50000
    min: 1000
    max: 500000`,
	`const log = utils.logger("webview");

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("The webview tool requires Obsidian Desktop (Electron). It is not available on mobile.");
}

if (!utils.webview) {
  throw new Error("Webview subsystem unavailable.");
}

const action = params.action as string;
if (!action || !["read", "click", "navigate"].includes(action)) {
  throw new Error("Missing or invalid 'action' parameter. Must be 'read', 'click', or 'navigate'.");
}

const scope = (params.scope as string) || "conversation";
const maxOutputChars = settings.webview_max_output_chars as number;

function initTurndown(): any {
  const td = new libs.Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  td.use(libs.turndownGfm.gfm);
  td.addRule("stripNav", {
    filter: ["nav", "footer", "aside"],
    replacement: () => "",
  });
  td.addRule("stripForms", {
    filter: ["form", "input", "select", "button"],
    replacement: () => "",
  });
  return td;
}

async function getWebview(): Promise<{ leaf: any; webviewEl: any }> {
  if (scope === "active") {
    const result = utils.webview!.getActiveWebview();
    if (!result) {
      throw new Error("No Web Viewer tab is currently active. Switch to a Web Viewer tab and try again, or use scope: 'conversation' for autonomous browsing.");
    }
    return result;
  }
  const result = await utils.webview!.getConversationWebview();
  if (!result) {
    throw new Error("Could not open or find a Web Viewer leaf. Ensure Obsidian's Web Viewer core plugin is enabled.");
  }
  return result;
}

if (action === "read") {
  const { leaf, webviewEl } = await getWebview();
  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const url = await webviewEl.executeJavaScript("window.location.href");
  const title = await webviewEl.executeJavaScript("document.title");

  const links = await webviewEl.executeJavaScript(\`
    Array.from(document.querySelectorAll('a[href]'))
      .filter(a => a.innerText.trim().length > 0)
      .filter(a => {
        const href = a.getAttribute('href');
        return href && !href.startsWith('#') && !href.startsWith('javascript:');
      })
      .slice(0, 50)
      .map(a => ({ text: a.innerText.trim().substring(0, 100), href: a.href }))
  \`);

  const html = await webviewEl.executeJavaScript("document.documentElement.outerHTML");
  let content: string;
  try {
    content = initTurndown().turndown(html);
  } catch {
    content = html;
  }

  let truncated = false;
  if (content.length > maxOutputChars) {
    content = content.substring(0, maxOutputChars);
    truncated = true;
  }

  const result: any = { url, title, links, content };
  if (truncated) {
    result.note = \`Content truncated at \${maxOutputChars.toLocaleString()} characters.\`;
  }

  log.info("Read webview", { url, title, linkCount: links.length, contentLength: content.length, truncated });
  return result;
}

if (action === "navigate") {
  const targetUrl = params.url as string;
  if (!targetUrl || typeof targetUrl !== "string") {
    throw new Error("Missing required parameter: 'url' (required for navigate action).");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    throw new Error(\`Invalid URL: \${targetUrl}\`);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(\`Unsupported protocol: \${parsedUrl.protocol}. Only http:// and https:// URLs are accepted.\`);
  }

  const denyCheck = utils.isDomainBlocked(targetUrl, shared.domain_denylist ?? []);
  if (denyCheck.blocked) {
    log.info("Domain blocked by denylist", { url: targetUrl, pattern: denyCheck.pattern });
    throw new Error(\`Domain \${parsedUrl.hostname} is blocked by your denylist.\`);
  }

  const { leaf, webviewEl } = await getWebview();

  await webviewEl.loadURL(targetUrl);
  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const newUrl = await webviewEl.executeJavaScript("window.location.href");
  const newTitle = await webviewEl.executeJavaScript("document.title");

  if (scope === "conversation") {
    const convId = utils.webview!.getConversationId();
    if (convId) {
      await utils.webview!.persistUrl(convId, newUrl);
    }
  }

  log.info("Navigate webview", { targetUrl, newUrl, newTitle });
  return { url: newUrl, title: newTitle };
}

if (action === "click") {
  const text = params.text as string;
  if (!text || typeof text !== "string") {
    throw new Error("Missing required parameter: 'text' (required for click action).");
  }

  const { leaf, webviewEl } = await getWebview();
  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const safeText = JSON.stringify(text);
  const clickResult = await webviewEl.executeJavaScript(\`
    (function(targetText) {
      const links = Array.from(document.querySelectorAll('a'));
      const target = targetText.toLowerCase();
      const match = links.find(a =>
        a.innerText.trim().toLowerCase().includes(target)
      );
      if (match) {
        match.click();
        return { found: true, text: match.innerText.trim().substring(0, 100), href: match.href };
      }
      const available = links
        .filter(a => a.innerText.trim().length > 0)
        .slice(0, 20)
        .map(a => a.innerText.trim().substring(0, 80));
      return { found: false, available };
    })(\${safeText})
  \`);

  if (!clickResult.found) {
    const availableStr = clickResult.available?.length > 0
      ? \`\\n\\nAvailable link texts: \${clickResult.available.map((t: string) => \`"\${t}"\`).join(", ")}\`
      : "";
    throw new Error(\`No link found with text matching "\${text}".\${availableStr}\`);
  }

  await utils.webview!.waitForReady(webviewEl, scope === "conversation", leaf);

  const newUrl = await webviewEl.executeJavaScript("window.location.href");
  const newTitle = await webviewEl.executeJavaScript("document.title");

  if (scope === "conversation") {
    const convId = utils.webview!.getConversationId();
    if (convId) {
      await utils.webview!.persistUrl(convId, newUrl);
    }
  }

  log.info("Click webview", { text, clicked: clickResult.text, newUrl, newTitle });
  return { clicked: clickResult.text, new_url: newUrl, new_title: newTitle };
}

throw new Error(\`Unknown action: \${action}\`);`,
);

// ---------------------------------------------------------------------------
// read_notor_settings
// ---------------------------------------------------------------------------

const READ_NOTOR_SETTINGS = scaffold(
	"read_notor_settings",
	"Read the current Notor plugin settings.",
	"read",
	`params: {}`,
	`return JSON.stringify(utils.readPluginSettings(), null, 2);`,
);

// ---------------------------------------------------------------------------
// edit_notor_settings
// ---------------------------------------------------------------------------

const EDIT_NOTOR_SETTINGS = scaffold(
	"edit_notor_settings",
	"Change a single Notor plugin setting by key path.",
	"write",
	`params:
  key_path:
    type: string
    description: "Dot-separated path into the settings object (e.g. 'compaction_threshold' or 'auto_approve.write_note'). Use numeric indices for array items (e.g. 'providers.0.model_id')."
  value:
    type: string
    description: 'The new value as a JSON literal (e.g. 0.9, true, "hello"). Parsed as JSON; if parsing fails, used as a raw string.'`,
	`const keyPath = params.key_path as string;
if (!keyPath) throw new Error("key_path is required");

const rawValue = params.value as string;
let parsed: unknown;
try {
  parsed = JSON.parse(rawValue);
} catch {
  parsed = rawValue;
}

const result = await utils.editPluginSetting(keyPath, parsed);
if (!result.success) {
  throw new Error(result.error ?? "Unknown error");
}

return \`Setting updated: \${keyPath}\\n  Old: \${JSON.stringify(result.oldValue)}\\n  New: \${JSON.stringify(result.newValue)}\`;`,
);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * All built-in tool scaffolds, keyed by tool name.
 *
 * Used by:
 * - `ExtensionManager.ensureBuiltinToolVaultFile()` to create vault files on demand
 * - `ExtensionManager.resetBuiltinToolToDefault()` to restore vault files
 * - Extensions settings section to enumerate built-in tools
 */
export const BUILTIN_TOOL_SCAFFOLDS: ReadonlyMap<string, BuiltinToolScaffold> =
	new Map([
		[READ_NOTE.name, READ_NOTE],
		[SEARCH_VAULT.name, SEARCH_VAULT],
		[LIST_VAULT.name, LIST_VAULT],
		[READ_FRONTMATTER.name, READ_FRONTMATTER],
		[GET_BACKLINKS.name, GET_BACKLINKS],
		[GET_OUTLINKS.name, GET_OUTLINKS],
		[WRITE_NOTE.name, WRITE_NOTE],
		[REPLACE_IN_NOTE.name, REPLACE_IN_NOTE],
		[UPDATE_FRONTMATTER.name, UPDATE_FRONTMATTER],
		[MANAGE_TAGS.name, MANAGE_TAGS],
		[MOVE_NOTE.name, MOVE_NOTE],
		[FETCH_WEBPAGE.name, FETCH_WEBPAGE],
		[WEB_SEARCH.name, WEB_SEARCH],
		[EXECUTE_COMMAND.name, EXECUTE_COMMAND],
		[READ_FILE.name, READ_FILE],
		[READ_DOCX.name, READ_DOCX],
		[IMPORT_DOCX.name, IMPORT_DOCX],
		[WRITE_DOCX.name, WRITE_DOCX],
		[WRITE_FILE.name, WRITE_FILE],
		[REPLACE_IN_FILE.name, REPLACE_IN_FILE],
		[EXTRACT_DOCX_COMMENTS.name, EXTRACT_DOCX_COMMENTS],
		[SLEEP.name, SLEEP],
		[SEARCH_CHAT_HISTORY.name, SEARCH_CHAT_HISTORY],
		[READ_CHAT_HISTORY.name, READ_CHAT_HISTORY],
		[CAPTURE_MEMORY.name, CAPTURE_MEMORY],
		[WEBVIEW.name, WEBVIEW],
		[READ_NOTOR_SETTINGS.name, READ_NOTOR_SETTINGS],
		[EDIT_NOTOR_SETTINGS.name, EDIT_NOTOR_SETTINGS],
	]);

// ---------------------------------------------------------------------------
// Built-in shared settings scaffold (D-8)
// ---------------------------------------------------------------------------

/**
 * Default shared settings schema, used when no `notor/settings.md` exists.
 *
 * Declares the two cross-tool settings (`domain_denylist`, `read_file_allowed_paths`)
 * so they are always available in the `shared` object passed to tool functions.
 * If a user-authored `notor/settings.md` exists, it takes precedence.
 */
export const BUILTIN_SHARED_SETTINGS_SCHEMA: readonly SettingsFieldSchema[] = [
	{
		key: "domain_denylist",
		name: "Domain denylist",
		type: "string[]",
		description: "Domains blocked from fetch_webpage and web_search requests.",
		default: [],
	},
	{
		key: "read_file_allowed_paths",
		name: "Allowed file-system paths",
		type: "string[]",
		description: "Absolute paths outside the vault that read_file, write_file, replace_in_file, and DOCX tools may access.",
		default: [],
	},
];
