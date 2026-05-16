import type { Persona } from "../types";
import type { ProviderRegistry } from "../providers/index";
import type { ModelPreset } from "../types";
import { resolvePreset } from "../presets/preset-resolver";

export interface PersonaOverrideResolution {
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	presetName: string | null;
	thinkingLevel: string | null;
}

/**
 * Resolve a persona's provider/model overrides without mutating any state.
 *
 * Returns null if the persona specifies no overrides or if none could be
 * resolved (provider/model unavailable).
 */
export function resolvePersonaOverrides(
	persona: Persona,
	providerRegistry: ProviderRegistry,
	presets: ModelPreset[],
): PersonaOverrideResolution | null {
	// Preset takes highest priority
	if (persona.preferred_preset) {
		const resolved = resolvePreset(persona.preferred_preset, presets);
		if (resolved) {
			const config = providerRegistry.getConfig(resolved.providerId);
			if (config) {
				return {
					providerId: resolved.providerId,
					modelId: resolved.modelId,
					useExtendedContext: resolved.useExtendedContext,
					presetName: resolved.presetName,
					thinkingLevel: resolved.thinkingLevel,
				};
			}
		}
		// Preset not available — fall through to legacy provider/model
	}

	// Legacy provider/model overrides
	let providerId: string | null = null;
	let modelId: string | null = null;
	let useExtendedContext = false;

	if (persona.preferred_provider) {
		let config = providerRegistry.getConfig(persona.preferred_provider);
		if (!config) {
			const resolvedId = providerRegistry.resolveTypeToId(persona.preferred_provider);
			if (resolvedId) config = providerRegistry.getConfig(resolvedId);
		}
		if (config) {
			providerId = config.id;
		}
	}

	if (persona.preferred_model) {
		const checkProviderId = providerId ?? providerRegistry.getActiveId();
		const cachedModels = providerRegistry.getCachedModels(checkProviderId);
		const modelAvailable =
			cachedModels.length === 0 ||
			cachedModels.some((m) => m.id === persona.preferred_model);
		if (modelAvailable) {
			modelId = persona.preferred_model;
		}
	}

	if (!providerId && !modelId) return null;

	return {
		providerId: providerId ?? providerRegistry.getActiveId(),
		modelId: modelId ?? providerRegistry.getConfig(providerId ?? providerRegistry.getActiveId())?.model_id ?? "",
		useExtendedContext,
		presetName: null,
		thinkingLevel: null,
	};
}
