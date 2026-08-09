import { scaffold } from "./_scaffold-helper";

export const GET_BACKLINKS = scaffold(
	"get_backlinks",
	"Returns all notes in the vault that link TO the specified note.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note`,
	`const log = utils.logger("get_backlinks");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Getting backlinks", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

// Reverse-lookup: find all source files whose resolvedLinks include the target.
// Self-links are filtered out.
const targetPath = file.path;
const backlinks: string[] = [];
// Backlinks name *other* notes, so they are filtered against vault-read
// restrictions; the count is disclosed rather than silently dropped.
let hidden = 0;
for (const [sourcePath, links] of Object.entries(app.metadataCache.resolvedLinks)) {
  if (sourcePath !== targetPath && targetPath in links) {
    if (utils.pathFilter && !utils.pathFilter(sourcePath)) {
      hidden++;
      continue;
    }
    backlinks.push(sourcePath);
  }
}

log.debug("Got backlinks", { path: file.path, count: backlinks.length, hidden });

const suffix = hidden > 0 ? "\\n(" + hidden + " hidden by path restrictions)" : "";
return backlinks.length > 0 ? backlinks.join("\\n") + suffix : (hidden > 0 ? "(none visible)" + suffix : "(none)");`,
);
