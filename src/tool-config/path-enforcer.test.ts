import { describe, it, expect } from "vitest";
import { enforcePathConstraints, TOOL_PATH_PARAMS } from "./path-enforcer";
import type { ResolvedToolConfigEntry } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ResolvedToolConfigEntry> = {}): ResolvedToolConfigEntry {
	return {
		enabled: true,
		auto_approve: false,
		allowed_paths: [],
		blocked_paths: [],
		...overrides,
	};
}

const VAULT_ROOT = "/Users/test/vault";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("enforcePathConstraints", () => {
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

	describe("TOOL_PATH_PARAMS table coverage", () => {
		it("contains entries for all 13 built-in tools", () => {
			const expectedTools = [
				"read_note", "write_note", "replace_in_note",
				"read_frontmatter", "update_frontmatter", "manage_tags",
				"search_vault", "list_vault",
				"read_file", "read_docx", "write_docx",
				"execute_command", "fetch_webpage",
			];
			for (const tool of expectedTools) {
				expect(TOOL_PATH_PARAMS).toHaveProperty(tool);
			}
			expect(Object.keys(TOOL_PATH_PARAMS)).toHaveLength(13);
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
});
