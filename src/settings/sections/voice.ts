/**
 * Voice mode settings section (macOS-only hands-free loop).
 *
 * @see docs/voice.md
 */

import { Notice, Platform, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { markSubsection } from "../helpers";
import type { VoiceProgressVerbosity } from "../types";
import { DEFAULT_WAKE_WORD, VOICE_VERBOSITY_LABELS, VOICE_VERBOSITY_LEVELS } from "../../voice/voice-settings";
import type { PromptOverrideFile } from "../../chat/prompt-override-file";
import { logger } from "../../utils/logger";

const log = logger("settings:voice");

type NumericKey = {
	[K in keyof SettingsContext["settings"]]: SettingsContext["settings"][K] extends number ? K : never;
}[keyof SettingsContext["settings"]];

type StringKey = {
	[K in keyof SettingsContext["settings"]]: SettingsContext["settings"][K] extends string ? K : never;
}[keyof SettingsContext["settings"]];

function addNumberSetting(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	key: NumericKey,
	name: string,
	desc: string,
	range: { min: number; max: number; integer?: boolean },
	onSaved?: () => void,
): void {
	new Setting(containerEl)
		.setName(name)
		.setDesc(desc)
		.addText((text) =>
			text
				.setValue(String(ctx.settings[key]))
				.onChange(async (value) => {
					const parsed = range.integer ? parseInt(value, 10) : parseFloat(value);
					if (!Number.isFinite(parsed) || parsed < range.min || parsed > range.max) return;
					(ctx.settings as unknown as Record<string, number>)[key] = parsed;
					await ctx.saveSettings();
					onSaved?.();
				}),
		);
}

function addTextSetting(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	key: StringKey,
	name: string,
	desc: string,
	placeholder: string,
	onSaved?: () => void,
): void {
	new Setting(containerEl)
		.setName(name)
		.setDesc(desc)
		.addText((text) =>
			text
				.setPlaceholder(placeholder)
				.setValue(ctx.settings[key])
				.onChange(async (value) => {
					(ctx.settings as unknown as Record<string, string>)[key] = value.trim();
					await ctx.saveSettings();
					onSaved?.();
				}),
		);
}

function addCustomizePromptButton(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	name: string,
	desc: string,
	file: PromptOverrideFile,
): void {
	new Setting(containerEl)
		.setName(name)
		.setDesc(desc)
		.addButton((btn) =>
			btn.setButtonText("Customize").onClick(async () => {
				try {
					if (await file.exists()) {
						new Notice("Prompt file already exists — opening it.");
					} else {
						await file.writeDefault();
						new Notice("Default prompt exported for editing.");
					}
					await ctx.app.workspace.openLinkText(file.getPath(), "", false);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to export voice prompt", { path: file.getPath(), error: msg });
					new Notice(`Failed to export prompt: ${msg}`);
				}
			}),
		);
}

/**
 * Advice for a wake word that will wake Notor too easily, or "" when it looks
 * fine. Short and single-word phrases are spotted in ordinary speech more often.
 */
export function wakeWordAdvice(wakeWord: string): string {
	const words = wakeWord.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return `No wake word set; "${DEFAULT_WAKE_WORD}" is used.`;
	const syllables = words.reduce((n, w) => n + Math.max(1, (w.toLowerCase().match(/[aeiouy]+/g) ?? []).length), 0);
	if (words.length < 2 || syllables < 3) {
		return "Short or single-word wake words wake Notor by mistake more often. Two to four syllables work best.";
	}
	return "";
}

/** Render the "Voice" settings group body. */
export function renderVoiceSection(containerEl: HTMLElement, ctx: SettingsContext): void {
	containerEl.createEl("p", {
		text:
			"Talk to Notor hands-free: say the wake word, then your request. Notor transcribes it locally " +
			"with whisper.cpp, sends it to the conversation, and reads a summary of the reply aloud. Until it " +
			"hears the wake word, nothing you say is transcribed. Requires whisper.cpp (brew install whisper-cpp) " +
			"with a ggml model, and sherpa-onnx (pip install sherpa-onnx sentencepiece) with a keyword-spotting model.",
		cls: "setting-item-description",
	});

	if (!Platform.isMacOS) {
		containerEl.createEl("p", {
			text: "Voice mode is only available on macOS.",
			cls: "setting-item-description",
		});
		return;
	}

	new Setting(containerEl)
		.setName("Enable voice mode")
		.setDesc("Shows the microphone button in chat panels and adds a command to turn voice mode on and off.")
		.addToggle((toggle) =>
			toggle.setValue(ctx.settings.voice_enabled).onChange(async (value) => {
				ctx.settings.voice_enabled = value;
				await ctx.saveSettings();
				// The `voice` extension feature group follows this toggle.
				await ctx.plugin.getExtensionManager().reload(false);
				ctx.redisplay();
			}),
		);

	const preflightEl = containerEl.createEl("p", { cls: "setting-item-description notor-voice-preflight" });
	const refreshPreflight = () => {
		const problems = ctx.plugin.getVoiceManager().preflight();
		preflightEl.setText(
			problems.length > 0
				? problems.map((p) => p.message).join(" ")
				: "Voice mode is configured: whisper, Python and both model files were found.",
		);
		preflightEl.toggleClass("notor-voice-preflight-error", problems.length > 0);
	};
	refreshPreflight();

	const applyWakeChange = () => {
		refreshPreflight();
		ctx.plugin.getVoiceManager().applyWakeConfigChange();
	};

	// --- Wake word ---
	markSubsection(new Setting(containerEl).setHeading().setName("Wake word"), "Wake word");
	const wakeWordSetting = new Setting(containerEl)
		.setName("Wake word")
		.setDesc("Say this to address Notor, then your request in the same breath or after the chime. Nothing is sent until it is heard.");
	const adviceEl = wakeWordSetting.descEl.createDiv({ cls: "notor-voice-preflight-error" });
	const refreshAdvice = () => adviceEl.setText(wakeWordAdvice(ctx.settings.voice_wake_word));
	wakeWordSetting.addText((text) =>
		text
			.setPlaceholder(DEFAULT_WAKE_WORD)
			.setValue(ctx.settings.voice_wake_word)
			.onChange(async (value) => {
				ctx.settings.voice_wake_word = value.trim();
				await ctx.saveSettings();
				refreshAdvice();
				applyWakeChange();
			}),
	);
	refreshAdvice();
	addTextSetting(containerEl, ctx, "voice_wake_word_variants", "Alternative spellings",
		"Comma-separated spellings the detector also listens for. Made-up words like \"Notor\" need a few, " +
		"because the model only knows English spellings. They are also stripped from what is sent.",
		"Hey Nota, Hey Noter", applyWakeChange);
	addNumberSetting(containerEl, ctx, "voice_wake_listen_timeout_ms", "Listen after wake word (ms)",
		"After a bare wake word, how long Notor waits for you to start talking before going back to waiting.",
		{ min: 1_000, max: 30_000, integer: true });
	new Setting(containerEl)
		.setName("Wake chime")
		.setDesc("Play a short chime when the wake word is heard, and when voice mode turns on or off.")
		.addToggle((toggle) =>
			toggle.setValue(ctx.settings.voice_wake_earcon_enabled).onChange(async (value) => {
				ctx.settings.voice_wake_earcon_enabled = value;
				await ctx.saveSettings();
			}),
		);

	// --- Wake-word detection ---
	markSubsection(new Setting(containerEl).setHeading().setName("Wake-word detection"), "Wake-word detection");
	addTextSetting(containerEl, ctx, "voice_kws_python_path", "Python interpreter",
		"Python 3 with sherpa-onnx and sentencepiece installed: a name on your login-shell PATH, or an absolute path (for example a virtual environment's bin/python).",
		"python3", applyWakeChange);
	addTextSetting(containerEl, ctx, "voice_kws_model_dir", "Keyword-spotting model folder",
		"Absolute path to an unpacked sherpa-onnx keyword-spotting model, such as sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.",
		"/Users/you/.local/share/sherpa-onnx/kws-gigaspeech", applyWakeChange);
	addNumberSetting(containerEl, ctx, "voice_kws_threshold", "Detection threshold",
		"0–1. Lower wakes more easily (and by mistake more often); raise it if Notor wakes when you did not call it.",
		{ min: 0.01, max: 1 }, applyWakeChange);
	addNumberSetting(containerEl, ctx, "voice_kws_score", "Wake word boost",
		"How strongly the detector favours the wake word. Raise it if Notor misses the wake word.",
		{ min: 0, max: 10 }, applyWakeChange);
	addNumberSetting(containerEl, ctx, "voice_kws_num_threads", "Detector threads",
		"CPU threads for wake-word detection. One is plenty.", { min: 1, max: 8, integer: true }, applyWakeChange);

	// --- Speech recognition ---
	markSubsection(new Setting(containerEl).setHeading().setName("Speech recognition"), "Speech recognition");
	addTextSetting(containerEl, ctx, "voice_whisper_server_path", "Whisper server binary",
		"Name of the whisper.cpp server binary on your login-shell PATH, or an absolute path.",
		"whisper-server", refreshPreflight);
	addTextSetting(containerEl, ctx, "voice_whisper_model_path", "Whisper model file",
		"Absolute path to a ggml model, e.g. ggml-base.en.bin from huggingface.co/ggerganov/whisper.cpp.",
		"/Users/you/.local/share/whisper/ggml-base.en.bin", refreshPreflight);
	addNumberSetting(containerEl, ctx, "voice_whisper_server_port", "Server port",
		"Loopback port for the whisper server. The next two ports are tried if it is busy.",
		{ min: 1024, max: 65_535, integer: true });
	addTextSetting(containerEl, ctx, "voice_whisper_language", "Language",
		"Whisper language code, such as en, de, or auto.", "en");
	new Setting(containerEl)
		.setName("Vocabulary")
		.setDesc("Names and jargon to help recognition. Added to whisper's prompt after the wake word.")
		.addTextArea((text) =>
			text
				.setPlaceholder("Project names, people, jargon…")
				.setValue(ctx.settings.voice_whisper_vocabulary)
				.onChange(async (value) => {
					ctx.settings.voice_whisper_vocabulary = value;
					await ctx.saveSettings();
				}),
		);
	addTextSetting(containerEl, ctx, "voice_whisper_extra_args", "Extra server arguments",
		"Additional whisper-server flags, e.g. -t 8. Applied at the next start.", "");

	// --- Listening ---
	markSubsection(new Setting(containerEl).setHeading().setName("Listening"), "Listening");
	addNumberSetting(containerEl, ctx, "voice_end_of_turn_pause_ms", "End-of-turn pause (ms)",
		"Silence after you stop talking that ends what you said after the wake word.",
		{ min: 300, max: 30_000, integer: true });
	addNumberSetting(containerEl, ctx, "voice_silence_threshold", "Speech threshold",
		"Microphone level (0–1) above which audio counts as speech. Raise it in noisy rooms.",
		{ min: 0.001, max: 1 });
	addNumberSetting(containerEl, ctx, "voice_min_utterance_ms", "Minimum utterance (ms)",
		"Shorter sounds are ignored as noise.", { min: 0, max: 10_000, integer: true });
	addNumberSetting(containerEl, ctx, "voice_stop_on_silence_ms", "Turn off when idle (ms)",
		"Turn voice mode off when the wake word has not been heard for this long and nothing is running. 0 keeps it on indefinitely (default).",
		{ min: 0, max: 3_600_000, integer: true });
	addNumberSetting(containerEl, ctx, "voice_barge_in_threshold_multiplier", "Reply-while-speaking sensitivity",
		"While Notor reads out an approval or question, a reply without the wake word must exceed the speech threshold times this value. (Say the wake word to interrupt.)",
		{ min: 1, max: 20 });

	// --- Spoken output ---
	markSubsection(new Setting(containerEl).setHeading().setName("Spoken output"), "Spoken output");
	new Setting(containerEl)
		.setName("Progress verbosity")
		.setDesc("How much is spoken while the assistant works. The final summary is always spoken.")
		.addDropdown((dropdown) => {
			for (const level of VOICE_VERBOSITY_LEVELS) dropdown.addOption(level, VOICE_VERBOSITY_LABELS[level]);
			dropdown.setValue(ctx.settings.voice_progress_verbosity).onChange(async (value) => {
				ctx.settings.voice_progress_verbosity = value as VoiceProgressVerbosity;
				await ctx.saveSettings();
			});
		});
	addNumberSetting(containerEl, ctx, "voice_progress_interval_ms", "Progress interval (ms)",
		"Minimum time between spoken progress updates at the periodic level.",
		{ min: 5_000, max: 600_000, integer: true });
	addNumberSetting(containerEl, ctx, "voice_speech_summary_max_chars", "Summary length (characters)",
		"Target length of the spoken summary of each reply.", { min: 100, max: 5_000, integer: true });
	addTextSetting(containerEl, ctx, "voice_tts_command", "Text-to-speech command",
		"Command that speaks the text it receives on stdin. The macOS default is say.", "say");
	addTextSetting(containerEl, ctx, "voice_tts_voice", "Voice",
		"Voice name passed as -v. Leave empty for the system voice; run say -v ? in a terminal to list voices.", "");
	addNumberSetting(containerEl, ctx, "voice_tts_rate", "Speech rate (words per minute)",
		"Passed as -r. 0 uses the default rate.", { min: 0, max: 1_000, integer: true });

	// --- Shaping ---
	markSubsection(new Setting(containerEl).setHeading().setName("Shaping"), "Shaping");
	containerEl.createEl("p", {
		text:
			"Two LLM passes shape the loop: one cleans up what you dictated before it is sent, " +
			"one condenses the reply (including tool calls) into something listenable. " +
			"Both prompts can be customized, like the core system prompt.",
		cls: "setting-item-description",
	});
	const configuredPresets = ctx.settings.model_presets.filter((p) => p.provider_id !== null && p.model_id !== null);
	new Setting(containerEl)
		.setName("Shaping model preset")
		.setDesc("Model used for the clean-up and summary passes. Defaults to the conversation's current model.")
		.addDropdown((dropdown) => {
			dropdown.addOption("", "(Same as the conversation)");
			for (const p of configuredPresets) dropdown.addOption(p.name, p.name);
			dropdown.setValue(ctx.settings.voice_shaping_preset).onChange(async (value) => {
				ctx.settings.voice_shaping_preset = value;
				await ctx.saveSettings();
			});
		});
	new Setting(containerEl)
		.setName("Clean up dictated input")
		.setDesc("Fix punctuation and remove filler words before sending. Adds one quick model call per utterance.")
		.addToggle((toggle) =>
			toggle.setValue(ctx.settings.voice_input_cleanup_enabled).onChange(async (value) => {
				ctx.settings.voice_input_cleanup_enabled = value;
				await ctx.saveSettings();
			}),
		);
	const prompts = ctx.plugin.getVoiceManager().getPromptFiles();
	addCustomizePromptButton(containerEl, ctx, "Customize clean-up prompt",
		"Export the default input clean-up prompt to a note for editing. If it already exists, opens it.",
		prompts.inputCleanup);
	addCustomizePromptButton(containerEl, ctx, "Customize speech summary prompt",
		"Export the default spoken-summary prompt to a note for editing. If it already exists, opens it.",
		prompts.speechSummary);

}
