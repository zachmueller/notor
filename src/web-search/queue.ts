import type { TaskLaneQueue } from "../queue/task-lane-queue";
import type { SearchProviderRegistry } from "./provider-registry";
import type {
	WebSearchProviderType,
	WebSearchResult,
	ProviderConfig,
	SearchProvider,
} from "./providers/provider";

/** Resolved web search configuration — built from flat extension settings. */
export interface WebSearchResolvedConfig {
	roundRobin: boolean;
	providerPriority: string[];
	maxFallbackProviders: number;
	providers: Record<string, ProviderConfig>;
}

/** Result returned by WebSearchQueue.search(). */
export interface WebSearchApiResult {
	results: WebSearchResult[];
	/** Which provider fulfilled the request (empty string if all failed). */
	provider: string;
	/** Providers that were tried and failed, with reasons. */
	failures: Array<{ provider: string; error: string }>;
	/** Set when the queue itself cannot proceed (e.g. no providers configured). */
	error?: string;
}

/**
 * Web-search-specific orchestration layer on top of TaskLaneQueue.
 * Handles provider selection, round-robin, fallback, and config resolution.
 *
 * Settings are read fresh on every search() call — not cached at construction.
 */
export class WebSearchQueue {
	private roundRobinIndex = 0;

	constructor(
		private readonly getSettings: () => Record<string, unknown>,
		private readonly providerRegistry: SearchProviderRegistry,
		private readonly laneQueue: TaskLaneQueue,
	) {}

	/**
	 * Execute a web search. The queue selects the provider based on
	 * priority order, availability, and round-robin state.
	 *
	 * Settings are read from the constructor-provided `getSettings` callback.
	 * For caller-supplied config, use {@link searchWithConfig}.
	 */
	async search(
		query: string,
		numResults: number,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<WebSearchApiResult> {
		const config = this.buildConfig(this.getSettings());
		return this.searchWithConfig(query, numResults, timeoutMs, config, signal);
	}

	/**
	 * Execute a web search with an explicit config (no settings lookup).
	 * Useful for extension tools that manage their own provider settings.
	 */
	async searchWithConfig(
		query: string,
		numResults: number,
		timeoutMs: number,
		config: WebSearchResolvedConfig,
		signal?: AbortSignal,
	): Promise<WebSearchApiResult> {
		const chain = this.resolveProviderChain(config, this.roundRobinIndex);
		this.roundRobinIndex++;

		if (chain.length === 0) {
			return {
				results: [],
				provider: "",
				failures: [],
				error: "No web search providers are configured",
			};
		}

		const failures: Array<{ provider: string; error: string }> = [];
		const maxAttempts = config.maxFallbackProviders;

		for (let i = 0; i < chain.length && failures.length < maxAttempts; i++) {
			const provider = chain[i]!;

			if (signal?.aborted) {
				failures.push({
					provider: provider.meta.type,
					error: "Aborted",
				});
				break;
			}

			const providerConfig = config.providers[provider.meta.type];
			const apiKey = providerConfig?.apiKey ?? null;
			const delayMs = providerConfig?.delayMs ?? provider.meta.defaultDelayMs;

			try {
				const result = await this.laneQueue.enqueue(
					provider.meta.type,
					() => provider.search(query, numResults, timeoutMs, apiKey, signal),
					delayMs,
				);

				if (result.warnings && result.warnings.length > 0) {
					// Warnings are surfaced to the caller — the scaffold logs them
				}

				if (!result.rateLimited) {
					return {
						results: result.results,
						provider: provider.meta.type,
						failures,
					};
				}

				failures.push({
					provider: provider.meta.type,
					error: "Rate limited",
				});
			} catch (err) {
				failures.push({
					provider: provider.meta.type,
					error: String(err),
				});
			}
		}

		return {
			results: [],
			provider: "",
			failures,
			error: "All search providers failed",
		};
	}

	/**
	 * Map flat extension settings to typed config.
	 * Setting key names match the scaffold YAML fence keys.
	 */
	buildConfig(settings: Record<string, unknown>): WebSearchResolvedConfig {
		return {
			roundRobin: (settings.web_search_round_robin as boolean) ?? false,
			providerPriority:
				(settings.web_search_provider_priority as string[]) ?? [
					"duckduckgo",
					"tavily",
					"brave",
					"serpapi",
					"kagi",
				],
			maxFallbackProviders:
				(settings.web_search_max_fallback_providers as number) ?? 2,
			providers: {
				duckduckgo: {
					enabled:
						(settings.web_search_duckduckgo_enabled as boolean) ?? true,
					delayMs:
						(settings.web_search_duckduckgo_delay_ms as number) ?? 1500,
					apiKey: null,
				},
				tavily: {
					enabled:
						(settings.web_search_tavily_enabled as boolean) ?? false,
					delayMs:
						(settings.web_search_tavily_delay_ms as number) ?? 0,
					apiKey:
						(settings.web_search_tavily_api_key as string) ?? null,
				},
				brave: {
					enabled:
						(settings.web_search_brave_enabled as boolean) ?? false,
					delayMs:
						(settings.web_search_brave_delay_ms as number) ?? 0,
					apiKey:
						(settings.web_search_brave_api_key as string) ?? null,
				},
				serpapi: {
					enabled:
						(settings.web_search_serpapi_enabled as boolean) ?? false,
					delayMs:
						(settings.web_search_serpapi_delay_ms as number) ?? 0,
					apiKey:
						(settings.web_search_serpapi_api_key as string) ?? null,
				},
				kagi: {
					enabled:
						(settings.web_search_kagi_enabled as boolean) ?? false,
					delayMs:
						(settings.web_search_kagi_delay_ms as number) ?? 0,
					apiKey:
						(settings.web_search_kagi_api_key as string) ?? null,
				},
			},
		};
	}

	/**
	 * Resolve the ordered provider fallback chain.
	 *
	 * Pure function — no side effects. The returned chain always contains ALL
	 * available providers. Round-robin only rotates the starting position.
	 *
	 * @param config     - Resolved web search config.
	 * @param startIndex - Round-robin index (ignored when round-robin is off).
	 */
	resolveProviderChain(
		config: WebSearchResolvedConfig,
		startIndex: number,
	): SearchProvider[] {
		const available = this.providerRegistry.getAvailableByPriority(
			config.providers,
			config.providerPriority,
		);

		if (!config.roundRobin || available.length === 0) {
			return available;
		}

		// Rotate: starting position is startIndex % length, then wrap cyclically
		const offset = startIndex % available.length;
		return [
			...available.slice(offset),
			...available.slice(0, offset),
		];
	}
}
