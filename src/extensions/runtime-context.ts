/**
 * Runtime context builder for user-defined extensions.
 *
 * Assembles the `utils`, `libs`, and `obsidian` objects injected into
 * extension functions at execution time.
 */

import type NotorPlugin from "../main";
import type { Logger } from "../utils/logger";
import type { StaleContentTracker } from "../chat/stale-tracker";
import type { CheckpointManager } from "../checkpoints/checkpoint";
import type { NoteOpener } from "../tools/note-opener";
import type { ShellExecuteOptions, ShellExecuteResult } from "../shell/shell-executor";
import type { ResolvedToolConfigEntry } from "../tool-config/types";
import type { TFile } from "obsidian";

import { resolveNote } from "../utils/resolve-note";
import { logger } from "../utils/logger";
import { resolveAndValidatePath, isPathWithin } from "../utils/path-validation";
import { executeShellCommand } from "../shell/shell-executor";
import { enforcePathConstraints } from "../tool-config/path-enforcer";
import { isDomainBlocked } from "../utils/domain-denylist";
import { detectMediaFormat } from "../media/format-detector";
import { processImage } from "../media/image-processor";
import { processPdf } from "../media/pdf-processor";
import { getTextContent, type ContentBlock, type ImageMediaType } from "../media/types";
import { resolveImageForDocx } from "../tools/docx-image-utils";
import type { DocxImageData } from "../tools/docx-image-utils";
import { graftIntoTemplate } from "../tools/docx-template-graft";
import { estimateTokenCount } from "../utils/tokens";
import { normalizedIndexOf } from "../utils/unicode-normalize";
import type { Message } from "../types";
import type { SubAgentResult } from "../chat/sub-agent-runner";
import { SubAgentRunner } from "../chat/sub-agent-runner";
import { ToolDispatcher } from "../chat/dispatcher";
import { intersectToolConfig } from "../tool-config/merger";
import { SUB_AGENT_PREAMBLE } from "../sub-agents/preamble";
import { SUB_AGENT_ITERATION_CAP, SUB_AGENT_TOKEN_LIMIT } from "../sub-agents/constants";
import { resolvePreset } from "../presets/preset-resolver";
import {
	parseCommentsXml,
	parseCommentsExtendedXml,
	extractQuotedText,
	parsePeopleXml,
	buildCommentThreads,
	formatCommentsAsMarkdown,
	extractExistingCommentIds,
} from "../tools/docx-comment-parser";
import type { RawComment, Comment } from "../tools/docx-comment-parser";
import type { WebSearchApiResult, WebSearchResolvedConfig } from "../web-search/queue";

// Obsidian exports
import { requestUrl, Notice, TFile as TFileClass, TFolder, getFrontMatterInfo, normalizePath, MarkdownView, Platform } from "obsidian";

// Bundled libraries (static imports)
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import * as docx from "docx";
import PizZip from "pizzip";
import { marked } from "marked";
import * as xmldom from "@xmldom/xmldom";
import { Cron } from "croner";

// ---------------------------------------------------------------------------
// Extension block rate limiter (Phase 12)
// ---------------------------------------------------------------------------

import { checkRateLimit } from "./rate-limiter";

// ---------------------------------------------------------------------------
// Memory library imports (Phase 1)
// ---------------------------------------------------------------------------

import type { MemoryNote } from "../memory/note-format";
import {
	serializeNote,
	parseNote,
	slugifyTitle,
	computeFingerprint,
	assertMemoryPath,
	extractJSON,
	patchFrontmatterField,
	extractMemoryWikilinks,
} from "../memory/note-format";
import {
	readDedupCache,
	writeDedupEntry,
	readDreamCursor,
	advanceDreamCursor,
} from "../memory/dedup-cache";
import { resolveConcept } from "../memory/concept-resolver";
import type { ResolveConceptResult } from "../memory/concept-resolver";
import { PendingMemoryManager } from "../memory/pending-memory-manager";

// ---------------------------------------------------------------------------
// Utils builder
// ---------------------------------------------------------------------------

/** Lightweight conversation summary returned by chat history tools. */
export interface ChatHistorySummary {
	id: string;
	title?: string;
	preview?: string;
	created_at: string;
	updated_at: string;
	is_favorite?: boolean;
	deep_link: string;
}

/** Full conversation with messages returned by chat history tools. */
export interface ChatHistoryConversation {
	id: string;
	title?: string;
	created_at: string;
	updated_at: string;
	messages: Array<{ role: string; content: string; timestamp: string }>;
	deep_link: string;
}

/** Shape of the `utils` object injected into extension functions. */
export interface ExtensionUtils {
	resolveNote: (path: string) => TFile | null;
	staleTracker: StaleContentTracker;
	checkpointManager: CheckpointManager;
	noteOpener: NoteOpener;
	logger: (name: string) => Logger;
	resolveAndValidatePath: (
		path: string,
		allowedPaths?: string[],
	) => { valid: true; resolvedPath: string } | { valid: false; error: string };
	executeShellCommand: (cmd: string, opts?: ShellExecuteOptions) => Promise<ShellExecuteResult>;
	pathEnforcer: {
		enforcePathConstraints: (
			toolName: string,
			params: Record<string, unknown>,
			entry: ResolvedToolConfigEntry,
		) => string | null;
		isPathWithin: (target: string, base: string) => boolean;
	};
	/** Check if a URL's domain matches any pattern in the denylist. */
	isDomainBlocked: (url: string, denylist: string[]) => { blocked: true; pattern: string } | { blocked: false };
	/** Create intermediate vault directories for a file path. */
	ensureDirectoryExists: (filePath: string) => Promise<void>;
	/** Detect media format from buffer magic bytes. */
	detectMediaFormat: (buffer: Buffer) => "png" | "jpeg" | "gif" | "webp" | "pdf" | null;
	/** Process an image buffer for LLM consumption (resize, compress). */
	processImage: (buffer: Buffer, mediaType: ImageMediaType, options?: { maxDimension?: number; compressionQuality?: number }) => Promise<ContentBlock>;
	/** Process a PDF buffer for LLM consumption. Reads active_provider and pdf_native_max_size_mb internally. */
	processPdf: (buffer: Buffer, options: { pages?: string; maxTextChars?: number; preferNative?: boolean }) => Promise<{ contentBlocks: ContentBlock[]; textSummary: string }>;
	/** Resolve an image href to data suitable for embedding in a DOCX via ImageRun. */
	resolveImageForDocx: (href: string, allowedPaths?: string[]) => Promise<DocxImageData | null>;
	/** Graft generated DOCX body content into a template, preserving template styles/margins/headers/footers. */
	graftDocxIntoTemplate: (generatedZip: import("pizzip"), templateZip: import("pizzip")) => Promise<void>;
	/** DOCX comment parsing utilities. */
	docxComments: {
		parseCommentsXml: (xml: string) => RawComment[];
		parseCommentsExtendedXml: (xml: string) => { resolvedIds: Set<string>; threadingMap: Map<string, string> };
		extractQuotedText: (documentXml: string, commentId: string) => string;
		parsePeopleXml: (xml: string) => Map<string, string>;
		buildCommentThreads: (raw: RawComment[], threadingMap: Map<string, string>, resolvedIds: Set<string>, includeResolved: boolean, peopleMap: Map<string, string>) => Comment[];
		formatCommentsAsMarkdown: (comments: Comment[], filename: string, startNumber: number) => string;
		extractExistingCommentIds: (existingContent: string) => { ids: Set<string>; maxNumber: number };
	};
	/** Per-lane FIFO serialization queue with optional inter-completion delays. */
	queue: {
		enqueue: <T>(lane: string, fn: () => Promise<T>, delayMs?: number) => Promise<T>;
		pending: (lane: string) => number;
	};
	/** Multi-provider web search with fallback and round-robin. */
	webSearch: {
		search: (query: string, numResults: number, timeoutMs: number, signal?: AbortSignal) => Promise<WebSearchApiResult>;
		searchWithConfig: (query: string, numResults: number, timeoutMs: number, config: WebSearchResolvedConfig, signal?: AbortSignal) => Promise<WebSearchApiResult>;
		buildConfig: (settings: Record<string, unknown>) => WebSearchResolvedConfig;
	};
	/**
	 * Make an LLM call using a named model preset.
	 *
	 * Resolves the preset to a provider+model, sends the messages, and
	 * collects the streaming response into a string. Returns null if the
	 * preset is unconfigured or the call fails.
	 *
	 * A recursion depth guard (max depth 1) prevents unbounded LLM→tool→LLM loops.
	 */
	llmCall: (
		presetName: string,
		messages: Array<{ role: string; content: string }>,
	) => Promise<string | null>;
	/**
	 * API for reading/writing conversation metadata.
	 *
	 * Returns null when no active conversation exists (e.g., tool executed
	 * outside a conversation context).
	 */
	conversationApi: {
		getTitle: () => string | undefined;
		setTitle: (title: string) => void;
		isFavorite: () => boolean;
		setFavorite: (favorite: boolean) => void;
	} | null;
	/**
	 * API for searching and reading past chat conversations from local history.
	 *
	 * Wraps `HistoryManager` methods with simplified return types suitable
	 * for tool consumption. Returns null only if history is unavailable.
	 */
	chatHistory: {
		search: (query: string) => Promise<ChatHistorySummary[]>;
		loadConversation: (conversationId: string) => Promise<ChatHistoryConversation | null>;
		listRecent: (limit?: number) => Promise<ChatHistorySummary[]>;
		/**
		 * Load the raw `Message[]` for a conversation — all roles, all fields
		 * (including `is_hook_injection`, `ContentBlock[]` content, tool calls,
		 * extension blocks).
		 *
		 * When the conversation has an active live session, reads from the
		 * in-memory `ConversationManager`. Falls back to persisted JSONL for
		 * inactive conversations. Returns `null` if not found.
		 */
		loadFull: (conversationId: string) => Promise<Message[] | null>;
	} | null;
	/**
	 * API for emitting extension blocks into the chat transcript.
	 *
	 * Null when no conversation is available (background vault events).
	 *
	 * LLM visibility: blocks emitted during blocking automations (pre_send,
	 * blocking on_conversation_start) land before the session snapshot and are
	 * visible to the LLM on the current turn. Blocks from non-blocking automations
	 * land after the snapshot and are only visible on subsequent turns.
	 */
	chatBlocks: {
		emit: (
			kind: string,
			data: Record<string, unknown>,
			opts?: { fallbackText?: string; conversationId?: string },
		) => Promise<Message | null>;
	} | null;
	/**
	 * Spawn a sub-agent from extension code.
	 *
	 * Resolves the named profile, builds a restricted tool dispatcher (matching
	 * the active orchestrator's effective config), and runs an isolated
	 * `SubAgentRunner` conversation loop.
	 *
	 * When `detached: true`, the sub-agent runs in the background; the
	 * `onComplete` callback is invoked when it finishes, and the returned
	 * Promise resolves to `null` immediately. When `detached: false` (default),
	 * the returned Promise resolves to the `SubAgentResult` when complete.
	 *
	 * Depth guard: max depth 1. Sub-agents cannot spawn further sub-agents
	 * via this API.
	 *
	 * Returns `null` when the profile cannot be resolved, no active orchestrator
	 * is available, or the depth guard fires.
	 */
	runSubAgent: (opts: {
		profileName: string;
		task: string;
		detached?: boolean;
		/** Suppress editor-open side effects for all tool calls within the sub-agent. */
		silent?: boolean;
		onComplete?: (result: SubAgentResult) => Promise<void> | void;
		iterationCap?: number;
		timeout?: number;
	}) => Promise<SubAgentResult | null>;
	/**
	 * Resolve a subdirectory path under the user's `notor_dir`.
	 *
	 * Returns `${settings.notor_dir}/${subdir}` (vault-relative).
	 */
	resolveNotorPath: (subdir: string) => string;
	/**
	 * Read the raw Markdown content of a vault note by path.
	 *
	 * Resolves the path via `resolveNote()` and reads via `vault.read()`.
	 * Throws if the file is not found.
	 */
	readNote: (path: string) => Promise<string>;
	/**
	 * Memory subsystem facade. Null when `memory_enabled` is false.
	 *
	 * Exposes deterministic library functions (note format, dedup, dream cursor)
	 * and the concept resolver (which spawns a sub-agent).
	 */
	memory: {
		resolveConcept: (args: {
			insight: string;
			memoryDir: string;
			resolverProfile: string;
			silent?: boolean;
			pendingMode?: boolean;
			pendingMemoryDir?: string;
		}) => Promise<ResolveConceptResult>;
		fingerprintAndDedup: (content: string, windowHours: number) => Promise<{ fingerprint: string; isDuplicate: boolean }>;
		serializeNote: (args: { title: string; body: string; sources: string[]; createdAt: string }) => string;
		parseNote: (markdown: string) => MemoryNote;
		slugifyTitle: (title: string) => string;
		assertMemoryPath: (vaultRelativePath: string, memoryDir: string) => void;
		readDedupCache: (windowHours: number) => Promise<Record<string, string>>;
		writeDedupEntry: (fingerprint: string, timestamp: string) => Promise<void>;
		readDreamCursor: () => Promise<string | null>;
		advanceDreamCursor: (timestamp: string) => Promise<void>;
		hasMemoryNotes: () => Promise<boolean>;
		extractJSON: (text: string) => unknown | null;
		patchFrontmatterField: (content: string, key: string, value: string) => string;
		extractMemoryWikilinks: (body: string, memoryDir: string) => string[];
		/** Manager for pending (unapproved) memory notes. */
		pendingMemoryManager: PendingMemoryManager;
	} | null;
	/**
	 * Current memory approval mode from plugin settings.
	 * "auto" | "bulk" | "bulk_and_inline". Null when memory is disabled.
	 */
	memoryApprovalMode: string | null;
	/**
	 * Read the current Notor plugin settings as a sanitized JSON object.
	 *
	 * Returns a deep clone with sensitive fields redacted (MCP env values)
	 * and transient data stripped (model caches).
	 */
	readPluginSettings: () => Record<string, unknown>;
	/**
	 * Edit a single Notor plugin setting by dot-separated key path.
	 *
	 * Validates the path exists, checks type compatibility, applies the
	 * change, and calls saveSettings() to persist and propagate.
	 */
	editPluginSetting: (keyPath: string, value: unknown) => Promise<{
		success: boolean;
		oldValue?: unknown;
		newValue?: unknown;
		error?: string;
	}>;
	/** Show an Obsidian Notice popup. */
	notify: (message: string, options?: {
		/** Duration in milliseconds. 0 = persistent until dismissed. Default: 5000. */
		duration?: number;
		/** Callback invoked on left-click. Notice is auto-hidden after. */
		onClick?: () => void;
		/** Callback invoked on right-click (desktop only). Notice is auto-hidden after. */
		onRightClick?: () => void;
	}) => void;
	/** Unicode-normalized indexOf for fuzzy SEARCH/REPLACE matching. */
	normalizedIndexOf: (haystack: string, needle: string) => { index: number; length: number } | null;
	/**
	 * Webview browser facade for interacting with Obsidian's Web Viewer.
	 * Null when not on desktop (Electron required).
	 */
	webview: {
		getConversationWebview: () => Promise<{ leaf: any; webviewEl: any } | null>;
		getActiveWebview: () => { leaf: any; webviewEl: any } | null;
		waitForReady: (webviewEl: any, revealLeaf?: boolean, leaf?: any) => Promise<void>;
		getConversationId: () => string | null;
		persistUrl: (conversationId: string, url: string) => Promise<void>;
		readPersistedUrl: (conversationId: string) => Promise<string | null>;
	} | null;
	/** AbortSignal for the current tool call — only set per-invocation by UserToolAdapter. */
	abortSignal?: AbortSignal;
	/** Progress callback for long-running tools — only set per-invocation by UserToolAdapter. */
	onProgress?: (status: string) => void;
}

/**
 * Resolve a dot-separated key path against a settings-like object
 * and return the available keys at that level (for error messages).
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
function getAvailableKeys(root: any, pathParts: string[]): string {
	let target = root;
	for (const part of pathParts) {
		const index = /^\d+$/.test(part) ? Number(part) : part;
		target = target?.[index];
		if (target === undefined || target === null || typeof target !== "object") return "";
	}
	return Object.keys(target).slice(0, 30).join(", ");
}
/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

/**
 * Build the `utils` object for extensions.
 *
 * @param plugin - The plugin instance.
 * @param conversationId - Optional conversation ID. When provided, `conversationApi`
 *   is bound to the correct conversation via ID lookup. When omitted, `conversationApi`
 *   is null.
 * @param sourceExtensionName - Name of the extension for use as `source_extension`
 *   on emitted chat blocks. When omitted, `chatBlocks` is null.
 *
 * Note: `abortSignal` and `onProgress` are NOT included — they're per-call only.
 * `UserToolAdapter.execute()` merges them into the returned object per-invocation.
 */
export function buildUtils(plugin: NotorPlugin, conversationId?: string, sourceExtensionName?: string): ExtensionUtils {
	const vaultRootPath = (plugin.app.vault.adapter as { basePath?: string }).basePath ?? "";

	const utils: ExtensionUtils = {
		resolveNote: (path: string) =>
			resolveNote(path, plugin.app.vault, plugin.app.metadataCache),

		staleTracker: plugin.getStaleTracker(),

		checkpointManager: plugin.getSharedCheckpointManager(),

		noteOpener: plugin.getNoteOpener(),

		logger: (name: string) => logger(`ext:${name}`),

		resolveAndValidatePath: (path: string, allowedPaths?: string[]) =>
			resolveAndValidatePath(
				path,
				vaultRootPath,
				allowedPaths ?? (plugin.settings.user_shared_settings?.["read_file_allowed_paths"] as string[] | undefined) ?? [],
			),

		executeShellCommand: (cmd: string, opts?: ShellExecuteOptions) =>
			executeShellCommand(cmd, plugin.settings, opts),

		pathEnforcer: {
			enforcePathConstraints: (
				toolName: string,
				params: Record<string, unknown>,
				entry: ResolvedToolConfigEntry,
			) => enforcePathConstraints(toolName, params, entry, vaultRootPath, (path: string) => {
				const file = resolveNote(path, plugin.app.vault, plugin.app.metadataCache);
				return file?.path ?? null;
			}),

			isPathWithin: (target: string, base: string) =>
				isPathWithin(target, base),
		},

		isDomainBlocked,

		normalizedIndexOf,

		detectMediaFormat,

		processImage,

		processPdf: (buffer: Buffer, options: { pages?: string; maxTextChars?: number; preferNative?: boolean }) =>
			processPdf(buffer, {
				...options,
				providerType: plugin.getProviderRegistry().getActiveType(),
				maxNativeSizeBytes: plugin.settings.pdf_native_max_size_mb * 1024 * 1024,
			}),

		ensureDirectoryExists: async (filePath: string) => {
			const parts = filePath.split("/");
			parts.pop(); // remove filename
			if (parts.length === 0) return;
			let current = "";
			for (const part of parts) {
				current = current ? `${current}/${part}` : part;
				const existing = plugin.app.vault.getAbstractFileByPath(current);
				if (!existing) {
					await plugin.app.vault.createFolder(current);
				} else if (!(existing instanceof TFolder)) {
					throw new Error(`Cannot create directory: "${current}" already exists as a file`);
				}
			}
		},

		resolveImageForDocx: (href: string, allowedPaths?: string[]) =>
			resolveImageForDocx(href, vaultRootPath, allowedPaths ?? (plugin.settings.user_shared_settings?.["read_file_allowed_paths"] as string[] | undefined) ?? []),

		graftDocxIntoTemplate: graftIntoTemplate,

		docxComments: {
			parseCommentsXml,
			parseCommentsExtendedXml,
			extractQuotedText,
			parsePeopleXml,
			buildCommentThreads,
			formatCommentsAsMarkdown,
			extractExistingCommentIds,
		},

		queue: (() => {
			const tlq = plugin.getTaskLaneQueue();
			return {
				enqueue: <T>(lane: string, fn: () => Promise<T>, delayMs?: number) => tlq.enqueue(lane, fn, delayMs),
				pending: (lane: string) => tlq.pending(lane),
			};
		})(),

		webSearch: {
			search: (query: string, numResults: number, timeoutMs: number, signal?: AbortSignal) =>
				plugin.getWebSearchQueue().search(query, numResults, timeoutMs, signal),
			searchWithConfig: (query: string, numResults: number, timeoutMs: number, config: WebSearchResolvedConfig, signal?: AbortSignal) =>
				plugin.getWebSearchQueue().searchWithConfig(query, numResults, timeoutMs, config, signal),
			buildConfig: (settings: Record<string, unknown>) =>
				plugin.getWebSearchQueue().buildConfig(settings),
		},

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
				const { resolvePreset: resolve } = await import("../presets/preset-resolver");
				const resolved = resolve(presetName, plugin.settings.model_presets);
				if (!resolved) return null;

				depth++;
				try {
					const provider = plugin.getProviderRegistry().getProvider(resolved.providerId);
					const stream = provider.sendMessage(
						messages.map((m) => ({
							role: m.role as "user" | "assistant" | "system",
							content: m.content,
						})),
						[], // no tools
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
				loadConversation: async (conversationId: string) => {
					const entries = await hm.listConversations();
					const match = entries.find(e => e.id === conversationId);
					if (!match) return null;
					const { conversation, messages } = await hm.loadConversation(match.filename);
					return {
						id: conversation.id,
						title: conversation.title,
						created_at: conversation.created_at,
						updated_at: conversation.updated_at,
						// extension_block messages are intentionally excluded — extensions see
						// only user/assistant turns in their conversation history context.
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
				loadFull: async (conversationId: string): Promise<Message[] | null> => {
					// Live session: read from in-memory ConversationManager
					const orchestrator = plugin.getActiveOrchestrator?.();
					const convManager = orchestrator?.getConversationManager();
					const activeConv = convManager?.getActiveConversation();
					if (activeConv && activeConv.id === conversationId) {
						return convManager!.getMessages();
					}

					// Inactive: resolve ID → filename, then load from JSONL
					const entries = await hm.listConversations();
					const match = entries.find(e => e.id === conversationId);
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
			// Verify the conversation exists
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

		runSubAgent: (() => {
			const rsaLog = logger("ext:runSubAgent");
			let depth = 0;

			return async (opts: {
				profileName: string;
				task: string;
				detached?: boolean;
				silent?: boolean;
				onComplete?: (result: SubAgentResult) => Promise<void> | void;
				iterationCap?: number;
				timeout?: number;
			}): Promise<SubAgentResult | null> => {
				// Depth guard: sub-agents spawned from extensions cannot spawn further sub-agents
				if (depth >= 1) {
					rsaLog.warn("runSubAgent depth limit exceeded (max 1)");
					return null;
				}

				// Resolve profile
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

				// Resolve provider and model (preset takes precedence)
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

				// Build sub-agent tool dispatcher: intersect active orchestrator's effective
				// config with the profile's tool configs.
				const orchestrator = plugin.getActiveOrchestrator?.();
				const parentEffectiveConfig = orchestrator?.getEffectiveToolConfig() ?? (() => {
					// Build permissive default when no orchestrator (background context)
					const tools: import("../tool-config/types").EffectiveToolConfig["tools"] = {};
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

				const mergedSubAgentConfig: import("../tool-config/types").ParsedToolConfig = {
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

				const toolDefinitions: import("../providers/provider").ToolDefinition[] = enabledToolNames
					.map(name => toolRegistry.get(name))
					.filter((t): t is NonNullable<typeof t> => t !== undefined)
					.map(t => ({
						name: t.name,
						description: t.description,
						input_schema: t.input_schema as import("../providers/provider").ToolDefinition["input_schema"],
						mode: t.mode,
					}));

				const systemPrompt = SUB_AGENT_PREAMBLE + "\n" + profile.prompt_content;

				// Standalone abort controller — aborted on timeout or plugin unload
				const controller = new AbortController();

				// Timeout handling
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
					// Register controller so plugin unload can abort it
					plugin.registerDetachedSubAgent(controller);

					// Fire and forget — invoke onComplete when done
					(async () => {
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

				// Synchronous (blocking) path — return result directly
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
			};
		})(),

		resolveNotorPath: (subdir: string) =>
			normalizePath(`${plugin.settings.notor_dir}/${subdir}`),

		readNote: async (path: string) => {
			const file = resolveNote(path, plugin.app.vault, plugin.app.metadataCache);
			if (!file) {
				throw new Error(`Note not found: ${path}`);
			}
			return plugin.app.vault.read(file);
		},

		chatBlocks: (() => {
			const cbLog = logger("ext:chatBlocks");

			// sourceExtensionName is required for block attribution
			if (!sourceExtensionName) return null;

			return {
				emit: async (
					kind: string,
					data: Record<string, unknown>,
					opts?: { fallbackText?: string; conversationId?: string },
				): Promise<Message | null> => {
					// Validate data is JSON-serializable and within size limit
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

					// Gate: disabled extension cannot emit
					// Tools are disabled via tool_enabled[name]; automations never execute when disabled
					if (plugin.settings.tool_enabled[sourceExtensionName] === false) {
						cbLog.warn("chatBlocks.emit: extension is disabled — no-op", { kind, extension: sourceExtensionName });
						return null;
					}

					// Resolve target conversation ID
					const targetConversationId = opts?.conversationId ?? conversationId;

					// Rate limit: sliding window per conversation
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

					// Compute estimated_wire_tokens via registry
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

					// Warn if block will not be visible to the LLM
					if (!def?.toLLMText && (opts?.fallbackText == null || opts.fallbackText === "")) {
						cbLog.warn(`Block kind '${kind}' will not be visible to the LLM — no toLLMText or fallback_text.`);
					}

					// Warn if kind is unregistered (still emits with fallback rendering)
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

					// Active conversation path: live render + persist
					const orchestrator = plugin.getActiveOrchestrator?.();
					const convManager = orchestrator?.getConversationManager();
					const activeConv = convManager?.getActiveConversation();

					if (activeConv && activeConv.id === targetConversationId) {
						// If a transient loading placeholder of this kind exists, promote it
						// in-place so the final block occupies the same position in the message
						// array (and JSONL) as the placeholder — keeping correct ordering.
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

					// Non-active conversation path: persist to JSONL only
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

		readPluginSettings: () => {
			const clone = JSON.parse(JSON.stringify(plugin.settings)) as Record<string, unknown>;

			// Redact MCP server env values (could contain secrets)
			const mcpServers = clone.mcp_servers as Record<string, Record<string, unknown>> | undefined;
			if (mcpServers && typeof mcpServers === "object") {
				for (const server of Object.values(mcpServers)) {
					if (Array.isArray(server.env)) {
						for (const entry of server.env as Array<Record<string, unknown>>) {
							if (entry && typeof entry === "object") {
								entry.value = "[REDACTED]";
							}
						}
					}
					if (Array.isArray(server.headers)) {
						for (const header of server.headers as Array<Record<string, unknown>>) {
							if (header && typeof header === "object" && header.sensitive) {
								header.value = "[REDACTED]";
							}
						}
					}
				}
			}

			// Strip transient model caches (large, not user-facing)
			const providers = clone.providers as Array<Record<string, unknown>> | undefined;
			if (Array.isArray(providers)) {
				for (const p of providers) {
					delete p.model_cache;
					delete p.model_cache_timestamp;
				}
			}

			return clone;
		},

		editPluginSetting: (() => {
			const editLog = logger("ext:editPluginSetting");

			const BLOCKED_PATTERNS = [
				/^mcp_servers\.[^.]+\.env/,
				/^mcp_servers\.[^.]+\.headers/,
				/^providers\.\d+\.model_cache/,
				/^providers\.\d+\.model_cache_timestamp/,
			];

			return async (keyPath: string, value: unknown): Promise<{
				success: boolean;
				oldValue?: unknown;
				newValue?: unknown;
				error?: string;
			}> => {
				// Validate against denylist
				for (const pattern of BLOCKED_PATTERNS) {
					if (pattern.test(keyPath)) {
						return { success: false, error: `Path "${keyPath}" is blocked for security reasons.` };
					}
				}

				// Dynamic key-path traversal requires runtime-typed access
				/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */

				// Resolve the key path
				const parts = keyPath.split(".");
				let target: any = plugin.settings;
				for (let i = 0; i < parts.length - 1; i++) {
					const key = parts[i]!;
					const index = /^\d+$/.test(key) ? Number(key) : key;
					target = target?.[index];
					if (target === undefined || target === null || typeof target !== "object") {
						const availableKeys = getAvailableKeys(plugin.settings, parts.slice(0, i));
						return {
							success: false,
							error: `Invalid path: "${keyPath}" — "${parts.slice(0, i + 1).join(".")}" does not exist.${availableKeys ? ` Available keys at "${parts.slice(0, i).join(".") || "(root)"}": ${availableKeys}` : ""}`,
						};
					}
				}

				const lastKey = parts[parts.length - 1]!;
				const finalIndex = /^\d+$/.test(lastKey) ? Number(lastKey) : lastKey;

				if (!(finalIndex in target)) {
					const parentPath = parts.slice(0, -1).join(".");
					const availableKeys = Object.keys(target).slice(0, 30).join(", ");
					return {
						success: false,
						error: `Key "${lastKey}" does not exist at "${parentPath || "(root)"}". Available keys: ${availableKeys}`,
					};
				}

				const oldValue = target[finalIndex];

				// Type compatibility check
				if (oldValue !== null && oldValue !== undefined && value !== null && value !== undefined) {
					const oldType = Array.isArray(oldValue) ? "array" : typeof oldValue;
					const newType = Array.isArray(value) ? "array" : typeof value;
					if (oldType !== newType) {
						return {
							success: false,
							error: `Type mismatch: "${keyPath}" is ${oldType} but got ${newType}.`,
						};
					}
				}

				// Apply the change
				target[finalIndex] = value;

				// Persist and propagate
				try {
					await plugin.saveSettings();
					editLog.info("Setting edited", { keyPath, oldValue, newValue: value });
					return { success: true, oldValue, newValue: value };
				} catch (e) {
					// Revert on save failure
					target[finalIndex] = oldValue;
					/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any */
					const msg = e instanceof Error ? e.message : String(e);
					editLog.error("Failed to save settings after edit", { keyPath, error: msg });
					return { success: false, error: `Failed to save: ${msg}` };
				}
			};
		})(),

		notify: (message: string, options?: {
			duration?: number;
			onClick?: () => void;
			onRightClick?: () => void;
		}) => {
			const duration = options?.duration ?? 5000;
			const notice = new Notice(message, duration);

			if (options?.onClick) {
				notice.noticeEl.addEventListener("click", () => {
					notice.hide();
					options.onClick!();
				});
			}

			if (options?.onRightClick && Platform.isDesktop) {
				notice.noticeEl.oncontextmenu = (e) => {
					e.preventDefault();
					notice.hide();
					options.onRightClick!();
				};
			}
		},

		webview: null,

		memory: null,
		memoryApprovalMode: null,
	};

	// Wire webview facade — desktop only (Electron required for <webview> tag).
	if (Platform.isDesktopApp) {
		const WEB_VIEWER_VIEW_TYPE = "web-browser";
		const WEBVIEW_PROP_CANDIDATES = ["webview", "webviewEl", "frame", "browser"];
		const webviewLog = logger("ext:webview");
		const leafCache = plugin.getWebviewLeafCache();

		function findWebviewEl(leaf: any): any {
			const view = leaf.view;
			for (const prop of WEBVIEW_PROP_CANDIDATES) {
				if (view?.[prop] && typeof view[prop].executeJavaScript === "function") {
					return view[prop];
				}
			}
			const el = leaf.containerEl?.querySelector?.("webview");
			if (el && typeof el.executeJavaScript === "function") return el;
			return null;
		}

		utils.webview = {
			getConversationId: () => conversationId ?? null,

			getActiveWebview: () => {
				const leaves = plugin.app.workspace.getLeavesOfType(WEB_VIEWER_VIEW_TYPE);
				const activeLeaf = plugin.app.workspace.activeLeaf;
				const targetLeaf = leaves.find((l: any) => l === activeLeaf) ?? null;
				if (!targetLeaf) return null;
				const webviewEl = findWebviewEl(targetLeaf);
				if (!webviewEl) return null;
				return { leaf: targetLeaf, webviewEl };
			},

			getConversationWebview: async () => {
				const convId = conversationId;
				if (!convId) return null;

				let leaf = leafCache.get(convId);
				const allLeaves = plugin.app.workspace.getLeavesOfType(WEB_VIEWER_VIEW_TYPE);

				if (leaf && !allLeaves.includes(leaf)) {
					leafCache.delete(convId);
					leaf = undefined;
				}

				if (!leaf) {
					const persistedUrl = await utils.webview!.readPersistedUrl(convId);

					leaf = plugin.app.workspace.getLeaf("split");
					await leaf.setViewState({
						type: WEB_VIEWER_VIEW_TYPE,
						active: false,
						state: persistedUrl ? { url: persistedUrl } : {},
					});
					leafCache.set(convId, leaf);

					await new Promise(r => setTimeout(r, 200));
				}

				const webviewEl = findWebviewEl(leaf);
				if (!webviewEl) {
					webviewLog.warn("Could not find webview element on leaf");
					return null;
				}
				return { leaf, webviewEl };
			},

			waitForReady: async (webviewEl: any, revealLeaf = false, leaf?: any) => {
				if (revealLeaf && leaf) {
					plugin.app.workspace.revealLeaf(leaf);
				}

				if (typeof webviewEl.isLoading === "function" && webviewEl.isLoading()) {
					await Promise.race([
						new Promise<void>(resolve => {
							webviewEl.addEventListener("did-finish-load", () => resolve(), { once: true });
						}),
						new Promise<void>(resolve => setTimeout(resolve, 10000)),
					]);
				}

				for (let i = 0; i < 3; i++) {
					try {
						const state = await webviewEl.executeJavaScript("document.readyState");
						if (state === "complete") break;
					} catch { /* ignore */ }
					await new Promise(r => setTimeout(r, 500));
				}

				await new Promise(r => setTimeout(r, 300));
			},

			persistUrl: async (cId: string, url: string) => {
				const sidecarPath = normalizePath(
					`${plugin.settings.history_path}${cId}.webview.json`,
				);
				const data = JSON.stringify({ url, timestamp: new Date().toISOString() });
				await plugin.app.vault.adapter.write(sidecarPath, data);
			},

			readPersistedUrl: async (cId: string) => {
				const sidecarPath = normalizePath(
					`${plugin.settings.history_path}${cId}.webview.json`,
				);
				try {
					const raw = await plugin.app.vault.adapter.read(sidecarPath);
					const parsed = JSON.parse(raw);
					return typeof parsed.url === "string" ? parsed.url : null;
				} catch {
					return null;
				}
			},
		};
	}

	// Wire memory facade after the main object is constructed so that
	// resolveConcept can reference utils.runSubAgent without recursion.
	if (plugin.settings.memory_enabled) {
		const memoryFolder = plugin.settings.memory_folder ?? "memory";
		const memoryDir = normalizePath(`${plugin.settings.notor_dir}/${memoryFolder}`);
		const pendingMemoryDir = normalizePath(`${plugin.settings.notor_dir}/pending-memories`);
		const dedupCachePath = `${memoryDir}/.dedup-cache.json`;
		const dreamCursorPath = `${memoryDir}/.dream-cursor.json`;

		const pendingManager = new PendingMemoryManager(
			plugin.app,
			plugin.app.vault,
			pendingMemoryDir,
			memoryDir,
		);

		utils.memoryApprovalMode = plugin.settings.memory_approval_mode ?? "auto";

		utils.memory = {
			resolveConcept: (args: {
				insight: string;
				memoryDir: string;
				resolverProfile: string;
				silent?: boolean;
				pendingMode?: boolean;
				pendingMemoryDir?: string;
			}) => resolveConcept({
				insight: args.insight,
				memoryDir: args.memoryDir,
				resolverProfile: args.resolverProfile,
				app: plugin.app,
				runSubAgent: utils.runSubAgent,
				vault: plugin.app.vault,
				silent: args.silent,
				pendingMode: args.pendingMode,
				pendingMemoryDir: args.pendingMemoryDir,
			}),

			fingerprintAndDedup: async (content: string, windowHours: number) => {
				const fingerprint = computeFingerprint(content);
				const cache = await readDedupCache(plugin.app, dedupCachePath, windowHours);
				const isDuplicate = fingerprint in cache;
				if (!isDuplicate) {
					await writeDedupEntry(plugin.app, dedupCachePath, fingerprint, new Date().toISOString());
				}
				return { fingerprint, isDuplicate };
			},

			serializeNote,
			parseNote,
			slugifyTitle,
			assertMemoryPath,

			readDedupCache: (windowHours: number) =>
				readDedupCache(plugin.app, dedupCachePath, windowHours),
			writeDedupEntry: (fingerprint: string, timestamp: string) =>
				writeDedupEntry(plugin.app, dedupCachePath, fingerprint, timestamp),
			readDreamCursor: () =>
				readDreamCursor(plugin.app, dreamCursorPath),
			advanceDreamCursor: (timestamp: string) =>
				advanceDreamCursor(plugin.app, dreamCursorPath, timestamp),

			hasMemoryNotes: async () => {
				const folder = plugin.app.vault.getAbstractFileByPath(memoryDir);
				if (!folder || !(folder instanceof TFolder)) return false;
				return folder.children.some(
					(f) => f instanceof TFileClass && f.extension === "md" && !f.name.startsWith("."),
				);
			},

			extractJSON,
			patchFrontmatterField,
			extractMemoryWikilinks,

			pendingMemoryManager: pendingManager,
		};
	}

	return utils;
}

// ---------------------------------------------------------------------------
// Libs builder
// ---------------------------------------------------------------------------

/** Shape of the `libs` object injected into extension functions. */
export interface ExtensionLibs {
	mammoth: typeof mammoth;
	Turndown: typeof TurndownService;
	turndownGfm: { gfm: typeof gfm };
	unpdf: () => Promise<typeof import("unpdf")>;
	docx: typeof docx;
	PizZip: typeof PizZip;
	marked: typeof marked;
	xmldom: typeof xmldom;
	croner: { Cron: typeof Cron };
	fs: typeof import("fs");
	crypto: typeof import("crypto");
	path: typeof import("path");
}

/**
 * Build the `libs` object exposing bundled libraries to extensions.
 *
 * `unpdf` is a lazy wrapper preserving the deferred loading pattern
 * from `src/media/pdf-processor.ts` to avoid regressing startup time.
 */
export function buildLibs(): ExtensionLibs {
	return {
		mammoth,
		Turndown: TurndownService,
		turndownGfm: { gfm },
		unpdf: () => import("unpdf"),
		docx,
		PizZip,
		marked,
		xmldom,
		croner: { Cron },
		fs: require("fs") as typeof import("fs"),
		crypto: require("crypto") as typeof import("crypto"),
		path: require("path") as typeof import("path"),
	};
}

// ---------------------------------------------------------------------------
// Obsidian exports builder
// ---------------------------------------------------------------------------

/** Shape of the `obsidian` object injected into extension functions. */
export interface ExtensionObsidianExports {
	requestUrl: typeof requestUrl;
	Notice: typeof Notice;
	TFile: typeof TFileClass;
	TFolder: typeof TFolder;
	getFrontMatterInfo: typeof getFrontMatterInfo;
	normalizePath: typeof normalizePath;
	MarkdownView: typeof MarkdownView;
	Platform: typeof Platform;
}

/**
 * Build the `obsidian` object exposing commonly needed Obsidian module exports.
 */
export function buildObsidianExports(): ExtensionObsidianExports {
	return {
		requestUrl,
		Notice,
		TFile: TFileClass,
		TFolder,
		getFrontMatterInfo,
		normalizePath,
		MarkdownView,
		Platform,
	};
}
