import { describe, it, expect } from "vitest";
import { detectMediaFormat } from "./format-detector";

describe("detectMediaFormat", () => {
	it("detects PNG", () => {
		const buf = Buffer.alloc(16);
		buf[0] = 0x89;
		buf[1] = 0x50;
		buf[2] = 0x4e;
		buf[3] = 0x47;
		expect(detectMediaFormat(buf)).toBe("png");
	});

	it("detects JPEG", () => {
		const buf = Buffer.alloc(16);
		buf[0] = 0xff;
		buf[1] = 0xd8;
		buf[2] = 0xff;
		expect(detectMediaFormat(buf)).toBe("jpeg");
	});

	it("detects GIF", () => {
		const buf = Buffer.alloc(16);
		buf[0] = 0x47;
		buf[1] = 0x49;
		buf[2] = 0x46;
		expect(detectMediaFormat(buf)).toBe("gif");
	});

	it("detects WebP", () => {
		const buf = Buffer.alloc(16);
		// RIFF
		buf[0] = 0x52;
		buf[1] = 0x49;
		buf[2] = 0x46;
		buf[3] = 0x46;
		// bytes 4-7: file size (ignored)
		buf[4] = 0x00;
		buf[5] = 0x00;
		buf[6] = 0x00;
		buf[7] = 0x00;
		// WEBP
		buf[8] = 0x57;
		buf[9] = 0x45;
		buf[10] = 0x42;
		buf[11] = 0x50;
		expect(detectMediaFormat(buf)).toBe("webp");
	});

	it("detects PDF", () => {
		const buf = Buffer.from("%PDF-1.4 ...", "ascii");
		expect(detectMediaFormat(buf)).toBe("pdf");
	});

	it("returns null for unknown binary", () => {
		const buf = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d]);
		expect(detectMediaFormat(buf)).toBeNull();
	});

	it("returns null for buffer too small", () => {
		const buf = Buffer.from([0x89, 0x50]);
		expect(detectMediaFormat(buf)).toBeNull();
	});

	it("does not false-positive RIFF without WEBP", () => {
		const buf = Buffer.alloc(16);
		buf[0] = 0x52;
		buf[1] = 0x49;
		buf[2] = 0x46;
		buf[3] = 0x46;
		// bytes 8-11: not WEBP
		buf[8] = 0x41;
		buf[9] = 0x56;
		buf[10] = 0x49;
		buf[11] = 0x20;
		expect(detectMediaFormat(buf)).toBeNull();
	});
});
