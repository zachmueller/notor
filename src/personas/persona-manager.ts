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
import type { Persona } from "../types";
import type { NotorSettings } from "../settings";
import type { ProviderRegistry } from "../providers/index";
import { resolvePreset } from "../presets/preset-resolver";
import { discoverPersonas, getPersonasRootPath } from "./persona-discovery";
import { BUILTIN_PERSONA_PROFILES, BUILTIN_PERSONA_NAMES, canonicalPersonaName } from "./builtin-personas";
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

	/**
	 * Callbacks fired when the active persona changes (for UI updates).
	 *
	 * After per-panel persona isolation, these only fire from file-watcher
	 * refresh and plugin startup restore — not from user-initiated panel
	 * switches.
	 */
	private personaChangedCallbacks = new Set<(persona: Persona | null) => void>();

	/** Callbacks fired with the fresh persona list whenever persona files are re-read. */
	private personasRefreshedCallbacks = new Set<(personas: Persona[]) => void>();

	/** Callbacks fired once the startup restore has activated a persona. */
	private personaRestoredCallbacks = new Set<(persona: Persona) => void>();

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
	 * Register a callback that fires with the freshly discovered personas each
	 * time persona files change on disk. Panels use it to swap in the new copy
	 * of *their* persona — which is not necessarily the manager's active one.
	 * Returns an unregister function.
	 */
	setOnPersonasRefreshed(callback: (personas: Persona[]) => void): () => void {
		this.personasRefreshedCallbacks.add(callback);
		return () => { this.personasRefreshedCallbacks.delete(callback); };
	}

	/**
	 * Register a callback that fires when {@link restoreFromSettings} activates
	 * the saved persona. Panels created before the restore finished started
	 * with no persona and use this to adopt it. Returns an unregister function.
	 */
	setOnPersonaRestored(callback: (persona: Persona) => void): () => void {
		this.personaRestoredCallbacks.add(callback);
		return () => { this.personaRestoredCallbacks.delete(callback); };
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
		return findPersona(personas, name) ?? null;
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
		const persona = findPersona(personas, name);

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

		// Surface unavailable provider/model overrides (A-008). The overrides
		// themselves are applied per panel / per run (resolvePersonaOverrides,
		// resolvePersonaProviderConfig) — never to the global registry.
		this.warnUnavailableOverrides(persona);

		// Notify listeners (file-watcher refresh + plugin startup)
		for (const cb of this.personaChangedCallbacks) cb(persona);

		return true;
	}

	/**
	 * Deactivate the current persona and persist the cleared state.
	 */
	deactivatePersona(): void {
		const previousName = this.activePersona?.name;
		this.activePersona = null;
		this.settings.active_persona = "";

		// Persist (fire-and-forget — errors logged internally by saveData)
		this.saveData().catch((e) => {
			log.error("Failed to persist persona deactivation", { error: String(e) });
		});

		log.info("Persona deactivated", { previousName });

		// Notify listeners
		for (const cb of this.personaChangedCallbacks) cb(null);
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
			return;
		}

		const restored = this.activePersona;
		if (restored) {
			for (const cb of this.personaRestoredCallbacks) cb(restored);
		}
	}

	/**
	 * Refresh the active persona from disk without switching provider/model.
	 *
	 * Re-discovers personas and updates the in-memory cache. If the active
	 * persona was deleted, deactivates it. Fires `personasRefreshedCallbacks`
	 * with every discovered persona (even with no active one, so panels can
	 * refresh their own), then `personaChangedCallbacks` so UI labels update.
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
		const errors: Array<{ filePath: string; message: string }> = [];
		const personas = await discoverPersonas(
			this.vault, this.metadataCache, this.settings.notor_dir, this.templateRegistry, errors,
		);
		for (const cb of this.personasRefreshedCallbacks) cb(personas);

		if (!this.activePersona) {
			return { status: "no-active-persona" };
		}

		const currentName = this.activePersona.name;
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
	// Built-in persona management
	// -----------------------------------------------------------------------

	/** Name of the system prompt file inside each persona directory. */
	private static readonly SYSTEM_PROMPT_FILENAME = "system-prompt.md";

	/**
	 * Check if a persona name corresponds to a built-in persona.
	 */
	isBuiltinPersona(name: string): boolean {
		return BUILTIN_PERSONA_NAMES.has(canonicalPersonaName(name));
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
		// Profile by canonical name; folder by the given name, so a legacy-named
		// customized folder (e.g. orchestration-creator/) is the one opened.
		const builtin = BUILTIN_PERSONA_PROFILES.get(canonicalPersonaName(name));
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
		// Resetting a legacy-named folder writes the renamed built-in's content into it.
		const builtin = BUILTIN_PERSONA_PROFILES.get(canonicalPersonaName(name));
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
	 * Warn (non-blocking, A-008) when a persona's preset, provider or model
	 * override can't be honored. Read-only: never touches the global
	 * `ProviderRegistry` — mutating it made one panel's (or a background
	 * workflow's) persona silently change every other panel's model.
	 */
	private warnUnavailableOverrides(persona: Persona): void {
		if (persona.preferred_preset) {
			const resolved = resolvePreset(persona.preferred_preset, this.settings.model_presets);
			if (resolved && this.providerRegistry.getConfig(resolved.providerId)) return;
			new Notice(
				`Preset '${persona.preferred_preset}' not available; falling back to provider/model overrides.`
			);
		}

		let providerId: string | null = null;
		if (persona.preferred_provider) {
			providerId = this.providerRegistry.getConfig(persona.preferred_provider)?.id
				?? this.providerRegistry.resolveTypeToId(persona.preferred_provider);
			if (!providerId) {
				new Notice(`Provider '${persona.preferred_provider}' not available; using default.`);
				log.warn("Persona preferred provider not available, using default", {
					persona: persona.name,
					requestedProvider: persona.preferred_provider,
				});
			}
		}

		if (persona.preferred_model) {
			const cachedModels = this.providerRegistry.getCachedModels(providerId ?? this.providerRegistry.getActiveId());
			const modelAvailable =
				cachedModels.length === 0 || // No cache yet — optimistically accept
				cachedModels.some((m) => m.id === persona.preferred_model);
			if (!modelAvailable) {
				new Notice(`Model '${persona.preferred_model}' not available; using default.`);
				log.warn("Persona preferred model not available, using default", {
					persona: persona.name,
					requestedModel: persona.preferred_model,
					availableModels: cachedModels.map((m) => m.id),
				});
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
}

/**
 * Find a persona by name: an exact directory-name match first, else a match
 * through built-in persona aliases (`orchestration-creator` ↔ `circuit-creator`).
 */
function findPersona(personas: Persona[], name: string): Persona | undefined {
	const exact = personas.find((p) => p.name === name);
	if (exact) return exact;
	const canonical = canonicalPersonaName(name);
	return personas.find((p) => canonicalPersonaName(p.name) === canonical);
}
