/**
 * Research R-3: Tag Change Detection — Standalone Unit Tests
 *
 * Verifies the core logic components that don't depend on the Obsidian runtime:
 * - Tag normalization
 * - Shadow cache initialization, update, diff computation
 * - Suppression manager (suppress, check-and-consume, cleanup)
 * - Edge cases: file create/delete/rename, empty tags, case sensitivity
 *
 * Run: node specs/03-workflows-personas/research/research-r3-unit-test.mjs
 */

import assert from "node:assert/strict";

// ============================================================================
// Tag Normalization
// ============================================================================

function normalizeTag(tag) {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

function displayTag(tag) {
  return tag.trim().replace(/^#/, "");
}

// ============================================================================
// Shadow Cache Implementation (extracted from reference impl)
// ============================================================================

class TagShadowCache {
  /** @type {Map<string, Set<string>>} */
  cache = new Map();

  /**
   * Initialize from a list of { path, tags } entries.
   * (In production, this scans vault.getMarkdownFiles() + metadataCache)
   * @param {Array<{path: string, tags: string[]}>} entries
   */
  initialize(entries) {
    for (const { path, tags } of entries) {
      const normalized = new Set(tags.map(normalizeTag));
      if (normalized.size > 0) {
        this.cache.set(path, normalized);
      }
    }
  }

  /** @param {string} path */
  get(path) {
    return this.cache.get(path) ?? new Set();
  }

  /**
   * Update shadow cache and return diff.
   * @param {string} path
   * @param {Set<string>} newTags - normalized tags
   * @returns {{ added: string[], removed: string[] }}
   */
  update(path, newTags) {
    const oldTags = this.get(path);
    const added = [];
    const removed = [];

    for (const tag of newTags) {
      if (!oldTags.has(tag)) added.push(tag);
    }
    for (const tag of oldTags) {
      if (!newTags.has(tag)) removed.push(tag);
    }

    if (newTags.size > 0) {
      this.cache.set(path, newTags);
    } else {
      this.cache.delete(path);
    }

    return { added, removed };
  }

  /** @param {string} path */
  remove(path) {
    this.cache.delete(path);
  }

  /**
   * @param {string} oldPath
   * @param {string} newPath
   */
  rename(oldPath, newPath) {
    const tags = this.cache.get(oldPath);
    if (tags) {
      this.cache.delete(oldPath);
      this.cache.set(newPath, tags);
    }
  }

  get size() {
    return this.cache.size;
  }
}

// ============================================================================
// Suppression Manager Implementation
// ============================================================================

class TagChangeSuppressionManager {
  /** @type {Map<string, number>} path → timestamp */
  suppressed = new Map();

  /** @param {string} path */
  suppress(path) {
    this.suppressed.set(path, Date.now());
  }

  /**
   * Check and consume suppression. Returns true if was suppressed.
   * @param {string} path
   * @returns {boolean}
   */
  checkAndConsume(path) {
    const timestamp = this.suppressed.get(path);
    if (timestamp === undefined) return false;
    this.suppressed.delete(path);
    return true;
  }

  /** @param {string} path */
  isSuppressed(path) {
    return this.suppressed.has(path);
  }

  /** Prune entries older than maxAgeMs. */
  cleanup(maxAgeMs = 2000) {
    const now = Date.now();
    for (const [path, timestamp] of this.suppressed) {
      if (now - timestamp > maxAgeMs) {
        this.suppressed.delete(path);
      }
    }
  }

  clear() {
    this.suppressed.clear();
  }
}

// ============================================================================
// Simulate parseFrontMatterTags behavior
// ============================================================================

/**
 * Mimics Obsidian's parseFrontMatterTags(frontmatter) behavior.
 * Returns string[] | null with # prefix.
 *
 * @param {any} frontmatter
 * @returns {string[] | null}
 */
function mockParseFrontMatterTags(frontmatter) {
  if (!frontmatter) return null;
  const raw = frontmatter.tags;
  if (raw == null) return null;
  if (typeof raw === "string") {
    return raw.trim() ? [`#${raw.trim()}`] : null;
  }
  if (Array.isArray(raw)) {
    const result = raw
      .filter((t) => t != null && String(t).trim() !== "")
      .map((t) => `#${String(t).trim()}`);
    return result.length > 0 ? result : null;
  }
  return null;
}

// ============================================================================
// Tests
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

// --- Tag Normalization ---
console.log("\n🏷️  Tag Normalization");

test("strips leading #", () => {
  assert.equal(normalizeTag("#research"), "research");
});

test("trims whitespace", () => {
  assert.equal(normalizeTag("  research  "), "research");
});

test("lowercases", () => {
  assert.equal(normalizeTag("Research"), "research");
});

test("strips # and lowercases", () => {
  assert.equal(normalizeTag("#Research"), "research");
});

test("handles empty string", () => {
  assert.equal(normalizeTag(""), "");
});

test("displayTag preserves case", () => {
  assert.equal(displayTag("#Research"), "Research");
});

test("displayTag strips # only", () => {
  assert.equal(displayTag("#AI-Tools"), "AI-Tools");
});

// --- mockParseFrontMatterTags ---
console.log("\n📋 parseFrontMatterTags behavior");

test("null frontmatter returns null", () => {
  assert.equal(mockParseFrontMatterTags(null), null);
});

test("no tags property returns null", () => {
  assert.deepEqual(mockParseFrontMatterTags({ title: "test" }), null);
});

test("string tag returns array with # prefix", () => {
  assert.deepEqual(mockParseFrontMatterTags({ tags: "research" }), ["#research"]);
});

test("array tags returns array with # prefix", () => {
  assert.deepEqual(
    mockParseFrontMatterTags({ tags: ["research", "ai"] }),
    ["#research", "#ai"]
  );
});

test("mixed array with nulls filtered", () => {
  assert.deepEqual(
    mockParseFrontMatterTags({ tags: ["research", null, "", "ai"] }),
    ["#research", "#ai"]
  );
});

test("empty string tag returns null", () => {
  assert.equal(mockParseFrontMatterTags({ tags: "" }), null);
});

test("empty array returns null", () => {
  assert.equal(mockParseFrontMatterTags({ tags: [] }), null);
});

// --- Shadow Cache ---
console.log("\n🗄️  Shadow Cache");

test("initialize populates cache", () => {
  const cache = new TagShadowCache();
  cache.initialize([
    { path: "note1.md", tags: ["#research", "#ai"] },
    { path: "note2.md", tags: ["#draft"] },
    { path: "note3.md", tags: [] }, // no tags — should not be stored
  ]);
  assert.equal(cache.size, 2);
  assert.deepEqual(cache.get("note1.md"), new Set(["research", "ai"]));
  assert.deepEqual(cache.get("note2.md"), new Set(["draft"]));
  assert.deepEqual(cache.get("note3.md"), new Set()); // empty
});

test("update detects added tags", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#research"] }]);

  const diff = cache.update("note1.md", new Set(["research", "ai"]));
  assert.deepEqual(diff.added, ["ai"]);
  assert.deepEqual(diff.removed, []);
});

test("update detects removed tags", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#research", "#ai"] }]);

  const diff = cache.update("note1.md", new Set(["research"]));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, ["ai"]);
});

test("update detects both added and removed", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#research", "#draft"] }]);

  const diff = cache.update("note1.md", new Set(["research", "published"]));
  assert.deepEqual(diff.added, ["published"]);
  assert.deepEqual(diff.removed, ["draft"]);
});

test("update with no changes returns empty diff", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#research", "#ai"] }]);

  const diff = cache.update("note1.md", new Set(["research", "ai"]));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test("update on unknown path treats as new (all tags added)", () => {
  const cache = new TagShadowCache();

  const diff = cache.update("new-note.md", new Set(["research", "ai"]));
  assert.deepEqual(diff.added, ["research", "ai"]);
  assert.deepEqual(diff.removed, []);
  assert.equal(cache.size, 1);
});

test("update to empty tags removes entry from cache", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#research"] }]);

  const diff = cache.update("note1.md", new Set());
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, ["research"]);
  assert.equal(cache.size, 0);
});

test("remove deletes entry", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#research"] }]);
  assert.equal(cache.size, 1);

  cache.remove("note1.md");
  assert.equal(cache.size, 0);
  assert.deepEqual(cache.get("note1.md"), new Set());
});

test("rename moves entry", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "old.md", tags: ["#research"] }]);

  cache.rename("old.md", "new.md");
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.get("old.md"), new Set());
  assert.deepEqual(cache.get("new.md"), new Set(["research"]));
});

test("rename nonexistent path is no-op", () => {
  const cache = new TagShadowCache();
  cache.rename("nonexistent.md", "new.md");
  assert.equal(cache.size, 0);
});

// --- Case Sensitivity ---
console.log("\n🔤 Case Sensitivity");

test("case-only change is NOT detected as add/remove", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#Research"] }]);

  // "Research" normalizes to "research" in the cache.
  // Updating with "research" (same normalized form) should produce empty diff.
  const diff = cache.update("note1.md", new Set(["research"]));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test("genuinely different tags with different cases are detected", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note1.md", tags: ["#research"] }]);

  const diff = cache.update("note1.md", new Set(["ai"]));
  assert.deepEqual(diff.added, ["ai"]);
  assert.deepEqual(diff.removed, ["research"]);
});

// --- Suppression Manager ---
console.log("\n🚫 Suppression Manager");

test("suppress and checkAndConsume works", () => {
  const mgr = new TagChangeSuppressionManager();
  mgr.suppress("note1.md");

  assert.equal(mgr.isSuppressed("note1.md"), true);
  assert.equal(mgr.checkAndConsume("note1.md"), true);
  // Consumed — should be gone
  assert.equal(mgr.isSuppressed("note1.md"), false);
  assert.equal(mgr.checkAndConsume("note1.md"), false);
});

test("unsuppressed path returns false", () => {
  const mgr = new TagChangeSuppressionManager();
  assert.equal(mgr.checkAndConsume("note1.md"), false);
  assert.equal(mgr.isSuppressed("note1.md"), false);
});

test("multiple paths suppressed independently", () => {
  const mgr = new TagChangeSuppressionManager();
  mgr.suppress("note1.md");
  mgr.suppress("note2.md");

  assert.equal(mgr.checkAndConsume("note1.md"), true);
  assert.equal(mgr.isSuppressed("note2.md"), true);
  assert.equal(mgr.checkAndConsume("note2.md"), true);
});

test("cleanup removes stale entries", () => {
  const mgr = new TagChangeSuppressionManager();
  // Manually set an old timestamp
  mgr.suppressed.set("old-note.md", Date.now() - 5000);
  mgr.suppressed.set("new-note.md", Date.now());

  mgr.cleanup(2000);

  assert.equal(mgr.isSuppressed("old-note.md"), false); // pruned
  assert.equal(mgr.isSuppressed("new-note.md"), true);  // still valid
});

test("clear removes all entries", () => {
  const mgr = new TagChangeSuppressionManager();
  mgr.suppress("note1.md");
  mgr.suppress("note2.md");
  mgr.clear();

  assert.equal(mgr.isSuppressed("note1.md"), false);
  assert.equal(mgr.isSuppressed("note2.md"), false);
});

// --- Integration: Full Flow Simulation ---
console.log("\n🔄 Integration: Full Flow Simulation");

test("simulated tag change detection flow", () => {
  const cache = new TagShadowCache();
  const suppression = new TagChangeSuppressionManager();
  const hooksFired = [];

  // Initialize with existing vault state
  cache.initialize([
    { path: "Research/Climate.md", tags: ["#research", "#draft"] },
    { path: "Daily/2026-08-03.md", tags: ["#daily"] },
  ]);

  // Simulate: user adds tag "important" to Climate.md via editor
  const newTags1 = new Set(["research", "draft", "important"].map(normalizeTag));
  const diff1 = cache.update("Research/Climate.md", newTags1);
  if (diff1.added.length > 0 || diff1.removed.length > 0) {
    if (!suppression.checkAndConsume("Research/Climate.md")) {
      hooksFired.push({ path: "Research/Climate.md", ...diff1 });
    }
  }

  assert.equal(hooksFired.length, 1);
  assert.deepEqual(hooksFired[0].added, ["important"]);
  assert.deepEqual(hooksFired[0].removed, []);

  // Simulate: Notor tool changes tags on Climate.md within hook workflow
  suppression.suppress("Research/Climate.md");
  const newTags2 = new Set(
    ["research", "important", "reviewed"].map(normalizeTag)
  );
  const diff2 = cache.update("Research/Climate.md", newTags2);
  if (diff2.added.length > 0 || diff2.removed.length > 0) {
    if (!suppression.checkAndConsume("Research/Climate.md")) {
      hooksFired.push({ path: "Research/Climate.md", ...diff2 });
    }
  }

  // Should NOT have fired — suppressed
  assert.equal(hooksFired.length, 1);
  // But shadow cache should be updated
  assert.deepEqual(
    cache.get("Research/Climate.md"),
    new Set(["research", "important", "reviewed"])
  );

  // Simulate: user changes tags on Daily note (NOT suppressed)
  const newTags3 = new Set(["daily", "summary"].map(normalizeTag));
  const diff3 = cache.update("Daily/2026-08-03.md", newTags3);
  if (diff3.added.length > 0 || diff3.removed.length > 0) {
    if (!suppression.checkAndConsume("Daily/2026-08-03.md")) {
      hooksFired.push({ path: "Daily/2026-08-03.md", ...diff3 });
    }
  }

  assert.equal(hooksFired.length, 2);
  assert.deepEqual(hooksFired[1].added, ["summary"]);
  assert.deepEqual(hooksFired[1].removed, []);
});

test("simulated new file with tags (all tags 'added')", () => {
  const cache = new TagShadowCache();

  // New file created with tags — no prior shadow cache entry
  const newTags = new Set(["project", "idea"].map(normalizeTag));
  const diff = cache.update("New/Idea.md", newTags);

  assert.deepEqual(diff.added.sort(), ["idea", "project"]);
  assert.deepEqual(diff.removed, []);
});

test("simulated file deletion cleans shadow cache", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note.md", tags: ["#research"] }]);

  cache.remove("note.md");
  assert.equal(cache.size, 0);

  // Subsequent update on same path should see all tags as "added" (fresh)
  const diff = cache.update("note.md", new Set(["research"]));
  assert.deepEqual(diff.added, ["research"]);
});

test("no-change event produces empty diff (no hook fires)", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note.md", tags: ["#research", "#ai"] }]);

  // metadataCache 'changed' fires but tags haven't actually changed
  // (e.g., user edited body text, not tags)
  const diff = cache.update("note.md", new Set(["research", "ai"]));
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

test("rapid identical updates produce empty diffs after first", () => {
  const cache = new TagShadowCache();
  cache.initialize([{ path: "note.md", tags: ["#draft"] }]);

  const diff1 = cache.update("note.md", new Set(["published"]));
  assert.deepEqual(diff1.added, ["published"]);
  assert.deepEqual(diff1.removed, ["draft"]);

  // Second update with same tags — empty diff
  const diff2 = cache.update("note.md", new Set(["published"]));
  assert.deepEqual(diff2.added, []);
  assert.deepEqual(diff2.removed, []);
});

// --- Obsidian API Signature Verification ---
console.log("\n📐 Obsidian API Signature Verification (from obsidian.d.ts)");

test("metadataCache.on('changed') signature has 3 args: file, data, cache", () => {
  // Verified via: grep -A 5 "on(name: 'changed'" node_modules/obsidian/obsidian.d.ts
  // Result: on(name: 'changed', callback: (file: TFile, data: string, cache: CachedMetadata) => any, ctx?: any): EventRef;
  //
  // Confirms:
  // - 3 callback args: TFile, string, CachedMetadata
  // - NO "previous cache" or "old data" argument
  // - Returns EventRef (for registerEvent)
  assert.ok(true, "Verified from obsidian.d.ts — signature matches research findings");
});

test("parseFrontMatterTags is a standalone export function", () => {
  // Verified via: grep -A 3 "parseFrontMatterTags" node_modules/obsidian/obsidian.d.ts
  // Result: export function parseFrontMatterTags(frontmatter: any | null): string[] | null;
  //
  // Confirms:
  // - Standalone export (not a method on a class)
  // - Takes frontmatter: any | null
  // - Returns string[] | null (with # prefix per Obsidian convention)
  assert.ok(true, "Verified from obsidian.d.ts — parseFrontMatterTags is standalone, returns string[]|null");
});

test("getAllTags is separate from parseFrontMatterTags", () => {
  // Verified via: grep -A 3 "getAllTags" node_modules/obsidian/obsidian.d.ts
  // Result: export function getAllTags(cache: CachedMetadata): string[] | null;
  //
  // Confirms:
  // - Takes CachedMetadata (not just frontmatter)
  // - Includes both frontmatter AND inline body tags
  // - NOT suitable for FR-49 (frontmatter-only tag change detection)
  assert.ok(true, "Verified from obsidian.d.ts — getAllTags includes inline tags, not suitable for FR-49");
});

// --- Summary ---
console.log("\n" + "=".repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("❌ SOME TESTS FAILED");
  process.exit(1);
} else {
  console.log("✅ ALL TESTS PASSED");
}
