/**
 * Provider registry — single point of access for LLM provider instances.
 *
 * Manages provider creation, retrieval, and switching. Providers are
 * initialized lazily (not at plugin load time) to keep startup fast.
 *
 * Instances are keyed by unique provider ID (not type), enabling multiple
 * instances of the same provider type (e.g., two local servers, multiple
 * Bedrock accounts). Factories remain keyed by type.
 *
 * Model list caching (PROV-007) is integrated here with 5-minute TTL
 * and stale-while-revalidate strategy.
 */

import type { App } from "obsidian";
import type { LLMProviderConfig, LLMProviderType, ModelInfo } from "../types";
import type { LLMProvider } from "./provider";
import { ProviderError } from "./provider";
import { enrichModelInfo } from "./model-metadata";
import { logger } from "../utils/logger";

const log = logger("ProviderRegistry");

/** Cache entry for a provider's model list. */
interface ModelListCache {
	models: ModelInfo[];
	fetchedAt: number;
}

/** Cache TTL: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Factory function type for creating provider instances.
 *
 * Each provider type registers a factory that creates the concrete
 * LLMProvider implementation from its configuration.
 */
export type ProviderFactory = (
	config: LLMProviderConfig,
	app: App
) => LLMProvider;

/**
 * Registry that manages LLM provider instances.
 *
 * - Registers provider factories per type (local, anthropic, openai, bedrock)
 * - Creates provider instances lazily on first access (keyed by instance ID)
 * - Caches model lists per instance with 5-minute TTL
 * - Tracks the active provider instance for the plugin
 */
export class ProviderRegistry {
	/** Factory functions keyed by provider type. */
	private factories = new Map<LLMProviderType, ProviderFactory>();

	/** Lazily-created provider instances keyed by instance ID. */
	private instances = new Map<string, LLMProvider>();

	/** Provider configurations keyed by instance ID. */
	private configs = new Map<string, LLMProviderConfig>();

	/** Model list caches keyed by instance ID. */
	private modelCaches = new Map<string, ModelListCache>();

	/** The currently active provider instance ID. */
	private activeId: string;

	constructor(
		private readonly app: App,
		configs: LLMProviderConfig[],
		activeProvider: string
	) {
		this.activeId = activeProvider;
		for (const config of configs) {
			this.configs.set(config.id, config);
		}
	}

	// -----------------------------------------------------------------------
	// Factory registration
	// -----------------------------------------------------------------------

	/**
	 * Register a factory function for a provider type.
	 *
	 * Called during plugin initialization to register each supported
	 * provider type's constructor.
	 */
	registerFactory(type: LLMProviderType, factory: ProviderFactory): void {
		this.factories.set(type, factory);
		log.debug("Registered provider factory", { type });
	}

	// -----------------------------------------------------------------------
	// Provider access
	// -----------------------------------------------------------------------

	/**
	 * Get the provider instance by ID.
	 *
	 * Creates the instance lazily on first access using the registered
	 * factory for the config's type.
	 *
	 * @throws ProviderError if no factory is registered or no config exists
	 */
	getProvider(id: string): LLMProvider {
		const existing = this.instances.get(id);
		if (existing) {
			return existing;
		}

		const config = this.configs.get(id);
		if (!config) {
			throw new ProviderError(
				`No configuration found for provider: ${id}`,
				id,
				"UNKNOWN"
			);
		}

		const factory = this.factories.get(config.type);
		if (!factory) {
			throw new ProviderError(
				`No provider factory registered for type: ${config.type}`,
				config.type,
				"UNKNOWN"
			);
		}

		log.info("Creating provider instance", { id, type: config.type });
		const instance = factory(config, this.app);
		this.instances.set(id, instance);
		return instance;
	}

	/**
	 * Get the currently active provider instance.
	 */
	getActiveProvider(): LLMProvider {
		return this.getProvider(this.activeId);
	}

	/**
	 * Get the currently active provider instance ID.
	 */
	getActiveId(): string {
		return this.activeId;
	}

	/**
	 * Get the currently active provider type.
	 */
	getActiveType(): LLMProviderType {
		const config = this.configs.get(this.activeId);
		return config?.type ?? "local";
	}

	// -----------------------------------------------------------------------
	// Provider switching
	// -----------------------------------------------------------------------

	/**
	 * Switch the active provider by instance ID.
	 *
	 * Does NOT eagerly create the new provider instance — it will be
	 * created lazily on next access.
	 */
	switchProvider(id: string): void {
		if (!this.configs.has(id)) {
			throw new ProviderError(
				`No configuration found for provider: ${id}`,
				id,
				"UNKNOWN"
			);
		}
		log.info("Switching active provider", { from: this.activeId, to: id });
		this.activeId = id;
	}

	// -----------------------------------------------------------------------
	// Configuration updates
	// -----------------------------------------------------------------------

	/**
	 * Update the configuration for a provider instance.
	 *
	 * Destroys any cached instance so the next access creates a fresh
	 * one with the new configuration. Also clears the model list cache.
	 */
	updateConfig(config: LLMProviderConfig): void {
		this.configs.set(config.id, config);
		this.instances.delete(config.id);
		this.modelCaches.delete(config.id);
		log.debug("Updated provider config", { id: config.id, type: config.type });
	}

	/**
	 * Remove a provider instance from the registry entirely.
	 */
	removeProvider(id: string): void {
		this.instances.delete(id);
		this.configs.delete(id);
		this.modelCaches.delete(id);
		log.info("Removed provider", { id });
	}

	/**
	 * Reset cached credentials for a provider instance.
	 *
	 * Calls `resetCredentials()` on the cached instance (if it implements it),
	 * then destroys the cached instance and model list so the next access
	 * creates a fresh provider with new credentials.
	 */
	resetProviderCredentials(id: string): void {
		const instance = this.instances.get(id);
		if (instance?.resetCredentials) {
			instance.resetCredentials();
		}
		this.instances.delete(id);
		this.modelCaches.delete(id);
		log.info("Reset provider credentials", { id });
	}

	// -----------------------------------------------------------------------
	// Model list caching (PROV-007)
	// -----------------------------------------------------------------------

	/**
	 * Get the model list for a provider, using cache when available.
	 *
	 * Implements stale-while-revalidate:
	 * - Fresh cache (< 5 min): return immediately
	 * - Stale cache (>= 5 min): return stale data, refresh in background
	 * - No cache: fetch and return
	 *
	 * @param id - Provider instance ID (defaults to active)
	 * @param forceRefresh - Skip cache and fetch fresh data
	 */
	async getModels(
		id?: string,
		forceRefresh = false
	): Promise<ModelInfo[]> {
		const providerId = id ?? this.activeId;
		const cache = this.modelCaches.get(providerId);
		const now = Date.now();

		if (!forceRefresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
			return cache.models;
		}

		if (!forceRefresh && cache) {
			log.debug("Returning stale model cache, refreshing in background", {
				id: providerId,
			});
			this.refreshModelsInBackground(providerId);
			return cache.models;
		}

		return this.fetchAndCacheModels(providerId);
	}

	/**
	 * Explicitly refresh the model list for a provider.
	 * Clears cache and fetches fresh data.
	 */
	async refreshModels(id?: string): Promise<ModelInfo[]> {
		return this.getModels(id, true);
	}

	/**
	 * Clear model cache for a specific provider or all providers.
	 */
	clearModelCache(id?: string): void {
		if (id) {
			this.modelCaches.delete(id);
		} else {
			this.modelCaches.clear();
		}
	}

	/**
	 * Return the currently cached model list for a provider synchronously.
	 * Returns an empty array if no cache is available yet.
	 */
	getCachedModels(id?: string): ModelInfo[] {
		const providerId = id ?? this.activeId;
		return this.modelCaches.get(providerId)?.models ?? [];
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private async fetchAndCacheModels(id: string): Promise<ModelInfo[]> {
		try {
			const provider = this.getProvider(id);
			const raw = await provider.listModels();
			const models = raw.map(enrichModelInfo);
			this.modelCaches.set(id, {
				models,
				fetchedAt: Date.now(),
			});
			log.info("Fetched and cached model list", {
				id,
				count: models.length,
			});
			return models;
		} catch (e) {
			const staleCache = this.modelCaches.get(id);
			if (staleCache) {
				log.warn("Model fetch failed, returning stale cache", {
					id,
					error: String(e),
				});
				return staleCache.models;
			}
			throw e;
		}
	}

	private refreshModelsInBackground(id: string): void {
		this.fetchAndCacheModels(id).catch((e) => {
			log.warn("Background model refresh failed", {
				id,
				error: String(e),
			});
		});
	}

	// -----------------------------------------------------------------------
	// Introspection
	// -----------------------------------------------------------------------

	/**
	 * List all registered provider types (factory-registered).
	 */
	getRegisteredTypes(): LLMProviderType[] {
		return Array.from(this.factories.keys());
	}

	/**
	 * List all unique configured provider types.
	 */
	getConfiguredTypes(): LLMProviderType[] {
		const types = new Set<LLMProviderType>();
		for (const config of this.configs.values()) {
			types.add(config.type);
		}
		return Array.from(types);
	}

	/**
	 * List all configured provider instance IDs.
	 */
	getConfiguredIds(): string[] {
		return Array.from(this.configs.keys());
	}

	/**
	 * Get all configurations for a given provider type.
	 */
	getConfigsForType(type: LLMProviderType): LLMProviderConfig[] {
		const result: LLMProviderConfig[] = [];
		for (const config of this.configs.values()) {
			if (config.type === type) result.push(config);
		}
		return result;
	}

	/**
	 * Get the configuration for a provider by instance ID.
	 */
	getConfig(id: string): LLMProviderConfig | undefined {
		return this.configs.get(id);
	}

	/**
	 * Resolve a provider type to the first configured instance ID of that type.
	 * Used for backward compatibility when conversation headers store a bare type.
	 */
	resolveTypeToId(type: string): string | null {
		for (const config of this.configs.values()) {
			if (config.type === type) return config.id;
		}
		return null;
	}
}
