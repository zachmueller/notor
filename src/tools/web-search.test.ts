/**
 * Unit tests for web-search.ts — URL cleaning, HTML parsing, and domain
 * denylist filtering.
 *
 * All tests use inline strings. No network access required.
 *
 * `parseDDGResults` relies on the browser-native `DOMParser`, which is not
 * available in Node. We polyfill it from jsdom before importing the module
 * under test.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanDDGUrl, parseDDGResults, WebSearchTool } from "./web-search";

// ---------------------------------------------------------------------------
// cleanDDGUrl
// ---------------------------------------------------------------------------

describe("cleanDDGUrl", () => {
	it("decodes a DDG redirect URL", () => {
		const raw =
			"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc";
		expect(cleanDDGUrl(raw)).toBe("https://example.com/page");
	});

	it("handles double-encoded DDG redirect URL correctly", () => {
		// URLSearchParams decodes once → "https%3A%2F%2Fexample.com%2Fpath"
		// decodeURIComponent decodes again → "https://example.com/path"
		const raw =
			"//duckduckgo.com/l/?uddg=https%253A%252F%252Fexample.com%252Fpath";
		expect(cleanDDGUrl(raw)).toBe("https://example.com/path");
	});

	it("handles protocol-relative URLs", () => {
		expect(cleanDDGUrl("//example.com/foo")).toBe("https://example.com/foo");
	});

	it("passes through absolute http URLs unchanged", () => {
		expect(cleanDDGUrl("http://example.com")).toBe("http://example.com");
	});

	it("passes through absolute https URLs unchanged", () => {
		expect(cleanDDGUrl("https://example.com/bar")).toBe(
			"https://example.com/bar"
		);
	});

	it("returns null for relative paths", () => {
		expect(cleanDDGUrl("/some/path")).toBeNull();
	});

	it("returns null for empty strings", () => {
		expect(cleanDDGUrl("")).toBeNull();
	});

	it("returns null for malformed DDG redirect without query string", () => {
		expect(cleanDDGUrl("//duckduckgo.com/l/")).toBeNull();
	});

	it("returns null for DDG redirect without uddg param", () => {
		expect(cleanDDGUrl("//duckduckgo.com/l/?foo=bar")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseDDGResults
// ---------------------------------------------------------------------------

/** Minimal DDG-like HTML with the expected class structure. */
function ddgHtml(
	results: { href: string; title: string; snippet: string }[]
): string {
	const items = results
		.map(
			(r) => `
		<div class="result">
			<h2 class="result__title">
				<a href="${r.href}">${r.title}</a>
			</h2>
			<a class="result__snippet">${r.snippet}</a>
		</div>`
		)
		.join("\n");
	return `<html><body>${items}</body></html>`;
}

describe("parseDDGResults", () => {
	it("parses results with correct titles, URLs, and snippets", () => {
		const html = ddgHtml([
			{
				href: "https://example.com",
				title: "Example",
				snippet: "An example site.",
			},
			{
				href: "//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.org",
				title: "Foo",
				snippet: "Foo description.",
			},
		]);

		const results = parseDDGResults(html, 10);
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual({
			title: "Example",
			url: "https://example.com",
			snippet: "An example site.",
		});
		expect(results[1]).toEqual({
			title: "Foo",
			url: "https://foo.org",
			snippet: "Foo description.",
		});
	});

	it("respects maxResults cap", () => {
		const html = ddgHtml([
			{ href: "https://a.com", title: "A", snippet: "a" },
			{ href: "https://b.com", title: "B", snippet: "b" },
			{ href: "https://c.com", title: "C", snippet: "c" },
		]);

		const results = parseDDGResults(html, 2);
		expect(results).toHaveLength(2);
		expect(results[0]!.title).toBe("A");
		expect(results[1]!.title).toBe("B");
	});

	it("skips results with missing title", () => {
		const html = `<html><body>
			<div class="result">
				<h2 class="result__title"><a href="https://a.com"></a></h2>
				<a class="result__snippet">snippet</a>
			</div>
			<div class="result">
				<h2 class="result__title"><a href="https://b.com">Valid</a></h2>
				<a class="result__snippet">good</a>
			</div>
		</body></html>`;

		const results = parseDDGResults(html, 10);
		expect(results).toHaveLength(1);
		expect(results[0]!.title).toBe("Valid");
	});

	it("skips results with missing URL", () => {
		const html = `<html><body>
			<div class="result">
				<h2 class="result__title"><a>No Href</a></h2>
				<a class="result__snippet">snippet</a>
			</div>
		</body></html>`;

		const results = parseDDGResults(html, 10);
		expect(results).toHaveLength(0);
	});

	it("skips results with unrecognised URL format", () => {
		const html = ddgHtml([
			{ href: "/relative/path", title: "Relative", snippet: "bad" },
		]);

		const results = parseDDGResults(html, 10);
		expect(results).toHaveLength(0);
	});

	it("returns empty array for empty HTML", () => {
		expect(parseDDGResults("", 10)).toEqual([]);
	});

	it("returns empty array for HTML with no .result containers", () => {
		expect(
			parseDDGResults("<html><body><p>Hello</p></body></html>", 10)
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Domain denylist filtering in execute()
// ---------------------------------------------------------------------------

// `obsidian` is resolved to src/__mocks__/obsidian.ts via vitest alias.
// Import the mock so we can control requestUrl in tests.
import { requestUrl } from "obsidian";
const mockRequestUrl = vi.mocked(requestUrl);

// Mock the logger — use shared mock functions so tests can assert on log calls.
// vi.hoisted ensures the variable is declared before the hoisted vi.mock factory runs.
const mockLog = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));
vi.mock("../utils/logger", () => ({
	logger: () => mockLog,
}));

function fakeSettings(overrides: Record<string, unknown> = {}) {
	return {
		web_search_timeout: 10,
		web_search_default_num_results: 5,
		domain_denylist: [] as string[],
		...overrides,
	} as any;
}

describe("WebSearchTool.execute — domain denylist filtering", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("excludes results from blocked domains", async () => {
		const html = ddgHtml([
			{
				href: "https://blocked.com/page",
				title: "Blocked",
				snippet: "bad",
			},
			{
				href: "https://allowed.com/page",
				title: "Allowed",
				snippet: "good",
			},
		]);
		mockRequestUrl.mockResolvedValue({ status: 200, text: html } as any);

		const tool = new WebSearchTool(
			{} as any,
			fakeSettings({ domain_denylist: ["blocked.com"] })
		);
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(true);
		expect(result.result).toContain("Allowed");
		expect(result.result).not.toContain("Blocked");
	});

	it("passes through results from allowed domains", async () => {
		const html = ddgHtml([
			{ href: "https://good.com", title: "Good", snippet: "yes" },
		]);
		mockRequestUrl.mockResolvedValue({ status: 200, text: html } as any);

		const tool = new WebSearchTool(
			{} as any,
			fakeSettings({ domain_denylist: ["other.com"] })
		);
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(true);
		expect(result.result).toContain("Good");
	});

	it("wildcard denylist patterns block subdomains", async () => {
		const html = ddgHtml([
			{
				href: "https://sub.blocked.com/page",
				title: "Sub",
				snippet: "sub",
			},
			{
				href: "https://allowed.com/page",
				title: "OK",
				snippet: "ok",
			},
		]);
		mockRequestUrl.mockResolvedValue({ status: 200, text: html } as any);

		const tool = new WebSearchTool(
			{} as any,
			fakeSettings({ domain_denylist: ["*.blocked.com"] })
		);
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(true);
		expect(result.result).not.toContain("Sub");
		expect(result.result).toContain("OK");
	});

	it("returns 'no results' when all results are filtered", async () => {
		const html = ddgHtml([
			{ href: "https://blocked.com/a", title: "A", snippet: "a" },
		]);
		mockRequestUrl.mockResolvedValue({ status: 200, text: html } as any);

		const tool = new WebSearchTool(
			{} as any,
			fakeSettings({ domain_denylist: ["blocked.com"] })
		);
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(true);
		expect(result.result).toContain("No results found for query: test");
	});

	it("works when domain_denylist is empty", async () => {
		const html = ddgHtml([
			{ href: "https://example.com", title: "Ex", snippet: "s" },
		]);
		mockRequestUrl.mockResolvedValue({ status: 200, text: html } as any);

		const tool = new WebSearchTool(
			{} as any,
			fakeSettings({ domain_denylist: [] })
		);
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(true);
		expect(result.result).toContain("Ex");
	});
});

// ---------------------------------------------------------------------------
// Edge case handling (Phase 6)
// ---------------------------------------------------------------------------

describe("WebSearchTool.execute — edge cases", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("logs a warning when DDG returns non-empty body but 0 results are parsed (selector drift)", async () => {
		// Non-empty HTML with no .result containers → 0 parsed results
		mockRequestUrl.mockResolvedValue({
			status: 200,
			text: "<html><body><p>Some content but no results</p></body></html>",
		} as any);

		const tool = new WebSearchTool({} as any, fakeSettings());
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(true);
		expect(result.result).toContain("No results found");
		expect(mockLog.warn).toHaveBeenCalledWith(
			expect.stringContaining("0 results were parsed"),
			expect.objectContaining({ query: "test" })
		);
	});

	it("does not log selector drift warning when response is empty", async () => {
		mockRequestUrl.mockResolvedValue({
			status: 200,
			text: "",
		} as any);

		const tool = new WebSearchTool({} as any, fakeSettings());
		await tool.execute({ query: "test" });

		// The warn call for selector drift should NOT fire for empty responses
		expect(mockLog.warn).not.toHaveBeenCalledWith(
			expect.stringContaining("0 results were parsed"),
			expect.anything()
		);
	});

	it("handles network errors gracefully (no stack trace)", async () => {
		mockRequestUrl.mockRejectedValue(new Error("getaddrinfo ENOTFOUND html.duckduckgo.com"));

		const tool = new WebSearchTool({} as any, fakeSettings());
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(false);
		expect(result.error).toContain("getaddrinfo ENOTFOUND");
		expect(result.error).not.toContain("at "); // No stack trace leaked
	});

	it("handles non-Error thrown values gracefully", async () => {
		mockRequestUrl.mockRejectedValue("connection refused");

		const tool = new WebSearchTool({} as any, fakeSettings());
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(false);
		expect(result.error).toContain("Unknown network error");
	});

	it("handles timeout errors gracefully", async () => {
		// Simulate a request that never resolves, so the timeout fires
		mockRequestUrl.mockImplementation(
			() => new Promise(() => {}) as any // never resolves
		);

		const tool = new WebSearchTool(
			{} as any,
			fakeSettings({ web_search_timeout: 0.01 }) // 10ms timeout
		);
		const result = await tool.execute({ query: "test" });

		expect(result.success).toBe(false);
		expect(result.error).toContain("timed out");
	});
});
