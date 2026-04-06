/**
 * Shell configuration settings section renderer.
 *
 * Tool-specific settings (timeout, max output chars, allowed paths) have been
 * migrated to per-extension settings on the `execute_command` scaffold.
 * Only shell executable and shell arguments remain here — they are consumed
 * by the shell resolver infrastructure, not by the tool scaffold directly.
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Shell configuration" settings section. */
export function renderShellSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Shell configuration");
	containerEl.createEl("p", {
		text:
			"Configure the shell used by execute_command. Timeout, output limits, " +
			"and allowed directories are now configured per-tool in Extensions settings.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Shell executable")
		.setDesc(
			"Custom shell executable to use instead of the platform default. " +
			"Leave empty for automatic detection ($SHELL on macOS/Linux, PowerShell on Windows)."
		)
		.addText((text) =>
			text
				.setPlaceholder("(platform default)")
				.setValue(ctx.settings.execute_command_shell)
				.onChange(async (value) => {
					ctx.settings.execute_command_shell = value.trim();
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Shell arguments")
		.setDesc(
			"Custom shell launch arguments (comma-separated). Leave empty for platform defaults. " +
			"Example: -l,-c for login shell."
		)
		.addText((text) =>
			text
				.setPlaceholder("(platform default)")
				.setValue(
					ctx.settings.execute_command_shell_args.join(", ")
				)
				.onChange(async (value) => {
					ctx.settings.execute_command_shell_args = value
						.split(",")
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
					await ctx.saveSettings();
				})
		);
}
