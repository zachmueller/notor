import type { BuilderContext, ExtensionUtils } from "./types";
import {
	serializeNote,
	parseNote,
	slugifyTitle,
	computeFingerprint,
	assertMemoryPath,
	extractJSON,
	patchFrontmatterField,
	extractMemoryWikilinks,
} from "../../memory/note-format";
import {
	readDedupCache,
	writeDedupEntry,
	readDreamCursor,
	advanceDreamCursor,
} from "../../memory/dedup-cache";
import { resolveConcept } from "../../memory/concept-resolver";
import { PendingMemoryManager } from "../../memory/pending-memory-manager";
import { TFile as TFileClass, TFolder, normalizePath } from "obsidian";

export function buildMemoryUtils(
	ctx: BuilderContext,
	runSubAgent: ExtensionUtils["runSubAgent"],
): Pick<ExtensionUtils, "memory" | "memoryApprovalMode"> {
	const { plugin } = ctx;

	if (!plugin.settings.memory_enabled) {
		return { memory: null, memoryApprovalMode: null };
	}

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

	return {
		memoryApprovalMode: plugin.settings.memory_approval_mode ?? "auto",

		memory: {
			resolveConcept: (args) => resolveConcept({
				insight: args.insight,
				memoryDir: args.memoryDir,
				resolverProfile: args.resolverProfile,
				app: plugin.app,
				runSubAgent,
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
		},
	};
}
