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

	renderCustomParamsSetting(groupEl, ctx, provider);

	new Setting(groupEl)
		.setName("Display name")
		.addText((text) => {
			text
				.setValue(provider.display_name)
				.onChange(async (value) => {
					provider.display_name = value.trim() || provider.display_name;
					updateProvider(ctx.settings, provider);
					await ctx.saveSettings();
				});
			text.inputEl.addEventListener("blur", () => ctx.redisplay());
		});
	renderDeleteProviderButton(groupEl, provider, ctx);
}

/**
 * Render the "Custom parameters (JSON)" textarea for a local provider.
 *
 * Accepts a free-form JSON object that is merged top-level into each
 * `/chat/completions` request body (e.g. Ollama's `keep_alive`). Validates
 * live — malformed or non-object input shows an inline error and is NOT
 * persisted, so a bad edit can never corrupt the stored config.
 */
function renderCustomParamsSetting(
	groupEl: HTMLElement,
	ctx: SettingsContext,
	provider: LLMProviderConfig
): void {
	const setting = new Setting(groupEl)
		.setName("Custom parameters (JSON)")
		.setDesc(
			"Local/Ollama-specific. A JSON object merged into each request body — " +
				'e.g. { "keep_alive": "5m" } to keep the model resident between chats. ' +
				"Notor's own fields (model, messages, stream, and any tools/temperature/max-tokens it sends) " +
				"always take precedence. Strict servers may reject unknown keys."
		);

	let errorEl: HTMLElement | null = null;
	const clearError = () => {
		if (errorEl) {
			errorEl.remove();
			errorEl = null;
		}
	};
	const showError = (message: string) => {
		clearError();
		errorEl = groupEl.createEl("p", {
			text: message,
			cls: "notor-provider-error",
		});
		setting.settingEl.after(errorEl);
	};

	setting.addTextArea((text) => {
		text
			.setPlaceholder('{ "keep_alive": "5m" }')
			.setValue(
				provider.extra_body_params
					? JSON.stringify(provider.extra_body_params, null, 2)
					: ""
			)
			.onChange(async (value) => {
				const trimmed = value.trim();
				if (!trimmed) {
					clearError();
					delete provider.extra_body_params;
					updateProvider(ctx.settings, provider);
					await ctx.saveSettings();
					return;
				}

				let parsed: unknown;
				try {
					parsed = JSON.parse(trimmed);
				} catch {
					showError("Invalid JSON — changes not saved.");
					return;
				}
				if (
					typeof parsed !== "object" ||
					parsed === null ||
					Array.isArray(parsed)
				) {
					showError("Expected a JSON object (e.g. { \"keep_alive\": \"5m\" }) — changes not saved.");
					return;
				}

				clearError();
				provider.extra_body_params = parsed as Record<string, unknown>;
				updateProvider(ctx.settings, provider);
				await ctx.saveSettings();
			});
	});
}
