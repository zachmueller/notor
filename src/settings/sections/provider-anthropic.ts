/**
 * Anthropic provider section renderer.
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

/** Render the "Anthropic" provider settings for a given instance. */
export function renderAnthropicProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	config?: LLMProviderConfig
): void {
	const provider = config ?? ctx.settings.providers.find((p) => p.type === "anthropic")!;

	new Setting(containerEl).setHeading().setName(provider.display_name);

	const groupEl = containerEl.createDiv({ cls: "notor-provider-group" });

	new Setting(groupEl)
		.setName("API key")
		.setDesc("Your Anthropic API key.")
		.addComponent(
			(el) =>
				new SecretComponent(ctx.app, el)
					.setValue(secretIdForApiKey(provider.id))
					.onChange((_value) => {
						// SecretComponent writes directly to SecretStorage.
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
