/**
 * WAV encoding for speech recognition input.
 *
 * whisper.cpp expects 16 kHz, 16-bit, mono PCM. Capture normally runs at
 * 16 kHz already; when the audio context refused that rate the samples are
 * linearly resampled here.
 */

export const WAV_SAMPLE_RATE = 16000;

/** Linear-interpolation resampler (adequate for speech at these rates). */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
	if (fromRate === toRate || samples.length === 0) return samples;
	const ratio = fromRate / toRate;
	const outLength = Math.max(1, Math.round(samples.length / ratio));
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = samples[Math.min(idx, samples.length - 1)]!;
		const b = samples[Math.min(idx + 1, samples.length - 1)]!;
		out[i] = a + (b - a) * frac;
	}
	return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encode Float32 samples as a 16 kHz 16-bit mono RIFF/WAVE buffer. */
export function encodeWav16kMono(samples: Float32Array, inputRate: number = WAV_SAMPLE_RATE): ArrayBuffer {
	const pcm = resampleLinear(samples, inputRate, WAV_SAMPLE_RATE);
	const dataBytes = pcm.length * 2;
	const buffer = new ArrayBuffer(44 + dataBytes);
	const view = new DataView(buffer);

	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, WAV_SAMPLE_RATE, true);
	view.setUint32(28, WAV_SAMPLE_RATE * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeAscii(view, 36, "data");
	view.setUint32(40, dataBytes, true);

	let offset = 44;
	for (let i = 0; i < pcm.length; i++) {
		const clamped = Math.max(-1, Math.min(1, pcm[i]!));
		view.setInt16(offset, Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff), true);
		offset += 2;
	}
	return buffer;
}
