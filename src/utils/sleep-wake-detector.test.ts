import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	SleepWakeDetector,
	SLEEP_HEARTBEAT_INTERVAL_MS,
	SLEEP_DETECTION_THRESHOLD_MS,
} from "./sleep-wake-detector";

describe("SleepWakeDetector", () => {
	let registered: (() => void) | null;
	const registerInterval = (cb: () => void, _ms: number): number => {
		registered = cb;
		return 1;
	};

	beforeEach(() => {
		registered = null;
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not fire when ticks arrive within the threshold", () => {
		const detector = new SleepWakeDetector();
		const wake = vi.fn();
		detector.onWake(wake);
		detector.start(registerInterval);

		// Normal tick — clock advanced by the heartbeat interval only.
		vi.setSystemTime(SLEEP_HEARTBEAT_INTERVAL_MS);
		registered!();

		expect(wake).not.toHaveBeenCalled();
	});

	it("fires with the detected gap when a tick is delayed past the threshold", () => {
		const detector = new SleepWakeDetector();
		const wake = vi.fn();
		detector.onWake(wake);
		detector.start(registerInterval);

		// Simulate a sleep: the next tick lands far later than expected.
		const gap = SLEEP_DETECTION_THRESHOLD_MS + 30_000;
		vi.setSystemTime(gap);
		registered!();

		expect(wake).toHaveBeenCalledTimes(1);
		expect(wake).toHaveBeenCalledWith(gap);
	});

	it("notifies multiple subscribers and stops after unsubscribe", () => {
		const detector = new SleepWakeDetector();
		const a = vi.fn();
		const b = vi.fn();
		detector.onWake(a);
		const unsub = detector.onWake(b);
		detector.start(registerInterval);

		const gap = SLEEP_DETECTION_THRESHOLD_MS + 1_000;
		vi.setSystemTime(gap);
		registered!();
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);

		unsub();
		vi.setSystemTime(gap * 3);
		registered!();
		expect(a).toHaveBeenCalledTimes(2);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it("isolates subscriber errors", () => {
		const detector = new SleepWakeDetector();
		const bad = vi.fn(() => {
			throw new Error("boom");
		});
		const good = vi.fn();
		detector.onWake(bad);
		detector.onWake(good);
		detector.start(registerInterval);

		vi.setSystemTime(SLEEP_DETECTION_THRESHOLD_MS + 1_000);
		expect(() => registered!()).not.toThrow();
		expect(good).toHaveBeenCalledTimes(1);
	});
});
