import { describe, it, expect } from "vitest";
import { SilenceDetector, rms, type DetectorEvent } from "./silence-detector";

const RATE = 16_000;
/** 10 ms frames. */
const FRAME = 160;

function frame(level: number, length = FRAME): Float32Array {
	return new Float32Array(length).fill(level);
}

function feed(detector: SilenceDetector, level: number, ms: number): DetectorEvent[] {
	const events: DetectorEvent[] = [];
	const frames = Math.round((ms / 1000) * RATE / FRAME);
	for (let i = 0; i < frames; i++) events.push(...detector.push(frame(level)));
	return events;
}

function make(overrides: Partial<ConstructorParameters<typeof SilenceDetector>[0]> = {}) {
	return new SilenceDetector({
		sampleRate: RATE,
		threshold: 0.02,
		pauseMs: 2500,
		minUtteranceMs: 600,
		...overrides,
	});
}

function utteranceEnd(events: DetectorEvent[]): Extract<DetectorEvent, { type: "utterance_end" }> {
	const end = events.find((e) => e.type === "utterance_end");
	if (end?.type !== "utterance_end") throw new Error("expected utterance_end");
	return end;
}

const countNear = (samples: Float32Array, value: number) =>
	samples.reduce((n, v) => (Math.abs(v - value) < 1e-6 ? n + 1 : n), 0);

describe("rms", () => {
	it("returns the amplitude of a constant frame and 0 for an empty one", () => {
		expect(rms(frame(0.5))).toBeCloseTo(0.5, 6);
		expect(rms(new Float32Array(0))).toBe(0);
	});
});

describe("SilenceDetector — listening mode", () => {
	it("emits speech_start once onset is confirmed and ends the utterance after the pause", () => {
		const d = make();
		expect(feed(d, 0, 1000)).toEqual([]);
		const onset = feed(d, 0.1, 1000);
		expect(onset.filter((e) => e.type === "speech_start")).toHaveLength(1);
		expect(d.isInSpeech).toBe(true);

		expect(feed(d, 0, 2400)).toEqual([]);
		const ended = utteranceEnd(feed(d, 0, 200));
		expect(d.isInSpeech).toBe(false);
		// ~1 s of speech, with the pre-roll excluded from the duration estimate.
		expect(ended.durationMs).toBeGreaterThan(900);
		expect(ended.durationMs).toBeLessThan(1100);
		expect(ended.peakLevel).toBeCloseTo(0.1, 5);
		// Captured audio = pre-roll (≤300 ms) + speech (1 s) + at most 500 ms of trailing silence.
		expect(ended.samples.length).toBeGreaterThanOrEqual(RATE + 0.5 * RATE - FRAME);
		expect(ended.samples.length).toBeLessThanOrEqual(RATE + 0.5 * RATE + 0.3 * RATE + 2 * FRAME);
	});

	it("includes pre-roll audio before the onset", () => {
		const d = make({ preRollMs: 300 });
		// Quiet-but-nonzero audio so we can find it in the capture.
		feed(d, 0.001, 1000);
		feed(d, 0.1, 700);
		const end = utteranceEnd(feed(d, 0, 2600));
		// The first samples are the quiet pre-roll, not the loud speech.
		expect(end.samples[0]).toBeCloseTo(0.001, 6);
		expect(countNear(end.samples, 0.1)).toBe(Math.round(0.7 * RATE));
	});

	it("discards utterances shorter than the minimum", () => {
		const d = make({ minUtteranceMs: 600 });
		feed(d, 0.1, 200);
		const events = feed(d, 0, 2600);
		expect(events.some((e) => e.type === "utterance_discarded")).toBe(true);
		expect(events.some((e) => e.type === "utterance_end")).toBe(false);
	});

	it("keeps listening after an utterance ends", () => {
		const d = make();
		feed(d, 0.1, 1000);
		feed(d, 0, 2600);
		const again = [...feed(d, 0.1, 1000), ...feed(d, 0, 2600)];
		expect(again.filter((e) => e.type === "speech_start")).toHaveLength(1);
		expect(again.filter((e) => e.type === "utterance_end")).toHaveLength(1);
	});

	it("forces an utterance boundary at the maximum length and continues capturing", () => {
		const d = make({ maxUtteranceMs: 1000, minUtteranceMs: 100 });
		const events = feed(d, 0.1, 2500);
		expect(events.filter((e) => e.type === "utterance_end").length).toBeGreaterThanOrEqual(2);
	});

	it("emits silence_timeout only when stop-on-silence is enabled", () => {
		const off = make();
		expect(feed(off, 0, 5000)).toEqual([]);

		const on = make({ stopOnSilenceMs: 1000 });
		const events = feed(on, 0, 2050);
		expect(events.filter((e) => e.type === "silence_timeout")).toHaveLength(2);
	});

	it("resets the idle-silence counter when speech happens", () => {
		const d = make({ stopOnSilenceMs: 1000 });
		feed(d, 0, 800);
		feed(d, 0.1, 700);
		const events = feed(d, 0, 2600); // ends the utterance; ~100 ms of post-utterance idle silence
		expect(events.some((e) => e.type === "silence_timeout")).toBe(false);
	});
});

describe("SilenceDetector — speaking mode (barge-in)", () => {
	it("ignores audio below the raised threshold", () => {
		const d = make({ bargeInThresholdMultiplier: 3, bargeInSustainMs: 400 });
		d.setMode("speaking");
		expect(feed(d, 0.05, 2000)).toEqual([]); // 2.5× threshold: below 3×
		expect(d.isInSpeech).toBe(false);
	});

	it("requires the loudness to be sustained", () => {
		const d = make({ bargeInThresholdMultiplier: 3, bargeInSustainMs: 400 });
		d.setMode("speaking");
		expect(feed(d, 0.1, 390)).toEqual([]);
		feed(d, 0, 100);
		expect(feed(d, 0.1, 200)).toEqual([]);
		expect(d.isInSpeech).toBe(false);
	});

	it("starts an utterance after sustained loud audio and keeps the sustain window", () => {
		const d = make({ bargeInThresholdMultiplier: 3, bargeInSustainMs: 400 });
		d.setMode("speaking");
		expect(feed(d, 0.1, 390)).toEqual([]);
		expect(feed(d, 0.1, 20)).toEqual([{ type: "speech_start" }]);
		expect(d.isInSpeech).toBe(true);

		feed(d, 0.1, 600);
		const end = utteranceEnd(feed(d, 0, 2600));
		// All ~1010 ms of loud audio made it into the capture, including the sustain window.
		expect(countNear(end.samples, 0.1)).toBe(Math.round(1.01 * RATE));
		expect(end.durationMs).toBeGreaterThan(900);
	});

	it("keeps capturing an in-progress utterance across mode switches", () => {
		const d = make();
		feed(d, 0.1, 500);
		expect(d.isInSpeech).toBe(true);
		d.setMode("speaking");
		feed(d, 0.1, 500);
		expect(d.isInSpeech).toBe(true);
		d.setMode("listening");
		const end = utteranceEnd(feed(d, 0, 2600));
		expect(end.durationMs).toBeGreaterThan(900);
		expect(end.durationMs).toBeLessThan(1100);
	});

	it("reset drops a partial utterance", () => {
		const d = make();
		feed(d, 0.1, 500);
		d.reset();
		expect(d.isInSpeech).toBe(false);
		expect(feed(d, 0, 3000)).toEqual([]);
	});
});
