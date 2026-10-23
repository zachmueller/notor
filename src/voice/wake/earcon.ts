/**
 * Earcons — short non-speech cues for voice mode, synthesized with WebAudio
 * in the renderer (no asset files, no `say` round trip, so they play
 * instantly):
 *
 * - `arm`: two rising tones — voice mode is on and waiting for the wake word.
 * - `wake`: one bright blip — the wake word was heard; speak now.
 * - `disarm`: one soft falling tone — back to waiting, or voice mode is off.
 */

import type { VoiceEarcon } from "../voice-controller";

interface Tone {
	/** Start offset in seconds. */
	at: number;
	from: number;
	to: number;
	duration: number;
}

const TONES: Record<VoiceEarcon, Tone[]> = {
	arm: [
		{ at: 0, from: 660, to: 660, duration: 0.09 },
		{ at: 0.11, from: 880, to: 880, duration: 0.12 },
	],
	wake: [{ at: 0, from: 990, to: 1320, duration: 0.12 }],
	disarm: [{ at: 0, from: 660, to: 440, duration: 0.16 }],
};

const PEAK_GAIN = 0.12;

/** Plays earcons on one lazily created output context; `dispose` closes it. */
export class EarconPlayer {
	private context: AudioContext | null = null;

	play(kind: VoiceEarcon): void {
		const context = this.ensureContext();
		if (!context) return;
		if (context.state === "suspended") void context.resume().catch(() => undefined);
		const now = context.currentTime + 0.01;
		for (const tone of TONES[kind]) {
			const osc = context.createOscillator();
			const gain = context.createGain();
			const start = now + tone.at;
			const end = start + tone.duration;
			osc.type = "sine";
			osc.frequency.setValueAtTime(tone.from, start);
			osc.frequency.linearRampToValueAtTime(tone.to, end);
			// Short attack and release so the tone does not click.
			gain.gain.setValueAtTime(0, start);
			gain.gain.linearRampToValueAtTime(PEAK_GAIN, start + 0.01);
			gain.gain.setValueAtTime(PEAK_GAIN, end - 0.03);
			gain.gain.linearRampToValueAtTime(0, end);
			osc.connect(gain).connect(context.destination);
			osc.start(start);
			osc.stop(end + 0.02);
		}
	}

	dispose(): void {
		const context = this.context;
		this.context = null;
		// Let a just-started disarm tone finish before closing.
		if (context) setTimeout(() => void context.close().catch(() => undefined), 500);
	}

	private ensureContext(): AudioContext | null {
		if (this.context) return this.context;
		if (typeof AudioContext === "undefined") return null;
		try {
			this.context = new AudioContext();
		} catch {
			return null;
		}
		return this.context;
	}
}
