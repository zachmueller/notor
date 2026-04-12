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
import { markSubsection } from "../helpers";

/**
 * Render the "Title Generation" sub-section in Automation settings.
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 12.4
 */
export function renderTitleGenerationSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const heading = new Setting(containerEl).setHeading().setName("Title generation");
	markSubsection(heading, "Title generation");

	new Setting(containerEl)
		.setName("Enable automatic title generation")
		.setDesc(
			"Each new conversation will use an additional LLM call to generate a descriptive title.",
		)
		.addToggle((toggle) => {
			toggle.setValue(ctx.settings.title_generation_enabled);
			toggle.onChange(async (value) => {
				ctx.settings.title_generation_enabled = value;
				await ctx.saveSettings();
			});
		});

	const configuredPresets = ctx.settings.model_presets.filter(
		(p) => p.provider_type !== null && p.model_id !== null,
	);

	new Setting(containerEl)
		.setName("Title generation preset")
		.setDesc("The model preset used for LLM title generation calls.")
		.addDropdown((dropdown) => {
			if (configuredPresets.length === 0) {
				dropdown.addOption("", "(no presets configured)");
				dropdown.setDisabled(true);
			} else {
				for (const p of configuredPresets) {
					dropdown.addOption(p.name, p.name);
				}
				dropdown.setValue(ctx.settings.title_generation_preset);
				dropdown.onChange(async (value) => {
					ctx.settings.title_generation_preset = value;
					await ctx.saveSettings();
				});
			}
		});
}

/** Render the "User automations" sub-section. */
export function renderUserAutomationsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	// Render title generation section first
	renderTitleGenerationSection(containerEl, ctx);

	const manager = ctx.plugin.getExtensionManager();
	const automations = manager.getAutomations();

	// Filter out scaffold automations from the user-visible list
	const userAutomations = automations.filter((a) => !a.isScaffold);

	if (userAutomations.length === 0) return;

	const heading = new Setting(containerEl).setHeading().setName("User automations");
	markSubsection(heading, "User automations");

	for (const automation of userAutomations) {
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
