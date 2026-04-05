/**
 * ExtensionManager — central orchestrator for user-defined extensions.
 *
 * Coordinates discovery, compilation, registration, settings resolution,
 * and reload lifecycle for user tools and automations.
 */

import { Notice } from "obsidian";
import type NotorPlugin from "../main";
import type { Tool, ToolExecuteOptions, JSONSchema } from "../tools/tool";
import type { ToolResult } from "../types";
import type {
	AutomationTrigger,
	CompiledExtensionFn,
	ExtensionError,
	ExtensionReloadResult,
	SharedSettingsDefinition,
	UserAutomationDefinition,
	UserToolDefinition,
} from "./types";
import { discoverExtensions } from "./discovery";
import { compileExtension } from "./compiler";
import { paramSchemaToJsonSchema } from "./param-schema";
import { resolveSettings, resolveSharedSettings } from "./settings-schema";
import { buildUtils, buildLibs, buildObsidianExports } from "./runtime-context";
import type { ExtensionUtils, ExtensionLibs, ExtensionObsidianExports } from "./runtime-context";
import { TOOL_PATH_PARAMS } from "../tool-config/path-enforcer";
import { logger } from "../utils/logger";

const log = logger("ExtensionManager");

// ---------------------------------------------------------------------------
// UserToolAdapter — wraps a UserToolDefinition as a Tool for the registry
// ---------------------------------------------------------------------------

/**
 * Adapter that wraps a compiled user tool definition into the `Tool` interface
 * expected by `ToolRegistry` and `ToolDispatcher`.
 *
 * Also satisfies `DispatchableTool` via structural typing (Tool is a superset).
 */
export class UserToolAdapter implements Tool {
	readonly name: string;
	readonly description: string;
	readonly input_schema: JSONSchema;
	readonly mode: "read" | "write";

	constructor(
		private readonly definition: UserToolDefinition,
		private readonly manager: ExtensionManager,
		private readonly plugin: NotorPlugin,
	) {
		this.name = definition.name;
		this.description = definition.description;
		this.input_schema = paramSchemaToJsonSchema(definition.params);
		this.mode = definition.mode;
	}

	async execute(params: Record<string, unknown>, options?: ToolExecuteOptions): Promise<ToolResult> {
		const startTime = Date.now();

		try {
			// 1. Resolve per-extension settings (sync)
			const { values: settings, missing: missingSettings } =
				this.manager.getResolvedSettings(this.definition.name);

			// 2. Check for missing required settings
			if (missingSettings.length > 0) {
				return {
					tool_name: this.name,
					success: false,
					result: "",
					error: `Tool '${this.name}' requires setting${missingSettings.length > 1 ? "s" : ""} '${missingSettings.join("', '")}' to be configured in Settings.`,
					duration_ms: Date.now() - startTime,
				};
			}

			// 3. Resolve shared settings (sync)
			const { values: shared } = this.manager.getResolvedSharedSettings();

			// 4. Build injected context objects
			const utils: ExtensionUtils = buildUtils(this.plugin);
			// Merge abort signal per-invocation
			if (options?.abortSignal) {
				utils.abortSignal = options.abortSignal;
			}

			const libs = this.manager.getCachedLibs();
			const obsidian = this.manager.getCachedObsidianExports();

			// 5. Call compiled function
			const compiledFn = this.definition.compiledFn!;
			const returnValue = await compiledFn(
				this.plugin.app,
				obsidian,
				utils,
				libs,
				settings,
				shared,
				params,
			);

			// 6. Map return value to ToolResult
			const duration_ms = Date.now() - startTime;
			const result: ToolResult = {
				tool_name: this.name,
				success: true,
				result: typeof returnValue === "string"
					? returnValue
					: typeof returnValue === "object" && returnValue !== null
						? returnValue as Record<string, unknown>
						: String(returnValue ?? ""),
				duration_ms,
			};

			// Pass through content_blocks if returned
			if (
				returnValue &&
				typeof returnValue === "object" &&
				"content_blocks" in (returnValue as Record<string, unknown>) &&
				Array.isArray((returnValue as Record<string, unknown>).content_blocks)
			) {
				result.content_blocks = (returnValue as Record<string, unknown>).content_blocks as ToolResult["content_blocks"];
				// Use .result from the return value if present alongside content_blocks
				if ("result" in (returnValue as Record<string, unknown>)) {
					const innerResult = (returnValue as Record<string, unknown>).result;
					result.result = typeof innerResult === "string"
						? innerResult
						: typeof innerResult === "object" && innerResult !== null
							? innerResult as Record<string, unknown>
							: String(innerResult ?? "");
				}
			}

			return result;
		} catch (err: unknown) {
			const duration_ms = Date.now() - startTime;
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;

			// 3-channel error reporting
			new Notice(`Extension error in ${this.name}: ${message}`);
			log.error("User tool execution failed", { tool: this.name, error: String(err), stack });

			return {
				tool_name: this.name,
				success: false,
				result: "",
				error: message,
				duration_ms,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// ExtensionManager
// ---------------------------------------------------------------------------

/**
 * Central manager for user-defined extensions.
 *
 * Orchestrates discovery, compilation, registration in ToolRegistry/ToolDispatcher,
 * settings resolution, and the reload lifecycle.
 */
export class ExtensionManager {
	/** Compiled user tools keyed by tool name. */
	private tools = new Map<string, UserToolDefinition>();

	/** Compiled user automations keyed by file path. */
	private automations = new Map<string, UserAutomationDefinition>();

	/** Shared settings definition from `notor/settings.md`. */
	private sharedSettings: SharedSettingsDefinition | null = null;

	/** Cached libs object (built once, reused across calls). */
	private cachedLibsInstance: ExtensionLibs | null = null;

	/** Cached obsidian exports (built once, reused). */
	private cachedObsidianInstance: ExtensionObsidianExports | null = null;

	/** Tool names registered by this manager (for cleanup on reload). */
	private registeredToolNames = new Set<string>();

	constructor(
		private readonly plugin: NotorPlugin,
		private readonly parseYAML: (yaml: string) => unknown,
	) {}

	// -----------------------------------------------------------------------
	// Reload
	// -----------------------------------------------------------------------

	/**
	 * Full discovery + compilation + registration cycle.
	 *
	 * @param isInitialLoad - When true (called from `onLayoutReady()`), skip
	 *   ToolDispatcher registration — the dispatcher doesn't exist yet and will
	 *   pick up user tools from `registry.getAll()` when lazily created.
	 *   When false (manual reload), register/unregister in the dispatcher too.
	 */
	async reload(isInitialLoad: boolean): Promise<ExtensionReloadResult> {
		const errors: ExtensionError[] = [];
		const builtinOverrides: string[] = [];

		// 1. Discover all extensions
		const discovered = await discoverExtensions(
			this.plugin.app.vault,
			this.plugin.app.metadataCache,
			this.plugin.settings.notor_dir,
			this.parseYAML,
		);
		errors.push(...discovered.errors);

		// 2. Compile tools
		const compiledTools = new Map<string, UserToolDefinition>();
		for (const tool of discovered.tools) {
			const result = compileExtension(tool.rawCode, "tool");
			if ("error" in result) {
				const msg = `Extension '${tool.name}' failed to compile: ${result.error}`;
				new Notice(msg);
				log.error(msg, { file: tool.filePath });
				errors.push({ filePath: tool.filePath, message: result.error });
				continue;
			}
			tool.compiledFn = result.fn;
			compiledTools.set(tool.name, tool);
		}

		// 3. Compile automations
		const compiledAutomations = new Map<string, UserAutomationDefinition>();
		for (const automation of discovered.automations) {
			const result = compileExtension(automation.rawCode, "automation");
			if ("error" in result) {
				const displayName = automation.displayName ?? automation.filePath;
				const msg = `Extension '${displayName}' failed to compile: ${result.error}`;
				new Notice(msg);
				log.error(msg, { file: automation.filePath });
				errors.push({ filePath: automation.filePath, message: result.error });
				continue;
			}
			automation.compiledFn = result.fn;
			compiledAutomations.set(automation.filePath, automation);
		}

		// 4. Shared settings
		this.sharedSettings = discovered.sharedSettings;

		// 5. Detect built-in overrides before unregistering
		const registry = this.plugin.getToolRegistry();
		for (const toolName of compiledTools.keys()) {
			if (registry.has(toolName) && !this.registeredToolNames.has(toolName)) {
				builtinOverrides.push(toolName);
			}
		}

		// 6. Unregister previous user tools
		for (const name of this.registeredToolNames) {
			registry.unregister(name);
			delete TOOL_PATH_PARAMS[name];
			if (!isInitialLoad) {
				this.plugin.getToolDispatcher().unregisterTool(name);
			}
		}
		this.registeredToolNames.clear();

		// 7. Register new user tools
		for (const [name, tool] of compiledTools) {
			const adapter = new UserToolAdapter(tool, this, this.plugin);
			registry.register(adapter);
			if (!isInitialLoad) {
				this.plugin.getToolDispatcher().registerTool(adapter);
			}
			this.registeredToolNames.add(name);

			// Register path params for path enforcement
			if (tool.pathParams.length > 0) {
				TOOL_PATH_PARAMS[name] = tool.pathParams;
			}
		}

		// 8. Update internal maps
		this.tools = compiledTools;
		this.automations = compiledAutomations;

		// 9. Report
		const toolCount = compiledTools.size;
		const automationCount = compiledAutomations.size;

		if (builtinOverrides.length > 0) {
			new Notice(`User extensions override built-in tools: ${builtinOverrides.join(", ")}`);
		}

		const summary = `Extensions reloaded: ${toolCount} tool${toolCount !== 1 ? "s" : ""}, ${automationCount} automation${automationCount !== 1 ? "s" : ""}` +
			(errors.length > 0 ? ` (${errors.length} error${errors.length !== 1 ? "s" : ""})` : "");
		log.info(summary);

		if (!isInitialLoad) {
			new Notice(summary);
		}

		return { toolCount, automationCount, builtinOverrides, errors };
	}

	// -----------------------------------------------------------------------
	// Tool accessors
	// -----------------------------------------------------------------------

	/** Get all compiled user tool definitions. */
	getTools(): UserToolDefinition[] {
		return Array.from(this.tools.values());
	}

	// -----------------------------------------------------------------------
	// Automation accessors
	// -----------------------------------------------------------------------

	/** Get all compiled automations matching a specific trigger, sorted by order. */
	getAutomationsForTrigger(trigger: AutomationTrigger): UserAutomationDefinition[] {
		const matching: UserAutomationDefinition[] = [];
		for (const automation of this.automations.values()) {
			if (automation.trigger === trigger && automation.compiledFn) {
				matching.push(automation);
			}
		}
		// Already sorted by order from discovery, but re-sort to be safe
		return matching.sort((a, b) => {
			if (a.order !== b.order) return a.order - b.order;
			return a.filePath.localeCompare(b.filePath);
		});
	}

	/**
	 * Get automations matching a trigger + tool name filter.
	 *
	 * If an automation's `toolFilter` is null, it matches all tools.
	 * If non-null, the tool name must be in the filter list.
	 */
	getAutomationsForToolEvent(
		trigger: "on_tool_call" | "on_tool_result",
		toolName: string,
	): UserAutomationDefinition[] {
		const matching: UserAutomationDefinition[] = [];
		for (const automation of this.automations.values()) {
			if (automation.trigger !== trigger || !automation.compiledFn) continue;
			if (automation.toolFilter === null || automation.toolFilter.includes(toolName)) {
				matching.push(automation);
			}
		}
		return matching.sort((a, b) => {
			if (a.order !== b.order) return a.order - b.order;
			return a.filePath.localeCompare(b.filePath);
		});
	}

	// -----------------------------------------------------------------------
	// Settings resolution
	// -----------------------------------------------------------------------

	/**
	 * Resolve per-extension settings (synchronous).
	 *
	 * Always reads from live `plugin.settings` reference — no caching.
	 */
	getResolvedSettings(extensionName: string): { values: Record<string, unknown>; missing: string[] } {
		// Find the tool or automation definition with settings
		const tool = this.tools.get(extensionName);
		const schemas = tool?.settingsSchema;

		if (!schemas || schemas.length === 0) {
			// Check automations by display name or file path
			for (const automation of this.automations.values()) {
				if (
					(automation.displayName === extensionName || automation.filePath === extensionName) &&
					automation.settingsSchema &&
					automation.settingsSchema.length > 0
				) {
					const persisted = this.plugin.settings.user_extension_settings[extensionName] ?? {};
					return resolveSettings(automation.settingsSchema, extensionName, persisted, this.plugin.app);
				}
			}
			return { values: {}, missing: [] };
		}

		const persisted = this.plugin.settings.user_extension_settings[extensionName] ?? {};
		return resolveSettings(schemas, extensionName, persisted, this.plugin.app);
	}

	/**
	 * Resolve global shared settings (synchronous).
	 *
	 * Always reads from live `plugin.settings` reference — no caching.
	 */
	getResolvedSharedSettings(): { values: Record<string, unknown>; missing: string[] } {
		if (!this.sharedSettings || this.sharedSettings.settingsSchema.length === 0) {
			return { values: {}, missing: [] };
		}

		const persisted = this.plugin.settings.user_shared_settings ?? {};
		return resolveSharedSettings(this.sharedSettings.settingsSchema, persisted, this.plugin.app);
	}

	// -----------------------------------------------------------------------
	// Cached context objects
	// -----------------------------------------------------------------------

	/** Get or build the cached libs object. */
	getCachedLibs(): ExtensionLibs {
		if (!this.cachedLibsInstance) {
			this.cachedLibsInstance = buildLibs();
		}
		return this.cachedLibsInstance;
	}

	/** Get or build the cached obsidian exports. */
	getCachedObsidianExports(): ExtensionObsidianExports {
		if (!this.cachedObsidianInstance) {
			this.cachedObsidianInstance = buildObsidianExports();
		}
		return this.cachedObsidianInstance;
	}

	// -----------------------------------------------------------------------
	// Cleanup
	// -----------------------------------------------------------------------

	/** Destroy and clean up all registered user tools. */
	destroy(): void {
		const registry = this.plugin.getToolRegistry();
		for (const name of this.registeredToolNames) {
			registry.unregister(name);
			delete TOOL_PATH_PARAMS[name];
		}
		this.registeredToolNames.clear();
		this.tools.clear();
		this.automations.clear();
		this.sharedSettings = null;
		this.cachedLibsInstance = null;
		this.cachedObsidianInstance = null;
	}
}
