/**
 * Manual save detector — command interception for on_manual_save hooks.
 *
 * Implements the `editor:save-file` command interception mechanism to
 * distinguish manual saves (Cmd+S / Ctrl+S) from auto-saves (FR-48b).
 *
 * Monkey-patches `app.commands.executeCommandById` to set a short-lived
 * flag when the save command is executed. Based on R-2 research findings.
 *
 * Desktop-only: on mobile, `install()` is a no-op and `isManualSave()`
 * always returns `false`, as the `editor:save-file` command is not
 * reliably available on mobile per R-2.
 *
 * @see specs/03-workflows-personas/tasks/group-f-tasks.md — F-011
 * @see specs/03-workflows-personas/research/research-r2-manual-save-test.ts
 */

import type { App } from "obsidian";
import { MarkdownView, Platform } from "obsidian";
import { logger } from "../utils/logger";

const log = logger("ManualSaveDetector");

/** The Obsidian command ID for "Save current file". */
const SAVE_COMMAND_ID = "editor:save-file";

/**
 * Window in milliseconds within which a save event is considered "manual"
 * after the save command was intercepted.
 */
const MANUAL_SAVE_WINDOW_MS = 500;

/**
 * Cleanup interval period in milliseconds. Runs every 60 s to prune any
 * unconsumed flags that have grown stale beyond the window.
 */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Cutoff for pruning unconsumed flags: 2× the window to account for
 * any timing edge cases where the modify event hasn't fired yet.
 */
const STALE_CUTOFF_MS = MANUAL_SAVE_WINDOW_MS * 2;

// ---------------------------------------------------------------------------
// ManualSaveDetector
// ---------------------------------------------------------------------------

/**
 * Detects whether a `vault.on('modify')` event was caused by a manual save
 * (Cmd+S / Ctrl+S) by intercepting `app.commands.executeCommandById`.
 *
 * Usage:
 * ```ts
 * const detector = new ManualSaveDetector();
 * detector.install(app);
 * // ...
 * if (detector.isManualSave(notePath)) { /* handle manual save *\/ }
 * // ...
 * detector.destroy(); // on plugin unload
 * ```
 */
export class ManualSaveDetector {
	/**
	 * Pending manual save flags: note path → timestamp (ms).
	 * Populated by the command interceptor; consumed by `isManualSave()`.
	 */
	private readonly pendingFlags = new Map<string, number>();

	/**
	 * Restores the original `executeCommandById` implementation.
	 * Set by `install()`; called by `destroy()`.
	 */
	private uninstallFn: (() => void) | null = null;

	/**
	 * Reference to the Obsidian App instance, held for active file lookup.
	 */
	private app: App | null = null;

	// ---------------------------------------------------------------------------
	// Install / uninstall
	// ---------------------------------------------------------------------------

	/**
	 * Patch `app.commands.executeCommandById` to intercept `editor:save-file`.
	 *
	 * When the save command executes, records the active file's path with the
	 * current timestamp. The `vault.on('modify')` event that follows within
	 * `MANUAL_SAVE_WINDOW_MS` will be identified as a manual save by
	 * `isManualSave()`.
	 *
	 * If the Obsidian `commands` API is unavailable (future API change), the
	 * method logs a warning and returns a no-op without patching.
	 *
	 * Desktop-only: on mobile this method is a no-op per R-2 findings.
	 *
	 * @param app - The Obsidian App instance.
	 */
	install(app: App): void {
		this.app = app;

		// Desktop-only guard
		if (!Platform.isDesktopApp) {
			log.debug("ManualSaveDetector: skipping install on mobile");
			this.uninstallFn = null;
			return;
		}

		// Defensive check: ensure commands API is available and patchable
		const commands = (app as unknown as Record<string, unknown>)["commands"] as
			| Record<string, unknown>
			| undefined;

		if (
			!commands ||
			typeof commands["executeCommandById"] !== "function"
		) {
			log.warn(
				"ManualSaveDetector: app.commands.executeCommandById not available — " +
				"on_manual_save hooks will not fire. " +
				"This may occur if the Obsidian API has changed."
			);
			this.uninstallFn = null;
			return;
		}

		const originalFn = commands["executeCommandById"] as (
			id: string,
			...args: unknown[]
		) => unknown;

		// Patch: intercept save-file command
		const detector = this;
		commands["executeCommandById"] = function (
			this: unknown,
			id: string,
			...args: unknown[]
		): unknown {
			if (id === SAVE_COMMAND_ID) {
				detector.recordManualSaveFlag();
			}
			return originalFn.apply(this, [id, ...args]);
		};

		log.debug("ManualSaveDetector: installed command interceptor");

		// Store uninstall function to restore original
		this.uninstallFn = () => {
			commands["executeCommandById"] = originalFn;
			log.debug("ManualSaveDetector: uninstalled command interceptor");
		};
	}

	// ---------------------------------------------------------------------------
	// Manual save detection
	// ---------------------------------------------------------------------------

	/**
	 * Check whether a `vault.on('modify')` event for the given note path was
	 * caused by a manual save command.
	 *
	 * Returns `true` and **consumes** the flag (one-shot) if a pending flag
	 * exists for the path within `MANUAL_SAVE_WINDOW_MS`. Returns `false`
	 * if no flag exists, the flag has expired, or running on mobile.
	 *
	 * @param notePath - Vault-relative path of the modified note.
	 * @returns `true` if this was a manual save; `false` otherwise.
	 */
	isManualSave(notePath: string): boolean {
		if (!Platform.isDesktopApp) return false;

		const flag = this.pendingFlags.get(notePath);
		if (flag === undefined) return false;

		const age = Date.now() - flag;
		if (age > MANUAL_SAVE_WINDOW_MS) {
			// Flag expired — clean it up
			this.pendingFlags.delete(notePath);
			return false;
		}

		// Consume the flag (one-shot)
		this.pendingFlags.delete(notePath);
		log.debug("Manual save detected", { notePath, ageMs: age });
		return true;
	}

	// ---------------------------------------------------------------------------
	// Cleanup
	// ---------------------------------------------------------------------------

	/**
	 * Register a periodic cleanup interval to prune unconsumed stale flags.
	 *
	 * Should be called once during plugin initialization using
	 * `this.registerInterval()` so Obsidian manages the timer lifecycle.
	 *
	 * @param registerInterval - Obsidian's `Plugin.registerInterval()` wrapper.
	 * @returns The interval ID returned by `registerInterval`.
	 */
	startCleanup(
		registerInterval: (callback: () => void, ms: number) => number
	): number {
		return registerInterval(() => {
			this.pruneStaleFlags();
		}, CLEANUP_INTERVAL_MS);
	}

	/**
	 * Uninstall the command interceptor, clear all pending flags, and
	 * release all references.
	 *
	 * Called on plugin unload.
	 */
	destroy(): void {
		if (this.uninstallFn) {
			this.uninstallFn();
			this.uninstallFn = null;
		}
		this.pendingFlags.clear();
		this.app = null;
		log.debug("ManualSaveDetector destroyed");
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	/**
	 * Record a pending manual-save flag for the currently active Markdown note.
	 *
	 * Called by the patched `executeCommandById` when `editor:save-file` fires.
	 * Reads the active file path via `workspace.getActiveViewOfType(MarkdownView)`.
	 */
	private recordManualSaveFlag(): void {
		if (!this.app) return;

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const notePath = activeView?.file?.path;

		if (!notePath) {
			log.debug("ManualSaveDetector: save-file intercepted but no active Markdown file");
			return;
		}

		this.pendingFlags.set(notePath, Date.now());
		log.debug("Manual save flag recorded", { notePath });
	}

	/**
	 * Remove unconsumed flags that have grown older than `STALE_CUTOFF_MS`.
	 */
	private pruneStaleFlags(): void {
		const cutoff = Date.now() - STALE_CUTOFF_MS;
		let pruned = 0;

		for (const [path, ts] of this.pendingFlags) {
			if (ts < cutoff) {
				this.pendingFlags.delete(path);
				pruned++;
			}
		}

		if (pruned > 0) {
			log.debug("Pruned stale manual-save flags", { pruned });
		}
	}
}
