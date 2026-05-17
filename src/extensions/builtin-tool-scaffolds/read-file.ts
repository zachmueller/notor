import { scaffold } from "./_scaffold-helper";

export const READ_FILE = scaffold(
	"read_file",
	"Read a text file, image, or PDF from the filesystem.",
	"read",
	`params:
  path:
    type: string
    description: "Path to the file. Vault-relative or absolute."
    path_namespace: filesystem
  encoding:
    type: string
    description: "File encoding."
    default: "utf-8"
  pages:
    type: string
    description: "Page range for PDF files (e.g. '1-5')."
settings:
  image_max_dimension:
    name: "Image Max Dimension"
    type: number
    description: "Maximum width or height in pixels. Images larger than this are resized proportionally."
    default: 2000
    min: 100
    max: 8000
  image_compression_quality:
    name: "Image Compression Quality"
    type: number
    description: "JPEG compression quality (1-100)."
    default: 80
    min: 1
    max: 100
  pdf_prefer_native:
    name: "Prefer Native PDF"
    type: boolean
    description: "Send PDFs as native document blocks when supported by the provider."
    default: true
  pdf_text_max_chars:
    name: "PDF Max Text Characters"
    type: number
    description: "Maximum characters to extract from PDF text content."
    default: 100000
    min: 1000
    max: 1000000
  pdf_native_max_size_mb:
    name: "PDF Native Max Size (MB)"
    type: number
    description: "Maximum PDF file size in MB for native document block processing."
    default: 10
    min: 1
    max: 100`,
	`const log = utils.logger("read_file");

const filePath = params.path as string;
const encoding = params.encoding as string | undefined;
const pages = params.pages as string | undefined;

if (!filePath || typeof filePath !== "string" || filePath.trim() === "") {
  throw new Error("Missing required parameter: path");
}

if (!obsidian.Platform.isDesktopApp) {
  throw new Error("read_file is only available on desktop.");
}

const pathResult = utils.resolveAndValidatePath(filePath);
if (!pathResult.valid) throw new Error(pathResult.error);

const resolvedPath = pathResult.resolvedPath;

// Check file existence
try {
  await libs.fs.promises.stat(resolvedPath);
} catch (e: any) {
  if (e.code === "ENOENT") throw new Error(\`File not found: \${resolvedPath}\`);
  throw e;
}

// Read raw buffer
const buf = await libs.fs.promises.readFile(resolvedPath);

// Detect binary via null bytes in first 8 KB
if (buf.subarray(0, 8192).includes(0)) {
  const format = utils.detectMediaFormat(buf);

  if (format === "png" || format === "jpeg" || format === "gif" || format === "webp") {
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error(\`Image file is too large (\${(buf.length / (1024 * 1024)).toFixed(1)} MB). Maximum raw input size is 50 MB.\`);
    }

    try {
      const mediaType = \`image/\${format}\` as any;
      const block = await utils.processImage(buf, mediaType, {
        maxDimension: settings.image_max_dimension as number,
        compressionQuality: settings.image_compression_quality as number,
      });
      const filename = resolvedPath.split("/").pop() ?? resolvedPath;
      const w = block.type === "image" ? block.width : undefined;
      const h = block.type === "image" ? block.height : undefined;

      log.info("Read image file", { path: resolvedPath, format, width: w, height: h });

      return {
        result: \`Read image: \${filename} (\${w}x\${h}, image/\${format})\`,
        content_blocks: [block],
      };
    } catch (e: any) {
      throw new Error(\`Failed to process image: \${e instanceof Error ? e.message : String(e)}\`);
    }
  }

  if (format === "pdf") {
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error(\`PDF file is too large (\${(buf.length / (1024 * 1024)).toFixed(1)} MB). Maximum raw input size is 50 MB.\`);
    }

    try {
      const result = await utils.processPdf(buf, {
        pages,
        maxTextChars: settings.pdf_text_max_chars as number,
        preferNative: settings.pdf_prefer_native as boolean,
      });
      const filename = resolvedPath.split("/").pop() ?? resolvedPath;

      log.info("Read PDF file", { path: resolvedPath, summary: result.textSummary });

      return {
        result: \`Read PDF: \${filename} — \${result.textSummary}\`,
        content_blocks: result.contentBlocks,
      };
    } catch (e: any) {
      throw new Error(\`Failed to process PDF: \${e instanceof Error ? e.message : String(e)}\`);
    }
  }

  throw new Error(
    "read_file only supports text-based files, images (PNG, JPEG, GIF, WebP), and PDFs. For Word documents, use read_docx instead."
  );
}

const content = buf.toString((encoding as BufferEncoding) ?? "utf-8");
log.info("Read file", { path: resolvedPath, bytes: buf.length });
return content;`,
);
