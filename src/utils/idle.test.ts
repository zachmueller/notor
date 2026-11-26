import { describe, expect, it, vi } from "vitest";
import { IDLE_FALLBACK_DELAY_MS, scheduleWhenIdle, type IdleWindow } from "./idle";

function fakeWindow(withIdle: boolean) {
	const idle: Array<{ cb: () => void; opts?: { timeout?: number }; cancelled: boolean }> = [];
	const timers: Array<{ cb: () => void; ms?: number; cancelled: boolean }> = [];
	const win: IdleWindow = {
		setTimeout: vi.fn((cb: () => void, ms?: number) => timers.push({ cb, ms, cancelled: false }) - 1),
		clearTimeout: vi.fn((h: number) => { timers[h]!.cancelled = true; }),
		...(withIdle
			? {
				requestIdleCallback: vi.fn((cb: () => void, opts?: { timeout?: number }) => idle.push({ cb, opts, cancelled: false }) - 1),
				cancelIdleCallback: vi.fn((h: number) => { idle[h]!.cancelled = true; }),
			}
			: {}),
	};
	return { win, idle, timers };
}

describe("scheduleWhenIdle", () => {
	it("uses requestIdleCallback with the timeout when available", () => {
		const { win, idle, timers } = fakeWindow(true);
		const cb = vi.fn();
		scheduleWhenIdle(cb, 5000, win);
		expect(idle).toHaveLength(1);
		expect(idle[0]!.opts).toEqual({ timeout: 5000 });
		expect(timers).toHaveLength(0);
		idle[0]!.cb();
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("falls back to a short timer without idle callbacks", () => {
		const { win, timers } = fakeWindow(false);
		const cb = vi.fn();
		scheduleWhenIdle(cb, 5000, win);
		expect(timers[0]!.ms).toBe(IDLE_FALLBACK_DELAY_MS);
		timers[0]!.cb();
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("never waits longer than the timeout in fallback mode", () => {
		const { win, timers } = fakeWindow(false);
		scheduleWhenIdle(() => undefined, 50, win);
		expect(timers[0]!.ms).toBe(50);
	});

	it("cancel prevents the callback (idle and fallback paths)", () => {
		for (const withIdle of [true, false]) {
			const { win, idle, timers } = fakeWindow(withIdle);
			const cb = vi.fn();
			const cancel = scheduleWhenIdle(cb, 1000, win);
			cancel();
			(withIdle ? idle[0]! : timers[0]!).cb();
			expect(cb).not.toHaveBeenCalled();
		}
	});
});
