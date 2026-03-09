/**
 * Active provider selection section renderer.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Active provider" dropdown. */
export function renderActiveProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	containerEl.createEl("h2", { text: "Active provider" });

	new Setting(containerEl)
		.setName("Active provider")
		.setDesc("The LLM provider used for all chat conversations.")
		.addDropdown((dropdown) => {
			const providerLabels: Record<string, string> = {
				local: "Local (OpenAI-compatible)",
				anthropic: "Anthropic",
				openai: "OpenAI",
				bedrock: "AWS Bedrock",
			};
			for (const [value, label] of Object.entries(providerLabels)) {
				dropdown.addOption(value, label);
			}
			dropdown.setValue(ctx.settings.active_provider);
			dropdown.onChange(async (value) => {
				ctx.settings.active_provider = value;
				await ctx.saveSettings();
			});
		});
}
