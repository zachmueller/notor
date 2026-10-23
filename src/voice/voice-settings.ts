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
	wakeWord: string;
	/** Wake word first, then the alternative spellings (deduplicated, never empty). */
	wakeWordSpellings: string[];
	wakeListenTimeoutMs: number;
	wakeEarconEnabled: boolean;
	kwsPythonPath: string;
	kwsModelDir: string;
	kwsThreshold: number;
	kwsScore: number;
	kwsNumThreads: number;
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

export const DEFAULT_WAKE_WORD = "Hey Notor";

/** Split the comma-separated variants setting and put the wake word first, without duplicates. */
export function wakeWordSpellings(wakeWord: string, variants: string): string[] {
	const seen = new Set<string>();
	const spellings: string[] = [];
	for (const raw of [wakeWord, ...variants.split(",")]) {
		const spelling = raw.trim().replace(/\s+/g, " ");
		const key = spelling.toLowerCase();
		if (!spelling || seen.has(key)) continue;
		seen.add(key);
		spellings.push(spelling);
	}
	return spellings;
}

/** Read the voice settings with defaults and ranges applied. */
export function readVoiceConfig(settings: NotorSettings): VoiceConfig {
	const wakeWord = str(settings.voice_wake_word, DEFAULT_WAKE_WORD).trim().replace(/\s+/g, " ") || DEFAULT_WAKE_WORD;
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
		wakeWord,
		wakeWordSpellings: wakeWordSpellings(wakeWord, str(settings.voice_wake_word_variants, "")),
		wakeListenTimeoutMs: num(settings.voice_wake_listen_timeout_ms, 1_000, 30_000, 5_000),
		wakeEarconEnabled: settings.voice_wake_earcon_enabled !== false,
		kwsPythonPath: str(settings.voice_kws_python_path, "python3").trim() || "python3",
		kwsModelDir: str(settings.voice_kws_model_dir, "").trim(),
		kwsThreshold: num(settings.voice_kws_threshold, 0.01, 1, 0.15),
		kwsScore: num(settings.voice_kws_score, 0, 10, 2),
		kwsNumThreads: Math.round(num(settings.voice_kws_num_threads, 1, 8, 1)),
		endOfTurnPauseMs: num(settings.voice_end_of_turn_pause_ms, 300, 30_000, 600),
		silenceThreshold: num(settings.voice_silence_threshold, 0.001, 1, 0.02),
		bargeInMultiplier: num(settings.voice_barge_in_threshold_multiplier, 1, 20, 3),
		minUtteranceMs: num(settings.voice_min_utterance_ms, 0, 10_000, 600),
		stopOnSilenceMs: num(settings.voice_stop_on_silence_ms, 0, 3_600_000, 0),
		verbosity,
		progressIntervalMs: num(settings.voice_progress_interval_ms, 5_000, 600_000, 25_000),
		shapingPreset: str(settings.voice_shaping_preset, "").trim(),
		inputCleanupEnabled: settings.voice_input_cleanup_enabled !== false,
		summaryMaxChars: Math.round(num(settings.voice_speech_summary_max_chars, 100, 5_000, 600)),
		ttsCommand: str(settings.voice_tts_command, "say").trim() || "say",
		ttsVoice: str(settings.voice_tts_voice, "").trim(),
		ttsRate: Math.round(num(settings.voice_tts_rate, 0, 1_000, 0)),
	};
}

/**
 * Whisper's vocabulary prompt: the wake word first (so its residue in a
 * transcript is spelled consistently and easy to strip), then user jargon.
 */
export function buildWhisperInitialPrompt(config: VoiceConfig): string {
	const parts = [config.wakeWord, config.whisperVocabulary].map((p) => p.trim()).filter(Boolean);
	return parts.join(". ");
}
