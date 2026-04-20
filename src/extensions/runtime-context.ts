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
import type { WebSearchApiResult } from "../web-search/queue";

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
	} | null;
	/** AbortSignal for the current tool call — only set per-invocation by UserToolAdapter. */
	abortSignal?: AbortSignal;
	/** Progress callback for long-running tools — only set per-invocation by UserToolAdapter. */
	onProgress?: (status: string) => void;
}

/**
 * Build the `utils` object for extensions.
 *
 * @param plugin - The plugin instance.
 * @param conversationId - Optional conversation ID. When provided, `conversationApi`
 *   is bound to the correct conversation via ID lookup. When omitted, `conversationApi`
 *   is null.
 *
 * Note: `abortSignal` and `onProgress` are NOT included — they're per-call only.
 * `UserToolAdapter.execute()` merges them into the returned object per-invocation.
 */
export function buildUtils(plugin: NotorPlugin, conversationId?: string): ExtensionUtils {
	const vaultRootPath = (plugin.app.vault.adapter as { basePath?: string }).basePath ?? "";

	return {
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
				allowedPaths ?? plugin.settings.read_file_allowed_paths,
			),

		executeShellCommand: (cmd: string, opts?: ShellExecuteOptions) =>
			executeShellCommand(cmd, plugin.settings, opts),

		pathEnforcer: {
			enforcePathConstraints: (
				toolName: string,
				params: Record<string, unknown>,
				entry: ResolvedToolConfigEntry,
			) => enforcePathConstraints(toolName, params, entry, vaultRootPath),

			isPathWithin: (target: string, base: string) =>
				isPathWithin(target, base),
		},

		isDomainBlocked,

		detectMediaFormat,

		processImage,

		processPdf: (buffer: Buffer, options: { pages?: string; maxTextChars?: number; preferNative?: boolean }) =>
			processPdf(buffer, {
				...options,
				providerType: plugin.settings.active_provider,
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
			resolveImageForDocx(href, vaultRootPath, allowedPaths ?? plugin.settings.read_file_allowed_paths),

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
					const provider = plugin.getProviderRegistry().getProvider(resolved.providerType);
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
	};
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
