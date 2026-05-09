/**
 * Auto-context injection — ambient workspace signals automatically
 * included with every user message sent to the LLM.
 *
 * Sources:
 *   - Open file paths (FR-26)
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
// Last-active file path cache
// ---------------------------------------------------------------------------

/**
 * Vault-relative path of the most recently focused file-backed leaf.
 *
 * Updated by `notifyFileLeafActivated()` which is called from an
 * `active-leaf-change` workspace event listener registered during plugin
 * load (see `main.ts`). The cache is intentionally NOT cleared when the
 * active leaf changes to a non-file view (e.g. the chat panel) — that
 * is precisely the case we want to recover from when assembling auto-context.
 */
let _lastActiveFilePath: string | null = null;

/**
 * Notify the auto-context module that a file-backed leaf became active.
 *
 * Should be called from a `registerEvent(app.workspace.on('active-leaf-change', …))`
 * handler in the plugin entry point so the cache stays current.
 *
 * @param path - Vault-relative path of the newly-active file,
 *               or `null` to reset the cache (e.g. on plugin unload).
 */
export function notifyFileLeafActivated(path: string | null): void {
	_lastActiveFilePath = path;
}

/**
 * Return the cached last-active file path.
 *
 * Useful for command callbacks that need to resolve the active file
 * when the active view might not be a file-backed view (e.g., when the
 * chat panel has focus).
 */
export function getLastActiveFilePath(): string | null {
	return _lastActiveFilePath;
}

// ---------------------------------------------------------------------------
// CTX-001: Open file paths collector
// ---------------------------------------------------------------------------

/** View types that are non-file-backed or internal — excluded from open-files list. */
const EXCLUDED_VIEW_TYPES = new Set([
	"empty",
	"graph",
	"localgraph",
	"search",
	"file-explorer",
	"backlink",
	"outgoing-link",
	"tag",
	"outline",
	"notor-chat-view",
]);

/**
 * Collect vault-relative file paths of all currently open file-backed leaves
 * (markdown, PDFs, images, canvas, etc.), with the active file annotated
 * with ` (active)`.
 *
 * Uses `iterateAllLeaves()` to enumerate every leaf regardless of
 * activation state (Obsidian lazily initialises tab views, so
 * type-specific queries may miss unvisited tabs). For each leaf we check
 * `leaf.view?.getState()?.file` as a fallback when the view's `.file`
 * property hasn't been populated yet.
 *
 * Active file detection uses a two-stage approach to handle the common
 * case where the chat panel has focus:
 *   1. Try `app.workspace.getActiveFile()` — works when any file-backed
 *      view is currently focused.
 *   2. Fall back to `_lastActiveFilePath` — the cached path set by
 *      the `active-leaf-change` event listener. This correctly handles
 *      the case where the user switches to the chat panel, because the
 *      cache is not cleared on non-file leaf changes.
 *
 * @returns Array of vault-relative file paths. The active file (if any)
 *          has ` (active)` appended.
 */
export function collectOpenFilePaths(app: App): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];

	// Stage 1: Try the currently-focused file view.
	let activePath: string | null = app.workspace.getActiveFile()?.path ?? null;

	const openPaths = new Set<string>();

	// iterateAllLeaves covers pinned tabs, split panes, stacked tabs,
	// and — crucially — tabs whose views haven't been activated yet.
	app.workspace.iterateAllLeaves((leaf) => {
		const viewType = leaf.view?.getViewType?.();
		if (viewType && EXCLUDED_VIEW_TYPES.has(viewType)) return;

		// Try the view's file property first (populated for activated views).
		let filePath: string | undefined =
			(leaf.view as { file?: { path: string } }).file?.path;

		// Fallback: read the serialised view state which Obsidian populates
		// even for lazily-initialised tabs.
		if (!filePath) {
			const state = leaf.view?.getState?.() as { file?: string } | undefined;
			if (state?.file) {
				filePath = state.file;
			}
		}

		if (filePath && !seen.has(filePath)) {
			seen.add(filePath);
			openPaths.add(filePath);
			paths.push(filePath);
		}
	});

	// Stage 2: If no file view is currently focused (e.g. the chat panel
	// has focus), use the cached last-active file path.
	// Only use the cached path if the corresponding tab is still open.
	if (!activePath && _lastActiveFilePath && openPaths.has(_lastActiveFilePath)) {
		activePath = _lastActiveFilePath;
	}

	// Annotate the active path with " (active)" in the final list.
	if (activePath) {
		return paths.map((p) =>
			p === activePath ? `${p} (active)` : p,
		);
	}

	return paths;
}

/** @deprecated Use `collectOpenFilePaths` instead. */
export const collectOpenNotePaths = collectOpenFilePaths;

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

	// Open files
	if (settings.auto_context_open_notes) {
		const paths = collectOpenFilePaths(app);
		const pathList = paths.length > 0 ? "\n" + paths.join("\n") + "\n  " : "";
		tags.push(`  <open-files>${pathList}</open-files>`);
	}

	// Vault structure — one folder per line, trailing `/`
	if (settings.auto_context_vault_structure) {
		const folders = collectVaultStructure(app);
		const folderList =
			folders.length > 0
				? "\n" + folders.map((f) => f + "/").join("\n") + "\n  "
				: "";
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