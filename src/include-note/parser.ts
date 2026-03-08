/**
 * Regex-based parser for `<include_note ... />` tags.
 *
 * Finds all self-closing `<include_note>` tags in a given text string and
 * extracts their attributes into `IncludeNoteTag` objects. This is a pure
 * function with no vault access — it operates entirely on the raw text.
 *
 * @see specs/03-workflows-personas/contracts/include-note-tag.md — Parsing Algorithm
 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-002
 * @module
 */

import type { IncludeNoteTag, IncludeNoteMode, IncludeNotePathType } from "../types";

/**
 * Regex pattern to find all self-closing `<include_note ... />` tags.
 *
 * Matches:
 * - The opening `<include_note` literal
 * - One or more whitespace characters (including newlines)
 * - A non-greedy capture group for attribute content (`[^>]*?`)
 * - Optional trailing whitespace
 * - The self-closing `/>` literal
 *
 * The `g` and `s` flags ensure all occurrences are found and that `\s`
 * matches newlines (for tags spanning multiple lines).
 */
const TAG_REGEX = /<include_note\s+([^>]*?)\s*\/>/g;

/**
 * Regex pattern to extract key-value attribute pairs from a tag's
 * attribute string. Only double-quoted values are supported per contract.
 */
const ATTR_REGEX = /(\w+)\s*=\s*"([^"]*)"/g;

/**
 * Set of recognized attribute names. Attributes not in this set are
 * silently ignored per contract.
 */
const SUPPORTED_ATTRS = new Set(["path", "section", "mode", "strip_frontmatter"]);

/**
 * Parse all `<include_note ... />` tags in the given text and extract
 * their attributes into `IncludeNoteTag` objects.
 *
 * Tags without a `path` attribute (or with an empty `path`) are excluded
 * from the returned array — they are left as-is in the source text.
 *
 * @param text - The raw text to scan for `<include_note>` tags.
 * @returns An array of parsed `IncludeNoteTag` objects in the order they
 *          appear in the text. Returns an empty array if no valid tags
 *          are found.
 */
export function parseIncludeNoteTags(text: string): IncludeNoteTag[] {
	const tags: IncludeNoteTag[] = [];

	// Reset lastIndex in case the regex was used before (global flag)
	TAG_REGEX.lastIndex = 0;

	let match: RegExpExecArray | null;
	while ((match = TAG_REGEX.exec(text)) !== null) {
		const rawTag = match[0] as string;
		const attrString = match[1] as string;

		// Extract all key="value" pairs from the attribute string
		const attrs = extractAttributes(attrString);

		// `path` is required — skip tags without a valid path
		const path = attrs.get("path");
		if (!path) {
			continue;
		}

		// Determine path type: if the value contains `[[` it's a wikilink
		const pathType: IncludeNotePathType = path.includes("[[")
			? "wikilink"
			: "vault_relative";

		// `section` defaults to null if absent
		const section = attrs.get("section") ?? null;

		// `mode` defaults to "inline"; unrecognized values default to "inline"
		const rawMode = attrs.get("mode");
		const mode: IncludeNoteMode =
			rawMode === "inline" || rawMode === "attached" ? rawMode : "inline";

		// `strip_frontmatter` defaults to true; only exact string "false" sets it to false
		const rawStripFm = attrs.get("strip_frontmatter");
		const stripFrontmatter = rawStripFm !== "false";

		tags.push({
			raw_tag: rawTag,
			path,
			path_type: pathType,
			section,
			mode,
			strip_frontmatter: stripFrontmatter,
		});
	}

	return tags;
}

/**
 * Extract double-quoted attribute key-value pairs from a tag's attribute
 * string. Only attributes in the supported set are included; others are
 * silently ignored.
 *
 * @param attrString - The raw attribute content between `<include_note` and `/>`.
 * @returns A map of attribute name → value for recognized attributes.
 */
function extractAttributes(attrString: string): Map<string, string> {
	const attrs = new Map<string, string>();

	// Reset lastIndex in case the regex was used before (global flag)
	ATTR_REGEX.lastIndex = 0;

	let attrMatch: RegExpExecArray | null;
	while ((attrMatch = ATTR_REGEX.exec(attrString)) !== null) {
		const key = attrMatch[1] as string;
		const value = attrMatch[2] as string;

		// Only include supported attributes; silently ignore others
		if (SUPPORTED_ATTRS.has(key)) {
			attrs.set(key, value);
		}
	}

	return attrs;
}
