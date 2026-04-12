/**
 * Per-automation settings modal.
 *
 * Opened from the gear icon on an automation row in the Automation settings
 * section. Shows automation name, description, reset-to-default (built-in
 * only), per-automation settings fields, and a shared-settings note with link.
 *
 * Mirrors the pattern established by {@link ToolSettingsModal}.
 */

import { Modal, Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "../settings/sections/context";
import { renderFieldList, type FieldTarget } from "../settings/sections/field-renderer";
import { ConfirmModal } from "./confirm-modal";
import { BUILTIN_AUTOMATION_SCAFFOLDS } from "../extensions/builtin-automation-scaffolds";

export class AutomationSettingsModal extends Modal {
	constructor(
		private ctx: SettingsContext,
		private automationName: string,
		private scrollToGroup?: (groupTitle: string, subsection?: string) => void,
	) {
		super(ctx.app);
	}

	onOpen(): void {
		this.renderContent();
	}

	onClose(): void {
		this.contentEl.empty();
		this.ctx.redisplay();
	}

	private renderContent(): void {
		const { contentEl } = this;
		contentEl.empty();

		const manager = this.ctx.plugin.getExtensionManager();
		const automations = manager.getAutomations();
		const automationDef = automations.find((a) => {
			const name = a.displayName
				?? a.filePath.split("/").pop()?.replace(/\.md$/, "")
				?? a.filePath;
			return name === this.automationName
				|| a.filePath.split("/").pop()?.replace(/\.md$/, "") === this.automationName;
		});
		const scaffold = BUILTIN_AUTOMATION_SCAFFOLDS.get(this.automationName);
		const isBuiltin = scaffold !== undefined;

		// --- Header ---
		const displayName = scaffold?.displayName ?? automationDef?.displayName ?? this.automationName;
		contentEl.createEl("h2", { text: displayName });
		if (scaffold) {
			contentEl.createEl("p", {
				text: `Trigger: ${scaffold.trigger}`,
				cls: "setting-item-description",
			});
		} else if (automationDef) {
			contentEl.createEl("p", {
				text: `Trigger: ${automationDef.trigger}`,
				cls: "setting-item-description",
			});
		}

		// --- Reset to default (built-in automations with vault override only) ---
		if (isBuiltin) {
			const vaultFilePath = normalizePath(
				`${this.ctx.settings.notor_dir}/automations/${this.automationName}.md`,
			);
			const vaultFileExists =
				this.ctx.app.vault.getAbstractFileByPath(vaultFilePath) !== null;

			if (vaultFileExists) {
				new Setting(contentEl)
					.setName("Custom definition active")
					.addButton((btn) =>
						btn
							.setButtonText("Reset to default")
							.setWarning()
							.onClick(() => {
								new ConfirmModal(
									this.ctx.app,
									"Reset to default?",
									`This will delete your customized "${this.automationName}" file and restore the built-in default. Any custom logic will be lost.`,
									async () => {
										try {
											await manager.resetBuiltinAutomationToDefault(this.automationName);
											await manager.reload(false);
											new Notice(`Automation "${this.automationName}" reset to default.`);
											this.renderContent();
										} catch (e) {
											const msg = e instanceof Error ? e.message : String(e);
											new Notice(`Failed to reset automation: ${msg}`);
										}
									},
									"Reset to default",
									true,
								).open();
							}),
					);
			}
		}

		// --- Per-automation settings ---
		const settingsSchema = automationDef?.settingsSchema ?? scaffold?.settingsSchema;
		if (settingsSchema && settingsSchema.length > 0) {
			new Setting(contentEl).setHeading().setName("Settings");
			// Use displayName as extension key — must match executeAutomation()'s extensionName
			const extensionName = displayName;
			const target: FieldTarget = {
				kind: "extension",
				extensionName,
			};
			renderFieldList(contentEl, this.ctx, settingsSchema, target);

			new Setting(contentEl).addButton((btn) =>
				btn
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(async () => {
						delete this.ctx.settings.user_extension_settings[extensionName];
						await this.ctx.saveSettings();
						this.renderContent();
					}),
			);
		}

		// --- Shared settings note ---
		const sharedDef = manager.getSharedSettingsDefinition();
		if (sharedDef) {
			const note = new Setting(contentEl).setDesc(
				"This automation may also be affected by shared settings.",
			);
			note.descEl.appendText(" ");
			const linkEl = note.descEl.createEl("a", {
				text: "Edit shared settings \u2192",
				href: "#",
			});
			linkEl.addEventListener("click", (e) => {
				e.preventDefault();
				this.close();
				this.scrollToGroup?.("Tools", "Shared settings");
			});
		}

		// --- Done button ---
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Done")
				.setCta()
				.onClick(() => this.close()),
		);
	}
}
