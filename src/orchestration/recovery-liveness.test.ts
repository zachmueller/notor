/**
 * F1 Fix 2 — recovery liveness predicate.
 *
 * The recovery scan skips a still-`active` root whose `session-log.jsonl` mtime is
 * fresh (a live runner is still writing it), and offers resume otherwise. This
 * covers the pure freshness boundary the launch-side `isSessionLogLive` delegates
 * to — fresh → live (skip), stale → not live (offer), null stat → not live.
 *
 * @see specs/ZZ-misc/arch-review-july-2026/F1-orchestration-run-lifecycle.md — Fix 2
 */

import { describe, it, expect } from "vitest";
import { isSessionLogMtimeLive } from "./recovery-liveness";

const NOW = 1_000_000_000_000;

describe("isSessionLogMtimeLive (F1 Fix 2)", () => {
	it("treats a fresh mtime as live (recovery skips → no second runner)", () => {
		// 10s old — well within the 90s live window.
		expect(isSessionLogMtimeLive(NOW - 10_000, NOW)).toBe(true);
	});

	it("treats a stale mtime as not live (recovery offers resume)", () => {
		// 2 minutes old — beyond the live window.
		expect(isSessionLogMtimeLive(NOW - 120_000, NOW)).toBe(false);
	});

	it("treats a null stat (adapter differences / missing file) as not live", () => {
		expect(isSessionLogMtimeLive(null, NOW)).toBe(false);
	});

	it("is generous at the boundary — just under the threshold is still live", () => {
		expect(isSessionLogMtimeLive(NOW - 89_000, NOW)).toBe(true);
		expect(isSessionLogMtimeLive(NOW - 91_000, NOW)).toBe(false);
	});
});
