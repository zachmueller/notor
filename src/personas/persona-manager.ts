/**
 * Persona manager — manages active persona state, switching, provider/model
 * overrides, and revert logic for workflow persona switching.
 *
 * The PersonaManager is the central coordinator for the persona system.
 * It owns the "active persona" state, triggers discovery scans, handles
 * provider/model switching on activation, and provides save/restore
 * methods for workflow persona revert (Group E dependency).
 *
 * @see specs/03-workflows-personas/spec.md — FR-38, FR-39
 * @see specs/03-workflows-personas/data-model.md — Persona entity
 * @see specs/03-workflows-personas/tasks/group-a-tasks.md — A-005, A-007, A-008
 */

import { Notice } from "obsidian";
import type { MetadataCache, Vault } from "obsidian";
import type { Persona, LLMProviderType } from "../types";
import type { NotorSettings } from "../settings";
import type { ProviderRegistry } from "../providers/index";
import { discoverPersonas } from "./persona-discovery";
import { logger } from "../utils/logger";

const log = logger("PersonaManager");

/**
 * Manages the active persona lifecycle — activation, deactivation,
 * provider/model switching, and save/restore for workflow revert.
 */
export class PersonaManager {
	/** Currently active persona (null = no persona, global defaults). */
	private activePersona: Persona | null = null;

	/** Saved persona name for workflow revert (see savePersonaState / restorePersonaState). */
	private savedPersonaName: string | null = null;

	/** Callback fired when the active persona changes (for UI updates). */
	private onPersonaChanged: ((persona: Persona | null) => void) | null = null;

	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
		private settings: NotorSettings,
		private readonly providerRegistry: ProviderRegistry,
		private readonly saveData: () => Promise<void>
	) {}

	// -----------------------------------------------------------------------
	// Active persona accessors
	// -----------------------------------------------------------------------

	/**
	 * Get the currently active persona, or null if no persona is active.
	 */
	getActivePersona(): Persona | null {
		return this.activePersona;
	}

	/**
	 * Register a callback that fires whenever the active persona changes.
	 * Used by the chat view to update the persona label and provider/model display.
	 */
	setOnPersonaChanged(callback: (persona: Persona | null) => void): void {
		this.onPersonaChanged = callback;
	}

	// -----------------------------------------------------------------------
	// Discovery
	// -----------------------------------------------------------------------

	/**
	 * Trigger a fresh discovery scan and return all valid personas.
	 *
	 * This is a pass-through to the stateless discovery service.
	 * Callers (picker, settings tab) invoke this when they need the
	 * latest persona list.
	 */
	async getDiscoveredPersonas(): Promise<Persona[]> {
		return discoverPersonas(this.vault, this.metadataCache, this.settings.notor_dir);
	}

	// -----------------------------------------------------------------------
	// Activation / deactivation
	// -----------------------------------------------------------------------

	/**
	 * Activate a persona by name.
	 *
	 * Discovers all personas, finds the one matching `name`, caches the
	 * active `Persona` object, persists the name to settings, and switches
	 * the provider/model if the persona specifies overrides.
	 *
	 * @param name - Persona name (subdirectory name, e.g. `"researcher"`)
	 * @returns `true` if activation succeeded, `false` if the persona was not found
	 */
	async activatePersona(name: string): Promise<boolean> {
		const personas = await this.getDiscoveredPersonas();
		const persona = personas.find((p) => p.name === name);

		if (!persona) {
			log.warn("Persona not found for activation", { name });
			return false;
		}

		this.activePersona = persona;
		this.settings.active_persona = name;
		await this.saveData();

		log.info("Persona activated", {
			name,
			promptMode: persona.prompt_mode,
			preferredProvider: persona.preferred_provider,
			preferredModel: persona.preferred_model,
		});

		// Switch provider/model if persona specifies overrides (A-007, A-008)
		this.applyProviderModelOverrides(persona);

		// Notify listeners (UI label, chat view model selector)
		this.onPersonaChanged?.(persona);

		return true;
	}

	/**
	 * Deactivate the current persona, reverting to global defaults.
	 *
	 * Clears the active persona, reverts provider/model to global settings,
	 * and persists the cleared state.
	 */
	deactivatePersona(): void {
		const previousName = this.activePersona?.name;
		this.activePersona = null;
		this.settings.active_persona = "";

		// Revert provider/model to global defaults
		this.revertProviderModel();

		// Persist (fire-and-forget — errors logged internally by saveData)
		this.saveData().catch((e) => {
			log.error("Failed to persist persona deactivation", { error: String(e) });
		});

		log.info("Persona deactivated", { previousName });

		// Notify listeners
		this.onPersonaChanged?.(null);
	}

	/**
	 * Restore the active persona from settings on plugin load.
	 *
	 * If `active_persona` is non-empty, discovers personas and resolves
	 * the named persona. If not found, silently clears the setting.
	 */
	async restoreFromSettings(): Promise<void> {
		const name = this.settings.active_persona;
		if (!name) {
			return;
		}

		const success = await this.activatePersona(name);
		if (!success) {
			log.warn("Could not restore active persona from settings, clearing", { name });
			this.settings.active_persona = "";
			await this.saveData();
		}
	}

	// -----------------------------------------------------------------------
	// Workflow persona save/restore (Group E integration point)
	// -----------------------------------------------------------------------

	/**
	 * Save the current persona state so it can be restored later.
	 *
	 * Called before a workflow switches the persona via
	 * `notor-workflow-persona`. The saved name is used by
	 * `restorePersonaState()` to revert after the workflow completes.
	 */
	savePersonaState(): void {
		this.savedPersonaName = this.activePersona?.name ?? null;
		log.debug("Persona state saved", { savedName: this.savedPersonaName });
	}

	/**
	 * Restore the previously saved persona state.
	 *
	 * Called after a workflow completes to revert the persona switch.
	 * If `savedPersonaName` is null, deactivates the persona (revert to
	 * global defaults). If non-null, activates that persona.
	 */
	async restorePersonaState(): Promise<void> {
		const nameToRestore = this.savedPersonaName;
		this.savedPersonaName = null;

		if (nameToRestore === null) {
			this.deactivatePersona();
		} else {
			const success = await this.activatePersona(nameToRestore);
			if (!success) {
				log.warn("Could not restore saved persona, deactivating", {
					name: nameToRestore,
				});
				this.deactivatePersona();
			}
		}

		log.debug("Persona state restored", { restoredName: nameToRestore });
	}

	// -----------------------------------------------------------------------
	// Settings reference update
	// -----------------------------------------------------------------------

	/**
	 * Update the settings reference (called when settings change externally).
	 */
	updateSettings(settings: NotorSettings): void {
		this.settings = settings;
	}

	// -----------------------------------------------------------------------
	// Provider / model switching (A-007, A-008)
	// -----------------------------------------------------------------------

	/**
	 * Apply provider and model overrides specified by a persona.
	 *
	 * Handles fallback gracefully: if the specified provider or model is
	 * not available, falls back to the current default and surfaces a
	 * non-blocking notice (A-008).
	 */
	private applyProviderModelOverrides(persona: Persona): void {
		// --- Provider switch ---
		if (persona.preferred_provider) {
			try {
				// Verify the provider is configured
				const config = this.providerRegistry.getConfig(
					persona.preferred_provider as LLMProviderType
				);
				if (config) {
					this.providerRegistry.switchProvider(
						persona.preferred_provider as LLMProviderType
					);
					log.info("Switched provider for persona", {
						persona: persona.name,
						provider: persona.preferred_provider,
					});
				} else {
					// Provider not configured — fall back with notice (A-008)
					new Notice(
						`Provider '${persona.preferred_provider}' not available; using default.`
					);
					log.warn("Persona preferred provider not available, using default", {
						persona: persona.name,
						requestedProvider: persona.preferred_provider,
					});
				}
			} catch (e) {
				// Provider switch failed — fall back with notice (A-008)
				new Notice(
					`Provider '${persona.preferred_provider}' not available; using default.`
				);
				log.warn("Failed to switch to persona preferred provider", {
					persona: persona.name,
					requestedProvider: persona.preferred_provider,
					error: String(e),
				});
			}
		}

		// --- Model switch ---
		if (persona.preferred_model) {
			const activeType = this.providerRegistry.getActiveType();
			const config = this.providerRegistry.getConfig(activeType);

			if (config) {
				// Check if the model is available in the cached model list
				const cachedModels = this.providerRegistry.getCachedModels(activeType);
				const modelAvailable =
					cachedModels.length === 0 || // No cache yet — optimistically set it
					cachedModels.some((m) => m.id === persona.preferred_model);

				if (modelAvailable) {
					const updated = { ...config, model_id: persona.preferred_model };
					this.providerRegistry.updateConfig(updated);
					log.info("Switched model for persona", {
						persona: persona.name,
						model: persona.preferred_model,
					});
				} else {
					// Model not in cached list — fall back with notice (A-008)
					new Notice(
						`Model '${persona.preferred_model}' not available; using default.`
					);
					log.warn("Persona preferred model not available, using default", {
						persona: persona.name,
						requestedModel: persona.preferred_model,
						availableModels: cachedModels.map((m) => m.id),
					});
				}
			}
		}
	}

	/**
	 * Revert provider and model to global defaults from settings.
	 *
	 * Called on persona deactivation to restore the user's configured
	 * defaults.
	 */
	private revertProviderModel(): void {
		// Revert provider to global default
		try {
			const globalProvider = this.settings.active_provider as LLMProviderType;
			this.providerRegistry.switchProvider(globalProvider);
			log.debug("Reverted provider to global default", { provider: globalProvider });
		} catch (e) {
			log.warn("Failed to revert provider to global default", {
				error: String(e),
			});
		}

		// Revert model to global default (from the provider's stored config)
		const globalProvider = this.settings.active_provider as LLMProviderType;
		const providerSettings = this.settings.providers.find(
			(p) => p.type === globalProvider
		);
		if (providerSettings?.model_id) {
			const currentConfig = this.providerRegistry.getConfig(globalProvider);
			if (currentConfig) {
				const reverted = { ...currentConfig, model_id: providerSettings.model_id };
				this.providerRegistry.updateConfig(reverted);
				log.debug("Reverted model to global default", {
					model: providerSettings.model_id,
				});
			}
		}
	}
}
