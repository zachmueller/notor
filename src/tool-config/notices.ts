/**
 * Obsidian Notice helper for tool config validation errors.
 *
 * Provides a reusable `showToolConfigError()` function that surfaces
 * parser errors as Obsidian Notices with right-click navigation to
 * the source note.
 *
 * @see specs/04b-tool-toggle/spec.md — FR-82
 * @see specs/04b-tool-toggle/research/RT-3-notice-right-click.md
 */

import { Notice, Platform } from "obsidian";
import type NotorPlugin from "../main";

/**
 * Show an Obsidian Notice for a tool config validation error.
 *
 * On desktop, the Notice includes a right-click handler that navigates
 * to the source note. On mobile, the handler is omitted (no right-click).
 *
 * @param plugin     - The Notor plugin instance (for workspace access).
 * @param sourceFile - Vault-relative path of the source note.
 * @param detail     - Human-readable error description.
 */
export function showToolConfigError(
	plugin: NotorPlugin,
	sourceFile: string,
	detail: string,
): void {
	const message = `Tool config error in "${sourceFile}": ${detail}` +
		(Platform.isDesktop ? "\n(right-click to jump to note)" : "");

	const notice = new Notice(message, 8000);

	if (Platform.isDesktop) {
		notice.noticeEl.oncontextmenu = () => {
			plugin.app.workspace.openLinkText(sourceFile, "", false);
		};
	}
}
