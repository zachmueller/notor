/**
 * POL-002 / POL-001 — the first-party reference flows parse + validate under
 * FEAT-002 without error.
 *
 * Feeds each reference flow's `definition.md` + step notes through a fake vault
 * into `FlowDefinitionParser`, asserting it parses (frontmatter mapping + step
 * resolution) and passes the load-time validators (reachable completion,
 * single-subscriber topics, no published-but-unsubscribed non-terminal topic,
 * required-events published). This is the verifiable bar that the
 * orchestration-creator persona (POL-001) emits frontmatter the parser accepts.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — POL-002 / POL-001
 */

import { describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import { FlowDefinitionParser } from "./flow-parser";
import { REFERENCE_FLOWS, materializeReferenceFlows, type ReferenceFlowFs } from "./reference-flows";

/**
 * Build a fake Vault + MetadataCache from a `{ path → rawFileContent }` map. The
 * parser reads frontmatter via `metadataCache.getFileCache()` and the body via
 * `vault.read()` + `getFrontMatterInfo()` — both served from the raw content here.
 */
function buildFakeVault(files: Record<string, string>) {
	const fileObjs = new Map<string, TFile>();
	const folderObjs = new Map<string, TFolder>();

	function ensureFolder(path: string): TFolder {
		let folder = folderObjs.get(path);
		if (!folder) {
			folder = new TFolder();
			folder.path = path;
			folder.name = path.split("/").pop() ?? path;
			folder.children = [];
			folderObjs.set(path, folder);
			if (path !== "") {
				const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
				const parent = ensureFolder(parentPath);
				if (!parent.children.includes(folder)) parent.children.push(folder);
			}
		}
		return folder;
	}

	for (const path of Object.keys(files)) {
		const file = new TFile();
		file.path = path;
		file.name = path.split("/").pop() ?? path;
		file.extension = "md";
		fileObjs.set(path, file);
		const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const parent = ensureFolder(parentPath);
		if (!parent.children.includes(file)) parent.children.push(file);
	}

	/** Parse the YAML frontmatter block of a raw note into a flat record. */
	const parseFrontmatter = (raw: string): Record<string, unknown> | undefined => {
		const m = raw.match(/^---\n([\s\S]*?)\n---/);
		if (!m) return undefined;
		const fm: Record<string, unknown> = {};
		const lines = m[1]!.split("\n");
		let currentKey: string | null = null;
		let listAccum: string[] | null = null;
		const commit = () => {
			if (currentKey && listAccum) fm[currentKey] = listAccum;
			listAccum = null;
		};
		for (const line of lines) {
			if (/^\s*-\s+/.test(line)) {
				const item = line.replace(/^\s*-\s+/, "").trim().replace(/^["']|["']$/g, "");
				(listAccum ??= []).push(item);
				continue;
			}
			const kv = line.match(/^([\w-]+):\s*(.*)$/);
			if (kv) {
				commit();
				currentKey = kv[1]!;
				const rawVal = kv[2]!.trim();
				if (rawVal === "") {
					listAccum = []; // a list follows on subsequent lines
				} else {
					const val = rawVal.replace(/^["']|["']$/g, "");
					fm[currentKey] =
						val === "true" ? true : val === "false" ? false : /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
					currentKey = null;
				}
			}
		}
		commit();
		return fm;
	};

	const vault = {
		getAbstractFileByPath: (path: string) => {
			const n = path.replace(/\/$/, "");
			return fileObjs.get(n) ?? folderObjs.get(n) ?? null;
		},
		read: async (file: TFile) => files[file.path] ?? "",
	} as unknown as import("obsidian").Vault;

	const metadataCache = {
		getFileCache: (file: TFile) => {
			const raw = files[file.path];
			if (raw === undefined) return null;
			return { frontmatter: parseFrontmatter(raw) };
		},
		getFirstLinkpathDest: (linkpath: string, sourcePath: string) => {
			const flowDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
			return fileObjs.get(`${flowDir}/steps/${linkpath}.md`) ?? null;
		},
	} as unknown as import("obsidian").MetadataCache;

	ensureFolder("notor/orchestrations");
	return { vault, metadataCache };
}

/** Materialize the reference flows into an in-memory file map (mirrors the vault adapter). */
async function materializeToMap(): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const fs: ReferenceFlowFs = {
		exists: (p) => Promise.resolve(p in files || Object.keys(files).some((k) => k.startsWith(p + "/"))),
		mkdir: () => Promise.resolve(),
		write: (p, data) => {
			files[p] = data;
			return Promise.resolve();
		},
	};
	await materializeReferenceFlows("notor", fs);
	return files;
}

describe("reference flows (POL-002)", () => {
	it("materializes all three flows with their definition + steps", async () => {
		const files = await materializeToMap();
		for (const flow of REFERENCE_FLOWS) {
			expect(files[`notor/orchestrations/${flow.slug}/definition.md`]).toBeDefined();
			for (const stepFile of Object.keys(flow.steps)) {
				expect(files[`notor/orchestrations/${flow.slug}/steps/${stepFile}`]).toBeDefined();
			}
		}
	});

	it("is edit-preserving — a second materialize never overwrites existing files", async () => {
		const files = await materializeToMap();
		const before = files["notor/orchestrations/code-assist/definition.md"];
		files["notor/orchestrations/code-assist/definition.md"] = "USER EDITED";
		const fs: ReferenceFlowFs = {
			exists: (p) => Promise.resolve(p in files || Object.keys(files).some((k) => k.startsWith(p + "/"))),
			mkdir: () => Promise.resolve(),
			write: (p, data) => {
				files[p] = data;
				return Promise.resolve();
			},
		};
		await materializeReferenceFlows("notor", fs);
		// The user edit survives; the constant did NOT clobber it.
		expect(files["notor/orchestrations/code-assist/definition.md"]).toBe("USER EDITED");
		expect(before).not.toBe("USER EDITED");
	});

	it("each reference flow parses + validates under FlowDefinitionParser (FEAT-002)", async () => {
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new FlowDefinitionParser(vault, metadataCache, "notor");

		for (const flow of REFERENCE_FLOWS) {
			const dir = `notor/orchestrations/${flow.slug}`;
			// parseFlowByDir throws FlowParseError on any load-time validation failure.
			const result = await parser.parseFlowByDir(dir);
			expect(result.flow.name.length).toBeGreaterThan(0);
			expect(result.flow.steps.length).toBeGreaterThan(0);
		}
	});

	it("discovers all three flows via discoverFlows() (the picker path)", async () => {
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new FlowDefinitionParser(vault, metadataCache, "notor");
		const discovered = await parser.discoverFlows();
		const names = discovered.map((p) => p.flow.name).sort();
		expect(names).toEqual(["Code Assist", "Research", "Review"]);
	});

	it("code-assist + research are invocable; review is not", async () => {
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new FlowDefinitionParser(vault, metadataCache, "notor");
		const byName = new Map((await parser.discoverFlows()).map((p) => [p.flow.name, p.flow]));
		expect(byName.get("Code Assist")?.invocable).toBe(true);
		expect(byName.get("Research")?.invocable).toBe(true);
		expect(byName.get("Review")?.invocable).toBe(false);
	});
});
