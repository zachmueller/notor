/**
 * Context compaction settings section renderer (COMP-003).
 *
 * @see specs/03a-settings-refactor/tasks.md — S-003
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Context compaction" settings section. */
export function renderCompactionSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	containerEl.createEl("h2", { text: "Context compaction" });
	containerEl.createEl("p", {
		text:
			"When a conversation approaches the model's context window limit, " +
			"Notor can automatically summarize the conversation to reclaim space. " +
			"You can also trigger compaction manually via the command palette (Notor: Compact context).",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Compaction threshold")
		.setDesc(
			"Fraction of the model's context window (0.0–1.0) that triggers auto-compaction. " +
			"For example, 0.8 means compaction fires when 80% of the context window is used."
		)
		.addText((text) =>
			text
				.setPlaceholder("0.8")
				.setValue(String(ctx.settings.compaction_threshold))
				.onChange(async (value) => {
					const parsed = parseFloat(value);
					if (!isNaN(parsed) && parsed > 0 && parsed <= 1) {
						ctx.settings.compaction_threshold = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Custom compaction prompt")
		.setDesc(
			"Override the built-in compaction system prompt. " +
			"Leave empty to use the default prompt that produces concise, faithful summaries."
		)
		.addTextArea((text) =>
			text
				.setPlaceholder("(using default prompt)")
				.setValue(ctx.settings.compaction_prompt_override)
				.onChange(async (value) => {
					ctx.settings.compaction_prompt_override = value;
					await ctx.saveSettings();
				})
		);
}
