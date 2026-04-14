/**
 * Local (OpenAI-compatible) provider section renderer.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { SecretComponent, Setting } from "obsidian";
import { SECRET_IDS } from "../../utils/secrets";
import { getProvider, updateProvider } from "../helpers";
import { renderConnectionTestButton } from "./connection-test";
import type { SettingsContext } from "./context";

/** Render the "Local (OpenAI-compatible)" provider settings. */
export function renderLocalProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Local (OpenAI-compatible)");

	const provider = getProvider(ctx.settings, "local");

	new Setting(containerEl)
		.setName("Endpoint URL")
		.setDesc(
			"Base URL of the local OpenAI-compatible API server (e.g. Ollama, LM Studio)."
		)
		.addText((text) =>
			text
				.setPlaceholder("http://localhost:11434/v1")
				.setValue(provider.endpoint ?? "")
				.onChange(async (value) => {
					const updated = { ...getProvider(ctx.settings, "local") };
					updated.endpoint = value.trim();
					updateProvider(ctx.settings, updated);
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("API key")
		.setDesc(
			"Optional API key for local servers that require authentication."
		)
		.addComponent(
			(el) =>
				new SecretComponent(ctx.app, el)
					.setValue(SECRET_IDS.LOCAL_API_KEY)
					.onChange((_value) => {
						// SecretComponent writes directly to SecretStorage;
						// no additional save needed.
					})
		);

	renderConnectionTestButton(containerEl, "local", ctx);
}
