/**
 * Model selection — the five conversation-header fields that decide which
 * provider/model an LLM call uses, as one value.
 *
 * Ownership: the conversation header (in memory + JSONL) is the source of
 * truth; the orchestrator's `active*` fields are the panel's view of it; a
 * running `ConversationSession` holds a mutable copy read fresh at the top of
 * every response-loop iteration. Quick Settings never write global registry
 * state.
 */

import type { Conversation, LLMProviderConfig } from "../types";
import { getModelExtendedContext } from "../providers/model-metadata";

export interface ModelSelection {
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
	presetName: string | null;
}

/** The registry surface the selection helpers need (keeps them testable). */
export interface SelectionRegistry {
	getConfig(id: string): LLMProviderConfig | undefined;
	resolveTypeToId(type: string): string | null;
}

type SelectionFields = Pick<Conversation, "provider_id" | "model_id" | "use_extended_context" | "thinking_level" | "preset_name">;

/** Read the selection recorded on a conversation header. */
export function readSelection(conv: SelectionFields): ModelSelection {
	return {
		providerId: conv.provider_id,
		modelId: conv.model_id,
		useExtendedContext: conv.use_extended_context ?? false,
		thinkingLevel: conv.thinking_level ?? null,
		presetName: conv.preset_name ?? null,
	};
}

/** Write a selection onto a conversation header (in memory only). */
export function writeSelection(conv: SelectionFields, sel: ModelSelection): void {
	conv.provider_id = sel.providerId;
	conv.model_id = sel.modelId;
	conv.use_extended_context = sel.useExtendedContext;
	conv.thinking_level = sel.thinkingLevel;
	conv.preset_name = sel.presetName;
}

export function selectionsEqual(a: ModelSelection, b: ModelSelection): boolean {
	return a.providerId === b.providerId
		&& a.modelId === b.modelId
		&& a.useExtendedContext === b.useExtendedContext
		&& (a.thinkingLevel ?? null) === (b.thinkingLevel ?? null)
		&& (a.presetName ?? null) === (b.presetName ?? null);
}

/**
 * Normalize a selection before it is used or persisted:
 * - map a bare provider type (back-compat headers/presets) to a configured
 *   instance id;
 * - drop `useExtendedContext` when the model has no separate 1M variant, so a
 *   flag carried over from another model/provider is silently ignored.
 */
export function normalizeSelection(sel: ModelSelection, registry: SelectionRegistry): ModelSelection {
	const providerId = registry.getConfig(sel.providerId)?.id
		?? registry.resolveTypeToId(sel.providerId)
		?? sel.providerId;
	const useExtendedContext = sel.useExtendedContext && getModelExtendedContext(sel.modelId) !== undefined;
	return { ...sel, providerId, useExtendedContext };
}

/** Human-readable one-liner for the "model switched" Notice. */
export function describeSelection(sel: ModelSelection, registry: SelectionRegistry): string {
	const provider = registry.getConfig(sel.providerId)?.display_name ?? sel.providerId;
	const model = sel.modelId || "(no model)";
	const ext = sel.useExtendedContext ? " · 1M" : "";
	const thinking = sel.thinkingLevel ? ` · thinking ${sel.thinkingLevel}` : "";
	return `${provider} · ${model}${ext}${thinking} (${sel.presetName ?? "Custom"})`;
}
