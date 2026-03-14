/**
 * General settings section renderer (SET-002).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "General" settings section. */
export function renderGeneralSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("General");

	new Setting(containerEl)
		.setName("Notor directory")
		.setDesc(
			"Vault-relative path for Notor-managed files (system prompts, rules, etc.). " +
				"This folder is visible in the file explorer."
		)
		.addText((text) =>
			text
				.setPlaceholder("notor/")
				.setValue(ctx.settings.notor_dir)
				.onChange(async (value) => {
					ctx.settings.notor_dir =
						value.trim() || "notor/";
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Open notes on access")
		.setDesc(
			"Automatically open notes in the editor when the AI reads or modifies them."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.open_notes_on_access)
				.onChange(async (value) => {
					ctx.settings.open_notes_on_access = value;
					await ctx.saveSettings();
				})
		);
}
