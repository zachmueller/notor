import { Notice, Setting } from "obsidian";
import type { SettingsContext } from "./context";
import { logger } from "../../utils/logger";

const log = logger("settings:system-prompt");

export function renderSystemPromptSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	containerEl.createEl("p", {
		text:
			"Customize the base system prompt sent to the AI. " +
			"If a custom prompt file exists, it replaces the built-in default. " +
			"Template variables like {notor_dir}, {vault_name}, and {available_tools} are supported.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Customize system prompt")
		.setDesc(
			"Export the default system prompt to a file for editing. " +
				"If the file already exists, opens it without overwriting.",
		)
		.addButton((btn) =>
			btn.setButtonText("Customize").onClick(async () => {
				const builder = ctx.plugin.getSystemPromptBuilder();
				const filePath = builder.getCustomPromptPath();

				try {
					const exists = await ctx.app.vault.adapter.exists(filePath);

					if (exists) {
						new Notice("Custom system prompt already exists — opening it.");
					} else {
						await builder.writeDefaultPromptFile();
						new Notice("Default system prompt exported for editing.");
					}

					await ctx.app.workspace.openLinkText(filePath, "", false);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					log.error("Failed to export system prompt", { error: msg });
					new Notice(`Failed to export system prompt: ${msg}`);
				}
			}),
		);
}
