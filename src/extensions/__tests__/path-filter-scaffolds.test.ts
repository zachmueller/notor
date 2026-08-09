import { describe, it, expect, vi } from "vitest";
import { getFrontMatterInfo } from "obsidian";
import { SEARCH_VAULT } from "../builtin-tool-scaffolds/search-vault";
import { LIST_VAULT } from "../builtin-tool-scaffolds/list-vault";
import { GET_BACKLINKS } from "../builtin-tool-scaffolds/get-backlinks";
import { GET_OUTLINKS } from "../builtin-tool-scaffolds/get-outlinks";
import { READ_NOTE } from "../builtin-tool-scaffolds/read-note";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";

// ---------------------------------------------------------------------------
// Result filtering: the hard gate only inspects a call's own path arguments, so
// tools that return OTHER notes' paths or content filter their results against
// the effective vault-read lists and disclose the count they withheld.
//
// Each test runs the real compiled scaffold body, once with a pathFilter and
// once without, to pin both the filtering and the unrestricted behavior.
// Invocation order: fn(app, obsidian, utils, libs, settings, shared, params).
// ---------------------------------------------------------------------------

function compileScaffold(scaffoldContent: string) {
	const fence = extractCodeFence(scaffoldContent);
	if (!fence) throw new Error("No code fence found in scaffold");
	const compiled = compileExtension(fence.code, "tool");
	if ("error" in compiled) throw new Error(compiled.error);
	return compiled.fn;
}

const noopLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} });

/** Allow everything except paths under `private/`. */
const denyPrivate = (p: string) => !p.startsWith("private/");

// ---------------------------------------------------------------------------
// search_vault
// ---------------------------------------------------------------------------

function runSearchVault(pathFilter?: (p: string) => boolean) {
	const files = [
		{ path: "ai/notes.md", name: "notes.md", stat: { mtime: 1, size: 10 } },
		{ path: "private/secret.md", name: "secret.md", stat: { mtime: 1, size: 10 } },
	];
	const contents: Record<string, string> = {
		"ai/notes.md": "needle here",
		"private/secret.md": "needle here too",
	};

	const app = {
		vault: {
			getFiles: () => files,
			cachedRead: vi.fn(async (f: { path: string }) => contents[f.path] ?? ""),
			read: vi.fn(async (f: { path: string }) => contents[f.path] ?? ""),
		},
		metadataCache: { resolvedLinks: {} },
	};
	const utils = { logger: noopLogger, ...(pathFilter ? { pathFilter } : {}) };

	return compileScaffold(SEARCH_VAULT.scaffoldContent)(
		app,
		{ getFrontMatterInfo },
		utils,
		{},
		{},
		{},
		{ query: "needle" },
	) as Promise<{ files: Array<{ path: string }>; notice?: string }>;
}

describe("search_vault result filtering", () => {
	it("withholds out-of-scope hits and discloses the count", async () => {
		const result = await runSearchVault(denyPrivate);
		expect(result.files.map((f) => f.path)).toEqual(["ai/notes.md"]);
		expect(result.notice).toBe("1 notes hidden by path restrictions");
	});

	it("returns everything and adds no notice when reads are unrestricted", async () => {
		const result = await runSearchVault();
		expect(result.files.map((f) => f.path).sort()).toEqual(["ai/notes.md", "private/secret.md"]);
		expect(result.notice).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// list_vault
// ---------------------------------------------------------------------------

function runListVault(pathFilter?: (p: string) => boolean) {
	class TFile {
		extension = "md";
		constructor(
			public path: string,
			public name: string,
			public stat = { mtime: 1, size: 10 },
		) {}
	}
	class TFolder {
		children: unknown[] = [];
		constructor(
			public path: string,
			public name: string,
		) {}
	}
	const aiFile = new TFile("ai/notes.md", "notes.md");
	const privateFile = new TFile("private/secret.md", "secret.md");
	const root = new TFolder("", "");
	root.children = [aiFile, privateFile];

	const app = {
		vault: {
			getRoot: () => root,
			getAbstractFileByPath: () => root,
			getFiles: () => [aiFile, privateFile],
		},
	};
	const utils = { logger: noopLogger, ...(pathFilter ? { pathFilter } : {}) };

	return compileScaffold(LIST_VAULT.scaffoldContent)(
		app,
		{ getFrontMatterInfo, TFile, TFolder },
		utils,
		{},
		{},
		{},
		{},
	) as Promise<{ items: Array<{ path: string }>; notice?: string }>;
}

describe("list_vault result filtering", () => {
	it("withholds out-of-scope entries and discloses the count", async () => {
		const result = await runListVault(denyPrivate);
		expect(result.items.map((i) => i.path)).toEqual(["ai/notes.md"]);
		expect(result.notice).toBe("1 entries hidden by path restrictions");
	});

	it("returns everything and adds no notice when reads are unrestricted", async () => {
		const result = await runListVault();
		expect(result.items.map((i) => i.path).sort()).toEqual([
			"ai/notes.md",
			"private/secret.md",
		]);
		expect(result.notice).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// get_backlinks / get_outlinks
// ---------------------------------------------------------------------------

function runLinkTool(scaffold: string, pathFilter?: (p: string) => boolean) {
	const target = "ai/target.md";
	const app = {
		metadataCache: {
			// Both sources link to the target; the target links out to both.
			resolvedLinks: {
				"ai/other.md": { [target]: 1 },
				"private/secret.md": { [target]: 1 },
				[target]: { "ai/other.md": 1, "private/secret.md": 1 },
			},
			unresolvedLinks: { [target]: { "Missing Note": 1 } },
		},
	};
	const utils = {
		logger: noopLogger,
		resolveNote: () => ({ path: target, extension: "md" }),
		...(pathFilter ? { pathFilter } : {}),
	};

	return compileScaffold(scaffold)(
		app,
		{ getFrontMatterInfo },
		utils,
		{},
		{},
		{},
		{ path: target },
	) as Promise<string>;
}

describe("get_backlinks result filtering", () => {
	it("withholds out-of-scope sources and discloses the count", async () => {
		const out = await runLinkTool(GET_BACKLINKS.scaffoldContent, denyPrivate);
		expect(out).toContain("ai/other.md");
		expect(out).not.toContain("private/secret.md");
		expect(out).toContain("1 hidden by path restrictions");
	});

	it("reports that something was withheld even when nothing is visible", async () => {
		const out = await runLinkTool(GET_BACKLINKS.scaffoldContent, () => false);
		// Never let the model conclude "no backlinks exist" when it just can't see them.
		expect(out).toContain("hidden by path restrictions");
		expect(out).not.toBe("(none)");
	});

	it("returns everything unannotated when reads are unrestricted", async () => {
		const out = await runLinkTool(GET_BACKLINKS.scaffoldContent);
		expect(out).toContain("ai/other.md");
		expect(out).toContain("private/secret.md");
		expect(out).not.toContain("hidden by path restrictions");
	});
});

describe("get_outlinks result filtering", () => {
	it("withholds out-of-scope targets but keeps unresolved link text", async () => {
		const out = await runLinkTool(GET_OUTLINKS.scaffoldContent, denyPrivate);
		expect(out).toContain("ai/other.md");
		expect(out).not.toContain("private/secret.md");
		expect(out).toContain("1 hidden by path restrictions");
		// Unresolved links have no target, so there is nothing to restrict.
		expect(out).toContain("Missing Note");
	});

	it("returns everything unannotated when reads are unrestricted", async () => {
		const out = await runLinkTool(GET_OUTLINKS.scaffoldContent);
		expect(out).toContain("private/secret.md");
		expect(out).not.toContain("hidden by path restrictions");
	});
});

// ---------------------------------------------------------------------------
// read_note backlink snippets
// ---------------------------------------------------------------------------

function runReadNote(mode: "list" | "context", pathFilter?: (p: string) => boolean) {
	const target = "ai/target.md";
	const sources: Record<string, string> = {
		"ai/other.md": "see [[target]] here",
		"private/secret.md": "secret mentions [[target]]",
	};

	const app = {
		vault: { read: vi.fn(async () => "Body text") },
		metadataCache: {
			resolvedLinks: {
				"ai/other.md": { [target]: 1 },
				"private/secret.md": { [target]: 1 },
			},
			getFileCache: (f: { path: string }) => ({
				links: [
					{
						link: "target",
						position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 } },
					},
				],
			}),
			getFirstLinkpathDest: () => ({ path: target }),
		},
	};
	const utils = {
		logger: noopLogger,
		resolveNote: (p: string) => ({ path: p, extension: "md" }),
		readNote: async (p: string) => sources[p] ?? "",
		staleContent: { recordRead: vi.fn() },
		notes: { open: vi.fn() },
		...(pathFilter ? { pathFilter } : {}),
	};

	return compileScaffold(READ_NOTE.scaffoldContent)(
		app,
		{ getFrontMatterInfo },
		utils,
		{},
		{ backlinks_default: mode },
		{},
		{ path: target, backlinks: mode },
	) as Promise<string>;
}

describe("read_note backlink filtering", () => {
	it("withholds out-of-scope sources in list mode and discloses the count", async () => {
		const out = await runReadNote("list", denyPrivate);
		expect(out).toContain("ai/other.md");
		expect(out).not.toContain("private/secret.md");
		expect(out).toContain("hidden by path restrictions");
	});

	it("does not quote content from an out-of-scope note in context mode", async () => {
		const out = await runReadNote("context", denyPrivate);
		// The snippet windows are the real leak here — they quote other notes' text.
		expect(out).not.toContain("secret mentions");
		expect(out).toContain("hidden by path restrictions");
	});

	it("reports withholding even when every source is filtered out", async () => {
		const out = await runReadNote("list", () => false);
		expect(out).toContain("hidden by path restrictions");
	});

	it("adds no notice when reads are unrestricted", async () => {
		const out = await runReadNote("list");
		expect(out).toContain("private/secret.md");
		expect(out).not.toContain("hidden by path restrictions");
	});
});
