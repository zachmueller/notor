/**
 * Factory helper to build a ProviderRegistry from plugin settings.
 *
 * Used by the settings tab's "Test connection" button. This module is
 * imported DYNAMICALLY from settings.ts to avoid circular dependencies
 * and to keep the initial module graph lean.
 *
 * NOTE: AWS Bedrock is intentionally NOT registered here. The Bedrock
 * provider relies on `@aws-sdk/credential-providers` (`fromIni`) which
 * is a Node.js-only package — its browser bundle omits `fromIni`, so
 * bundling it here would cause an esbuild resolution error. Bedrock is
 * registered in the full plugin lifecycle (INT-001) where the complete
 * provider graph is assembled at runtime inside Obsidian's Electron
 * environment. Connection testing for Bedrock is handled by the plugin's
 * main registry, not this lightweight test helper.
 */

import type { App } from "obsidian";
import type { NotorSettings } from "../settings";
import type { LLMProviderType } from "../types";
import { ProviderRegistry } from "./index";
import { LocalProvider } from "./local-provider";
import { AnthropicProvider } from "./anthropic-provider";
import { OpenAIProvider } from "./openai-provider";

/**
 * Build and return a ProviderRegistry wired with HTTP-based providers
 * (local, Anthropic, OpenAI). Used for connection testing in settings.
 *
 * Bedrock is excluded — see module-level note above.
 */
export function buildProviderRegistry(
	app: App,
	settings: NotorSettings
): ProviderRegistry {
	const registry = new ProviderRegistry(
		app,
		settings.providers,
		settings.active_provider as LLMProviderType
	);

	// Local (OpenAI-compatible)
	registry.registerFactory("local", (config, appInstance) => {
		return new LocalProvider(config, appInstance);
	});

	// Anthropic
	registry.registerFactory("anthropic", (config, appInstance) => {
		return new AnthropicProvider(config, appInstance);
	});

	// OpenAI
	registry.registerFactory("openai", (config, appInstance) => {
		return new OpenAIProvider(config, appInstance);
	});

	// Bedrock is intentionally not registered here — see module-level note.

	return registry;
}
