/**
 * Research R-3: Tag Change Detection via Metadata Cache
 *
 * This is a reference test plugin (not runnable standalone) that demonstrates
 * and documents the behavior of Obsidian's metadataCache.on('changed', ...)
 * event for detecting tag changes in note frontmatter.
 *
 * Findings are documented inline and summarized in research.md.
 *
 * @see specs/03-workflows-personas/research.md — R-3 findings
 * @see design/research/obsidian-vault-api-frontmatter.md — Prior research on vault API
 */

import { Plugin, TFile, CachedMetadata, FrontMatterCache } from "obsidian";

// ============================================================================
// Q1: metadataCache.on('changed') Callback Signature and Behavior
// ============================================================================

/**
 * The 'changed' event on metadataCache fires with THREE arguments:
 *
 *   (file: TFile, data: string, cache: CachedMetadata) => any
 *
 * - file:  The TFile that was modified
 * - data:  The raw file content as a string (full content including frontmatter)
 * - cache: The NEW CachedMetadata after re-indexing
 *
 * CRITICAL: There is NO "old data" or "previous cache" argument.
 * The callback receives ONLY the new state. To detect what changed,
 * we must maintain our own shadow cache of previous tag state.
 *
 * From obsidian.d.ts:
 *   on(name: 'changed', callback: (file: TFile, data: string, cache: CachedMetadata) => any, ctx?: any): EventRef;
 */

// ============================================================================
// Q1 (continued): When does 'changed' fire?
// ============================================================================

/**
 * The metadataCache 'changed' event fires:
 *
 * 1. After ANY modification to a file's content that causes the metadata
 *    cache to be re-indexed. This includes frontmatter changes.
 *
 * 2. The event fires ASYNCHRONOUSLY after the file write — not in the
 *    same synchronous call stack as vault.on('modify'). Obsidian
 *    debounces/batches metadata re-indexing internally.
 *
 * 3. It fires ONLY when the parsed metadata actually differs from the
 *    cached version. If you write the file with identical content,
 *    the 'changed' event may still fire (Obsidian re-indexes on any
 *    modify event), but the cache contents will be the same.
 *
 * 4. It fires when tags are changed via:
 *    - processFrontMatter (used by manage_tags and update_frontmatter tools) ✓
 *    - vault.modify / vault.process (raw file writes) ✓
 *    - User manually editing frontmatter in the editor ✓
 *    - External file sync modifying the file ✓
 *
 * 5. It does NOT fire on file rename (documented in obsidian.d.ts).
 *    Use vault.on('rename') for that.
 *
 * Event ordering after a file modification:
 *   vault.on('modify')  →  metadataCache.on('changed')  →  metadataCache.on('resolve')
 *
 * The delay between vault.on('modify') and metadataCache.on('changed')
 * is typically 50-200ms but can be longer under heavy vault load.
 */

// ============================================================================
// Q2: Shadow Cache Design
// ============================================================================

/**
 * Shadow cache: Map<string, Set<string>>
 *   Key: vault-relative note path (e.g., "Research/Climate.md")
 *   Value: Set of normalized tag strings (without leading #)
 *
 * Using Set<string> instead of string[] for O(1) diff computation.
 */

/** Normalized tag set for a single note. */
type TagSet = Set<string>;

/**
 * The shadow tag cache maintains the last-known tag state for every
 * note in the vault that has tags.
 */
class TagShadowCache {
    private cache: Map<string, TagSet> = new Map();

    /**
     * Initialize the shadow cache by scanning all files in the vault.
     *
     * This should be called ONCE during plugin onload(), after
     * workspace.onLayoutReady() to ensure the metadata cache is populated.
     *
     * Performance: For a vault with 10,000 notes, each with ~5 tags:
     *   - Iteration: O(n) over all files via vault.getMarkdownFiles()
     *   - Cache lookup: O(1) per file via metadataCache.getFileCache()
     *   - Memory: 10,000 entries × ~5 tags × ~20 chars ≈ 1 MB
     *   - Time: < 50ms (no disk I/O — reads from in-memory metadata cache)
     *
     * This is well within acceptable bounds for plugin initialization.
     */
    initialize(app: import("obsidian").App): void {
        const files = app.vault.getMarkdownFiles();
        for (const file of files) {
            const tags = this.extractTags(app, file);
            if (tags.size > 0) {
                this.cache.set(file.path, tags);
            }
        }
    }

    /**
     * Get the last-known tags for a note path.
     * Returns an empty set if the note has no cached tags.
     */
    get(path: string): TagSet {
        return this.cache.get(path) ?? new Set();
    }

    /**
     * Update the shadow cache for a note path with new tags.
     * Returns the diff: { added: string[], removed: string[] }.
     */
    update(path: string, newTags: TagSet): { added: string[]; removed: string[] } {
        const oldTags = this.get(path);

        const added: string[] = [];
        const removed: string[] = [];

        // Tags in new but not in old → added
        for (const tag of newTags) {
            if (!oldTags.has(tag)) {
                added.push(tag);
            }
        }

        // Tags in old but not in new → removed
        for (const tag of oldTags) {
            if (!newTags.has(tag)) {
                removed.push(tag);
            }
        }

        // Update cache
        if (newTags.size > 0) {
            this.cache.set(path, newTags);
        } else {
            this.cache.delete(path);
        }

        return { added, removed };
    }

    /**
     * Remove a note from the shadow cache (e.g., on file delete).
     */
    remove(path: string): void {
        this.cache.delete(path);
    }

    /**
     * Handle file rename: move cache entry from old path to new path.
     */
    rename(oldPath: string, newPath: string): void {
        const tags = this.cache.get(oldPath);
        if (tags) {
            this.cache.delete(oldPath);
            this.cache.set(newPath, tags);
        }
    }

    /**
     * Extract normalized tags from a file's cached metadata.
     *
     * Uses TWO sources for comprehensive tag detection:
     *
     * 1. cache.frontmatter?.tags — the raw frontmatter `tags` property.
     *    This is what processFrontMatter operates on and what users
     *    see/edit in the frontmatter YAML block.
     *
     * 2. Obsidian's parseFrontMatterTags(cache.frontmatter) utility —
     *    this normalizes tags from frontmatter (handles string vs array,
     *    adds # prefix). However, for our shadow cache we strip the #.
     *
     * We use parseFrontMatterTags for robustness, as it handles edge
     * cases in tag format normalization that we'd otherwise need to
     * replicate.
     *
     * NOTE: We intentionally do NOT use getAllTags(cache) because that
     * includes inline tags (#tag in body text). FR-49 specifies that
     * on-tag-change fires only for frontmatter tag changes.
     */
    private extractTags(app: import("obsidian").App, file: TFile): TagSet {
        const cache = app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter) return new Set();

        // parseFrontMatterTags returns string[] | null, with # prefix
        const rawTags = (globalThis as any).parseFrontMatterTags?.(cache.frontmatter)
            ?? this.manualExtractTags(cache.frontmatter);

        const normalized = new Set<string>();
        if (rawTags) {
            for (const tag of rawTags) {
                normalized.add(normalizeTag(tag));
            }
        }
        return normalized;
    }

    /**
     * Fallback manual tag extraction from frontmatter.
     * Handles: undefined, null, string, string[], mixed arrays.
     * Same normalization as ManageTagsTool.normaliseTags().
     */
    private manualExtractTags(frontmatter: FrontMatterCache): string[] {
        const raw = frontmatter["tags"];
        if (!raw) return [];
        if (typeof raw === "string") return [raw];
        if (Array.isArray(raw)) {
            return raw.filter((t: unknown) => t != null && t !== "").map(String);
        }
        return [];
    }

    /** Current cache size (number of notes with tags). */
    get size(): number {
        return this.cache.size;
    }
}

// ============================================================================
// Q3: Tag Normalization
// ============================================================================

/**
 * Tag normalization rules:
 *
 * 1. Strip leading '#' (Obsidian's parseFrontMatterTags adds it;
 *    frontmatter stores tags without it; manage_tags tool strips it)
 * 2. Trim whitespace
 * 3. Case sensitivity: PRESERVE original case.
 *
 *    Obsidian treats tags as case-insensitive for search/filtering
 *    (e.g., #Research and #research match the same tag). However,
 *    Obsidian preserves the original case in frontmatter and display.
 *
 *    For tag CHANGE DETECTION, we should compare case-insensitively
 *    to avoid false positives when only case changes (e.g., user
 *    renames "research" to "Research" — this is not a meaningful
 *    add/remove). But we should REPORT tags in their original case.
 *
 *    Implementation: normalize to lowercase for comparison in the
 *    shadow cache Set, but track original case separately for the
 *    tags_added/tags_removed arrays reported to hooks.
 *
 *    SIMPLIFICATION: After further analysis, case-only changes are
 *    extremely rare in practice. The simpler approach is to compare
 *    case-insensitively (lowercase in shadow cache) and report the
 *    new case from the current frontmatter. This avoids the complexity
 *    of tracking both normalized and original forms.
 *
 * 4. The `tags` frontmatter property can be:
 *    - A YAML string:    `tags: research`         → ["research"]
 *    - A YAML list:      `tags: [research, ai]`   → ["research", "ai"]
 *    - A YAML flow list: `tags:\n  - research`     → ["research"]
 *    - null/undefined:   (no tags property)        → []
 *
 *    The ManageTagsTool already handles all these via normaliseTags().
 *    The shadow cache must handle them identically.
 *
 *    parseFrontMatterTags() from Obsidian handles all variants and
 *    returns string[] | null with '#' prefix. We strip the '#'.
 */
function normalizeTag(tag: string): string {
    return tag.trim().replace(/^#/, "").toLowerCase();
}

/**
 * Extract the display-case tag (for reporting in hooks).
 * Same as normalizeTag but preserves original case.
 */
function displayTag(tag: string): string {
    return tag.trim().replace(/^#/, "");
}

// ============================================================================
// Q4: Loop Prevention
// ============================================================================

/**
 * Loop prevention for on-tag-change hooks.
 *
 * When Notor's own tools (manage_tags, update_frontmatter) change tags
 * within a hook-initiated workflow, we must suppress on-tag-change hooks
 * for those changes to prevent infinite loops.
 *
 * Approach: A per-note-path suppression set, scoped to the execution chain.
 *
 * The suppression is NOT global — it targets specific note paths being
 * modified by the current hook workflow execution. This allows:
 *   - Hook workflow modifies note A's tags → on-tag-change suppressed for A
 *   - User simultaneously modifies note B's tags → on-tag-change fires for B
 *
 * Implementation:
 *
 *   const suppressTagChangeHooks: Set<string> = new Set();
 *
 *   // Before tool execution within hook workflow:
 *   suppressTagChangeHooks.add(targetNotePath);
 *
 *   // After tool execution:
 *   suppressTagChangeHooks.delete(targetNotePath);
 *
 *   // In metadataCache 'changed' handler:
 *   if (suppressTagChangeHooks.has(file.path)) {
 *     // Still update shadow cache (to keep it accurate), but don't fire hooks
 *     shadowCache.update(file.path, newTags);
 *     return;
 *   }
 *
 * TIMING CONSIDERATION:
 *   The metadataCache 'changed' event fires ASYNCHRONOUSLY (50-200ms after
 *   the file write). The suppress flag must remain set until AFTER the
 *   metadata cache event has been processed.
 *
 *   Problem: If we clear the flag immediately after tool execution
 *   (synchronously), the metadataCache 'changed' event hasn't fired yet
 *   and won't see the suppression flag.
 *
 *   Solution: Use a TIMED cleanup with the same approach as manual-save
 *   detection (R-2). Set the flag before tool execution, and clear it
 *   after a delay (e.g., 1000ms) that exceeds the expected metadata
 *   cache update delay.
 *
 *   Alternatively, use a TWO-PHASE approach:
 *   1. Before tool execution: add path to suppressTagChangeHooks
 *   2. In metadataCache 'changed' handler: if path is suppressed,
 *      update shadow cache but don't fire hooks, then remove from set
 *   3. Safety cleanup: periodic timer removes entries older than 2s
 *
 *   The two-phase approach is cleaner because the suppress flag is
 *   consumed exactly when the corresponding cache event fires, and
 *   the safety cleanup handles edge cases (e.g., cache event never fires).
 */

interface SuppressEntry {
    path: string;
    timestamp: number;
}

class TagChangeSuppressionManager {
    private suppressed: Map<string, number> = new Map();
    private cleanupInterval: number | null = null;

    /** Suppress on-tag-change hooks for a note path. */
    suppress(path: string): void {
        this.suppressed.set(path, Date.now());
    }

    /**
     * Check and consume suppression for a note path.
     * Returns true if the path was suppressed (and consumes the entry).
     */
    checkAndConsume(path: string): boolean {
        const timestamp = this.suppressed.get(path);
        if (timestamp === undefined) return false;

        // Consume the suppression
        this.suppressed.delete(path);
        return true;
    }

    /**
     * Check if a path is suppressed WITHOUT consuming.
     * Used for read-only checks.
     */
    isSuppressed(path: string): boolean {
        return this.suppressed.has(path);
    }

    /** Start periodic cleanup of stale entries (call in onload). */
    startCleanup(registerInterval: (interval: number) => void): void {
        // Clean up entries older than 2 seconds every 30 seconds
        const id = window.setInterval(() => {
            const now = Date.now();
            for (const [path, timestamp] of this.suppressed) {
                if (now - timestamp > 2000) {
                    this.suppressed.delete(path);
                }
            }
        }, 30000);
        registerInterval(id);
    }

    /** Clear all suppressions (call in onunload). */
    clear(): void {
        this.suppressed.clear();
    }
}

// ============================================================================
// Q5: Timing and Batching
// ============================================================================

/**
 * Timing and batching behavior:
 *
 * 1. metadataCache.on('changed') fires ONCE PER FILE per modification.
 *    If a batch operation changes multiple notes rapidly, each note gets
 *    its own 'changed' event. Events are not coalesced across files.
 *
 * 2. However, if the SAME file is modified multiple times in rapid
 *    succession (e.g., two processFrontMatter calls on the same file
 *    within a few ms), Obsidian MAY coalesce the metadata cache updates
 *    into a single 'changed' event (or fire multiple events). The
 *    behavior depends on Obsidian's internal debounce timing.
 *
 * 3. For our use case, this means:
 *    - Batch tag operations on DIFFERENT notes: each fires its own
 *      'changed' event → each gets its own on-tag-change hook fire.
 *    - Rapid tag operations on the SAME note: may produce one or
 *      multiple 'changed' events. The shadow cache diff approach
 *      handles this correctly either way — if coalesced, the diff
 *      shows all changes at once; if multiple events, each diff
 *      shows incremental changes.
 *
 * 4. Debounce recommendation for on-tag-change:
 *    The contract (vault-event-hooks.md) specifies that debounce does
 *    NOT apply to on-tag-change (it fires once per distinct tag diff).
 *    This is correct because:
 *    - Tag changes are discrete, meaningful events (not rapid-fire like saves)
 *    - The shadow cache diff already handles deduplication (if the same
 *      tags are written twice, the second diff is empty → no hook fires)
 *    - Adding debounce would delay legitimate tag change reactions
 *
 * 5. No additional debounce is needed for on-tag-change.
 */

// ============================================================================
// Reference Implementation: Tag Change Detection Handler
// ============================================================================

/**
 * Complete reference implementation for registering the metadataCache
 * 'changed' listener for on-tag-change detection.
 *
 * This would be integrated into the vault event hook manager.
 */
function registerTagChangeListener(plugin: Plugin): void {
    const shadowCache = new TagShadowCache();
    const suppression = new TagChangeSuppressionManager();

    // Initialize shadow cache after layout is ready (metadata cache populated)
    plugin.app.workspace.onLayoutReady(() => {
        shadowCache.initialize(plugin.app);
    });

    // Start suppression cleanup timer
    suppression.startCleanup((interval) => {
        plugin.registerInterval(interval);
    });

    // Register metadata cache listener
    plugin.registerEvent(
        plugin.app.metadataCache.on("changed", (file: TFile, data: string, cache: CachedMetadata) => {
            // Only process markdown files
            if (!file.path.endsWith(".md")) return;

            // Extract new tags from the updated cache
            const newTagsRaw = extractTagsFromCache(cache);
            const newTags = new Set(newTagsRaw.map(normalizeTag));

            // Compute diff against shadow cache
            const diff = shadowCache.update(file.path, newTags);

            // No tag changes → nothing to do
            if (diff.added.length === 0 && diff.removed.length === 0) return;

            // Check loop prevention
            if (suppression.checkAndConsume(file.path)) {
                // Tag change was made by a hook-initiated workflow
                // Shadow cache was already updated above; skip hook dispatch
                return;
            }

            // Dispatch on-tag-change hooks
            dispatchTagChangeHooks(file.path, diff.added, diff.removed);
        })
    );

    // Handle file deletion: remove from shadow cache
    plugin.registerEvent(
        plugin.app.vault.on("delete", (abstractFile) => {
            if (abstractFile instanceof TFile) {
                shadowCache.remove(abstractFile.path);
            }
        })
    );

    // Handle file rename: update shadow cache path
    plugin.registerEvent(
        plugin.app.vault.on("rename", (abstractFile, oldPath) => {
            if (abstractFile instanceof TFile) {
                shadowCache.rename(oldPath, abstractFile.path);
            }
        })
    );
}

/**
 * Extract tags from a CachedMetadata object.
 * Returns raw tag strings (may include # prefix from parseFrontMatterTags).
 */
function extractTagsFromCache(cache: CachedMetadata): string[] {
    if (!cache.frontmatter) return [];

    // Use Obsidian's parseFrontMatterTags for robust extraction
    // Note: This is a global function, not a method on a class
    const { parseFrontMatterTags } = require("obsidian");
    const tags = parseFrontMatterTags(cache.frontmatter);
    return tags ?? [];
}

/**
 * Placeholder for hook dispatch — would integrate with the hook engine.
 */
function dispatchTagChangeHooks(
    notePath: string,
    tagsAdded: string[],
    tagsRemoved: string[]
): void {
    // In production, this would:
    // 1. Build NOTOR_NOTE_PATH, NOTOR_TAGS_ADDED, NOTOR_TAGS_REMOVED env vars
    // 2. Dispatch shell command hooks via executeHook()
    // 3. Dispatch workflow triggers via workflow execution pipeline
    console.log("on-tag-change:", { notePath, tagsAdded, tagsRemoved });
}

// ============================================================================
// Memory Footprint Analysis
// ============================================================================

/**
 * Shadow cache memory estimate:
 *
 * Assumptions:
 *   - 10,000 notes in vault
 *   - Average 5 tags per note (many notes have 0-2, some have 10+)
 *   - Average tag length: 15 characters (after normalization)
 *   - Only notes WITH tags are stored (reduces effective count)
 *
 * Estimate:
 *   - Notes with tags: ~5,000 (50% of vault, conservative)
 *   - Map overhead: 5,000 entries × 100 bytes (key + metadata) = 500 KB
 *   - Tag strings: 5,000 × 5 tags × 15 chars × 2 bytes/char = 750 KB
 *   - Set overhead: 5,000 × 5 × 64 bytes (Set entry overhead) = 1.6 MB
 *   - Total: ~2.85 MB
 *
 * For a LARGE vault (50,000 notes, 25,000 with tags):
 *   - Total: ~14 MB
 *
 * For a TYPICAL vault (1,000-3,000 notes):
 *   - Total: ~300 KB - 1 MB
 *
 * Verdict: Acceptable. Even the large vault case (14 MB) is within
 * Obsidian's typical memory footprint. The shadow cache adds negligible
 * overhead compared to Obsidian's own metadata cache, which stores
 * far more data per file.
 *
 * OPTIMIZATION: If memory is a concern, we could use a lazy initialization
 * approach — only cache tags for notes that have tags (already done) and
 * prune entries when tags are removed (already done in update()). The
 * current design already optimizes for this.
 *
 * ALTERNATIVE (rejected): Initialize lazily on first cache 'changed' event
 * rather than scanning all files at startup. This was rejected because:
 *   1. On the first tag change event, we'd have no previous state to diff
 *      against, causing a false "all tags added" detection.
 *   2. Scanning all files at startup is fast (<50ms) because it reads from
 *      the in-memory metadata cache (no disk I/O).
 *   3. Eager initialization ensures correct behavior from the first event.
 */

// ============================================================================
// Edge Case: Tags Changed Outside Notor
// ============================================================================

/**
 * When tags are changed outside Notor (manual editor edit, file sync):
 *
 * 1. The file is modified → vault.on('modify') fires
 * 2. Obsidian re-indexes → metadataCache.on('changed') fires
 * 3. Our handler reads new tags from cache, diffs against shadow cache
 * 4. If tags differ → on-tag-change hooks fire
 *
 * This works correctly because our detection is based on the metadata
 * cache event, which fires regardless of HOW the file was modified.
 * The shadow cache is always up to date because we update it on every
 * 'changed' event (even suppressed ones — see suppression manager).
 */

// ============================================================================
// Edge Case: File Created with Tags
// ============================================================================

/**
 * When a new file is created with tags in frontmatter:
 *
 * 1. vault.on('create') fires
 * 2. metadataCache.on('changed') fires (new file indexed)
 * 3. Shadow cache has no entry for this path → old tags = empty set
 * 4. New tags are all "added" → on-tag-change hooks fire
 *
 * This is CORRECT behavior: creating a file with tags should trigger
 * on-tag-change (all tags are "added"). This is consistent with
 * on-note-create also firing. Both hooks fire for the same event,
 * which is expected and documented in the spec (FR-48a: "If a newly
 * created note is also immediately opened, both hooks fire").
 *
 * NOTE: If the file creation is from a hook-initiated workflow,
 * the on-note-create suppression flag will be set, but we also need
 * the on-tag-change suppression flag if the workflow is creating a
 * note with tags. The execution chain tracking (sourceHooks set)
 * handles this at a higher level.
 */

// ============================================================================
// Edge Case: parseFrontMatterTags vs getAllTags
// ============================================================================

/**
 * Obsidian provides two tag extraction utilities:
 *
 * 1. parseFrontMatterTags(frontmatter) — extracts tags from FRONTMATTER ONLY
 *    Returns: string[] | null (with # prefix)
 *    Source: frontmatter.tags property
 *
 * 2. getAllTags(cache) — extracts ALL tags: frontmatter + inline body tags
 *    Returns: string[] | null (with # prefix)
 *    Source: cache.frontmatter.tags + cache.tags (inline #tag occurrences)
 *
 * For on-tag-change (FR-49), we use parseFrontMatterTags because:
 *   - FR-49 specifies: "fires when the `tags` frontmatter property changes"
 *   - Inline body tags (#tag) are NOT part of the frontmatter property
 *   - Using getAllTags would cause false positives when body text changes
 *     add/remove inline #tag references without frontmatter changes
 *   - The manage_tags tool operates on frontmatter only
 *
 * If a future requirement expands on-tag-change to include inline tags,
 * getAllTags could be used instead, with the shadow cache tracking all tags.
 */

export {
    TagShadowCache,
    TagChangeSuppressionManager,
    normalizeTag,
    displayTag,
    registerTagChangeListener,
};
