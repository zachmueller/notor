/**
 * Thin wrapper over `navigator.onLine` and the window `online`/`offline`
 * events, so the stream-retry loop can pause while the device is offline
 * instead of spending retries.
 *
 * `navigator.onLine === true` doesn't guarantee reachability (captive
 * portals, plane Wi-Fi with no uplink) — the retry budget still covers
 * that case. Injectable so tests can drive connectivity changes.
 */

export interface NetworkMonitor {
	/** Whether the device currently reports a network connection. */
	isOnline(): boolean;
	/** Subscribe to connectivity changes; returns an unsubscribe function. */
	subscribe(listener: (online: boolean) => void): () => void;
}

/** Browser/Electron monitor; degrades to "always online" without a window. */
export const browserNetworkMonitor: NetworkMonitor = {
	isOnline(): boolean {
		return typeof navigator === "undefined" || navigator.onLine !== false;
	},
	subscribe(listener: (online: boolean) => void): () => void {
		if (typeof window === "undefined") return () => {};
		const onOnline = () => listener(true);
		const onOffline = () => listener(false);
		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);
		return () => {
			window.removeEventListener("online", onOnline);
			window.removeEventListener("offline", onOffline);
		};
	},
};

/**
 * Resolve once the monitor reports online, `maxMs` elapses, or `signal`
 * aborts. `onTick` fires every `tickMs` with the time waited so far, so
 * callers can refresh UI and heartbeat liveness during a long outage.
 */
export function waitForOnline(
	monitor: NetworkMonitor,
	opts: { signal?: AbortSignal; maxMs: number; tickMs?: number; onTick?: (waitedMs: number) => void },
): Promise<"online" | "timeout" | "aborted"> {
	if (opts.signal?.aborted) return Promise.resolve("aborted");
	if (monitor.isOnline()) return Promise.resolve("online");
	if (opts.maxMs <= 0) return Promise.resolve("timeout");

	return new Promise((resolve) => {
		const started = Date.now();
		const cleanups: Array<() => void> = [];
		const finish = (outcome: "online" | "timeout" | "aborted") => {
			for (const cleanup of cleanups) cleanup();
			resolve(outcome);
		};

		cleanups.push(monitor.subscribe((online) => {
			if (online) finish("online");
		}));
		const timeout = setTimeout(() => finish("timeout"), opts.maxMs);
		cleanups.push(() => clearTimeout(timeout));
		if (opts.onTick) {
			const tick = setInterval(() => opts.onTick?.(Date.now() - started), opts.tickMs ?? 1000);
			cleanups.push(() => clearInterval(tick));
		}
		if (opts.signal) {
			const onAbort = () => finish("aborted");
			opts.signal.addEventListener("abort", onAbort, { once: true });
			cleanups.push(() => opts.signal?.removeEventListener("abort", onAbort));
		}
	});
}
