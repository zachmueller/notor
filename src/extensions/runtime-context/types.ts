import type NotorPlugin from "../../main";
import type { Logger } from "../../utils/logger";
import type { StaleContentTracker } from "../../chat/stale-tracker";
import type { CheckpointManager } from "../../checkpoints/checkpoint";
import type { NoteOpener } from "../../tools/note-opener";
import type { ShellExecuteOptions, ShellExecuteResult } from "../../shell/shell-executor";
import type { TempOutputSpiller } from "../../shell/temp-output-spiller";
import type { ResolvedToolConfigEntry } from "../../tool-config/types";
import type { TFile } from "obsidian";
import type { ContentBlock, ImageMediaType } from "../../media/types";
import type { DocxImageData } from "../../tools/docx-image-utils";
import type { RawComment, Comment } from "../../tools/docx-comment-parser";
import type { WebSearchApiResult, WebSearchResolvedConfig } from "../../web-search/queue";
import type { SubAgentResult } from "../../chat/sub-agent-runner";
import type { Message } from "../../types";
import type { MemoryNote } from "../../memory/note-format";
import type { ResolveConceptResult } from "../../memory/concept-resolver";
import type { PendingMemoryManager } from "../../memory/pending-memory-manager";

export interface BuilderContext {
	plugin: NotorPlugin;
	vaultRootPath: string;
	conversationId?: string;
	sourceExtensionName?: string;
}

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
	/** Temp output spiller for writing truncated output to disk. Undefined when disabled or on mobile. */
	tempOutputSpiller?: TempOutputSpiller;
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
		extractJSON: (text: string) => unknown;
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

import type mammoth from "mammoth";
import type TurndownService from "turndown";
import type { gfm } from "turndown-plugin-gfm";
import type * as docx from "docx";
import type PizZip from "pizzip";
import type { marked } from "marked";
import type * as xmldom from "@xmldom/xmldom";
import type { Cron } from "croner";
import type { requestUrl, Notice, TFile as TFileClass, TFolder, getFrontMatterInfo, normalizePath, MarkdownView, Platform } from "obsidian";

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
