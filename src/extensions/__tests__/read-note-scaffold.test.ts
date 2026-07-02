import { describe, it, expect, vi } from "vitest";
import { getFrontMatterInfo } from "obsidian";
import { READ_NOTE } from "../builtin-tool-scaffolds/read-note";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";

// ---------------------------------------------------------------------------
// Compile the real read_note scaffold code body and run it with mocks.
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

interface LinkHit {
	link: string;
	line: number;
}

interface SourceNote {
	/** Full content of the source note (incl. frontmatter). */
	content: string;
	/** Links emitted by this source's metadata cache. */
	links?: LinkHit[];
	/** When true, utils.readNote rejects for this source. */
	unreadable?: boolean;
}

interface RunOpts {
	/** Target note content. */
	content: string;
	/** Param values (path defaults to "target.md"). */
	params?: Record<string, unknown>;
	/** Resolved tool settings. */
	settings?: Record<string, unknown>;
	/** Map of sourcePath -> SourceNote for backlink sources. */
	sources?: Record<string, SourceNote>;
	/** resolvedLinks map override; defaults to derived-from-sources pointing at target. */
	resolvedLinks?: Record<string, Record<string, number>>;
	targetPath?: string;
}

function runReadNote(opts: RunOpts) {
	const fn = compileScaffold(READ_NOTE.scaffoldContent);
	const targetPath = opts.targetPath ?? "target.md";
	const sources = opts.sources ?? {};

	// Default resolvedLinks: every source links to the target once.
	const resolvedLinks =
		opts.resolvedLinks ??
		Object.fromEntries(
			Object.keys(sources).map((p) => [p, { [targetPath]: 1 }]),
		);

	const recordRead = vi.fn();
	const openNote = vi.fn();

	const app = {
		vault: {
			read: vi.fn(async () => opts.content),
		},
		metadataCache: {
			resolvedLinks,
			getFileCache: vi.fn((f: { path: string }) => {
				const src = sources[f.path];
				if (!src?.links) return {};
				return {
					links: src.links.map((l) => ({
						link: l.link,
						position: { start: { line: l.line, col: 0, offset: 0 }, end: { line: l.line, col: 0, offset: 0 } },
					})),
				};
			}),
			getFirstLinkpathDest: vi.fn((link: string) => {
				// Treat "self" as unresolved; otherwise resolve to the target.
				if (link === "__unresolved__") return null;
				return { path: targetPath };
			}),
		},
	};

	const obsidian = { getFrontMatterInfo };

	const utils = {
		logger: noopLogger,
		resolveNote: vi.fn((p: string) => {
			if (p === targetPath) return { path: targetPath, extension: "md" };
			if (sources[p]) return { path: p, extension: "md" };
			return { path: p, extension: "md" };
		}),
		readNote: vi.fn(async (p: string) => {
			const src = sources[p];
			if (!src) throw new Error(`Note not found: ${p}`);
			if (src.unreadable) throw new Error(`Cannot read: ${p}`);
			return src.content;
		}),
		staleContent: { recordRead },
		notes: { open: openNote },
	};

	const params: Record<string, unknown> = { path: targetPath, ...(opts.params ?? {}) };

	const result = fn(app, obsidian, utils, {}, opts.settings ?? {}, {}, params) as Promise<string>;
	return result.then((out) => ({ out, recordRead, openNote }));
}

describe("read_note scaffold — backlinks", () => {
	it("omitted param + default 'list' appends a Backlinks list; recordRead/openNote still called", async () => {
		const { out, recordRead, openNote } = await runReadNote({
			content: "Body text",
			settings: { backlinks_default: "list" },
			sources: { "a.md": { content: "links [[target]]" }, "b.md": { content: "[[target]] too" } },
		});
		expect(out).toContain("Body text");
		expect(out).toContain("## Backlinks");
		expect(out).toContain("- a.md");
		expect(out).toContain("- b.md");
		expect(recordRead).toHaveBeenCalledWith("target.md", "Body text");
		expect(openNote).toHaveBeenCalledWith("target.md");
	});

	it("omitted param + default 'none' returns plain content (feature disabled via setting)", async () => {
		const { out } = await runReadNote({
			content: "Body text",
			settings: { backlinks_default: "none" },
			sources: { "a.md": { content: "[[target]]" } },
		});
		expect(out).toBe("Body text");
		expect(out).not.toContain("## Backlinks");
	});

	it("explicit backlinks:'none' overrides a 'list' setting (agent can force off)", async () => {
		const { out } = await runReadNote({
			content: "Body text",
			params: { backlinks: "none" },
			settings: { backlinks_default: "list" },
			sources: { "a.md": { content: "[[target]]" } },
		});
		expect(out).toBe("Body text");
	});

	it("context mode renders a snippet window with '> ' on the matched line", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "context" },
			settings: { backlinks_context_lines: 1 },
			sources: {
				"a.md": {
					content: "line0\nline1 [[target]]\nline2",
					links: [{ link: "target", line: 1 }],
				},
			},
		});
		expect(out).toContain("### a.md");
		expect(out).toContain("    > line1 [[target]]");
		expect(out).toContain("      line0");
		expect(out).toContain("      line2");
	});

	it("context mode clamps the window at file start and end", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "context" },
			settings: { backlinks_context_lines: 5 },
			sources: {
				"a.md": {
					content: "only [[target]] line",
					links: [{ link: "target", line: 0 }],
				},
			},
		});
		expect(out).toContain("    > only [[target]] line");
		// No padding lines beyond the single line of content.
		expect(out.split("\n").filter((l) => l.trim().length > 0 && l.startsWith("    ")).length).toBe(1);
	});

	it("excludes self-links from the source list", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "list" },
			// target links to itself + a.md links to target
			resolvedLinks: {
				"target.md": { "target.md": 1 },
				"a.md": { "target.md": 1 },
			},
			sources: { "a.md": { content: "[[target]]" } },
		});
		expect(out).toContain("- a.md");
		expect(out).not.toContain("- target.md");
	});

	it("no backlinks -> no section even in list mode", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "list" },
			resolvedLinks: {},
			sources: {},
		});
		expect(out).toBe("Body");
	});

	it("source cap emits a truncation indicator", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "list" },
			settings: { backlinks_max_total_sources: 1 },
			sources: {
				"a.md": { content: "[[target]]" },
				"b.md": { content: "[[target]]" },
				"c.md": { content: "[[target]]" },
			},
		});
		// Only one source listed (sorted -> a.md), plus indicator for the other two.
		expect(out).toContain("- a.md");
		expect(out).not.toContain("- b.md");
		expect(out).toContain("… and 2 more source note(s) (truncated).");
	});

	it("per-source link cap emits a truncation indicator", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "context" },
			settings: { backlinks_max_links_per_source: 1, backlinks_context_lines: 0 },
			sources: {
				"a.md": {
					content: "x [[target]]\ny [[target]]\nz [[target]]",
					links: [
						{ link: "target", line: 0 },
						{ link: "target", line: 1 },
						{ link: "target", line: 2 },
					],
				},
			},
		});
		expect(out).toContain("    > x [[target]]");
		expect(out).not.toContain("    > y [[target]]");
		expect(out).toContain("… and 2 more link(s) in this note.");
	});

	it("unresolved LinkCache falls back to a path-only entry (no throw)", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "context" },
			sources: {
				"a.md": {
					content: "embed only",
					links: [{ link: "__unresolved__", line: 0 }],
				},
			},
		});
		expect(out).toContain("### a.md");
		// No snippet window for this source.
		expect(out).not.toContain("    > ");
	});

	it("unreadable source is skipped; others still render and the tool succeeds", async () => {
		const { out } = await runReadNote({
			content: "Body",
			params: { backlinks: "context" },
			settings: { backlinks_context_lines: 0 },
			sources: {
				"a.md": { content: "broken", links: [{ link: "target", line: 0 }], unreadable: true },
				"b.md": { content: "ok [[target]]", links: [{ link: "target", line: 0 }] },
			},
		});
		expect(out).toContain("### b.md");
		expect(out).toContain("    > ok [[target]]");
		// a.md produced no rendered block (skipped before push).
		expect(out).not.toContain("### a.md");
	});

	it("include_frontmatter:false still strips target frontmatter independent of backlinks", async () => {
		const { out } = await runReadNote({
			content: "---\ntitle: T\n---\nBody text",
			params: { backlinks: "list" },
			sources: { "a.md": { content: "[[target]]" } },
		});
		expect(out.startsWith("Body text")).toBe(true);
		expect(out).not.toContain("title: T");
		expect(out).toContain("## Backlinks");
	});

	it("include_frontmatter:true retains target frontmatter and still appends backlinks", async () => {
		const { out } = await runReadNote({
			content: "---\ntitle: T\n---\nBody text",
			params: { backlinks: "list", include_frontmatter: true },
			sources: { "a.md": { content: "[[target]]" } },
		});
		expect(out).toContain("title: T");
		expect(out).toContain("## Backlinks");
		expect(out).toContain("- a.md");
	});
});
