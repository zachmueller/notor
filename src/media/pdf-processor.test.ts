import { describe, it, expect, vi, beforeEach } from "vitest";
import { parsePageRange, processPdf } from "./pdf-processor";

// ---------------------------------------------------------------------------
// parsePageRange — pure function, no mocks needed
// ---------------------------------------------------------------------------

describe("parsePageRange", () => {
	it("parses a single page number", () => {
		expect(parsePageRange("3")).toEqual({ start: 3, end: 3 });
	});

	it("parses a page range", () => {
		expect(parsePageRange("1-5")).toEqual({ start: 1, end: 5 });
	});

	it("parses a single page range (same start/end)", () => {
		expect(parsePageRange("7-7")).toEqual({ start: 7, end: 7 });
	});

	it("trims whitespace", () => {
		expect(parsePageRange("  2-10  ")).toEqual({ start: 2, end: 10 });
	});

	it("rejects comma-separated ranges", () => {
		const result = parsePageRange("1-3,7-9");
		expect(typeof result).toBe("string");
		expect(result).toContain("Comma-separated");
	});

	it("rejects single comma-separated pages", () => {
		const result = parsePageRange("1,3,5");
		expect(typeof result).toBe("string");
		expect(result).toContain("Comma-separated");
	});

	it("rejects invalid page number", () => {
		const result = parsePageRange("abc");
		expect(typeof result).toBe("string");
		expect(result).toContain("Invalid page number");
	});

	it("rejects zero page number", () => {
		const result = parsePageRange("0");
		expect(typeof result).toBe("string");
		expect(result).toContain("Invalid page number");
	});

	it("rejects negative page number", () => {
		const result = parsePageRange("-1");
		expect(typeof result).toBe("string");
	});

	it("rejects range with start > end", () => {
		const result = parsePageRange("10-5");
		expect(typeof result).toBe("string");
		expect(result).toContain("greater than end");
	});

	it("rejects range with non-numeric parts", () => {
		const result = parsePageRange("a-b");
		expect(typeof result).toBe("string");
		expect(result).toContain("Invalid page numbers");
	});

	it("rejects range with zero start", () => {
		const result = parsePageRange("0-5");
		expect(typeof result).toBe("string");
		expect(result).toContain("Invalid page numbers");
	});
});

// ---------------------------------------------------------------------------
// processPdf — requires mocking unpdf
// ---------------------------------------------------------------------------

// Mock unpdf module
const mockGetDocumentProxy = vi.fn();

vi.mock("unpdf", () => ({
	getDocumentProxy: (...args: unknown[]) => mockGetDocumentProxy(...args),
}));

// Helper to create a mock PDF proxy
function createMockPdfProxy(numPages: number, pageTexts?: string[]) {
	return {
		numPages,
		getPage: vi.fn(async (pageNum: number) => ({
			getTextContent: vi.fn(async () => ({
				items: (pageTexts?.[pageNum - 1] ?? `Page ${pageNum} text content.`)
					.split("\n")
					.map((line) => ({ str: line, hasEOL: true })),
			})),
		})),
		cleanup: vi.fn(async () => {}),
	};
}

describe("processPdf", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("text extraction path", () => {
		it("extracts text from a PDF for a non-native provider", async () => {
			const mockProxy = createMockPdfProxy(3, [
				"Page one content.",
				"Page two content.",
				"Page three content.",
			]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 mock data");
			const result = await processPdf(buffer, {
				providerId: "openai",
			});

			expect(result.contentBlocks).toHaveLength(1);
			expect(result.contentBlocks[0]!.type).toBe("text");
			if (result.contentBlocks[0]!.type === "text") {
				expect(result.contentBlocks[0]!.text).toContain("Page one content.");
				expect(result.contentBlocks[0]!.text).toContain("Page two content.");
				expect(result.contentBlocks[0]!.text).toContain("Page three content.");
			}
			expect(result.textSummary).toContain("3 pages");
		});

		it("extracts specific page range", async () => {
			const mockProxy = createMockPdfProxy(10, [
				"P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10",
			]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 mock data");
			const result = await processPdf(buffer, {
				pages: "2-4",
				providerId: "anthropic", // native provider, but page range forces text extraction
			});

			expect(result.contentBlocks).toHaveLength(1);
			expect(result.contentBlocks[0]!.type).toBe("text");
			if (result.contentBlocks[0]!.type === "text") {
				expect(result.contentBlocks[0]!.text).toContain("P2");
				expect(result.contentBlocks[0]!.text).toContain("P3");
				expect(result.contentBlocks[0]!.text).toContain("P4");
				expect(result.contentBlocks[0]!.text).not.toContain("P1\n");
				expect(result.contentBlocks[0]!.text).not.toContain("P5");
			}
			expect(result.textSummary).toContain("pages 2-4 of 10");
		});

		it("clamps page range to actual page count", async () => {
			const mockProxy = createMockPdfProxy(3, ["P1", "P2", "P3"]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 mock data");
			const result = await processPdf(buffer, {
				pages: "1-100",
				providerId: "openai",
			});

			expect(result.contentBlocks).toHaveLength(1);
			expect(result.contentBlocks[0]!.type).toBe("text");
			if (result.contentBlocks[0]!.type === "text") {
				expect(result.contentBlocks[0]!.text).toContain("P1");
				expect(result.contentBlocks[0]!.text).toContain("P3");
			}
		});

		it("truncates text at maxTextChars limit", async () => {
			const longText = "A".repeat(1000);
			const mockProxy = createMockPdfProxy(5, [
				longText, longText, longText, longText, longText,
			]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 mock data");
			const result = await processPdf(buffer, {
				providerId: "openai",
				maxTextChars: 2000,
			});

			expect(result.contentBlocks).toHaveLength(1);
			if (result.contentBlocks[0]!.type === "text") {
				expect(result.contentBlocks[0]!.text.length).toBeLessThanOrEqual(2100); // 2000 + truncation message
				expect(result.contentBlocks[0]!.text).toContain("[Text truncated");
			}
		});

		it("handles empty text (image-only PDF)", async () => {
			const mockProxy = createMockPdfProxy(2, ["", ""]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 mock data");
			const result = await processPdf(buffer, {
				providerId: "openai",
			});

			expect(result.contentBlocks).toHaveLength(1);
			if (result.contentBlocks[0]!.type === "text") {
				expect(result.contentBlocks[0]!.text).toContain("no extractable text");
			}
			expect(result.textSummary).toContain("no extractable text");
		});

		it("forces text extraction when preferNative is false", async () => {
			const mockProxy = createMockPdfProxy(2, ["Page 1", "Page 2"]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 mock data");
			const result = await processPdf(buffer, {
				providerId: "anthropic", // native-capable provider
				preferNative: false,
			});

			expect(result.contentBlocks).toHaveLength(1);
			expect(result.contentBlocks[0]!.type).toBe("text");
		});
	});

	describe("native document block path", () => {
		it("returns native document block for Anthropic provider", async () => {
			const mockProxy = createMockPdfProxy(5);
			// First call for page count in native path
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 small test content");
			const result = await processPdf(buffer, {
				providerId: "anthropic",
			});

			expect(result.contentBlocks).toHaveLength(1);
			expect(result.contentBlocks[0]!.type).toBe("document");
			if (result.contentBlocks[0]!.type === "document") {
				expect(result.contentBlocks[0]!.media_type).toBe("application/pdf");
				expect(result.contentBlocks[0]!.data).toBe(buffer.toString("base64"));
				expect(result.contentBlocks[0]!.page_count).toBe(5);
			}
			expect(result.textSummary).toContain("5 pages");
		});

		it("returns native document block for Bedrock provider", async () => {
			const mockProxy = createMockPdfProxy(3);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 bedrock test");
			const result = await processPdf(buffer, {
				providerId: "bedrock",
			});

			expect(result.contentBlocks).toHaveLength(1);
			expect(result.contentBlocks[0]!.type).toBe("document");
		});

		it("throws when PDF exceeds native size limit", async () => {
			// Create a buffer that would exceed Bedrock's 4.5MB limit when base64-encoded
			const largeBuffer = Buffer.alloc(4 * 1024 * 1024); // 4MB raw → ~5.3MB base64
			largeBuffer.write("%PDF-1.4");

			await expect(
				processPdf(largeBuffer, { providerId: "bedrock" }),
			).rejects.toThrow("too large for native document block");
		});

		it("uses text extraction for non-native providers", async () => {
			const mockProxy = createMockPdfProxy(2, ["Hello", "World"]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 openai test");
			const result = await processPdf(buffer, {
				providerId: "openai",
			});

			expect(result.contentBlocks[0]!.type).toBe("text");
		});

		it("uses text extraction for local provider", async () => {
			const mockProxy = createMockPdfProxy(1, ["Local text"]);
			mockGetDocumentProxy.mockResolvedValue(mockProxy);

			const buffer = Buffer.from("%PDF-1.4 local test");
			const result = await processPdf(buffer, {
				providerId: "local",
			});

			expect(result.contentBlocks[0]!.type).toBe("text");
		});
	});

	describe("error handling", () => {
		it("throws on invalid page range", async () => {
			const buffer = Buffer.from("%PDF-1.4 test");
			await expect(
				processPdf(buffer, { pages: "1-3,5-7", providerId: "openai" }),
			).rejects.toThrow("Comma-separated");
		});

		it("throws when unpdf fails to parse", async () => {
			mockGetDocumentProxy.mockRejectedValue(new Error("Invalid PDF structure"));

			const buffer = Buffer.from("not a pdf");
			await expect(
				processPdf(buffer, { providerId: "openai" }),
			).rejects.toThrow("Invalid PDF structure");
		});
	});
});
