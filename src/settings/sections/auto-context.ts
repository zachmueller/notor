/**
 * Auto-context settings section renderer (CTX-005).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Auto-context" settings section. */
export function renderAutoContextSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Auto-context");
	containerEl.createEl("p", {
		text:
			"Ambient workspace signals automatically included with every message sent to the AI. " +
			"Each source can be individually enabled or disabled.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Include open note paths")
		.setDesc(
			"Include the vault-relative paths of all currently open notes so the AI knows your active workspace."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.auto_context_open_notes)
				.onChange(async (value) => {
					ctx.settings.auto_context_open_notes = value;
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Include vault structure")
		.setDesc(
			"Include the top-level folder names in your vault so the AI can navigate and suggest directories."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.auto_context_vault_structure)
				.onChange(async (value) => {
					ctx.settings.auto_context_vault_structure = value;
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Include operating system")
		.setDesc(
			"Include your OS platform (macOS, Windows, Linux) so the AI generates platform-appropriate commands."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.auto_context_os)
				.onChange(async (value) => {
					ctx.settings.auto_context_os = value;
					await ctx.saveSettings();
				})
		);
}
