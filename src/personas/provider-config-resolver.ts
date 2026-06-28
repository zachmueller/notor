/**
 * Pure persona provider/model resolver (ARCH-007).
 *
 * Resolves the provider + model a step turn should run on **without** mutating
 * the shared `ProviderRegistry`. This is a concurrency-correctness requirement,
 * not a polish item: the engine relies on concurrency (the shared `Semaphore`,
 * concurrent `run_flow` children, a flow running alongside foreground chat), and
 * `PersonaManager.applyProviderModelOverrides()` mutates **global** state via
 * `providerRegistry.switchProvider(...)` / `updateConfig(...)` — so two concurrent
 * step turns with different models would clobber each other's selection
 * (research.md Finding 5).
 *
 * This function only **reads** the preset/provider/model tables and returns a
 * {@link ResolvedProviderConfig} value object — it performs NO mutating registry
 * call. `StepTurnExecutor` (FEAT-007) pins the result into each step's
 * `ConversationSession` and passes `modelId` as `RunLoopOptions.model`.
 *
 * It mirrors the pure `resolveWorkflowProviderConfig()`
 * (`src/chat/workflow-executor.ts`). `stepModelOverride` (`notor-step-model`)
 * takes precedence over the persona's `preferred_model`.
 *
 * @see specs/ZZ-misc/orchestration/data-model.md — ResolvedProviderConfig
 * @see specs/ZZ-misc/orchestration/tasks/phase-0-runloop.md — ARCH-007
 */

import type { Persona } from "../types";
import type { NotorSettings } from "../settings/types";
import type { ProviderRegistry } from "../providers/index";
import type { ResolvedProviderConfig } from "../run-loop/types";
import { resolvePreset } from "../presets/preset-resolver";
import { logger } from "../utils/logger";

const log = logger("PersonaProviderResolver");

/**
 * Resolve a persona's effective provider/model for a single step turn, as a
 * pinned value object — never writing to the global registry.
 *
 * Precedence (mirrors `applyProviderModelOverrides`, read-only):
 *   1. `persona.preferred_preset` (if it resolves to a configured preset);
 *   2. else `persona.preferred_provider` + `persona.preferred_model`;
 *   3. else the registry's current active provider + its configured model.
 * In every branch, a non-null `stepModelOverride` overrides the resolved model.
 *
 * Fallback is graceful: an unavailable provider/model yields a value-object
 * fallback (no global write, no blocking).
 *
 * @param persona - The step's persona (or null → use active provider/model).
 * @param stepModelOverride - `notor-step-model` (overrides the persona's model).
 * @param settings - Plugin settings (preset table lives here).
 * @param providerRegistry - Read-only here: only `getActiveId` / `getConfig`.
 */
export function resolvePersonaProviderConfig(
	persona: Persona | null,
	stepModelOverride: string | null,
	settings: NotorSettings,
	providerRegistry: ProviderRegistry,
): ResolvedProviderConfig {
	const applyOverride = (config: ResolvedProviderConfig): ResolvedProviderConfig =>
		stepModelOverride ? { ...config, modelId: stepModelOverride } : config;

	// 1. Preset (highest priority) — read-only resolution.
	if (persona?.preferred_preset) {
		const resolved = resolvePreset(persona.preferred_preset, settings.model_presets);
		if (resolved) {
			return applyOverride({
				providerId: resolved.providerId,
				modelId: resolved.modelId,
				useExtendedContext: resolved.useExtendedContext,
				thinkingLevel: resolved.thinkingLevel,
			});
		}
		log.warn("Persona preset not configured; falling back to provider/model", {
			persona: persona.name,
			preset: persona.preferred_preset,
		});
	}

	// 2. Persona provider/model overrides — read the config table, no mutation.
	if (persona?.preferred_provider) {
		let config = providerRegistry.getConfig(persona.preferred_provider);
		let providerId = persona.preferred_provider;
		if (!config) {
			const resolvedId = providerRegistry.resolveTypeToId(persona.preferred_provider);
			if (resolvedId) {
				config = providerRegistry.getConfig(resolvedId);
				providerId = resolvedId;
			}
		}
		if (config) {
			return applyOverride({
				providerId,
				modelId: persona.preferred_model ?? config.model_id ?? "",
				useExtendedContext: config.use_extended_context ?? false,
				thinkingLevel: null,
			});
		}
		log.warn("Persona preferred provider not available; using active provider", {
			persona: persona.name,
			requestedProvider: persona.preferred_provider,
		});
	}

	// 3. Active provider fallback (also covers a persona with only preferred_model).
	const activeId = providerRegistry.getActiveId();
	const activeConfig = providerRegistry.getConfig(activeId);
	return applyOverride({
		providerId: activeId,
		modelId: persona?.preferred_model ?? activeConfig?.model_id ?? "",
		useExtendedContext: activeConfig?.use_extended_context ?? false,
		thinkingLevel: null,
	});
}
