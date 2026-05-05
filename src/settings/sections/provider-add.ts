/**
 * "Add provider" button and provider deletion for multi-instance support.
 */

import { Setting, Notice } from "obsidian";
import type { LLMProviderConfig, LLMProviderType } from "../../types";
import { clearProviderSecrets } from "../../utils/secrets";
import { generateProviderId, updateProvider } from "../helpers";
import type { SettingsContext } from "./context";

const PROVIDER_TYPE_LABELS: Record<LLMProviderType, string> = {
	local: "Local (OpenAI-compatible)",
	anthropic: "Anthropic",
	openai: "OpenAI",
	bedrock: "AWS Bedrock",
};

function createDefaultConfig(type: LLMProviderType, existingCount: number): LLMProviderConfig {
	const suffix = existingCount > 0 ? ` (${existingCount + 1})` : "";
	const base: LLMProviderConfig = {
		id: generateProviderId(type),
		type,
		enabled: false,
		display_name: `${PROVIDER_TYPE_LABELS[type]}${suffix}`,
	};

	switch (type) {
		case "local":
			base.endpoint = "";
			break;
		case "anthropic":
			base.endpoint = "https://api.anthropic.com";
			break;
		case "openai":
			base.endpoint = "https://api.openai.com";
			break;
		case "bedrock":
			base.aws_auth_method = "profile";
			base.aws_profile = "default";
			break;
	}

	return base;
}

/** Render the "Add provider" button at the end of the providers section. */
export function renderAddProviderButton(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl)
		.setName("Add provider")
		.setDesc("Add another provider instance (e.g., a second local server or AWS account).")
		.addDropdown((dropdown) => {
			dropdown.addOption("", "Select type…");
			dropdown.addOption("local", "Local (OpenAI-compatible)");
			dropdown.addOption("anthropic", "Anthropic");
			dropdown.addOption("openai", "OpenAI");
			dropdown.addOption("bedrock", "AWS Bedrock");
			dropdown.onChange(async (value) => {
				if (!value) return;
				const type = value as LLMProviderType;
				const existingCount = ctx.settings.providers.filter((p) => p.type === type).length;
				const config = createDefaultConfig(type, existingCount);
				ctx.settings.providers.push(config);
				await ctx.saveSettings();
				ctx.redisplay();
			});
		});
}

/** Render a "Delete" button for a provider instance (inline within a provider section). */
export function renderDeleteProviderButton(
	containerEl: HTMLElement,
	config: LLMProviderConfig,
	ctx: SettingsContext
): void {
	new Setting(containerEl)
		.setName("Remove this provider")
		.setDesc(`Permanently remove "${config.display_name}" and its stored credentials.`)
		.addButton((button) => {
			button
				.setButtonText("Delete")
				.setWarning()
				.onClick(async () => {
					const idx = ctx.settings.providers.findIndex((p) => p.id === config.id);
					if (idx < 0) return;

					// Clear secrets
					clearProviderSecrets(ctx.app, config.id, config.type);

					// Remove from settings
					ctx.settings.providers.splice(idx, 1);

					// If this was the active provider, switch to the first remaining
					if (ctx.settings.active_provider === config.id) {
						ctx.settings.active_provider = ctx.settings.providers[0]?.id ?? "local";
					}

					await ctx.saveSettings();
					new Notice(`Provider "${config.display_name}" removed.`);
					ctx.redisplay();
				});
		});
}
