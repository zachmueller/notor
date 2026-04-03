/**
 * Web search settings section renderer.
 *
 * @see specs/ZZ-misc/web-search-tool-impl-plan.md — Phase 2
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Web search" settings section. */
export function renderWebSearchSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Web search");
	containerEl.createEl("p", {
		text:
			"Settings for the web_search tool. The domain denylist is shared " +
			"with fetch_webpage (configured above).",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Request timeout (seconds)")
		.setDesc(
			"Maximum time to wait for search results before aborting."
		)
		.addText((text) =>
			text
				.setPlaceholder("10")
				.setValue(String(ctx.settings.web_search_timeout))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.web_search_timeout = parsed;
						await ctx.saveSettings();
					}
				})
		);

	new Setting(containerEl)
		.setName("Default number of results")
		.setDesc(
			"Number of search results returned when the LLM does not specify a count (1–10)."
		)
		.addText((text) =>
			text
				.setPlaceholder("5")
				.setValue(
					String(ctx.settings.web_search_default_num_results)
				)
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 1 && parsed <= 10) {
						ctx.settings.web_search_default_num_results = parsed;
						await ctx.saveSettings();
					}
				})
		);
}
