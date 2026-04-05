/**
 * Images & PDFs settings section renderer.
 *
 * @see specs/ZZ-misc/pdf-and-image-handling-tasks.md — Task 2.1
 */

import { Setting } from "obsidian";
import type { SettingsContext } from "./context";

/** Render the "Images & PDFs" settings section. */
export function renderMediaSection(
	containerEl: HTMLElement,
	ctx: SettingsContext,
): void {
	new Setting(containerEl).setHeading().setName("Images & PDFs");
	containerEl.createEl("p", {
		text:
			"Settings for image processing when attaching images to messages or " +
			"reading image files via tools. Images are resized and compressed to " +
			"fit within provider limits.",
		cls: "setting-item-description",
	});

	new Setting(containerEl)
		.setName("Max image dimension (px)")
		.setDesc(
			"Images larger than this dimension (width or height) are resized " +
			"proportionally before sending to the LLM. Lower values reduce token usage.",
		)
		.addText((text) =>
			text
				.setPlaceholder("2000")
				.setValue(String(ctx.settings.image_max_dimension))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.image_max_dimension = parsed;
						await ctx.saveSettings();
					}
				}),
		);

	new Setting(containerEl)
		.setName("JPEG compression quality")
		.setDesc(
			"Initial JPEG quality (0\u2013100) used when compressing images. " +
			"If the result still exceeds 5 MB, lower quality levels are tried automatically.",
		)
		.addText((text) =>
			text
				.setPlaceholder("80")
				.setValue(String(ctx.settings.image_compression_quality))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed >= 0 && parsed <= 100) {
						ctx.settings.image_compression_quality = parsed;
						await ctx.saveSettings();
					}
				}),
		);

	// PDF settings
	new Setting(containerEl)
		.setName("Max native PDF size (MB)")
		.setDesc(
			"Maximum PDF file size (in MB) for native document blocks sent to " +
			"providers that support them (Anthropic, Bedrock). Larger PDFs fall " +
			"back to text extraction.",
		)
		.addText((text) =>
			text
				.setPlaceholder("10")
				.setValue(String(ctx.settings.pdf_native_max_size_mb))
				.onChange(async (value) => {
					const parsed = parseFloat(value);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.pdf_native_max_size_mb = parsed;
						await ctx.saveSettings();
					}
				}),
		);

	new Setting(containerEl)
		.setName("PDF text extraction limit (chars)")
		.setDesc(
			"Maximum number of characters to extract from PDFs when using text " +
			"extraction (for providers without native PDF support, or when reading " +
			"specific page ranges).",
		)
		.addText((text) =>
			text
				.setPlaceholder("400000")
				.setValue(String(ctx.settings.pdf_text_max_chars))
				.onChange(async (value) => {
					const parsed = parseInt(value, 10);
					if (!isNaN(parsed) && parsed > 0) {
						ctx.settings.pdf_text_max_chars = parsed;
						await ctx.saveSettings();
					}
				}),
		);

	new Setting(containerEl)
		.setName("Prefer native PDF blocks")
		.setDesc(
			"When enabled, PDFs are sent as native document blocks to providers " +
			"that support them (Anthropic, Bedrock). When disabled, text is always " +
			"extracted from PDFs regardless of provider.",
		)
		.addToggle((toggle) =>
			toggle
				.setValue(ctx.settings.pdf_prefer_native)
				.onChange(async (value) => {
					ctx.settings.pdf_prefer_native = value;
					await ctx.saveSettings();
				}),
		);
}
