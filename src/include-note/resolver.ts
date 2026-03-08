/**
 * Vault-aware resolution logic for `<include_note ... />` tags.
 *
 * Resolves parsed `IncludeNoteTag` objects against the Obsidian vault:
 * path resolution (vault-relative and wikilink), note content reading,
 * section extraction, frontmatter stripping, and inline/attached mode
 * assembly.
 *
 * @see specs/03-workflows-personas/contracts/include-note-tag.md — Resolution Algorithm
 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-003 through D-008
 * @module
 */

import { TFile, type MetadataCache, type Vault, getFrontMatterInfo } from "obsidian";
import type { IncludeNoteTag, IncludeNoteResolutionResult } from "../types";
import { parseIncludeNoteTags } from "./parser";
import { logger } from "../utils/logger";

const log = logger("IncludeNoteResolver");

/**
 * Context in which `<include_note>` tags are being resolved.
 *
 * - `"workflow"` — both `inline` and `attached` modes are supported.
 * - `"system_prompt"` — `mode` attribute is ignored; always resolved as inline.
 * - `"vault_rule"` — `mode` attribute is ignored; always resolved as inline.
 *
 * @see specs/03-workflows-personas/contracts/include-note-tag.md — Context-Specific Rules
 */
export type IncludeNoteContext = "workflow" | "system_prompt" | "vault_rule";

// ---------------------------------------------------------------------------
// D-003: Path resolution — vault-relative paths
// D-004: Path resolution — wikilink paths
// ---------------------------------------------------------------------------

/**
 * Resolve an `<include_note>` tag's path to a `TFile` in the vault.
 *
 * - For `path_type === "vault_relative"`: calls `vault.getAbstractFileByPath()`
 *   and checks the result is a `TFile` (not a `TFolder`).
 * - For `path_type === "wikilink"`: strips `[[` and `]]` from the path and
 *   resolves via `metadataCache.getFirstLinkpathDest()`.
 *
 * Returns `null` if the path does not resolve to a file.
 *
 * @param tag - The parsed `<include_note>` tag.
 * @param vault - The Obsidian vault instance.
 * @param metadataCache - The Obsidian metadata cache instance.
 * @param sourceFilePath - Vault-relative path of the file containing the tag
 *                         (provides disambiguation context for wikilink resolution).
 * @returns The resolved `TFile`, or `null` if the path could not be resolved.
 *
 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-003, D-004
 */
export function resolveIncludeNotePath(
	tag: IncludeNoteTag,
	vault: Vault,
	metadataCache: MetadataCache,
	sourceFilePath: string,
): TFile | null {
	if (tag.path_type === "wikilink") {
		return resolveWikilinkPath(tag.path, metadataCache, sourceFilePath);
	}
	return resolveVaultRelativePath(tag.path, vault);
}

/**
 * Resolve a vault-relative path to a `TFile`.
 *
 * Handles paths with and without `.md` extension: if the exact path does not
 * resolve, tries appending `.md` as a fallback.
 *
 * @param path - Vault-relative file path (e.g., `"Research/Topic A.md"`).
 * @param vault - The Obsidian vault instance.
 * @returns The resolved `TFile`, or `null` if not found.
 */
function resolveVaultRelativePath(path: string, vault: Vault): TFile | null {
	// Try exact path first
	const file = vault.getAbstractFileByPath(path);
	if (file instanceof TFile) {
		return file;
	}

	// Fallback: try appending .md if the path doesn't already have it
	if (!path.endsWith(".md")) {
		const withExt = vault.getAbstractFileByPath(path + ".md");
		if (withExt instanceof TFile) {
			return withExt;
		}
	}

	return null;
}

/**
 * Resolve a wikilink path to a `TFile`.
 *
 * Strips `[[` and `]]` from the path value and calls
 * `metadataCache.getFirstLinkpathDest()` with the stripped link path
 * and the source file's vault-relative path for disambiguation context.
 *
 * Handles wikilinks with subdirectory hints (e.g., `[[Research/Topic A]]`)
 * and wikilinks with just a note name (e.g., `[[Topic A]]`).
 *
 * @param path - The raw path attribute value containing `[[...]]`.
 * @param metadataCache - The Obsidian metadata cache instance.
 * @param sourceFilePath - Vault-relative path of the file containing the tag.
 * @returns The resolved `TFile`, or `null` if the wikilink resolves to nothing.
 */
function resolveWikilinkPath(
	path: string,
	metadataCache: MetadataCache,
	sourceFilePath: string,
): TFile | null {
	// Strip [[ and ]] from the path value
	const linkPath = path.replace(/^\[\[|\]\]$/g, "");
	return metadataCache.getFirstLinkpathDest(linkPath, sourceFilePath);
}

// ---------------------------------------------------------------------------
// D-005: Section extraction
// ---------------------------------------------------------------------------

/**
 * Extract a section from note content by heading name.
 *
 * Finds the first heading whose text matches `sectionName` (exact match,
 * case-sensitive), then extracts content from that heading's start offset
 * to the next heading of equal or higher level (or end of content).
 *
 * **Important:** Section offsets are computed against the full file content
 * (before frontmatter stripping). This function should be called on the
 * full raw content, not on frontmatter-stripped content.
 *
 * @param content - The full file content (including any frontmatter).
 * @param sectionName - The heading text to search for.
 * @param file - The resolved `TFile` (used to query the metadata cache).
 * @param metadataCache - The Obsidian metadata cache instance.
 * @returns The extracted section content (including heading line), trimmed.
 *          Returns `null` if the heading is not found.
 *
 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-005
 * @see specs/03-workflows-personas/contracts/include-note-tag.md — Resolution Algorithm Step 4
 */
export function extractSection(
	content: string,
	sectionName: string,
	file: TFile,
	metadataCache: MetadataCache,
): string | null {
	const cache = metadataCache.getFileCache(file);
	const headings = cache?.headings ?? [];

	if (headings.length === 0) {
		return null;
	}

	// Find the first heading whose text matches sectionName (exact, case-sensitive)
	const targetIdx = headings.findIndex((h) => h.heading === sectionName);
	if (targetIdx === -1) {
		return null;
	}

	const targetHeading = headings[targetIdx]!;
	const targetLevel = targetHeading.level;
	const startOffset = targetHeading.position.start.offset;

	// Find the next heading of equal or higher level (lower or equal level number)
	let endOffset = content.length;
	for (let i = targetIdx + 1; i < headings.length; i++) {
		if (headings[i]!.level <= targetLevel) {
			endOffset = headings[i]!.position.start.offset;
			break;
		}
	}

	return content.slice(startOffset, endOffset).trim();
}

// ---------------------------------------------------------------------------
// D-006: Note content reading
// ---------------------------------------------------------------------------

/**
 * Read the full content of a resolved `TFile` from the vault.
 *
 * Always reads the latest content — no caching is performed. Per contract:
 * "Tags are always resolved with the latest note content — there is no
 * caching of resolved content between calls."
 *
 * @param file - The resolved `TFile` to read.
 * @param vault - The Obsidian vault instance.
 * @returns The raw content string (including frontmatter).
 * @throws On read failure (caught by error handling in the main resolver).
 *
 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-006
 */
export async function readNoteContent(file: TFile, vault: Vault): Promise<string> {
	return vault.read(file);
}

// ---------------------------------------------------------------------------
// D-007: Frontmatter stripping
// ---------------------------------------------------------------------------

/**
 * Strip YAML frontmatter from note content.
 *
 * Uses Obsidian's `getFrontMatterInfo()` utility to reliably determine
 * the frontmatter boundary, then returns the body content after the
 * closing `---` delimiter.
 *
 * If the content has no frontmatter (no leading `---`), returns the
 * full content as-is.
 *
 * @param content - The raw note content (potentially including frontmatter).
 * @returns The body content after frontmatter has been stripped.
 *
 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-007
 */
export function stripNoteFrontmatter(content: string): string {
	const fmInfo = getFrontMatterInfo(content);
	if (!fmInfo.exists) {
		return content;
	}
	return content.slice(fmInfo.contentStart);
}

// ---------------------------------------------------------------------------
// D-008: Inline vs attached mode assembly (main public API)
// ---------------------------------------------------------------------------

/**
 * Resolve all `<include_note>` tags in a text string.
 *
 * This is the main public API for `<include_note>` resolution. It parses
 * the text for tags, resolves each one against the vault, and returns the
 * result with inline-resolved content and collected attachments.
 *
 * **Context-specific rules:**
 * - `"system_prompt"` / `"vault_rule"`: the `mode` attribute is ignored
 *   and all tags are resolved as `inline`.
 * - `"workflow"`: both `inline` and `attached` modes are supported.
 *
 * **No nested resolution:** If resolved content itself contains
 * `<include_note>` tags, they are passed through as literal text
 * (single-pass resolution per contract).
 *
 * Tags are resolved in order of appearance. String replacement on
 * `raw_tag` is used (not offset-based) so earlier replacements don't
 * affect later tag positions.
 *
 * @param text - The text containing `<include_note>` tags to resolve.
 * @param vault - The Obsidian vault instance.
 * @param metadataCache - The Obsidian metadata cache instance.
 * @param sourceFilePath - Vault-relative path of the file containing the tags.
 * @param context - The resolution context (`"workflow"`, `"system_prompt"`, or `"vault_rule"`).
 * @returns The resolution result with `inlineContent` and `attachments`.
 *
 * @see specs/03-workflows-personas/tasks/group-d-tasks.md — D-008
 * @see specs/03-workflows-personas/contracts/include-note-tag.md — Resolution Algorithm
 */
export async function resolveIncludeNotes(
	text: string,
	vault: Vault,
	metadataCache: MetadataCache,
	sourceFilePath: string,
	context: IncludeNoteContext,
): Promise<IncludeNoteResolutionResult> {
	const tags = parseIncludeNoteTags(text);

	// Fast path: no tags found — return original text unmodified
	if (tags.length === 0) {
		return { inlineContent: text, attachments: [] };
	}

	let resultText = text;
	const attachments: IncludeNoteResolutionResult["attachments"] = [];

	// Resolve tags in order of appearance
	for (const tag of tags) {
		const resolved = await resolveSingleTag(tag, vault, metadataCache, sourceFilePath);

		// Determine effective mode: system_prompt and vault_rule contexts
		// force all tags to inline mode
		const effectiveMode =
			context === "system_prompt" || context === "vault_rule"
				? "inline"
				: tag.mode;

		if (resolved.error) {
			// Error markers are always inserted inline at the tag position
			resultText = resultText.replace(tag.raw_tag, resolved.error);
		} else if (effectiveMode === "attached") {
			// Attached mode: remove the tag from the text, collect the content
			resultText = resultText.replace(tag.raw_tag, "");
			attachments.push({
				path: resolved.resolvedPath!,
				section: tag.section,
				content: resolved.content!,
			});
		} else {
			// Inline mode (default): replace the tag with the resolved content
			resultText = resultText.replace(tag.raw_tag, resolved.content!);
		}
	}

	return { inlineContent: resultText, attachments };
}

// ---------------------------------------------------------------------------
// Internal: single tag resolution
// ---------------------------------------------------------------------------

/** Result of resolving a single `<include_note>` tag. */
interface SingleTagResult {
	/** Resolved content (null on error). */
	content: string | null;
	/** Vault-relative path of the resolved file (null on error). */
	resolvedPath: string | null;
	/** Error marker string (null on success). */
	error: string | null;
}

/**
 * Resolve a single `<include_note>` tag against the vault.
 *
 * Performs: path resolution → content reading → section extraction →
 * frontmatter stripping. Returns either the resolved content or an
 * error marker string.
 *
 * Each error is logged at `warn` level via the `IncludeNoteResolver`
 * logger source for debugging.
 */
async function resolveSingleTag(
	tag: IncludeNoteTag,
	vault: Vault,
	metadataCache: MetadataCache,
	sourceFilePath: string,
): Promise<SingleTagResult> {
	// Step 1: Resolve path to file
	let file: TFile | null;
	try {
		file = resolveIncludeNotePath(tag, vault, metadataCache, sourceFilePath);
	} catch {
		// Defensive: treat any resolution error as "not found"
		file = null;
	}

	if (!file) {
		const errorMarker = buildNotFoundError(tag);
		log.warn("Note not found", { path: tag.path, path_type: tag.path_type, sourceFilePath });
		return { content: null, resolvedPath: null, error: errorMarker };
	}

	// Vault-scoping security check: verify the resolved file is within the vault.
	// Obsidian's API inherently scopes to the vault, but this is a defensive guard.
	if (!file.path || file.path.startsWith("..")) {
		const errorMarker = buildNotFoundError(tag);
		log.warn("Path resolves outside vault", { path: tag.path, resolvedPath: file.path });
		return { content: null, resolvedPath: null, error: errorMarker };
	}

	// Step 2: Read note content
	let rawContent: string;
	try {
		rawContent = await readNoteContent(file, vault);
	} catch (err) {
		// File read failure — generic "not found" error (no internal details leaked)
		const errorMarker = buildNotFoundError(tag);
		log.warn("File read failure", { path: tag.path, resolvedPath: file.path, error: String(err) });
		return { content: null, resolvedPath: null, error: errorMarker };
	}

	// Step 3: Section extraction (if specified)
	// Section extraction runs on the full content (before frontmatter stripping)
	// because metadata cache offsets are based on the full file.
	let content: string;
	if (tag.section) {
		const sectionContent = extractSection(rawContent, tag.section, file, metadataCache);
		if (sectionContent === null) {
			const errorMarker = `[include_note error: section '${tag.section}' not found in '${file.path}']`;
			log.warn("Section not found", {
				path: tag.path,
				resolvedPath: file.path,
				section: tag.section,
			});
			return { content: null, resolvedPath: null, error: errorMarker };
		}
		content = sectionContent;
	} else {
		content = rawContent;
	}

	// Step 4: Frontmatter stripping (if enabled)
	// When section extraction was performed, the extracted section content is
	// typically body content (headings appear after frontmatter), so stripping
	// is usually a no-op. But we apply it consistently for correctness.
	if (tag.strip_frontmatter) {
		content = stripNoteFrontmatter(content);
	}

	return { content, resolvedPath: file.path, error: null };
}

/**
 * Build the appropriate "not found" error marker for a tag.
 *
 * Preserves wikilink syntax in the error message for wikilink paths.
 */
function buildNotFoundError(tag: IncludeNoteTag): string {
	if (tag.path_type === "wikilink") {
		return `[include_note error: note '${tag.path}' not found]`;
	}
	return `[include_note error: note '${tag.path}' not found]`;
}
