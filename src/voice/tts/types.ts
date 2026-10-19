/**
 * Text-to-speech backend seam.
 *
 * The shipped implementation runs a local command (`say` by default) with the
 * text on stdin. Any local, stdin-reading synthesizer can be substituted via
 * the `voice_tts_command` setting without code changes; cloud TTS is out of
 * scope.
 */

export interface SpeakResult {
	/** True when playback was cut short by `stop()` (barge-in or shutdown). */
	interrupted: boolean;
}

export interface TtsBackend {
	readonly isSpeaking: boolean;
	/** Speak `text`; resolves when playback ends or is interrupted. Never rejects. */
	speak(text: string): Promise<SpeakResult>;
	/** Stop the current utterance immediately (no-op when idle). */
	stop(): void;
	dispose(): void;
}
