/**
 * Microphone capture in the Electron renderer.
 *
 * `getUserMedia` → `AudioContext` (16 kHz requested) → `AudioWorkletNode` →
 * Float32 frames posted back over the worklet's message port. Plugins ship as a
 * single `main.js`, so the worklet module is loaded from a blob URL built from
 * `PROCESSOR_SOURCE` below.
 */

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
	/** Samples per delivered frame. Default 4096 (~256 ms at 16 kHz). */
	frameSize?: number;
}

const PROCESSOR_NAME = "notor-pcm-capture";

/**
 * Runs on the audio thread: accumulates the 128-sample render quanta of the
 * first input channel into `frameSize` frames and transfers each one to the
 * main thread. The node's output is left silent.
 */
const PROCESSOR_SOURCE = `
class NotorPcmCapture extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this.frameSize = options.processorOptions.frameSize;
		this.frame = new Float32Array(this.frameSize);
		this.filled = 0;
	}
	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (channel) {
			for (let i = 0; i < channel.length; i++) {
				this.frame[this.filled++] = channel[i];
				if (this.filled === this.frameSize) {
					this.port.postMessage(this.frame, [this.frame.buffer]);
					this.frame = new Float32Array(this.frameSize);
					this.filled = 0;
				}
			}
		}
		return true;
	}
}
registerProcessor(${JSON.stringify(PROCESSOR_NAME)}, NotorPcmCapture);
`;

export class MicrophoneAudioSource implements AudioSource {
	private stream: MediaStream | null = null;
	private context: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private processor: AudioWorkletNode | null = null;
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

		let processor: AudioWorkletNode;
		try {
			const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: "text/javascript" }));
			try {
				await context.audioWorklet.addModule(url);
			} finally {
				URL.revokeObjectURL(url);
			}
			processor = new AudioWorkletNode(context, PROCESSOR_NAME, {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				channelCount: 1,
				channelCountMode: "explicit",
				processorOptions: { frameSize: this.opts.frameSize ?? 4096 },
			});
		} catch (e) {
			stream.getTracks().forEach((track) => track.stop());
			void context.close().catch(() => undefined);
			throw new MicrophoneCaptureError("microphone_unavailable", `Could not start audio processing: ${String(e)}`);
		}
		this._sampleRate = context.sampleRate;

		processor.port.onmessage = (event: MessageEvent<Float32Array>) => onFrame(event.data);
		const source = context.createMediaStreamSource(stream);
		source.connect(processor);
		// Keep the node pulled by the render graph; its output stays silent.
		processor.connect(context.destination);

		this.stream = stream;
		this.context = context;
		this.source = source;
		this.processor = processor;
		if (context.state !== "running") await context.resume();
	}

	stop(): void {
		if (this.processor) {
			this.processor.port.onmessage = null;
			this.processor.port.close();
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
