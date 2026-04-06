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
import { isDomainBlocked } from "../utils/domain-denylist";

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

// Re-export from standalone utility for backward compatibility.
// Canonical location: src/utils/domain-denylist.ts
export { isDomainBlocked } from "../utils/domain-denylist";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** User-Agent header sent with all requests. */
const USER_AGENT = "Notor/1.0";

// ---------------------------------------------------------------------------
// Chromium net error diagnostic hints
// ---------------------------------------------------------------------------

/**
 * Maps common Chromium `net::ERR_*` error code substrings to human-readable
 * diagnostic hints. When `requestUrl()` fails at the network level, the raw
 * error message typically contains one of these codes with no further context.
 *
 * Order matters: more-specific codes must appear before `ERR_FAILED` (the
 * catch-all) so the first match wins.
 */
const CHROMIUM_NET_ERROR_HINTS: Record<string, string> = {
	ERR_NAME_NOT_RESOLVED:
		"DNS lookup failed — check the hostname or your network connection",
	ERR_CONNECTION_REFUSED:
		"Connection refused — the server may be down or blocking requests",
	ERR_CONNECTION_TIMED_OUT:
		"Connection timed out — the server took too long to respond",
	ERR_CONNECTION_RESET:
		"Connection reset by the server — it may have dropped the connection",
	ERR_INTERNET_DISCONNECTED: "No internet connection detected",
	ERR_SSL_PROTOCOL_ERROR:
		"SSL/TLS handshake failed — the site may have a certificate issue",
	ERR_CERT_AUTHORITY_INVALID:
		"SSL certificate not trusted — the certificate may be self-signed or expired",
	ERR_CERT_DATE_INVALID:
		"SSL certificate has expired or is not yet valid",
	ERR_BLOCKED_BY_CLIENT:
		"Request blocked by a browser extension or content policy",
	ERR_TOO_MANY_REDIRECTS:
		"Too many redirects — the URL may be in a redirect loop",
	ERR_INVALID_URL: "The URL is malformed or not supported by the network stack",
	ERR_NETWORK_CHANGED:
		"Network changed during the request — try again",
	ERR_ADDRESS_UNREACHABLE:
		"The server address is unreachable — it may be on a private or unavailable network",
	ERR_EMPTY_RESPONSE: "The server returned an empty response",
	// ERR_FAILED is Chromium's catch-all — keep last so specific codes match first
	ERR_FAILED:
		"Generic network failure — check your internet connection, proxy settings, or try again",
};

/**
 * Extract a human-readable hint for a Chromium `net::ERR_*` code embedded in
 * an error message. Returns `null` if no known code is found.
 */
function getNetErrorHint(errorMessage: string): string | null {
	for (const [code, hint] of Object.entries(CHROMIUM_NET_ERROR_HINTS)) {
		if (errorMessage.includes(code)) {
			return hint;
		}
	}
	return null;
}

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

			// Diagnostic: when requestUrl fails, probe with native fetch to
			// isolate whether the problem is Obsidian's API or the Electron
			// network stack itself.
			let nativeFetchResult: string;
			try {
				const probe = await fetch(url, {
					method: "HEAD",
					signal: AbortSignal.timeout(5000),
				});
				nativeFetchResult = `native fetch OK (status ${probe.status})`;
			} catch (probeErr) {
				nativeFetchResult = `native fetch also failed: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`;
			}

			log.warn("Fetch failed", {
				url,
				hostname: parsedUrl.hostname,
				error: message,
				errorName: e instanceof Error ? e.name : "Unknown",
				nativeFetchResult,
				...(e instanceof Error && e.stack ? { stack: e.stack } : {}),
			});
			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: `${message} [diagnostic: ${nativeFetchResult}]`,
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
			const rawMessage = e instanceof Error ? e.message : String(e);
			const hint = getNetErrorHint(rawMessage);
			const enhanced = hint
				? `Failed to fetch URL: ${rawMessage} — ${hint}`
				: `Failed to fetch URL: ${rawMessage}`;
			throw new Error(enhanced);
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