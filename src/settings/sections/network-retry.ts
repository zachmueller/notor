/**
 * Network retry settings section renderer.
 *
 * Controls how long Notor keeps retrying a provider turn after a transient
 * failure (network drop, throttling, overloaded/5xx) and how long it waits
 * while the device is offline. Stored in ms; shown in seconds/minutes.
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { markSubsection } from "../helpers";

export const NETWORK_RETRY_SUBSECTION = "Network retry";

/** Render the "Network retry" subsection of the Providers group. */
export function renderNetworkRetrySection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	const heading = new Setting(containerEl).setHeading().setName(NETWORK_RETRY_SUBSECTION);
	markSubsection(heading, NETWORK_RETRY_SUBSECTION);
	containerEl.createEl("p", {
		text:
			"When a provider request fails because the connection dropped or the provider is " +
			"temporarily overloaded, Notor re-sends the turn automatically with increasing delays. " +
			"While your device is offline it waits for the network to return without using up retries.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Automatic retries")
		.setDesc("How many times to re-send a failed turn before showing an error. Set to 0 to turn automatic retry off. (0–10)")
		.addText((text) =>
			text
				.setPlaceholder("6")
				.setValue(String(ctx.settings.network_retry_max_retries))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 0 && parsed <= 10) {
						ctx.settings.network_retry_max_retries = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Maximum retry delay (seconds)")
		.setDesc("Delays start at 1 second and double after each retry, up to this cap. (1–120)")
		.addText((text) =>
			text
				.setPlaceholder("30")
				.setValue(String(Math.round(ctx.settings.network_retry_max_delay_ms / 1000)))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 1 && parsed <= 120) {
						ctx.settings.network_retry_max_delay_ms = parsed * 1000;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Offline wait (minutes)")
		.setDesc(
			"How long to wait for the network to come back while your device is offline before giving up. " +
			"Select Stop to cancel at any time. (0–60)"
		)
		.addText((text) =>
			text
				.setPlaceholder("10")
				.setValue(String(Math.round(ctx.settings.network_offline_wait_max_ms / 60_000)))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 0 && parsed <= 60) {
						ctx.settings.network_offline_wait_max_ms = parsed * 60_000;
						await ctx.saveSettings();
					}
				})
		);
}
