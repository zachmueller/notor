/**
 * Settings for the `on_daily_start` trigger, rendered inside the
 * "On daily start" vault event subsection: reset time, pre-flight retry
 * budget, and this device's last-fired day.
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { isValidResetTime } from "../../hooks/daily-start/logical-day";

/** Render the daily-start controls into `containerEl`. */
export function renderDailyStartSettings(containerEl: HTMLElement, ctx: SettingsContext): void {
	new Setting(containerEl)
		.setName("Day reset time")
		.setDesc(
			"Local time (24-hour, e.g. 04:00) at which a new day starts. The first time you use " +
			"Obsidian after this time, daily start hooks run once for the day.",
		)
		.addText((text) =>
			text
				.setPlaceholder("04:00")
				.setValue(ctx.settings.daily_start_reset_time)
				.onChange(async (value) => {
					if (!isValidResetTime(value)) return;
					ctx.settings.daily_start_reset_time = value.trim();
					await ctx.saveSettings();
				}),
		);

	renderIntegerSetting(containerEl, ctx, {
		name: "Retries when a model is unreachable",
		desc: "How many times to retry when credentials have expired or the network is down (0–20). 0 turns retries off.",
		placeholder: "5",
		get: () => ctx.settings.daily_start_retry_max_attempts,
		set: (v) => { ctx.settings.daily_start_retry_max_attempts = v; },
		valid: (v) => v >= 0 && v <= 20,
	});

	renderIntegerSetting(containerEl, ctx, {
		name: "First retry delay (minutes)",
		desc: "Wait before the first retry; doubles after each failed retry (1–120).",
		placeholder: "3",
		get: () => ctx.settings.daily_start_retry_base_minutes,
		set: (v) => { ctx.settings.daily_start_retry_base_minutes = v; },
		valid: (v) => v >= 1 && v <= 120,
	});

	renderIntegerSetting(containerEl, ctx, {
		name: "Longest retry delay (minutes)",
		desc: "Upper limit for the wait between retries. Must be at least the first retry delay (up to 720).",
		placeholder: "30",
		get: () => ctx.settings.daily_start_retry_max_minutes,
		set: (v) => { ctx.settings.daily_start_retry_max_minutes = v; },
		valid: (v) => v >= ctx.settings.daily_start_retry_base_minutes && v <= 720,
	});

	const detector = ctx.plugin.getDailyStart()?.detector;
	const lastFired = detector?.lastFiredDay() ?? null;
	new Setting(containerEl)
		.setName("Last run on this device")
		.setDesc(
			lastFired
				? `Daily start last ran for ${lastFired}. Reset to run it again on your next activity.`
				: "Daily start hasn't run on this device yet.",
		)
		.addButton((button) =>
			button
				.setButtonText("Reset")
				.setDisabled(!detector || lastFired === null)
				.onClick(() => {
					detector?.resetDeviceState();
					ctx.redisplay();
				}),
		);
}

function renderIntegerSetting(
	containerEl: HTMLElement,
	ctx: SettingsContext,
	opts: {
		name: string;
		desc: string;
		placeholder: string;
		get: () => number;
		set: (value: number) => void;
		valid: (value: number) => boolean;
	},
): void {
	new Setting(containerEl)
		.setName(opts.name)
		.setDesc(opts.desc)
		.addText((text) =>
			text
				.setPlaceholder(opts.placeholder)
				.setValue(String(opts.get()))
				.onChange(async (value) => {
					const parsed = Number(value.trim());
					if (value.trim() === "" || !Number.isInteger(parsed) || !opts.valid(parsed)) return;
					opts.set(parsed);
					await ctx.saveSettings();
				}),
		);
}
