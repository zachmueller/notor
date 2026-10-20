/**
 * Node-side `fetch` for HTTP MCP transports (desktop only).
 *
 * The renderer's `fetch` silently drops the `Cookie` header (a forbidden
 * request header), subjects every request to CORS from `app://obsidian.md`,
 * and turns a cross-origin redirect into an opaque `TypeError`. Login-proxied
 * MCP servers need all three to work, so servers with a `headersHelper` (or a
 * fixed `Cookie` header) use this `FetchLike` built on Node's `http`/`https`.
 *
 * It returns a WHATWG `Response` whose body streams the `IncomingMessage`
 * chunk by chunk, so the SDK's SSE parser works unchanged. Same-origin
 * redirects are followed (fetch semantics); cross-origin redirects are always
 * returned unfollowed so the caller can treat them as an expired session.
 *
 * @see specs/04d-mcp-headers-helper/spec.md — Background, Transport selection
 */

import * as http from "http";
import * as https from "https";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** Maximum same-origin redirects followed per request. */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Statuses for which `new Response()` must be given a null body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Flatten any `HeadersInit` into a plain object. */
export function headersToRecord(init: HeadersInit | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!init) return out;
	if (init instanceof Headers) {
		init.forEach((value, key) => { out[key] = value; });
	} else if (Array.isArray(init)) {
		for (const [key, value] of init) out[key] = value;
	} else {
		Object.assign(out, init);
	}
	return out;
}

function bodyToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return Buffer.from(body, "utf8");
	if (body instanceof Uint8Array) return Buffer.from(body);
	if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
	if (body instanceof URLSearchParams) return Buffer.from(body.toString(), "utf8");
	throw new TypeError("nodeFetch supports string, Uint8Array, ArrayBuffer and URLSearchParams bodies only.");
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError");
}

function toResponseHeaders(raw: http.IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}
	return headers;
}

interface RequestSpec {
	url: URL;
	method: string;
	headers: Record<string, string>;
	body: Buffer | undefined;
	signal: AbortSignal | undefined;
}

/** One HTTP exchange; resolves once response headers arrive. */
function sendOnce(spec: RequestSpec): Promise<{ res: http.IncomingMessage; response: Response }> {
	return new Promise((resolve, reject) => {
		const { url, method, headers, body, signal } = spec;
		if (signal?.aborted) {
			reject(abortError(signal));
			return;
		}

		const transport = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
		if (!transport) {
			reject(new TypeError(`nodeFetch: unsupported protocol ${url.protocol}`));
			return;
		}

		const outHeaders: Record<string, string> = { ...headers };
		if (body) outHeaders["content-length"] = String(body.length);

		let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
		const onAbort = () => {
			const err = abortError(signal!);
			req.destroy(err);
			try { streamController?.error(err); } catch { /* already closed */ }
			reject(err);
		};

		const req = transport.request(url, { method, headers: outHeaders }, (res) => {
			const status = res.statusCode ?? 0;
			const nullBody = NULL_BODY_STATUSES.has(status) || method === "HEAD";
			let stream: ReadableStream<Uint8Array> | null = null;

			if (nullBody) {
				res.resume();
				res.on("end", () => signal?.removeEventListener("abort", onAbort));
			} else {
				stream = new ReadableStream<Uint8Array>({
					start(controller) {
						streamController = controller;
						res.on("data", (chunk: Buffer) => {
							controller.enqueue(new Uint8Array(chunk));
							if ((controller.desiredSize ?? 1) <= 0) res.pause();
						});
						res.on("end", () => {
							signal?.removeEventListener("abort", onAbort);
							try { controller.close(); } catch { /* already errored */ }
						});
						res.on("error", (e) => {
							signal?.removeEventListener("abort", onAbort);
							try { controller.error(e); } catch { /* already closed */ }
						});
					},
					pull() {
						res.resume();
					},
					cancel() {
						signal?.removeEventListener("abort", onAbort);
						res.destroy();
					},
				});
			}

			const response = new Response(stream, {
				status,
				statusText: res.statusMessage ?? "",
				headers: toResponseHeaders(res.headers),
			});
			resolve({ res, response });
		});

		req.on("error", (e) => {
			signal?.removeEventListener("abort", onAbort);
			reject(new TypeError(`fetch failed: ${e.message}`));
		});
		signal?.addEventListener("abort", onAbort, { once: true });

		if (body) req.write(body);
		req.end();
	});
}

/**
 * `fetch` over Node `http`/`https`.
 *
 * Honours `method`, `headers` (including `Cookie`), string/binary `body`,
 * `signal`, and `redirect` (`"follow"` follows same-origin redirects only;
 * `"manual"` never follows; `"error"` rejects on any redirect).
 */
export const nodeFetch: FetchLike = async (input, init) => {
	let url = new URL(typeof input === "string" ? input : input.href);
	const origin = url.origin;
	let method = (init?.method ?? "GET").toUpperCase();
	let headers = headersToRecord(init?.headers);
	let body = bodyToBuffer(init?.body);
	const signal = init?.signal ?? undefined;
	const redirectMode = init?.redirect ?? "follow";

	for (let redirects = 0; ; redirects++) {
		const { res, response } = await sendOnce({ url, method, headers, body, signal });
		const status = response.status;
		const location = response.headers.get("location");

		if (!REDIRECT_STATUSES.has(status) || !location || redirectMode === "manual") {
			return response;
		}
		if (redirectMode === "error") {
			res.destroy();
			throw new TypeError("fetch failed: redirect mode is \"error\"");
		}

		const next = new URL(location, url);
		// Cross-origin redirects are never followed — for MCP servers behind a
		// login proxy this is the expired-session signal the caller acts on.
		if (next.origin !== origin) return response;
		if (redirects >= MAX_REDIRECTS) {
			res.destroy();
			throw new TypeError("fetch failed: too many redirects");
		}

		res.resume();
		// Fetch spec: 303 always, and 301/302 for POST, switch to a bodiless GET.
		if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
			if (method !== "HEAD") method = "GET";
			body = undefined;
			headers = Object.fromEntries(
				Object.entries(headers).filter(([k]) => !/^content-(type|length|encoding|language|location)$/i.test(k))
			);
		}
		url = next;
	}
};
