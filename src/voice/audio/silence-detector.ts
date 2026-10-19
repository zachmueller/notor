/**
 * Silence detector — a pure RMS state machine over mono PCM frames.
 *
 * Timing is measured in samples, not wall-clock time, so background-window
 * timer throttling cannot skew the end-of-turn pause. Two onset modes:
 *
 * - `listening`: a few consecutive loud frames start an utterance.
 * - `speaking`: Notor's own text-to-speech is playing; onset needs a higher
 *   threshold sustained for `bargeInSustainMs`, so speaker output leaking
 *   into the microphone does not trigger the loop on itself. The sustained
 *   audio is kept (via the pre-roll ring), so a barge-in utterance is not
 *   missing its first word.
 *
 * Once an utterance is in progress both modes accumulate identically and end
 * it after `pauseMs` of silence; switching modes never drops captured audio.
 * Listening continues after an utterance ends.
 *
 * @see docs/voice.md
 */

export type DetectorMode = "listening" | "speaking";

export interface SilenceDetectorOptions {
	/** Sample rate of the incoming frames, in Hz. */
	sampleRate: number;
	/** RMS level (0–1) at or above which a frame counts as speech. */
	threshold: number;
	/** Silence after speech that ends the utterance. */
	pauseMs: number;
	/** Utterances with less speech than this are discarded as noise. */
	minUtteranceMs: number;
	/** Audio kept from before the detected onset. Default 300. */
	preRollMs?: number;
	/** Emit `silence_timeout` after this much continuous silence with no speech; 0 = off. */
	stopOnSilenceMs?: number;
	/** In `speaking` mode, speech must exceed `threshold × multiplier`. Default 3. */
	bargeInThresholdMultiplier?: number;
	/** In `speaking` mode, loudness must be sustained this long. Default 400. */
	bargeInSustainMs?: number;
	/** Consecutive loud frames that confirm onset in `listening` mode. Default 2. */
	onsetFrames?: number;
	/** Force an utterance boundary after this much audio. Default 90 000. */
	maxUtteranceMs?: number;
}

export type DetectorEvent =
	| { type: "speech_start" }
	| { type: "utterance_end"; samples: Float32Array; durationMs: number; peakLevel: number }
	| { type: "utterance_discarded"; durationMs: number }
	| { type: "silence_timeout" };

/** Root-mean-square level of a frame (0 for an empty frame). */
export function rms(frame: Float32Array): number {
	if (frame.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < frame.length; i++) {
		const s = frame[i]!;
		sum += s * s;
	}
	return Math.sqrt(sum / frame.length);
}

/** Copy the first `total` samples of `chunks` into one contiguous array. */
function concat(chunks: Float32Array[], total: number): Float32Array {
	const out = new Float32Array(Math.max(0, total));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= out.length) break;
		const take = Math.min(chunk.length, out.length - offset);
		out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
		offset += take;
	}
	return out;
}

export class SilenceDetector {
	private mode: DetectorMode = "listening";
	private inSpeech = false;
	private loudStreak = 0;
	/** Samples since the last loud frame while in speech. */
	private trailingSilence = 0;
	/** Samples of silence with no speech at all (stop-on-silence). */
	private idleSilence = 0;
	/** Sustained loud samples while in `speaking` mode. */
	private bargeLoud = 0;
	private chunks: Float32Array[] = [];
	private chunkSamples = 0;
	/** Pre-roll samples that preceded the onset audio. */
	private onsetPreRoll = 0;
	private peak = 0;
	private preRoll: Float32Array[] = [];
	private preRollSamples = 0;

	constructor(private readonly opts: SilenceDetectorOptions) {}

	get currentMode(): DetectorMode {
		return this.mode;
	}

	get isInSpeech(): boolean {
		return this.inSpeech;
	}

	/** Switch onset modes. An utterance already in progress keeps being captured. */
	setMode(mode: DetectorMode): void {
		if (mode === this.mode) return;
		this.mode = mode;
		this.loudStreak = 0;
		this.bargeLoud = 0;
	}

	reset(): void {
		this.resetSpeechState();
		this.idleSilence = 0;
		this.loudStreak = 0;
		this.bargeLoud = 0;
	}

	/** Feed one frame; returns the events it produced (usually none). */
	push(frame: Float32Array): DetectorEvent[] {
		const events: DetectorEvent[] = [];
		const n = frame.length;
		if (n === 0) return events;
		const level = rms(frame);

		if (!this.inSpeech) {
			this.pushPreRoll(frame);

			if (this.mode === "speaking") {
				const barge = this.opts.threshold * (this.opts.bargeInThresholdMultiplier ?? 3);
				if (level >= barge) {
					this.bargeLoud += n;
					if (this.bargeLoud >= this.samplesOf(this.opts.bargeInSustainMs ?? 400)) {
						this.enterSpeech(level, this.bargeLoud);
						events.push({ type: "speech_start" });
					}
				} else {
					this.bargeLoud = 0;
				}
				return events;
			}

			if (level >= this.opts.threshold) {
				this.loudStreak++;
				this.idleSilence = 0;
				if (this.loudStreak >= (this.opts.onsetFrames ?? 2)) {
					this.enterSpeech(level, this.loudStreak * n);
					events.push({ type: "speech_start" });
				}
			} else {
				this.loudStreak = 0;
				const stopMs = this.opts.stopOnSilenceMs ?? 0;
				if (stopMs > 0) {
					this.idleSilence += n;
					if (this.idleSilence >= this.samplesOf(stopMs)) {
						this.idleSilence = 0;
						events.push({ type: "silence_timeout" });
					}
				}
			}
			return events;
		}

		// In speech: accumulate until the pause (or the length cap) ends it.
		this.chunks.push(frame);
		this.chunkSamples += n;
		if (level >= this.opts.threshold) {
			this.trailingSilence = 0;
			if (level > this.peak) this.peak = level;
		} else {
			this.trailingSilence += n;
		}

		const pauseSamples = this.samplesOf(this.opts.pauseMs);
		const maxSamples = this.samplesOf(this.opts.maxUtteranceMs ?? 90_000);
		if (this.trailingSilence >= pauseSamples || this.chunkSamples >= maxSamples) {
			events.push(this.finishUtterance());
		}
		return events;
	}

	private enterSpeech(level: number, loudSamples: number): void {
		this.inSpeech = true;
		this.chunks = [...this.preRoll];
		this.chunkSamples = this.preRollSamples;
		this.onsetPreRoll = Math.max(0, this.preRollSamples - loudSamples);
		this.trailingSilence = 0;
		this.peak = level;
		this.preRoll = [];
		this.preRollSamples = 0;
		this.loudStreak = 0;
		this.bargeLoud = 0;
	}

	private finishUtterance(): DetectorEvent {
		// Keep at most ~500 ms of trailing silence so the recognizer sees a clean tail.
		const keepTail = Math.min(this.trailingSilence, this.samplesOf(500));
		const total = this.chunkSamples - (this.trailingSilence - keepTail);
		const speechSamples = this.chunkSamples - this.trailingSilence - this.onsetPreRoll;
		const durationMs = this.ms(Math.max(0, speechSamples));
		const samples = concat(this.chunks, total);
		const peakLevel = this.peak;
		this.resetSpeechState();
		if (durationMs < this.opts.minUtteranceMs) {
			return { type: "utterance_discarded", durationMs };
		}
		return { type: "utterance_end", samples, durationMs, peakLevel };
	}

	private pushPreRoll(frame: Float32Array): void {
		// In speaking mode the ring must also hold the barge-in sustain window.
		const extra = this.mode === "speaking" ? (this.opts.bargeInSustainMs ?? 400) : 0;
		const limit = this.samplesOf((this.opts.preRollMs ?? 300) + extra);
		this.preRoll.push(frame);
		this.preRollSamples += frame.length;
		while (this.preRoll.length > 1 && this.preRollSamples - this.preRoll[0]!.length >= limit) {
			this.preRollSamples -= this.preRoll.shift()!.length;
		}
	}

	private resetSpeechState(): void {
		this.inSpeech = false;
		this.trailingSilence = 0;
		this.chunks = [];
		this.chunkSamples = 0;
		this.onsetPreRoll = 0;
		this.peak = 0;
		this.preRoll = [];
		this.preRollSamples = 0;
	}

	private ms(samples: number): number {
		return (samples / this.opts.sampleRate) * 1000;
	}

	private samplesOf(ms: number): number {
		return Math.round((ms / 1000) * this.opts.sampleRate);
	}
}
