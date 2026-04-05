import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UserToolDefinition, UserAutomationDefinition, ExtensionError } from "../types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLog = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	error: vi.fn(),
}));

vi.mock("../../utils/logger", () => ({
	logger: () => mockLog,
}));

// Mock obsidian Notice
const mockNoticeInstances: Array<{ message: string }> = [];
vi.mock("obsidian", () => ({
	Notice: class {
		constructor(message: string) {
			mockNoticeInstances.push({ message });
		}
	},
}));

// Mock TOOL_PATH_PARAMS — mutable object
const mockToolPathParams: Record<string, unknown> = {};
vi.mock("../../tool-config/path-enforcer", () => ({
	TOOL_PATH_PARAMS: mockToolPathParams,
}));

// Mock discovery
const mockDiscoverExtensions = vi.fn();
vi.mock("../discovery", () => ({
	discoverExtensions: (...args: unknown[]) => mockDiscoverExtensions(...args),
}));

// Mock compiler
const mockCompileExtension = vi.fn();
vi.mock("../compiler", () => ({
	compileExtension: (...args: unknown[]) => mockCompileExtension(...args),
}));

// Mock param-schema
vi.mock("../param-schema", () => ({
	paramSchemaToJsonSchema: (params: Record<string, unknown>) => ({
		type: "object",
		properties: Object.fromEntries(
			Object.entries(params).map(([k, v]) => [k, { type: (v as Record<string, string>).type }]),
		),
		required: Object.entries(params)
			.filter(([, v]) => (v as Record<string, unknown>).default === undefined)
			.map(([k]) => k),
	}),
}));

// Mock settings resolution
const mockResolveSettings = vi.fn().mockReturnValue({ values: {}, missing: [] });
const mockResolveSharedSettings = vi.fn().mockReturnValue({ values: {}, missing: [] });
vi.mock("../settings-schema", () => ({
	resolveSettings: (...args: unknown[]) => mockResolveSettings(...args),
	resolveSharedSettings: (...args: unknown[]) => mockResolveSharedSettings(...args),
}));

// Mock runtime context
const mockBuildUtils = vi.fn().mockReturnValue({ logger: () => {} });
const mockBuildLibs = vi.fn().mockReturnValue({ marked: {} });
const mockBuildObsidianExports = vi.fn().mockReturnValue({ Notice: class {} });
vi.mock("../runtime-context", () => ({
	buildUtils: (...args: unknown[]) => mockBuildUtils(...args),
	buildLibs: (...args: unknown[]) => mockBuildLibs(...args),
	buildObsidianExports: (...args: unknown[]) => mockBuildObsidianExports(...args),
}));

// Mock secrets
vi.mock("../../utils/secrets", () => ({
	getSecret: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockPlugin(overrides?: Partial<ReturnType<typeof createMockPlugin>>): ReturnType<typeof _createMockPlugin> {
	return _createMockPlugin(overrides);
}

function _createMockPlugin(overrides?: Record<string, unknown>) {
	const registeredTools = new Map<string, unknown>();
	const dispatcherTools = new Map<string, unknown>();

	return {
		app: { vault: {}, metadataCache: {} },
		settings: {
			notor_dir: "notor/",
			user_extension_settings: {} as Record<string, Record<string, unknown>>,
			user_shared_settings: {} as Record<string, unknown>,
		},
		getToolRegistry: () => ({
			register: vi.fn((tool: { name: string }) => { registeredTools.set(tool.name, tool); }),
			unregister: vi.fn((name: string) => { registeredTools.delete(name); }),
			has: vi.fn((name: string) => registeredTools.has(name)),
			get: vi.fn((name: string) => registeredTools.get(name)),
		}),
		getToolDispatcher: () => ({
			registerTool: vi.fn((tool: { name: string }) => { dispatcherTools.set(tool.name, tool); }),
			unregisterTool: vi.fn((name: string) => { dispatcherTools.delete(name); }),
		}),
		_registeredTools: registeredTools,
		_dispatcherTools: dispatcherTools,
		...overrides,
	};
}

function makeToolDef(overrides?: Partial<UserToolDefinition>): UserToolDefinition {
	return {
		filePath: "notor/tools/my-tool.md",
		name: "my_tool",
		description: "A test tool",
		mode: "read",
		params: { query: { type: "string" } },
		pathParams: [],
		settingsSchema: null,
		rawCode: 'return params.query;',
		compiledFn: null,
		...overrides,
	};
}

function makeAutomationDef(overrides?: Partial<UserAutomationDefinition>): UserAutomationDefinition {
	return {
		filePath: "notor/automations/on-save.md",
		displayName: null,
		trigger: "on_save",
		schedule: null,
		toolFilter: null,
		order: 0,
		settingsSchema: null,
		rawCode: 'console.log("fired");',
		compiledFn: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// We need to import after mocks are set up
const { ExtensionManager, UserToolAdapter } = await import("../manager");

beforeEach(() => {
	vi.clearAllMocks();
	mockNoticeInstances.length = 0;
	// Clean up TOOL_PATH_PARAMS
	for (const key of Object.keys(mockToolPathParams)) {
		delete mockToolPathParams[key];
	}
});

// ---------------------------------------------------------------------------
// ExtensionManager.reload()
// ---------------------------------------------------------------------------

describe("ExtensionManager.reload", () => {
	it("discovers and compiles tools from vault files", async () => {
		const tool = makeToolDef();
		const compiledFn = vi.fn().mockResolvedValue("result");

		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: compiledFn });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const result = await manager.reload(true);

		expect(result.toolCount).toBe(1);
		expect(result.automationCount).toBe(0);
		expect(result.errors).toHaveLength(0);
		expect(mockDiscoverExtensions).toHaveBeenCalledOnce();
		expect(mockCompileExtension).toHaveBeenCalledWith(tool.rawCode, "tool");
	});

	it("compiles automations", async () => {
		const automation = makeAutomationDef();
		const compiledFn = vi.fn().mockResolvedValue(undefined);

		mockDiscoverExtensions.mockResolvedValue({
			tools: [],
			automations: [automation],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: compiledFn });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const result = await manager.reload(true);

		expect(result.automationCount).toBe(1);
		expect(mockCompileExtension).toHaveBeenCalledWith(automation.rawCode, "automation");
	});

	it("skips tool on compilation error and continues loading others", async () => {
		const badTool = makeToolDef({ name: "bad_tool", rawCode: "invalid" });
		const goodTool = makeToolDef({ name: "good_tool", rawCode: "return 1;" });

		mockDiscoverExtensions.mockResolvedValue({
			tools: [badTool, goodTool],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension
			.mockReturnValueOnce({ error: "Syntax error" })
			.mockReturnValueOnce({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const result = await manager.reload(true);

		expect(result.toolCount).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].message).toContain("Syntax error");
	});

	it("detects built-in tool overrides", async () => {
		const tool = makeToolDef({ name: "read_note" });
		const compiledFn = vi.fn();

		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: compiledFn });

		// Pre-register "read_note" as a built-in tool
		const plugin = createMockPlugin();
		plugin._registeredTools.set("read_note", { name: "read_note" });

		const manager = new ExtensionManager(plugin as never, vi.fn());
		const result = await manager.reload(true);

		expect(result.builtinOverrides).toContain("read_note");
	});

	it("clears previous registrations before re-registering", async () => {
		const tool1 = makeToolDef({ name: "tool_a" });
		const tool2 = makeToolDef({ name: "tool_b" });

		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool1],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());

		// First reload: registers tool_a
		await manager.reload(true);
		expect(manager.getTools()).toHaveLength(1);
		expect(manager.getTools()[0].name).toBe("tool_a");

		// Second reload: replaces with tool_b
		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool2],
			automations: [],
			sharedSettings: null,
			errors: [],
		});

		const result = await manager.reload(false);
		expect(result.toolCount).toBe(1);
		expect(manager.getTools()).toHaveLength(1);
		expect(manager.getTools()[0].name).toBe("tool_b");
	});

	it("registers path params in TOOL_PATH_PARAMS", async () => {
		const tool = makeToolDef({
			name: "path_tool",
			pathParams: [{ paramName: "path", namespace: "vault" }],
		});

		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		expect(mockToolPathParams["path_tool"]).toEqual([
			{ paramName: "path", namespace: "vault" },
		]);
	});

	it("skips dispatcher registration on initial load", async () => {
		const tool = makeToolDef();

		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		// Dispatcher tools should not have been registered (isInitialLoad=true)
		expect(plugin._dispatcherTools.size).toBe(0);
	});

	it("registers in dispatcher on manual reload (isInitialLoad=false)", async () => {
		const tool = makeToolDef();

		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(false);

		expect(plugin._dispatcherTools.size).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// UserToolAdapter.execute()
// ---------------------------------------------------------------------------

describe("UserToolAdapter.execute", () => {
	it("returns valid ToolResult with correct fields", async () => {
		const compiledFn = vi.fn().mockResolvedValue("search result");
		const toolDef = makeToolDef({ compiledFn });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const adapter = new UserToolAdapter(toolDef, manager, plugin as never);

		const result = await adapter.execute({ query: "test" });

		expect(result.tool_name).toBe("my_tool");
		expect(result.success).toBe(true);
		expect(result.result).toBe("search result");
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
		expect(result.error).toBeUndefined();
	});

	it("handles thrown errors gracefully (returns error ToolResult)", async () => {
		const compiledFn = vi.fn().mockRejectedValue(new Error("Tool crashed"));
		const toolDef = makeToolDef({ compiledFn });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const adapter = new UserToolAdapter(toolDef, manager, plugin as never);

		const result = await adapter.execute({ query: "test" });

		expect(result.tool_name).toBe("my_tool");
		expect(result.success).toBe(false);
		expect(result.error).toBe("Tool crashed");
		expect(result.duration_ms).toBeGreaterThanOrEqual(0);
	});

	it("returns error when required settings are missing", async () => {
		const compiledFn = vi.fn().mockResolvedValue("ok");
		const toolDef = makeToolDef({
			settingsSchema: [{ key: "api_key", name: "API Key", type: "string" }],
		});

		// Register the tool via reload so it exists in manager's internal map
		mockDiscoverExtensions.mockResolvedValue({
			tools: [toolDef],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: compiledFn });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		// Now mock resolveSettings to report missing settings
		mockResolveSettings.mockReturnValueOnce({ values: {}, missing: ["api_key"] });

		// Get the adapter from the registry (or create one manually)
		const adapter = new UserToolAdapter(
			manager.getTools()[0],
			manager,
			plugin as never,
		);

		const result = await adapter.execute({});

		expect(result.success).toBe(false);
		expect(result.error).toContain("api_key");
		expect(result.error).toContain("configured in Settings");
	});

	it("merges abort signal from options into utils", async () => {
		const compiledFn = vi.fn().mockResolvedValue("ok");
		const toolDef = makeToolDef({ compiledFn });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const adapter = new UserToolAdapter(toolDef, manager, plugin as never);

		const controller = new AbortController();
		await adapter.execute({}, { abortSignal: controller.signal });

		// Check that buildUtils was called and abortSignal was set
		const utilsObj = mockBuildUtils.mock.results[0]?.value;
		expect(utilsObj.abortSignal).toBe(controller.signal);
	});

	it("passes content_blocks through if returned", async () => {
		const blocks = [{ type: "text", text: "hello" }];
		const compiledFn = vi.fn().mockResolvedValue({
			result: "summary",
			content_blocks: blocks,
		});
		const toolDef = makeToolDef({ compiledFn });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const adapter = new UserToolAdapter(toolDef, manager, plugin as never);

		const result = await adapter.execute({});

		expect(result.content_blocks).toEqual(blocks);
		expect(result.result).toBe("summary");
	});

	it("exposes correct name, description, mode, input_schema", () => {
		const toolDef = makeToolDef({
			name: "custom_search",
			description: "Search things",
			mode: "write",
			params: { query: { type: "string" } },
		});
		toolDef.compiledFn = vi.fn();

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		const adapter = new UserToolAdapter(toolDef, manager, plugin as never);

		expect(adapter.name).toBe("custom_search");
		expect(adapter.description).toBe("Search things");
		expect(adapter.mode).toBe("write");
		expect(adapter.input_schema.type).toBe("object");
	});
});

// ---------------------------------------------------------------------------
// getAutomationsForTrigger
// ---------------------------------------------------------------------------

describe("getAutomationsForTrigger", () => {
	it("returns automations matching the trigger", async () => {
		const auto1 = makeAutomationDef({ trigger: "on_save", filePath: "a.md" });
		const auto2 = makeAutomationDef({ trigger: "pre_send", filePath: "b.md" });

		mockDiscoverExtensions.mockResolvedValue({
			tools: [],
			automations: [auto1, auto2],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		const result = manager.getAutomationsForTrigger("on_save");
		expect(result).toHaveLength(1);
		expect(result[0].trigger).toBe("on_save");
	});

	it("returns empty array for non-matching trigger", async () => {
		const auto = makeAutomationDef({ trigger: "on_save" });

		mockDiscoverExtensions.mockResolvedValue({
			tools: [],
			automations: [auto],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		expect(manager.getAutomationsForTrigger("pre_send")).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// getAutomationsForToolEvent
// ---------------------------------------------------------------------------

describe("getAutomationsForToolEvent", () => {
	it("respects notor-tools filter", async () => {
		const auto = makeAutomationDef({
			trigger: "on_tool_call",
			toolFilter: ["read_note"],
		});

		mockDiscoverExtensions.mockResolvedValue({
			tools: [],
			automations: [auto],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		expect(manager.getAutomationsForToolEvent("on_tool_call", "read_note")).toHaveLength(1);
		expect(manager.getAutomationsForToolEvent("on_tool_call", "write_note")).toHaveLength(0);
	});

	it("null filter matches all tools", async () => {
		const auto = makeAutomationDef({
			trigger: "on_tool_call",
			toolFilter: null,
		});

		mockDiscoverExtensions.mockResolvedValue({
			tools: [],
			automations: [auto],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		expect(manager.getAutomationsForToolEvent("on_tool_call", "any_tool")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Automation ordering
// ---------------------------------------------------------------------------

describe("automation ordering", () => {
	it("automations are sorted by order", async () => {
		const auto1 = makeAutomationDef({ trigger: "on_save", order: 10, filePath: "a.md" });
		const auto2 = makeAutomationDef({ trigger: "on_save", order: 1, filePath: "b.md" });
		const auto3 = makeAutomationDef({ trigger: "on_save", order: 5, filePath: "c.md" });

		mockDiscoverExtensions.mockResolvedValue({
			tools: [],
			automations: [auto1, auto2, auto3],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		const sorted = manager.getAutomationsForTrigger("on_save");
		expect(sorted.map((a) => a.order)).toEqual([1, 5, 10]);
	});
});

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe("ExtensionManager.destroy", () => {
	it("cleans up registry entries and TOOL_PATH_PARAMS", async () => {
		const tool = makeToolDef({
			name: "cleanup_tool",
			pathParams: [{ paramName: "p", namespace: "vault" }],
		});

		mockDiscoverExtensions.mockResolvedValue({
			tools: [tool],
			automations: [],
			sharedSettings: null,
			errors: [],
		});
		mockCompileExtension.mockReturnValue({ fn: vi.fn() });

		const plugin = createMockPlugin();
		const manager = new ExtensionManager(plugin as never, vi.fn());
		await manager.reload(true);

		expect(mockToolPathParams["cleanup_tool"]).toBeDefined();

		manager.destroy();

		expect(mockToolPathParams["cleanup_tool"]).toBeUndefined();
		expect(manager.getTools()).toHaveLength(0);
		expect(manager.getAutomations()).toHaveLength(0);
	});
});
