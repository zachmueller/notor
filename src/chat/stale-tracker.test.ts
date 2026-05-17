import { describe, it, expect, beforeEach } from "vitest";
import { StaleContentTracker } from "./stale-tracker";

const FM_NOTE = `---
title: Test
status: draft
---
Body content here.
`;

const FM_NOTE_CHANGED_FM = `---
title: Test
status: done
tags:
  - updated
---
Body content here.
`;

const FM_NOTE_CHANGED_BODY = `---
title: Test
status: draft
---
Body content has been modified.
`;

const NO_FM_NOTE = "Just body content, no frontmatter.";
const NO_FM_NOTE_CHANGED = "Different body content entirely.";

describe("StaleContentTracker", () => {
	let tracker: StaleContentTracker;

	beforeEach(() => {
		tracker = new StaleContentTracker();
	});

	describe("check() — fast path", () => {
		it("returns fresh when content is unchanged", () => {
			tracker.recordRead("note.md", FM_NOTE);
			const result = tracker.check("note.md", FM_NOTE);
			expect(result.isStale).toBe(false);
			expect(result.error).toBeNull();
		});

		it("returns fresh for untracked notes", () => {
			const result = tracker.check("unknown.md", "anything");
			expect(result.isStale).toBe(false);
		});
	});

	describe("check() — body hash fallback", () => {
		it("returns fresh when only frontmatter changed", () => {
			tracker.recordRead("note.md", FM_NOTE);
			const result = tracker.check("note.md", FM_NOTE_CHANGED_FM);
			expect(result.isStale).toBe(false);
			expect(result.error).toBeNull();
		});

		it("returns stale when body content changed", () => {
			tracker.recordRead("note.md", FM_NOTE);
			const result = tracker.check("note.md", FM_NOTE_CHANGED_BODY);
			expect(result.isStale).toBe(true);
			expect(result.error).toContain("has changed since last read");
		});

		it("returns stale when body changed in note without frontmatter", () => {
			tracker.recordRead("note.md", NO_FM_NOTE);
			const result = tracker.check("note.md", NO_FM_NOTE_CHANGED);
			expect(result.isStale).toBe(true);
		});

		it("updates stored content after frontmatter-only change so next check hits fast path", () => {
			tracker.recordRead("note.md", FM_NOTE);
			tracker.check("note.md", FM_NOTE_CHANGED_FM);

			// Second check with same content should hit fast path (no hash computation)
			const result = tracker.check("note.md", FM_NOTE_CHANGED_FM);
			expect(result.isStale).toBe(false);
		});
	});

	describe("updateAfterFrontmatterWrite()", () => {
		it("updates stored content while preserving body hash", () => {
			tracker.recordRead("note.md", FM_NOTE);

			// Trigger hash computation
			tracker.check("note.md", FM_NOTE_CHANGED_FM);

			// Simulate frontmatter write
			tracker.updateAfterFrontmatterWrite("note.md", FM_NOTE_CHANGED_FM);

			// Fast path should now pass
			const result = tracker.check("note.md", FM_NOTE_CHANGED_FM);
			expect(result.isStale).toBe(false);
		});

		it("no-ops for untracked notes", () => {
			// Should not throw
			tracker.updateAfterFrontmatterWrite("unknown.md", FM_NOTE);
			expect(tracker.hasBeenRead("unknown.md")).toBe(false);
		});
	});

	describe("updateAfterWrite()", () => {
		it("replaces stored content entirely", () => {
			tracker.recordRead("note.md", FM_NOTE);
			tracker.updateAfterWrite("note.md", FM_NOTE_CHANGED_BODY);

			// Should pass fast path with the new content
			const result = tracker.check("note.md", FM_NOTE_CHANGED_BODY);
			expect(result.isStale).toBe(false);
		});
	});

	describe("serialize() and restore()", () => {
		it("round-trips stale state", () => {
			tracker.recordRead("a.md", FM_NOTE);
			tracker.recordRead("b.md", NO_FM_NOTE);

			const serialized = tracker.serialize();
			expect(serialized).toHaveLength(2);
			expect(serialized[0]!.note_path).toBe("a.md");
			expect(serialized[0]!.body_hash).toBeTruthy();
			expect(serialized[1]!.note_path).toBe("b.md");

			// Restore into a fresh tracker
			const tracker2 = new StaleContentTracker();
			tracker2.restore(serialized);

			// Frontmatter-only change should still pass via body hash
			const result = tracker2.check("a.md", FM_NOTE_CHANGED_FM);
			expect(result.isStale).toBe(false);

			// Body change should still detect stale
			const result2 = tracker2.check("b.md", NO_FM_NOTE_CHANGED);
			expect(result2.isStale).toBe(true);
		});

		it("restored entries use hash path (empty sentinel forces mismatch)", () => {
			tracker.recordRead("note.md", FM_NOTE);
			const serialized = tracker.serialize();

			const tracker2 = new StaleContentTracker();
			tracker2.restore(serialized);

			// Same content as original — fast path fails (empty sentinel),
			// but body hash should match
			const result = tracker2.check("note.md", FM_NOTE);
			expect(result.isStale).toBe(false);
		});
	});

	describe("clear()", () => {
		it("removes all entries", () => {
			tracker.recordRead("a.md", FM_NOTE);
			tracker.recordRead("b.md", NO_FM_NOTE);
			tracker.clear();

			expect(tracker.hasBeenRead("a.md")).toBe(false);
			expect(tracker.hasBeenRead("b.md")).toBe(false);
		});
	});

	describe("invalidate()", () => {
		it("removes tracking for a specific path", () => {
			tracker.recordRead("a.md", FM_NOTE);
			tracker.invalidate("a.md");
			expect(tracker.hasBeenRead("a.md")).toBe(false);
		});
	});
});
