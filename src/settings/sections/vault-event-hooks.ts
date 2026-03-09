/**
 * Vault event hooks settings section renderer (F-003, F-004).
 *
 * Renders the top-level "Vault event hooks" heading, shared numeric controls,
 * and one collapsible subsection per vault event type. The per-event subsection
 * rendering is delegated to `renderVaultEventHookSubsection()` in
 * `./vault-event-hook-subsection.ts`.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003, S-007
 */

import { Setting } from "obsidian";
import type { VaultEventHookType } from "../../types";
import type { SettingsContext } from "./context";
import {
	renderVaultEventHookSubsection,
	type VaultEventMeta,
} from "./vault-event-hook-subsection";

/**
 * Render the "Vault event hooks" section in **Settings → Notor**.
 *
 * Contains one collapsible subsection per vault event type, each
 * listing configured hooks with enable/disable toggle, reorder, and
 * delete controls. An "Add hook" form per event type supports both
 * `"execute_command"` and `"run_workflow"` action types (F-004).
 */
export function renderVaultEventHooksSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	containerEl.createEl("h2", { text: "Vault event hooks" });
	containerEl.createEl("p", {
		text:
			"Actions that run automatically when vault events occur — note opened, " +
			"created, saved, tag changed, or on a schedule. Each event type can have " +
			"multiple hooks that run in order. Desktop only for shell command hooks.",
		cls: "setting-item-description",
	});

	// Shared numeric controls
	new Setting(containerEl)
		.setName("Debounce cooldown (seconds)")
		.setDesc(
			"Minimum time between repeated firings of the same hook on the same note. " +
			"Applies to on-note-open, on-save, and on-manual-save events."
		)
		.addText((text) =>
			text
				.setPlaceholder("5")
				.setValue(String(ctx.settings.vault_event_debounce_seconds))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 0) {
						ctx.settings.vault_event_debounce_seconds = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Workflow concurrency limit")
		.setDesc(
			"Maximum number of background workflow executions running simultaneously. " +
			"Additional executions are queued (FIFO) until a slot becomes available."
		)
		.addText((text) =>
			text
				.setPlaceholder("3")
				.setValue(String(ctx.settings.workflow_concurrency_limit))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.workflow_concurrency_limit = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Recent workflow entries")
		.setDesc(
			"Number of recent workflow executions shown in the activity indicator dropdown."
		)
		.addText((text) =>
			text
				.setPlaceholder("5")
				.setValue(String(ctx.settings.workflow_activity_indicator_count))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 1 && parsed <= 50) {
						ctx.settings.workflow_activity_indicator_count = parsed;
						await ctx.saveSettings();
					}
				})
		);

	// Per-event-type collapsible subsections
	const eventMeta: VaultEventMeta[] = [
		{
			event: "on_note_open" as VaultEventHookType,
			title: "On note open",
			desc: "Fires when a Markdown note is opened (activated) in the editor.",
			hasSchedule: false,
		},
		{
			event: "on_note_create" as VaultEventHookType,
			title: "On note create",
			desc: "Fires when a new Markdown file is created in the vault.",
			hasSchedule: false,
		},
		{
			event: "on_save" as VaultEventHookType,
			title: "On save",
			desc: "Fires whenever a Markdown note is saved (auto-save or manual save).",
			hasSchedule: false,
		},
		{
			event: "on_manual_save" as VaultEventHookType,
			title: "On manual save",
			desc: "Fires only on explicit keyboard saves (Cmd+S / Ctrl+S).",
			hasSchedule: false,
			desktopOnlyNote:
				"Desktop only — fires on Cmd+S / Ctrl+S; does not fire on mobile.",
		},
		{
			event: "on_tag_change" as VaultEventHookType,
			title: "On tag change",
			desc: "Fires when a note's frontmatter tags are added or removed.",
			hasSchedule: false,
		},
		{
			event: "on_schedule" as VaultEventHookType,
			title: "On schedule",
			desc: "Fires on a cron schedule (e.g. daily at midnight). Requires a cron expression.",
			hasSchedule: true,
		},
	];

	for (const meta of eventMeta) {
		renderVaultEventHookSubsection(containerEl, meta, ctx);
	}
}
