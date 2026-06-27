import { Notice } from "obsidian";
import type NotorPlugin from "../main";
import type { NotorChatView } from "./chat-view";
import type { ChatOrchestrator } from "../chat/orchestrator";
import { conversationFilename } from "../chat/history";
import { parseOptionValue, buildOptionValue } from "../providers/model-grouping";
import { resolvePersonaOverrides } from "../personas/persona-overrides";
import { resolvePreset } from "../presets/preset-resolver";
import { extractJsonlFromHtml, reassignIds } from "../export/html-importer";
import { RenameModal } from "./rename-modal";
import { ConfirmModal } from "./confirm-modal";
import { showOsNotification, revealChatPanel } from "./os-notification";
import { logger } from "../utils/logger";

const log = logger("WireView");

/**
 * Wire a newly created chat view to the orchestrator.
 *
 * Called when the view is registered and every time the view is opened
 * (Obsidian may recreate views on workspace restore). Each panel gets
 * its own orchestrator instance (sharing infrastructure singletons).
 */
export function wireView(view: NotorChatView, orchestrator: ChatOrchestrator, plugin: NotorPlugin): void {
	const historyManager = plugin.getHistoryManager();
	const providerRegistry = plugin.getProviderRegistry();
	const toolDispatcher = plugin.getToolDispatcher();

	// Wire orchestrator ↔ view
	orchestrator.setView(view);

	// A7.3: Wire close cleanup
	const leafId = view.leaf.id;

	const updateThisView = () => view.updateActivityIndicator();

	view.setOnCloseCleanup(async () => {
		view._loadConversationAbort?.abort();
		clearTimeout(view._loadFallbackTimeout);
		orchestrator.setView(undefined);
		view._unregisterSessionsChanged?.();
		view._unregisterPersonaChanged?.();
		view._removeActivityCallback?.();
		plugin.removeOrchestrator(leafId);
		await orchestrator.destroy();
	});

	// H-006: Wire workflow activity tracker
	const workflowActivityTracker = plugin.getWorkflowActivityTracker();
	if (workflowActivityTracker) {
		view.setWorkflowActivityTracker(workflowActivityTracker);
	}

	// Wire global session accessor
	view.setGetActiveSessions(() => plugin.getAllActiveSessions());
	view.setGetCurrentConversationId(() => view.getActiveConversationId());

	// Register this panel's indicator updater in the global set
	view._removeActivityCallback?.();
	plugin.addActivityIndicatorCallback(updateThisView);
	view._removeActivityCallback = () => plugin.removeActivityIndicatorCallback(updateThisView);

	// A3.5: Wire session-change listener
	view._unregisterSessionsChanged?.();
	view._unregisterSessionsChanged = orchestrator.onSessionsChanged(() => {
		plugin.fireActivityIndicatorCallbacks();
	});

	// H-005: Wire conversation-by-ID switching
	view.setOnSwitchToConversationById(async (conversationId: string) => {
		const result = await orchestrator.switchToConversationById(conversationId);
		if (result) {
			view.setActiveConversationId(conversationId);
			const conv = orchestrator.getConversationManager().getActiveConversation();
			view.updateHeaderTitle(conversationId, conv?.title ?? null);
			view.updateHeaderFavorite(conversationId, !!conv?.is_favorite);
		}
		return result;
	});

	// Wire persona manager to view (A-013: picker + label)
	const personaManager = plugin.getPersonaManager();
	view.setPersonaManager(personaManager);

	// Wire persona-changed callback
	view._unregisterPersonaChanged?.();
	view._unregisterPersonaChanged = personaManager.setOnPersonaChanged((persona) => {
		const panelPersonaName = orchestrator.getActivePersona()?.name ?? null;
		if (persona && persona.name === panelPersonaName) {
			view.updatePersonaLabel(persona);
			orchestrator.setActivePersona(persona);
		} else if (persona === null && panelPersonaName !== null) {
			view.updatePersonaLabel(null);
			orchestrator.setActivePersona(null);
		}
	});


	view.setOnPersonaChange((persona) => {
		orchestrator.setActivePersona(persona);

		if (persona) {
			const resolution = resolvePersonaOverrides(persona, providerRegistry, plugin.settings.model_presets ?? []);
			if (resolution) {
				orchestrator.setActiveProvider(resolution.providerId);
				orchestrator.setActiveModel(resolution.modelId, resolution.useExtendedContext, resolution.thinkingLevel);
				view.updateProviderDisplay(resolution.providerId);
				const modelValue = resolution.useExtendedContext
					? `${resolution.modelId}::1m`
					: resolution.modelId;
				view.updateModelDisplay(modelValue);
				if (resolution.presetName) {
					orchestrator.setActivePresetName(resolution.presetName);
					view.updatePresetDisplay(resolution.presetName);
				}
			}
		}

		const conv = orchestrator.getDisplayedConversation();
		if (conv) {
			conv.persona_name = persona?.name ?? null;
			historyManager.updateConversationHeader(conv).catch((e) => {
				log.error("Failed to update conversation header on persona change", { error: String(e) });
			});
		}

		toolDispatcher.setActivePersonaName(persona?.name ?? null);

		plugin.settings.active_persona = persona?.name ?? "";
		void plugin.saveData(plugin.settings);
	});


	// E-012 / E-015: Wire workflow send callback
	view.setOnSendWorkflow(async (workflow, supplementaryText) => {
		await orchestrator.executeWorkflow(workflow, supplementaryText);
	});

	// Workflow chip — deactivate: drop the workflow's tool-config overrides for
	// future turns (keep workflow_path/name for history; persona untouched).
	// Patches the in-memory conversation so the next turn's snapshot sees the
	// flag (the manager's onConversationChanged persists the header).
	view.setOnDeactivateWorkflow(() => {
		const convManager = orchestrator.getConversationManager();
		const conv = convManager.getActiveConversation();
		if (!conv) return;
		convManager.setWorkflowMetadata({ workflow_deactivated: true });
		view.updateWorkflowLabel({ ...conv, workflow_deactivated: true });
	});

	// Workflow chip — switch: apply the chosen workflow fully into the current
	// conversation (tool configs, persona, provider/model, hooks) as the next turn.
	view.setOnSwitchWorkflow(async (workflow) => {
		await orchestrator.switchWorkflow(workflow);
	});

	// E-015: Workflow discovery callback for slash-command suggest
	view.setGetWorkflows(() => plugin.getDiscoveredWorkflows());

	// Send message
	view.setOnSendMessage(async (content: string, attachments?) => {
		await orchestrator.handleUserMessage(content, attachments);
	});

	// Stop response
	view.setOnStopResponse(() => {
		const displayedConvId = orchestrator.getConversationManager().getActiveConversation()?.id;
		if (displayedConvId) {
			const session = orchestrator.getActiveSession(displayedConvId);
			if (session) {
				session.abortController.abort();
				return;
			}
		}
	});

	// New conversation
	view.setOnNewConversation(() => {
		const staleTracker = plugin.getStaleTracker();
		staleTracker.clear?.();
		const vaultRuleManager = plugin.getVaultRuleManager();
		vaultRuleManager.clearAccessedNotes();

		plugin.loadSettings().then(() => {
			toolDispatcher.setAutoApprove(plugin.settings.auto_approve);
			toolDispatcher.setActivePersonaName(
				plugin.settings.active_persona || null
			);
			orchestrator.updateSettings(plugin.settings);
			plugin.updateMcpHubSettings();

			return orchestrator.newConversation();
		}).then(() => {
			const conv = orchestrator.getConversationManager().getActiveConversation();
			if (conv) {
				view.setActiveConversationId(conv.id);
				view.updateHeaderTitle(conv.id, conv.title ?? null);
				view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
			}
		}).catch((e) => {
			log.error("Failed to create new conversation", { error: String(e) });
			new Notice(`Failed to create conversation: ${e instanceof Error ? e.message : String(e)}`);
		});
	});

	// Open conversation list — refresh from disk
	view.setOnOpenConversationList(() => {
		return historyManager.listConversations();
	});

	// Search conversations by query
	view.setOnSearchConversations((query: string) => {
		return historyManager.searchConversations(query);
	});

	// Switch conversation
	view.setOnSwitchConversation((filename: string) => {
		orchestrator.switchConversation(filename).then(() => {
			const conv = orchestrator.getConversationManager().getActiveConversation();
			if (conv) {
				view.setActiveConversationId(conv.id);
				view.updateHeaderTitle(conv.id, conv.title ?? null);
				view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
			}
			plugin.getStaleTracker().clear?.();
			plugin.getVaultRuleManager().clearAccessedNotes();
		}).catch((e) => {
			log.error("Failed to switch conversation", { error: String(e) });
		});
	});

	// Fork conversation at a specific message
	view.setOnForkConversation(async (messageId: string) => {
		const result = await orchestrator.forkConversation(messageId);
		if (!result) return;

		await orchestrator.switchConversation(result.filename);

		view.setActiveConversationId(result.conversation.id);
		view.updateHeaderTitle(result.conversation.id, result.conversation.title ?? null);
		view.updateHeaderFavorite(result.conversation.id, !!result.conversation.is_favorite);
		plugin.getStaleTracker().clear?.();
		plugin.getVaultRuleManager().clearAccessedNotes();

		new Notice(`Forked: ${result.conversation.title}`);
	});

	// Fork & re-run the tool at a specific message (same panel). Slices to
	// just before the tool ran (dropping its result) and re-dispatches it.
	view.setOnForkConversationRerun(async (messageId: string) => {
		const result = await orchestrator.forkConversation(messageId, "rerun");
		if (!result) return;

		await orchestrator.switchConversation(result.filename);

		view.setActiveConversationId(result.conversation.id);
		view.updateHeaderTitle(result.conversation.id, result.conversation.title ?? null);
		view.updateHeaderFavorite(result.conversation.id, !!result.conversation.is_favorite);
		plugin.getStaleTracker().clear?.();
		plugin.getVaultRuleManager().clearAccessedNotes();

		// Surface which tool is being re-run (the trailing tool_call).
		const messages = orchestrator.getConversationManager().getMessages();
		const lastCall = [...messages].reverse().find((m) => m.role === "tool_call");
		const toolName = lastCall?.tool_call?.tool_name;
		new Notice(toolName ? `Re-running ${toolName}…` : "Re-running tool…");

		// Auto-dispatch the trailing pending tool_call(s) and continue the loop.
		await orchestrator.resumePendingToolCalls();
	});

	// /btw — fork conversation to a new panel
	view.setOnForkToNewPanel(async (messageId, initialText) => {
		const messages = orchestrator.getConversationManager().getMessages();
		const forkMessageId = messageId ?? messages[messages.length - 1]?.id;
		if (!forkMessageId) return;

		const result = await orchestrator.forkConversation(forkMessageId);
		if (!result) return;

		plugin.openChatInNewTab(result.filename, false, initialText);
		new Notice(`Side conversation: ${result.conversation.title}`);
	});

	// Export conversation from history list
	view.setOnExportConversation((filename: string) => {
		historyManager.loadConversation(filename).then(({ conversation, messages }) => {
			plugin.showExportModal(conversation, messages);
		}).catch((e) => {
			log.error("Failed to load conversation for export", { error: String(e) });
			new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
		});
	});

	// Toggle favorite
	view.setOnToggleFavorite(async (filename: string) => {
		const newValue = await historyManager.toggleFavorite(filename);
		const convManager = orchestrator.getConversationManager();
		const activeConv = convManager.getActiveConversation();
		if (activeConv && filename.includes(activeConv.id)) {
			convManager.setFavorite(newValue);
			view.updateHeaderFavorite(activeConv.id, newValue);
		}
		const entries = await historyManager.listConversations();
		view.renderConversationList(
			view.isFavFilterActive() ? entries.filter((e) => e.is_favorite) : entries
		);
	});

	// Rename conversation
	view.setOnRenameConversation((filename: string, currentTitle: string) => {
		new RenameModal(
			plugin.app,
			currentTitle,
			async (newTitle: string) => {
				const { conversation } = await historyManager.loadConversation(filename);
				conversation.title = newTitle;
				await historyManager.updateConversationHeader(conversation);

				const convManager = orchestrator.getConversationManager();
				const activeConv = convManager.getActiveConversation();
				if (activeConv && activeConv.id === conversation.id) {
					convManager.setTitle(newTitle);
				} else {
					view.updateConversationTitleInList(conversation.id, newTitle);
				}
			},
		).open();
	});

	// Direct rename (inline header title editing)
	view.setOnDirectRename(async (filename: string, newTitle: string) => {
		const { conversation } = await historyManager.loadConversation(filename);
		conversation.title = newTitle;
		await historyManager.updateConversationHeader(conversation);

		const convManager = orchestrator.getConversationManager();
		const activeConv = convManager.getActiveConversation();
		if (activeConv && activeConv.id === conversation.id) {
			convManager.setTitle(newTitle);
		} else {
			view.updateConversationTitleInList(conversation.id, newTitle);
		}
	});

	// Active conversation metadata
	view.setGetActiveConversationMeta(() => {
		const conv = orchestrator.getConversationManager().getActiveConversation();
		if (!conv) return null;
		return {
			id: conv.id,
			title: conv.title ?? "Untitled",
			filename: conversationFilename(conv),
			is_favorite: !!conv.is_favorite,
		};
	});

	// Open conversation in a new tab
	view.setOnOpenInNewTab((filename: string) => {
		plugin.openChatInNewTab(filename);
	});

	// Delete conversation with confirmation
	view.setOnDeleteConversation((filename: string) => {
		const activeSessions = orchestrator.getActiveSessions();
		const streamingSession = activeSessions.find(s => filename.includes(s.conversationId));
		if (streamingSession) {
			new Notice("Cannot delete — conversation is still streaming. Stop it first.");
			return;
		}
		new ConfirmModal(
			plugin.app,
			"Delete conversation",
			"This conversation will be permanently deleted. This action cannot be undone.",
			async () => {
				const convManager = orchestrator.getConversationManager();
				const activeConv = convManager.getActiveConversation();
				await historyManager.deleteConversationFile(filename);
				const entries = await historyManager.listConversations();
				view.renderConversationList(entries);
				const nextEntry = entries[0];
				if (activeConv && nextEntry && filename.includes(activeConv.id)) {
					await orchestrator.switchConversation(nextEntry.filename);
					const conv = convManager.getActiveConversation();
					if (conv) {
						view.setActiveConversationId(conv.id);
						view.updateHeaderTitle(conv.id, conv.title ?? null);
						view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
					}
				} else if (entries.length === 0) {
					await orchestrator.newConversation();
					const conv = convManager.getActiveConversation();
					if (conv) {
						view.setActiveConversationId(conv.id);
						view.updateHeaderTitle(conv.id, conv.title ?? null);
						view.updateHeaderFavorite(conv.id, !!conv.is_favorite);
					}
				}
			},
			"Delete",
			true
		).open();
	});

	// Import conversation from exported HTML
	view.setOnImportConversation(async (htmlContent: string) => {
		const extracted = extractJsonlFromHtml(htmlContent);
		if (!extracted) {
			new Notice("This HTML file does not contain embedded conversation data");
			return;
		}
		const { conversation, messages } = reassignIds(
			extracted.conversation,
			extracted.messages
		);
		try {
			const filename = await historyManager.importConversation(conversation, messages);
			await orchestrator.switchConversation(filename);
			new Notice(`Imported conversation: ${conversation.title ?? "Untitled"}`);
		} catch (e) {
			log.error("Failed to import conversation", { error: String(e) });
			new Notice(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
		}
	});

	// Mode toggle
	view.setOnModeToggle((mode) => {
		const convManager = orchestrator.getConversationManager();
		convManager.setMode(mode);
		const displayedConvId = convManager.getActiveConversation()?.id;
		if (displayedConvId) {
			const session = orchestrator.getActiveSession(displayedConvId);
			session?.conversationManager.setMode(mode);
		}
	});

	// Settings open
	view.setOnSettingsOpen(() => {
		(plugin.app as import("obsidian").App & {
			setting?: { open: () => void; openTabById: (id: string) => void };
		}).setting?.openTabById("notor");
	});

	// Settings deep-link
	view.setOnOpenSettingsGroup((groupTitle: string, subsection?: string) => {
		const appSetting = (plugin.app as import("obsidian").App & {
			setting?: { open: () => void; openTabById: (id: string) => void };
		}).setting;
		appSetting?.open();
		appSetting?.openTabById("notor");
		setTimeout(() => {
			plugin.scrollSettingsToGroup(groupTitle, subsection);
		}, 100);
	});

	// Provider change
	view.setOnProviderChange((providerId) => {
		orchestrator.setActiveProvider(providerId);
		providerRegistry.switchProvider(providerId);
		plugin.settings.active_provider = providerId;
		plugin.saveSettings().catch((e) => {
			log.error("Failed to save provider change", { error: String(e) });
		});

		const conv = orchestrator.getDisplayedConversation();
		if (conv) {
			conv.provider_id = providerId;
			historyManager.updateConversationHeader(conv).catch((e) => {
				log.error("Failed to update conversation header on provider change", { error: String(e) });
			});
		}
	});

	// Model change
	view.setOnModelChange((selectedValue) => {
		const { modelId, isExtendedContext } = parseOptionValue(selectedValue);
		orchestrator.setActiveModel(modelId, isExtendedContext);

		const activeId = orchestrator.getActiveProviderId();
		const config = providerRegistry.getConfig(activeId);
		if (config) {
			const updated = { ...config, model_id: modelId, use_extended_context: isExtendedContext };
			providerRegistry.updateConfig(updated);
			const idx = plugin.settings.providers.findIndex(
				(p) => p.id === activeId
			);
			if (idx >= 0) {
				plugin.settings.providers[idx] = updated;
				plugin.saveSettings().catch((e) => {
					log.error("Failed to save model change", { error: String(e) });
				});
			}
		}

		const conv = orchestrator.getDisplayedConversation();
		if (conv) {
			conv.model_id = modelId;
			conv.use_extended_context = isExtendedContext;
			historyManager.updateConversationHeader(conv).catch((e) => {
				log.error("Failed to update conversation header on model change", { error: String(e) });
			});
		}
	});

	// Refresh models
	view.setOnRefreshModels(async () => {
		return providerRegistry.refreshModels();
	});

	// Available providers
	view.setGetAvailableProviders(() => {
		return providerRegistry.getConfiguredIds().map((id) => {
			const config = providerRegistry.getConfig(id)!;
			return {
				id: config.id,
				type: config.type,
				displayName: config.display_name,
			};
		});
	});

	// Available models
	view.setGetAvailableModels(() => {
		const activeId = orchestrator.getActiveProviderId();
		try {
			const cached = providerRegistry.getCachedModels(activeId);
			if (cached.length > 0) {
				return cached;
			}
			providerRegistry.getModels(activeId).catch(() => {});
			const config = providerRegistry.getConfig(activeId);
			if (config?.model_id) {
				return [{ id: config.model_id, display_name: config.model_id }];
			}
			return [];
		} catch {
			return [];
		}
	});

	// Current provider
	view.setGetCurrentProvider(() => {
		return orchestrator.getActiveProviderId();
	});

	// Current model
	view.setGetCurrentModel(() => {
		const modelId = orchestrator.getActiveModelId();
		const useExtended = orchestrator.getActiveUseExtendedContext();
		return buildOptionValue(modelId, useExtended);
	});

	// Preset change
	view.setOnPresetChange((presetName, providerId, modelId, useExtendedContext) => {
		let thinkingLevel: string | null | undefined;
		if (presetName !== null) {
			const resolved = resolvePreset(presetName, plugin.settings.model_presets);
			if (!resolved) {
				log.warn("Preset not configured", { presetName });
				return;
			}
			providerId = resolved.providerId;
			modelId = resolved.modelId;
			useExtendedContext = resolved.useExtendedContext;
			thinkingLevel = resolved.thinkingLevel;
		}

		if (providerId) {
			orchestrator.setActiveProvider(providerId);
			providerRegistry.switchProvider(providerId);
			plugin.settings.active_provider = providerId;
		}
		if (modelId !== undefined) {
			orchestrator.setActiveModel(modelId, useExtendedContext ?? false, thinkingLevel);
			const config = providerRegistry.getConfig(orchestrator.getActiveProviderId());
			if (config) {
				const updated = { ...config, model_id: modelId, use_extended_context: useExtendedContext ?? false };
				providerRegistry.updateConfig(updated);
				const idx = plugin.settings.providers.findIndex((p) => p.id === config.id);
				if (idx >= 0) {
					plugin.settings.providers[idx] = updated;
				}
			}
		}

		orchestrator.setActivePresetName(presetName);

		plugin.saveSettings().catch((e) => {
			log.error("Failed to save preset change", { error: String(e) });
		});
		const conv = orchestrator.getDisplayedConversation();
		if (conv) {
			conv.preset_name = presetName;
			if (providerId) conv.provider_id = providerId;
			if (modelId) {
				conv.model_id = modelId;
				conv.use_extended_context = useExtendedContext ?? false;
			}
			historyManager.updateConversationHeader(conv).catch((e) => {
				log.error("Failed to update conversation header on preset change", { error: String(e) });
			});
		}
	});

	// Available presets
	view.setGetAvailablePresets(() => {
		return plugin.settings.model_presets;
	});

	// Current preset
	view.setGetCurrentPreset(() => {
		return orchestrator.getActivePresetName();
	});

	// Thinking level
	view.setGetActiveModelId(() => {
		return orchestrator.getActiveModelId();
	});
	view.setGetActiveThinkingLevel(() => {
		return orchestrator.getActiveThinkingLevel();
	});
	view.setOnThinkingLevelChange((level) => {
		orchestrator.setActiveThinkingLevel(level);
	});

	// Checkpoint callbacks
	const checkpointMgr = orchestrator.getCheckpointManager();
	view.setOnListCheckpoints(async () => {
		return checkpointMgr?.listCheckpoints() ?? [];
	});

	view.setOnRestoreCheckpoint(async (checkpointId) => {
		return checkpointMgr?.restore(checkpointId) ?? false;
	});

	view.setOnGetCurrentContent(async (notePath) => {
		return checkpointMgr?.getCurrentContent(notePath) ?? null;
	});

	// Wire approval callback
	orchestrator.setApprovalCallback(async (toolCall, abortSignal?, messageId?, autoApproved?) => {
		if (autoApproved) {
			const toolCallEl = messageId
				? view.getToolCallEl(messageId) ?? view.getLastToolCallEl()
				: view.getLastToolCallEl();
			if (toolCallEl) {
				void view.renderDiffApprovalPrompt(toolCallEl, toolCall.tool_name, toolCall.parameters ?? {}, true)
					.catch((err) => {
						// Best-effort diff card for auto-approved calls; control flow
						// already returns "approved", so just swallow + log the
						// unhandled rejection rather than letting it float.
						log.error("auto-approved renderDiffApprovalPrompt failed", {
							toolName: toolCall.tool_name,
							error: String(err),
						});
					});
			}
			return "approved";
		}

		const session = orchestrator.getActiveSessions()[0];

		const decision = await new Promise<"approved" | "rejected">((resolve) => {
			if (messageId && session) {
				session.pendingApprovals.set(messageId, {
					resolve,
					toolCallId: toolCall.id ?? "",
					messageId,
					toolName: toolCall.tool_name,
					parameters: toolCall.parameters ?? {},
				});
				session.setStatus("waiting_approval");

				// OS-level desktop notification — conversation is now blocked on
				// the user. In "coalesce" mode, fire only once per blocked episode
				// (when the first approval becomes pending) so a batch of tool calls
				// produces a single notification; in "per_call" mode, fire one per
				// call naming the tool.
				const coalesce = plugin.settings.os_notifications_coalesce_approvals === "coalesce";
				if (!coalesce) {
					showOsNotification(plugin.settings, {
						kind: "approval_required",
						title: "Notor — Approval needed",
						body: toolCall.tool_name,
						onClick: () => revealChatPanel(plugin.app, true),
					});
				} else if (session.pendingApprovals.size === 1) {
					showOsNotification(plugin.settings, {
						kind: "approval_required",
						title: "Notor — Approval needed",
						body: "One or more actions need your approval.",
						onClick: () => revealChatPanel(plugin.app, true),
					});
				}
			}

			const toolCallEl = messageId
				? view.getToolCallEl(messageId) ?? view.getLastToolCallEl()
				: view.getLastToolCallEl();
			if (toolCallEl) {
				view.renderDiffApprovalPrompt(toolCallEl, toolCall.tool_name, toolCall.parameters ?? {}, false)
					.then((result) => resolve(result))
					.catch((err) => {
						// A thrown/rejected render must never leave the approval
						// promise unsettled — that hangs the whole conversation (the
						// dispatcher awaits this decision). Fail closed: reject so the
						// model gets a clean, recoverable result.
						log.error("renderDiffApprovalPrompt failed; rejecting tool call", {
							toolName: toolCall.tool_name,
							error: String(err),
						});
						resolve("rejected");
					});
			}

			if (abortSignal) {
				if (abortSignal.aborted) { resolve("rejected"); return; }
				abortSignal.addEventListener("abort", () => resolve("rejected"), { once: true });
			}
		});

		if (messageId && session) {
			session.pendingApprovals.delete(messageId);
			if (session.pendingApprovals.size === 0 && session.status === "waiting_approval") {
				session.setStatus("running");
			}
		}

		return decision;
	});

	// Wire interaction callback (follow-up questions). Unlike approval, this is
	// never raced against a timeout or hook — it always awaits explicit input.
	orchestrator.setInteractionCallback(async (request, abortSignal?, messageId?) => {
		const session = orchestrator.getActiveSessions()[0];

		const toolCallEl = messageId
			? view.getToolCallEl(messageId) ?? view.getLastToolCallEl()
			: view.getLastToolCallEl();

		if (!toolCallEl) {
			throw new Error("No tool-call element available to render interaction.");
		}

		if (messageId && session) {
			session.setStatus("waiting_approval");
		}

		// OS-level desktop notification — the agent is asking a follow-up
		// question and cannot proceed until the user answers.
		const firstQuestion = request.type === "ask" ? request.questions[0]?.question : undefined;
		showOsNotification(plugin.settings, {
			kind: "input_required",
			title: "Notor — Input needed",
			body: firstQuestion ? firstQuestion.slice(0, 100) : "The assistant needs your input.",
			onClick: () => revealChatPanel(plugin.app, true),
		});

		try {
			const response = await new Promise<import("./interaction-ui").InteractionResponse>((resolve, reject) => {
				if (messageId && session) {
					session.pendingInteractions.set(messageId, { resolve, reject, request, messageId });
				}
				view.renderInteractionPrompt(toolCallEl, request, abortSignal)
					.then(resolve)
					.catch(reject);
			});
			return response;
		} finally {
			if (messageId && session) {
				session.pendingInteractions.delete(messageId);
				if (session.pendingInteractions.size === 0 && session.status === "waiting_approval") {
					session.setStatus("running");
				}
			}
		}
	});
}
