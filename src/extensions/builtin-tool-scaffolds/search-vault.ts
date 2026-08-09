import { scaffold } from "./_scaffold-helper";

export const SEARCH_VAULT = scaffold(
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

// Count of candidates withheld by vault-read path restrictions, reported in the
// result so the model never concludes the hidden notes simply don't exist.
let hiddenByPathRestrictions = 0;

function getCandidateFiles(sp: string, fp: string): any[] {
  const allFiles = app.vault.getFiles();
  return allFiles.filter((file: any) => {
    if (utils.pathFilter && !utils.pathFilter(file.path)) {
      hiddenByPathRestrictions++;
      return false;
    }
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

const result: any = {
  total_matches: totalMatches,
  total_files: totalFiles,
  files: paginatedResults,
};
if (hiddenByPathRestrictions > 0) {
  result.notice = hiddenByPathRestrictions + " notes hidden by path restrictions";
}
return result;`,
);
