/**
 * Provider and model steps of the guided setup wizard.
 */

import { Setting } from "obsidian";
import type { LLMProviderConfig, LLMProviderType, ModelInfo, ModelPreset } from "../../types";
import type { SettingsContext } from "../../settings/sections/context";
import { getProviderById } from "../../settings/helpers";
import { createDefaultConfig, PROVIDER_TYPE_LABELS } from "../../settings/sections/provider-add";
import { renderProviderSection } from "../../settings/sections/providers";
import { addModelOptions, selectModelOption } from "../../settings/sections/model-presets";
import { buildOptionValue, parseOptionValue } from "../../providers/model-grouping";
import { isPresetConfigured, isProviderConfigured } from "../../settings/setup-detection";
import { logger } from "../../utils/logger";
import type { SetupWizardHost } from "./types";

const log = logger("SetupWizard");

function configuredProviders(ctx: SettingsContext): LLMProviderConfig[] {
	return ctx.settings.providers.filter((p) =>
		isProviderConfigured(ctx.app, p, ctx.settings.model_presets)
	);
}

/**
 * Providers a preset can point at: configured ones, plus Bedrock instances the
 * user set up in this session (profile auth only counts as configured once a
 * preset references it, so the model step is what completes it).
 */
function presetCandidateProviders(ctx: SettingsContext, host: SetupWizardHost): LLMProviderConfig[] {
	return ctx.settings.providers.filter(
		(p) =>
			isProviderConfigured(ctx.app, p, ctx.settings.model_presets) ||
			(p.type === "bedrock" && host.touchedProviderIds.has(p.id))
	);
}

/** Reuse an untouched, unconfigured instance of the type (e.g. a seeded default) or add a new one. */
async function startProviderSetup(
	ctx: SettingsContext,
	host: SetupWizardHost,
	type: LLMProviderType
): Promise<void> {
	const { providers, model_presets } = ctx.settings;
	let config = providers.find(
		(p) =>
			p.type === type &&
			!host.touchedProviderIds.has(p.id) &&
			!isProviderConfigured(ctx.app, p, model_presets)
	);
	if (!config) {
		const existingCount = providers.filter((p) => p.type === type).length;
		config = createDefaultConfig(type, existingCount);
		providers.push(config);
	}
	config.enabled = true;
	host.activeProviderId = config.id;
	host.touchedProviderIds.add(config.id);
	await ctx.saveSettings();
	host.rerender();
}

export function renderProvidersStep(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	host: SetupWizardHost
): void {
	containerEl.createEl("p", {
		text:
			"Notor needs at least one AI provider to chat. Add as many as you like, " +
			"and use Test connection to confirm each one works.",
	});

	const configured = configuredProviders(ctx);
	if (configured.length > 0) {
		const listEl = containerEl.createEl("ul", { cls: "notor-setup-wizard-checklist" });
		for (const p of configured) {
			listEl.createEl("li", { text: `✓ ${p.display_name}`, cls: "notor-setup-wizard-check is-done" });
		}
	}

	const active = host.activeProviderId
		? getProviderById(ctx.settings, host.activeProviderId)
		: undefined;

	if (active) {
		const sectionEl = containerEl.createDiv({ cls: "notor-setup-wizard-provider" });
		renderProviderSection(sectionEl, ctx, active);
		new Setting(containerEl)
			.setName("Add another provider")
			.setDesc("Set up an additional provider, or continue to the next step.")
			.addButton((btn) =>
				btn.setButtonText("Add another").onClick(() => {
					host.activeProviderId = null;
					host.rerender();
				})
			);
	} else {
		new Setting(containerEl)
			.setName(configured.length > 0 ? "Add another provider" : "Choose a provider")
			.setDesc("Local covers Ollama, LM Studio, and other OpenAI-compatible servers.")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "Select type…");
				for (const [type, label] of Object.entries(PROVIDER_TYPE_LABELS)) {
					dropdown.addOption(type, label);
				}
				dropdown.onChange(async (value) => {
					if (!value) return;
					await startProviderSetup(ctx, host, value as LLMProviderType);
				});
			});
	}

	// Field edits don't redisplay the step, so re-check the warning whenever a
	// field commits its value (a full re-render here would steal focus).
	const warningEl = containerEl.createEl("p", {
		text: "No provider is configured yet. You can continue, but chat won't work until one is.",
		cls: "setting-item-description mod-warning notor-setup-wizard-provider-warning",
	});
	const updateWarning = () => warningEl.toggle(configuredProviders(ctx).length === 0);
	updateWarning();
	containerEl.addEventListener("change", updateWarning);
	ctx.addCleanup?.(() => containerEl.removeEventListener("change", updateWarning));
}

export function renderModelStep(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	host: SetupWizardHost
): void {
	containerEl.createEl("p", {
		text:
			"Model presets are named shortcuts for a provider and model pair (tiny, small, medium, large) " +
			"that you switch between in the chat panel. Pick a model for your default preset now; " +
			"you can fill in the others later.",
	});

	const presets = ctx.settings.model_presets;
	const preset = presets.find((p) => p.name === ctx.settings.default_preset) ?? presets[0];
	const candidates = presetCandidateProviders(ctx, host);

	if (!preset || candidates.length === 0) {
		containerEl.createEl("p", {
			text: preset
				? "Configure a provider first (select Back), then return here to pick a model."
				: "No model presets exist. Add one in the Models settings.",
			cls: "setting-item-description mod-warning",
		});
		renderAllPresetsLink(containerEl, host);
		return;
	}

	const providerId = candidates.some((p) => p.id === preset.provider_id) ? preset.provider_id : null;

	new Setting(containerEl)
		.setName(`Provider for the "${preset.name}" preset`)
		.addDropdown((dropdown) => {
			dropdown.addOption("", "Select provider…");
			for (const p of candidates) dropdown.addOption(p.id, p.display_name);
			dropdown.setValue(providerId ?? "");
			dropdown.onChange(async (value) => {
				preset.provider_id = value || null;
				preset.model_id = null;
				preset.use_extended_context = false;
				await ctx.saveSettings();
				host.rerender();
			});
		});

	if (providerId) renderModelPicker(containerEl, ctx, host, preset, providerId);

	containerEl.createEl("p", {
		text: isPresetConfigured(preset)
			? `✓ The "${preset.name}" preset is ready to use.`
			: "Choose a model to finish setting up this preset.",
		cls: isPresetConfigured(preset)
			? "notor-setup-wizard-check is-done"
			: "setting-item-description mod-warning",
	});

	renderAllPresetsLink(containerEl, host);
}

function renderModelPicker(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	host: SetupWizardHost,
	preset: ModelPreset,
	providerId: string
): void {
	const modelRow = new Setting(containerEl).setName("Model");
	const registry = ctx.plugin.getProviderRegistry();
	const currentValue = preset.model_id
		? buildOptionValue(preset.model_id, preset.use_extended_context)
		: "";

	const saveModel = async (value: string) => {
		const parsed = parseOptionValue(value);
		preset.model_id = parsed.modelId || null;
		preset.use_extended_context = parsed.isExtendedContext;
		await ctx.saveSettings();
	};

	const renderDropdown = (models: ModelInfo[]) =>
		modelRow.addDropdown((dropdown) => {
			dropdown.addOption("", "(select model)");
			addModelOptions(dropdown, models);
			selectModelOption(dropdown, currentValue);
			dropdown.onChange(async (value) => {
				await saveModel(value);
				host.rerender();
			});
		});

	const cached = registry.getCachedModels(providerId);
	if (cached.length > 0) {
		renderDropdown(cached);
		return;
	}

	modelRow.setDesc("Loading models...");
	registry
		.getModels(providerId)
		.then((models) => {
			if (!modelRow.settingEl.isConnected) return;
			modelRow.setDesc("");
			renderDropdown(models);
		})
		.catch((e) => {
			log.error("Failed to fetch models for setup wizard", { provider: providerId, error: String(e) });
			if (!modelRow.settingEl.isConnected) return;
			modelRow.setDesc("Couldn't load the model list. Enter a model ID instead.");
			modelRow.addText((text) =>
				text
					.setPlaceholder("Enter model ID...")
					.setValue(preset.model_id ?? "")
					.onChange(saveModel)
			);
		});
}

function renderAllPresetsLink(containerEl: HTMLElement, host: SetupWizardHost): void {
	new Setting(containerEl)
		.setName("All presets")
		.setDesc("Set up the other presets, thinking levels, and extended context.")
		.addButton((btn) =>
			btn.setButtonText("Configure all presets →").onClick(() => host.openInSettings("Models"))
		);
}
