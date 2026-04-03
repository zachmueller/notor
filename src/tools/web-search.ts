/**
 * `web_search` tool — searches the web via DuckDuckGo's HTML endpoint
 * and returns titles, URLs, and snippets as a markdown list.
 *
 * Uses the browser-native `DOMParser` for HTML parsing (NOT `@xmldom/xmldom`,
 * which is XML-only). Domain denylist filtering is applied to result URLs
 * before returning them to the LLM.
 *
 * Read-only tool available in both Plan and Act modes.
 * Auto-approve default: true.
 */

import { requestUrl } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { isDomainBlocked } from "./fetch-webpage";
import { logger } from "../utils/logger";

const log = logger("WebSearchTool");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single web search result. */
export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

// ---------------------------------------------------------------------------
// URL cleaning
// ---------------------------------------------------------------------------

/**
 * Decode a DuckDuckGo result URL.
 *
 * DDG wraps all result URLs in a redirect of the form
 * `//duckduckgo.com/l/?uddg={encoded_url}&...`. This function extracts the
 * actual destination URL.
 *
 * @param raw - The raw `href` from the DDG result link element.
 * @returns The cleaned URL, or `null` if the input is unrecognised.
 */
export function cleanDDGUrl(raw: string): string | null {
	// Handle redirect: //duckduckgo.com/l/?uddg=...
	if (raw.startsWith("//duckduckgo.com/l/")) {
		const qIndex = raw.indexOf("?");
		if (qIndex === -1) return null;
		const params = new URLSearchParams(raw.substring(qIndex + 1));
		const actual = params.get("uddg");
		if (!actual) return null;
		return decodeURIComponent(actual);
	}
	// Handle protocol-relative
	if (raw.startsWith("//")) return "https:" + raw;
	// Already absolute
	if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
	return null;
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

/**
 * Parse DuckDuckGo HTML search results into structured data.
 *
 * Uses the browser-native global `DOMParser` (available in Electron's
 * renderer context) with `text/html` mime type.
 *
 * @param html       - Raw HTML response body from DDG.
 * @param maxResults - Maximum number of results to extract.
 * @returns Array of parsed search results (may be shorter than `maxResults`).
 */
export function parseDDGResults(
	html: string,
	maxResults: number
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

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

/**
 * Implements the `web_search` tool.
 *
 * Searches the web via DuckDuckGo's HTML endpoint and returns results as a
 * numbered markdown list with titles, URLs, and snippets. Domain denylist
 * filtering is applied to result URLs before returning them.
 */
export class WebSearchTool implements Tool {
	readonly name = "web_search";
	readonly mode = "read" as const;

	readonly description =
		"Search the web using DuckDuckGo and return a list of results with " +
		"titles, URLs, and snippets. Use this to find information, explore " +
		"topics, or discover URLs that can then be fetched with fetch_webpage " +
		"for full content. Results are snippets only, not full page content. " +
		"A domain denylist may filter out certain results.";

	readonly input_schema = {
		type: "object",
		properties: {
			query: {
				type: "string",
				description: "Search query string.",
			},
			num_results: {
				type: "number",
				description:
					"Number of results to return. Defaults to 5. Maximum 10.",
				default: 5,
			},
		},
		required: ["query"],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const query = params["query"] as string;

		if (!query || typeof query !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: query",
			};
		}

		// Clamp num_results to 1–10, defaulting to the configured value.
		const rawNum =
			typeof params["num_results"] === "number"
				? params["num_results"]
				: this.settings.web_search_default_num_results;
		const numResults = Math.max(1, Math.min(10, Math.round(rawNum)));

		const timeoutMs = this.settings.web_search_timeout * 1000;

		log.info("Web search initiated", { query, numResults, timeoutMs });

		// -----------------------------------------------------------------
		// Fetch search results from DuckDuckGo
		// -----------------------------------------------------------------

		let responseText: string;
		try {
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
							)
						),
					timeoutMs
				)
			);

			const response = await Promise.race([
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
			]);

			if (response.status !== 200) {
				log.warn("DuckDuckGo returned non-200 status", {
					status: response.status,
				});
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Search request failed with HTTP status ${response.status}.`,
				};
			}

			responseText = response.text;
		} catch (e) {
			const message =
				e instanceof Error ? e.message : "Unknown network error";
			log.warn("Web search request failed", { error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Web search failed: ${message}`,
			};
		}

		// -----------------------------------------------------------------
		// Parse and filter results
		// -----------------------------------------------------------------

		const parsed = parseDDGResults(responseText, numResults);

		// Warn on possible selector drift: DDG returned content but no
		// results could be extracted — the HTML structure may have changed.
		if (parsed.length === 0 && responseText.length > 0) {
			log.warn(
				"DuckDuckGo returned a non-empty response but 0 results were parsed. " +
					"The HTML structure may have changed (selector drift).",
				{ query, responseLength: responseText.length }
			);
		}

		// Filter out blocked domains
		const results = parsed.filter((r) => {
			const check = isDomainBlocked(r.url, this.settings.domain_denylist);
			if (check.blocked) {
				log.debug("Filtered blocked domain from search results", {
					url: r.url,
					pattern: check.pattern,
				});
			}
			return !check.blocked;
		});

		if (results.length === 0) {
			return {
				tool_name: this.name,
				success: true,
				result: `No results found for query: ${query}`,
			};
		}

		// -----------------------------------------------------------------
		// Format output as numbered markdown list
		// -----------------------------------------------------------------

		const lines: string[] = [
			`Web search results for "${query}" (${results.length} result${results.length === 1 ? "" : "s"}):`,
			"",
		];

		for (let i = 0; i < results.length; i++) {
			const r = results[i]!;
			lines.push(`${i + 1}. **[${r.title}](${r.url})**`);
			if (r.snippet) {
				lines.push(`   ${r.snippet}`);
			}
			lines.push("");
		}

		const output = lines.join("\n").trimEnd();

		log.info("Web search completed", {
			query,
			resultCount: results.length,
		});

		return {
			tool_name: this.name,
			success: true,
			result: output,
		};
	}
}
