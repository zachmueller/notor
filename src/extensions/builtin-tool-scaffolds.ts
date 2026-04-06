/**
 * Built-in tool scaffold definitions for the Extensions settings section.
 *
 * Each scaffold provides a complete `.md` file template that can be written
 * to `notor/tools/{name}.md` so the user can customize the built-in tool.
 * The vault file overrides the built-in implementation on next reload.
 *
 * Follows the same pattern as `src/sub-agents/builtin-profiles.ts`.
 */

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
): BuiltinToolScaffold {
	const trimmedYaml = yamlFenceContent.trimEnd();
	return {
		name,
		description,
		mode,
		scaffoldContent:
`---
notor-type: tool
notor-tool-name: ${name}
notor-description: "${description}"
notor-mode: ${mode}
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
  limit:
    type: number
    description: "Maximum number of files to return."
    default: 20
  offset:
    type: number
    description: "Number of files to skip for pagination."
    default: 0`,
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
    default: "last_modified"`,
	`const log = utils.logger("list_vault");

const listPath = ((params.path as string) ?? "").trim();
const recursive = (params.recursive as boolean) ?? false;
const limit = Math.max(1, Math.min(500, Math.floor((params.limit as number) ?? 50)));
const offset = Math.max(0, Math.floor((params.offset as number) ?? 0));
const sortBy = ((params.sort_by as string) ?? "last_modified") as "last_modified" | "alphabetical";

log.debug("Listing vault", { listPath, recursive, limit, offset, sortBy });

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

// Collect, sort, paginate
const allItems = collectItems(listPath, recursive);

const sorted = [...allItems].sort((a: any, b: any) => {
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
    path_namespace: vault`,
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
    path_namespace: vault`,
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
    path_namespace: vault`,
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
      const idx = modified.indexOf(block.search);
      if (idx === -1) {
        failedBlockIndex = i + 1;
        failedSearchText = block.search;
        throw new Error(\`Search block \${i + 1} did not match\`);
      }
      modified =
        modified.slice(0, idx) +
        block.replace +
        modified.slice(idx + block.search.length);
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
    description: "URL of the webpage to fetch."`,
);

const WEB_SEARCH = scaffold(
	"web_search",
	"Search the web using DuckDuckGo and return results with titles, URLs, and snippets.",
	"read",
	`params:
  query:
    type: string
    description: "Search query string."
  num_results:
    type: number
    description: "Number of results to return. Maximum 10."
    default: 5`,
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
    max: 500000`,
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
  });

  let output = result.stdout;

  if (result.truncated) {
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
    description: "Page range for PDF files (e.g. '1-5')."`,
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
    path_namespace: filesystem`,
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
  const idx = content.indexOf(block.search);
  if (idx === -1) {
    const preview = block.search.length > 80
      ? block.search.slice(0, 80) + "..."
      : block.search;
    throw new Error(
      \`Search block \${i + 1} did not match any text in \${params.path}. \` +
      \`No changes were applied. The search text was: "\${preview}"\`
    );
  }
  content = content.slice(0, idx) + block.replace + content.slice(idx + block.search.length);
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
		[WRITE_DOCX.name, WRITE_DOCX],
		[WRITE_FILE.name, WRITE_FILE],
		[REPLACE_IN_FILE.name, REPLACE_IN_FILE],
		[EXTRACT_DOCX_COMMENTS.name, EXTRACT_DOCX_COMMENTS],
	]);
