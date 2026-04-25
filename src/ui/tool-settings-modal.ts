/**
 * Per-tool settings modal.
 *
 * Opened from the gear icon on a tool row in the Tools settings section.
 * Shows tool name, description, reset-to-default (built-in only),
 * shell configuration (execute_command only), per-tool settings fields,
 * and a shared-settings note with link.
 *
 * @see specs/ZZ-misc/settings-reorganization-design.md — Section 4
 */

import { Modal, Notice, Setting, normalizePath } from "obsidian";
import type { SettingsContext } from "../settings/sections/context";
import { renderFieldList, type FieldTarget } from "../settings/sections/field-renderer";
import { renderShellSection } from "../settings/sections/execute-command";
import { ConfirmModal } from "./confirm-modal";

export class ToolSettingsModal extends Modal {
	constructor(
		private ctx: SettingsContext,
		private toolName: string,
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
		const registry = this.ctx.plugin.getToolRegistry();
		const tool = registry.get(this.toolName);
		const toolDefs = new Map(manager.getTools().map((t) => [t.name, t]));
		const toolDef = toolDefs.get(this.toolName);
		const builtinNames = new Set(manager.getBuiltinToolNames());
		const isBuiltin = builtinNames.has(this.toolName);

		// --- Header (2.2) ---
		contentEl.createEl("h2", { text: this.toolName });
		if (tool?.description) {
			contentEl.createEl("p", {
				text: tool.description,
				cls: "setting-item-description",
			});
		}

		// --- Reset to default (2.3) — built-in tools with vault override only ---
		if (isBuiltin) {
			const vaultFilePath = normalizePath(
				`${this.ctx.settings.notor_dir}/tools/${this.toolName}.md`,
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
									`This will delete your customized "${this.toolName}" file and restore the built-in default. Any custom logic will be lost.`,
									async () => {
										try {
											await manager.resetBuiltinToolToDefault(this.toolName);
											await manager.reload(false);
											new Notice(`Tool "${this.toolName}" reset to default.`);
											this.renderContent();
										} catch (e) {
											const msg = e instanceof Error ? e.message : String(e);
											new Notice(`Failed to reset tool: ${msg}`);
										}
									},
									"Reset to default",
									true,
								).open();
							}),
					);
			}
		}

		// --- Shell configuration (2.4) — execute_command only ---
		if (this.toolName === "execute_command") {
			renderShellSection(contentEl, this.ctx);
		}

		// --- Per-tool settings (2.5) ---
		if (toolDef?.settingsSchema && toolDef.settingsSchema.length > 0) {
			new Setting(contentEl).setHeading().setName("Settings");
			const target: FieldTarget = {
				kind: "extension",
				extensionName: this.toolName,
			};
			renderFieldList(contentEl, this.ctx, toolDef.settingsSchema, target, () => this.renderContent());

			new Setting(contentEl).addButton((btn) =>
				btn
					.setButtonText("Reset to defaults")
					.setWarning()
					.onClick(async () => {
						delete this.ctx.settings.user_extension_settings[this.toolName];
						await this.ctx.saveSettings();
						this.renderContent();
					}),
			);
		}

		// --- Shared settings note (2.6) ---
		const sharedDef = manager.getSharedSettingsDefinition();
		if (sharedDef) {
			const note = new Setting(contentEl).setDesc(
				"This tool may also be affected by shared settings.",
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

		// --- Done button (2.7) ---
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText("Done")
				.setCta()
				.onClick(() => this.close()),
		);
	}
}
