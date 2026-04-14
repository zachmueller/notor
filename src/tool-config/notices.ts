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
		notice.messageEl.oncontextmenu = () => {
			void plugin.app.workspace.openLinkText(sourceFile, "", false);
		};
	}
}

/**
 * Show a Notice when an MCP server's tools lack readOnlyHint annotations.
 *
 * Warns the user that tools without classification hints default to "write"
 * and suggests verifying the settings. On desktop, right-clicking opens
 * Settings > Tools scrolled to the specific server's tool list.
 *
 * @param plugin     - The Notor plugin instance.
 * @param serverName - The MCP server's slug name.
 * @param toolCount  - Number of tools missing readOnlyHint.
 */
export function showMcpMissingAnnotationsNotice(
	plugin: NotorPlugin,
	serverName: string,
	toolCount: number,
): void {
	const plural = toolCount === 1 ? "tool lacks" : "tools lack";
	const message =
		`MCP server "${serverName}": ${toolCount} ${plural} read/write hints — ` +
		`defaulting to Write. Verify classifications in Settings > Tools.` +
		(Platform.isDesktop ? "\n(right-click to open tool settings)" : "");

	const notice = new Notice(message, 10000);

	if (Platform.isDesktop) {
		notice.messageEl.oncontextmenu = () => {
			const appSetting = (plugin.app as import("obsidian").App & {
				setting?: { open: () => void; openTabById: (id: string) => void };
			}).setting;
			appSetting?.open();
			appSetting?.openTabById("notor");
			setTimeout(() => {
				(plugin as unknown as { _settingTab?: { scrollToGroup: (g: string, s?: string) => void } })
					._settingTab?.scrollToGroup("Tools", `mcp-server:${serverName}`);
			}, 100);
		};
	}
}
