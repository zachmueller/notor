import { scaffold } from "./_scaffold-helper";

export const GET_OUTLINKS = scaffold(
	"get_outlinks",
	"Returns all notes that the specified note links TO.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the note relative to vault root."
    path_namespace: vault
    path_resolve_as: note`,
	`const log = utils.logger("get_outlinks");

if (!params.path || typeof params.path !== "string") {
  throw new Error("Missing required parameter: path");
}

log.debug("Getting outlinks", { path: params.path });

const file = utils.resolveNote(params.path);
if (!file) throw new Error(\`Note not found: \${params.path}\`);

const resolvedMap = app.metadataCache.resolvedLinks[file.path] ?? {};
const unresolvedMap = app.metadataCache.unresolvedLinks[file.path] ?? {};

// Filter out self-links
const resolvedPaths = Object.keys(resolvedMap).filter((p) => p !== file.path);
const unresolvedLinkNames = Object.keys(unresolvedMap);

log.debug("Got outlinks", {
  path: file.path,
  resolved: resolvedPaths.length,
  unresolved: unresolvedLinkNames.length,
});

const resolvedSection = resolvedPaths.length > 0 ? resolvedPaths.join("\\n") : "(none)";
const unresolvedSection = unresolvedLinkNames.length > 0 ? unresolvedLinkNames.join("\\n") : "(none)";
return \`Resolved:\\n\${resolvedSection}\\n\\nUnresolved:\\n\${unresolvedSection}\`;`,
);
