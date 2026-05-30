/**
 * Pure parsing functions for extracting comments from `.docx` XML files.
 *
 * No Obsidian APIs, no `fs`, no side effects — enables comprehensive unit
 * testing without any runtime dependencies beyond `@xmldom/xmldom` and
 * Node.js `crypto`.
 *
 * @see private/extract_docx_comments-plan.md — requirements
 * @see private/extract_docx_comments-impl-plan.md — implementation plan
 */

import { DOMParser } from "@xmldom/xmldom";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// OOXML namespace constants
// ---------------------------------------------------------------------------

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface RawComment {
	commentId: string;
	paraId: string | null;
	author: string;
	date: string;
	text: string;
	quotedText: string;
}

export interface Comment {
	commentId: string;
	paraId: string;
	author: string;
	date: string;
	text: string;
	quotedText: string;
	replies: Array<{ author: string; date: string; text: string }>;
	uniqueId: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Depth-first tree walk. Return `true` from callback to stop early. */
function walkNodes(node: Node, callback: (n: Node) => boolean | void): boolean {
	if (callback(node)) return true;
	const children = node.childNodes;
	if (children) {
		for (let i = 0; i < children.length; i++) {
			if (walkNodes(children[i]!, callback)) return true;
		}
	}
	return false;
}

/** Collect text from a comment, joining paragraphs with spaces. */
function collectCommentText(element: Element): string {
	const paragraphs = element.getElementsByTagNameNS(W_NS, "p");
	const paraTexts: string[] = [];
	for (let i = 0; i < paragraphs.length; i++) {
		const p = paragraphs[i]!;
		const runs = p.getElementsByTagNameNS(W_NS, "t");
		const runTexts: string[] = [];
		for (let j = 0; j < runs.length; j++) {
			runTexts.push(runs[j]!.textContent ?? "");
		}
		const paraText = runTexts.join("");
		if (paraText) paraTexts.push(paraText);
	}
	return paraTexts.join(" ");
}

/** Format ISO date string to "YYYY-MM-DD HH:MM:SS". */
function formatDate(isoDate: string): string {
	const d = new Date(isoDate);
	if (isNaN(d.getTime())) return isoDate;
	const pad = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
		`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
	);
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Parse `word/comments.xml` into raw comment objects.
 */
export function parseCommentsXml(xml: string): RawComment[] {
	const doc = new DOMParser().parseFromString(xml, "text/xml");
	const comments = doc.getElementsByTagNameNS(W_NS, "comment");
	const result: RawComment[] = [];

	for (let i = 0; i < comments.length; i++) {
		const el = comments[i]!;
		const commentId = el.getAttribute("w:id") ?? "";
		const author = el.getAttribute("w:author") ?? "";
		const date = el.getAttribute("w:date") ?? "";

		// Find paraId from the first <w:p> child
		let paraId: string | null = null;
		const paragraphs = el.getElementsByTagNameNS(W_NS, "p");
		if (paragraphs.length > 0) {
			const p = paragraphs[0]!;
			const ns = p.getAttributeNS(W14_NS, "paraId");
			const prefixed = p.getAttribute("w14:paraId");
			paraId = (ns || prefixed) || null;
		}

		const text = collectCommentText(el);

		result.push({
			commentId,
			paraId,
			author,
			date,
			text,
			quotedText: "",
		});
	}

	return result;
}

/**
 * Parse `word/commentsExtended.xml` for resolved status and threading.
 */
export function parseCommentsExtendedXml(xml: string): {
	resolvedIds: Set<string>;
	threadingMap: Map<string, string>;
} {
	if (!xml || xml.trim() === "") {
		return { resolvedIds: new Set(), threadingMap: new Map() };
	}

	const doc = new DOMParser().parseFromString(xml, "text/xml");
	const elements = doc.getElementsByTagNameNS(W15_NS, "commentEx");
	const resolvedIds = new Set<string>();
	const threadingMap = new Map<string, string>();

	for (let i = 0; i < elements.length; i++) {
		const el = elements[i]!;
		const paraId =
			el.getAttributeNS(W15_NS, "paraId") ??
			el.getAttribute("w15:paraId") ??
			"";

		if (!paraId) continue;

		const done =
			el.getAttributeNS(W15_NS, "done") ??
			el.getAttribute("w15:done");
		if (done === "1") {
			resolvedIds.add(paraId);
		}

		const parentParaId =
			el.getAttributeNS(W15_NS, "paraIdParent") ??
			el.getAttribute("w15:paraIdParent");
		if (parentParaId) {
			threadingMap.set(paraId, parentParaId);
		}
	}

	return { resolvedIds, threadingMap };
}

/**
 * Extract the quoted (highlighted) text for a comment from `word/document.xml`.
 *
 * Walks the DOM looking for `commentRangeStart`/`commentRangeEnd` markers
 * matching the given comment ID, collecting all `<w:t>` text between them.
 */
export function extractQuotedText(
	documentXml: string,
	commentId: string
): string {
	const doc = new DOMParser().parseFromString(documentXml, "text/xml");
	const collected: string[] = [];
	let capturing = false;

	walkNodes(doc, (node): boolean | void => {
		if (node.nodeType !== 1) return; // skip non-elements
		const el = node as Element;

		if (
			el.localName === "commentRangeStart" &&
			el.namespaceURI === W_NS &&
			el.getAttribute("w:id") === commentId
		) {
			capturing = true;
			return;
		}

		if (
			el.localName === "commentRangeEnd" &&
			el.namespaceURI === W_NS &&
			el.getAttribute("w:id") === commentId
		) {
			return true; // stop walking
		}

		if (
			capturing &&
			el.localName === "t" &&
			el.namespaceURI === W_NS
		) {
			collected.push(el.textContent ?? "");
		}
	});

	return collected.length > 0 ? collected.join("") : "[Quote unavailable]";
}

/**
 * Parse `word/people.xml` to build author → userId mapping.
 */
export function parsePeopleXml(xml: string): Map<string, string> {
	if (!xml || xml.trim() === "") return new Map();

	const doc = new DOMParser().parseFromString(xml, "text/xml");
	const people = doc.getElementsByTagNameNS(W15_NS, "person");
	const map = new Map<string, string>();

	for (let i = 0; i < people.length; i++) {
		const person = people[i]!;
		const author =
			person.getAttributeNS(W15_NS, "author") ??
			person.getAttribute("w15:author") ??
			"";

		if (!author) continue;

		const presenceInfo = person.getElementsByTagNameNS(
			W15_NS,
			"presenceInfo"
		);
		if (presenceInfo.length > 0) {
			const userId =
				presenceInfo[0]!.getAttributeNS(W15_NS, "userId") ??
				presenceInfo[0]!.getAttribute("w15:userId") ??
				"";
			map.set(author, userId);
		}
	}

	return map;
}

/**
 * Best-effort @mention resolution using the people map.
 *
 * Iterates over known author names (longest first) and replaces `@Name`
 * occurrences with `@Name (userId)`.
 */
export function resolveAtMentions(
	text: string,
	peopleMap: Map<string, string>
): string {
	if (peopleMap.size === 0) return text;

	// Sort by name length descending so longer names match first
	// (e.g. "Jane Doe" before "Jane")
	const entries = [...peopleMap.entries()].sort(
		(a, b) => b[0].length - a[0].length
	);

	let result = text;
	for (const [name, userId] of entries) {
		// Escape regex special chars in the name
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`@${escaped}(?=\\s|$|[.,;:!?)])`, "g");
		result = result.replace(pattern, `@${name} (${userId})`);
	}
	return result;
}

/**
 * Compute a deterministic 12-char unique ID for a comment.
 */
export function computeUniqueId(
	author: string,
	date: string,
	text: string
): string {
	return createHash("md5")
		.update(`${author}|${date}|${text}`)
		.digest("hex")
		.slice(0, 12);
}

/**
 * Build threaded comments from raw data.
 *
 * Separates top-level comments from replies, filters resolved comments,
 * resolves @mentions, and sorts by document order.
 */
export function buildCommentThreads(
	raw: RawComment[],
	threadingMap: Map<string, string>,
	resolvedIds: Set<string>,
	includeResolved: boolean,
	peopleMap: Map<string, string>
): Comment[] {
	// Build paraId → RawComment lookup
	const byParaId = new Map<string, RawComment>();
	for (const r of raw) {
		if (r.paraId) byParaId.set(r.paraId, r);
	}

	// Separate top-level and replies
	const topLevel: RawComment[] = [];
	const replies: RawComment[] = [];
	for (const r of raw) {
		if (r.paraId && threadingMap.has(r.paraId)) {
			replies.push(r);
		} else {
			topLevel.push(r);
		}
	}

	// Filter resolved top-level comments
	const filteredTopLevel = includeResolved
		? topLevel
		: topLevel.filter((c) => !c.paraId || !resolvedIds.has(c.paraId));

	// Build set of included top-level paraIds for reply filtering
	const includedParaIds = new Set(
		filteredTopLevel.map((c) => c.paraId).filter(Boolean) as string[]
	);

	// Sort top-level by commentId (numeric) for document order
	filteredTopLevel.sort(
		(a, b) => Number(a.commentId) - Number(b.commentId)
	);

	const result: Comment[] = [];

	for (const c of filteredTopLevel) {
		// Find replies to this comment
		const commentReplies = replies
			.filter(
				(r) =>
					r.paraId &&
					threadingMap.get(r.paraId) === c.paraId &&
					includedParaIds.has(c.paraId)
			)
			.sort(
				(a, b) =>
					new Date(a.date).getTime() - new Date(b.date).getTime()
			)
			.map((r) => ({
				author: r.author,
				date: formatDate(r.date),
				text: resolveAtMentions(r.text, peopleMap),
			}));

		result.push({
			commentId: c.commentId,
			paraId: c.paraId ?? "",
			author: c.author,
			date: formatDate(c.date),
			text: resolveAtMentions(c.text, peopleMap),
			quotedText: c.quotedText || "[Quote unavailable]",
			replies: commentReplies,
			uniqueId: computeUniqueId(c.author, c.date, c.text),
		});
	}

	return result;
}

/**
 * Format comments as Markdown for the output note.
 *
 * When `startNumber` is 1, includes the `# Comment Extraction` header.
 * When appending (startNumber > 1), omits the header.
 */
export function formatCommentsAsMarkdown(
	comments: Comment[],
	filename: string,
	startNumber: number
): string {
	const lines: string[] = [];

	if (startNumber === 1) {
		lines.push(`# Comment Extraction: ${filename}\n`);
	}

	for (let i = 0; i < comments.length; i++) {
		const c = comments[i]!;
		const num = startNumber + i;

		if (i > 0 || startNumber > 1) {
			lines.push("---\n");
		}

		lines.push(`### Comment ${num}`);
		lines.push(
			`**IDs**: \`${c.uniqueId}\` (xml:\`${c.commentId}\`, para:\`${c.paraId}\`)`
		);
		lines.push(`**Reviewer**: ${c.author}`);
		lines.push(`**Timestamp**: ${c.date}`);
		lines.push(`**Quote**: "${c.quotedText}"`);
		lines.push(`**Comment**: ${c.text}`);

		for (const reply of c.replies) {
			lines.push("");
			lines.push(
				`**Reply** (${reply.author}, ${reply.date}): ${reply.text}`
			);
		}

		lines.push("");
	}

	return lines.join("\n");
}

/**
 * Extract existing comment unique IDs and the highest comment number
 * from an existing note's content. Used for dedup/append.
 */
export function extractExistingCommentIds(existingContent: string): {
	ids: Set<string>;
	maxNumber: number;
} {
	const ids = new Set<string>();
	let maxNumber = 0;

	// Match unique IDs from **IDs**: `<id>` lines
	const idRegex = /\*\*IDs\*\*:\s*`([^`]+)`/g;
	let match;
	while ((match = idRegex.exec(existingContent)) !== null) {
		ids.add(match[1]!);
	}

	// Match comment numbers from ### Comment <N> lines
	const numRegex = /### Comment (\d+)/g;
	while ((match = numRegex.exec(existingContent)) !== null) {
		const num = parseInt(match[1]!, 10);
		if (num > maxNumber) maxNumber = num;
	}

	return { ids, maxNumber };
}
