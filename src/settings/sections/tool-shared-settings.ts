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
import { markSubsection } from "../helpers";

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

	const heading = new Setting(containerEl).setHeading().setName("Shared settings");
	markSubsection(heading, "Shared settings");
	renderFieldList(containerEl, ctx, sharedDef.settingsSchema, {
		kind: "shared",
	});

	new Setting(containerEl).addButton((btn) =>
		btn
			.setButtonText("Reset to defaults")
			.setWarning()
			.onClick(async () => {
				// Clear only the fields this section renders. `user_shared_settings`
				// also backs the Path scoping section above, whose lists are a
				// security boundary and must not be wiped by a button labelled for
				// shared settings.
				for (const field of sharedDef.settingsSchema) {
					delete ctx.settings.user_shared_settings[field.key];
				}
				await ctx.saveSettings();
				ctx.redisplay();
			}),
	);
}

/**
 * Render the "Extension execution timeout" numeric setting. Bounds a single
 * user-tool or automation execution; `0` disables the guard.
 */
export function renderExtensionTimeoutSetting(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl)
		.setName("Extension execution timeout (seconds)")
		.setDesc(
			"Abandon a user tool or automation that runs longer than this, instead of wedging the conversation. " +
				"0 disables the guard. The guard fires only at an await boundary — an unbounded synchronous loop is not interruptible.",
		)
		.addText((text) =>
			text
				.setPlaceholder("300")
				.setValue(String(ctx.settings.extension_execution_timeout_seconds))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 0) {
						ctx.settings.extension_execution_timeout_seconds = parsed;
						await ctx.saveSettings();
					}
				}),
		);

	new Setting(containerEl)
		.setName("Auto-skip stale user-input prompts")
		.setDesc(
			"Auto-skip prompts from tools waiting on your input (e.g. ask_user) once the execution timeout above elapses, instead of waiting indefinitely. " +
				"Off by default so you can always step in — you can still cancel a prompt with Stop. Requires the execution timeout above to be greater than 0.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.auto_skip_user_input_prompts)
				.onChange(async (value) => {
					ctx.settings.auto_skip_user_input_prompts = value;
					await ctx.saveSettings();
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
