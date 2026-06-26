/**
 * Sleep/wake detector — monotonic-clock heartbeat that infers a system
 * suspend/resume from a missed interval gap.
 *
 * Obsidian/Electron expose no direct OS sleep/wake API in use here, so we
 * derive the signal: a periodic tick records the wall-clock time; if the gap
 * between two ticks far exceeds the expected interval, the JS event loop was
 * frozen (the machine slept), and we treat the current tick as a wake event.
 *
 * This is the single shared detector for the plugin. Multiple subsystems
 * subscribe via {@link SleepWakeDetector.onWake} — e.g. `McpHub` reconnects
 * its servers, and `WorkflowConcurrencyManager` reconciles stranded background
 * executions. Previously each subsystem would have needed its own heartbeat;
 * one detector keeps a single timer and a single source of truth.
 */

import { logger } from "./logger";

const log = logger("SleepWakeDetector");

/** Heartbeat interval (ms). */
export const SLEEP_HEARTBEAT_INTERVAL_MS = 15_000;

/** If the gap between ticks exceeds this, a sleep/wake event likely occurred. */
export const SLEEP_DETECTION_THRESHOLD_MS = 60_000;

/** Wake callback. Receives the detected gap in milliseconds. */
export type WakeCallback = (gapMs: number) => void;

/**
 * Heartbeat-gap based sleep/wake detector.
 *
 * Provider-agnostic: it only owns the timing logic and fans out a wake event
 * to subscribers. Each subscriber decides its own settle delay / response.
 */
export class SleepWakeDetector {
	/** Wall-clock timestamp of the previous heartbeat tick. */
	private lastHeartbeat = 0;

	/** Registered wake subscribers. */
	private readonly subscribers = new Set<WakeCallback>();

	/**
	 * Begin the heartbeat.
	 *
	 * Should be called once during plugin init using `this.registerInterval()`
	 * so Obsidian manages the timer lifecycle (cleared on unload).
	 *
	 * @param registerInterval - Obsidian's `Plugin.registerInterval()` wrapper,
	 *   same signature as `window.setInterval`.
	 */
	start(registerInterval: (callback: () => void, ms: number) => number): void {
		this.lastHeartbeat = Date.now();
		registerInterval(() => this.tick(), SLEEP_HEARTBEAT_INTERVAL_MS);
	}

	/**
	 * Subscribe to wake events.
	 *
	 * @param callback - Invoked with the detected gap (ms) when a wake is detected.
	 * @returns An unsubscribe function.
	 */
	onWake(callback: WakeCallback): () => void {
		this.subscribers.add(callback);
		return () => {
			this.subscribers.delete(callback);
		};
	}

	/** Remove all subscribers — called on plugin unload. */
	destroy(): void {
		this.subscribers.clear();
	}

	/**
	 * Heartbeat tick — compares the gap since the previous tick and, if it
	 * exceeds the threshold, notifies all wake subscribers.
	 */
	private tick(): void {
		const now = Date.now();
		const gap = now - this.lastHeartbeat;
		this.lastHeartbeat = now;

		if (gap > SLEEP_DETECTION_THRESHOLD_MS) {
			log.info("System sleep/wake detected", {
				gapMs: gap,
				subscribers: this.subscribers.size,
			});
			for (const cb of this.subscribers) {
				try {
					cb(gap);
				} catch (e) {
					log.error("Wake subscriber error", { error: String(e) });
				}
			}
		}
	}
}
