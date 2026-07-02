import { scaffold } from "./_scaffold-helper";

export const MANAGE_TAGS = scaffold(
	"manage_tags",
	"Add or remove tags on a note via the frontmatter 'tags' property.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note
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
  await utils.checkpoints.create(file.path, "manage_tags", "");
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

// Update stale tracker so subsequent body-write tools don't false-positive
try {
  const updatedContent = await app.vault.read(file);
  utils.staleContent.updateAfterFrontmatterWrite(file.path, updatedContent);
} catch { /* non-fatal */ }

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
