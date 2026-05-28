import { scaffold } from "./_scaffold-helper";

export const WRITE_NOTE = scaffold(
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
  utils.staleTracker.recordRead(existingFile.path, currentContent);
  return {
    __toolError: true,
    error: "Note content has changed since last read. The current content is included below — retry your edit based on this content.",
    result: "Error: Stale content detected for " + params.path + ". The note was modified since you last read it.\\n\\n---\\nCurrent note content:\\n\\n" + currentContent,
  };
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
