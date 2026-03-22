/**
 * Auto-approve settings section renderer (SET-002).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 * @see specs/04b-tool-toggle/tasks.md — UI-001
 */

import { Notice, Setting } from "obsidian";
import { TOOL_DISPLAY_NAMES } from "../constants";
import type { SettingsContext } from "./context";

/**
 * Generate a `<notor_tool_config>` YAML snippet containing only tools
 * whose auto-approve settings differ from their defaults.
 *
 * Read-only tools default to `true`, write tools default to `false`.
 *
 * @see specs/04b-tool-toggle/spec.md — FR-86
 */
export function generateToolConfigSnippet(
	autoApprove: Record<string, boolean>
): string {
	const lines: string[] = [];

	for (const [toolId, meta] of Object.entries(TOOL_DISPLAY_NAMES)) {
		const defaultValue = !meta.isWrite; // read tools default true, write tools default false
		const currentValue = autoApprove[toolId] ?? defaultValue;
		if (currentValue !== defaultValue) {
			lines.push(`${toolId}:`);
			lines.push(`  auto_approve: ${currentValue}`);
		}
	}

	const comment =
		"# Only tools that differ from global defaults are listed.\n" +
		"# Unlisted tools inherit their settings from global defaults.";

	const body = lines.length > 0 ? `${comment}\n${lines.join("\n")}` : comment;

	return `<notor_tool_config version="1.0">\n${body}\n</notor_tool_config>`;
}

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

	// UI-001: Copy tool config YAML helper button (FR-86)
	new Setting(containerEl)
		.setName("Copy tool config YAML")
		.setDesc(
			"Generate a <notor_tool_config> snippet reflecting current auto-approve " +
			"settings and copy it to your clipboard. Paste into a persona, workflow, " +
			"or rule note to override tool behaviour per context."
		)
		.addButton((btn) =>
			btn
				.setButtonText("Copy to clipboard")
				.onClick(async () => {
					const snippet = generateToolConfigSnippet(ctx.settings.auto_approve);
					await navigator.clipboard.writeText(snippet);
					new Notice("Tool config YAML copied to clipboard.");
				})
		);
}
