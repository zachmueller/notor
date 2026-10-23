/**
 * Speech-to-text backend seam.
 *
 * The only shipped implementation is a local whisper.cpp server; the interface
 * exists so other *local* recognizers can be swapped in later. Cloud speech
 * recognition is deliberately out of scope.
 */

export type SttStatus = "stopped" | "starting" | "ready" | "error";

export type VoiceProblemCode =
	| "not_macos"
	| "binary_not_found"
	| "model_missing"
	| "server_failed"
	| "microphone_denied"
	| "microphone_unavailable"
	| "kws_python_not_found"
	| "kws_model_missing"
	| "kws_module_missing"
	| "kws_keyword_invalid"
	| "kws_failed";

/** A configuration or environment problem that prevents voice mode from running. */
export interface VoiceConfigProblem {
	code: VoiceProblemCode;
	/** User-facing, sentence-case explanation with the fix. */
	message: string;
}

export interface TranscribeHints {
	/** Vocabulary / context prompt for this utterance (overrides the launch-time prompt). */
	prompt?: string;
}

export interface SttBackend {
	readonly status: SttStatus;
	/** Synchronous environment check; empty when the backend can start. */
	preflight(): VoiceConfigProblem[];
	/** Start (or ensure) the recognizer; resolves when it accepts requests. */
	start(): Promise<void>;
	/** Transcribe a 16 kHz mono 16-bit WAV. Returns "" for silence or discarded output. */
	transcribe(wav: ArrayBuffer, hints?: TranscribeHints): Promise<string>;
	/** Stop and release the recognizer. Safe to call repeatedly. */
	dispose(): Promise<void>;
	/** Restart the recognizer in place (e.g. after system wake). Optional. */
	restart?(): Promise<void>;
	/** Subscribe to status changes; returns an unsubscribe function. */
	onStatus(listener: (status: SttStatus, detail?: string) => void): () => void;
}
