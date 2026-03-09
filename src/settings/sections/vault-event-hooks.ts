/**
 * Vault event hooks settings section renderer (F-003, F-004).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Notice, Setting, TextComponent } from "obsidian";
import type { VaultEventHookType } from "../../types";
import {
	addVaultEventHook,
	removeVaultEventHook,
	reorderVaultEventHooks,
	toggleVaultEventHook,
} from "../../hooks/vault-event-hook-config";
import { validateCronExpressionBasic } from "../helpers";
import type { SettingsContext } from "./context";

/** Metadata for a single vault event type subsection. */
interface VaultEventMeta {
	event: VaultEventHookType;
	title: string;
	desc: string;
	hasSchedule: boolean;
	desktopOnlyNote?: string;
}

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
			event: "on_note_open",
			title: "On note open",
			desc: "Fires when a Markdown note is opened (activated) in the editor.",
			hasSchedule: false,
		},
		{
			event: "on_note_create",
			title: "On note create",
			desc: "Fires when a new Markdown file is created in the vault.",
			hasSchedule: false,
		},
		{
			event: "on_save",
			title: "On save",
			desc: "Fires whenever a Markdown note is saved (auto-save or manual save).",
			hasSchedule: false,
		},
		{
			event: "on_manual_save",
			title: "On manual save",
			desc: "Fires only on explicit keyboard saves (Cmd+S / Ctrl+S).",
			hasSchedule: false,
			desktopOnlyNote:
				"Desktop only — fires on Cmd+S / Ctrl+S; does not fire on mobile.",
		},
		{
			event: "on_tag_change",
			title: "On tag change",
			desc: "Fires when a note's frontmatter tags are added or removed.",
			hasSchedule: false,
		},
		{
			event: "on_schedule",
			title: "On schedule",
			desc: "Fires on a cron schedule (e.g. daily at midnight). Requires a cron expression.",
			hasSchedule: true,
		},
	];

	for (const meta of eventMeta) {
		renderVaultEventHookSubsection(containerEl, meta, ctx);
	}
}

/**
 * Render one collapsible `<details>` subsection for a single vault event type.
 */
function renderVaultEventHookSubsection(
	containerEl: HTMLElement,
	meta: VaultEventMeta,
	ctx: SettingsContext
): void {
	const { event, title, desc, hasSchedule, desktopOnlyNote } = meta;
	const hooks = ctx.settings.vault_event_hooks[event];

	const details = containerEl.createEl("details", {
		cls: "notor-vault-hook-details",
	});
	const summary = details.createEl("summary", {
		cls: "notor-vault-hook-summary",
	});
	summary.createEl("strong", { text: title });
	const hookCount = hooks.length;
	if (hookCount > 0) {
		summary.createSpan({
			text: ` (${hookCount} hook${hookCount === 1 ? "" : "s"})`,
			cls: "notor-vault-hook-count",
		});
	}

	const body = details.createDiv({ cls: "notor-vault-hook-body" });

	body.createEl("p", { text: desc, cls: "setting-item-description" });
	if (desktopOnlyNote) {
		body.createEl("p", {
			text: `ℹ️ ${desktopOnlyNote}`,
			cls: "setting-item-description notor-vault-hook-desktop-note",
		});
	}

	// Render existing hooks
	for (let i = 0; i < hooks.length; i++) {
		const hook = hooks[i];
		if (!hook) continue;

		// Determine display name and description
		const actionLabel =
			(hook.action_type ?? "execute_command") === "run_workflow"
				? `▶ ${hook.workflow_path ?? "(no path)"}`
				: `$ ${hook.command ?? "(no command)"}`;
		const hookName = hook.label || actionLabel.substring(0, 60);
		const hookDesc = hook.label ? actionLabel.substring(0, 80) : "";

		// Warn if run_workflow hook has an empty path
		const isInvalidWorkflow =
			(hook.action_type ?? "execute_command") === "run_workflow" &&
			!hook.workflow_path?.trim();

		const setting = new Setting(body)
			.setName(hookName + (isInvalidWorkflow ? " ⚠️" : ""))
			.setDesc(hookDesc);

		// Enabled toggle
		setting.addToggle((toggle) =>
			toggle.setValue(hook.enabled).onChange(async (value) => {
				toggleVaultEventHook(
					ctx.settings.vault_event_hooks,
					hook.id
				);
				// toggleVaultEventHook mutates in place; sync saved value
				hook.enabled = value;
				await ctx.saveSettings();
			})
		);

		// Move up
		if (i > 0) {
			setting.addButton((btn) =>
				btn.setButtonText("↑").onClick(async () => {
					reorderVaultEventHooks(
						ctx.settings.vault_event_hooks,
						event,
						hook.id,
						i - 1
					);
					await ctx.saveSettings();
					ctx.redisplay();
				})
			);
		}

		// Move down
		if (i < hooks.length - 1) {
			setting.addButton((btn) =>
				btn.setButtonText("↓").onClick(async () => {
					reorderVaultEventHooks(
						ctx.settings.vault_event_hooks,
						event,
						hook.id,
						i + 1
					);
					await ctx.saveSettings();
					ctx.redisplay();
				})
			);
		}

		// Remove
		setting.addButton((btn) =>
			btn
				.setButtonText("Remove")
				.setWarning()
				.onClick(async () => {
					removeVaultEventHook(
						ctx.settings.vault_event_hooks,
						hook.id
					);
					await ctx.saveSettings();
					ctx.redisplay();
				})
		);
	}

	// Add hook form (F-003 + F-004)
	let newActionType: "execute_command" | "run_workflow" = "execute_command";
	let newCommandOrPath = "";
	let newLabel = "";
	let newSchedule = "";

	// Action type selector
	const actionTypeSetting = new Setting(body)
		.setName("Add hook")
		.setDesc("Action to perform when this event fires.");

	// Command / workflow path input (shared element, placeholder changes with action type)
	let commandInput: TextComponent | null = null;

	// Action type dropdown
	actionTypeSetting.addDropdown((dropdown) => {
		dropdown.addOption("execute_command", "Execute shell command");
		dropdown.addOption("run_workflow", "Run a workflow");
		dropdown.setValue(newActionType);
		dropdown.onChange((value) => {
			newActionType = value as "execute_command" | "run_workflow";
			// Update the placeholder on the command/path input
			if (commandInput) {
				commandInput.setPlaceholder(
					newActionType === "run_workflow"
						? "daily/review.md"
						: "Shell command"
				);
			}
		});
	});

	actionTypeSetting.addText((text) => {
		commandInput = text;
		text.setPlaceholder("Shell command").onChange((v) => {
			newCommandOrPath = v.trim();
		});
	});

	// Label input (optional)
	actionTypeSetting.addText((text) => {
		text.setPlaceholder("Label (optional)").onChange((v) => {
			newLabel = v.trim();
		});
		text.inputEl.style.width = "120px";
	});

	// Cron expression input (only for on_schedule)
	let scheduleErrorEl: HTMLElement | null = null;
	if (hasSchedule) {
		const scheduleSetting = new Setting(body)
			.setName("Cron expression")
			.setDesc(
				"Standard 5-field cron (minute hour day-of-month month day-of-week). " +
				"Example: 0 9 * * 1-5 (9am Mon–Fri)."
			);

		scheduleSetting.addText((text) => {
			text.setPlaceholder("0 9 * * 1-5").onChange((v) => {
				newSchedule = v.trim();
				// Live validation feedback
				if (scheduleErrorEl) {
					scheduleErrorEl.remove();
					scheduleErrorEl = null;
				}
				if (newSchedule) {
					const validation = validateCronExpressionBasic(newSchedule);
					if (!validation.valid) {
						scheduleErrorEl = body.createEl("p", {
							text: `Invalid cron expression: ${validation.error}`,
							cls: "notor-cron-error",
						});
						scheduleSetting.settingEl.after(scheduleErrorEl);
					} else if (validation.nextRun) {
						scheduleErrorEl = body.createEl("p", {
							text: `Next run: ${validation.nextRun.toLocaleString()}`,
							cls: "notor-cron-preview",
						});
						scheduleSetting.settingEl.after(scheduleErrorEl);
					}
				}
			});
		});
	}

	// Add button
	actionTypeSetting.addButton((btn) =>
		btn.setButtonText("Add").onClick(async () => {
			if (!newCommandOrPath) {
				new Notice(
					newActionType === "run_workflow"
						? "Enter a workflow path."
						: "Enter a shell command."
				);
				return;
			}
			if (hasSchedule && !newSchedule) {
				new Notice("Enter a cron expression for the schedule.");
				return;
			}
			if (hasSchedule && newSchedule) {
				const validation = validateCronExpressionBasic(newSchedule);
				if (!validation.valid) {
					new Notice(`Invalid cron expression: ${validation.error}`);
					return;
				}
			}

			try {
				addVaultEventHook(
					ctx.settings.vault_event_hooks,
					event,
					newActionType,
					newCommandOrPath,
					newLabel,
					hasSchedule ? newSchedule : null
				);
				await ctx.saveSettings();
				ctx.redisplay();
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e));
			}
		})
	);
}
