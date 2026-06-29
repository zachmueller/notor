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
import type { AggregateBudget, OrchestrationToolContext } from "../run-loop/types";
import { buildUtils, buildLibs, buildObsidianExports } from "../extensions/runtime-context";
import { resolveNote } from "../utils/resolve-note";
import { resolveIncludeNotes } from "../include-note/resolver";
import { logger } from "../utils/logger";
import { FlowDefinitionParser } from "./flow-parser";
import { FlowCompositionManager } from "./flow-composition-manager";
import type {
	SpawnChildFlow,
	SpawnChildFlowRequest,
	SpawnChildFlowResult,
} from "./child-flow";
import { StepPromptBuilder } from "./step-prompt-builder";
import { StepTurnExecutor, type StepRuntime, type StepRuntimeFactory } from "./step-turn-executor";
import { CodeStepExecutor, type CodeStepRuntime, type CodeStepRuntimeFactory } from "./code-step-executor";
import type { ScratchpadFs } from "./orchestration-helper";
import { SessionLog, type SessionLogWriter } from "./session-log";
import { OrchestrationSessionManager, type SessionFs } from "./session-manager";
import { TaskRegistry, type TaskFs } from "./task-registry";
import { seedMemoriesNote, memoriesPath } from "./memories";
import { writeFailureReport, shouldWriteFailureReport } from "./failure-report";
import { SessionRecovery, type RecoveryFs, type RecoverableSession } from "./session-recovery";
import { VaultStepConversationStore } from "./step-conversation-store";
import { showOrchestrationProgressNotice } from "./notices";
import { OrchestrationRunner, type OrchestrationRunResult } from "./runner";
import type { OrchestrationFlow, OrchestrationSessionMeta } from "./types";
import type { ChildResultEntry, ChildSpawnedEntry, SessionLogEntry } from "./session-log";

const log = logger("OrchestrationLaunch");

/** Generate a short session id. */
function newSessionId(): string {
	return `sess-${crypto.randomUUID().slice(0, 12)}`;
}

/**
 * Open a step conversation by id from a progress-Notice right-click (INT-021 /
 * FR-141). Opens the chat panel if needed, then reuses
 * `ChatOrchestrator.switchToConversationById(...)` — the **same** navigation
 * primitive behind the `notor-conversation://{id}` link and main.ts's
 * `obsidian://notor?id=` handler (no new navigation is introduced, AC-4). A
 * conversation that cannot be resolved surfaces the same "may have been deleted"
 * Notice the protocol handler uses.
 */
function jumpToStepConversation(plugin: NotorPlugin, conversationId: string): void {
	void plugin.openChatPanel().then(() => {
		const orchestrator = plugin.getActiveOrchestrator();
		if (!orchestrator) {
			new Notice("No active chat panel");
			return;
		}
		void orchestrator.switchToConversationById(conversationId).then((found) => {
			if (!found) {
				new Notice("Step conversation not found — it may have been deleted");
			}
		});
	});
}

/**
 * Query a session's still-open/running tasks for the runner's `FLOW_COMPLETE`
 * enforcement (INT-003). Backed by the same vault-adapter {@link TaskRegistry}
 * the task-tool scaffolds write through, so the open-task set the runner reads is
 * exactly what those tools persisted.
 */
async function listOpenTaskKeys(
	plugin: NotorPlugin,
	tasksPath: string,
): Promise<Array<{ key: string; description: string }>> {
	const adapter = plugin.app.vault.adapter;
	const fs: TaskFs = {
		exists: (p) => adapter.exists(normalizePath(p)),
		read: (p) => adapter.read(normalizePath(p)),
		write: async (p, data) => adapter.write(normalizePath(p), data),
		mkdir: async (p) => adapter.mkdir(normalizePath(p)),
		list: async (dir) => {
			const norm = normalizePath(dir);
			if (!(await adapter.exists(norm))) return [];
			return (await adapter.list(norm)).files;
		},
	};
	const open = await new TaskRegistry(fs).listOpen(tasksPath);
	return open.map((t) => ({ key: t.key, description: t.description }));
}

/**
 * Build the {@link StepTurnExecutor} wired to the plugin's chat stack. Shared by
 * a fresh launch and a recovery resume so both run on the identical runtime.
 *
 * `committedKeys` is the SHARED `once()` skip set for the whole run (seeded empty
 * on a fresh launch, or from the recovered log on resume so an already-committed
 * external effect is not re-run — FR-125 / INT-010).
 */
function buildExecutor(
	plugin: NotorPlugin,
	sessionLog: SessionLog,
	committedKeys: Set<string>,
): StepTurnExecutor {
	// INT-006: persist each step conversation (hidden from the flat list) with its
	// orchestration_edges header into the chat history directory.
	const stepConversationStore = new VaultStepConversationStore(
		new VaultSessionFs(plugin.app),
		plugin.settings.history_path,
	);
	// INT-010: the deterministic code-step executor (notor-step-mode: code).
	const codeStepExecutor = new CodeStepExecutor(
		{
			runtimeFactory: makeCodeStepRuntimeFactory(plugin, committedKeys),
			notifyError: (message: string) => new Notice(message),
		},
		sessionLog,
	);
	return new StepTurnExecutor(
		{
			personaManager: {
				getPersonaByName: (name: string) => plugin.getPersonaManager().getPersonaByName(name),
			},
			providerRegistry: plugin.getProviderRegistry(),
			settings: plugin.settings,
			promptBuilder: new StepPromptBuilder(),
			runtimeFactory: makeRuntimeFactory(plugin),
			memoriesPath: memoriesPath(plugin.settings.notor_dir),
			stepConversationStore,
			codeStepExecutor,
			// INT-020 / INT-021: per-turn progress Notice. The jump callback reuses
			// the existing notor-conversation:// navigation primitive
			// (`switchToConversationById`, the same path main.ts's obsidian://notor?id=
			// handler uses) — no new navigation is introduced. The closure resolves the
			// active orchestrator lazily at right-click time (a panel may not be open
			// when the flow is launched from a hook).
			showProgressNotice: ({ flowName, stepName, iteration, emittedTopic, conversationId }) =>
				showOrchestrationProgressNotice({
					flowName,
					stepName,
					iteration,
					emittedTopic,
					conversationId,
					onJumpToConversation: () => jumpToStepConversation(plugin, conversationId),
				}),
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

/** A {@link SessionFs} backed by Obsidian's vault adapter (INT-001). */
export class VaultSessionFs implements SessionFs {
	constructor(private readonly app: App) {}

	exists(path: string): Promise<boolean> {
		return this.app.vault.adapter.exists(normalizePath(path));
	}

	async mkdir(path: string): Promise<void> {
		const norm = normalizePath(path);
		// Obsidian's adapter.mkdir is not recursive — create parents first.
		const parts = norm.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.app.vault.adapter.exists(current))) {
				await this.app.vault.adapter.mkdir(current);
			}
		}
	}

	async write(path: string, data: string): Promise<void> {
		const norm = normalizePath(path);
		const dir = norm.slice(0, norm.lastIndexOf("/"));
		if (dir && !(await this.app.vault.adapter.exists(dir))) {
			await this.mkdir(dir);
		}
		await this.app.vault.adapter.write(norm, data);
	}

	read(path: string): Promise<string> {
		return this.app.vault.adapter.read(normalizePath(path));
	}
}

/**
 * Opt-in failed-run debug note (Part B). When a run terminates with
 * `status: "error"` and `orchestration_write_failure_notes` is on, compose a
 * human-readable Markdown report from data already captured (session.json meta +
 * the run result + session-log.jsonl) and write it under
 * `{notor_dir}/orchestrations/failures/`. Called from both finalize sites (a
 * fresh run and a crash-recovery resume).
 *
 * Fully best-effort: a missing log, an absent meta, or a write failure is logged
 * and swallowed so the report never masks the original run error.
 */
async function maybeWriteFailureReport(
	plugin: NotorPlugin,
	sessionManager: OrchestrationSessionManager,
	sessionId: string,
	flow: OrchestrationFlow,
	result: OrchestrationRunResult,
): Promise<void> {
	if (!shouldWriteFailureReport(result.status, plugin.settings.orchestration_write_failure_notes)) {
		return;
	}
	try {
		const ws = sessionManager.resolveWorkspace(sessionId);
		const meta = await sessionManager.readMeta(sessionId);
		const fsVault = new VaultSessionFs(plugin.app);
		const logJsonl = await fsVault.read(ws.logPath).catch(() => null);
		const path = await writeFailureReport({
			notorDir: plugin.settings.notor_dir,
			fs: fsVault,
			meta,
			result,
			logJsonl,
			sessionDir: ws.sessionDir,
		});
		new Notice(`Orchestration '${flow.name}' failed — debug report: ${path}`);
	} catch (e) {
		log.warn("Failed to write orchestration failure report", { sessionId, error: String(e) });
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

/**
 * Build the real per-step {@link CodeStepRuntimeFactory} (INT-010). Each call
 * assembles:
 *  - `utils` / `libs` / `obsidian` — the **identical** objects user-defined
 *    tools receive (`buildUtils()` / `buildLibs()` / `buildObsidianExports()`),
 *    so a code step inherits `utils.executeShellCommand` / `utils.notify` / … unchanged;
 *  - a fresh per-step `ToolDispatcher` (registry + effective config + vault root),
 *    so `orchestration.callTool` / `callMcpTool` dispatch through the same seam as
 *    LLM tool calls and honor path enforcement + the auto-allowed scratchpad path;
 *  - a vault-adapter-backed scratchpad FS + the shared {@link TaskRegistry}.
 *
 * `committedKeys` is the run-wide `once()` skip set (mutated in place as guarded
 * effects commit), shared with the conversation path.
 */
function makeCodeStepRuntimeFactory(
	plugin: NotorPlugin,
	committedKeys: Set<string>,
): CodeStepRuntimeFactory {
	const adapter = plugin.app.vault.adapter;
	const scratchpadFs: ScratchpadFs = {
		read: async (path) => {
			const norm = normalizePath(path);
			if (!(await adapter.exists(norm))) return null;
			return adapter.read(norm);
		},
		write: async (path, content) => {
			const norm = normalizePath(path);
			const dir = norm.slice(0, norm.lastIndexOf("/"));
			if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(norm, content);
		},
		exists: (path) => adapter.exists(normalizePath(path)),
		list: async (dir) => {
			const norm = normalizePath(dir);
			if (!(await adapter.exists(norm))) return [];
			return (await adapter.list(norm)).files;
		},
	};
	const taskFs: TaskFs = {
		exists: (p) => adapter.exists(normalizePath(p)),
		read: (p) => adapter.read(normalizePath(p)),
		write: async (p, data) => {
			const norm = normalizePath(p);
			const dir = norm.slice(0, norm.lastIndexOf("/"));
			if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
			await adapter.write(norm, data);
		},
		mkdir: async (p) => {
			const norm = normalizePath(p);
			if (!(await adapter.exists(norm))) await adapter.mkdir(norm);
		},
		list: async (dir) => {
			const norm = normalizePath(dir);
			if (!(await adapter.exists(norm))) return [];
			return (await adapter.list(norm)).files;
		},
	};
	const taskRegistry = new TaskRegistry(taskFs);

	return {
		async build({ orchestrationContext, abortSignal }): Promise<CodeStepRuntime> {
			const settings = plugin.settings;
			const registry = plugin.getToolRegistry();

			// A fresh per-step dispatcher (mirrors the conversation-step pattern) so
			// concurrent code steps don't share mutable dispatcher state.
			const dispatcher = new ToolDispatcher();
			for (const tool of registry.getAll()) {
				dispatcher.registerTool(tool);
			}
			dispatcher.setSettings(settings);
			if (plugin.vaultRootPath) dispatcher.setVaultRootPath(plugin.vaultRootPath);
			dispatcher.setResolveVaultPath((p: string) => {
				const file = resolveNote(p, plugin.app.vault, plugin.app.metadataCache);
				return file?.path ?? null;
			});
			const configResolver = new ConfigResolver(
				settings,
				plugin.getSystemPromptBuilder(),
				dispatcher,
			);
			configResolver.setGetToolDefinitions((effective?: EffectiveToolConfig) =>
				buildToolDefinitions(registry.getAll(), effective),
			);
			const { effective } = await configResolver.resolveEffectiveConfig(undefined, null, null);
			dispatcher.setEffectiveToolConfig(effective);

			// utils/libs/obsidian — IDENTICAL to user-defined tools.
			const utils = buildUtils(plugin);
			utils.abortSignal = abortSignal;
			// The scaffold task tools (and any orchestration-aware tool reached via
			// callTool) read the session carriage off utils, exactly as a step turn.
			utils.orchestrationContext = orchestrationContext;
			const libs = buildLibs();
			const obsidian = buildObsidianExports();

			return {
				app: plugin.app,
				obsidian,
				utils,
				libs,
				dispatcher,
				scratchpadFs,
				taskRegistry,
				committedKeys,
			};
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
		origin?: "user" | "hook" | "schedule" | "run_flow" | "chaining";
		parentSessionId?: string | null;
		mode?: ConversationMode;
		abortSignal?: AbortSignal;
		/**
		 * Pre-allocated child session id (INT-044). When omitted a fresh one is
		 * minted. A child / chaining launch supplies it so the parent's
		 * `child.spawned` ledger entry can record the id **before** the run starts.
		 */
		sessionId?: string;
		/**
		 * Inherited cascade context for a child / chaining run (INT-043/045/046):
		 * the SHARED budget cell + the parent's depth (the child runs at `depth+1`).
		 * Omitted for a root run, which seeds a fresh cell from the flow's ceilings.
		 */
		inheritedContext?: { budget: AggregateBudget; depth: number };
		/**
		 * The parent session's scratchpad path, auto-allowed for a `shared`-handoff
		 * child's step turns (FR-174). Only consulted when the callee flow's
		 * `notor-handoff-isolation` is `shared`.
		 */
		parentScratchpadPath?: string;
		/**
		 * The caller's step conversation id (INT-043). Written as the child entry
		 * conversation's `parent` back-link edge so the run-tree can ascend.
		 */
		parentConversationId?: string;
	},
): Promise<OrchestrationRunResult> {
	const sessionId = options?.sessionId ?? newSessionId();
	const origin = options?.origin ?? "user";
	const parentSessionId = options?.parentSessionId ?? null;
	// `shared` handoff: auto-allow the parent scratchpad for this child's turns.
	const sharedParentScratchpad =
		flow.handoffIsolation === "shared" ? options?.parentScratchpadPath : undefined;

	// INT-001: create the session workspace (dir + scratchpad/ + tasks/ +
	// session.json status `active`) before the first turn runs.
	const sessionManager = new OrchestrationSessionManager(
		plugin.settings.notor_dir,
		new VaultSessionFs(plugin.app),
	);
	const ws = await sessionManager.createSession({
		sessionId,
		flowName: flow.name,
		prompt: promptText,
		origin,
		parentSessionId,
	});

	// INT-004: seed the persistent cross-session memories note on first use
	// (idempotent — never overwrites an existing note).
	await seedMemoriesNote(plugin.settings.notor_dir, new VaultSessionFs(plugin.app)).catch((e) =>
		log.warn("memories.md seeding failed", { error: String(e) }),
	);

	// POL-004: surface this run in the unified activity indicator as an active
	// `flow-run` entry (session-file-backed registry).
	plugin.upsertFlowRun?.({
		type: "flow-run",
		sessionId,
		flowName: flow.name,
		status: "active",
		startedAt: new Date().toISOString(),
	});

	const sessionLog = new SessionLog(ws.logPath, new VaultSessionLogWriter(plugin.app));
	// Fresh launch: no prior committed side-effects (INT-010 once() skip set).
	const executor = buildExecutor(plugin, sessionLog, new Set<string>());

	const abortController = new AbortController();
	const abortSignal = options?.abortSignal ?? abortController.signal;

	// INT-045: if this flow chains (`notor-on-complete-flow`), resolve the
	// successor's `notor-flow-inputs` so the prompt builder injects the HANDOFF
	// section on the terminal step (the predecessor shapes its forwarded payload).
	const onCompleteFlowInputs = flow.onCompleteFlow
		? await resolveSuccessorInputs(plugin, flow.onCompleteFlow)
		: null;

	const runner = new OrchestrationRunner({
		executor,
		sessionLog,
		makeOrchestrationContext: (_conversationId): OrchestrationToolContext => ({
			sessionId,
			scratchpadPath: ws.scratchpadPath,
			tasksPath: ws.tasksPath,
			// `shared` handoff: the parent scratchpad is auto-allowed for this
			// child's step turns (FR-174 / INT-044).
			parentScratchpadPath: sharedParentScratchpad,
			pendingEmission: null,
			emissionOverwrites: [],
			workflowInvocations: [],
			childRunResults: [],
			childEdges: [],
		}),
		makeConversationId: () => crypto.randomUUID(),
		mode: options?.mode ?? plugin.settings.mode,
		sessionId,
		abortSignal,
		origin,
		parentSessionId,
		// INT-046: a child / chaining run inherits the parent's SHARED budget cell
		// + depth (so the whole tree respects one ceiling). Omitted ⇒ root run.
		inheritedContext: options?.inheritedContext,
		// INT-045: the chaining successor's input contract, injected into the
		// terminal step's HANDOFF section so the predecessor shapes its payload.
		onCompleteFlowInputs,
		// INT-003: query the session's task registry to gate FLOW_COMPLETE.
		listOpenTasks: () => listOpenTaskKeys(plugin, ws.tasksPath),
		// INT-030: interactive pause. The runner writes user.input.required,
		// suspends, and calls this to collect the answer (a modal). Returning
		// null (declined/dismissed) finalizes via FLOW_CANCELLED.
		requestUserInput: (promptText) => requestOrchestrationInput(plugin.app, flow.name, promptText),
		// INT-030: mirror session.json status while paused so a crash-while-paused
		// is recovered as a dangling user.input.required tail ("still paused").
		setSessionStatus: (status) => sessionManager.updateStatus(sessionId, status),
		onProgress: (status) => log.debug("orchestration progress", { status }),
	});

	log.info("Launching orchestration flow", { flow: flow.name, sessionId, origin });

	let result: OrchestrationRunResult;
	try {
		result = await runner.start(flow, promptText);
	} catch (e) {
		// A crash before a terminal: mark the session interrupted so the recovery
		// scan (INT-005) picks it up on next load.
		await sessionManager
			.updateStatus(sessionId, "interrupted")
			.catch(() => undefined);
		throw e;
	}

	// INT-001: reflect the terminal status into session.json (recovery entry
	// point). `completed` → done; `cancelled`/`error` map to their statuses.
	const finalStatus =
		result.status === "completed"
			? "completed"
			: result.status === "cancelled"
				? "cancelled"
				: "error";
	await sessionManager
		.updateStatus(sessionId, finalStatus, { iteration: result.iterations })
		.catch((e) => log.warn("Failed to finalize session.json status", { error: String(e) }));

	// POL-004: reflect the terminal status into the unified indicator's flow-run entry.
	plugin.upsertFlowRun?.({
		type: "flow-run",
		sessionId,
		flowName: flow.name,
		status: finalStatus,
		startedAt: new Date().toISOString(),
	});

	// Part B: opt-in failed-run debug note (no-op unless status is error + setting on).
	await maybeWriteFailureReport(plugin, sessionManager, sessionId, flow, result);

	// INT-045: chaining / one-way handoff. On successful completion, if the flow
	// declares `notor-on-complete-flow`, launch the successor INSTEAD of returning
	// to any caller — fire-and-forget. The handoff is gated exactly like a
	// run_flow spawn over the SAME shared budget cell + depth, so an A → B → A
	// on-complete cycle terminates at max_depth / the aggregate budget. A blocked
	// handoff is a loud FLOW_ERROR (the chain has no caller to return to).
	if (result.status === "completed" && flow.onCompleteFlow) {
		await chainToSuccessor(plugin, flow, result, sessionId).catch((e) =>
			log.error("Chaining handoff failed", { flow: flow.name, error: String(e) }),
		);
	}

	return result;
}

/**
 * Resolve a chaining successor's `notor-flow-inputs` by wikilink-stripped flow
 * name (INT-045). Returns `null` when the successor is not discoverable (the
 * HANDOFF section is then simply omitted).
 */
async function resolveSuccessorInputs(
	plugin: NotorPlugin,
	successorName: string,
): Promise<string | null> {
	try {
		const parser = new FlowDefinitionParser(
			plugin.app.vault,
			plugin.app.metadataCache,
			plugin.settings.notor_dir,
		);
		const parsed = await parser.discoverFlows();
		const match = parsed.find((p) => p.flow.name === successorName);
		return match?.flow.flowInputs ?? null;
	} catch {
		return null;
	}
}

/**
 * Launch a chaining successor (INT-045 / FR-175). Gated exactly like a `run_flow`
 * spawn over the predecessor's live shared budget cell + depth (`canSpawnChild`);
 * a blocked handoff terminates the chain with `FLOW_ERROR` (status `error`) — a
 * loud, diagnosable stop, since chaining has no caller to return a tool error to.
 * The successor is launched as a recovery **root**-able `origin: "chaining"` run
 * (it is recovered as a root once this predecessor is terminal — INT-005), so this
 * call is fire-and-forget: it does not block the predecessor's own return.
 */
async function chainToSuccessor(
	plugin: NotorPlugin,
	predecessor: OrchestrationFlow,
	predecessorResult: OrchestrationRunResult,
	predecessorSessionId: string,
): Promise<void> {
	const successorName = predecessor.onCompleteFlow;
	if (!successorName) return;

	const parser = new FlowDefinitionParser(
		plugin.app.vault,
		plugin.app.metadataCache,
		plugin.settings.notor_dir,
	);
	const parsed = await parser.discoverFlows();
	const successor = parsed.find((p) => p.flow.name === successorName)?.flow;
	if (!successor) {
		new Notice(
			`Chaining target '${successorName}' (from '${predecessor.name}') is not discoverable — chain stops.`,
		);
		return;
	}

	// Gate the handoff over the SAME shared cell + depth (canSpawnChild semantics).
	const budget = predecessorResult.budget;
	const depth = predecessorResult.depth;
	const maxDepth =
		successor.maxDepth !== null && successor.maxDepth !== undefined
			? depth + 1 + successor.maxDepth
			: Infinity;
	const blocked =
		depth + 1 >= maxDepth ||
		budget.iterationsRemaining <= 0 ||
		budget.costRemainingUsd <= 0;
	if (blocked) {
		// A blocked handoff terminates the chain loudly (no caller to return to).
		new Notice(
			`Chain '${predecessor.name}' → '${successorName}' blocked (depth/budget exhausted); chain stops with an error.`,
		);
		log.warn("Chaining handoff blocked — terminating the chain", {
			predecessor: predecessor.name,
			successor: successorName,
			depth,
			budget,
		});
		return;
	}

	// Forward the predecessor's terminal payload (shaped by the HANDOFF section).
	const forwardedPayload = predecessorResult.text;
	new Notice(`Chaining '${predecessor.name}' → '${successorName}'…`);
	await launchOrchestration(plugin, successor, forwardedPayload, {
		origin: "chaining",
		parentSessionId: predecessorSessionId,
		// Inherit the SAME shared cell by reference + depth + 1 (bounded cycle).
		inheritedContext: { budget, depth: depth + 1 },
		parentScratchpadPath:
			successor.handoffIsolation === "shared"
				? new OrchestrationSessionManager(
						plugin.settings.notor_dir,
						new VaultSessionFs(plugin.app),
					).resolveWorkspace(predecessorSessionId).scratchpadPath
				: undefined,
	});
}

// ---------------------------------------------------------------------------
// Child-flow spawn (INT-043 / INT-044) — the run_flow execution body
// ---------------------------------------------------------------------------

/**
 * Build the {@link SpawnChildFlow} callback injected into {@link RunFlowTool}.
 * Closes over the plugin; for each `run_flow` call it:
 *  1. resolves the parent session's depth (from the parent's `RunContext` cascade,
 *     passed by the tool) and writes a **`child.spawned`** ledger entry on the
 *     **parent** session log (the recovery anchor — FR-125);
 *  2. runs the child flow to its terminal event on a child session + child runner
 *     inheriting the parent's SHARED budget cell + `depth + 1` (INT-046);
 *  3. writes **`child.result`** on the parent log (the reuse-on-recovery artifact);
 *  4. backfills the reciprocal `parent` edge on the child entry conversation;
 *  5. returns the child's `structured`/`text` + the aggregate-subtree rollup.
 *
 * **Recovery reuse/resume (INT-044 / FR-125).** Before spawning, it scans the
 * parent log for a `child.spawned` with this `via_tool_call_id`:
 *  - a matching **`child.result`** (terminal child) ⇒ **reuse** the recorded result
 *    (no re-spawn) — the parent's replay must not double-execute the child;
 *  - a `child.spawned` with **no** `child.result` (non-terminal child) ⇒ **resume**
 *    that child session in place (replay its own log) and await it — never
 *    tombstone-and-respawn, so the child's `once()` markers survive.
 *
 * The match is by `via_tool_call_id`; a re-run parent mints the SAME id only if the
 * tool re-issues an identical call. To make reuse deterministic across a crash the
 * parent's replay re-runs the step from fresh context, so it re-dispatches the same
 * `run_flow` — the ledger is matched by occurrence order within the step (v1 runs
 * `run_flow` serially, so order is stable).
 */
export function makeChildFlowSpawner(plugin: NotorPlugin): SpawnChildFlow {
	const sessionManager = new OrchestrationSessionManager(
		plugin.settings.notor_dir,
		new VaultSessionFs(plugin.app),
	);

	return async (req: SpawnChildFlowRequest): Promise<SpawnChildFlowResult> => {
		// Resolve the callee flow (the tool already validated it is invocable, but
		// re-resolve so the spawner is self-contained / testable).
		const composition = new FlowCompositionManager(
			plugin.app.vault,
			plugin.app.metadataCache,
			plugin.settings.notor_dir,
		);
		const flow = await composition.resolveFlow(req.flowName);
		if (!flow) {
			return childErrorResult(req, `Flow '${req.flowName}' is not invocable.`);
		}

		const parentWs = sessionManager.resolveWorkspace(req.parentSessionId);
		const parentLog = new SessionLog(parentWs.logPath, new VaultSessionLogWriter(plugin.app));

		// --- Recovery reuse/resume (INT-044) -------------------------------------
		const reconciled = await reconcileChildLedger(plugin, req);
		if (reconciled) return reconciled;

		// --- Fresh spawn ---------------------------------------------------------
		const childSessionId = newSessionId();

		// child.spawned BEFORE launch (the recovery anchor).
		await parentLog
			.appendChildSpawned({
				turn: 0,
				step: req.parentConversationId ?? "",
				via_tool_call_id: req.viaToolCallId,
				child_session_id: childSessionId,
			})
			.catch((e) => log.warn("child.spawned append failed", { error: String(e) }));

		let result: OrchestrationRunResult;
		try {
			result = await launchOrchestration(plugin, flow, req.payload, {
				origin: "run_flow",
				parentSessionId: req.parentSessionId,
				sessionId: childSessionId,
				inheritedContext: req.cascade,
				parentScratchpadPath: req.parentScratchpadPath,
				parentConversationId: req.parentConversationId,
				abortSignal: req.cascade.abort,
			});
		} catch (e) {
			log.error("Child flow run threw", { flow: flow.name, error: String(e) });
			return childErrorResult(req, e instanceof Error ? e.message : String(e), childSessionId);
		}

		// child.result AFTER the child returns, BEFORE the parent turn continues.
		await parentLog
			.appendChildResult({
				turn: 0,
				child_session_id: childSessionId,
				structured: result.structured ?? undefined,
				text: result.text,
				stop_reason: result.terminal.topic,
			})
			.catch((e) => log.warn("child.result append failed", { error: String(e) }));

		const entryConversationId = await resolveChildEntryConversationId(plugin, childSessionId);
		// Backfill the reciprocal `parent` edge on the child entry conversation.
		if (entryConversationId && req.parentConversationId) {
			await backfillParentEdge(
				plugin,
				entryConversationId,
				req.parentConversationId,
				req.parentSessionId,
			);
		}

		return {
			status: result.status,
			structured: result.structured,
			text: result.text,
			stopReason: result.terminal.topic,
			childSessionId,
			entryConversationId,
			rollup: {
				costUsd: result.subtreeConsumed.costUsd,
				iterations: result.subtreeConsumed.iterations,
				maxDepthReached: result.subtreeConsumed.maxDepthReached,
				tokenUsage: result.tokenUsage,
			},
		};
	};
}

/**
 * Reconcile a `run_flow` child against the parent's durable ledger on a recovery
 * re-run (INT-044). Returns a reuse/resume result when the parent already has a
 * `child.spawned` for this `via_tool_call_id`; `null` for a fresh spawn (the
 * common live case).
 */
async function reconcileChildLedger(
	plugin: NotorPlugin,
	req: SpawnChildFlowRequest,
): Promise<SpawnChildFlowResult | null> {
	const sessionManager = new OrchestrationSessionManager(
		plugin.settings.notor_dir,
		new VaultSessionFs(plugin.app),
	);
	const parentWs = sessionManager.resolveWorkspace(req.parentSessionId);
	let raw: string;
	try {
		if (!(await plugin.app.vault.adapter.exists(normalizePath(parentWs.logPath)))) return null;
		raw = await plugin.app.vault.adapter.read(normalizePath(parentWs.logPath));
	} catch {
		return null;
	}

	const entries = raw
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l): SessionLogEntry | null => {
			try {
				return JSON.parse(l) as SessionLogEntry;
			} catch {
				return null;
			}
		})
		.filter((e): e is SessionLogEntry => e !== null);

	const spawned = entries.find(
		(e): e is ChildSpawnedEntry =>
			e.type === "child.spawned" && e.via_tool_call_id === req.viaToolCallId,
	);
	if (!spawned) return null; // fresh spawn

	const childSessionId = spawned.child_session_id;
	const childResult = entries.find(
		(e): e is ChildResultEntry =>
			e.type === "child.result" && e.child_session_id === childSessionId,
	);

	if (childResult) {
		// Terminal child → REUSE the recorded result (no re-spawn).
		log.info("run_flow recovery: reusing terminal child result", { childSessionId });
		const entryConversationId = await resolveChildEntryConversationId(plugin, childSessionId);
		return {
			status: childResult.stop_reason === "FLOW_CANCELLED" ? "cancelled" : "completed",
			structured: childResult.structured ?? null,
			text: childResult.text,
			stopReason: childResult.stop_reason,
			childSessionId,
			entryConversationId,
			rollup: { costUsd: 0, iterations: 0, maxDepthReached: req.cascade.depth + 1, tokenUsage: { input: 0, output: 0 } },
		};
	}

	// Non-terminal child → RESUME it in place (replay its own log), never respawn.
	log.info("run_flow recovery: resuming non-terminal child in place", { childSessionId });
	const composition = new FlowCompositionManager(
		plugin.app.vault,
		plugin.app.metadataCache,
		plugin.settings.notor_dir,
	);
	const flow = await composition.resolveFlow(req.flowName);
	if (!flow) return childErrorResult(req, `Flow '${req.flowName}' is no longer invocable.`, childSessionId);

	const recovery = new SessionRecovery();
	const recoveryFs = makeRecoveryFs(plugin, sessionManager);
	const logRaw = await recoveryFs.readLog(childSessionId);
	const metaRaw = await recoveryFs.readMeta(childSessionId);
	if (!logRaw || !metaRaw) {
		return childErrorResult(req, "Child session log/meta missing on resume.", childSessionId);
	}
	const childMeta = JSON.parse(metaRaw) as OrchestrationSessionMeta;
	const recovered = recovery.replay(childMeta, logRaw, {
		resolveCeilings: () => ({ maxIterations: flow.maxIterations, maxCostUsd: flow.maxCostUsd }),
	});
	const result = await resumeChildSession(plugin, flow, recovered, sessionManager, req.cascade);
	const entryConversationId = await resolveChildEntryConversationId(plugin, childSessionId);
	return {
		status: result.status,
		structured: result.structured,
		text: result.text,
		stopReason: result.terminal.topic,
		childSessionId,
		entryConversationId,
		rollup: {
			costUsd: result.subtreeConsumed.costUsd,
			iterations: result.subtreeConsumed.iterations,
			maxDepthReached: result.subtreeConsumed.maxDepthReached,
			tokenUsage: result.tokenUsage,
		},
	};
}

/** A child-run error result (no usable child output). */
function childErrorResult(
	req: SpawnChildFlowRequest,
	message: string,
	childSessionId = "",
): SpawnChildFlowResult {
	return {
		status: "error",
		structured: null,
		text: message,
		stopReason: "error",
		childSessionId,
		entryConversationId: null,
		rollup: { costUsd: 0, iterations: 0, maxDepthReached: req.cascade.depth + 1, tokenUsage: { input: 0, output: 0 } },
	};
}

/**
 * Resolve the **entry** (first) step conversation id of a child session from its
 * log — the `turn.start` `conversation_id` of the first conversation turn (the
 * `child` edge target). `null` when the child ran only code steps (no conversation).
 */
async function resolveChildEntryConversationId(
	plugin: NotorPlugin,
	childSessionId: string,
): Promise<string | null> {
	const sessionManager = new OrchestrationSessionManager(
		plugin.settings.notor_dir,
		new VaultSessionFs(plugin.app),
	);
	const ws = sessionManager.resolveWorkspace(childSessionId);
	try {
		if (!(await plugin.app.vault.adapter.exists(normalizePath(ws.logPath)))) return null;
		const raw = await plugin.app.vault.adapter.read(normalizePath(ws.logPath));
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as { type?: string; conversation_id?: string | null };
				if (e.type === "turn.start" && e.conversation_id) return e.conversation_id;
			} catch {
				// tolerate a malformed/truncated line
			}
		}
	} catch {
		// no log / unreadable — no entry conversation
	}
	return null;
}

/** Add a `parent` back-link edge on the child entry conversation's header. */
async function backfillParentEdge(
	plugin: NotorPlugin,
	childEntryConversationId: string,
	parentConversationId: string,
	parentSessionId: string,
): Promise<void> {
	const path = `${plugin.settings.history_path.replace(/\/+$/, "")}/orchestration_step_${childEntryConversationId}.jsonl`;
	try {
		const norm = normalizePath(path);
		if (!(await plugin.app.vault.adapter.exists(norm))) return;
		const content = await plugin.app.vault.adapter.read(norm);
		const nl = content.indexOf("\n");
		const headerLine = nl >= 0 ? content.slice(0, nl) : content;
		const rest = nl >= 0 ? content.slice(nl) : "";
		const header = JSON.parse(headerLine) as Record<string, unknown>;
		const edges = Array.isArray(header.orchestration_edges)
			? (header.orchestration_edges as Array<Record<string, unknown>>)
			: [];
		if (!edges.some((e) => e.kind === "parent" && e.conversation_id === parentConversationId)) {
			edges.push({
				kind: "parent",
				conversation_id: parentConversationId,
				session_id: parentSessionId,
			});
		}
		header.orchestration_edges = edges;
		await plugin.app.vault.adapter.write(norm, JSON.stringify(header) + rest);
	} catch (e) {
		log.warn("Failed to backfill parent edge on child entry", { error: String(e) });
	}
}

// ---------------------------------------------------------------------------
// Session recovery on reload (INT-005 / FR-125)
// ---------------------------------------------------------------------------

/** Build the {@link RecoveryFs} the scan + child-resume read sessions through. */
function makeRecoveryFs(
	plugin: NotorPlugin,
	sessionManager: OrchestrationSessionManager,
): RecoveryFs {
	const fsVault = new VaultSessionFs(plugin.app);
	const sessionsRoot = `${sessionManager.rootPath}/sessions`;
	return {
		listSessions: async () => {
			if (!(await fsVault.exists(sessionsRoot))) return [];
			const listing = await plugin.app.vault.adapter.list(normalizePath(sessionsRoot));
			return listing.folders.map((f) => f.split("/").pop() ?? f);
		},
		readMeta: async (sessionId) => {
			const path = `${sessionsRoot}/${sessionId}/session.json`;
			if (!(await fsVault.exists(path))) return null;
			return fsVault.read(path);
		},
		readLog: async (sessionId) => {
			const path = `${sessionsRoot}/${sessionId}/session-log.jsonl`;
			if (!(await fsVault.exists(path))) return null;
			return fsVault.read(path);
		},
	};
}

/**
 * Load-time orchestration recovery scan. Gated on `orchestration_enabled` by the
 * caller (main.ts). Scans `{notor_dir}/orchestrations/sessions/*` for recoverable
 * roots (`user`/`hook` always; terminal-parent `chaining`), classifies each
 * dangling tail, rebuilds budget + safety state, and resumes each on its own
 * runner. Loud recovery errors (interior log corruption, absent/unexpected
 * `origin`, missing files) are surfaced as Notices and the session is marked
 * `error` — never silently skipped.
 *
 * Resume is offered, not forced: a "Resume orchestration?" Notice summarizes
 * where each run left off. (The Phase-2 surface is a Notice + auto-resume of
 * `user`/`hook` roots; a richer prompt is a later UX task.)
 */
export async function recoverOrchestrations(plugin: NotorPlugin): Promise<void> {
	const fsVault = new VaultSessionFs(plugin.app);
	const sessionManager = new OrchestrationSessionManager(plugin.settings.notor_dir, fsVault);
	const recoveryFs = makeRecoveryFs(plugin, sessionManager);

	// Resolve each flow's finite ceilings so the budget re-seeds from the real
	// caps (not the engine defaults) when the flow is still discoverable.
	let flowsByName = new Map<string, OrchestrationFlow>();
	try {
		const parser = new FlowDefinitionParser(
			plugin.app.vault,
			plugin.app.metadataCache,
			plugin.settings.notor_dir,
		);
		const parsed = await parser.discoverFlows();
		flowsByName = new Map(parsed.map((p) => [p.flow.name, p.flow]));
	} catch (e) {
		log.warn("Flow discovery during recovery failed; using engine-default ceilings", {
			error: String(e),
		});
	}

	const recovery = new SessionRecovery();
	const scan = await recovery.scan(recoveryFs, {
		resolveCeilings: (flowName) => {
			const f = flowsByName.get(flowName);
			return f ? { maxIterations: f.maxIterations, maxCostUsd: f.maxCostUsd } : null;
		},
	});

	// Surface loud recovery errors and mark those sessions `error`.
	for (const err of scan.errors) {
		log.error("Orchestration recovery error", { sessionId: err.sessionId, reason: err.reason });
		new Notice(`Orchestration recovery error (${err.sessionId}): ${err.reason}`);
		await sessionManager.updateStatus(err.sessionId, "error").catch(() => undefined);
	}

	if (scan.recoverable.length === 0) return;

	for (const recovered of scan.recoverable) {
		const flow = flowsByName.get(recovered.meta.flow_name);
		if (!flow) {
			log.warn("Cannot resume — flow no longer discoverable", {
				sessionId: recovered.sessionId,
				flow: recovered.meta.flow_name,
			});
			new Notice(
				`Cannot resume orchestration '${recovered.meta.flow_name}' — its flow definition is missing.`,
			);
			continue;
		}
		new Notice(`Resuming orchestration '${flow.name}' (${recovered.action.kind})…`);
		// POL-004: re-seed the unified indicator so a recovered run surfaces.
		plugin.upsertFlowRun?.({
			type: "flow-run",
			sessionId: recovered.sessionId,
			flowName: flow.name,
			status: "active",
			startedAt: recovered.meta.started_at,
		});
		resumeRecoveredSession(plugin, flow, recovered, sessionManager).catch((e) =>
			log.error("Orchestration resume failed", {
				sessionId: recovered.sessionId,
				error: String(e),
			}),
		);
	}
}

/**
 * Resume one recovered session on a freshly-wired runner. Returns the terminal
 * result (used by a `run_flow` parent reconciling a non-terminal child in place,
 * INT-044). `inheritedContext` is set only for a child resume — a root resume
 * re-seeds its budget from the rehydrated state.
 */
async function resumeRecoveredSession(
	plugin: NotorPlugin,
	flow: OrchestrationFlow,
	recovered: RecoverableSession,
	sessionManager: OrchestrationSessionManager,
	inheritedContext?: { budget: AggregateBudget; depth: number; abort?: AbortSignal },
): Promise<OrchestrationRunResult> {
	const ws = sessionManager.resolveWorkspace(recovered.sessionId);
	await sessionManager.updateStatus(recovered.sessionId, "active").catch(() => undefined);

	const sessionLog = new SessionLog(ws.logPath, new VaultSessionLogWriter(plugin.app));
	// Resume: seed the once() skip set from the recovered log so an
	// already-committed external effect is not re-run (FR-125 / INT-010).
	const executor = buildExecutor(plugin, sessionLog, new Set(recovered.committedKeys));
	const abortSignal = inheritedContext?.abort ?? new AbortController().signal;

	const runner = new OrchestrationRunner({
		executor,
		sessionLog,
		makeOrchestrationContext: (): OrchestrationToolContext => ({
			sessionId: recovered.sessionId,
			scratchpadPath: ws.scratchpadPath,
			tasksPath: ws.tasksPath,
			pendingEmission: null,
			emissionOverwrites: [],
			workflowInvocations: [],
			childRunResults: [],
			childEdges: [],
		}),
		makeConversationId: () => crypto.randomUUID(),
		mode: plugin.settings.mode,
		sessionId: recovered.sessionId,
		abortSignal,
		origin: recovered.meta.origin,
		parentSessionId: recovered.meta.parent_session_id,
		// INT-044: a resumed child inherits the parent's shared budget cell + depth
		// so its turns keep drawing down the tree-wide ceiling. A root resume omits
		// this (its budget is re-seeded from the rehydrated decrements in resume()).
		inheritedContext: inheritedContext
			? { budget: inheritedContext.budget, depth: inheritedContext.depth }
			: undefined,
		listOpenTasks: () => listOpenTaskKeys(plugin, ws.tasksPath),
		// INT-030: a recovered paused session re-surfaces its prompt through the
		// same modal; supplying input resumes the loop, dismissing cancels it.
		requestUserInput: (promptText) => requestOrchestrationInput(plugin.app, flow.name, promptText),
		setSessionStatus: (status) => sessionManager.updateStatus(recovered.sessionId, status),
		onProgress: (status) => log.debug("orchestration resume progress", { status }),
	});

	let result: OrchestrationRunResult;
	try {
		result = await runner.resume(flow, recovered);
	} catch (e) {
		await sessionManager.updateStatus(recovered.sessionId, "interrupted").catch(() => undefined);
		throw e;
	}
	const finalStatus =
		result.status === "completed"
			? "completed"
			: result.status === "cancelled"
				? "cancelled"
				: "error";
	await sessionManager
		.updateStatus(recovered.sessionId, finalStatus, { iteration: result.iterations })
		.catch((e) => log.warn("Failed to finalize resumed session.json status", { error: String(e) }));

	// Part B: opt-in failed-run debug note for a recovered run that ends in error.
	await maybeWriteFailureReport(plugin, sessionManager, recovered.sessionId, flow, result);

	return result;
}

/**
 * Resume a non-terminal `run_flow` child in place (INT-044). The parent's replay
 * (via {@link makeChildFlowSpawner}'s reconciliation) calls this to replay the
 * child's own log and await its terminal result, inheriting the parent's shared
 * budget cell + `depth + 1` — never tombstone-and-respawn, so the child's `once()`
 * markers survive.
 */
async function resumeChildSession(
	plugin: NotorPlugin,
	flow: OrchestrationFlow,
	recovered: RecoverableSession,
	sessionManager: OrchestrationSessionManager,
	cascade: { budget: AggregateBudget; depth: number; abort: AbortSignal },
): Promise<OrchestrationRunResult> {
	return resumeRecoveredSession(plugin, flow, recovered, sessionManager, {
		budget: cascade.budget,
		depth: cascade.depth,
		abort: cascade.abort,
	});
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

// ---------------------------------------------------------------------------
// Interactive pause prompt (INT-030 / FR-150)
// ---------------------------------------------------------------------------

/**
 * The modal a paused flow surfaces to collect the user's answer. Resolves with
 * the entered text on submit, or `null` when the user dismisses/cancels (which
 * the runner finalizes via `FLOW_CANCELLED`). Resolves exactly once.
 */
class UserInputModal extends Modal {
	private settled = false;

	constructor(
		app: App,
		private readonly flowName: string,
		private readonly question: string,
		private readonly resolve: (value: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: `"${this.flowName}" needs your input` });
		contentEl.createEl("p", { text: this.question, cls: "setting-item-description" });

		const input = contentEl.createEl("textarea", { cls: "notor-orchestration-objective-input" });
		input.rows = 4;
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.submit(input.value.trim());
			}
		});

		const buttonRow = contentEl.createDiv({ cls: "modal-button-container" });
		new ButtonComponent(buttonRow).setButtonText("Cancel run").onClick(() => this.close());
		new ButtonComponent(buttonRow)
			.setButtonText("Submit")
			.setCta()
			.onClick(() => this.submit(input.value.trim()));

		setTimeout(() => input.focus(), 10);
	}

	onClose(): void {
		// Dismissed without submitting → the run cancels. (submit() settles first,
		// so a settled modal closing is a no-op.)
		this.settle(null);
	}

	private submit(value: string): void {
		if (!value) {
			new Notice("Enter a response, or cancel the run.");
			return;
		}
		this.settle(value);
		this.close();
	}

	private settle(value: string | null): void {
		if (this.settled) return;
		this.settled = true;
		this.resolve(value);
	}
}

/**
 * Surface the interactive-pause prompt and await the user's answer (INT-030).
 * Wired as the runner's `requestUserInput` callback; resolves with the entered
 * text or `null` on dismiss/cancel.
 */
function requestOrchestrationInput(
	app: App,
	flowName: string,
	question: string,
): Promise<string | null> {
	return new Promise((resolve) => {
		new UserInputModal(app, flowName, question, resolve).open();
	});
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
