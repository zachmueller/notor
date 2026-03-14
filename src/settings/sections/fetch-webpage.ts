/**
 * Web fetching settings section renderer (TOOL-013).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Web fetching" settings section. */
export function renderFetchWebpageSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Web fetching");
	containerEl.createEl("p", {
		text:
			"Settings for the fetch_webpage tool. Controls timeouts, download limits, " +
			"and domain blocking.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Request timeout (seconds)")
		.setDesc(
			"Maximum time to wait for a webpage response before aborting."
		)
		.addText((text) =>
			text
				.setPlaceholder("15")
				.setValue(String(ctx.settings.fetch_webpage_timeout))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.fetch_webpage_timeout = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Maximum download size (MB)")
		.setDesc(
			"Maximum raw download size in megabytes. Requests exceeding this are aborted."
		)
		.addText((text) =>
			text
				.setPlaceholder("5")
				.setValue(
					String(ctx.settings.fetch_webpage_max_download_mb)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.fetch_webpage_max_download_mb = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Maximum output characters")
		.setDesc(
			"Maximum characters in the converted output. Content exceeding this is truncated."
		)
		.addText((text) =>
			text
				.setPlaceholder("50000")
				.setValue(
					String(ctx.settings.fetch_webpage_max_output_chars)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.fetch_webpage_max_output_chars = parsed;
						await ctx.saveSettings();
					}
				})
		);

	// Domain denylist
	new Setting(containerEl).setHeading().setName("Domain denylist");
	containerEl.createEl("p", {
		text:
			"Domains blocked from being fetched. Use exact domains (e.g. example.com) or " +
			"wildcard patterns (e.g. *.example.com) to block all sub-domains.",
		cls: "setting-item-description",
	});

	const denylist = ctx.settings.domain_denylist;
	for (let i = 0; i < denylist.length; i++) {
		const entry = denylist[i] ?? "";
		new Setting(containerEl)
			.setName(entry || "(empty)")
			.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						ctx.settings.domain_denylist.splice(i, 1);
						await ctx.saveSettings();
						ctx.redisplay();
					})
			);
	}

	let newDomain = "";
	new Setting(containerEl)
		.setName("Add domain")
		.setDesc("Enter a domain or wildcard pattern to block.")
		.addText((text) => {
			text.setPlaceholder("Example.com or *.example.com").onChange(
				(v) => {
					newDomain = v.trim();
				}
			);
		})
		.addButton((btn) =>
			btn.setButtonText("Add").onClick(async () => {
				if (!newDomain) {
					new Notice("Enter a domain pattern to add.");
					return;
				}
				if (
					!/^(\*\.)?[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
						newDomain
					)
				) {
					new Notice(
						"Invalid domain format. Use a domain like 'example.com' or '*.example.com'."
					);
					return;
				}
				ctx.settings.domain_denylist.push(newDomain);
				await ctx.saveSettings();
				ctx.redisplay();
			})
		);
}
