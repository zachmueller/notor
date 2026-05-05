/**
 * Local (OpenAI-compatible) provider section renderer.
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

/** Render the "Local (OpenAI-compatible)" provider settings for a given instance. */
export function renderLocalProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	config?: LLMProviderConfig
): void {
	const provider = config ?? ctx.settings.providers.find((p) => p.type === "local")!;

	new Setting(containerEl).setHeading().setName(provider.display_name);

	const groupEl = containerEl.createDiv({ cls: "notor-provider-group" });

	new Setting(groupEl)
		.setName("Endpoint URL")
		.setDesc(
			"Base URL of the local OpenAI-compatible API server (e.g. Ollama, LM Studio)."
		)
		.addText((text) =>
			text
				.setPlaceholder("http://localhost:11434/v1")
				.setValue(provider.endpoint ?? "")
				.onChange(async (value) => {
					provider.endpoint = value.trim();
					updateProvider(ctx.settings, provider);
					await ctx.saveSettings();
				})
		);

	new Setting(groupEl)
		.setName("API key")
		.setDesc(
			"Optional API key for local servers that require authentication."
		)
		.addComponent(
			(el) =>
				new SecretComponent(ctx.app, el)
					.setValue(secretIdForApiKey(provider.id))
					.onChange((_value) => {
						// SecretComponent writes directly to SecretStorage.
					})
		);

	renderConnectionTestButton(groupEl, provider.id, ctx);

	// Only show display name editor and delete for non-default instances
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
