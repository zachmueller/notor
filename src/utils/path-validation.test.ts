import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock os.homedir() before importing the module under test
vi.mock("os", () => ({
	homedir: () => "/Users/test",
}));

import { expandTilde, isPathWithin, resolveAndValidatePath } from "./path-validation";

// ---------------------------------------------------------------------------
// expandTilde
// ---------------------------------------------------------------------------

describe("expandTilde", () => {
	it("expands bare ~ to homedir", () => {
		expect(expandTilde("~")).toBe("/Users/test");
	});

	it("expands ~/ prefix to homedir", () => {
		expect(expandTilde("~/Documents/file.txt")).toBe("/Users/test/Documents/file.txt");
	});

	it("expands ~/  with nested path", () => {
		expect(expandTilde("~/a/b/c")).toBe("/Users/test/a/b/c");
	});

	it("does not expand ~username paths", () => {
		expect(expandTilde("~bob/Documents")).toBe("~bob/Documents");
	});

	it("does not expand absolute paths", () => {
		expect(expandTilde("/absolute/path")).toBe("/absolute/path");
	});

	it("does not expand relative paths", () => {
		expect(expandTilde("relative/path")).toBe("relative/path");
	});

	it("does not expand tilde in the middle of a path", () => {
		expect(expandTilde("/some/~/path")).toBe("/some/~/path");
	});

	it("returns empty string unchanged", () => {
		expect(expandTilde("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// resolveAndValidatePath — tilde expansion
// ---------------------------------------------------------------------------

const VAULT_ROOT = "/Users/test/vault";

describe("resolveAndValidatePath — tilde expansion", () => {
	it("resolves ~/path to absolute path under homedir", () => {
		const result = resolveAndValidatePath("~/Documents/file.txt", VAULT_ROOT, [
			"~/Documents",
		]);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.resolvedPath).toBe("/Users/test/Documents/file.txt");
		}
	});

	it("resolves bare ~ to homedir", () => {
		const result = resolveAndValidatePath("~", VAULT_ROOT, ["/Users/test"]);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.resolvedPath).toBe("/Users/test");
		}
	});

	it("rejects tilde path outside allowed paths", () => {
		const result = resolveAndValidatePath("~/secret/file.txt", VAULT_ROOT, [
			"~/Documents",
		]);
		expect(result.valid).toBe(false);
	});

	it("allows tilde path within vault root", () => {
		// ~/vault/notes/file.txt → /Users/test/vault/notes/file.txt (inside vault root)
		const result = resolveAndValidatePath("~/vault/notes/file.txt", "/Users/test/vault", []);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.resolvedPath).toBe("/Users/test/vault/notes/file.txt");
		}
	});

	it("expands tilde in allowedPaths entries", () => {
		const result = resolveAndValidatePath("/Users/test/Desktop/file.txt", VAULT_ROOT, [
			"~/Desktop",
		]);
		expect(result.valid).toBe(true);
	});

	it("handles mixed tilde and absolute allowed paths", () => {
		const result = resolveAndValidatePath("~/Projects/file.txt", VAULT_ROOT, [
			"/Users/test/Projects",
		]);
		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.resolvedPath).toBe("/Users/test/Projects/file.txt");
		}
	});
});
