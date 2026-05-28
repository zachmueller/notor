import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { KagiSearchProvider } from "../kagi";
import type { ProviderConfig } from "../provider";

const mockRequestUrl = vi.mocked(requestUrl);

describe("KagiSearchProvider", () => {
	let provider: KagiSearchProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new KagiSearchProvider();
	});

	// ── meta ────────────────────────────────────────────────────────

	describe("meta", () => {
		it("has correct metadata", () => {
			expect(provider.meta).toEqual({
				type: "kagi",
				displayName: "Kagi",
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
					data: [
						{
							title: "Example Result",
							url: "https://example.com",
							snippet: "This is the snippet content.",
						},
						{
							title: "Another Result",
							url: "https://another.com",
							snippet: "Another snippet.",
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
				title: "Example Result",
				url: "https://example.com",
				snippet: "This is the snippet content.",
			});
			expect(result.results[1]).toEqual({
				title: "Another Result",
				url: "https://another.com",
				snippet: "Another snippet.",
			});
			expect(result.rateLimited).toBeUndefined();
		});

		it("sends Authorization Bot header with API key", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({ data: [] }),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await provider.search("test", 5, 10000, "my-api-key-123");

			expect(mockRequestUrl).toHaveBeenCalledWith(
				expect.objectContaining({
					url: expect.stringContaining("https://kagi.com/api/v0/search"),
					method: "GET",
					headers: expect.objectContaining({
						Authorization: "Bot my-api-key-123",
					}),
					throw: false,
				}),
			);
		});

		it("sends correct query params in URL", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: JSON.stringify({ data: [] }),
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await provider.search("hello world", 3, 10000, "key");

			const call = mockRequestUrl.mock.calls[0][0];
			expect(call.url).toBe(
				"https://kagi.com/api/v0/search?q=hello%20world&limit=3",
			);
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
				status: 500,
				text: "Internal Server Error",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await expect(
				provider.search("test", 5, 10000, "key"),
			).rejects.toThrow("HTTP status 500");
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
			mockRequestUrl.mockRejectedValue(new Error("Network unreachable"));

			await expect(
				provider.search("test", 5, 10000, "key"),
			).rejects.toThrow("Network unreachable");
		});

		it("returns empty results when data field is missing", async () => {
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
