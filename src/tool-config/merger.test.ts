import { describe, it, expect } from "vitest";
import { mergeToolConfigs, intersectToolConfig } from "./merger";
import type { EffectiveToolConfig, ParsedToolConfig } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(
	source: "rule" | "persona" | "workflow",
	sourceFile: string,
	tools: Record<string, Record<string, unknown>>,
	documentPosition = 0,
): ParsedToolConfig {
	return { source, sourceFile, documentPosition, tools } as ParsedToolConfig;
}

const ALL_TOOLS = ["read_note", "write_note", "execute_command", "fetch_webpage"];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mergeToolConfigs", () => {
	describe("precedence order: workflow > persona > rule > global", () => {
		it("workflow overrides persona overrides rule", () => {
			const configs: ParsedToolConfig[] = [
				makeConfig("rule", "rules/a.md", {
					read_note: { enabled: false, auto_approve: false },
				}),
				makeConfig("persona", "personas/p.md", {
					read_note: { enabled: true },
				}),
				makeConfig("workflow", "workflows/w.md", {
					read_note: { auto_approve: true },
				}),
			];

			const result = mergeToolConfigs(configs, {}, ALL_TOOLS);

			// persona enabled=true overrides rule enabled=false
			expect(result.tools.read_note!.enabled).toBe(true);
			// workflow auto_approve=true overrides rule auto_approve=false
			expect(result.tools.read_note!.auto_approve).toBe(true);
		});
	});

	describe("sparse merge: higher-priority omitted field does not override", () => {
		it("preserves lower-priority value when higher omits the field", () => {
			const configs: ParsedToolConfig[] = [
				makeConfig("rule", "rules/a.md", {
					read_note: { enabled: false, auto_approve: true },
				}),
				makeConfig("workflow", "workflows/w.md", {
					read_note: { enabled: true },
					// auto_approve omitted — should NOT override rule's value
				}),
			];

			const result = mergeToolConfigs(configs, {}, ALL_TOOLS);

			expect(result.tools.read_note!.enabled).toBe(true);
			expect(result.tools.read_note!.auto_approve).toBe(true); // from rule
		});
	});

	describe("replace semantics for allowed_paths / blocked_paths", () => {
		it("higher-priority completely replaces lower-priority paths", () => {
			const configs: ParsedToolConfig[] = [
				makeConfig("rule", "rules/a.md", {
					read_note: {
						allowed_paths: ["notes/", "journal/"],
						blocked_paths: ["private/"],
					},
				}),
				makeConfig("persona", "personas/p.md", {
					read_note: {
						allowed_paths: ["only-this/"],
					},
				}),
			];

			const result = mergeToolConfigs(configs, {}, ALL_TOOLS);

			// Persona's allowed_paths replaces rule's entirely
			expect(result.tools.read_note!.allowed_paths).toEqual(["only-this/"]);
			// Rule's blocked_paths preserved (persona didn't set it)
			expect(result.tools.read_note!.blocked_paths).toEqual(["private/"]);
		});
	});

	describe("default fill for unmentioned tools", () => {
		it("fills defaults for tools not mentioned in any config", () => {
			const configs: ParsedToolConfig[] = [
				makeConfig("persona", "personas/p.md", {
					read_note: { enabled: false },
				}),
			];

			const result = mergeToolConfigs(configs, {}, ALL_TOOLS);

			// read_note has explicit config
			expect(result.tools.read_note!.enabled).toBe(false);

			// write_note not mentioned → defaults
			expect(result.tools.write_note!.enabled).toBe(true);
			expect(result.tools.write_note!.auto_approve).toBe(false);
			expect(result.tools.write_note!.allowed_paths).toEqual([]);
			expect(result.tools.write_note!.blocked_paths).toEqual([]);
		});
	});

	describe("globalAutoApprove correctly applied", () => {
		it("uses globalAutoApprove for default auto_approve values", () => {
			const globalAutoApprove: Record<string, boolean> = {
				read_note: true,
				write_note: false,
				execute_command: true,
			};

			const result = mergeToolConfigs([], globalAutoApprove, ALL_TOOLS);

			expect(result.tools.read_note!.auto_approve).toBe(true);
			expect(result.tools.write_note!.auto_approve).toBe(false);
			expect(result.tools.execute_command!.auto_approve).toBe(true);
			// Not in globalAutoApprove → defaults to false
			expect(result.tools.fetch_webpage!.auto_approve).toBe(false);
		});

		it("config overrides globalAutoApprove", () => {
			const globalAutoApprove = { read_note: true };
			const configs: ParsedToolConfig[] = [
				makeConfig("persona", "p.md", {
					read_note: { auto_approve: false },
				}),
			];

			const result = mergeToolConfigs(configs, globalAutoApprove, ALL_TOOLS);
			expect(result.tools.read_note!.auto_approve).toBe(false);
		});

		it("handles MCP server-level autoApprove in namespaced format", () => {
			const mcpTools = [...ALL_TOOLS, "myserver__list", "myserver__search"];
			const globalAutoApprove = {
				myserver__list: true,
				myserver__search: false,
			};

			const result = mergeToolConfigs([], globalAutoApprove, mcpTools);

			expect(result.tools["myserver__list"]!.auto_approve).toBe(true);
			expect(result.tools["myserver__search"]!.auto_approve).toBe(false);
		});
	});

	describe("document position ordering within same source type", () => {
		it("later document position wins within same source type", () => {
			const configs: ParsedToolConfig[] = [
				makeConfig("rule", "rules/a.md", { read_note: { enabled: false } }, 0),
				makeConfig("rule", "rules/a.md", { read_note: { enabled: true } }, 100),
			];

			const result = mergeToolConfigs(configs, {}, ALL_TOOLS);
			expect(result.tools.read_note!.enabled).toBe(true);
		});

		it("earlier document position is overridden by later one", () => {
			const configs: ParsedToolConfig[] = [
				makeConfig("persona", "p.md", { write_note: { auto_approve: true } }, 500),
				makeConfig("persona", "p.md", { write_note: { auto_approve: false } }, 1000),
			];

			const result = mergeToolConfigs(configs, {}, ALL_TOOLS);
			expect(result.tools.write_note!.auto_approve).toBe(false);
		});
	});

	describe("all tools have fully resolved entries", () => {
		it("every tool in allToolNames has all fields defined", () => {
			const result = mergeToolConfigs([], {}, ALL_TOOLS);

			for (const toolName of ALL_TOOLS) {
				const entry = result.tools[toolName];
				expect(entry).toBeDefined();
				expect(typeof entry!.enabled).toBe("boolean");
				expect(typeof entry!.auto_approve).toBe("boolean");
				expect(Array.isArray(entry!.allowed_paths)).toBe(true);
				expect(Array.isArray(entry!.blocked_paths)).toBe(true);
			}
		});
	});

	describe("globalEnabled correctly applied", () => {
		it("uses globalEnabled for default enabled values", () => {
			const globalEnabled: Record<string, boolean> = {
				read_note: true,
				write_note: false,
				execute_command: false,
			};

			const result = mergeToolConfigs([], {}, ALL_TOOLS, globalEnabled);

			expect(result.tools.read_note!.enabled).toBe(true);
			expect(result.tools.write_note!.enabled).toBe(false);
			expect(result.tools.execute_command!.enabled).toBe(false);
			// Not in globalEnabled → defaults to true
			expect(result.tools.fetch_webpage!.enabled).toBe(true);
		});

		it("config overrides globalEnabled", () => {
			const globalEnabled = { read_note: false };
			const configs: ParsedToolConfig[] = [
				makeConfig("persona", "p.md", {
					read_note: { enabled: true },
				}),
			];

			const result = mergeToolConfigs(configs, {}, ALL_TOOLS, globalEnabled);
			expect(result.tools.read_note!.enabled).toBe(true);
		});

		it("handles MCP tool enabled in namespaced format", () => {
			const mcpTools = [...ALL_TOOLS, "myserver__list", "myserver__search"];
			const globalEnabled = {
				"myserver__list": false,
				"myserver__search": true,
			};

			const result = mergeToolConfigs([], {}, mcpTools, globalEnabled);

			expect(result.tools["myserver__list"]!.enabled).toBe(false);
			expect(result.tools["myserver__search"]!.enabled).toBe(true);
		});
	});

	describe("empty configs list", () => {
		it("returns defaults for all tools when no configs provided", () => {
			const result = mergeToolConfigs([], {}, ALL_TOOLS);

			for (const toolName of ALL_TOOLS) {
				expect(result.tools[toolName]!.enabled).toBe(true);
				expect(result.tools[toolName]!.auto_approve).toBe(false);
				expect(result.tools[toolName]!.allowed_paths).toEqual([]);
				expect(result.tools[toolName]!.blocked_paths).toEqual([]);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// intersectToolConfig
// ---------------------------------------------------------------------------

describe("intersectToolConfig", () => {
	/** Build a parent EffectiveToolConfig from a partial map. */
	function makeParent(
		tools: Record<
			string,
			{
				enabled?: boolean;
				auto_approve?: boolean;
				allowed_paths?: string[];
				blocked_paths?: string[];
			}
		>,
	): EffectiveToolConfig {
		const resolved: EffectiveToolConfig = { tools: {} };
		for (const [name, entry] of Object.entries(tools)) {
			resolved.tools[name] = {
				enabled: entry.enabled ?? true,
				auto_approve: entry.auto_approve ?? false,
				allowed_paths: entry.allowed_paths ?? [],
				blocked_paths: entry.blocked_paths ?? [],
			};
		}
		return resolved;
	}

	/** Build a sub-agent ParsedToolConfig. */
	function makeSubAgentConfig(
		tools: Record<string, Record<string, unknown>>,
	): ParsedToolConfig {
		return {
			source: "persona",
			sourceFile: "sub-agents/test/system-prompt.md",
			documentPosition: 0,
			tools,
		} as ParsedToolConfig;
	}

	const TOOL_MODES: Record<string, "read" | "write"> = {
		read_note: "read",
		write_note: "write",
		search_vault: "read",
		execute_command: "write",
		fetch_webpage: "read",
	};

	describe("default-deny: tools not in sub-agent config are excluded", () => {
		it("only includes tools explicitly mentioned in sub-agent config", () => {
			const parent = makeParent({
				read_note: {},
				write_note: {},
				search_vault: {},
			});
			const subAgent = makeSubAgentConfig({
				read_note: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);

			expect(result.tools.read_note).toBeDefined();
			expect(result.tools.write_note).toBeUndefined();
			expect(result.tools.search_vault).toBeUndefined();
		});
	});

	describe("enabled: AND semantics", () => {
		it("sub-agent enables tool that parent disabled → tool is disabled", () => {
			const parent = makeParent({
				read_note: { enabled: false },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.enabled).toBe(false);
		});

		it("sub-agent enables tool that parent enabled → tool is enabled", () => {
			const parent = makeParent({
				read_note: { enabled: true },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.enabled).toBe(true);
		});

		it("sub-agent disables tool that parent enabled → tool is disabled", () => {
			const parent = makeParent({
				read_note: { enabled: true },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { enabled: false },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.enabled).toBe(false);
		});

		it("sub-agent omits enabled field → defaults to true, AND with parent", () => {
			const parent = makeParent({
				read_note: { enabled: true },
			});
			const subAgent = makeSubAgentConfig({
				read_note: {}, // enabled omitted → defaults to true
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.enabled).toBe(true);
		});
	});

	describe("allowed_paths: intersection semantics", () => {
		it("both have paths → only common paths remain", () => {
			const parent = makeParent({
				read_note: { allowed_paths: ["notes/", "journal/", "shared/"] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { allowed_paths: ["journal/", "shared/", "archive/"] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.allowed_paths).toEqual(["journal/", "shared/"]);
		});

		it("parent empty (no restriction), sub-agent has paths → sub-agent paths win", () => {
			const parent = makeParent({
				read_note: { allowed_paths: [] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { allowed_paths: ["notes/only/"] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.allowed_paths).toEqual(["notes/only/"]);
		});

		it("sub-agent empty (no restriction), parent has paths → parent paths win", () => {
			const parent = makeParent({
				read_note: { allowed_paths: ["notes/"] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { allowed_paths: [] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.allowed_paths).toEqual(["notes/"]);
		});

		it("both empty → empty (no restriction)", () => {
			const parent = makeParent({
				read_note: { allowed_paths: [] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { allowed_paths: [] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.allowed_paths).toEqual([]);
		});

		it("no overlap → empty result (nothing allowed)", () => {
			const parent = makeParent({
				read_note: { allowed_paths: ["notes/"] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { allowed_paths: ["journal/"] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.allowed_paths).toEqual([]);
		});

		it("sub-agent omits allowed_paths → treated as empty (no restriction)", () => {
			const parent = makeParent({
				read_note: { allowed_paths: ["notes/"] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { enabled: true },
				// allowed_paths omitted
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.allowed_paths).toEqual(["notes/"]);
		});
	});

	describe("blocked_paths: union semantics", () => {
		it("combines blocked paths from both parent and sub-agent", () => {
			const parent = makeParent({
				read_note: { blocked_paths: ["private/"] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { blocked_paths: ["secrets/"] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.blocked_paths).toEqual(["private/", "secrets/"]);
		});

		it("deduplicates common blocked paths", () => {
			const parent = makeParent({
				read_note: { blocked_paths: ["private/", "secrets/"] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { blocked_paths: ["secrets/", "hidden/"] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.blocked_paths).toEqual([
				"private/",
				"secrets/",
				"hidden/",
			]);
		});

		it("parent empty, sub-agent has blocks → sub-agent blocks used", () => {
			const parent = makeParent({
				read_note: { blocked_paths: [] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { blocked_paths: ["private/"] },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.blocked_paths).toEqual(["private/"]);
		});

		it("sub-agent omits blocked_paths → parent blocks preserved", () => {
			const parent = makeParent({
				read_note: { blocked_paths: ["private/"] },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.blocked_paths).toEqual(["private/"]);
		});
	});

	describe("auto_approve: read tools forced true, write tools inherit parent", () => {
		it("read tools get auto_approve=true regardless of parent config", () => {
			const parent = makeParent({
				read_note: { auto_approve: false },
				search_vault: { auto_approve: false },
			});
			const subAgent = makeSubAgentConfig({
				read_note: { enabled: true },
				search_vault: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.read_note!.auto_approve).toBe(true);
			expect(result.tools.search_vault!.auto_approve).toBe(true);
		});

		it("write tools inherit parent's auto_approve=true", () => {
			const parent = makeParent({
				write_note: { auto_approve: true },
			});
			const subAgent = makeSubAgentConfig({
				write_note: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.write_note!.auto_approve).toBe(true);
		});

		it("write tools inherit parent's auto_approve=false", () => {
			const parent = makeParent({
				write_note: { auto_approve: false },
			});
			const subAgent = makeSubAgentConfig({
				write_note: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.write_note!.auto_approve).toBe(false);
		});

		it("tool with unknown mode gets parent's auto_approve (no forced true)", () => {
			const parent = makeParent({
				custom_tool: { auto_approve: false },
			});
			const subAgent = makeSubAgentConfig({
				custom_tool: { enabled: true },
			});

			// custom_tool not in TOOL_MODES → mode is undefined, not "read"
			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.custom_tool!.auto_approve).toBe(false);
		});
	});

	describe("tool not in parent → disabled", () => {
		it("sub-agent requests tool parent doesn't know about → disabled entry", () => {
			const parent = makeParent({
				read_note: {},
			});
			const subAgent = makeSubAgentConfig({
				nonexistent_tool: { enabled: true },
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);
			expect(result.tools.nonexistent_tool!.enabled).toBe(false);
			expect(result.tools.nonexistent_tool!.auto_approve).toBe(false);
		});
	});

	describe("combined scenarios", () => {
		it("full intersection with multiple tools and mixed configs", () => {
			const parent = makeParent({
				read_note: {
					enabled: true,
					auto_approve: false,
					allowed_paths: ["notes/", "journal/"],
					blocked_paths: ["private/"],
				},
				write_note: {
					enabled: true,
					auto_approve: true,
					allowed_paths: ["notes/"],
					blocked_paths: [],
				},
				search_vault: { enabled: false },
				execute_command: { enabled: true, auto_approve: false },
			});
			const subAgent = makeSubAgentConfig({
				read_note: {
					enabled: true,
					allowed_paths: ["journal/", "archive/"],
					blocked_paths: ["journal/secret/"],
				},
				write_note: { enabled: true, allowed_paths: ["notes/"] },
				search_vault: { enabled: true }, // parent disabled → stays disabled
			});

			const result = intersectToolConfig(parent, subAgent, TOOL_MODES);

			// read_note: enabled, read→auto_approve=true, paths intersected/unioned
			expect(result.tools.read_note!.enabled).toBe(true);
			expect(result.tools.read_note!.auto_approve).toBe(true);
			expect(result.tools.read_note!.allowed_paths).toEqual(["journal/"]);
			expect(result.tools.read_note!.blocked_paths).toEqual([
				"private/",
				"journal/secret/",
			]);

			// write_note: enabled, write→inherits parent auto_approve=true
			expect(result.tools.write_note!.enabled).toBe(true);
			expect(result.tools.write_note!.auto_approve).toBe(true);
			expect(result.tools.write_note!.allowed_paths).toEqual(["notes/"]);

			// search_vault: parent disabled AND sub-agent enabled → disabled
			expect(result.tools.search_vault!.enabled).toBe(false);

			// execute_command: not in sub-agent config → not in result
			expect(result.tools.execute_command).toBeUndefined();
		});
	});
});
