/**
 * Preset resolver — single source of truth for converting a preset name
 * into concrete provider+model+extended values.
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 4
 */

import type { ModelPreset } from "../types";

/** A fully resolved preset with concrete provider+model details. */
export interface ResolvedPreset {
	presetName: string;
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
}

/**
 * Resolve a preset name to concrete model details.
 * Returns null if the preset doesn't exist or isn't configured (provider_id/model_id is null).
 */
export function resolvePreset(presetName: string, presets: ModelPreset[]): ResolvedPreset | null {
	const preset = presets.find((p) => p.name === presetName);
	if (!preset || preset.provider_id === null || preset.model_id === null) {
		return null;
	}
	return {
		presetName: preset.name,
		providerId: preset.provider_id,
		modelId: preset.model_id,
		useExtendedContext: preset.use_extended_context,
		thinkingLevel: preset.thinking_level ?? null,
	};
}

/** Result of resolving a conversation's model configuration via the fallback chain. */
export interface ConversationModelResolution {
	/** Preset name to display (null = "Custom" mode). */
	presetName: string | null;
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
	/** Which fallback level produced this resolution. */
	source: "preset" | "stored" | "default";
}

/**
 * Resolve the model configuration for an existing conversation. The JSONL
 * header is the authority, so the stored values win:
 *   1. Stored provider/model/extended/thinking when the provider is still
 *      accessible. `preset_name` is carried through as a label only — later
 *      edits to the preset's definition never change a conversation's model.
 *   2. The stored preset's CURRENT definition, only if the stored provider
 *      is gone (or the header has no model)
 *   3. The user's default preset
 *   4. Any configured preset
 *
 * Returns null only if no resolution is possible (no configured presets at all).
 */
export function resolveConversationModel(
	conversation: { preset_name?: string | null; provider_id: string; model_id: string; use_extended_context?: boolean; thinking_level?: string | null },
	presets: ModelPreset[],
	defaultPresetName: string,
	isProviderAccessible: (providerId: string) => boolean,
): ConversationModelResolution | null {
	// Step 1: The stored selection, when its provider is still accessible.
	if (conversation.model_id && isProviderAccessible(conversation.provider_id)) {
		return {
			presetName: conversation.preset_name ?? null,
			providerId: conversation.provider_id,
			modelId: conversation.model_id,
			useExtendedContext: conversation.use_extended_context ?? false,
			thinkingLevel: conversation.thinking_level ?? null,
			source: "stored",
		};
	}

	// Step 2: The stored preset's current definition (stored provider gone).
	if (conversation.preset_name) {
		const resolved = resolvePreset(conversation.preset_name, presets);
		if (resolved) {
			return {
				presetName: resolved.presetName,
				providerId: resolved.providerId,
				modelId: resolved.modelId,
				useExtendedContext: resolved.useExtendedContext,
				thinkingLevel: resolved.thinkingLevel,
				source: "preset",
			};
		}
	}

	// Step 3: Fall back to the user's default preset
	const defaultResolved = resolvePreset(defaultPresetName, presets);
	if (defaultResolved) {
		return {
			presetName: defaultResolved.presetName,
			providerId: defaultResolved.providerId,
			modelId: defaultResolved.modelId,
			useExtendedContext: defaultResolved.useExtendedContext,
			thinkingLevel: defaultResolved.thinkingLevel,
			source: "default",
		};
	}

	// Ultimate fallback: any configured preset
	const anyPreset = findFirstConfiguredPreset(presets);
	if (anyPreset) {
		return {
			presetName: anyPreset.presetName,
			providerId: anyPreset.providerId,
			modelId: anyPreset.modelId,
			useExtendedContext: anyPreset.useExtendedContext,
			thinkingLevel: anyPreset.thinkingLevel,
			source: "default",
		};
	}

	return null;
}

/**
 * Find the first configured preset (provider_id != null) in the list.
 * Used as ultimate fallback when the default preset is unconfigured.
 */
export function findFirstConfiguredPreset(presets: ModelPreset[]): ResolvedPreset | null {
	for (const preset of presets) {
		if (preset.provider_id !== null && preset.model_id !== null) {
			return {
				presetName: preset.name,
				providerId: preset.provider_id,
				modelId: preset.model_id,
				useExtendedContext: preset.use_extended_context,
				thinkingLevel: preset.thinking_level ?? null,
			};
		}
	}
	return null;
}
