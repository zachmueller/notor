/**
 * Persona discovery must not depend on the metadata cache having indexed a
 * persona file — at plugin load it hasn't, and treating the missing cache
 * entry as malformed YAML dropped the persona (and the startup restore then
 * cleared `active_persona`).
 */
import { describe, it, expect, vi } from "vitest";
import { parse as parseYamlReal } from "yaml";

vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<typeof import("obsidian")>()),
	parseYaml: (text: string) => parseYamlReal(text),
}));
vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { TFile, TFolder } from "obsidian";
import type { MetadataCache, Vault } from "obsidian";
import { discoverPersonas } from "./persona-discovery";

const PROMPT_PATH = "notor/personas/writer/system-prompt.md";

const CONTENT = `---
notor-persona-prompt-mode: replace
notor-persona-chip-emoji: "✍️"
---

You write notes.
`;

function makeVault(content: string): Vault {
	const file = Object.assign(new TFile(), { path: PROMPT_PATH, name: "system-prompt.md" });
	const dir = Object.assign(new TFolder(), { path: "notor/personas/writer", name: "writer", children: [file] });
	const root = Object.assign(new TFolder(), { path: "notor/personas", name: "personas", children: [dir] });
	const byPath: Record<string, unknown> = { [root.path]: root, [dir.path]: dir, [file.path]: file };
	return {
		getAbstractFileByPath: (p: string) => byPath[p] ?? null,
		cachedRead: async () => content,
	} as unknown as Vault;
}

function cacheReturning(entry: unknown): MetadataCache {
	return { getFileCache: () => entry } as unknown as MetadataCache;
}

async function discoverWriter(content: string, cacheEntry: unknown) {
	const personas = await discoverPersonas(makeVault(content), cacheReturning(cacheEntry), "notor/");
	return personas.find((p) => p.name === "writer");
}

describe("discoverPersonas — frontmatter source", () => {
	it("uses the metadata cache's frontmatter when the file is indexed", async () => {
		const writer = await discoverWriter(CONTENT, {
			frontmatter: { "notor-persona-prompt-mode": "replace", "notor-persona-chip-emoji": "🧪" },
		});
		expect(writer?.prompt_mode).toBe("replace");
		expect(writer?.chip_emoji).toBe("🧪");
	});

	it("parses frontmatter itself when the file isn't indexed yet", async () => {
		const writer = await discoverWriter(CONTENT, null);
		expect(writer?.prompt_mode).toBe("replace");
		expect(writer?.chip_emoji).toBe("✍️");
		expect(writer?.prompt_content).toBe("You write notes.");
	});

	it("still excludes an indexed file whose frontmatter didn't parse", async () => {
		expect(await discoverWriter(CONTENT, {})).toBeUndefined();
	});

	it("excludes an unindexed file with unparseable frontmatter", async () => {
		expect(await discoverWriter("---\nkey: [unclosed\n---\nBody\n", null)).toBeUndefined();
	});

	it("discovers a persona without frontmatter", async () => {
		expect((await discoverWriter("Just a prompt.\n", null))?.prompt_mode).toBe("append");
	});
});
