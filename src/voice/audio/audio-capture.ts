/**
 * Microphone capture in the Electron renderer.
 *
 * `getUserMedia` → `AudioContext` (16 kHz requested) → `ScriptProcessorNode`
 * → Float32 frames. A worklet would be the modern choice, but loading one
 * requires a blob-URL module that Obsidian's content security policy may
 * block; the processor node is reliable and more than fast enough for a
 * 2.5-second silence detector.
 */

/* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessorNode is used on purpose; see the header. */
import type { VoiceProblemCode } from "../stt/types";

/** Anything that produces mono PCM frames; the controller never touches browser APIs directly. */
export interface AudioSource {
	/** Actual sample rate of the frames delivered to `onFrame`. */
	readonly sampleRate: number;
	start(onFrame: (frame: Float32Array) => void): Promise<void>;
	stop(): void;
}

export class MicrophoneCaptureError extends Error {
	constructor(
		public readonly code: Extract<VoiceProblemCode, "microphone_denied" | "microphone_unavailable">,
		message: string,
	) {
		super(message);
		this.name = "MicrophoneCaptureError";
	}
}

export interface MicrophoneAudioSourceOptions {
	/** Default 16 000; the context may refuse it, in which case `sampleRate` reports what it chose. */
	preferredSampleRate?: number;
	/** ScriptProcessor buffer size (power of two). Default 4096 (~256 ms at 16 kHz). */
	bufferSize?: number;
}

export class MicrophoneAudioSource implements AudioSource {
	private stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private processor: ScriptProcessorNode | null = null;
	private _sampleRate: number;

	constructor(private readonly opts: MicrophoneAudioSourceOptions = {}) {
		this._sampleRate = opts.preferredSampleRate ?? 16_000;
	}

	get sampleRate(): number {
		return this._sampleRate;
	}

	async start(onFrame: (frame: Float32Array) => void): Promise<void> {
		if (this.context) return;
		if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
			throw new MicrophoneCaptureError("microphone_unavailable", "Microphone capture is not available in this environment.");
		}

		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
		} catch (e) {
			const name = (e as { name?: string }).name;
			if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
				throw new MicrophoneCaptureError(
					"microphone_denied",
					"Microphone access was denied. Allow Obsidian to use the microphone in System Settings → Privacy & Security → Microphone.",
				);
			}
			throw new MicrophoneCaptureError("microphone_unavailable", `No microphone is available: ${String(e)}`);
		}

		let context: AudioContext;
		try {
			context = new AudioContext({ sampleRate: this.opts.preferredSampleRate ?? 16_000 });
		} catch {
			context = new AudioContext();
		}
		this._sampleRate = context.sampleRate;

		const source = context.createMediaStreamSource(stream);
		const processor = context.createScriptProcessor(this.opts.bufferSize ?? 4096, 1, 1);
		processor.onaudioprocess = (event) => {
			// Copy: the input buffer is reused by the audio thread.
			onFrame(new Float32Array(event.inputBuffer.getChannelData(0)));
		};
		source.connect(processor);
		// A ScriptProcessorNode only runs while connected to the graph's output;
		// its output buffer stays silent because nothing is written to it.
		processor.connect(context.destination);

		this.stream = stream;
		this.context = context;
		this.source = source;
		this.processor = processor;
		if (context.state !== "running") await context.resume();
	}

	stop(): void {
		if (this.processor) {
			this.processor.onaudioprocess = null;
			this.processor.disconnect();
		}
		this.source?.disconnect();
		this.stream?.getTracks().forEach((track) => track.stop());
		void this.context?.close().catch(() => undefined);
		this.processor = null;
		this.source = null;
		this.stream = null;
		this.context = null;
	}
}
