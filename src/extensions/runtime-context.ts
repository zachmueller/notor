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

// Obsidian exports
import { requestUrl, Notice, TFile as TFileClass, TFolder, getFrontMatterInfo, normalizePath, MarkdownView } from "obsidian";

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
	};
}
