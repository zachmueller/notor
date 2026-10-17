/**
 * Built-in persona rename: `orchestration-creator` → `circuit-creator`.
 * A legacy name keeps resolving, and a user-customized folder under the legacy
 * name is that user's copy of the renamed built-in (no duplicate row).
 */
import { describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import type { Persona } from "../types";
import { BUILTIN_PERSONA_NAMES, BUILTIN_PERSONA_PROFILES, canonicalPersonaName } from "./builtin-personas";
import { discoverPersonas } from "./persona-discovery";

function fakeVault(files: Record<string, string>) {
	const nodes = new Map<string, TFile | TFolder>();
	const folder = (path: string): TFolder => {
		const existing = nodes.get(path);
		if (existing) return existing as TFolder;
		const f = new TFolder();
		f.path = path;
		f.name = path.split("/").pop() ?? path;
		f.children = [];
		nodes.set(path, f);
		if (path.includes("/")) folder(path.slice(0, path.lastIndexOf("/"))).children.push(f);
		return f;
	};
	for (const path of Object.keys(files)) {
		const file = new TFile();
		file.path = path;
		file.name = path.split("/").pop() ?? path;
		file.basename = file.name.replace(/\.md$/, "");
		file.extension = "md";
		nodes.set(path, file);
		folder(path.slice(0, path.lastIndexOf("/"))).children.push(file);
	}
	const vault = {
		getAbstractFileByPath: (p: string) => nodes.get(p.replace(/\/$/, "")) ?? null,
		read: async (f: TFile) => files[f.path] ?? "",
		cachedRead: async (f: TFile) => files[f.path] ?? "",
	} as unknown as import("obsidian").Vault;
	const metadataCache = {
		getFileCache: () => ({ frontmatter: {} }),
	} as unknown as import("obsidian").MetadataCache;
	return { vault, metadataCache };
}

describe("built-in persona aliases", () => {
	it("renames orchestration-creator to circuit-creator", () => {
		expect(BUILTIN_PERSONA_NAMES.has("circuit-creator")).toBe(true);
		expect(BUILTIN_PERSONA_NAMES.has("orchestration-creator")).toBe(false);
		expect(canonicalPersonaName("orchestration-creator")).toBe("circuit-creator");
		expect(canonicalPersonaName("researcher")).toBe("researcher");
	});

	it("the renamed persona can write to both circuit roots", () => {
		const prompt = BUILTIN_PERSONA_PROFILES.get("circuit-creator")!.systemPromptContent;
		expect(prompt).toContain('- "{notor_dir}/circuits/"');
		expect(prompt).toContain('- "{notor_dir}/orchestrations/"');
	});

	it("discovery lists the built-in under its new name when no vault copy exists", async () => {
		const { vault, metadataCache } = fakeVault({});
		const names = (await discoverPersonas(vault, metadataCache, "notor")).map((p) => p.name);
		expect(names).toContain("circuit-creator");
		expect(names).not.toContain("orchestration-creator");
	});

	it("a customized legacy-named folder replaces the built-in (no duplicate)", async () => {
		const { vault, metadataCache } = fakeVault({
			"notor/personas/orchestration-creator/system-prompt.md": "---\n---\nMy customized creator.",
		});
		const names = (await discoverPersonas(vault, metadataCache, "notor")).map((p) => p.name);
		expect(names).toContain("orchestration-creator");
		expect(names).not.toContain("circuit-creator");
	});
});
