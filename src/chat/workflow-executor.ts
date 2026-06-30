/**
 * Workflow execution — extracted from ChatOrchestrator (Phase B5).
 *
 * Owns foreground and background workflow execution, including the
 * background response loop. The orchestrator facade delegates to this
 * class; external callers are unaffected.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B5
 */

import { Notice } from "obsidian";
import type { App } from "obsidian";
import type {
	Conversation,
	ConversationMode,
	Persona,
	Workflow,
	WorkflowExecution,
	WorkflowExecutionRequest,
	WorkflowAssemblyResult,
	ExecutionChain,
} from "../types";
import { readChildRunMetadata } from "../types";
import type { ProviderRegistry } from "../providers/index";
import type { SystemPromptBuilder } from "./system-prompt";
import type { ToolDispatcher, ApprovalCallback, InteractionCallback } from "./dispatcher";
import type { HistoryManager } from "./history";
import type { ConversationManager } from "./conversation";
import type { NotorSettings } from "../settings";
import type { PersonaManager } from "../personas/persona-manager";
import type { WorkflowHookOverrideManager } from "../hooks/workflow-hook-override";
import { showOsNotification, revealChatPanel } from "../ui/os-notification";
import type { VaultRuleManager } from "../rules/vault-rules";
import type { ToolSessionContext } from "../tools/tool";
import type { TemplateVariableRegistry } from "../template-vars";
import type { SessionManager } from "./session-manager";
import type { ConfigResolver } from "./config-resolver";
import type { HookDispatcher } from "./hook-dispatcher";
import type { ViewRouter } from "./view-router";
import { ConversationSession } from "./conversation-session";
import { calculateCost, toChatMessages } from "./message-pipeline";
import { WorkflowConcurrencyManager } from "../workflows/workflow-concurrency";
import { parseStreamEvents } from "./stream-utils";
import { buildAutoContextBlock } from "../context/auto-context";
import { ContextManager } from "./context";
import {
	revertWorkflowPersona,
	switchWorkflowPersona,
	assembleWorkflowPrompt,
} from "../workflows/workflow-executor";
import { resolvePreset } from "../presets/preset-resolver";
import { logger } from "../utils/logger";
import { resolveNote } from "../utils/resolve-note";

const log = logger("WorkflowExecutor");

// ---------------------------------------------------------------------------
// Per-workflow preset resolution helper (Phase 4)
// ---------------------------------------------------------------------------

interface ResolvedProviderConfig {
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
	thinkingLevel: string | null;
}

function resolveWorkflowProviderConfig(
	workflow: Workflow,
	settings: NotorSettings,
	fallbackProviderId: string,
	fallbackModelId: string,
	fallbackExtendedContext: boolean,
	fallbackThinkingLevel: string | null,
): ResolvedProviderConfig {
	if (workflow.model_preset) {
		const resolved = resolvePreset(workflow.model_preset, settings.model_presets);
		if (resolved) {
			return {
				providerId: resolved.providerId,
				modelId: resolved.modelId,
				useExtendedContext: resolved.useExtendedContext,
				thinkingLevel: resolved.thinkingLevel,
			};
		}
		log.warn("Workflow model preset not found or unconfigured, using fallback", {
			preset: workflow.model_preset,
			workflowName: workflow.display_name,
		});
	}
	return {
		providerId: fallbackProviderId,
		modelId: fallbackModelId,
		useExtendedContext: fallbackExtendedContext,
		thinkingLevel: fallbackThinkingLevel,
	};
}

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/**
 * Dependencies injected from the orchestrator facade.
 *
 * Readonly singletons and extracted class references are stored directly.
 * Mutable orchestrator state is accessed via getter callbacks so the
 * WorkflowExecutor always reads the latest value at call time (same
 * pattern as HookDispatcher and CompactionManager).
 */
export interface WorkflowExecutorDeps {
	// Readonly singletons
	readonly app: App;
	readonly providerRegistry: ProviderRegistry;
	readonly systemPromptBuilder: SystemPromptBuilder;
	readonly dispatcher: ToolDispatcher;
	readonly historyManager: HistoryManager;

	// Already-extracted class references
	readonly sessionManager: SessionManager;
	readonly configResolver: ConfigResolver;
	readonly hookDispatcher: HookDispatcher;
	readonly viewRouter: ViewRouter;

	// Getter callbacks for mutable orchestrator state
	getSettings(): NotorSettings;
	getPersonaManager(): PersonaManager | undefined;
	getWorkflowHookOverrideManager(): WorkflowHookOverrideManager | undefined;
	getVaultRuleManager(): VaultRuleManager | undefined;
	getPanelApprovalCallback(): ApprovalCallback | undefined;
	getPanelInteractionCallback(): InteractionCallback | undefined;
	getConversationManager(): ConversationManager;
	getActiveProviderId(): string;
	getActiveModelId(): string;
	getActiveUseExtendedContext(): boolean;

	// Utility getters
	getVaultRootPath(): string | undefined;
	getTemplateRegistry(): TemplateVariableRegistry | undefined;
	getSessionContext(): ToolSessionContext;

	// Per-panel persona state
	getActivePersona(): Persona | null;
	setActivePersona(persona: Persona | null): void;

	// Orchestrator method bridges
	runSession(
		session: ConversationSession,
		mode: ConversationMode,
		opts?: { preLoop?: () => Promise<void> },
	): Promise<void>;
	setWorkflowPersonaRevert(prev: string | null | undefined): void;
	handleError(e: unknown): void;
}

// ---------------------------------------------------------------------------
// WorkflowExecutor
// ---------------------------------------------------------------------------

export class WorkflowExecutor {
	constructor(private readonly deps: WorkflowExecutorDeps) {}

	// -------------------------------------------------------------------
	// Foreground workflow execution (E-013)
	// -------------------------------------------------------------------

	/**
	 * Execute a workflow: assemble the prompt, switch persona, create a new
	 * conversation, add the assembled message, and start the LLM response loop.
	 *
	 * This is the convergence point for both command-palette and slash-command
	 * workflow triggers. Both paths produce a `Workflow` + optional
	 * supplementary text, which are passed here.
	 *
	 * Execution sequence:
	 * 1. Revert any existing workflow persona (leaving the previous conversation)
	 * 2. Switch to workflow persona if `workflow.persona_name` is set (E-007)
	 * 3. Assemble the workflow prompt via `assembleWorkflowPrompt()` (E-006)
	 * 4. If assembly returns null (empty guard), surface notice and abort
	 * 5. Create a new conversation with workflow metadata
	 * 6. Open the chat panel if not already visible
	 * 7. Store persona revert state (E-008)
	 * 8. Add the assembled message as the first user message (`is_workflow_message: true`)
	 * 9. Dispatch to the LLM via `responseLoop()`
	 *
	 * @param workflow - The discovered workflow to execute.
	 * @param supplementaryText - Optional user text from the slash-command input.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-013
	 */
	async executeWorkflow(workflow: Workflow, supplementaryText = ""): Promise<void> {
		return this._runWorkflowIntoConversation(workflow, supplementaryText, null);
	}

	/**
	 * Switch the current conversation to a different workflow mid-chat.
	 *
	 * Applies the workflow *fully* into the existing conversation — its tool
	 * configs, persona, provider/model, and hook overrides — and injects its
	 * assembled prompt as the next user turn, WITHOUT creating a new
	 * conversation. Rejected (with a Notice) when the conversation is already
	 * processing a message, so we never half-apply a workflow that can't run.
	 *
	 * Wired from the workflow chip's context menu.
	 */
	async switchWorkflow(workflow: Workflow, supplementaryText = ""): Promise<void> {
		const conversationManager = this.deps.getConversationManager();
		const active = conversationManager.getActiveConversation();
		if (!active) {
			new Notice("No active conversation to switch.");
			return;
		}
		// Guard FIRST — before any persona switch, assembly, or header mutation —
		// so a blocked switch leaves the conversation completely untouched.
		const guardError = this.deps.sessionManager.checkSessionGuards(active.id);
		if (guardError) {
			new Notice(guardError);
			return;
		}
		return this._runWorkflowIntoConversation(workflow, supplementaryText, active.id);
	}

	/**
	 * Shared workflow-execution body for both the new-conversation path
	 * (`targetConversationId === null`) and the switch-into-existing path
	 * (`targetConversationId` set).
	 *
	 * With a null target this is byte-for-byte the original `executeWorkflow`
	 * behavior. The `isExisting` branches diverge only where they must: reuse
	 * vs. create the conversation, append vs. clear messages, persona-revert
	 * bookkeeping, and clearing a prior workflow's hooks.
	 */
	private async _runWorkflowIntoConversation(
		workflow: Workflow,
		supplementaryText: string,
		targetConversationId: string | null,
	): Promise<void> {
		const isExisting = targetConversationId !== null;
		log.info("Executing workflow", {
			display_name: workflow.display_name,
			file_path: workflow.file_path,
			persona_name: workflow.persona_name,
			into_existing: isExisting,
		});

		const personaManager = this.deps.getPersonaManager();

		// Step 2: Switch persona if the workflow specifies one
		let personaSwitchResult: { switched: boolean; previousPersona: string | null } = {
			switched: false,
			previousPersona: null,
		};

		if (workflow.persona_name && personaManager) {
			try {
				personaSwitchResult = await switchWorkflowPersona(
					workflow.persona_name,
					personaManager,
					(p) => this.deps.setActivePersona(p),
				);
			} catch (e) {
				log.error("Persona switch failed before workflow execution", {
					personaName: workflow.persona_name,
					error: String(e),
				});
				// Non-fatal — continue with current persona
			}
		}

		// Step 3: Assemble the workflow prompt
		let assemblyResult;
		try {
			assemblyResult = await assembleWorkflowPrompt(
				{
					workflow,
					supplementaryText: supplementaryText || null,
					triggerContext: null, // manual execution — no trigger context
				},
				this.deps.app.vault,
				this.deps.app.metadataCache,
				this.deps.getTemplateRegistry(),
			);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Workflow prompt assembly failed", { error: errMsg });
			new Notice(`Workflow execution failed: ${errMsg}`);
			// Revert persona if we switched it
			if (personaSwitchResult.switched && personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager, (p) => this.deps.setActivePersona(p));
			}
			return;
		}

		// Step 4: Empty guard — assembleWorkflowPrompt returns null and surfaces Notice itself
		if (assemblyResult === null) {
			// Revert persona if we switched it
			if (personaSwitchResult.switched && personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager, (p) => this.deps.setActivePersona(p));
			}
			return;
		}

		// Step 5: Create a new conversation with workflow metadata
		// (This also calls maybeRevertWorkflowPersona for the *previous* conversation
		// via the E-008 path — we intentionally skip that here because we already
		// handled persona switching above before creating the new conversation.)
		const conversationManager = this.deps.getConversationManager();
		const fallbackProviderId = this.deps.getActiveProviderId();
		const fallbackConfig = this.deps.providerRegistry.getConfig(fallbackProviderId);
		const { providerId, modelId, useExtendedContext, thinkingLevel } = resolveWorkflowProviderConfig(
			workflow,
			this.deps.getSettings(),
			fallbackProviderId,
			this.deps.getActiveModelId(),
			fallbackConfig?.use_extended_context ?? false,
			null,
		);
		const currentMode = workflow.mode
			?? (conversationManager.hasActiveConversation()
				? conversationManager.getMode()
				: this.deps.getSettings().mode);

		// Determine the active persona name after any switch
		const activePersonaName = personaManager?.getActivePersona()?.name ?? null;

		const view = this.deps.viewRouter.getView();
		let conversation: Conversation;
		if (isExisting) {
			// Switch path: reuse the active conversation. Mutate its workflow
			// metadata (and provider/model/persona/mode per "full workflow") in
			// place so the snapshot below and follow-up turns see the new state;
			// do NOT create a file or clear the visible message history. Load the
			// mutated clone back (silent) so the in-memory conversation reflects
			// it, then persist the header once.
			const active = conversationManager.getActiveConversation()!;
			active.workflow_path = workflow.file_path;
			active.workflow_name = workflow.display_name;
			active.workflow_tool_configs = assemblyResult.toolConfigs;
			active.workflow_deactivated = false;
			active.persona_name = activePersonaName;
			active.provider_id = providerId;
			active.model_id = modelId;
			active.use_extended_context = useExtendedContext;
			if (workflow.mode) active.mode = workflow.mode;
			conversationManager.loadConversation(active, conversationManager.getMessages(), { silent: true });
			await this.deps.historyManager.updateConversationHeader(active);
			conversation = active;
			if (workflow.mode) view?.updateModeDisplay(conversation.mode);
			// Reflect the applied provider/model/persona in the panel UI.
			view?.updateProviderDisplay(providerId);
			view?.updateModelDisplay(useExtendedContext ? `${modelId}::1m` : modelId);
			view?.updatePersonaLabel(this.deps.getActivePersona());
			view?.updateWorkflowLabel(conversation);
		} else {
			// Step 5: Create a new conversation with workflow metadata
			// (This also calls maybeRevertWorkflowPersona for the *previous* conversation
			// via the E-008 path — we intentionally skip that here because we already
			// handled persona switching above before creating the new conversation.)
			conversation = conversationManager.createConversation(
				providerId,
				modelId,
				currentMode,
				{
					workflow_path: workflow.file_path,
					workflow_name: workflow.display_name,
					workflow_tool_configs: assemblyResult.toolConfigs,
					persona_name: activePersonaName,
					is_background: false,
					title: `Workflow: ${workflow.display_name}`,
					use_extended_context: useExtendedContext,
				}
			);

			await this.deps.historyManager.createConversationFile(conversation);

			view?.clearMessages();
			view?.updateModeDisplay(conversation.mode);
			view?.updateWorkflowLabel(conversation);
		}

		// Step 7: Store persona revert state for E-008. Only for the
		// new-conversation path — a mid-conversation switch must not clobber the
		// original conversation's revert slot, and its persona now persists in
		// the conversation header.
		if (!isExisting) {
			if (personaSwitchResult.switched) {
				this.deps.setWorkflowPersonaRevert(personaSwitchResult.previousPersona);
			} else {
				// No switch performed — clear any stale revert state from a previous workflow
				this.deps.setWorkflowPersonaRevert(undefined);
			}
		}

		// Step 8: Add the assembled message as the first user message
		const userMessage = conversationManager.addMessage({
			role: "user",
			content: assemblyResult.assembledMessage,
			is_workflow_message: true,
		});

		view?.renderUserMessage(userMessage);

		log.info("Workflow conversation created", {
			conversation_id: conversation.id,
			workflow_name: workflow.display_name,
			assembled_length: assemblyResult.assembledMessage.length,
		});

		// --- Create isolated ConversationSession for the workflow ---

		// Session guards: prevent duplicate sessions per-orchestrator and cross-orchestrator
		const guardError = this.deps.sessionManager.checkSessionGuards(conversation.id);
		if (guardError) {
			new Notice(guardError);
			return;
		}

		const snapshotConv = conversationManager.getActiveConversation()!;
		const snapshotMessages = conversationManager.getMessages();

		const { ConversationManager: ConvManagerClass } = await import("./conversation");
		const sessionConvManager = new ConvManagerClass(currentMode);

		sessionConvManager.setOnMessageAdded(async (message) => {
			const sessionConv = sessionConvManager.getActiveConversation();
			if (sessionConv) {
				await this.deps.historyManager.appendMessage(sessionConv, message);
			}
		});
		sessionConvManager.setOnConversationChanged(async (sessionConv) => {
			await this.deps.historyManager.updateConversationHeader(sessionConv);
		});

		sessionConvManager.loadConversation(snapshotConv, snapshotMessages);

		const pinnedPersona = this.deps.getActivePersona();

		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.deps.configResolver.resolveEffectiveConfig(undefined, assemblyResult, pinnedPersona);

		const approvalCallback: ApprovalCallback = this.deps.getPanelApprovalCallback()
			?? (async () => "approved" as const);

		// A manual workflow runs through the real (UI-bound) response loop, so it
		// must carry the panel's interaction callback — otherwise tools like
		// ask_user have no channel to render their prompt and error out. Mirrors
		// ChatOrchestrator.handleUserMessage, which snapshots the same callback.
		const interactionCallback = this.deps.getPanelInteractionCallback();

		const session = new ConversationSession({
			conversationId: conversation.id,
			conversationManager: sessionConvManager,
			abortController: new AbortController(),
			title: conversation.title ?? `Workflow: ${workflow.display_name}`,
			pinnedPersona,
			providerId,
			modelId,
			useExtendedContext,
			thinkingLevel,
			workflowAssembly: assemblyResult,
			approvalCallback,
			interactionCallback,
			initialConfig,
			initialParsedConfigs,
		});

		// Step 10: Run the session through the orchestrator's canonical lifecycle
		// (register → run → flush → sync-back → hook-deactivate → unregister).
		// Delegating to runSession() — rather than reimplementing the lifecycle
		// here — guarantees the manual-workflow path can never again drift from
		// the display sync-back that keeps follow-up turns attached to this
		// conversation. Hook *activation* is workflow-specific, so it runs in the
		// preLoop hook (after registration, before the first LLM call).
		await this.deps.runSession(session, currentMode, {
			preLoop: async () => {
				// G-006: Activate workflow-scoped hook overrides before the first
				// LLM call. activate() is last-write-wins, so switching cleanly
				// replaces a prior workflow's hooks. When switching to a workflow
				// with NO hooks, the prior override must be explicitly cleared
				// (deactivate is idempotent). runSession()'s finally performs the
				// matching deactivate() on all exit paths.
				const whOverrideManager = this.deps.getWorkflowHookOverrideManager();
				if (whOverrideManager) {
					if (workflow.hooks) {
						whOverrideManager.activate(conversation.id, workflow.hooks);
						log.info("Workflow hook overrides activated for manual execution", {
							conversationId: conversation.id,
							events: Object.keys(workflow.hooks),
						});
					} else if (isExisting) {
						whOverrideManager.deactivate(conversation.id);
					}
				}
			},
		});
	}

	// -------------------------------------------------------------------
	// Step→workflow invocation (INT-031 / FR-151)
	// -------------------------------------------------------------------

	/**
	 * Run a named single-turn workflow **headlessly** and await its final
	 * assistant text + total spend (INT-031 / FR-151). This is the seam an
	 * orchestration conversation step uses to delegate a well-bounded sub-task to
	 * an existing workflow and fold the result back into its own turn.
	 *
	 * **Wraps, does not modify, the background loop.** It drives the *existing*
	 * private {@link _backgroundResponseLoop} (the one-tool-at-a-time
	 * `while(continueLoop)` loop) with a throwaway {@link WorkflowExecution} and a
	 * **local** {@link WorkflowConcurrencyManager} — so the live background-workflow
	 * path's signature and behavior are untouched (Phase 7 owns generalizing the
	 * loop, not INT-031). After the loop settles it reads the workflow's cumulative
	 * `total_output_tokens` / `estimated_cost` off the isolated background
	 * conversation and derives the iteration count from the assistant turns. The
	 * returned `{ text, costUsd, iterations }` feeds both the step-context fold and
	 * the caller's post-hoc aggregate-budget reconciliation (`decrementAggregate`).
	 *
	 * Budget note (FR-151 / Issue-13h): the invoked workflow runs **uncapped**
	 * during the call — the background loop has no per-run iteration/cost cap and
	 * no `RunContext` — so the aggregate overshoot is **unbounded** (a whole
	 * workflow run). Reconciliation is the caller's responsibility at the
	 * await-result boundary; this method only reports the spend.
	 *
	 * @param workflow            - The resolved workflow to run (via `discoverWorkflows`).
	 * @param supplementaryText   - The step's task/direction folded into the prompt.
	 * @returns The workflow's final assistant text + total cost/iterations.
	 *
	 * @see specs/ZZ-misc/orchestration/tasks/phase-5-interactive-workflow.md — INT-031
	 */
	async runWorkflowHeadless(
		workflow: Workflow,
		supplementaryText: string,
	): Promise<{ text: string; costUsd: number; iterations: number }> {
		const personaManager = this.deps.getPersonaManager();

		// Assemble the workflow prompt via the SHARED assembly path (no duplicate
		// prompt-assembly logic — reuses src/workflows/workflow-executor.ts).
		const assemblyResult = await assembleWorkflowPrompt(
			{
				workflow,
				supplementaryText: supplementaryText || null,
				triggerContext: null,
			},
			this.deps.app.vault,
			this.deps.app.metadataCache,
			this.deps.getTemplateRegistry(),
		);
		if (assemblyResult === null) {
			throw new Error(`Workflow '${workflow.display_name}' has no prompt content.`);
		}

		// Resolve provider/model exactly as the background path (preset → fallback).
		const mode = workflow.mode ?? this.deps.getSettings().mode;
		const registryProviderId = this.deps.providerRegistry.getActiveId();
		const registryConfig = this.deps.providerRegistry.getConfig(registryProviderId);
		const { providerId, modelId, useExtendedContext, thinkingLevel } = resolveWorkflowProviderConfig(
			workflow,
			this.deps.getSettings(),
			registryProviderId,
			registryConfig?.model_id ?? "",
			registryConfig?.use_extended_context ?? false,
			null,
		);

		const activePersonaName = personaManager?.getActivePersona()?.name ?? null;

		// Isolated background conversation manager (never touches the user's panel).
		const { ConversationManager } = await import("./conversation");
		const bgConversationManager = new ConversationManager(mode);
		bgConversationManager.setOnMessageAdded(async (message) => {
			const conv = bgConversationManager.getActiveConversation();
			if (conv) {
				await this.deps.historyManager.appendMessage(conv, message);
			}
		});
		bgConversationManager.setOnConversationChanged(async (conv) => {
			await this.deps.historyManager.updateConversationHeader(conv);
		});

		const bgConversation = bgConversationManager.createConversation(providerId, modelId, mode, {
			workflow_path: workflow.file_path,
			workflow_name: workflow.display_name,
			workflow_tool_configs: assemblyResult.toolConfigs,
			persona_name: activePersonaName,
			is_background: true,
			title: `Step→workflow: ${workflow.display_name}`,
			use_extended_context: useExtendedContext,
		});
		await this.deps.historyManager.createConversationFile(bgConversation);

		bgConversationManager.addMessage({
			role: "user",
			content: assemblyResult.assembledMessage,
			is_workflow_message: true,
		});

		// A throwaway execution + LOCAL concurrency manager so the shared
		// _backgroundResponseLoop runs unchanged without touching the global
		// background-workflow pool (liveness/status updates land on this manager
		// and are discarded). onComplete/submit are NOT called — the loop only
		// uses markStreaming/touchStreamActivity/updateStatus/markInToolCall.
		const execution: WorkflowExecution = {
			id: crypto.randomUUID(),
			workflow_path: workflow.file_path,
			workflow_name: workflow.display_name,
			conversation_id: bgConversation.id,
			trigger_event: "step_workflow_invocation",
			trigger_source: null,
			status: "running",
			started_at: new Date().toISOString(),
			completed_at: null,
			error_message: null,
		};
		const localConcurrency = new WorkflowConcurrencyManager(1);
		const chain: ExecutionChain = { sourceHooks: new Set(), modifiedNotePaths: new Set() };

		// G-007 parity: activate workflow-scoped hook overrides for this run, then
		// always deactivate (mirrors executeBackgroundWorkflow's finally).
		const whOverrideManager = this.deps.getWorkflowHookOverrideManager();
		if (workflow.hooks && whOverrideManager) {
			whOverrideManager.activate(bgConversation.id, workflow.hooks);
		}

		const pinnedPersona = this.deps.getActivePersona();
		try {
			await this._backgroundResponseLoop(
				bgConversationManager,
				assemblyResult,
				mode,
				execution,
				localConcurrency,
				chain,
				providerId,
				modelId,
				useExtendedContext,
				thinkingLevel,
				pinnedPersona,
			);
		} finally {
			if (whOverrideManager) {
				whOverrideManager.deactivate(bgConversation.id);
			}
		}

		// Read the workflow's cumulative spend off the settled background
		// conversation (the per-turn rollup the loop already maintains), and the
		// final assistant text. Iterations = assistant turns (LLM turns).
		const settled = bgConversationManager.getActiveConversation();
		const messages = bgConversationManager.getMessages();
		const finalText = [...messages]
			.reverse()
			.find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.length > 0)
			?.content as string | undefined;
		const iterations = messages.filter((m) => m.role === "assistant").length;
		const costUsd =
			settled?.estimated_cost
			?? calculateCost(
				settled?.total_input_tokens ?? 0,
				settled?.total_output_tokens ?? 0,
				modelId,
				this.deps.getSettings(),
			)
			?? 0;

		return { text: finalText ?? "", costUsd, iterations };
	}

	// -------------------------------------------------------------------
	// Background workflow execution (F-021)
	// -------------------------------------------------------------------

	/**
	 * Execute a workflow in the background (event-triggered).
	 *
	 * Creates a background conversation, sends the assembled prompt, and runs
	 * the LLM response loop independently of the main chat panel. The user's
	 * active conversation is never disturbed.
	 *
	 * Execution sequence:
	 * 1. Create a background conversation (`is_background: true`) with workflow metadata
	 * 2. Update execution record with the new conversation ID
	 * 3. Add the assembled prompt as the first user message (`is_workflow_message: true`)
	 * 4. Run the response loop in the background
	 * 5. Surface a completion/failure Notice
	 * 6. Call `concurrencyManager.onComplete()` in the finally block
	 *
	 * When a tool call requires approval, the execution status is updated to
	 * `"waiting_approval"` via `concurrencyManager.updateStatus()`.
	 *
	 * @param request            - The workflow execution request (workflow + trigger context).
	 * @param execution          - The execution tracking record (from F-020).
	 * @param chain              - Execution chain for loop prevention.
	 * @param concurrencyManager - Manager to call `onComplete()` when done.
	 * @param personaSwitchResult - Result of any persona switch performed before submission.
	 *
	 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-021
	 */
	async executeBackgroundWorkflow(
		request: WorkflowExecutionRequest,
		execution: WorkflowExecution,
		chain: ExecutionChain,
		concurrencyManager: WorkflowConcurrencyManager,
		personaSwitchResult: { switched: boolean; previousPersona: string | null }
	): Promise<void> {
		const { workflow, supplementaryText, triggerContext } = request;

		log.info("Starting background workflow execution", {
			executionId: execution.id,
			workflowName: workflow.display_name,
			hookEvent: triggerContext?.event,
		});

		const personaManager = this.deps.getPersonaManager();

		// Step 1: Assemble the workflow prompt (re-assemble here to get the
		// assembled message string; the dispatcher already validated it is non-null)
		let assemblyResult;
		try {
			assemblyResult = await assembleWorkflowPrompt(
				{
					workflow,
					supplementaryText: supplementaryText ?? null,
					triggerContext: triggerContext ?? null,
				},
				this.deps.app.vault,
				this.deps.app.metadataCache,
				this.deps.getTemplateRegistry(),
			);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Background workflow prompt assembly failed", {
				executionId: execution.id,
				error: errMsg,
			});
			concurrencyManager.onComplete(execution.id, "errored", errMsg);
			new Notice(`Workflow '${workflow.display_name}' failed: ${errMsg}`);
			// Revert persona if we switched it
			if (personaSwitchResult.switched && personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager, (p) => this.deps.setActivePersona(p));
			}
			return;
		}

		if (assemblyResult === null) {
			// Empty guard: Notice already surfaced by assembleWorkflowPrompt
			log.warn("Background workflow assembly returned null", {
				executionId: execution.id,
			});
			concurrencyManager.onComplete(execution.id, "errored", "Workflow has no prompt content");
			if (personaSwitchResult.switched && personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager, (p) => this.deps.setActivePersona(p));
			}
			return;
		}

		// Step 2: Create a background conversation (does NOT switch the user's
		// active conversation — we operate on a separate ConversationManager instance
		// scoped to this background execution).
		const mode = workflow.mode ?? this.deps.getSettings().mode;
		const registryProviderId = this.deps.providerRegistry.getActiveId();
		const registryConfig = this.deps.providerRegistry.getConfig(registryProviderId);
		const { providerId, modelId, useExtendedContext, thinkingLevel } = resolveWorkflowProviderConfig(
			workflow,
			this.deps.getSettings(),
			registryProviderId,
			registryConfig?.model_id ?? "",
			registryConfig?.use_extended_context ?? false,
			null,
		);

		// Determine the active persona name after any switch
		const activePersonaName = personaManager?.getActivePersona()?.name ?? null;

		// Create a dedicated ConversationManager for this background execution
		// so it runs fully isolated from the main chat panel's state.
		const { ConversationManager } = await import("./conversation");
		const bgConversationManager = new ConversationManager(mode);

		// Wire persistence callbacks (same pattern as the main orchestrator)
		bgConversationManager.setOnMessageAdded(async (message) => {
			const conv = bgConversationManager.getActiveConversation();
			if (conv) {
				await this.deps.historyManager.appendMessage(conv, message);
			}
		});
		bgConversationManager.setOnConversationChanged(async (conv) => {
			await this.deps.historyManager.updateConversationHeader(conv);
		});

		const bgConversation = bgConversationManager.createConversation(
			providerId,
			modelId,
			mode,
			{
				workflow_path: workflow.file_path,
				workflow_name: workflow.display_name,
				workflow_tool_configs: assemblyResult.toolConfigs,
				persona_name: activePersonaName,
				is_background: true,
				title: `Workflow: ${workflow.display_name}`,
				use_extended_context: useExtendedContext,
			}
		);

		await this.deps.historyManager.createConversationFile(bgConversation);

		// Step 3: Update execution record with conversation ID
		execution.conversation_id = bgConversation.id;

		// Step 4: Add the assembled message as the first user message
		bgConversationManager.addMessage({
			role: "user",
			content: assemblyResult.assembledMessage,
			is_workflow_message: true,
		});

		log.info("Background workflow conversation created", {
			conversationId: bgConversation.id,
			workflowName: workflow.display_name,
		});

		// G-007: Activate workflow-scoped hook overrides before the first LLM call
		const whOverrideManager = this.deps.getWorkflowHookOverrideManager();
		if (workflow.hooks && whOverrideManager) {
			whOverrideManager.activate(bgConversation.id, workflow.hooks);
			log.info("Workflow hook overrides activated for background execution", {
				conversationId: bgConversation.id,
				events: Object.keys(workflow.hooks),
			});
		}

		// Step 5: Run the response loop (no view — background execution)
		// We build a self-contained response loop using the background conversation manager.
		const pinnedPersona = this.deps.getActivePersona();
		let finalStatus: "completed" | "errored" | "stopped" = "completed";
		let errorMessage: string | undefined;

		try {
			await this._backgroundResponseLoop(
				bgConversationManager,
				assemblyResult,
				mode,
				execution,
				concurrencyManager,
				chain,
				providerId,
				modelId,
				useExtendedContext,
				thinkingLevel,
				pinnedPersona
			);
		} catch (e) {
			const errMsg = e instanceof Error ? e.message : String(e);
			log.error("Background workflow response loop error", {
				executionId: execution.id,
				error: errMsg,
			});
			finalStatus = "errored";
			errorMessage = errMsg;
		} finally {
			// G-005: Deactivate workflow-scoped hook overrides on all exit paths
			// This runs before concurrencyManager.onComplete() so the override is
			// always cleared even if onComplete() throws.
			const whm = this.deps.getWorkflowHookOverrideManager();
			if (whm) {
				whm.deactivate(bgConversation.id);
			}

			// Step 6: Mark completion
			concurrencyManager.onComplete(execution.id, finalStatus, errorMessage);

			if (finalStatus === "completed") {
				log.info("Background workflow completed", {
					executionId: execution.id,
					workflowName: workflow.display_name,
				});
				new Notice(`Workflow '${workflow.display_name}' completed.`);
				showOsNotification(this.deps.getSettings(), {
					kind: "workflow_complete",
					title: "Notor — Workflow completed",
					body: workflow.display_name,
					onClick: () => revealChatPanel(this.deps.app),
				});
			} else if (finalStatus === "errored") {
				new Notice(`Workflow '${workflow.display_name}' failed: ${errorMessage ?? "Unknown error"}`);
				showOsNotification(this.deps.getSettings(), {
					kind: "error",
					title: "Notor — Workflow failed",
					body: `${workflow.display_name}: ${errorMessage ?? "Unknown error"}`,
					onClick: () => revealChatPanel(this.deps.app),
				});
			}

			// Revert persona if we switched it — scoped to this background execution
			if (personaSwitchResult.switched && personaManager) {
				try {
					await revertWorkflowPersona(
						personaSwitchResult.previousPersona,
						personaManager,
						(p) => this.deps.setActivePersona(p),
					);
				} catch (e) {
					log.error("Failed to revert workflow persona after background execution", {
						error: String(e),
					});
				}
			}
		}
	}

	// -------------------------------------------------------------------
	// Background response loop
	// -------------------------------------------------------------------

	/**
	 * Background response loop — drives LLM turns for a background workflow
	 * execution without touching the main chat panel UI.
	 *
	 * Mirrors `responseLoop()` but operates on the provided background
	 * `ConversationManager` and never renders to the view.
	 */
	private async _backgroundResponseLoop(
		bgConvManager: ConversationManager,
		workflowAssembly: WorkflowAssemblyResult,
		mode: ConversationMode,
		execution: WorkflowExecution,
		concurrencyManager: WorkflowConcurrencyManager,
		_chain: ExecutionChain,
		providerId: string,
		modelId: string,
		useExtendedContext: boolean,
		thinkingLevel: string | null,
		pinnedPersona: Persona | null
	): Promise<void> {
		let continueLoop = true;
		const vaultRootPath = this.deps.getVaultRootPath();

		// Resolve initial effective config
		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.deps.configResolver.resolveEffectiveConfig(undefined, workflowAssembly, pinnedPersona);

		// Capture approval callback for session-scoped dispatch
		const approvalCallback = this.deps.getPanelApprovalCallback()
			?? (async () => "approved" as const);

		const bgConv = bgConvManager.getActiveConversation()!;
		const session = new ConversationSession({
			conversationId: bgConv.id,
			conversationManager: bgConvManager,
			abortController: new AbortController(),
			title: bgConv.title ?? `Workflow: ${execution.id}`,
			pinnedPersona,
			providerId,
			modelId,
			useExtendedContext,
			thinkingLevel,
			workflowAssembly,
			approvalCallback,
			initialConfig,
			initialParsedConfigs,
		});

		try {
		while (continueLoop) {
			continueLoop = false;

			// 1. Evaluate vault rules + resolve effective tool config
			const vaultRuleManager = this.deps.getVaultRuleManager();
			const matchedRules = vaultRuleManager
				? await vaultRuleManager.getMatchedRules()
				: undefined;

			const { effective, toolDefinitions, parsedConfigs } =
				await this.deps.configResolver.resolveEffectiveConfig(matchedRules, session.workflowAssembly, session.pinnedPersona);
			session.effectiveConfig = effective;
			session.parsedConfigs = parsedConfigs;

			const autoContext = buildAutoContextBlock(this.deps.app, this.deps.getSettings());
			const systemPrompt = await this.deps.systemPromptBuilder.assemble(
				mode,
				toolDefinitions,
				undefined, // vaultRuleContent — now handled via cached stripped content
				autoContext ?? undefined,
				session.pinnedPersona,
				this.deps.getSettings().memory_enabled,
			);

			// 2. Assemble messages
			const allMessages = bgConvManager.getMessages();
			const hasSystemMessage = allMessages.some((m) => m.role === "system");
			if (!hasSystemMessage) {
				allMessages.unshift({
					id: "system",
					conversation_id: bgConvManager.getActiveConversation()!.id,
					role: "system",
					content: systemPrompt,
					timestamp: new Date().toISOString(),
				});
			}

			// 3. Assemble context window
			const contextMgr = new ContextManager();
			const contextResult = contextMgr.assembleContextWindow(allMessages, session.modelId, session.useExtendedContext);

			// 4. Convert to ChatMessage format
			const chatMessages = toChatMessages(
				contextResult.messages,
				systemPrompt
			);

			// 5. Send to LLM
			const abortController = new AbortController();
			// Register liveness for this stream iteration so the sleep/wake
			// reconciler can tell a frozen socket apart from a busy tool call.
			concurrencyManager.markStreaming(execution.id, abortController);
			const provider = this.deps.providerRegistry.getProvider(session.providerId);
			const stream = provider.sendMessage(chatMessages, toolDefinitions, {
				model: session.modelId,
				abort_signal: abortController.signal,
				use_extended_context: session.useExtendedContext,
			});

			// 6. Process stream (background — no UI rendering)
			let textContent = "";
			let inputTokens = 0;
			let outputTokens = 0;
			let toolCallId = "";
			let toolName = "";
			let parameters: Record<string, unknown> = {};
			let hasToolCall = false;

			for await (const event of parseStreamEvents(stream, abortController.signal, {
				onPartialToolCall: this.deps.dispatcher.makePartialToolCallHandler(),
			})) {
				// Every event proves the stream socket is alive — stamp it so a
				// post-sleep reconciliation doesn't clear an actively-streaming run.
				concurrencyManager.touchStreamActivity(execution.id);
				switch (event.type) {
					case "text_delta":
						textContent = event.text;
						break;
					case "tool_call":
						hasToolCall = true;
						toolCallId = event.id;
						toolName = event.name;
						parameters = event.parameters;
						// Background loop handles one tool call at a time
						break;
					case "message_end":
						inputTokens = event.inputTokens;
						outputTokens = event.outputTokens;
						break;
					case "error":
						throw new Error(event.message);
					case "cancelled":
						// Abort — exit the loop
						break;
				}
				// Background loop breaks after the first tool call
				if (hasToolCall) break;
			}

			if (hasToolCall) {
				// Add tool call message
				const toolCallMessage = bgConvManager.addMessage({
					role: "tool_call",
					content: "",
					tool_call: {
						id: toolCallId,
						tool_name: toolName,
						parameters,
						status: "pending",
					},
				});

				// Update status to waiting_approval if the tool is not auto-approved
				const isAutoApproved = session.effectiveConfig.tools[toolName]?.auto_approve ?? false;

				if (!isAutoApproved) {
					concurrencyManager.updateStatus(execution.id, "waiting_approval");
					log.info("Background workflow waiting for tool approval", {
						executionId: execution.id,
						toolName,
					});
				}

				// Entering a (possibly long-running) tool call — the reconciler
				// must never clear an execution in this phase.
				concurrencyManager.markInToolCall(execution.id);

				// Dispatch the tool with session-scoped policy context and approval
				const policyCtx = vaultRootPath
					? session.buildPolicyContext(this.deps.getSettings(), vaultRootPath, (path: string) => {
						const file = resolveNote(path, this.deps.app.vault, this.deps.app.metadataCache);
						return file?.path ?? null;
					})
					: undefined;
				// Approval-required hooks can still gate background tool calls. There
				// is no interaction channel in a headless run, so interactionCallback
				// is intentionally left undefined (ask_user errors out cleanly).
				const bgConvForApprovalHook = bgConvManager.getActiveConversation();
				const approvalHookFn = bgConvForApprovalHook
					? async (tn: string, params: Record<string, unknown>, m: string) =>
						this.deps.hookDispatcher.dispatchApprovalRequiredHook(bgConvForApprovalHook.id, tn, params, m)
					: undefined;
				const toolResult = await this.deps.dispatcher.dispatch(
					toolName,
					parameters,
					mode,
					toolCallMessage.id,
					undefined, // abortSignal
					undefined, // onProgress
					policyCtx,
					session.approvalCallback,
					this.deps.getSessionContext(), // sessionContext (A4.4e)
					approvalHookFn,
					undefined, // interactionCallback — headless, no UI channel
				);
				toolResult.tool_call_id = toolCallId;

				// Restore running status after approval/execution
				if (!isAutoApproved) {
					concurrencyManager.updateStatus(execution.id, "running");
				}

				// Dispatch hook events if applicable
				const bgConvForHooks = bgConvManager.getActiveConversation();
				if (bgConvForHooks) {
					this.deps.hookDispatcher.dispatchToolCallHook(bgConvForHooks.id, toolName, parameters);
					this.deps.hookDispatcher.dispatchToolResultHook(bgConvForHooks.id, toolName, parameters, toolResult);
				}

				// Add tool result message
				bgConvManager.addMessage({
					role: "tool_result",
					content: "",
					tool_result: toolResult,
				});

				// Roll up child-run tokens (sub-agent OR run_flow child subtree) into
				// conversation totals without inflating per-message estimates (which
				// would cause premature compaction/truncation). Tolerates the legacy
				// sub_agent_metadata key (INT-047).
				const bgChildTokens = readChildRunMetadata(toolResult)?.token_usage;
				if (bgChildTokens) {
					bgConvManager.addTokens(bgChildTokens.input, bgChildTokens.output);
				}

				// Add token tracking message if available
				if (inputTokens || outputTokens) {
					bgConvManager.addMessage({
						role: "assistant",
						content: textContent || "",
						input_tokens: inputTokens,
						output_tokens: outputTokens,
					});
				}

				// Update token footer after background tool result token rollup
				const bgConvForFooter = bgConvManager.getActiveConversation();
				if (bgConvForFooter) {
					this.deps.viewRouter.getView()?.updateTokenFooter(
						bgConvManager.getCurrentContextUsage().contextTokens,
						bgConvForFooter.total_output_tokens,
						bgConvForFooter.estimated_cost
					);
				}

				// Continue the loop
				continueLoop = true;
			} else {
				// Final text response
				bgConvManager.addMessage({
					role: "assistant",
					content: textContent,
					input_tokens: inputTokens,
					output_tokens: outputTokens,
				});
			}
		}
		} finally {
			// No cleanup needed — session is local to this method and not
			// registered in activeSessions (background workflows are tracked
			// by WorkflowConcurrencyManager instead).
		}
	}
}
