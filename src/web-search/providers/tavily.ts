import { requestUrl } from "obsidian";
import type {
	SearchProvider,
	SearchProviderMeta,
	SearchProviderResult,
	ProviderConfig,
	WebSearchResult,
} from "./provider";

/** Minimal shape of the Tavily search response (fields Notor reads). */
interface TavilyResponse {
	results?: Array<{ title: string; url: string; content: string }>;
}

export class TavilyProvider implements SearchProvider {
	readonly meta: SearchProviderMeta = {
		type: "tavily",
		displayName: "Tavily",
		requiresApiKey: true,
		defaultDelayMs: 0,
	};

	async search(
		query: string,
		numResults: number,
		timeoutMs: number,
		apiKey: string | null,
		signal?: AbortSignal,
	): Promise<SearchProviderResult> {
		const timeoutPromise = new Promise<never>((_, reject) =>
			setTimeout(
				() =>
					reject(
						new Error(
							`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
						),
					),
				timeoutMs,
			),
		);

		const racers: Promise<unknown>[] = [
			requestUrl({
				url: "https://api.tavily.com/search",
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: numResults }),
				throw: false,
			}),
			timeoutPromise,
		];

		if (signal) {
			racers.push(
				new Promise<never>((_, reject) => {
					if (signal.aborted) {
						reject(new DOMException("The operation was aborted.", "AbortError"));
						return;
					}
					signal.addEventListener(
						"abort",
						() =>
							reject(
								new DOMException("The operation was aborted.", "AbortError"),
							),
						{ once: true },
					);
				}),
			);
		}

		const response = (await Promise.race(racers)) as {
			status: number;
			text: string;
		};

		if (response.status === 429) {
			return { results: [], rateLimited: true };
		}

		if (response.status !== 200) {
			throw new Error(
				`Search request failed with HTTP status ${response.status}.`,
			);
		}

		const json = JSON.parse(response.text) as TavilyResponse;
		const results: WebSearchResult[] = (json.results ?? []).map(
			(r) => ({
				title: r.title,
				url: r.url,
				snippet: r.content,
			}),
		);

		return { results };
	}

	isConfigured(config: ProviderConfig): boolean {
		return config.enabled && !!config.apiKey;
	}
}
