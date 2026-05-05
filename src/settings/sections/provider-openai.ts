/**
 * OpenAI provider section renderer.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { SecretComponent, Setting } from "obsidian";
import { secretIdForApiKey } from "../../utils/secrets";
import type { LLMProviderConfig } from "../../types";
import { updateProvider } from "../helpers";
import { renderConnectionTestButton } from "./connection-test";
import { renderDeleteProviderButton } from "./provider-add";
import type { SettingsContext } from "./context";

/** Render the "OpenAI" provider settings for a given instance. */
export function renderOpenAIProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	config?: LLMProviderConfig
): void {
	const provider = config ?? ctx.settings.providers.find((p) => p.type === "openai")!;

	new Setting(containerEl).setHeading().setName(provider.display_name);

	const groupEl = containerEl.createDiv({ cls: "notor-provider-group" });

	new Setting(groupEl)
		.setName("API key")
		.setDesc("Your OpenAI API key.")
		.addComponent(
			(el) =>
				new SecretComponent(ctx.app, el)
					.setValue(secretIdForApiKey(provider.id))
					.onChange((_value) => {
						// SecretComponent writes directly to SecretStorage.
					})
		);

	new Setting(groupEl)
		.setName("Custom endpoint URL")
		.setDesc(
			"Override the default OpenAI API base URL. Leave blank to use the default. " +
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
					provider.endpoint = value.trim() || "https://api.openai.com";
					updateProvider(ctx.settings, provider);
					await ctx.saveSettings();
				})
		);

	renderConnectionTestButton(groupEl, provider.id, ctx);

	if (provider.id !== provider.type) {
		new Setting(groupEl)
			.setName("Display name")
			.addText((text) =>
				text
					.setValue(provider.display_name)
					.onChange(async (value) => {
						provider.display_name = value.trim() || provider.display_name;
						updateProvider(ctx.settings, provider);
						await ctx.saveSettings();
					})
			);
		renderDeleteProviderButton(groupEl, provider, ctx);
	}
}
