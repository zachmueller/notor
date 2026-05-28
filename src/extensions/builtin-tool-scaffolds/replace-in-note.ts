import { scaffold } from "./_scaffold-helper";

export const REPLACE_IN_NOTE = scaffold(
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
  utils.staleTracker.recordRead(file.path, currentContent);
  return {
    __toolError: true,
    error: "Note content has changed since last read. The current content is included below — retry your edit based on this content.",
    result: "Error: Stale content detected for " + params.path + ". The note was modified since you last read it.\\n\\n---\\nCurrent note content:\\n\\n" + currentContent,
  };
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
    const errorMsg = \`Search block \${failedBlockIndex} did not match any text in \${params.path}. No changes were applied. The search text was: "\${preview}"\`;
    utils.staleTracker.recordRead(file.path, currentContent);
    return {
      __toolError: true,
      error: errorMsg,
      result: "Error: " + errorMsg + "\\n\\n---\\nCurrent note content:\\n\\n" + currentContent,
    };
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
