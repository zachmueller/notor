/**
 * OS-level (native desktop) notifications for chat events.
 *
 * Wraps the Web Notifications API (available in Obsidian's Electron runtime)
 * to surface completion and input-required events when the user has switched
 * away from Obsidian. Complements — does not replace — the in-app `Notice`
 * toasts (see {@link ../tool-config/notices}).
 *
 * All entry points are desktop-only, opt-in (default OFF), and gated so they
 * fire only when Obsidian is not the active OS app. The whole module is
 * fire-and-forget and defensively wrapped: a notification must never throw
 * into a completion or approval code path.
 *
 * @see ai/notor/ideas — "OS-level notifications for chat events"
 */

import { Platform } from "obsidian";
import type { App } from "obsidian";
import type { NotorSettings } from "../settings/types";
import { CHAT_VIEW_TYPE } from "./chat-view";
import { logger } from "../utils/logger";

const log = logger("OsNotification");

/**
 * The class of event a notification represents. The kind selects which
 * settings toggle gates it — completion kinds share one toggle, input-required
 * kinds share another — so new blocking states are covered automatically as
 * long as they emit the appropriate kind.
 */
export type NotifKind =
	// Completion class — gated by os_notifications_completion_enabled.
	| "chat_complete"
	| "workflow_complete"
	| "error"
	// Input-required class — gated by os_notifications_input_required_enabled.
	| "approval_required"
	| "input_required";

export interface OsNotifyArgs {
	kind: NotifKind;
	/** Notification title, e.g. "Notor — Approval needed". */
	title: string;
	/** Notification body, e.g. "write_note" or a response preview. */
	body: string;
	/** Invoked when the user clicks the notification (focus window + navigate). */
	onClick?: () => void;
}

/** Whether a kind belongs to the input-required class (vs. completion). */
function isInputRequired(kind: NotifKind): boolean {
	return kind === "approval_required" || kind === "input_required";
}

/**
 * Best-effort check for whether Obsidian itself is the active OS application.
 *
 * Prefers Electron's app-level window focus (broader than per-window
 * `document.hasFocus()`), falling back to `document.hasFocus()` if the Electron
 * API is unavailable. Follows the runtime `require("electron")` pattern used in
 * {@link ../ui/attachment-picker}.
 */
function obsidianIsActive(): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- runtime require needed to access Electron's remote which has no static import path in Obsidian's plugin environment
		const { remote } = require("electron") as {
			remote?: {
				getCurrentWindow?: () => { isFocused?: () => boolean };
				BrowserWindow?: { getFocusedWindow?: () => { id?: number } | null };
			};
		};
		const win = remote?.getCurrentWindow?.();
		if (win && typeof win.isFocused === "function") {
			return win.isFocused();
		}
		if (remote?.BrowserWindow?.getFocusedWindow) {
			return remote.BrowserWindow.getFocusedWindow() != null;
		}
	} catch {
		// Electron remote not available — fall through to the DOM check.
	}
	return document.hasFocus();
}

/**
 * Bring the Obsidian OS window to the foreground.
 *
 * Used by notification click handlers. Tries the Electron window's `focus()`
 * first, falling back to the DOM `window.focus()`.
 */
export function focusObsidianWindow(): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports -- runtime require needed to access Electron's remote which has no static import path in Obsidian's plugin environment
		const { remote } = require("electron") as {
			remote?: { getCurrentWindow?: () => { focus?: () => void; show?: () => void } };
		};
		const win = remote?.getCurrentWindow?.();
		if (win) {
			win.show?.();
			win.focus?.();
			return;
		}
	} catch {
		// Fall through to the DOM focus.
	}
	try {
		window.focus();
	} catch {
		/* no-op */
	}
}

/**
 * Bring Obsidian to the foreground and reveal an existing chat panel.
 *
 * Reuses the same `getLeavesOfType` / `revealLeaf` approach as the plugin's
 * `openChatPanel()`. Suitable as a notification `onClick` handler.
 *
 * @param app          - The Obsidian app.
 * @param scrollToPrompt - When true, scroll the revealed panel to its pending
 *                         approval prompt (`.notor-approval-prompt`) if present.
 */
export function revealChatPanel(app: App, scrollToPrompt = false): void {
	focusObsidianWindow();
	try {
		const leaves = app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
		const leaf = leaves[0];
		if (!leaf) return;
		void app.workspace.revealLeaf(leaf);
		if (scrollToPrompt) {
			// Defer until the leaf is revealed/laid out, then scroll the pending
			// approval prompt into view (falls back to a no-op if none is present).
			window.setTimeout(() => {
				const prompt = leaf.view?.containerEl?.querySelector(".notor-approval-prompt");
				prompt?.scrollIntoView({ behavior: "smooth", block: "center" });
			}, 100);
		}
	} catch (e) {
		log.error("Failed to reveal chat panel", { error: String(e) });
	}
}

/**
 * Show an OS-native desktop notification for a chat event, subject to the
 * user's settings and window-focus gating.
 *
 * No-ops silently on mobile, when the relevant toggle is OFF, when Obsidian is
 * the active app (and the suppression toggle is on), or when notification
 * permission is denied. Never throws.
 */
export function showOsNotification(settings: NotorSettings, args: OsNotifyArgs): void {
	try {
		// Desktop only — mobile has no Electron / OS notification layer.
		if (!Platform.isDesktopApp) return;

		// Gate on the class-specific toggle.
		const enabled = isInputRequired(args.kind)
			? settings.os_notifications_input_required_enabled
			: settings.os_notifications_completion_enabled;
		if (!enabled) return;

		// Only notify when the user is working in another app, if configured.
		if (settings.os_notifications_only_when_app_inactive && obsidianIsActive()) {
			return;
		}

		if (typeof Notification === "undefined") return;

		if (Notification.permission === "denied") return;

		if (Notification.permission === "default") {
			// Request permission, then fire once granted. Electron usually
			// pre-grants, so this path is rarely hit.
			void Notification.requestPermission().then((perm) => {
				if (perm === "granted") fire(args);
			});
			return;
		}

		fire(args);
	} catch (e) {
		log.error("Failed to show OS notification", { error: String(e) });
	}
}

/** Create the Notification instance and wire its click handler. */
function fire(args: OsNotifyArgs): void {
	try {
		const notification = new Notification(args.title, { body: args.body });
		if (args.onClick) {
			notification.onclick = () => {
				try {
					args.onClick?.();
				} catch (e) {
					log.error("OS notification onclick handler threw", { error: String(e) });
				}
			};
		}
	} catch (e) {
		log.error("Failed to create Notification", { error: String(e) });
	}
}
