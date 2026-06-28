/**
 * use_subagent tool — spawns a focused sub-agent to perform a specific task.
 *
 * The LLM invokes this tool with a profile name and task description.
 * The tool spins up an isolated `SubAgentRunner` conversation loop and
 * returns the final text result.
 *
 * @see specs/ZZ-misc/sub-agents-design.md — Sections 2.1, 8, 9.5
 * @see specs/ZZ-misc/sub-agents-implementation-plan.md — Phase 5.3
 */

import { Notice } from "obsidian";
import type { Tool, JSONSchema, ToolExecuteOptions, ToolResult } from "./tool";
import type { ToolDefinition as ProviderToolDefinition } from "../providers/provider";
import type { SubAgentManager } from "../sub-agents/manager";
import type { SubAgentProfile } from "../sub-agents/types";
import type { ProviderRegistry } from "../providers/index";
import type { ToolRegistry } from "./index";
import type { NotorSettings } from "../settings/types";
import type { EffectiveToolConfig } from "../tool-config/types";
import type { ParsedToolConfig } from "../tool-config/types";
import type { ApprovalCallback } from "../chat/dispatcher";
import type { Conversation } from "../types";
import type { HistoryManager } from "../chat/history";
import { ToolDispatcher } from "../chat/dispatcher";
import { SubAgentRunner } from "../chat/sub-agent-runner";
import { intersectToolConfig } from "../tool-config/merger";
import { SUB_AGENT_PREAMBLE } from "../sub-agents/preamble";
import { ASK_USER } from "../extensions/builtin-tool-scaffolds/ask-user";
import {
	USE_SUBAGENT_TOOL_NAME,
	SUB_AGENT_ITERATION_CAP,
	SUB_AGENT_TOKEN_LIMIT,
} from "../sub-agents/constants";
import { Semaphore } from "../sub-agents/semaphore";
import {
	generateSubAgentFilename,
	chatMessagesToMessages,
} from "../chat/sub-agent-history";
import { resolvePreset } from "../presets/preset-resolver";
import { logger } from "../utils/logger";

const log = logger("UseSubagentTool");

/**
 * Tool that spawns focused sub-agent conversations.
 *
 * Implements the `Tool` interface with dynamic `description` and
 * `input_schema` getters that reflect the currently visible sub-agent
 * profiles.
 */
export class UseSubagentTool implements Tool {
	readonly name = USE_SUBAGENT_TOOL_NAME;
	readonly mode = "read" as const;

	private cachedVisibleProfiles: SubAgentProfile[] = [];
	private readonly semaphore: Semaphore;

	/**
	 * Defense-in-depth flag (Section 3.3). Should never be `true` in normal
	 * operation because `filterSubAgentTools()` removes this tool from
	 * sub-agent tool lists.
	 */
	_isSubAgentContext = false;

	/** Vault root path for sub-agent dispatcher path enforcement. */
	private vaultRootPath?: string;

	/** Optional resolver for vault note paths (used by path enforcement). */
	private resolveVaultPath?: (path: string) => string | null;

	/** Parent's approval callback for the "bubble" pattern (Section 9.7). */
	private parentApprovalCallback?: ApprovalCallback;

	constructor(
		private readonly subAgentManager: SubAgentManager,
		private readonly providerRegistry: ProviderRegistry,
		private readonly toolRegistry: ToolRegistry,
		private readonly settings: NotorSettings,
		private readonly getParentEffectiveConfig: () => EffectiveToolConfig | null,
		private readonly historyManager?: HistoryManager,
		private readonly getParentConversation?: () => Conversation | null,
	) {
		this.semaphore = new Semaphore(
			settings.sub_agent_concurrency_cap ?? 3,
		);
	}

	// -----------------------------------------------------------------------
	// Public setters (called after construction from main.ts)
	// -----------------------------------------------------------------------

	setVaultRootPath(path: string): void {
		this.vaultRootPath = path;
	}

	setResolveVaultPath(fn: (path: string) => string | null): void {
		this.resolveVaultPath = fn;
	}

	setApprovalCallback(callback: ApprovalCallback): void {
		this.parentApprovalCallback = callback;
	}

	// -----------------------------------------------------------------------
	// Dynamic description & schema (Section 8)
	// -----------------------------------------------------------------------

	/**
	 * Dynamic description that includes the list of visible sub-agent profiles.
	 * Rebuilt on each access from the cached profile list.
	 */
	get description(): string {
		const base = "Spawn a focused sub-agent to perform a specific task. Available profiles:\n";
		if (this.cachedVisibleProfiles.length === 0) {
			return base + "(no profiles available)";
		}
		const profileLines = this.cachedVisibleProfiles
			.filter((p) => p.description !== null)
			.map((p) => `- ${p.name}: ${p.description}`);
		return base + profileLines.join("\n");
	}

	/**
	 * Dynamic input schema with an `enum` constraint on profile names.
	 */
	get input_schema(): JSONSchema {
		return {
			type: "object",
			properties: {
				profile: {
					type: "string",
					description: "Name of the sub-agent profile to use.",
					enum: this.cachedVisibleProfiles.map((p) => p.name),
				},
				task: {
					type: "string",
					description: "The specific task or question for the sub-agent to complete.",
				},
			},
			required: ["profile", "task"],
		};
	}

	// -----------------------------------------------------------------------
	// Profile cache management (5.3c)
	// -----------------------------------------------------------------------

	/**
	 * Refresh the cached list of visible profiles from the manager.
	 *
	 * Called:
	 * - Once at registration time (fire-and-forget from main.ts)
	 * - At the start of each `execute()` invocation (hot-reload)
	 * - When settings change (visibility toggle) — wired in Phase 7
	 */
	async refreshVisibleProfiles(): Promise<void> {
		try {
			this.cachedVisibleProfiles = await this.subAgentManager.getVisibleProfiles(
				this.toolRegistry.getNames(),
			);
		} catch (e) {
			log.warn("Failed to refresh visible profiles", { error: String(e) });
		}
	}

	// -----------------------------------------------------------------------
	// Execute (5.3d — 10-step pipeline)
	// -----------------------------------------------------------------------

	async execute(
		params: Record<string, unknown>,
		options?: ToolExecuteOptions,
	): Promise<ToolResult> {
		// Step 1: Refresh profiles & validate
		await this.refreshVisibleProfiles();

		const profileName = params["profile"] as string;
		const task = params["task"] as string;

		const profile = this.cachedVisibleProfiles.find((p) => p.name === profileName);
		if (!profile) {
			return {
				tool_name: USE_SUBAGENT_TOOL_NAME,
				success: false,
				result: "",
				error: `Sub-agent profile '${profileName}' not found or is disabled.`,
			};
		}

		// Defense-in-depth: isVisible check
		if (!this.subAgentManager.isVisible(profile.name)) {
			return {
				tool_name: USE_SUBAGENT_TOOL_NAME,
				success: false,
				result: "",
				error: `Sub-agent profile '${profileName}' is disabled.`,
			};
		}

		// Step 2: Depth gate (ARCH-004) — replaces the binary `_isSubAgentContext`
		// recursion ban with the cascading depth model on RunContext.
		//
		// A child run may spawn iff `depth < maxDepth`. Sub-agents are seeded
		// `maxDepth = 0` (ARCH-003), so a nested `use_subagent` runs at `depth = 0`
		// and fails `0 < 0` → rejected exactly as the old ban did. When no
		// runContext is threaded (ordinary foreground chat invoking use_subagent at
		// top level), there is no depth constraint and the call proceeds as today.
		// The rejection is a clear error ToolResult (success:false), never a throw.
		const runContext = options?.runContext;
		if (runContext && runContext.depth >= runContext.maxDepth) {
			return {
				tool_name: USE_SUBAGENT_TOOL_NAME,
				success: false,
				result: "",
				error: "use_subagent cannot be called from within a sub-agent.",
			};
		}

		// Defense-in-depth (retired flag): the depth gate above is the enforcement
		// path, but `_isSubAgentContext` is retained for back-compat so any caller
		// still setting it keeps the historical rejection behavior.
		if (this._isSubAgentContext) {
			return {
				tool_name: USE_SUBAGENT_TOOL_NAME,
				success: false,
				result: "",
				error: "use_subagent cannot be called from within a sub-agent.",
			};
		}

		// Step 3: Acquire semaphore slot
		await this.semaphore.acquire();
		try {
			return await this.executeInner(profile, task, options);
		} finally {
			this.semaphore.release();
		}
	}

	// -----------------------------------------------------------------------
	// Inner execution (Steps 4–10)
	// -----------------------------------------------------------------------

	private async executeInner(
		profile: SubAgentProfile,
		task: string,
		options?: ToolExecuteOptions,
	): Promise<ToolResult> {
		// Step 4: Resolve provider and model (preset takes precedence)
		let provider;
		let providerId: string;
		let model: string;

		const resolvedPreset = profile.preferred_preset
			? resolvePreset(profile.preferred_preset, this.settings.model_presets)
			: null;

		if (resolvedPreset) {
			providerId = resolvedPreset.providerId;
			try {
				provider = this.providerRegistry.getProvider(providerId);
			} catch {
				return {
					tool_name: USE_SUBAGENT_TOOL_NAME,
					success: false,
					result: "",
					error: `Provider '${providerId}' (from preset '${profile.preferred_preset}') is not configured for sub-agent '${profile.name}'.`,
				};
			}
			model = resolvedPreset.modelId;
		} else if (profile.preferred_provider) {
			if (profile.preferred_preset) {
				log.warn("Preset not found, falling back to preferred_provider/preferred_model", {
					profile: profile.name,
					preset: profile.preferred_preset,
				});
			}
			providerId = profile.preferred_provider;
			try {
				provider = this.providerRegistry.getProvider(providerId);
			} catch {
				return {
					tool_name: USE_SUBAGENT_TOOL_NAME,
					success: false,
					result: "",
					error: `Provider '${providerId}' is not configured for sub-agent '${profile.name}'.`,
				};
			}
			const providerConfig = this.providerRegistry.getConfig(providerId);
			model = profile.preferred_model ?? providerConfig?.model_id ?? "";
		} else {
			providerId = this.providerRegistry.getActiveType();
			provider = this.providerRegistry.getActiveProvider();
			const providerConfig = this.providerRegistry.getConfig(providerId);
			model = profile.preferred_model ?? providerConfig?.model_id ?? "";
		}
		if (!model) {
			return {
				tool_name: USE_SUBAGENT_TOOL_NAME,
				success: false,
				result: "",
				error: `No model ID could be resolved for sub-agent '${profile.name}'. Configure a model in the provider settings or set notor-preferred-model in the profile.`,
			};
		}

		// Step 5: Build sub-agent's effective tool config
		// Prefer sessionContext (A4.4d) for correct per-orchestrator state;
		// fall back to closure-based accessors for non-session contexts.
		const parentConfig = options?.sessionContext?.getEffectiveToolConfig()
			?? this.getParentEffectiveConfig();
		const effectiveParent = parentConfig ?? this.buildPermissiveDefault();

		// Merge the profile's tool_configs array into a single ParsedToolConfig
		const mergedSubAgentConfig: ParsedToolConfig = {
			source: "subagent",
			sourceFile: profile.system_prompt_path,
			documentPosition: 0,
			tools: {},
		};
		for (const config of profile.tool_configs) {
			Object.assign(mergedSubAgentConfig.tools, config.tools);
		}

		// Build toolModes map
		const toolModes: Record<string, "read" | "write"> = {};
		for (const tool of this.toolRegistry.getAll()) {
			toolModes[tool.name] = tool.mode;
		}

		const intersectedConfig = intersectToolConfig(
			effectiveParent,
			mergedSubAgentConfig,
			toolModes,
		);

		// Step 6: Configuration gap detection
		const gaps: string[] = [];
		for (const [toolName, subEntry] of Object.entries(mergedSubAgentConfig.tools)) {
			if (subEntry.enabled !== false) {
				const intersected = intersectedConfig.tools[toolName];
				if (!intersected || !intersected.enabled) {
					gaps.push(toolName);
				}
			}
		}
		if (gaps.length > 0) {
			const gapList = gaps.join(", ");
			new Notice(
				`Sub-agent '${profile.name}': tools [${gapList}] are enabled in the profile but disabled in the current context.`,
			);
			log.warn("Sub-agent configuration gap", {
				profile: profile.name,
				disabledByParent: gaps,
			});
		}

		// Step 7: Build sub-agent tool definitions and dispatcher.
		// ask_user is excluded: sub-agents have no UI surface, so its interaction
		// channel can't be wired — offering it would only let the model call a
		// tool that errors out. Filter it from both the tool defs the model sees
		// and the sub-dispatcher so it can't be dispatched even if hallucinated.
		const enabledToolNames = Object.entries(intersectedConfig.tools)
			.filter(([, entry]) => entry.enabled)
			.map(([name]) => name)
			.filter((name) => name !== ASK_USER.name);

		const toolDefs: ProviderToolDefinition[] = enabledToolNames
			.map((name) => this.toolRegistry.get(name))
			.filter((t): t is Tool => t !== undefined)
			.map((t) => ({
				name: t.name,
				description: t.description,
				input_schema: t.input_schema as unknown as ProviderToolDefinition["input_schema"],
				mode: t.mode,
			}));

		const subDispatcher = new ToolDispatcher();
		for (const name of enabledToolNames) {
			const tool = this.toolRegistry.get(name);
			if (tool) subDispatcher.registerTool(tool);
		}
		subDispatcher.setEffectiveToolConfig(intersectedConfig);
		subDispatcher.setSettings(this.settings);
		if (this.vaultRootPath) {
			subDispatcher.setVaultRootPath(this.vaultRootPath);
		}
		if (this.resolveVaultPath) {
			subDispatcher.setResolveVaultPath(this.resolveVaultPath);
		}
		if (this.parentApprovalCallback) {
			subDispatcher.setApprovalCallback(this.parentApprovalCallback);
		}

		// Step 8: Assemble system prompt
		const systemPrompt = SUB_AGENT_PREAMBLE + "\n" + profile.prompt_content;

		// Step 9: Construct and run SubAgentRunner
		const abortSignal = options?.abortSignal;
		const mode = options?.mode ?? "act";
		const parentSignal = abortSignal ?? new AbortController().signal;

		const runner = new SubAgentRunner({
			provider,
			model,
			systemPrompt,
			toolDefinitions: toolDefs,
			dispatcher: subDispatcher,
			parentAbortSignal: parentSignal,
			iterationCap: profile.iteration_cap ?? this.settings.sub_agent_iteration_cap ?? SUB_AGENT_ITERATION_CAP,
			tokenLimit: this.settings.sub_agent_token_limit ?? SUB_AGENT_TOKEN_LIMIT,
			mode,
			onProgress: options?.onProgress,
			// When this sub-agent was itself dispatched from inside a run tree (a
			// flow at maxDepth ≥ 1), inherit the parent's shared budget cell and
			// depth. Absent (foreground chat), the runner seeds a fresh root context.
			parentRunContext: options?.runContext,
		});

		const result = await runner.run(task);

		// Step 10: Write sub-agent JSONL and return ToolResult with metadata
		log.info("Sub-agent completed", {
			profile: profile.name,
			iterations: result.iterationCount,
			stopReason: result.stopReason,
			tokenUsage: result.tokenUsage,
		});

		// Phase 6.1: Persist sub-agent conversation to its own JSONL file
		let jsonlFilename: string | null = null;
		// Prefer sessionContext (A4.4d) for correct per-orchestrator conversation;
		// fall back to closure-based accessor for non-session contexts.
		const parentConversation = options?.sessionContext?.getActiveConversation()
			?? this.getParentConversation?.();
		if (this.historyManager && parentConversation) {
			try {
				const invocationId = crypto.randomUUID();
				jsonlFilename = generateSubAgentFilename(
					parentConversation.created_at,
					parentConversation.id,
					invocationId,
				);

				const subAgentConversationId = crypto.randomUUID();
				const persistedMessages = chatMessagesToMessages(
					result.messages,
					subAgentConversationId,
				);

				await this.historyManager.writeSubAgentConversation(
					jsonlFilename,
					{
						id: subAgentConversationId,
						parent_conversation_id: parentConversation.id,
						sub_agent_name: profile.name,
						provider_id: providerId,
						model_id: model,
						total_input_tokens: result.tokenUsage.input,
						total_output_tokens: result.tokenUsage.output,
						iteration_count: result.iterationCount,
						stop_reason: result.stopReason,
						created_at: new Date().toISOString(),
					},
					persistedMessages,
				);
			} catch (e) {
				log.warn("Failed to write sub-agent history", {
					profile: profile.name,
					error: String(e),
				});
				// Non-fatal: sub-agent result is still returned to the parent
			}
		}

		return {
			tool_name: USE_SUBAGENT_TOOL_NAME,
			success: true,
			result: result.text,
			// INT-047: the shared child_run_metadata block (single-run totals for a
			// sub-agent). `name` is the generalized label; `profile_name` is retained
			// as the legacy alias so already-persisted readers still resolve it.
			child_run_metadata: jsonlFilename ? {
				jsonl_filename: jsonlFilename,
				token_usage: result.tokenUsage,
				iteration_count: result.iterationCount,
				depth: options?.runContext?.depth ?? 0,
				stop_reason: result.stopReason,
				name: profile.name,
				profile_name: profile.name,
			} : null,
		};
	}

	// -----------------------------------------------------------------------
	// Helpers
	// -----------------------------------------------------------------------

	/**
	 * Build a permissive default config when the parent has no effective config.
	 * All registered tools enabled with defaults.
	 */
	private buildPermissiveDefault(): EffectiveToolConfig {
		const tools: EffectiveToolConfig["tools"] = {};
		for (const name of this.toolRegistry.getNames()) {
			tools[name] = {
				enabled: true,
				auto_approve: this.settings.auto_approve[name] ?? false,
				allowed_paths: [],
				blocked_paths: [],
				allowed_command_patterns: [],
				blocked_command_patterns: [],
			};
		}
		return { tools };
	}
}
