import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseImageDimensions, resolveImageForDocx } from "./docx-image-utils";

// ---------------------------------------------------------------------------
// parseImageDimensions
// ---------------------------------------------------------------------------

describe("parseImageDimensions", () => {
	describe("PNG", () => {
		it("parses dimensions from IHDR chunk (bytes 16-23)", () => {
			const buf = Buffer.alloc(24);
			// PNG magic
			buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
			// Width = 800 at bytes 16-19 (big-endian)
			buf.writeUInt32BE(800, 16);
			// Height = 600 at bytes 20-23 (big-endian)
			buf.writeUInt32BE(600, 20);
			expect(parseImageDimensions(buf, "image/png")).toEqual({ width: 800, height: 600 });
		});

		it("returns null for buffer too small", () => {
			const buf = Buffer.alloc(20);
			expect(parseImageDimensions(buf, "image/png")).toBeNull();
		});

		it("returns null for zero dimensions", () => {
			const buf = Buffer.alloc(24);
			buf.writeUInt32BE(0, 16);
			buf.writeUInt32BE(600, 20);
			expect(parseImageDimensions(buf, "image/png")).toBeNull();
		});
	});

	describe("JPEG", () => {
		it("parses dimensions from SOF0 marker", () => {
			// Minimal JPEG with SOI + SOF0 marker
			const buf = Buffer.alloc(32);
			// SOI
			buf[0] = 0xff; buf[1] = 0xd8;
			// SOF0 marker
			buf[2] = 0xff; buf[3] = 0xc0;
			// Segment length
			buf.writeUInt16BE(17, 4);
			// Precision
			buf[6] = 8;
			// Height = 480 at offset 7
			buf.writeUInt16BE(480, 7);
			// Width = 640 at offset 9
			buf.writeUInt16BE(640, 9);
			expect(parseImageDimensions(buf, "image/jpeg")).toEqual({ width: 640, height: 480 });
		});

		it("parses dimensions from SOF2 marker", () => {
			const buf = Buffer.alloc(32);
			buf[0] = 0xff; buf[1] = 0xd8;
			buf[2] = 0xff; buf[3] = 0xc2;
			buf.writeUInt16BE(17, 4);
			buf[6] = 8;
			buf.writeUInt16BE(1080, 7);
			buf.writeUInt16BE(1920, 9);
			expect(parseImageDimensions(buf, "image/jpeg")).toEqual({ width: 1920, height: 1080 });
		});

		it("skips non-SOF segments to find SOF0", () => {
			// SOI(2) + APP0 marker(2) + segment(10) = next marker at offset 14
			const buf = Buffer.alloc(48);
			buf[0] = 0xff; buf[1] = 0xd8;
			// APP0 segment (to skip): marker + length + payload
			buf[2] = 0xff; buf[3] = 0xe0;
			buf.writeUInt16BE(10, 4); // segment length = 10 (includes length bytes)
			// SOF0 at offset 2 + 2 + 10 = 14
			buf[14] = 0xff; buf[15] = 0xc0;
			buf.writeUInt16BE(17, 16);
			buf[18] = 8;
			buf.writeUInt16BE(300, 19);
			buf.writeUInt16BE(400, 21);
			expect(parseImageDimensions(buf, "image/jpeg")).toEqual({ width: 400, height: 300 });
		});

		it("returns null for corrupt JPEG (no SOF marker)", () => {
			const buf = Buffer.alloc(16);
			buf[0] = 0xff; buf[1] = 0xd8;
			// No valid markers after SOI
			buf[2] = 0x00; buf[3] = 0x00;
			expect(parseImageDimensions(buf, "image/jpeg")).toBeNull();
		});
	});

	describe("GIF", () => {
		it("parses dimensions from bytes 6-9 (little-endian)", () => {
			const buf = Buffer.alloc(16);
			// GIF magic
			buf[0] = 0x47; buf[1] = 0x49; buf[2] = 0x46;
			buf[3] = 0x38; buf[4] = 0x39; buf[5] = 0x61; // GIF89a
			// Width = 320 at bytes 6-7 (little-endian)
			buf.writeUInt16LE(320, 6);
			// Height = 240 at bytes 8-9 (little-endian)
			buf.writeUInt16LE(240, 8);
			expect(parseImageDimensions(buf, "image/gif")).toEqual({ width: 320, height: 240 });
		});

		it("returns null for buffer too small", () => {
			const buf = Buffer.alloc(8);
			expect(parseImageDimensions(buf, "image/gif")).toBeNull();
		});
	});

	describe("BMP", () => {
		it("parses dimensions from bytes 18-25 (signed int32 LE)", () => {
			const buf = Buffer.alloc(26);
			// BMP magic
			buf[0] = 0x42; buf[1] = 0x4d;
			// Width = 1024 at bytes 18-21
			buf.writeInt32LE(1024, 18);
			// Height = 768 at bytes 22-25
			buf.writeInt32LE(768, 22);
			expect(parseImageDimensions(buf, "image/bmp")).toEqual({ width: 1024, height: 768 });
		});

		it("handles negative height (top-down BMP)", () => {
			const buf = Buffer.alloc(26);
			buf[0] = 0x42; buf[1] = 0x4d;
			buf.writeInt32LE(512, 18);
			buf.writeInt32LE(-256, 22);
			expect(parseImageDimensions(buf, "image/bmp")).toEqual({ width: 512, height: 256 });
		});
	});

	describe("unsupported format", () => {
		it("returns null for unknown MIME type", () => {
			const buf = Buffer.alloc(32);
			expect(parseImageDimensions(buf, "image/tiff")).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// resolveImageForDocx
// ---------------------------------------------------------------------------

describe("resolveImageForDocx", () => {
	const vaultRoot = "/test/vault";
	const allowedPaths: string[] = ["/test/external"];

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects HTTP URLs", async () => {
		const result = await resolveImageForDocx("https://example.com/img.png", vaultRoot, allowedPaths);
		expect(result).toBeNull();
	});

	it("rejects http URLs", async () => {
		const result = await resolveImageForDocx("http://example.com/img.png", vaultRoot, allowedPaths);
		expect(result).toBeNull();
	});

	it("resolves a PNG data URI", async () => {
		// Create a minimal valid PNG buffer (8-byte signature + 25-byte IHDR)
		const pngBuf = Buffer.alloc(33);
		// PNG signature
		pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47;
		pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a;
		// IHDR chunk: length 13
		pngBuf.writeUInt32BE(13, 8);
		// "IHDR"
		pngBuf[12] = 0x49; pngBuf[13] = 0x48; pngBuf[14] = 0x44; pngBuf[15] = 0x52;
		// Width = 100
		pngBuf.writeUInt32BE(100, 16);
		// Height = 50
		pngBuf.writeUInt32BE(50, 20);

		const base64 = pngBuf.toString("base64");
		const dataUri = `data:image/png;base64,${base64}`;
		const result = await resolveImageForDocx(dataUri, vaultRoot, allowedPaths);

		expect(result).not.toBeNull();
		expect(result!.type).toBe("png");
		expect(result!.width).toBe(100);
		expect(result!.height).toBe(50);
	});

	it("returns null for malformed data URI", async () => {
		const result = await resolveImageForDocx("data:badformat", vaultRoot, allowedPaths);
		expect(result).toBeNull();
	});

	it("resolves a JPEG data URI", async () => {
		// Minimal JPEG-like buffer with SOI + SOF0
		const jpegBuf = Buffer.alloc(32);
		jpegBuf[0] = 0xff; jpegBuf[1] = 0xd8; jpegBuf[2] = 0xff;
		// SOF0
		jpegBuf[2] = 0xff; jpegBuf[3] = 0xc0;
		jpegBuf.writeUInt16BE(17, 4);
		jpegBuf[6] = 8;
		jpegBuf.writeUInt16BE(200, 7);
		jpegBuf.writeUInt16BE(300, 9);

		const base64 = jpegBuf.toString("base64");
		const dataUri = `data:image/jpeg;base64,${base64}`;
		const result = await resolveImageForDocx(dataUri, vaultRoot, allowedPaths);

		expect(result).not.toBeNull();
		expect(result!.type).toBe("jpg");
		expect(result!.width).toBe(300);
		expect(result!.height).toBe(200);
	});

	it("returns null for unsupported image format in data URI", async () => {
		// Buffer that doesn't match any known image magic bytes
		const buf = Buffer.from("not an image at all, just text", "utf-8");
		const base64 = buf.toString("base64");
		// MIME says TIFF but magic bytes don't match anything known
		const dataUri = `data:image/tiff;base64,${base64}`;
		const result = await resolveImageForDocx(dataUri, vaultRoot, allowedPaths);
		expect(result).toBeNull();
	});

	it("resolves a file path within vault root", async () => {
		const fs = await import("fs");
		// Create a PNG buffer
		const pngBuf = Buffer.alloc(33);
		pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47;
		pngBuf[4] = 0x0d; pngBuf[5] = 0x0a; pngBuf[6] = 0x1a; pngBuf[7] = 0x0a;
		pngBuf.writeUInt32BE(13, 8);
		pngBuf[12] = 0x49; pngBuf[13] = 0x48; pngBuf[14] = 0x44; pngBuf[15] = 0x52;
		pngBuf.writeUInt32BE(200, 16);
		pngBuf.writeUInt32BE(150, 20);

		vi.spyOn(fs.promises, "readFile").mockResolvedValue(pngBuf);

		const result = await resolveImageForDocx("images/test.png", vaultRoot, allowedPaths);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("png");
		expect(result!.width).toBe(200);
		expect(result!.height).toBe(150);
	});

	it("returns null when file not found", async () => {
		const fs = await import("fs");
		vi.spyOn(fs.promises, "readFile").mockRejectedValue(new Error("ENOENT"));

		const result = await resolveImageForDocx("images/missing.png", vaultRoot, allowedPaths);
		expect(result).toBeNull();
	});

	it("returns fallback dimensions when buffer dimensions cannot be parsed", async () => {
		const fs = await import("fs");
		// Create a BMP buffer too small for dimension parsing
		const bmpBuf = Buffer.alloc(16);
		bmpBuf[0] = 0x42; bmpBuf[1] = 0x4d;

		vi.spyOn(fs.promises, "readFile").mockResolvedValue(bmpBuf);

		const result = await resolveImageForDocx("/test/vault/test.bmp", vaultRoot, allowedPaths);
		expect(result).not.toBeNull();
		expect(result!.type).toBe("bmp");
		// Fallback dimensions
		expect(result!.width).toBe(400);
		expect(result!.height).toBe(300);
	});
});
