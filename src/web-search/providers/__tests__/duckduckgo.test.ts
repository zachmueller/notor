// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import {
	cleanDDGUrl,
	parseDDGResults,
	DuckDuckGoProvider,
} from "../duckduckgo";
import type { ProviderConfig } from "../provider";

const mockRequestUrl = vi.mocked(requestUrl);

describe("DuckDuckGoProvider", () => {
	let provider: DuckDuckGoProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new DuckDuckGoProvider();
	});

	// ── cleanDDGUrl ─────────────────────────────────────────────────

	describe("cleanDDGUrl", () => {
		it("decodes DDG redirect URL", () => {
			const raw =
				"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc";
			expect(cleanDDGUrl(raw)).toBe("https://example.com/page");
		});

		it("returns null for DDG redirect without uddg param", () => {
			expect(cleanDDGUrl("//duckduckgo.com/l/?rut=abc")).toBeNull();
		});

		it("returns null for DDG redirect without query string", () => {
			expect(cleanDDGUrl("//duckduckgo.com/l/")).toBeNull();
		});

		it("converts protocol-relative URL to https", () => {
			expect(cleanDDGUrl("//example.com/page")).toBe(
				"https://example.com/page",
			);
		});

		it("passes through absolute HTTP URL", () => {
			expect(cleanDDGUrl("http://example.com")).toBe("http://example.com");
		});

		it("passes through absolute HTTPS URL", () => {
			expect(cleanDDGUrl("https://example.com")).toBe("https://example.com");
		});

		it("returns null for empty string", () => {
			expect(cleanDDGUrl("")).toBeNull();
		});

		it("returns null for relative path", () => {
			expect(cleanDDGUrl("foo/bar")).toBeNull();
		});
	});

	// ── parseDDGResults ─────────────────────────────────────────────

	describe("parseDDGResults", () => {
		it("extracts multiple results from valid HTML", () => {
			const html = `
				<div class="result">
					<a class="result__title" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">
						<a href="https://example.com">Example Title</a>
					</a>
					<div class="result__title"><a href="https://example.com">Example Title</a></div>
					<div class="result__snippet">Example snippet text.</div>
				</div>
				<div class="result">
					<div class="result__title"><a href="https://other.com">Other Title</a></div>
					<div class="result__snippet">Other snippet.</div>
				</div>
			`;
			const results = parseDDGResults(html, 10);
			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({
				title: "Example Title",
				url: "https://example.com",
				snippet: "Example snippet text.",
			});
			expect(results[1]).toEqual({
				title: "Other Title",
				url: "https://other.com",
				snippet: "Other snippet.",
			});
		});

		it("honors maxResults cap", () => {
			const html = `
				<div class="result">
					<div class="result__title"><a href="https://a.com">A</a></div>
					<div class="result__snippet">Snippet A</div>
				</div>
				<div class="result">
					<div class="result__title"><a href="https://b.com">B</a></div>
					<div class="result__snippet">Snippet B</div>
				</div>
				<div class="result">
					<div class="result__title"><a href="https://c.com">C</a></div>
					<div class="result__snippet">Snippet C</div>
				</div>
			`;
			const results = parseDDGResults(html, 2);
			expect(results).toHaveLength(2);
			expect(results[0].title).toBe("A");
			expect(results[1].title).toBe("B");
		});

		it("skips results with missing title", () => {
			const html = `
				<div class="result">
					<div class="result__title"><a href="https://a.com"></a></div>
					<div class="result__snippet">No title</div>
				</div>
				<div class="result">
					<div class="result__title"><a href="https://b.com">Has Title</a></div>
					<div class="result__snippet">Has snippet</div>
				</div>
			`;
			const results = parseDDGResults(html, 10);
			expect(results).toHaveLength(1);
			expect(results[0].title).toBe("Has Title");
		});

		it("skips results with missing URL", () => {
			const html = `
				<div class="result">
					<div class="result__title"><a>No Href</a></div>
					<div class="result__snippet">Snippet</div>
				</div>
			`;
			const results = parseDDGResults(html, 10);
			expect(results).toHaveLength(0);
		});

		it("returns empty array for empty HTML", () => {
			expect(parseDDGResults("", 10)).toEqual([]);
		});

		it("returns empty array when no .result containers found", () => {
			expect(parseDDGResults("<div>No results here</div>", 10)).toEqual([]);
		});
	});

	// ── meta ────────────────────────────────────────────────────────

	describe("meta", () => {
		it("has correct metadata", () => {
			expect(provider.meta).toEqual({
				type: "duckduckgo",
				displayName: "DuckDuckGo",
				requiresApiKey: false,
				defaultDelayMs: 1500,
			});
		});
	});

	// ── search() ────────────────────────────────────────────────────

	describe("search", () => {
		it("returns parsed results on HTTP 200", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: `
					<div class="result">
						<div class="result__title"><a href="https://example.com">Result</a></div>
						<div class="result__snippet">Snippet text</div>
					</div>
				`,
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test query", 5, 10000, null);

			expect(result.results).toHaveLength(1);
			expect(result.results[0]).toEqual({
				title: "Result",
				url: "https://example.com",
				snippet: "Snippet text",
			});
			expect(result.rateLimited).toBeUndefined();
		});

		it("sends correct request parameters", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: "",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await provider.search("hello world", 5, 10000, null);

			expect(mockRequestUrl).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://html.duckduckgo.com/html/",
					method: "POST",
					body: "q=hello%20world&kl=us-en",
					throw: false,
				}),
			);
		});

		it("detects rate-limit on HTTP 202", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 202,
				text: "",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test", 5, 10000, null);

			expect(result.rateLimited).toBe(true);
			expect(result.results).toEqual([]);
		});

		it("detects rate-limit on 0 results from non-empty body (selector drift)", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 200,
				text: "<html><body>Some content but no .result containers</body></html>",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			const result = await provider.search("test", 5, 10000, null);

			expect(result.rateLimited).toBe(true);
			expect(result.results).toEqual([]);
			expect(result.warnings).toBeDefined();
			expect(result.warnings![0]).toContain("selector drift");
		});

		it("throws on non-200/202 status", async () => {
			mockRequestUrl.mockResolvedValue({
				status: 403,
				text: "Forbidden",
				headers: {},
				arrayBuffer: new ArrayBuffer(0),
				json: {},
			});

			await expect(
				provider.search("test", 5, 10000, null),
			).rejects.toThrow("HTTP status 403");
		});

		it("propagates network errors", async () => {
			mockRequestUrl.mockRejectedValue(new Error("Network unreachable"));

			await expect(
				provider.search("test", 5, 10000, null),
			).rejects.toThrow("Network unreachable");
		});

		it("rejects on timeout", async () => {
			mockRequestUrl.mockImplementation(
				() =>
					new Promise(() => {
						// never resolves
					}),
			);

			await expect(
				provider.search("test", 5, 50, null),
			).rejects.toThrow("timed out");
		});

		it("rejects when abort signal is already aborted", async () => {
			const controller = new AbortController();
			controller.abort();

			await expect(
				provider.search("test", 5, 10000, null, controller.signal),
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
				null,
				controller.signal,
			);

			// Abort after a tick
			await Promise.resolve();
			controller.abort();

			await expect(searchPromise).rejects.toThrow("aborted");
		});
	});

	// ── isConfigured() ──────────────────────────────────────────────

	describe("isConfigured", () => {
		it("returns true when enabled", () => {
			const config: ProviderConfig = {
				enabled: true,
				delayMs: 1500,
				apiKey: null,
			};
			expect(provider.isConfigured(config)).toBe(true);
		});

		it("returns false when disabled", () => {
			const config: ProviderConfig = {
				enabled: false,
				delayMs: 1500,
				apiKey: null,
			};
			expect(provider.isConfigured(config)).toBe(false);
		});
	});
});
