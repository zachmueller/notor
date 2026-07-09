import { scaffold } from "./_scaffold-helper";

export const WRITE_FILE = scaffold(
	"write_file",
	"Write text content to a file on the filesystem. For very large content (roughly 1,000+ words), first write a skeleton with placeholder markers, then fill each section with follow-up replace_in_file edits.",
	"write",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  content:
    type: string
    description: "Complete text content to write to the file."
  encoding:
    type: string
    description: "File encoding."
    default: "utf-8"`,
	`const log = utils.logger("write_file");

if (!params.path || typeof params.path !== "string" || params.path.trim() === "") {
  throw new Error("Missing required parameter: path");
}
if (params.content === undefined || params.content === null || typeof params.content !== "string") {
  throw new Error("Missing required parameter: content");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("write_file is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(params.path as string);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;
const content = params.content as string;
const encoding = (params.encoding as string) || "utf-8";

const MAX_CONTENT_BYTES = 5 * 1024 * 1024;
if (content.length > MAX_CONTENT_BYTES) {
  throw new Error("Content exceeds maximum size of 5 MB.");
}

// Create intermediate directories if they don't exist
await libs.fs.promises.mkdir(libs.path.dirname(resolvedPath), { recursive: true });

// Write the file
await libs.fs.promises.writeFile(resolvedPath, content, {
  encoding: encoding as BufferEncoding,
});

log.info("Wrote file", { path: resolvedPath, chars: content.length });
return \`Successfully wrote file: \${resolvedPath} (\${content.length} characters)\`;`,
);
