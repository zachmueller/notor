/**
 * Compaction manager — handles automatic and manual context compaction.
 *
 * Extracted from `ChatOrchestrator` (Phase B6). Manages threshold-based
 * auto-compaction during response loops and manual compaction triggered
 * by the user command.
 *
 * @see specs/ZZ-misc/multi-conversation-robustness-implementation-tasks.md — B6
 */

import { Notice } from "obsidian";
import type { Message } from "../types";
import type { ProviderRegistry } from "../providers/index";
import type { ConversationManager } from "./conversation";
import type { HistoryManager } from "./history";
import type { ConversationSession } from "./conversation-session";
import type { NotorChatView } from "../ui/chat-view";
import type { NotorSettings } from "../settings";
import { shouldCompact, performCompaction } from "../context/compaction";
import { showCompactingIndicator, showCompactionMarker } from "../ui/compaction-marker";
import { extractPendingMessages } from "./message-pipeline";
import { logger } from "../utils/logger";

const log = logger("CompactionManager");

export class CompactionManager {
	constructor(
		private readonly getSettings: () => NotorSettings,
		private readonly providerRegistry: ProviderRegistry,
		private readonly historyManager: HistoryManager,
		private readonly getConversationManager: () => ConversationManager,
		private readonly getView: () => NotorChatView | undefined,
		private readonly getViewForSession: (session: ConversationSession) => NotorChatView | undefined,
		private readonly getActiveModelId: () => string,
		private readonly getActiveUseExtendedContext: () => boolean,
	) {}

	/**
	 * Check compaction threshold and perform compaction if needed.
	 *
	 * Called before every LLM API call (user messages and tool-result round-trips).
	 * When threshold is crossed, sends conversation to LLM for summarization,
	 * constructs new context window, and logs the compaction record.
	 */
	async checkAndPerformCompaction(session?: ConversationSession): Promise<void> {
		const convManager = session?.conversationManager ?? this.getConversationManager();
		const conv = convManager.getActiveConversation();
		if (!conv) return;

		const settings = this.getSettings();
		const messages = convManager.getMessages();
		const modelId = session?.modelId ?? this.getActiveModelId();
		const useExtendedContext = session?.useExtendedContext ?? this.getActiveUseExtendedContext();

		if (!shouldCompact(messages, settings, modelId, useExtendedContext)) {
			return;
		}

		const pendingMessages = extractPendingMessages(messages);
		const allCompleted = messages.slice(0, messages.length - pendingMessages.length);

		// Messages with exclude_from_compaction are not seen by the summarizer
		// but must survive the cycle — re-appended between summary and pending.
		const excludedMessages = allCompleted.filter((m) => m.exclude_from_compaction);
		const completedMessages = allCompleted.filter((m) => !m.exclude_from_compaction);

		log.info("Compaction message split", {
			totalMessages: messages.length,
			pendingCount: pendingMessages.length,
			completedCount: completedMessages.length,
			excludedCount: excludedMessages.length,
			firstPendingRole: pendingMessages[0]?.role ?? "none",
			firstCompletedRole: completedMessages[0]?.role ?? "none",
			lastCompletedRole: completedMessages[completedMessages.length - 1]?.role ?? "none",
		});

		// Show compacting indicator in chat UI (session-aware)
		const viewForCompaction = session ? this.getViewForSession(session) : this.getView();
		const messagesContainer = viewForCompaction?.getMessagesContainer?.();
		let indicator: HTMLElement | null = null;
		if (messagesContainer) {
			indicator = showCompactingIndicator(messagesContainer);
		}

		log.info("Auto-compaction triggered", {
			conversationId: conv.id,
			messageCount: messages.length,
		});

		try {
			const provider = session
				? this.providerRegistry.getProvider(session.providerId)
				: this.providerRegistry.getActiveProvider();
			const result = await performCompaction(
				completedMessages,
				provider,
				settings,
				modelId,
				conv.id,
				"automatic",
				useExtendedContext
			);

			if (result.success && result.newMessages && result.record) {
				// Replace conversation messages with compacted context
				convManager.replaceMessages(result.newMessages);

				// Re-append excluded messages between summary and pending so they
				// survive compaction cycles (e.g., memory-recalled blocks at start).
				for (const excluded of excludedMessages) {
					convManager.addMessage({
						role: excluded.role,
						content: excluded.content,
						tool_call: excluded.tool_call ?? undefined,
						tool_result: excluded.tool_result ?? undefined,
						is_hook_injection: excluded.is_hook_injection,
						is_workflow_message: excluded.is_workflow_message,
						hook_injections: excluded.hook_injections ?? undefined,
						attachments: excluded.attachments ?? undefined,
						auto_context: excluded.auto_context ?? undefined,
						source_extension: excluded.source_extension ?? undefined,
						exclude_from_compaction: excluded.exclude_from_compaction,
					});
				}

				// Re-append pending messages so the conversation ends with a user
				// turn. Without this, providers like Bedrock reject the next call
				// because the last message in the compacted context is an assistant
				// acknowledgment ("Understood. I have the context…").
				for (const pending of pendingMessages) {
					convManager.addMessage({
						role: pending.role,
						content: pending.content,
						tool_call: pending.tool_call ?? undefined,
						tool_result: pending.tool_result ?? undefined,
						is_hook_injection: pending.is_hook_injection,
						is_workflow_message: pending.is_workflow_message,
						hook_injections: pending.hook_injections ?? undefined,
						attachments: pending.attachments ?? undefined,
						auto_context: pending.auto_context ?? undefined,
						source_extension: pending.source_extension ?? undefined,
						exclude_from_compaction: pending.exclude_from_compaction,
					});
				}

				// Log compaction record to JSONL
				await this.historyManager.appendMessage(conv, {
					id: result.record.id,
					conversation_id: conv.id,
					role: "system",
					content: JSON.stringify(result.record),
					timestamp: result.record.timestamp,
				} as Message);

				// Show permanent marker
				if (messagesContainer) {
					showCompactionMarker(
						messagesContainer,
						indicator,
						result.record.timestamp,
						result.record.token_count_at_compaction
					);
				} else {
					indicator?.remove();
				}

				new Notice("Context compacted successfully");
				log.info("Auto-compaction complete", {
					conversationId: conv.id,
					summaryTokens: result.summaryTokens,
				});
			} else {
				// Compaction failed — fall back to existing truncation
				indicator?.remove();
				const errMsg = result.error ?? "Unknown compaction error";
				log.warn("Compaction failed, falling back to truncation", { error: errMsg });
				new Notice(`Context compaction failed: ${errMsg}. Falling back to truncation.`);
			}
		} catch (e) {
			indicator?.remove();
			const errorMsg = e instanceof Error ? e.message : String(e);
			log.error("Compaction error", { error: errorMsg });
			new Notice(`Context compaction error: ${errorMsg}`);
		}
	}

	/**
	 * Manually trigger context compaction.
	 *
	 * Registered as the "Notor: Compact context" command.
	 */
	async manualCompaction(): Promise<void> {
		const convManager = this.getConversationManager();
		const conv = convManager.getActiveConversation();
		if (!conv) {
			new Notice("No active conversation to compact.");
			return;
		}

		const settings = this.getSettings();
		const messages = convManager.getMessages();
		if (messages.length < 2) {
			new Notice("Conversation is too short to compact.");
			return;
		}

		const modelId = this.getActiveModelId();
		const useExtendedContext = this.getActiveUseExtendedContext();

		const pendingMessages = extractPendingMessages(messages);
		const allCompleted = messages.slice(0, messages.length - pendingMessages.length);
		const excludedMessages = allCompleted.filter((m) => m.exclude_from_compaction);
		const completedMessages = allCompleted.filter((m) => !m.exclude_from_compaction);

		// Show compacting indicator
		const messagesContainer = this.getView()?.getMessagesContainer?.();
		let indicator: HTMLElement | null = null;
		if (messagesContainer) {
			indicator = showCompactingIndicator(messagesContainer);
		}

		try {
			const provider = this.providerRegistry.getActiveProvider();
			const result = await performCompaction(
				completedMessages,
				provider,
				settings,
				modelId,
				conv.id,
				"manual",
				useExtendedContext
			);

			if (result.success && result.newMessages && result.record) {
				convManager.replaceMessages(result.newMessages);

				// Re-append excluded messages between summary and pending.
				for (const excluded of excludedMessages) {
					convManager.addMessage({
						role: excluded.role,
						content: excluded.content,
						tool_call: excluded.tool_call ?? undefined,
						tool_result: excluded.tool_result ?? undefined,
						is_hook_injection: excluded.is_hook_injection,
						is_workflow_message: excluded.is_workflow_message,
						hook_injections: excluded.hook_injections ?? undefined,
						attachments: excluded.attachments ?? undefined,
						auto_context: excluded.auto_context ?? undefined,
						source_extension: excluded.source_extension ?? undefined,
						exclude_from_compaction: excluded.exclude_from_compaction,
					});
				}

				// Re-append any pending messages so the conversation ends on a user turn.
				for (const pending of pendingMessages) {
					convManager.addMessage({
						role: pending.role,
						content: pending.content,
						tool_call: pending.tool_call ?? undefined,
						tool_result: pending.tool_result ?? undefined,
						is_hook_injection: pending.is_hook_injection,
						is_workflow_message: pending.is_workflow_message,
						hook_injections: pending.hook_injections ?? undefined,
						attachments: pending.attachments ?? undefined,
						auto_context: pending.auto_context ?? undefined,
						source_extension: pending.source_extension ?? undefined,
						exclude_from_compaction: pending.exclude_from_compaction,
					});
				}

				await this.historyManager.appendMessage(conv, {
					id: result.record.id,
					conversation_id: conv.id,
					role: "system",
					content: JSON.stringify(result.record),
					timestamp: result.record.timestamp,
				} as Message);

				if (messagesContainer) {
					showCompactionMarker(
						messagesContainer,
						indicator,
						result.record.timestamp,
						result.record.token_count_at_compaction
					);
				} else {
					indicator?.remove();
				}

				new Notice("Context compacted successfully");
			} else {
				indicator?.remove();
				new Notice(`Compaction failed: ${result.error ?? "Unknown error"}`);
			}
		} catch (e) {
			indicator?.remove();
			const errorMsg = e instanceof Error ? e.message : String(e);
			new Notice(`Compaction error: ${errorMsg}`);
		}
	}
}
