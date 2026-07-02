import { scaffold } from "./_scaffold-helper";

export const READ_NOTE = scaffold(
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
    default: false
  backlinks:
    type: string
    description: "Append a Backlinks section: 'list' (linking note paths) or 'context' (paths plus snippet windows). Use 'none' to suppress. If omitted, uses the configured default (Settings → Tools → read_note)."
    enum:
      - none
      - list
      - context
    default: "list"
settings:
  backlinks_default:
    name: "Default backlinks mode"
    type: string
    description: "What read_note appends when the agent does not specify a backlinks mode."
    options:
      - none
      - list
      - context
    default: "list"
  backlinks_context_lines:
    name: "Backlinks context lines"
    type: number
    description: "Lines of surrounding context around each backlink in 'context' mode (0 = link line only)."
    default: 2
    min: 0
    max: 10
  backlinks_max_links_per_source:
    name: "Max backlinks per source note"
    type: number
    description: "Max link snippets shown from a single source note in 'context' mode."
    default: 5
    min: 1
    max: 20
  backlinks_max_total_sources:
    name: "Max backlink source notes"
    type: number
    description: "Max number of source notes listed in the Backlinks section."
    default: 25
    min: 1
    max: 200`,
	`const log = utils.logger("read_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Reading note", { path: params.path, includeFrontmatter: params.include_frontmatter });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

// Only allow markdown files
if (file.extension !== "md") {
  throw new Error(\`Path is not a Markdown note: \${params.path}. read_note only reads Markdown (.md) notes — use read_file to read JSON, text, or other non-Markdown files.\`);
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
utils.staleContent.recordRead(file.path, fullContent);

// Open the note in the editor if configured
await utils.notes.open(file.path);

log.debug("Read note successfully", { path: params.path, contentLength: returnContent.length });

// --- Backlinks section ---------------------------------------------------
// Resolve effective mode: omitted (undefined) -> settings default; explicit value honored.
const requestedMode = params.backlinks;
const backlinksMode = requestedMode === undefined ? (settings.backlinks_default ?? "list") : requestedMode;

if (backlinksMode !== "list" && backlinksMode !== "context") {
  return returnContent; // "none" or unrecognized -> no backlinks section
}

// Reverse-lookup over resolvedLinks (same pattern as get_backlinks); self-links excluded.
const targetPath = file.path;
const sources = [];
for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
  if (sourcePath !== targetPath && targetPath in links) sources.push(sourcePath);
}

if (sources.length === 0) {
  return returnContent; // no backlinks -> no empty "## Backlinks" header
}

sources.sort(); // deterministic order

// Clamp caps from settings (double-guard malformed persisted values).
const maxSources = Math.max(1, Math.min(200, Math.floor((settings.backlinks_max_total_sources as number) ?? 25)));
const ctxLines = Math.max(0, Math.min(10, Math.floor((settings.backlinks_context_lines as number) ?? 2)));
const maxPerSource = Math.max(1, Math.min(20, Math.floor((settings.backlinks_max_links_per_source as number) ?? 5)));

const shown = sources.slice(0, maxSources);
let body: string;

if (backlinksMode === "list") {
  body = shown.map((p) => \`- \${p}\`).join("\\n");
} else {
  // context mode: read each source once and extract line windows around links to the target.
  const blocks = [];
  for (const sourcePath of shown) {
    const sourceFile = utils.resolveNote(sourcePath);
    if (!sourceFile) continue;

    const cache = app.metadataCache.getFileCache(sourceFile);
    const linkCache = cache?.links ?? [];
    const hits = linkCache.filter((l) => {
      const dest = app.metadataCache.getFirstLinkpathDest(l.link, sourcePath);
      return dest && dest.path === targetPath;
    });

    if (hits.length === 0) {
      // No usable link positions (embed-only ref or stale cache) -> path-only entry.
      blocks.push(\`### \${sourcePath}\`);
      continue;
    }

    let srcLines;
    try {
      const srcContent = await utils.readNote(sourcePath);
      srcLines = srcContent.split("\\n");
    } catch (e) {
      log.debug("Skipping unreadable backlink source", { sourcePath, error: String(e) });
      continue;
    }

    const snippets = [];
    for (const hit of hits.slice(0, maxPerSource)) {
      const ln = hit.position.start.line;
      const start = Math.max(0, ln - ctxLines);
      const end = Math.min(srcLines.length - 1, ln + ctxLines);
      const windowLines = [];
      for (let i = start; i <= end; i++) {
        const prefix = i === ln ? "> " : "  ";
        windowLines.push(\`    \${prefix}\${srcLines[i] ?? ""}\`);
      }
      snippets.push(windowLines.join("\\n"));
    }
    if (hits.length > maxPerSource) {
      snippets.push(\`    … and \${hits.length - maxPerSource} more link(s) in this note.\`);
    }

    blocks.push(\`### \${sourcePath}\\n\${snippets.join("\\n\\n")}\`);
  }
  body = blocks.join("\\n\\n");
}

if (sources.length > maxSources) {
  body += \`\\n\\n… and \${sources.length - maxSources} more source note(s) (truncated).\`;
}

log.debug("Appended backlinks", { mode: backlinksMode, sourceCount: sources.length, shown: shown.length });

return \`\${returnContent}\\n\\n## Backlinks\\n\\n\${body}\`;`,
);
