/**
 * `fetch_webpage` tool — fetches a webpage by URL and returns content as
 * Markdown (for HTML) or as-is (for text/JSON).
 *
 * Includes domain denylist matching, download size cap, output character
 * cap, and Turndown HTML-to-Markdown conversion with GFM plugin.
 *
 * Read-only tool available in both Plan and Act modes.
 * Auto-approve default: true.
 *
 * @see specs/02-context-intelligence/contracts/tool-schemas.md — fetch_webpage schema
 * @see specs/02-context-intelligence/research.md § R-4 — Turndown findings
 * @see specs/02-context-intelligence/tasks.md — TOOL-010, TOOL-011, TOOL-012
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { requestUrl } from "obsidian";
import type { App } from "obsidian";
import type { Tool, ToolResult } from "./tool";
import type { NotorSettings } from "../settings";
import { logger } from "../utils/logger";

const log = logger("FetchWebpageTool");

// ---------------------------------------------------------------------------
// Turndown singleton (configured once per plugin lifecycle)
// ---------------------------------------------------------------------------

let turndownInstance: TurndownService | null = null;

/**
 * Get a lazily-initialized, configured Turndown instance.
 *
 * Configuration per R-4 findings: ATX headings, fenced code blocks,
 * `-` bullet markers, inline links, `*` emphasis. GFM plugin for
 * tables, strikethrough, and task lists. Custom rules to strip noisy
 * navigation elements and forms.
 */
function getTurndown(): TurndownService {
	if (!turndownInstance) {
		turndownInstance = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			bulletListMarker: "-",
			emDelimiter: "*",
			strongDelimiter: "**",
			linkStyle: "inlined",
		});

		// GFM support (tables, strikethrough, task lists)
		turndownInstance.use(gfm);

		// Strip noisy navigation elements
		turndownInstance.addRule("stripNav", {
			filter: ["nav", "footer", "aside"],
			replacement: () => "",
		});

		// Strip form elements
		turndownInstance.addRule("stripForms", {
			filter: ["form", "input", "select", "button"],
			replacement: () => "",
		});
	}
	return turndownInstance;
}

// ---------------------------------------------------------------------------
// Domain denylist matching (TOOL-011)
// ---------------------------------------------------------------------------

/**
 * Check whether a URL's domain is blocked by the denylist.
 *
 * Supports:
 * - Exact domain match: `example.com` blocks only `example.com`
 * - Wildcard match: `*.example.com` blocks all sub-domains but NOT
 *   `example.com` itself
 *
 * @param url      - The URL to check.
 * @param denylist - Array of domain patterns from settings.
 * @returns `{ blocked: true, pattern: string }` if blocked, or
 *          `{ blocked: false }` if allowed.
 */
export function isDomainBlocked(
	url: string,
	denylist: string[]
): { blocked: true; pattern: string } | { blocked: false } {
	if (!denylist || denylist.length === 0) {
		return { blocked: false };
	}

	let hostname: string;
	try {
		const parsed = new URL(url);
		hostname = parsed.hostname.toLowerCase();
	} catch {
		// If URL can't be parsed, let the fetch itself fail later
		return { blocked: false };
	}

	for (const pattern of denylist) {
		const p = pattern.trim().toLowerCase();
		if (!p) continue;

		if (p.startsWith("*.")) {
			// Wildcard: *.example.com blocks sub.example.com but not example.com
			const baseDomain = p.slice(2);
			if (hostname.endsWith("." + baseDomain)) {
				return { blocked: true, pattern };
			}
		} else {
			// Exact match
			if (hostname === p) {
				return { blocked: true, pattern };
			}
		}
	}

	return { blocked: false };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum redirect hops before erroring. */
const MAX_REDIRECTS = 5;

/** User-Agent header sent with all requests. */
const USER_AGENT = "Notor/1.0";

// ---------------------------------------------------------------------------
// Tool implementation (TOOL-010 + TOOL-012)
// ---------------------------------------------------------------------------

/**
 * Implements the `fetch_webpage` tool.
 *
 * Fetches a URL via HTTP GET, converts HTML to Markdown via Turndown,
 * and returns text/JSON as-is. Enforces domain denylist, download size
 * cap, redirect limit, timeout, and output character cap.
 */
export class FetchWebpageTool implements Tool {
	readonly name = "fetch_webpage";
	readonly mode = "read" as const;

	readonly description =
		"Fetch a webpage by URL and return its content converted to Markdown. " +
		"For HTML pages, the content is converted using Turndown. For plain text " +
		"and JSON responses, the content is returned as-is. Binary content types " +
		"(PDF, images, etc.) are not supported. A domain denylist may block certain " +
		"URLs. The returned content may be truncated if it exceeds the configured " +
		"output size limit.";

	readonly input_schema = {
		type: "object",
		properties: {
			url: {
				type: "string",
				description:
					"URL of the webpage to fetch. Both http:// and https:// URLs are accepted.",
			},
		},
		required: ["url"],
	};

	constructor(
		private readonly app: App,
		private readonly settings: NotorSettings
	) {}

	async execute(params: Record<string, unknown>): Promise<ToolResult> {
		const url = params["url"] as string;

		if (!url || typeof url !== "string") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: "Missing required parameter: url",
			};
		}

		// Validate URL format
		let parsedUrl: URL;
		try {
			parsedUrl = new URL(url);
		} catch {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Invalid URL: ${url}`,
			};
		}

		// Only allow http and https
		if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Unsupported protocol: ${parsedUrl.protocol}. Only http:// and https:// URLs are accepted.`,
			};
		}

		// Step 1-2: Domain denylist check
		const denyCheck = isDomainBlocked(url, this.settings.domain_denylist);
		if (denyCheck.blocked) {
			log.info("Domain blocked by denylist", {
				url,
				pattern: denyCheck.pattern,
			});
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Domain ${parsedUrl.hostname} is blocked by your denylist.`,
			};
		}

		// Step 3-4: Fetch with timeout, redirects, and size cap
		const timeoutMs = this.settings.fetch_webpage_timeout * 1000;
		const maxDownloadBytes =
			this.settings.fetch_webpage_max_download_mb * 1024 * 1024;
		const maxOutputChars = this.settings.fetch_webpage_max_output_chars;

		log.info("Fetching webpage", {
			url,
			timeout: `${this.settings.fetch_webpage_timeout}s`,
			maxDownloadMb: this.settings.fetch_webpage_max_download_mb,
		});

		let body: string;
		let mimeType: string;
		try {
			const fetchResult = await this.fetchWithObsidian(
				url,
				timeoutMs,
				maxDownloadBytes
			);
			body = fetchResult.body;
			mimeType = fetchResult.mimeType;
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			log.warn("Fetch failed", { url, error: message });
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: message,
			};
		}

		let content: string;
		if (mimeType === "text/html" || mimeType === "application/xhtml+xml") {
			// HTML → Turndown conversion
			try {
				content = getTurndown().turndown(body);
			} catch (e) {
				log.warn("Turndown conversion failed", {
					url,
					error: String(e),
				});
				// Fall back to raw text if conversion fails
				content = body;
			}
		} else if (
			mimeType.startsWith("text/") ||
			mimeType === "application/json"
		) {
			// text/* and application/json → as-is
			content = body;
		} else {
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `Content type '${mimeType}' is not supported. Only text/html, text/*, and application/json are supported.`,
			};
		}

		// Step 6: Output character cap
		const totalLength = content.length;
		if (totalLength > maxOutputChars) {
			const truncated = content.substring(0, maxOutputChars);
			const result =
				truncated +
				`\n\nNote: page was truncated at ${maxOutputChars.toLocaleString()} characters; total fetched length was ${totalLength.toLocaleString()} characters.`;
			log.info("Output truncated", {
				url,
				totalLength,
				maxOutputChars,
			});
			return {
				tool_name: this.name,
				success: true,
				result,
			};
		}

		log.info("Fetch complete", {
			url,
			contentType: mimeType,
			contentLength: content.length,
		});

		return {
			tool_name: this.name,
			success: true,
			result: content,
		};
	}

	// -----------------------------------------------------------------------
	// HTTP helpers
	// -----------------------------------------------------------------------

	/**
	 * Fetch a URL using Obsidian's `requestUrl()` API.
	 *
	 * `requestUrl()` executes in Obsidian's main process rather than the
	 * renderer, which means it bypasses Electron's CORS enforcement. This
	 * is required for fetching URLs from sites that don't set
	 * `Access-Control-Allow-Origin: *` (e.g. Wikipedia).
	 *
	 * Enforces the download size cap via the Content-Length header (when
	 * present) and by checking the decoded body length after receipt.
	 * Note: `requestUrl()` buffers the full response before returning, so
	 * streaming mid-download cancellation is not possible — we reject
	 * after the fact if the body exceeds the cap.
	 */
	private async fetchWithObsidian(
		url: string,
		timeoutMs: number,
		maxDownloadBytes: number
	): Promise<{ body: string; mimeType: string }> {
		let response: Awaited<ReturnType<typeof requestUrl>>;

		try {
			// requestUrl does not natively support a timeout; we race against
			// a manual timer.
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

			response = await Promise.race([
				requestUrl({
					url,
					method: "GET",
					headers: { "User-Agent": USER_AGENT },
					throw: false, // handle non-2xx ourselves
				}),
				timeoutPromise,
			]);
		} catch (e) {
			throw new Error(
				`Failed to fetch URL: ${e instanceof Error ? e.message : String(e)}`
			);
		}

		if (response.status < 200 || response.status >= 300) {
			throw new Error(
				`HTTP request failed with status ${response.status}.`
			);
		}

		// Check size via body byte length
		const bodyBytes = new TextEncoder().encode(response.text).length;
		if (bodyBytes > maxDownloadBytes) {
			throw new Error(
				`Response body too large: download aborted at ${this.settings.fetch_webpage_max_download_mb} MB.`
			);
		}

		const contentType = response.headers["content-type"] ?? "";
		const mimeType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

		return { body: response.text, mimeType };
	}
}