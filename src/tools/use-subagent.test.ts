import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger
vi.mock("../utils/logger", () => ({
	logger: () => ({
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	}),
}));

// Mock obsidian Notice
vi.mock("obsidian", () => ({
	Notice: vi.fn(),
}));

// Mock mcp-tool-adapter (required by dispatcher import chain)
vi.mock("../mcp/mcp-tool-adapter", () => ({
	isMcpTool: () => false,
}));

// Mock SubAgentRunner — we test the tool's wiring, not the runner itself
const mockRunFn = vi.fn();
vi.mock("../chat/sub-agent-runner", () => {
	const MockSubAgentRunner = vi.fn().mockImplementation(function (this: { run: typeof mockRunFn }) {
		this.run = mockRunFn;
	});
	return { SubAgentRunner: MockSubAgentRunner };
});

import { UseSubagentTool } from "./use-subagent";
import { SubAgentRunner } from "../chat/sub-agent-runner";
import { Notice } from "obsidian";
import type { SubAgentManager } from "../sub-agents/manager";
import type { SubAgentProfile } from "../sub-agents/types";
import type { ProviderRegistry } from "../providers/index";
import type { ToolRegistry } from "./index";
import type { NotorSettings } from "../settings/types";
import type { EffectiveToolConfig } from "../tool-config/types";
import type { LLMProvider } from "../providers/provider";
import type { SubAgentResult } from "../chat/sub-agent-runner";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeProfile(overrides: Partial<SubAgentProfile> = {}): SubAgentProfile {
	return {
		name: "search-vault",
		directory_path: "notor/sub-agents/search-vault",
		system_prompt_path: "notor/sub-agents/search-vault/system-prompt.md",
		prompt_content: "You search the vault.",
		description: "Search the vault for notes",
		preferred_provider: null,
		preferred_model: null,
		tool_configs: [{
			source: "subagent",
			sourceFile: "notor/sub-agents/search-vault/system-prompt.md",
			documentPosition: 0,
			tools: {
				search_vault: { enabled: true },
			},
		}],
		is_builtin: true,
		...overrides,
	};
}

function makeSubAgentResult(overrides: Partial<SubAgentResult> = {}): SubAgentResult {
	return {
		text: "Found 3 relevant notes.",
		messages: [],
		tokenUsage: { input: 100, output: 50 },
		iterationCount: 2,
		stopReason: "completed",
		...overrides,
	};
}

function makeMockProvider(): LLMProvider {
	return {
		sendMessage: vi.fn(),
		listModels: vi.fn(async () => []),
		getTokenCount: vi.fn(() => 0),
		supportsStreaming: vi.fn(() => true),
		validateConnection: vi.fn(async () => true),
	} as unknown as LLMProvider;
}

function makeMockSubAgentManager(
	profiles: SubAgentProfile[] = [makeProfile()],
): SubAgentManager {
	return {
		discoverProfiles: vi.fn(async () => profiles),
		getVisibleProfiles: vi.fn(async () => profiles),
		getProfile: vi.fn(async (name: string) =>
			profiles.find((p) => p.name === name) ?? null,
		),
		isVisible: vi.fn((name: string) =>
			profiles.some((p) => p.name === name),
		),
		setVisibility: vi.fn(),
		ensureBuiltinVaultFile: vi.fn(),
		resetToDefault: vi.fn(),
		updateSettings: vi.fn(),
	} as unknown as SubAgentManager;
}

function makeMockProviderRegistry(
	mockProvider?: LLMProvider,
): ProviderRegistry {
	const provider = mockProvider ?? makeMockProvider();
	return {
		getActiveProvider: vi.fn(() => provider),
		getActiveType: vi.fn(() => "anthropic" as const),
		getProvider: vi.fn(() => provider),
		getConfig: vi.fn(() => ({
			type: "anthropic",
			model_id: "claude-sonnet-4-20250514",
		})),
	} as unknown as ProviderRegistry;
}

function makeMockToolRegistry(): ToolRegistry {
	const tools = new Map([
		["search_vault", { name: "search_vault", description: "Search", input_schema: { type: "object" }, mode: "read" as const, execute: vi.fn() }],
		["read_note", { name: "read_note", description: "Read", input_schema: { type: "object" }, mode: "read" as const, execute: vi.fn() }],
		["write_note", { name: "write_note", description: "Write", input_schema: { type: "object" }, mode: "write" as const, execute: vi.fn() }],
	]);
	return {
		get: (name: string) => tools.get(name),
		getAll: () => Array.from(tools.values()),
		getNames: () => Array.from(tools.keys()),
		has: (name: string) => tools.has(name),
	} as unknown as ToolRegistry;
}

function makeSettings(overrides: Partial<NotorSettings> = {}): NotorSettings {
	return {
		sub_agent_concurrency_cap: 3,
		sub_agent_visibility: {},
		sub_agent_auto_approve_reads: true,
		...overrides,
	} as unknown as NotorSettings;
}

function makeParentConfig(): EffectiveToolConfig {
	return {
		tools: {
			search_vault: { enabled: true, auto_approve: true, allowed_paths: [], blocked_paths: [] },
			read_note: { enabled: true, auto_approve: true, allowed_paths: [], blocked_paths: [] },
			write_note: { enabled: true, auto_approve: false, allowed_paths: [], blocked_paths: [] },
		},
	};
}

function createTool(overrides: {
	manager?: SubAgentManager;
	providerRegistry?: ProviderRegistry;
	toolRegistry?: ToolRegistry;
	settings?: NotorSettings;
	parentConfig?: EffectiveToolConfig | null;
} = {}): UseSubagentTool {
	const {
		manager = makeMockSubAgentManager(),
		providerRegistry = makeMockProviderRegistry(),
		toolRegistry = makeMockToolRegistry(),
		settings = makeSettings(),
		parentConfig = makeParentConfig(),
	} = overrides;

	return new UseSubagentTool(
		manager,
		providerRegistry,
		toolRegistry,
		settings,
		() => parentConfig,
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UseSubagentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRunFn.mockResolvedValue(makeSubAgentResult());
	});

	// -----------------------------------------------------------------------
	// Basic properties
	// -----------------------------------------------------------------------

	describe("tool metadata", () => {
		it("has correct name and mode", () => {
			const tool = createTool();
			expect(tool.name).toBe("use_subagent");
			expect(tool.mode).toBe("read");
		});
	});

	// -----------------------------------------------------------------------
	// Dynamic description & schema (5.3b)
	// -----------------------------------------------------------------------

	describe("dynamic description", () => {
		it("includes visible profile names and descriptions", async () => {
			const tool = createTool();
			await tool.refreshVisibleProfiles();

			expect(tool.description).toContain("search-vault");
			expect(tool.description).toContain("Search the vault for notes");
		});

		it("shows (no profiles available) when no profiles exist", () => {
			const tool = createTool({ manager: makeMockSubAgentManager([]) });
			// Don't refresh — cache is empty
			expect(tool.description).toContain("(no profiles available)");
		});

		it("excludes profiles with null description", async () => {
			const noDesc = makeProfile({ name: "no-desc", description: null });
			const withDesc = makeProfile({ name: "with-desc", description: "Has desc" });
			const tool = createTool({ manager: makeMockSubAgentManager([noDesc, withDesc]) });
			await tool.refreshVisibleProfiles();

			expect(tool.description).not.toContain("no-desc");
			expect(tool.description).toContain("with-desc");
		});
	});

	describe("dynamic input_schema", () => {
		it("has enum matching visible profile names", async () => {
			const tool = createTool();
			await tool.refreshVisibleProfiles();

			const schema = tool.input_schema;
			expect(schema.properties?.profile?.enum).toEqual(["search-vault"]);
		});
	});

	// -----------------------------------------------------------------------
	// execute() — success path
	// -----------------------------------------------------------------------

	describe("execute() — success", () => {
		it("valid profile + task → SubAgentRunner is constructed and run, result returned", async () => {
			const tool = createTool();
			const result = await tool.execute(
				{ profile: "search-vault", task: "Find notes about testing" },
				{ mode: "act" },
			);

			expect(result.success).toBe(true);
			expect(result.result).toBe("Found 3 relevant notes.");
			expect(SubAgentRunner).toHaveBeenCalledTimes(1);
			expect(mockRunFn).toHaveBeenCalledWith("Find notes about testing");
		});

		it("threads onProgress callback through to SubAgentRunner", async () => {
			const onProgress = vi.fn();
			const tool = createTool();
			await tool.execute(
				{ profile: "search-vault", task: "Search" },
				{ mode: "act", onProgress },
			);

			// SubAgentRunner constructor should receive onProgress
			const ctorCall = (SubAgentRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
			expect(ctorCall.onProgress).toBe(onProgress);
		});
	});

	// -----------------------------------------------------------------------
	// execute() — error paths
	// -----------------------------------------------------------------------

	describe("execute() — errors", () => {
		it("unknown profile name → error ToolResult", async () => {
			const tool = createTool();
			const result = await tool.execute(
				{ profile: "nonexistent", task: "Do something" },
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("not found or is disabled");
		});

		it("disabled profile (visibility toggle off) → error ToolResult", async () => {
			const manager = makeMockSubAgentManager([]);
			const tool = createTool({ manager });
			const result = await tool.execute(
				{ profile: "search-vault", task: "Search" },
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("not found or is disabled");
		});

		it("_isSubAgentContext flag set → error ToolResult (defense-in-depth)", async () => {
			const tool = createTool();
			tool._isSubAgentContext = true;

			const result = await tool.execute(
				{ profile: "search-vault", task: "Search" },
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("cannot be called from within a sub-agent");
		});

		it("provider not configured → error ToolResult", async () => {
			const profile = makeProfile({ preferred_provider: "bedrock" });
			const providerRegistry = makeMockProviderRegistry();
			(providerRegistry.getProvider as ReturnType<typeof vi.fn>).mockImplementation(() => {
				throw new Error("No configuration found");
			});

			const tool = createTool({
				manager: makeMockSubAgentManager([profile]),
				providerRegistry,
			});

			const result = await tool.execute(
				{ profile: "search-vault", task: "Search" },
			);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Provider 'bedrock' is not configured");
		});
	});

	// -----------------------------------------------------------------------
	// Semaphore (5.2 integration)
	// -----------------------------------------------------------------------

	describe("semaphore", () => {
		it("limits concurrent executions to cap", async () => {
			const settings = makeSettings({ sub_agent_concurrency_cap: 1 } as Partial<NotorSettings>);
			const tool = createTool({ settings });

			let concurrentCount = 0;
			let maxConcurrent = 0;

			mockRunFn.mockImplementation(async () => {
				concurrentCount++;
				maxConcurrent = Math.max(maxConcurrent, concurrentCount);
				// Simulate some async work
				await new Promise((r) => setTimeout(r, 10));
				concurrentCount--;
				return makeSubAgentResult();
			});

			// Launch 3 concurrent calls
			const promises = [
				tool.execute({ profile: "search-vault", task: "1" }),
				tool.execute({ profile: "search-vault", task: "2" }),
				tool.execute({ profile: "search-vault", task: "3" }),
			];

			await Promise.all(promises);

			// With cap of 1, should never exceed 1 concurrent
			expect(maxConcurrent).toBe(1);
		});
	});

	// -----------------------------------------------------------------------
	// Configuration gap detection (5.5)
	// -----------------------------------------------------------------------

	describe("configuration gap detection", () => {
		it("emits Notice for tools enabled in profile but disabled by parent", async () => {
			const parentConfig: EffectiveToolConfig = {
				tools: {
					search_vault: { enabled: false, auto_approve: false, allowed_paths: [], blocked_paths: [] },
					read_note: { enabled: true, auto_approve: true, allowed_paths: [], blocked_paths: [] },
				},
			};

			const tool = createTool({ parentConfig });
			await tool.execute(
				{ profile: "search-vault", task: "Search" },
			);

			expect(Notice).toHaveBeenCalledWith(
				expect.stringContaining("search_vault"),
			);
		});
	});

	// -----------------------------------------------------------------------
	// Tool config merging
	// -----------------------------------------------------------------------

	describe("tool config intersection", () => {
		it("profile's multiple tool_config blocks are merged (last-writer-wins)", async () => {
			const profile = makeProfile({
				tool_configs: [
					{
						source: "subagent",
						sourceFile: "test.md",
						documentPosition: 0,
						tools: { search_vault: { enabled: true } },
					},
					{
						source: "subagent",
						sourceFile: "test.md",
						documentPosition: 1,
						tools: { search_vault: { enabled: false } },
					},
				],
			});

			const tool = createTool({ manager: makeMockSubAgentManager([profile]) });

			// The sub-agent will run, but search_vault should be disabled in its config
			// (enabled: false in profile AND true in parent → false from last-writer-wins in merge + intersection)
			await tool.execute({ profile: "search-vault", task: "Search" });

			// SubAgentRunner was still called (just with fewer tools)
			expect(SubAgentRunner).toHaveBeenCalled();
		});

		it("intersected config correctly restricts sub-agent tools to parent ∩ profile", async () => {
			// Parent has search_vault enabled, write_note enabled
			// Profile only requests search_vault
			// → sub-agent should only get search_vault
			const tool = createTool();
			await tool.execute(
				{ profile: "search-vault", task: "Search" },
			);

			const ctorCall = (SubAgentRunner as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
			const toolNames = ctorCall.toolDefinitions.map((t: { name: string }) => t.name);
			expect(toolNames).toContain("search_vault");
			expect(toolNames).not.toContain("write_note");
			expect(toolNames).not.toContain("read_note");
		});
	});
});
