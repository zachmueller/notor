/**
 * Provider registry — single point of access for LLM provider instances.
 *
 * Manages provider creation, retrieval, and switching. Providers are
 * initialized lazily (not at plugin load time) to keep startup fast.
 *
 * Model list caching (PROV-007) is integrated here with 5-minute TTL
 * and stale-while-revalidate strategy.
 */

import type { App } from "obsidian";
import type { LLMProviderConfig, LLMProviderType, ModelInfo } from "../types";
import type { LLMProvider } from "./provider";
import { ProviderError } from "./provider";
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
 * - Creates provider instances lazily on first access
 * - Caches model lists per provider with 5-minute TTL
 * - Tracks the active provider for the plugin
 */
export class ProviderRegistry {
	/** Factory functions keyed by provider type. */
	private factories = new Map<LLMProviderType, ProviderFactory>();

	/** Lazily-created provider instances keyed by provider type. */
	private instances = new Map<LLMProviderType, LLMProvider>();

	/** Provider configurations keyed by provider type. */
	private configs = new Map<LLMProviderType, LLMProviderConfig>();

	/** Model list caches keyed by provider type. */
	private modelCaches = new Map<LLMProviderType, ModelListCache>();

	/** The currently active provider type. */
	private activeType: LLMProviderType;

	constructor(
		private readonly app: App,
		configs: LLMProviderConfig[],
		activeProvider: LLMProviderType
	) {
		this.activeType = activeProvider;
		for (const config of configs) {
			this.configs.set(config.type, config);
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
	 * Get the provider instance for a given type.
	 *
	 * Creates the instance lazily on first access using the registered
	 * factory and stored configuration.
	 *
	 * @throws ProviderError if no factory is registered or no config exists
	 */
	getProvider(type: LLMProviderType): LLMProvider {
		// Return cached instance if available
		const existing = this.instances.get(type);
		if (existing) {
			return existing;
		}

		// Create new instance
		const factory = this.factories.get(type);
		if (!factory) {
			throw new ProviderError(
				`No provider factory registered for type: ${type}`,
				type,
				"UNKNOWN"
			);
		}

		const config = this.configs.get(type);
		if (!config) {
			throw new ProviderError(
				`No configuration found for provider type: ${type}`,
				type,
				"UNKNOWN"
			);
		}

		log.info("Creating provider instance", { type });
		const instance = factory(config, this.app);
		this.instances.set(type, instance);
		return instance;
	}

	/**
	 * Get the currently active provider instance.
	 */
	getActiveProvider(): LLMProvider {
		return this.getProvider(this.activeType);
	}

	/**
	 * Get the currently active provider type.
	 */
	getActiveType(): LLMProviderType {
		return this.activeType;
	}

	// -----------------------------------------------------------------------
	// Provider switching
	// -----------------------------------------------------------------------

	/**
	 * Switch the active provider type.
	 *
	 * Does NOT eagerly create the new provider instance — it will be
	 * created lazily on next access.
	 */
	switchProvider(type: LLMProviderType): void {
		if (!this.configs.has(type)) {
			throw new ProviderError(
				`No configuration found for provider type: ${type}`,
				type,
				"UNKNOWN"
			);
		}
		log.info("Switching active provider", { from: this.activeType, to: type });
		this.activeType = type;
	}

	// -----------------------------------------------------------------------
	// Configuration updates
	// -----------------------------------------------------------------------

	/**
	 * Update the configuration for a provider type.
	 *
	 * Destroys any cached instance so the next access creates a fresh
	 * one with the new configuration. Also clears the model list cache.
	 */
	updateConfig(config: LLMProviderConfig): void {
		this.configs.set(config.type, config);
		// Invalidate cached instance and model list
		this.instances.delete(config.type);
		this.modelCaches.delete(config.type);
		log.debug("Updated provider config", { type: config.type });
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
	 * @param type - Provider type to get models for (defaults to active)
	 * @param forceRefresh - Skip cache and fetch fresh data
	 */
	async getModels(
		type?: LLMProviderType,
		forceRefresh = false
	): Promise<ModelInfo[]> {
		const providerType = type ?? this.activeType;
		const cache = this.modelCaches.get(providerType);
		const now = Date.now();

		// Return fresh cache immediately
		if (!forceRefresh && cache && now - cache.fetchedAt < CACHE_TTL_MS) {
			return cache.models;
		}

		// Stale cache: return stale data and refresh in background
		if (!forceRefresh && cache) {
			log.debug("Returning stale model cache, refreshing in background", {
				type: providerType,
			});
			this.refreshModelsInBackground(providerType);
			return cache.models;
		}

		// No cache or force refresh: fetch synchronously
		return this.fetchAndCacheModels(providerType);
	}

	/**
	 * Explicitly refresh the model list for a provider.
	 * Clears cache and fetches fresh data.
	 */
	async refreshModels(type?: LLMProviderType): Promise<ModelInfo[]> {
		return this.getModels(type, true);
	}

	/**
	 * Clear model cache for a specific provider or all providers.
	 */
	clearModelCache(type?: LLMProviderType): void {
		if (type) {
			this.modelCaches.delete(type);
		} else {
			this.modelCaches.clear();
		}
	}

	/**
	 * Return the currently cached model list for a provider synchronously.
	 * Returns an empty array if no cache is available yet.
	 *
	 * Useful for populating UI synchronously without triggering async fetches.
	 */
	getCachedModels(type?: LLMProviderType): ModelInfo[] {
		const providerType = type ?? this.activeType;
		return this.modelCaches.get(providerType)?.models ?? [];
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private async fetchAndCacheModels(
		type: LLMProviderType
	): Promise<ModelInfo[]> {
		try {
			const provider = this.getProvider(type);
			const models = await provider.listModels();
			this.modelCaches.set(type, {
				models,
				fetchedAt: Date.now(),
			});
			log.info("Fetched and cached model list", {
				type,
				count: models.length,
			});
			return models;
		} catch (e) {
			// If we have stale cache, return it on fetch failure
			const staleCache = this.modelCaches.get(type);
			if (staleCache) {
				log.warn("Model fetch failed, returning stale cache", {
					type,
					error: String(e),
				});
				return staleCache.models;
			}
			// No cache at all — re-throw
			throw e;
		}
	}

	private refreshModelsInBackground(type: LLMProviderType): void {
		this.fetchAndCacheModels(type).catch((e) => {
			log.warn("Background model refresh failed", {
				type,
				error: String(e),
			});
		});
	}

	// -----------------------------------------------------------------------
	// Introspection
	// -----------------------------------------------------------------------

	/**
	 * List all registered provider types.
	 */
	getRegisteredTypes(): LLMProviderType[] {
		return Array.from(this.factories.keys());
	}

	/**
	 * List all configured provider types.
	 */
	getConfiguredTypes(): LLMProviderType[] {
		return Array.from(this.configs.keys());
	}

	/**
	 * Get the configuration for a provider type.
	 */
	getConfig(type: LLMProviderType): LLMProviderConfig | undefined {
		return this.configs.get(type);
	}
}