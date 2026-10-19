/**
 * POL-002 / POL-001 — the first-party reference flows parse + validate under
 * FEAT-002 without error.
 *
 * Feeds each reference flow's `definition.md` + step notes through a fake vault
 * into `CircuitDefinitionParser`, asserting it parses (frontmatter mapping + step
 * resolution) and passes the load-time validators (reachable completion,
 * single-subscriber topics, no published-but-unsubscribed non-terminal topic,
 * required-events published). This is the verifiable bar that the
 * circuit-creator persona (formerly orchestration-creator; POL-001) emits frontmatter the parser accepts.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-7-composability.md — POL-002 / POL-001
 */

import { describe, it, expect } from "vitest";
import { TFile, TFolder } from "obsidian";
import { CircuitDefinitionParser } from "./circuit-parser";
import { REFERENCE_CIRCUITS, materializeReferenceCircuits, type ReferenceCircuitFs } from "./reference-circuits";

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
		const scalar = (raw: string): unknown => {
			const trimmed = raw.trim();
			if (trimmed === "null" || trimmed === "~") return null;
			const val = trimmed.replace(/^["']|["']$/g, "");
			return val === "true" ? true : val === "false" ? false : /^-?\d+(\.\d+)?$/.test(val) ? Number(val) : val;
		};
		for (const line of lines) {
			if (/^\s*-\s+/.test(line)) {
				const rawItem = line.replace(/^\s*-\s+/, "").trim();
				// Inline flow map (`- { name: x, type: boolean }`), as the evaluator
				// dimensions use. Values never contain commas in the reference notes.
				const flow = rawItem.match(/^\{(.*)\}$/);
				if (flow) {
					const obj: Record<string, unknown> = {};
					for (const pair of flow[1]!.split(",")) {
						const kv = pair.match(/^\s*([\w-]+):\s*(.*)$/);
						if (kv) obj[kv[1]!] = scalar(kv[2]!);
					}
					(listAccum ??= []).push(obj as unknown as string);
					continue;
				}
				(listAccum ??= []).push(rawItem.replace(/^["']|["']$/g, ""));
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
					fm[currentKey] = scalar(rawVal);
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
			let flowDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
			if (flowDir.endsWith("/steps") || flowDir.endsWith("/evals")) flowDir = flowDir.slice(0, flowDir.lastIndexOf("/"));
			return fileObjs.get(`${flowDir}/steps/${linkpath}.md`) ?? fileObjs.get(`${flowDir}/evals/${linkpath}.md`) ?? null;
		},
	} as unknown as import("obsidian").MetadataCache;

	ensureFolder("notor/circuits");
	return { vault, metadataCache };
}

/** Materialize the reference flows into an in-memory file map (mirrors the vault adapter). */
async function materializeToMap(): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const fs: ReferenceCircuitFs = {
		exists: (p) => Promise.resolve(p in files || Object.keys(files).some((k) => k.startsWith(p + "/"))),
		mkdir: () => Promise.resolve(),
		write: (p, data) => {
			files[p] = data;
			return Promise.resolve();
		},
	};
	await materializeReferenceCircuits("notor", fs);
	return files;
}

describe("reference flows (POL-002)", () => {
	it("seeds into circuits/ and skips slugs the user already has under orchestrations/", async () => {
		const files: Record<string, string> = {
			"notor/orchestrations/code-assist/definition.md": "LEGACY USER COPY",
		};
		const fs: ReferenceCircuitFs = {
			exists: (p) => Promise.resolve(p in files || Object.keys(files).some((k) => k.startsWith(p + "/"))),
			mkdir: () => Promise.resolve(),
			write: (p, data) => {
				files[p] = data;
				return Promise.resolve();
			},
		};
		const result = await materializeReferenceCircuits("notor", fs);
		expect(result.skipped).toEqual(["code-assist"]);
		expect(result.written.sort()).toEqual(["research", "review"]);
		expect(Object.keys(files).some((k) => k.startsWith("notor/circuits/code-assist/"))).toBe(false);
		expect(files["notor/orchestrations/code-assist/definition.md"]).toBe("LEGACY USER COPY");
	});

	it("materializes all three flows with their definition + steps (+ evals where declared)", async () => {
		const files = await materializeToMap();
		for (const flow of REFERENCE_CIRCUITS) {
			expect(files[`notor/circuits/${flow.slug}/definition.md`]).toBeDefined();
			for (const stepFile of Object.keys(flow.steps)) {
				expect(files[`notor/circuits/${flow.slug}/steps/${stepFile}`]).toBeDefined();
			}
			for (const evalFile of Object.keys(flow.evals ?? {})) {
				expect(files[`notor/circuits/${flow.slug}/evals/${evalFile}`]).toBeDefined();
			}
		}
		expect(files["notor/circuits/research/evals/report-quality.md"]).toContain("notor-type: circuit-evaluator");
		expect(files["notor/circuits/research/evals/_rubric.md"]).toBeDefined();
		expect(files["notor/circuits/code-assist/evals/structured-summary.md"]).toContain("notor-eval-mode: code");
	});

	it("backfills evals/ into a pre-existing reference dir without touching definition.md or steps", async () => {
		const files = await materializeToMap();
		for (const key of Object.keys(files)) if (key.includes("/evals/")) delete files[key];
		files["notor/circuits/research/definition.md"] = "USER EDITED DEFINITION";
		files["notor/circuits/research/steps/explore.md"] = "USER EDITED STEP";
		const mkdirs: string[] = [];
		const fs: ReferenceCircuitFs = {
			exists: (p) => Promise.resolve(p in files || Object.keys(files).some((k) => k.startsWith(p + "/"))),
			mkdir: (p) => {
				mkdirs.push(p);
				return Promise.resolve();
			},
			write: (p, data) => {
				files[p] = data;
				return Promise.resolve();
			},
		};
		const result = await materializeReferenceCircuits("notor", fs);
		expect(result.written.sort()).toEqual(["code-assist", "research"]);
		expect(mkdirs).toContain("notor/circuits/research/evals");
		expect(files["notor/circuits/research/evals/report-quality.md"]).toBeDefined();
		expect(files["notor/circuits/research/definition.md"]).toBe("USER EDITED DEFINITION");
		expect(files["notor/circuits/research/steps/explore.md"]).toBe("USER EDITED STEP");
	});

	it("is edit-preserving — a second materialize never overwrites existing files", async () => {
		const files = await materializeToMap();
		const before = files["notor/circuits/code-assist/definition.md"];
		files["notor/circuits/code-assist/definition.md"] = "USER EDITED";
		const fs: ReferenceCircuitFs = {
			exists: (p) => Promise.resolve(p in files || Object.keys(files).some((k) => k.startsWith(p + "/"))),
			mkdir: () => Promise.resolve(),
			write: (p, data) => {
				files[p] = data;
				return Promise.resolve();
			},
		};
		await materializeReferenceCircuits("notor", fs);
		// The user edit survives; the constant did NOT clobber it.
		expect(files["notor/circuits/code-assist/definition.md"]).toBe("USER EDITED");
		expect(before).not.toBe("USER EDITED");
	});

	it("each reference flow parses + validates under CircuitDefinitionParser (FEAT-002)", async () => {
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new CircuitDefinitionParser(vault, metadataCache, "notor");

		for (const flow of REFERENCE_CIRCUITS) {
			const dir = `notor/circuits/${flow.slug}`;
			// parseCircuitByDir throws CircuitParseError on any load-time validation failure.
			const result = await parser.parseCircuitByDir(dir);
			expect(result.flow.name.length).toBeGreaterThan(0);
			expect(result.flow.steps.length).toBeGreaterThan(0);
		}
	});

	it("each materializeReferenceCircuits output parses with ZERO errors AND zero warnings (F6 §5.5 gate)", async () => {
		// The cheap, verifiable gate on the reference-flow content (F6 §4.4 / §5.5):
		// each first-party example must parse AND validate clean — no hard error
		// (parseCircuitByDir throws on those) and no non-blocking topology warning.
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new CircuitDefinitionParser(vault, metadataCache, "notor");

		for (const flow of REFERENCE_CIRCUITS) {
			const dir = `notor/circuits/${flow.slug}`;
			const result = await parser.parseCircuitByDir(dir);
			expect(result.warnings, `${flow.slug} produced parse warnings`).toEqual([]);
		}
	});

	it("discovers all three flows via discoverCircuits() (the picker path)", async () => {
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new CircuitDefinitionParser(vault, metadataCache, "notor");
		const discovered = await parser.discoverCircuits();
		const names = discovered.map((p) => p.flow.name).sort();
		expect(names).toEqual(["Code Assist", "Research", "Review"]);
	});

	it("research ships an LLM judge with a rubric; code-assist ships a code evaluator; review has none", async () => {
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new CircuitDefinitionParser(vault, metadataCache, "notor");
		const byName = new Map((await parser.discoverCircuits()).map((p) => [p.flow.name, p.flow]));

		const research = byName.get("Research")!;
		expect(research.evalMaxCostUsd).toBe(1);
		expect(research.evaluators).toHaveLength(1);
		expect(research.evaluators[0]).toMatchObject({
			name: "Report quality",
			mode: "conversation",
			persona: null,
			subagent: null,
			rubricPath: "notor/circuits/research/evals/_rubric.md",
			includeNoteContents: true,
		});
		expect(research.evaluators[0]!.dimensions).toEqual([
			{ name: "accuracy", type: "numeric", min: 1, max: 5, description: null },
			{ name: "completeness", type: "numeric", min: 1, max: 5, description: null },
			{ name: "concision", type: "numeric", min: 1, max: 5, description: null },
			{ name: "cited_sources", type: "boolean", min: 0, max: 1, description: "Every factual claim names a source" },
		]);

		const codeAssist = byName.get("Code Assist")!;
		expect(codeAssist.evaluators).toHaveLength(1);
		expect(codeAssist.evaluators[0]).toMatchObject({ name: "Structured summary", mode: "code", rubricPath: null });
		expect(codeAssist.evaluators[0]!.dimensions.map((d) => [d.name, d.type])).toEqual([
			["completed", "boolean"],
			["has_summary", "boolean"],
			["has_plan", "boolean"],
		]);
		expect(codeAssist.evaluators[0]!.bodyContent).toContain("return {");

		expect(byName.get("Review")!.evaluators).toEqual([]);
	});

	it("code-assist + research are invocable; review is not", async () => {
		const files = await materializeToMap();
		const { vault, metadataCache } = buildFakeVault(files);
		const parser = new CircuitDefinitionParser(vault, metadataCache, "notor");
		const byName = new Map((await parser.discoverCircuits()).map((p) => [p.flow.name, p.flow]));
		expect(byName.get("Code Assist")?.invocable).toBe(true);
		expect(byName.get("Research")?.invocable).toBe(true);
		expect(byName.get("Review")?.invocable).toBe(false);
	});
});
