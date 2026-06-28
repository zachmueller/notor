/**
 * Orchestration settings section renderer.
 *
 * Master toggle for the orchestration subsystem (feature group
 * `orchestration`). Mirrors the Memory toggle: on change it sets
 * `settings.orchestration_enabled` and reloads the extension manager so tools
 * tagged `featureGroup: "orchestration"` are registered/filtered accordingly.
 *
 * @see specs/ZZ-misc/orchestration/spec.md — FR-119
 * @see src/settings/sections/memory.ts — mirrored toggle
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Orchestration" settings section. */
export function renderOrchestrationSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Orchestration");
	containerEl.createEl("p", {
		text:
			"Multi-step orchestration flows: event-driven pipelines of conversation " +
			"and code steps with cascading guardrails (depth, iteration, cost, runtime). " +
			"When disabled, all orchestration tools are excluded.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Enable orchestration")
		.setDesc("Master toggle for the orchestration subsystem.")
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.orchestration_enabled)
				.onChange(async (value) => {
					ctx.settings.orchestration_enabled = value;
					await ctx.saveSettings();

					const manager = ctx.plugin.getExtensionManager();
					await manager.reload(false);

					ctx.redisplay();
				}),
		);
}
