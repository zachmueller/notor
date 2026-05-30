import type { BuilderContext, ExtensionUtils, ChatHistorySummary } from "./types";
import type { Message } from "../../types";
import { logger } from "../../utils/logger";
import { resolvePreset } from "../../presets/preset-resolver";
import { getTextContent } from "../../media/types";
import { estimateTokenCount } from "../../utils/tokens";
import { checkRateLimit } from "../rate-limiter";

/**
 * Build the `ask` primitive. Wired after `buildUtils` assembles the object so
 * `ask` can read the per-call `interactionCallback` that UserToolAdapter
 * attaches at invocation time (mirroring how `memory` is wired last).
 *
 * Returns null when no interaction channel is wired (headless/background runs).
 */
export function buildAsk(utils: ExtensionUtils): ExtensionUtils["ask"] {
	const log = logger("ext:ask");
	let counter = 0;
	return async (
		question: string,
		opts?: { suggestions?: string[]; allowFreeText?: boolean },
	): Promise<string | null> => {
		const cb = utils.interactionCallback;
		if (!cb) {
			log.warn("utils.ask called with no interaction channel available");
			return null;
		}
		if (typeof question !== "string" || question.trim().length === 0) {
			throw new Error("utils.ask requires a non-empty question string.");
		}
		counter += 1;
		const id = `ask-${counter}`;
		const response = await cb({
			type: "ask",
			id,
			question,
			suggestions: opts?.suggestions,
			allowFreeText: opts?.allowFreeText,
		});
		return response.value;
	};
}

export function buildChatUtils(ctx: BuilderContext): Pick<ExtensionUtils,
	"llmCall" | "conversationApi" | "chatHistory" | "chatBlocks"
> {
	const { plugin, conversationId, sourceExtensionName } = ctx;

	return {
		llmCall: (() => {
			const log = logger("ext:llmCall");
			let depth = 0;
			return async (
				presetName: string,
				messages: Array<{ role: string; content: string }>,
			): Promise<string | null> => {
				if (depth >= 1) {
					log.warn("llmCall recursion depth exceeded");
					return null;
				}
				const resolved = resolvePreset(presetName, plugin.settings.model_presets);
				if (!resolved) return null;

				depth++;
				try {
					const provider = plugin.getProviderRegistry().getProvider(resolved.providerId);
					const stream = provider.sendMessage(
						messages.map((m) => ({
							role: m.role as "user" | "assistant" | "system",
							content: m.content,
						})),
						[],
						{ model: resolved.modelId },
					);
					let text = "";
					for await (const chunk of stream) {
						if (chunk.type === "text_delta") {
							text += chunk.text;
						} else if (chunk.type === "error") {
							log.warn("llmCall stream error", { error: chunk.error });
							return text || null;
						}
					}
					return text || null;
				} catch (e) {
					log.warn("llmCall failed", { preset: presetName, error: String(e) });
					return null;
				} finally {
					depth--;
				}
			};
		})(),

		chatHistory: (() => {
			const hm = plugin.getHistoryManager();
			if (!hm) return null;
			const toSummary = (e: { id: string; title?: string; preview?: string; created_at: string; updated_at: string; is_favorite?: boolean }): ChatHistorySummary => ({
				id: e.id,
				title: e.title,
				preview: e.preview,
				created_at: e.created_at,
				updated_at: e.updated_at,
				is_favorite: e.is_favorite,
				deep_link: `notor-conversation://${e.id}`,
			});
			return {
				search: async (query: string) => {
					const entries = await hm.searchConversations(query);
					return entries.map(toSummary);
				},
				loadConversation: async (cId: string) => {
					const entries = await hm.listConversations();
					const match = entries.find(e => e.id === cId);
					if (!match) return null;
					const { conversation, messages } = await hm.loadConversation(match.filename);
					return {
						id: conversation.id,
						title: conversation.title,
						created_at: conversation.created_at,
						updated_at: conversation.updated_at,
						messages: messages
							.filter(m => m.role === "user" || m.role === "assistant")
							.map(m => ({
								role: m.role,
								content: getTextContent(m.content),
								timestamp: m.timestamp,
							})),
						deep_link: `notor-conversation://${conversation.id}`,
					};
				},
				listRecent: async (limit = 20) => {
					const entries = await hm.listConversations();
					return entries.slice(0, limit).map(toSummary);
				},
				loadFull: async (cId: string): Promise<Message[] | null> => {
					const orchestrator = plugin.getActiveOrchestrator?.();
					const convManager = orchestrator?.getConversationManager();
					const activeConv = convManager?.getActiveConversation();
					if (activeConv && activeConv.id === cId) {
						return convManager!.getMessages();
					}

					const entries = await hm.listConversations();
					const match = entries.find(e => e.id === cId);
					if (!match) return null;
					const { messages } = await hm.loadConversation(match.filename);
					return messages;
				},
			};
		})(),

		conversationApi: (() => {
			const apiLog = logger("ext:conversationApi");
			if (!conversationId) {
				apiLog.debug("conversationApi: no conversationId, returning null");
				return null;
			}
			const orchestrator = plugin.getActiveOrchestrator?.();
			if (!orchestrator) {
				apiLog.debug("conversationApi: no active orchestrator, returning null", { conversationId });
				return null;
			}
			const convManager = orchestrator.getConversationManager();
			if (!convManager) {
				apiLog.debug("conversationApi: no conversation manager, returning null", { conversationId });
				return null;
			}
			const conv = convManager.getActiveConversation();
			if (!conv || conv.id !== conversationId) {
				apiLog.debug("conversationApi: conversation mismatch, returning null", {
					conversationId,
					activeConvId: conv?.id ?? null,
				});
				return null;
			}
			apiLog.debug("conversationApi: bound successfully", { conversationId });
			return {
				getTitle: () => convManager.getActiveConversation()?.title,
				setTitle: (title: string) => {
					apiLog.info("setTitle called", { title, conversationId });
					convManager.setTitle(title);
				},
				isFavorite: () => convManager.getActiveConversation()?.is_favorite ?? false,
				setFavorite: (favorite: boolean) => { convManager.setFavorite(favorite); },
			};
		})(),

		chatBlocks: (() => {
			const cbLog = logger("ext:chatBlocks");

			if (!sourceExtensionName) return null;

			return {
				emit: async (
					kind: string,
					data: Record<string, unknown>,
					opts?: { fallbackText?: string; conversationId?: string },
				): Promise<Message | null> => {
					let serialized: string;
					try {
						serialized = JSON.stringify(data);
					} catch {
						cbLog.error("chatBlocks.emit: data is not JSON-serializable", { kind, extension: sourceExtensionName });
						return null;
					}
					if (serialized.length > 102400) {
						cbLog.error("chatBlocks.emit: data exceeds 100KB size limit", { kind, extension: sourceExtensionName, size: serialized.length });
						return null;
					}

					if (plugin.settings.tool_enabled[sourceExtensionName] === false) {
						cbLog.warn("chatBlocks.emit: extension is disabled — no-op", { kind, extension: sourceExtensionName });
						return null;
					}

					const targetConversationId = opts?.conversationId ?? conversationId;

					if (targetConversationId) {
						const maxEmits = plugin.settings.extension_block_max_emits_per_window;
						const windowMs = plugin.settings.extension_block_rate_window_seconds * 1000;
						if (!checkRateLimit(targetConversationId, maxEmits, windowMs)) {
							cbLog.warn("chatBlocks.emit: rate limit exceeded", {
								kind,
								extension: sourceExtensionName,
								conversationId: targetConversationId,
								limit: maxEmits,
								windowSeconds: plugin.settings.extension_block_rate_window_seconds,
							});
							return null;
						}
					}

					const registry = plugin.getChatBlockRegistry();
					const def = registry.get(kind);
					let estimated_wire_tokens: number;
					if (def?.toLLMText) {
						const wireText = def.toLLMText(data);
						estimated_wire_tokens = wireText != null ? estimateTokenCount(wireText) : 0;
					} else if (opts?.fallbackText != null) {
						estimated_wire_tokens = estimateTokenCount(opts.fallbackText);
					} else {
						estimated_wire_tokens = 0;
					}

					if (!def?.toLLMText && (opts?.fallbackText == null || opts.fallbackText === "")) {
						cbLog.warn(`Block kind '${kind}' will not be visible to the LLM — no toLLMText or fallback_text.`);
					}

					if (!def) {
						cbLog.warn(`chatBlocks.emit: kind '${kind}' is not registered in ChatBlockRegistry — will render with fallback`, { extension: sourceExtensionName });
					}

					const exclude_from_compaction = def?.excludeFromCompaction ?? false;

					const messageParams = {
						role: "extension_block" as const,
						content: [{
							type: "custom_block" as const,
							kind,
							data,
							fallback_text: opts?.fallbackText,
							estimated_wire_tokens,
						}],
						source_extension: sourceExtensionName,
						exclude_from_compaction,
					};

					const orchestrator = plugin.getActiveOrchestrator?.();
					const convManager = orchestrator?.getConversationManager();
					const activeConv = convManager?.getActiveConversation();

					if (activeConv && activeConv.id === targetConversationId) {
						const transient = convManager!.getMessages().find((m) =>
							m.role === "extension_block" &&
							Array.isArray(m.content) &&
							m.content.some(
								(b) => b.type === "custom_block" && (b as { kind: string; loading?: boolean }).kind === kind && (b as { loading?: boolean }).loading === true,
							),
						);
						if (transient) {
							const promoted = convManager!.promoteTransientMessage(transient.id, messageParams.content, {
								exclude_from_compaction: messageParams.exclude_from_compaction,
							});
							if (promoted) {
								cbLog.debug("chatBlocks.emit: promoted transient block", { kind, conversationId: targetConversationId });
								return promoted;
							}
						}
						const message = convManager!.addMessage(messageParams);
						cbLog.debug("chatBlocks.emit: emitted to active conversation", { kind, conversationId: targetConversationId });
						return message;
					}

					if (targetConversationId) {
						const hm = plugin.getHistoryManager();
						const message = await hm.addMessageToConversation(targetConversationId, messageParams);
						if (message) {
							cbLog.debug("chatBlocks.emit: emitted to non-active conversation", { kind, conversationId: targetConversationId });
						} else {
							cbLog.warn("chatBlocks.emit: conversation not found", { kind, conversationId: targetConversationId });
						}
						return message;
					}

					cbLog.warn("chatBlocks.emit: no conversation available", { kind, extension: sourceExtensionName });
					return null;
				},
			};
		})(),
	};
}
