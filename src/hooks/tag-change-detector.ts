/**
 * Tag shadow cache and suppression manager for on_tag_change hooks.
 *
 * Contains two classes:
 * - F-014: `TagShadowCache` — maintains per-note normalized tag state for
 *   diff computation. Eagerly initialized at plugin load via
 *   `workspace.onLayoutReady()`. Maintained by vault lifecycle handlers.
 * - F-015: `TagChangeSuppressionManager` — two-phase consume-on-event
 *   mechanism to prevent on_tag_change hooks from re-firing when Notor's
 *   own tools (manage_tags, update_frontmatter) modify tags.
 *
 * Both classes are based on R-3 research findings.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-014, F-015
 * @see specs/03-workflows-personas/research/research-r3-tag-change-test.ts
 */

import type { App, TFile } from "obsidian";
import { parseFrontMatterTags } from "obsidian";
import { logger } from "../utils/logger";

const log = logger("TagChangeDetector");

// ---------------------------------------------------------------------------
// F-014: TagShadowCache
// ---------------------------------------------------------------------------

/**
 * In-memory shadow cache of per-note normalized frontmatter tag sets.
 *
 * Maintained in parallel with Obsidian's metadata cache so that
 * `metadataCache.on('changed')` handlers can compute before/after tag diffs
 * without a separate disk read.
 *
 * **Initialization:** Call `initialize(app)` inside
 * `workspace.onLayoutReady()` — it reads all Markdown files synchronously
 * from the metadata cache (no disk I/O; target <50 ms for 10,000 notes).
 *
 * **Tag normalization:** Leading `#` stripped, whitespace trimmed, lowercase
 * for comparison. Original casing is preserved in reported diffs by using
 * the new-tags set (caller's responsibility per F-016).
 *
 * **Uses `parseFrontMatterTags()`** (NOT `getAllTags()`) to extract
 * frontmatter-only tags per R-3 rationale.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-014
 */
export class TagShadowCache {
	/** vault-relative note path → normalized lowercase tag set. */
	private readonly cache = new Map<string, Set<string>>();

	// ---------------------------------------------------------------------------
	// Initialization
	// ---------------------------------------------------------------------------

	/**
	 * Eagerly initialize the shadow cache from Obsidian's metadata cache.
	 *
	 * Iterates all Markdown files via `vault.getMarkdownFiles()`, reads tags
	 * from `metadataCache.getFileCache(file)?.frontmatter` via
	 * `parseFrontMatterTags()`, normalizes, and stores.
	 *
	 * This method performs only in-memory reads from Obsidian's already-built
	 * metadata cache. It should be called inside `workspace.onLayoutReady()`
	 * to ensure the metadata cache is fully populated before reading.
	 *
	 * @param app - The Obsidian App instance.
	 */
	initialize(app: App): void {
		const files = app.vault.getMarkdownFiles();
		let cached = 0;
		let skipped = 0;

		for (const file of files) {
			const fileCache = app.metadataCache.getFileCache(file);
			if (!fileCache) {
				skipped++;
				continue;
			}

			const rawTags = parseFrontMatterTags(fileCache.frontmatter) ?? [];
			const normalizedTags = normalizeTagSet(rawTags);
			this.cache.set(file.path, normalizedTags);
			cached++;
		}

		log.debug("TagShadowCache initialized", {
			total: files.length,
			cached,
			skipped,
		});
	}

	// ---------------------------------------------------------------------------
	// Read / write
	// ---------------------------------------------------------------------------

	/**
	 * Return the shadow cache entry for a note.
	 *
	 * @param notePath - Vault-relative path of the note.
	 * @returns The normalized tag set (empty Set if not present in cache).
	 */
	getTags(notePath: string): Set<string> {
		return this.cache.get(notePath) ?? new Set<string>();
	}

	/**
	 * Replace the cache entry for a note with a new normalized tag set.
	 *
	 * @param notePath - Vault-relative path.
	 * @param newTags  - Normalized lowercase tag set to store.
	 */
	updateTags(notePath: string, newTags: Set<string>): void {
		this.cache.set(notePath, newTags);
	}

	// ---------------------------------------------------------------------------
	// Lifecycle maintenance
	// ---------------------------------------------------------------------------

	/**
	 * Remove the cache entry for a deleted note.
	 *
	 * Should be called from a `vault.on('delete')` handler.
	 *
	 * @param notePath - Vault-relative path of the deleted note.
	 */
	removePath(notePath: string): void {
		this.cache.delete(notePath);
		log.debug("TagShadowCache entry removed", { notePath });
	}

	/**
	 * Rename a cache entry (move from old path to new path).
	 *
	 * Should be called from a `vault.on('rename')` handler.
	 *
	 * @param oldPath - Previous vault-relative path.
	 * @param newPath - New vault-relative path.
	 */
	renamePath(oldPath: string, newPath: string): void {
		const tags = this.cache.get(oldPath);
		if (tags !== undefined) {
			this.cache.set(newPath, tags);
			this.cache.delete(oldPath);
		}
		log.debug("TagShadowCache entry renamed", { oldPath, newPath });
	}

	// ---------------------------------------------------------------------------
	// Diff computation
	// ---------------------------------------------------------------------------

	/**
	 * Compute the diff between the shadow cache entry for a note and a new
	 * set of tags.
	 *
	 * Tags are compared using the lowercase normalized forms in both the
	 * cache and `newTags`. The returned `added` and `removed` arrays contain
	 * the normalized lowercase strings (caller formats them as needed).
	 *
	 * Returns `{ added: [], removed: [] }` if there is no change.
	 *
	 * @param notePath - Vault-relative path of the note.
	 * @param newTags  - Current normalized lowercase tag set.
	 * @returns `{ added: string[], removed: string[] }` tag diff.
	 */
	computeDiff(
		notePath: string,
		newTags: Set<string>
	): { added: string[]; removed: string[] } {
		const oldTags = this.getTags(notePath);

		const added: string[] = [];
		const removed: string[] = [];

		for (const tag of newTags) {
			if (!oldTags.has(tag)) {
				added.push(tag);
			}
		}

		for (const tag of oldTags) {
			if (!newTags.has(tag)) {
				removed.push(tag);
			}
		}

		return { added, removed };
	}

	// ---------------------------------------------------------------------------
	// Cleanup
	// ---------------------------------------------------------------------------

	/**
	 * Clear all internal state. Called on plugin unload.
	 */
	destroy(): void {
		this.cache.clear();
		log.debug("TagShadowCache destroyed");
	}
}

// ---------------------------------------------------------------------------
// F-015: TagChangeSuppressionManager
// ---------------------------------------------------------------------------

/**
 * Two-phase consume-on-event suppression mechanism for on_tag_change hooks.
 *
 * Prevents `on_tag_change` hooks from re-firing when Notor's own tools
 * (`manage_tags`, `update_frontmatter`) modify tags within a hook-initiated
 * workflow.
 *
 * **Integration point:** When `manage_tags` or `update_frontmatter` is
 * called within a hook-initiated workflow, the tool dispatcher calls
 * `suppress(notePath)` _before_ the tool executes. The subsequent
 * `metadataCache.on('changed')` event handler calls `checkAndConsume()`
 * to skip hook dispatch for that note.
 *
 * **Note:** The shadow cache is still updated on suppressed events to keep
 * it accurate — only hook dispatch is skipped.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-015
 */
export class TagChangeSuppressionManager {
	/** vault-relative note path → timestamp (ms) when suppression was set. */
	private readonly suppressions = new Map<string, number>();

	/**
	 * How long (ms) a suppression flag remains active. The metadata cache
	 * update is asynchronous, so we allow 2 seconds for the event to arrive.
	 */
	private static readonly WINDOW_MS = 2_000;

	/**
	 * Periodic cleanup interval (ms). Removes entries older than WINDOW_MS.
	 */
	private static readonly CLEANUP_INTERVAL_MS = 30_000;

	// ---------------------------------------------------------------------------
	// Suppression API
	// ---------------------------------------------------------------------------

	/**
	 * Mark a note path as suppressed for the next `on_tag_change` event.
	 *
	 * Called by `manage_tags` and `update_frontmatter` tool dispatchers
	 * immediately before modifying tags.
	 *
	 * @param notePath - Vault-relative path of the note being modified.
	 */
	suppress(notePath: string): void {
		this.suppressions.set(notePath, Date.now());
		log.debug("Tag change suppression set", { notePath });
	}

	/**
	 * Check whether the given note path has an active suppression, and
	 * consume it (one-shot) if found.
	 *
	 * Returns `true` (suppressed) and removes the entry if a suppression
	 * exists within the `WINDOW_MS` window. Returns `false` if no
	 * suppression is active or the window has expired.
	 *
	 * @param notePath - Vault-relative path of the note.
	 * @returns `true` to skip hook dispatch; `false` to allow.
	 */
	checkAndConsume(notePath: string): boolean {
		const ts = this.suppressions.get(notePath);
		if (ts === undefined) return false;

		const age = Date.now() - ts;
		if (age > TagChangeSuppressionManager.WINDOW_MS) {
			// Expired — clean up and allow
			this.suppressions.delete(notePath);
			return false;
		}

		// Consume (one-shot) and suppress
		this.suppressions.delete(notePath);
		log.debug("Tag change dispatch suppressed (consumed)", { notePath, ageMs: age });
		return true;
	}

	// ---------------------------------------------------------------------------
	// Cleanup
	// ---------------------------------------------------------------------------

	/**
	 * Register a periodic cleanup interval that prunes entries older than
	 * `WINDOW_MS` to prevent unbounded memory growth.
	 *
	 * Should be called once during plugin initialization using
	 * `this.registerInterval()` so Obsidian manages the timer lifecycle.
	 *
	 * @param registerInterval - Obsidian's `Plugin.registerInterval()` wrapper.
	 * @returns The interval ID returned by `registerInterval`.
	 */
	startCleanup(
		registerInterval: (callback: () => void, ms: number) => number
	): number {
		return registerInterval(() => {
			this.prune();
		}, TagChangeSuppressionManager.CLEANUP_INTERVAL_MS);
	}

	/**
	 * Clear all internal state. Called on plugin unload.
	 */
	destroy(): void {
		this.suppressions.clear();
		log.debug("TagChangeSuppressionManager destroyed");
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Remove entries that have exceeded the suppression window.
	 */
	private prune(): void {
		const cutoff = Date.now() - TagChangeSuppressionManager.WINDOW_MS;
		let pruned = 0;

		for (const [path, ts] of this.suppressions) {
			if (ts < cutoff) {
				this.suppressions.delete(path);
				pruned++;
			}
		}

		if (pruned > 0) {
			log.debug("Pruned stale tag suppression entries", { pruned });
		}
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw tag array to a lowercase Set.
 *
 * `parseFrontMatterTags()` returns strings that may or may not have a
 * leading `#`. We strip any `#`, trim whitespace, and lowercase for
 * consistent comparison.
 *
 * @param rawTags - Array of raw tag strings from `parseFrontMatterTags()`.
 * @returns Normalized lowercase tag Set.
 */
function normalizeTagSet(rawTags: string[]): Set<string> {
	return new Set<string>(
		rawTags.map((t) => t.replace(/^#/, "").trim().toLowerCase())
	);
}

// Re-export TFile for convenience (used by callers registering vault handlers)
export type { TFile };
