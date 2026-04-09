import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { BraveSearchProvider } from "../brave";
import type { ProviderConfig } from "../provider";

const mockRequestUrl = vi.mocked(requestUrl);

describe("BraveSearchProvider", () => {
	let provider: BraveSearchProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new BraveSearchProvider();
	});

	// ── meta ────────────────────────────────────────────────────────

	describe("meta", () => {
		it("has correct metadata", () => {
			expect(provider.meta).toEqual({
				type: "brave",
				displayName: "Brave Search",
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
					web: {
						results: [
							{
								title: "Brave Result",
								url: "https://brave.com",
								description: "A search result from Brave.",
							},
							{
								title: "Second Result",
								url: "https://second.com",
								description: "Another result.",
							},
						],
					},
				}),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test query", 5, 10000, "test-key");

			expect(result.results).toHaveLength(2);
			expect(result.results[0]).toEqual({
				title: "Brave Result",
				url: "https://brave.com",
				snippet: "A search result from Brave.",
			});
			expect(result.results[1]).toEqual({
				title: "Second Result",
				url: "https://second.com",
				snippet: "Another result.",
			});
			expect(result.rateLimited).toBeUndefined();
		});

		it("sends X-Subscription-Token header with API key", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({ web: { results: [] } }),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await provider.search("test", 5, 10000, "brave-key-456");

			expect(mockRequestUrl).toHaveBeenCalledWith(
				expect.objectContaining({
					headers: expect.objectContaining({
						"X-Subscription-Token": "brave-key-456",
					}),
					throw: false,
				}),
			);
		});

		it("sends correct query and count in URL", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({ web: { results: [] } }),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await provider.search("hello world", 3, 10000, "key");

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.url).toBe(
				"https://api.search.brave.com/res/v1/web/search?q=hello%20world&count=3",
			);
			expect(call.method).toBe("GET");
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

		it("throws on non-200/429 status", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 403,
				text: "Forbidden",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await expect(
				provider.search("test", 5, 10000, "key"),
			).rejects.toThrow("HTTP status 403");
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
			mockRequestUrl.mockRejectedValue(new Error("Connection refused"));

			await expect(
				provider.search("test", 5, 10000, "key"),
			).rejects.toThrow("Connection refused");
		});

		it("handles missing web.results in response", async () => {
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
