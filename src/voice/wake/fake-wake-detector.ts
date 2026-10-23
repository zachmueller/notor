/**
 * In-memory wake-word detector for unit tests and the microphone-free test
 * seam: counts pushed samples and emits hits on request.
 */

import type { VoiceConfigProblem } from "../stt/types";
import type { WakeHit, WakeStatus, WakeWordDetector } from "./types";

export class FakeWakeDetector implements WakeWordDetector {
	status: WakeStatus = "stopped";
	problems: VoiceConfigProblem[] = [];
	samplesPushed = 0;
	disposed = false;
	restarted = 0;
	private readonly hitListeners = new Set<(hit: WakeHit) => void>();
	private readonly statusListeners = new Set<(status: WakeStatus, detail?: string) => void>();

	preflight(): VoiceConfigProblem[] {
		return this.problems;
	}

	start(): Promise<void> {
		this.status = "ready";
		return Promise.resolve();
	}

	push(frame: Float32Array): void {
		this.samplesPushed += frame.length;
	}

	onHit(listener: (hit: WakeHit) => void): () => void {
		this.hitListeners.add(listener);
		return () => {
			this.hitListeners.delete(listener);
		};
	}

	onStatus(listener: (status: WakeStatus, detail?: string) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	dispose(): Promise<void> {
		this.disposed = true;
		this.status = "stopped";
		return Promise.resolve();
	}

	restart(): Promise<void> {
		this.restarted++;
		return Promise.resolve();
	}

	/** Report a hit ending at `endSample` (default: everything pushed so far). */
	emitHit(endSample: number = this.samplesPushed, keyword = "hey_notor"): void {
		for (const listener of this.hitListeners) listener({ keyword, endSample });
	}

	emitStatus(status: WakeStatus, detail?: string): void {
		this.status = status;
		for (const listener of this.statusListeners) listener(status, detail);
	}
}
