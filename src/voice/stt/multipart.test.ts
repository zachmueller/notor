import { describe, it, expect } from "vitest";
import { encodeMultipart } from "./multipart";

function latin1(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (b) => String.fromCharCode(b)).join("");
}

describe("encodeMultipart", () => {
	it("encodes text fields and a binary file part with the given boundary", () => {
		const data = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0xff]);
		const { body, contentType } = encodeMultipart(
			[
				{ name: "file", filename: "utterance.wav", contentType: "audio/wav", data },
				{ name: "response_format", value: "json" },
			],
			"BOUNDARY",
		);

		expect(contentType).toBe("multipart/form-data; boundary=BOUNDARY");
		const text = latin1(body);
		expect(text.startsWith("--BOUNDARY\r\n")).toBe(true);
		expect(text).toContain('Content-Disposition: form-data; name="file"; filename="utterance.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF\u0000ÿ\r\n');
		expect(text).toContain('Content-Disposition: form-data; name="response_format"\r\n\r\njson\r\n');
		expect(text.endsWith("--BOUNDARY--\r\n")).toBe(true);
	});

	it("accepts an ArrayBuffer file payload and generates a unique boundary by default", () => {
		const a = encodeMultipart([{ name: "f", filename: "a.bin", contentType: "application/octet-stream", data: new ArrayBuffer(3) }]);
		const b = encodeMultipart([{ name: "f", filename: "a.bin", contentType: "application/octet-stream", data: new ArrayBuffer(3) }]);
		expect(a.contentType).toMatch(/^multipart\/form-data; boundary=----NotorVoice/);
		expect(a.contentType).not.toBe(b.contentType);
		expect(a.body.byteLength).toBeGreaterThan(3);
	});
});
