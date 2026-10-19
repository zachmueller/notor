/**
 * Serialized, prioritized speech queue over a TTS backend.
 *
 * - Lines never overlap: one utterance plays at a time.
 * - `final` (the end-of-turn summary) drops queued `progress` lines, which
 *   would be stale by the time they played.
 * - Consecutive identical `progress` lines collapse.
 * - `interrupt()` is barge-in: stop the current line and clear the queue.
 */

import { logger } from "../../utils/logger";
import type { TtsBackend } from "./types";

const log = logger("SpeechQueue");

export type SpeechPriority = "announce" | "final" | "progress";

export interface SpeechItem {
	text: string;
	priority: SpeechPriority;
}

export interface SpeechQueueEvents {
	onStart?(item: SpeechItem): void;
	onEnd?(item: SpeechItem, interrupted: boolean): void;
	/** Fired when the queue drains and nothing is playing. */
	onIdle?(): void;
}

export class SpeechQueue {
	private queue: SpeechItem[] = [];
	private active: SpeechItem | null = null;
	private lastSpoken: string | null = null;
	private draining = false;

	constructor(
		private readonly tts: TtsBackend,
		private readonly events: SpeechQueueEvents = {},
	) {}

	get isSpeaking(): boolean {
		return this.active !== null;
	}

	get pendingCount(): number {
		return this.queue.length;
	}

	getLastSpoken(): string | null {
		return this.lastSpoken;
	}

	enqueue(text: string, priority: SpeechPriority = "announce"): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (priority === "final") {
			this.queue = this.queue.filter((item) => item.priority !== "progress");
		}
		if (priority === "progress") {
			const last = this.queue[this.queue.length - 1];
			if (last?.priority === "progress" && last.text === trimmed) return;
			if (this.active?.priority === "progress" && this.active.text === trimmed) return;
		}
		this.queue.push({ text: trimmed, priority });
		void this.drain();
	}

	/** Barge-in: stop the current line and discard everything queued. */
	interrupt(): void {
		this.queue = [];
		this.tts.stop();
	}

	/** Stop only the current line; queued lines still play. */
	skipCurrent(): void {
		this.tts.stop();
	}

	clearPending(): void {
		this.queue = [];
	}

	/** Re-speak the last completed announcement or summary. */
	repeatLast(): boolean {
		if (!this.lastSpoken) return false;
		this.enqueue(this.lastSpoken, "announce");
		return true;
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift()!;
				this.active = item;
				this.events.onStart?.(item);
				let interrupted = false;
				try {
					({ interrupted } = await this.tts.speak(item.text));
				} catch (e) {
					log.warn("speak failed", { error: String(e) });
				}
				this.active = null;
				if (!interrupted && item.priority !== "progress") this.lastSpoken = item.text;
				this.events.onEnd?.(item, interrupted);
			}
		} finally {
			this.draining = false;
			this.events.onIdle?.();
		}
	}
}
