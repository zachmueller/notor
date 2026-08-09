import { describe, it, expect } from "vitest";
import {
	PATH_GROUPS,
	PATH_SCOPE_LISTS,
	PATH_SCOPING_SETTINGS_SCHEMA,
	buildGlobalPathScopes,
	pathScopeKey,
} from "./path-scoping";

describe("path scoping settings definitions", () => {
	it("defines one field per group × list", () => {
		expect(PATH_SCOPING_SETTINGS_SCHEMA).toHaveLength(PATH_GROUPS.length * PATH_SCOPE_LISTS.length);
		expect(PATH_SCOPING_SETTINGS_SCHEMA).toHaveLength(16);
	});

	it("gives every field a unique string[] key defaulting to empty", () => {
		const keys = PATH_SCOPING_SETTINGS_SCHEMA.map((f) => f.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const field of PATH_SCOPING_SETTINGS_SCHEMA) {
			expect(field.type).toBe("string[]");
			expect(field.default).toEqual([]);
		}
	});

	it("builds keys that are stable and readable", () => {
		expect(pathScopeKey("vault-write", "auto_approve_paths")).toBe(
			"path_scope_vault_write_auto_approve_paths",
		);
		expect(pathScopeKey("filesystem-read", "blocked_paths")).toBe(
			"path_scope_filesystem_read_blocked_paths",
		);
	});
});

describe("buildGlobalPathScopes", () => {
	it("returns an empty object when nothing is configured", () => {
		expect(buildGlobalPathScopes(undefined)).toEqual({});
		expect(buildGlobalPathScopes({})).toEqual({});
	});

	it("omits groups whose lists are all empty, so lookups stay cheap misses", () => {
		const scopes = buildGlobalPathScopes({
			[pathScopeKey("vault-read", "allowed_paths")]: [],
			[pathScopeKey("vault-write", "blocked_paths")]: ["private/"],
		});
		expect(scopes["vault-read"]).toBeUndefined();
		expect(scopes["vault-write"]).toEqual({
			allowed_paths: [],
			blocked_paths: ["private/"],
			auto_approve_paths: [],
			never_auto_approve_paths: [],
		});
	});

	it("expresses the expected read-wide-open / write-narrowed shape", () => {
		const scopes = buildGlobalPathScopes({
			[pathScopeKey("vault-write", "blocked_paths")]: ["private/"],
			[pathScopeKey("vault-write", "auto_approve_paths")]: ["ai/"],
			[pathScopeKey("filesystem-write", "allowed_paths")]: ["~/scratch"],
		});
		expect(Object.keys(scopes).sort()).toEqual(["filesystem-write", "vault-write"]);
		expect(scopes["vault-write"]!.auto_approve_paths).toEqual(["ai/"]);
		expect(scopes["filesystem-write"]!.allowed_paths).toEqual(["~/scratch"]);
	});

	it("drops blank entries and ignores non-array persisted values", () => {
		const scopes = buildGlobalPathScopes({
			[pathScopeKey("vault-write", "blocked_paths")]: ["private/", "  ", ""],
			[pathScopeKey("vault-read", "allowed_paths")]: "not-an-array" as unknown as string[],
		});
		expect(scopes["vault-write"]!.blocked_paths).toEqual(["private/"]);
		expect(scopes["vault-read"]).toBeUndefined();
	});
});
