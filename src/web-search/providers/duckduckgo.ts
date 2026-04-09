import { requestUrl } from "obsidian";
import type {
	SearchProvider,
	SearchProviderMeta,
	SearchProviderResult,
	ProviderConfig,
	WebSearchResult,
} from "./provider";

/**
 * Clean a DuckDuckGo result URL, resolving redirects and protocol-relative URLs.
 *
 * Exported for testing only — not part of the public API.
 */
export function cleanDDGUrl(raw: string): string | null {
	if (raw.startsWith("//duckduckgo.com/l/")) {
		const qIndex = raw.indexOf("?");
		if (qIndex === -1) return null;
		const urlParams = new URLSearchParams(raw.substring(qIndex + 1));
		const actual = urlParams.get("uddg");
		if (!actual) return null;
		return decodeURIComponent(actual);
	}
	if (raw.startsWith("//")) return "https:" + raw;
	if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
	return null;
}

/**
 * Parse DuckDuckGo HTML search results into structured objects.
 *
 * Uses browser-native DOMParser (available in Obsidian's Electron runtime).
 * Exported for testing only — not part of the public API.
 */
export function parseDDGResults(
	html: string,
	maxResults: number,
): WebSearchResult[] {
	const parser = new DOMParser();
	const doc = parser.parseFromString(html, "text/html");
	const results: WebSearchResult[] = [];

	const containers = Array.from(doc.querySelectorAll(".result"));
	for (const el of containers) {
		if (results.length >= maxResults) break;

		const titleEl = el.querySelector(".result__title a");
		const snippetEl = el.querySelector(".result__snippet");

		const title = titleEl?.textContent?.trim() ?? "";
		const rawUrl = titleEl?.getAttribute("href") ?? "";
		const snippet = snippetEl?.textContent?.trim() ?? "";

		if (!title || !rawUrl) continue;

		const url = cleanDDGUrl(rawUrl);
		if (!url) continue;

		results.push({ title, url, snippet });
	}

	return results;
}

export class DuckDuckGoProvider implements SearchProvider {
	readonly meta: SearchProviderMeta = {
		type: "duckduckgo",
		displayName: "DuckDuckGo",
		requiresApiKey: false,
		defaultDelayMs: 1500,
	};

	async search(
		query: string,
		numResults: number,
		timeoutMs: number,
		_apiKey: string | null,
		signal?: AbortSignal,
	): Promise<SearchProviderResult> {
		const warnings: string[] = [];

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
				url: "https://html.duckduckgo.com/html/",
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent":
						"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					DNT: "1",
				},
				body: `q=${encodeURIComponent(query)}&kl=us-en`,
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

		// Rate-limit detection: HTTP 202 signals DDG throttling
		if (response.status === 202) {
			return { results: [], rateLimited: true };
		}

		if (response.status !== 200) {
			throw new Error(
				`Search request failed with HTTP status ${response.status}.`,
			);
		}

		const parsed = parseDDGResults(response.text, numResults);

		// Selector drift detection: non-empty body but 0 results → likely rate-limited or HTML changed
		if (parsed.length === 0 && response.text.length > 0) {
			warnings.push(
				"DuckDuckGo returned a non-empty response but 0 results were parsed. " +
					"The HTML structure may have changed (selector drift).",
			);
			return { results: [], rateLimited: true, warnings };
		}

		return { results: parsed, warnings: warnings.length > 0 ? warnings : undefined };
	}

	isConfigured(config: ProviderConfig): boolean {
		return config.enabled;
	}
}
