import { scaffold } from "./_scaffold-helper";

export const REPLACE_IN_FILE = scaffold(
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
    description: "Array of search/replace blocks to apply in sequence. Each block's search text must match exactly one location in the file (add surrounding context to disambiguate if it appears more than once)."
    properties:
      search:
        type: string
        description: "Text to find in the file. Leading/trailing and interior whitespace differences are tolerated, but the search must match a UNIQUE location — include 2–4 lines of surrounding context if the text appears multiple times."
      replace:
        type: string
        description: "Text to replace the matched search text with. Use empty string to delete the matched text."
    required_items:
      - search
      - replace
settings:
  replace_in_file_return_full_content_on_failure:
    name: "Return Full File Content on Failure"
    type: boolean
    description: "When a replace fails (no match or ambiguous match), include the file's full current content in the error so the model can self-correct without re-reading. Disable to save context window."
    default: true
  replace_in_file_failure_content_max_chars:
    name: "Max Failure-Content Characters"
    type: number
    description: "When returning full content on failure, truncate it to this many characters (a marker notes the cut). Prevents large files from flooding the context window."
    default: 20000
    min: 1000
    max: 500000`,
	`const log = utils.logger("replace_in_file");

const buildFailureResult = (errorMsg, fullContent) => {
  if (!settings.replace_in_file_return_full_content_on_failure) {
    return "Error: " + errorMsg + "\\n\\n(Full file content omitted by setting — re-read the file to see current content.)";
  }
  const cap = settings.replace_in_file_failure_content_max_chars;
  let body = fullContent;
  if (typeof cap === "number" && body.length > cap) {
    body = body.slice(0, cap) + "\\n\\n…[truncated " + (body.length - cap) + " chars — re-read the file for full content]";
  }
  return "Error: " + errorMsg + "\\n\\n---\\nCurrent file content:\\n\\n" + body;
};

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

const originalContent = buf.toString("utf-8");
let content = originalContent;

// Apply SEARCH/REPLACE blocks sequentially in memory (atomic: all must match before write)
const noOpBlocks = [];
for (let i = 0; i < params.changes.length; i++) {
  const block = params.changes[i];
  if (!block) continue;
  // No-op block (search === replace) changes nothing — record a warning and skip.
  // Skipping before matching ensures a harmless no-op can never abort other changes.
  if (block.search === block.replace) {
    noOpBlocks.push(i + 1);
    continue;
  }
  const result = utils.resilientIndexOf(content, block.search);
  if (!result.ok) {
    const preview = block.search.length > 80
      ? block.search.slice(0, 80) + "..."
      : block.search;
    const errorMsg = result.reason === "not_unique"
      ? \`Search block \${i + 1} matched \${result.count} locations in \${params.path}. Add surrounding context (2–4 lines) so it matches exactly one place. No changes were applied. The search text was: "\${preview}"\`
      : \`Search block \${i + 1} did not match any text in \${params.path}. No changes were applied. The search text was: "\${preview}"\`;
    // Auto-return the current file content so the model can correct without re-reading.
    return {
      __toolError: true,
      error: errorMsg,
      result: buildFailureResult(errorMsg, originalContent),
    };
  }
  const match = result.match;
  content = content.slice(0, match.index) + block.replace + content.slice(match.index + match.length);
}

// All blocks matched — write
await libs.fs.promises.writeFile(resolvedPath, content, "utf-8");

log.info("Applied replacements", { path: resolvedPath, count: params.changes.length, noOps: noOpBlocks.length });
const applied = params.changes.length - noOpBlocks.length;
let msg = \`Applied \${applied} replacement\${applied === 1 ? "" : "s"} to \${resolvedPath}\`;
if (noOpBlocks.length) {
  msg += \` ⚠️ Block(s) \${noOpBlocks.join(", ")} were no-ops (search and replace text were identical) — those edits did NOT change the file.\`;
}
return msg;`,
);
