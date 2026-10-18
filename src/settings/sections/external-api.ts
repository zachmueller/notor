/**
 * External API settings — the gates on `app.plugins.plugins.notor.api`, the
 * surface Templater scripts and other plugins use to run circuits, workflows,
 * and tools.
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { markSubsection } from "../helpers";

/** Render the "External API" subsection. */
export function renderExternalApiSection(containerEl: HTMLElement, ctx: SettingsContext): void {
	const heading = new Setting(containerEl).setHeading().setName("External API");
	markSubsection(heading, "External API");
	containerEl.createEl("p", {
		text:
			"Lets Templater scripts and other plugins run circuits, workflows, and tools through " +
			"app.plugins.plugins.notor.api. Runs follow your Plan/Act mode and approval rules.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Enable external API")
		.setDesc("When off, every API call fails with an error.")
		.addToggle((toggle) =>
			toggle.setValue(ctx.settings.external_api_enabled).onChange(async (value) => {
				ctx.settings.external_api_enabled = value;
				await ctx.saveSettings();
			}),
		);

	new Setting(containerEl)
		.setName("Allow scripts to auto-approve")
		.setDesc(
			"Lets a script pass approval: \"auto\" to approve every allowed tool call in its run. " +
			"Never-auto-approve paths and blocked commands still ask you, and a notice appears " +
			"each time a run auto-approves. Only turn this on if you trust the scripts that call Notor.",
		)
		.addToggle((toggle) =>
			toggle.setValue(ctx.settings.external_api_allow_auto_approve).onChange(async (value) => {
				ctx.settings.external_api_allow_auto_approve = value;
				await ctx.saveSettings();
			}),
		);
}
