/**
 * First-run detection for the guided setup banner.
 *
 * Evaluated on every settings-tab render from current state only (no
 * `setup_completed` flag), so the banner reappears if the user later
 * clears out every provider.
 *
 * The provider `enabled` flag is deliberately ignored: the seeded `local`
 * provider ships `enabled: true` with an empty endpoint.
 */

import type { App } from "obsidian";
import type { LLMProviderConfig, ModelPreset } from "../types";
import type { NotorSettings } from "./types";
import {
	getSecret,
	secretIdForAccessKeyId,
	secretIdForApiKey,
	secretIdForSecretAccessKey,
} from "../utils/secrets";

/** Whether a preset has both a provider and a model assigned. */
export function isPresetConfigured(preset: ModelPreset): boolean {
	return preset.provider_id !== null && preset.model_id !== null;
}

/**
 * Whether a provider instance has enough configuration to handle requests.
 *
 * Bedrock with profile auth always has a profile name (it defaults to
 * "default"), so it only counts once a model preset references it.
 */
export function isProviderConfigured(
	app: App,
	config: LLMProviderConfig,
	presets: ModelPreset[]
): boolean {
	switch (config.type) {
		case "local":
			return !!config.endpoint?.trim();
		case "anthropic":
		case "openai":
			return getSecret(app, secretIdForApiKey(config.id)) !== null;
		case "bedrock":
			if (config.aws_auth_method === "keys") {
				return (
					getSecret(app, secretIdForAccessKeyId(config.id)) !== null &&
					getSecret(app, secretIdForSecretAccessKey(config.id)) !== null
				);
			}
			return presets.some((p) => p.provider_id === config.id);
	}
}

/** Whether the user still needs the guided setup (no provider or preset configured). */
export function needsInitialSetup(app: App, settings: NotorSettings): boolean {
	if (settings.model_presets.some(isPresetConfigured)) return false;
	return !settings.providers.some((p) => isProviderConfigured(app, p, settings.model_presets));
}
