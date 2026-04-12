/**
 * Conversation lifecycle manager — owns conversation creation, switching,
 * forking, and workflow persona revert.
 *
 * Extracted from `ChatOrchestrator` (Phase B3). The display
 * `ConversationManager` remains on the orchestrator; this class receives
 * it via callback to avoid moving the field across too many references.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B3
 */

import { Notice } from "obsidian";
import type { Conversation, LLMProviderType, Message } from "../types";
import { buildOptionValue } from "../providers/model-grouping";
import { isPresetStale } from "../presets/preset-resolver";
import type { ConversationManager } from "./conversation";
import type { HistoryManager } from "./history";
import type { ConversationSession } from "./conversation-session";
import type { ViewRouter } from "./view-router";
import type { SessionManager } from "./session-manager";
import type { ConfigResolver } from "./config-resolver";
import type { NotorChatView } from "../ui/chat-view";
import type { NotorSettings } from "../settings";
import type { PersonaManager } from "../personas/persona-manager";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { revertWorkflowPersona } from "../workflows/workflow-executor";
import { logger } from "../utils/logger";

const log = logger("ConversationLifecycle");

export class ConversationLifecycleManager {
	private workflowPreviousPersona: string | null | undefined = undefined;

	constructor(
		private readonly getSettings: () => NotorSettings,
		private readonly historyManager: HistoryManager,
		private readonly getConversationManager: () => ConversationManager,
		private readonly viewRouter: ViewRouter,
		private readonly sessionManager: SessionManager,
		private readonly configResolver: ConfigResolver,
		private readonly getPersonaManager: () => PersonaManager | undefined,
		private readonly getCheckpointManager: () => CheckpointManager | undefined,
		private readonly getActiveProviderType: () => LLMProviderType,
		private readonly getActiveModelId: () => string,
		private readonly getActiveUseExtendedContext: () => boolean,
		private readonly setActiveProviderType: (type: LLMProviderType) => void,
		private readonly setActiveModelId: (modelId: string) => void,
		private readonly setActiveUseExtendedContext: (useExtended: boolean) => void,
		private readonly getActivePresetName: () => string | null,
		private readonly setActivePresetName: (name: string | null) => void,
	) {}

	/**
	 * Record the previous persona for workflow persona revert (E-008).
	 */
	setWorkflowPersonaRevert(previousPersona: string | null | undefined): void {
		this.workflowPreviousPersona = previousPersona;
	}

	/**
	 * Start a new conversation.
	 */
	async newConversation(opts?: { signal?: AbortSignal }): Promise<void> {
		const signal = opts?.signal;

		// E-008: Revert workflow persona before leaving this conversation
		await this.maybeRevertWorkflowPersona();
		if (signal?.aborted) return;

		const convManager = this.getConversationManager();
		const settings = this.getSettings();
		const providerType = this.getActiveProviderType();
		const modelId = this.getActiveModelId();
		const view = this.viewRouter.getView();

		const currentMode = convManager.hasActiveConversation()
			? convManager.getMode()
			: settings.mode;

		const presetName = this.getActivePresetName();
		const useExtendedContext = this.getActiveUseExtendedContext();
		const conversation = convManager.createConversation(
			providerType,
			modelId,
			currentMode,
			{
				...(useExtendedContext && { use_extended_context: true }),
				...(presetName !== undefined && { preset_name: presetName }),
			},
		);

		// Capture active persona into header
		conversation.persona_name = this.getPersonaManager()?.getActivePersona()?.name ?? null;

		await this.historyManager.createConversationFile(conversation);
		if (signal?.aborted) return;

		view?.clearMessages();
		view?.updateModeDisplay(conversation.mode);
		view?.clearDisplayOverrides();

		// Scope checkpoint manager to the new conversation (A1.6b)
		this.getCheckpointManager()?.setConversationId(conversation.id);

		log.info("New conversation started", { id: conversation.id });
	}

	/**
	 * Fork the current conversation at a specific message.
	 */
	async forkConversation(
		forkAtMessageId: string,
	): Promise<{ filename: string; conversation: Conversation } | null> {
		const convManager = this.getConversationManager();
		const providerType = this.getActiveProviderType();
		const modelId = this.getActiveModelId();
		const currentMode =
			convManager.getActiveConversation()?.mode ??
			this.getSettings().mode;

		const forkData = convManager.prepareFork(
			forkAtMessageId,
			providerType,
			modelId,
			currentMode,
		);

		if (!forkData) {
			new Notice("Could not fork: message not found in current conversation.");
			return null;
		}

		const filename = await this.historyManager.importConversation(
			forkData.conversation,
			forkData.messages,
		);

		return { filename, conversation: forkData.conversation };
	}

	/**
	 * Switch to an existing conversation.
	 */
	async switchConversation(filename: string, opts?: { signal?: AbortSignal }): Promise<void> {
		const signal = opts?.signal;
		const convManager = this.getConversationManager();
		const view = this.viewRouter.getView();

		// E-008: Revert workflow persona before leaving this conversation
		await this.maybeRevertWorkflowPersona();
		if (signal?.aborted) return;

		view?.setRespondingState(false);

		try {
			const { conversation, messages: historyMessages } = await this.historyManager.loadConversation(filename);
			if (signal?.aborted) return;

			const activeSession = this.sessionManager.getActiveSession(conversation.id);
			if (activeSession) {
				this.switchToActiveSession(convManager, view, activeSession, conversation);
				return;
			}

			// No active session — standard JSONL load path
			convManager.loadConversation(conversation, historyMessages);

			view?.clearMessages();
			for (const msg of historyMessages) {
				this.viewRouter.renderMessage(msg);
			}

			view?.updateModeDisplay(conversation.mode);
			view?.updateTokenFooter(
				conversation.total_input_tokens,
				conversation.total_output_tokens,
				conversation.estimated_cost
			);

			// Display-restore persona from conversation header
			if (conversation.persona_name) {
				const persona = await this.getPersonaManager()?.getPersonaByName(conversation.persona_name) ?? null;
				if (signal?.aborted) return;
				view?.updatePersonaLabel(persona);
			} else {
				view?.updatePersonaLabel(this.getPersonaManager()?.getActivePersona() ?? null);
			}

			// Display-restore preset (or provider/model for legacy conversations)
			if (conversation.preset_name) {
				const stale = isPresetStale(
					conversation.preset_name,
					conversation.provider_id,
					conversation.model_id,
					this.getSettings().model_presets,
				);
				view?.updatePresetDisplay(stale ? null : conversation.preset_name);
			} else {
				// Legacy conversation or Custom — show as Custom with provider/model overrides
				view?.updatePresetDisplay(null);
				if (conversation.provider_id) {
					view?.updateProviderDisplay(conversation.provider_id as LLMProviderType);
				}
				if (conversation.model_id) {
					view?.updateModelDisplay(
						buildOptionValue(conversation.model_id, conversation.use_extended_context ?? false)
					);
				}
			}

			// Sync per-orchestrator state so subsequent actions (new conversation,
			// getCurrentModel callback) reflect the loaded conversation's model.
			this.setActivePresetName(conversation.preset_name ?? null);
			if (conversation.provider_id) {
				this.setActiveProviderType(conversation.provider_id as LLMProviderType);
			}
			if (conversation.model_id) {
				this.setActiveModelId(conversation.model_id);
				this.setActiveUseExtendedContext(conversation.use_extended_context ?? false);
			}

			this.getCheckpointManager()?.setConversationId(conversation.id);
			log.info("Switched to conversation", { id: conversation.id });
		} catch (e) {
			log.error("Failed to switch conversation", { filename, error: String(e) });
			view?.showError(`Failed to load conversation: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * Handle sync-back from an active session during switchConversation.
	 */
	private switchToActiveSession(
		convManager: ConversationManager,
		view: NotorChatView | undefined,
		activeSession: ConversationSession,
		conversation: Conversation,
	): void {
		const sessionConv = activeSession.conversationManager.getActiveConversation()!;
		const sessionMessages = activeSession.conversationManager.getMessages();

		convManager.loadConversation(sessionConv, sessionMessages, { silent: true });

		view?.clearMessages();
		for (const msg of sessionMessages) {
			this.viewRouter.renderMessage(msg);
		}

		view?.updateModeDisplay(sessionConv.mode);
		view?.updateTokenFooter(
			sessionConv.total_input_tokens,
			sessionConv.total_output_tokens,
			sessionConv.estimated_cost
		);

		view?.setRespondingState(true);

		// Register one-time callback to turn off responding state
		const previousOnStatusChange = activeSession.onStatusChange;
		activeSession.onStatusChange = (session) => {
			previousOnStatusChange?.(session);
			if (session.status === "completed" || session.status === "errored" || session.status === "cancelled") {
				this.viewRouter.getViewForSession(session)?.setRespondingState(false);
				activeSession.onStatusChange = previousOnStatusChange;
			}
		};

		// Display-restore from session's pinned state
		view?.updatePersonaLabel(activeSession.pinnedPersona);
		// Preset-aware display restore
		this.setActivePresetName(sessionConv.preset_name ?? null);
		if (sessionConv.preset_name) {
			const stale = isPresetStale(
				sessionConv.preset_name,
				sessionConv.provider_id,
				sessionConv.model_id,
				this.getSettings().model_presets,
			);
			view?.updatePresetDisplay(stale ? null : sessionConv.preset_name);
		} else {
			view?.updatePresetDisplay(null);
			if (sessionConv.provider_id) {
				view?.updateProviderDisplay(sessionConv.provider_id as LLMProviderType);
			}
			if (sessionConv.model_id) {
				view?.updateModelDisplay(
					buildOptionValue(sessionConv.model_id, activeSession.useExtendedContext)
				);
			}
		}
		if (sessionConv.provider_id) {
			this.setActiveProviderType(sessionConv.provider_id as LLMProviderType);
		}
		if (sessionConv.model_id) {
			this.setActiveModelId(sessionConv.model_id);
			this.setActiveUseExtendedContext(activeSession.useExtendedContext);
		}

		this.configResolver.updateDisplayConfig(activeSession.effectiveConfig, activeSession.parsedConfigs);
		this.getCheckpointManager()?.setConversationId(conversation.id);

		log.info("Switched to active session conversation (sync-back)", { id: conversation.id });
	}

	/**
	 * Switch to a conversation by its unique ID (H-005).
	 */
	async switchToConversationById(conversationId: string, opts?: { signal?: AbortSignal }): Promise<boolean> {
		const signal = opts?.signal;
		try {
			const entries = await this.historyManager.listConversations();
			if (signal?.aborted) return false;
			const match = entries.find((e) => e.id === conversationId);
			if (!match) {
				log.warn("Conversation not found by ID", { conversationId });
				return false;
			}
			await this.switchConversation(match.filename, { signal });
			return true;
		} catch (e) {
			log.error("Failed to switch to conversation by ID", {
				conversationId,
				error: String(e),
			});
			return false;
		}
	}

	/**
	 * Revert the workflow persona if the current conversation had one active.
	 *
	 * @see specs/03-workflows-personas/tasks/group-e-tasks.md — E-008
	 */
	async maybeRevertWorkflowPersona(): Promise<void> {
		const personaManager = this.getPersonaManager();
		if (this.workflowPreviousPersona === undefined || !personaManager) {
			return;
		}

		const previousPersona = this.workflowPreviousPersona;
		this.workflowPreviousPersona = undefined;

		try {
			await revertWorkflowPersona(previousPersona, personaManager);
		} catch (e) {
			log.error("Failed to revert workflow persona", { error: String(e) });
		}
	}
}
