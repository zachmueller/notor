import { describe, it, expect, vi } from "vitest";
import type { Vault } from "obsidian";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { PromptOverrideFile, stripFrontmatter } from "./prompt-override-file";

function fakeVault(files: Record<string, string> = {}): { vault: Vault; files: Record<string, string>; dirs: Set<string> } {
	const dirs = new Set<string>();
	const adapter = {
		exists: async (p: string) => p in files || dirs.has(p),
		read: async (p: string) => {
			if (!(p in files)) throw new Error(`ENOENT ${p}`);
			return files[p]!;
		},
		write: async (p: string, content: string) => {
			files[p] = content;
		},
		mkdir: async (p: string) => {
			dirs.add(p);
		},
	};
	return { vault: { adapter } as unknown as Vault, files, dirs };
}

const opts = {
	path: "notor/prompts/voice-input-cleanup.md",
	defaultText: "DEFAULT PROMPT",
	description: "Voice clean-up prompt",
	notes: "Edit me.",
};

describe("stripFrontmatter", () => {
	it("removes a leading YAML block and leaves other content alone", () => {
		expect(stripFrontmatter("---\na: 1\n---\nbody\n")).toBe("body\n");
		expect(stripFrontmatter("no frontmatter")).toBe("no frontmatter");
		expect(stripFrontmatter("---\nunterminated")).toBe("---\nunterminated");
	});
});

describe("PromptOverrideFile", () => {
	it("returns the default when the file is missing or blank", async () => {
		const { vault, files } = fakeVault();
		const file = new PromptOverrideFile(vault, opts);
		expect(await file.exists()).toBe(false);
		expect(await file.read()).toEqual({ text: "DEFAULT PROMPT", source: "default" });
		files[opts.path] = "---\ndescription: x\n---\n\n   \n";
		expect(await file.read()).toEqual({ text: "DEFAULT PROMPT", source: "default" });
	});

	it("returns the trimmed, frontmatter-stripped file text when present", async () => {
		const { vault } = fakeVault({ [opts.path]: "---\ndescription: x\n---\n\n<!--\nnotes\n-->\n\nCUSTOM\n" });
		const file = new PromptOverrideFile(vault, opts);
		expect(await file.read()).toEqual({ text: "<!--\nnotes\n-->\n\nCUSTOM", source: "file" });
	});

	it("writes the default with frontmatter and notes, creating the folder", async () => {
		const { vault, files, dirs } = fakeVault();
		const file = new PromptOverrideFile(vault, opts);
		expect(await file.writeDefault()).toBe(opts.path);
		expect(dirs.has("notor/prompts")).toBe(true);
		expect(files[opts.path]).toBe("---\ndescription: Voice clean-up prompt\n---\n\n<!--\nEdit me.\n-->\n\nDEFAULT PROMPT\n");
		// Round-trips: the exported default reads back as a file override with identical text after the comment.
		const read = await file.read();
		expect(read.source).toBe("file");
		expect(read.text.endsWith("DEFAULT PROMPT")).toBe(true);
	});

	it("falls back to the default when reading throws", async () => {
		const vault = { adapter: { exists: async () => true, read: async () => { throw new Error("io"); } } } as unknown as Vault;
		const file = new PromptOverrideFile(vault, opts);
		expect(await file.read()).toEqual({ text: "DEFAULT PROMPT", source: "default" });
	});
});
