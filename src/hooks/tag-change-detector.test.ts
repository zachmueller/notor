/** TagShadowCache.rebuild — a fresh baseline when the tag-change listener (re)starts. */

import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/logger", () => {
	const noop = () => undefined;
	return { logger: () => ({ debug: noop, info: noop, warn: noop, error: noop }) };
});
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<typeof import("obsidian")>()),
	parseFrontMatterTags: (fm: { tags?: string[] } | undefined) => fm?.tags ?? null,
}));

import { TagShadowCache } from "./tag-change-detector";

function app(notes: Record<string, string[]>) {
	return {
		vault: { getMarkdownFiles: () => Object.keys(notes).map((path) => ({ path })) },
		metadataCache: { getFileCache: (f: { path: string }) => ({ frontmatter: { tags: notes[f.path] } }) },
	} as never;
}

describe("TagShadowCache.rebuild", () => {
	it("replaces stale entries with the current metadata", () => {
		const cache = new TagShadowCache();
		cache.initialize(app({ "a.md": ["one"], "gone.md": ["x"] }));
		cache.updateTags("a.md", new Set(["stale"]));

		cache.rebuild(app({ "a.md": ["two"] }));
		expect([...cache.getTags("a.md")]).toEqual(["two"]);
		expect([...cache.getTags("gone.md")]).toEqual([]);
	});
});
