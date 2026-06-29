/**
 * "Models" settings section renderer — preset management UI.
 *
 * Displays the default preset selector, editable preset rows (name,
 * provider, model, delete), add/reorder controls, and populates model
 * dropdowns from the ProviderRegistry.
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 5.2
 */

import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import type { ModelPreset } from "../../types";
import { groupModels, parseOptionValue, buildOptionValue } from "../../providers/model-grouping";
import { supportsThinking } from "../../providers/model-metadata";
import { logger } from "../../utils/logger";

const log = logger("ModelPresetsSection");

// API field name shown as the custom-thinking placeholder; referenced through
// a const so the sentence-case lint rule treats it as a value, not UI copy.
const BUDGET_TOKENS_PLACEHOLDER = "budget_tokens";

/** Build a display-name lookup from the current provider configs. */
function buildProviderLabels(ctx: SettingsContext): Record<string, string> {
	const labels: Record<string, string> = {};
	for (const p of ctx.settings.providers) {
		labels[p.id] = p.display_name;
	}
	return labels;
}

/** Render the "Models" settings section. */
export function renderModelPresetsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Model presets");
	containerEl.createEl("p", {
		text:
			"Define named presets that map to specific provider + model combinations. " +
			"Use presets to quickly switch between models in the chat panel.",
		cls: "setting-item-description",
	});

	const presets = ctx.settings.model_presets;

	// --- Default preset selector ---
	const configuredPresets = presets.filter((p) => p.provider_id !== null && p.model_id !== null);
	new Setting(containerEl)
		.setName("Default preset")
		.setDesc("The preset used for new conversations.")
		.addDropdown((dropdown) => {
			if (configuredPresets.length === 0) {
				dropdown.addOption("", "(no presets configured)");
				dropdown.setDisabled(true);
			} else {
				for (const p of configuredPresets) {
					dropdown.addOption(p.name, p.name);
				}
				dropdown.setValue(ctx.settings.default_preset);
				dropdown.onChange(async (value) => {
					ctx.settings.default_preset = value;
					await ctx.saveSettings();
				});
			}
		});

	// --- Preset rows ---
	const listContainer = containerEl.createDiv({ cls: "notor-preset-list" });
	renderPresetRows(listContainer, ctx);

	// --- Add preset button ---
	new Setting(containerEl)
		.setName("Add preset")
		.setDesc("Create a new unconfigured preset.")
		.addButton((btn) =>
			btn.setButtonText("Add").onClick(async () => {
				const name = generateUniqueName(presets);
				presets.push({
					name,
					provider_id: null,
					model_id: null,
					use_extended_context: false,
					thinking_level: null,
				});
				await ctx.saveSettings();
				ctx.redisplay();
			}),
		);
}

/** Render editable rows for each preset. */
function renderPresetRows(containerEl: HTMLElement, ctx: SettingsContext): void {
	const presets = ctx.settings.model_presets;
	const registry = ctx.plugin.getProviderRegistry();
	const providerLabels = buildProviderLabels(ctx);

	for (let i = 0; i < presets.length; i++) {
		const preset = presets[i]!;
		const rowEl = containerEl.createDiv({ cls: "notor-preset-row" });

		// --- Preset name ---
		const nameRow = new Setting(rowEl)
			.setName(`Preset: ${preset.name}`)
			.setDesc(
				preset.provider_id && preset.model_id
					? `${providerLabels[preset.provider_id] ?? preset.provider_id} \u00B7 ${preset.model_id}${preset.use_extended_context ? " \u00B7 1M" : ""}`
					: "(not configured)",
			);

		// Name edit
		nameRow.addText((text) => {
			text.setPlaceholder("Preset name")
				.setValue(preset.name)
				.onChange(async (value) => {
					const trimmed = value.trim();
					if (!trimmed) return;
					// Check uniqueness
					if (presets.some((p, idx) => idx !== i && p.name === trimmed)) {
						new Notice(`Preset name "${trimmed}" is already taken.`);
						return;
					}
					// Update default_preset reference if this preset was the default
					if (ctx.settings.default_preset === preset.name) {
						ctx.settings.default_preset = trimmed;
					}
					preset.name = trimmed;
					await ctx.saveSettings();
				});
		});

		// --- Provider dropdown ---
		const providerRow = new Setting(rowEl)
			.setName("Provider");

		providerRow.addDropdown((dropdown) => {
			dropdown.addOption("", "(not configured)");
			for (const provider of ctx.settings.providers) {
				dropdown.addOption(provider.id, provider.display_name);
			}
			dropdown.setValue(preset.provider_id ?? "");
			dropdown.onChange(async (value) => {
				if (value === "") {
					preset.provider_id = null;
					preset.model_id = null;
					preset.use_extended_context = false;
				} else {
					preset.provider_id = value;
					// Reset model when provider changes
					preset.model_id = null;
					preset.use_extended_context = false;
				}
				await ctx.saveSettings();
				ctx.redisplay();
			});
		});

		// --- Model dropdown (only if provider is selected) ---
		if (preset.provider_id) {
			const modelRow = new Setting(rowEl).setName("Model");
			const providerId = preset.provider_id;

			// Try cached models first, trigger background fetch if needed
			const cached = registry.getCachedModels(providerId);
			const currentValue = preset.model_id
				? buildOptionValue(preset.model_id, preset.use_extended_context)
				: "";

			if (cached.length > 0) {
				renderModelDropdown(modelRow, cached, currentValue, preset, i, ctx, providerId, registry);
			} else {
				// Show a loading indicator and fetch models
				modelRow.setDesc("Loading models...");
				registry
					.getModels(providerId)
					.then((models) => {
						modelRow.setDesc("");
						renderModelDropdown(modelRow, models, currentValue, preset, i, ctx, providerId, registry);
					})
					.catch((e) => {
						log.error("Failed to fetch models for preset", { provider: providerId, error: String(e) });
						modelRow.setDesc("Failed to load models.");
						// Fallback: text input
						modelRow.addText((text) => {
							text.setPlaceholder("Enter model ID...")
								.setValue(preset.model_id ?? "")
								.onChange(async (value) => {
									const parsed = parseOptionValue(value);
									preset.model_id = parsed.modelId || null;
									preset.use_extended_context = parsed.isExtendedContext;
									await ctx.saveSettings();
								});
						});
						modelRow.addExtraButton((btn) =>
							btn.setIcon("refresh-cw").setTooltip("Retry loading models").onClick(async () => {
								btn.setDisabled(true);
								try {
									await registry.refreshModels(providerId);
								} catch (e) {
									log.error("Failed to refresh models", { provider: providerId, error: String(e) });
									new Notice("Failed to refresh model list.");
								}
								ctx.redisplay();
							}),
						);
					});
			}
		}

		// --- Thinking level control (only for models that support it) ---
		if (preset.model_id && supportsThinking(preset.model_id)) {
			const isCustom = preset.thinking_level !== null
				&& !["low", "medium", "high"].includes(preset.thinking_level);

			const thinkingSetting = new Setting(rowEl)
				.setName("Thinking")
				.setDesc("Extended thinking / reasoning level")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Off");
					dropdown.addOption("low", "Low");
					dropdown.addOption("medium", "Medium");
					dropdown.addOption("high", "High");
					dropdown.addOption("custom", "Custom...");
					dropdown.setValue(
						preset.thinking_level === null ? ""
							: (["low", "medium", "high"].includes(preset.thinking_level) ? preset.thinking_level : "custom"),
					);
					dropdown.onChange(async (value) => {
						if (value === "" || value === "custom") {
							preset.thinking_level = value === "" ? null
								: (isCustom ? preset.thinking_level : "4096");
						} else {
							preset.thinking_level = value;
						}
						await ctx.saveSettings();
						ctx.redisplay();
					});
				});

			if (isCustom) {
				thinkingSetting.addText((text) => {
					text.setPlaceholder(BUDGET_TOKENS_PLACEHOLDER)
						.setValue(preset.thinking_level!);
					text.inputEl.addClass("notor-input-w-80");
					text.onChange(async (value) => {
						const asInt = parseInt(value, 10);
						if (!isNaN(asInt) && asInt > 0) {
							preset.thinking_level = String(asInt);
							await ctx.saveSettings();
						}
					});
				});
			}
		}

		// --- Reorder + delete controls ---
		const controlsRow = new Setting(rowEl);
		controlsRow.settingEl.addClass("notor-preset-controls");

		// Move up
		if (i > 0) {
			controlsRow.addButton((btn) =>
				btn.setIcon("arrow-up").setTooltip("Move up").onClick(async () => {
					[presets[i - 1], presets[i]] = [presets[i]!, presets[i - 1]!];
					await ctx.saveSettings();
					ctx.redisplay();
				}),
			);
		}

		// Move down
		if (i < presets.length - 1) {
			controlsRow.addButton((btn) =>
				btn.setIcon("arrow-down").setTooltip("Move down").onClick(async () => {
					[presets[i], presets[i + 1]] = [presets[i + 1]!, presets[i]!];
					await ctx.saveSettings();
					ctx.redisplay();
				}),
			);
		}

		// Delete (disabled if this is the default preset)
		controlsRow.addButton((btn) => {
			btn.setIcon("trash").setTooltip("Delete preset");
			if (ctx.settings.default_preset === preset.name) {
				btn.setDisabled(true);
				btn.setTooltip("Cannot delete the default preset");
			}
			btn.onClick(async () => {
				presets.splice(i, 1);
				await ctx.saveSettings();
				ctx.redisplay();
			});
		});
	}
}

/** Render a model dropdown for a preset row. */
function renderModelDropdown(
	setting: Setting,
	models: import("../../types").ModelInfo[],
	currentValue: string,
	preset: ModelPreset,
	_index: number,
	ctx: SettingsContext,
	providerId: string,
	registry: ReturnType<SettingsContext["plugin"]["getProviderRegistry"]>,
): void {
	setting.addDropdown((dropdown) => {
		dropdown.addOption("", "(select model)");

		const groups = groupModels(models);

		// Use optgroup-style rendering for grouped models (Bedrock)
		if (groups.some((g) => g.variants.length > 1)) {
			for (const group of groups) {
				for (const variant of group.variants) {
					const label = variant.region
						? `${group.label} ${variant.region}${variant.contextLabel ? ` (${variant.contextLabel})` : ""}`
						: `${group.label}${variant.contextLabel ? ` (${variant.contextLabel})` : ""}`;
					dropdown.addOption(variant.optionValue, label);
				}
			}
		} else {
			// Flat list (non-Bedrock providers)
			for (const m of models) {
				dropdown.addOption(m.id, m.display_name || m.id);
			}
			// Also add ::1m variants for models that support extended context
			for (const group of groups) {
				for (const variant of group.variants) {
					if (variant.isExtendedContext) {
						dropdown.addOption(
							variant.optionValue,
							`${variant.model.display_name || variant.model.id} (1M)`,
						);
					}
				}
			}
		}

		dropdown.setValue(currentValue);
		dropdown.onChange(async (value) => {
			if (value === "") {
				preset.model_id = null;
				preset.use_extended_context = false;
			} else {
				const parsed = parseOptionValue(value);
				preset.model_id = parsed.modelId;
				preset.use_extended_context = parsed.isExtendedContext;
			}
			await ctx.saveSettings();
			ctx.redisplay();
		});
	});

	setting.addExtraButton((btn) =>
		btn.setIcon("refresh-cw").setTooltip("Refresh model list").onClick(async () => {
			btn.setDisabled(true);
			try {
				await registry.refreshModels(providerId);
			} catch (e) {
				log.error("Failed to refresh models", { provider: providerId, error: String(e) });
				new Notice("Failed to refresh model list.");
			}
			ctx.redisplay();
		}),
	);
}

/** Generate a unique preset name like "preset-1", "preset-2", etc. */
function generateUniqueName(presets: ModelPreset[]): string {
	const existingNames = new Set(presets.map((p) => p.name));
	let counter = 1;
	while (existingNames.has(`preset-${counter}`)) {
		counter++;
	}
	return `preset-${counter}`;
}
