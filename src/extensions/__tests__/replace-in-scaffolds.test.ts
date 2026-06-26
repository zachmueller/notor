import { describe, it, expect, vi } from "vitest";
import { REPLACE_IN_NOTE } from "../builtin-tool-scaffolds/replace-in-note";
import { REPLACE_IN_FILE } from "../builtin-tool-scaffolds/replace-in-file";
import { extractCodeFence } from "../parser";
import { compileExtension } from "../compiler";
import { resilientIndexOf } from "../../utils/unicode-normalize";

// ---------------------------------------------------------------------------
// Helpers: compile each scaffold's real code body and run it with mocks.
// compileExtension strips TS types then builds the AsyncFunction.
// ---------------------------------------------------------------------------

function compileScaffold(scaffoldContent: string) {
	const fence = extractCodeFence(scaffoldContent);
	if (!fence) throw new Error("No code fence found in scaffold");
	const compiled = compileExtension(fence.code, "tool");
	if ("error" in compiled) throw new Error(compiled.error);
	return compiled.fn;
}

const noopLogger = () => ({ debug() {}, info() {}, warn() {}, error() {} });

const DEFAULT_NOTE_SETTINGS = {
	replace_in_note_return_full_content_on_failure: true,
	replace_in_note_failure_content_max_chars: 20000,
};
const DEFAULT_FILE_SETTINGS = {
	replace_in_file_return_full_content_on_failure: true,
	replace_in_file_failure_content_max_chars: 20000,
};

// ---- replace_in_note harness -------------------------------------------------

function runReplaceInNote(opts: {
	initialContent: string;
	changes: Array<Record<string, string>>;
	settings?: Record<string, unknown>;
	stale?: boolean;
}) {
	const fn = compileScaffold(REPLACE_IN_NOTE.scaffoldContent);
	const store = { content: opts.initialContent };
	const file = { path: "note.md" };

	const app = {
		vault: {
			read: vi.fn(async () => store.content),
			process: vi.fn(async (_f: unknown, cb: (data: string) => string) => {
				store.content = cb(store.content);
				return store.content;
			}),
		},
	};

	const utils = {
		logger: noopLogger,
		resolveNote: vi.fn(() => file),
		resilientIndexOf,
		staleTracker: {
			check: vi.fn(() => ({ isStale: !!opts.stale })),
			recordRead: vi.fn(),
			updateAfterWrite: vi.fn(),
			invalidate: vi.fn(),
		},
		checkpointManager: { createCheckpoint: vi.fn(async () => {}) },
		noteOpener: { openNote: vi.fn(async () => {}) },
	};

	const params = { path: "note.md", changes: opts.changes };
	const settings = opts.settings ?? DEFAULT_NOTE_SETTINGS;

	return {
		result: fn(app, {}, utils, {}, settings, {}, params),
		store,
		app,
		utils,
	};
}

// ---- replace_in_file harness -------------------------------------------------

function runReplaceInFile(opts: {
	initialContent: string;
	changes: Array<Record<string, string>>;
	settings?: Record<string, unknown>;
}) {
	const fn = compileScaffold(REPLACE_IN_FILE.scaffoldContent);
	const store = { content: opts.initialContent };
	const resolvedPath = "/abs/file.txt";

	const obsidian = { Platform: { isDesktopApp: true } };

	const utils = {
		logger: noopLogger,
		resolveAndValidatePath: vi.fn(() => ({ valid: true, resolvedPath })),
		resilientIndexOf,
	};

	const libs = {
		fs: {
			promises: {
				stat: vi.fn(async () => ({})),
				readFile: vi.fn(async () => Buffer.from(store.content, "utf-8")),
				writeFile: vi.fn(async (_p: string, data: string) => {
					store.content = data;
				}),
			},
		},
	};

	const params = { path: "file.txt", changes: opts.changes };
	const settings = opts.settings ?? DEFAULT_FILE_SETTINGS;

	return {
		result: fn({}, obsidian, utils, libs, settings, {}, params),
		store,
		libs,
	};
}

// ---------------------------------------------------------------------------
// No-op warnings
// ---------------------------------------------------------------------------

describe("replace_in_note — no-op warnings", () => {
	it("a single no-op edit reports 0 applied + warning and changes nothing", async () => {
		const { result, store } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "beta", new_text: "beta" }],
		});
		const msg = await result;
		expect(msg).toContain("Applied 0 replacements");
		expect(msg).toContain("⚠️");
		expect(msg).toContain("Edit(s) 1 were no-ops");
		expect(store.content).toBe("alpha beta gamma");
	});

	it("one no-op + one valid edit applies the valid edit and warns about the no-op", async () => {
		const { result, store } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [
				{ old_text: "beta", new_text: "beta" },
				{ old_text: "gamma", new_text: "delta" },
			],
		});
		const msg = await result;
		expect(msg).toContain("Applied 1 replacement to note.md");
		expect(msg).toContain("Edit(s) 1 were no-ops");
		expect(store.content).toBe("alpha beta delta");
	});

	it("legitimate edits produce no warning (no false positives)", async () => {
		const { result, store } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "alpha", new_text: "ALPHA" }],
		});
		const msg = await result;
		expect(msg).toBe("Applied 1 replacement to note.md");
		expect(msg).not.toContain("⚠️");
		expect(store.content).toBe("ALPHA beta gamma");
	});
});

describe("replace_in_file — no-op warnings", () => {
	it("one no-op + one valid edit applies the valid edit and warns", async () => {
		const { result, store } = runReplaceInFile({
			initialContent: "alpha beta gamma",
			changes: [
				{ old_text: "beta", new_text: "beta" },
				{ old_text: "gamma", new_text: "delta" },
			],
		});
		const msg = await result;
		expect(msg).toContain("Applied 1 replacement to /abs/file.txt");
		expect(msg).toContain("Edit(s) 1 were no-ops");
		expect(store.content).toBe("alpha beta delta");
	});

	it("legitimate edits produce no warning", async () => {
		const { result, store } = runReplaceInFile({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "alpha", new_text: "ALPHA" }],
		});
		const msg = await result;
		expect(msg).not.toContain("⚠️");
		expect(store.content).toBe("ALPHA beta gamma");
	});
});

// ---------------------------------------------------------------------------
// Backward compatibility — legacy {search,replace} aliases still apply.
// These guard replay of old persisted conversations; the aliases are hidden
// from the LLM schema but accepted at runtime.
// ---------------------------------------------------------------------------

describe("replace_in_note — legacy {search,replace} aliases", () => {
	it("applies a legacy block", async () => {
		const { result, store } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ search: "alpha", replace: "ALPHA" }],
		});
		const msg = await result;
		expect(msg).toBe("Applied 1 replacement to note.md");
		expect(store.content).toBe("ALPHA beta gamma");
	});

	it("applies a legacy deletion (empty replace)", async () => {
		const { result, store } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ search: "alpha ", replace: "" }],
		});
		const msg = await result;
		expect(msg).toBe("Applied 1 replacement to note.md");
		expect(store.content).toBe("beta gamma");
	});
});

describe("replace_in_file — legacy {search,replace} aliases", () => {
	it("applies a legacy block", async () => {
		const { result, store } = runReplaceInFile({
			initialContent: "alpha beta gamma",
			changes: [{ search: "alpha", replace: "ALPHA" }],
		});
		const msg = await result;
		expect(msg).toBe("Applied 1 replacement to /abs/file.txt");
		expect(store.content).toBe("ALPHA beta gamma");
	});

	it("applies a legacy deletion (empty replace)", async () => {
		const { result, store } = runReplaceInFile({
			initialContent: "alpha beta gamma",
			changes: [{ search: "alpha ", replace: "" }],
		});
		const msg = await result;
		expect(msg).toBe("Applied 1 replacement to /abs/file.txt");
		expect(store.content).toBe("beta gamma");
	});
});

// ---------------------------------------------------------------------------
// Configurable full-content return on failure
// ---------------------------------------------------------------------------

describe("replace_in_note — configurable failure content", () => {
	it("toggle on, under cap → full content appended", async () => {
		const { result } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "NO_MATCH", new_text: "x" }],
		});
		const r = await result;
		expect(r.__toolError).toBe(true);
		expect(r.result).toContain("Current note content:");
		expect(r.result).toContain("alpha beta gamma");
	});

	it("toggle off → short hint, no content", async () => {
		const { result } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "NO_MATCH", new_text: "x" }],
			settings: {
				replace_in_note_return_full_content_on_failure: false,
				replace_in_note_failure_content_max_chars: 20000,
			},
		});
		const r = await result;
		expect(r.__toolError).toBe(true);
		expect(r.result).toContain("omitted by setting");
		expect(r.result).not.toContain("alpha beta gamma");
	});

	it("content over cap → truncated with marker", async () => {
		const big = "x".repeat(5000) + "NEEDLE_AT_END";
		const { result } = runReplaceInNote({
			initialContent: big,
			changes: [{ old_text: "NO_MATCH", new_text: "y" }],
			settings: {
				replace_in_note_return_full_content_on_failure: true,
				replace_in_note_failure_content_max_chars: 1000,
			},
		});
		const r = await result;
		expect(r.result).toContain("[truncated");
		expect(r.result).not.toContain("NEEDLE_AT_END");
	});

	it("stale branch honors the toggle (off → hint only)", async () => {
		const { result } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "alpha", new_text: "ALPHA" }],
			stale: true,
			settings: {
				replace_in_note_return_full_content_on_failure: false,
				replace_in_note_failure_content_max_chars: 20000,
			},
		});
		const r = await result;
		expect(r.__toolError).toBe(true);
		expect(r.result).toContain("Stale content detected");
		expect(r.result).toContain("omitted by setting");
		expect(r.result).not.toContain("alpha beta gamma");
	});

	it("stale branch with toggle on → full content", async () => {
		const { result } = runReplaceInNote({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "alpha", new_text: "ALPHA" }],
			stale: true,
		});
		const r = await result;
		expect(r.result).toContain("Current note content:");
		expect(r.result).toContain("alpha beta gamma");
	});
});

describe("replace_in_file — configurable failure content", () => {
	it("toggle on → full content appended", async () => {
		const { result } = runReplaceInFile({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "NO_MATCH", new_text: "x" }],
		});
		const r = await result;
		expect(r.__toolError).toBe(true);
		expect(r.result).toContain("Current file content:");
		expect(r.result).toContain("alpha beta gamma");
	});

	it("toggle off → short hint, no content", async () => {
		const { result } = runReplaceInFile({
			initialContent: "alpha beta gamma",
			changes: [{ old_text: "NO_MATCH", new_text: "x" }],
			settings: {
				replace_in_file_return_full_content_on_failure: false,
				replace_in_file_failure_content_max_chars: 20000,
			},
		});
		const r = await result;
		expect(r.result).toContain("omitted by setting");
		expect(r.result).not.toContain("alpha beta gamma");
	});

	it("content over cap → truncated with marker", async () => {
		const big = "x".repeat(5000) + "NEEDLE_AT_END";
		const { result } = runReplaceInFile({
			initialContent: big,
			changes: [{ old_text: "NO_MATCH", new_text: "y" }],
			settings: {
				replace_in_file_return_full_content_on_failure: true,
				replace_in_file_failure_content_max_chars: 1000,
			},
		});
		const r = await result;
		expect(r.result).toContain("[truncated");
		expect(r.result).not.toContain("NEEDLE_AT_END");
	});
});
