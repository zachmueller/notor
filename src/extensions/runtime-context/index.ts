/**
 * Runtime context builder for user-defined extensions.
 *
 * Assembles the `utils`, `libs`, and `obsidian` objects injected into
 * extension functions at execution time.
 */

export type {
	BuilderContext,
	ChatHistorySummary,
	ChatHistoryConversation,
	ExtensionUtils,
	ExtensionLibs,
	ExtensionObsidianExports,
} from "./types";

import type NotorPlugin from "../../main";
import type { ExtensionUtils, ExtensionLibs, ExtensionObsidianExports } from "./types";

import { buildFileUtils } from "./file-utils";
import { buildMediaUtils } from "./media-utils";
import { buildWebUtils } from "./web-utils";
import { buildChatUtils, buildAsk } from "./chat-utils";
import { buildSubAgentUtils } from "./sub-agent-utils";
import { buildMemoryUtils } from "./memory-utils";
import { buildPluginUtils } from "./plugin-utils";

// Bundled libraries (for buildLibs)
import mammoth from "mammoth";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import * as docx from "docx";
import PizZip from "pizzip";
import { marked } from "marked";
import * as xmldom from "@xmldom/xmldom";
import { Cron } from "croner";

// Node built-ins exposed to extensions (externalized by esbuild's node target)
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";

// Obsidian exports (for buildObsidianExports)
import { requestUrl, Notice, TFile as TFileClass, TFolder, getFrontMatterInfo, normalizePath, MarkdownView, Platform } from "obsidian";

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
	const ctx = { plugin, vaultRootPath, conversationId, sourceExtensionName };

	const subAgentResult = buildSubAgentUtils(ctx);

	const utils: ExtensionUtils = {
		...buildFileUtils(ctx),
		...buildMediaUtils(ctx),
		...buildWebUtils(ctx),
		...buildChatUtils(ctx),
		...subAgentResult,
		...buildPluginUtils(ctx),
		memory: null,
		memoryApprovalMode: null,
		// Placeholder — wired below once `utils` exists so `ask` can read the
		// per-call `interactionCallback`.
		ask: async () => null,
	};

	// Wire memory last — resolveConcept needs runSubAgent
	const mem = buildMemoryUtils(ctx, utils.runSubAgent);
	utils.memory = mem.memory;
	utils.memoryApprovalMode = mem.memoryApprovalMode;

	// Wire ask — reads the per-call interactionCallback attached by UserToolAdapter.
	utils.ask = buildAsk(utils);

	return utils;
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
		fs,
		crypto,
		path,
	};
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
