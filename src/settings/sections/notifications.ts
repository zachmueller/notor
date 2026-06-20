/**
 * Notifications settings section renderer.
 *
 * Controls OS-native desktop notifications for chat completion and
 * input-required events. Desktop-only; all toggles default OFF.
 *
 * @see ai/notor/ideas — "OS-level notifications for chat events"
 */

import { Platform, Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Notifications" settings section. */
export function renderNotificationsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Notifications");
	containerEl.createEl("p", {
		text:
			"Native OS desktop notifications for chat events. Desktop only — these " +
			"complement the in-app notices and let you monitor long-running conversations " +
			"when Obsidian isn't on screen.",
		cls: "setting-item-description",
	});

	if (!Platform.isDesktopApp) {
		containerEl.createEl("p", {
			text: "OS notifications are not available on mobile.",
			cls: "setting-item-description",
		});
		return;
	}

	new Setting(containerEl)
		.setName("Notify on completion")
		.setDesc(
			"Show a desktop notification when a chat response or a background workflow finishes."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.os_notifications_completion_enabled)
				.onChange(async (value) => {
					ctx.settings.os_notifications_completion_enabled = value;
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Notify when input is required")
		.setDesc(
			"Show a desktop notification when a conversation is blocked waiting on you — " +
				"a tool approval, a diff to accept, or a follow-up question."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.os_notifications_input_required_enabled)
				.onChange(async (value) => {
					ctx.settings.os_notifications_input_required_enabled = value;
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Only when Obsidian is inactive")
		.setDesc(
			"Suppress desktop notifications while Obsidian is the active app, so you're only " +
				"alerted when working in another application."
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.os_notifications_only_when_app_inactive)
				.onChange(async (value) => {
					ctx.settings.os_notifications_only_when_app_inactive = value;
					await ctx.saveSettings();
				})
		);

	new Setting(containerEl)
		.setName("Approval notifications")
		.setDesc(
			"When several tool calls need approval at once, collapse them into a single " +
				"notification, or fire one notification per call."
		)
		.addDropdown((dropdown) => {
			dropdown.addOption("per_call", "One per call");
			dropdown.addOption("coalesce", "Collapse into one");
			dropdown.setValue(ctx.settings.os_notifications_coalesce_approvals);
			dropdown.onChange(async (value) => {
				ctx.settings.os_notifications_coalesce_approvals = value as "coalesce" | "per_call";
				await ctx.saveSettings();
			});
		});
}
