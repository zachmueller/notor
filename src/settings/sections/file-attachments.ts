/**
 * File attachments settings section renderer (POLISH-001).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "File attachments" settings section. */
export function renderFileAttachmentsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("File attachments");
	containerEl.createEl("p", {
		text:
			"Settings for attaching external files to messages. " +
			"Vault notes can be attached without size restrictions; " +
			"external files from your filesystem are subject to size limits. Desktop only.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("External file size threshold (MB)")
		.setDesc(
			"Files larger than this threshold trigger a confirmation dialog before attaching. " +
			"This prevents accidentally attaching very large files to the context window."
		)
		.addText((text) =>
			text
				.setPlaceholder("1")
				.setValue(String(ctx.settings.external_file_size_threshold_mb))
				.onChange(async (value) => {
					const parsed = parseFloat(value);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.external_file_size_threshold_mb = parsed;
						await ctx.saveSettings();
					}
				})
		);
}
