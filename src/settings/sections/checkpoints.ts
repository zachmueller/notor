/**
 * Checkpoint settings section renderer (SET-002).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Checkpoints" settings section. */
export function renderCheckpointSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Checkpoints");

	new Setting(containerEl)
		.setName("Storage path")
		.setDesc(
			"Path where note snapshots are stored before write operations. " +
				"Relative to the vault root."
		)
		.addText((text) =>
			text
				.setPlaceholder(`${ctx.app.vault.configDir}/plugins/notor/checkpoints/`)
				.setValue(ctx.settings.checkpoint_path)
				.onChange(async (value) => {
					ctx.settings.checkpoint_path =
						value.trim() ||
						`${ctx.app.vault.configDir}/plugins/notor/checkpoints/`;
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Maximum per conversation")
		.setDesc(
			"Maximum number of checkpoints retained per conversation. " +
				"Oldest checkpoints are pruned when this limit is exceeded."
		)
		.addText((text) =>
			text
				.setPlaceholder("100")
				.setValue(
					String(
						ctx.settings.checkpoint_max_per_conversation
					)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.checkpoint_max_per_conversation =
							parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Maximum age (days)")
		.setDesc(
			"Checkpoints older than this many days are automatically pruned."
		)
		.addText((text) =>
			text
				.setPlaceholder("30")
				.setValue(
					String(ctx.settings.checkpoint_max_age_days)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.checkpoint_max_age_days =
							parsed;
						await ctx.saveSettings();
					}
				})
		);
}
