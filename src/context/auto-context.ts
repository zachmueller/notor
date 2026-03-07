/**
 * Auto-context injection — ambient workspace signals automatically
 * included with every user message sent to the LLM.
 *
 * Sources:
 *   - Open note paths (FR-26)
 *   - Vault structure — top-level folders (FR-27)
 *   - OS platform (FR-28)
 *
 * Each source can be individually enabled/disabled via settings.
 * The output is an XML-tagged `<auto-context>` block per the contract
 * in specs/02-context-intelligence/contracts/tool-schemas.md.
 *
 * @see specs/02-context-intelligence/tasks.md — CTX-001..CTX-004
 * @see specs/02-context-intelligence/spec.md — FR-26, FR-27, FR-28
 */

import type { App } from "obsidian";
import { TFolder } from "obsidian";
import type { NotorSettings } from "../settings";

// ---------------------------------------------------------------------------
// CTX-001: Open note paths collector
// ---------------------------------------------------------------------------

/**
 * Collect vault-relative file paths of all currently open markdown notes.
 *
 * Enumerates all leaves of type "markdown" in the workspace, which
 * covers pinned tabs, split panes, and stacked tabs.
 *
 * @returns Array of vault-relative file paths (empty if none open).
 */
export function collectOpenNotePaths(app: App): string[] {
	const paths: string[] = [];
	const leaves = app.workspace.getLeavesOfType("markdown");

	for (const leaf of leaves) {
		// MarkdownView exposes .file — the TFile for the open note
		const file = (leaf.view as { file?: { path: string } }).file;
		if (file?.path) {
			paths.push(file.path);
		}
	}

	return paths;
}

// ---------------------------------------------------------------------------
// CTX-002: Vault structure collector
// ---------------------------------------------------------------------------

/**
 * Collect top-level folder names at the vault root.
 *
 * Only returns folder names — files at root level are excluded.
 *
 * @returns Array of folder names (empty if vault root has no folders).
 */
export function collectVaultStructure(app: App): string[] {
	const root = app.vault.getRoot();
	if (!root.children) {
		return [];
	}

	const folders: string[] = [];
	for (const child of root.children) {
		if (child instanceof TFolder) {
			folders.push(child.name);
		}
	}

	return folders;
}

// ---------------------------------------------------------------------------
// CTX-003: OS platform detector
// ---------------------------------------------------------------------------

/** Map of process.platform values to human-readable names. */
const PLATFORM_NAMES: Record<string, string> = {
	darwin: "macOS",
	win32: "Windows",
	linux: "Linux",
};

/**
 * Detect the user's operating system.
 *
 * Maps `process.platform` to a human-readable name.
 *
 * @returns Human-readable OS name (e.g. "macOS", "Windows", "Linux").
 */
export function detectOS(): string {
	const platform =
		typeof process !== "undefined" ? process.platform : "unknown";
	return PLATFORM_NAMES[platform] ?? `Unknown (${platform})`;
}

// ---------------------------------------------------------------------------
// CTX-004: Auto-context XML assembly
// ---------------------------------------------------------------------------

/**
 * Build the `<auto-context>` XML block from enabled sources.
 *
 * Reads per-source enable/disable state from settings and assembles
 * the block per the contract specification. Tags for disabled sources
 * are omitted entirely. If all sources are disabled, returns `null`.
 *
 * @param app - The Obsidian App instance.
 * @param settings - Current plugin settings.
 * @returns The `<auto-context>` XML string, or `null` if all sources disabled.
 */
export function buildAutoContextBlock(
	app: App,
	settings: NotorSettings
): string | null {
	const tags: string[] = [];

	// Open notes
	if (settings.auto_context_open_notes) {
		const paths = collectOpenNotePaths(app);
		const pathList = paths.length > 0 ? "\n" + paths.join("\n") + "\n  " : "";
		tags.push(`  <open-notes>${pathList}</open-notes>`);
	}

	// Vault structure
	if (settings.auto_context_vault_structure) {
		const folders = collectVaultStructure(app);
		const folderList = folders.join(", ");
		tags.push(`  <vault-structure>${folderList}</vault-structure>`);
	}

	// OS platform
	if (settings.auto_context_os) {
		const os = detectOS();
		tags.push(`  <os>${os}</os>`);
	}

	// If no tags were added, all sources are disabled
	if (tags.length === 0) {
		return null;
	}

	return `<auto-context>\n${tags.join("\n")}\n</auto-context>`;
}