import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { checkRateLimit, _resetRateLimiter } from "./rate-limiter";

describe("checkRateLimit — 13.7", () => {
	beforeEach(() => {
		_resetRateLimiter();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("allows emits up to the limit within the window", () => {
		const convId = "conv-1";
		for (let i = 0; i < 10; i++) {
			expect(checkRateLimit(convId, 10, 60_000)).toBe(true);
		}
	});

	it("blocks the (limit+1)th emit within the window", () => {
		const convId = "conv-2";
		for (let i = 0; i < 10; i++) {
			checkRateLimit(convId, 10, 60_000);
		}
		// 11th emit should be blocked
		expect(checkRateLimit(convId, 10, 60_000)).toBe(false);
	});

	it("allows emits again after the window slides", () => {
		const convId = "conv-3";
		const windowMs = 60_000;

		// Fill up the limit
		for (let i = 0; i < 10; i++) {
			checkRateLimit(convId, 10, windowMs);
		}
		expect(checkRateLimit(convId, 10, windowMs)).toBe(false);

		// Advance time past the window
		vi.advanceTimersByTime(windowMs + 1);

		// Now emits should be allowed again
		expect(checkRateLimit(convId, 10, windowMs)).toBe(true);
	});

	it("rate limits are per-conversation (different conv IDs are independent)", () => {
		const windowMs = 60_000;
		// Fill conv-a to limit
		for (let i = 0; i < 10; i++) {
			checkRateLimit("conv-a", 10, windowMs);
		}
		// conv-a is blocked
		expect(checkRateLimit("conv-a", 10, windowMs)).toBe(false);
		// conv-b is unaffected
		expect(checkRateLimit("conv-b", 10, windowMs)).toBe(true);
	});

	it("limit of 0 blocks all emits immediately", () => {
		expect(checkRateLimit("conv-zero", 0, 60_000)).toBe(false);
	});

	it("sliding window only counts timestamps within the window", () => {
		const convId = "conv-slide";
		const windowMs = 60_000;

		// Emit 5 times at t=0
		vi.setSystemTime(0);
		for (let i = 0; i < 5; i++) {
			checkRateLimit(convId, 10, windowMs);
		}

		// Advance to t=30s, emit 5 more
		vi.advanceTimersByTime(30_000);
		for (let i = 0; i < 5; i++) {
			checkRateLimit(convId, 10, windowMs);
		}

		// At t=30s: all 10 are within the 60s window → next should be blocked
		expect(checkRateLimit(convId, 10, windowMs)).toBe(false);

		// Advance to t=61s: first batch (t=0) has expired, second batch (t=30s) still valid
		vi.advanceTimersByTime(31_000);
		// 5 old timestamps expired, 5 remain → 5 new emits allowed before hitting limit again
		expect(checkRateLimit(convId, 10, windowMs)).toBe(true);
	});
});
