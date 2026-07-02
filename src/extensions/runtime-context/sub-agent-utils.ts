import type { BuilderContext, ExtensionUtils } from "./types";
import type { SubAgentResult } from "../../chat/sub-agent-runner";
import { SubAgentRunner } from "../../chat/sub-agent-runner";
import { ToolDispatcher } from "../../chat/dispatcher";
import { intersectToolConfig } from "../../tool-config/merger";
import { SUB_AGENT_PREAMBLE } from "../../sub-agents/preamble";
import { SUB_AGENT_ITERATION_CAP, SUB_AGENT_TOKEN_LIMIT } from "../../sub-agents/constants";
import { resolvePreset } from "../../presets/preset-resolver";
import { resolveNote } from "../../utils/resolve-note";
import { logger } from "../../utils/logger";

export function buildSubAgentUtils(ctx: BuilderContext): Pick<ExtensionUtils, "runSubAgent"> {
	const { plugin } = ctx;
	const rsaLog = logger("ext:runSubAgent");
	let depth = 0;

	return {
		runSubAgent: async (opts: {
			profileName: string;
			task: string;
			detached?: boolean;
			silent?: boolean;
			onComplete?: (result: SubAgentResult) => Promise<void> | void;
			iterationCap?: number;
			timeout?: number;
		}): Promise<SubAgentResult | null> => {
			if (depth >= 1) {
				rsaLog.warn("runSubAgent depth limit exceeded (max 1)");
				return null;
			}

			const subAgentManager = plugin.getSubAgentManager();
			const toolRegistry = plugin.getToolRegistry();
			const profile = await subAgentManager.getProfile(
				opts.profileName,
				toolRegistry.getNames(),
			);
			if (!profile) {
				rsaLog.warn("runSubAgent: profile not found", { profileName: opts.profileName });
				return null;
			}

			const providerRegistry = plugin.getProviderRegistry();
			let providerId: string;
			let model: string;
			let provider;

			const resolvedPreset = profile.preferred_preset
				? resolvePreset(profile.preferred_preset, plugin.settings.model_presets)
				: null;

			if (resolvedPreset) {
				providerId = resolvedPreset.providerId;
				model = resolvedPreset.modelId;
			} else {
				if (profile.preferred_preset) {
					rsaLog.warn("runSubAgent: preset not found, falling back", {
						profile: opts.profileName,
						preset: profile.preferred_preset,
					});
				}
				providerId = profile.preferred_provider
					? profile.preferred_provider
					: providerRegistry.getActiveType();
				const providerConfig = providerRegistry.getConfig(providerId);
				model = profile.preferred_model ?? providerConfig?.model_id ?? "";
			}

			try {
				provider = providerRegistry.getProvider(providerId);
			} catch {
				rsaLog.warn("runSubAgent: provider not configured", { provider: providerId, profile: opts.profileName });
				return null;
			}
			if (!model) {
				rsaLog.warn("runSubAgent: no model resolved", { profile: opts.profileName });
				return null;
			}

			const orchestrator = plugin.getActiveOrchestrator?.();
			const parentEffectiveConfig = orchestrator?.getEffectiveToolConfig() ?? (() => {
				const tools: import("../../tool-config/types").EffectiveToolConfig["tools"] = {};
				for (const name of toolRegistry.getNames()) {
					tools[name] = {
						enabled: true,
						auto_approve: plugin.settings.auto_approve[name] ?? false,
						allowed_paths: [],
						blocked_paths: [],
						allowed_command_patterns: [],
						blocked_command_patterns: [],
					};
				}
				return { tools };
			})();

			const mergedSubAgentConfig: import("../../tool-config/types").ParsedToolConfig = {
				source: "subagent",
				sourceFile: profile.system_prompt_path,
				documentPosition: 0,
				tools: {},
			};
			for (const config of profile.tool_configs) {
				Object.assign(mergedSubAgentConfig.tools, config.tools);
			}

			const toolModes: Record<string, "read" | "write"> = {};
			for (const tool of toolRegistry.getAll()) {
				toolModes[tool.name] = tool.mode;
			}
			const intersectedConfig = intersectToolConfig(parentEffectiveConfig, mergedSubAgentConfig, toolModes);

			const enabledToolNames = Object.entries(intersectedConfig.tools)
				.filter(([, entry]) => entry.enabled)
				.map(([name]) => name);

			const subDispatcher = new ToolDispatcher();
			for (const name of enabledToolNames) {
				const tool = toolRegistry.get(name);
				if (tool) subDispatcher.registerTool(tool);
			}
			subDispatcher.setEffectiveToolConfig(intersectedConfig);
			subDispatcher.setSettings(plugin.settings);
			if (plugin.vaultRootPath) {
				subDispatcher.setVaultRootPath(plugin.vaultRootPath);
			}
			subDispatcher.setResolveVaultPath((path: string) => {
				const file = resolveNote(path, plugin.app.vault, plugin.app.metadataCache);
				return file?.path ?? null;
			});
			if (opts.silent) {
				subDispatcher.setSilentMode(true);
			}

			const toolDefinitions: import("../../providers/provider").ToolDefinition[] = enabledToolNames
				.map(name => toolRegistry.get(name))
				.filter((t): t is NonNullable<typeof t> => t !== undefined)
				.map(t => ({
					name: t.name,
					description: t.description,
					input_schema: t.input_schema as import("../../providers/provider").ToolDefinition["input_schema"],
					mode: t.mode,
				}));

			const systemPrompt = SUB_AGENT_PREAMBLE + "\n" + profile.prompt_content;

			const controller = new AbortController();

			const timeoutMs = opts.timeout ?? 60000;
			let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

			const runAndCleanup = async (): Promise<SubAgentResult> => {
				const runner = new SubAgentRunner({
					provider,
					model,
					systemPrompt,
					toolDefinitions,
					dispatcher: subDispatcher,
					parentAbortSignal: controller.signal,
					iterationCap: opts.iterationCap ?? profile.iteration_cap ?? plugin.settings.sub_agent_iteration_cap ?? SUB_AGENT_ITERATION_CAP,
					tokenLimit: SUB_AGENT_TOKEN_LIMIT,
					mode: "act",
					// F2: gate this sub-agent's tool calls through the pure policy engine
					// (command patterns / paths / plan-mode / denylist), built from the
					// intersected effective config. domainDenylist comes from the tool's
					// settings reference (no settings are threaded into RunLoop).
					policyCtx: {
						effectiveConfig: intersectedConfig,
						mode: "act",
						domainDenylist: plugin.settings.domain_denylist,
						vaultRootPath: plugin.vaultRootPath ?? "",
						resolveVaultPath: (path: string) => {
							const file = resolveNote(path, plugin.app.vault, plugin.app.metadataCache);
							return file?.path ?? null;
						},
					},
				});

				depth++;
				timeoutHandle = setTimeout(() => {
					rsaLog.warn("runSubAgent: timeout reached", { profile: opts.profileName, timeoutMs });
					controller.abort();
				}, timeoutMs);

				try {
					return await runner.run(opts.task);
				} finally {
					depth--;
					if (timeoutHandle !== null) {
						clearTimeout(timeoutHandle);
						timeoutHandle = null;
					}
				}
			};

			if (opts.detached) {
				plugin.registerDetachedSubAgent(controller);

				void (async () => {
					try {
						const result = await runAndCleanup();
						rsaLog.debug("runSubAgent detached: complete", { profile: opts.profileName });
						if (opts.onComplete) {
							try {
								await opts.onComplete(result);
							} catch (e) {
								rsaLog.error("runSubAgent detached: onComplete threw", { profile: opts.profileName, error: String(e) });
							}
						}
					} catch (e) {
						rsaLog.error("runSubAgent detached: runner threw", { profile: opts.profileName, error: String(e) });
					} finally {
						plugin.unregisterDetachedSubAgent(controller);
					}
				})();

				return null;
			}

			try {
				const result = await runAndCleanup();
				rsaLog.debug("runSubAgent: complete", { profile: opts.profileName, stopReason: result.stopReason });
				if (opts.onComplete) {
					try {
						await opts.onComplete(result);
					} catch (e) {
						rsaLog.error("runSubAgent: onComplete threw", { profile: opts.profileName, error: String(e) });
					}
				}
				return result;
			} catch (e) {
				rsaLog.error("runSubAgent: runner threw", { profile: opts.profileName, error: String(e) });
				return null;
			}
		},
	};
}
