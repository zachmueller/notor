import { scaffold } from "./_scaffold-helper";

export const MOVE_NOTE = scaffold(
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
  await utils.checkpoints.create(file.path, "move_note", "");
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
