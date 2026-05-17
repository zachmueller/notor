/**
 * Templates settings section renderer.
 *
 * Master toggle for the templates integration subsystem. When enabled,
 * registers list_templates and apply_template tool scaffolds that let the
 * AI list and apply Templater/core Templates.
 */

import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";

export function renderTemplatesSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Templates");
	containerEl.createEl("p", {
		text:
			"Integration with the Templater community plugin and Obsidian's core Templates plugin. " +
			"When enabled, the assistant can list available templates and apply them to create new notes, " +
			"automatically answering prompts and suggestors.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Enable templates integration")
		.setDesc(
			"Master toggle for the template tools. " +
			"Requires the Templater plugin or core Templates to be configured.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.templates_enabled)
				.onChange(async (value) => {
					if (value) {
						const hasTemplater = !!(ctx.app as any).plugins?.plugins?.["templater-obsidian"];
						const hasCoreTemplates = !!(ctx.app as any).internalPlugins?.getPluginById?.("templates")?.instance?.options?.folder;
						if (!hasTemplater && !hasCoreTemplates) {
							toggle.setValue(false);
							new Notice(
								"Cannot enable templates — neither Templater nor core Templates plugin is installed/configured.\n\n" +
								"Install Templater from Community Plugins, or configure a template folder in Settings → Templates.",
								8000,
							);
							return;
						}
					}

					ctx.settings.templates_enabled = value;
					await ctx.saveSettings();

					const manager = ctx.plugin.getExtensionManager();
					await manager.reload(false);

					ctx.redisplay();
				}),
		);

	if (ctx.settings.templates_enabled) {
		new Setting(containerEl)
			.setName("Execution timeout (seconds)")
			.setDesc(
				"Maximum time allowed for a Templater template to execute. " +
				"Increase for templates with complex logic or many prompts.",
			)
			.addText((text) =>
				text
					.setPlaceholder("30")
					.setValue(String(ctx.settings.templates_apply_timeout))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 5 && num <= 120) {
							ctx.settings.templates_apply_timeout = num;
							await ctx.saveSettings();
						}
					}),
			);
	}
}
