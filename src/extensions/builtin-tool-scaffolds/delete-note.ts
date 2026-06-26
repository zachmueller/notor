import { scaffold } from "./_scaffold-helper";

export const DELETE_NOTE = scaffold(
	"delete_note",
	"Delete a note from the vault (moves it to trash).",
	"write",
	`params:
  path:
    type: string
    description: "Path of the note to delete, relative to vault root."
    path_namespace: vault
    path_resolve_as: note`,
	`const log = utils.logger("delete_note");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

if (file.extension !== "md") {
  throw new Error(\`Path is not a Markdown note: \${file.path}\`);
}

// Count backlinks before deletion so we can warn about dangling links.
const targetPath = file.path;
let backlinkCount = 0;
for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
  if (sourcePath !== targetPath && targetPath in links) backlinkCount++;
}

// Checkpoint before destructive operation (non-fatal) — second recovery path.
try {
  await utils.checkpointManager.createCheckpoint(file.path, "delete_note", "");
} catch { /* non-fatal */ }

// Recoverable delete: honors the user's configured Obsidian trash location.
await app.fileManager.trashFile(file);

log.info("Note deleted", { path: targetPath, backlinks: backlinkCount });

let msg = \`Note deleted (moved to trash): \${targetPath}\`;
if (backlinkCount > 0) {
  msg += \`\\n⚠️ \${backlinkCount} note(s) still link to this note — those links are now broken.\`;
}
return msg;`,
);
