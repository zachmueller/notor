import { scaffold } from "./_scaffold-helper";

export const REPLACE_IN_NOTE = scaffold(
	"replace_in_note",
	"Make targeted find/replace edits within a note.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
  changes:
    type: "object[]"
    description: "Array of find/replace edits to apply in sequence. Each edit's old_text must match exactly one location in the note (add surrounding context to disambiguate if it appears more than once)."
    properties:
      old_text:
        type: string
        description: "Text to find in the note. Leading/trailing and interior whitespace differences are tolerated, but it must match a UNIQUE location — include 2–4 lines of surrounding context if the text appears multiple times."
      new_text:
        type: string
        description: "Replacement text. Use an empty string to delete the matched text."
    required_items:
      - old_text
      - new_text
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

// Canonicalize legacy {search,replace} aliases to {old_text,new_text}.
// Hidden from the LLM schema; lets old persisted conversations replay.
for (let i = 0; i < params.changes.length; i++) {
  const b = params.changes[i];
  if (b && typeof b === "object") {
    if (b.old_text === undefined && b.search !== undefined) b.old_text = b.search;
    if (b.new_text === undefined && b.replace !== undefined) b.new_text = b.replace;
  }
}

// Validate change blocks
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (typeof block?.old_text !== "string" || typeof block?.new_text !== "string") {
    throw new Error(\`Edit \${i + 1} is missing required 'old_text' or 'new_text' property\`);
  }
  if (block.old_text === "") {
    throw new Error(\`Edit \${i + 1} has an empty old_text string. The text to find must be non-empty.\`);
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
// if any edit doesn't match (or matches ambiguously), the callback
// throws and vault.process writes nothing.
let failedBlockIndex = -1;
let failedOldText = "";
let failedReason = "";
let failedCount = 0;
const noOpBlocks = [];

try {
  await app.vault.process(file, (data: string) => {
    let modified = data;
    for (let i = 0; i < params.changes.length; i++) {
      const block = params.changes[i];
      if (!block) continue;
      // No-op edit (old_text === new_text) changes nothing — record a warning and skip.
      // Skipping before matching ensures a harmless no-op can never abort other changes.
      if (block.old_text === block.new_text) {
        if (!noOpBlocks.includes(i + 1)) noOpBlocks.push(i + 1);
        continue;
      }
      const result = utils.resilientIndexOf(modified, block.old_text);
      if (!result.ok) {
        failedBlockIndex = i + 1;
        failedOldText = block.old_text;
        failedReason = result.reason;
        failedCount = result.count || 0;
        throw new Error(\`Edit \${i + 1} did not match uniquely\`);
      }
      const match = result.match;
      modified =
        modified.slice(0, match.index) +
        block.new_text +
        modified.slice(match.index + match.length);
    }
    return modified;
  });
} catch (e: any) {
  if (failedBlockIndex !== -1) {
    const preview = failedOldText.length > 80
      ? failedOldText.slice(0, 80) + "..."
      : failedOldText;
    const errorMsg = failedReason === "not_unique"
      ? \`Edit \${failedBlockIndex} matched \${failedCount} locations in \${params.path}. Add surrounding context (2–4 lines) so it matches exactly one place. No changes were applied. The text to find was: "\${preview}"\`
      : \`Edit \${failedBlockIndex} did not match any text in \${params.path}. No changes were applied. The text to find was: "\${preview}"\`;
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
  msg += \` ⚠️ Edit(s) \${noOpBlocks.join(", ")} were no-ops (the find and replacement text were identical) — those edits did NOT change the note.\`;
}
return msg;`,
);
