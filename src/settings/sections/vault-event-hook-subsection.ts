/**
 * Vault event hook subsection renderer — one collapsible `<details>` block
 * per vault event type.
 *
 * Extracted from `vault-event-hooks.ts` to keep each file under 300 lines
 * per AGENTS.md guidance.
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003, S-007
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
export interface VaultEventMeta {
	event: VaultEventHookType;
	title: string;
	desc: string;
	hasSchedule: boolean;
	desktopOnlyNote?: string;
}

/**
 * Render one collapsible `<details>` subsection for a single vault event type.
 */
export function renderVaultEventHookSubsection(
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

		const delayBadge = hook.delay_ms != null && hook.delay_ms > 0
			? ` ⏱${hook.delay_ms}ms`
			: "";
		const setting = new Setting(body)
			.setName(hookName + (isInvalidWorkflow ? " ⚠️" : "") + delayBadge)
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
	let newDelayMs: number | null = null;

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
		text.inputEl.addClass("notor-input-w-120");
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

	// Delay input (Phase 5: per-hook debounce)
	new Setting(body)
		.setName("Delay (ms)")
		.setDesc("Debounce delay before execution. Empty = inherit from workflow, 0 = immediate.")
		.addText((text) =>
			text.setPlaceholder("inherit").onChange((value) => {
				if (value.trim() === "") {
					newDelayMs = null;
				} else {
					const parsed = parseInt(value, 10);
					newDelayMs = (!isNaN(parsed) && parsed >= 0) ? parsed : null;
				}
			})
		);

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
					hasSchedule ? newSchedule : null,
					newDelayMs
				);
				await ctx.saveSettings();
				ctx.redisplay();
			} catch (e) {
				new Notice(e instanceof Error ? e.message : String(e));
			}
		})
	);
}
