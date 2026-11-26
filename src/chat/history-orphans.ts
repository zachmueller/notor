/**
 * Daily sweep for history data whose conversation no longer exists.
 *
 * Deleting a conversation removes its leftovers immediately (see
 * `HistoryManager.deleteConversationFile`), but data orphaned before that
 * existed — or by a crash mid-delete, or a delete synced from another device —
 * stays forever. This pass removes, from the history folder and the checkpoint
 * folder:
 *  - sub-agent conversation files (`{ts}_{parentId}_subagent_{inv}.jsonl`) whose
 *    parent conversation is gone;
 *  - `{id}.plan.json` / `{id}.webview.json` sidecars whose conversation is gone;
 *  - checkpoint folders (`{checkpointPath}/{id}/`) whose conversation is gone.
 *
 * A conversation "exists" when a regular conversation file
 * (`{ts}_{id}.jsonl`) or a circuit step conversation
 * (`orchestration_step_{id}.jsonl`) carries its ID. As a safety margin an orphan
 * is only removed once it has not been modified for `minAgeMs` (default one
 * day), so nothing written moments ago (e.g. by another device mid-sync) is
 * touched.
 */

import { normalizePath, type DataAdapter } from "obsidian";
import { SUB_AGENT_FILENAME_MARKER } from "./history";
import { STEP_CONVERSATION_FILE_PREFIX } from "./sub-agent-history";

export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface OrphanSweepOptions {
	adapter: DataAdapter;
	historyPath: string;
	checkpointPath: string;
	now?: number;
	minAgeMs?: number;
}

export interface OrphanSweepResult {
	subAgentFiles: number;
	sidecars: number;
	checkpointFolders: number;
}

/** Compact `created_at` prefix of conversation file names (see conversationFilename). */
const TIMESTAMP_PREFIX_RE = /^\d{8}_\d{6}_/;
const CONVERSATION_FILE_RE = /^(?:\d{8}_\d{6}_)?(.+)\.jsonl$/;
const SIDECAR_RE = /^(.+)\.(plan|webview)\.json$/;

const baseName = (path: string) => path.split("/").pop() ?? path;

/** IDs of every conversation (regular or circuit step) present in the listing. */
export function liveConversationIds(fileNames: readonly string[]): Set<string> {
	const ids = new Set<string>();
	for (const name of fileNames) {
		if (!name.endsWith(".jsonl") || name.includes(SUB_AGENT_FILENAME_MARKER)) continue;
		if (name.startsWith(STEP_CONVERSATION_FILE_PREFIX)) {
			ids.add(name.slice(STEP_CONVERSATION_FILE_PREFIX.length, -".jsonl".length));
			continue;
		}
		const m = CONVERSATION_FILE_RE.exec(name);
		if (m) ids.add(m[1]!);
	}
	return ids;
}

/** Parent conversation ID of a sub-agent file name, or null. */
export function subAgentParentId(name: string): string | null {
	const at = name.indexOf(SUB_AGENT_FILENAME_MARKER);
	if (at <= 0) return null;
	const parent = name.slice(0, at).replace(TIMESTAMP_PREFIX_RE, "");
	return parent || null;
}

export async function sweepHistoryOrphans(opts: OrphanSweepOptions): Promise<OrphanSweepResult> {
	const { adapter } = opts;
	const now = opts.now ?? Date.now();
	const minAgeMs = opts.minAgeMs ?? ORPHAN_MIN_AGE_MS;
	const result: OrphanSweepResult = { subAgentFiles: 0, sidecars: 0, checkpointFolders: 0 };

	const historyDir = normalizePath(opts.historyPath).replace(/\/+$/, "");
	if (!(await adapter.exists(historyDir))) return result;
	const files = (await adapter.list(historyDir)).files;
	const names = files.map(baseName);
	const live = liveConversationIds(names);

	const oldEnough = async (path: string): Promise<boolean> => {
		const stat = await adapter.stat(path);
		return !!stat && now - stat.mtime >= minAgeMs;
	};

	for (const [i, file] of files.entries()) {
		const name = names[i]!;
		let orphan: "subAgentFiles" | "sidecars" | null = null;
		if (name.includes(SUB_AGENT_FILENAME_MARKER)) {
			const parent = subAgentParentId(name);
			if (parent && !live.has(parent)) orphan = "subAgentFiles";
		} else {
			const m = SIDECAR_RE.exec(name);
			if (m && !live.has(m[1]!)) orphan = "sidecars";
		}
		if (orphan && (await oldEnough(file))) {
			await adapter.remove(file);
			result[orphan]++;
		}
	}

	const checkpointDir = normalizePath(opts.checkpointPath).replace(/\/+$/, "");
	if (await adapter.exists(checkpointDir)) {
		for (const folder of (await adapter.list(checkpointDir)).folders) {
			if (live.has(baseName(folder))) continue;
			if (await oldEnough(folder)) {
				await adapter.rmdir(folder, true);
				result.checkpointFolders++;
			}
		}
	}
	return result;
}
