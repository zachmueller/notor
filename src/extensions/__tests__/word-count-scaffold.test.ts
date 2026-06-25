import { describe, it, expect, vi } from "vitest";
import { getFrontMatterInfo } from "obsidian";
import { WORD_COUNT } from "../builtin-tool-scaffolds/word-count";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";

// ---------------------------------------------------------------------------
// Compile the real word_count scaffold code body and run it with mocks.
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

interface RunOpts {
	content: string;
	section?: string;
	excludeCode?: boolean;
	extension?: string;
	resolve?: boolean;
}

function runWordCount(opts: RunOpts) {
	const fn = compileScaffold(WORD_COUNT.scaffoldContent);

	const app = {
		vault: { read: vi.fn(async () => opts.content) },
	};
	const obsidian = { getFrontMatterInfo };
	const utils = {
		logger: noopLogger,
		resolveNote: vi.fn(() =>
			opts.resolve === false
				? null
				: { path: "test.md", extension: opts.extension ?? "md" },
		),
	};
	const params: Record<string, unknown> = { path: "test.md" };
	if (opts.section !== undefined) params.section = opts.section;
	if (opts.excludeCode !== undefined) params.exclude_code = opts.excludeCode;

	return fn(app, obsidian, utils, {}, {}, {}, params) as Promise<any>;
}

describe("word_count scaffold", () => {
	it("counts words and characters of a plain note", async () => {
		const res = await runWordCount({ content: "Hello world\nThis is a test" });
		expect(res.word_count).toBe(6);
		expect(res.char_count).toBe(26);
		expect(res.section).toBeNull();
	});

	it("excludes frontmatter from the count", async () => {
		const res = await runWordCount({
			content: "---\ntitle: Test\n---\nHello world",
		});
		expect(res.word_count).toBe(2);
		expect(res.char_count).toBe(11);
	});

	it("exclude_code true drops fenced code blocks; false includes them", async () => {
		const content =
			"Intro words here\n```js\nconst x = 1;\nconsole.log(x);\n```\nOutro text";
		const excluded = await runWordCount({ content, excludeCode: true });
		const included = await runWordCount({ content, excludeCode: false });
		expect(excluded.word_count).toBe(5); // "Intro words here" + "Outro text"
		expect(included.word_count).toBeGreaterThan(excluded.word_count);
	});

	it("strips markdown decoration: heading markers, bullets, and link display text", async () => {
		const res = await runWordCount({
			content:
				"# Title\n- item one\n[[note|Display Text]] and [link](http://x) here",
		});
		// Title(1) + item one(2) + "Display Text and link here"(5) = 8
		expect(res.word_count).toBe(8);
	});

	it("scopes the count to a section, including nested lower-level headings", async () => {
		const content =
			"# Intro\nAlpha beta\n## Sub\ngamma\n# Other\ndelta epsilon zeta";
		const intro = await runWordCount({ content, section: "intro" });
		// Intro(1) + Alpha beta(2) + Sub(1) + gamma(1) = 5
		expect(intro.word_count).toBe(5);
		expect(intro.section).toBe("Intro"); // canonical heading text, not the input casing
		expect(intro.sections).toBeUndefined();

		const other = await runWordCount({ content, section: "Other" });
		expect(other.word_count).toBe(4); // Other(1) + delta epsilon zeta(3)
	});

	it("throws when the requested section is not found", async () => {
		await expect(
			runWordCount({ content: "# Intro\nhello", section: "Nope" }),
		).rejects.toThrow(/Section not found/);
	});

	it("returns a per-heading breakdown when no section is given", async () => {
		const content =
			"# Intro\nAlpha beta\n## Sub\ngamma\n# Other\ndelta epsilon zeta";
		const res = await runWordCount({ content });
		expect(res.word_count).toBe(9);
		expect(res.sections).toHaveLength(3);
		const intro = res.sections.find((s: any) => s.heading === "Intro");
		const sub = res.sections.find((s: any) => s.heading === "Sub");
		expect(intro).toMatchObject({ level: 1, word_count: 5 });
		expect(sub).toMatchObject({ level: 2, word_count: 2 });
	});

	it("rejects when the note cannot be resolved", async () => {
		await expect(
			runWordCount({ content: "x", resolve: false }),
		).rejects.toThrow(/Note not found/);
	});

	it("rejects non-markdown files", async () => {
		await expect(
			runWordCount({ content: "x", extension: "txt" }),
		).rejects.toThrow(/not a Markdown note/);
	});
});
