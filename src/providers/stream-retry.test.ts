import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../utils/logger", () => ({
	logger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
	DEFAULT_RETRY_POLICY,
	backoffDelay,
	formatRetryStatus,
	retriesAttemptedOf,
	retryPolicyFromSettings,
	withStreamRetry,
	type RetryPolicy,
	type RetryStatus,
} from "./stream-retry";
import type { NetworkMonitor } from "./network-status";
import { ProviderError } from "./provider";
import { retryableCodeOfError } from "./network-errors";

/** A controllable connectivity source. */
function fakeNetwork(initiallyOnline = true): NetworkMonitor & { set(online: boolean): void } {
	let online = initiallyOnline;
	const listeners = new Set<(online: boolean) => void>();
	return {
		isOnline: () => online,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			online = next;
			for (const l of [...listeners]) l(next);
		},
	};
}

const POLICY: RetryPolicy = { maxRetries: 3, baseDelayMs: 1_000, maxDelayMs: 30_000, offlineWaitMaxMs: 60_000 };

type Result = { ok: boolean };

/** classify: thrown errors via the shared classifier; results never retry. */
const classify = (outcome: { result?: unknown; error?: unknown }) =>
	outcome.error !== undefined ? retryableCodeOfError(outcome.error) : null;

const netErr = () => new ProviderError("dropped", "bedrock", "CONNECTION_FAILED");

describe("backoffDelay / retryPolicyFromSettings", () => {
	it("doubles from the base delay, caps at maxDelayMs, and jitters ±20%", () => {
		const mid = () => 0.5;
		expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, DEFAULT_RETRY_POLICY, mid))).toEqual([
			1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
		]);
		expect(backoffDelay(1, DEFAULT_RETRY_POLICY, () => 0)).toBe(800);
		expect(backoffDelay(1, DEFAULT_RETRY_POLICY, () => 1)).toBe(1_200);
		expect(backoffDelay(6, DEFAULT_RETRY_POLICY, () => 1)).toBe(30_000);
	});

	it("clamps settings and falls back to defaults", () => {
		expect(retryPolicyFromSettings({})).toEqual(DEFAULT_RETRY_POLICY);
		expect(retryPolicyFromSettings({
			network_retry_max_retries: 99,
			network_retry_max_delay_ms: 5,
			network_offline_wait_max_ms: -1,
		})).toEqual({ maxRetries: 10, baseDelayMs: 1_000, maxDelayMs: 1_000, offlineWaitMaxMs: 0 });
	});

	it("formats status lines", () => {
		expect(formatRetryStatus({ kind: "retrying", retry: 2, maxRetries: 6, remainingMs: 3_200, code: "CONNECTION_FAILED" }))
			.toBe("Connection lost — retrying (2/6) in 4s…");
		expect(formatRetryStatus({ kind: "retrying", retry: 1, maxRetries: 6, remainingMs: 900, code: "SERVICE_UNAVAILABLE" }))
			.toBe("Provider unavailable — retrying (1/6) in 1s…");
		expect(formatRetryStatus({ kind: "offline", waitedMs: 0 })).toBe("Waiting for network…");
	});
});

describe("withStreamRetry", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(Math, "random").mockReturnValue(0.5); // no jitter
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("retries a transient failure with backoff, then returns the success", async () => {
		const network = fakeNetwork();
		const attempt = vi.fn()
			.mockRejectedValueOnce(netErr())
			.mockRejectedValueOnce(netErr())
			.mockResolvedValueOnce({ ok: true });
		const statuses: RetryStatus[] = [];
		const failed = vi.fn();
		const done = withStreamRetry<Result>(attempt, {
			policy: POLICY, classify, network, onAbort: () => ({ ok: false }),
			onStatus: (s) => statuses.push(s), onFailedAttempt: failed,
		});

		await vi.advanceTimersByTimeAsync(999);
		expect(attempt).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempt).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(2_000);
		await expect(done).resolves.toEqual({ ok: true });
		expect(attempt).toHaveBeenCalledTimes(3);
		expect(failed.mock.calls.map((c) => c[1])).toEqual([1, 2]);
		expect(statuses[0]).toEqual({ kind: "retrying", retry: 1, maxRetries: 3, remainingMs: 1_000, code: "CONNECTION_FAILED" });
		expect(statuses.filter((s) => s.kind === "resumed")).toHaveLength(2);
	});

	it("passes non-retryable failures straight through", async () => {
		const attempt = vi.fn().mockRejectedValue(new ProviderError("denied", "bedrock", "AUTH_FAILED"));
		await expect(withStreamRetry<Result>(attempt, {
			policy: POLICY, classify, network: fakeNetwork(), onAbort: () => ({ ok: false }),
		})).rejects.toMatchObject({ code: "AUTH_FAILED" });
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("rethrows the last error annotated with the retry count once the budget runs out", async () => {
		const attempt = vi.fn().mockImplementation(async () => { throw netErr(); });
		const done = withStreamRetry<Result>(attempt, {
			policy: POLICY, classify, network: fakeNetwork(), onAbort: () => ({ ok: false }),
		});
		const assertion = expect(done).rejects.toSatisfy((e: unknown) => retriesAttemptedOf(e) === 3);
		await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
		await assertion;
		expect(attempt).toHaveBeenCalledTimes(4);
	});

	it("returns the last retryable result when retries are disabled", async () => {
		const attempt = vi.fn().mockResolvedValue({ ok: false });
		const result = await withStreamRetry<Result>(attempt, {
			policy: { ...POLICY, maxRetries: 0 },
			classify: () => "CONNECTION_FAILED",
			network: fakeNetwork(),
			onAbort: () => ({ ok: true }),
		});
		expect(result).toEqual({ ok: false });
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("ends a backoff sleep immediately on abort", async () => {
		const controller = new AbortController();
		const attempt = vi.fn().mockRejectedValue(netErr());
		const done = withStreamRetry<Result | "aborted">(attempt, {
			policy: POLICY, classify, network: fakeNetwork(), signal: controller.signal, onAbort: () => "aborted",
		});
		await vi.advanceTimersByTimeAsync(500);
		controller.abort();
		await expect(done).resolves.toBe("aborted");
		expect(attempt).toHaveBeenCalledTimes(1);
	});

	it("waits offline without spending a retry, then retries after the settle delay", async () => {
		const network = fakeNetwork(false);
		const attempt = vi.fn()
			.mockRejectedValueOnce(netErr())
			.mockResolvedValueOnce({ ok: true });
		const statuses: RetryStatus[] = [];
		const done = withStreamRetry<Result>(attempt, {
			policy: { ...POLICY, maxRetries: 1 }, classify, network, onAbort: () => ({ ok: false }),
			onStatus: (s) => statuses.push(s),
		});

		// Far longer than any backoff: still waiting, no second attempt.
		await vi.advanceTimersByTimeAsync(20_000);
		expect(attempt).toHaveBeenCalledTimes(1);
		expect(statuses.every((s) => s.kind === "offline")).toBe(true);

		network.set(true);
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(done).resolves.toEqual({ ok: true });
		expect(attempt).toHaveBeenCalledTimes(2);
	});

	it("cuts a backoff short when the network comes back", async () => {
		const network = fakeNetwork();
		const attempt = vi.fn()
			.mockRejectedValueOnce(netErr())
			.mockRejectedValueOnce(netErr())
			.mockResolvedValueOnce({ ok: true });
		const done = withStreamRetry<Result>(attempt, {
			policy: POLICY, classify, network, onAbort: () => ({ ok: false }),
		});
		await vi.advanceTimersByTimeAsync(1_000); // first retry
		expect(attempt).toHaveBeenCalledTimes(2);
		// Second backoff is 2s; an `online` event ends it early.
		await vi.advanceTimersByTimeAsync(100);
		network.set(true);
		await vi.advanceTimersByTimeAsync(0);
		await expect(done).resolves.toEqual({ ok: true });
	});

	it("gives up when the offline wait exceeds its cap", async () => {
		const attempt = vi.fn().mockRejectedValue(netErr());
		const done = withStreamRetry<Result>(attempt, {
			policy: { ...POLICY, offlineWaitMaxMs: 5_000 }, classify, network: fakeNetwork(false),
			onAbort: () => ({ ok: false }),
		});
		const assertion = expect(done).rejects.toMatchObject({ code: "CONNECTION_FAILED" });
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
		expect(attempt).toHaveBeenCalledTimes(1);
	});
});
