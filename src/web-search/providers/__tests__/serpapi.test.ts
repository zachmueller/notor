import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { SerpApiProvider } from "../serpapi";
import type { ProviderConfig } from "../provider";

const mockRequestUrl = vi.mocked(requestUrl);

describe("SerpApiProvider", () => {
	let provider: SerpApiProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new SerpApiProvider();
	});

	// ── meta ────────────────────────────────────────────────────────

	describe("meta", () => {
		it("has correct metadata", () => {
			expect(provider.meta).toEqual({
				type: "serpapi",
				displayName: "SerpApi",
				requiresApiKey: true,
				defaultDelayMs: 0,
			});
		});
	});

	// ── search() ────────────────────────────────────────────────────

	describe("search", () => {
		it("returns parsed results on HTTP 200", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({
					organic_results: [
						{
							title: "SerpApi Result",
							link: "https://serpapi.com",
							snippet: "A result from SerpApi.",
						},
						{
							title: "Google Result",
							link: "https://google.com/result",
							snippet: "Another organic result.",
						},
					],
				}),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test query", 5, 10000, "test-key");

			expect(result.results).toHaveLength(2);
			expect(result.results[0]).toEqual({
				title: "SerpApi Result",
				url: "https://serpapi.com",
				snippet: "A result from SerpApi.",
			});
			expect(result.results[1]).toEqual({
				title: "Google Result",
				url: "https://google.com/result",
				snippet: "Another organic result.",
			});
			expect(result.rateLimited).toBeUndefined();
		});

		it("sends api_key in query params", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({ organic_results: [] }),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await provider.search("test", 5, 10000, "serp-key-789");

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.url).toContain("api_key=serp-key-789");
			expect(call.url).toContain("engine=google");
			expect(call.method).toBe("GET");
		});

		it("sends correct query and num in URL", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({ organic_results: [] }),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await provider.search("hello world", 3, 10000, "key");

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.url).toContain("q=hello%20world");
			expect(call.url).toContain("num=3");
			expect(call.throw).toBe(false);
		});

		it("detects rate-limit on HTTP 429", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 429,
				text: "Too Many Requests",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test", 5, 10000, "key");

			expect(result.rateLimited).toBe(true);
			expect(result.results).toEqual([]);
		});

		it("detects rate-limit from JSON error containing 'rate'", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({
					error: "Your account has exceeded the rate limit. Please try again later.",
				}),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test", 5, 10000, "key");

			expect(result.rateLimited).toBe(true);
			expect(result.results).toEqual([]);
		});

		it("does not treat non-rate JSON errors as rate-limited", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({
					error: "Invalid API key",
					organic_results: [],
				}),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test", 5, 10000, "key");

			// "Invalid API key" doesn't contain "rate", so not rate-limited
			expect(result.rateLimited).toBeUndefined();
			expect(result.results).toEqual([]);
		});

		it("throws on non-200/429 status", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 401,
				text: "Unauthorized",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await expect(
				provider.search("test", 5, 10000, "key"),
			).rejects.toThrow("HTTP status 401");
		});

		it("rejects on timeout", async () => {
			mockRequestUrl.mockImplementation(
				() =>
					new Promise(() => {
						// never resolves
					}),
			);

			await expect(
				provider.search("test", 5, 50, "key"),
			).rejects.toThrow("timed out");
		});

		it("propagates network errors", async () => {
			mockRequestUrl.mockRejectedValue(new Error("DNS resolution failed"));

			await expect(
				provider.search("test", 5, 10000, "key"),
			).rejects.toThrow("DNS resolution failed");
		});

		it("handles missing organic_results in response", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({}),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test", 5, 10000, "key");

			expect(result.results).toEqual([]);
		});

		it("rejects when abort signal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			mockRequestUrl.mockImplementation(
				() =>
					new Promise(() => {
						// never resolves
					}),
			);

			await expect(
				provider.search("test", 5, 10000, "key", controller.signal),
			).rejects.toThrow("aborted");
		});

		it("rejects when abort signal fires during request", async () => {
			const controller = new AbortController();

			mockRequestUrl.mockImplementation(
				() =>
					new Promise(() => {
						// never resolves
					}),
			);

			const searchPromise = provider.search(
				"test",
				5,
				30000,
				"key",
				controller.signal,
			);

			await Promise.resolve();
			controller.abort();

			await expect(searchPromise).rejects.toThrow("aborted");
		});
	});

	// ── isConfigured() ──────────────────────────────────────────────

	describe("isConfigured", () => {
		it("returns true when enabled with API key", () => {
			const config: ProviderConfig = {
				enabled: true,
				delayMs: 0,
				apiKey: "some-key",
			};
			expect(provider.isConfigured(config)).toBe(true);
		});

		it("returns false when enabled but no API key", () => {
			const config: ProviderConfig = {
				enabled: true,
				delayMs: 0,
				apiKey: null,
			};
			expect(provider.isConfigured(config)).toBe(false);
		});

		it("returns false when enabled but empty API key", () => {
			const config: ProviderConfig = {
				enabled: true,
				delayMs: 0,
				apiKey: "",
			};
			expect(provider.isConfigured(config)).toBe(false);
		});

		it("returns false when disabled", () => {
			const config: ProviderConfig = {
				enabled: false,
				delayMs: 0,
				apiKey: "some-key",
			};
			expect(provider.isConfigured(config)).toBe(false);
		});
	});
});
