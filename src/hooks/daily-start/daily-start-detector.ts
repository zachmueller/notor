/**
 * DailyStartDetector — fires `on_daily_start` targets once per logical day.
 *
 * Detection is activity-gated, not timer-driven: the plugin reports activity
 * (plugin load, wake from sleep, window focus, editing, …) via
 * `noteActivity()`, and the first report on a new logical day fires every
 * target. `lastFiredDay` is persisted per device *before* dispatching so
 * reloads or bursts of activity can't double-fire.
 *
 * AI-backed targets first pass a provider pre-flight. Failures (expired
 * credentials, offline, …) are reported and retried with long exponential
 * backoff; the retry state is persisted so a reload resumes it.
 */

import type { NotorSettings } from "../../settings/types";
import { backoffDelay, type RetryPolicy } from "../../providers/stream-retry";
import { logger } from "../../utils/logger";
import {
	collectTriggerTargets,
	fireTriggerTarget,
	type TriggerExecutors,
	type TriggerSourceAccessors,
	type TriggerSourceSpec,
	type TriggerTarget,
} from "../trigger-sources";
import { logicalDay, parseResetTime } from "./logical-day";
import type { DailyRunRecord, DailyStartStateData, DailyStartStateStore } from "./daily-start-state";
import { emptyDailyStartState } from "./daily-start-state";
import { DailyRunTracker } from "./daily-start-runs";
import { describePreflightFailure, needsPreflight, type PreflightFailure } from "./preflight";

const log = logger("DailyStartDetector");

/** Minimum gap between activity-triggered checks. */
export const ACTIVITY_THROTTLE_MS = 30_000;

/** `on_daily_start` sources: circuits opt in with `notor-daily-start: true`. */
export const DAILY_START_TRIGGER_SPEC: TriggerSourceSpec = {
	hookEvent: "on_daily_start",
	workflowTrigger: "on-daily-start",
	circuitMatches: (circuit) => circuit.dailyStart,
	requireSchedule: false,
};

/** A pre-flight failure as reported to the UI. */
export interface DailyStartFailureReport {
	failure: PreflightFailure;
	reason: string;
	/** Retries scheduled so far (0 when retries are disabled). */
	attempt: number;
	maxAttempts: number;
	/** Epoch ms of the next retry, or null when giving up. */
	retryAt: number | null;
	/** Labels of the targets that are waiting. */
	labels: string[];
}

/** Notices / UI surface (see `daily-start-notices.ts`). */
export interface DailyStartUi {
	runChanged(record: DailyRunRecord): void;
	preflightFailed(report: DailyStartFailureReport): void;
	preflightCleared(): void;
}

export interface DailyStartDetectorDeps {
	getSettings: () => NotorSettings;
	state: DailyStartStateStore;
	sources: TriggerSourceAccessors;
	executors: TriggerExecutors;
	preflight: {
		resolveProviders: (target: TriggerTarget) => Promise<string[]>;
		run: (providerIds: string[]) => Promise<PreflightFailure | null>;
	};
	ui: DailyStartUi;
	now?: () => Date;
}

export class DailyStartDetector {
	readonly runs: DailyRunTracker;
	private lastCheckAt = Number.NEGATIVE_INFINITY;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** True while a check / attempt is in flight (serializes firing). */
	private busy = false;

	constructor(private readonly deps: DailyStartDetectorDeps) {
		this.runs = new DailyRunTracker({
			getRecord: (key) => this.load().runs.find((r) => r.key === key) ?? null,
			patchRecord: (key, patch) => this.patchRecord(key, patch),
			onRecordChanged: (record) => deps.ui.runChanged(record),
		});
	}

	/** Plugin layout is ready: resume a persisted retry, then count the load as activity. */
	start(): void {
		const state = this.load();
		if (state.pendingRetry && state.lastFiredDay === this.today()) {
			this.scheduleRetry(state.pendingRetry.nextAt);
		}
		this.noteActivity();
	}

	/** Report user activity. Throttled; fires when a new logical day has begun. */
	noteActivity(): void {
		const t = this.now().getTime();
		if (t - this.lastCheckAt < ACTIVITY_THROTTLE_MS) return;
		this.lastCheckAt = t;
		void this.check(false);
	}

	/** Fire now regardless of `lastFiredDay` (the "Run daily start now" command). */
	runNow(): Promise<void> {
		return this.check(true);
	}

	/** Run the pending pre-flight retry immediately (Notice button / back online). */
	retryNow(): void {
		if (!this.load().pendingRetry) return;
		this.clearRetryTimer();
		void this.retry();
	}

	/** True when at least one `on_daily_start` target is configured. */
	hasTargets(): boolean {
		return this.collect().length > 0;
	}

	/** Logical day the trigger last fired on this device. */
	lastFiredDay(): string | null {
		return this.load().lastFiredDay;
	}

	/** Records for the most recent fired day, newest attempt first. */
	recentRuns(): DailyRunRecord[] {
		return [...this.load().runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
	}

	/** Conversation to open for a record (a running workflow's record may lag). */
	conversationFor(record: DailyRunRecord): string | null {
		return record.conversationId ?? this.runs.liveConversationId(record.key);
	}

	/** Forget this device's fired day and any pending retry (settings "Reset"). */
	resetDeviceState(): void {
		this.clearRetryTimer();
		this.deps.state.save(emptyDailyStartState());
		this.deps.ui.preflightCleared();
	}

	destroy(): void {
		this.clearRetryTimer();
		this.runs.destroy();
	}

	// -------------------------------------------------------------------------

	private async check(force: boolean): Promise<void> {
		if (this.busy) return;
		const day = this.today();
		if (!force && this.load().lastFiredDay === day) return;

		const targets = this.collect();
		if (targets.length === 0) return;

		// Persist the fired day before dispatching anything.
		this.clearRetryTimer();
		this.deps.state.save({ lastFiredDay: day, runs: [], pendingRetry: null });
		this.deps.ui.preflightCleared();
		log.info("Daily start firing", { day, force, targets: targets.map((t) => t.key) });

		for (const target of targets.filter((t) => !needsPreflight(t))) {
			this.launch(target);
		}
		await this.attempt(targets.filter(needsPreflight));
	}

	private async retry(): Promise<void> {
		this.retryTimer = null;
		if (this.busy) return;
		const state = this.load();
		const pending = state.pendingRetry;
		if (!pending) return;
		if (state.lastFiredDay !== this.today()) {
			// A new logical day has begun; the next activity check fires fresh.
			this.save({ ...state, pendingRetry: null });
			this.deps.ui.preflightCleared();
			return;
		}
		const waiting = this.collect().filter((t) => pending.targetKeys.includes(t.key));
		if (waiting.length === 0) {
			this.save({ ...state, pendingRetry: null });
			this.deps.ui.preflightCleared();
			return;
		}
		await this.attempt(waiting);
	}

	/** Pre-flight each AI target; launch the ones that pass, schedule a retry for the rest. */
	private async attempt(targets: TriggerTarget[]): Promise<void> {
		if (targets.length === 0) return;
		this.busy = true;
		try {
			const byProvider = new Map<string, PreflightFailure | null>();
			const failed: TriggerTarget[] = [];
			let firstFailure: PreflightFailure | null = null;

			for (const target of targets) {
				let failure: PreflightFailure | null = null;
				try {
					for (const id of await this.deps.preflight.resolveProviders(target)) {
						if (!byProvider.has(id)) byProvider.set(id, await this.deps.preflight.run([id]));
						failure = byProvider.get(id) ?? null;
						if (failure) break;
					}
				} catch (e) {
					log.warn("Daily start pre-flight resolution failed; launching anyway", { key: target.key, error: String(e) });
				}
				if (failure) {
					failed.push(target);
					firstFailure ??= failure;
					this.upsertRecord(target, { status: "pending_retry", error: describePreflightFailure(failure) });
				} else {
					this.launch(target);
				}
			}

			if (!firstFailure) {
				this.save({ ...this.load(), pendingRetry: null });
				this.deps.ui.preflightCleared();
				return;
			}
			this.onPreflightFailed(firstFailure, failed);
		} finally {
			this.busy = false;
		}
	}

	private onPreflightFailed(failure: PreflightFailure, failed: TriggerTarget[]): void {
		const settings = this.deps.getSettings();
		const policy = retryPolicyFromSettings(settings);
		const state = this.load();
		const retry = (state.pendingRetry?.attempt ?? 0) + 1;
		const reason = describePreflightFailure(failure);
		const labels = failed.map((t) => t.label);
		log.warn("Daily start pre-flight failed", { provider: failure.providerId, kind: failure.kind, retry });

		if (retry > policy.maxRetries) {
			this.save({ ...state, pendingRetry: null });
			for (const target of failed) this.upsertRecord(target, { status: "gave_up", error: reason });
			this.deps.ui.preflightFailed({ failure, reason, attempt: retry - 1, maxAttempts: policy.maxRetries, retryAt: null, labels });
			return;
		}

		const retryAt = this.now().getTime() + backoffDelay(retry, policy);
		this.save({
			...state,
			pendingRetry: { attempt: retry, nextAt: retryAt, targetKeys: failed.map((t) => t.key), reason },
		});
		this.scheduleRetry(retryAt);
		this.deps.ui.preflightFailed({ failure, reason, attempt: retry, maxAttempts: policy.maxRetries, retryAt, labels });
	}

	private launch(target: TriggerTarget): void {
		let observer;
		if (needsPreflight(target)) {
			this.upsertRecord(target, {});
			observer = this.runs.observe(target);
		}
		fireTriggerTarget(target, "on_daily_start", "Daily start", this.deps.executors, observer);
	}

	private scheduleRetry(at: number): void {
		this.clearRetryTimer();
		const delay = Math.max(0, at - this.now().getTime());
		this.retryTimer = setTimeout(() => void this.retry(), delay);
	}

	private clearRetryTimer(): void {
		if (this.retryTimer !== null) clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}

	private collect(): TriggerTarget[] {
		const hooks = this.deps.getSettings().vault_event_hooks.on_daily_start ?? [];
		return collectTriggerTargets(DAILY_START_TRIGGER_SPEC, hooks, this.deps.sources);
	}

	private upsertRecord(target: TriggerTarget, patch: Partial<DailyRunRecord>): void {
		const state = this.load();
		const existing = state.runs.find((r) => r.key === target.key);
		const record: DailyRunRecord = {
			key: target.key,
			label: target.label,
			kind: target.kind,
			status: "running",
			conversationId: null,
			sessionId: null,
			error: null,
			startedAt: this.now().toISOString(),
			...existing,
			...patch,
		};
		this.save({ ...state, runs: [...state.runs.filter((r) => r.key !== target.key), record] });
	}

	private patchRecord(key: string, patch: Partial<DailyRunRecord>): DailyRunRecord | null {
		const state = this.load();
		const existing = state.runs.find((r) => r.key === key);
		if (!existing) return null;
		const record = { ...existing, ...patch };
		this.save({ ...state, runs: state.runs.map((r) => (r.key === key ? record : r)) });
		return record;
	}

	private load(): DailyStartStateData {
		return this.deps.state.load();
	}

	private save(data: DailyStartStateData): void {
		this.deps.state.save(data);
	}

	private today(): string {
		return logicalDay(this.now(), parseResetTime(this.deps.getSettings().daily_start_reset_time));
	}

	private now(): Date {
		return this.deps.now?.() ?? new Date();
	}
}

/** Long-backoff retry policy from the daily-start settings (minutes → ms). */
export function retryPolicyFromSettings(settings: NotorSettings): RetryPolicy {
	const maxRetries = Math.max(0, Math.floor(settings.daily_start_retry_max_attempts ?? 5));
	const baseMinutes = Math.max(1, settings.daily_start_retry_base_minutes ?? 3);
	const maxMinutes = Math.max(baseMinutes, settings.daily_start_retry_max_minutes ?? 30);
	return {
		maxRetries,
		baseDelayMs: baseMinutes * 60_000,
		maxDelayMs: maxMinutes * 60_000,
		offlineWaitMaxMs: 0,
	};
}
