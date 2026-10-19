import { describe, it, expect } from "vitest";
import { encodeWav16kMono, resampleLinear, WAV_SAMPLE_RATE } from "./wav-encoder";

function ascii(view: DataView, offset: number, length: number): string {
	let s = "";
	for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
	return s;
}

describe("encodeWav16kMono", () => {
	it("writes a valid 16 kHz mono 16-bit RIFF header", () => {
		const samples = new Float32Array([0, 0.5, -0.5, 1]);
		const buffer = encodeWav16kMono(samples);
		const view = new DataView(buffer);

		expect(buffer.byteLength).toBe(44 + samples.length * 2);
		expect(ascii(view, 0, 4)).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
		expect(ascii(view, 8, 4)).toBe("WAVE");
		expect(ascii(view, 12, 4)).toBe("fmt ");
		expect(view.getUint16(20, true)).toBe(1); // PCM
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(WAV_SAMPLE_RATE);
		expect(view.getUint32(28, true)).toBe(WAV_SAMPLE_RATE * 2);
		expect(view.getUint16(32, true)).toBe(2);
		expect(view.getUint16(34, true)).toBe(16);
		expect(ascii(view, 36, 4)).toBe("data");
		expect(view.getUint32(40, true)).toBe(samples.length * 2);
	});

	it("converts and clamps samples to int16", () => {
		const view = new DataView(encodeWav16kMono(new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5])));
		expect(view.getInt16(44, true)).toBe(0);
		expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 0x7fff));
		expect(view.getInt16(48, true)).toBe(Math.round(-0.5 * 0x8000));
		expect(view.getInt16(50, true)).toBe(0x7fff);
		expect(view.getInt16(52, true)).toBe(-0x8000);
		expect(view.getInt16(54, true)).toBe(0x7fff);
		expect(view.getInt16(56, true)).toBe(-0x8000);
	});

	it("resamples when the input rate differs", () => {
		const samples = new Float32Array(32_000).fill(0.25);
		const buffer = encodeWav16kMono(samples, 32_000);
		expect(new DataView(buffer).getUint32(40, true)).toBe(16_000 * 2);
	});
});

describe("resampleLinear", () => {
	it("returns the input untouched when rates match", () => {
		const samples = new Float32Array([1, 2, 3]);
		expect(resampleLinear(samples, 16_000, 16_000)).toBe(samples);
	});

	it("interpolates between neighbours when downsampling", () => {
		const out = resampleLinear(new Float32Array([0, 1, 2, 3]), 32_000, 16_000);
		expect(out.length).toBe(2);
		expect(out[0]).toBe(0);
		expect(out[1]).toBe(2);
	});
});
