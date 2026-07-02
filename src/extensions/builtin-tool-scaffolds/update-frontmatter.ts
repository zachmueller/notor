import { scaffold } from "./_scaffold-helper";

export const UPDATE_FRONTMATTER = scaffold(
	"update_frontmatter",
	"Add, modify, or remove specific frontmatter properties.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
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
  await utils.checkpoints.create(file.path, "update_frontmatter", "");
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

// Update stale tracker so subsequent body-write tools don't false-positive
try {
  const updatedContent = await app.vault.read(file);
  utils.staleContent.updateAfterFrontmatterWrite(file.path, updatedContent);
} catch { /* non-fatal */ }

const setCount = set ? Object.keys(set).length : 0;
const removeCount = remove ? remove.length : 0;
const parts: string[] = [];
if (setCount > 0) parts.push(\`set \${setCount} propert\${setCount === 1 ? "y" : "ies"}\`);
if (removeCount > 0) parts.push(\`removed \${removeCount} propert\${removeCount === 1 ? "y" : "ies"}\`);

log.info("Updated frontmatter", { path: params.path, setCount, removeCount });
return \`Updated frontmatter on \${params.path}: \${parts.join(", ")}\`;`,
);
