import type {
	WebSearchProviderType,
	SearchProvider,
	ProviderConfig,
} from "./providers/provider";

/**
 * Registry of available web search providers.
 * Maps provider type strings to singleton provider instances.
 */
export class SearchProviderRegistry {
	private providers = new Map<WebSearchProviderType, SearchProvider>();

	/** Register a provider instance, keyed by its meta.type. */
	register(provider: SearchProvider): void {
		this.providers.set(provider.meta.type, provider);
	}

	/** Get a provider by type, or undefined if not registered. */
	get(type: WebSearchProviderType): SearchProvider | undefined {
		return this.providers.get(type);
	}

	/** Get all registered providers. */
	getAll(): SearchProvider[] {
		return Array.from(this.providers.values());
	}

	/**
	 * Get providers that are currently configured and usable.
	 * Filters to providers where `isConfigured(config)` returns true.
	 */
	getAvailable(
		providerConfigs: Record<string, ProviderConfig>,
	): SearchProvider[] {
		return this.getAll().filter((p) => {
			const config = providerConfigs[p.meta.type];
			return config != null && p.isConfigured(config);
		});
	}

	/**
	 * Available providers sorted by user's priority order.
	 * Providers not in `priorityOrder` are excluded (not appended).
	 * Unconfigured providers are excluded even if in the priority list.
	 */
	getAvailableByPriority(
		providerConfigs: Record<string, ProviderConfig>,
		priorityOrder: string[],
	): SearchProvider[] {
		const available = new Map<string, SearchProvider>();
		for (const p of this.getAvailable(providerConfigs)) {
			available.set(p.meta.type, p);
		}

		const result: SearchProvider[] = [];
		for (const type of priorityOrder) {
			const provider = available.get(type);
			if (provider) {
				result.push(provider);
			}
		}
		return result;
	}
}
