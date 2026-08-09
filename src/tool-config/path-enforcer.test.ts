import { describe, it, expect, beforeEach, vi } from "vitest";
import { enforcePathConstraints, matchesPathPrefixes, TOOL_PATH_PARAMS } from "./path-enforcer";
import type { ResolvedToolConfigEntry } from "./types";

// Mock os.homedir() for deterministic tilde expansion
vi.mock("os", () => ({
	homedir: () => "/Users/test",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ResolvedToolConfigEntry> = {}): ResolvedToolConfigEntry {
	return {
		enabled: true,
		auto_approve: false,
		allowed_paths: [],
		blocked_paths: [],
		allowed_command_patterns: [],
		blocked_command_patterns: [],
		auto_approve_paths: [],
		never_auto_approve_paths: [],
		...overrides,
	};
}

const VAULT_ROOT = "/Users/test/vault";

/**
 * After Phase 7.3, TOOL_PATH_PARAMS starts empty and is populated dynamically
 * by ExtensionManager.reload(). Seed the entries needed by these unit tests.
 */
function seedPathParams(): void {
	Object.assign(TOOL_PATH_PARAMS, {
		read_note: [{ paramName: "path", namespace: "vault" as const, resolveAs: "note" as const }],
		write_note: [{ paramName: "path", namespace: "vault" as const, resolveAs: "note" as const }],
		search_vault: [{ paramName: "path", namespace: "vault" as const }],
		read_file: [{ paramName: "path", namespace: "filesystem" as const }],
		write_docx: [
			{ paramName: "output_path", namespace: "filesystem" as const },
			{ paramName: "template_path", namespace: "filesystem" as const },
		],
		read_xlsx: [{ paramName: "path", namespace: "filesystem" as const }],
		write_xlsx: [{ paramName: "output_path", namespace: "filesystem" as const }],
		list_xlsx_sheets: [{ paramName: "path", namespace: "filesystem" as const }],
		import_xlsx: [
			{ paramName: "path", namespace: "filesystem" as const },
			{ paramName: "note_path", namespace: "vault" as const },
		],
		fetch_webpage: [],
	});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// The shared matcher both tiers use. It returns the winning prefix so callers
// can name it in an error message or an auto-approve reason label.
describe("matchesPathPrefixes", () => {
	it("returns the matching vault prefix", () => {
		expect(matchesPathPrefixes("ai/notes/x.md", "vault", ["other/", "ai/"], "")).toBe("ai/");
	});

	it("returns null when no vault prefix matches", () => {
		expect(matchesPathPrefixes("private/x.md", "vault", ["ai/"], "")).toBeNull();
	});

	it("returns null for an empty prefix list", () => {
		expect(matchesPathPrefixes("ai/x.md", "vault", [], "")).toBeNull();
	});

	it("respects `/` boundaries rather than doing a bare string prefix match", () => {
		expect(matchesPathPrefixes("ai-private/x.md", "vault", ["ai"], "")).toBeNull();
	});

	it("returns the matching filesystem prefix, expanding tilde", () => {
		expect(
			matchesPathPrefixes("~/Documents/f.txt", "filesystem", ["~/Documents"], VAULT_ROOT),
		).toBe("~/Documents");
	});

	it("resolves relative filesystem paths against the vault root", () => {
		expect(matchesPathPrefixes("sub/f.txt", "filesystem", [VAULT_ROOT], VAULT_ROOT)).toBe(
			VAULT_ROOT,
		);
	});
});

describe("enforcePathConstraints", () => {
	beforeEach(() => {
		// Clear and re-seed before each test (entries are dynamic post-migration)
		for (const key of Object.keys(TOOL_PATH_PARAMS)) delete TOOL_PATH_PARAMS[key];
		seedPathParams();
	});

	describe("vault-namespace: prefix match", () => {
		it("allows path within allowed prefix", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const result = enforcePathConstraints("read_note", { path: "notes/daily.md" }, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});

		it("blocks path not within any allowed prefix", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const result = enforcePathConstraints("read_note", { path: "journal/entry.md" }, entry, VAULT_ROOT);
			expect(result).not.toBeNull();
			expect(result).toContain("not within any allowed path");
		});

		it("allows exact path match", () => {
			const entry = makeEntry({ allowed_paths: ["notes/daily.md"] });
			const result = enforcePathConstraints("read_note", { path: "notes/daily.md" }, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});

		it("blocks via blocked_paths prefix", () => {
			const entry = makeEntry({ blocked_paths: ["private/"] });
			const result = enforcePathConstraints("write_note", { path: "private/secret.md" }, entry, VAULT_ROOT);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});
	});

	describe("filesystem-namespace: absolute path resolution", () => {
		it("allows path within allowed absolute path", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault/docs"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "/Users/test/vault/docs/readme.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});

		it("blocks path outside allowed absolute path", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault/docs"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "/Users/test/other/file.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).not.toBeNull();
		});

		it("resolves relative path from vault root for filesystem tools", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "subdir/file.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});
	});

	describe("blocked_paths overrides allowed_paths", () => {
		it("blocks when path matches both allowed and blocked", () => {
			const entry = makeEntry({
				allowed_paths: ["notes/"],
				blocked_paths: ["notes/secret/"],
			});
			const result = enforcePathConstraints("read_note", { path: "notes/secret/file.md" }, entry, VAULT_ROOT);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});
	});

	describe("empty allowed_paths = no restriction", () => {
		it("allows any path when allowed_paths is empty and blocked_paths is empty", () => {
			const entry = makeEntry();
			const result = enforcePathConstraints("read_note", { path: "anywhere/file.md" }, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});

		it("allows when allowed_paths empty but path not in blocked", () => {
			const entry = makeEntry({ blocked_paths: ["private/"] });
			const result = enforcePathConstraints("read_note", { path: "public/file.md" }, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});
	});

	describe("empty blocked_paths = no blocklist restriction", () => {
		it("does not block anything when blocked_paths is empty", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const result = enforcePathConstraints("read_note", { path: "notes/file.md" }, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});
	});

	describe("fetch_webpage exempt", () => {
		it("skips enforcement for fetch_webpage (empty params)", () => {
			const entry = makeEntry({ allowed_paths: ["something/"], blocked_paths: ["everything/"] });
			const result = enforcePathConstraints("fetch_webpage", { url: "https://example.com" }, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});
	});

	describe("MCP tools exempt", () => {
		it("skips enforcement for MCP tools (not in TOOL_PATH_PARAMS)", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"], blocked_paths: ["private/"] });
			const result = enforcePathConstraints(
				"myserver__sometool",
				{ path: "private/secret.md" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});
	});

	describe("write_docx dual path params both enforced", () => {
		it("blocks when output_path is blocked", () => {
			const entry = makeEntry({ blocked_paths: ["/tmp/blocked"] });
			const result = enforcePathConstraints(
				"write_docx",
				{ output_path: "/tmp/blocked/out.docx", template_path: "/Users/test/vault/template.docx" },
				entry,
				VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});

		it("blocks when template_path is blocked", () => {
			const entry = makeEntry({ blocked_paths: ["/tmp/blocked"] });
			const result = enforcePathConstraints(
				"write_docx",
				{ output_path: "/Users/test/vault/out.docx", template_path: "/tmp/blocked/template.docx" },
				entry,
				VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});

		it("allows when both paths are within allowed", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault"] });
			const result = enforcePathConstraints(
				"write_docx",
				{ output_path: "/Users/test/vault/out.docx", template_path: "/Users/test/vault/template.docx" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});
	});

	describe("import_xlsx mixed filesystem + vault params both enforced", () => {
		it("blocks when the filesystem source path is blocked", () => {
			const entry = makeEntry({ blocked_paths: ["/tmp/blocked"] });
			const result = enforcePathConstraints(
				"import_xlsx",
				{ path: "/tmp/blocked/data.xlsx", note_path: "notes/imported.md" },
				entry,
				VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});

		it("blocks when the vault destination note is blocked", () => {
			const entry = makeEntry({ blocked_paths: ["private/"] });
			const result = enforcePathConstraints(
				"import_xlsx",
				{ path: "/Users/test/vault/data.xlsx", note_path: "private/imported.md" },
				entry,
				VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});

		it("allows when both the filesystem source and vault destination are permitted", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault", "notes/"] });
			const result = enforcePathConstraints(
				"import_xlsx",
				{ path: "/Users/test/vault/data.xlsx", note_path: "notes/imported.md" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});
	});

	describe("TOOL_PATH_PARAMS is dynamically populated", () => {
		it("starts empty before ExtensionManager.reload() seeds it", () => {
			// Clear to verify the base state (before seedPathParams runs)
			for (const key of Object.keys(TOOL_PATH_PARAMS)) delete TOOL_PATH_PARAMS[key];
			expect(Object.keys(TOOL_PATH_PARAMS)).toHaveLength(0);
		});

		it("accepts dynamically registered entries", () => {
			// seedPathParams() ran in beforeEach — verify entries are present
			expect(TOOL_PATH_PARAMS).toHaveProperty("read_note");
			expect(TOOL_PATH_PARAMS).toHaveProperty("write_docx");
			expect(TOOL_PATH_PARAMS["write_docx"]).toHaveLength(2);
		});
	});

	describe("filesystem-namespace: tilde expansion", () => {
		it("allows tilde path within tilde-expanded allowed path", () => {
			const entry = makeEntry({ allowed_paths: ["~/Documents"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "~/Documents/file.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});

		it("blocks tilde path outside allowed paths", () => {
			const entry = makeEntry({ allowed_paths: ["~/Documents"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "~/Desktop/file.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("not within any allowed path");
		});

		it("blocks tilde path matching tilde-expanded blocked path", () => {
			const entry = makeEntry({ blocked_paths: ["~/secret"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "~/secret/file.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});

		it("matches tilde path against equivalent absolute allowed path", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/Projects"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "~/Projects/file.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});

		it("matches absolute path against tilde-expanded allowed path", () => {
			const entry = makeEntry({ allowed_paths: ["~/Projects"] });
			const result = enforcePathConstraints(
				"read_file",
				{ path: "/Users/test/Projects/file.txt" },
				entry,
				VAULT_ROOT,
			);
			expect(result).toBeNull();
		});
	});

	describe("skips empty/null/undefined path params", () => {
		it("skips enforcement when path param is undefined", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const result = enforcePathConstraints("read_note", {}, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});

		it("skips enforcement when path param is empty string", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const result = enforcePathConstraints("read_note", { path: "  " }, entry, VAULT_ROOT);
			expect(result).toBeNull();
		});
	});

	describe("vault path resolution via resolveVaultPath callback", () => {
		it("resolves bare name to canonical path and checks against allowed_paths", () => {
			const entry = makeEntry({ allowed_paths: ["Research/"] });
			const resolver = (path: string) =>
				path === "Climate" ? "Research/Climate.md" : null;
			const result = enforcePathConstraints(
				"read_note", { path: "Climate" }, entry, VAULT_ROOT, resolver,
			);
			expect(result).toBeNull();
		});

		it("resolves bare name and correctly blocks via blocked_paths", () => {
			const entry = makeEntry({ blocked_paths: ["Research/"] });
			const resolver = (path: string) =>
				path === "Climate" ? "Research/Climate.md" : null;
			const result = enforcePathConstraints(
				"read_note", { path: "Climate" }, entry, VAULT_ROOT, resolver,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});

		it("resolves path without .md extension", () => {
			const entry = makeEntry({ allowed_paths: ["Research/"] });
			const resolver = (path: string) =>
				path === "Research/Climate" ? "Research/Climate.md" : null;
			const result = enforcePathConstraints(
				"read_note", { path: "Research/Climate" }, entry, VAULT_ROOT, resolver,
			);
			expect(result).toBeNull();
		});

		it("falls through to raw string matching when resolver returns null", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const resolver = () => null;
			const result = enforcePathConstraints(
				"read_note", { path: "nonexistent-note" }, entry, VAULT_ROOT, resolver,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("not within any allowed path");
		});

		it("uses raw string matching when no resolver is provided (backward compat)", () => {
			const entry = makeEntry({ allowed_paths: ["Intake for Commonplace Notes.md"] });
			const result = enforcePathConstraints(
				"read_note", { path: "Intake for Commonplace Notes" }, entry, VAULT_ROOT,
			);
			// Without resolver, bare name doesn't match the .md suffix in allowed_paths
			expect(result).not.toBeNull();
		});

		it("does not call resolver for directory tools without resolveAs", () => {
			const entry = makeEntry({ allowed_paths: ["Projects/"] });
			const resolver = vi.fn(() => "Projects/SomeNote.md");
			const result = enforcePathConstraints(
				"search_vault", { path: "Projects" }, entry, VAULT_ROOT, resolver,
			);
			expect(result).toBeNull();
			expect(resolver).not.toHaveBeenCalled();
		});

		it("does not call resolver for filesystem-namespace params", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault"] });
			const resolver = vi.fn(() => "some/path.md");
			const result = enforcePathConstraints(
				"read_file", { path: "/Users/test/vault/file.txt" }, entry, VAULT_ROOT, resolver,
			);
			expect(result).toBeNull();
			expect(resolver).not.toHaveBeenCalled();
		});
	});

	// -- INT-001: per-session auto-allow (FR-121) -----------------------------
	describe("sessionAllowedPaths (orchestration scratchpad auto-allow, FR-121)", () => {
		const SCRATCHPAD = "notor/orchestrations/sessions/sess-A/scratchpad";

		it("allows a scratchpad path OUTSIDE allowed_paths when it is session-allowed", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			// Without session-allow → blocked.
			expect(
				enforcePathConstraints("write_note", { path: `${SCRATCHPAD}/plan.md` }, entry, VAULT_ROOT),
			).not.toBeNull();
			// With session-allow → permitted, in addition to allowed_paths.
			expect(
				enforcePathConstraints(
					"write_note",
					{ path: `${SCRATCHPAD}/plan.md` },
					entry,
					VAULT_ROOT,
					undefined,
					[SCRATCHPAD],
				),
			).toBeNull();
		});

		it("still allows the tool's configured allowed_paths (auto-allow is additive)", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			expect(
				enforcePathConstraints(
					"write_note",
					{ path: "notes/daily.md" },
					entry,
					VAULT_ROOT,
					undefined,
					[SCRATCHPAD],
				),
			).toBeNull();
		});

		it("is session-scoped — session A's scratchpad does NOT admit session B's", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const sessionBPath = "notor/orchestrations/sessions/sess-B/scratchpad/plan.md";
			expect(
				enforcePathConstraints(
					"write_note",
					{ path: sessionBPath },
					entry,
					VAULT_ROOT,
					undefined,
					[SCRATCHPAD], // only session A's prefix
				),
			).not.toBeNull();
		});

		it("blocked_paths still take precedence over a session-allowed path", () => {
			const entry = makeEntry({ allowed_paths: [], blocked_paths: [SCRATCHPAD] });
			expect(
				enforcePathConstraints(
					"write_note",
					{ path: `${SCRATCHPAD}/secret.md` },
					entry,
					VAULT_ROOT,
					undefined,
					[SCRATCHPAD],
				),
			).not.toBeNull();
		});

		it("passing undefined sessionAllowedPaths yields identical behavior to omitting it", () => {
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			const withUndefined = enforcePathConstraints(
				"read_note", { path: "journal/x.md" }, entry, VAULT_ROOT, undefined, undefined,
			);
			const without = enforcePathConstraints("read_note", { path: "journal/x.md" }, entry, VAULT_ROOT);
			expect(withUndefined).toBe(without);
		});

		it("auto-allows a filesystem-namespace path under a session prefix", () => {
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault/docs"] });
			const fsScratch = "/Users/test/vault/notor/orchestrations/sessions/sess-A/scratchpad";
			expect(
				enforcePathConstraints(
					"read_file",
					{ path: `${fsScratch}/out.txt` },
					entry,
					VAULT_ROOT,
					undefined,
					[fsScratch],
				),
			).toBeNull();
		});
	});

	// -- Path normalization: `.` / `..` collapse ------------------------------
	// The vault namespace collapses `.` and `..` so it agrees with the filesystem
	// namespace (which gets this from path.normalize()) on what a path *means*.
	describe("vault-namespace: `.` and `..` segment collapse", () => {
		it("collapses `..` so a traversal out of an allowed prefix is not allowed", () => {
			const entry = makeEntry({ allowed_paths: ["ai/"] });
			// ai/../private/x collapses to private/x → outside ai/ → rejected.
			const result = enforcePathConstraints(
				"read_note", { path: "ai/../private/x.md" }, entry, VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("not within any allowed path");
		});

		it("collapses `..` so a traversal INTO a blocked prefix is still blocked", () => {
			const entry = makeEntry({ blocked_paths: ["private/"] });
			const result = enforcePathConstraints(
				"write_note", { path: "ai/../private/secret.md" }, entry, VAULT_ROOT,
			);
			expect(result).not.toBeNull();
			expect(result).toContain("is blocked");
		});

		it("collapses `.` segments", () => {
			const entry = makeEntry({ allowed_paths: ["ai/"] });
			expect(
				enforcePathConstraints("read_note", { path: "ai/./x.md" }, entry, VAULT_ROOT),
			).toBeNull();
		});

		it("collapses an interior `..` that stays within the allowed prefix", () => {
			const entry = makeEntry({ allowed_paths: ["ai/"] });
			// ai/sub/../x.md collapses to ai/x.md → still inside ai/.
			expect(
				enforcePathConstraints("read_note", { path: "ai/sub/../x.md" }, entry, VAULT_ROOT),
			).toBeNull();
		});

		it("keeps a leading `..` literal so it escapes nothing and fails closed", () => {
			const entry = makeEntry({ allowed_paths: ["ai/"] });
			expect(
				enforcePathConstraints("read_note", { path: "../outside.md" }, entry, VAULT_ROOT),
			).not.toBeNull();
		});

		it("normalizes prefixes as well as paths", () => {
			const entry = makeEntry({ allowed_paths: ["ai/sub/../"] });
			// Prefix collapses to `ai`, so ai/x.md matches.
			expect(
				enforcePathConstraints("read_note", { path: "ai/x.md" }, entry, VAULT_ROOT),
			).toBeNull();
		});
	});

	// -- F2 B.5: empty-root behavior (mobile gate) ----------------------------
	// The legacy branch already passes `this.vaultRootPath ?? ""` on mobile, so an
	// empty root is precedented. Lock the behavior so the pure path can pass
	// `vaultRootPath: ""` on mobile (removing the mobile legacy fallback) with a
	// verified contract rather than a guess.
	describe("empty vaultRootPath (mobile — no basePath)", () => {
		it("vault-namespace enforcement is unaffected by an empty root (prefix match, no root join)", () => {
			// Vault-namespace paths never touch vaultRootPath, so allow/block work as usual.
			const entry = makeEntry({ allowed_paths: ["notes/"] });
			expect(enforcePathConstraints("read_note", { path: "notes/x.md" }, entry, "")).toBeNull();
			expect(
				enforcePathConstraints("read_note", { path: "journal/x.md" }, entry, ""),
			).not.toBeNull();
		});

		it("vault-namespace blocked_paths still win with an empty root", () => {
			const entry = makeEntry({ blocked_paths: ["private/"] });
			expect(
				enforcePathConstraints("write_note", { path: "private/secret.md" }, entry, ""),
			).not.toBeNull();
		});

		it("no path constraints → allowed regardless of root", () => {
			const entry = makeEntry();
			expect(enforcePathConstraints("read_file", { path: "anything/x.txt" }, entry, "")).toBeNull();
		});

		it("filesystem-namespace with an absolute allowed_path still enforces under an empty root", () => {
			// Absolute paths resolve without the root; a matching path is allowed and a
			// non-matching one is blocked — the empty root does not silently open access.
			const entry = makeEntry({ allowed_paths: ["/Users/test/vault/docs"] });
			expect(
				enforcePathConstraints("read_file", { path: "/Users/test/vault/docs/f.txt" }, entry, ""),
			).toBeNull();
			expect(
				enforcePathConstraints("read_file", { path: "/etc/passwd" }, entry, ""),
			).not.toBeNull();
		});
	});
});
