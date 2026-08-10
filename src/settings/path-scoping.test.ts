import { describe, it, expect } from "vitest";
import {
	PATH_RULE_STATES,
	PATH_SCOPE_LISTS,
	buildGlobalPathScopes,
	detectRuleNamespace,
	restrictSummary,
	type PathRuleState,
	type PathScopeRule,
} from "./path-scoping";

/** A rule with both directions defaulted, overridden per test. */
function rule(path: string, over: Partial<Omit<PathScopeRule, "path">> = {}): PathScopeRule {
	return { path, read: "default", write: "default", ...over };
}

describe("path scoping definitions", () => {
	it("keeps the four lists the inspector renders as columns", () => {
		expect(PATH_SCOPE_LISTS).toHaveLength(4);
	});

	it("offers a dropdown option for every rule state", () => {
		const states: PathRuleState[] = [
			"default",
			"auto_approve",
			"always_ask",
			"allow",
			"allow_auto",
			"blocked",
		];
		expect(PATH_RULE_STATES.map((s) => s.state)).toEqual(states);
	});
});

describe("detectRuleNamespace", () => {
	it("treats relative paths as governing the vault and the filesystem", () => {
		// Relative prefixes reach both: the filesystem matcher resolves them
		// against the vault root, so `read_file private/x` must be covered too.
		expect(detectRuleNamespace("ai/")).toBe("both");
		expect(detectRuleNamespace("notes/sub")).toBe("both");
		expect(detectRuleNamespace("./x")).toBe("both");
	});

	it("treats ~, root-relative, and drive-qualified paths as filesystem-only", () => {
		expect(detectRuleNamespace("~")).toBe("filesystem");
		expect(detectRuleNamespace("~/Downloads")).toBe("filesystem");
		expect(detectRuleNamespace("/etc")).toBe("filesystem");
		expect(detectRuleNamespace("\\\\server\\share")).toBe("filesystem");
		expect(detectRuleNamespace("C:\\Users")).toBe("filesystem");
		expect(detectRuleNamespace("c:/Users")).toBe("filesystem");
	});

	it("does not mistake a colon in a folder name for a drive letter", () => {
		expect(detectRuleNamespace("c:notes")).toBe("both");
	});

	it("ignores surrounding whitespace", () => {
		expect(detectRuleNamespace("  ~/x  ")).toBe("filesystem");
	});
});

describe("buildGlobalPathScopes", () => {
	it("returns an empty object when nothing is configured", () => {
		expect(buildGlobalPathScopes(undefined)).toEqual({});
		expect(buildGlobalPathScopes([])).toEqual({});
	});

	it("omits groups with no rules, so lookups stay cheap misses", () => {
		const scopes = buildGlobalPathScopes([rule("private/", { write: "blocked" })]);
		expect(Object.keys(scopes).sort()).toEqual(["filesystem-write", "vault-write"]);
		expect(scopes["vault-write"]).toEqual({
			allowed_paths: [],
			blocked_paths: ["private/"],
			auto_approve_paths: [],
			never_auto_approve_paths: [],
		});
	});

	it("contributes nothing for a rule left at default in both directions", () => {
		expect(buildGlobalPathScopes([rule("ai/")])).toEqual({});
	});

	describe("state → list projection", () => {
		it("auto_approve lands in auto_approve_paths", () => {
			const scopes = buildGlobalPathScopes([rule("ai/", { write: "auto_approve" })]);
			expect(scopes["vault-write"]!.auto_approve_paths).toEqual(["ai/"]);
			expect(scopes["vault-write"]!.allowed_paths).toEqual([]);
		});

		it("always_ask lands in never_auto_approve_paths", () => {
			const scopes = buildGlobalPathScopes([rule("ai/", { write: "always_ask" })]);
			expect(scopes["vault-write"]!.never_auto_approve_paths).toEqual(["ai/"]);
		});

		it("allow lands in allowed_paths", () => {
			const scopes = buildGlobalPathScopes([rule("ai/", { write: "allow" })]);
			expect(scopes["vault-write"]!.allowed_paths).toEqual(["ai/"]);
			expect(scopes["vault-write"]!.auto_approve_paths).toEqual([]);
		});

		it("allow_auto lands in both allowed_paths and auto_approve_paths", () => {
			const scopes = buildGlobalPathScopes([rule("ai/", { write: "allow_auto" })]);
			expect(scopes["vault-write"]!.allowed_paths).toEqual(["ai/"]);
			expect(scopes["vault-write"]!.auto_approve_paths).toEqual(["ai/"]);
		});

		it("blocked lands in blocked_paths", () => {
			const scopes = buildGlobalPathScopes([rule("ai/", { write: "blocked" })]);
			expect(scopes["vault-write"]!.blocked_paths).toEqual(["ai/"]);
		});
	});

	it("projects a relative path into both namespaces of the same access", () => {
		const scopes = buildGlobalPathScopes([rule("private/", { read: "blocked" })]);
		expect(scopes["vault-read"]!.blocked_paths).toEqual(["private/"]);
		expect(scopes["filesystem-read"]!.blocked_paths).toEqual(["private/"]);
	});

	it("projects a filesystem path into the filesystem group only", () => {
		const scopes = buildGlobalPathScopes([rule("~/scratch", { write: "allow" })]);
		expect(scopes["filesystem-write"]!.allowed_paths).toEqual(["~/scratch"]);
		expect(scopes["vault-write"]).toBeUndefined();
	});

	it("keeps read and write independent", () => {
		const scopes = buildGlobalPathScopes([rule("ai/", { read: "blocked" })]);
		expect(scopes["vault-read"]!.blocked_paths).toEqual(["ai/"]);
		expect(scopes["vault-write"]).toBeUndefined();
		expect(scopes["filesystem-write"]).toBeUndefined();
	});

	it("expresses the read-wide-open / write-narrowed shape", () => {
		const scopes = buildGlobalPathScopes([
			rule("private/", { write: "blocked" }),
			rule("ai/", { write: "auto_approve" }),
			rule("~/scratch", { write: "allow" }),
		]);
		expect(Object.keys(scopes).sort()).toEqual(["filesystem-write", "vault-write"]);
		expect(scopes["vault-write"]!.auto_approve_paths).toEqual(["ai/"]);
		expect(scopes["vault-write"]!.blocked_paths).toEqual(["private/"]);
		expect(scopes["filesystem-write"]!.allowed_paths).toEqual(["~/scratch"]);
	});

	describe("hand-edited data.json tolerance", () => {
		it("skips rules with a blank or non-string path", () => {
			const scopes = buildGlobalPathScopes([
				rule("   ", { write: "blocked" }),
				rule("", { write: "blocked" }),
				{ path: 42 as unknown as string, read: "blocked", write: "default" },
			]);
			expect(scopes).toEqual({});
		});

		it("treats an unrecognized state as default", () => {
			const scopes = buildGlobalPathScopes([
				rule("ai/", { write: "nonsense" as unknown as PathRuleState }),
			]);
			expect(scopes).toEqual({});
		});

		it("trims the stored path", () => {
			const scopes = buildGlobalPathScopes([rule("  ai/  ", { write: "blocked" })]);
			expect(scopes["vault-write"]!.blocked_paths).toEqual(["ai/"]);
		});

		it("projects duplicate rows for the same path without deduping", () => {
			// Prefix matching is existential, so duplicates are harmless; the UI
			// prevents them but projection must not assume uniqueness.
			const scopes = buildGlobalPathScopes([
				rule("ai/", { write: "blocked" }),
				rule("ai/", { write: "blocked" }),
			]);
			expect(scopes["vault-write"]!.blocked_paths).toEqual(["ai/", "ai/"]);
		});
	});
});

describe("restrictSummary", () => {
	it("reports only groups narrowed by an allow list", () => {
		const summary = restrictSummary([
			rule("ai/", { read: "allow", write: "allow_auto" }),
			rule("notes/", { read: "allow" }),
			rule("private/", { write: "blocked" }),
		]);
		expect(summary["vault-read"]).toEqual(["ai/", "notes/"]);
		expect(summary["vault-write"]).toEqual(["ai/"]);
	});

	it("is empty when no rule restricts anything", () => {
		expect(restrictSummary([rule("private/", { write: "blocked" })])).toEqual({});
		expect(restrictSummary([])).toEqual({});
	});
});
