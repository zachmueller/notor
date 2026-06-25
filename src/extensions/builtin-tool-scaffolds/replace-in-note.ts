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
    description: "Array of search/replace blocks to apply in sequence. Each block's search text must match exactly one location in the note (add surrounding context to disambiguate if it appears more than once)."
    properties:
      search:
        type: string
        description: "Text to find in the note. Leading/trailing and interior whitespace differences are tolerated, but the search must match a UNIQUE location — include 2–4 lines of surrounding context if the text appears multiple times."
      replace:
        type: string
        description: "Text to replace the matched search text with. Use empty string to delete the matched text."
    required_items:
      - search
      - replace
settings:
  replace_in_note_return_full_content_on_failure:
    name: "Return Full Note Content on Failure"
    type: boolean
    description: "When a replace fails (no match, ambiguous match, or stale content), include the note's full current content in the error so the model can self-correct without re-reading. Disable to save context window."
    default: true
  replace_in_note_failure_content_max_chars:
    name: "Max Failure-Content Characters"
    type: number
    description: "When returning full content on failure, truncate it to this many characters (a marker notes the cut). Prevents large notes from flooding the context window."
    default: 20000
    min: 1000
    max: 500000`,
	`const log = utils.logger("replace_in_note");

const buildFailureResult = (errorMsg, fullContent) => {
  if (!settings.replace_in_note_return_full_content_on_failure) {
    return "Error: " + errorMsg + "\\n\\n(Full note content omitted by setting — re-read the note to see current content.)";
  }
  const cap = settings.replace_in_note_failure_content_max_chars;
  let body = fullContent;
  if (typeof cap === "number" && body.length > cap) {
    body = body.slice(0, cap) + "\\n\\n…[truncated " + (body.length - cap) + " chars — re-read the note for full content]";
  }
  return "Error: " + errorMsg + "\\n\\n---\\nCurrent note content:\\n\\n" + body;
};

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
    result: buildFailureResult("Stale content detected for " + params.path + ". The note was modified since you last read it.", currentContent),
  };
}

// Checkpoint before write (non-fatal)
try {
  await utils.checkpointManager.createCheckpoint(file.path, "replace_in_note", "");
} catch { /* non-fatal */ }

// Apply changes atomically via vault.process —
// if any search block doesn't match (or matches ambiguously), the callback
// throws and vault.process writes nothing.
let failedBlockIndex = -1;
let failedSearchText = "";
let failedReason = "";
let failedCount = 0;
const noOpBlocks = [];

try {
  await app.vault.process(file, (data: string) => {
    let modified = data;
    for (let i = 0; i < params.changes.length; i++) {
      const block = params.changes[i];
      if (!block) continue;
      // No-op block (search === replace) changes nothing — record a warning and skip.
      // Skipping before matching ensures a harmless no-op can never abort other changes.
      if (block.search === block.replace) {
        if (!noOpBlocks.includes(i + 1)) noOpBlocks.push(i + 1);
        continue;
      }
      const result = utils.resilientIndexOf(modified, block.search);
      if (!result.ok) {
        failedBlockIndex = i + 1;
        failedSearchText = block.search;
        failedReason = result.reason;
        failedCount = result.count || 0;
        throw new Error(\`Search block \${i + 1} did not match uniquely\`);
      }
      const match = result.match;
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
    const errorMsg = failedReason === "not_unique"
      ? \`Search block \${failedBlockIndex} matched \${failedCount} locations in \${params.path}. Add surrounding context (2–4 lines) so it matches exactly one place. No changes were applied. The search text was: "\${preview}"\`
      : \`Search block \${failedBlockIndex} did not match any text in \${params.path}. No changes were applied. The search text was: "\${preview}"\`;
    utils.staleTracker.recordRead(file.path, currentContent);
    return {
      __toolError: true,
      error: errorMsg,
      result: buildFailureResult(errorMsg, currentContent),
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

log.info("Applied replacements", { path: params.path, count: params.changes.length, noOps: noOpBlocks.length });

// Open in editor
await utils.noteOpener.openNote(file.path);

const applied = params.changes.length - noOpBlocks.length;
let msg = \`Applied \${applied} replacement\${applied === 1 ? "" : "s"} to \${params.path}\`;
if (noOpBlocks.length) {
  msg += \` ⚠️ Block(s) \${noOpBlocks.join(", ")} were no-ops (search and replace text were identical) — those edits did NOT change the note.\`;
}
return msg;`,
);
