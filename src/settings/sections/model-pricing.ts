/**
 * Model pricing settings section renderer (SET-002).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Notice, Setting } from "obsidian";
import type { ModelPricing } from "../types";
import type { SettingsContext } from "./context";

/** Render the "Model pricing" settings section. */
export function renderModelPricingSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Model pricing");
	containerEl.createEl("p", {
		text:
			"Optional per-model pricing for token cost estimates. " +
			"If not configured, token counts are still shown but costs are omitted. " +
			"Enter costs in USD per 1,000 tokens.",
		cls: "setting-item-description",
	});

	const pricing = ctx.settings.model_pricing;

	// Render existing entries
	const existingModelIds = Object.keys(pricing);
	for (const modelId of existingModelIds) {
		const entry = pricing[modelId];
		if (entry) {
			renderModelPricingRow(containerEl, modelId, entry, ctx);
		}
	}

	// Add new entry form
	let newModelId = "";
	let newInputPrice = "";
	let newOutputPrice = "";

	const addSetting = new Setting(containerEl)
		.setName("Add model pricing")
		.setDesc(
			"Model ID (e.g., gpt-4o, claude-sonnet-4-5), input price per 1k tokens, output price per 1k tokens."
		);

	addSetting.addText((text) => {
		text.setPlaceholder("Model ID").onChange((v) => {
			newModelId = v.trim();
		});
		text.inputEl.addClass("notor-input-w-160");
	});
	addSetting.addText((text) => {
		text.setPlaceholder("Input $").onChange((v) => {
			newInputPrice = v.trim();
		});
		text.inputEl.addClass("notor-input-w-80");
	});
	addSetting.addText((text) => {
		text.setPlaceholder("Output $").onChange((v) => {
			newOutputPrice = v.trim();
		});
		text.inputEl.addClass("notor-input-w-80");
	});
	addSetting.addButton((btn) =>
		btn.setButtonText("Add").onClick(async () => {
			if (!newModelId) {
				new Notice("Model ID is required.");
				return;
			}
			const input = parseFloat(newInputPrice);
			const output = parseFloat(newOutputPrice);
			if (isNaN(input) || isNaN(output)) {
				new Notice("Enter valid numeric prices.");
				return;
			}
			ctx.settings.model_pricing[newModelId] = {
				input,
				output,
			};
			await ctx.saveSettings();
			ctx.redisplay();
		})
	);
}

/** Render a single model pricing row with a remove button. */
function renderModelPricingRow(
	containerEl: HTMLElement,
	modelId: string,
	pricing: ModelPricing,
	ctx: SettingsContext
): void {
	new Setting(containerEl)
		.setName(modelId)
		.setDesc(
			`Input: $${pricing.input}/1K tokens · Output: $${pricing.output}/1K tokens`
		)
		.addButton((btn) =>
			btn
				.setButtonText("Remove")
				.setWarning()
				.onClick(async () => {
					delete ctx.settings.model_pricing[modelId];
					await ctx.saveSettings();
					ctx.redisplay();
				})
		);
}
