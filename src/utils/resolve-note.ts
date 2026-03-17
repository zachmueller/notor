/**
 * Shared note resolution utility for vault tools.
 *
 * Provides Obsidian-style flexible note resolution so tools work correctly
 * even when the AI omits the `.md` extension or supplies only a bare note name.
 */

import { TFile } from "obsidian";
import type { Vault, MetadataCache } from "obsidian";

/**
 * Resolve a note path to a TFile using Obsidian-style fallback resolution:
 *
 * 1. Exact vault-relative path (e.g., "Research/Climate.md")
 * 2. Path with .md appended (e.g., "Research/Climate" → "Research/Climate.md")
 * 3. Wikilink-style name resolution via metadataCache.getFirstLinkpathDest
 *    (e.g., bare name "Climate" finds the note anywhere in the vault)
 *
 * Returns null if no matching note is found.
 */
export function resolveNote(
	path: string,
	vault: Vault,
	metadataCache: MetadataCache,
): TFile | null {
	// Step 1: exact vault-relative path
	const exact = vault.getAbstractFileByPath(path);
	if (exact instanceof TFile) return exact;

	// Step 2: auto-append .md if not already present
	if (!path.endsWith(".md")) {
		const withExt = vault.getAbstractFileByPath(path + ".md");
		if (withExt instanceof TFile) return withExt;
	}

	// Step 3: wikilink-style resolution — finds note by name across the vault
	const byName = metadataCache.getFirstLinkpathDest(path, "");
	if (byName instanceof TFile) return byName;

	return null;
}
