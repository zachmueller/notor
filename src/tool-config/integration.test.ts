/**
 * Integration test — end-to-end tool config flow.
 *
 * Tests the full pipeline from `<notor_tool_config>` tag in source text
 * through parsing, merging, and enforcement.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/mcp-tool-adapter", () => ({
	isMcpTool: (name: string) => name.includes("__"),
	parseMcpToolName: (name: string) => {
		const idx = name.indexOf("__");
		if (idx === -1) return { serverName: "", toolName: name };
		return { serverName: name.substring(0, idx), toolName: name.substring(idx + 2) };
	},
}));

import { extractToolConfigs } from "./parser";
import { mergeToolConfigs } from "./merger";
import { enforcePathConstraints, evaluatePathApproval, TOOL_PATH_PARAMS } from "./path-enforcer";
import type { ParsedToolConfig, PathGroup, PathListSet } from "./types";
import { buildGlobalPathScopes, pathScopeKey } from "../settings/path-scoping";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_TOOLS = [
	"read_note", "write_note", "replace_in_note",
	"read_frontmatter", "update_frontmatter", "manage_tags", "move_note", "delete_note",
	"search_vault", "list_vault",
	"read_file", "read_docx", "write_docx", "import_docx",
	"execute_command", "fetch_webpage",
	"browser__screenshot", "browser__click", "browser__navigate", "browser__type",
];

/** Simple mock parser for YAML-like content */
function mockParseYAML(yamlObj: unknown): (text: string) => unknown {
	return () => yamlObj;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("end-to-end tool config flow", () => {
	beforeEach(() => {
		// TOOL_PATH_PARAMS is dynamically populated post-migration (Phase 7.3).
		// Seed entries needed by path enforcement tests.
		for (const key of Object.keys(TOOL_PATH_PARAMS)) delete TOOL_PATH_PARAMS[key];
		TOOL_PATH_PARAMS["read_note"] = [{ paramName: "path", namespace: "vault" , access: "write" as const }];
	});

	describe("persona disabling tools -> LLM tool list excludes disabled tools", () => {
		it("disabled tools are filtered from effective config", () => {
			const personaText = `You are a research assistant.
<notor_tool_config>
placeholder
</notor_tool_config>
Focus on reading.`;

			const personaYAML = {
				execute_command: { enabled: false },
				write_note: { enabled: false },
			};

			const result = extractToolConfigs(
				personaText, "persona", "personas/researcher/system-prompt.md",
				ALL_TOOLS, mockParseYAML(personaYAML),
			);

			expect(result.errors).toHaveLength(0);
			expect(result.strippedContent).not.toContain("notor_tool_config");

			const effective = mergeToolConfigs(result.configs, {}, ALL_TOOLS);

			expect(effective.tools.execute_command!.enabled).toBe(false);
			expect(effective.tools.write_note!.enabled).toBe(false);
			expect(effective.tools.read_note!.enabled).toBe(true);

			// Simulate filtering for LLM tool list
			const enabledTools = ALL_TOOLS.filter((t) => effective.tools[t]?.enabled !== false);
			expect(enabledTools).not.toContain("execute_command");
			expect(enabledTools).not.toContain("write_note");
			expect(enabledTools).toContain("read_note");
		});
	});

	describe("workflow overriding persona config -> correct precedence", () => {
		it("workflow auto_approve overrides persona auto_approve", () => {
			const personaConfigs: ParsedToolConfig[] = [{
				source: "persona",
				sourceFile: "personas/p.md",
				documentPosition: 0,
				tools: {
					read_note: { enabled: true, auto_approve: false },
					write_note: { enabled: false },
				},
			}];

			const workflowConfigs: ParsedToolConfig[] = [{
				source: "workflow",
				sourceFile: "workflows/w.md",
				documentPosition: 0,
				tools: {
					read_note: { auto_approve: true },
					write_note: { enabled: true }, // re-enable what persona disabled
				},
			}];

			const allConfigs = [...personaConfigs, ...workflowConfigs];
			const effective = mergeToolConfigs(allConfigs, {}, ALL_TOOLS);

			// Workflow overrides persona
			expect(effective.tools.read_note!.auto_approve).toBe(true);
			expect(effective.tools.write_note!.enabled).toBe(true);
			// Persona's enabled=true preserved (workflow didn't set it for read_note)
			expect(effective.tools.read_note!.enabled).toBe(true);
		});
	});

	describe("rule activating mid-conversation -> config recomputed", () => {
		it("adding a rule config changes effective result", () => {
			// First iteration: no rules
			const effective1 = mergeToolConfigs([], {}, ALL_TOOLS);
			expect(effective1.tools.execute_command!.enabled).toBe(true);

			// Second iteration: rule disables execute_command
			const ruleConfigs: ParsedToolConfig[] = [{
				source: "rule",
				sourceFile: "rules/no-shell.md",
				documentPosition: 0,
				tools: { execute_command: { enabled: false } },
			}];
			const effective2 = mergeToolConfigs(ruleConfigs, {}, ALL_TOOLS);
			expect(effective2.tools.execute_command!.enabled).toBe(false);
		});
	});

	describe("disabled tool call -> blocked with correct error message", () => {
		it("simulates dispatcher blocking a disabled tool", () => {
			const configs: ParsedToolConfig[] = [{
				source: "persona",
				sourceFile: "personas/safe.md",
				documentPosition: 0,
				tools: { execute_command: { enabled: false } },
			}];

			const effective = mergeToolConfigs(configs, {}, ALL_TOOLS);
			const toolEntry = effective.tools.execute_command!;

			// Simulate dispatcher enabled check
			if (!toolEntry.enabled) {
				const errorMessage = `Tool 'execute_command' is disabled and cannot be used in this context.`;
				expect(errorMessage).toContain("disabled");
				expect(errorMessage).toContain("execute_command");
			} else {
				throw new Error("Expected tool to be disabled");
			}
		});
	});

	describe("path-restricted tool call -> blocked when outside allowed range", () => {
		it("full pipeline: parse -> merge -> enforce path", () => {
			const personaConfigs: ParsedToolConfig[] = [{
				source: "persona",
				sourceFile: "personas/scoped.md",
				documentPosition: 0,
				tools: {
					read_note: {
						allowed_paths: ["notes/project/"],
						blocked_paths: ["notes/project/secret/"],
					},
				},
			}];

			const effective = mergeToolConfigs(personaConfigs, {}, ALL_TOOLS);

			// Allowed path
			const allowed = enforcePathConstraints(
				"read_note",
				{ path: "notes/project/readme.md" },
				effective.tools.read_note!,
				"/vault",
			);
			expect(allowed).toBeNull();

			// Blocked path (in blocked subdir)
			const blocked = enforcePathConstraints(
				"read_note",
				{ path: "notes/project/secret/keys.md" },
				effective.tools.read_note!,
				"/vault",
			);
			expect(blocked).not.toBeNull();
			expect(blocked).toContain("is blocked");

			// Outside allowed range
			const outside = enforcePathConstraints(
				"read_note",
				{ path: "journal/entry.md" },
				effective.tools.read_note!,
				"/vault",
			);
			expect(outside).not.toBeNull();
			expect(outside).toContain("not within any allowed path");
		});
	});

	describe("include_note embedding a shared config -> extracted correctly", () => {
		it("simulates post-include-resolution extraction", () => {
			// After <include_note> resolution, the persona content has inline config
			const resolvedPersonaContent = `You are a helper.

Here is the shared config from an included note:
<notor_tool_config>
placeholder
</notor_tool_config>

Continue with your task.`;

			const sharedConfigYAML = {
				execute_command: { enabled: false, auto_approve: false },
				read_note: { auto_approve: true },
			};

			const result = extractToolConfigs(
				resolvedPersonaContent, "persona", "personas/helper/system-prompt.md",
				ALL_TOOLS, mockParseYAML(sharedConfigYAML),
			);

			expect(result.errors).toHaveLength(0);
			expect(result.configs).toHaveLength(1);
			expect(result.strippedContent).not.toContain("notor_tool_config");
			expect(result.strippedContent).toContain("shared config from an included note");

			const effective = mergeToolConfigs(result.configs, {}, ALL_TOOLS);
			expect(effective.tools.execute_command!.enabled).toBe(false);
			expect(effective.tools.read_note!.auto_approve).toBe(true);
		});
	});

	describe("MCP server wildcard -> disable all, re-enable specific tools", () => {
		it("persona wildcard disables server, specific entries re-enable subset", () => {
			const personaConfigs: ParsedToolConfig[] = [{
				source: "persona",
				sourceFile: "personas/focused.md",
				documentPosition: 0,
				tools: {
					"browser__screenshot": { enabled: true },
					"browser__click": { enabled: true, auto_approve: true },
				},
				serverDefaults: {
					browser: { enabled: false },
				},
			}];

			const effective = mergeToolConfigs(personaConfigs, {}, ALL_TOOLS);

			// Wildcard-disabled tools
			expect(effective.tools["browser__navigate"]!.enabled).toBe(false);
			expect(effective.tools["browser__type"]!.enabled).toBe(false);
			// Explicitly re-enabled tools
			expect(effective.tools["browser__screenshot"]!.enabled).toBe(true);
			expect(effective.tools["browser__click"]!.enabled).toBe(true);
			expect(effective.tools["browser__click"]!.auto_approve).toBe(true);
			// Built-in tools unaffected
			expect(effective.tools.read_note!.enabled).toBe(true);

			// Simulate LLM tool filtering
			const enabledTools = ALL_TOOLS.filter((t) => effective.tools[t]?.enabled !== false);
			expect(enabledTools).toContain("browser__screenshot");
			expect(enabledTools).toContain("browser__click");
			expect(enabledTools).not.toContain("browser__navigate");
			expect(enabledTools).not.toContain("browser__type");
			expect(enabledTools).toContain("read_note");
		});

		it("workflow re-enables tool that persona wildcard disabled", () => {
			const personaConfigs: ParsedToolConfig[] = [{
				source: "persona",
				sourceFile: "personas/p.md",
				documentPosition: 0,
				tools: {},
				serverDefaults: { browser: { enabled: false } },
			}];
			const workflowConfigs: ParsedToolConfig[] = [{
				source: "workflow",
				sourceFile: "workflows/w.md",
				documentPosition: 0,
				tools: {
					"browser__navigate": { enabled: true },
				},
			}];

			const effective = mergeToolConfigs(
				[...personaConfigs, ...workflowConfigs], {}, ALL_TOOLS,
			);

			expect(effective.tools["browser__navigate"]!.enabled).toBe(true);
			expect(effective.tools["browser__screenshot"]!.enabled).toBe(false);
			expect(effective.tools["browser__click"]!.enabled).toBe(false);
		});
	});

	describe("multiple sources combined", () => {
		it("rule + persona + workflow merge in correct precedence order", () => {
			const ruleConfig: ParsedToolConfig = {
				source: "rule",
				sourceFile: "rules/safety.md",
				documentPosition: 0,
				tools: {
					execute_command: { enabled: false },
					write_note: { auto_approve: false },
					read_note: { allowed_paths: ["archive/"] },
				},
			};

			const personaConfig: ParsedToolConfig = {
				source: "persona",
				sourceFile: "personas/editor.md",
				documentPosition: 0,
				tools: {
					write_note: { auto_approve: true },
					read_note: { allowed_paths: ["notes/", "drafts/"] },
				},
			};

			const workflowConfig: ParsedToolConfig = {
				source: "workflow",
				sourceFile: "workflows/publish.md",
				documentPosition: 0,
				tools: {
					execute_command: { enabled: true }, // re-enable what rule disabled
				},
			};

			const effective = mergeToolConfigs(
				[ruleConfig, personaConfig, workflowConfig],
				{ read_note: true },
				ALL_TOOLS,
			);

			// Workflow re-enables execute_command over rule
			expect(effective.tools.execute_command!.enabled).toBe(true);
			// Persona overrides rule's write_note auto_approve
			expect(effective.tools.write_note!.auto_approve).toBe(true);
			// Persona replaces rule's allowed_paths for read_note
			expect(effective.tools.read_note!.allowed_paths).toEqual(["notes/", "drafts/"]);
			// globalAutoApprove used for unmentioned tools
			expect(effective.tools.read_note!.auto_approve).toBe(true); // from globalAutoApprove
		});
	});

	// ---------------------------------------------------------------------------
	// Global group scopes: access tier is a FLOOR (a persona can only narrow it),
	// approval tier is a DEFAULT (a persona replaces it outright).
	// ---------------------------------------------------------------------------

	describe("global path scopes vs per-context config", () => {
		const VAULT_ROOT = "/vault";

		/** Build global scopes the way Settings → config-resolver does. */
		function scopes(
			overrides: Partial<Record<PathGroup, Partial<PathListSet>>>,
		): Partial<Record<PathGroup, PathListSet>> {
			const shared: Record<string, string[]> = {};
			for (const [group, lists] of Object.entries(overrides)) {
				for (const [list, paths] of Object.entries(lists ?? {})) {
					shared[pathScopeKey(group as PathGroup, list as keyof PathListSet)] = paths as string[];
				}
			}
			return buildGlobalPathScopes(shared);
		}

		beforeEach(() => {
			for (const key of Object.keys(TOOL_PATH_PARAMS)) delete TOOL_PATH_PARAMS[key];
			TOOL_PATH_PARAMS["write_note"] = [
				{ paramName: "path", namespace: "vault", resolveAs: "note", access: "write" },
			];
			TOOL_PATH_PARAMS["read_note"] = [
				{ paramName: "path", namespace: "vault", resolveAs: "note", access: "read" },
			];
			// A mixed tool: reads a filesystem file, writes a vault note.
			TOOL_PATH_PARAMS["import_docx"] = [
				{ paramName: "path", namespace: "filesystem", access: "read" },
				{ paramName: "note_path", namespace: "vault", access: "write" },
			];
		});

		it("a global block applies with no per-context config at all", () => {
			const effective = mergeToolConfigs(
				[], {}, ALL_TOOLS, {}, scopes({ "vault-write": { blocked_paths: ["private/"] } }),
			);
			const error = enforcePathConstraints(
				"write_note", { path: "private/x.md" }, effective.tools.write_note!, VAULT_ROOT,
			);
			expect(error).toContain("blocked by path constraint");
		});

		it("a persona cannot widen a global block (access tier is a floor)", () => {
			// The persona allows all of private/ — the global block still wins.
			const personaConfig: ParsedToolConfig = {
				source: "persona", sourceFile: "p.md", documentPosition: 0,
				tools: { write_note: { allowed_paths: ["private/"] } },
			};
			const effective = mergeToolConfigs(
				[personaConfig], {}, ALL_TOOLS, {},
				scopes({ "vault-write": { blocked_paths: ["private/"] } }),
			);
			expect(
				enforcePathConstraints(
					"write_note", { path: "private/x.md" }, effective.tools.write_note!, VAULT_ROOT,
				),
			).toContain("blocked by path constraint");
		});

		it("allow lists intersect — only paths both permit are allowed", () => {
			const personaConfig: ParsedToolConfig = {
				source: "persona", sourceFile: "p.md", documentPosition: 0,
				tools: { write_note: { allowed_paths: ["ai/", "drafts/"] } },
			};
			const effective = mergeToolConfigs(
				[personaConfig], {}, ALL_TOOLS, {},
				scopes({ "vault-write": { allowed_paths: ["ai/", "notes/"] } }),
			);
			const entry = effective.tools.write_note!;

			// ai/ is in both → allowed.
			expect(enforcePathConstraints("write_note", { path: "ai/x.md" }, entry, VAULT_ROOT)).toBeNull();
			// drafts/ only the persona allows → not allowed.
			expect(
				enforcePathConstraints("write_note", { path: "drafts/x.md" }, entry, VAULT_ROOT),
			).toContain("not within any allowed path");
			// notes/ only the global allows → not allowed.
			expect(
				enforcePathConstraints("write_note", { path: "notes/x.md" }, entry, VAULT_ROOT),
			).toContain("not within any allowed path");
		});

		it("a session-allowed scratchpad still loses to a global group block", () => {
			const effective = mergeToolConfigs(
				[], {}, ALL_TOOLS, {},
				scopes({ "vault-write": { blocked_paths: ["scratch/"] } }),
			);
			expect(
				enforcePathConstraints(
					"write_note", { path: "scratch/plan.md" }, effective.tools.write_note!,
					VAULT_ROOT, undefined, ["scratch/"],
				),
			).toContain("blocked by path constraint");
		});

		it("global auto_approve_paths acts as a default when the tool sets none", () => {
			const effective = mergeToolConfigs(
				[], {}, ALL_TOOLS, {}, scopes({ "vault-write": { auto_approve_paths: ["ai/"] } }),
			);
			const entry = effective.tools.write_note!;

			expect(evaluatePathApproval("write_note", { path: "ai/x.md" }, entry, VAULT_ROOT).verdict)
				.toBe("allow");
			expect(evaluatePathApproval("write_note", { path: "other/x.md" }, entry, VAULT_ROOT).verdict)
				.toBe("none");
		});

		it("a persona replaces the global approval default outright", () => {
			const personaConfig: ParsedToolConfig = {
				source: "persona", sourceFile: "p.md", documentPosition: 0,
				tools: { write_note: { auto_approve_paths: ["drafts/"] } },
			};
			const effective = mergeToolConfigs(
				[personaConfig], {}, ALL_TOOLS, {},
				scopes({ "vault-write": { auto_approve_paths: ["ai/"] } }),
			);
			const entry = effective.tools.write_note!;

			// The persona's list replaces the global one rather than intersecting.
			expect(evaluatePathApproval("write_note", { path: "drafts/x.md" }, entry, VAULT_ROOT).verdict)
				.toBe("allow");
			expect(evaluatePathApproval("write_note", { path: "ai/x.md" }, entry, VAULT_ROOT).verdict)
				.toBe("none");
		});

		it("read and write groups restrict independently — the dominant configuration", () => {
			// "Read wide open, write narrowed": the whole reason groups are keyed on
			// namespace × access rather than per tool.
			const effective = mergeToolConfigs(
				[], {}, ALL_TOOLS, {}, scopes({ "vault-write": { allowed_paths: ["ai/"] } }),
			);

			expect(
				enforcePathConstraints(
					"read_note", { path: "anywhere/x.md" }, effective.tools.read_note!, VAULT_ROOT,
				),
			).toBeNull();
			expect(
				enforcePathConstraints(
					"write_note", { path: "anywhere/x.md" }, effective.tools.write_note!, VAULT_ROOT,
				),
			).toContain("not within any allowed path");
		});

		it("a mixed tool obeys a different group per path parameter", () => {
			// import_docx reads a filesystem file and writes a vault note, so its two
			// params are governed by filesystem-read and vault-write respectively.
			const effective = mergeToolConfigs(
				[], {}, ALL_TOOLS, {},
				scopes({
					"filesystem-read": { allowed_paths: ["/inbox"] },
					"vault-write": { allowed_paths: ["ai/"] },
				}),
			);
			const entry = effective.tools.import_docx!;

			// Both params in bounds → allowed.
			expect(
				enforcePathConstraints(
					"import_docx", { path: "/inbox/a.docx", note_path: "ai/a.md" }, entry, VAULT_ROOT,
				),
			).toBeNull();
			// Filesystem source out of bounds.
			expect(
				enforcePathConstraints(
					"import_docx", { path: "/elsewhere/a.docx", note_path: "ai/a.md" }, entry, VAULT_ROOT,
				),
			).toContain("not within any allowed path");
			// Vault destination out of bounds.
			expect(
				enforcePathConstraints(
					"import_docx", { path: "/inbox/a.docx", note_path: "private/a.md" }, entry, VAULT_ROOT,
				),
			).toContain("not within any allowed path");
		});

		it("no global scopes configured → behaves exactly as before", () => {
			const effective = mergeToolConfigs([], {}, ALL_TOOLS);
			expect(effective.tools.write_note!.path_scopes).toEqual({});
			expect(
				enforcePathConstraints(
					"write_note", { path: "anywhere/x.md" }, effective.tools.write_note!, VAULT_ROOT,
				),
			).toBeNull();
		});
	});
});
