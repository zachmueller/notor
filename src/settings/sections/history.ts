/**
 * Chat history settings section renderer (SET-002).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Chat history" settings section. */
export function renderHistorySection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Chat history");

	new Setting(containerEl)
		.setName("Storage path")
		.setDesc(
			"Path where conversation history is stored. " +
				"Relative to the vault root. JSONL files are not shown as vault notes."
		)
		.addText((text) =>
			text
				.setPlaceholder(`${ctx.app.vault.configDir}/plugins/notor/history/`)
				.setValue(ctx.settings.history_path)
				.onChange(async (value) => {
					ctx.settings.history_path =
						value.trim() ||
						`${ctx.app.vault.configDir}/plugins/notor/history/`;
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Maximum size (MB)")
		.setDesc(
			"Maximum total size of stored history in megabytes. " +
				"Oldest conversations are pruned when this limit is exceeded. " +
				"Favorited conversations are never pruned."
		)
		.addText((text) =>
			text
				.setPlaceholder("500")
				.setValue(
					String(ctx.settings.history_max_size_mb)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.history_max_size_mb = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Maximum age (days)")
		.setDesc(
			"Conversations older than this many days are automatically pruned. " +
				"Favorited conversations are never pruned."
		)
		.addText((text) =>
			text
				.setPlaceholder("90")
				.setValue(
					String(ctx.settings.history_max_age_days)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.history_max_age_days = parsed;
						await ctx.saveSettings();
					}
				})
		);
}
