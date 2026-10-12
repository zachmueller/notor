/**
 * Turn-level retry for provider streams, shared by every consumer (chat
 * orchestrator, run-loop, background workflows, compaction, extension
 * llmCall) so their retry behavior can't drift.
 *
 * A failed attempt is re-run with jittered exponential backoff while the
 * caller's classifier says the failure is transient. While the device
 * reports offline the loop waits for the network to return without
 * spending a retry. Every wait listens to the caller's abort signal, so a
 * user Stop ends it immediately.
 *
 * Re-sending is safe because tools only run after a stream completes —
 * a failed attempt never executed anything.
 */

import type { NotorSettings } from "../settings/types";
import type { ProviderErrorCode } from "./provider";
import { browserNetworkMonitor, waitForOnline, type NetworkMonitor } from "./network-status";
import { logger } from "../utils/logger";

const log = logger("StreamRetry");

/** Retry budget and backoff shape. */
export interface RetryPolicy {
	/** Retries after the first attempt; 0 disables automatic retry. */
	maxRetries: number;
	/** First backoff delay; doubles per retry. */
	baseDelayMs: number;
	/** Cap on a single backoff delay. */
	maxDelayMs: number;
	/** Cap on total time spent waiting for the device to come back online. */
	offlineWaitMaxMs: number;
}

/** 1s → 2s → 4s → 8s → 16s → 30s: about a minute of tolerance. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
	maxRetries: 6,
	baseDelayMs: 1_000,
	maxDelayMs: 30_000,
	offlineWaitMaxMs: 600_000,
};

/** Delay after the network returns before retrying, letting DNS/routes settle. */
const ONLINE_SETTLE_MS = 1_000;

/** How often waits report status (UI countdown, orchestration liveness). */
const STATUS_TICK_MS = 1_000;

const JITTER = 0.2;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Build a policy from settings, clamping each value — settings can be
 * edited without range checks (e.g. via `edit_notor_settings`).
 */
export function retryPolicyFromSettings(
	settings: Partial<Pick<NotorSettings, "network_retry_max_retries" | "network_retry_max_delay_ms" | "network_offline_wait_max_ms">>,
): RetryPolicy {
	return {
		maxRetries: clamp(settings.network_retry_max_retries, 0, 10, DEFAULT_RETRY_POLICY.maxRetries),
		baseDelayMs: DEFAULT_RETRY_POLICY.baseDelayMs,
		maxDelayMs: clamp(settings.network_retry_max_delay_ms, 1_000, 120_000, DEFAULT_RETRY_POLICY.maxDelayMs),
		offlineWaitMaxMs: clamp(settings.network_offline_wait_max_ms, 0, 3_600_000, DEFAULT_RETRY_POLICY.offlineWaitMaxMs),
	};
}

/** Backoff before retry number `retry` (1-based), with ±20% jitter, capped. */
export function backoffDelay(retry: number, policy: RetryPolicy, random: () => number = Math.random): number {
	const exponential = policy.baseDelayMs * Math.pow(2, Math.max(0, retry - 1));
	const jittered = exponential * (1 - JITTER + 2 * JITTER * random());
	return Math.round(Math.min(policy.maxDelayMs, jittered));
}

/** Progress reported while the loop is waiting to retry. */
export type RetryStatus =
	| { kind: "retrying"; retry: number; maxRetries: number; remainingMs: number; code: ProviderErrorCode }
	| { kind: "offline"; waitedMs: number }
	| { kind: "resumed"; retry: number };

/** What one attempt produced: a returned result or a thrown error. */
export type AttemptOutcome<T> = { result: T; error?: undefined } | { result?: undefined; error: unknown };

export interface StreamRetryOptions<T> {
	policy: RetryPolicy;
	signal?: AbortSignal;
	/** The retryable code for a failed outcome, or null to stop (success or permanent failure). */
	classify: (outcome: AttemptOutcome<T>) => ProviderErrorCode | null;
	/** Called after a retryable failure, before waiting (e.g. mark the partial output interrupted). */
	onFailedAttempt?: (outcome: AttemptOutcome<T>, attempt: number) => void;
	/** Called on every wait tick and when a retry attempt starts. */
	onStatus?: (status: RetryStatus) => void;
	/** Result to return when `signal` aborts during a wait. */
	onAbort: () => T;
	/** Identifies the caller in logs (e.g. provider id, "compaction"). */
	label?: string;
	/** Connectivity source; defaults to the browser's. */
	network?: NetworkMonitor;
}

/** Error annotation recording how many retries ran before giving up. */
export interface RetriesAnnotated {
	retriesAttempted?: number;
}

/** Retries a thrown error went through before surfacing (0 when none or unknown). */
export function retriesAttemptedOf(e: unknown): number {
	const n = e && typeof e === "object" ? (e as RetriesAnnotated).retriesAttempted : undefined;
	return typeof n === "number" ? n : 0;
}

/** Human-readable status line, shared by the chat UI and run-loop progress. */
export function formatRetryStatus(status: RetryStatus): string {
	switch (status.kind) {
		case "retrying": {
			const seconds = Math.max(1, Math.ceil(status.remainingMs / 1000));
			return `${retryReasonLabel(status.code)} — retrying (${status.retry}/${status.maxRetries}) in ${seconds}s…`;
		}
		case "offline":
			return "Waiting for network…";
		case "resumed":
			return `Retrying (${status.retry})…`;
	}
}

function retryReasonLabel(code: ProviderErrorCode): string {
	switch (code) {
		case "RATE_LIMITED":
			return "Rate limited";
		case "SERVICE_UNAVAILABLE":
			return "Provider unavailable";
		default:
			return "Connection lost";
	}
}

type WaitOutcome = "elapsed" | "online" | "offline" | "aborted";

/**
 * Sleep `ms`, ending early when the signal aborts or connectivity changes
 * (coming online cuts the backoff short; going offline switches to the
 * no-cost offline wait). Ticks `onTick(remainingMs)` once per second.
 */
function backoffSleep(
	ms: number,
	network: NetworkMonitor,
	signal: AbortSignal | undefined,
	onTick: (remainingMs: number) => void,
): Promise<WaitOutcome> {
	if (signal?.aborted) return Promise.resolve("aborted");
	return new Promise((resolve) => {
		const deadline = Date.now() + ms;
		const cleanups: Array<() => void> = [];
		const finish = (outcome: WaitOutcome) => {
			for (const cleanup of cleanups) cleanup();
			resolve(outcome);
		};
		const timer = setTimeout(() => finish("elapsed"), ms);
		cleanups.push(() => clearTimeout(timer));
		const tick = setInterval(() => onTick(Math.max(0, deadline - Date.now())), STATUS_TICK_MS);
		cleanups.push(() => clearInterval(tick));
		cleanups.push(network.subscribe((online) => finish(online ? "online" : "offline")));
		if (signal) {
			const onAbort = () => finish("aborted");
			signal.addEventListener("abort", onAbort, { once: true });
			cleanups.push(() => signal.removeEventListener("abort", onAbort));
		}
	});
}

/** Plain abortable sleep (the post-reconnect settle delay). */
function settle(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Run `attempt` until it succeeds, fails permanently, or the retry budget
 * runs out. Returns the final result, or rethrows the final error
 * annotated with `retriesAttempted`.
 */
export async function withStreamRetry<T>(
	attempt: (attemptNumber: number) => Promise<T>,
	opts: StreamRetryOptions<T>,
): Promise<T> {
	const { policy, signal } = opts;
	const network = opts.network ?? browserNetworkMonitor;
	let retries = 0;
	let offlineWaitedMs = 0;

	const giveUp = (outcome: AttemptOutcome<T>): T => {
		if (outcome.error === undefined) return outcome.result as T;
		if (retries > 0 && outcome.error && typeof outcome.error === "object") {
			(outcome.error as RetriesAnnotated).retriesAttempted = retries;
		}
		// Rethrow exactly what the attempt threw.
		throw outcome.error as Error;
	};

	for (;;) {
		let outcome: AttemptOutcome<T>;
		try {
			outcome = { result: await attempt(retries + 1) };
		} catch (error) {
			if (signal?.aborted) return opts.onAbort();
			outcome = { error };
		}
		if (signal?.aborted) return outcome.error === undefined ? (outcome.result as T) : opts.onAbort();

		const code = opts.classify(outcome);
		if (code === null) return giveUp(outcome);
		if (retries >= policy.maxRetries) {
			if (policy.maxRetries > 0) {
				log.warn("Provider stream retries exhausted", { label: opts.label, retries, code });
			}
			return giveUp(outcome);
		}

		opts.onFailedAttempt?.(outcome, retries + 1);
		retries++;

		// Wait phase: back off while online; wait (without spending the
		// retry) while offline. A connectivity change mid-sleep re-enters
		// the loop so going offline switches to the offline wait.
		let delayMs = backoffDelay(retries, policy);
		log.info("Provider stream retry", { label: opts.label, retry: retries, maxRetries: policy.maxRetries, delayMs, code });
		for (;;) {
			if (!network.isOnline()) {
				const remaining = policy.offlineWaitMaxMs - offlineWaitedMs;
				const started = Date.now();
				opts.onStatus?.({ kind: "offline", waitedMs: offlineWaitedMs });
				const result = await waitForOnline(network, {
					signal,
					maxMs: remaining,
					tickMs: STATUS_TICK_MS,
					onTick: (waited) => opts.onStatus?.({ kind: "offline", waitedMs: offlineWaitedMs + waited }),
				});
				offlineWaitedMs += Date.now() - started;
				if (result === "aborted") return opts.onAbort();
				if (result === "timeout") {
					log.warn("Gave up waiting for network", { label: opts.label, offlineWaitedMs });
					retries--; // the retry was never spent
					return giveUp(outcome);
				}
				if (!(await settle(ONLINE_SETTLE_MS, signal))) return opts.onAbort();
				break;
			}

			opts.onStatus?.({ kind: "retrying", retry: retries, maxRetries: policy.maxRetries, remainingMs: delayMs, code });
			const sleepStarted = Date.now();
			const result = await backoffSleep(delayMs, network, signal, (remainingMs) =>
				opts.onStatus?.({ kind: "retrying", retry: retries, maxRetries: policy.maxRetries, remainingMs, code }),
			);
			if (result === "aborted") return opts.onAbort();
			if (result === "offline") {
				delayMs = Math.max(0, delayMs - (Date.now() - sleepStarted));
				continue;
			}
			break; // elapsed, or came online — retry now
		}

		opts.onStatus?.({ kind: "resumed", retry: retries });
	}
}

/**
 * Pass `stream` through, calling `onFirst` just before its first chunk is
 * delivered — lets a retried attempt swap out the previous attempt's
 * interrupted output at the moment new output arrives.
 */
export async function* onFirstChunk<C>(stream: AsyncIterable<C>, onFirst: () => void): AsyncIterable<C> {
	let first = true;
	for await (const chunk of stream) {
		if (first) {
			first = false;
			onFirst();
		}
		yield chunk;
	}
}
