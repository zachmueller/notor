/**
 * Unit tests for docx-comment-parser.ts — pure XML parsing functions.
 *
 * All tests use inline XML strings. No .docx fixture files needed.
 */

import { describe, it, expect } from "vitest";
import {
	parseCommentsXml,
	parseCommentsExtendedXml,
	extractQuotedText,
	parsePeopleXml,
	resolveAtMentions,
	computeUniqueId,
	buildCommentThreads,
	formatCommentsAsMarkdown,
	extractExistingCommentIds,
} from "./docx-comment-parser";

// ---------------------------------------------------------------------------
// Helpers — reusable XML fragments
// ---------------------------------------------------------------------------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";

function commentsXml(inner: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="${W_NS}" xmlns:w14="${W14_NS}">
${inner}
</w:comments>`;
}

function commentsExtXml(inner: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<w15:commentsEx xmlns:w15="${W15_NS}">
${inner}
</w15:commentsEx>`;
}

function documentXml(bodyInner: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${W_NS}">
<w:body>
${bodyInner}
</w:body>
</w:document>`;
}

function peopleXml(inner: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<w15:people xmlns:w15="${W15_NS}">
${inner}
</w15:people>`;
}

// ---------------------------------------------------------------------------
// parseCommentsXml
// ---------------------------------------------------------------------------

describe("parseCommentsXml", () => {
	it("extracts a single comment with all fields", () => {
		const xml = commentsXml(`
			<w:comment w:id="1" w:author="Jane Doe" w:date="2025-07-15T14:23:15Z">
				<w:p w14:paraId="ABC123">
					<w:r><w:t>Great point here</w:t></w:r>
				</w:p>
			</w:comment>
		`);
		const result = parseCommentsXml(xml);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			commentId: "1",
			author: "Jane Doe",
			date: "2025-07-15T14:23:15Z",
			paraId: "ABC123",
			text: "Great point here",
			quotedText: "",
		});
	});

	it("extracts multiple comments in document order", () => {
		const xml = commentsXml(`
			<w:comment w:id="1" w:author="Alice" w:date="2025-01-01T00:00:00Z">
				<w:p w14:paraId="A1"><w:r><w:t>First</w:t></w:r></w:p>
			</w:comment>
			<w:comment w:id="2" w:author="Bob" w:date="2025-01-02T00:00:00Z">
				<w:p w14:paraId="B2"><w:r><w:t>Second</w:t></w:r></w:p>
			</w:comment>
		`);
		const result = parseCommentsXml(xml);
		expect(result).toHaveLength(2);
		expect(result[0]!.commentId).toBe("1");
		expect(result[1]!.commentId).toBe("2");
	});

	it("concatenates text across multiple paragraphs with spaces", () => {
		const xml = commentsXml(`
			<w:comment w:id="1" w:author="Jane" w:date="2025-01-01T00:00:00Z">
				<w:p w14:paraId="P1"><w:r><w:t>First paragraph</w:t></w:r></w:p>
				<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p>
			</w:comment>
		`);
		const result = parseCommentsXml(xml);
		expect(result[0]!.text).toBe("First paragraph Second paragraph");
	});

	it("returns empty string for comment with no text", () => {
		const xml = commentsXml(`
			<w:comment w:id="1" w:author="Jane" w:date="2025-01-01T00:00:00Z">
				<w:p w14:paraId="P1"></w:p>
			</w:comment>
		`);
		const result = parseCommentsXml(xml);
		expect(result[0]!.text).toBe("");
	});

	it("returns null paraId when w14:paraId attribute is missing", () => {
		const xml = commentsXml(`
			<w:comment w:id="1" w:author="Jane" w:date="2025-01-01T00:00:00Z">
				<w:p><w:r><w:t>No para ID</w:t></w:r></w:p>
			</w:comment>
		`);
		const result = parseCommentsXml(xml);
		expect(result[0]!.paraId).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseCommentsExtendedXml
// ---------------------------------------------------------------------------

describe("parseCommentsExtendedXml", () => {
	it("detects resolved comment (done=1)", () => {
		const xml = commentsExtXml(
			`<w15:commentEx w15:paraId="ABC123" w15:done="1"/>`
		);
		const { resolvedIds, threadingMap } = parseCommentsExtendedXml(xml);
		expect(resolvedIds.has("ABC123")).toBe(true);
		expect(threadingMap.size).toBe(0);
	});

	it("detects reply threading (paraIdParent)", () => {
		const xml = commentsExtXml(
			`<w15:commentEx w15:paraId="CHILD1" w15:paraIdParent="PARENT1"/>`
		);
		const { resolvedIds, threadingMap } = parseCommentsExtendedXml(xml);
		expect(resolvedIds.size).toBe(0);
		expect(threadingMap.get("CHILD1")).toBe("PARENT1");
	});

	it("handles element with both done and parent", () => {
		const xml = commentsExtXml(
			`<w15:commentEx w15:paraId="X1" w15:done="1" w15:paraIdParent="P1"/>`
		);
		const { resolvedIds, threadingMap } = parseCommentsExtendedXml(xml);
		expect(resolvedIds.has("X1")).toBe(true);
		expect(threadingMap.get("X1")).toBe("P1");
	});

	it("returns empty collections for null/empty input", () => {
		const { resolvedIds, threadingMap } = parseCommentsExtendedXml("");
		expect(resolvedIds.size).toBe(0);
		expect(threadingMap.size).toBe(0);
	});

	it("ignores elements with neither done nor parent", () => {
		const xml = commentsExtXml(
			`<w15:commentEx w15:paraId="X1"/>`
		);
		const { resolvedIds, threadingMap } = parseCommentsExtendedXml(xml);
		expect(resolvedIds.size).toBe(0);
		expect(threadingMap.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// extractQuotedText
// ---------------------------------------------------------------------------

describe("extractQuotedText", () => {
	it("extracts text between commentRangeStart and commentRangeEnd", () => {
		const xml = documentXml(`
			<w:p>
				<w:commentRangeStart w:id="1"/>
				<w:r><w:t>Hello world</w:t></w:r>
				<w:commentRangeEnd w:id="1"/>
			</w:p>
		`);
		expect(extractQuotedText(xml, "1")).toBe("Hello world");
	});

	it("concatenates text across multiple runs", () => {
		const xml = documentXml(`
			<w:p>
				<w:commentRangeStart w:id="1"/>
				<w:r><w:t>Hello </w:t></w:r>
				<w:r><w:t>world</w:t></w:r>
				<w:commentRangeEnd w:id="1"/>
			</w:p>
		`);
		expect(extractQuotedText(xml, "1")).toBe("Hello world");
	});

	it("returns [Quote unavailable] when no matching range found", () => {
		const xml = documentXml(`
			<w:p><w:r><w:t>Just text</w:t></w:r></w:p>
		`);
		expect(extractQuotedText(xml, "99")).toBe("[Quote unavailable]");
	});

	it("handles nested elements between markers", () => {
		const xml = documentXml(`
			<w:p>
				<w:commentRangeStart w:id="2"/>
				<w:r><w:rPr><w:b/></w:rPr><w:t>Bold text</w:t></w:r>
				<w:commentRangeEnd w:id="2"/>
			</w:p>
		`);
		expect(extractQuotedText(xml, "2")).toBe("Bold text");
	});
});

// ---------------------------------------------------------------------------
// parsePeopleXml
// ---------------------------------------------------------------------------

describe("parsePeopleXml", () => {
	it("maps a single person to their userId", () => {
		const xml = peopleXml(`
			<w15:person w15:author="Jane Doe">
				<w15:presenceInfo w15:providerId="AD" w15:userId="jane.doe@example.com"/>
			</w15:person>
		`);
		const map = parsePeopleXml(xml);
		expect(map.get("Jane Doe")).toBe("jane.doe@example.com");
	});

	it("maps multiple people", () => {
		const xml = peopleXml(`
			<w15:person w15:author="Alice">
				<w15:presenceInfo w15:providerId="AD" w15:userId="alice@co.com"/>
			</w15:person>
			<w15:person w15:author="Bob">
				<w15:presenceInfo w15:providerId="AD" w15:userId="bob@co.com"/>
			</w15:person>
		`);
		const map = parsePeopleXml(xml);
		expect(map.size).toBe(2);
		expect(map.get("Alice")).toBe("alice@co.com");
		expect(map.get("Bob")).toBe("bob@co.com");
	});

	it("returns empty map for null/empty input", () => {
		expect(parsePeopleXml("").size).toBe(0);
	});

	it("skips person without presenceInfo", () => {
		const xml = peopleXml(`
			<w15:person w15:author="Jane Doe"/>
		`);
		const map = parsePeopleXml(xml);
		expect(map.size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// resolveAtMentions
// ---------------------------------------------------------------------------

describe("resolveAtMentions", () => {
	const peopleMap = new Map([
		["Jane Doe", "jane.doe@example.com"],
		["Bob", "bob@co.com"],
	]);

	it("replaces matching @mention with alias", () => {
		expect(resolveAtMentions("Please see @Jane Doe for details", peopleMap))
			.toBe("Please see @Jane Doe (jane.doe@example.com) for details");
	});

	it("leaves text unchanged when no @mentions", () => {
		expect(resolveAtMentions("No mentions here", peopleMap))
			.toBe("No mentions here");
	});

	it("returns text unchanged with empty peopleMap", () => {
		expect(resolveAtMentions("@Jane Doe hello", new Map()))
			.toBe("@Jane Doe hello");
	});

	it("leaves unknown @mentions unchanged", () => {
		expect(resolveAtMentions("Ask @Unknown Person about it", peopleMap))
			.toBe("Ask @Unknown Person about it");
	});
});

// ---------------------------------------------------------------------------
// computeUniqueId
// ---------------------------------------------------------------------------

describe("computeUniqueId", () => {
	it("is deterministic", () => {
		const id1 = computeUniqueId("Jane", "2025-01-01", "text");
		const id2 = computeUniqueId("Jane", "2025-01-01", "text");
		expect(id1).toBe(id2);
	});

	it("produces different IDs for different inputs", () => {
		const id1 = computeUniqueId("Jane", "2025-01-01", "text1");
		const id2 = computeUniqueId("Jane", "2025-01-01", "text2");
		expect(id1).not.toBe(id2);
	});

	it("returns exactly 12 hex characters", () => {
		const id = computeUniqueId("Author", "2025-01-01", "Comment");
		expect(id).toMatch(/^[0-9a-f]{12}$/);
	});
});

// ---------------------------------------------------------------------------
// buildCommentThreads
// ---------------------------------------------------------------------------

describe("buildCommentThreads", () => {
	it("builds a single top-level comment with no replies", () => {
		const raw = [
			{
				commentId: "1",
				paraId: "P1",
				author: "Jane",
				date: "2025-07-15T14:23:15Z",
				text: "Good point",
				quotedText: "some text",
			},
		];
		const result = buildCommentThreads(
			raw,
			new Map(),
			new Set(),
			false,
			new Map()
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.replies).toHaveLength(0);
		expect(result[0]!.text).toBe("Good point");
		expect(result[0]!.date).toBe("2025-07-15 14:23:15");
	});

	it("nests replies under parent and sorts by date", () => {
		const raw = [
			{
				commentId: "1",
				paraId: "P1",
				author: "Jane",
				date: "2025-07-15T10:00:00Z",
				text: "Parent comment",
				quotedText: "text",
			},
			{
				commentId: "2",
				paraId: "C2",
				author: "Bob",
				date: "2025-07-15T12:00:00Z",
				text: "Later reply",
				quotedText: "",
			},
			{
				commentId: "3",
				paraId: "C1",
				author: "Alice",
				date: "2025-07-15T11:00:00Z",
				text: "Earlier reply",
				quotedText: "",
			},
		];
		const threadingMap = new Map([
			["C1", "P1"],
			["C2", "P1"],
		]);
		const result = buildCommentThreads(
			raw,
			threadingMap,
			new Set(),
			false,
			new Map()
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.replies).toHaveLength(2);
		expect(result[0]!.replies[0]!.author).toBe("Alice"); // earlier
		expect(result[0]!.replies[1]!.author).toBe("Bob"); // later
	});

	it("filters resolved comments when includeResolved=false", () => {
		const raw = [
			{
				commentId: "1",
				paraId: "P1",
				author: "Jane",
				date: "2025-01-01T00:00:00Z",
				text: "Resolved",
				quotedText: "text",
			},
		];
		const resolvedIds = new Set(["P1"]);
		const result = buildCommentThreads(
			raw,
			new Map(),
			resolvedIds,
			false,
			new Map()
		);
		expect(result).toHaveLength(0);
	});

	it("includes resolved comments when includeResolved=true", () => {
		const raw = [
			{
				commentId: "1",
				paraId: "P1",
				author: "Jane",
				date: "2025-01-01T00:00:00Z",
				text: "Resolved",
				quotedText: "text",
			},
		];
		const resolvedIds = new Set(["P1"]);
		const result = buildCommentThreads(
			raw,
			new Map(),
			resolvedIds,
			true,
			new Map()
		);
		expect(result).toHaveLength(1);
	});

	it("filters replies whose parent is filtered out", () => {
		const raw = [
			{
				commentId: "1",
				paraId: "P1",
				author: "Jane",
				date: "2025-01-01T00:00:00Z",
				text: "Resolved parent",
				quotedText: "text",
			},
			{
				commentId: "2",
				paraId: "C1",
				author: "Bob",
				date: "2025-01-02T00:00:00Z",
				text: "Reply to resolved",
				quotedText: "",
			},
		];
		const threadingMap = new Map([["C1", "P1"]]);
		const resolvedIds = new Set(["P1"]);
		const result = buildCommentThreads(
			raw,
			threadingMap,
			resolvedIds,
			false,
			new Map()
		);
		expect(result).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// formatCommentsAsMarkdown
// ---------------------------------------------------------------------------

describe("formatCommentsAsMarkdown", () => {
	const sampleComment = {
		commentId: "1",
		paraId: "P1",
		author: "Jane Doe",
		date: "2025-07-15 14:23:15",
		text: "Good point",
		quotedText: "some quoted text",
		replies: [],
		uniqueId: "abc123def456",
	};

	it("formats a single comment with header", () => {
		const md = formatCommentsAsMarkdown([sampleComment], "test.docx", 1);
		expect(md).toContain("# Comment Extraction: test.docx");
		expect(md).toContain("### Comment 1");
		expect(md).toContain("**IDs**: `abc123def456` (xml:`1`, para:`P1`)");
		expect(md).toContain("**Reviewer**: Jane Doe");
		expect(md).toContain("**Timestamp**: 2025-07-15 14:23:15");
		expect(md).toContain('**Quote**: "some quoted text"');
		expect(md).toContain("**Comment**: Good point");
	});

	it("separates multiple comments with ---", () => {
		const c2 = { ...sampleComment, commentId: "2", uniqueId: "xyz789abc012" };
		const md = formatCommentsAsMarkdown([sampleComment, c2], "test.docx", 1);
		expect(md).toContain("### Comment 1");
		expect(md).toContain("---");
		expect(md).toContain("### Comment 2");
	});

	it("includes reply lines", () => {
		const withReply = {
			...sampleComment,
			replies: [
				{ author: "Bob", date: "2025-07-15 15:00:00", text: "I agree" },
			],
		};
		const md = formatCommentsAsMarkdown([withReply], "test.docx", 1);
		expect(md).toContain("**Reply** (Bob, 2025-07-15 15:00:00): I agree");
	});

	it("omits header when startNumber > 1", () => {
		const md = formatCommentsAsMarkdown([sampleComment], "test.docx", 5);
		expect(md).not.toContain("# Comment Extraction");
		expect(md).toContain("### Comment 5");
		// Should start with --- separator when appending
		expect(md).toMatch(/^---/);
	});
});

// ---------------------------------------------------------------------------
// extractExistingCommentIds
// ---------------------------------------------------------------------------

describe("extractExistingCommentIds", () => {
	it("extracts IDs from existing note content", () => {
		const content = [
			"### Comment 1",
			"**IDs**: `abc123def456` (xml:`1`, para:`P1`)",
			"### Comment 2",
			"**IDs**: `xyz789abc012` (xml:`2`, para:`P2`)",
		].join("\n");
		const { ids, maxNumber } = extractExistingCommentIds(content);
		expect(ids.has("abc123def456")).toBe(true);
		expect(ids.has("xyz789abc012")).toBe(true);
		expect(maxNumber).toBe(2);
	});

	it("returns empty set and 0 for empty content", () => {
		const { ids, maxNumber } = extractExistingCommentIds("");
		expect(ids.size).toBe(0);
		expect(maxNumber).toBe(0);
	});

	it("returns empty set when no matching patterns", () => {
		const { ids, maxNumber } = extractExistingCommentIds(
			"Just some text\nNo comments here"
		);
		expect(ids.size).toBe(0);
		expect(maxNumber).toBe(0);
	});
});
