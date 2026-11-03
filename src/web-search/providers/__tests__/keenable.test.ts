import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { KeenableSearchProvider } from "../keenable";

const mockRequestUrl = vi.mocked(requestUrl);

function respond(status: number, body: unknown) {
	mockRequestUrl.mockResolvedValue({
		status,
		text: typeof body === "string" ? body : JSON.stringify(body),
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json: {},
	});
}

describe("KeenableSearchProvider", () => {
	let provider: KeenableSearchProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new KeenableSearchProvider();
	});

	it("has correct metadata", () => {
		expect(provider.meta).toEqual({
			type: "keenable",
			displayName: "Keenable",
			requiresApiKey: true,
			defaultDelayMs: 0,
		});
	});

	it("POSTs the query with X-API-Key and max_results", async () => {
		respond(200, { results: [] });
		await provider.search("hello world", 3, 10000, "my-key");

		const call = mockRequestUrl.mock.calls[0][0] as any;
		expect(call.url).toBe("https://api.keenable.ai/v1/search");
		expect(call.method).toBe("POST");
		expect(call.headers["X-API-Key"]).toBe("my-key");
		expect(call.throw).toBe(false);
		expect(JSON.parse(call.body)).toEqual({ query: "hello world", max_results: 3 });
	});

	it("prefers description, falls back to a truncated snippet, drops results without url", async () => {
		respond(200, {
			results: [
				{ title: "A", url: "https://a.example", description: "desc", snippet: "s" },
				{ title: "B", url: "https://b.example", snippet: "x".repeat(900) },
				{ title: "C", description: "no url" },
			],
		});
		const result = await provider.search("q", 5, 10000, "key");
		expect(result.results).toEqual([
			{ title: "A", url: "https://a.example", snippet: "desc" },
			{ title: "B", url: "https://b.example", snippet: "x".repeat(500) },
		]);
	});

	it("detects rate-limit on HTTP 429 and throws on other errors", async () => {
		respond(429, "Too Many Requests");
		expect(await provider.search("q", 5, 10000, "key")).toEqual({ results: [], rateLimited: true });
		respond(401, "Unauthorized");
		await expect(provider.search("q", 5, 10000, "key")).rejects.toThrow(/401/);
	});

	it("isConfigured requires enabled and an API key", () => {
		expect(provider.isConfigured({ enabled: true, delayMs: 0, apiKey: "k" })).toBe(true);
		expect(provider.isConfigured({ enabled: false, delayMs: 0, apiKey: "k" })).toBe(false);
		expect(provider.isConfigured({ enabled: true, delayMs: 0, apiKey: null })).toBe(false);
	});
});
