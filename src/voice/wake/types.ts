/**
 * Wake-word detector seam.
 *
 * The shipped implementation is a local sherpa-onnx keyword spotter run as a
 * sidecar; the interface keeps the controller testable and leaves room for
 * other *local* spotters. Cloud wake-word services are out of scope.
 */

import type { VoiceConfigProblem } from "../stt/types";

export type WakeStatus = "stopped" | "starting" | "ready" | "error";

export interface WakeHit {
	/** Label of the spotted keyword (e.g. "hey_notor"). */
	keyword: string;
	/**
	 * Samples pushed (since `start`) when the keyword was detected — at or just
	 * after the keyword's end. Same counter as the frames given to `push`.
	 */
	endSample: number;
}

export interface WakeWordDetector {
	readonly status: WakeStatus;
	/** Synchronous environment check; empty when the detector can start. */
	preflight(): VoiceConfigProblem[];
	/** Start the detector for frames at `sampleRate`; resolves when it accepts audio. */
	start(sampleRate: number): Promise<void>;
	/** Feed one mono PCM frame. Non-blocking; hits arrive via `onHit`. */
	push(frame: Float32Array): void;
	onHit(listener: (hit: WakeHit) => void): () => void;
	onStatus(listener: (status: WakeStatus, detail?: string) => void): () => void;
	/** Stop and release the detector. Safe to call repeatedly. */
	dispose(): Promise<void>;
	/** Restart in place (after system wake or a settings change). Optional. */
	restart?(): Promise<void>;
}
