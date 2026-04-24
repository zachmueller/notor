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

import { Notice, TFile, normalizePath } from "obsidian";
import type { MetadataCache, Vault } from "obsidian";
import type { Persona, LLMProviderType } from "../types";
import type { NotorSettings } from "../settings";
import type { ProviderRegistry } from "../providers/index";
import { resolvePreset } from "../presets/preset-resolver";
import { discoverPersonas, getPersonasRootPath } from "./persona-discovery";
import { BUILTIN_PERSONA_PROFILES, BUILTIN_PERSONA_NAMES } from "./builtin-personas";
import { logger } from "../utils/logger";
import type { TemplateVariableRegistry } from "../template-vars";

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

	/**
	 * Callbacks fired when the active persona changes (for UI updates).
	 *
	 * Supports multiple listeners so each panel can update its own persona
	 * label independently in multi-panel mode (Phase 4).
	 */
	private personaChangedCallbacks = new Set<(persona: Persona | null) => void>();

	/**
	 * Callback fired when the active persona name changes, specifically
	 * for propagating the persona name to the ToolDispatcher so auto-approve
	 * resolution stays in sync.
	 *
	 * @see specs/03-workflows-personas/tasks/group-b-tasks.md — B-007
	 */
	private onPersonaNameChanged: ((name: string | null) => void) | null = null;

	constructor(
		private readonly vault: Vault,
		private readonly metadataCache: MetadataCache,
		private settings: NotorSettings,
		private readonly providerRegistry: ProviderRegistry,
		private readonly saveData: () => Promise<void>,
		private readonly templateRegistry?: TemplateVariableRegistry,
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
	 *
	 * Supports multiple listeners (one per panel in multi-panel mode).
	 * Returns an unregister function.
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Phase 4, Step 4f
	 */
	setOnPersonaChanged(callback: (persona: Persona | null) => void): () => void {
		this.personaChangedCallbacks.add(callback);
		return () => { this.personaChangedCallbacks.delete(callback); };
	}

	/**
	 * Register a callback that fires when the active persona name changes.
	 *
	 * Used by main.ts to propagate the persona name to the ToolDispatcher
	 * so that per-persona auto-approve resolution stays in sync whenever
	 * the user switches personas via the persona picker.
	 *
	 * @see specs/03-workflows-personas/tasks/group-b-tasks.md — B-007
	 */
	setOnPersonaNameChanged(callback: (name: string | null) => void): void {
		this.onPersonaNameChanged = callback;
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
		return discoverPersonas(this.vault, this.metadataCache, this.settings.notor_dir, this.templateRegistry);
	}

	/**
	 * Look up a persona by name without activating it.
	 *
	 * Used by `switchConversation()` to display-restore the persona label
	 * from the JSONL header without calling `activatePersona()` (which
	 * would mutate global state and fire callbacks).
	 *
	 * @param name - Persona name (subdirectory name, e.g. `"researcher"`)
	 * @returns The persona if found, `null` if deleted or not discoverable
	 *
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1f
	 */
	async getPersonaByName(name: string): Promise<Persona | null> {
		const personas = await this.getDiscoveredPersonas();
		return personas.find((p) => p.name === name) ?? null;
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
		for (const cb of this.personaChangedCallbacks) cb(persona);

		// Propagate persona name to dispatcher for auto-approve resolution (B-007)
		this.onPersonaNameChanged?.(name);

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
		for (const cb of this.personaChangedCallbacks) cb(null);

		// Propagate null persona to dispatcher for auto-approve resolution (B-007)
		this.onPersonaNameChanged?.(null);
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

	/**
	 * Refresh the active persona from disk without switching provider/model.
	 *
	 * Re-discovers personas and updates the in-memory cache. If the active
	 * persona was deleted, deactivates it. Fires `personaChangedCallbacks`
	 * so UI labels update automatically.
	 *
	 * If the active persona's file fails to parse, the old state is preserved
	 * and an error result is returned so the caller can surface a Notice.
	 *
	 * Called by the persona file watcher when persona files change on disk.
	 */
	async refreshActivePersona(): Promise<
		| { status: "refreshed"; persona: Persona }
		| { status: "deactivated"; previousName: string }
		| { status: "no-active-persona" }
		| { status: "error"; filePath: string; message: string }
	> {
		if (!this.activePersona) {
			return { status: "no-active-persona" };
		}

		const currentName = this.activePersona.name;
		const errors: Array<{ filePath: string; message: string }> = [];
		const personas = await discoverPersonas(
			this.vault, this.metadataCache, this.settings.notor_dir, this.templateRegistry, errors,
		);
		const updated = personas.find((p) => p.name === currentName);

		if (updated) {
			this.activePersona = updated;
			for (const cb of this.personaChangedCallbacks) cb(updated);
			log.info("Active persona refreshed from disk", { name: currentName });
			return { status: "refreshed", persona: updated };
		}

		// If the active persona failed to parse (vs. simply being deleted), preserve
		// the current state and surface the error rather than deactivating.
		if (errors.length > 0) {
			const activePersonaDir = this.activePersona.directory_path;
			const activeError = errors.find(e => e.filePath.startsWith(activePersonaDir));
			if (activeError) {
				log.warn("Active persona failed to parse — keeping previous state", { name: currentName, error: activeError.message });
				return { status: "error", filePath: activeError.filePath, message: activeError.message };
			}
		}

		log.warn("Active persona no longer found on disk, deactivating", { name: currentName });
		this.deactivatePersona();
		return { status: "deactivated", previousName: currentName };
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
	// Built-in persona management
	// -----------------------------------------------------------------------

	/** Name of the system prompt file inside each persona directory. */
	private static readonly SYSTEM_PROMPT_FILENAME = "system-prompt.md";

	/**
	 * Check if a persona name corresponds to a built-in persona.
	 */
	isBuiltinPersona(name: string): boolean {
		return BUILTIN_PERSONA_NAMES.has(name);
	}

	/**
	 * Ensure a built-in persona has a vault file. Creates the directory
	 * and `system-prompt.md` from the built-in constant if they don't exist.
	 *
	 * Called on first "Open" click in Settings.
	 *
	 * @param name - Built-in persona name (e.g., `"notor-help"`)
	 * @returns Vault-relative path to the created/existing system-prompt.md
	 * @throws Error if the name is not a built-in persona
	 */
	async ensureBuiltinPersonaVaultFile(name: string): Promise<string> {
		const builtin = BUILTIN_PERSONA_PROFILES.get(name);
		if (!builtin) {
			throw new Error(`"${name}" is not a built-in persona.`);
		}

		const rootPath = getPersonasRootPath(this.settings.notor_dir);
		const dirPath = normalizePath(`${rootPath}/${name}`);
		const filePath = normalizePath(`${dirPath}/${PersonaManager.SYSTEM_PROMPT_FILENAME}`);

		if (this.vault.getAbstractFileByPath(filePath)) {
			return filePath;
		}

		await this.ensureDirectory(dirPath);
		await this.vault.create(filePath, builtin.systemPromptContent);
		log.info("Created vault file for built-in persona", { name, path: filePath });

		return filePath;
	}

	/**
	 * Reset a built-in persona's vault file to the default content.
	 *
	 * Overwrites the existing vault file with the built-in constant.
	 * If the vault file doesn't exist, creates it.
	 *
	 * @param name - Built-in persona name
	 * @throws Error if the name is not a built-in persona
	 */
	async resetBuiltinPersonaToDefault(name: string): Promise<void> {
		const builtin = BUILTIN_PERSONA_PROFILES.get(name);
		if (!builtin) {
			throw new Error(`"${name}" is not a built-in persona.`);
		}

		const rootPath = getPersonasRootPath(this.settings.notor_dir);
		const dirPath = normalizePath(`${rootPath}/${name}`);
		const filePath = normalizePath(`${dirPath}/${PersonaManager.SYSTEM_PROMPT_FILENAME}`);

		const existing = this.vault.getAbstractFileByPath(filePath);
		if (existing && existing instanceof TFile) {
			await this.vault.modify(existing, builtin.systemPromptContent);
			log.info("Reset built-in persona to default", { name, path: filePath });
		} else {
			await this.ensureDirectory(dirPath);
			await this.vault.create(filePath, builtin.systemPromptContent);
			log.info("Created vault file for built-in persona (reset)", { name, path: filePath });
		}
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
		// --- Preset resolution (highest priority) ---
		if (persona.preferred_preset) {
			const resolved = resolvePreset(persona.preferred_preset, this.settings.model_presets);
			if (resolved) {
				try {
					const config = this.providerRegistry.getConfig(resolved.providerType);
					if (config) {
						this.providerRegistry.switchProvider(resolved.providerType);
						const updated = {
							...config,
							model_id: resolved.modelId,
							use_extended_context: resolved.useExtendedContext,
						};
						this.providerRegistry.updateConfig(updated);
						log.info("Applied preset override for persona", {
							persona: persona.name,
							preset: persona.preferred_preset,
							provider: resolved.providerType,
							model: resolved.modelId,
						});
						return; // Preset fully applied — skip legacy provider/model overrides
					}
				} catch (e) {
					log.warn("Failed to apply persona preset override", {
						persona: persona.name,
						preset: persona.preferred_preset,
						error: String(e),
					});
				}
			}
			// Preset not configured or failed — fall through to legacy overrides
			new Notice(
				`Preset '${persona.preferred_preset}' not available; falling back to provider/model overrides.`
			);
		}

		// --- Provider switch (legacy fallback) ---
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
					const updated = { ...config, model_id: persona.preferred_model, use_extended_context: false };
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
	 * Ensure a directory path exists, creating intermediate directories
	 * as needed.
	 */
	private async ensureDirectory(dirPath: string): Promise<void> {
		const parts = dirPath.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const normalized = normalizePath(current);
			if (!this.vault.getAbstractFileByPath(normalized)) {
				await this.vault.createFolder(normalized);
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

		// Revert model and use_extended_context to global defaults (from the provider's stored config)
		const globalProvider = this.settings.active_provider as LLMProviderType;
		const providerSettings = this.settings.providers.find(
			(p) => p.type === globalProvider
		);
		if (providerSettings?.model_id) {
			const currentConfig = this.providerRegistry.getConfig(globalProvider);
			if (currentConfig) {
				const reverted = {
					...currentConfig,
					model_id: providerSettings.model_id,
					use_extended_context: providerSettings.use_extended_context ?? false,
				};
				this.providerRegistry.updateConfig(reverted);
				log.debug("Reverted model to global default", {
					model: providerSettings.model_id,
					use_extended_context: providerSettings.use_extended_context ?? false,
				});
			}
		}
	}
}
