/**
 * Transient-failure classification shared by every provider and every
 * stream consumer (chat orchestrator, run-loop, workflows, compaction).
 *
 * Providers use `isTransientNetworkError` to map low-level transport
 * failures (DNS, reset, timeout, a canceled HTTP/2 stream) to
 * `CONNECTION_FAILED`. Consumers use `isRetryableProviderFailure` to decide
 * whether a failed turn may be re-sent automatically.
 */

import { ProviderError, type ProviderErrorCode, type StreamChunk } from "./provider";

/** Node/undici/Smithy error codes that indicate the network briefly went away. */
const TRANSIENT_CODES = new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENETDOWN",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
]);

/** Error `name`s the AWS SDK / Smithy use for transport-level failures. */
const TRANSIENT_NAMES = new Set(["TimeoutError", "NetworkingError", "RequestTimeout", "RequestTimeoutException"]);

const TRANSIENT_MESSAGE =
	/pending stream has been canceled|socket hang up|network|fetch failed|failed to fetch|load failed|terminated|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_CONNECTION|ERR_HTTP2|getaddrinfo|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i;

/** Codes a consumer may retry automatically. */
const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
	"CONNECTION_FAILED",
	"RATE_LIMITED",
	"SERVICE_UNAVAILABLE",
]);

const MAX_CAUSE_DEPTH = 5;

/**
 * True when `e` (or anything in its `.cause` chain) looks like a transient
 * network failure. Never matches an abort — callers check their abort
 * signal first, and a user Stop must not be retried.
 */
export function isTransientNetworkError(e: unknown): boolean {
	let current: unknown = e;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && current != null; depth++) {
		if (typeof current === "object") {
			const err = current as { name?: unknown; code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
			if (err.name === "AbortError") return false;
			if (typeof err.code === "string" && (TRANSIENT_CODES.has(err.code) || err.code.startsWith("ERR_HTTP2"))) return true;
			if (typeof err.errno === "string" && TRANSIENT_CODES.has(err.errno)) return true;
			if (typeof err.name === "string" && TRANSIENT_NAMES.has(err.name)) return true;
			if (typeof err.message === "string" && TRANSIENT_MESSAGE.test(err.message)) return true;
			current = err.cause;
		} else {
			return typeof current === "string" && TRANSIENT_MESSAGE.test(current);
		}
	}
	return false;
}

/**
 * Whether a classified failure may be retried automatically. An explicit
 * `retryable` flag wins; otherwise network, throttling and transient
 * server errors are retryable. Auth, invalid-request and context-overflow
 * failures never are.
 */
export function isRetryableProviderFailure(failure: { code?: ProviderErrorCode; retryable?: boolean }): boolean {
	if (failure.retryable !== undefined) return failure.retryable;
	return failure.code !== undefined && RETRYABLE_CODES.has(failure.code);
}

/**
 * Classify anything a stream consumer caught: a `ProviderError` uses its
 * code/flag; an error carrying `code`/`retryable` fields (e.g. one rethrown
 * from an error chunk) uses those; any other error is retryable only when
 * it looks like a transient network failure.
 */
export function isRetryableError(e: unknown): boolean {
	return retryableCodeOfError(e) !== null;
}

/**
 * Build an Error for a stream `error` chunk that keeps its classification,
 * so consumers that throw on error chunks (compaction, workflows) can still
 * retry them via `isRetryableError`.
 */
export function errorFromChunk(
	message: string,
	chunk: { code?: ProviderErrorCode; retryable?: boolean },
): Error & { providerCode?: ProviderErrorCode; retryable?: boolean } {
	const err = new Error(message) as Error & { providerCode?: ProviderErrorCode; retryable?: boolean };
	err.providerCode = chunk.code;
	err.retryable = chunk.retryable;
	return err;
}

/** HTTP statuses that indicate a transient server-side failure (5xx, Anthropic 529 overloaded). */
export function isTransientHttpStatus(status: number): boolean {
	return status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

/**
 * Build the `error` chunk a fetch-based provider yields when its response
 * body fails mid-stream (connection reset, DNS drop), instead of letting the
 * raw exception escape the generator unclassified.
 */
export function streamFailureChunk(e: unknown): Extract<StreamChunk, { type: "error" }> {
	const message = e instanceof Error ? e.message : String(e);
	return {
		type: "error",
		error: message,
		code: isTransientNetworkError(e) ? "CONNECTION_FAILED" : "PROVIDER_ERROR",
		details: { name: e instanceof Error ? e.name : undefined, rawMessage: message },
	};
}

/**
 * Wrap a provider's raw stream so an exception thrown after the request was
 * accepted (body reader rejected mid-stream) becomes a classified `error`
 * chunk. Pre-stream `ProviderError`s are already classified and rethrown
 * unchanged; aborts end the stream quietly.
 */
export async function* catchStreamFailures(
	stream: AsyncIterable<StreamChunk>,
	signal: AbortSignal | undefined,
	onFailure?: (e: unknown) => void,
): AsyncIterable<StreamChunk> {
	try {
		yield* stream;
	} catch (e: unknown) {
		if (e instanceof ProviderError) throw e;
		if (signal?.aborted) return;
		onFailure?.(e);
		yield streamFailureChunk(e);
	}
}

/**
 * The code to report for a retryable failure, or null when it must not be
 * retried. Used as the `classify` callback of `withStreamRetry`.
 */
export function retryableCodeOfFailure(failure: { code?: ProviderErrorCode; retryable?: boolean }): ProviderErrorCode | null {
	if (!isRetryableProviderFailure(failure)) return null;
	return failure.code ?? "CONNECTION_FAILED";
}

/** `retryableCodeOfFailure` for anything thrown out of a provider stream. */
export function retryableCodeOfError(e: unknown): ProviderErrorCode | null {
	if (e instanceof ProviderError) return retryableCodeOfFailure(e);
	if (e && typeof e === "object") {
		const tagged = e as { providerCode?: ProviderErrorCode; retryable?: boolean };
		if (tagged.providerCode !== undefined || tagged.retryable !== undefined) {
			return retryableCodeOfFailure({ code: tagged.providerCode, retryable: tagged.retryable });
		}
	}
	return isTransientNetworkError(e) ? "CONNECTION_FAILED" : null;
}
