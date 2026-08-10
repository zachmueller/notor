import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/mcp-tool-adapter", () => ({
	isMcpTool: (name: string) => name.includes("__"),
}));

import { extractToolConfigs } from "./parser";

// Simple YAML-like parser for tests (mirrors obsidian's parseYAML behavior)
function parseYAML(text: string): unknown {
	// Handle empty / whitespace
	const trimmed = text.trim();
	if (!trimmed) return null;

	// Simple key-value YAML parser for test purposes
	const result: Record<string, Record<string, unknown>> = {};
	let currentTool: string | null = null;

	for (const line of trimmed.split("\n")) {
		const stripped = line.trimEnd();
		if (!stripped || stripped.startsWith("#")) continue;

		// Top-level key (no leading whitespace, ends with ':')
		const topMatch = stripped.match(/^(\S+):\s*$/);
		if (topMatch) {
			currentTool = topMatch[1]!;
			result[currentTool] = {};
			continue;
		}

		// Inline top-level key:value
		const topInlineMatch = stripped.match(/^(\S+):\s+(.+)$/);
		if (topInlineMatch && !stripped.startsWith(" ") && !stripped.startsWith("\t")) {
			currentTool = topInlineMatch[1]!;
			const val = parseValue(topInlineMatch[2]!);
			if (typeof val === "object" && val !== null && !Array.isArray(val)) {
				result[currentTool] = val as Record<string, unknown>;
			} else {
				result[currentTool] = {};
			}
			continue;
		}

		// Nested field
		if (currentTool) {
			const fieldMatch = stripped.match(/^\s+(\S+):\s*(.*)$/);
			if (fieldMatch) {
				const fieldName = fieldMatch[1]!;
				const rawValue = fieldMatch[2]!.trim();

				if (!rawValue) {
					// Array follows on subsequent lines
					result[currentTool]![fieldName] = [];
				} else {
					result[currentTool]![fieldName] = parseValue(rawValue);
				}
				continue;
			}

			// Array item
			const arrayMatch = stripped.match(/^\s+-\s+(.+)$/);
			if (arrayMatch && currentTool) {
				const lastKey = Object.keys(result[currentTool]!).pop();
				if (lastKey) {
					const arr = result[currentTool]![lastKey];
					if (Array.isArray(arr)) {
						arr.push(parseValue(arrayMatch[1]!));
					}
				}
			}
		}
	}

	return Object.keys(result).length > 0 ? result : null;
}

function parseValue(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	const num = Number(raw);
	if (!isNaN(num) && raw !== "") return num;
	// Strip quotes
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}
	return raw;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extractToolConfigs", () => {
	const knownTools = ["read_note", "write_note", "execute_command", "fetch_webpage", "myserver__tool1"];

	describe("valid single-block extraction and stripping", () => {
		it("extracts a single valid block and strips it from content", () => {
			const text = `Some text before.
<notor_tool_config>
read_note:
  enabled: false
  auto_approve: true
</notor_tool_config>
Some text after.`;

			const result = extractToolConfigs(text, "persona", "personas/test/system-prompt.md", knownTools, parseYAML);

			expect(result.configs).toHaveLength(1);
			expect(result.errors).toHaveLength(0);
			expect(result.strippedContent).toBe("Some text before.\n\nSome text after.");
			expect(result.configs[0]!.tools.read_note).toEqual({
				enabled: false,
				auto_approve: true,
			});
			expect(result.configs[0]!.source).toBe("persona");
			expect(result.configs[0]!.sourceFile).toBe("personas/test/system-prompt.md");
		});

		it("preserves documentPosition as character offset", () => {
			const text = `Preamble\n<notor_tool_config>\nread_note:\n  enabled: true\n</notor_tool_config>`;
			const result = extractToolConfigs(text, "rule", "rules/test.md", knownTools, parseYAML);

			expect(result.configs).toHaveLength(1);
			expect(result.configs[0]!.documentPosition).toBe(text.indexOf("<notor_tool_config>"));
		});
	});

	describe("multiple blocks per file (document-order merge)", () => {
		it("extracts multiple blocks in document order", () => {
			const text = `Start.
<notor_tool_config>
read_note:
  enabled: false
</notor_tool_config>
Middle.
<notor_tool_config>
write_note:
  auto_approve: true
</notor_tool_config>
End.`;

			const result = extractToolConfigs(text, "persona", "test.md", knownTools, parseYAML);

			expect(result.configs).toHaveLength(2);
			expect(result.configs[0]!.tools).toHaveProperty("read_note");
			expect(result.configs[1]!.tools).toHaveProperty("write_note");
			expect(result.configs[0]!.documentPosition).toBeLessThan(result.configs[1]!.documentPosition);
			expect(result.strippedContent).toBe("Start.\n\nMiddle.\n\nEnd.");
		});
	});

	describe("version attribute parsing", () => {
		it("handles missing version attribute (no error)", () => {
			const text = `<notor_tool_config>
read_note:
  enabled: true
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, parseYAML);
			expect(result.configs).toHaveLength(1);
			expect(result.errors).toHaveLength(0);
		});

		it("handles valid version attribute", () => {
			const text = `<notor_tool_config version="1.0">
read_note:
  enabled: true
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, parseYAML);
			expect(result.configs).toHaveLength(1);
			expect(result.errors).toHaveLength(0);
		});

		it("skips block with unsupported major version and warns", () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const text = `<notor_tool_config version="2.0">
read_note:
  enabled: true
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, parseYAML);
			expect(result.configs).toHaveLength(0);
			expect(result.errors).toHaveLength(0);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unsupported major version 2"));
			warnSpy.mockRestore();
		});
	});

	describe("YAML parse failures", () => {
		it("handles malformed YAML with error", () => {
			const badParser = () => {
				throw new Error("YAML parse error");
			};
			const text = `<notor_tool_config>
{invalid: yaml: [
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, badParser);
			expect(result.configs).toHaveLength(0);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("Invalid YAML");
			expect(result.errors[0]!.detail).toContain("YAML parse error");
			expect(result.strippedContent).toBe("");
		});

		it("handles null return from parseYAML", () => {
			const nullParser = () => null;
			const text = `<notor_tool_config>
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, nullParser);
			expect(result.configs).toHaveLength(0);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("must contain a YAML mapping");
			expect(result.errors[0]!.detail).toContain("null");
		});

		it("handles undefined return from parseYAML", () => {
			const undefParser = () => undefined;
			const text = `<notor_tool_config>
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, undefParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("must contain a YAML mapping");
		});

		it("handles array return from parseYAML", () => {
			const arrayParser = () => [1, 2, 3];
			const text = `<notor_tool_config>
- item1
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, arrayParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("array");
		});

		it("handles scalar return from parseYAML", () => {
			const scalarParser = () => "just a string";
			const text = `<notor_tool_config>
something
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, scalarParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("must contain a YAML mapping");
		});
	});

	describe("field validation", () => {
		it("reports unrecognized tool name and skips", () => {
			const text = `<notor_tool_config>
unknown_tool:
  enabled: false
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, parseYAML);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain('Unrecognized tool name "unknown_tool"');
		});

		it("skips tool name validation when knownToolNames is omitted", () => {
			const text = `<notor_tool_config>
any_tool_name:
  enabled: false
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", undefined, parseYAML);
			expect(result.errors).toHaveLength(0);
			expect(result.configs[0]!.tools).toHaveProperty("any_tool_name");
		});

		it("reports unrecognized field and skips it", () => {
			const text = `<notor_tool_config>
read_note:
  enabled: true
  unknown_field: something
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, parseYAML);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain('unrecognized field "unknown_field"');
			expect(result.configs[0]!.tools.read_note).toEqual({ enabled: true });
		});

		it("reports wrong type for enabled field", () => {
			const mockParser = () => ({ read_note: { enabled: "yes" } });
			const text = `<notor_tool_config>
read_note:
  enabled: "yes"
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain('"enabled" must be a boolean');
		});

		it("reports wrong type for auto_approve field", () => {
			const mockParser = () => ({ read_note: { auto_approve: 1 } });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain('"auto_approve" must be a boolean');
		});

		it("reports wrong type for allowed_paths field", () => {
			const mockParser = () => ({ read_note: { allowed_paths: "not-an-array" } });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain('"allowed_paths" must be an array of strings');
		});

		it("reports wrong type for blocked_paths field", () => {
			const mockParser = () => ({ read_note: { blocked_paths: [1, 2] } });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain('"blocked_paths" must be an array of strings');
		});
	});

	describe("MCP tool path field restriction", () => {
		it("errors on allowed_paths for MCP tool", () => {
			const mockParser = () => ({
				myserver__tool1: {
					enabled: true,
					allowed_paths: ["some/path"],
				},
			});
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("not yet implemented for MCP tools");
			// enabled should still be kept
			expect(result.configs[0]!.tools.myserver__tool1).toEqual({ enabled: true });
		});

		it("errors on blocked_paths for MCP tool", () => {
			const mockParser = () => ({
				myserver__tool1: {
					auto_approve: false,
					blocked_paths: ["some/path"],
				},
			});
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("not yet implemented for MCP tools");
			expect(result.configs[0]!.tools.myserver__tool1).toEqual({ auto_approve: false });
		});
	});

	describe("content fully stripped from output", () => {
		it("strips all blocks leaving surrounding text intact", () => {
			const text = `Line 1.
<notor_tool_config>
read_note:
  enabled: false
</notor_tool_config>
Line 2.
<notor_tool_config>
write_note:
  enabled: true
</notor_tool_config>
Line 3.`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, parseYAML);
			expect(result.strippedContent).not.toContain("notor_tool_config");
			expect(result.strippedContent).toContain("Line 1.");
			expect(result.strippedContent).toContain("Line 2.");
			expect(result.strippedContent).toContain("Line 3.");
		});

		it("strips even blocks with errors", () => {
			const badParser = () => {
				throw new Error("parse error");
			};
			const text = `Before.
<notor_tool_config>
bad yaml
</notor_tool_config>
After.`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, badParser);
			expect(result.strippedContent).not.toContain("notor_tool_config");
			expect(result.errors).toHaveLength(1);
		});
	});

	describe("error structure", () => {
		it("errors include sourceFile and detail fields", () => {
			const nullParser = () => null;
			const text = `<notor_tool_config>
bad
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "my/file.md", knownTools, nullParser);
			expect(result.errors[0]).toHaveProperty("sourceFile", "my/file.md");
			expect(result.errors[0]).toHaveProperty("detail");
			expect(typeof result.errors[0]!.detail).toBe("string");
		});
	});

	describe("valid path arrays", () => {
		it("parses allowed_paths and blocked_paths correctly", () => {
			const mockParser = () => ({
				read_note: {
					allowed_paths: ["notes/", "journal/"],
					blocked_paths: ["private/"],
				},
			});
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(0);
			expect(result.configs[0]!.tools.read_note).toEqual({
				allowed_paths: ["notes/", "journal/"],
				blocked_paths: ["private/"],
			});
		});

		it("parses the approval-tier path lists correctly", () => {
			const mockParser = () => ({
				write_note: {
					auto_approve: false,
					auto_approve_paths: ["ai/"],
					never_auto_approve_paths: ["private/"],
				},
			});
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(0);
			expect(result.configs[0]!.tools.write_note).toEqual({
				auto_approve: false,
				auto_approve_paths: ["ai/"],
				never_auto_approve_paths: ["private/"],
			});
		});

		it("hints at per-tool expansion when a path-scoping group name is used as a key", () => {
			// Group names are internal vocabulary someone may have read in the docs
			// and tried here, so the error should say what to do instead.
			const mockParser = () => ({ "vault-write": { auto_approve_paths: ["ai/"] } });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("internal path-scoping group name");
			expect(result.errors[0]!.detail).toContain("list the individual tools");
		});

		it("reports wrong type for auto_approve_paths", () => {
			const mockParser = () => ({ write_note: { auto_approve_paths: "ai/" } });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain(
				'"auto_approve_paths" must be an array of strings',
			);
		});
	});

	describe("tool entry that is not an object", () => {
		it("reports error for scalar tool entry", () => {
			const mockParser = () => ({ read_note: true });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("expected a mapping of fields");
		});

		it("reports error for array tool entry", () => {
			const mockParser = () => ({ read_note: [1, 2] });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("expected a mapping of fields");
		});

		it("reports error for null tool entry", () => {
			const mockParser = () => ({ read_note: null });
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("expected a mapping of fields");
		});
	});

	describe("MCP server wildcard keys", () => {
		const knownToolsWithMcp = ["read_note", "write_note", "myserver__tool1", "myserver__tool2", "other__x"];

		it("parses serverName__* wildcard into serverDefaults", () => {
			const mockParser = () => ({
				"myserver__*": { enabled: false },
				"myserver__tool1": { enabled: true },
			});
			const text = `<notor_tool_config>\nplaceholder\n</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownToolsWithMcp, mockParser);

			expect(result.errors).toHaveLength(0);
			expect(result.configs[0]!.serverDefaults).toEqual({
				myserver: { enabled: false },
			});
			expect(result.configs[0]!.tools["myserver__tool1"]).toEqual({ enabled: true });
			expect(result.configs[0]!.tools).not.toHaveProperty("myserver__*");
		});

		it("rejects path fields on wildcard keys", () => {
			const mockParser = () => ({
				"myserver__*": { enabled: false, allowed_paths: ["notes/"] },
			});
			const text = `<notor_tool_config>\nplaceholder\n</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownToolsWithMcp, mockParser);

			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]!.detail).toContain("not yet implemented for MCP tools");
			expect(result.configs[0]!.serverDefaults).toEqual({
				myserver: { enabled: false },
			});
		});

		it("does not set serverDefaults when no wildcards present", () => {
			const mockParser = () => ({
				"myserver__tool1": { enabled: true },
			});
			const text = `<notor_tool_config>\nplaceholder\n</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownToolsWithMcp, mockParser);

			expect(result.configs[0]!.serverDefaults).toBeUndefined();
		});

		it("wildcard with only invalid fields produces no serverDefaults entry", () => {
			const mockParser = () => ({
				"myserver__*": { bad_field: true },
			});
			const text = `<notor_tool_config>\nplaceholder\n</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownToolsWithMcp, mockParser);

			expect(result.errors).toHaveLength(1);
			expect(result.configs[0]!.serverDefaults).toBeUndefined();
		});
	});

	describe("empty tool entry (no valid fields)", () => {
		it("does not add tool entry when all fields are invalid", () => {
			const mockParser = () => ({
				read_note: { bad_field: true },
			});
			const text = `<notor_tool_config>
placeholder
</notor_tool_config>`;
			const result = extractToolConfigs(text, "persona", "test.md", knownTools, mockParser);
			expect(result.errors).toHaveLength(1);
			expect(result.configs[0]!.tools).not.toHaveProperty("read_note");
		});
	});
});
