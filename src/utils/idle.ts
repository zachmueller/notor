/**
 * Run `callback` when the renderer is idle, or after `timeoutMs` at the latest.
 *
 * Uses `requestIdleCallback` where available (desktop Electron, Android WebView)
 * and falls back to a short timer elsewhere (iOS WKWebView has no idle
 * callbacks). Returns a cancel function. Callers register it with
 * `plugin.register()` so a pending callback never fires after unload.
 *
 * Timers are called through the window object at call time and never stored
 * (storing `window.setTimeout` unbound throws "Illegal invocation" in Obsidian).
 */

export interface IdleWindow {
	requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
	cancelIdleCallback?: (handle: number) => void;
	setTimeout(cb: () => void, ms?: number): number;
	clearTimeout(handle: number): void;
}

/** Fallback delay when idle callbacks are unavailable. */
export const IDLE_FALLBACK_DELAY_MS = 200;

export function scheduleWhenIdle(
	callback: () => void,
	timeoutMs: number,
	win: IdleWindow = window,
): () => void {
	let done = false;
	const run = () => {
		if (done) return;
		done = true;
		callback();
	};
	if (typeof win.requestIdleCallback === "function") {
		const handle = win.requestIdleCallback(run, { timeout: timeoutMs });
		return () => {
			done = true;
			win.cancelIdleCallback?.(handle);
		};
	}
	const handle = win.setTimeout(run, Math.min(IDLE_FALLBACK_DELAY_MS, timeoutMs));
	return () => {
		done = true;
		win.clearTimeout(handle);
	};
}
