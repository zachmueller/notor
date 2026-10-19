import { describe, it, expect, vi } from "vitest";

vi.mock("../../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { SpeechQueue } from "./speech-queue";
import type { SpeakResult, TtsBackend } from "./types";

/** A TTS fake whose utterances finish only when the test says so. */
class FakeTts implements TtsBackend {
	spoken: string[] = [];
	private pending: { resolve: (r: SpeakResult) => void } | null = null;

	get isSpeaking(): boolean {
		return this.pending !== null;
	}

	speak(text: string): Promise<SpeakResult> {
		this.spoken.push(text);
		return new Promise((resolve) => {
			this.pending = { resolve };
		});
	}

	stop(): void {
		const p = this.pending;
		this.pending = null;
		p?.resolve({ interrupted: true });
	}

	finishCurrent(): void {
		const p = this.pending;
		this.pending = null;
		p?.resolve({ interrupted: false });
	}

	dispose(): void {
		this.stop();
	}
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("SpeechQueue", () => {
	it("plays lines one at a time in order", async () => {
		const tts = new FakeTts();
		const queue = new SpeechQueue(tts);
		queue.enqueue("one");
		queue.enqueue("two");
		await tick();
		expect(tts.spoken).toEqual(["one"]);
		expect(queue.isSpeaking).toBe(true);
		tts.finishCurrent();
		await tick();
		expect(tts.spoken).toEqual(["one", "two"]);
		tts.finishCurrent();
		await tick();
		expect(queue.isSpeaking).toBe(false);
		expect(queue.getLastSpoken()).toBe("two");
	});

	it("drops queued progress lines when a final summary arrives", async () => {
		const tts = new FakeTts();
		const queue = new SpeechQueue(tts);
		queue.enqueue("working", "progress");
		queue.enqueue("still working", "progress");
		queue.enqueue("one more", "progress");
		await tick();
		queue.enqueue("Here is the summary.", "final");
		tts.finishCurrent();
		await tick();
		tts.finishCurrent();
		await tick();
		expect(tts.spoken).toEqual(["working", "Here is the summary."]);
	});

	it("collapses consecutive identical progress lines", async () => {
		const tts = new FakeTts();
		const queue = new SpeechQueue(tts);
		queue.enqueue("reading note", "progress");
		queue.enqueue("reading note", "progress");
		queue.enqueue("reading note", "progress");
		await tick();
		expect(queue.pendingCount).toBe(0);
		expect(tts.spoken).toEqual(["reading note"]);
	});

	it("interrupt stops the current line and clears the rest; progress is not remembered for repeat", async () => {
		const tts = new FakeTts();
		const ended: Array<[string, boolean]> = [];
		const queue = new SpeechQueue(tts, { onEnd: (item, interrupted) => ended.push([item.text, interrupted]) });
		queue.enqueue("long announcement");
		queue.enqueue("next", "progress");
		await tick();
		queue.interrupt();
		await tick();
		expect(ended).toEqual([["long announcement", true]]);
		expect(tts.spoken).toEqual(["long announcement"]);
		expect(queue.isSpeaking).toBe(false);
		expect(queue.repeatLast()).toBe(false);
	});

	it("repeatLast re-speaks the last completed non-progress line", async () => {
		const tts = new FakeTts();
		const queue = new SpeechQueue(tts);
		queue.enqueue("the summary", "final");
		await tick();
		tts.finishCurrent();
		await tick();
		queue.enqueue("progress line", "progress");
		await tick();
		tts.finishCurrent();
		await tick();
		expect(queue.repeatLast()).toBe(true);
		await tick();
		expect(tts.spoken).toEqual(["the summary", "progress line", "the summary"]);
	});

	it("ignores blank text and fires onIdle when drained", async () => {
		const tts = new FakeTts();
		const idle = vi.fn();
		const queue = new SpeechQueue(tts, { onIdle: idle });
		queue.enqueue("   ");
		expect(queue.pendingCount).toBe(0);
		queue.enqueue("hi");
		await tick();
		tts.finishCurrent();
		await tick();
		expect(idle).toHaveBeenCalledTimes(1);
	});
});
