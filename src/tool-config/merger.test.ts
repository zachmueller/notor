import { describe, it, expect } from "vitest";
import { mergeToolConfigs } from "./merger";
import type { ParsedToolConfig } from "./types";

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
