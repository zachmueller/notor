/**
 * Preset resolver — single source of truth for converting a preset name
 * into concrete provider+model+extended values.
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 4
 */

import type { LLMProviderType, ModelPreset } from "../types";

/** A fully resolved preset with concrete provider+model details. */
export interface ResolvedPreset {
	presetName: string;
	providerType: LLMProviderType;
	modelId: string;
	useExtendedContext: boolean;
}

/**
 * Resolve a preset name to concrete model details.
 * Returns null if the preset doesn't exist or isn't configured (provider_type/model_id is null).
 */
export function resolvePreset(presetName: string, presets: ModelPreset[]): ResolvedPreset | null {
	const preset = presets.find((p) => p.name === presetName);
	if (!preset || preset.provider_type === null || preset.model_id === null) {
		return null;
	}
	return {
		presetName: preset.name,
		providerType: preset.provider_type,
		modelId: preset.model_id,
		useExtendedContext: preset.use_extended_context,
	};
}

/**
 * Check if a stored preset is stale — i.e., the preset name still exists but now
 * maps to a different provider/model than what was stored on the conversation.
 */
export function isPresetStale(
	presetName: string,
	storedProvider: string,
	storedModel: string,
	presets: ModelPreset[],
): boolean {
	const resolved = resolvePreset(presetName, presets);
	if (!resolved) {
		// Preset no longer exists or is unconfigured — treat as stale
		return true;
	}
	return resolved.providerType !== storedProvider || resolved.modelId !== storedModel;
}

/**
 * Find the first configured preset (provider_type != null) in the list.
 * Used as ultimate fallback when the default preset is unconfigured.
 */
export function findFirstConfiguredPreset(presets: ModelPreset[]): ResolvedPreset | null {
	for (const preset of presets) {
		if (preset.provider_type !== null && preset.model_id !== null) {
			return {
				presetName: preset.name,
				providerType: preset.provider_type,
				modelId: preset.model_id,
				useExtendedContext: preset.use_extended_context,
			};
		}
	}
	return null;
}
