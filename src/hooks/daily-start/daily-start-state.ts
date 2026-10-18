/**
 * Per-device persistence for the `on_daily_start` trigger.
 *
 * Stored with `App.saveLocalStorage()` (vault-scoped, not synced) rather than
 * in `data.json`, so each device gets its own morning run and a synced
 * `last fired` day from another machine never suppresses this one.
 */

import type { App } from "obsidian";
import type { TriggerTarget } from "../trigger-sources";

/** Status of one daily-start target run. */
export type DailyRunStatus =
	| "pending_retry" // pre-flight failed; waiting for a retry
	| "gave_up" // pre-flight retries exhausted
	| "running"
	| "waiting_approval"
	| "completed"
	| "failed";

/** One target fired (or attempted) for a logical day. */
export interface DailyRunRecord {
	/** Target key (`hook id`, `workflow:{path}`, `orch:{flowDir}`, …). */
	key: string;
	label: string;
	kind: TriggerTarget["kind"];
	status: DailyRunStatus;
	/** Conversation to open (workflow conversation / circuit entry step). */
	conversationId: string | null;
	/** Circuit session id (opens the run tree when no conversation is known). */
	sessionId: string | null;
	error: string | null;
	/** ISO timestamp of the most recent attempt. */
	startedAt: string;
}

/** Pre-flight retry in progress (survives a plugin reload). */
export interface PendingRetry {
	/** Number of retries already scheduled (1-based once the first fails). */
	attempt: number;
	/** Epoch ms of the next attempt. */
	nextAt: number;
	/** Keys of targets still waiting for a passing pre-flight. */
	targetKeys: string[];
	/** Human-readable reason for the last failure. */
	reason: string;
}

export interface DailyStartStateData {
	/** Logical day (`YYYY-MM-DD`) the trigger last fired on this device. */
	lastFiredDay: string | null;
	/** Records for `lastFiredDay` only. */
	runs: DailyRunRecord[];
	pendingRetry: PendingRetry | null;
}

/** Storage seam (localStorage in the plugin, in-memory in tests). */
export interface DailyStartStateStore {
	load(): DailyStartStateData;
	save(data: DailyStartStateData): void;
}

export const DAILY_START_STORAGE_KEY = "notor:daily-start";

export function emptyDailyStartState(): DailyStartStateData {
	return { lastFiredDay: null, runs: [], pendingRetry: null };
}

/** `App.loadLocalStorage` / `saveLocalStorage` backed store. */
export class LocalStorageDailyStartState implements DailyStartStateStore {
	constructor(private readonly app: App) {}

	load(): DailyStartStateData {
		const raw: unknown = this.app.loadLocalStorage(DAILY_START_STORAGE_KEY);
		return normalize(raw);
	}

	save(data: DailyStartStateData): void {
		this.app.saveLocalStorage(DAILY_START_STORAGE_KEY, data);
	}
}

/** In-memory store for tests. */
export class MemoryDailyStartState implements DailyStartStateStore {
	data: DailyStartStateData = emptyDailyStartState();

	load(): DailyStartStateData {
		return structuredClone(this.data);
	}

	save(data: DailyStartStateData): void {
		this.data = structuredClone(data);
	}
}

/** Coerce whatever was stored (possibly from an older build) into valid state. */
function normalize(raw: unknown): DailyStartStateData {
	if (!raw || typeof raw !== "object") return emptyDailyStartState();
	const r = raw as Partial<DailyStartStateData>;
	return {
		lastFiredDay: typeof r.lastFiredDay === "string" ? r.lastFiredDay : null,
		runs: Array.isArray(r.runs) ? r.runs : [],
		pendingRetry: r.pendingRetry && typeof r.pendingRetry === "object" ? r.pendingRetry : null,
	};
}
