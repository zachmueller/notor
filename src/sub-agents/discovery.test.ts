import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian module before imports
vi.mock("obsidian", () => ({
	TAbstractFile: class {},
}));

// Mock the logger
vi.mock("../utils/logger", () => ({
	logger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// Mock mcp-tool-adapter (required by parser.ts)
vi.mock("../mcp/mcp-tool-adapter", () => ({
	isMcpTool: (name: string) => name.includes("__"),
}));

import { discoverSubAgentProfiles, getSubAgentsRootPath } from "./discovery";
import { BUILTIN_SUBAGENT_PROFILES } from "./builtin-profiles";

// ---------------------------------------------------------------------------
// Test helpers: Obsidian mock factories
// ---------------------------------------------------------------------------

interface MockFile {
	path: string;
	name: string;
	stat: { mtime: number; ctime: number; size: number };
	/** Raw file content returned by vault.cachedRead(). */
	_content: string;
	/** Frontmatter returned by metadataCache.getFileCache(). */
	_frontmatter?: Record<string, unknown>;
}

interface MockFolder {
	path: string;
	name: string;
	children: (MockFolder | MockFile)[];
}

function makeFile(
	path: string,
	content: string,
	frontmatter?: Record<string, unknown>,
): MockFile {
	const parts = path.split("/");
	return {
		path,
		name: parts[parts.length - 1]!,
		stat: { mtime: Date.now(), ctime: Date.now(), size: content.length },
		_content: content,
		_frontmatter: frontmatter,
	};
}

function makeFolder(path: string, children: (MockFolder | MockFile)[]): MockFolder {
	const parts = path.split("/");
	return { path, name: parts[parts.length - 1]!, children };
}

function isFolder(obj: MockFolder | MockFile): obj is MockFolder {
	return "children" in obj;
}

/** Build a mock Vault that resolves files from a flat registry. */
function buildMockVault(files: Map<string, MockFolder | MockFile>) {
	return {
		getAbstractFileByPath: (p: string) => files.get(p) ?? null,
		cachedRead: async (file: MockFile) => file._content,
	} as unknown as import("obsidian").Vault;
}

/** Build a mock MetadataCache that resolves frontmatter from MockFile objects. */
function buildMockMetadataCache(files: Map<string, MockFolder | MockFile>) {
	return {
		getFileCache: (file: MockFile) => {
			if (file._frontmatter) {
				return { frontmatter: file._frontmatter };
			}
			return null;
		},
	} as unknown as import("obsidian").MetadataCache;
}

/** Simple YAML parser for tests (mirrors obsidian's parseYAML). */
function parseYAML(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed) return null;

	// Detect obviously malformed YAML (unmatched brackets, etc.) —
	// real Obsidian parseYaml would throw for these.
	if (/\[(?![^\]]*\])/.test(trimmed)) {
		throw new Error("Malformed YAML: unmatched bracket");
	}

	const result: Record<string, Record<string, unknown>> = {};
	let currentTool: string | null = null;

	for (const line of trimmed.split("\n")) {
		const stripped = line.trimEnd();
		if (!stripped || stripped.startsWith("#")) continue;

		const topMatch = stripped.match(/^(\S+):\s*$/);
		if (topMatch) {
			currentTool = topMatch[1]!;
			result[currentTool] = {};
			continue;
		}

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

		if (currentTool) {
			const fieldMatch = stripped.match(/^\s+(\S+):\s*(.*)$/);
			if (fieldMatch) {
				const fieldName = fieldMatch[1]!;
				const rawValue = fieldMatch[2]!.trim();
				if (!rawValue) {
					result[currentTool]![fieldName] = [];
				} else {
					result[currentTool]![fieldName] = parseValue(rawValue);
				}
				continue;
			}

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
	if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
		return raw.slice(1, -1);
	}
	return raw;
}

// ---------------------------------------------------------------------------
// Helpers to register folder trees in the files map
// ---------------------------------------------------------------------------

function registerTree(files: Map<string, MockFolder | MockFile>, node: MockFolder | MockFile): void {
	files.set(node.path, node);
	if (isFolder(node)) {
		for (const child of node.children) {
			registerTree(files, child);
		}
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("discoverSubAgentProfiles", () => {
	const NOTOR_DIR = "notor/";
	const KNOWN_TOOLS = ["search_vault", "read_note", "read_frontmatter", "list_vault",
		"get_backlinks", "get_outlinks", "web_search", "fetch_webpage", "write_note"];

	describe("vault directory discovery", () => {
		it("discovers profiles in correct directory", async () => {
			const promptContent = `---
notor-description: Test agent for searching.
notor-preferred-provider: anthropic
notor-preferred-model: claude-sonnet-4-20250514
---

You are a test agent.

<notor_tool_config>
search_vault:
  enabled: true
read_note:
  enabled: true
</notor_tool_config>
`;
			const promptFile = makeFile(
				"notor/sub-agents/test-agent/system-prompt.md",
				promptContent,
				{
					"notor-description": "Test agent for searching.",
					"notor-preferred-provider": "anthropic",
					"notor-preferred-model": "claude-sonnet-4-20250514",
				},
			);

			const agentDir = makeFolder("notor/sub-agents/test-agent", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			// Should find the vault profile + built-in profiles without vault files
			const testProfile = profiles.find(p => p.name === "test-agent");
			expect(testProfile).toBeDefined();
			expect(testProfile!.description).toBe("Test agent for searching.");
			expect(testProfile!.preferred_provider).toBe("anthropic");
			expect(testProfile!.preferred_model).toBe("claude-sonnet-4-20250514");
			expect(testProfile!.directory_path).toBe("notor/sub-agents/test-agent/");
			expect(testProfile!.system_prompt_path).toBe("notor/sub-agents/test-agent/system-prompt.md");
			expect(testProfile!.is_builtin).toBe(false);
			expect(testProfile!.prompt_content).toBe("You are a test agent.");
		});

		it("parses frontmatter properties correctly", async () => {
			const promptFile = makeFile(
				"notor/sub-agents/my-agent/system-prompt.md",
				"---\nnotor-description: My description\n---\nPrompt body",
				{ "notor-description": "My description" },
			);

			const agentDir = makeFolder("notor/sub-agents/my-agent", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "my-agent");

			expect(profile).toBeDefined();
			expect(profile!.description).toBe("My description");
			expect(profile!.preferred_provider).toBeNull();
			expect(profile!.preferred_model).toBeNull();
			expect(profile!.preferred_preset).toBeNull();
			expect(profile!.iteration_cap).toBeNull();
		});

		it("parses preferred_preset and iteration_cap from frontmatter", async () => {
			const promptFile = makeFile(
				"notor/sub-agents/preset-agent/system-prompt.md",
				"---\nnotor-description: Preset agent\nnotor-preferred-preset: tiny\nnotor-iteration-cap: 6\n---\nPrompt body",
				{
					"notor-description": "Preset agent",
					"notor-preferred-preset": "tiny",
					"notor-iteration-cap": 6,
				},
			);

			const agentDir = makeFolder("notor/sub-agents/preset-agent", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "preset-agent");

			expect(profile).toBeDefined();
			expect(profile!.preferred_preset).toBe("tiny");
			expect(profile!.iteration_cap).toBe(6);
		});

		it("parses iteration_cap as string from frontmatter", async () => {
			const promptFile = makeFile(
				"notor/sub-agents/cap-agent/system-prompt.md",
				"---\nnotor-iteration-cap: 12\n---\nBody",
				{ "notor-iteration-cap": "12" },
			);

			const agentDir = makeFolder("notor/sub-agents/cap-agent", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "cap-agent");

			expect(profile).toBeDefined();
			expect(profile!.iteration_cap).toBe(12);
		});

		it("extracts tool config blocks", async () => {
			const promptContent = `---
notor-description: Search helper
---

Search agent body.

<notor_tool_config>
search_vault:
  enabled: true
  auto_approve: true
read_note:
  enabled: true
</notor_tool_config>
`;
			const promptFile = makeFile(
				"notor/sub-agents/searcher/system-prompt.md",
				promptContent,
				{ "notor-description": "Search helper" },
			);

			const agentDir = makeFolder("notor/sub-agents/searcher", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "searcher");

			expect(profile).toBeDefined();
			expect(profile!.tool_configs).toHaveLength(1);
			expect(profile!.tool_configs[0]!.tools.search_vault).toEqual({ enabled: true, auto_approve: true });
			expect(profile!.tool_configs[0]!.tools.read_note).toEqual({ enabled: true });
			expect(profile!.tool_configs[0]!.source).toBe("subagent");
		});

		it("handles missing optional fields gracefully", async () => {
			const promptFile = makeFile(
				"notor/sub-agents/minimal/system-prompt.md",
				"Just a prompt with no frontmatter.",
			);

			const agentDir = makeFolder("notor/sub-agents/minimal", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "minimal");

			expect(profile).toBeDefined();
			expect(profile!.description).toBeNull();
			expect(profile!.preferred_provider).toBeNull();
			expect(profile!.preferred_model).toBeNull();
			expect(profile!.preferred_preset).toBeNull();
			expect(profile!.iteration_cap).toBeNull();
			expect(profile!.tool_configs).toEqual([]);
			expect(profile!.prompt_content).toBe("Just a prompt with no frontmatter.");
		});

		it("ignores directories without system-prompt.md", async () => {
			const otherFile = makeFile("notor/sub-agents/broken/readme.md", "Not a prompt.");
			const brokenDir = makeFolder("notor/sub-agents/broken", [otherFile]);
			const rootDir = makeFolder("notor/sub-agents", [brokenDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			// Should only have built-in profiles, not "broken"
			expect(profiles.find(p => p.name === "broken")).toBeUndefined();
		});

		it("skips profiles with malformed YAML frontmatter", async () => {
			// Has frontmatter delimiters but cache returns no frontmatter → malformed
			const promptFile = makeFile(
				"notor/sub-agents/bad-yaml/system-prompt.md",
				"---\ninvalid: [yaml: broken\n---\nBody content.",
				// No _frontmatter → cache returns null
			);

			const agentDir = makeFolder("notor/sub-agents/bad-yaml", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			expect(profiles.find(p => p.name === "bad-yaml")).toBeUndefined();
		});
	});

	describe("built-in profile fallback", () => {
		it("returns built-in profiles when sub-agents directory does not exist", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			expect(profiles.length).toBe(BUILTIN_SUBAGENT_PROFILES.size);
			for (const [name] of BUILTIN_SUBAGENT_PROFILES) {
				const profile = profiles.find(p => p.name === name);
				expect(profile).toBeDefined();
				expect(profile!.is_builtin).toBe(true);
			}
		});

		it("uses vault file when built-in profile has been customized", async () => {
			const customContent = `---
notor-description: My custom vault search agent.
---

Custom search behavior.

<notor_tool_config>
search_vault:
  enabled: true
</notor_tool_config>
`;
			const promptFile = makeFile(
				"notor/sub-agents/search-vault/system-prompt.md",
				customContent,
				{ "notor-description": "My custom vault search agent." },
			);

			const agentDir = makeFolder("notor/sub-agents/search-vault", [promptFile]);
			const rootDir = makeFolder("notor/sub-agents", [agentDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const searchVault = profiles.find(p => p.name === "search-vault");

			expect(searchVault).toBeDefined();
			expect(searchVault!.description).toBe("My custom vault search agent.");
			expect(searchVault!.prompt_content).toBe("Custom search behavior.");
			expect(searchVault!.is_builtin).toBe(true);
		});

		it("built-in profiles have valid tool configs", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			const searchVault = profiles.find(p => p.name === "search-vault");
			expect(searchVault).toBeDefined();
			expect(searchVault!.tool_configs.length).toBeGreaterThan(0);
			expect(searchVault!.tool_configs[0]!.tools.search_vault).toEqual({ enabled: true });
			expect(searchVault!.tool_configs[0]!.tools.read_note).toEqual({ enabled: true });

			const searchWeb = profiles.find(p => p.name === "search-web");
			expect(searchWeb).toBeDefined();
			expect(searchWeb!.tool_configs.length).toBeGreaterThan(0);
			expect(searchWeb!.tool_configs[0]!.tools.web_search).toEqual({ enabled: true });
			expect(searchWeb!.tool_configs[0]!.tools.fetch_webpage).toEqual({ enabled: true });
		});

		it("built-in profiles parse preferred_preset and iteration_cap from raw frontmatter", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			// Non-memory built-in profiles shouldn't have preset/iteration_cap
			const nonMemoryBuiltins = profiles.filter(
				p => p.is_builtin && !p.name.startsWith("memory-"),
			);
			for (const profile of nonMemoryBuiltins) {
				expect(profile.preferred_preset).toBeNull();
				expect(profile.iteration_cap).toBeNull();
			}

			// Memory built-in profiles should have preset and iteration_cap
			const memorySearch = profiles.find(p => p.name === "memory-search");
			expect(memorySearch).toBeDefined();
			expect(memorySearch!.preferred_preset).toBe("tiny");
			expect(memorySearch!.iteration_cap).toBe(6);

			const memoryResolver = profiles.find(p => p.name === "memory-resolver");
			expect(memoryResolver).toBeDefined();
			expect(memoryResolver!.preferred_preset).toBe("tiny");
			expect(memoryResolver!.iteration_cap).toBe(6);

			const memoryCapture = profiles.find(p => p.name === "memory-capture");
			expect(memoryCapture).toBeDefined();
			expect(memoryCapture!.preferred_preset).toBe("tiny");
			expect(memoryCapture!.iteration_cap).toBe(5);

			const memoryDream = profiles.find(p => p.name === "memory-dream");
			expect(memoryDream).toBeDefined();
			expect(memoryDream!.preferred_preset).toBe("large");
			expect(memoryDream!.iteration_cap).toBe(16);
		});

		it("memory-search profile loads with correct tool scoping", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "memory-search");

			expect(profile).toBeDefined();
			expect(profile!.is_builtin).toBe(true);
			expect(profile!.tool_configs).toHaveLength(1);
			const tools = profile!.tool_configs[0]!.tools;
			expect(tools.read_note).toBeDefined();
			expect(tools.search_vault).toBeDefined();
			expect(tools.read_note!.allowed_paths).toEqual(["{notor_dir}/memory"]);
			expect(tools.search_vault!.allowed_paths).toEqual(["{notor_dir}/memory"]);
			// Should not have broader vault tools
			expect(tools.list_vault).toBeUndefined();
			// Should have link tools scoped to memory dir
			expect(tools.get_backlinks).toEqual({ allowed_paths: ["{notor_dir}/memory"] });
			expect(tools.get_outlinks).toEqual({ allowed_paths: ["{notor_dir}/memory"] });
		});

		it("memory-resolver profile loads with correct tool scoping", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "memory-resolver");

			expect(profile).toBeDefined();
			expect(profile!.is_builtin).toBe(true);
			expect(profile!.tool_configs).toHaveLength(1);
			const tools = profile!.tool_configs[0]!.tools;
			expect(tools.read_note).toBeDefined();
			expect(tools.search_vault).toBeDefined();
			expect(tools.read_note!.allowed_paths).toEqual(["{notor_dir}/memory"]);
			expect(tools.search_vault!.allowed_paths).toEqual(["{notor_dir}/memory"]);
			expect(tools.list_vault).toBeUndefined();
			// Should have link tools scoped to memory dir
			expect(tools.get_backlinks).toEqual({ allowed_paths: ["{notor_dir}/memory"] });
			expect(tools.get_outlinks).toEqual({ allowed_paths: ["{notor_dir}/memory"] });
		});

		it("memory-capture profile loads with broader tool access", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "memory-capture");

			expect(profile).toBeDefined();
			expect(profile!.is_builtin).toBe(true);
			expect(profile!.tool_configs).toHaveLength(1);
			const tools = profile!.tool_configs[0]!.tools;
			expect(tools.read_note).toEqual({ enabled: true });
			expect(tools.search_vault).toEqual({ enabled: true });
			expect(tools.list_vault).toEqual({ enabled: true });
			expect(tools.read_frontmatter).toEqual({ enabled: true });
			expect(tools.get_backlinks).toEqual({ enabled: true });
			expect(tools.get_outlinks).toEqual({ enabled: true });
		});

		it("memory-dream profile loads with broader tool access and large preset", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);
			const profile = profiles.find(p => p.name === "memory-dream");

			expect(profile).toBeDefined();
			expect(profile!.is_builtin).toBe(true);
			expect(profile!.preferred_preset).toBe("large");
			expect(profile!.iteration_cap).toBe(16);
			expect(profile!.tool_configs).toHaveLength(1);
			const tools = profile!.tool_configs[0]!.tools;
			expect(tools.read_note).toEqual({ enabled: true });
			expect(tools.search_vault).toEqual({ enabled: true });
			expect(tools.list_vault).toEqual({ enabled: true });
			expect(tools.read_frontmatter).toEqual({ enabled: true });
			expect(tools.get_backlinks).toEqual({ enabled: true });
			expect(tools.get_outlinks).toEqual({ enabled: true });
		});

		it("memory-search and memory-resolver have path-restricted tool configs", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			for (const name of ["memory-search", "memory-resolver"]) {
				const profile = profiles.find(p => p.name === name);
				expect(profile).toBeDefined();
				const tools = profile!.tool_configs[0]!.tools;
				for (const toolName of Object.keys(tools)) {
					const config = tools[toolName]!;
					if (config.allowed_paths) {
						expect(config.allowed_paths).toEqual(["{notor_dir}/memory"]);
					}
				}
			}
		});

		it("{notor_dir} placeholders in memory profiles are resolved by template registry", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const mockRegistry = {
				resolve: (content: string) => content.replace(/\{notor_dir\}/g, "my-vault/notor"),
			} as import("../template-vars").TemplateVariableRegistry;

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML, mockRegistry);

			const memSearch = profiles.find(p => p.name === "memory-search");
			expect(memSearch).toBeDefined();
			expect(memSearch!.prompt_content).toContain("my-vault/notor/memory/");
			expect(memSearch!.prompt_content).not.toContain("{notor_dir}");
			// Tool configs are extracted after template resolution
			const tools = memSearch!.tool_configs[0]!.tools;
			expect(tools.read_note!.allowed_paths).toEqual(["my-vault/notor/memory"]);
			expect(tools.search_vault!.allowed_paths).toEqual(["my-vault/notor/memory"]);
			expect(tools.get_backlinks!.allowed_paths).toEqual(["my-vault/notor/memory"]);
			expect(tools.get_outlinks!.allowed_paths).toEqual(["my-vault/notor/memory"]);
		});

		it("built-in profiles have descriptions", async () => {
			const files = new Map<string, MockFolder | MockFile>();
			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			for (const profile of profiles) {
				if (profile.is_builtin) {
					expect(profile.description).not.toBeNull();
					expect(profile.description!.length).toBeGreaterThan(0);
				}
			}
		});
	});

	describe("mixed vault + built-in profiles", () => {
		it("combines user-created and built-in profiles", async () => {
			const userPrompt = makeFile(
				"notor/sub-agents/custom-agent/system-prompt.md",
				"---\nnotor-description: Custom agent\n---\nCustom prompt.",
				{ "notor-description": "Custom agent" },
			);

			const customDir = makeFolder("notor/sub-agents/custom-agent", [userPrompt]);
			const rootDir = makeFolder("notor/sub-agents", [customDir]);

			const files = new Map<string, MockFolder | MockFile>();
			registerTree(files, rootDir);

			const vault = buildMockVault(files);
			const cache = buildMockMetadataCache(files);

			const profiles = await discoverSubAgentProfiles(vault, cache, NOTOR_DIR, KNOWN_TOOLS, parseYAML);

			// User-created + built-in profiles
			expect(profiles.length).toBe(1 + BUILTIN_SUBAGENT_PROFILES.size);
			expect(profiles.find(p => p.name === "custom-agent")).toBeDefined();
			expect(profiles.find(p => p.name === "search-vault")).toBeDefined();
			expect(profiles.find(p => p.name === "search-web")).toBeDefined();
		});
	});
});

describe("getSubAgentsRootPath", () => {
	it("strips trailing slash and appends sub-agents", () => {
		expect(getSubAgentsRootPath("notor/")).toBe("notor/sub-agents");
	});

	it("handles path without trailing slash", () => {
		expect(getSubAgentsRootPath("notor")).toBe("notor/sub-agents");
	});

	it("handles nested paths", () => {
		expect(getSubAgentsRootPath("my/custom/dir/")).toBe("my/custom/dir/sub-agents");
	});
});
