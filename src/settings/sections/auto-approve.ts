/**
 * Auto-approve settings section renderer (SET-002).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import { TOOL_DISPLAY_NAMES } from "../constants";
import type { SettingsContext } from "./context";

/** Render the "Auto-approve" settings section. */
export function renderAutoApproveSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Auto-approve");
	containerEl.createEl("p", {
		text:
			"When auto-approve is on for a tool, it executes immediately without " +
			"an inline approval prompt. Read-only tools default to auto-approved; " +
			"write tools default to requiring approval.",
		cls: "setting-item-description",
	});

	const readTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([, meta]) => !meta.isWrite
	);
	const writeTools = Object.entries(TOOL_DISPLAY_NAMES).filter(
		([, meta]) => meta.isWrite
	);

	// Read-only tools
	new Setting(containerEl).setHeading().setName("Read-only tools");
	for (const [toolId, meta] of readTools) {
		new Setting(containerEl)
			.setName(meta.name)
			.setDesc(meta.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(
						ctx.settings.auto_approve[toolId] ?? true
					)
					.onChange(async (value) => {
						ctx.settings.auto_approve[toolId] = value;
						await ctx.saveSettings();
					})
			);
	}

	// Write tools
	new Setting(containerEl).setHeading().setName("Write tools");
	for (const [toolId, meta] of writeTools) {
		new Setting(containerEl)
			.setName(meta.name)
			.setDesc(meta.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(
						ctx.settings.auto_approve[toolId] ?? false
					)
					.onChange(async (value) => {
						ctx.settings.auto_approve[toolId] = value;
						await ctx.saveSettings();
					})
			);
	}
}
