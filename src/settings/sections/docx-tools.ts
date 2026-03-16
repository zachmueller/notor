/**
 * Word & file tools settings section renderer (FR-76).
 *
 * Renders allowed paths shared by `read_file`, `read_docx`, and `write_docx`,
 * plus the default output directory and default template path for `write_docx`.
 * All three tools are desktop-only; `write_docx` requires Act mode.
 *
 * @see specs/04c-docx/spec.md — FR-76
 */

import { Notice, Setting } from "obsidian";
import fs from "fs";
import { extname, resolve, isAbsolute } from "path";
import type { SettingsContext } from "./context";

/** Render the "Word & file tools" settings section. */
export function renderDocxToolsSection(
	containerEl: HTMLElement,
	ctx: SettingsContext
): void {
	new Setting(containerEl).setHeading().setName("Word & file tools");
	containerEl.createEl("p", {
		text:
			"Settings for the read_file, read_docx, and write_docx tools. " +
			"All three tools are desktop-only. write_docx requires Act mode.",
		cls: "setting-item-description",
	});

	// --- Allowed read/write paths ---
	new Setting(containerEl).setHeading().setName("Allowed read/write paths");
	containerEl.createEl("p", {
		text:
			"Additional filesystem paths allowed for read_file, read_docx, and write_docx. " +
			"The vault root is always implicitly allowed.",
		cls: "setting-item-description",
	});

	const allowedPaths = ctx.settings.read_file_allowed_paths;
	for (let i = 0; i < allowedPaths.length; i++) {
		const entry = allowedPaths[i] ?? "";
		new Setting(containerEl)
			.setName(entry || "(empty)")
			.addButton((btn) =>
				btn
					.setButtonText("Remove")
					.setWarning()
					.onClick(async () => {
						ctx.settings.read_file_allowed_paths.splice(i, 1);
						await ctx.saveSettings();
						ctx.redisplay();
					})
			);
	}

	let newPath = "";
	new Setting(containerEl)
		.setName("Add allowed path")
		.setDesc("Enter an absolute directory path.")
		.addText((text) => {
			text.setPlaceholder("/path/to/directory").onChange((v) => {
				newPath = v.trim();
			});
		})
		.addButton((btn) =>
			btn.setButtonText("Add").onClick(async () => {
				if (!newPath) {
					new Notice("Enter a path to add.");
					return;
				}
				ctx.settings.read_file_allowed_paths.push(newPath);
				await ctx.saveSettings();
				ctx.redisplay();
			})
		);

	// --- Default output directory ---
	new Setting(containerEl)
		.setName("Default output directory")
		.setDesc(
			"Default output directory for write_docx. Leave empty to require output_path per call."
		)
		.addText((text) =>
			text
				.setPlaceholder("(none — output_path required per call)")
				.setValue(ctx.settings.write_docx_default_output_dir)
				.onChange(async (value) => {
					ctx.settings.write_docx_default_output_dir = value.trim();
					await ctx.saveSettings();
				})
		);

	// --- Default template path ---
	let templateErrorEl: HTMLElement | null = null;

	const templateSetting = new Setting(containerEl)
		.setName("Default template path")
		.setDesc(
			"Default .docx template applied by write_docx. Leave empty to use no template."
		)
		.addText((text) => {
			text
				.setPlaceholder("(none — no template applied by default)")
				.setValue(ctx.settings.write_docx_default_template_path)
				.onChange(async (value) => {
					ctx.settings.write_docx_default_template_path = value.trim();
					await ctx.saveSettings();
					// Clear any existing inline error when the user edits the field
					if (templateErrorEl) {
						templateErrorEl.remove();
						templateErrorEl = null;
					}
				});

			text.inputEl.addEventListener("blur", async () => {
				const value = ctx.settings.write_docx_default_template_path;

				// Clear previous error
				if (templateErrorEl) {
					templateErrorEl.remove();
					templateErrorEl = null;
				}

				if (!value) return;

				let errorMessage: string | null = null;

				if (extname(value).toLowerCase() !== ".docx") {
					errorMessage = "Template must be a .docx file.";
				} else {
					try {
						const adapter = ctx.app.vault.adapter as {
							basePath?: string;
						};
						const vaultRoot = adapter.basePath ?? "";
						const resolvedPath = isAbsolute(value)
							? value
							: resolve(vaultRoot, value);
						await fs.promises.stat(resolvedPath);
					} catch {
						errorMessage = `Template file not found: ${value}`;
					}
				}

				if (errorMessage) {
					templateErrorEl = templateSetting.controlEl.createEl("p", {
						text: errorMessage,
						cls: "setting-item-description mod-warning",
					});
				}
			});
		});
}
