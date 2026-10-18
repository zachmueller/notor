/**
 * Dispatch a provider instance to its type-specific section renderer.
 *
 * Shared by the settings tab's Providers group and the guided setup wizard.
 */

import type { LLMProviderConfig } from "../../types";
import { renderLocalProviderSection } from "./provider-local";
import { renderAnthropicProviderSection } from "./provider-anthropic";
import { renderOpenAIProviderSection } from "./provider-openai";
import { renderBedrockProviderSection } from "./provider-bedrock";
import type { SettingsContext } from "./context";

/** Render the settings for one provider instance. */
export function renderProviderSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	config: LLMProviderConfig
): void {
	switch (config.type) {
		case "local":
			renderLocalProviderSection(containerEl, ctx, config);
			break;
		case "anthropic":
			renderAnthropicProviderSection(containerEl, ctx, config);
			break;
		case "openai":
			renderOpenAIProviderSection(containerEl, ctx, config);
			break;
		case "bedrock":
			renderBedrockProviderSection(containerEl, ctx, config);
			break;
	}
}
