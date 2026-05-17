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
