import { describe, it, expect } from "vitest";

import {
	catchStreamFailures,
	errorFromChunk,
	isRetryableError,
	isRetryableProviderFailure,
	isTransientNetworkError,
} from "./network-errors";
import { ProviderError, type StreamChunk } from "./provider";

function nodeError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

function named(name: string, message: string): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

describe("isTransientNetworkError", () => {
	it("matches the in-flight Wi-Fi report (canceled HTTP/2 stream caused by ENOTFOUND)", () => {
		const cause = nodeError("getaddrinfo ENOTFOUND bedrock-runtime.us-west-2.amazonaws.com", "ENOTFOUND");
		const e = new Error("The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-west-2.amazonaws.com)");
		(e as Error & { cause?: unknown }).cause = cause;
		expect(isTransientNetworkError(e)).toBe(true);
		// The message alone is enough, without the cause chain.
		expect(isTransientNetworkError(new Error(e.message))).toBe(true);
	});

	it("matches transport codes, SDK timeout names and fetch failures", () => {
		expect(isTransientNetworkError(nodeError("read ECONNRESET", "ECONNRESET"))).toBe(true);
		expect(isTransientNetworkError(nodeError("boom", "EHOSTUNREACH"))).toBe(true);
		expect(isTransientNetworkError(nodeError("boom", "ERR_HTTP2_STREAM_CANCEL"))).toBe(true);
		expect(isTransientNetworkError(named("TimeoutError", "Connection timed out after 1000 ms"))).toBe(true);
		expect(isTransientNetworkError(new Error("socket hang up"))).toBe(true);
		expect(isTransientNetworkError(new TypeError("Failed to fetch"))).toBe(true);
		expect(isTransientNetworkError(new TypeError("network error"))).toBe(true);
	});

	it("follows the cause chain", () => {
		const e = Object.assign(new Error("Request failed"), { cause: nodeError("x", "EAI_AGAIN") });
		expect(isTransientNetworkError(e)).toBe(true);
	});

	it("never matches aborts or request/auth failures", () => {
		expect(isTransientNetworkError(named("AbortError", "The operation was aborted"))).toBe(false);
		expect(isTransientNetworkError(named("ValidationException", "Malformed input request"))).toBe(false);
		expect(isTransientNetworkError(named("AccessDeniedException", "You don't have access to the model"))).toBe(false);
		expect(isTransientNetworkError(undefined)).toBe(false);
	});
});

describe("isRetryableProviderFailure / isRetryableError", () => {
	it("retries network, throttling and transient server codes only", () => {
		expect(isRetryableProviderFailure({ code: "CONNECTION_FAILED" })).toBe(true);
		expect(isRetryableProviderFailure({ code: "RATE_LIMITED" })).toBe(true);
		expect(isRetryableProviderFailure({ code: "SERVICE_UNAVAILABLE" })).toBe(true);
		for (const code of ["AUTH_FAILED", "INVALID_REQUEST", "CONTEXT_LENGTH_EXCEEDED", "PROVIDER_ERROR"] as const) {
			expect(isRetryableProviderFailure({ code })).toBe(false);
		}
		expect(isRetryableProviderFailure({})).toBe(false);
	});

	it("lets an explicit retryable flag override the code", () => {
		expect(isRetryableProviderFailure({ code: "CONNECTION_FAILED", retryable: false })).toBe(false);
		expect(isRetryableError(new ProviderError("x", "local", "CONNECTION_FAILED", undefined, undefined, false))).toBe(false);
	});

	it("classifies ProviderErrors, chunk-derived errors and raw network errors", () => {
		expect(isRetryableError(new ProviderError("x", "bedrock", "SERVICE_UNAVAILABLE"))).toBe(true);
		expect(isRetryableError(new ProviderError("x", "bedrock", "AUTH_FAILED"))).toBe(false);
		expect(isRetryableError(errorFromChunk("x", { code: "RATE_LIMITED" }))).toBe(true);
		expect(isRetryableError(errorFromChunk("socket hang up", { code: "PROVIDER_ERROR" }))).toBe(false);
		expect(isRetryableError(new TypeError("Failed to fetch"))).toBe(true);
		expect(isRetryableError(new Error("Unexpected token"))).toBe(false);
	});
});

describe("catchStreamFailures", () => {
	async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
		const out: StreamChunk[] = [];
		for await (const chunk of stream) out.push(chunk);
		return out;
	}

	it("turns a mid-stream throw into a classified error chunk", async () => {
		const source = (async function* (): AsyncIterable<StreamChunk> {
			yield { type: "text_delta", text: "partial" };
			throw new TypeError("network error");
		})();
		const chunks = await drain(catchStreamFailures(source, undefined));
		expect(chunks).toEqual([
			{ type: "text_delta", text: "partial" },
			expect.objectContaining({ type: "error", error: "network error", code: "CONNECTION_FAILED" }),
		]);
	});

	it("rethrows pre-stream ProviderErrors and ends quietly on abort", async () => {
		const pre = (async function* (): AsyncIterable<StreamChunk> {
			throw new ProviderError("denied", "anthropic", "AUTH_FAILED");
		})();
		await expect(drain(catchStreamFailures(pre, undefined))).rejects.toMatchObject({ code: "AUTH_FAILED" });

		const controller = new AbortController();
		controller.abort();
		const aborted = (async function* (): AsyncIterable<StreamChunk> {
			throw new TypeError("network error");
		})();
		expect(await drain(catchStreamFailures(aborted, controller.signal))).toEqual([]);
	});
});
