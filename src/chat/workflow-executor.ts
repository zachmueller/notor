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
	ConversationMode,
	Persona,
	Workflow,
	WorkflowExecution,
	WorkflowExecutionRequest,
	WorkflowAssemblyResult,
	ExecutionChain,
} from "../types";
import type { ProviderRegistry } from "../providers/index";
import type { SystemPromptBuilder } from "./system-prompt";
import type { ToolDispatcher, ApprovalCallback } from "./dispatcher";
import type { HistoryManager } from "./history";
import type { ConversationManager } from "./conversation";
import type { NotorSettings } from "../settings";
import type { PersonaManager } from "../personas/persona-manager";
import type { WorkflowHookOverrideManager } from "../hooks/workflow-hook-override";
import type { VaultRuleManager } from "../rules/vault-rules";
import type { WorkflowConcurrencyManager } from "../workflows/workflow-concurrency";
import type { ToolSessionContext } from "../tools/tool";
import type { TemplateVariableRegistry } from "../template-vars";
import type { SessionManager } from "./session-manager";
import type { ConfigResolver } from "./config-resolver";
import type { HookDispatcher } from "./hook-dispatcher";
import type { ViewRouter } from "./view-router";
import { ConversationSession } from "./conversation-session";
import { toChatMessages } from "./message-pipeline";
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

const log = logger("WorkflowExecutor");

// ---------------------------------------------------------------------------
// Per-workflow preset resolution helper (Phase 4)
// ---------------------------------------------------------------------------

interface ResolvedProviderConfig {
	providerId: string;
	modelId: string;
	useExtendedContext: boolean;
}

function resolveWorkflowProviderConfig(
	workflow: Workflow,
	settings: NotorSettings,
	fallbackProviderId: string,
	fallbackModelId: string,
	fallbackExtendedContext: boolean,
): ResolvedProviderConfig {
	if (workflow.model_preset) {
		const resolved = resolvePreset(workflow.model_preset, settings.model_presets);
		if (resolved) {
			return {
				providerId: resolved.providerId,
				modelId: resolved.modelId,
				useExtendedContext: resolved.useExtendedContext,
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
	getConversationManager(): ConversationManager;
	getActiveProviderId(): string;
	getActiveModelId(): string;
	getActiveUseExtendedContext(): boolean;

	// Utility getters
	getVaultRootPath(): string | undefined;
	getTemplateRegistry(): TemplateVariableRegistry | undefined;
	getSessionContext(): ToolSessionContext;

	// Orchestrator method bridges
	runResponseLoop(mode: ConversationMode, session: ConversationSession): Promise<void>;
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
		log.info("Executing workflow", {
			display_name: workflow.display_name,
			file_path: workflow.file_path,
			persona_name: workflow.persona_name,
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
					personaManager
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
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager);
			}
			return;
		}

		// Step 4: Empty guard — assembleWorkflowPrompt returns null and surfaces Notice itself
		if (assemblyResult === null) {
			// Revert persona if we switched it
			if (personaSwitchResult.switched && personaManager) {
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager);
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
		const { providerId, modelId, useExtendedContext } = resolveWorkflowProviderConfig(
			workflow,
			this.deps.getSettings(),
			fallbackProviderId,
			this.deps.getActiveModelId(),
			fallbackConfig?.use_extended_context ?? false,
		);
		const currentMode = workflow.mode
			?? (conversationManager.hasActiveConversation()
				? conversationManager.getMode()
				: this.deps.getSettings().mode);

		// Determine the active persona name after any switch
		const activePersonaName = personaManager?.getActivePersona()?.name ?? null;

		const conversation = conversationManager.createConversation(
			providerId,
			modelId,
			currentMode,
			{
				workflow_path: workflow.file_path,
				workflow_name: workflow.display_name,
				persona_name: activePersonaName,
				is_background: false,
				title: `Workflow: ${workflow.display_name}`,
				use_extended_context: useExtendedContext,
			}
		);

		await this.deps.historyManager.createConversationFile(conversation);

		const view = this.deps.viewRouter.getView();
		view?.clearMessages();
		view?.updateModeDisplay(conversation.mode);

		// Step 7: Store persona revert state for E-008
		if (personaSwitchResult.switched) {
			this.deps.setWorkflowPersonaRevert(personaSwitchResult.previousPersona);
		} else {
			// No switch performed — clear any stale revert state from a previous workflow
			this.deps.setWorkflowPersonaRevert(undefined);
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

		const pinnedPersona = personaManager?.getActivePersona() ?? null;

		const { effective: initialConfig, parsedConfigs: initialParsedConfigs } =
			await this.deps.configResolver.resolveEffectiveConfig(undefined, assemblyResult, pinnedPersona);

		const approvalCallback: ApprovalCallback = this.deps.getPanelApprovalCallback()
			?? (async () => "approved" as const);

		const session = new ConversationSession({
			conversationId: conversation.id,
			conversationManager: sessionConvManager,
			abortController: new AbortController(),
			title: conversation.title ?? `Workflow: ${workflow.display_name}`,
			pinnedPersona,
			providerId,
			modelId,
			useExtendedContext,
			workflowAssembly: assemblyResult,
			approvalCallback,
			initialConfig,
			initialParsedConfigs,
		});

		this.deps.sessionManager.registerSession(session);

		// G-006: Activate workflow-scoped hook overrides before the first LLM call
		const whOverrideManager = this.deps.getWorkflowHookOverrideManager();
		if (workflow.hooks && whOverrideManager) {
			whOverrideManager.activate(conversation.id, workflow.hooks);
			log.info("Workflow hook overrides activated for manual execution", {
				conversationId: conversation.id,
				events: Object.keys(workflow.hooks),
			});
		}

		// Step 10: Start the response loop
		session.responsePromise = this.deps.runResponseLoop(currentMode, session);
		try {
			await session.responsePromise;
		} catch (e) {
			session.setStatus("errored");
			this.deps.handleError(e);
		} finally {
			if (session.status === "running" || session.status === "waiting_approval") {
				session.setStatus("completed");
			}
			// Drain pending JSONL writes for THIS conversation before removing the session.
			try {
				const conv = session.conversationManager.getActiveConversation();
				if (conv) {
					await this.deps.historyManager.flushConversation(conv);
				}
			} catch {
				// Best-effort — don't block session cleanup on write errors
			}
			// G-005: Deactivate workflow-scoped hook overrides on all exit paths.
			// deactivate() is idempotent — safe if destroy() also calls it.
			const whm = this.deps.getWorkflowHookOverrideManager();
			if (session.workflowAssembly && whm) {
				whm.deactivate(session.conversationId);
			}
			this.deps.sessionManager.unregisterSession(session.conversationId);
			this.deps.viewRouter.getViewForSession(session)?.setRespondingState(false);
		}
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
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager);
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
				await revertWorkflowPersona(personaSwitchResult.previousPersona, personaManager);
			}
			return;
		}

		// Step 2: Create a background conversation (does NOT switch the user's
		// active conversation — we operate on a separate ConversationManager instance
		// scoped to this background execution).
		const mode = workflow.mode ?? this.deps.getSettings().mode;
		const registryProviderId = this.deps.providerRegistry.getActiveId();
		const registryConfig = this.deps.providerRegistry.getConfig(registryProviderId);
		const { providerId, modelId, useExtendedContext } = resolveWorkflowProviderConfig(
			workflow,
			this.deps.getSettings(),
			registryProviderId,
			registryConfig?.model_id ?? "",
			registryConfig?.use_extended_context ?? false,
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
		const pinnedPersona = personaManager?.getActivePersona() ?? null;
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
			} else if (finalStatus === "errored") {
				new Notice(`Workflow '${workflow.display_name}' failed: ${errorMessage ?? "Unknown error"}`);
			}

			// Revert persona if we switched it — scoped to this background execution
			if (personaSwitchResult.switched && personaManager) {
				try {
					await revertWorkflowPersona(
						personaSwitchResult.previousPersona,
						personaManager
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

			for await (const event of parseStreamEvents(stream, abortController.signal)) {
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

				// Dispatch the tool with session-scoped policy context and approval
				const policyCtx = vaultRootPath
					? session.buildPolicyContext(this.deps.getSettings(), vaultRootPath)
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

				// Roll up sub-agent tokens into conversation totals without
				// inflating per-message estimates (which would cause premature
				// compaction/truncation).
				const bgSubAgentTokens = toolResult.sub_agent_metadata?.token_usage;
				if (bgSubAgentTokens) {
					bgConvManager.addTokens(bgSubAgentTokens.input, bgSubAgentTokens.output);
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
						bgConvForFooter.total_input_tokens,
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
