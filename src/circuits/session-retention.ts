/**
 * Retention for finished circuit runs (`circuits_session_retention_days`).
 *
 * Every circuit run leaves a session folder in the vault
 * (`{notor_dir}/{circuits|orchestrations}/sessions/{id}/`) plus one step
 * conversation per LLM turn in the history folder
 * (`orchestration_step_{conversationId}.jsonl`, header
 * `orchestration_session_id`). Nothing removed them, so a long-lived install
 * accumulates thousands — each read by the startup recovery scan and indexed by
 * Obsidian.
 *
 * Deletion is per run *tree* (a root session plus its composition children and
 * chained successors, linked by `parent_session_id`), and only when every
 * session in the tree has finished (completed / cancelled / error) and the
 * tree's newest activity is older than the retention window. Sessions whose
 * `session.json` is missing or unreadable are never deleted, nor is anything in
 * their tree. Deleting a tree removes its session folders, their step
 * conversations, and sub-agent runs spawned from those steps.
 */

import { normalizePath, type DataAdapter } from "obsidian";
import type { CircuitSessionMeta } from "./types";
import { mapWithConcurrency } from "../utils/concurrency";
import { readFirstLine } from "../utils/file-head";
import { STEP_CONVERSATION_FILE_PREFIX } from "../chat/sub-agent-history";
import { SUB_AGENT_FILENAME_MARKER } from "../chat/history";
import { logger } from "../utils/logger";

const log = logger("CircuitSessionRetention");

const FINISHED: ReadonlySet<CircuitSessionMeta["status"]> = new Set(["completed", "cancelled", "error"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const READ_CONCURRENCY = 4;

/** What the selector needs to know about one session. */
export interface SessionInfo {
	id: string;
	/** Null when `session.json` is missing or unreadable (never deleted). */
	meta: Pick<CircuitSessionMeta, "status" | "parent_session_id" | "started_at"> | null;
	/** Last write to the session log (ms), if known. */
	logMtime: number | null;
}

/** A deletable run tree and its newest activity (ms). */
export interface PrunableTree {
	ids: string[];
	lastActivity: number;
}

/**
 * IDs of sessions to delete: whole trees in which every session is finished and
 * the newest activity (max of `started_at` and the log's mtime) is older than
 * `retentionDays`. `retentionDays <= 0` keeps everything.
 */
export function selectSessionsToPrune(sessions: readonly SessionInfo[], retentionDays: number, now: number): Set<string> {
	return new Set(selectTreesToPrune(sessions, retentionDays, now).flatMap((t) => t.ids));
}

/** Deletable run trees, oldest first (see {@link selectSessionsToPrune}). */
export function selectTreesToPrune(sessions: readonly SessionInfo[], retentionDays: number, now: number): PrunableTree[] {
	const prune: PrunableTree[] = [];
	if (!(retentionDays > 0)) return prune;
	const cutoff = now - retentionDays * DAY_MS;
	const byId = new Map(sessions.map((s) => [s.id, s]));

	// Topmost existing ancestor of each session (a missing parent ends the chain).
	const rootOf = (id: string): string => {
		const seen = new Set<string>();
		let cur = id;
		for (;;) {
			seen.add(cur);
			const parent = byId.get(cur)?.meta?.parent_session_id;
			if (!parent || !byId.has(parent) || seen.has(parent)) return cur;
			cur = parent;
		}
	};
	const trees = new Map<string, SessionInfo[]>();
	for (const s of sessions) {
		const root = rootOf(s.id);
		const list = trees.get(root) ?? [];
		list.push(s);
		trees.set(root, list);
	}

	for (const members of trees.values()) {
		let deletable = true;
		let newest = 0;
		for (const s of members) {
			if (!s.meta || !FINISHED.has(s.meta.status)) {
				deletable = false;
				break;
			}
			const started = Date.parse(s.meta.started_at);
			const lastActivity = Math.max(Number.isNaN(started) ? 0 : started, s.logMtime ?? 0);
			if (lastActivity === 0 || lastActivity > cutoff) {
				deletable = false;
				break;
			}
			newest = Math.max(newest, lastActivity);
		}
		if (deletable) prune.push({ ids: members.map((s) => s.id), lastActivity: newest });
	}
	return prune.sort((a, b) => a.lastActivity - b.lastActivity);
}

/**
 * Take whole trees, oldest first, until `maxSessions` sessions are selected. A
 * single tree larger than the cap is still taken on its own, so the oldest run
 * can never block the queue.
 */
export function capTrees(trees: readonly PrunableTree[], maxSessions: number): PrunableTree[] {
	const out: PrunableTree[] = [];
	let total = 0;
	for (const tree of trees) {
		if (out.length > 0 && total + tree.ids.length > maxSessions) break;
		out.push(tree);
		total += tree.ids.length;
	}
	return out;
}

export interface CircuitRetentionOptions {
	adapter: DataAdapter;
	/** `{notor_dir}/{circuits|orchestrations}` — the circuit data root. */
	circuitRootPath: string;
	historyPath: string;
	retentionDays: number;
	now?: number;
	/** At most this many sessions are deleted per pass; the rest wait for the next day. */
	maxSessionsPerPass?: number;
	/** Sessions deleted between pauses. */
	batchSize?: number;
	/** Awaited between batches (the plugin waits for an idle period). */
	pause?: () => Promise<void>;
}

export const DEFAULT_MAX_SESSIONS_PER_PASS = 250;
export const DEFAULT_BATCH_SIZE = 25;

export interface CircuitRetentionResult {
	sessions: number;
	stepConversations: number;
	subAgentConversations: number;
	/** Finished sessions past the window left for a later pass by the cap. */
	deferred: number;
}

/** Apply circuit run retention (the daily housekeeping pass). */
export async function pruneFinishedCircuitSessions(opts: CircuitRetentionOptions): Promise<CircuitRetentionResult> {
	const { adapter } = opts;
	const now = opts.now ?? Date.now();
	const result: CircuitRetentionResult = { sessions: 0, stepConversations: 0, subAgentConversations: 0, deferred: 0 };
	if (!(opts.retentionDays > 0)) return result;

	const sessionsRoot = normalizePath(`${opts.circuitRootPath}/sessions`).replace(/\/+$/, "");
	if (!(await adapter.exists(sessionsRoot))) return result;
	const ids = (await adapter.list(sessionsRoot)).folders.map((f) => f.split("/").pop() ?? f);

	const sessions = await mapWithConcurrency(ids, READ_CONCURRENCY, async (id): Promise<SessionInfo> => {
		const dir = `${sessionsRoot}/${id}`;
		let meta: SessionInfo["meta"] = null;
		try {
			meta = JSON.parse(await adapter.read(`${dir}/session.json`)) as CircuitSessionMeta;
		} catch {
			meta = null;
		}
		const stat = await adapter.stat(`${dir}/session-log.jsonl`).catch(() => null);
		return { id, meta, logMtime: stat?.mtime ?? null };
	});

	const allTrees = selectTreesToPrune(sessions, opts.retentionDays, now);
	const trees = capTrees(allTrees, opts.maxSessionsPerPass ?? DEFAULT_MAX_SESSIONS_PER_PASS);
	const prune = new Set(trees.flatMap((t) => t.ids));
	result.deferred = allTrees.reduce((n, t) => n + t.ids.length, 0) - prune.size;
	if (prune.size === 0) return result;

	// Step conversations of the pruned sessions (by header) and their sub-agent runs.
	const historyDir = normalizePath(opts.historyPath).replace(/\/+$/, "");
	const stepFilesBySession = new Map<string, Array<{ file: string; conversationId: string }>>();
	const subAgentFilesByParent = new Map<string, string[]>();
	if (await adapter.exists(historyDir)) {
		const files = (await adapter.list(historyDir)).files;
		const stepFiles = files.filter((f) => (f.split("/").pop() ?? f).startsWith(STEP_CONVERSATION_FILE_PREFIX));
		const headers = await mapWithConcurrency(stepFiles, READ_CONCURRENCY, async (file) => {
			try {
				return JSON.parse(await readFirstLine(adapter, file)) as { id?: string; orchestration_session_id?: string };
			} catch {
				return null;
			}
		});
		for (const [i, file] of stepFiles.entries()) {
			const h = headers[i];
			if (!h?.id || !h.orchestration_session_id || !prune.has(h.orchestration_session_id)) continue;
			const list = stepFilesBySession.get(h.orchestration_session_id) ?? [];
			list.push({ file, conversationId: h.id });
			stepFilesBySession.set(h.orchestration_session_id, list);
		}
		for (const file of files) {
			const name = file.split("/").pop() ?? file;
			const at = name.indexOf(SUB_AGENT_FILENAME_MARKER);
			if (at <= 0) continue;
			const parentId = name.slice(0, at).replace(/^\d{8}_\d{6}_/, "");
			const list = subAgentFilesByParent.get(parentId) ?? [];
			list.push(file);
			subAgentFilesByParent.set(parentId, list);
		}
	}

	// Delete in small batches, pausing between them so the vault's delete events
	// (index, file explorer, other plugins' listeners) don't pile up at once.
	const ordered = trees.flatMap((t) => t.ids);
	const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
	for (let start = 0; start < ordered.length; start += batchSize) {
		if (start > 0) await opts.pause?.();
		for (const id of ordered.slice(start, start + batchSize)) {
			try {
				for (const step of stepFilesBySession.get(id) ?? []) {
					for (const sub of subAgentFilesByParent.get(step.conversationId) ?? []) {
						await adapter.remove(sub);
						result.subAgentConversations++;
					}
					await adapter.remove(step.file);
					result.stepConversations++;
				}
				await adapter.rmdir(`${sessionsRoot}/${id}`, true);
				result.sessions++;
			} catch (e) {
				log.warn("Failed to delete circuit session", { sessionId: id, error: String(e) });
			}
		}
	}
	log.info("Pruned finished circuit runs", { ...result, retentionDays: opts.retentionDays });
	return result;
}
