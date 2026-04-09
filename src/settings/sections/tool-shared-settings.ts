/**
 * Shared settings and reload-extensions renderers for the Tools section.
 *
 * Extracted from `extensions.ts` so that `settings-tab.ts` can render these
 * directly inside the Tools group without going through the monolithic
 * extensions section.
 *
 * @see specs/ZZ-misc/settings-reorganization-design.md — Section 7.3
 */

import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { renderFieldList } from "./field-renderer";

/**
 * Render the "Shared settings" sub-section: heading, field list, and
 * "Reset to defaults" button.  No-ops if no shared settings definition exists.
 */
export function renderSharedSettingsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const sharedDef = manager.getSharedSettingsDefinition();
	if (!sharedDef) return;

	new Setting(containerEl).setHeading().setName("Shared settings");
	renderFieldList(containerEl, ctx, sharedDef.settingsSchema, {
		kind: "shared",
	});

	new Setting(containerEl).addButton((btn) =>
		btn
			.setButtonText("Reset to defaults")
			.setWarning()
			.onClick(async () => {
				ctx.settings.user_shared_settings = {};
				await ctx.saveSettings();
				ctx.redisplay();
			}),
	);
}

/**
 * Render the "Reload extensions" button that re-discovers and re-compiles
 * all user tools and automations.
 */
export function renderReloadExtensionsButton(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();

	new Setting(containerEl)
		.setName("Reload extensions")
		.setDesc("Re-discover and re-compile all user tools and automations.")
		.addButton((btn) =>
			btn.setButtonText("Reload").onClick(async () => {
				const result = await manager.reload(false);
				const summary =
					`Extensions reloaded: ${result.toolCount} tool${result.toolCount !== 1 ? "s" : ""}, ` +
					`${result.automationCount} automation${result.automationCount !== 1 ? "s" : ""}` +
					(result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length !== 1 ? "s" : ""})` : "");
				new Notice(summary);
				ctx.redisplay();
			}),
		);
}
