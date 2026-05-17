import { scaffold } from "./_scaffold-helper";

export const READ_FRONTMATTER = scaffold(
	"read_frontmatter",
	"Read the parsed YAML frontmatter of a note as structured key-value data.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note`,
	`const log = utils.logger("read_frontmatter");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Reading frontmatter", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

const cache = app.metadataCache.getFileCache(file);
if (!cache?.frontmatter) {
  log.debug("No frontmatter found", { path: params.path });
  return {};
}

const { position: _, ...frontmatter } = cache.frontmatter;
log.info("Read frontmatter", { path: params.path, keyCount: Object.keys(frontmatter).length });
return frontmatter;`,
);
