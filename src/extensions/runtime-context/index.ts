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
import { buildChatUtils, buildAsk, buildAskMany } from "./chat-utils";
import { buildSubAgentUtils } from "./sub-agent-utils";
import { buildMemoryUtils } from "./memory-utils";
import { buildPluginUtils } from "./plugin-utils";
import { buildCircuitUtils } from "./circuit-utils";
import { buildVoiceUtils } from "./voice-utils";
import { RUNTIME_API_VERSION } from "./version";

// Bundled libraries (for buildLibs). The heavy document libraries load on first
// access through lazy-modules.ts so they don't evaluate during plugin load.
import { gfm } from "turndown-plugin-gfm";
import { marked } from "marked";
import { Cron } from "croner";
import { loadDocx, loadMammoth, loadPizZip, loadTurndown, loadXmldom } from "../../utils/lazy-modules";

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
		api: { version: RUNTIME_API_VERSION },
		...buildFileUtils(ctx),
		...buildMediaUtils(ctx),
		...buildWebUtils(ctx),
		...buildChatUtils(ctx),
		...subAgentResult,
		...buildPluginUtils(ctx),
		...buildCircuitUtils(ctx),
		...buildVoiceUtils(ctx),
		memory: null,
		memoryApprovalMode: null,
		// Placeholders — wired below once `utils` exists so `ask`/`askMany` can
		// read the per-call `interactionCallback`.
		ask: async () => null,
		askMany: async (qs) => (Array.isArray(qs) ? qs : []).map(() => null),
	};

	// Circuit-vocabulary alias of the per-call `orchestrationContext` (attached
	// after construction by UserToolAdapter), so it must be a live getter.
	Object.defineProperty(utils, "circuitContext", {
		get: () => utils.orchestrationContext,
		enumerable: true,
		configurable: true,
	});

	// Wire memory last — resolveConcept needs runSubAgent
	const mem = buildMemoryUtils(ctx, utils.runSubAgent);
	utils.memory = mem.memory;
	utils.memoryApprovalMode = mem.memoryApprovalMode;

	// Wire ask/askMany — read the per-call interactionCallback attached by
	// UserToolAdapter. `ask` is a thin wrapper over `askMany`.
	utils.askMany = buildAskMany(utils);
	utils.ask = buildAsk(utils.askMany);

	return utils;
}

/**
 * Build the `libs` object exposing bundled libraries to extensions.
 *
 * `unpdf` / `exceljs` are async thunks preserving the deferred loading pattern
 * from `src/media/pdf-processor.ts`. `mammoth`, `Turndown`, `docx`, `PizZip` and
 * `xmldom` are lazy getters: same synchronous API for extensions, but each
 * library evaluates on first access instead of at plugin load.
 */
export function buildLibs(): ExtensionLibs {
	return {
		get mammoth() { return loadMammoth(); },
		get Turndown() { return loadTurndown(); },
		turndownGfm: { gfm },
		unpdf: () => import("unpdf"),
		exceljs: () => import("exceljs"),
		get docx() { return loadDocx(); },
		get PizZip() { return loadPizZip(); },
		marked,
		get xmldom() { return loadXmldom(); },
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
