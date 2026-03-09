/**
 * Shell commands settings section renderer (TOOL-016).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Shell commands" settings section. */
export function renderExecuteCommandSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	containerEl.createEl("h2", { text: "Shell commands" });
	containerEl.createEl("p", {
		text:
			"Settings for the execute_command tool. Controls shell configuration, " +
			"timeouts, output limits, and allowed working directories. Desktop only.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Command timeout (seconds)")
		.setDesc(
			"Maximum time a command can run before it is terminated."
		)
		.addText((text) =>
			text
				.setPlaceholder("30")
				.setValue(
					String(ctx.settings.execute_command_timeout)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.execute_command_timeout = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Maximum output characters")
		.setDesc(
			"Maximum characters captured from command output. Output exceeding this is truncated."
		)
		.addText((text) =>
			text
				.setPlaceholder("50000")
				.setValue(
					String(ctx.settings.execute_command_max_output_chars)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.execute_command_max_output_chars = parsed;
						await ctx.saveSettings();
					}
				})
		);

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

	// Allowed paths
	containerEl.createEl("h3", { text: "Allowed working directories" });
	containerEl.createEl("p", {
		text:
			"Additional absolute paths where commands are allowed to run. " +
			"The vault root is always allowed.",
		cls: "setting-item-description",
	});

	const allowedPaths = ctx.settings.execute_command_allowed_paths;
	for (let i = 0; i < allowedPaths.length; i++) {
		const entry = allowedPaths[i] ?? "";
		new Setting(containerEl)
			.setName(entry || "(empty)")
			.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						ctx.settings.execute_command_allowed_paths.splice(i, 1);
						await ctx.saveSettings();
						ctx.redisplay();
					})
			);
	}

	let newPath = "";
	new Setting(containerEl)
		.setName("Add allowed path")
		.setDesc("Enter an absolute directory path.")
		.addText((text) => {
			text.setPlaceholder("/path/to/directory").onChange((v) => {
				newPath = v.trim();
			});
		})
		.addButton((btn) =>
			btn.setButtonText("Add").onClick(async () => {
				if (!newPath) {
					new Notice("Enter a path to add.");
					return;
				}
				ctx.settings.execute_command_allowed_paths.push(
					newPath
				);
				await ctx.saveSettings();
				ctx.redisplay();
			})
		);
}
