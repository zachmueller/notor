/**
 * Automations settings section renderer.
 *
 * Renders built-in and user-defined automations in a row-based layout
 * matching the Tools section pattern: each row has an Enabled toggle,
 * an open-file icon, and a gear icon for per-automation settings.
 *
 * @see src/settings/sections/tools.ts — Tools section (reference pattern)
 */

import { Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { markSubsection } from "../helpers";
import { BUILTIN_AUTOMATION_SCAFFOLDS } from "../../extensions/builtin-automation-scaffolds";
import { AutomationSettingsModal } from "../../ui/automation-settings-modal";
import type { UserAutomationDefinition } from "../../extensions/types";
import { logger } from "../../utils/logger";

const log = logger("UserAutomationsSection");

// ---------------------------------------------------------------------------
// Column headers
// ---------------------------------------------------------------------------

/** Render column headers for automation rows: [Name] [Enabled] [Icons]. */
function renderAutomationColumnHeaders(containerEl: HTMLElement): void {
	const headerEl = containerEl.createDiv({ cls: "notor-automation-column-headers" });
	headerEl.createSpan({ cls: "notor-tool-column-spacer" });
	headerEl.createSpan({ cls: "notor-tool-column-label", text: "Enabled" });
	headerEl.createSpan({ cls: "notor-tool-column-icon-spacer" });
}

// ---------------------------------------------------------------------------
// Built-in automations
// ---------------------------------------------------------------------------

/**
 * Default enabled state for built-in automations.
 * Title generation defaults to disabled (opt-in); others default to enabled.
 */
function getDefaultEnabled(name: string): boolean {
	if (name === "title-generation") return false;
	return true;
}

function renderBuiltinAutomations(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const scaffolds = [...BUILTIN_AUTOMATION_SCAFFOLDS.entries()];
	if (scaffolds.length === 0) return;

	const heading = new Setting(containerEl).setHeading().setName("Built-in automations");
	markSubsection(heading, "Built-in automations");
	renderAutomationColumnHeaders(containerEl);

	const manager = ctx.plugin.getExtensionManager();
	const automations = manager.getAutomations();

	for (const [name, scaffold] of scaffolds) {
		const isEnabled = ctx.settings.automation_enabled[name] ?? getDefaultEnabled(name);

		// Find the compiled definition (for settingsSchema from vault file)
		const automationDef = automations.find((a) =>
			a.filePath.split("/").pop()?.replace(/\.md$/, "") === name,
		);

		const setting = new Setting(containerEl)
			.setName(scaffold.displayName)
			.setDesc(`Trigger: ${scaffold.trigger}`);

		// Enabled toggle
		setting.addToggle((toggle) =>
			toggle
				.setValue(isEnabled)
				.setTooltip("Enabled")
				.onChange(async (value) => {
					ctx.settings.automation_enabled[name] = value;
					await ctx.saveSettings();
					ctx.redisplay();
				}),
		);

		if (!isEnabled) {
			setting.settingEl.addClass("notor-tool-row-disabled");
		}

		// Open-file icon
		const vaultPath = normalizePath(
			`${ctx.settings.notor_dir}/automations/${name}.md`,
		);
		const vaultFileExists = ctx.app.vault.getAbstractFileByPath(vaultPath) !== null;

		setting.addExtraButton((btn) =>
			btn
				.setIcon("square-arrow-out-up-right")
				.setTooltip("Open automation definition")
				.onClick(async () => {
					if (vaultFileExists) {
						await ctx.app.workspace.openLinkText(vaultPath, "", true);
					} else {
						try {
							const path = await manager.ensureBuiltinAutomationVaultFile(name);
							await ctx.app.workspace.openLinkText(path, "", true);
							new Notice(`Created ${path} — reload extensions to activate.`);
							ctx.redisplay();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							log.error("Failed to open automation file", { error: msg });
							new Notice(`Failed to open automation: ${msg}`);
						}
					}
				}),
		);

		// Gear icon (if has settings schema or vault override exists)
		const hasSettings = (automationDef?.settingsSchema?.length ?? 0) > 0
			|| (scaffold.settingsSchema?.length ?? 0) > 0;

		if (hasSettings || vaultFileExists) {
			setting.addExtraButton((btn) =>
				btn
					.setIcon("settings")
					.setTooltip("Configure automation settings")
					.onClick(() => {
						new AutomationSettingsModal(ctx, name, ctx.scrollToGroup).open();
					}),
			);
		} else {
			// Invisible placeholder for column alignment
			setting.addExtraButton((btn) => {
				btn.extraSettingsEl.addClass("notor-tool-icon-placeholder");
			});
		}
	}
}

// ---------------------------------------------------------------------------
// User automations
// ---------------------------------------------------------------------------

function renderUserAutomations(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const automations = manager.getAutomations();
	const builtinNames = manager.getBuiltinAutomationNames();

	// Filter out scaffold automations and vault-file overrides of built-ins
	const userAutomations = automations.filter((a) => {
		if (a.isScaffold) return false;
		const filename = a.filePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
		return !builtinNames.has(filename);
	});

	if (userAutomations.length === 0) return;

	const heading = new Setting(containerEl).setHeading().setName("User automations");
	markSubsection(heading, "User automations");
	renderAutomationColumnHeaders(containerEl);

	for (const automation of userAutomations) {
		renderUserAutomationRow(containerEl, automation, ctx);
	}
}

function renderUserAutomationRow(
	containerEl: HTMLElement,
	automation: UserAutomationDefinition,
	ctx: SettingsContext,
): void {
	const label = automation.displayName
		?? automation.filePath.split("/").pop()?.replace(/\.md$/, "")
		?? automation.filePath;
	const extKey = automation.filePath.split("/").pop()?.replace(/\.md$/, "") ?? label;
	const isEnabled = ctx.settings.automation_enabled[extKey] ?? true;

	const setting = new Setting(containerEl)
		.setName(label)
		.setDesc(`Trigger: ${automation.trigger}`);

	// Enabled toggle
	setting.addToggle((toggle) =>
		toggle
			.setValue(isEnabled)
			.setTooltip("Enabled")
			.onChange(async (value) => {
				ctx.settings.automation_enabled[extKey] = value;
				await ctx.saveSettings();
				ctx.redisplay();
			}),
	);

	if (!isEnabled) {
		setting.settingEl.addClass("notor-tool-row-disabled");
	}

	// Open-file icon
	setting.addExtraButton((btn) =>
		btn
			.setIcon("square-arrow-out-up-right")
			.setTooltip("Open automation definition")
			.onClick(async () => {
				await ctx.app.workspace.openLinkText(automation.filePath, "", true);
			}),
	);

	// Gear icon (only if automation has settings schema)
	if (automation.settingsSchema && automation.settingsSchema.length > 0) {
		setting.addExtraButton((btn) =>
			btn
				.setIcon("settings")
				.setTooltip("Configure automation settings")
				.onClick(() => {
					new AutomationSettingsModal(ctx, extKey, ctx.scrollToGroup).open();
				}),
		);
	} else {
		// Invisible placeholder for column alignment
		setting.addExtraButton((btn) => {
			btn.extraSettingsEl.addClass("notor-tool-icon-placeholder");
		});
	}
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/** Render the complete automations settings section. */
export function renderUserAutomationsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Automations");
	containerEl.createEl("p", {
		text:
			"Control which automations are active. " +
			"Disabling an automation prevents it from running when its trigger fires. " +
			"Click the gear icon to configure per-automation settings.",
		cls: "setting-item-description",
	});

	renderBuiltinAutomations(containerEl, ctx);
	renderUserAutomations(containerEl, ctx);
}
