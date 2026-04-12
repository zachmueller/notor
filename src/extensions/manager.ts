/**
 * ExtensionManager — central orchestrator for user-defined extensions.
 *
 * Coordinates discovery, compilation, registration, settings resolution,
 * and reload lifecycle for user tools and automations.
 */

import { Notice, normalizePath } from "obsidian";
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
import { parseExtensionFile } from "./parser";
import { compileExtension } from "./compiler";
import { paramSchemaToJsonSchema } from "./param-schema";
import { resolveSettings, resolveSharedSettings } from "./settings-schema";
import { buildUtils, buildLibs, buildObsidianExports } from "./runtime-context";
import type { ExtensionUtils, ExtensionLibs, ExtensionObsidianExports } from "./runtime-context";
import { TOOL_PATH_PARAMS } from "../tool-config/path-enforcer";
import { BUILTIN_TOOL_SCAFFOLDS, BUILTIN_SHARED_SETTINGS_SCHEMA } from "./builtin-tool-scaffolds";
import { BUILTIN_AUTOMATION_SCAFFOLDS } from "./builtin-automation-scaffolds";
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

		// 1b. Inject scaffold fallbacks for missing built-in tools
		for (const [name, scaffold] of BUILTIN_TOOL_SCAFFOLDS) {
			// Skip if vault file was discovered with this name
			if (discovered.tools.some(t => t.name === name)) continue;

			// Construct frontmatter directly from scaffold metadata (no re-parsing)
			const frontmatter: Record<string, unknown> = {
				"notor-type": "tool",
				"notor-tool-name": scaffold.name,
				"notor-description": scaffold.description,
				"notor-mode": scaffold.mode,
			};
			const parsed = parseExtensionFile(
				scaffold.scaffoldContent,
				frontmatter,
				`(built-in scaffold: ${name})`,
				this.parseYAML,
			);
			if ("message" in parsed) {
				errors.push({ filePath: `(built-in scaffold: ${name})`, message: parsed.message });
				continue;
			}
			if ("name" in parsed && "mode" in parsed) {
				const toolDef = parsed as UserToolDefinition;
				toolDef.isScaffold = true;
				discovered.tools.push(toolDef);
			}
		}

		// 2. Compile tools
		const compiledTools = new Map<string, UserToolDefinition>();
		for (const tool of discovered.tools) {
			const result = compileExtension(tool.rawCode, "tool");
			if ("error" in result) {
				if (tool.isScaffold) {
					const msg = `CRITICAL: Built-in tool '${tool.name}' failed to load. The plugin may not function correctly.`;
					new Notice(msg);
					log.error(msg, { file: tool.filePath, error: result.error });
				} else {
					const msg = `Extension '${tool.name}' failed to compile: ${result.error}`;
					new Notice(msg);
					log.error(msg, { file: tool.filePath });
				}
				errors.push({ filePath: tool.filePath, message: result.error });
				continue;
			}
			tool.compiledFn = result.fn;
			compiledTools.set(tool.name, tool);
		}

		// 2b. Inject scaffold fallbacks for missing built-in automations
		for (const [name, scaffold] of BUILTIN_AUTOMATION_SCAFFOLDS) {
			// Skip if vault file was discovered with this name (same pattern as tools)
			const vaultPath = normalizePath(
				`${this.plugin.settings.notor_dir}/automations/${name}.md`,
			);
			if (discovered.automations.some(a => a.filePath === vaultPath)) continue;

			// Construct frontmatter directly from scaffold metadata (no re-parsing)
			const frontmatter: Record<string, unknown> = {
				"notor-type": "automation",
				"notor-trigger": scaffold.trigger,
				"notor-display-name": scaffold.displayName,
			};
			const parsed = parseExtensionFile(
				scaffold.scaffoldContent,
				frontmatter,
				`(built-in scaffold: ${name})`,
				this.parseYAML,
			);
			if ("message" in parsed) {
				errors.push({ filePath: `(built-in scaffold: ${name})`, message: parsed.message });
				continue;
			}
			if ("trigger" in parsed) {
				const automationDef = parsed as UserAutomationDefinition;
				automationDef.isScaffold = true;
				// Carry over code-side settingsSchema if the scaffold defines one
				if (scaffold.settingsSchema && !automationDef.settingsSchema?.length) {
					automationDef.settingsSchema = scaffold.settingsSchema;
				}
				discovered.automations.push(automationDef);
			}
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

		// 4. Shared settings — vault file wins; fall back to built-in scaffold (D-8)
		if (discovered.sharedSettings) {
			this.sharedSettings = discovered.sharedSettings;
		} else {
			this.sharedSettings = {
				filePath: "(built-in shared settings scaffold)",
				settingsSchema: [...BUILTIN_SHARED_SETTINGS_SCHEMA],
			};
		}

		// 5. Detect built-in overrides (vault files that replace scaffold defaults)
		const registry = this.plugin.getToolRegistry();
		for (const [toolName, tool] of compiledTools) {
			if (BUILTIN_TOOL_SCAFFOLDS.has(toolName) && !tool.isScaffold) {
				builtinOverrides.push(toolName);
			}
		}
		// Also detect automation overrides (vault files with same name as scaffold)
		for (const [, automation] of compiledAutomations) {
			if (automation.isScaffold) continue;
			const filename = automation.filePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
			if (BUILTIN_AUTOMATION_SCAFFOLDS.has(filename)) {
				builtinOverrides.push(filename);
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
			new Notice(`User extensions override built-ins: ${builtinOverrides.join(", ")}`);
		}

		const summary = `Extensions reloaded: ${toolCount} tool${toolCount !== 1 ? "s" : ""}, ${automationCount} automation${automationCount !== 1 ? "s" : ""}` +
			(errors.length > 0 ? ` (${errors.length} error${errors.length !== 1 ? "s" : ""})` : "");
		log.info(summary);

		return { toolCount, automationCount, builtinOverrides, errors };
	}

	// -----------------------------------------------------------------------
	// Tool accessors
	// -----------------------------------------------------------------------

	/** Get all compiled user tool definitions. */
	getTools(): UserToolDefinition[] {
		return Array.from(this.tools.values());
	}

	/** Get all compiled user automation definitions. */
	getAutomations(): UserAutomationDefinition[] {
		return Array.from(this.automations.values());
	}

	/** Get the shared settings definition (from `notor/settings.md`), or null. */
	getSharedSettingsDefinition(): SharedSettingsDefinition | null {
		return this.sharedSettings;
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
	// Automation execution
	// -----------------------------------------------------------------------

	/**
	 * Execute a single automation with the given context.
	 *
	 * Resolves settings, builds runtime context, and invokes the compiled function.
	 * Used as a callback by hook dispatch functions (EXT-013, EXT-014).
	 *
	 * @param automation - The automation definition to execute.
	 * @param context    - Event context passed as the `context` parameter to the automation.
	 * @returns The return value from the automation's compiled function.
	 */
	async executeAutomation(
		automation: UserAutomationDefinition,
		context: Record<string, unknown>,
	): Promise<unknown> {
		if (!automation.compiledFn) {
			throw new Error(`Automation '${automation.displayName ?? automation.filePath}' has no compiled function`);
		}

		// Check automation_enabled — keyed by filename (e.g., "title-generation")
		const filename = automation.filePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
		const defaultEnabled = filename === "title-generation" ? false : true;
		const isEnabled = this.plugin.settings.automation_enabled[filename] ?? defaultEnabled;
		if (!isEnabled) return;

		const extensionName = automation.displayName ?? automation.filePath;

		// Resolve per-extension settings (sync)
		const { values: settings, missing: missingSettings } = this.getResolvedSettings(extensionName);

		if (missingSettings.length > 0) {
			const msg = `Automation '${extensionName}' requires setting${missingSettings.length > 1 ? "s" : ""} '${missingSettings.join("', '")}' to be configured in Settings.`;
			new Notice(msg);
			log.warn(msg);
			return;
		}

		// Resolve shared settings (sync)
		const { values: shared } = this.getResolvedSharedSettings();

		// Build runtime context — pass conversationId so utils.conversationApi can bind
		const conversationId = typeof context.conversationId === "string" ? context.conversationId : undefined;
		const utils = buildUtils(this.plugin, conversationId);
		const libs = this.getCachedLibs();
		const obsidian = this.getCachedObsidianExports();

		return automation.compiledFn(
			this.plugin.app,
			obsidian,
			utils,
			libs,
			settings,
			shared,
			context,
		);
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
	// Built-in tool scaffolds
	// -----------------------------------------------------------------------

	/** Get all built-in tool names (for the settings UI). */
	getBuiltinToolNames(): string[] {
		return Array.from(BUILTIN_TOOL_SCAFFOLDS.keys());
	}

	/**
	 * Ensure a vault file exists for a built-in tool scaffold.
	 *
	 * Creates `{notor_dir}/tools/{toolName}.md` with the scaffold content
	 * if it doesn't already exist. Returns the vault-relative file path.
	 */
	async ensureBuiltinToolVaultFile(toolName: string): Promise<string> {
		const scaffold = BUILTIN_TOOL_SCAFFOLDS.get(toolName);
		if (!scaffold) {
			throw new Error(`No built-in scaffold for tool "${toolName}"`);
		}

		const dir = normalizePath(`${this.plugin.settings.notor_dir}/tools`);
		const filePath = normalizePath(`${dir}/${toolName}.md`);

		// If file already exists, return its path
		if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
			return filePath;
		}

		// Ensure directory exists
		const dirFile = this.plugin.app.vault.getAbstractFileByPath(dir);
		if (!dirFile) {
			await this.plugin.app.vault.createFolder(dir);
		}

		await this.plugin.app.vault.create(filePath, scaffold.scaffoldContent);
		log.info("Created built-in tool scaffold", { tool: toolName, path: filePath });
		return filePath;
	}

	/**
	 * Reset a built-in tool to its default scaffold by deleting the vault file.
	 *
	 * After deletion, the next `reload()` will inject the scaffold fallback.
	 */
	async resetBuiltinToolToDefault(toolName: string): Promise<void> {
		const scaffold = BUILTIN_TOOL_SCAFFOLDS.get(toolName);
		if (!scaffold) {
			throw new Error(`No built-in scaffold for tool "${toolName}"`);
		}

		const dir = normalizePath(`${this.plugin.settings.notor_dir}/tools`);
		const filePath = normalizePath(`${dir}/${toolName}.md`);

		const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (existing) {
			await this.plugin.app.vault.delete(existing);
		}
		log.info("Reset built-in tool to default scaffold", { tool: toolName, path: filePath });
	}

	// -----------------------------------------------------------------------
	// Built-in automation scaffold helpers
	// -----------------------------------------------------------------------

	/** Get the set of built-in automation scaffold names. */
	getBuiltinAutomationNames(): Set<string> {
		return new Set(BUILTIN_AUTOMATION_SCAFFOLDS.keys());
	}

	/**
	 * Ensure a vault file exists for a built-in automation scaffold.
	 *
	 * If the file doesn't exist, creates it with the scaffold content
	 * so the user can customize it. Returns the vault-relative path.
	 */
	async ensureBuiltinAutomationVaultFile(automationName: string): Promise<string> {
		const scaffold = BUILTIN_AUTOMATION_SCAFFOLDS.get(automationName);
		if (!scaffold) {
			throw new Error(`No built-in scaffold for automation "${automationName}"`);
		}

		const dir = normalizePath(`${this.plugin.settings.notor_dir}/automations`);
		const filePath = normalizePath(`${dir}/${automationName}.md`);

		// If file already exists, return its path
		if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
			return filePath;
		}

		// Ensure directory exists
		const dirFile = this.plugin.app.vault.getAbstractFileByPath(dir);
		if (!dirFile) {
			await this.plugin.app.vault.createFolder(dir);
		}

		await this.plugin.app.vault.create(filePath, scaffold.scaffoldContent);
		log.info("Created built-in automation scaffold", { automation: automationName, path: filePath });
		return filePath;
	}

	/**
	 * Reset a built-in automation to its default scaffold by deleting the vault file.
	 *
	 * After deletion, the next `reload()` will inject the scaffold fallback.
	 */
	async resetBuiltinAutomationToDefault(automationName: string): Promise<void> {
		const scaffold = BUILTIN_AUTOMATION_SCAFFOLDS.get(automationName);
		if (!scaffold) {
			throw new Error(`No built-in scaffold for automation "${automationName}"`);
		}

		const dir = normalizePath(`${this.plugin.settings.notor_dir}/automations`);
		const filePath = normalizePath(`${dir}/${automationName}.md`);

		const existing = this.plugin.app.vault.getAbstractFileByPath(filePath);
		if (existing) {
			await this.plugin.app.vault.delete(existing);
		}
		log.info("Reset built-in automation to default scaffold", { automation: automationName, path: filePath });
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
