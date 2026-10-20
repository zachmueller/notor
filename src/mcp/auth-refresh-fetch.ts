/**
 * Auth-refreshing `fetch` wrapper for HTTP MCP servers with a `headersHelper`.
 *
 * Layers the helper's headers over every request the SDK makes (POST, the GET
 * SSE stream, DELETE). When a response looks like an expired login-proxy
 * session — 401, 403, or a redirect to another origin — it re-runs the helper
 * and retries the request once with the fresh headers. A second failure is
 * reported through `onAuthFailure` so McpHub can fall back to its reconnect /
 * backoff path, and the caller gets a synthetic 401 rather than the proxy's
 * redirect or sign-in page.
 *
 * Helper header values live only in this closure; they are never logged.
 *
 * @see specs/04d-mcp-headers-helper/spec.md — FR-182, FR-184
 */

import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { logger } from "../utils/logger";

const log = logger("McpAuthRefresh");

export interface AuthRefreshFetchOptions {
	/** Server name, for logs. */
	serverName: string;
	/** Server URL — redirects to any other origin count as auth failures. */
	serverUrl: string | URL;
	/** Underlying fetch (the Node-side fetch on desktop). */
	baseFetch: FetchLike;
	/** Helper headers from the connect-time run. */
	initialHeaders: Record<string, string>;
	/** Re-run the helper. */
	runHelper: () => Promise<Record<string, string>>;
	/** Called when a request still fails auth after a refresh (or the refresh failed). */
	onAuthFailure?: (message: string) => void;
}

/** Whether a response looks like an expired or rejected session. */
export function isAuthFailure(response: Response, serverOrigin: string): boolean {
	if (response.status === 401 || response.status === 403) return true;
	// The renderer fetch with redirect: "manual" hides the target entirely.
	if (response.type === "opaqueredirect") return true;
	if (response.status >= 300 && response.status < 400) {
		const location = response.headers.get("location");
		if (!location) return false;
		try {
			return new URL(location, serverOrigin).origin !== serverOrigin;
		} catch {
			return true;
		}
	}
	return false;
}

/** Synthetic response returned instead of the proxy's redirect / sign-in page. */
function authFailedResponse(message: string): Response {
	return new Response(message, {
		status: 401,
		statusText: "Unauthorized",
		headers: { "content-type": "text/plain" },
	});
}

async function discard(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		/* already consumed or errored */
	}
}

function withHeaders(init: RequestInit | undefined, extra: Record<string, string>): RequestInit {
	const headers = new Headers(init?.headers);
	for (const [name, value] of Object.entries(extra)) {
		headers.set(name, value);
	}
	return { ...init, headers };
}

/** Create the wrapped `fetch` for one transport instance. */
export function createAuthRefreshFetch(opts: AuthRefreshFetchOptions): FetchLike {
	const serverOrigin = new URL(opts.serverUrl).origin;
	let current = opts.initialHeaders;
	/** Bumped on every successful refresh. */
	let generation = 0;
	let refreshing: Promise<Record<string, string>> | null = null;

	/**
	 * Fresh helper headers for a request sent under `sentGeneration`.
	 *
	 * Single-flight: concurrent failures share one helper run, and a request
	 * that failed with headers that have since been refreshed just retries with
	 * the newer ones instead of running the helper again.
	 */
	const refresh = (sentGeneration: number): Promise<Record<string, string>> => {
		if (sentGeneration !== generation) return Promise.resolve(current);
		refreshing ??= opts.runHelper()
			.then((headers) => {
				current = headers;
				generation++;
				log.debug("headersHelper refreshed headers", {
					serverName: opts.serverName,
					headerKeys: Object.keys(headers),
				});
				return headers;
			})
			.finally(() => {
				refreshing = null;
			});
		return refreshing;
	};

	return async (url, init) => {
		const sentGeneration = generation;
		const first = await opts.baseFetch(url, withHeaders(init, current));
		if (!isAuthFailure(first, serverOrigin)) return first;

		log.info("MCP server rejected the session — re-running headersHelper", {
			serverName: opts.serverName,
			status: first.status,
		});
		await discard(first);

		let fresh: Record<string, string>;
		try {
			fresh = await refresh(sentGeneration);
		} catch (e) {
			const message = `Authentication failed and headersHelper could not refresh headers: ${e instanceof Error ? e.message : String(e)}`;
			opts.onAuthFailure?.(message);
			return authFailedResponse(message);
		}

		const second = await opts.baseFetch(url, withHeaders(init, fresh));
		if (!isAuthFailure(second, serverOrigin)) return second;

		await discard(second);
		const message = `Authentication failed after refreshing headers (HTTP ${second.status}).`;
		log.warn("MCP server rejected refreshed headers", {
			serverName: opts.serverName,
			status: second.status,
		});
		opts.onAuthFailure?.(message);
		return authFailedResponse(message);
	};
}
