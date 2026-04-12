/**
 * User automations settings section renderer.
 *
 * Renders built-in automation scaffolds (like title generation) with
 * Open/Reset controls — the same pattern as built-in tools — plus any
 * user-defined automations from the vault.
 *
 * @see specs/ZZ-misc/settings-reorganization-design.md — Section 9
 * @see specs/ZZ-misc/model-presets-design.md — Section 12.4
 */

import { Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "./context";
import { renderFieldList } from "./field-renderer";
import { markSubsection } from "../helpers";
import { BUILTIN_AUTOMATION_SCAFFOLDS } from "../../extensions/builtin-automation-scaffolds";
import { logger } from "../../utils/logger";

const log = logger("UserAutomationsSection");

/**
 * Render the "Title Generation" sub-section in Automation settings.
 *
 * Shows the enable toggle and preset selector, plus "Open automation"
 * and "Reset to default" buttons so users can inspect and customize
 * the title generation code (same UX pattern as built-in tools).
 *
 * @see specs/ZZ-misc/model-presets-design.md — Section 12.4
 */
function renderTitleGenerationSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const heading = new Setting(containerEl).setHeading().setName("Title generation");
	markSubsection(heading, "Title generation");

	new Setting(containerEl)
		.setName("Enable automatic title generation")
		.setDesc(
			"Each new conversation will use an additional LLM call to generate a descriptive title.",
		)
		.addToggle((toggle) => {
			toggle.setValue(ctx.settings.title_generation_enabled);
			toggle.onChange(async (value) => {
				ctx.settings.title_generation_enabled = value;
				await ctx.saveSettings();
			});
		});

	const configuredPresets = ctx.settings.model_presets.filter(
		(p) => p.provider_type !== null && p.model_id !== null,
	);

	new Setting(containerEl)
		.setName("Title generation preset")
		.setDesc("The model preset used for LLM title generation calls.")
		.addDropdown((dropdown) => {
			if (configuredPresets.length === 0) {
				dropdown.addOption("", "(no presets configured)");
				dropdown.setDisabled(true);
			} else {
				for (const p of configuredPresets) {
					dropdown.addOption(p.name, p.name);
				}
				dropdown.setValue(ctx.settings.title_generation_preset);
				dropdown.onChange(async (value) => {
					ctx.settings.title_generation_preset = value;
					await ctx.saveSettings();
				});
			}
		});

	// "Open automation" / "Reset" buttons — same pattern as built-in tools
	const manager = ctx.plugin.getExtensionManager();
	const scaffoldName = "title-generation";
	const vaultPath = normalizePath(
		`${ctx.settings.notor_dir}/automations/${scaffoldName}.md`,
	);
	const vaultFileExists = ctx.app.vault.getAbstractFileByPath(vaultPath) !== null;

	const actionSetting = new Setting(containerEl)
		.setName("Customize automation")
		.setDesc(
			vaultFileExists
				? "You have a custom version. Edit the vault file to change the prompt or logic."
				: "Open to create a vault file you can edit to customize the prompt or logic.",
		);

	actionSetting.addButton((btn) =>
		btn
			.setButtonText(vaultFileExists ? "Open" : "Open & create")
			.setTooltip("Open the automation definition in the editor")
			.onClick(async () => {
				try {
					if (vaultFileExists) {
						await ctx.app.workspace.openLinkText(vaultPath, "", true);
					} else {
						const path = await manager.ensureBuiltinAutomationVaultFile(scaffoldName);
						await ctx.app.workspace.openLinkText(path, "", true);
						new Notice(`Created ${path} — reload extensions to activate.`);
						ctx.redisplay();
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to open automation file", { error: msg });
					new Notice(`Failed to open automation: ${msg}`);
				}
			}),
	);

	if (vaultFileExists) {
		actionSetting.addButton((btn) =>
			btn
				.setButtonText("Reset to default")
				.setWarning()
				.setTooltip("Delete the vault file and restore the built-in version")
				.onClick(async () => {
					try {
						await manager.resetBuiltinAutomationToDefault(scaffoldName);
						new Notice("Reset to default — reload extensions to apply.");
						ctx.redisplay();
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`Failed to reset: ${msg}`);
					}
				}),
		);
	}
}

/**
 * Render built-in automation scaffolds (other than title-generation,
 * which has its own dedicated section above).
 */
function renderBuiltinAutomations(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	const manager = ctx.plugin.getExtensionManager();
	const builtinNames = manager.getBuiltinAutomationNames();

	// Skip title-generation (rendered separately above)
	const otherScaffolds = [...BUILTIN_AUTOMATION_SCAFFOLDS.entries()]
		.filter(([name]) => name !== "title-generation");

	if (otherScaffolds.length === 0) return;

	const heading = new Setting(containerEl).setHeading().setName("Built-in automations");
	markSubsection(heading, "Built-in automations");

	for (const [name, scaffold] of otherScaffolds) {
		const vaultPath = normalizePath(
			`${ctx.settings.notor_dir}/automations/${name}.md`,
		);
		const vaultFileExists = ctx.app.vault.getAbstractFileByPath(vaultPath) !== null;

		const setting = new Setting(containerEl)
			.setName(scaffold.displayName)
			.setDesc(`Trigger: ${scaffold.trigger}`);

		// "Built-in" badge
		if (!vaultFileExists) {
			setting.nameEl.createSpan({
				text: "Built-in",
				cls: "notor-extension-badge-builtin",
			});
		} else {
			setting.nameEl.createSpan({
				text: "Customized",
				cls: "notor-extension-badge-user",
			});
		}

		// Open button
		setting.addButton((btn) =>
			btn
				.setIcon("square-arrow-out-up-right")
				.setTooltip("Open automation definition")
				.onClick(async () => {
					try {
						if (vaultFileExists) {
							await ctx.app.workspace.openLinkText(vaultPath, "", true);
						} else {
							const path = await manager.ensureBuiltinAutomationVaultFile(name);
							await ctx.app.workspace.openLinkText(path, "", true);
							new Notice(`Created ${path} — reload extensions to activate.`);
							ctx.redisplay();
						}
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						new Notice(`Failed to open: ${msg}`);
					}
				}),
		);

		// Reset button (only if vault file exists)
		if (vaultFileExists) {
			setting.addButton((btn) =>
				btn
					.setButtonText("Reset")
					.setWarning()
					.setTooltip("Delete vault file and restore built-in version")
					.onClick(async () => {
						try {
							await manager.resetBuiltinAutomationToDefault(name);
							new Notice("Reset to default — reload extensions to apply.");
							ctx.redisplay();
						} catch (e) {
							const msg = e instanceof Error ? e.message : String(e);
							new Notice(`Failed to reset: ${msg}`);
						}
					}),
			);
		}
	}

	void builtinNames; // referenced for future use
}

/** Render the complete user automations section. */
export function renderUserAutomationsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	// 1. Title generation (dedicated section with toggle + preset + open/reset)
	renderTitleGenerationSection(containerEl, ctx);

	// 2. Other built-in automations (if any exist in the future)
	renderBuiltinAutomations(containerEl, ctx);

	// 3. User-defined automations from vault
	const manager = ctx.plugin.getExtensionManager();
	const automations = manager.getAutomations();
	const builtinNames = manager.getBuiltinAutomationNames();

	// Filter out scaffold automations — they're rendered in their own sections above
	const userAutomations = automations.filter((a) => !a.isScaffold);
	// Also filter out vault-file overrides of built-in automations (rendered above)
	const pureUserAutomations = userAutomations.filter((a) => {
		const filename = a.filePath.split("/").pop()?.replace(/\.md$/, "") ?? "";
		return !builtinNames.has(filename);
	});

	if (pureUserAutomations.length === 0) return;

	const heading = new Setting(containerEl).setHeading().setName("User automations");
	markSubsection(heading, "User automations");

	for (const automation of pureUserAutomations) {
		const label = automation.displayName
			?? automation.filePath.split("/").pop()?.replace(/\.md$/, "")
			?? automation.filePath;
		const extKey = automation.displayName ?? automation.filePath;

		const setting = new Setting(containerEl)
			.setName(label)
			.setDesc(`Trigger: ${automation.trigger}`);

		// "User" badge
		setting.nameEl.createSpan({
			text: "User",
			cls: "notor-extension-badge-user",
		});

		// Open button
		setting.addButton((btn) =>
			btn
				.setIcon("square-arrow-out-up-right")
				.setTooltip("Open extension file")
				.onClick(async () => {
					await ctx.app.workspace.openLinkText(automation.filePath, "", true);
				}),
		);

		// Inline settings if present
		if (automation.settingsSchema && automation.settingsSchema.length > 0) {
			renderFieldList(containerEl, ctx, automation.settingsSchema, {
				kind: "extension",
				extensionName: extKey,
			});

			new Setting(containerEl).addButton((btn) =>
				btn
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(async () => {
						delete ctx.settings.user_extension_settings[extKey];
						await ctx.saveSettings();
						ctx.redisplay();
					}),
			);
		}
	}
}
