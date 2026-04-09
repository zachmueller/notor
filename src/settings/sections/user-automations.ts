/**
 * User automations settings section renderer.
 *
 * Extracted from `extensions.ts` so that the Automation section in
 * `settings-tab.ts` can render user automations alongside hooks and
 * vault event hooks.
 *
 * @see specs/ZZ-misc/settings-reorganization-design.md — Section 9
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { renderFieldList } from "./field-renderer";

/** Render the "User automations" sub-section. */
export function renderUserAutomationsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const automations = manager.getAutomations();

	if (automations.length === 0) return;

	new Setting(containerEl).setHeading().setName("User automations");

	for (const automation of automations) {
		const label = automation.displayName
			?? automation.filePath.split("/").pop()?.replace(/\.md$/, "")
			?? automation.filePath;
		const extKey = automation.displayName ?? automation.filePath;

		const setting = new Setting(containerEl)
			.setName(label)
			.setDesc(`Trigger: ${automation.trigger}`);

		// "User" badge
		setting.nameEl.createSpan({
			text: "User",
			cls: "notor-extension-badge-user",
		});

		// Open button
		setting.addButton((btn) =>
			btn
				.setIcon("square-arrow-out-up-right")
				.setTooltip("Open extension file")
				.onClick(async () => {
					await ctx.app.workspace.openLinkText(automation.filePath, "", true);
				}),
		);

		// Inline settings if present
		if (automation.settingsSchema && automation.settingsSchema.length > 0) {
			renderFieldList(containerEl, ctx, automation.settingsSchema, {
				kind: "extension",
				extensionName: extKey,
			});

			new Setting(containerEl).addButton((btn) =>
				btn
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(async () => {
						delete ctx.settings.user_extension_settings[extKey];
						await ctx.saveSettings();
						ctx.redisplay();
					}),
			);
		}
	}
}
