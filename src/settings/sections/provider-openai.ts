/**
 * OpenAI provider section renderer.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { SecretComponent, Setting } from "obsidian";
import { SECRET_IDS } from "../../utils/secrets";
import { getProvider, updateProvider } from "../helpers";
import { renderConnectionTestButton } from "./connection-test";
import type { SettingsContext } from "./context";

/** Render the "OpenAI" provider settings. */
export function renderOpenAIProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("OpenAI");

	const provider = getProvider(ctx.settings, "openai");

	new Setting(containerEl)
		.setName("API key")
		.setDesc("Your OpenAI API key.")
		.addComponent(
			(el) =>
				new SecretComponent(ctx.app, el)
					.setValue(SECRET_IDS.OPENAI_API_KEY)
					.onChange((_value) => {
						// SecretComponent writes directly to SecretStorage.
					})
		);

	new Setting(containerEl)
		.setName("Custom endpoint URL")
		.setDesc(
			"Override the default OpenAI endpoint. Leave blank to use api.openai.com. " +
				"Useful for Azure OpenAI or other compatible services."
		)
		.addText((text) =>
			text
				.setPlaceholder("https://api.openai.com")
				.setValue(
					provider.endpoint && provider.endpoint !== "https://api.openai.com"
						? provider.endpoint
						: ""
				)
				.onChange(async (value) => {
					const updated = { ...getProvider(ctx.settings, "openai") };
					updated.endpoint = value.trim() || "https://api.openai.com";
					updateProvider(ctx.settings, updated);
					await ctx.saveSettings();
				})
		);

	renderConnectionTestButton(containerEl, "openai", ctx);
}
