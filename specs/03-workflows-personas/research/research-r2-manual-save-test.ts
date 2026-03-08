/**
 * R-2 Research: Manual Save Detection via Command Interception
 *
 * This file is a reference implementation for the manual-save detection
 * mechanism. It cannot be run standalone — it must be compiled as part of
 * an Obsidian plugin and tested within Obsidian's runtime environment.
 *
 * The approach:
 *   1. Monkey-patch `app.commands.executeCommandById` to detect when
 *      `editor:save-file` is invoked (Cmd+S / Ctrl+S / command palette).
 *   2. Set a short-lived flag in a Map<string, number> with the active
 *      note's path and a timestamp.
 *   3. In the `vault.on('modify', ...)` handler, check if the modified
 *      file has a recent manual-save flag (within a timing window).
 *   4. If it does, this is a manual save — fire on-manual-save hooks.
 *      If not, this is an auto-save — skip.
 *
 * Tested patterns and findings are documented in research.md.
 *
 * @see specs/03-workflows-personas/research.md — R-2 findings
 */

import { App, Plugin, TAbstractFile, TFile, MarkdownView } from "obsidian";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Obsidian's internal `app.commands` object. Not in the public type
 * definitions, but stable and widely used by community plugins.
 *
 * Key methods (observed across Obsidian versions 0.15+–1.7+):
 *   - `commands: Record<string, Command>`  — registered command map
 *   - `executeCommandById(id: string): boolean` — execute a command by ID
 *   - `executeCommand(command: Command): boolean` — execute a command object
 *   - `findCommand(id: string): Command | undefined`
 *   - `listCommands(): Command[]`
 *
 * We only need `executeCommandById` for interception.
 */
interface InternalCommands {
	executeCommandById(id: string): boolean;
	// Other methods exist but are not relevant to this research.
}

interface AppWithCommands extends App {
	commands: InternalCommands;
}

// ---------------------------------------------------------------------------
// Manual-save flag store
// ---------------------------------------------------------------------------

/**
 * Tracks which note paths have been manually saved recently.
 * Key: vault-relative note path
 * Value: timestamp (Date.now()) when the manual save command was intercepted
 */
const manualSaveFlags: Map<string, number> = new Map();

/**
 * Timing window (ms) within which a `vault.on('modify')` event after
 * a `editor:save-file` interception is considered a manual save.
 *
 * Research finding: The delta between command interception and modify event
 * is typically 5–50ms on desktop. A 500ms window provides ample margin for
 * slow I/O or heavy vaults while being short enough to avoid false positives
 * from auto-save (Obsidian's auto-save interval is typically 2000ms+).
 */
const MANUAL_SAVE_WINDOW_MS = 500;

/**
 * Cleanup interval for expired flags (ms). Flags older than 2× the window
 * are pruned to prevent memory growth.
 */
const CLEANUP_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Command interception
// ---------------------------------------------------------------------------

/**
 * Monkey-patch `app.commands.executeCommandById` to intercept
 * `editor:save-file`. Returns an uninstall function that restores
 * the original method.
 *
 * This uses the direct monkey-patch approach (no external library).
 * The `monkey-around` library could be used for a slightly more
 * cooperative pattern, but the manual approach is simpler and avoids
 * an extra dependency for a single interception point.
 *
 * @param app - Obsidian App instance (must have `commands` property)
 * @returns Uninstall function to call on plugin unload
 */
function interceptSaveCommand(app: App): () => void {
	const appWithCmds = app as AppWithCommands;
	const commands = appWithCmds.commands;
	const original = commands.executeCommandById.bind(commands);

	commands.executeCommandById = function (id: string): boolean {
		if (id === "editor:save-file") {
			// Determine which note is currently active
			const activeView = app.workspace.getActiveViewOfType(MarkdownView);
			const activePath = activeView?.file?.path;

			if (activePath) {
				manualSaveFlags.set(activePath, Date.now());
			}
		}

		// Always call the original — we are observing, not blocking
		return original(id);
	};

	// Return uninstall function
	return () => {
		commands.executeCommandById = original;
	};
}

/**
 * Alternative implementation using the `monkey-around` library for
 * cooperative patching. This is the preferred community pattern when
 * multiple plugins may patch the same method.
 *
 * Usage (requires `npm install monkey-around`):
 * ```ts
 * import { around } from "monkey-around";
 *
 * const uninstall = around((app as any).commands, {
 *   executeCommandById(original) {
 *     return function (this: any, id: string): boolean {
 *       if (id === "editor:save-file") {
 *         const activeView = app.workspace.getActiveViewOfType(MarkdownView);
 *         if (activeView?.file?.path) {
 *           manualSaveFlags.set(activeView.file.path, Date.now());
 *         }
 *       }
 *       return original.call(this, id);
 *     };
 *   }
 * });
 * // Call uninstall() on plugin unload
 * ```
 *
 * The `around()` function returns an uninstall callback and chains
 * cooperatively with other patches.
 */

// ---------------------------------------------------------------------------
// Modify event handler — manual save detection
// ---------------------------------------------------------------------------

/**
 * Check whether a file modification was triggered by a manual save.
 * Call this from the `vault.on('modify', ...)` handler.
 *
 * @param filePath - Vault-relative path of the modified file
 * @returns true if this modification was preceded by a manual save command
 */
function isManualSave(filePath: string): boolean {
	const flagTimestamp = manualSaveFlags.get(filePath);
	if (flagTimestamp === undefined) return false;

	const elapsed = Date.now() - flagTimestamp;
	// Consume the flag (one-shot)
	manualSaveFlags.delete(filePath);

	return elapsed <= MANUAL_SAVE_WINDOW_MS;
}

/**
 * Clean up expired manual-save flags to prevent memory growth.
 * Called periodically (e.g., every 60 seconds).
 */
function cleanupExpiredFlags(): void {
	const cutoff = Date.now() - MANUAL_SAVE_WINDOW_MS * 2;
	for (const [path, timestamp] of manualSaveFlags) {
		if (timestamp < cutoff) {
			manualSaveFlags.delete(path);
		}
	}
}

// ---------------------------------------------------------------------------
// Example plugin integration (reference)
// ---------------------------------------------------------------------------

/**
 * Example of how to wire up manual-save detection in a plugin's onload().
 *
 * ```ts
 * class MyPlugin extends Plugin {
 *   private uninstallSaveIntercept?: () => void;
 *   private cleanupInterval?: number;
 *
 *   async onload() {
 *     // 1. Intercept the save command
 *     this.uninstallSaveIntercept = interceptSaveCommand(this.app);
 *     // Register for cleanup on unload
 *     this.register(() => this.uninstallSaveIntercept?.());
 *
 *     // 2. Listen for file modifications
 *     this.registerEvent(
 *       this.app.vault.on("modify", (file: TAbstractFile) => {
 *         if (!(file instanceof TFile) || file.extension !== "md") return;
 *
 *         if (isManualSave(file.path)) {
 *           console.log(`[MANUAL SAVE] ${file.path}`);
 *           // → fire on-manual-save hooks here
 *         } else {
 *           console.log(`[AUTO SAVE] ${file.path}`);
 *           // → auto-save; do not fire on-manual-save hooks
 *         }
 *       })
 *     );
 *
 *     // 3. Periodic cleanup of expired flags
 *     this.cleanupInterval = window.setInterval(
 *       () => cleanupExpiredFlags(),
 *       CLEANUP_INTERVAL_MS
 *     );
 *     this.registerInterval(this.cleanupInterval);
 *   }
 *
 *   onunload() {
 *     // uninstallSaveIntercept and cleanupInterval are auto-cleaned
 *     // via this.register() and this.registerInterval()
 *     manualSaveFlags.clear();
 *   }
 * }
 * ```
 */

// ---------------------------------------------------------------------------
// Test scenarios (to verify in Obsidian)
// ---------------------------------------------------------------------------

/**
 * Test plan for manual verification in Obsidian:
 *
 * TEST 1: Basic manual save detection
 *   1. Open a note in the editor
 *   2. Make an edit (type some text)
 *   3. Press Cmd+S (macOS) or Ctrl+S (Windows/Linux)
 *   4. EXPECT: console logs "[MANUAL SAVE] <path>"
 *   5. EXPECT: vault.on('modify') fires within 5-50ms of command interception
 *
 * TEST 2: Auto-save does NOT trigger manual save
 *   1. Open a note in the editor
 *   2. Make an edit (type some text)
 *   3. Wait for auto-save to trigger (typically after 2+ seconds of inactivity)
 *   4. EXPECT: console logs "[AUTO SAVE] <path>"
 *   5. EXPECT: manualSaveFlags does NOT contain the note's path
 *
 * TEST 3: Command palette save
 *   1. Open a note in the editor
 *   2. Make an edit
 *   3. Open command palette and select "Save current file"
 *   4. EXPECT: console logs "[MANUAL SAVE] <path>"
 *   5. EXPECT: Command palette save routes through executeCommandById("editor:save-file")
 *
 * TEST 4: Multiple panes / split view
 *   1. Open two different notes in a split view
 *   2. Focus the left pane and press Cmd+S
 *   3. EXPECT: Only the left pane's note is flagged as manual save
 *   4. Focus the right pane and press Cmd+S
 *   5. EXPECT: Only the right pane's note is flagged as manual save
 *
 * TEST 5: Rapid saves (debounce interaction)
 *   1. Open a note
 *   2. Press Cmd+S three times in rapid succession (<1 second)
 *   3. EXPECT: First save is detected as manual; subsequent modify events
 *      may or may not fire (Obsidian may coalesce writes)
 *   4. EXPECT: No false positives or missed detections
 *
 * TEST 6: Timing measurement
 *   1. Instrument both the command interceptor and modify handler with
 *      performance.now() timestamps
 *   2. Perform 20+ manual saves across different notes
 *   3. EXPECT: Delta between command interception and modify event is
 *      consistently < 100ms (typically 5-50ms)
 *   4. EXPECT: No cases where modify fires BEFORE command interception
 *
 * TEST 7: Third-party plugin save
 *   1. Install a plugin that calls app.commands.executeCommandById("editor:save-file")
 *   2. Trigger that plugin's save action
 *   3. EXPECT: Detected as "manual save" — this is intentional, as programmatic
 *      command execution represents deliberate save actions
 *
 * TEST 8: Mobile behavior
 *   1. On iOS/Android, note that there is no Cmd+S / Ctrl+S equivalent
 *   2. EXPECT: All saves on mobile are auto-saves via the OS
 *   3. EXPECT: on-manual-save hooks never fire on mobile (no command interception)
 *   4. DECISION: Document that on-manual-save is desktop-only behavior
 *
 * TEST 9: Uninstall/cleanup
 *   1. Enable the plugin with save interception active
 *   2. Disable the plugin
 *   3. Press Cmd+S
 *   4. EXPECT: Original executeCommandById behavior is restored
 *   5. EXPECT: No errors in console from orphaned interceptors
 */

export {
	interceptSaveCommand,
	isManualSave,
	cleanupExpiredFlags,
	manualSaveFlags,
	MANUAL_SAVE_WINDOW_MS,
};
