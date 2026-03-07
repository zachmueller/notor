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

	constructor(private readonly settings: NotorSettings) {}

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

		let response: Response;
		try {
			response = await this.fetchWithRedirects(
				url,
				timeoutMs,
				maxDownloadBytes
			);
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

		// Step 5: Content-type routing
		const contentType = response.headers.get("content-type") ?? "";
		const mimeType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";

		let body: string;
		try {
			body = await this.readBodyWithSizeCap(response, maxDownloadBytes);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
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
				error: `Content type '${mimeType || contentType}' is not supported. Only text/html, text/*, and application/json are supported.`,
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
	 * Fetch a URL with manual redirect following and timeout.
	 *
	 * Uses `redirect: "manual"` to count redirect hops and enforce
	 * the maximum (5). Uses `AbortSignal.timeout()` for request timeout.
	 */
	private async fetchWithRedirects(
		url: string,
		timeoutMs: number,
		maxDownloadBytes: number
	): Promise<Response> {
		let currentUrl = url;
		let redirectCount = 0;

		while (redirectCount <= MAX_REDIRECTS) {
			let response: Response;
			try {
				response = await fetch(currentUrl, {
					method: "GET",
					headers: {
						"User-Agent": USER_AGENT,
					},
					redirect: "manual",
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (e) {
				if (e instanceof DOMException && e.name === "TimeoutError") {
					throw new Error(
						`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
					);
				}
				if (e instanceof DOMException && e.name === "AbortError") {
					throw new Error(
						`Request timed out after ${Math.round(timeoutMs / 1000)} seconds.`
					);
				}
				throw new Error(
					`Failed to fetch URL: ${e instanceof Error ? e.message : String(e)}`
				);
			}

			// Handle redirects (3xx status codes)
			if (
				response.status >= 300 &&
				response.status < 400 &&
				response.headers.get("location")
			) {
				redirectCount++;
				if (redirectCount > MAX_REDIRECTS) {
					throw new Error(
						`Too many redirects (exceeded ${MAX_REDIRECTS} hops).`
					);
				}
				const location = response.headers.get("location")!;
				// Resolve relative redirects
				currentUrl = new URL(location, currentUrl).href;
				continue;
			}

			// Check for non-success status
			if (!response.ok) {
				throw new Error(
					`HTTP request failed with status ${response.status}: ${response.statusText}`
				);
			}

			// Check Content-Length header if available
			const contentLength = response.headers.get("content-length");
			if (contentLength) {
				const size = parseInt(contentLength, 10);
				if (!isNaN(size) && size > maxDownloadBytes) {
					throw new Error(
						`Response body too large: download aborted at ${this.settings.fetch_webpage_max_download_mb} MB.`
					);
				}
			}

			return response;
		}

		throw new Error(
			`Too many redirects (exceeded ${MAX_REDIRECTS} hops).`
		);
	}

	/**
	 * Read the response body as text, enforcing the download size cap.
	 *
	 * Reads the body in chunks to monitor cumulative size and abort
	 * early if the cap is exceeded.
	 */
	private async readBodyWithSizeCap(
		response: Response,
		maxBytes: number
	): Promise<string> {
		// If the body is not streamable, fall back to text()
		if (!response.body) {
			const text = await response.text();
			if (new Blob([text]).size > maxBytes) {
				throw new Error(
					`Response body too large: download aborted at ${this.settings.fetch_webpage_max_download_mb} MB.`
				);
			}
			return text;
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8");
		const chunks: string[] = [];
		let totalBytes = 0;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				totalBytes += value.byteLength;
				if (totalBytes > maxBytes) {
					reader.cancel();
					throw new Error(
						`Response body too large: download aborted at ${this.settings.fetch_webpage_max_download_mb} MB.`
					);
				}

				chunks.push(decoder.decode(value, { stream: true }));
			}
		} finally {
			reader.releaseLock();
		}

		// Flush any remaining bytes in the decoder
		chunks.push(decoder.decode());

		return chunks.join("");
	}
}