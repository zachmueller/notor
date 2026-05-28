/** Supported web search provider identifiers. */
export type WebSearchProviderType = "duckduckgo" | "tavily" | "brave" | "serpapi" | "kagi";

/** Static metadata for a search provider. */
export interface SearchProviderMeta {
	type: WebSearchProviderType;
	displayName: string;
	requiresApiKey: boolean;
	/** Recommended minimum delay between requests (ms). */
	defaultDelayMs: number;
}

/** Resolved configuration for a single provider (from extension settings). */
export interface ProviderConfig {
	enabled: boolean;
	delayMs: number;
	apiKey: string | null;
}

/** Normalized search result from any provider. */
export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

/** Result from a single provider search attempt. */
export interface SearchProviderResult {
	results: WebSearchResult[];
	/** True if the provider signalled rate-limiting (HTTP 429, 202, etc.). */
	rateLimited?: boolean;
	/** Human-readable error string, if any. */
	error?: string;
	/** Non-fatal warnings (e.g. selector drift). Logged by the WebSearchQueue. */
	warnings?: string[];
}

/** A web search provider implementation. */
export interface SearchProvider {
	readonly meta: SearchProviderMeta;

	/**
	 * Execute a web search via this provider's API.
	 *
	 * @param query      - Search query string.
	 * @param numResults - Maximum number of results to return.
	 * @param timeoutMs  - Request timeout in milliseconds.
	 * @param apiKey     - API key resolved from settings (null for keyless providers).
	 * @param signal     - Optional AbortSignal for cancellation.
	 */
	search(
		query: string,
		numResults: number,
		timeoutMs: number,
		apiKey: string | null,
		signal?: AbortSignal,
	): Promise<SearchProviderResult>;

	/**
	 * Whether this provider is currently usable given its resolved config.
	 * Checks enabled state and API key presence (for key-requiring providers).
	 */
	isConfigured(config: ProviderConfig): boolean;
}
