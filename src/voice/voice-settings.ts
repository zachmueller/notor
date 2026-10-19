/**
 * Typed, range-checked view of the `voice_*` settings.
 *
 * Settings can be edited without validation (settings tab text fields,
 * `edit_notor_settings`), so every consumer reads through this module.
 */

import type { NotorSettings, VoiceProgressVerbosity } from "../settings/types";

export const VOICE_VERBOSITY_LEVELS: readonly VoiceProgressVerbosity[] = [
	"silent",
	"needs_me",
	"periodic",
	"every_tool",
];

export const VOICE_VERBOSITY_LABELS: Record<VoiceProgressVerbosity, string> = {
	silent: "Silent — final summary only",
	needs_me: "Needs me — approvals, questions, and the final summary",
	periodic: "Periodic — brief progress updates",
	every_tool: "Every tool — one short line per tool call",
};

export interface VoiceConfig {
	enabled: boolean;
	whisperServerPath: string;
	whisperModelPath: string;
	whisperPort: number;
	whisperLanguage: string;
	whisperVocabulary: string;
	whisperExtraArgs: string;
	endOfTurnPauseMs: number;
	silenceThreshold: number;
	bargeInMultiplier: number;
	minUtteranceMs: number;
	stopOnSilenceMs: number;
	verbosity: VoiceProgressVerbosity;
	progressIntervalMs: number;
	shapingPreset: string;
	inputCleanupEnabled: boolean;
	summaryMaxChars: number;
	triggerPhrase: string;
	ttsCommand: string;
	ttsVoice: string;
	ttsRate: number;
}

function num(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

/** Read the voice settings with defaults and ranges applied. */
export function readVoiceConfig(settings: NotorSettings): VoiceConfig {
	const verbosity = VOICE_VERBOSITY_LEVELS.includes(settings.voice_progress_verbosity)
		? settings.voice_progress_verbosity
		: "needs_me";
	return {
		enabled: settings.voice_enabled === true,
		whisperServerPath: str(settings.voice_whisper_server_path, "whisper-server").trim() || "whisper-server",
		whisperModelPath: str(settings.voice_whisper_model_path, "").trim(),
		whisperPort: Math.round(num(settings.voice_whisper_server_port, 1024, 65_535, 8178)),
		whisperLanguage: str(settings.voice_whisper_language, "en").trim() || "en",
		whisperVocabulary: str(settings.voice_whisper_vocabulary, "").trim(),
		whisperExtraArgs: str(settings.voice_whisper_extra_args, ""),
		endOfTurnPauseMs: num(settings.voice_end_of_turn_pause_ms, 300, 30_000, 2500),
		silenceThreshold: num(settings.voice_silence_threshold, 0.001, 1, 0.02),
		bargeInMultiplier: num(settings.voice_barge_in_threshold_multiplier, 1, 20, 3),
		minUtteranceMs: num(settings.voice_min_utterance_ms, 0, 10_000, 600),
		stopOnSilenceMs: num(settings.voice_stop_on_silence_ms, 0, 3_600_000, 0),
		verbosity,
		progressIntervalMs: num(settings.voice_progress_interval_ms, 5_000, 600_000, 25_000),
		shapingPreset: str(settings.voice_shaping_preset, "").trim(),
		inputCleanupEnabled: settings.voice_input_cleanup_enabled !== false,
		summaryMaxChars: Math.round(num(settings.voice_speech_summary_max_chars, 100, 5_000, 600)),
		triggerPhrase: str(settings.voice_command_trigger_phrase, "voice command").trim() || "voice command",
		ttsCommand: str(settings.voice_tts_command, "say").trim() || "say",
		ttsVoice: str(settings.voice_tts_voice, "").trim(),
		ttsRate: Math.round(num(settings.voice_tts_rate, 0, 1_000, 0)),
	};
}

/** The launch-time vocabulary prompt for whisper: trigger phrase first, then user jargon. */
export function buildWhisperInitialPrompt(config: VoiceConfig): string {
	const parts = [config.triggerPhrase, config.whisperVocabulary].map((p) => p.trim()).filter(Boolean);
	return parts.join(". ");
}
