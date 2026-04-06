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
import type { ContentBlock, ImageMediaType } from "../media/types";
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
	/** AbortSignal for the current tool call — only set per-invocation by UserToolAdapter. */
	abortSignal?: AbortSignal;
}

/**
 * Build the `utils` object for extensions.
 *
 * Note: `abortSignal` is NOT included — it's per-call only.
 * `UserToolAdapter.execute()` merges it into the returned object per-invocation.
 */
export function buildUtils(plugin: NotorPlugin): ExtensionUtils {
	const vaultRootPath = (plugin.app.vault.adapter as { basePath?: string }).basePath ?? "";

	return {
		resolveNote: (path: string) =>
			resolveNote(path, plugin.app.vault, plugin.app.metadataCache),

		staleTracker: plugin.getStaleTracker(),

		checkpointManager: plugin.getCheckpointManager(),

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
