/**
 * Orchestration launch wiring (FEAT-011).
 *
 * Builds a fully-wired {@link OrchestrationRunner} from the plugin's chat stack
 * and exposes:
 *  - {@link launchOrchestration} — resolve/parse a flow + run it to a terminal
 *    event (used by the command and by the `run_orchestration` hook, FEAT-012);
 *  - {@link showOrchestrationPicker} — the `FuzzySuggestModal` flow picker +
 *    objective prompt the "Notor: Run Orchestration" command opens.
 *
 * The real {@link StepRuntimeFactory} composes the persona-pinned system prompt
 * and a per-step `ToolDispatcher` via the existing `ConfigResolver` /
 * `SystemPromptBuilder` — no reimplementation of system-prompt assembly. The
 * resolved provider/model comes from the pure `resolvePersonaProviderConfig(...)`
 * pinned by `StepTurnExecutor`, so concurrent step turns never race on the global
 * registry.
 *
 * @see specs/ZZ-misc/orchestration/tasks/phase-1-engine.md — FEAT-011
 */

import { FuzzySuggestModal, Modal, Notice, ButtonComponent, normalizePath } from "obsidian";
import type { App } from "obsidian";
import type NotorPlugin from "../main";
import { ToolDispatcher } from "../chat/dispatcher";
import { ConfigResolver } from "../chat/config-resolver";
import type { ConversationMode } from "../types";
import type { ToolDefinition } from "../providers/provider";
import type { EffectiveToolConfig } from "../tool-config/types";
import type { Tool } from "../tools/tool";
import type { OrchestrationToolContext } from "../run-loop/types";
import { resolveNote } from "../utils/resolve-note";
import { resolveIncludeNotes } from "../include-note/resolver";
import { logger } from "../utils/logger";
import { FlowDefinitionParser } from "./flow-parser";
import { StepPromptBuilder } from "./step-prompt-builder";
import { StepTurnExecutor, type StepRuntime, type StepRuntimeFactory } from "./step-turn-executor";
import { SessionLog, type SessionLogWriter } from "./session-log";
import { OrchestrationRunner, type OrchestrationRunResult } from "./runner";
import type { OrchestrationFlow } from "./types";

const log = logger("OrchestrationLaunch");

/** Generate a short session id. */
function newSessionId(): string {
	return `sess-${crypto.randomUUID().slice(0, 12)}`;
}

/** Vault-relative path to a session directory. */
function sessionDir(notorDir: string, sessionId: string): string {
	return normalizePath(`${notorDir.replace(/\/$/, "")}/orchestrations/sessions/${sessionId}`);
}

/** A {@link SessionLogWriter} backed by Obsidian's append-only adapter. */
class VaultSessionLogWriter implements SessionLogWriter {
	constructor(private readonly app: App) {}

	async append(path: string, data: string): Promise<void> {
		const dir = path.slice(0, path.lastIndexOf("/"));
		// Ensure the session directory exists before the first append.
		if (dir && !(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.adapter.mkdir(dir);
		}
		await this.app.vault.adapter.append(path, data);
	}
}

/**
 * Build the real per-step {@link StepRuntimeFactory} from the plugin. Each call
 * to `build` composes the persona system prompt + filtered tool definitions +
 * a per-step dispatcher (with the orchestration session context bound via the
 * dispatcher's session-context seam).
 */
function makeRuntimeFactory(plugin: NotorPlugin): StepRuntimeFactory {
	return {
		async build({ step, persona, resolved, orchestrationContext }): Promise<StepRuntime> {
			const settings = plugin.settings;
			const registry = plugin.getToolRegistry();

			// A fresh per-step dispatcher (mirrors the sub-agent dispatcher pattern),
			// so concurrent step turns don't share mutable dispatcher state.
			const dispatcher = new ToolDispatcher();
			for (const tool of registry.getAll()) {
				dispatcher.registerTool(tool);
			}
			dispatcher.setSettings(settings);
			dispatcher.setActivePersonaName(persona?.name ?? null);
			if (plugin.vaultRootPath) dispatcher.setVaultRootPath(plugin.vaultRootPath);
			dispatcher.setResolveVaultPath((p: string) => {
				const file = resolveNote(p, plugin.app.vault, plugin.app.metadataCache);
				return file?.path ?? null;
			});

			// Filtered tool definitions via the shared ConfigResolver path.
			const configResolver = new ConfigResolver(
				settings,
				plugin.getSystemPromptBuilder(),
				dispatcher,
			);
			configResolver.setGetToolDefinitions((effective?: EffectiveToolConfig) =>
				buildToolDefinitions(registry.getAll(), effective),
			);
			const { effective, toolDefinitions } = await configResolver.resolveEffectiveConfig(
				undefined,
				null,
				persona,
			);
			dispatcher.setEffectiveToolConfig(effective);

			// Persona-composed system prompt (append/replace per the persona's mode).
			const systemPrompt = await plugin
				.getSystemPromptBuilder()
				.assemble(
					plugin.settings.mode,
					toolDefinitions,
					undefined,
					undefined,
					persona,
					settings.memory_enabled,
					null,
					settings.enable_popover_references,
				);

			const provider = plugin.getProviderRegistry().getProvider(resolved.providerId);

			// The orchestrationContext is threaded into RunLoopOptions by the
			// executor; the dispatcher reads it off ToolExecuteOptions at dispatch.
			void orchestrationContext;
			void step;

			return { provider, dispatcher, toolDefinitions, systemPrompt };
		},
	};
}

/** Compute filtered `ToolDefinition[]` from the registry + an effective config. */
function buildToolDefinitions(
	tools: Tool[],
	effective?: EffectiveToolConfig,
): ToolDefinition[] {
	const defs: ToolDefinition[] = [];
	for (const tool of tools) {
		const entry = effective?.tools[tool.name];
		if (!entry || !entry.enabled) continue;
		defs.push({
			name: tool.name,
			description: tool.description,
			input_schema: tool.input_schema as ToolDefinition["input_schema"],
			mode: tool.mode,
		});
	}
	return defs;
}

/**
 * Resolve, parse, and run a flow by directory to a terminal event. Used by both
 * the command (FEAT-011) and the `run_orchestration` hook (FEAT-012).
 */
export async function launchOrchestration(
	plugin: NotorPlugin,
	flow: OrchestrationFlow,
	promptText: string,
	options?: {
		origin?: "user" | "hook" | "run_flow" | "chaining";
		parentSessionId?: string | null;
		mode?: ConversationMode;
		abortSignal?: AbortSignal;
	},
): Promise<OrchestrationRunResult> {
	const sessionId = newSessionId();
	const dir = sessionDir(plugin.settings.notor_dir, sessionId);
	const logPath = `${dir}/session-log.jsonl`;
	const sessionLog = new SessionLog(logPath, new VaultSessionLogWriter(plugin.app));

	const promptBuilder = new StepPromptBuilder();
	const runtimeFactory = makeRuntimeFactory(plugin);

	const executor = new StepTurnExecutor(
		{
			personaManager: {
				getPersonaByName: (name: string) => plugin.getPersonaManager().getPersonaByName(name),
			},
			providerRegistry: plugin.getProviderRegistry(),
			settings: plugin.settings,
			promptBuilder,
			runtimeFactory,
			resolveIncludes: async (body, notePath) => {
				const result = await resolveIncludeNotes(
					body,
					plugin.app.vault,
					plugin.app.metadataCache,
					notePath,
					"workflow",
				);
				return result.inlineContent;
			},
		},
		sessionLog,
	);

	const abortController = new AbortController();
	const abortSignal = options?.abortSignal ?? abortController.signal;

	const runner = new OrchestrationRunner({
		executor,
		sessionLog,
		makeOrchestrationContext: (_conversationId): OrchestrationToolContext => ({
			sessionId,
			scratchpadPath: `${dir}/scratchpad`,
			tasksPath: `${dir}/tasks`,
			pendingEmission: null,
			emissionOverwrites: [],
		}),
		makeConversationId: () => crypto.randomUUID(),
		mode: options?.mode ?? plugin.settings.mode,
		sessionId,
		abortSignal,
		origin: options?.origin ?? "user",
		parentSessionId: options?.parentSessionId ?? null,
		onProgress: (status) => log.debug("orchestration progress", { status }),
	});

	log.info("Launching orchestration flow", { flow: flow.name, sessionId, origin: options?.origin });
	return runner.start(flow, promptText);
}

// ---------------------------------------------------------------------------
// Flow picker + objective prompt (the command UI)
// ---------------------------------------------------------------------------

class FlowPickerModal extends FuzzySuggestModal<OrchestrationFlow> {
	constructor(
		app: App,
		private readonly flows: OrchestrationFlow[],
		private readonly onSelect: (flow: OrchestrationFlow) => void,
		private readonly emptyMessage: string,
	) {
		super(app);
		this.setPlaceholder("Select an orchestration flow to run…");
	}

	getItems(): OrchestrationFlow[] {
		return this.flows;
	}

	getItemText(flow: OrchestrationFlow): string {
		return flow.description ? `${flow.name} — ${flow.description}` : flow.name;
	}

	onChooseItem(flow: OrchestrationFlow): void {
		this.onSelect(flow);
	}

	onNoSuggestion(): void {
		if (this.flows.length === 0) {
			this.resultContainerEl.empty();
			const msg = this.resultContainerEl.createDiv({ cls: "notor-orchestration-picker-empty" });
			msg.textContent = this.emptyMessage;
		}
	}
}

class ObjectiveModal extends Modal {
	constructor(
		app: App,
		private readonly flowName: string,
		private readonly onSubmit: (objective: string) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `Run "${this.flowName}"` });
		contentEl.createEl("p", {
			text: "Describe the objective for this flow run.",
			cls: "setting-item-description",
		});

		const input = contentEl.createEl("textarea", { cls: "notor-orchestration-objective-input" });
		input.rows = 4;
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit(input.value.trim());
			}
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonRow).setButtonText("Cancel").onClick(() => this.close());
		new ButtonComponent(buttonRow)
			.setButtonText("Run")
			.setCta()
			.onClick(() => this.submit(input.value.trim()));

		setTimeout(() => input.focus(), 10);
	}

	private submit(objective: string): void {
		if (!objective) {
			new Notice("Enter an objective to run the flow.");
			return;
		}
		this.close();
		this.onSubmit(objective);
	}
}

/**
 * Open the flow picker → objective prompt → launch. Discovers flows via
 * {@link FlowDefinitionParser}. Surfaced by the "Notor: Run Orchestration"
 * command (gated on `orchestration_enabled`).
 */
export async function showOrchestrationPicker(plugin: NotorPlugin): Promise<void> {
	const parser = new FlowDefinitionParser(
		plugin.app.vault,
		plugin.app.metadataCache,
		plugin.settings.notor_dir,
	);

	let parsed;
	try {
		parsed = await parser.discoverFlows();
	} catch (e) {
		log.error("Flow discovery failed", { error: String(e) });
		new Notice(`Orchestration discovery failed: ${e instanceof Error ? e.message : String(e)}`);
		return;
	}

	const flows = parsed.map((p) => p.flow);
	const emptyMessage = `No orchestration flows found in ${plugin.settings.notor_dir.replace(/\/$/, "")}/orchestrations/`;

	new FlowPickerModal(
		plugin.app,
		flows,
		(flow) => {
			new ObjectiveModal(plugin.app, flow.name, (objective) => {
				launchOrchestration(plugin, flow, objective, { origin: "user" }).catch((e) => {
					log.error("Orchestration run failed", { flow: flow.name, error: String(e) });
					new Notice(`Orchestration '${flow.name}' failed: ${e instanceof Error ? e.message : String(e)}`);
				});
			}).open();
		},
		emptyMessage,
	).open();
}
