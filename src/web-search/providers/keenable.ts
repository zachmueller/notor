import { requestUrl } from "obsidian";
import type {
	SearchProvider,
	SearchProviderMeta,
	SearchProviderResult,
	ProviderConfig,
	WebSearchResult,
} from "./provider";

/** Minimal shape of the Keenable search response (fields Notor reads). */
interface KeenableResponse {
	results?: Array<{ title?: string; url?: string; description?: string; snippet?: string }>;
}

const SNIPPET_MAX_CHARS = 500;

export class KeenableSearchProvider implements SearchProvider {
	readonly meta: SearchProviderMeta = {
		type: "keenable",
		displayName: "Keenable",
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
		let timer: number | undefined;
		let onAbort: (() => void) | undefined;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = window.setTimeout(
				() =>
					reject(
						new Error(
							`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
						),
					),
				timeoutMs,
			);
		});

		const racers: Promise<unknown>[] = [
			requestUrl({
				url: "https://api.keenable.ai/v1/search",
				method: "POST",
				contentType: "application/json",
				headers: {
					Accept: "application/json",
					"X-API-Key": apiKey ?? "",
					"X-Keenable-Title": "Notor",
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
					onAbort = () =>
						reject(new DOMException("The operation was aborted.", "AbortError"));
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			);
		}

		let response: { status: number; text: string };
		try {
			response = (await Promise.race(racers)) as {
				status: number;
				text: string;
			};
		} finally {
			window.clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}

		if (response.status === 429) {
			return { results: [], rateLimited: true };
		}

		if (response.status !== 200) {
			throw new Error(
				`Search request failed with HTTP status ${response.status}.`,
			);
		}

		const json = JSON.parse(response.text) as KeenableResponse;
		const results: WebSearchResult[] = (json.results ?? [])
			.filter((r) => typeof r.url === "string" && r.url.length > 0)
			.map((r) => ({
				title: r.title || r.url!,
				url: r.url!,
				snippet: (r.description || r.snippet || "").slice(0, SNIPPET_MAX_CHARS),
			}));

		return { results };
	}

	isConfigured(config: ProviderConfig): boolean {
		return config.enabled && !!config.apiKey;
	}
}
