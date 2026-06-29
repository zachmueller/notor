import { requestUrl } from "obsidian";
import type {
	SearchProvider,
	SearchProviderMeta,
	SearchProviderResult,
	ProviderConfig,
	WebSearchResult,
} from "./provider";

/** Minimal shape of the Brave search response (fields Notor reads). */
interface BraveResponse {
	web?: { results?: Array<{ title: string; url: string; description: string }> };
}

export class BraveSearchProvider implements SearchProvider {
	readonly meta: SearchProviderMeta = {
		type: "brave",
		displayName: "Brave Search",
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

		const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults}`;

		const racers: Promise<unknown>[] = [
			requestUrl({
				url,
				method: "GET",
				headers: {
					Accept: "application/json",
					"X-Subscription-Token": apiKey ?? "",
				},
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

		const json = JSON.parse(response.text) as BraveResponse;
		const webResults = json.web?.results ?? [];
		const results: WebSearchResult[] = webResults.map(
			(r) => ({
				title: r.title,
				url: r.url,
				snippet: r.description,
			}),
		);

		return { results };
	}

	isConfigured(config: ProviderConfig): boolean {
		return config.enabled && !!config.apiKey;
	}
}
