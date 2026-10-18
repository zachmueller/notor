import { describe, expect, it } from "vitest";
import { createDefaultSettings, DEFAULT_VAULT_EVENT_HOOKS, mergeSavedSettings } from "./defaults";
import type { NotorSettings } from "./types";
import type { VaultEventHook } from "../types";

const hook: VaultEventHook = {
	id: "h1",
	event: "on_save",
	action_type: "execute_command",
	command: "echo hi",
	workflow_path: null,
	label: "",
	enabled: true,
	schedule: null,
	delay_ms: null,
};

describe("mergeSavedSettings", () => {
	it("backfills vault event types missing from saved settings", () => {
		const saved = {
			vault_event_hooks: {
				on_note_open: [],
				on_note_create: [],
				on_save: [hook],
				on_manual_save: [],
				on_tag_change: [],
				on_schedule: [],
			},
		} as unknown as Partial<NotorSettings>;
		const loaded = mergeSavedSettings(createDefaultSettings(".obsidian"), saved);
		expect(loaded.vault_event_hooks.on_daily_start).toEqual([]);
		expect(loaded.vault_event_hooks.on_save).toEqual([hook]);
	});

	it("does not share default hook arrays with the loaded settings", () => {
		const loaded = mergeSavedSettings(createDefaultSettings(".obsidian"), null);
		loaded.vault_event_hooks.on_daily_start.push({ ...hook, event: "on_daily_start" });
		expect(DEFAULT_VAULT_EVENT_HOOKS.on_daily_start).toEqual([]);
	});

	it("defaults the daily-start settings", () => {
		const loaded = mergeSavedSettings(createDefaultSettings(".obsidian"), {});
		expect(loaded.daily_start_reset_time).toBe("04:00");
		expect(loaded.daily_start_retry_max_attempts).toBe(5);
		expect(loaded.daily_start_retry_base_minutes).toBe(3);
		expect(loaded.daily_start_retry_max_minutes).toBe(30);
	});
});
