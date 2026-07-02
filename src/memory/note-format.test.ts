import { describe, it, expect } from "vitest";
import {
	serializeNote,
	parseNote,
	serializePendingNote,
	parsePendingNote,
	slugifyTitle,
	computeFingerprint,
	assertMemoryPath,
	patchFrontmatterField,
	extractMemoryWikilinks,
} from "./note-format";

describe("serializeNote / parseNote round-trip", () => {
	it("preserves all fields through round-trip", () => {
		const input = {
			title: "Prefer explicit nullability",
			body: "When writing TypeScript, always use explicit null checks.\n\nEvidence from conversation on 2026-04-18.",
			sources: ["chat", "dream"],
			createdAt: "2026-04-18T12:00:00.000Z",
		};

		const serialized = serializeNote(input);
		const parsed = parseNote(serialized);

		expect(parsed.title).toBe(input.title);
		expect(parsed.body).toBe(input.body);
		expect(parsed.sources).toEqual(input.sources);
		expect(parsed.createdAt).toBe(input.createdAt);
		expect(parsed.memoryUpdatedAt).toBeTruthy();
	});

	it("handles empty sources array", () => {
		const serialized = serializeNote({
			title: "Test",
			body: "Body text",
			sources: [],
			createdAt: "2026-04-18T12:00:00.000Z",
		});

		const parsed = parseNote(serialized);
		expect(parsed.sources).toEqual([]);
	});

	it("handles single source", () => {
		const serialized = serializeNote({
			title: "Test",
			body: "Body text",
			sources: ["chat"],
			createdAt: "2026-04-18T12:00:00.000Z",
		});

		const parsed = parseNote(serialized);
		expect(parsed.sources).toEqual(["chat"]);
	});

	it("handles body with multiple paragraphs and special characters", () => {
		const body = "First paragraph.\n\nSecond paragraph with `code` and **bold**.\n\n- A list item\n- Another item";
		const serialized = serializeNote({
			title: "Complex body",
			body,
			sources: ["chat"],
			createdAt: "2026-04-18T12:00:00.000Z",
		});

		const parsed = parseNote(serialized);
		expect(parsed.body).toBe(body);
	});

	it("returns empty fields for markdown without frontmatter", () => {
		const parsed = parseNote("# Just a heading\n\nSome body text");
		expect(parsed.title).toBe("");
		expect(parsed.body).toBe("# Just a heading\n\nSome body text");
		expect(parsed.createdAt).toBe("");
		expect(parsed.sources).toEqual([]);
	});
});

describe("schema_version in memory notes", () => {
	it("serializeNote emits notor-schema: 1 and parseNote reads it back", () => {
		const serialized = serializeNote({ title: "T", body: "B", sources: [], createdAt: "c" });
		expect(serialized).toContain("notor-schema: 1");
		const parsed = parseNote(serialized);
		expect(parsed.schema_version).toBe(1);
	});

	it("serializePendingNote emits notor-schema: 1 and parsePendingNote reads it back", () => {
		const serialized = serializePendingNote({
			title: "T", body: "B", sources: [], createdAt: "c", memoryUpdatedAt: "u",
			approvalState: "pending", originalAction: "create",
		});
		expect(serialized).toContain("notor-schema: 1");
		const parsed = parsePendingNote(serialized);
		expect(parsed.schema_version).toBe(1);
	});

	it("parseNote defaults schema_version to 1 for legacy notes without notor-schema", () => {
		const legacyNote = "---\nnotor-type: memory\nnotor-created-at: t\nnotor-memory-updated-at: t\nnotor-sources: []\n---\n\n# Title\n\nBody\n";
		const parsed = parseNote(legacyNote);
		expect(parsed.schema_version).toBe(1);
	});

	it("parsePendingNote defaults schema_version to 1 for legacy notes", () => {
		const legacyNote = "---\nnotor-type: pending-memory\nnotor-created-at: t\nnotor-memory-updated-at: t\nnotor-sources: []\nnotor-approval-state: pending\nnotor-original-action: create\n---\n\n# Title\n\nBody\n";
		const parsed = parsePendingNote(legacyNote);
		expect(parsed.schema_version).toBe(1);
	});

	it("patchFrontmatterField composes with notor-schema (inserts after last notor-* line)", () => {
		const serialized = serializeNote({ title: "T", body: "B", sources: [], createdAt: "c" });
		const patched = patchFrontmatterField(serialized, "notor-last-useful-at", "2026-07-01T00:00:00Z");
		// schema_version field must still be present after the patch.
		const parsed = parseNote(patched);
		expect(parsed.schema_version).toBe(1);
		expect(parsed.lastUsefulAt).toBe("2026-07-01T00:00:00Z");
	});
});

describe("slugifyTitle", () => {
	it("converts to lowercase kebab-case", () => {
		expect(slugifyTitle("Prefer Explicit Nullability")).toBe("prefer-explicit-nullability");
	});

	it("handles unicode with diacritical marks", () => {
		expect(slugifyTitle("café résumé")).toBe("cafe-resume");
	});

	it("handles special characters", () => {
		expect(slugifyTitle("Auth rewrite (legal, not tech-debt)")).toBe("auth-rewrite-legal-not-tech-debt");
	});

	it("collapses consecutive hyphens", () => {
		expect(slugifyTitle("hello---world")).toBe("hello-world");
	});

	it("trims leading and trailing hyphens", () => {
		expect(slugifyTitle("---leading and trailing---")).toBe("leading-and-trailing");
	});

	it("handles empty string", () => {
		expect(slugifyTitle("")).toBe("");
	});

	it("truncates very long titles to 200 characters", () => {
		const longTitle = "a".repeat(300);
		expect(slugifyTitle(longTitle).length).toBeLessThanOrEqual(200);
	});

	it("handles title with only special characters", () => {
		expect(slugifyTitle("!!!@@@###")).toBe("");
	});

	it("handles numbers", () => {
		expect(slugifyTitle("Phase 3 Design")).toBe("phase-3-design");
	});
});

describe("computeFingerprint", () => {
	it("produces deterministic output", () => {
		const a = computeFingerprint("hello world");
		const b = computeFingerprint("hello world");
		expect(a).toBe(b);
	});

	it("normalizes whitespace", () => {
		const a = computeFingerprint("hello   world");
		const b = computeFingerprint("hello world");
		expect(a).toBe(b);
	});

	it("normalizes case", () => {
		const a = computeFingerprint("Hello World");
		const b = computeFingerprint("hello world");
		expect(a).toBe(b);
	});

	it("normalizes leading/trailing whitespace", () => {
		const a = computeFingerprint("  hello world  ");
		const b = computeFingerprint("hello world");
		expect(a).toBe(b);
	});

	it("returns a hex string", () => {
		const fp = computeFingerprint("test");
		expect(fp).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces different output for different content", () => {
		const a = computeFingerprint("hello");
		const b = computeFingerprint("world");
		expect(a).not.toBe(b);
	});
});

describe("assertMemoryPath", () => {
	it("accepts paths within the memory directory", () => {
		expect(() => assertMemoryPath("notor/memory/note.md", "notor/memory")).not.toThrow();
	});

	it("accepts dotfiles within the memory directory", () => {
		expect(() => assertMemoryPath("notor/memory/.dedup-cache.json", "notor/memory")).not.toThrow();
		expect(() => assertMemoryPath("notor/memory/.dream-cursor.json", "notor/memory")).not.toThrow();
	});

	it("accepts the memory directory itself", () => {
		expect(() => assertMemoryPath("notor/memory", "notor/memory")).not.toThrow();
	});

	it("rejects paths outside the memory directory", () => {
		expect(() => assertMemoryPath("notor/notes/foo.md", "notor/memory")).toThrow(
			/outside memory directory/,
		);
	});

	it("rejects path traversal attempts", () => {
		expect(() => assertMemoryPath("notor/memory/../../secrets.md", "notor/memory")).toThrow();
	});

	it("rejects absolute paths", () => {
		expect(() => assertMemoryPath("/Users/test/notor/memory/note.md", "notor/memory")).toThrow(
			/Absolute paths/,
		);
	});

	it("rejects empty path", () => {
		expect(() => assertMemoryPath("", "notor/memory")).toThrow();
	});

	it("rejects empty memoryDir", () => {
		expect(() => assertMemoryPath("notor/memory/note.md", "")).toThrow();
	});

	it("rejects sibling directory with shared prefix", () => {
		expect(() => assertMemoryPath("notor/memory-archive/note.md", "notor/memory")).toThrow(
			/outside memory directory/,
		);
	});
});

describe("patchFrontmatterField", () => {
	const baseNote = [
		"---",
		"notor-type: memory",
		"notor-created-at: 2026-04-18T12:00:00.000Z",
		"notor-memory-updated-at: 2026-04-18T12:00:00.000Z",
		"notor-sources: [chat]",
		"---",
		"",
		"# My Note",
		"",
		"Body text.",
		"",
	].join("\n");

	it("replaces an existing key in-place without touching other fields", () => {
		const patched = patchFrontmatterField(baseNote, "notor-memory-updated-at", "2026-04-20T00:00:00.000Z");
		expect(patched).toContain("notor-memory-updated-at: 2026-04-20T00:00:00.000Z");
		expect(patched).toContain("notor-created-at: 2026-04-18T12:00:00.000Z");
		expect(patched).toContain("Body text.");
	});

	it("inserts a new key after the last notor-* line when absent", () => {
		const patched = patchFrontmatterField(baseNote, "notor-last-linked-to-at", "2026-04-20T00:00:00.000Z");
		expect(patched).toContain("notor-last-linked-to-at: 2026-04-20T00:00:00.000Z");
		expect(patched).toContain("notor-memory-updated-at: 2026-04-18T12:00:00.000Z");
		expect(patched).toContain("Body text.");
		// The new key should be inside the frontmatter block (before the closing ---)
		const fmEnd = patched.indexOf("\n---\n", 4);
		const keyPos = patched.indexOf("notor-last-linked-to-at");
		expect(keyPos).toBeGreaterThan(0);
		expect(keyPos).toBeLessThan(fmEnd);
	});

	it("returns content unchanged when no frontmatter block is found", () => {
		const plain = "# Just a heading\n\nBody.";
		expect(patchFrontmatterField(plain, "notor-last-useful-at", "2026-04-20T00:00:00.000Z")).toBe(plain);
	});
});

describe("extractMemoryWikilinks", () => {
	const memoryDir = "notor/memory";

	it("extracts links to memory notes", () => {
		const body = "See also [[notor/memory/concept-a]] and [[notor/memory/concept-b]].";
		expect(extractMemoryWikilinks(body, memoryDir)).toEqual([
			"notor/memory/concept-a.md",
			"notor/memory/concept-b.md",
		]);
	});

	it("strips aliases from wikilinks", () => {
		const body = "See [[notor/memory/concept-a|Concept A]].";
		expect(extractMemoryWikilinks(body, memoryDir)).toEqual(["notor/memory/concept-a.md"]);
	});

	it("ignores links outside the memory directory", () => {
		const body = "See [[notor/notes/some-note]] and [[notor/memory/concept-a]].";
		expect(extractMemoryWikilinks(body, memoryDir)).toEqual(["notor/memory/concept-a.md"]);
	});

	it("deduplicates repeated links", () => {
		const body = "[[notor/memory/concept-a]] again [[notor/memory/concept-a]].";
		expect(extractMemoryWikilinks(body, memoryDir)).toEqual(["notor/memory/concept-a.md"]);
	});

	it("appends .md extension when missing", () => {
		const body = "[[notor/memory/concept-a]]";
		const results = extractMemoryWikilinks(body, memoryDir);
		expect(results[0]).toMatch(/\.md$/);
	});

	it("returns empty array when body has no wikilinks", () => {
		expect(extractMemoryWikilinks("No links here.", memoryDir)).toEqual([]);
	});
});
