/**
 * Config resolver — resolves effective tool configuration from all sources.
 *
 * Extracted from `ChatOrchestrator` (Phase B4). Owns the display-facing
 * config fields (`effectiveToolConfig`, `activeParsedConfigs`) and the
 * tool definitions callback.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B4
 */

import type { Persona, VaultRule, WorkflowAssemblyResult } from "../types";
import type { ToolDefinition } from "../providers/provider";
import type { SystemPromptBuilder } from "./system-prompt";
import type { ToolDispatcher } from "./dispatcher";
import type { NotorSettings } from "../settings";
import type { EffectiveToolConfig, ParsedToolConfig } from "../tool-config/types";
import { mergeToolConfigs } from "../tool-config/merger";
import { logger } from "../utils/logger";

const log = logger("ConfigResolver");

export class ConfigResolver {
	private activeParsedConfigs: ParsedToolConfig[] = [];
	private effectiveToolConfig: EffectiveToolConfig | null = null;
	private getToolDefinitionsCallback?: (config?: EffectiveToolConfig) => ToolDefinition[];

	constructor(
		private settings: NotorSettings,
		private readonly systemPromptBuilder: SystemPromptBuilder,
		private readonly dispatcher: ToolDispatcher,
	) {}

	/**
	 * Resolve the effective tool config for the current iteration.
	 *
	 * Accepts all variable inputs as parameters and returns a structured
	 * result without mutating any external state.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-001
	 * @see specs/ZZ-misc/thread-safe-streaming-multi-panel-design.md — Step 1b
	 */
	async resolveEffectiveConfig(
		matchedRules?: VaultRule[],
		workflowAssembly?: WorkflowAssemblyResult | null,
		activePersona?: Persona | null,
	): Promise<{
		effective: EffectiveToolConfig;
		toolDefinitions: ToolDefinition[];
		parsedConfigs: ParsedToolConfig[];
	}> {
		// Phase 1: Extract tool configs from persona and rules
		const { personaToolConfigs, ruleToolConfigs } =
			await this.systemPromptBuilder.extractSourceToolConfigs(matchedRules, activePersona ?? null);

		// Collect workflow tool configs from assembly parameter
		const workflowToolConfigs = workflowAssembly?.toolConfigs ?? [];

		// Collect all parsed configs
		const allConfigs: ParsedToolConfig[] = [
			...ruleToolConfigs,
			...personaToolConfigs,
			...workflowToolConfigs,
		];

		// Build globalAutoApprove and globalEnabled per-iteration from current settings
		const globalAutoApprove: Record<string, boolean> = {
			...this.settings.auto_approve,
		};
		const globalEnabled: Record<string, boolean> = {
			...this.settings.tool_enabled,
		};

		// Expand MCP server-level autoApprove[] into namespaced keys
		if (this.settings.mcp_servers) {
			for (const [serverName, serverConfig] of Object.entries(this.settings.mcp_servers)) {
				if (serverConfig.disabled) continue;
				if (serverConfig.autoApprove) {
					for (const rawToolName of serverConfig.autoApprove) {
						globalAutoApprove[`${serverName}__${rawToolName}`] = true;
					}
				}
			}
		}

		// Get all registered tool names for default fill
		const allToolNames = this.dispatcher.getRegisteredToolNames();

		// Merge all configs
		const effective = mergeToolConfigs(allConfigs, globalAutoApprove, allToolNames, globalEnabled);

		// Compute filtered tool definitions
		const toolDefinitions = this.getToolDefinitionsCallback?.(effective) ?? [];

		log.debug("Effective tool config resolved", {
			totalConfigs: allConfigs.length,
			enabledTools: toolDefinitions.length,
			totalTools: allToolNames.length,
		});

		return { effective, toolDefinitions, parsedConfigs: allConfigs };
	}

	/**
	 * Update the display-facing config fields for the inspector.
	 *
	 * Called when the displayed conversation's config changes (either from
	 * a session's resolveEffectiveConfig result or on conversation switch).
	 */
	updateDisplayConfig(effective: EffectiveToolConfig, parsedConfigs: ParsedToolConfig[]): void {
		this.activeParsedConfigs = parsedConfigs;
		this.effectiveToolConfig = effective;
		this.dispatcher.setEffectiveToolConfig(effective);
	}

	/**
	 * Get the current effective tool config (for the inspector view).
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-004
	 */
	getEffectiveToolConfig(): EffectiveToolConfig | null {
		return this.effectiveToolConfig;
	}

	/**
	 * Get the parsed tool configs contributing to the current effective config.
	 *
	 * @see specs/04b-tool-toggle/tasks.md — ORCH-004
	 */
	getActiveParsedConfigs(): ParsedToolConfig[] {
		return this.activeParsedConfigs;
	}

	/**
	 * Set the callback that provides tool definitions for the response loop.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-015
	 * @see specs/04b-tool-toggle/tasks.md — MAIN-001
	 */
	setGetToolDefinitions(callback: (config?: EffectiveToolConfig) => ToolDefinition[]): void {
		this.getToolDefinitionsCallback = callback;
	}

	/** Update the settings reference (called when plugin settings change). */
	updateSettings(settings: NotorSettings): void {
		this.settings = settings;
	}
}
