/**
 * Voice mode settings section (macOS-only hands-free loop).
 *
 * @see docs/voice.md
 */

import { Notice, Platform, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { markSubsection } from "../helpers";
import type { VoiceProgressVerbosity } from "../types";
import { VOICE_VERBOSITY_LABELS, VOICE_VERBOSITY_LEVELS } from "../../voice/voice-settings";
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

/** Render the "Voice" settings group body. */
export function renderVoiceSection(containerEl: HTMLElement, ctx: SettingsContext): void {
	containerEl.createEl("p", {
		text:
			"Talk to Notor hands-free: speech is transcribed locally with whisper.cpp, sent to the " +
			"conversation, and the reply is summarized and read aloud. Requires whisper.cpp " +
			"(brew install whisper-cpp) and a downloaded ggml model. Headphones are recommended.",
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
		.setDesc("Shows the microphone button in chat panels and adds a command to toggle voice mode.")
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
				: "Speech recognition is configured: the whisper server binary and the model file were found.",
		);
		preflightEl.toggleClass("notor-voice-preflight-error", problems.length > 0);
	};
	refreshPreflight();

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
	addNumberSetting(containerEl, ctx, "voice_stop_on_silence_ms", "Stop listening after silence (ms)",
		"Turn voice mode off after this much continuous silence. 0 keeps it on indefinitely (default).",
		{ min: 0, max: 3_600_000, integer: true });
	addNumberSetting(containerEl, ctx, "voice_barge_in_threshold_multiplier", "Barge-in sensitivity",
		"While Notor is speaking, your voice must exceed the speech threshold times this value to interrupt it.",
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
			dropdown.addOption("", "(same as the conversation)");
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
