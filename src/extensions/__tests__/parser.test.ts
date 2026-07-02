import { describe, it, expect, vi } from "vitest";
import { extractYamlFence, extractCodeFence, parseExtensionFile } from "../parser";

// ---------------------------------------------------------------------------
// Mock logger (used by settings-schema via parseSettingsSchema)
// ---------------------------------------------------------------------------

vi.mock("../../utils/logger", () => ({
	logger: () => ({
		info: vi.fn(),
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	}),
}));

// ---------------------------------------------------------------------------
// Minimal parseYAML stub (mirrors Obsidian's parseYaml for test purposes)
// ---------------------------------------------------------------------------

function parseYAML(yaml: string): unknown {
	// Minimal YAML parser for tests — handles the subset used by extensions
	const result: Record<string, unknown> = {};
	const lines = yaml.split("\n");
	let currentKey: string | null = null;
	let currentObj: Record<string, unknown> | null = null;
	let nestedKey: string | null = null;
	let nestedObj: Record<string, unknown> | null = null;

	for (const line of lines) {
		const trimmed = line.trimEnd();
		if (trimmed === "" || trimmed.startsWith("#")) continue;

		// Top-level key with value
		const topMatch = trimmed.match(/^(\w+):\s*(.+)$/);
		if (topMatch) {
			currentKey = topMatch[1];
			nestedKey = null;
			nestedObj = null;
			currentObj = null;
			result[currentKey] = parseValue(topMatch[2]);
			continue;
		}

		// Top-level key (block)
		const blockMatch = trimmed.match(/^(\w+):$/);
		if (blockMatch) {
			currentKey = blockMatch[1];
			currentObj = {};
			nestedKey = null;
			nestedObj = null;
			result[currentKey] = currentObj;
			continue;
		}

		// Nested key (2 spaces) with value
		const nestedValMatch = trimmed.match(/^  (\w+):\s*(.+)$/);
		if (nestedValMatch && currentObj) {
			nestedKey = nestedValMatch[1];
			nestedObj = null;
			currentObj[nestedKey] = parseValue(nestedValMatch[2]);
			continue;
		}

		// Nested key (2 spaces) block
		const nestedBlockMatch = trimmed.match(/^  (\w+):$/);
		if (nestedBlockMatch && currentObj) {
			nestedKey = nestedBlockMatch[1];
			nestedObj = {};
			currentObj[nestedKey] = nestedObj;
			continue;
		}

		// Deep nested key (4 spaces) with value
		const deepMatch = trimmed.match(/^    (\w+):\s*(.+)$/);
		if (deepMatch && nestedObj) {
			nestedObj[deepMatch[1]] = parseValue(deepMatch[2]);
			continue;
		}
	}

	return result;
}

function parseValue(raw: string): unknown {
	const trimmed = raw.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	// Strip quotes
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

// ---------------------------------------------------------------------------
// extractYamlFence
// ---------------------------------------------------------------------------

describe("extractYamlFence", () => {
	it("extracts content from a yaml fence", () => {
		const content = `Some text\n\`\`\`yaml\nparams:\n  path:\n    type: string\n\`\`\`\nMore text`;
		const result = extractYamlFence(content);
		expect(result).toBe("params:\n  path:\n    type: string\n");
	});

	it("returns null when no yaml fence present", () => {
		const content = "Just some markdown\n\nNo fences here.";
		expect(extractYamlFence(content)).toBeNull();
	});

	it("returns null for empty yaml fence", () => {
		const content = "text\n```yaml\n\n```\ntext";
		expect(extractYamlFence(content)).toBeNull();
	});

	it("returns null for whitespace-only yaml fence", () => {
		const content = "text\n```yaml\n   \n```\ntext";
		expect(extractYamlFence(content)).toBeNull();
	});

	it("takes only the first yaml fence when multiple exist", () => {
		const content = "text\n```yaml\nfirst: true\n```\ntext\n```yaml\nsecond: true\n```\n";
		const result = extractYamlFence(content);
		expect(result).toBe("first: true\n");
	});
});

// ---------------------------------------------------------------------------
// extractCodeFence
// ---------------------------------------------------------------------------

describe("extractCodeFence", () => {
	it("extracts ts fence", () => {
		const content = "text\n```ts\nconst x = 1;\n```\n";
		const result = extractCodeFence(content);
		expect(result).toEqual({ code: "const x = 1;\n", lang: "ts" });
	});

	it("extracts typescript fence", () => {
		const content = "text\n```typescript\nconst x: string = 'hello';\n```\n";
		const result = extractCodeFence(content);
		expect(result).toEqual({ code: "const x: string = 'hello';\n", lang: "typescript" });
	});

	it("extracts js fence", () => {
		const content = "text\n```js\nconst x = 1;\n```\n";
		const result = extractCodeFence(content);
		expect(result).toEqual({ code: "const x = 1;\n", lang: "js" });
	});

	it("extracts javascript fence", () => {
		const content = "text\n```javascript\nconst x = 1;\n```\n";
		const result = extractCodeFence(content);
		expect(result).toEqual({ code: "const x = 1;\n", lang: "javascript" });
	});

	it("returns null when no code fence present", () => {
		expect(extractCodeFence("just text")).toBeNull();
	});

	it("returns null for empty code fence", () => {
		const content = "text\n```ts\n\n```\ntext";
		expect(extractCodeFence(content)).toBeNull();
	});

	it("takes only the first code fence when multiple exist", () => {
		const content = "text\n```ts\nfirst();\n```\nmore\n```js\nsecond();\n```\n";
		const result = extractCodeFence(content);
		expect(result).toEqual({ code: "first();\n", lang: "ts" });
	});

	it("ignores non-TS/JS fences (e.g. yaml)", () => {
		const content = "text\n```yaml\nkey: value\n```\n```ts\ncode();\n```\n";
		const result = extractCodeFence(content);
		expect(result).toEqual({ code: "code();\n", lang: "ts" });
	});
});

// ---------------------------------------------------------------------------
// parseExtensionFile — tool
// ---------------------------------------------------------------------------

describe("parseExtensionFile — tool", () => {
	const validToolContent = `---
notor-type: tool
notor-tool-name: custom_search
notor-description: Search the web
notor-mode: read
---

Some prose documentation.

\`\`\`yaml
params:
  query:
    type: string
    description: Search query
\`\`\`

\`\`\`ts
return await fetch(params.query);
\`\`\`
`;

	const validToolFrontmatter = {
		"notor-type": "tool",
		"notor-tool-name": "custom_search",
		"notor-description": "Search the web",
		"notor-mode": "read",
	};

	it("parses a valid tool file correctly", () => {
		const result = parseExtensionFile(validToolContent, validToolFrontmatter, "notor/tools/search.md", parseYAML);

		expect("name" in result).toBe(true);
		if (!("name" in result)) return;

		expect(result.name).toBe("custom_search");
		expect(result.description).toBe("Search the web");
		expect(result.mode).toBe("read");
		expect(result.filePath).toBe("notor/tools/search.md");
		expect(result.rawCode).toContain("fetch(params.query)");
		expect(result.compiledFn).toBeNull();
		expect(result.params).toHaveProperty("query");
	});

	it("returns error for missing notor-type", () => {
		const result = parseExtensionFile(validToolContent, {}, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-type");
		}
	});

	it("returns error for invalid notor-type", () => {
		const result = parseExtensionFile(validToolContent, { "notor-type": "widget" }, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("Invalid 'notor-type'");
		}
	});

	it("returns error for missing notor-tool-name", () => {
		const fm = { ...validToolFrontmatter, "notor-tool-name": undefined };
		const result = parseExtensionFile(validToolContent, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-tool-name");
		}
	});

	it("returns error for missing notor-description", () => {
		const fm = { ...validToolFrontmatter, "notor-description": undefined };
		const result = parseExtensionFile(validToolContent, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-description");
		}
	});

	it("returns error for missing notor-mode", () => {
		const fm = { ...validToolFrontmatter, "notor-mode": undefined };
		const result = parseExtensionFile(validToolContent, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-mode");
		}
	});

	it("returns error for invalid notor-mode", () => {
		const fm = { ...validToolFrontmatter, "notor-mode": "execute" };
		const result = parseExtensionFile(validToolContent, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-mode");
		}
	});

	it("returns error when code fence is missing", () => {
		const content = "Some text without code fence\n```yaml\nparams:\n  q:\n    type: string\n```\n";
		const result = parseExtensionFile(content, validToolFrontmatter, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("code fence");
		}
	});

	it("parses YAML fence with params and settings blocks", () => {
		const content = `text
\`\`\`yaml
params:
  path:
    type: string
    description: File path
settings:
  api_key:
    name: API Key
    type: string
    secret: true
\`\`\`

\`\`\`ts
return "ok";
\`\`\`
`;
		const fm = { ...validToolFrontmatter };
		const result = parseExtensionFile(content, fm, "file.md", parseYAML);

		expect("name" in result).toBe(true);
		if (!("name" in result)) return;

		expect(result.params).toHaveProperty("path");
		expect(result.settingsSchema).not.toBeNull();
		expect(result.settingsSchema).toHaveLength(1);
		expect(result.settingsSchema![0].key).toBe("api_key");
		expect(result.settingsSchema![0].secret).toBe(true);
	});

	it("sets empty params when no YAML fence is present", () => {
		const content = "text\n```ts\nreturn 42;\n```\n";
		const result = parseExtensionFile(content, validToolFrontmatter, "file.md", parseYAML);

		expect("name" in result).toBe(true);
		if (!("name" in result)) return;
		expect(Object.keys(result.params)).toHaveLength(0);
	});

	it("prose outside fences is ignored", () => {
		const content = `# My Tool

This is extensive documentation about the tool.
It spans multiple lines and has **markdown** formatting.

\`\`\`yaml
params:
  q:
    type: string
\`\`\`

More prose between fences explaining usage.

\`\`\`ts
return params.q;
\`\`\`

And even more prose after the code.
`;
		const result = parseExtensionFile(content, validToolFrontmatter, "file.md", parseYAML);
		expect("name" in result).toBe(true);
		if ("name" in result) {
			expect(result.rawCode).toContain("params.q");
		}
	});

	it("extracts path params from params with path_namespace", () => {
		const content = `text
\`\`\`yaml
params:
  path:
    type: string
    path_namespace: vault
\`\`\`

\`\`\`ts
return "ok";
\`\`\`
`;
		const result = parseExtensionFile(content, validToolFrontmatter, "file.md", parseYAML);
		expect("name" in result).toBe(true);
		if ("name" in result) {
			expect(result.pathParams).toHaveLength(1);
			expect(result.pathParams[0].paramName).toBe("path");
			expect(result.pathParams[0].namespace).toBe("vault");
		}
	});
});

// ---------------------------------------------------------------------------
// parseExtensionFile — notor-min-api version handshake
// ---------------------------------------------------------------------------

describe("parseExtensionFile — notor-min-api", () => {
	const content = "text\n```ts\nreturn 1;\n```\n";
	const baseFrontmatter = {
		"notor-type": "tool",
		"notor-tool-name": "versioned_tool",
		"notor-description": "A versioned tool",
		"notor-mode": "read",
	};

	it("loads when notor-min-api is absent", () => {
		const result = parseExtensionFile(content, baseFrontmatter, "file.md", parseYAML);
		expect("name" in result).toBe(true);
	});

	it("loads when notor-min-api equals the runtime version (1)", () => {
		const fm = { ...baseFrontmatter, "notor-min-api": 1 };
		const result = parseExtensionFile(content, fm, "file.md", parseYAML);
		expect("name" in result).toBe(true);
	});

	it("returns ExtensionError naming file + versions when notor-min-api exceeds the runtime version", () => {
		const fm = { ...baseFrontmatter, "notor-min-api": 2 };
		const result = parseExtensionFile(content, fm, "notor/tools/versioned.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.filePath).toBe("notor/tools/versioned.md");
			expect(result.message).toContain("v2");
			expect(result.message).toContain("v1");
		}
	});

	it("returns ExtensionError for a malformed (non-integer) notor-min-api", () => {
		const fm = { ...baseFrontmatter, "notor-min-api": "abc" };
		const result = parseExtensionFile(content, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-min-api");
			expect(result.message).toContain("integer");
		}
	});
});

// ---------------------------------------------------------------------------
// parseExtensionFile — automation
// ---------------------------------------------------------------------------

describe("parseExtensionFile — automation", () => {
	const validAutomationFrontmatter = {
		"notor-type": "automation",
		"notor-trigger": "on_save",
	};

	const validAutomationContent = `text
\`\`\`ts
console.log("saved");
\`\`\`
`;

	it("parses a valid automation file correctly", () => {
		const result = parseExtensionFile(validAutomationContent, validAutomationFrontmatter, "notor/automations/on-save.md", parseYAML);

		expect("trigger" in result).toBe(true);
		if (!("trigger" in result)) return;

		expect(result.trigger).toBe("on_save");
		expect(result.filePath).toBe("notor/automations/on-save.md");
		expect(result.rawCode).toContain("saved");
		expect(result.order).toBe(0);
		expect(result.displayName).toBeNull();
		expect(result.toolFilter).toBeNull();
		expect(result.schedule).toBeNull();
		expect(result.compiledFn).toBeNull();
	});

	it("parses all optional fields", () => {
		const fm = {
			...validAutomationFrontmatter,
			"notor-display-name": "Auto Save Logger",
			"notor-tools": ["read_note", "write_note"],
			"notor-automation-order": 5,
			"notor-trigger": "on_tool_call",
		};
		const result = parseExtensionFile(validAutomationContent, fm, "file.md", parseYAML);

		expect("trigger" in result).toBe(true);
		if (!("trigger" in result)) return;

		expect(result.displayName).toBe("Auto Save Logger");
		expect(result.toolFilter).toEqual(["read_note", "write_note"]);
		expect(result.order).toBe(5);
		expect(result.trigger).toBe("on_tool_call");
	});

	it("defaults notor-automation-order to 0 when not specified", () => {
		const result = parseExtensionFile(validAutomationContent, validAutomationFrontmatter, "file.md", parseYAML);
		expect("trigger" in result).toBe(true);
		if ("trigger" in result) {
			expect(result.order).toBe(0);
		}
	});

	it("returns error for missing notor-trigger", () => {
		const fm = { "notor-type": "automation" as const };
		const result = parseExtensionFile(validAutomationContent, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-trigger");
		}
	});

	it("returns error for invalid notor-trigger value", () => {
		const fm = { "notor-type": "automation" as const, "notor-trigger": "on_hover" };
		const result = parseExtensionFile(validAutomationContent, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-trigger");
		}
	});

	it("returns error for missing code fence", () => {
		const result = parseExtensionFile("No code here", validAutomationFrontmatter, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("code fence");
		}
	});

	it("requires notor-schedule when trigger is on_schedule", () => {
		const fm = { "notor-type": "automation" as const, "notor-trigger": "on_schedule" };
		const result = parseExtensionFile(validAutomationContent, fm, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("notor-schedule");
		}
	});

	it("accepts on_schedule trigger with valid notor-schedule", () => {
		const fm = {
			"notor-type": "automation" as const,
			"notor-trigger": "on_schedule",
			"notor-schedule": "0 9 * * *",
		};
		const result = parseExtensionFile(validAutomationContent, fm, "file.md", parseYAML);
		expect("trigger" in result).toBe(true);
		if ("trigger" in result) {
			expect(result.trigger).toBe("on_schedule");
			expect(result.schedule).toBe("0 9 * * *");
		}
	});

	it("handles notor-tools as a single string", () => {
		const fm = {
			...validAutomationFrontmatter,
			"notor-tools": "read_note",
		};
		const result = parseExtensionFile(validAutomationContent, fm, "file.md", parseYAML);
		expect("trigger" in result).toBe(true);
		if ("trigger" in result) {
			expect(result.toolFilter).toEqual(["read_note"]);
		}
	});
});

// ---------------------------------------------------------------------------
// parseExtensionFile — settings
// ---------------------------------------------------------------------------

describe("parseExtensionFile — settings", () => {
	const settingsFrontmatter = { "notor-type": "settings" };

	it("parses a valid settings file correctly", () => {
		const content = `text
\`\`\`yaml
settings:
  api_key:
    name: API Key
    type: string
    secret: true
\`\`\`
`;
		const result = parseExtensionFile(content, settingsFrontmatter, "notor/settings.md", parseYAML);

		expect("settingsSchema" in result).toBe(true);
		if (!("settingsSchema" in result)) return;
		// Ensure it's SharedSettingsDefinition (no name, no trigger)
		expect("name" in result).toBe(false);
		expect("trigger" in result).toBe(false);

		expect(result.settingsSchema).toHaveLength(1);
		expect(result.settingsSchema[0].key).toBe("api_key");
		expect(result.settingsSchema[0].type).toBe("string");
	});

	it("returns error when YAML fence is missing", () => {
		const content = "Just text, no yaml fence";
		const result = parseExtensionFile(content, settingsFrontmatter, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("settings");
		}
	});

	it("returns error when YAML fence has no settings block", () => {
		const content = "text\n```yaml\nparams:\n  q:\n    type: string\n```\n";
		const result = parseExtensionFile(content, settingsFrontmatter, "file.md", parseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("settings");
		}
	});

	it("returns error when settings block is empty (no fields)", () => {
		const content = "text\n```yaml\nsettings:\n```\n";
		const result = parseExtensionFile(content, settingsFrontmatter, "file.md", parseYAML);
		expect("message" in result).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// parseExtensionFile — YAML parse failure
// ---------------------------------------------------------------------------

describe("parseExtensionFile — YAML parse errors", () => {
	it("returns error when YAML fence content fails to parse", () => {
		const content = "text\n```yaml\n{invalid: yaml: content\n```\n```ts\nreturn 1;\n```\n";
		const brokenParseYAML = () => { throw new Error("parse error"); };
		const fm = {
			"notor-type": "tool" as const,
			"notor-tool-name": "test",
			"notor-description": "test",
			"notor-mode": "read" as const,
		};
		const result = parseExtensionFile(content, fm, "file.md", brokenParseYAML);
		expect("message" in result).toBe(true);
		if ("message" in result) {
			expect(result.message).toContain("YAML");
		}
	});
});
