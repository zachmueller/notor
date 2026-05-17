import { scaffold } from "./_scaffold-helper";

export const READ_DOCX = scaffold(
	"read_docx",
	"Read a .docx file and return its content as Markdown.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the .docx file. Vault-relative or absolute."
    path_namespace: filesystem`,
	`const log = utils.logger("read_docx");

const filePath = params.path as string;

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("read_docx is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;

if (libs.path.extname(resolvedPath).toLowerCase() !== ".docx") {
  throw new Error("read_docx only supports .docx files.");
}

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

const buf = await libs.fs.promises.readFile(resolvedPath);

// Build image extraction handler
const extractedImages: Array<{ index: number; vaultPath: string | null; alt: string }> = [];
let imageIndex = 0;
let duplicatesSkipped = 0;

// Determine if the input path is vault-relative (for attachment folder resolution)
const vaultFile = app.vault.getFileByPath(filePath);
const sourcePath: string | undefined = vaultFile ? vaultFile.path : undefined;

const supportedImageTypes = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);

const convertImage = libs.mammoth.images.imgElement(
  async (image: any) => {
    const idx = imageIndex++;
    const contentType = image.contentType;

    // Skip unsupported formats
    if (!supportedImageTypes.has(contentType)) {
      const formatName = contentType.replace("image/", "").toUpperCase();
      const alt = \`[Unsupported image format: \${formatName}]\`;
      extractedImages.push({ index: idx, vaultPath: null, alt });
      return { src: \`__notor_skip_\${idx}__\`, alt };
    }

    try {
      const imgBuffer = await image.readAsBuffer();
      const ext = (contentType.split("/")[1] ?? "bin").replace("jpeg", "jpg");
      const hash = libs.crypto.createHash("md5").update(imgBuffer).digest("hex");
      const filename = \`\${hash}.\${ext}\`;

      // Resolve target path via Obsidian's attachment folder logic
      const targetPath = await app.fileManager.getAvailablePathForAttachment(
        filename,
        sourcePath,
      );

      // Check if the file already exists at the resolved path
      const existing = app.vault.getFileByPath(targetPath);
      if (existing) {
        duplicatesSkipped++;
      } else {
        const arrayBuf = imgBuffer.buffer.slice(
          imgBuffer.byteOffset,
          imgBuffer.byteOffset + imgBuffer.byteLength,
        );
        await app.vault.createBinary(targetPath, arrayBuf);
      }

      extractedImages.push({ index: idx, vaultPath: targetPath, alt: filename });
      return { src: \`__notor_img_\${idx}__\`, alt: filename };
    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn("Image extraction failed", { index: idx, error: errMsg });
      extractedImages.push({ index: idx, vaultPath: null, alt: "[Image extraction failed]" });
      return { src: \`__notor_skip_\${idx}__\`, alt: "[Image extraction failed]" };
    }
  },
);

// Convert DOCX → HTML via mammoth (with image handler)
const { value: html } = await libs.mammoth.convertToHtml(
  { buffer: buf },
  { convertImage },
);

// Build a lookup from src marker → extracted image info
const imageMap = new Map<string, { vaultPath: string | null; alt: string }>();
for (const img of extractedImages) {
  imageMap.set(\`__notor_img_\${img.index}__\`, img);
  imageMap.set(\`__notor_skip_\${img.index}__\`, img);
}

// Convert HTML → Markdown via Turndown (local instance)
const td = new libs.Turndown({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});
td.use(libs.turndownGfm.gfm);
td.addRule("replaceImages", {
  filter: ["img"],
  replacement: (_content: string, node: any) => {
    const src = node.getAttribute("src") ?? "";
    const alt = node.getAttribute("alt") ?? "";

    if (src.startsWith("__notor_img_")) {
      const info = imageMap.get(src);
      if (info?.vaultPath) {
        return \`![\${alt}](\${info.vaultPath})\`;
      }
    }

    if (src.startsWith("__notor_skip_")) {
      return alt || "[image]";
    }

    return "[image]";
  },
});

const markdown = td.turndown(html);

const extractedCount = extractedImages.filter((i: any) => i.vaultPath !== null).length;
const skippedCount = extractedImages.filter((i: any) => i.vaultPath === null).length;
if (duplicatesSkipped > 0) {
  new obsidian.Notice(\`Skipped \${duplicatesSkipped} duplicate image(s) — already in vault\`);
}
log.info("Read docx", {
  path: resolvedPath,
  bytes: buf.length,
  imagesExtracted: extractedCount,
  imagesSkipped: skippedCount,
  duplicatesSkipped,
});

return markdown;`,
);
