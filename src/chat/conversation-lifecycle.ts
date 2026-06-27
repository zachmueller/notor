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
import type { Conversation, Persona } from "../types";
import { buildOptionValue } from "../providers/model-grouping";
import { resolveConversationModel, resolvePreset } from "../presets/preset-resolver";
import type { ConversationManager, ForkMode } from "./conversation";
import { HistoryManager } from "./history";
import { conversationFilename } from "./history";
import type { ConversationSession } from "./conversation-session";
import type { StaleContentTracker } from "./stale-tracker";
import type { ViewRouter } from "./view-router";
import type { SessionManager } from "./session-manager";
import type { ConfigResolver } from "./config-resolver";
import type { NotorChatView } from "../ui/chat-view";
import type { NotorSettings } from "../settings";
import type { PersonaManager } from "../personas/persona-manager";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import { revertWorkflowPersona } from "../workflows/workflow-executor";
import { showDraftSavedNotice } from "../tool-config/notices";
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
		private readonly getActiveProviderId: () => string,
		private readonly getActiveModelId: () => string,
		private readonly getActiveUseExtendedContext: () => boolean,
		private readonly setActiveProviderId: (id: string) => void,
		private readonly setActiveModelId: (modelId: string) => void,
		private readonly setActiveUseExtendedContext: (useExtended: boolean) => void,
		private readonly setActiveThinkingLevel: (level: string | null) => void,
		private readonly getActivePresetName: () => string | null,
		private readonly setActivePresetName: (name: string | null) => void,
		private readonly isProviderAccessible: (providerId: string) => boolean,
		private readonly getActivePersona: () => Persona | null,
		private readonly setActivePersona: (persona: Persona | null) => void,
		private readonly getSharedCheckpointManager?: () => CheckpointManager | undefined,
		private readonly onSwitchConversation?: (filename: string) => Promise<void>,
		private readonly getStaleTracker?: () => StaleContentTracker | undefined,
	) {}

	/**
	 * Record the previous persona for workflow persona revert (E-008).
	 */
	setWorkflowPersonaRevert(previousPersona: string | null | undefined): void {
		this.workflowPreviousPersona = previousPersona;
	}

	/**
	 * Persist current stale tracker state to JSONL before leaving a conversation.
	 */
	private async persistStaleState(convManager: ConversationManager): Promise<void> {
		const tracker = this.getStaleTracker?.();
		if (!tracker) return;

		const conversation = convManager.getActiveConversation();
		if (!conversation) return;

		const entries = tracker.serialize();
		if (entries.length > 0) {
			await this.historyManager.appendStaleState(conversation, entries);
		}
		tracker.clear();
	}

	/**
	 * Restore stale tracker state from JSONL after loading a conversation.
	 */
	private async restoreStaleState(filename: string): Promise<void> {
		const tracker = this.getStaleTracker?.();
		if (!tracker) return;

		try {
			const rawContent = await this.historyManager.readRawFile(filename);
			const entries = HistoryManager.extractStaleState(rawContent);
			if (entries) {
				tracker.restore(entries);
			}
		} catch {
			// Non-fatal — stale state is best-effort
		}
	}

	/**
	 * If the input box has unsent text, save it as a draft on the current
	 * conversation header, clear the input, and show a Notice with a
	 * right-click handler to switch back.
	 */
	private async maybeSaveDraft(
		convManager: ConversationManager,
		view: NotorChatView | undefined,
	): Promise<void> {
		const currentConversation = convManager.getActiveConversation();
		const draftText = view?.getInputText()?.trim() ?? "";
		if (!currentConversation || !draftText) return;

		await this.historyManager.saveDraft(currentConversation, draftText);
		view?.setInputText("");

		const filename = conversationFilename(currentConversation);
		const onSwitchBack = this.onSwitchConversation
			? () => void this.onSwitchConversation!(filename)
			: () => {};
		showDraftSavedNotice(currentConversation.title, onSwitchBack);
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
		const providerId = this.getActiveProviderId();
		const modelId = this.getActiveModelId();
		const view = this.viewRouter.getView();

		// Save any unsent draft from the current conversation before leaving
		await this.maybeSaveDraft(convManager, view);
		if (signal?.aborted) return;

		// Mode B: Reset to configured default persona for new chats
		if (settings.new_chat_persona_mode === "default") {
			const personaManager = this.getPersonaManager();
			if (personaManager) {
				const defaultName = settings.default_persona;
				if (defaultName) {
					const persona = await personaManager.getPersonaByName(defaultName);
					if (signal?.aborted) return;
					if (persona) {
						this.setActivePersona(persona);
						const targetPreset = persona.preferred_preset ?? settings.default_preset;
						const resolved = resolvePreset(targetPreset, settings.model_presets);
						if (resolved) {
							this.setActivePresetName(resolved.presetName);
							this.setActiveProviderId(resolved.providerId);
							this.setActiveModelId(resolved.modelId);
							this.setActiveUseExtendedContext(resolved.useExtendedContext);
							this.setActiveThinkingLevel(resolved.thinkingLevel);
						}
					} else {
						this.setActivePersona(null);
					}
				} else {
					this.setActivePersona(null);
				}
			}
		}

		const currentMode = convManager.hasActiveConversation()
			? convManager.getMode()
			: settings.mode;

		const presetName = this.getActivePresetName();
		const useExtendedContext = this.getActiveUseExtendedContext();
		const conversation = convManager.createConversation(
			providerId,
			modelId,
			currentMode,
			{
				...(useExtendedContext && { use_extended_context: true }),
				...(presetName !== undefined && { preset_name: presetName }),
			},
		);

		// Capture per-panel active persona into header
		conversation.persona_name = this.getActivePersona()?.name ?? null;

		await this.historyManager.createConversationFile(conversation);
		if (signal?.aborted) return;

		view?.clearMessages();
		view?.setRespondingState(false);
		view?.updateModeDisplay(conversation.mode);
		view?.renderTaskPanel(conversation.tasks);
		view?.clearDisplayOverrides();

		// Display persona label for the new conversation
		if (conversation.persona_name) {
			const persona = await this.getPersonaManager()?.getPersonaByName(conversation.persona_name) ?? null;
			if (signal?.aborted) return;
			view?.updatePersonaLabel(persona);
		} else {
			view?.updatePersonaLabel(null);
		}

		// Display the active-workflow chip for the new conversation
		view?.updateWorkflowLabel(conversation);

		// Scope checkpoint managers to the new conversation (A1.6b)
		this.getCheckpointManager()?.setConversationId(conversation.id);
		this.getSharedCheckpointManager?.()?.setConversationId(conversation.id);

		log.info("New conversation started", { id: conversation.id });
	}

	/**
	 * Fork the current conversation at a specific message.
	 *
	 * @param forkMode `"resume"` (default) keeps the existing tool result;
	 *   `"rerun"` excludes the result and resets the trailing tool_call(s) to
	 *   `pending` so the caller can re-dispatch the tool.
	 */
	async forkConversation(
		forkAtMessageId: string,
		forkMode: ForkMode = "resume",
	): Promise<{ filename: string; conversation: Conversation } | null> {
		const convManager = this.getConversationManager();
		const providerId = this.getActiveProviderId();
		const modelId = this.getActiveModelId();
		const currentMode =
			convManager.getActiveConversation()?.mode ??
			this.getSettings().mode;

		const forkData = convManager.prepareFork(
			forkAtMessageId,
			providerId,
			modelId,
			currentMode,
			forkMode,
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

		// Persist stale tracker state before leaving the current conversation
		await this.persistStaleState(convManager);

		// Save any unsent draft from the current conversation before leaving
		await this.maybeSaveDraft(convManager, view);
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

			// Restore stale tracker state from JSONL (if persisted)
			await this.restoreStaleState(filename);

			view?.clearMessages();
			for (const msg of historyMessages) {
				this.viewRouter.renderMessage(msg);
			}

			view?.updateModeDisplay(conversation.mode);
			view?.renderTaskPanel(conversation.tasks);
			view?.updateTokenFooter(
				convManager.getCurrentContextUsage().contextTokens,
				conversation.total_output_tokens,
				conversation.estimated_cost
			);

			// Display-restore persona from conversation header and update per-panel state
			if (conversation.persona_name) {
				const persona = await this.getPersonaManager()?.getPersonaByName(conversation.persona_name) ?? null;
				if (signal?.aborted) return;
				view?.updatePersonaLabel(persona);
				this.setActivePersona(persona);
			} else {
				view?.updatePersonaLabel(null);
				this.setActivePersona(null);
			}

			// Display-restore the active-workflow chip from the conversation header
			view?.updateWorkflowLabel(conversation);

			// Resolve model configuration via preset-first fallback chain
			const resolution = resolveConversationModel(
				conversation,
				this.getSettings().model_presets,
				this.getSettings().default_preset,
				this.isProviderAccessible,
			);

			if (resolution) {
				view?.updatePresetDisplay(resolution.presetName);
				if (resolution.presetName === null) {
					view?.updateProviderDisplay(resolution.providerId);
					view?.updateModelDisplay(
						buildOptionValue(resolution.modelId, resolution.useExtendedContext)
					);
				}

				this.setActivePresetName(resolution.presetName);
				this.setActiveProviderId(resolution.providerId);
				this.setActiveModelId(resolution.modelId);
				this.setActiveUseExtendedContext(resolution.useExtendedContext);
				this.setActiveThinkingLevel(resolution.thinkingLevel);

				// Update in-memory conversation so handleUserMessage() pins correctly
				if (resolution.source !== "stored") {
					conversation.provider_id = resolution.providerId;
					conversation.model_id = resolution.modelId;
					conversation.use_extended_context = resolution.useExtendedContext;
					if (resolution.source === "default") {
						conversation.preset_name = resolution.presetName;
					}
					this.historyManager.updateConversationHeader(conversation);
				}

				if (resolution.source === "default") {
					new Notice(`Preset "${conversation.preset_name}" unavailable. Using default preset.`);
				}
			} else {
				view?.updatePresetDisplay(null);
				this.setActivePresetName(null);
			}

			this.getCheckpointManager()?.setConversationId(conversation.id);
			this.getSharedCheckpointManager?.()?.setConversationId(conversation.id);

			// Restore any saved draft into the input box
			if (conversation.draft_text && view) {
				view.setInputText(conversation.draft_text);
			}

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
		view?.renderTaskPanel(sessionConv.tasks);
		view?.updateTokenFooter(
			activeSession.conversationManager.getCurrentContextUsage().contextTokens,
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

		// Re-render pending approval prompts (buttons were destroyed by clearMessages).
		if (view && activeSession.pendingApprovals.size > 0) {
			const approvalResults = view.reRenderPendingApprovals(activeSession.pendingApprovals);
			for (const [msgId, promise] of approvalResults) {
				const pending = activeSession.pendingApprovals.get(msgId);
				if (pending) {
					promise.then((decision) => pending.resolve(decision));
				}
			}
		}

		// Re-render pending interaction prompts (ask_user) destroyed by clearMessages.
		if (view && activeSession.pendingInteractions.size > 0) {
			const interactionResults = view.reRenderPendingInteractions(activeSession.pendingInteractions);
			for (const [msgId, promise] of interactionResults) {
				const pending = activeSession.pendingInteractions.get(msgId);
				if (pending) {
					promise
						.then((response) => pending.resolve(response))
						.catch((err) => pending.reject(err));
				}
			}
		}

		// Display-restore from session's pinned state
		view?.updatePersonaLabel(activeSession.pinnedPersona);
		this.setActivePersona(activeSession.pinnedPersona);
		view?.updateWorkflowLabel(sessionConv);

		// Resolve model configuration via preset-first fallback chain
		const resolution = resolveConversationModel(
			sessionConv,
			this.getSettings().model_presets,
			this.getSettings().default_preset,
			this.isProviderAccessible,
		);

		if (resolution) {
			view?.updatePresetDisplay(resolution.presetName);
			if (resolution.presetName === null) {
				view?.updateProviderDisplay(resolution.providerId);
				view?.updateModelDisplay(
					buildOptionValue(resolution.modelId, resolution.useExtendedContext)
				);
			}

			this.setActivePresetName(resolution.presetName);
			this.setActiveProviderId(resolution.providerId);
			this.setActiveModelId(resolution.modelId);
			this.setActiveUseExtendedContext(resolution.useExtendedContext);
			this.setActiveThinkingLevel(resolution.thinkingLevel);
		} else {
			view?.updatePresetDisplay(null);
			this.setActivePresetName(null);
		}

		this.configResolver.updateDisplayConfig(activeSession.effectiveConfig, activeSession.parsedConfigs);
		this.getCheckpointManager()?.setConversationId(conversation.id);
		this.getSharedCheckpointManager?.()?.setConversationId(conversation.id);

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
			await revertWorkflowPersona(previousPersona, personaManager, (p) => this.setActivePersona(p));
		} catch (e) {
			log.error("Failed to revert workflow persona", { error: String(e) });
		}
	}
}
