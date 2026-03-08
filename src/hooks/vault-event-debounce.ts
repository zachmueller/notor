/**
 * Debounce engine for vault event hooks.
 *
 * Provides a per-event-type, per-note-path cooldown tracker that prevents
 * the same hook from firing repeatedly for rapid successive events on the
 * same note. Used by `on-note-open`, `on-save`, and `on-manual-save`
 * listeners. Not used by `on-note-create`, `on-tag-change`, or
 * `on-schedule` per the contract.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-005
 */

import { logger } from "../utils/logger";

const log = logger("VaultEventDebounce");

// ---------------------------------------------------------------------------
// VaultEventDebounce
// ---------------------------------------------------------------------------

/**
 * Per-event-type, per-note-path cooldown tracker.
 *
 * Tracks when a given (eventType, notePath) pair was last processed and
 * suppresses repeat firings within the configured cooldown window.
 *
 * Internal structure: `Map<eventType, Map<notePath, timestampMs>>`
 */
export class VaultEventDebounce {
	/** Cooldown duration in milliseconds. Readable dynamically for runtime updates. */
	private cooldownMs: number;

	/**
	 * Nested map: event type → note path → last-recorded timestamp (ms).
	 * Lazily populated on first use.
	 */
	private readonly timestamps = new Map<string, Map<string, number>>();

	/**
	 * @param cooldownMs - Cooldown window in milliseconds.
	 *   To allow runtime updates from settings, pass the initial value here
	 *   and call `setCooldown()` whenever settings change.
	 */
	constructor(cooldownMs: number) {
		this.cooldownMs = cooldownMs;
	}

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------

	/**
	 * Update the cooldown window at runtime (e.g. after settings save).
	 *
	 * @param cooldownMs - New cooldown in milliseconds.
	 */
	setCooldown(cooldownMs: number): void {
		this.cooldownMs = cooldownMs;
	}

	/**
	 * Check whether the given (eventType, notePath) pair should be debounced.
	 *
	 * Returns `true` if the pair was recorded within `cooldownMs` — the caller
	 * should skip processing. Returns `false` if the cooldown has expired (or
	 * was never set), records the current timestamp, and allows processing to
	 * proceed.
	 *
	 * @param eventType - Vault event type identifier (e.g. `"on_note_open"`).
	 * @param notePath  - Vault-relative path of the note being processed.
	 * @returns `true` to suppress (debounced); `false` to allow.
	 */
	shouldDebounce(eventType: string, notePath: string): boolean {
		const now = Date.now();

		let pathMap = this.timestamps.get(eventType);
		if (!pathMap) {
			pathMap = new Map<string, number>();
			this.timestamps.set(eventType, pathMap);
		}

		const last = pathMap.get(notePath);
		if (last !== undefined && now - last < this.cooldownMs) {
			log.debug("Debounced event", {
				eventType,
				notePath,
				msSinceLast: now - last,
				cooldownMs: this.cooldownMs,
			});
			return true;
		}

		// Record the new timestamp and allow
		pathMap.set(notePath, now);
		return false;
	}

	/**
	 * Register a periodic cleanup interval that prunes timestamp entries
	 * older than 2× the current cooldown window.
	 *
	 * Should be called once during plugin initialisation using
	 * `this.registerInterval()` so Obsidian manages the timer lifecycle.
	 *
	 * @param registerInterval - Obsidian's `Plugin.registerInterval()` wrapper.
	 *   Accepts the same signature as `window.setInterval`.
	 * @returns The interval ID returned by `registerInterval`.
	 */
	startCleanup(
		registerInterval: (callback: () => void, ms: number) => number
	): number {
		return registerInterval(() => {
			this.prune();
		}, 60_000 /* 60 s */);
	}

	/**
	 * Clear all internal state. Called on plugin unload.
	 */
	destroy(): void {
		this.timestamps.clear();
		log.debug("VaultEventDebounce destroyed");
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Remove entries older than 2× cooldownMs to prevent unbounded memory growth.
	 */
	private prune(): void {
		const cutoff = Date.now() - this.cooldownMs * 2;
		let pruned = 0;

		for (const [eventType, pathMap] of this.timestamps) {
			for (const [notePath, ts] of pathMap) {
				if (ts < cutoff) {
					pathMap.delete(notePath);
					pruned++;
				}
			}
			// Remove empty event-type entries
			if (pathMap.size === 0) {
				this.timestamps.delete(eventType);
			}
		}

		if (pruned > 0) {
			log.debug("Pruned stale debounce entries", { pruned });
		}
	}
}
