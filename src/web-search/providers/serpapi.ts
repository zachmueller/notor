import { requestUrl } from "obsidian";
import type {
	SearchProvider,
	SearchProviderMeta,
	SearchProviderResult,
	ProviderConfig,
	WebSearchResult,
} from "./provider";

/** Minimal shape of the SerpApi search response (fields Notor reads). */
interface SerpApiResponse {
	error?: string;
	organic_results?: Array<{ title: string; link: string; snippet: string }>;
}

export class SerpApiProvider implements SearchProvider {
	readonly meta: SearchProviderMeta = {
		type: "serpapi",
		displayName: "SerpApi",
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

		const url =
			`https://serpapi.com/search?q=${encodeURIComponent(query)}` +
			`&num=${numResults}&api_key=${encodeURIComponent(apiKey ?? "")}` +
			`&engine=google`;

		const racers: Promise<unknown>[] = [
			requestUrl({
				url,
				method: "GET",
				headers: {
					Accept: "application/json",
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

		const json = JSON.parse(response.text) as SerpApiResponse;

		// SerpApi may also signal rate limiting via a JSON error field
		if (
			json.error &&
			typeof json.error === "string" &&
			json.error.toLowerCase().includes("rate")
		) {
			return { results: [], rateLimited: true };
		}

		const organicResults = json.organic_results ?? [];
		const results: WebSearchResult[] = organicResults.map(
			(r) => ({
				title: r.title,
				url: r.link,
				snippet: r.snippet,
			}),
		);

		return { results };
	}

	isConfigured(config: ProviderConfig): boolean {
		return config.enabled && !!config.apiKey;
	}
}
